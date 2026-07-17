// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentDetection } from '../../../../../../shared/application/contracts.js';
import type { RunHistorySummary } from '../../../../../../shared/runs/contracts.js';
import { AgentAttemptHistory } from './AgentAttemptHistory.js';

const PROJECT_ID = '95000000-0000-4000-8000-000000000001';
const RUN_ID = '95000000-0000-4000-8000-000000000002';
const PARENT_ID = '95000000-0000-4000-8000-000000000003';
const listRuns = vi.fn();
const SELECTED_AUTHORITY = {
  adapterId: 'codex' as const,
  model: 'gpt-5.1-codex',
  permissionProfile: 'worktree-write' as const,
};

const codexAgent: AgentDetection & { id: 'codex' } = {
  id: 'codex',
  label: 'OpenAI Codex CLI',
  installed: true,
  executable: '/usr/local/bin/codex',
  version: '1.2.3',
  providerDisclosure: 'Provider-controlled network.',
  capabilities: {
    interactiveInput: true,
    interrupt: true,
    pause: false,
    resume: true,
    modelSelection: true,
  },
  capabilitySource: 'manifest',
};

beforeEach(() => {
  listRuns.mockReset();
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: { runs: { list: listRuns } },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'forgeboard');
});

describe('AgentAttemptHistory', () => {
  it('loads only the selected node and exposes complete attempt evidence and reviewed actions', async () => {
    const attempt = runSummary();
    const onRetryAttempt = vi.fn();
    const onResumeAttempt = vi.fn();
    const onReviewAttempt = vi.fn();
    listRuns.mockResolvedValue({ ok: true, value: [attempt] });

    render(
      <AgentAttemptHistory
        projectId={PROJECT_ID}
        nodeId="agent-node"
        refreshKey="run:interrupted"
        agents={[codexAgent]}
        selectedAuthority={SELECTED_AUTHORITY}
        actionUnavailableReason={null}
        onRetryAttempt={onRetryAttempt}
        onResumeAttempt={onResumeAttempt}
        onReviewAttempt={onReviewAttempt}
      />,
    );

    expect(await screen.findByRole('article', { name: 'Retry attempt Interrupted' })).toBeTruthy();
    expect(listRuns).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      nodeId: 'agent-node',
      limit: 50,
    });
    expect(screen.getByText('OpenAI Codex CLI')).toBeTruthy();
    expect(screen.getByText('gpt-5.1-codex')).toBeTruthy();
    expect(screen.getByText('Dedicated worktree')).toBeTruthy();
    expect(screen.getByText('feature/agent-node')).toBeTruthy();
    expect(screen.getByText('Available for review')).toBeTruthy();
    expect(screen.getByText('Input tokens')).toBeTruthy();
    expect(screen.getByText('Cached input tokens')).toBeTruthy();
    expect(screen.getByText('Output tokens')).toBeTruthy();
    expect(screen.getByText('Total tokens')).toBeTruthy();
    expect(screen.getByText('250')).toBeTruthy();
    expect(screen.getByText('1,500')).toBeTruthy();
    expect(screen.getByText('$0.0425')).toBeTruthy();
    expect(screen.getByText('Available for resume review (CLI capability probed)')).toBeTruthy();
    fireEvent.click(screen.getByText('Output preview'));
    expect(screen.getByText('Changed src/agent.ts')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Retry review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Resume review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    expect(onRetryAttempt).toHaveBeenCalledWith(attempt);
    expect(onResumeAttempt).toHaveBeenCalledWith(attempt);
    expect(onReviewAttempt).toHaveBeenCalledWith(attempt);
  });

  it('does not present unavailable resume or worktree actions as usable', async () => {
    listRuns.mockResolvedValue({
      ok: true,
      value: [
        {
          ...runSummary(),
          providerSessionAvailable: false,
          resumeSupported: false,
          worktreeState: 'cleaned',
          worktreeAvailable: false,
        },
      ],
    });

    render(
      <AgentAttemptHistory
        projectId={PROJECT_ID}
        nodeId="agent-node"
        refreshKey="complete"
        agents={[codexAgent]}
        selectedAuthority={SELECTED_AUTHORITY}
        actionUnavailableReason={null}
      />,
    );

    await screen.findByRole('article');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Retry review' }).disabled).toBe(
      true,
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Resume review' }).disabled).toBe(
      true,
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Review changes' }).disabled).toBe(
      true,
    );
    expect(screen.getByText('Not exposed by provider')).toBeTruthy();
  });

  it('disables every continuation and review action for superseded authority', async () => {
    const superseded = {
      ...runSummary(),
      supersededByNewerAttempt: true,
      worktreeAvailable: false,
    };
    listRuns.mockResolvedValue({ ok: true, value: [superseded] });
    render(
      <AgentAttemptHistory
        projectId={PROJECT_ID}
        nodeId="agent-node"
        refreshKey="superseded"
        agents={[codexAgent]}
        selectedAuthority={SELECTED_AUTHORITY}
        actionUnavailableReason={null}
        onRetryAttempt={vi.fn()}
        onResumeAttempt={vi.fn()}
        onReviewAttempt={vi.fn()}
      />,
    );

    await screen.findByText('Superseded by newer resume');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Retry review' }).disabled).toBe(
      true,
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Resume review' }).disabled).toBe(
      true,
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Review changes' }).disabled).toBe(
      true,
    );
    expect(screen.getByRole('button', { name: 'Retry review' }).title).toContain(
      'newer resumed attempt',
    );
  });

  it('explains that a succeeded attempt is not retryable', async () => {
    listRuns.mockResolvedValue({
      ok: true,
      value: [{ ...runSummary(), status: 'succeeded', resumeSupported: false }],
    });
    render(
      <AgentAttemptHistory
        projectId={PROJECT_ID}
        nodeId="agent-node"
        refreshKey="succeeded"
        agents={[codexAgent]}
        selectedAuthority={SELECTED_AUTHORITY}
        actionUnavailableReason={null}
        onRetryAttempt={vi.fn()}
      />,
    );

    const retryButton = await screen.findByRole<HTMLButtonElement>('button', {
      name: 'Retry review',
    });
    expect(retryButton.disabled).toBe(true);
    expect(retryButton.title).toContain('failed, interrupted, terminated, or lost');
  });

  it('reports load failures and retries from an accessible action', async () => {
    listRuns
      .mockResolvedValueOnce({ ok: false, error: { message: 'History database unavailable' } })
      .mockResolvedValueOnce({ ok: true, value: [] });
    render(
      <AgentAttemptHistory
        projectId={PROJECT_ID}
        nodeId="agent-node"
        refreshKey="initial"
        agents={[codexAgent]}
        selectedAuthority={SELECTED_AUTHORITY}
        actionUnavailableReason={null}
      />,
    );

    expect((await screen.findByRole('alert')).textContent).toContain(
      'History database unavailable',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(screen.getByText('No attempts have been recorded for this Agent node.')).toBeTruthy(),
    );
    expect(listRuns).toHaveBeenCalledTimes(2);
  });
});

function runSummary(): RunHistorySummary {
  return {
    id: RUN_ID,
    projectId: PROJECT_ID,
    nodeId: 'agent-node',
    adapterId: 'codex',
    model: 'gpt-5.1-codex',
    permissionProfile: 'worktree-write',
    providerSessionAvailable: true,
    resumeSupported: true,
    resumeCapabilitySource: 'probe',
    action: 'retry',
    parentRunId: PARENT_ID,
    status: 'interrupted',
    branch: 'feature/agent-node',
    worktreeState: 'active',
    worktreeAvailable: true,
    supersededByNewerAttempt: false,
    startedAt: '2026-07-17T18:00:00.000Z',
    endedAt: '2026-07-17T18:01:05.000Z',
    exitCode: 130,
    outputDigest: 'a'.repeat(64),
    changedFileCount: 1,
    tokenUsage: {
      inputTokens: 1_000,
      cachedInputTokens: 250,
      outputTokens: 500,
      totalTokens: 1_500,
    },
    costUsd: 0.0425,
    outputPreview: 'Changed src/agent.ts',
    createdAt: '2026-07-17T18:00:00.000Z',
    updatedAt: '2026-07-17T18:01:05.000Z',
  };
}
