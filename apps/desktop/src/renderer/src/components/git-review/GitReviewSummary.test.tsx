// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { GitReviewView } from '../../../../shared/git/contracts.js';
import { GitReviewSummary } from './GitReviewSummary.js';

afterEach(cleanup);

describe('GitReviewSummary', () => {
  it('explains tracked-file line totals with a managed keyboard-accessible tooltip', () => {
    render(<GitReviewSummary review={review()} />);

    const totals = screen.getByRole('group', { name: 'Tracked file line changes' });
    const tooltip = screen.getByRole('tooltip', {
      name: /Only counts line changes in files Git already tracks/u,
    });
    expect(totals.tabIndex).toBe(0);
    expect(totals.getAttribute('title')).toBeNull();
    expect(totals.getAttribute('aria-describedby')).toBe(tooltip.id);
    expect(totals.textContent).toContain('2 files · +4 −2');
  });
});

function review(): GitReviewView {
  return {
    target: { kind: 'primary', projectId: '11111111-1111-4111-8111-111111111111' },
    branch: 'main',
    detached: false,
    headOid: 'a'.repeat(40),
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    dirty: true,
    conflicted: false,
    entries: [
      { kind: 'ordinary', path: 'src/one.ts', index: 'M', worktree: '.' },
      { kind: 'ordinary', path: 'src/two.ts', index: '.', worktree: 'M' },
    ],
    staged: { additions: 3, deletions: 1, files: [] },
    unstaged: { additions: 1, deletions: 1, files: [] },
    identity: {
      name: 'Ada Developer',
      email: 'ada@example.test',
      nameSource: 'settings',
      emailSource: 'settings',
      ready: true,
    },
    refreshedAt: '2026-07-19T18:00:00.000Z',
  };
}
