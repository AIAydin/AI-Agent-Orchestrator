// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunDisclosure } from '../../../../../../shared/application/contracts.js';
import type {
  WorkflowApprovalRequest,
  WorkflowHumanDecisionRequest,
} from '../../../../../../shared/workflow/contracts.js';
import { WorkflowDecisionDialog } from '../WorkflowDecisionDialog.js';

afterEach(cleanup);

describe('WorkflowDecisionDialog', () => {
  it('shows the exact launch disclosure before forwarding approval', () => {
    const onApproveLaunch = vi.fn();
    const request: WorkflowApprovalRequest = {
      executionId: 'workflow-execution',
      nodeId: 'agent-node',
      attempt: 1,
      executorId: 'agent-executor',
      preparationId: 'prepared-launch',
      approvalFingerprint: 'fingerprint-123',
      expiresAt: '2099-07-15T12:05:00.000Z',
      disclosure: {
        executable: '/usr/local/bin/agent',
        arguments: ['run', '--local'],
        workingDirectory: '/tmp/project',
      },
    };
    render(
      <WorkflowDecisionDialog
        {...baseProps()}
        target={{ kind: 'launch', request }}
        onApproveLaunch={onApproveLaunch}
      />,
    );

    expect(screen.getByRole('dialog', { name: 'Review this workflow launch' })).toBeTruthy();
    expect(screen.getByText(/\/usr\/local\/bin\/agent/u)).toBeTruthy();
    expect(screen.getByText(/workingDirectory/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to native launch approval' }));
    expect(onApproveLaunch).toHaveBeenCalledWith(request);
  });

  it('renders a typed agent disclosure instead of an opaque JSON dump', () => {
    const request: WorkflowApprovalRequest = {
      executionId: 'workflow-execution',
      nodeId: 'agent-node',
      attempt: 1,
      executorId: 'agent-executor',
      preparationId: 'prepared-agent-launch',
      approvalFingerprint: 'fingerprint-typed-agent',
      expiresAt: '2099-07-15T12:05:00.000Z',
      disclosure: agentDisclosure(),
    };
    render(<WorkflowDecisionDialog {...baseProps()} target={{ kind: 'launch', request }} />);

    expect(screen.getByRole('region', { name: 'Effective permission profile' })).toBeTruthy();
    expect(screen.getByText('Docker technical boundary')).toBeTruthy();
    expect(screen.getByText(/Ignored allow · sensitive allow/u)).toBeTruthy();
    expect(screen.getByText(/Network disabled · 2 CPU · 4096 MB memory/u)).toBeTruthy();
    expect(screen.getByText('Not mounted')).toBeTruthy();
    expect(screen.getByText(/in-image agent payload has not started/u)).toBeTruthy();
    expect(screen.getByText('workflow-context-manifest')).toBeTruthy();
    expect(screen.queryByText(/"contextManifestId"/u)).toBeNull();
  });

  it('requires actionable feedback before requesting changes', () => {
    const onDecideReview = vi.fn();
    const onReviewChanges = vi.fn();
    const reviewedRunId = '2c42e358-f4ad-41ec-b662-071e6796d6c2';
    const request: WorkflowHumanDecisionRequest = {
      executionId: 'workflow-execution',
      targetId: 'review-node',
      targetType: 'human-review',
      targetAttempt: 2,
      evidenceFingerprint: 'review-evidence-fingerprint',
      evidence: {
        targetId: 'review-node',
        relevantOutputs: {
          'diff-output': {
            referenceIds: [`agent-run:${reviewedRunId}`],
          },
        },
      },
    };
    render(
      <WorkflowDecisionDialog
        {...baseProps()}
        target={{ kind: 'human', request }}
        onDecideReview={onDecideReview}
        onReviewChanges={onReviewChanges}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Review bound worktree changes' }));
    expect(onReviewChanges).toHaveBeenCalledWith(reviewedRunId);

    fireEvent.click(screen.getByRole('radio', { name: /Request changes/u }));
    const submit = screen.getByRole('button', {
      name: 'Continue to native review confirmation',
    });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Actionable feedback/u), {
      target: { value: 'Add a regression test for the failed behavior.' },
    });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    expect(onDecideReview).toHaveBeenCalledWith(
      request,
      'changes-requested',
      'Add a regression test for the failed behavior.',
    );
  });
});

function baseProps(): React.ComponentProps<typeof WorkflowDecisionDialog> {
  return {
    target: {
      kind: 'revision',
      request: {
        executionId: 'workflow-execution',
        loopId: 'revision-loop',
        attemptsStarted: 3,
        evidenceFingerprint: 'revision-evidence-fingerprint',
        evidence: {
          loopId: 'revision-loop',
          exhaustedAfter: 3,
        },
      },
    },
    busy: false,
    onClose: vi.fn(),
    onApproveLaunch: vi.fn(),
    onApproveHuman: vi.fn(),
    onDecideReview: vi.fn(),
    onResolveRevision: vi.fn(),
    onReviewChanges: vi.fn(),
  };
}

function agentDisclosure(): RunDisclosure {
  return {
    runId: '00000000-0000-4000-8000-000000000011',
    nodeId: 'agent-node',
    adapterId: 'codex',
    provider: 'OpenAI',
    executable: 'docker',
    arguments: ['run', '--network', 'none'],
    cwd: '/tmp/worktrees/agent-node',
    runtime: 'pty',
    environmentVariableNames: [],
    contextAttachments: [],
    contextManifestId: 'workflow-context-manifest',
    contextManifestDigest: 'c'.repeat(64),
    permissionProfile: {
      name: 'Custom Docker policy',
      mode: 'custom',
      enforcement: 'docker',
      readRoots: ['/workspace'],
      writeRoots: [],
      network: 'blocked',
      custom: {
        runtime: 'docker',
        filesystem: 'assigned-worktree-read-only',
        ignoredFileRead: 'allow',
        sensitiveFileRead: 'allow',
        launchExecutablePolicy: 'allowlist',
        allowedLaunchExecutables: ['/usr/local/bin/codex'],
        forgeboardManagedActions: { developmentServers: 'deny', tests: 'deny' },
        requireReviewBeforePrimary: true,
        policyLimitations: ['The whole assigned worktree is visible inside this container.'],
        docker: {
          network: 'disabled',
          cpuLimit: 2,
          memoryMb: 4096,
          mountHostCredentials: false,
        },
      },
    },
    warnings: [],
    branch: 'forgeboard/task/codex-2',
    baseCommit: 'd'.repeat(40),
    primaryWasDirty: false,
  };
}
