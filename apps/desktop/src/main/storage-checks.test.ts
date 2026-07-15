import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import type { CheckExecutionView } from '../shared/check-contracts.js';
import type { Project } from '../shared/contracts.js';
import { LocalStore } from './storage.js';

const PROJECT_ID = '30000000-0000-4000-8000-000000000001';
const NOW = '2026-07-15T12:00:00.000Z';
const roots: string[] = [];
const stores = new Set<LocalStore>();

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createDatabasePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeboard-check-storage-'));
  roots.push(root);
  return join(root, 'forgeboard.sqlite3');
}

function openStore(path = createDatabasePath()): LocalStore {
  const store = new LocalStore(path);
  stores.add(store);
  return store;
}

function closeStore(store: LocalStore): void {
  store.close();
  stores.delete(store);
}

function project(): Project {
  return {
    id: PROJECT_ID,
    name: 'Checked project',
    path: '/tmp/checked-project',
    openedAt: NOW,
    missing: false,
    health: {
      isGitRepository: true,
      branch: 'main',
      dirty: false,
      remotes: [],
      packageManager: 'pnpm',
      frameworks: [],
      scripts: { lint: 'eslint .' },
      hasSubmodules: false,
      sensitiveWarnings: [],
    },
  };
}

function execution(
  id: string,
  status: CheckExecutionView['status'] = 'queued',
  updatedAt = NOW,
): CheckExecutionView {
  const terminal = ['passed', 'failed', 'cancelled', 'lost'].includes(status);
  return {
    id,
    projectId: PROJECT_ID,
    checkId: 'lint',
    label: 'Lint',
    kind: 'lint',
    executable: 'pnpm',
    arguments: ['lint'],
    cwd: '/tmp/checked-project',
    environmentVariableNames: ['PATH'],
    status,
    exitCode: status === 'passed' ? 0 : status === 'failed' ? 1 : null,
    startedAt: status === 'queued' ? null : NOW,
    endedAt: terminal ? updatedAt : null,
    output: status === 'passed' ? 'All files pass.' : '',
    outputTruncated: false,
    updatedAt,
  };
}

function executionId(index: number): string {
  return `30000000-0000-4000-8000-${index.toString().padStart(12, '0')}`;
}

describe('durable project check storage', () => {
  it('saves evolving results, preserves identity, and bounds newest-first lists', () => {
    const store = openStore();
    const id = executionId(10);
    const queued = execution(id);
    expect(store.saveCheckExecution(queued)).toEqual(queued);
    expect(store.getCheckExecution(id)).toEqual(queued);

    const passed = execution(id, 'passed', '2026-07-15T12:01:00.000Z');
    expect(store.saveCheckExecution(passed)).toEqual(passed);
    expect(store.getCheckExecution(id)).toEqual(passed);
    expect(() => store.saveCheckExecution({ ...passed, label: 'Changed identity' })).toThrow(
      'cannot change its persisted identity',
    );
    expect(() => store.saveCheckExecution(queued)).toThrow('cannot replace a newer result');

    for (let index = 1; index <= 205; index += 1) {
      store.saveCheckExecution(
        execution(
          executionId(1_000 + index),
          'passed',
          new Date(Date.parse(NOW) + index * 1_000).toISOString(),
        ),
      );
    }
    const latest = store.listCheckExecutions(PROJECT_ID, 10_000);
    expect(latest).toHaveLength(200);
    expect(latest[0]?.id).toBe(executionId(1_205));
    expect(latest.at(-1)?.id).toBe(executionId(1_007));
  });

  it('enforces monotonic lifecycle transitions while allowing exact retries and fast exits', () => {
    const store = openStore();
    const id = executionId(11);
    const queued = execution(id);
    expect(store.saveCheckExecution(queued)).toEqual(queued);
    expect(store.saveCheckExecution(queued)).toEqual(queued);
    expect(() =>
      store.saveCheckExecution({ ...queued, output: 'same timestamp mutation' }),
    ).toThrow('must advance its update time');

    const running = execution(id, 'running', '2026-07-15T12:00:01.000Z');
    expect(store.saveCheckExecution(running)).toEqual(running);
    expect(() =>
      store.saveCheckExecution({
        ...queued,
        updatedAt: '2026-07-15T12:00:02.000Z',
      }),
    ).toThrow('cannot return to queued');
    expect(() =>
      store.saveCheckExecution({
        ...running,
        startedAt: '2026-07-15T12:00:00.500Z',
        updatedAt: '2026-07-15T12:00:02.000Z',
      }),
    ).toThrow('cannot change its persisted start time');

    const passed = execution(id, 'passed', '2026-07-15T12:00:03.000Z');
    expect(store.saveCheckExecution(passed)).toEqual(passed);
    expect(() =>
      store.saveCheckExecution({
        ...passed,
        status: 'running',
        exitCode: null,
        endedAt: null,
        updatedAt: '2026-07-15T12:00:04.000Z',
      }),
    ).toThrow('terminal check execution cannot change');
    expect(() =>
      store.saveCheckExecution({
        ...passed,
        status: 'failed',
        exitCode: 1,
        updatedAt: '2026-07-15T12:00:04.000Z',
      }),
    ).toThrow('terminal check execution cannot change');
    expect(() =>
      store.saveCheckExecution({
        ...passed,
        output: 'mutated terminal output',
        updatedAt: '2026-07-15T12:00:04.000Z',
      }),
    ).toThrow('terminal check execution cannot change');

    const fastExitId = executionId(12);
    store.saveCheckExecution(execution(fastExitId));
    const fastExit = execution(fastExitId, 'failed', '2026-07-15T12:00:01.000Z');
    expect(store.saveCheckExecution(fastExit)).toEqual(fastExit);
  });

  it('marks queued and running executions lost on restart while preserving terminal results', () => {
    const databasePath = createDatabasePath();
    const store = openStore(databasePath);
    const queuedId = executionId(20);
    const runningId = executionId(21);
    const passedId = executionId(22);
    store.saveCheckExecution(execution(queuedId));
    store.saveCheckExecution(execution(runningId, 'running'));
    store.saveCheckExecution(execution(passedId, 'passed'));
    closeStore(store);

    const reopened = openStore(databasePath);
    expect(reopened.getStartupCheckRecoveryReport().lostCheckExecutionIds.sort()).toEqual(
      [queuedId, runningId].sort(),
    );
    expect(reopened.getCheckExecution(queuedId)).toMatchObject({ status: 'lost' });
    expect(reopened.getCheckExecution(runningId)).toMatchObject({ status: 'lost' });
    expect(reopened.getCheckExecution(passedId)).toMatchObject({ status: 'passed' });
    expect(reopened.getCheckExecution(queuedId)?.endedAt).not.toBeNull();
    expect(Date.parse(reopened.getCheckExecution(queuedId)?.updatedAt ?? '')).toBeGreaterThan(
      Date.parse(NOW),
    );
    expect(reopened.listAuditEvents(1)[0]).toMatchObject({
      category: 'recovery',
      action: 'interrupted-checks',
      outcome: 'allowed',
    });
  });

  it('exports, imports, and deletes check history while accepting version-two exports', async () => {
    const source = openStore();
    source.saveProject(project());
    const saved = execution(executionId(30), 'passed');
    source.saveCheckExecution(saved);

    const exported = source.exportData(new Date(NOW));
    expect(exported).toMatchObject({ version: 3, checkExecutions: [saved] });
    const destination = openStore();
    expect(destination.importData(exported)).toMatchObject({ checkExecutions: 1 });
    expect(destination.getCheckExecution(saved.id)).toEqual(saved);

    const legacy: Record<string, unknown> = { ...exported, version: 2 };
    delete legacy.checkExecutions;
    const legacyDestination = openStore();
    expect(legacyDestination.importData(legacy)).toMatchObject({ checkExecutions: 0 });
    expect(legacyDestination.listCheckExecutions(PROJECT_ID)).toEqual([]);

    await destination.deleteAllLocalData();
    expect(destination.getCheckExecution(saved.id)).toBeUndefined();
    expect(destination.exportData().checkExecutions).toEqual([]);
  });

  it('reports indexed-column corruption in full logical integrity checks', () => {
    const store = openStore();
    const saved = execution(executionId(40), 'passed');
    store.saveCheckExecution(saved);
    expect(store.checkIntegrity('full')).toMatchObject({ ok: true, messages: [] });

    const connection = new DatabaseSync(store.databasePath);
    connection
      .prepare('UPDATE check_executions SET status = ? WHERE id = ?')
      .run('failed', saved.id);
    connection.close();
    const report = store.checkIntegrity('full');
    expect(report.ok).toBe(false);
    expect(report.messages.join(' ')).toContain(
      'check_executions row 1: indexed columns do not match JSON',
    );
  });
});
