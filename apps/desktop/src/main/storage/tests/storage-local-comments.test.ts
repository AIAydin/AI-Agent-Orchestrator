import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { CanvasDocument } from '../../../shared/application/contracts.js';
import { LocalStore } from '../../storage.js';

const PROJECT_ID = '00000000-0000-4000-8000-000000000091';
const CANVAS_ID = '00000000-0000-4000-8000-000000000092';
const NOW = '2026-07-17T12:00:00.000Z';
const stores = new Set<LocalStore>();
const directories: string[] = [];

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('local node comment storage', () => {
  it('round-trips private and shared scopes across a database restart', () => {
    const path = databasePath();
    const first = open(path);
    const canonical = first.saveCanvas(document()).canonical;
    if (canonical === undefined) throw new Error('Expected canonical canvas.');
    const saved = first.saveCanvas({
      ...document(),
      schemaVersion: 2,
      canonical: {
        ...canonical,
        nodes: canonical.nodes.map((node) => ({
          ...node,
          comments: [
            {
              id: 'local:restart',
              authorId: 'local-user',
              scope: 'local' as const,
              body: 'Never publish this',
              createdAt: NOW,
            },
            {
              id: 'shared-restart',
              authorId: 'editor-1',
              scope: 'shared' as const,
              body: 'Room-visible',
              createdAt: NOW,
            },
          ],
        })),
      },
    });
    close(first);

    const loaded = open(path).loadCanvas(PROJECT_ID);
    expect(loaded).toEqual(saved);
    expect(loaded?.canonical?.nodes[0]?.comments).toMatchObject([
      { id: 'local:restart', scope: 'local', body: 'Never publish this' },
      { id: 'shared-restart', scope: 'shared', body: 'Room-visible' },
    ]);
  });
});

function document(): CanvasDocument {
  return {
    id: CANVAS_ID,
    projectId: PROJECT_ID,
    name: 'Comment persistence',
    nodes: [
      {
        id: 'node-1',
        type: 'task',
        position: { x: 0, y: 0 },
        data: { kind: 'task', title: 'Task', color: '#445566' },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt: NOW,
  };
}

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'forgeboard-local-comments-'));
  directories.push(directory);
  return join(directory, 'forgeboard.sqlite3');
}

function open(path: string): LocalStore {
  const store = new LocalStore(path);
  stores.add(store);
  return store;
}

function close(store: LocalStore): void {
  store.close();
  stores.delete(store);
}
