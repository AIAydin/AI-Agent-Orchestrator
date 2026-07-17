import { ShieldAlert } from 'lucide-react';
import { useEffect, useRef } from 'react';

import type {
  GitConnectionMutationPlanView,
  GitHubCliSelectionPlanView,
} from '../../../../../shared/git/connections/index.js';
import { trapModalFocus } from '../../../lib/modal-focus.js';
import { remoteTargetLabel } from './RemoteConnections.js';
import type { GitConnectionsPendingPlan } from './types.js';

export function ConnectionPlanDialog({
  plan,
  busy,
  onCancel,
  onConfirm,
}: {
  readonly plan: GitConnectionsPendingPlan;
  readonly busy: boolean;
  readonly onCancel: () => Promise<void>;
  readonly onConfirm: () => Promise<void>;
}) {
  const dialog = useRef<HTMLElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef(onCancel);
  const busyRef = useRef(busy);
  cancelRef.current = onCancel;
  busyRef.current = busy;
  const title =
    plan.kind === 'github-cli-selection' ? 'GitHub CLI configuration' : remotePlanTitle(plan);
  const titleId = `git-connections-plan-title-${plan.planId}`;
  const descriptionId = `git-connections-plan-description-${plan.planId}`;

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelButton.current?.focus();
    const handleKeyDown = (event: KeyboardEvent): void => {
      const openDialogs = [
        ...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'),
      ];
      if (openDialogs.at(-1) !== dialog.current) return;
      trapModalFocus(event, dialog.current);
      if (event.key !== 'Escape' || busyRef.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void cancelRef.current();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    if (busy) dialog.current?.focus();
  }, [busy]);

  return (
    <div className="modal-backdrop git-connections-plan-backdrop" role="presentation">
      <section
        ref={dialog}
        className="git-connections-plan"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy}
        tabIndex={-1}
      >
        <header>
          <ShieldAlert size={19} aria-hidden="true" />
          <div>
            <span>Reviewed local configuration plan</span>
            <h2 id={titleId}>{title}</h2>
          </div>
        </header>
        <p id={descriptionId}>
          Nothing has changed. Review this path-free summary before continuing to the cancel-default
          native system confirmation.
        </p>
        {plan.kind === 'git-remote-mutation' ? (
          <RemotePlanFacts plan={plan} />
        ) : (
          <GitHubCliPlanFacts plan={plan} />
        )}
        <div className="git-connections-plan-safety">
          <strong>Network access: none</strong>
          <span>
            {plan.kind === 'git-remote-mutation'
              ? 'This action changes local Git configuration only. It does not fetch, push, authenticate, or test reachability.'
              : 'This action selects a local executable source only. It does not sign in, contact GitHub, or verify repository access.'}
          </span>
        </div>
        <small>
          Plan expires at <time dateTime={plan.expiresAt}>{formatTime(plan.expiresAt)}</time>.
        </small>
        <footer>
          <button
            ref={cancelButton}
            className="button"
            type="button"
            disabled={busy}
            onClick={() => void onCancel()}
          >
            Go back
          </button>
          <button
            className={`button ${plan.kind === 'git-remote-mutation' && plan.operation === 'remove' ? 'danger' : 'primary'}`}
            type="button"
            disabled={busy}
            onClick={() => void onConfirm()}
          >
            Continue to system confirmation
          </button>
        </footer>
      </section>
    </div>
  );
}

function RemotePlanFacts({ plan }: { readonly plan: GitConnectionMutationPlanView }) {
  return (
    <>
      <dl>
        <PlanFact label="Project" value={plan.projectName} />
        <PlanFact label="Action" value={remoteOperationLabel(plan.operation)} />
        <PlanFact label="Remote" value={plan.remoteName} />
        <PlanFact label="Current target" value={remoteViewLabel(plan.before)} />
        <PlanFact
          label="Proposed target"
          value={plan.after === null ? 'Remove this remote' : remoteTargetLabel(plan.after)}
        />
      </dl>
      {plan.operation === 'remove' ? (
        <section
          className="git-connections-ref-impact"
          aria-label="Remote-tracking references removed"
        >
          <strong>
            Remote-tracking references removed ({String(plan.remoteTrackingRefs.length)})
          </strong>
          {plan.remoteTrackingRefs.length === 0 ? (
            <span>None</span>
          ) : (
            <ul>
              {plan.remoteTrackingRefs.map((ref) => (
                <li key={ref}>
                  <code>{ref}</code>
                </li>
              ))}
            </ul>
          )}
          <small>Local branches, commits, other remotes, and worktree files remain.</small>
        </section>
      ) : null}
    </>
  );
}

function GitHubCliPlanFacts({ plan }: { readonly plan: GitHubCliSelectionPlanView }) {
  return (
    <dl>
      <PlanFact
        label="Source"
        value={plan.source === 'automatic' ? 'Automatic discovery' : 'Custom executable'}
      />
      <PlanFact
        label="Executable file"
        value={plan.candidate?.filename ?? 'Not currently discovered'}
      />
      <PlanFact label="Version" value="Checked only after native approval" />
      <PlanFact
        label="Size"
        value={plan.candidate === null ? 'Unavailable' : formatBytes(plan.candidate.sizeBytes)}
      />
      <PlanFact label="SHA-256" value={plan.candidate?.sha256 ?? 'Unavailable'} code />
    </dl>
  );
}

function PlanFact({
  label,
  value,
  code = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly code?: boolean;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{code ? <code>{value}</code> : value}</dd>
    </div>
  );
}

function remotePlanTitle(plan: GitConnectionMutationPlanView): string {
  if (plan.operation === 'add') return 'Review remote addition';
  if (plan.operation === 'replace') return 'Review remote replacement';
  return 'Review remote removal';
}

function remoteOperationLabel(operation: GitConnectionMutationPlanView['operation']): string {
  if (operation === 'add') return 'Add remote';
  if (operation === 'replace') return 'Replace remote target';
  return 'Remove remote and disclosed tracking references';
}

function remoteViewLabel(remote: GitConnectionMutationPlanView['before']): string {
  if (remote === null) return 'No existing remote';
  if (remote.fetch === null && remote.push === null) return 'Advanced target not shown';
  const fetch = remote.fetch === null ? null : remoteTargetLabel(remote.fetch);
  const push = remote.push === null ? null : remoteTargetLabel(remote.push);
  if (fetch === push) return fetch ?? 'Advanced target not shown';
  return `Fetch: ${fetch ?? 'not shown'} · Push: ${push ?? 'not shown'}`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${String(value)} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MiB`;
}
