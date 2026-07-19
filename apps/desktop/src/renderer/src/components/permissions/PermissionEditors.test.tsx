// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExecutableAllowlistEditor } from './ExecutableAllowlistEditor.js';
import { PermissionRootEditor } from './PermissionRootEditor.js';

afterEach(cleanup);

describe('permission editor accessibility', () => {
  it('announces honest empty states and explains unavailable browse actions', () => {
    render(
      <>
        <PermissionRootEditor
          kind="read"
          values={[]}
          disabled={false}
          canBrowse={false}
          onChange={vi.fn()}
          onBrowse={vi.fn()}
        />
        <ExecutableAllowlistEditor
          values={[]}
          disabled={false}
          dockerRuntime
          onChange={vi.fn()}
          onBrowse={vi.fn()}
        />
      </>,
    );

    expect(screen.getAllByRole('status')).toHaveLength(2);
    expect(
      screen.getByRole('group', {
        name: 'Browse project folders unavailable',
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole('group', {
        name: 'Browse for an allowed program unavailable',
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole('tooltip', {
        name: 'Open a project first to pick one of its folders',
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole('tooltip', {
        name: "Type the program's full path as it appears inside the Docker image",
      }),
    ).toBeTruthy();
  });

  it('describes compact remove controls without a native title', () => {
    render(
      <PermissionRootEditor
        kind="write"
        values={['src']}
        disabled={false}
        canBrowse
        onChange={vi.fn()}
        onBrowse={vi.fn()}
      />,
    );

    const remove = screen.getByRole('button', {
      name: 'Remove writable folder src',
    });
    const tooltip = screen.getByRole('tooltip', {
      name: 'Remove writable folder',
    });
    expect(remove.getAttribute('aria-describedby')).toBe(tooltip.id);
    expect(remove.hasAttribute('title')).toBe(false);
  });
});
