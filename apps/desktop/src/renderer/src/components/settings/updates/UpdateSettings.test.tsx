// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppSettingsSchema,
  type AppSettings,
} from '../../../../../shared/application/contracts.js';
import { UpdateSettings } from './UpdateSettings.js';

const check = vi.fn();
const cancel = vi.fn(() => Promise.resolve({ ok: true as const, value: { cancelled: false } }));
const openRelease = vi.fn(() => Promise.resolve({ ok: true as const, value: true }));

beforeEach(() => {
  check.mockReset();
  cancel.mockClear();
  openRelease.mockClear();
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: { updates: { check, cancel, openRelease } },
  });
});

afterEach(cleanup);

describe('UpdateSettings', () => {
  it('makes no request before an explicit click and renders main-owned release evidence', async () => {
    check.mockResolvedValueOnce({
      ok: true,
      value: {
        channel: 'prerelease',
        currentVersion: '0.1.0',
        checkedAt: new Date().toISOString(),
        status: 'update-available',
        release: {
          id: 10,
          version: '0.2.0',
          tagName: 'v0.2.0',
          name: 'Artemis 0.2.0',
          url: 'https://github.com/AIAydin/AI-Agent-Orchestrator/releases/tag/v0.2.0',
          publishedAt: '2026-07-17T12:00:00.000Z',
          prerelease: true,
        },
      },
    });
    render(<Harness />);
    expect(check).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    await screen.findByText(/Artemis 0.2.0 is available/u);
    expect(check).toHaveBeenCalledWith({ channel: 'prerelease' });
    fireEvent.click(screen.getByRole('button', { name: 'Review release on GitHub' }));
    await waitFor(() => expect(openRelease).toHaveBeenCalledWith({ releaseId: 10 }));
  });

  it('disables checks in disabled mode and clears legacy download state without auto-download', () => {
    render(<Harness disabled legacy />);
    expect(screen.getByRole('button', { name: 'Check for updates' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.queryByRole('checkbox', { name: /Download updates automatically/u })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear inactive preference' }));
    expect(screen.queryByText(/imported legacy automatic-download/u)).toBeNull();
    expect(check).not.toHaveBeenCalled();
  });

  it('exposes and invokes cancellation only while an explicit update check is active', async () => {
    let finishCheck: ((value: { ok: true; value: null }) => void) | undefined;
    check.mockReturnValueOnce(
      new Promise((resolve) => {
        finishCheck = resolve;
      }),
    );
    cancel.mockResolvedValueOnce({ ok: true, value: { cancelled: true } });
    render(<Harness />);

    expect(screen.queryByRole('button', { name: 'Cancel check' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel check' }));
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Cancelling the update check…',
    );

    finishCheck?.({ ok: true, value: null });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel check' })).toBeNull());
  });
});

function Harness({ disabled = false, legacy = false }: { disabled?: boolean; legacy?: boolean }) {
  const [draft, setDraft] = useState<AppSettings>(
    AppSettingsSchema.parse({
      theme: 'system',
      reducedMotion: false,
      density: 'comfortable',
      defaultAgent: 'codex',
      defaultPermissionProfile: 'worktree-write',
      worktreeRoot: '/tmp/worktrees',
      terminalShell: '/bin/sh',
      envAllowlist: ['PATH'],
      previewPortStart: 41_000,
      previewPortEnd: 41_999,
      transcriptRetentionDays: 30,
      collaborationEnabled: false,
      collaborationUrl: '',
      updateChannel: disabled ? 'disabled' : 'prerelease',
      automaticUpdateDownloads: legacy,
    }),
  );
  return <UpdateSettings currentVersion="0.1.0" draft={draft} setDraft={setDraft} busy={false} />;
}
