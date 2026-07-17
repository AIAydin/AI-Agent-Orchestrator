import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { CanvasDocument } from '../../../shared/application/contracts.js';
import { LocalStore } from '../../storage.js';

const PROJECT_ID = '00000000-0000-4000-8000-000000000071';
const CANVAS_ID = '00000000-0000-4000-8000-000000000072';
const T1 = '2026-07-16T18:00:00.000Z';
const T2 = '2026-07-16T18:01:00.000Z';

const stores = new Set<LocalStore>();
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('group frame canvas persistence', () => {
  it('round-trips renderer dimensions, collapse state, and group configuration through storage', () => {
    const databasePath = createDatabasePath();
    const first = openStore(databasePath);

    const saved = first.saveCanvas(canvasDocument());
    expectGroupFrame(saved, {
      width: 777.5,
      height: 444.25,
      collapsed: true,
      purpose: 'feature-area',
      layout: 'grid',
      autoFit: true,
      childNodeIds: ['task-1', 'task-2'],
    });

    closeStore(first);
    const reopened = openStore(databasePath);
    const loaded = reopened.loadCanvas(PROJECT_ID);

    expect(loaded).toEqual(saved);
    expectGroupFrame(loaded, {
      width: 777.5,
      height: 444.25,
      collapsed: true,
      purpose: 'feature-area',
      layout: 'grid',
      autoFit: true,
      childNodeIds: ['task-1', 'task-2'],
    });
  });

  it('promotes a newer renderer edit over embedded canonical data without restoring stale values', () => {
    const store = openStore();
    const initial = store.saveCanvas(canvasDocument());
    const edited: CanvasDocument = {
      ...initial,
      updatedAt: T2,
      nodes: initial.nodes.map((node) =>
        node.id === 'frame-1'
          ? {
              ...node,
              width: 612,
              height: 318,
              data: {
                ...node.data,
                collapsed: false,
                purpose: 'workflow-stage',
                layout: 'vertical',
                autoFit: false,
                childNodeIds: ['task-2'],
              },
            }
          : node,
      ),
    };

    const saved = store.saveCanvas(edited);
    const loaded = store.loadCanvas(PROJECT_ID);
    const expected = {
      width: 612,
      height: 318,
      collapsed: false,
      purpose: 'workflow-stage' as const,
      layout: 'vertical' as const,
      autoFit: false,
      childNodeIds: ['task-2'],
    };

    expectGroupFrame(saved, expected);
    expectGroupFrame(loaded, expected);
    expect(loaded?.canonical?.groups.find((group) => group.id === 'frame-1')?.nodeIds).toEqual([
      'task-2',
    ]);
    expect(loaded?.canonical?.nodes.find((node) => node.id === 'task-1')).not.toHaveProperty(
      'groupId',
    );
    expect(loaded?.canonical?.nodes.find((node) => node.id === 'task-2')).toMatchObject({
      groupId: 'frame-1',
    });
  });
});

interface ExpectedGroupFrame {
  readonly width: number;
  readonly height: number;
  readonly collapsed: boolean;
  readonly purpose: 'product-surface' | 'workflow-stage' | 'feature-area' | 'custom';
  readonly layout: 'freeform' | 'horizontal' | 'vertical' | 'grid';
  readonly autoFit: boolean;
  readonly childNodeIds: readonly string[];
}

function expectGroupFrame(
  document: CanvasDocument | undefined,
  expected: ExpectedGroupFrame,
): void {
  expect(document).toBeDefined();
  const surface = document?.nodes.find((node) => node.id === 'frame-1');
  expect(surface).toMatchObject({
    width: expected.width,
    height: expected.height,
    data: {
      collapsed: expected.collapsed,
      purpose: expected.purpose,
      layout: expected.layout,
      autoFit: expected.autoFit,
      childNodeIds: expected.childNodeIds,
    },
  });

  const canonical = document?.canonical?.nodes.find((node) => node.id === 'frame-1');
  expect(canonical).toMatchObject({
    type: 'group-frame',
    size: { width: expected.width, height: expected.height },
    collapsed: expected.collapsed,
    data: {
      purpose: expected.purpose,
      layout: expected.layout,
      autoFit: expected.autoFit,
      childNodeIds: expected.childNodeIds,
    },
  });
}

function canvasDocument(): CanvasDocument {
  return {
    id: CANVAS_ID,
    projectId: PROJECT_ID,
    name: 'Group persistence canvas',
    nodes: [
      {
        id: 'frame-1',
        type: 'group-frame',
        position: { x: 40, y: 60 },
        width: 777.5,
        height: 444.25,
        data: {
          kind: 'group-frame',
          title: 'Delivery frame',
          color: '#445566',
          locked: false,
          collapsed: true,
          status: 'idle',
          purpose: 'feature-area',
          layout: 'grid',
          autoFit: true,
          childNodeIds: ['task-1', 'task-2'],
        },
      },
      taskNode('task-1', 90),
      taskNode('task-2', 410),
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt: T1,
  };
}

function taskNode(id: string, x: number): CanvasDocument['nodes'][number] {
  return {
    id,
    type: 'task',
    position: { x, y: 120 },
    width: 260,
    height: 150,
    data: {
      kind: 'task',
      title: id,
      color: '#556677',
      locked: false,
      collapsed: false,
      status: 'idle',
    },
  };
}

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'forgeboard-group-frame-persistence-'));
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
