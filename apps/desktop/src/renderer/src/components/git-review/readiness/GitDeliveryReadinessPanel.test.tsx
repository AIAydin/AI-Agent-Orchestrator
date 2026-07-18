// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  GitDeliveryReadinessGetView,
  GitDeliveryReadinessView,
} from '../../../../../shared/git/readiness/index.js';
import { GitDeliveryReadinessPanel } from './GitDeliveryReadinessPanel.js';

const READINESS_ID = '10000000-0000-4000-8000-000000000001';
const PROJECT_ID = '20000000-0000-4000-8000-000000000001';
const RUN_ID = '30000000-0000-4000-8000-000000000001';
const WORKTREE_ID = '40000000-0000-4000-8000-000000000001';
const CURRENT_HEAD = 'a'.repeat(40);
const PREVIOUS_HEAD = 'b'.repeat(40);
const CURRENT_DIGEST = 'c'.repeat(64);
const PREVIOUS_DIGEST = 'd'.repeat(64);
const CONFIGURATION_DIGEST = 'e'.repeat(64);
const EVIDENCE_FINGERPRINT = '1'.repeat(64);
const NOW = '2026-07-16T20:00:00.000Z';
const WORKFLOW_EXECUTION_ID = 'workflow-execution-1';

type RequiredCheck = GitDeliveryReadinessView['requiredChecks'][number];
type RequiredCheckState = RequiredCheck['state'];
type SourceFingerprint = GitDeliveryReadinessView['sourceFingerprint'];
type AvailableCheck = GitDeliveryReadinessGetView['availableChecks'][number];
type CheckId = AvailableCheck['checkId'];

const STATE_EXPECTATIONS: ReadonlyArray<
  readonly [RequiredCheckState, string, 'Run' | 'Re-run', boolean, string]
> = [
  ['missing', 'Not run', 'Run', false, "hasn't run for the current changes"],
  ['queued', 'Queued', 'Re-run', true, 'waiting to start'],
  ['running', 'Running', 'Re-run', true, 'running for the current changes'],
  ['passed', 'Passed', 'Re-run', false, 'passed for the current changes'],
  ['failed', 'Failed', 'Re-run', false, 'failed and blocks delivery'],
  ['cancelled', 'Cancelled', 'Re-run', false, 'cancelled before it could pass'],
  ['lost', 'Lost', 'Re-run', false, 'lost track of this check'],
  ['stale', 'Outdated', 'Re-run', false, 'changed after this check ran'],
];

afterEach(cleanup);

describe('GitDeliveryReadinessPanel', () => {
  it.each(STATE_EXPECTATIONS)(
    'renders the %s required-check state with an honest action',
    (state, stateLabel, actionLabel, actionDisabled, description) => {
      const check = requiredCheck(state, stateIndex(state));
      const prepared = readiness({ requiredChecks: [check] });
      renderPreparedPanel(prepared);

      expect(screen.getByText(stateLabel, { selector: '.git-delivery-check-state' })).toBeTruthy();
      expect(screen.getByText(new RegExp(description, 'u'))).toBeTruthy();
      const action = screen.getByRole('button', {
        name: `${actionLabel} ${check.label}`,
      });
      expect((action as HTMLButtonElement).disabled).toBe(actionDisabled);
    },
  );

  it('runs a check and records quality approval through keyboard-focusable callback buttons', () => {
    const check = requiredCheck('passed', 20);
    const prepared = readiness({ requiredChecks: [check] });
    const onRunCheck = vi.fn<(checkId: CheckId) => void>();
    const onApproveQuality = vi.fn<() => void>();
    render(
      <GitDeliveryReadinessPanel
        view={getView(prepared)}
        selectedWorkflowExecutionId={WORKFLOW_EXECUTION_ID}
        selectedCheckIds={[]}
        onRunCheck={onRunCheck}
        onSelectedWorkflowExecutionIdChange={vi.fn()}
        onSelectedCheckIdsChange={vi.fn()}
        onPrepareRequirements={vi.fn()}
        onApproveQuality={onApproveQuality}
      />,
    );

    const run = screen.getByRole('button', { name: `Re-run ${check.label}` });
    run.focus();
    expect(document.activeElement).toBe(run);
    fireEvent.click(run);
    expect(onRunCheck).toHaveBeenCalledWith(check.checkId);

    const approve = screen.getByRole('button', { name: 'Approve quality' });
    approve.focus();
    expect(document.activeElement).toBe(approve);
    fireEvent.click(approve);
    expect(onApproveQuality).toHaveBeenCalledTimes(1);
  });

  it('locks workflow-derived checks and permits only configured optional extras', () => {
    const mandatory = availableCheck(30, 'configured');
    const optional = availableCheck(33, 'configured');
    const unconfigured = availableCheck(31, 'unconfigured');
    const disabled = availableCheck(32, 'disabled');
    const view = getView(null, {
      availableChecks: [mandatory, optional, unconfigured, disabled],
    });
    const onSelectedCheckIdsChange = vi.fn<(checkIds: readonly CheckId[]) => void>();
    const onPrepareRequirements = vi.fn<(checkIds: readonly CheckId[]) => void>();
    const commonProps = {
      view,
      selectedWorkflowExecutionId: WORKFLOW_EXECUTION_ID,
      onRunCheck: vi.fn<(checkId: CheckId) => void>(),
      onSelectedWorkflowExecutionIdChange: vi.fn<(executionId: string) => void>(),
      onSelectedCheckIdsChange,
      onPrepareRequirements,
      onApproveQuality: vi.fn<() => void>(),
    };
    const { rerender } = render(
      <GitDeliveryReadinessPanel {...commonProps} selectedCheckIds={[]} />,
    );

    expect(screen.getByText(/Checks required by the workflow are locked/u)).toBeTruthy();
    expect(screen.queryByText(/no checks are required/iu)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Run /u })).toBeNull();
    expect(button('Save delivery requirements').disabled).toBe(false);
    expect(button('Approve quality').disabled).toBe(true);

    expect(checkbox(mandatory.label).checked).toBe(true);
    expect(checkbox(mandatory.label).disabled).toBe(true);
    const optionalChoice = checkbox(optional.label);
    optionalChoice.focus();
    expect(document.activeElement).toBe(optionalChoice);
    fireEvent.click(optionalChoice);
    expect(onSelectedCheckIdsChange).toHaveBeenCalledWith([optional.checkId]);
    expect(checkbox(unconfigured.label).disabled).toBe(true);
    expect(checkbox(disabled.label).disabled).toBe(true);

    rerender(<GitDeliveryReadinessPanel {...commonProps} selectedCheckIds={[optional.checkId]} />);
    const save = button('Save delivery requirements');
    expect(save.disabled).toBe(false);
    save.focus();
    expect(document.activeElement).toBe(save);
    fireEvent.click(save);
    expect(onPrepareRequirements).toHaveBeenCalledWith([optional.checkId]);
  });

  it('selects only from the main-provided compatible workflow executions', () => {
    const required = availableCheck(35, 'configured');
    const secondExecutionId = 'workflow-execution-2';
    const view = getView(null, {
      availableChecks: [required],
      compatibleWorkflowExecutions: [
        {
          executionId: WORKFLOW_EXECUTION_ID,
          canvasId: 'canvas-1',
          executionRevision: 7,
          endedAt: NOW,
          derivedCheckIds: [required.checkId],
        },
        {
          executionId: secondExecutionId,
          canvasId: 'canvas-2',
          executionRevision: 8,
          endedAt: '2026-07-16T21:00:00.000Z',
          derivedCheckIds: [required.checkId],
        },
      ],
    });
    const onWorkflowChange = vi.fn<(executionId: string) => void>();
    render(
      <GitDeliveryReadinessPanel
        view={view}
        selectedWorkflowExecutionId={null}
        selectedCheckIds={[]}
        onRunCheck={vi.fn()}
        onSelectedWorkflowExecutionIdChange={onWorkflowChange}
        onSelectedCheckIdsChange={vi.fn()}
        onPrepareRequirements={vi.fn()}
        onApproveQuality={vi.fn()}
      />,
    );

    const selector = screen.getByRole<HTMLSelectElement>('combobox', {
      name: /^Verified workflow execution/u,
    });
    expect([...selector.options].map((option) => option.value)).toEqual([
      '',
      WORKFLOW_EXECUTION_ID,
      secondExecutionId,
    ]);
    expect(selector.value).toBe('');
    fireEvent.change(selector, { target: { value: secondExecutionId } });
    expect(onWorkflowChange).toHaveBeenCalledWith(secondExecutionId);
  });

  it('invalidates run and approval actions until a changed required-check selection is saved', () => {
    const first = requiredCheck('passed', 40);
    const second = availableCheck(41, 'configured');
    const prepared = readiness({
      requiredChecks: [first],
      availableChecks: [availableForRequired(first), second],
    });
    render(
      <GitDeliveryReadinessPanel
        view={getView(prepared)}
        selectedWorkflowExecutionId={WORKFLOW_EXECUTION_ID}
        selectedCheckIds={[second.checkId]}
        onRunCheck={vi.fn()}
        onSelectedWorkflowExecutionIdChange={vi.fn()}
        onSelectedCheckIdsChange={vi.fn()}
        onPrepareRequirements={vi.fn()}
        onApproveQuality={vi.fn()}
      />,
    );

    expect(button('Save delivery requirements').disabled).toBe(false);
    expect(button(`Re-run ${first.label}`).disabled).toBe(true);
    expect(button('Approve quality').disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain("earlier results won't be reused");
  });

  it('explains when source drift invalidated the previously prepared evidence', () => {
    const staleReason =
      'The managed source changed after its delivery checks ran; prepare a new exact binding.';
    render(
      <GitDeliveryReadinessPanel
        view={getView(null, {
          compatibleWorkflowExecutions: [],
          workflowUnavailableReason: 'Run and pass a workflow review gate before delivery.',
          staleReason,
        })}
        selectedWorkflowExecutionId={null}
        selectedCheckIds={[]}
        onRunCheck={vi.fn()}
        onSelectedWorkflowExecutionIdChange={vi.fn()}
        onSelectedCheckIdsChange={vi.fn()}
        onPrepareRequirements={vi.fn()}
        onApproveQuality={vi.fn()}
      />,
    );

    expect(screen.getByText(staleReason).textContent).toContain(staleReason);
    expect(button('Approve quality').disabled).toBe(true);
  });

  it('requires every prepared check to pass before enabling human quality approval', () => {
    const failed = requiredCheck('failed', 50);
    const onApproveQuality = vi.fn<() => void>();
    const prepared = readiness({ requiredChecks: [failed] });
    renderPreparedPanel(prepared, { onApproveQuality });

    const approve = button('Approve quality');
    expect(approve.disabled).toBe(true);
    expect(
      screen.getByText(/Every required check must pass for these exact changes/u),
    ).toBeTruthy();
    fireEvent.click(approve);
    expect(onApproveQuality).not.toHaveBeenCalled();
  });

  it('disables every action while a required check is active or the parent is disabled', () => {
    const queued = requiredCheck('queued', 60);
    const missing = requiredCheck('missing', 61);
    const active = readiness({ requiredChecks: [queued, missing] });
    const commonCallbacks = {
      onRunCheck: vi.fn<(checkId: CheckId) => void>(),
      onSelectedWorkflowExecutionIdChange: vi.fn<(executionId: string) => void>(),
      onSelectedCheckIdsChange: vi.fn<(checkIds: readonly CheckId[]) => void>(),
      onPrepareRequirements: vi.fn<(checkIds: readonly CheckId[]) => void>(),
      onApproveQuality: vi.fn<() => void>(),
    };
    const { rerender } = render(
      <GitDeliveryReadinessPanel
        view={getView(active)}
        selectedWorkflowExecutionId={WORKFLOW_EXECUTION_ID}
        selectedCheckIds={[]}
        {...commonCallbacks}
      />,
    );

    expect(button(`Re-run ${queued.label}`).disabled).toBe(true);
    expect(button(`Run ${missing.label}`).disabled).toBe(true);
    expect(button('Approve quality').disabled).toBe(true);
    expect(checkbox(queued.label).disabled).toBe(true);

    const passed = requiredCheck('passed', 62);
    const prepared = readiness({ requiredChecks: [passed] });
    rerender(
      <GitDeliveryReadinessPanel
        view={getView(prepared)}
        selectedWorkflowExecutionId={WORKFLOW_EXECUTION_ID}
        selectedCheckIds={[]}
        disabled
        {...commonCallbacks}
      />,
    );
    expect(button(`Re-run ${passed.label}`).disabled).toBe(true);
    expect(button('Approve quality').disabled).toBe(true);
    expect(checkbox(passed.label).disabled).toBe(true);
  });

  it('shows a current human approval bound to the exact reviewed source', () => {
    const passed = requiredCheck('passed', 70);
    const currentApproval = approval(currentFingerprint(), 'Ada Reviewer');
    const prepared = readiness({
      requiredChecks: [passed],
      approvals: [currentApproval],
      evaluation: { ready: true, humanApprovalState: 'approved', blockers: [] },
    });
    renderPreparedPanel(prepared);

    expect(screen.getByText('Ready for delivery review')).toBeTruthy();
    expect(screen.getByText(/Ada Reviewer approved these exact changes/u)).toBeTruthy();
    expect(screen.getByText(CURRENT_HEAD.slice(0, 12))).toBeTruthy();
    expect(button('Approval up to date').disabled).toBe(true);
  });

  it('distinguishes a stale human approval and permits explicit approval of the current revision', () => {
    const passed = requiredCheck('passed', 80);
    const onApproveQuality = vi.fn<() => void>();
    const prepared = readiness({
      requiredChecks: [passed],
      approvals: [approval(previousFingerprint(), 'Grace Reviewer')],
      evaluation: {
        ready: false,
        humanApprovalState: 'stale',
        blockers: [{ code: 'human-approval-stale' }],
      },
    });
    renderPreparedPanel(prepared, { onApproveQuality });

    expect(screen.getByRole('alert').textContent).toContain(
      `Grace Reviewer approved version ${PREVIOUS_HEAD.slice(0, 12)}, but the current version is ${CURRENT_HEAD.slice(0, 12)}`,
    );
    expect(screen.getByRole('list', { name: 'Delivery blockers' }).textContent).toContain(
      'Human approval stale',
    );
    fireEvent.click(button('Approve the current results'));
    expect(onApproveQuality).toHaveBeenCalledTimes(1);
  });

  it('explains same-source approval drift as changed check evidence', () => {
    const passed = requiredCheck('passed', 85);
    const onApproveQuality = vi.fn<() => void>();
    const earlierEvidence = '2'.repeat(64);
    const prepared = readiness({
      requiredChecks: [passed],
      approvals: [approval(currentFingerprint(), 'Lin Reviewer', earlierEvidence)],
      evaluation: {
        ready: false,
        humanApprovalState: 'stale',
        blockers: [{ code: 'human-approval-stale' }],
      },
    });
    renderPreparedPanel(prepared, { onApproveQuality });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(
      'Lin Reviewer approved these changes, but the check results changed afterward',
    );
    expect(alert.textContent).not.toContain('current version is');
    fireEvent.click(button('Approve the current results'));
    expect(onApproveQuality).toHaveBeenCalledTimes(1);
  });

  it('does not call a digest-only approval current when another source component differs', () => {
    const passed = requiredCheck('passed', 87);
    const earlierBinding = {
      ...currentFingerprint(),
      sourceTree: '0'.repeat(40),
    };
    const prepared = readiness({
      requiredChecks: [passed],
      approvals: [approval(earlierBinding, 'Tree Reviewer')],
      evaluation: {
        ready: false,
        humanApprovalState: 'stale',
        blockers: [{ code: 'human-approval-stale' }],
      },
    });
    renderPreparedPanel(prepared);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(
      'Tree Reviewer approved an earlier version, but the code, workspace, run, or check setup changed since then',
    );
    expect(screen.queryByText(/Tree Reviewer approved these exact changes/u)).toBeNull();
    expect(button('Approve the current results').disabled).toBe(false);
  });

  it('gives the outer panel and quality panel independent accessible names', () => {
    const prepared = readiness({
      requiredChecks: [requiredCheck('passed', 90)],
    });
    renderPreparedPanel(prepared);

    const delivery = screen.getByRole('region', { name: 'Delivery readiness' });
    const quality = screen.getByRole('region', {
      name: 'Human quality approval',
    });
    expect(delivery.getAttribute('aria-labelledby')).not.toBe(
      quality.getAttribute('aria-labelledby'),
    );
  });
});

function renderPreparedPanel(
  prepared: GitDeliveryReadinessView,
  callbacks: {
    onRunCheck?: (checkId: CheckId) => void;
    onApproveQuality?: () => void;
  } = {},
) {
  return render(
    <GitDeliveryReadinessPanel
      view={getView(prepared)}
      selectedWorkflowExecutionId={WORKFLOW_EXECUTION_ID}
      selectedCheckIds={[]}
      onRunCheck={callbacks.onRunCheck ?? vi.fn()}
      onSelectedWorkflowExecutionIdChange={vi.fn()}
      onSelectedCheckIdsChange={vi.fn()}
      onPrepareRequirements={vi.fn()}
      onApproveQuality={callbacks.onApproveQuality ?? vi.fn()}
    />,
  );
}

function getView(
  prepared: GitDeliveryReadinessView | null,
  overrides: Partial<GitDeliveryReadinessGetView> = {},
): GitDeliveryReadinessGetView {
  return {
    target: { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID },
    source: {
      sourceHead: CURRENT_HEAD,
      sourceTree: 'f'.repeat(40),
      worktreeId: WORKTREE_ID,
      runId: RUN_ID,
    },
    availableChecks: prepared?.availableChecks ?? [],
    compatibleWorkflowExecutions: [
      {
        executionId: WORKFLOW_EXECUTION_ID,
        canvasId: 'canvas-1',
        executionRevision: 7,
        endedAt: NOW,
        derivedCheckIds:
          prepared?.requiredChecks.map((check) => check.checkId) ??
          (overrides.availableChecks?.[0] === undefined
            ? []
            : [overrides.availableChecks[0].checkId]),
      },
    ],
    workflowUnavailableReason: null,
    readiness: prepared,
    staleReason: null,
    refreshedAt: NOW,
    ...overrides,
  };
}

function readiness(
  overrides: Partial<GitDeliveryReadinessView> & {
    evaluation?: GitDeliveryReadinessView['evaluation'];
  } = {},
): GitDeliveryReadinessView {
  const requiredChecks = overrides.requiredChecks ?? [requiredCheck('missing', 0)];
  const availableChecks =
    overrides.availableChecks ?? requiredChecks.map((check) => availableForRequired(check));
  return {
    readinessId: READINESS_ID,
    target: { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID },
    sourceFingerprint: currentFingerprint(),
    workflowBinding: {
      executionId: WORKFLOW_EXECUTION_ID,
      executionRevision: 7,
      canvasId: 'canvas-1',
      sourceNodeId: 'agent-1',
      sourceAttempt: 2,
      sourceOutputDigest: '2'.repeat(64),
      gates: [
        {
          gateNodeId: 'review-gate-1',
          gateAttempt: 2,
          evidenceDigest: '3'.repeat(64),
          derivedCheckIds: requiredChecks.map((check) => check.checkId),
        },
      ],
      bindingDigest: '4'.repeat(64),
    },
    availableChecks,
    requiredChecks,
    approvals: [],
    evidenceFingerprint: EVIDENCE_FINGERPRINT,
    evaluation: {
      ready: false,
      humanApprovalState: 'missing',
      blockers: [
        ...requiredChecks.flatMap((check) => checkBlocker(check)),
        { code: 'human-approval-missing' },
      ],
    },
    updatedAt: NOW,
    ...overrides,
  };
}

function requiredCheck(state: RequiredCheckState, index: number): RequiredCheck {
  const ended = ['passed', 'failed', 'cancelled', 'lost', 'stale'].includes(state);
  const started = state !== 'missing' && state !== 'queued';
  return {
    checkId: uuidFor(index + 100),
    label: `Required check ${String(index)}`,
    kind: 'custom',
    configurationDigest: CONFIGURATION_DIGEST,
    state,
    executionId: state === 'missing' ? null : uuidFor(index + 300),
    sourceFingerprint:
      state === 'missing' ? null : state === 'stale' ? previousFingerprint() : currentFingerprint(),
    startedAt: started ? '2026-07-16T19:58:00.000Z' : null,
    endedAt: ended ? '2026-07-16T19:59:00.000Z' : null,
    updatedAt: NOW,
  };
}

function availableForRequired(check: RequiredCheck): AvailableCheck {
  return {
    checkId: check.checkId,
    label: check.label,
    kind: check.kind,
    availability: 'configured',
    configurationDigest: check.configurationDigest,
  };
}

function availableCheck(
  index: number,
  availability: AvailableCheck['availability'],
): AvailableCheck {
  return {
    checkId: uuidFor(index + 500),
    label: `Available check ${String(index)}`,
    kind: 'custom',
    availability,
    configurationDigest: availability === 'configured' ? CONFIGURATION_DIGEST : null,
  };
}

function approval(
  sourceFingerprint: SourceFingerprint,
  actorLabel: string,
  evidenceFingerprint = EVIDENCE_FINGERPRINT,
): GitDeliveryReadinessView['approvals'][number] {
  return {
    approvalId: '50000000-0000-4000-8000-000000000001',
    authority: 'human',
    actorId: 'local-reviewer',
    actorLabel,
    sourceFingerprint,
    evidenceFingerprint,
    approvedAt: '2026-07-16T19:59:30.000Z',
  };
}

function currentFingerprint(): SourceFingerprint {
  return {
    digest: CURRENT_DIGEST,
    sourceHead: CURRENT_HEAD,
    sourceTree: 'f'.repeat(40),
    worktreeId: WORKTREE_ID,
    runId: RUN_ID,
    requiredCheckConfigurationDigest: CONFIGURATION_DIGEST,
  };
}

function previousFingerprint(): SourceFingerprint {
  return {
    ...currentFingerprint(),
    digest: PREVIOUS_DIGEST,
    sourceHead: PREVIOUS_HEAD,
  };
}

function checkBlocker(check: RequiredCheck): GitDeliveryReadinessView['evaluation']['blockers'] {
  if (check.state === 'passed') return [];
  const suffix = check.state === 'missing' ? 'missing' : check.state;
  return [
    {
      code: `required-check-${suffix}` as GitDeliveryReadinessView['evaluation']['blockers'][number]['code'],
      checkId: check.checkId,
      label: check.label,
    },
  ];
}

function checkbox(name: string): HTMLInputElement {
  return screen.getByRole('checkbox', { name: new RegExp(name, 'u') });
}

function button(name: string): HTMLButtonElement;
function button(name: string, required: false): HTMLButtonElement | null;
function button(name: string, required = true): HTMLButtonElement | null {
  const options = { name };
  return (
    required ? screen.getByRole('button', options) : screen.queryByRole('button', options)
  ) as HTMLButtonElement | null;
}

function stateIndex(state: RequiredCheckState): number {
  return STATE_EXPECTATIONS.findIndex(([candidate]) => candidate === state);
}

function uuidFor(value: number): string {
  return `60000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}
