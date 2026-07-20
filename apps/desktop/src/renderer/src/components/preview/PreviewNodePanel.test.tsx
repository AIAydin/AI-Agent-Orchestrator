// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/unbound-method -- API members are Vitest mocks in this file. */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppSettingsSchema,
  type PreviewSessionSnapshot,
  type Project,
} from '../../../../shared/application/contracts.js';
import type { PreviewRendererOperations } from './controller/operations.js';
import { PreviewNodePanel } from './PreviewNodePanel.js';

const PROJECT_ID = 'd95d6c69-8409-4f0d-bb42-940b38b0a703';
const RUN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const blankCommandSettings = AppSettingsSchema.parse({
  theme: 'system',
  reducedMotion: false,
  density: 'comfortable',
  defaultAgent: 'test-agent',
  defaultPermissionProfile: 'worktree-write',
  worktreeRoot: '/tmp/forgeboard-worktrees',
  branchPrefix: 'forgeboard/',
  gitRemote: 'origin',
  terminalShell: '/bin/sh',
  envAllowlist: ['PATH'],
  developmentCommand: { executable: '', arguments: [] },
  previewPortStart: 41_000,
  previewPortEnd: 41_999,
  transcriptRetentionDays: 30,
  collaborationEnabled: false,
  collaborationUrl: '',
});

function project(scripts: Record<string, string>): Project {
  return {
    id: PROJECT_ID,
    name: 'detected-project',
    path: '/tmp/detected-project',
    openedAt: '2026-07-14T16:00:00.000Z',
    missing: false,
    health: {
      isGitRepository: true,
      branch: 'main',
      dirty: false,
      remotes: [],
      packageManager: 'pnpm',
      frameworks: ['Vite'],
      scripts,
      hasSubmodules: false,
      sensitiveWarnings: [],
    },
  };
}

function session(status: PreviewSessionSnapshot['status'] = 'stopped'): PreviewSessionSnapshot {
  const ready = status === 'ready';
  return {
    id: '024b6a04-8a03-4d24-a16f-4baf20ddb3f5',
    status,
    startedAt: '2026-07-14T16:00:00.000Z',
    readyAt: ready ? '2026-07-14T16:00:01.000Z' : null,
    stoppedAt: ready ? null : '2026-07-14T16:00:01.000Z',
    failure: null,
    trustedHosts: ['127.0.0.1'],
    processes: ready
      ? [
          {
            id: 'server',
            pid: 123,
            cwd: '.',
            port: 41_001,
            previewUrl: 'http://127.0.0.1:41001/',
            status: 'ready',
            exitCode: null,
            exitSignal: null,
            retainedLogBytes: 0,
            logs: [],
          },
        ]
      : [],
  };
}

function surfaceOperations(
  overrides: Partial<PreviewRendererOperations> = {},
): PreviewRendererOperations {
  return {
    listTargets: vi.fn().mockResolvedValue([
      {
        target: { kind: 'primary' },
        label: 'Primary checkout',
        badge: 'Primary checkout',
        available: true,
      },
      {
        target: { kind: 'agent-run', runId: RUN_ID },
        label: 'Agent run aaaaaaaa',
        badge: 'Agent worktree',
        available: true,
      },
    ]),
    ...overrides,
  };
}

function installPreviewBridge(start = vi.fn().mockResolvedValue({ ok: true, value: session() })) {
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: {
      previews: {
        listTargets: vi.fn(),
        get: vi.fn().mockResolvedValue({ ok: true, value: null }),
        start,
        restart: vi.fn(),
        stop: vi.fn().mockResolvedValue({ ok: true, value: null }),
        navigate: vi.fn(),
        onEvent: vi.fn().mockReturnValue(() => undefined),
      },
    },
  });
  return start;
}

function baseData(extra: Record<string, unknown> = {}) {
  return {
    kind: 'web-preview' as const,
    title: 'Preview',
    description: 'Local preview',
    status: 'idle' as const,
    locked: false,
    collapsed: false,
    color: '#6099c5',
    ...extra,
  };
}

beforeEach(() => {
  class ResizeObserverStub {
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'forgeboard');
});

describe('PreviewNodePanel', () => {
  it('defaults and launches a detected script against the explicit primary target', async () => {
    const start = installPreviewBridge();
    const onUpdate = vi.fn();
    renderPanel({
      project: project({ test: 'vitest', dev: 'vite --host 0.0.0.0' }),
      data: baseData(),
      onUpdate,
      operations: surfaceOperations(),
    });

    expect(
      screen.getByRole<HTMLSelectElement>('combobox', {
        name: 'Script to run',
      }).value,
    ).toBe('dev');
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ previewPackageScript: 'dev' }));
    fireEvent.click(screen.getByRole('button', { name: /Start preview/u }));

    await waitFor(() =>
      expect(start).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        nodeId: 'preview-node',
        target: { kind: 'primary' },
        cwdRelative: '.',
        readinessPath: '/',
        urlPath: '/',
        packageScript: 'dev',
      }),
    );
  });

  it('persists opaque worktree targeting and every literal command field', async () => {
    installPreviewBridge();
    const onUpdate = vi.fn();
    renderPanel({
      project: project({}),
      data: baseData({
        previewCommand: { executable: 'pnpm', arguments: ['run', 'dev'] },
      }),
      onUpdate,
      operations: surfaceOperations(),
    });

    await waitFor(() =>
      expect(
        within(screen.getByRole('combobox', { name: 'Run the preview in' })).getByRole('option', {
          name: /Agent run aaaaaaaa/u,
        }),
      ).toBeTruthy(),
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Run the preview in' }), {
      target: { value: `agent-run:${RUN_ID}` },
    });
    fireEvent.change(screen.getByLabelText('Arguments, one per line'), {
      target: { value: 'run\ndev\n--host' },
    });
    fireEvent.change(screen.getByLabelText('Project folder'), {
      target: { value: 'apps/web' },
    });
    fireEvent.change(screen.getByLabelText('Health check path'), {
      target: { value: '/health' },
    });
    fireEvent.change(screen.getByLabelText('First page to open'), {
      target: { value: '/dashboard' },
    });

    expect(onUpdate).toHaveBeenCalledWith({
      previewTarget: { kind: 'agent-run', runId: RUN_ID },
    });
    expect(onUpdate).toHaveBeenCalledWith({
      previewCommand: {
        executable: 'pnpm',
        arguments: ['run', 'dev', '--host'],
      },
    });
    expect(onUpdate).toHaveBeenCalledWith({ previewCwdRelative: 'apps/web' });
    expect(onUpdate).toHaveBeenCalledWith({ previewReadinessPath: '/health' });
    expect(onUpdate).toHaveBeenCalledWith({ previewUrlPath: '/dashboard' });
  });

  it('shows a recoverable unavailable worktree and prevents a misleading launch', async () => {
    installPreviewBridge();
    const operations = surfaceOperations({
      listTargets: vi.fn().mockResolvedValue([
        {
          target: { kind: 'primary' },
          label: 'Primary checkout',
          badge: 'Primary checkout',
          available: true,
        },
        {
          target: { kind: 'agent-run', runId: RUN_ID },
          label: 'Agent run aaaaaaaa',
          badge: 'Agent worktree',
          available: false,
          unavailableReason: 'The owned worktree was cleaned up.',
        },
      ]),
    });
    renderPanel({
      project: project({ dev: 'vite' }),
      data: baseData({
        previewTarget: { kind: 'agent-run', runId: RUN_ID },
        previewPackageScript: 'dev',
      }),
      operations,
    });

    expect(await screen.findByText('The owned worktree was cleaned up.')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Start preview/u }).disabled).toBe(
      true,
    );
  });

  it('persists device, rotation, and same-target comparison choices without a fake touch toggle', () => {
    installPreviewBridge();
    const onUpdate = vi.fn();
    renderPanel({
      project: project({ dev: 'vite' }),
      data: baseData({ previewPackageScript: 'dev', previewSideBySide: true }),
      onUpdate,
      operations: surfaceOperations(),
    });

    fireEvent.change(screen.getByRole('combobox', { name: 'Main device' }), {
      target: { value: 'tablet' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rotate to landscape' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Second device' }), {
      target: { value: 'iphone' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Compare side by side' }));

    expect(onUpdate).toHaveBeenCalledWith({ previewPreset: 'tablet' });
    expect(onUpdate).toHaveBeenCalledWith({ previewOrientation: 'landscape' });
    expect(onUpdate).toHaveBeenCalledWith({ previewSecondaryPreset: 'iphone' });
    expect(onUpdate).toHaveBeenCalledWith({ previewSideBySide: false });
    expect(screen.getByRole('note').textContent).toContain('automatically act like a touchscreen');
    expect(screen.queryByRole('checkbox', { name: /touch/u })).toBeNull();
  });

  it('keeps runtime stop available while all locked configuration remains read-only', async () => {
    installPreviewBridge();
    const stop = window.forgeboard.previews.stop as ReturnType<typeof vi.fn>;
    renderPanel({
      project: project({ dev: 'vite' }),
      data: baseData({ locked: true, previewPackageScript: 'dev' }),
      session: session('starting'),
      operations: surfaceOperations(),
    });

    expect(screen.getByRole('combobox', { name: 'Run the preview in' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('combobox', { name: 'Run the preview with' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByLabelText('Health check path')).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() =>
      expect(stop).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        nodeId: 'preview-node',
      }),
    );
  });

  it('enforces collaboration read-only without auto-persisting or launching', async () => {
    installPreviewBridge();
    const onUpdate = vi.fn();
    renderPanel({
      project: project({ dev: 'vite' }),
      data: baseData(),
      onUpdate,
      operations: surfaceOperations(),
      configurationReadOnly: true,
    });

    await waitFor(() =>
      expect(
        within(screen.getByRole('combobox', { name: 'Run the preview in' })).getByRole('option', {
          name: /Agent run aaaaaaaa/u,
        }),
      ).toBeTruthy(),
    );
    expect(screen.getByRole('combobox', { name: 'Run the preview in' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('combobox', { name: 'Run the preview with' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Open preview settings' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: /Start preview/u })).toHaveProperty('disabled', true);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('opens the preview surface with correctly sized, per-node partitioned webviews', async () => {
    installPreviewBridge();
    renderPanel({
      project: project({ dev: 'vite' }),
      data: baseData({
        previewPackageScript: 'dev',
        previewPreset: 'iphone',
        previewSecondaryPreset: 'tablet',
        previewSideBySide: true,
      }),
      session: session('ready'),
      operations: surfaceOperations(),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open preview' }));

    const primaryHost = await screen.findByLabelText<HTMLElement>('iPhone preview');
    expect(primaryHost.style.width).toBe('390px');
    expect(primaryHost.style.height).toBe('844px');
    const secondaryHost = screen.getByLabelText<HTMLElement>('Tablet preview');
    expect(secondaryHost.style.width).toBe('820px');
    expect(secondaryHost.style.height).toBe('1180px');

    const webviews = document.querySelectorAll('webview');
    expect(webviews).toHaveLength(2);
    expect(
      [...webviews].every((webview) => webview.getAttribute('src') === 'http://127.0.0.1:41001/'),
    ).toBe(true);
    expect(webviews[0]?.getAttribute('partition')).toBe(`preview:${PROJECT_ID}:preview-node`);

    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(screen.queryByRole('dialog', { name: 'Local preview' })).toBeNull();
  });
});

function renderPanel({
  project: selectedProject,
  data,
  session: selectedSession = null,
  onUpdate = vi.fn(),
  operations,
  configurationReadOnly = false,
}: {
  project: Project;
  data: ReturnType<typeof baseData>;
  session?: PreviewSessionSnapshot | null;
  onUpdate?: ReturnType<typeof vi.fn>;
  operations: PreviewRendererOperations;
  configurationReadOnly?: boolean;
}) {
  return render(
    <PreviewNodePanel
      projectId={PROJECT_ID}
      project={selectedProject}
      nodeId="preview-node"
      kind="web-preview"
      data={data}
      settings={blankCommandSettings}
      session={selectedSession}
      onUpdate={onUpdate}
      onSession={vi.fn()}
      onOpenSettings={vi.fn()}
      onError={(message) => {
        throw new Error(message);
      }}
      operations={operations}
      configurationReadOnly={configurationReadOnly}
    />,
  );
}
