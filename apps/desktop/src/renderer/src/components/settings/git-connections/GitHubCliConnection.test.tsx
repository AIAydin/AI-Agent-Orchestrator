// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  GitHubCliSelectionPlanView,
  GitHubCliStatusView,
} from '../../../../../shared/git/connections/index.js';
import { GitHubCliConnection } from './GitHubCliConnection.js';

const PLAN_ID = '20000000-0000-4000-8000-000000000001';
const NOW = '2026-07-17T12:00:00.000Z';

const status = vi.fn();
const refresh = vi.fn();
const chooseGitHubCli = vi.fn();
const useAutomaticGitHubCli = vi.fn();
const confirmGitHubCli = vi.fn();
const cancelPlan = vi.fn();

beforeEach(() => {
  status.mockReset().mockResolvedValue({ ok: true, value: readyCliStatus() });
  refresh.mockReset().mockResolvedValue({ ok: true, value: readyCliStatus() });
  chooseGitHubCli.mockReset();
  useAutomaticGitHubCli.mockReset();
  confirmGitHubCli.mockReset();
  cancelPlan.mockReset().mockResolvedValue({ ok: true, value: { acknowledged: true } });
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: {
      git: {
        connections: {
          status,
          refresh,
          chooseGitHubCli,
          useAutomaticGitHubCli,
          confirmGitHubCli,
          cancelPlan,
        },
      },
    },
  });
});

afterEach(cleanup);

describe('GitHubCliConnection', () => {
  it('reviews both custom browse and missing automatic GitHub CLI sources without auth claims', async () => {
    chooseGitHubCli.mockResolvedValue({ ok: true, value: customCliPlan() });
    useAutomaticGitHubCli.mockResolvedValue({ ok: true, value: automaticCliPlan() });
    confirmGitHubCli.mockResolvedValue({ ok: true, value: unavailableCliStatus() });
    render(<GitHubCliConnection settingsBusy={false} onError={vi.fn()} />);
    expect(await screen.findByText('GitHub CLI ready')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Choose GitHub CLI file' }));
    let dialog = await screen.findByRole('alertdialog', { name: 'GitHub CLI setup' });
    expect(within(dialog).getByText('custom-gh')).toBeTruthy();
    expect(within(dialog).getByText(/does not sign in, contact GitHub/u)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Go back' }));
    await waitFor(() => expect(cancelPlan).toHaveBeenCalledWith({ planId: PLAN_ID }));

    fireEvent.click(screen.getByRole('button', { name: 'Find GitHub CLI automatically' }));
    dialog = await screen.findByRole('alertdialog', { name: 'GitHub CLI setup' });
    expect(within(dialog).getByText('None found yet')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue to confirmation' }));
    await waitFor(() => expect(confirmGitHubCli).toHaveBeenCalledWith({ planId: PLAN_ID }));
    expect(await screen.findByText('GitHub CLI not found')).toBeTruthy();
    expect(screen.queryByText(/authenticated successfully/iu)).toBeNull();
  });

  it('refreshes GitHub CLI status on request without contacting GitHub', async () => {
    render(<GitHubCliConnection settingsBusy={false} onError={vi.fn()} />);
    expect(await screen.findByText('GitHub CLI ready')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh GitHub CLI status' }));

    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(await screen.findByText('GitHub CLI status updated.')).toBeTruthy();
  });

  it('cancels a selection plan that finishes preparing after unmount', async () => {
    const deferredPlan = deferred<{ ok: true; value: GitHubCliSelectionPlanView }>();
    chooseGitHubCli.mockReturnValue(deferredPlan.promise);
    const view = render(<GitHubCliConnection settingsBusy={false} onError={vi.fn()} />);
    expect(await screen.findByText('GitHub CLI ready')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Choose GitHub CLI file' }));
    view.unmount();
    deferredPlan.resolve({ ok: true, value: customCliPlan() });

    await waitFor(() => expect(cancelPlan).toHaveBeenCalledWith({ planId: PLAN_ID }));
    expect(confirmGitHubCli).not.toHaveBeenCalled();
  });
});

function readyCliStatus(): GitHubCliStatusView {
  return {
    source: 'custom',
    state: 'ready',
    identity: {
      source: 'custom',
      filename: 'custom-gh',
      sizeBytes: 42_000_000,
      sha256: 'b'.repeat(64),
      version: '2.76.1',
    },
    verifiedAt: NOW,
    checkedAt: NOW,
  };
}

function unavailableCliStatus(): GitHubCliStatusView {
  return {
    source: 'automatic',
    state: 'unavailable',
    identity: null,
    verifiedAt: null,
    checkedAt: NOW,
  };
}

function customCliPlan(): GitHubCliSelectionPlanView {
  return {
    kind: 'github-cli-selection',
    planId: PLAN_ID,
    expiresAt: '2026-07-17T12:10:00.000Z',
    source: 'custom',
    candidate: { ...readyCliStatus().identity!, version: null },
    networkAccess: false,
  };
}

function automaticCliPlan(): GitHubCliSelectionPlanView {
  return {
    kind: 'github-cli-selection',
    planId: PLAN_ID,
    expiresAt: '2026-07-17T12:10:00.000Z',
    source: 'automatic',
    candidate: null,
    networkAccess: false,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
