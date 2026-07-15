import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import type { CanvasDocument, ExtensionCanvasNodeTypeView, Project } from '../shared/contracts.js';
import { LocalStore } from './storage.js';
import { canvasContentHash } from './storage/values.js';

const PROJECT_ID = '70000000-0000-4000-8000-000000000001';
const CANVAS_ID = '70000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-07-14T16:00:00.000Z');
const roots: string[] = [];
const stores = new Set<LocalStore>();

const definition: ExtensionCanvasNodeTypeView = {
  id: 'release-card',
  displayName: 'Release card',
  description: 'A bounded declarative extension node.',
  category: 'Planning',
  icon: 'note',
  color: '#4F46E5',
  capabilities: ['human-editable'],
  fields: [
    {
      id: 'state',
      kind: 'select',
      label: 'State',
      required: true,
      options: [
        { label: 'Draft', value: 'draft' },
        { label: 'Ready', value: 'ready' },
      ],
      defaultValue: 'draft',
    },
    {
      id: 'references',
      kind: 'file-reference',
      label: 'References',
      required: false,
      multiple: true,
    },
  ],
  ports: [],
};

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('LocalStore authoritative extension value sanitation', () => {
  it('normalizes extension values before canvas and snapshot persistence', () => {
    const store = openStore();
    store.saveProject(project());
    const saved = store.saveCanvas(
      canvas(
        {
          state: 'undeclared-state',
          references: ['/tmp/reference.md', '/tmp/reference.md'],
          hiddenPayload: 'must-not-persist',
        },
        true,
      ),
    );

    expect(extensionData(saved)).not.toHaveProperty('hiddenTopLevelPayload');
    expect(extensionData(saved)['extensionValues']).toEqual({
      state: 'draft',
      references: ['/tmp/reference.md'],
    });
    const snapshot = store.createCanvasSnapshot(PROJECT_ID);
    expect(snapshot.contentHash).toBe(canvasHash(snapshot.document));
    expect(extensionData(snapshot.document)['extensionValues']).toEqual({
      state: 'draft',
      references: ['/tmp/reference.md'],
    });

    const inspector = new DatabaseSync(store.databasePath, { readOnly: true });
    const canvasJson = (
      inspector
        .prepare('SELECT value_json FROM canvas_documents WHERE project_id = ?')
        .get(PROJECT_ID) as { value_json: string }
    ).value_json;
    const snapshotJson = (
      inspector
        .prepare('SELECT value_json FROM canvas_snapshots WHERE id = ?')
        .get(snapshot.id) as { value_json: string }
    ).value_json;
    inspector.close();
    expect(`${canvasJson}${snapshotJson}`).not.toContain('must-not-persist');
    expect(JSON.stringify(store.exportData(NOW))).not.toContain('must-not-persist');
    expect(store.checkIntegrity('full')).toMatchObject({ ok: true, messages: [] });
  });

  it('repairs legacy canvas and snapshot values while keeping snapshot hashes consistent', () => {
    const databasePath = temporaryDatabasePath();
    const original = openStore(databasePath);
    original.saveProject(project());
    original.saveCanvas(canvas({ state: 'ready', references: ['/tmp/ready.md'] }));
    const snapshot = original.createCanvasSnapshot(PROJECT_ID);
    closeStore(original);

    const database = new DatabaseSync(databasePath);
    const canvasRow = database
      .prepare('SELECT value_json FROM canvas_documents WHERE project_id = ?')
      .get(PROJECT_ID) as { value_json: string };
    const poisonedCanvas = poisonCanvas(JSON.parse(canvasRow.value_json) as CanvasDocument);
    database
      .prepare('UPDATE canvas_documents SET value_json = ? WHERE project_id = ?')
      .run(JSON.stringify(poisonedCanvas), PROJECT_ID);

    const snapshotRow = database
      .prepare('SELECT value_json FROM canvas_snapshots WHERE id = ?')
      .get(snapshot.id) as { value_json: string };
    const poisonedSnapshot = JSON.parse(snapshotRow.value_json) as typeof snapshot;
    poisonedSnapshot.document = poisonCanvas(poisonedSnapshot.document);
    poisonedSnapshot.contentHash = canvasHash(poisonedSnapshot.document);
    database
      .prepare('UPDATE canvas_snapshots SET content_hash = ?, value_json = ? WHERE id = ?')
      .run(poisonedSnapshot.contentHash, JSON.stringify(poisonedSnapshot), snapshot.id);
    database.close();

    const repaired = openStore(databasePath);
    const loaded = repaired.loadCanvas(PROJECT_ID)!;
    expect(extensionData(loaded)['extensionValues']).toEqual({ state: 'draft', references: [] });
    const repairedSnapshot = repaired.listCanvasSnapshots(PROJECT_ID)[0]!;
    expect(extensionData(repairedSnapshot.document)['extensionValues']).toEqual({
      state: 'draft',
      references: [],
    });
    expect(repairedSnapshot.contentHash).toBe(canvasHash(repairedSnapshot.document));
    expect(JSON.stringify(repaired.exportData(NOW))).not.toContain('legacy-malicious-payload');
    expect(repaired.checkIntegrity('full')).toMatchObject({ ok: true, messages: [] });

    const inspector = new DatabaseSync(databasePath, { readOnly: true });
    const persisted = inspector
      .prepare(
        `SELECT value_json FROM canvas_documents
         UNION ALL SELECT value_json FROM canvas_snapshots`,
      )
      .all() as unknown as { value_json: string }[];
    inspector.close();
    expect(JSON.stringify(persisted)).not.toContain('legacy-malicious-payload');
  });

  it('rejects rewritten canvas values and malformed snapshot definitions before import mutation', () => {
    const source = openStore();
    source.saveProject(project());
    source.saveCanvas(canvas({ state: 'ready', references: ['/tmp/ready.md'] }));
    source.createCanvasSnapshot(PROJECT_ID);
    const exported = source.exportData(NOW);

    const destination = openStore();
    destination.saveProject(project({ name: 'Existing destination project' }));
    destination.saveCanvas(canvas({ state: 'draft', references: [] }));
    const before = destination.exportData(NOW);

    const rewrittenCanvasImport = structuredClone(exported);
    const importedCanvas = rewrittenCanvasImport.canvases[0];
    if (!importedCanvas) throw new Error('Expected an exported canvas fixture.');
    const importedCanvasData = extensionData(importedCanvas);
    importedCanvasData['extensionValues'] = {
      state: 'not-an-option',
      references: [],
      undeclared: 'import-payload',
    };
    awaitAtomicRejection(destination, rewrittenCanvasImport, before, 'would be rewritten');

    const malformedSnapshotImport = structuredClone(exported);
    const importedSnapshot = malformedSnapshotImport.snapshots[0];
    if (!importedSnapshot) throw new Error('Expected an exported snapshot fixture.');
    const importedSnapshotData = extensionData(importedSnapshot.document);
    delete importedSnapshotData['extensionDefinition'];
    importedSnapshot.contentHash = canvasHash(importedSnapshot.document);
    awaitAtomicRejection(destination, malformedSnapshotImport, before, 'invalid extension data');
  });
});

function openStore(path = temporaryDatabasePath()): LocalStore {
  const store = new LocalStore(path);
  stores.add(store);
  return store;
}

function closeStore(store: LocalStore): void {
  store.close();
  stores.delete(store);
}

function temporaryDatabasePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeboard-extension-values-'));
  roots.push(root);
  return join(root, 'data', 'forgeboard.sqlite3');
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    name: 'Extension value project',
    path: '/tmp/extension-value-project',
    openedAt: NOW.toISOString(),
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
    ...overrides,
  };
}

function canvas(
  extensionValues: Record<string, unknown>,
  includeHiddenTopLevelPayload = false,
): CanvasDocument {
  return {
    id: CANVAS_ID,
    projectId: PROJECT_ID,
    name: 'Extension canvas',
    nodes: [
      {
        id: 'extension-node',
        type: 'extension',
        position: { x: 10, y: 20 },
        data: {
          kind: 'extension',
          title: 'Release',
          description: '',
          status: 'idle',
          locked: false,
          collapsed: false,
          color: '#4F46E5',
          extensionId: 'example.release',
          extensionVersion: '1.0.0',
          extensionNodeTypeId: definition.id,
          extensionDefinition: definition,
          extensionValues,
          ...(includeHiddenTopLevelPayload ? { hiddenTopLevelPayload: 'must-not-persist' } : {}),
        },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt: NOW.toISOString(),
  };
}

function poisonCanvas(document: CanvasDocument): CanvasDocument {
  const poisoned = structuredClone(document);
  const data = extensionData(poisoned);
  data['extensionValues'] = {
    state: 'not-an-option',
    references: ['relative/path'],
    undeclared: 'legacy-malicious-payload',
  };
  data['hiddenTopLevelPayload'] = 'legacy-malicious-payload';
  return poisoned;
}

function extensionData(document: CanvasDocument): Record<string, unknown> {
  const node = document.nodes[0];
  if (!node) throw new Error('Expected an extension node fixture.');
  return node.data;
}

function canvasHash(document: CanvasDocument): string {
  return canvasContentHash(document);
}

function awaitAtomicRejection(
  store: LocalStore,
  imported: unknown,
  before: ReturnType<LocalStore['exportData']>,
  expectedMessage: string,
): void {
  expect(() => store.importData(imported, { replaceExisting: true })).toThrow(expectedMessage);
  expect(store.exportData(NOW)).toEqual(before);
}
