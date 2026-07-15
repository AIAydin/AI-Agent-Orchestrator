// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';

const mocks = vi.hoisted(() => ({
  flushCanvas: vi.fn<() => Promise<boolean>>(),
  unsubscribe: vi.fn(),
}));

vi.mock('./components/workspace/shell/Workspace.js', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return {
    Workspace: forwardRef(function MockWorkspace(
      _props: unknown,
      ref: React.ForwardedRef<{ flushCanvas: () => Promise<boolean> }>,
    ) {
      useImperativeHandle(ref, () => ({ flushCanvas: mocks.flushCanvas }), []);
      return <div>Workspace open</div>;
    }),
  };
});

vi.mock('./components/onboarding/Welcome.js', () => ({
  Welcome: ({ onOpenRecent }: { onOpenRecent: (path: string) => void }) => (
    <button type="button" onClick={() => onOpenRecent('/tmp/project')}>
      Open project
    </button>
  ),
}));

vi.mock('./components/settings/shell/SettingsPanel.js', () => ({ SettingsPanel: () => null }));
vi.mock('./components/onboarding/SetupWizard.js', () => ({ SetupWizard: () => null }));

let closeListener: (() => boolean | Promise<boolean>) | null = null;

beforeEach(() => {
  closeListener = null;
  mocks.flushCanvas.mockReset();
  mocks.unsubscribe.mockReset();
  mocks.flushCanvas.mockResolvedValue(true);
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: false })),
  });
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: forgeboardApi(),
  });
});

afterEach(cleanup);

describe('App close persistence', () => {
  it('delegates native close requests and blocks close when the workspace flush fails', async () => {
    const view = render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open project' }));
    await screen.findByText('Workspace open');
    expect(closeListener).not.toBeNull();

    mocks.flushCanvas.mockResolvedValueOnce(false);
    let allowClose = true;
    await act(async () => {
      allowClose = await closeListener!();
    });
    expect(allowClose).toBe(false);
    expect(mocks.flushCanvas).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Workspace open')).toBeTruthy();

    mocks.flushCanvas.mockResolvedValueOnce(true);
    await act(async () => {
      allowClose = await closeListener!();
    });
    expect(allowClose).toBe(true);

    view.unmount();
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

function forgeboardApi() {
  const project = {
    id: '60000000-0000-4000-8000-000000000001',
    name: 'Project',
    path: '/tmp/project',
    openedAt: '2026-07-15T12:00:00.000Z',
    missing: false,
    health: {
      isGitRepository: true,
      branch: 'main',
      dirty: false,
      remotes: [],
      packageManager: 'pnpm',
      frameworks: [],
      scripts: {},
      hasSubmodules: false,
      sensitiveWarnings: [],
    },
  };
  const settings = {
    onboardingCompleted: true,
    theme: 'system',
    density: 'comfortable',
    reducedMotion: false,
  };
  const ok = <Value,>(value: Value) => Promise.resolve({ ok: true as const, value });

  return {
    app: {
      getInfo: () => ok({ version: '0.1.0' }),
      onCloseRequested: (listener: () => boolean | Promise<boolean>) => {
        closeListener = listener;
        return mocks.unsubscribe;
      },
    },
    settings: { get: () => ok(settings) },
    agents: { detect: () => ok([]) },
    extensions: {
      list: () =>
        ok({
          registryPath: '/tmp/extensions.json',
          installed: [],
          quarantined: [],
          invalid: [],
        }),
    },
    projects: {
      recent: () => ok([project]),
      open: () => ok(project),
    },
  };
}
