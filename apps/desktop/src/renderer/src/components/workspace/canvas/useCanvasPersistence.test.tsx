// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasDocument } from '../../../../../shared/application/contracts.js';
import { useCanvasPersistence } from './useCanvasPersistence.js';

const PROJECT_A = '50000000-0000-4000-8000-000000000001';
const PROJECT_B = '50000000-0000-4000-8000-000000000002';

const persistCanvas = vi.fn<(document: CanvasDocument) => Promise<void>>();
const onError = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  persistCanvas.mockReset();
  onError.mockReset();
  persistCanvas.mockResolvedValue();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useCanvasPersistence', () => {
  it('flushes the latest edit immediately without waiting for autosave', async () => {
    const hook = renderPersistence(canvas('loaded'));
    expect(hook.result.current.persistedUpdatedAt).toBe('2026-07-15T12:00:00.000Z');
    hook.rerender({ projectId: PROJECT_A, document: canvas('edited') });

    let saved = false;
    await act(async () => {
      saved = await hook.result.current.flushCanvas();
    });

    expect(saved).toBe(true);
    expect(persistCanvas).toHaveBeenCalledTimes(1);
    expect(persistCanvas.mock.calls[0]?.[0].name).toBe('edited');
    expect(hook.result.current.saveState).toBe('saved');
    expect(hook.result.current.persistedUpdatedAt).toBe(persistCanvas.mock.calls[0]?.[0].updatedAt);

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(persistCanvas).toHaveBeenCalledTimes(1);
  });

  it('autosaves a dirty revision only after the configured delay', async () => {
    const hook = renderPersistence(canvas('loaded'));
    hook.rerender({ projectId: PROJECT_A, document: canvas('autosaved edit') });

    await act(async () => vi.advanceTimersByTimeAsync(29_999));
    expect(persistCanvas).not.toHaveBeenCalled();
    expect(hook.result.current.saveState).toBe('saving');

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(persistCanvas).toHaveBeenCalledTimes(1);
    expect(persistCanvas.mock.calls[0]?.[0].name).toBe('autosaved edit');
    expect(hook.result.current.saveState).toBe('saved');
  });

  it('treats a viewport-only pan and zoom change as a durable revision', async () => {
    const loaded = canvas('loaded');
    const hook = renderPersistence(loaded);
    hook.rerender({
      projectId: PROJECT_A,
      document: { ...loaded, viewport: { x: -240, y: 96, zoom: 1.4 } },
    });

    await act(async () => vi.advanceTimersByTimeAsync(30_000));

    expect(persistCanvas).toHaveBeenCalledTimes(1);
    expect(persistCanvas.mock.calls[0]?.[0].viewport).toEqual({
      x: -240,
      y: 96,
      zoom: 1.4,
    });
    expect(hook.result.current.saveState).toBe('saved');
  });

  it('serializes saves and drains the newest revision before reporting saved', async () => {
    const firstSave = deferred<void>();
    const latestSave = deferred<void>();
    persistCanvas.mockImplementationOnce(() => firstSave.promise);
    persistCanvas.mockImplementationOnce(() => latestSave.promise);
    const hook = renderPersistence(canvas('loaded'));
    hook.rerender({ projectId: PROJECT_A, document: canvas('first edit') });

    let flush!: Promise<boolean>;
    act(() => {
      flush = hook.result.current.flushCanvas();
    });
    expect(persistCanvas).toHaveBeenCalledTimes(1);

    hook.rerender({ projectId: PROJECT_A, document: canvas('latest edit') });
    expect(hook.result.current.saveState).toBe('saving');

    await act(async () => {
      firstSave.resolve();
      await firstSave.promise;
    });
    expect(persistCanvas).toHaveBeenCalledTimes(2);
    expect(persistCanvas.mock.calls[1]?.[0].name).toBe('latest edit');
    expect(hook.result.current.saveState).toBe('saving');

    let saved = false;
    await act(async () => {
      latestSave.resolve();
      saved = await flush;
    });
    expect(saved).toBe(true);
    expect(hook.result.current.saveState).toBe('saved');
  });

  it('coalesces content-identical document objects while a save is in flight', async () => {
    const save = deferred<void>();
    persistCanvas.mockImplementationOnce(() => save.promise);
    const hook = renderPersistence(canvas('loaded'));
    const edited = canvas('edited');
    hook.rerender({ projectId: PROJECT_A, document: edited });

    let flushed!: Promise<boolean>;
    act(() => {
      flushed = hook.result.current.flushCanvas();
    });
    expect(persistCanvas).toHaveBeenCalledTimes(1);

    for (let index = 0; index < 5; index += 1) {
      hook.rerender({
        projectId: PROJECT_A,
        document: {
          ...edited,
          nodes: [...edited.nodes],
          edges: [...edited.edges],
          viewport: { ...edited.viewport },
        },
      });
    }

    let saved = false;
    await act(async () => {
      save.resolve();
      saved = await flushed;
    });

    expect(saved).toBe(true);
    expect(persistCanvas).toHaveBeenCalledTimes(1);
    expect(hook.result.current.saveState).toBe('saved');
  });

  it('ignores an obsolete save response after the project scope changes', async () => {
    const oldSave = deferred<void>();
    persistCanvas.mockImplementationOnce(() => oldSave.promise);
    const hook = renderPersistence(canvas('loaded'));
    hook.rerender({
      projectId: PROJECT_A,
      document: canvas('old project edit'),
    });

    let flush!: Promise<boolean>;
    act(() => {
      flush = hook.result.current.flushCanvas();
    });
    hook.rerender({
      projectId: PROJECT_B,
      document: canvas('new project', PROJECT_B),
    });

    let saved = false;
    await act(async () => {
      oldSave.resolve();
      saved = await flush;
    });

    expect(saved).toBe(true);
    expect(persistCanvas).toHaveBeenCalledTimes(1);
    expect(hook.result.current.saveState).toBe('saved');
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports a failure, returns false to block close, and cancels timers on cleanup', async () => {
    persistCanvas.mockRejectedValueOnce(new Error('Disk is full.'));
    const hook = renderPersistence(canvas('loaded'));
    hook.rerender({ projectId: PROJECT_A, document: canvas('unsaved edit') });

    let saved = true;
    await act(async () => {
      saved = await hook.result.current.flushCanvas();
    });

    expect(saved).toBe(false);
    expect(hook.result.current.saveState).toBe('error');
    expect(onError).toHaveBeenCalledWith(
      'Could not save the canvas: Disk is full. Your changes are still here; try saving again.',
    );

    hook.rerender({ projectId: PROJECT_A, document: canvas('another edit') });
    hook.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(persistCanvas).toHaveBeenCalledTimes(1);
  });
});

function renderPersistence(document: CanvasDocument) {
  return renderHook(
    ({ projectId, document: current }: { projectId: string; document: CanvasDocument }) =>
      useCanvasPersistence({
        projectId,
        document: current,
        autosaveIntervalMs: 30_000,
        persistCanvas,
        onError,
      }),
    { initialProps: { projectId: PROJECT_A, document } },
  );
}

function canvas(name: string, projectId = PROJECT_A): CanvasDocument {
  return {
    id: projectId,
    projectId,
    name,
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt: '2026-07-15T12:00:00.000Z',
  };
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
