import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { CanvasDocument } from '../../../shared/application/contracts.js';
import { LocalStore } from '../../storage.js';

const PROJECT_ID = '00000000-0000-4000-8000-000000000081';
const CANVAS_ID = '00000000-0000-4000-8000-000000000082';
const RUN_ID = '00000000-0000-4000-8000-000000000083';
const NOW = '2026-07-17T12:00:00.000Z';

const stores = new Set<LocalStore>();
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('Git/PR node persistence', () => {
  it('round-trips the opaque target and UI configuration through SQLite', () => {
    const databasePath = createDatabasePath();
    const first = openStore(databasePath);
    const saved = first.saveCanvas(canvasDocument());

    expectGitConfiguration(saved);
    first.close();
    stores.delete(first);

    const reopened = openStore(databasePath);
    const loaded = reopened.loadCanvas(PROJECT_ID);
    expect(loaded).toEqual(saved);
    expectGitConfiguration(loaded);
  });

  it('opens a legacy worktree-bound node without promoting cached display into authority', () => {
    const store = openStore();
    const legacy = canvasDocument({
      worktreeId: 'legacy-worktree',
      branch: 'legacy/agent-branch',
      baseBranch: 'main',
      commitIds: ['abcdef1'],
      ahead: 1,
    });
    const saved = store.saveCanvas(legacy);
    const canonical = saved.canonical?.nodes[0];

    expect(canonical).toMatchObject({
      type: 'git-pr',
      data: { worktreeId: 'legacy-worktree', branch: 'legacy/agent-branch', ahead: 1 },
    });
    expect(canonical?.data).not.toHaveProperty('deliveryTarget');
  });
});

function expectGitConfiguration(document: CanvasDocument | undefined): void {
  expect(document?.nodes[0]?.data).toMatchObject({
    deliveryTarget: { kind: 'agent-run', runId: RUN_ID },
    remote: 'origin',
    destinationBranch: 'feature/remote-delivery',
    baseBranch: 'main',
    pullRequestTitle: 'Add safe remote delivery',
    pullRequestBody: 'Confirm the exact disclosed impact before publication.',
    pullRequestDraft: true,
    pullRequestUrl: 'https://github.com/forgeboard/example/pull/42',
  });
  expect(document?.canonical?.nodes[0]).toMatchObject({
    type: 'git-pr',
    data: {
      deliveryTarget: { kind: 'agent-run', runId: RUN_ID },
      remote: 'origin',
      destinationBranch: 'feature/remote-delivery',
      baseBranch: 'main',
      pullRequestDraft: true,
    },
  });
}

function canvasDocument(data: Record<string, unknown> = configuredData()): CanvasDocument {
  return {
    id: CANVAS_ID,
    projectId: PROJECT_ID,
    name: 'Remote delivery canvas',
    nodes: [
      {
        id: 'git-1',
        type: 'git-pr',
        position: { x: 40, y: 60 },
        width: 380,
        height: 240,
        data: {
          kind: 'git-pr',
          title: 'Git delivery',
          color: '#445566',
          locked: false,
          collapsed: false,
          status: 'idle',
          ...data,
        },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt: NOW,
  };
}

function configuredData(): Record<string, unknown> {
  return {
    deliveryTarget: { kind: 'agent-run', runId: RUN_ID },
    remote: 'origin',
    destinationBranch: 'feature/remote-delivery',
    baseBranch: 'main',
    pullRequestTitle: 'Add safe remote delivery',
    pullRequestBody: 'Confirm the exact disclosed impact before publication.',
    pullRequestDraft: true,
    pullRequestUrl: 'https://github.com/forgeboard/example/pull/42',
  };
}

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'forgeboard-git-pr-persistence-'));
  temporaryDirectories.push(directory);
  return join(directory, 'forgeboard.sqlite3');
}

function openStore(databasePath = createDatabasePath()): LocalStore {
  const store = new LocalStore(databasePath);
  stores.add(store);
  return store;
}
