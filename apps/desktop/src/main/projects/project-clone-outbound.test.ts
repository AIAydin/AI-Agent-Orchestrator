import { mkdtempSync, rmSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RepositoryService } from '@forgeboard/git-engine';
import type { App, Dialog } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OutboundActionGate } from '../outbound/outbound-action-gate.js';
import type { executeGitClone } from '../outbound/outbound-executors.js';
import { ProjectService } from './project-service.js';
import { LocalStore } from '../storage.js';

const roots: string[] = [];
const stores: LocalStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ProjectService clone outbound boundary', () => {
  it('returns null on native cancellation before starting Git or creating the destination', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeboard-clone-outbound-'));
    roots.push(root);
    const store = new LocalStore(join(root, 'data', 'forgeboard.sqlite3'));
    stores.push(store);
    const cloneExecutor = vi.fn((...arguments_: Parameters<typeof executeGitClone>) => {
      void arguments_;
      return Promise.resolve();
    });
    const repositories = {
      git: {
        withDelegateAuthorization: async <Value>(
          _authorize: unknown,
          operation: () => Promise<Value>,
        ): Promise<Value> => await operation(),
      },
    } as unknown as RepositoryService;
    const projects = new ProjectService(
      {} as App,
      {} as Dialog,
      store,
      repositories,
      cloneExecutor,
    );
    const gate = new OutboundActionGate(store);
    const destination = join(root, 'repository');
    const result = await projects.clone('https://github.com/owner/repository.git', destination, {
      ownerId: 'web-contents:42:test-owner',
      gate,
      confirmation: { confirm: () => Promise.resolve('denied') },
      assertCurrent: vi.fn(),
      authorizeGitDelegates: () => Promise.resolve(null),
    });

    expect(result).toBeNull();
    expect(cloneExecutor).not.toHaveBeenCalled();
    await expect(access(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(store.listAuditEvents(1)[0]).toMatchObject({
      category: 'external-send',
      action: 'git-clone',
      outcome: 'denied',
    });
    expect(JSON.stringify(store.exportData().audit.at(-1)?.metadata)).not.toContain('github.com');
  });
});
