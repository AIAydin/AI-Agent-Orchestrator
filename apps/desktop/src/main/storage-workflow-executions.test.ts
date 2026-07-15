import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import type { CanvasDocument, Project } from '../shared/contracts.js';
import {
  LocalStore,
  WORKFLOW_RUNTIME_MAX_BYTES,
  WorkflowExecutionEventReplayConflictError,
  WorkflowExecutionRevisionConflictError,
  type WorkflowExecutionMutation,
  type WorkflowExecutionRecord,
  type WorkflowJsonValue,
} from './storage.js';

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const CANVAS_ID = '00000000-0000-4000-8000-000000000002';
const EXECUTION_ID = 'workflow-execution-1';
const T0 = '2026-07-15T16:00:00.000Z';
const T1 = '2026-07-15T16:01:00.000Z';
const T2 = '2026-07-15T16:02:00.000Z';

const openStores = new Set<LocalStore>();
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const store of openStores) store.close();
  openStores.clear();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('workflow execution storage', () => {
  it('atomically mutates runtime state, appends ordered events, and updates bindings', () => {
    const store = preparedStore();
    store.createWorkflowExecution(execution());
    withDatabase(store.databasePath, (database) => {
      database.exec(`
        CREATE TRIGGER reject_test_binding
        BEFORE INSERT ON workflow_node_bindings
        WHEN NEW.node_id = 'agent-node'
        BEGIN
          SELECT RAISE(ABORT, 'forced binding failure');
        END;
      `);
    });

    const first = mutation({
      runtimeStep: 'running',
      eventId: 'event-started',
      eventType: 'started',
      occurredAt: T1,
      bindingPayload: { agentRunId: 'agent-run-1' },
    });
    expect(() => store.mutateWorkflowExecution(first)).toThrow('forced binding failure');
    expect(store.getWorkflowExecution(EXECUTION_ID)).toEqual(execution());
    expect(store.listWorkflowExecutionEvents(EXECUTION_ID)).toEqual([]);
    expect(store.listWorkflowNodeBindings(EXECUTION_ID)).toEqual([]);

    withDatabase(store.databasePath, (database) => {
      database.exec('DROP TRIGGER reject_test_binding;');
    });
    const appliedFirst = store.mutateWorkflowExecution(first);
    expect(appliedFirst).toMatchObject({
      replayed: false,
      execution: { revision: 1, status: 'running' },
      event: { id: 'event-started', sequence: 0, executionRevision: 1 },
      bindings: [
        {
          executionId: EXECUTION_ID,
          nodeId: 'agent-node',
          executionRevision: 1,
          binding: { schemaVersion: 1, payload: { agentRunId: 'agent-run-1' } },
        },
      ],
    });

    const appliedSecond = store.mutateWorkflowExecution(
      mutation({
        expectedRevision: 1,
        runtimeStep: 'waiting',
        eventId: 'event-approval',
        eventType: 'approval-requested',
        occurredAt: T2,
        status: 'waiting-for-approval',
        bindingPayload: { agentRunId: 'agent-run-1', waitingFor: 'approval-1' },
      }),
    );
    expect(appliedSecond.execution).toMatchObject({ revision: 2, status: 'waiting-for-approval' });
    expect(store.listWorkflowExecutionEvents(EXECUTION_ID)).toMatchObject([
      { id: 'event-started', sequence: 0, executionRevision: 1 },
      { id: 'event-approval', sequence: 1, executionRevision: 2 },
    ]);
    expect(
      store.listWorkflowExecutionEvents(EXECUTION_ID, { afterSequence: 0, limit: 1 }),
    ).toMatchObject([{ id: 'event-approval', sequence: 1 }]);
    expect(store.listWorkflowNodeBindings(EXECUTION_ID)).toMatchObject([
      {
        nodeId: 'agent-node',
        executionRevision: 2,
        binding: { payload: { agentRunId: 'agent-run-1', waitingFor: 'approval-1' } },
      },
    ]);
  });

  it('rejects stale revisions while making exact event replay idempotent', () => {
    const store = preparedStore();
    let durableChanges = 0;
    store.subscribeToDurableChanges(() => {
      durableChanges += 1;
    });
    store.createWorkflowExecution(execution());
    const first = mutation({
      runtimeStep: 'running',
      eventId: 'event-started',
      eventType: 'started',
      occurredAt: T1,
      eventPayload: { alpha: 1, beta: 2 },
      bindingPayload: { agentRunId: 'agent-run-1' },
    });
    expect(store.mutateWorkflowExecution(first).replayed).toBe(false);
    expect(durableChanges).toBe(2);

    const reorderedReplay: WorkflowExecutionMutation = {
      ...first,
      event: { ...first.event, payload: { beta: 2, alpha: 1 } },
    };
    expect(store.mutateWorkflowExecution(reorderedReplay)).toMatchObject({
      replayed: true,
      execution: { revision: 1 },
      event: { id: 'event-started', sequence: 0 },
    });
    expect(durableChanges).toBe(2);

    store.mutateWorkflowExecution(
      mutation({
        expectedRevision: 1,
        runtimeStep: 'complete',
        eventId: 'event-succeeded',
        eventType: 'succeeded',
        occurredAt: T2,
        status: 'succeeded',
        bindingPayload: null,
      }),
    );
    expect(() =>
      store.mutateWorkflowExecution(
        mutation({
          expectedRevision: 0,
          runtimeStep: 'stale',
          eventId: 'event-stale',
          eventType: 'retry',
          occurredAt: T2,
          bindingPayload: null,
        }),
      ),
    ).toThrow(WorkflowExecutionRevisionConflictError);
    expect(store.listWorkflowExecutionEvents(EXECUTION_ID)).toHaveLength(2);

    expect(store.mutateWorkflowExecution(reorderedReplay)).toMatchObject({
      replayed: true,
      execution: { revision: 2, status: 'succeeded' },
    });
    expect(() =>
      store.mutateWorkflowExecution({
        ...first,
        event: { ...first.event, payload: { alpha: 999 } },
      }),
    ).toThrow(WorkflowExecutionEventReplayConflictError);
    expect(store.getWorkflowExecution(EXECUTION_ID)).toMatchObject({
      revision: 2,
      status: 'succeeded',
    });
  });

  it('reloads recoverable executions, ordered events, and bindings after restart', () => {
    const databasePath = createDatabasePath();
    const store = preparedStore(databasePath);
    store.createWorkflowExecution(execution());
    store.mutateWorkflowExecution(
      mutation({
        runtimeStep: 'running',
        eventId: 'event-started',
        eventType: 'started',
        occurredAt: T1,
        bindingPayload: { agentRunId: 'agent-run-1', resumable: true },
      }),
    );
    closeStore(store);

    const reopened = openStore(databasePath);
    expect(reopened.listRecoverableWorkflowExecutions()).toMatchObject([
      {
        id: EXECUTION_ID,
        revision: 1,
        status: 'running',
        runtime: { payload: { step: 'running' } },
      },
    ]);
    expect(reopened.listWorkflowExecutionEvents(EXECUTION_ID)).toMatchObject([
      { id: 'event-started', sequence: 0, executionRevision: 1 },
    ]);
    expect(reopened.listWorkflowNodeBindings(EXECUTION_ID)).toMatchObject([
      {
        nodeId: 'agent-node',
        binding: { payload: { agentRunId: 'agent-run-1', resumable: true } },
      },
    ]);
  });

  it('lists bounded project and canvas run history newest first', () => {
    const store = preparedStore();
    store.createWorkflowExecution(execution());
    store.createWorkflowExecution(
      execution({ id: 'workflow-execution-2', createdAt: T1, updatedAt: T1 }),
    );
    store.createWorkflowExecution(
      execution({ id: 'workflow-execution-3', createdAt: T2, updatedAt: T2 }),
    );

    expect(
      store.listProjectWorkflowExecutions(PROJECT_ID, { limit: 2 }).map(({ id }) => id),
    ).toEqual(['workflow-execution-3', 'workflow-execution-2']);
    expect(
      store.listProjectWorkflowExecutions(PROJECT_ID, { canvasId: CANVAS_ID }).map(({ id }) => id),
    ).toEqual(['workflow-execution-3', 'workflow-execution-2', EXECUTION_ID]);
    expect(
      store.listProjectWorkflowExecutions(PROJECT_ID, {
        canvasId: '00000000-0000-4000-8000-000000000099',
      }),
    ).toEqual([]);
  });

  it('bounds envelopes, rejects non-JSON values, and fails closed on corrupt stored runtime data', () => {
    const databasePath = createDatabasePath();
    const store = preparedStore(databasePath);
    expect(() =>
      store.createWorkflowExecution(
        execution({
          runtime: {
            schemaVersion: 1,
            payload: 'x'.repeat(WORKFLOW_RUNTIME_MAX_BYTES),
          },
        }),
      ),
    ).toThrow('storage limit');
    expect(store.getWorkflowExecution(EXECUTION_ID)).toBeUndefined();

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() =>
      store.createWorkflowExecution(
        execution({
          runtime: { schemaVersion: 1, payload: cyclic as WorkflowJsonValue },
        }),
      ),
    ).toThrow('bounded, acyclic JSON');

    store.createWorkflowExecution(execution());
    closeStore(store);
    withDatabase(databasePath, (database) => {
      database
        .prepare('UPDATE workflow_executions SET runtime_json = ? WHERE id = ?')
        .run('{"schemaVersion":1,"payload":{},"unexpected":true}', EXECUTION_ID);
    });
    expect(() => openStore(databasePath)).toThrow(
      'The local Forgeboard database failed its startup integrity check',
    );
  });

  it('keeps workflow recovery local to SQLite and clears it during portable replace import', () => {
    const store = preparedStore();
    store.createWorkflowExecution(execution());
    expect('workflowExecutions' in store.exportData()).toBe(false);

    const emptyPortableExport = {
      format: 'forgeboard-local-export' as const,
      version: 3 as const,
      exportedAt: T2,
      settings: null,
      projects: [],
      canvases: [],
      runs: [],
      checkExecutions: [],
      snapshots: [],
      audit: [],
    };
    store.importData(emptyPortableExport);
    expect(store.getWorkflowExecution(EXECUTION_ID)).toBeDefined();

    store.importData(emptyPortableExport, { replaceExisting: true });
    expect(store.getWorkflowExecution(EXECUTION_ID)).toBeUndefined();
    expect(store.listWorkflowExecutionEvents(EXECUTION_ID)).toEqual([]);
    expect(store.listWorkflowNodeBindings(EXECUTION_ID)).toEqual([]);
  });
});

function execution(overrides: Partial<WorkflowExecutionRecord> = {}): WorkflowExecutionRecord {
  return {
    schemaVersion: 1,
    id: EXECUTION_ID,
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    status: 'queued',
    revision: 0,
    runtime: { schemaVersion: 1, payload: { step: 'queued' } },
    snapshot: { schemaVersion: 1, payload: { canvasRevision: 1 } },
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

interface MutationOptions {
  readonly expectedRevision?: number;
  readonly runtimeStep: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly status?: WorkflowExecutionMutation['status'];
  readonly eventPayload?: WorkflowJsonValue;
  readonly bindingPayload: WorkflowJsonValue | null;
}

function mutation(options: MutationOptions): WorkflowExecutionMutation {
  return {
    executionId: EXECUTION_ID,
    expectedRevision: options.expectedRevision ?? 0,
    status: options.status ?? 'running',
    runtime: { schemaVersion: 1, payload: { step: options.runtimeStep } },
    snapshot: { schemaVersion: 1, payload: { canvasRevision: 1 } },
    updatedAt: options.occurredAt,
    event: {
      id: options.eventId,
      type: options.eventType,
      occurredAt: options.occurredAt,
      payload: options.eventPayload ?? { step: options.runtimeStep },
    },
    bindingUpdates: [
      {
        nodeId: 'agent-node',
        binding:
          options.bindingPayload === null
            ? null
            : { schemaVersion: 1, payload: options.bindingPayload },
      },
    ],
  };
}

function preparedStore(databasePath = createDatabasePath()): LocalStore {
  const store = openStore(databasePath);
  store.saveProject(project());
  store.saveCanvas(canvas());
  return store;
}

function openStore(databasePath: string): LocalStore {
  const store = new LocalStore(databasePath);
  openStores.add(store);
  return store;
}

function closeStore(store: LocalStore): void {
  store.close();
  openStores.delete(store);
}

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'forgeboard-workflow-storage-test-'));
  temporaryDirectories.push(directory);
  return join(directory, 'forgeboard.sqlite3');
}

function withDatabase(databasePath: string, operation: (database: DatabaseSync) => void): void {
  const database = new DatabaseSync(databasePath);
  try {
    operation(database);
  } finally {
    database.close();
  }
}

function project(): Project {
  return {
    id: PROJECT_ID,
    name: 'Workflow project',
    path: '/tmp/forgeboard-workflow-project',
    openedAt: T0,
    missing: false,
    health: {
      isGitRepository: true,
      branch: 'main',
      dirty: false,
      remotes: [],
      packageManager: 'pnpm',
      frameworks: ['electron'],
      scripts: {},
      hasSubmodules: false,
      sensitiveWarnings: [],
    },
  };
}

function canvas(): CanvasDocument {
  return {
    id: CANVAS_ID,
    projectId: PROJECT_ID,
    name: 'Workflow canvas',
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt: T0,
  };
}
