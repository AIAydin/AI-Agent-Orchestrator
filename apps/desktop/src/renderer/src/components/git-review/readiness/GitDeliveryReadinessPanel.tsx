import {
  BadgeCheck,
  Ban,
  CircleDashed,
  CircleX,
  Clock3,
  History,
  LoaderCircle,
  Play,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  Unplug,
} from 'lucide-react';
import { useId, type ReactNode } from 'react';

import {
  GIT_DELIVERY_READINESS_MAX_REQUIRED_CHECKS,
  gitDeliverySourceFingerprintsEqual,
  type GitDeliveryReadinessGetView,
  type GitDeliveryReadinessView,
} from '../../../../../shared/git/readiness/index.js';
import { WorkspaceTooltip } from '../../workspace/shell/tooltips/WorkspaceTooltip.js';

import './delivery-readiness.css';

type RequiredCheck = GitDeliveryReadinessView['requiredChecks'][number];
type RequiredCheckState = RequiredCheck['state'];
type AvailableCheck = GitDeliveryReadinessGetView['availableChecks'][number];
type CheckId = AvailableCheck['checkId'];

export interface GitDeliveryReadinessPanelProps {
  readonly view: GitDeliveryReadinessGetView;
  readonly selectedWorkflowExecutionId: string | null;
  readonly selectedCheckIds: readonly CheckId[];
  readonly disabled?: boolean;
  readonly runningCheckId?: RequiredCheck['checkId'] | null;
  readonly requirementsBusy?: boolean;
  readonly approvalBusy?: boolean;
  readonly onRunCheck: (checkId: RequiredCheck['checkId']) => void;
  readonly onSelectedWorkflowExecutionIdChange: (executionId: string) => void;
  readonly onSelectedCheckIdsChange: (checkIds: readonly CheckId[]) => void;
  readonly onPrepareRequirements: (checkIds: readonly CheckId[]) => void;
  readonly onApproveQuality: () => void;
}

const CHECK_PRESENTATION: Readonly<
  Record<RequiredCheckState, { label: string; description: string; icon: ReactNode }>
> = {
  missing: {
    label: 'Not run',
    description: "This check hasn't run for the current changes yet.",
    icon: <CircleDashed size={13} aria-hidden="true" />,
  },
  queued: {
    label: 'Queued',
    description: 'This check is waiting to start.',
    icon: <Clock3 size={13} aria-hidden="true" />,
  },
  running: {
    label: 'Running',
    description: 'This check is running for the current changes.',
    icon: <LoaderCircle className="spin" size={13} aria-hidden="true" />,
  },
  passed: {
    label: 'Passed',
    description: 'This check passed for the current changes.',
    icon: <BadgeCheck size={13} aria-hidden="true" />,
  },
  failed: {
    label: 'Failed',
    description: 'This check failed and blocks delivery.',
    icon: <CircleX size={13} aria-hidden="true" />,
  },
  cancelled: {
    label: 'Cancelled',
    description: 'This check was cancelled before it could pass.',
    icon: <Ban size={13} aria-hidden="true" />,
  },
  lost: {
    label: 'Lost',
    description: "Artemis lost track of this check, so its result can't be verified.",
    icon: <Unplug size={13} aria-hidden="true" />,
  },
  stale: {
    label: 'Outdated',
    description: 'The changes or check setup changed after this check ran.',
    icon: <History size={13} aria-hidden="true" />,
  },
};

export function GitDeliveryReadinessPanel({
  view,
  selectedWorkflowExecutionId,
  selectedCheckIds,
  disabled = false,
  runningCheckId = null,
  requirementsBusy = false,
  approvalBusy = false,
  onRunCheck,
  onSelectedWorkflowExecutionIdChange,
  onSelectedCheckIdsChange,
  onPrepareRequirements,
  onApproveQuality,
}: GitDeliveryReadinessPanelProps) {
  const titleId = useId();
  const qualityTitleId = useId();
  const approvalDescriptionId = useId();
  const readiness = view.readiness;
  const selectedWorkflowExecution =
    view.compatibleWorkflowExecutions.find(
      (execution) => execution.executionId === selectedWorkflowExecutionId,
    ) ?? null;
  const mandatoryCheckIds = selectedWorkflowExecution?.derivedCheckIds ?? [];
  const selectedRequiredCheckIds = [...mandatoryCheckIds, ...selectedCheckIds];
  const currentHumanApproval = readiness === null ? null : latestHumanApproval(readiness, true);
  const previousHumanApproval = readiness === null ? null : latestHumanApproval(readiness, false);
  const approvalState = readiness?.evaluation.humanApprovalState ?? 'missing';
  const requiredChecks = readiness?.requiredChecks ?? [];
  const activeCheck = requiredChecks.some(
    (check) => check.state === 'queued' || check.state === 'running',
  );
  const readinessBusy = runningCheckId !== null || requirementsBusy || approvalBusy || activeCheck;
  const requirementsPrepared =
    readiness !== null &&
    readiness.workflowBinding.executionId === selectedWorkflowExecutionId &&
    sameCheckIds(
      selectedRequiredCheckIds,
      requiredChecks.map((check) => check.checkId),
    );
  const selectedChecksValid =
    selectedWorkflowExecution !== null &&
    selectedRequiredCheckIds.length > 0 &&
    selectedRequiredCheckIds.length <= GIT_DELIVERY_READINESS_MAX_REQUIRED_CHECKS &&
    new Set(selectedCheckIds).size === selectedCheckIds.length &&
    selectedCheckIds.every((checkId) => !mandatoryCheckIds.includes(checkId)) &&
    selectedRequiredCheckIds.every((checkId) =>
      view.availableChecks.some(
        (available) => available.checkId === checkId && available.availability === 'configured',
      ),
    );
  const ready = readiness?.evaluation.ready === true && requirementsPrepared;
  const allRequiredChecksPassed =
    requirementsPrepared && requiredChecks.every((check) => check.state === 'passed');
  const qualityState = readiness !== null && !requirementsPrepared ? 'stale' : approvalState;
  const approvalActionState =
    !requirementsPrepared && approvalState === 'approved' ? 'stale' : approvalState;

  return (
    <section className="git-delivery-readiness" aria-labelledby={titleId}>
      <header>
        <span>
          <strong id={titleId}>Delivery readiness</strong>
          <small>Checks and approvals apply to exactly the changes you reviewed.</small>
        </span>
        <span
          className={`git-delivery-readiness-summary ${ready ? 'ready' : 'blocked'}`}
          role="status"
          aria-live="polite"
        >
          {ready ? (
            <ShieldCheck size={12} aria-hidden="true" />
          ) : (
            <TriangleAlert size={12} aria-hidden="true" />
          )}
          {ready ? 'Ready for delivery review' : 'Not ready for delivery'}
        </span>
      </header>

      <CheckRequirementSelector
        checks={view.availableChecks}
        workflowExecutions={view.compatibleWorkflowExecutions}
        workflowUnavailableReason={view.workflowUnavailableReason}
        selectedWorkflowExecutionId={selectedWorkflowExecutionId}
        mandatoryCheckIds={mandatoryCheckIds}
        selectedCheckIds={selectedCheckIds}
        disabled={disabled || readinessBusy}
        busy={requirementsBusy}
        prepared={requirementsPrepared}
        valid={selectedChecksValid}
        onWorkflowExecutionChange={onSelectedWorkflowExecutionIdChange}
        onChange={onSelectedCheckIdsChange}
        onPrepare={() => onPrepareRequirements(selectedCheckIds)}
      />

      {readiness === null ? (
        <div className="git-delivery-unprepared">
          {view.staleReason !== null && (
            <p className="git-delivery-stale-reason" role="alert">
              <TriangleAlert size={12} aria-hidden="true" />
              {view.staleReason}
            </p>
          )}
          <p role="status">Choose a completed workflow run and save its requirements first.</p>
        </div>
      ) : (
        <ul className="git-delivery-checks" aria-label="Required delivery checks">
          {requiredChecks.map((check) => (
            <RequiredCheckRow
              key={check.checkId}
              check={check}
              disabled={disabled || readinessBusy || !requirementsPrepared}
              running={runningCheckId === check.checkId}
              onRun={() => onRunCheck(check.checkId)}
            />
          ))}
        </ul>
      )}

      <section
        className="git-delivery-quality"
        data-state={qualityState}
        aria-labelledby={qualityTitleId}
      >
        <header>
          <span>
            <strong id={qualityTitleId}>Human quality approval</strong>
            <small>
              Separate from your computer's final confirmation. It never replaces a required check.
            </small>
          </span>
          <button
            className="button"
            type="button"
            disabled={
              disabled ||
              readinessBusy ||
              !requirementsPrepared ||
              !allRequiredChecksPassed ||
              approvalActionState === 'approved'
            }
            aria-describedby={approvalDescriptionId}
            aria-busy={approvalBusy || undefined}
            onClick={onApproveQuality}
          >
            {approvalBusy ? (
              <LoaderCircle className="spin" size={13} aria-hidden="true" />
            ) : approvalActionState === 'approved' ? (
              <BadgeCheck size={13} aria-hidden="true" />
            ) : (
              <ShieldCheck size={13} aria-hidden="true" />
            )}
            {approvalBusy
              ? 'Recording approval…'
              : approvalActionState === 'approved'
                ? 'Approval up to date'
                : approvalActionState === 'stale'
                  ? 'Approve the current results'
                  : 'Approve quality'}
          </button>
        </header>

        <p className="git-delivery-quality-binding">
          <span>Current changes</span>
          <code>{shortOid(view.source.sourceHead)}</code>
          {readiness !== null && (
            <>
              <span aria-hidden="true">·</span>
              <WorkspaceTooltip content={readiness.sourceFingerprint.digest}>
                <code
                  tabIndex={0}
                  aria-label={`Quality source fingerprint: ${readiness.sourceFingerprint.digest}`}
                >
                  {readiness.sourceFingerprint.digest.slice(0, 12)}
                </code>
              </WorkspaceTooltip>
            </>
          )}
        </p>

        <QualityApprovalMessage
          id={approvalDescriptionId}
          readiness={readiness}
          requirementsPrepared={requirementsPrepared}
          allRequiredChecksPassed={allRequiredChecksPassed}
          currentApproval={currentHumanApproval}
          previousApproval={previousHumanApproval}
        />
      </section>

      {!ready && readiness !== null && readiness.evaluation.blockers.length > 0 && (
        <ul className="git-delivery-blockers" aria-label="Delivery blockers">
          {readiness.evaluation.blockers.map((blocker, index) => (
            <li key={`${blocker.code}:${blocker.checkId ?? ''}:${String(index)}`}>
              {blocker.label ?? friendlyBlockerCode(blocker.code)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CheckRequirementSelector({
  checks,
  workflowExecutions,
  workflowUnavailableReason,
  selectedWorkflowExecutionId,
  mandatoryCheckIds,
  selectedCheckIds,
  disabled,
  busy,
  prepared,
  valid,
  onWorkflowExecutionChange,
  onChange,
  onPrepare,
}: {
  readonly checks: readonly AvailableCheck[];
  readonly workflowExecutions: GitDeliveryReadinessGetView['compatibleWorkflowExecutions'];
  readonly workflowUnavailableReason: string | null;
  readonly selectedWorkflowExecutionId: string | null;
  readonly mandatoryCheckIds: readonly CheckId[];
  readonly selectedCheckIds: readonly CheckId[];
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly prepared: boolean;
  readonly valid: boolean;
  readonly onWorkflowExecutionChange: (executionId: string) => void;
  readonly onChange: (checkIds: readonly CheckId[]) => void;
  readonly onPrepare: () => void;
}) {
  const helpId = useId();
  const workflowHelpId = useId();
  const selected = new Set(selectedCheckIds);
  const mandatory = new Set(mandatoryCheckIds);
  const configuredCount = checks.filter((check) => check.availability === 'configured').length;
  const maximumReached =
    selected.size + mandatory.size >= GIT_DELIVERY_READINESS_MAX_REQUIRED_CHECKS;

  function toggle(checkId: CheckId, checked: boolean): void {
    const next = new Set(selected);
    if (checked) next.add(checkId);
    else next.delete(checkId);
    onChange([...next]);
  }

  return (
    <fieldset className="git-delivery-requirements" aria-describedby={helpId}>
      <legend>Workflow evidence and required checks</legend>
      <label className="git-delivery-workflow-selector">
        <span>
          <strong>Verified workflow execution</strong>
          <small id={workflowHelpId}>
            Verified by Artemis. Switching runs invalidates earlier delivery evidence.
          </small>
        </span>
        <select
          name="delivery-readiness-workflow-execution"
          value={selectedWorkflowExecutionId ?? ''}
          disabled={disabled || workflowExecutions.length === 0}
          aria-describedby={workflowHelpId}
          onChange={(event) => onWorkflowExecutionChange(event.target.value)}
        >
          {workflowExecutions.length === 0 && <option value="">No compatible execution</option>}
          {selectedWorkflowExecutionId === null && workflowExecutions.length > 0 && (
            <option value="" disabled>
              Select a verified execution
            </option>
          )}
          {workflowExecutions.map((execution) => (
            <option key={execution.executionId} value={execution.executionId}>
              {workflowExecutionLabel(execution)}
            </option>
          ))}
        </select>
      </label>
      {workflowUnavailableReason !== null && (
        <p className="git-delivery-stale-reason" role="alert">
          <TriangleAlert size={12} aria-hidden="true" />
          {workflowUnavailableReason}
        </p>
      )}
      <div className="git-delivery-available-checks">
        {checks.map((check) => {
          const checked = selected.has(check.checkId);
          const requiredByWorkflow = mandatory.has(check.checkId);
          const unavailable = check.availability !== 'configured';
          return (
            <label key={check.checkId}>
              <input
                type="checkbox"
                name="delivery-readiness-required-checks"
                value={check.checkId}
                checked={checked || requiredByWorkflow}
                disabled={
                  disabled || requiredByWorkflow || (!checked && (unavailable || maximumReached))
                }
                onChange={(event) => toggle(check.checkId, event.target.checked)}
              />
              <span>
                <strong>{check.label}</strong>
                <small>
                  {requiredByWorkflow
                    ? `${check.kind} check · required by the selected workflow gate`
                    : check.availability === 'configured'
                      ? `${check.kind} check · optional extra set up in Settings`
                      : check.availability === 'disabled'
                        ? 'Turned off in Settings.'
                        : 'Not set up in Settings.'}
                </small>
              </span>
            </label>
          );
        })}
        {checks.length === 0 && (
          <p>No checks are set up for this project yet. Add one in Settings → Checks.</p>
        )}
      </div>
      <div className="git-delivery-requirement-actions">
        <small id={helpId} role="status">
          {configuredCount === 0
            ? 'Set up at least one check in Settings first.'
            : selectedWorkflowExecutionId === null
              ? "Choose a workflow run whose review gates passed. Refresh if it's missing."
              : !valid
                ? `Pick up to ${String(GIT_DELIVERY_READINESS_MAX_REQUIRED_CHECKS)} configured checks.`
                : prepared
                  ? 'This workflow run and these checks are locked to the changes you reviewed.'
                  : 'Workflow checks are locked. Add optional ones before saving — later changes reset earlier results and approvals.'}
        </small>
        <button
          className="button"
          type="button"
          disabled={disabled || !valid || prepared}
          aria-busy={busy || undefined}
          onClick={onPrepare}
        >
          {busy ? (
            <LoaderCircle className="spin" size={12} aria-hidden="true" />
          ) : prepared ? (
            <BadgeCheck size={12} aria-hidden="true" />
          ) : (
            <ShieldCheck size={12} aria-hidden="true" />
          )}
          {busy
            ? 'Saving requirements…'
            : prepared
              ? 'Requirements saved'
              : 'Save delivery requirements'}
        </button>
      </div>
    </fieldset>
  );
}

function workflowExecutionLabel(
  execution: GitDeliveryReadinessGetView['compatibleWorkflowExecutions'][number],
): string {
  return `Canvas ${execution.canvasId} · revision ${String(execution.executionRevision)} · ${new Date(execution.endedAt).toLocaleString()}`;
}

function RequiredCheckRow({
  check,
  disabled,
  running,
  onRun,
}: {
  readonly check: RequiredCheck;
  readonly disabled: boolean;
  readonly running: boolean;
  readonly onRun: () => void;
}) {
  const presentation = CHECK_PRESENTATION[check.state];
  const active = check.state === 'queued' || check.state === 'running' || running;
  const runLabel = check.state === 'missing' ? `Run ${check.label}` : `Re-run ${check.label}`;

  return (
    <li className="git-delivery-check" data-state={check.state}>
      <span className="git-delivery-check-icon">{presentation.icon}</span>
      <span className="git-delivery-check-copy">
        <strong>{check.label}</strong>
        <span className="git-delivery-check-state">{presentation.label}</span>
        <small>{presentation.description}</small>
        <CheckTiming check={check} />
      </span>
      <span className="git-delivery-check-actions">
        <button
          className="button ghost"
          type="button"
          disabled={disabled || active}
          aria-label={runLabel}
          aria-busy={active || undefined}
          onClick={onRun}
        >
          {active ? (
            <LoaderCircle className="spin" size={12} aria-hidden="true" />
          ) : check.state === 'missing' ? (
            <Play size={12} aria-hidden="true" />
          ) : (
            <RefreshCw size={12} aria-hidden="true" />
          )}
          {active ? presentation.label : check.state === 'missing' ? 'Run' : 'Re-run'}
        </button>
      </span>
    </li>
  );
}

function CheckTiming({ check }: { readonly check: RequiredCheck }) {
  const timestamp = check.endedAt ?? check.startedAt;
  if (timestamp === null) return null;
  return (
    <small>
      {check.endedAt === null ? 'Started ' : 'Finished '}
      <time dateTime={timestamp}>{formatTimestamp(timestamp)}</time>
    </small>
  );
}

type HumanApproval = GitDeliveryReadinessView['approvals'][number];

function QualityApprovalMessage({
  id,
  readiness,
  requirementsPrepared,
  allRequiredChecksPassed,
  currentApproval,
  previousApproval,
}: {
  readonly id: string;
  readonly readiness: GitDeliveryReadinessView | null;
  readonly requirementsPrepared: boolean;
  readonly allRequiredChecksPassed: boolean;
  readonly currentApproval: HumanApproval | null;
  readonly previousApproval: HumanApproval | null;
}) {
  if (readiness === null) {
    return (
      <p id={id} className="git-delivery-quality-message" role="status">
        <CircleDashed size={12} aria-hidden="true" />
        Save at least one required check first — approval is tied to exactly these changes.
      </p>
    );
  }
  if (!requirementsPrepared) {
    return (
      <p id={id} className="git-delivery-quality-message stale" role="alert">
        <TriangleAlert size={12} aria-hidden="true" />
        The check selection changed. Save it again — earlier results won't be reused.
      </p>
    );
  }
  const state = readiness.evaluation.humanApprovalState;
  if (state === 'approved') {
    return (
      <p id={id} className="git-delivery-quality-message approved" role="status">
        <BadgeCheck size={12} aria-hidden="true" />
        {currentApproval === null
          ? 'Quality is approved for exactly these changes.'
          : `${currentApproval.actorLabel} approved these exact changes ${formatTimestamp(currentApproval.approvedAt)}.`}
      </p>
    );
  }
  if (state === 'stale') {
    const checksFirst = allRequiredChecksPassed ? '' : ' All required checks must pass first.';
    const sameSourceEvidenceChanged =
      previousApproval !== null &&
      gitDeliverySourceFingerprintsEqual(
        previousApproval.sourceFingerprint,
        readiness.sourceFingerprint,
      );
    return (
      <p id={id} className="git-delivery-quality-message stale" role="alert">
        <TriangleAlert size={12} aria-hidden="true" />
        {previousApproval === null
          ? `An earlier approval no longer matches these changes. Review and approve again.${checksFirst}`
          : sameSourceEvidenceChanged
            ? `${previousApproval.actorLabel} approved these changes, but the check results changed afterward. Review and approve again.${checksFirst}`
            : previousApproval.sourceFingerprint.sourceHead !==
                readiness.sourceFingerprint.sourceHead
              ? `${previousApproval.actorLabel} approved version ${shortOid(previousApproval.sourceFingerprint.sourceHead)}, but the current version is ${shortOid(readiness.sourceFingerprint.sourceHead)}. Review and approve again.${checksFirst}`
              : `${previousApproval.actorLabel} approved an earlier version, but the code, workspace, run, or check setup changed since then. Review and approve again.${checksFirst}`}
      </p>
    );
  }
  if (!allRequiredChecksPassed) {
    return (
      <p id={id} className="git-delivery-quality-message" role="status">
        <Clock3 size={12} aria-hidden="true" />
        Every required check must pass for these exact changes before quality can be approved.
      </p>
    );
  }
  return (
    <p id={id} className="git-delivery-quality-message" role="status">
      <CircleDashed size={12} aria-hidden="true" />
      No one has approved these exact changes yet.
    </p>
  );
}

function latestHumanApproval(
  readiness: GitDeliveryReadinessView,
  current: boolean,
): HumanApproval | null {
  const matches = readiness.approvals.filter((approval) => {
    if (approval.authority !== 'human') return false;
    const exact =
      approval.evidenceFingerprint === readiness.evidenceFingerprint &&
      gitDeliverySourceFingerprintsEqual(approval.sourceFingerprint, readiness.sourceFingerprint);
    return current ? exact : !exact;
  });
  return matches.reduce<HumanApproval | null>(
    (latest, approval) =>
      latest === null || approval.approvedAt > latest.approvedAt ? approval : latest,
    null,
  );
}

function shortOid(value: string): string {
  return value.slice(0, 12);
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'at an unknown time';
}

function friendlyBlockerCode(value: string): string {
  const words = value.replaceAll('_', ' ').replaceAll('-', ' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function sameCheckIds(left: readonly CheckId[], right: readonly CheckId[]): boolean {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return new Set(left).size === left.length && left.every((checkId) => rightIds.has(checkId));
}
