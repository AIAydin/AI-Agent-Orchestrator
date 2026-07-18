// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../../../../shared/application/contracts.js';
import { useProjectStatus } from './useProjectStatus.js';

afterEach(() => vi.restoreAllMocks());

describe('useProjectStatus', () => {
  it('ignores a previous project response that resolves after a project switch', async () => {
    const oldRefresh = deferred<{ ok: true; value: Project }>();
    const next = project('22222222-2222-4222-8222-222222222222', 'next', true);
    const refresh = vi
      .fn()
      .mockReturnValueOnce(oldRefresh.promise)
      .mockResolvedValueOnce({ ok: true, value: next });
    installApi(refresh);
    const initial = project('11111111-1111-4111-8111-111111111111', 'initial', false);
    const hook = renderHook(({ value }) => useProjectStatus(value), {
      initialProps: { value: initial },
    });

    hook.rerender({ value: next });
    await waitFor(() => expect(hook.result.current.project.id).toBe(next.id));
    act(() => oldRefresh.resolve({ ok: true, value: initial }));
    await waitFor(() => expect(hook.result.current.project.id).toBe(next.id));
    expect(hook.result.current.project.id).toBe(next.id);
  });

  it('shows health as unavailable when the folder can no longer be verified', async () => {
    installApi(vi.fn().mockRejectedValue(new Error('missing')));
    const current = project('11111111-1111-4111-8111-111111111111', 'current', false);
    const hook = renderHook(() => useProjectStatus(current));

    await waitFor(() => expect(hook.result.current.available).toBe(false));
    expect(hook.result.current.project.id).toBe(current.id);
  });
});

function installApi(refresh: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: { projects: { refresh } },
  });
}

function project(id: string, name: string, dirty: boolean): Project {
  return {
    id,
    name,
    path: `/tmp/${name}`,
    missing: false,
    openedAt: '2026-07-18T00:00:00.000Z',
    health: {
      isGitRepository: true,
      branch: 'main',
      dirty,
      remotes: [],
      hasSubmodules: false,
      packageManager: 'unknown',
      scripts: {},
      frameworks: [],
      sensitiveWarnings: [],
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
