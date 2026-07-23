// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AppSettingsSchema,
  type AppSettings,
} from '../../../../../shared/application/contracts.js';
import type {
  CheckFolderReadiness,
  FolderReadinessRequest,
  FolderReadinessResult,
} from '../../../../../shared/settings/folder-readiness.js';
import { useSettingsFolderReadiness } from './useSettingsFolderReadiness.js';

const base = AppSettingsSchema.parse({
  theme: 'system',
  reducedMotion: false,
  density: 'comfortable',
  defaultAgent: 'codex',
  defaultPermissionProfile: 'worktree-write',
  worktreeRoot: '/tmp/forgeboard-worktrees',
  terminalShell: '/bin/sh',
  envAllowlist: ['PATH'],
  previewPortStart: 41_000,
  previewPortEnd: 41_999,
  transcriptRetentionDays: 30,
  backupsEnabled: true,
  backupDirectory: '/tmp/forgeboard-backups',
  collaborationEnabled: false,
  collaborationUrl: 'ws://127.0.0.1:1234',
});

afterEach(cleanup);

describe('useSettingsFolderReadiness', () => {
  it('checks every enabled machine folder and blocks until exact evidence arrives', async () => {
    const check = vi.fn((request: FolderReadinessRequest) => Promise.resolve(ready(request)));
    render(<Harness initial={base} check={check} />);

    expect(screen.getByTestId('blocking').textContent).toBe('2');
    await waitFor(() => expect(screen.getByTestId('blocking').textContent).toBe('0'));
    expect(check).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenCalledWith({
      purpose: 'managed-worktrees',
      path: '/tmp/forgeboard-worktrees',
    });
    expect(check).toHaveBeenCalledWith({
      purpose: 'backup-destination',
      path: '/tmp/forgeboard-backups',
    });
  });

  it('discards a response that does not echo the exact current path', async () => {
    const check = vi.fn((request: FolderReadinessRequest) =>
      Promise.resolve(ready({ ...request, path: '/stale/path' })),
    );
    render(<Harness initial={{ ...base, backupsEnabled: false }} check={check} />);

    await waitFor(() => expect(screen.getByTestId('issue').textContent).toMatch(/older path/u));
    expect(screen.getByTestId('blocking').textContent).toBe('1');
  });

  it('immediately invalidates evidence after the path draft changes', async () => {
    const check = vi.fn((request: FolderReadinessRequest) => Promise.resolve(ready(request)));
    render(<Harness initial={{ ...base, backupsEnabled: false }} check={check} />);
    await waitFor(() => expect(screen.getByTestId('blocking').textContent).toBe('0'));

    act(() => screen.getByRole('button', { name: 'Change path' }).click());
    expect(screen.getByTestId('blocking').textContent).toBe('1');
    await waitFor(() => expect(screen.getByTestId('blocking').textContent).toBe('0'));
    expect(check).toHaveBeenLastCalledWith({
      purpose: 'managed-worktrees',
      path: '/tmp/other-worktrees',
    });

    act(() => screen.getByRole('button', { name: 'Restore path' }).click());
    expect(screen.getByTestId('blocking').textContent).toBe('1');
    await waitFor(() => expect(screen.getByTestId('blocking').textContent).toBe('0'));
  });
});

function Harness({ initial, check }: { initial: AppSettings; check: CheckFolderReadiness }) {
  const [settings, setSettings] = useState(initial);
  const readiness = useSettingsFolderReadiness(settings, check);
  return (
    <>
      <span data-testid="blocking">{readiness.blockingIssues.length}</span>
      <span data-testid="issue">{readiness.blockingIssues[0] ?? ''}</span>
      <button
        type="button"
        onClick={() =>
          setSettings((current) => ({
            ...current,
            worktreeRoot: '/tmp/other-worktrees',
          }))
        }
      >
        Change path
      </button>
      <button
        type="button"
        onClick={() =>
          setSettings((current) => ({
            ...current,
            worktreeRoot: '/tmp/forgeboard-worktrees',
          }))
        }
      >
        Restore path
      </button>
    </>
  );
}

function ready(request: FolderReadinessRequest): FolderReadinessResult {
  return {
    schemaVersion: 1,
    request,
    state: 'ready-existing',
    ready: true,
    checkedAt: '2026-07-15T18:00:00.000Z',
    reason: null,
    warning: null,
  };
}
