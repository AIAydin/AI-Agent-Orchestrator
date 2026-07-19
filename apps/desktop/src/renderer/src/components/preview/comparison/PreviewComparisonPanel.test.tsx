// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/unbound-method -- bridge members are Vitest mocks. */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  PreviewEventEnvelope,
  PreviewSessionSnapshot,
  PreviewStartInput,
} from '../../../../../shared/application/contracts.js';
import type { PreviewRendererOperations } from '../controller/operations.js';
import { PreviewComparisonPanel } from './PreviewComparisonPanel.js';

const PROJECT_ID = 'a3000000-0000-4000-8000-000000000001';
const LEFT_RUN = 'a3000000-0000-4000-8000-000000000002';
const RIGHT_RUN = 'a3000000-0000-4000-8000-000000000003';

describe('PreviewComparisonPanel', () => {
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

  it('launches two opaque agent targets in distinct slots and renders their distinct surfaces', async () => {
    const unsubscribe = vi.fn();
    const start = vi
      .fn<(input: PreviewStartInput) => Promise<{ ok: true; value: PreviewSessionSnapshot }>>()
      .mockImplementation((input) =>
        Promise.resolve({
          ok: true,
          value: session(
            input.slot === 'comparison-left' ? 41_001 : 41_002,
            input.target?.kind === 'agent-run' ? input.target.runId : LEFT_RUN,
          ),
        }),
      );
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: {
        previews: {
          get: vi.fn().mockResolvedValue({ ok: true, value: null }),
          start,
          restart: vi.fn(),
          stop: vi.fn().mockResolvedValue({ ok: true, value: null }),
          onEvent: vi.fn().mockReturnValue(unsubscribe),
        },
      },
    });
    const operations = surfaceOperations();
    render(
      <PreviewComparisonPanel
        projectId={PROJECT_ID}
        nodeId="preview-node"
        baseInput={{
          projectId: PROJECT_ID,
          nodeId: 'preview-node',
          packageScript: 'dev',
          cwdRelative: '.',
          readinessPath: '/',
          urlPath: '/',
        }}
        targets={[target(LEFT_RUN, 'Agent Alpha'), target(RIGHT_RUN, 'Agent Beta')]}
        configuration={{
          leftTarget: { kind: 'agent-run', runId: LEFT_RUN },
          rightTarget: { kind: 'agent-run', runId: RIGHT_RUN },
          leftPreset: 'desktop',
          rightPreset: 'tablet',
        }}
        launchConfigured
        readOnly={false}
        operations={operations}
        onConfiguration={vi.fn()}
        onError={(message) => {
          throw new Error(message);
        }}
      />,
    );

    const startButtons = screen.getAllByRole('button', { name: 'Start' });
    fireEvent.click(startButtons[0]!);
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));

    expect(start.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({
        nodeId: 'preview-node',
        slot: 'comparison-left',
        target: { kind: 'agent-run', runId: LEFT_RUN },
      }),
      expect.objectContaining({
        nodeId: 'preview-node',
        slot: 'comparison-right',
        target: { kind: 'agent-run', runId: RIGHT_RUN },
      }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Open side-by-side comparison' }));
    await waitFor(() => expect(operations.createSurface).toHaveBeenCalledTimes(2));
    expect(vi.mocked(operations.createSurface).mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({
        slot: 'comparison-left',
        url: 'http://127.0.0.1:41001/',
      }),
      expect.objectContaining({
        slot: 'comparison-right',
        url: 'http://127.0.0.1:41002/',
      }),
    ]);
    cleanup();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('shows saved unavailable-worktree recovery and never offers one run twice', async () => {
    installIdleBridge();
    render(
      <PreviewComparisonPanel
        projectId={PROJECT_ID}
        nodeId="preview-node"
        baseInput={{
          projectId: PROJECT_ID,
          nodeId: 'preview-node',
          packageScript: 'dev',
          cwdRelative: '.',
          readinessPath: '/',
          urlPath: '/',
        }}
        targets={[
          {
            ...target(LEFT_RUN, 'Agent Alpha'),
            available: false,
            unavailableReason: 'Worktree was cleaned up.',
          },
          target(RIGHT_RUN, 'Agent Beta'),
        ]}
        configuration={{
          leftTarget: { kind: 'agent-run', runId: LEFT_RUN },
          rightTarget: { kind: 'agent-run', runId: RIGHT_RUN },
          leftPreset: 'desktop',
          rightPreset: 'iphone',
        }}
        launchConfigured
        readOnly={false}
        operations={surfaceOperations()}
        onConfiguration={vi.fn()}
        onError={vi.fn()}
      />,
    );

    expect(await screen.findByText('Worktree was cleaned up.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Start' })[0]).toHaveProperty('disabled', true);
    expect(
      screen
        .getAllByRole<HTMLOptionElement>('option', { name: 'Agent Beta' })
        .some((option) => option.disabled),
    ).toBe(true);
  });

  it('stops a recovered session instead of relabeling it after its target changes', async () => {
    const stop = vi.fn().mockResolvedValue({ ok: true, value: null });
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: {
        previews: {
          get: vi.fn().mockImplementation(({ slot }: { slot?: string }) =>
            Promise.resolve({
              ok: true,
              value: slot === 'comparison-left' ? session(41_001, LEFT_RUN) : null,
            }),
          ),
          start: vi.fn(),
          restart: vi.fn(),
          stop,
          onEvent: vi.fn().mockReturnValue(() => undefined),
        },
      },
    });
    renderPanel({
      leftTarget: { kind: 'agent-run', runId: RIGHT_RUN },
      rightTarget: { kind: 'agent-run', runId: LEFT_RUN },
    });

    await waitFor(() =>
      expect(stop).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        nodeId: 'preview-node',
        slot: 'comparison-left',
      }),
    );
    expect(screen.getByRole('button', { name: 'Open side-by-side comparison' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('ignores another project event and keeps emergency Stop available while read-only', async () => {
    let listener: ((event: PreviewEventEnvelope) => void) | undefined;
    const stop = vi.fn().mockResolvedValue({ ok: true, value: null });
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: {
        previews: {
          get: vi.fn().mockImplementation(({ slot }: { slot?: string }) =>
            Promise.resolve({
              ok: true,
              value: session(
                slot === 'comparison-left' ? 41_001 : 41_002,
                slot === 'comparison-left' ? LEFT_RUN : RIGHT_RUN,
              ),
            }),
          ),
          start: vi.fn(),
          restart: vi.fn(),
          stop,
          onEvent: vi
            .fn<(next: (event: PreviewEventEnvelope) => void) => () => void>()
            .mockImplementation((next) => {
              listener = next;
              return () => undefined;
            }),
        },
      },
    });
    renderPanel({}, true);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Stop' })).toHaveLength(2));
    expect(
      screen
        .getAllByRole('button', { name: 'Restart' })
        .every((button) => button.hasAttribute('disabled')),
    ).toBe(true);
    expect(
      screen
        .getAllByRole('button', { name: 'Stop' })
        .every((button) => !button.hasAttribute('disabled')),
    ).toBe(true);
    listener?.({
      kind: 'state',
      projectId: 'b3000000-0000-4000-8000-000000000001',
      nodeId: 'preview-node',
      slot: 'comparison-left',
      session: session(41_099, RIGHT_RUN),
    });
    expect(stop).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Stop' })[0]!);
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  });

  it('guards imported equal targets before any launch handler runs', () => {
    const start = vi.fn();
    installIdleBridge(start);
    renderPanel({ rightTarget: { kind: 'agent-run', runId: LEFT_RUN } });
    expect(screen.getByRole('alert').textContent).toContain('two different agent runs');
    expect(
      screen
        .getAllByRole('button', { name: 'Start' })
        .every((button) => button.hasAttribute('disabled')),
    ).toBe(true);
    expect(start).not.toHaveBeenCalled();
  });
});

function installIdleBridge(start = vi.fn()) {
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: {
      previews: {
        get: vi.fn().mockResolvedValue({ ok: true, value: null }),
        start,
        restart: vi.fn(),
        stop: vi.fn(),
        onEvent: vi.fn().mockReturnValue(() => undefined),
      },
    },
  });
}

function target(runId: string, label: string) {
  return {
    target: { kind: 'agent-run' as const, runId },
    label,
    badge: 'Agent worktree' as const,
    available: true,
  };
}

function session(port: number, runId: string): PreviewSessionSnapshot {
  return {
    id: crypto.randomUUID(),
    status: 'ready',
    startedAt: '2026-07-18T12:00:00.000Z',
    readyAt: '2026-07-18T12:00:01.000Z',
    stoppedAt: null,
    failure: null,
    trustedHosts: ['127.0.0.1'],
    processes: [
      {
        id: 'development-server',
        pid: port,
        cwd: '.',
        port,
        previewUrl: `http://127.0.0.1:${String(port)}/`,
        status: 'ready',
        exitCode: null,
        exitSignal: null,
        retainedLogBytes: 0,
        logs: [],
      },
    ],
    target: { kind: 'agent-run', runId },
  };
}

function renderPanel(
  configuration: Partial<{
    leftTarget: { kind: 'agent-run'; runId: string };
    rightTarget: { kind: 'agent-run'; runId: string };
  }> = {},
  readOnly = false,
) {
  return render(
    <PreviewComparisonPanel
      projectId={PROJECT_ID}
      nodeId="preview-node"
      baseInput={{
        projectId: PROJECT_ID,
        nodeId: 'preview-node',
        packageScript: 'dev',
        cwdRelative: '.',
        readinessPath: '/',
        urlPath: '/',
      }}
      targets={[target(LEFT_RUN, 'Agent Alpha'), target(RIGHT_RUN, 'Agent Beta')]}
      configuration={{
        leftTarget: configuration.leftTarget ?? { kind: 'agent-run', runId: LEFT_RUN },
        rightTarget: configuration.rightTarget ?? { kind: 'agent-run', runId: RIGHT_RUN },
        leftPreset: 'desktop',
        rightPreset: 'tablet',
      }}
      launchConfigured
      readOnly={readOnly}
      operations={surfaceOperations()}
      onConfiguration={vi.fn()}
      onError={(message) => {
        throw new Error(message);
      }}
    />,
  );
}

function surfaceOperations(): PreviewRendererOperations {
  return {
    listTargets: vi.fn(),
    createSurface: vi.fn<PreviewRendererOperations['createSurface']>().mockImplementation((input) =>
      Promise.resolve({
        surfaceId: crypto.randomUUID(),
        projectId: input.projectId,
        nodeId: input.nodeId,
        ...(input.slot === undefined ? {} : { slot: input.slot }),
        url: input.url,
        status: 'ready',
        bounds: input.bounds,
        canGoBack: false,
        canGoForward: false,
        touchEmulation: input.touchEmulation,
        failure: null,
      }),
    ),
    setSurfaceBounds: vi.fn(),
    navigateSurface: vi.fn(),
    reloadSurface: vi.fn(),
    navigateSurfaceHistory: vi.fn(),
    getSurfaceConsole: vi.fn().mockResolvedValue({
      entries: [],
      truncated: false,
      retainedBytes: 0,
      disclosure:
        'Console output is captured in memory only, bounded to 500 entries and 256 KiB, and may contain application data.',
    }),
    saveSurfaceScreenshot: vi.fn(),
    openSurfaceExternally: vi.fn(),
    closeSurface: vi.fn().mockResolvedValue(true),
    onSurfaceEvent: vi.fn().mockReturnValue(() => undefined),
  };
}
