import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  AppSettings,
  CanvasDocument,
  Project,
} from '../../../shared/application/contracts.js';
import type {
  CanvasHistoryGraph,
  CanvasHistoryState,
} from '../../../shared/canvas/history/contracts.js';
import {
  CANVAS_HISTORY_MAX_BYTES,
  CanvasWorkspaceStateSchema,
} from '../../../shared/canvas/history/contracts.js';
import { LocalStore } from '../../storage.js';

const PROJECT_ID = '00000000-0000-4000-8000-000000000091';
const CANVAS_ID = '00000000-0000-4000-8000-000000000092';
const T1 = '2026-07-18T12:00:00.000Z';
const T2 = '2026-07-18T12:01:00.000Z';
const T3 = '2026-07-18T12:02:00.000Z';

const stores = new Set<LocalStore>();
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('canvas history persistence', () => {
  it('rejects an atomic load response whose document and history identities differ', () => {
    expect(
      CanvasWorkspaceStateSchema.safeParse({
        document: canvas(graph('current'), T1),
        history: {
          ...history([], []),
          canvasId: '00000000-0000-4000-8000-000000000099',
        },
      }).success,
    ).toBe(false);
  });

  it('round-trips ordered undo and redo lanes across repeated database restarts', () => {
    const databasePath = createDatabasePath();
    const first = openStore(databasePath);
    first.saveProject(project());
    first.saveCanvas(canvas(graph('initial'), T1));
    first.saveCanvasWithHistory({
      document: canvas(graph('current'), T2),
      history: history([graph('initial')], [graph('future')]),
    });

    closeStore(first);
    const second = openStore(databasePath);
    expectHistory(second.loadCanvasHistory(PROJECT_ID), ['initial'], ['future']);

    second.saveCanvasWithHistory({
      document: canvas(graph('initial'), T3),
      history: history([], [graph('current'), graph('future')]),
    });
    closeStore(second);

    const third = openStore(databasePath);
    expect(third.loadCanvas(PROJECT_ID)).toMatchObject({
      id: CANVAS_ID,
      projectId: PROJECT_ID,
      nodes: [{ data: { title: 'initial' } }],
      updatedAt: T3,
    });
    expectHistory(third.loadCanvasHistory(PROJECT_ID), [], ['current', 'future']);
  });

  it('rejects cross-project history atomically without replacing the saved canvas', () => {
    const store = openStore();
    store.saveProject(project());
    const initial = store.saveCanvas(canvas(graph('initial'), T1));

    expect(() =>
      store.saveCanvasWithHistory({
        document: canvas(graph('changed'), T2),
        history: {
          ...history([graph('initial')], []),
          projectId: '00000000-0000-4000-8000-000000000099',
        },
      }),
    ).toThrow('Canvas history project does not match the document.');
    expect(store.loadCanvas(PROJECT_ID)).toEqual(initial);
    expect(store.loadCanvasHistory(PROJECT_ID)).toEqual(history([], []));
  });

  it('discards stale checkpoints when the canvas changes outside the history transaction', () => {
    const store = openStore();
    store.saveProject(project());
    store.saveCanvas(canvas(graph('initial'), T1));
    store.saveCanvasWithHistory({
      document: canvas(graph('current'), T2),
      history: history([graph('initial')], []),
    });
    expectHistory(store.loadCanvasHistory(PROJECT_ID), ['initial'], []);

    store.saveCanvas(canvas(graph('external replacement'), T3));

    expect(store.loadCanvasHistory(PROJECT_ID)).toEqual(history([], []));
    expect(store.listCanvasSnapshots(PROJECT_ID)).not.toContainEqual(
      expect.objectContaining({ reason: 'undo-checkpoint' }),
    );
  });

  it('saves the current canvas while fitting oversized checkpoint bytes to an empty fallback', () => {
    const store = openStore();
    store.saveProject(project());
    store.saveCanvas(canvas(graph('initial'), T1));
    const bytesPerNode = Math.ceil(CANVAS_HISTORY_MAX_BYTES / 20) + 1_000;
    const oversized: CanvasHistoryGraph = {
      nodes: Array.from({ length: 20 }, (_, index) => {
        const node = graph(`oversized-${index}`).nodes[0];
        if (node === undefined) throw new Error('Expected the oversized checkpoint node.');
        return {
          ...node,
          id: `task-${index}`,
          data: { ...node.data, description: 'x'.repeat(bytesPerNode) },
        };
      }),
      edges: [],
    };

    const saved = store.saveCanvasWithHistory({
      document: canvas(graph('current survives'), T2),
      history: history([oversized], []),
    });

    expect(saved.nodes[0]?.data.title).toBe('current survives');
    expect(store.loadCanvas(PROJECT_ID)?.nodes[0]?.data.title).toBe('current survives');
    expect(store.loadCanvasHistory(PROJECT_ID)).toEqual(history([], []));
  });

  it('clears durable edit history when a recoverable snapshot replaces the canvas', () => {
    const store = openStore();
    store.saveProject(project());
    store.saveCanvas(canvas(graph('snapshot target'), T1));
    const snapshot = store.createCanvasSnapshot(PROJECT_ID);
    store.saveCanvasWithHistory({
      document: canvas(graph('current'), T2),
      history: history([graph('snapshot target')], []),
    });

    store.restoreCanvasSnapshot(snapshot.id, new Date(T3));

    expect(store.loadCanvas(PROJECT_ID)?.nodes[0]?.data.title).toBe('snapshot target');
    expect(store.loadCanvasHistory(PROJECT_ID)).toEqual(history([], []));
  });

  it('does not retain destination history through a replace import', () => {
    const source = openStore();
    source.saveProject(project());
    source.saveCanvas(canvas(graph('imported'), T1));
    const exported = source.exportData(new Date(T2));

    const destination = openStore();
    destination.saveProject(project());
    destination.saveCanvas(canvas(graph('destination'), T1));
    destination.saveCanvasWithHistory({
      document: canvas(graph('destination current'), T2),
      history: history([graph('destination')], []),
    });

    destination.importData(exported, { replaceExisting: true });

    expect(destination.loadCanvas(PROJECT_ID)?.nodes[0]?.data.title).toBe('imported');
    expect(destination.loadCanvasHistory(PROJECT_ID)).toEqual(history([], []));
  });

  it('falls back to empty history when its stored payload is malformed', () => {
    const databasePath = createDatabasePath();
    const store = openStore(databasePath);
    store.saveProject(project());
    store.saveCanvas(canvas(graph('initial'), T1));
    store.saveCanvasWithHistory({
      document: canvas(graph('current'), T2),
      history: history([graph('initial')], []),
    });
    const database = new DatabaseSync(databasePath);
    database
      .prepare('UPDATE canvas_history SET value_json = ? WHERE project_id = ?')
      .run(JSON.stringify({ malformed: true }), PROJECT_ID);
    database.close();

    expect(store.loadCanvasHistory(PROJECT_ID)).toEqual(history([], []));
  });

  it('removes durable canvas history during complete local-data deletion', async () => {
    const store = openStore();
    store.saveProject(project());
    store.saveCanvas(canvas(graph('initial'), T1));
    store.saveCanvasWithHistory({
      document: canvas(graph('current'), T2),
      history: history([graph('initial')], []),
    });

    await store.deleteAllLocalData();

    expect(store.loadCanvas(PROJECT_ID)).toBeUndefined();
    expect(store.loadCanvasHistory(PROJECT_ID)).toBeUndefined();
  });

  it('scrubs expired transcripts from both history lanes and reports a durable change', () => {
    const store = openStore();
    store.saveProject(project());
    store.saveCanvas(canvas(graph('initial'), T1));
    store.saveCanvasWithHistory({
      document: canvas(graph('current'), T2),
      history: history([transcriptGraph('past secret')], [transcriptGraph('future secret')]),
    });
    let durableChanges = 0;
    const unsubscribe = store.subscribeToDurableChanges(() => {
      durableChanges += 1;
    });

    const result = store.applyRetention(retentionSettings(), new Date(T3));
    unsubscribe();

    expect(result.scrubbedHistoryTranscripts).toBe(2);
    expect(durableChanges).toBeGreaterThan(0);
    expect(JSON.stringify(store.loadCanvasHistory(PROJECT_ID))).not.toContain('secret');
  });
});

function graph(title: string): CanvasHistoryGraph {
  return {
    nodes: [
      {
        id: 'task-1',
        type: 'task',
        position: { x: 12, y: 24 },
        data: { title },
      },
    ],
    edges: [],
  };
}

function transcriptGraph(transcript: string): CanvasHistoryGraph {
  return {
    nodes: [
      {
        id: `agent-${transcript.split(' ')[0]}`,
        type: 'agent',
        position: { x: 12, y: 24 },
        data: {
          title: 'Agent',
          transcript,
          transcriptUpdatedAt: '2025-01-01T00:00:00.000Z',
        },
      },
    ],
    edges: [],
  };
}

function retentionSettings(): AppSettings {
  return {
    onboardingCompleted: true,
    theme: 'system',
    reducedMotion: false,
    density: 'comfortable',
    canvasGridSize: 16,
    canvasSnapToGrid: true,
    keyboardPreset: 'standard',
    defaultAgent: 'test-agent',
    defaultPermissionProfile: 'plan-read-only',
    agentExecutableOverrides: {},
    agentDefaultModels: {},
    customAgent: {
      enabled: false,
      name: 'Custom CLI',
      providerName: 'Custom provider',
      providerDisclosure: 'Disclosure.',
      sendsContextOffDevice: true,
      executable: '',
      versionArguments: ['--version'],
      launchArguments: [],
      promptTransport: 'argument',
      runtime: 'pty',
      output: 'text',
    },
    customPermissionProfile: {
      runtime: 'host',
      filesystem: 'assigned-worktree-read-only',
      readPaths: ['.'],
      writePaths: [],
      ignoredFileRead: 'deny',
      sensitiveFileRead: 'deny',
      executablePolicy: 'selected-agent-only',
      allowedExecutables: [],
      forgeboardManagedActions: { developmentServers: 'deny', tests: 'deny' },
      requireReviewBeforePrimary: true,
      docker: {
        network: 'disabled',
        cpuLimit: 2,
        memoryMb: 4096,
        mountHostCredentials: false,
      },
    },
    worktreeRoot: '/tmp/worktrees',
    worktreeCleanupPolicy: 'manual',
    branchPrefix: 'forgeboard/',
    gitIdentityName: '',
    gitIdentityEmail: '',
    gitRemote: 'origin',
    externalEditorExecutable: '',
    terminalShell: '/bin/sh',
    envAllowlist: ['PATH'],
    developmentCommand: { executable: '', arguments: [] },
    testCommand: { executable: '', arguments: [] },
    lintCommand: { executable: '', arguments: [] },
    typecheckCommand: { executable: '', arguments: [] },
    buildCommand: { executable: '', arguments: [] },
    previewPortStart: 4100,
    previewPortEnd: 4200,
    previewTrustedHosts: ['127.0.0.1'],
    dockerEnabled: false,
    dockerExecutable: 'docker',
    dockerImage: '',
    dockerContainerExecutable: '',
    dockerNetwork: 'disabled',
    dockerCpuLimit: 2,
    dockerMemoryMb: 4096,
    dockerMountHostCredentials: false,
    transcriptRetentionDays: 30,
    auditRetentionDays: 365,
    snapshotRetentionCount: 100,
    autosaveIntervalMs: 2_000,
    backupsEnabled: true,
    backupDirectory: '/tmp/backups',
    backupIntervalHours: 24,
    backupOnQuit: true,
    backupRetentionCount: 30,
    collaborationEnabled: false,
    collaborationUrl: '',
    collaborationManagementUrl: '',
    collaborationDisplayName: 'Local user',
    collaborationSubject: 'local-user',
    collaborationColor: '#6d5efc',
    collaborationRoom: 'default',
    collaborationReconnect: true,
    updateChannel: 'stable',
    automaticUpdateDownloads: false,
    voiceCommandsEnabled: false,
    voiceAutoRunSafeActions: false,
  };
}

function history(past: CanvasHistoryGraph[], future: CanvasHistoryGraph[]): CanvasHistoryState {
  return { projectId: PROJECT_ID, canvasId: CANVAS_ID, past, future };
}

function expectHistory(
  state: CanvasHistoryState | undefined,
  pastTitles: string[],
  futureTitles: string[],
): void {
  expect(state).toMatchObject({ projectId: PROJECT_ID, canvasId: CANVAS_ID });
  expect(state?.past.map((entry) => entry.nodes[0]?.data.title)).toEqual(pastTitles);
  expect(state?.future.map((entry) => entry.nodes[0]?.data.title)).toEqual(futureTitles);
}

function canvas(graphValue: CanvasHistoryGraph, updatedAt: string): CanvasDocument {
  return {
    id: CANVAS_ID,
    projectId: PROJECT_ID,
    name: 'Durable history canvas',
    ...graphValue,
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt,
  };
}

function project(): Project {
  return {
    id: PROJECT_ID,
    name: 'Durable history project',
    path: '/tmp/forgeboard-durable-history-project',
    openedAt: T1,
    missing: false,
    health: {
      isGitRepository: false,
      branch: null,
      dirty: false,
      remotes: [],
      packageManager: 'unknown',
      frameworks: [],
      scripts: {},
      hasSubmodules: false,
      sensitiveWarnings: [],
    },
  };
}

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'forgeboard-canvas-history-'));
  temporaryDirectories.push(directory);
  return join(directory, 'forgeboard.sqlite3');
}

function openStore(databasePath = createDatabasePath()): LocalStore {
  const store = new LocalStore(databasePath);
  stores.add(store);
  return store;
}

function closeStore(store: LocalStore): void {
  store.close();
  stores.delete(store);
}
