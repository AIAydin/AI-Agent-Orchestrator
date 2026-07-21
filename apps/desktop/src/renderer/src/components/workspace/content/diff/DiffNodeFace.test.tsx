// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const useGitReview = vi.hoisted(() => vi.fn());
vi.mock('../../../git-review/useGitReview.js', () => ({ useGitReview }));
vi.mock('../../../git-review/diff/GitDiffViewer.js', () => ({
  GitDiffViewer: ({ file }: { file: { path: string } | null }) => (
    <div data-testid="diff-viewer">{file?.path ?? 'none'}</div>
  ),
}));

import type { GitReviewView } from '../../../../../../shared/git/contracts.js';
import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../../runs/agent-session/AgentSessionContext.js';
import { DiffNodeFace } from './DiffNodeFace.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

const openDiffReview = vi.fn();

afterEach(cleanup);
beforeEach(() => {
  openDiffReview.mockClear();
  useGitReview.mockReturnValue({
    review: reviewWithFile('src/app.ts'),
    loading: false,
    busyLabel: null,
    error: null,
  });
});

function reviewWithFile(path: string): GitReviewView {
  return {
    target: { kind: 'primary', projectId: PROJECT_ID },
    branch: 'main',
    dirty: true,
    conflicted: false,
    ahead: 1,
    behind: 0,
    refreshedAt: new Date().toISOString(),
    entries: [{ path, index: 'M', worktree: '.', kind: 'ordinary', originalPath: null }],
    staged: {
      additions: 3,
      deletions: 1,
      files: [{ newPath: path, oldPath: path, status: 'modified', binary: false, hunks: [] }],
    },
    unstaged: { additions: 0, deletions: 0, files: [] },
  } as unknown as GitReviewView;
}

function sessionValue(): AgentSessionContextValue {
  return {
    project: { id: PROJECT_ID, name: 'Demo', health: { isGitRepository: true } },
    graphReadOnly: false,
    openDiffReview,
  } as unknown as AgentSessionContextValue;
}

function nodeData(overrides: Partial<WorkshopNodeData> = {}): WorkshopNodeData {
  return {
    kind: 'diff',
    title: 'Review',
    description: '',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#e27b68',
    ...overrides,
  } as WorkshopNodeData;
}

function renderFace(overrides: Partial<WorkshopNodeData> = {}) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue()}>
        <DiffNodeFace id="n1" data={nodeData(overrides)} />
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

describe('DiffNodeFace', () => {
  it('renders the compact file list and the selected file in the viewer', () => {
    renderFace();
    expect(screen.getByRole('button', { name: /src\/app\.ts/ })).toBeTruthy();
    expect(screen.getByTestId('diff-viewer').textContent).toBe('src/app.ts');
  });

  it('maximizes into the full review dialog with the persisted preferences', () => {
    renderFace({ viewMode: 'split', showWhitespace: true });
    fireEvent.click(screen.getByRole('button', { name: 'Open review' }));
    expect(openDiffReview).toHaveBeenCalledWith('n1', {
      target: { kind: 'primary', projectId: PROJECT_ID },
      preferences: { viewMode: 'split', showWhitespace: true },
      purpose: 'review',
    });
  });

  it('shows a hint instead of the viewer when the project is not a Git repo', () => {
    const value = sessionValue();
    (value.project.health as { isGitRepository: boolean }).isGitRepository = false;
    render(
      <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
        <AgentSessionProvider value={value}>
          <DiffNodeFace id="n1" data={nodeData()} />
        </AgentSessionProvider>
      </CanvasNodeInteractionProvider>,
    );
    expect(screen.queryByTestId('diff-viewer')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('not tracked by Git');
  });
});
