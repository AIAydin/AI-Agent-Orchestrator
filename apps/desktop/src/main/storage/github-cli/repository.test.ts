import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { LocalStore, type StoredGitHubCliBinding } from '../../storage.js';

const roots: string[] = [];
const stores = new Set<LocalStore>();

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('device-local GitHub CLI binding storage', () => {
  it('persists one validated custom binding and clears it for automatic mode', () => {
    const path = databasePath();
    const first = openStore(path);
    const binding = customBinding();

    expect(first.getGitHubCliBinding()).toBeUndefined();
    expect(first.saveGitHubCliBinding(binding)).toEqual(binding);
    expect(first.getGitHubCliBinding()).toEqual(binding);
    closeStore(first);

    const reopened = openStore(path);
    expect(reopened.getGitHubCliBinding()).toEqual(binding);
    expect(reopened.clearGitHubCliBinding()).toBe(true);
    expect(reopened.clearGitHubCliBinding()).toBe(false);
    expect(reopened.getGitHubCliBinding()).toBeUndefined();
  });

  it('keeps the binding out of portable exports and preserves it across replace import', () => {
    const source = openStore();
    const portable = source.exportData(new Date('2026-07-17T12:00:00.000Z'));
    const destination = openStore();
    const binding = customBinding();
    destination.saveGitHubCliBinding(binding);

    expect(JSON.stringify(destination.exportData())).not.toContain(binding.executablePath);
    destination.importData(portable, { replaceExisting: true });

    expect(destination.getGitHubCliBinding()).toEqual(binding);
  });

  it('clears the device binding during complete local-data deletion', async () => {
    const store = openStore();
    store.saveGitHubCliBinding(customBinding());

    await store.deleteAllLocalData();

    expect(store.getGitHubCliBinding()).toBeUndefined();
    const inspector = new DatabaseSync(store.databasePath, { readOnly: true });
    expect(
      inspector.prepare('SELECT COUNT(*) AS count FROM github_cli_executable_binding').get(),
    ).toEqual({ count: 0 });
    inspector.close();
  });

  it('reports malformed or internally inconsistent binding rows through integrity checks', () => {
    const store = openStore();
    const binding = customBinding();
    store.saveGitHubCliBinding(binding);
    const connection = new DatabaseSync(store.databasePath);
    connection
      .prepare('UPDATE github_cli_executable_binding SET value_json = ? WHERE singleton = 1')
      .run(JSON.stringify({ ...binding, executableFileName: 'another-file' }));
    connection.close();

    expect(() => store.getGitHubCliBinding()).toThrow(/file name must match/iu);
    const report = store.checkIntegrity('full');
    expect(report.ok).toBe(false);
    expect(report.messages.join(' ')).toContain('github_cli_executable_binding row 1');
  });
});

function customBinding(): StoredGitHubCliBinding {
  return {
    schemaVersion: 1,
    executablePath: '/opt/forgeboard/bin/gh',
    executableFileName: 'gh',
    executableIdentity: {
      dev: 1,
      ino: 2,
      size: 3,
      mtimeMs: 4,
      ctimeMs: 5,
      mode: 0o100755,
      sha256: 'a'.repeat(64),
    },
    version: '2.80.0',
    validatedAt: '2026-07-17T11:00:00.000Z',
  };
}

function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeboard-github-cli-binding-'));
  roots.push(root);
  return join(root, 'data', 'forgeboard.sqlite3');
}

function openStore(path = databasePath()): LocalStore {
  const store = new LocalStore(path);
  stores.add(store);
  return store;
}

function closeStore(store: LocalStore): void {
  store.close();
  stores.delete(store);
}
