// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../../../shared/application/contracts.js';
import type {
  GitIdentityCheckInput,
  GitIdentityCheckResult,
} from '../../../../../shared/git/identity/contracts.js';
import { GitIdentityCheck } from './GitIdentityCheck.js';

const check = vi.fn();

beforeEach(() => {
  check.mockReset();
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: { git: { identity: { check } } },
  });
});

afterEach(cleanup);

describe('GitIdentityCheck', () => {
  it('checks the exact normalized unsaved Settings identity without a project', async () => {
    check.mockImplementation((request: GitIdentityCheckInput) =>
      Promise.resolve({ ok: true, value: readyResult(request) }),
    );
    renderCheck({ name: ' Forgeboard Author ', email: ' author@example.invalid ' });

    fireEvent.click(screen.getByRole('button', { name: 'Check Git identity' }));

    await screen.findByLabelText('Effective Git identity');
    expect(check).toHaveBeenCalledWith({
      source: 'settings',
      name: 'Forgeboard Author',
      email: 'author@example.invalid',
    });
    expect(screen.getByText('Current Settings draft')).toBeTruthy();
  });

  it('checks repository fallback through only the opaque active project id', async () => {
    check.mockImplementation((request: GitIdentityCheckInput) =>
      Promise.resolve({ ok: true, value: readyResult(request) }),
    );
    renderCheck({ activeProject: project });

    fireEvent.click(screen.getByRole('button', { name: 'Check Git identity' }));

    await screen.findByText('Selected repository Git configuration');
    expect(check).toHaveBeenCalledWith({ source: 'git-config', projectId: project.id });
    expect(JSON.stringify(check.mock.calls[0]?.[0])).not.toContain(project.path);
  });

  it('disables partial identity and blank fallback without a project', () => {
    const view = renderCheck({ name: 'Only a name' });
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Check Git identity' }).disabled,
    ).toBe(true);
    expect(screen.getByText(/Enter both a Git identity name and email/u)).toBeTruthy();

    view.rerender(component({}));
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Check Git identity' }).disabled,
    ).toBe(true);
    expect(screen.getByText(/Open a project/u)).toBeTruthy();
    expect(check).not.toHaveBeenCalled();
  });

  it('discards a delayed result after either draft field changes', async () => {
    const pending = deferred<GitIdentityCheckResult>();
    check.mockImplementationOnce(() =>
      pending.promise.then((value) => ({ ok: true as const, value })),
    );
    const first = { name: 'First Author', email: 'first@example.invalid' };
    const view = renderCheck(first);
    fireEvent.click(screen.getByRole('button', { name: 'Check Git identity' }));

    view.rerender(component({ name: 'Second Author', email: 'second@example.invalid' }));
    await act(async () => {
      pending.resolve(readyResult({ source: 'settings', name: first.name, email: first.email }));
      await pending.promise;
    });

    expect(screen.queryByLabelText('Effective Git identity')).toBeNull();
    expect(screen.getByText(/Checks these exact unsaved values/u)).toBeTruthy();
  });
});

const project: Project = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Fixture',
  path: '/private/repository',
  openedAt: '2026-07-18T16:00:00.000Z',
  missing: false,
  health: {
    isGitRepository: true,
    branch: 'main',
    dirty: false,
    remotes: [],
    packageManager: 'unknown',
    frameworks: [],
    scripts: {},
    hasSubmodules: false,
    sensitiveWarnings: [],
  },
};

function renderCheck(overrides: Partial<Parameters<typeof component>[0]> = {}) {
  return render(component(overrides));
}

function component(
  overrides: {
    readonly name?: string;
    readonly email?: string;
    readonly activeProject?: Project | null;
  } = {},
) {
  return (
    <GitIdentityCheck
      name={overrides.name ?? ''}
      email={overrides.email ?? ''}
      activeProject={overrides.activeProject ?? null}
      busy={false}
      perform={async (operation) => await operation()}
    />
  );
}

function readyResult(request: GitIdentityCheckInput): GitIdentityCheckResult {
  const settings = request.source === 'settings';
  return {
    request,
    identity: {
      name: settings ? request.name : 'Repository Author',
      email: settings ? request.email : 'repository@example.invalid',
      nameSource: settings ? 'settings' : 'git-config',
      emailSource: settings ? 'settings' : 'git-config',
      ready: true,
    },
    checkedAt: '2026-07-18T16:00:00.000Z',
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
