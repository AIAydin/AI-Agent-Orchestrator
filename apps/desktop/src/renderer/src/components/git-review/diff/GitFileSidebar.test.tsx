// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GitReviewFile, GitReviewGroups } from '../git-review-model.js';
import { GitFileSidebar } from './GitFileSidebar.js';

afterEach(cleanup);

describe('GitFileSidebar', () => {
  it('renders bounded pages and keeps a selected file visible when navigation moves across pages', () => {
    const staged = Array.from({ length: 205 }, (_, index) => reviewFile(index));
    const groups: GitReviewGroups = { staged, unstaged: [], untracked: [] };
    const onSelect = vi.fn();
    const rendered = render(
      <GitFileSidebar
        groups={groups}
        selection={{ area: 'staged', path: staged[0]!.path }}
        busy={false}
        onSelect={onSelect}
        onStagePath={() => undefined}
        onUnstagePath={() => undefined}
      />,
    );

    expect(screen.getByText('1–100 of 205')).toBeTruthy();
    expect(screen.queryByText(staged[100]!.path)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next staged changes page' }));
    expect(screen.getByText('101–200 of 205')).toBeTruthy();
    fireEvent.click(screen.getByText(staged[100]!.path).closest('button')!);
    expect(onSelect).toHaveBeenCalledWith({ area: 'staged', path: staged[100]!.path });

    rendered.rerender(
      <GitFileSidebar
        groups={groups}
        selection={{ area: 'staged', path: staged[204]!.path }}
        busy={false}
        onSelect={onSelect}
        onStagePath={() => undefined}
        onUnstagePath={() => undefined}
      />,
    );
    expect(screen.getByText('201–205 of 205')).toBeTruthy();
    expect(screen.getByText(staged[204]!.path)).toBeTruthy();
  });
});

function reviewFile(index: number): GitReviewFile {
  return {
    area: 'staged',
    path: `src/file-${String(index).padStart(3, '0')}.ts`,
    entry: {
      kind: 'ordinary',
      path: `src/file-${String(index).padStart(3, '0')}.ts`,
      index: 'M',
      worktree: '.',
    },
  };
}
