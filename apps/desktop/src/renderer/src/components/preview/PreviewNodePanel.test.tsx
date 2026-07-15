// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AppSettingsSchema,
  type PreviewSessionSnapshot,
  type Project,
} from '../../../../shared/application/contracts.js';
import { PreviewNodePanel } from './PreviewNodePanel.js';

const PROJECT_ID = 'd95d6c69-8409-4f0d-bb42-940b38b0a703';

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

function idleSnapshot(): PreviewSessionSnapshot {
  return {
    id: '024b6a04-8a03-4d24-a16f-4baf20ddb3f5',
    status: 'stopped',
    startedAt: '2026-07-14T16:00:00.000Z',
    readyAt: null,
    stoppedAt: '2026-07-14T16:00:01.000Z',
    failure: null,
    trustedHosts: ['127.0.0.1'],
    processes: [],
  };
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'forgeboard');
});

describe('PreviewNodePanel package-script picker', () => {
  it('defaults and starts a detected dev script when the global command is blank', async () => {
    const start = vi.fn().mockResolvedValue({ ok: true, value: idleSnapshot() });
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: {
        previews: {
          get: vi.fn().mockResolvedValue({ ok: true, value: null }),
          start,
          restart: vi.fn(),
          stop: vi.fn(),
          navigate: vi.fn(),
          onEvent: vi.fn(),
        },
      },
    });
    const onUpdate = vi.fn();
    render(
      <PreviewNodePanel
        projectId={PROJECT_ID}
        project={project({ test: 'vitest', dev: 'vite --host 0.0.0.0' })}
        nodeId="preview-node"
        kind="web-preview"
        data={{
          kind: 'web-preview',
          title: 'Preview',
          description: 'Local preview',
          status: 'idle',
          locked: false,
          collapsed: false,
          color: '#6099c5',
          previewPackageScript: '',
        }}
        settings={blankCommandSettings}
        session={null}
        onUpdate={onUpdate}
        onSession={() => undefined}
        onOpenSettings={() => undefined}
        onError={(message) => {
          throw new Error(message);
        }}
      />,
    );

    const commandPicker = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Preview command',
    });
    expect(commandPicker.value).toBe('dev');
    expect(commandPicker.name).toBe('node-preview-node-preview-command');
    expect(screen.getByLabelText<HTMLInputElement>('Project folder').name).toBe(
      'node-preview-node-preview-project-folder',
    );
    expect(screen.getByText('pnpm run dev')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Start preview/ }).disabled).toBe(
      false,
    );
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ previewPackageScript: 'dev' }));

    fireEvent.click(screen.getByRole('button', { name: /Start preview/ }));

    await waitFor(() =>
      expect(start).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        nodeId: 'preview-node',
        cwdRelative: '.',
        readinessPath: '/',
        urlPath: '/',
        packageScript: 'dev',
      }),
    );
  });

  it('persists picker changes and explains how to recover when nothing is detected', () => {
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: {
        previews: {
          get: vi.fn().mockResolvedValue({ ok: true, value: null }),
          start: vi.fn(),
          restart: vi.fn(),
          stop: vi.fn(),
          navigate: vi.fn(),
          onEvent: vi.fn(),
        },
      },
    });
    const onUpdate = vi.fn();
    const { rerender } = render(
      <PreviewNodePanel
        projectId={PROJECT_ID}
        project={project({ dev: 'vite', preview: 'astro dev' })}
        nodeId="preview-node"
        kind="web-preview"
        data={{
          kind: 'web-preview',
          title: 'Preview',
          description: 'Local preview',
          status: 'idle',
          locked: false,
          collapsed: false,
          color: '#6099c5',
        }}
        settings={blankCommandSettings}
        session={null}
        onUpdate={onUpdate}
        onSession={() => undefined}
        onOpenSettings={() => undefined}
        onError={() => undefined}
      />,
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Preview command' }), {
      target: { value: 'preview' },
    });
    expect(onUpdate).toHaveBeenCalledWith({ previewPackageScript: 'preview' });

    rerender(
      <PreviewNodePanel
        projectId={PROJECT_ID}
        project={project({})}
        nodeId="preview-node"
        kind="web-preview"
        data={{
          kind: 'web-preview',
          title: 'Preview',
          description: 'Local preview',
          status: 'idle',
          locked: false,
          collapsed: false,
          color: '#6099c5',
        }}
        settings={blankCommandSettings}
        session={null}
        onUpdate={onUpdate}
        onSession={() => undefined}
        onOpenSettings={() => undefined}
        onError={() => undefined}
      />,
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Start preview/ }).disabled).toBe(
      true,
    );
    expect(screen.getByRole('status').textContent).toContain(
      'enter a development command entirely in the UI',
    );
  });

  it('keeps stop available while a locked running preview has read-only configuration', async () => {
    const running: PreviewSessionSnapshot = {
      id: '024b6a04-8a03-4d24-a16f-4baf20ddb3f5',
      status: 'starting',
      startedAt: '2026-07-14T16:00:00.000Z',
      readyAt: null,
      stoppedAt: null,
      failure: null,
      trustedHosts: ['127.0.0.1'],
      processes: [],
    };
    const stop = vi.fn().mockResolvedValue({ ok: true, value: null });
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: {
        previews: {
          get: vi.fn().mockResolvedValue({ ok: true, value: running }),
          start: vi.fn(),
          restart: vi.fn(),
          stop,
          navigate: vi.fn(),
          onEvent: vi.fn(),
        },
      },
    });
    render(
      <PreviewNodePanel
        projectId={PROJECT_ID}
        project={project({ dev: 'vite' })}
        nodeId="preview-node"
        kind="web-preview"
        data={{
          kind: 'web-preview',
          title: 'Preview',
          description: 'Local preview',
          status: 'running',
          locked: true,
          collapsed: false,
          color: '#6099c5',
          previewPackageScript: 'dev',
        }}
        settings={blankCommandSettings}
        session={running}
        onUpdate={vi.fn()}
        onSession={vi.fn()}
        onOpenSettings={vi.fn()}
        onError={vi.fn()}
      />,
    );

    expect(screen.getByRole('combobox', { name: 'Preview command' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByLabelText('Readiness path')).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Stop' })).toHaveProperty('disabled', false);

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() =>
      expect(stop).toHaveBeenCalledWith({ projectId: PROJECT_ID, nodeId: 'preview-node' }),
    );
  });
});
