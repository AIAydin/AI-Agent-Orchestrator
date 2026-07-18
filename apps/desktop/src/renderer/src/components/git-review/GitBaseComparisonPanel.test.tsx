// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import type { GitAgentBaseComparisonView } from '../../../../shared/git/contracts.js';
import { GitBaseComparisonPanel } from './GitBaseComparisonPanel.js';
import {
  GIT_AGENT_COMPARISON_PANEL_ID,
  GIT_BASE_PANEL_ID,
  GIT_WORKING_TREE_PANEL_ID,
  GitReviewModeTabs,
  type GitReviewMode,
} from './GitReviewModeTabs.js';

const BASE_COMMIT = 'a'.repeat(40);
const HEAD_COMMIT = 'b'.repeat(40);

afterEach(cleanup);

describe('GitBaseComparisonPanel', () => {
  it('renders committed hunks as read-only comparison evidence', () => {
    render(<GitBaseComparisonPanel comparison={comparison()} />);

    expect(screen.getByText('Committed (read-only)')).toBeTruthy();
    expect(screen.getByText('new committed line')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add to commit' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Discard change/ })).toBeNull();
    expect(screen.getByText(BASE_COMMIT)).toBeTruthy();
    expect(screen.getAllByText(HEAD_COMMIT)).toHaveLength(2);
  });

  it('distinguishes an empty committed diff from staged or unstaged edits', () => {
    render(
      <GitBaseComparisonPanel
        comparison={{
          ...comparison(),
          headCommit: BASE_COMMIT,
          ahead: 0,
          commitCount: 0,
          commits: [],
          diff: { files: [], additions: 0, deletions: 0 },
        }}
      />,
    );

    expect(screen.getByText('No committed changes to compare')).toBeTruthy();
    expect(screen.getByText(/not committed yet is in the other tab/)).toBeTruthy();
  });

  it('does not advertise unavailable whole-file actions for a read-only binary comparison', () => {
    render(
      <GitBaseComparisonPanel
        comparison={{
          ...comparison(),
          diff: {
            files: [
              {
                oldPath: 'assets/preview.png',
                newPath: 'assets/preview.png',
                status: 'binary',
                binary: true,
                hunks: [],
              },
            ],
            additions: 0,
            deletions: 0,
          },
        }}
      />,
    );

    expect(
      screen.getByText("This file isn't text, so its committed changes can't be shown here."),
    ).toBeTruthy();
    expect(screen.queryByText(/whole-file button/)).toBeNull();
  });

  it('discloses when the bounded commit identifier list is truncated', () => {
    render(
      <GitBaseComparisonPanel
        comparison={{
          ...comparison(),
          ahead: 300,
          commitCount: 300,
          commitIdsTruncated: true,
        }}
      />,
    );

    expect(screen.getByText(/300 commits compared · not all shown/)).toBeTruthy();
    expect(screen.getAllByText(HEAD_COMMIT)).toHaveLength(2);
  });
});

describe('GitReviewModeTabs', () => {
  it('links panels and supports click, Arrow, Home, and End selection', () => {
    render(<TabHarness />);
    const baseTab = screen.getByRole('tab', { name: 'Committed changes' });
    const agentTab = screen.getByRole('tab', { name: 'Compare agents' });
    const workingTreeTab = screen.getByRole('tab', { name: 'Uncommitted changes' });

    expect(baseTab.getAttribute('aria-controls')).toBe(GIT_BASE_PANEL_ID);
    expect(baseTab.tabIndex).toBe(0);
    expect(workingTreeTab.tabIndex).toBe(-1);

    baseTab.focus();
    fireEvent.keyDown(baseTab, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(agentTab);
    expect(agentTab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').id).toBe(GIT_AGENT_COMPARISON_PANEL_ID);

    fireEvent.keyDown(agentTab, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(workingTreeTab);
    expect(workingTreeTab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').id).toBe(GIT_WORKING_TREE_PANEL_ID);

    fireEvent.keyDown(workingTreeTab, { key: 'Home' });
    expect(document.activeElement).toBe(baseTab);
    expect(baseTab.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(baseTab, { key: 'End' });
    expect(document.activeElement).toBe(workingTreeTab);
    fireEvent.click(baseTab);
    expect(baseTab.getAttribute('aria-selected')).toBe('true');
  });
});

function TabHarness() {
  const [mode, setMode] = useState<GitReviewMode>('base-comparison');
  const panelId =
    mode === 'base-comparison'
      ? GIT_BASE_PANEL_ID
      : mode === 'agent-comparison'
        ? GIT_AGENT_COMPARISON_PANEL_ID
        : GIT_WORKING_TREE_PANEL_ID;
  return (
    <>
      <GitReviewModeTabs mode={mode} onChange={setMode} />
      <div id={panelId} role="tabpanel">
        {mode}
      </div>
    </>
  );
}

function comparison(): GitAgentBaseComparisonView {
  return {
    baseCommit: BASE_COMMIT,
    headCommit: HEAD_COMMIT,
    ahead: 1,
    behind: 0,
    commitCount: 1,
    commits: [{ oid: HEAD_COMMIT, relation: 'ahead' }],
    commitIdsTruncated: false,
    diff: {
      additions: 1,
      deletions: 1,
      files: [
        {
          oldPath: 'src/committed.ts',
          newPath: 'src/committed.ts',
          status: 'modified',
          binary: false,
          hunks: [
            {
              id: 'c'.repeat(20),
              header: '@@ -1 +1 @@',
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: [
                { kind: 'deletion', content: 'old line', oldLine: 1, newLine: null },
                { kind: 'addition', content: 'new committed line', oldLine: null, newLine: 1 },
              ],
            },
          ],
        },
      ],
    },
  };
}
