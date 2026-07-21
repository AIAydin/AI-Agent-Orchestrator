// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { GitPrNodeController } from './types.js';

const controller = vi.hoisted(() => ({ current: null as unknown as GitPrNodeController }));
const useGitPrNodeController = vi.hoisted(() => vi.fn(() => controller.current));
vi.mock('./useGitPrNodeController.js', () => ({ useGitPrNodeController }));

import type { WorkshopNodeData } from '../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../canvas/interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../runs/agent-session/AgentSessionContext.js';
import { GitPrNodeFace } from './GitPrNodeFace.js';

const updateNodeData = vi.fn();
const recordHistory = vi.fn();
const openGitPrReadiness = vi.fn();

function baseController(overrides: Partial<GitPrNodeController> = {}): GitPrNodeController {
  return {
    agentRuns: [],
    agentRunsLoaded: true,
    agentRunsError: null,
    availableRemotes: null,
    inspection: null,
    inspectionError: null,
    githubStatus: null,
    githubError: null,
    ciStatus: null,
    ciError: null,
    actionError: null,
    pendingPlan: null,
    busy: null,
    notice: null,
    refreshAgentRuns: vi.fn(),
    inspect: vi.fn(),
    preparePush: vi.fn(),
    checkGitHub: vi.fn(),
    preparePullRequest: vi.fn(),
    checkCi: vi.fn(),
    cancelPlan: vi.fn(),
    confirmPlan: vi.fn(),
    ...overrides,
  };
}

afterEach(cleanup);
beforeEach(() => {
  updateNodeData.mockClear();
  recordHistory.mockClear();
  openGitPrReadiness.mockClear();
  useGitPrNodeController.mockClear();
  controller.current = baseController();
});

function sessionValue(): AgentSessionContextValue {
  return {
    project: { id: 'p1' },
    settings: { gitRemote: 'origin' },
    graphReadOnly: false,
    updateNodeData,
    recordHistory,
    reportError: vi.fn(),
    runnableAgents: [{ id: 'claude', label: 'Claude Code' }],
    nodeRoster: [{ id: 'a1', title: 'Builder', kind: 'agent', locked: false }],
    checkProducers: [],
    openGitPrReadiness,
  } as unknown as AgentSessionContextValue;
}

function nodeData(overrides: Partial<WorkshopNodeData> = {}): WorkshopNodeData {
  return {
    kind: 'git-pr',
    title: 'Publish login',
    description: '',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#7888d8',
    deliveryTarget: { kind: 'agent-run', runId: 'run-1' },
    ...overrides,
  } as WorkshopNodeData;
}

function renderFace(overrides: Partial<WorkshopNodeData> = {}) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue()}>
        <GitPrNodeFace id="n1" data={nodeData(overrides)} />
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

describe('GitPrNodeFace', () => {
  it('drives the existing controller with roster-derived labels', () => {
    renderFace();
    expect(useGitPrNodeController).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p1',
        nodes: [{ id: 'a1', data: { title: 'Builder' } }],
        agents: [{ id: 'claude', label: 'Claude Code' }],
      }),
    );
  });

  it('shows the operational strip once an inspection exists', () => {
    controller.current = baseController({
      inspection: {
        targetRunId: 'run-1',
        sourceBranch: 'feature/login',
        remote: 'origin',
        destinationBranch: 'feature/login',
        requestedBaseBranch: 'main',
        commitCount: 3,
        fileCount: 5,
        additions: 120,
        deletions: 8,
        ahead: 3,
        behind: 1,
        ready: true,
        readiness: [],
        commits: [],
        files: [],
      } as unknown as NonNullable<GitPrNodeController['inspection']>,
    });
    renderFace({ remote: 'origin', destinationBranch: 'feature/login', baseBranch: 'main' });
    expect(screen.getByText('feature/login → origin/main')).toBeTruthy();
    expect(screen.getByText('3 ahead · 1 behind')).toBeTruthy();
    expect(screen.getByText('3 commits')).toBeTruthy();
    expect(screen.getByRole('status')).toHaveProperty('textContent', 'Ready to publish');
  });

  it('runs checks and opens readiness from the face', () => {
    renderFace();
    fireEvent.click(screen.getByRole('button', { name: 'Check changes' }));
    expect(controller.current.inspect).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open checks and approval' }));
    expect(openGitPrReadiness).toHaveBeenCalledWith('run-1');
  });

  it('shows the created pull request link', () => {
    renderFace({ pullRequestUrl: 'https://github.com/acme/app/pull/7' });
    expect(screen.getByText('https://github.com/acme/app/pull/7')).toBeTruthy();
  });

  it('disables publish-affecting controls for read-only nodes', () => {
    renderFace({ locked: true });
    expect(screen.getByRole('button', { name: 'Open checks and approval' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('triggers the push review from the face once the inspection is ready', () => {
    controller.current = baseController({ inspection: readyInspection() });
    renderFace({ remote: 'origin', destinationBranch: 'feature/login', baseBranch: 'main' });
    const reviewPush = screen.getByRole('button', { name: 'Review push' });
    expect(reviewPush).toHaveProperty('disabled', false);
    fireEvent.click(reviewPush);
    expect(controller.current.preparePush).toHaveBeenCalled();
  });

  it('keeps the push review disabled until the inspection reports ready', () => {
    controller.current = baseController({
      inspection: { ...readyInspection(), ready: false, readiness: ['Needs approval'] },
    });
    renderFace({ remote: 'origin', destinationBranch: 'feature/login', baseBranch: 'main' });
    expect(screen.getByRole('button', { name: 'Review push' })).toHaveProperty('disabled', true);
  });

  it('confirms the pending plan from the focus-trapped dialog', () => {
    controller.current = baseController({ pendingPlan: pushPlan() });
    renderFace();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to final confirmation' }));
    expect(controller.current.confirmPlan).toHaveBeenCalled();
    expect(controller.current.cancelPlan).not.toHaveBeenCalled();
  });

  it('cancels the pending plan from the dialog', () => {
    controller.current = baseController({ pendingPlan: pushPlan() });
    renderFace();
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
    expect(controller.current.cancelPlan).toHaveBeenCalled();
    expect(controller.current.confirmPlan).not.toHaveBeenCalled();
  });

  it('cancels the pending plan when Escape is pressed', () => {
    controller.current = baseController({ pendingPlan: pushPlan() });
    renderFace();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(controller.current.cancelPlan).toHaveBeenCalled();
  });

  it('shows the pull-request plan details in the confirmation dialog', () => {
    controller.current = baseController({
      pendingPlan: {
        kind: 'pull-request',
        planId: 'plan-9',
        expiresAt: '2026-07-21T00:05:00.000Z',
        ownerRepository: 'acme/app',
        title: 'Add login',
        body: 'Ship the login page.',
        draft: true,
        inspection: readyInspection(),
      } as unknown as NonNullable<GitPrNodeController['pendingPlan']>,
    });
    renderFace();
    expect(screen.getByText('Review the pull request')).toBeTruthy();
    expect(screen.getByText('acme/app')).toBeTruthy();
    expect(screen.getByText('Ship the login page.')).toBeTruthy();
  });
});

function readyInspection(): NonNullable<GitPrNodeController['inspection']> {
  return {
    targetRunId: 'run-1',
    sourceBranch: 'feature/login',
    sourceOid: 'abc1234',
    remote: 'origin',
    remoteDisclosure: 'https://github.com/acme/app',
    destinationBranch: 'feature/login',
    requestedBaseBranch: 'main',
    requestedBaseOid: 'main0000',
    runBaseRef: 'main',
    runBaseOid: 'base0000',
    divergenceBaseOid: 'div00000',
    commitCount: 3,
    commits: ['abc1234'],
    commitsTruncated: false,
    fileCount: 5,
    files: [],
    filesTruncated: false,
    additions: 120,
    deletions: 8,
    ahead: 3,
    behind: 1,
    ready: true,
    readiness: [],
    inspectedAt: '2026-07-21T00:00:00.000Z',
  } as unknown as NonNullable<GitPrNodeController['inspection']>;
}

function pushPlan(): NonNullable<GitPrNodeController['pendingPlan']> {
  return {
    kind: 'push',
    planId: 'plan-1',
    expiresAt: '2026-07-21T00:05:00.000Z',
    inspection: readyInspection(),
  } as unknown as NonNullable<GitPrNodeController['pendingPlan']>;
}
