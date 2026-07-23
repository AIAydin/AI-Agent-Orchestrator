import { GitPullRequest, LoaderCircle, ShieldCheck, UploadCloud } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { trapModalFocus } from '../../../lib/modal-focus.js';

import type { GitPrInspectionView, GitPrNodeController, GitPrPendingPlan } from './types.js';

/**
 * Face-owned push / pull-request confirmation modal. This is a faithful port of
 * the inspector's PlanDialog — same focus trap (trapModalFocus), Escape-to-cancel,
 * Cancel-first footer, and full plan disclosure — so the git-pr node can confirm
 * pushes and pull requests directly on its face. It deliberately shares no code
 * with the inspector so the inspector can be deleted without touching the face.
 */
export function GitPrPlanDialog({
  plan,
  busy,
  disabled,
  onCancel,
  onConfirm,
}: {
  readonly plan: GitPrPendingPlan;
  readonly busy: GitPrNodeController['busy'];
  readonly disabled: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const pullRequest = plan.kind === 'pull-request';
  const confirming = busy === (pullRequest ? 'confirm-pull-request' : 'confirm-push');
  const dialog = useRef<HTMLElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef(onCancel);
  const confirmingRef = useRef(confirming);
  cancelRef.current = onCancel;
  confirmingRef.current = confirming;
  const titleId = `git-pr-face-plan-title-${plan.planId}`;
  const descriptionId = `git-pr-face-plan-description-${plan.planId}`;

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
      if (event.key !== 'Escape' || confirmingRef.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelRef.current();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    if (confirming) dialog.current?.focus();
  }, [confirming]);

  return (
    <div className="modal-backdrop git-pr-face-plan-backdrop nodrag nowheel" role="presentation">
      <section
        ref={dialog}
        className="git-pr-face-plan-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={confirming}
        tabIndex={-1}
      >
        <header>
          {pullRequest ? (
            <GitPullRequest size={18} aria-hidden="true" />
          ) : (
            <UploadCloud size={18} aria-hidden="true" />
          )}
          <div>
            <span className="eyebrow">{pullRequest ? 'Pull request plan' : 'Push plan'}</span>
            <h2 id={titleId}>{pullRequest ? 'Review the pull request' : 'Review the push'}</h2>
          </div>
        </header>
        <p id={descriptionId}>
          Nothing has changed online yet. Check each field — the final confirmation defaults to
          Cancel.
        </p>
        <dl>
          <Fact label="Remote" value={plan.inspection.remote} />
          <Fact label="Remote address" value={plan.inspection.remoteDisclosure} code />
          <Fact label="Branch with changes" value={plan.inspection.sourceBranch} />
          <Fact label="Latest commit" value={plan.inspection.sourceOid} code />
          <Fact label="Destination branch" value={plan.inspection.destinationBranch} />
          <Fact
            label="Run started from"
            value={`${plan.inspection.runBaseRef} @ ${plan.inspection.runBaseOid}`}
            code
          />
          {pullRequest ? (
            <Fact
              label="Merges into"
              value={`${plan.inspection.requestedBaseBranch} @ ${plan.inspection.requestedBaseOid ?? 'unavailable'}`}
              code
            />
          ) : null}
          <Fact label="Commits" value={String(plan.inspection.commitCount)} />
          <Fact label="Files" value={String(plan.inspection.fileCount)} />
          <Fact
            label="Line changes"
            value={`+${String(plan.inspection.additions)} −${String(plan.inspection.deletions)}`}
          />
          <Fact label="Plan ID" value={plan.planId} code />
          <Fact label="Approval expires" value={plan.expiresAt} />
          {plan.kind === 'pull-request' ? (
            <Fact label="Repository" value={plan.ownerRepository} />
          ) : null}
          {plan.kind === 'pull-request' ? <Fact label="Title" value={plan.title} /> : null}
          {plan.kind === 'pull-request' ? (
            <Fact label="Mode" value={plan.draft ? 'Draft' : 'Ready for review'} />
          ) : null}
        </dl>
        <section className="git-pr-face-plan-evidence" aria-label="Commits and changed files">
          <ExactChangesEvidence inspection={plan.inspection} />
        </section>
        {plan.kind === 'pull-request' ? (
          <section className="git-pr-face-plan-body" aria-label="Pull request body">
            <strong>Description</strong>
            <pre>{plan.body === '' ? '(no description)' : plan.body}</pre>
          </section>
        ) : null}
        <p className="git-pr-face-plan-no-force">
          <ShieldCheck size={14} aria-hidden="true" /> Force push is never offered. The latest
          commit and approval expiry are re-checked right before sending.
          {pullRequest
            ? ' A pull request follows its branch — commits pushed later change what it contains.'
            : ''}
        </p>
        <footer>
          <button ref={cancelButton} type="button" disabled={confirming} onClick={onCancel}>
            Go back
          </button>
          <button
            type="button"
            className="git-pr-face-plan-confirm"
            disabled={disabled || confirming}
            onClick={onConfirm}
          >
            {confirming ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : null}
            Continue to final confirmation
          </button>
        </footer>
      </section>
    </div>
  );
}

function ExactChangesEvidence({ inspection }: { readonly inspection: GitPrInspectionView }) {
  return (
    <>
      <div className="git-pr-face-plan-evidence-list">
        <strong>
          Commits ({inspection.commitCount}){inspection.commitsTruncated ? ' · partial list' : ''}
        </strong>
        {inspection.commitCount === 0 ? (
          <span>No commits between the base branch and this run&apos;s latest commit.</span>
        ) : (
          <ol>
            {inspection.commits.map((commit) => (
              <li key={commit}>
                <code>{commit}</code>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="git-pr-face-plan-evidence-list">
        <strong>
          Changed files ({inspection.fileCount}){inspection.filesTruncated ? ' · partial list' : ''}
        </strong>
        {inspection.fileCount === 0 ? (
          <span>No changed files in this comparison.</span>
        ) : (
          <ul>
            {inspection.files.map((file, index) => (
              <li key={`${file.oldPath ?? ''}:${file.newPath ?? ''}:${String(index)}`}>
                <span>{file.status}</span>
                <code>{changedFileLabel(file)}</code>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function Fact({
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

function changedFileLabel(file: {
  readonly oldPath: string | null;
  readonly newPath: string | null;
}): string {
  const oldPath = file.oldPath;
  const newPath = file.newPath;
  if (oldPath !== null && newPath !== null && oldPath !== newPath) return `${oldPath} → ${newPath}`;
  return newPath ?? oldPath ?? '(unknown path)';
}
