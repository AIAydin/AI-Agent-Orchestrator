import {
  CheckCircle2,
  CircleAlert,
  Copy,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  LoaderCircle,
  Lock,
  RefreshCw,
  ShieldCheck,
  UploadCloud,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import {
  GITHUB_PULL_REQUEST_BODY_MAX_CHARACTERS,
  GitRemoteBranchSchema,
  GitRemoteNameSchema,
} from '../../../../../shared/git/remote/index.js';
import { trapModalFocus } from '../../../lib/modal-focus.js';

import type {
  GitPrAgentRunOption,
  GitPrInspectionView,
  GitPrNodeConfiguration,
  GitPrNodeController,
  GitPrPendingPlan,
} from './types.js';
import './GitPrNodeInspector.css';

export interface GitPrNodeInspectorProps {
  readonly projectName: string;
  readonly nodeId: string;
  readonly locked: boolean;
  readonly configurationReadOnly: boolean;
  readonly configuration: GitPrNodeConfiguration;
  readonly controller: GitPrNodeController;
  readonly onRecord: () => void;
  readonly onConfigurationChange: (patch: Partial<GitPrNodeConfiguration>) => void;
  readonly onOpenReadiness: (runId: string) => void;
}

export function GitPrNodeInspector(props: GitPrNodeInspectorProps) {
  const { configuration, controller } = props;
  const effectsDisabled = props.locked || props.configurationReadOnly;
  const selectedRun = controller.agentRuns.find(
    (candidate) => candidate.runId === configuration.targetRunId,
  );
  const savedRunUnavailable = configuration.targetRunId !== undefined && selectedRun === undefined;
  const pinnedRunMissing =
    savedRunUnavailable && controller.agentRunsLoaded && controller.agentRunsError === null;
  const targetUnavailable =
    configuration.targetRunId === undefined || selectedRun?.worktreeState === 'cleanup-pending';
  const remoteValid = GitRemoteNameSchema.safeParse(configuration.remote).success;
  const remoteOptions = controller.availableRemotes;
  const remoteExists =
    remoteOptions === null || remoteOptions.some((remote) => remote === configuration.remote);
  const remoteInputValid = remoteValid && remoteExists;
  const remoteErrorId = `node-${props.nodeId}-git-pr-remote-error`;
  const remoteDiscoveryId = `node-${props.nodeId}-git-pr-remote-discovery`;
  const remoteDescription = [
    remoteValid ? undefined : remoteErrorId,
    remoteOptions === null ? undefined : remoteDiscoveryId,
  ]
    .filter((value): value is string => value !== undefined)
    .join(' ');
  const destinationBranchValid = GitRemoteBranchSchema.safeParse(
    configuration.destinationBranch,
  ).success;
  const baseBranchValid = GitRemoteBranchSchema.safeParse(configuration.baseBranch).success;
  const pullRequestTitleValid =
    configuration.pullRequestTitle.trim() !== '' &&
    configuration.pullRequestTitle.length <= 512 &&
    !configuration.pullRequestTitle.includes('\0') &&
    isWellFormedUnicode(configuration.pullRequestTitle);
  const pullRequestBodyValid =
    configuration.pullRequestBody.length <= GITHUB_PULL_REQUEST_BODY_MAX_CHARACTERS &&
    !configuration.pullRequestBody.includes('\0') &&
    isWellFormedUnicode(configuration.pullRequestBody);
  const inspectionMatches =
    controller.inspection !== null &&
    controller.inspection.targetRunId === configuration.targetRunId &&
    controller.inspection.remote === configuration.remote &&
    controller.inspection.destinationBranch === configuration.destinationBranch &&
    controller.inspection.requestedBaseBranch === configuration.baseBranch;
  const inspection = inspectionMatches ? controller.inspection : null;
  const staleInspection = controller.inspection !== null && !inspectionMatches;
  const busy = controller.busy !== null;

  const changeConfiguration = (patch: Partial<GitPrNodeConfiguration>): void => {
    props.onRecord();
    props.onConfigurationChange(patch);
  };

  return (
    <section className="git-pr-node-inspector" aria-label="Publish changes" aria-busy={busy}>
      <header className="git-pr-header">
        <span>
          <GitPullRequest size={15} aria-hidden="true" />
          <strong>Publish changes</strong>
        </span>
        <span
          className={`status-chip ${inspection?.ready === true ? 'ok' : 'warning'}`}
          role="status"
          aria-live="polite"
        >
          {controller.busy !== null
            ? operationLabel(controller.busy)
            : inspection?.ready === true
              ? 'Ready to publish'
              : 'Check needed'}
        </span>
      </header>

      {effectsDisabled ? (
        <p className="git-pr-state warning" role="status">
          <Lock size={14} aria-hidden="true" />
          {props.configurationReadOnly
            ? 'Your role in this shared project lets you view the saved publish settings, but not change them or publish.'
            : 'Unlock this node before changing settings or publishing.'}
        </p>
      ) : null}

      <fieldset className="git-pr-configuration" disabled={effectsDisabled || busy}>
        <legend>Publish settings</legend>
        <label>
          Finished agent run
          <select
            name={`node-${props.nodeId}-git-pr-run`}
            value={configuration.targetRunId ?? ''}
            onChange={(event) => {
              const targetRunId = event.target.value;
              const run = controller.agentRuns.find((candidate) => candidate.runId === targetRunId);
              changeConfiguration({
                ...(targetRunId === '' ? { targetRunId: undefined } : { targetRunId }),
                ...(run?.branch === null || run?.branch === undefined
                  ? {}
                  : {
                      destinationBranch:
                        configuration.destinationBranch.trim() === ''
                          ? run.branch
                          : configuration.destinationBranch,
                    }),
              });
            }}
          >
            <option value="">Choose a finished run…</option>
            {savedRunUnavailable ? (
              <option value={configuration.targetRunId}>
                {savedRunOptionLabel(configuration.targetRunId, controller)}
              </option>
            ) : null}
            {controller.agentRuns.map((run) => (
              <option
                key={run.runId}
                value={run.runId}
                disabled={run.worktreeState === 'cleanup-pending'}
              >
                {runLabel(run)}
              </option>
            ))}
          </select>
        </label>
        <div className="git-pr-run-actions">
          <button
            type="button"
            disabled={!controller.agentRunsLoaded || busy}
            onClick={controller.refreshAgentRuns}
          >
            <RefreshCw size={13} aria-hidden="true" /> Refresh run list
          </button>
          {!controller.agentRunsLoaded ? <small role="status">Loading run history…</small> : null}
        </div>
        {controller.agentRunsError !== null ? (
          <p className="git-pr-state error" role="alert">
            {controller.agentRunsError}
          </p>
        ) : null}
        {controller.agentRunsLoaded &&
        controller.agentRunsError === null &&
        controller.agentRuns.length === 0 ? (
          <p className="git-pr-state" role="status">
            No finished runs to publish yet. Run an agent to the end first, then choose its run
            above.
          </p>
        ) : null}
        <div className="git-pr-field-grid">
          <label>
            Remote
            <input
              name={`node-${props.nodeId}-git-pr-remote`}
              aria-label="Remote"
              maxLength={128}
              required
              list={`node-${props.nodeId}-git-pr-remote-options`}
              aria-invalid={!remoteInputValid}
              aria-describedby={remoteDescription === '' ? undefined : remoteDescription}
              value={configuration.remote}
              onChange={(event) => changeConfiguration({ remote: event.target.value })}
            />
            <datalist id={`node-${props.nodeId}-git-pr-remote-options`}>
              {(remoteOptions ?? []).map((remote) => (
                <option key={remote} value={remote} />
              ))}
            </datalist>
            {!remoteValid ? (
              <small id={remoteErrorId} className="git-pr-field-error">
                Use letters, numbers, dots, underscores, or hyphens, starting with a letter or
                number.
              </small>
            ) : null}
            {remoteOptions === null ? null : (
              <small
                id={remoteDiscoveryId}
                className={remoteExists ? undefined : 'git-pr-field-error'}
              >
                {remoteOptions.length === 0
                  ? "No remotes were found in this run's project copy. Clone a repository through Forgeboard so there is an online copy to publish to."
                  : remoteExists
                    ? `Found in this run's project copy: ${remoteOptions.join(', ')}.`
                    : `No remote named ${configuration.remote} was found. Choose one of: ${remoteOptions.join(', ')}.`}
              </small>
            )}
          </label>
          <label>
            Destination branch
            <input
              name={`node-${props.nodeId}-git-pr-destination`}
              aria-label="Destination branch"
              maxLength={1024}
              required
              aria-invalid={!destinationBranchValid}
              aria-describedby={
                destinationBranchValid ? undefined : `node-${props.nodeId}-git-pr-destination-error`
              }
              value={configuration.destinationBranch}
              placeholder={selectedRun?.branch ?? 'agent branch'}
              onChange={(event) => changeConfiguration({ destinationBranch: event.target.value })}
            />
            {!destinationBranchValid ? (
              <small
                id={`node-${props.nodeId}-git-pr-destination-error`}
                className="git-pr-field-error"
              >
                Enter the branch that should receive these changes.
              </small>
            ) : null}
          </label>
          <label>
            Base branch
            <input
              name={`node-${props.nodeId}-git-pr-base`}
              aria-label="Base branch"
              maxLength={1024}
              required
              aria-invalid={!baseBranchValid}
              aria-describedby={
                baseBranchValid ? undefined : `node-${props.nodeId}-git-pr-base-error`
              }
              value={configuration.baseBranch}
              placeholder="main"
              onChange={(event) => changeConfiguration({ baseBranch: event.target.value })}
            />
            {!baseBranchValid ? (
              <small id={`node-${props.nodeId}-git-pr-base-error`} className="git-pr-field-error">
                Enter the branch the pull request should merge into, for example main.
              </small>
            ) : null}
          </label>
        </div>
        <label>
          Pull request title
          <input
            name={`node-${props.nodeId}-git-pr-title`}
            aria-label="Pull request title"
            maxLength={512}
            required
            aria-invalid={!pullRequestTitleValid}
            aria-describedby={
              pullRequestTitleValid ? undefined : `node-${props.nodeId}-git-pr-title-error`
            }
            value={configuration.pullRequestTitle}
            onChange={(event) => changeConfiguration({ pullRequestTitle: event.target.value })}
          />
          {!pullRequestTitleValid ? (
            <small id={`node-${props.nodeId}-git-pr-title-error`} className="git-pr-field-error">
              Enter a title for the pull request.
            </small>
          ) : null}
        </label>
        <label>
          Pull request body
          <textarea
            name={`node-${props.nodeId}-git-pr-body`}
            aria-label="Pull request body"
            rows={5}
            maxLength={GITHUB_PULL_REQUEST_BODY_MAX_CHARACTERS}
            aria-invalid={!pullRequestBodyValid}
            aria-describedby={`node-${props.nodeId}-git-pr-body-count${pullRequestBodyValid ? '' : ` node-${props.nodeId}-git-pr-body-error`}`}
            value={configuration.pullRequestBody}
            onChange={(event) => changeConfiguration({ pullRequestBody: event.target.value })}
          />
          <small id={`node-${props.nodeId}-git-pr-body-count`}>
            {configuration.pullRequestBody.length.toLocaleString()} /{' '}
            {GITHUB_PULL_REQUEST_BODY_MAX_CHARACTERS.toLocaleString()} characters
          </small>
          {!pullRequestBodyValid ? (
            <small id={`node-${props.nodeId}-git-pr-body-error`} className="git-pr-field-error">
              Remove any unusual special characters, or shorten the text.
            </small>
          ) : null}
        </label>
        <label className="git-pr-checkbox">
          <input
            type="checkbox"
            name={`node-${props.nodeId}-git-pr-draft`}
            checked={configuration.pullRequestDraft}
            onChange={(event) => changeConfiguration({ pullRequestDraft: event.target.checked })}
          />
          Create as a draft pull request
        </label>
      </fieldset>

      <div className="git-pr-inspect-actions">
        <button
          type="button"
          className="button primary"
          disabled={targetUnavailable || busy}
          onClick={controller.inspect}
        >
          {controller.busy === 'inspect' ? (
            <LoaderCircle className="spin" size={14} aria-hidden="true" />
          ) : (
            <GitBranch size={14} aria-hidden="true" />
          )}
          {inspection === null ? 'Check changes' : 'Recheck changes'}
        </button>
      </div>

      {pinnedRunMissing ? (
        <p className="git-pr-state warning" role="status">
          This saved run is not in the recent list. Forgeboard will still verify it when you check
          it.
        </p>
      ) : null}
      {staleInspection ? (
        <p className="git-pr-state warning" role="status">
          Settings changed after the last check. Check again before publishing.
        </p>
      ) : null}
      {controller.inspectionError !== null ? (
        <p className="git-pr-state error" role="alert">
          <CircleAlert size={14} aria-hidden="true" /> {controller.inspectionError}
        </p>
      ) : null}
      {inspection !== null ? <ExactGitState inspection={inspection} /> : null}

      <section className="git-pr-actions" aria-label="Publish actions">
        <header>
          <strong>Publish actions</strong>
          <small>Nothing runs automatically · force push is never used</small>
        </header>
        <div>
          <button
            type="button"
            disabled={effectsDisabled || configuration.targetRunId === undefined || busy}
            onClick={() => {
              if (configuration.targetRunId !== undefined) {
                props.onOpenReadiness(configuration.targetRunId);
              }
            }}
          >
            <ShieldCheck size={14} aria-hidden="true" /> Open checks and approval
          </button>
          <button
            type="button"
            disabled={effectsDisabled || targetUnavailable || inspection?.ready !== true || busy}
            onClick={controller.preparePush}
          >
            <UploadCloud size={14} aria-hidden="true" /> Review push
          </button>
          <button
            type="button"
            disabled={effectsDisabled || targetUnavailable || inspection === null || busy}
            onClick={controller.checkGitHub}
          >
            <ShieldCheck size={14} aria-hidden="true" /> Check GitHub sign-in and repository
          </button>
          <button
            type="button"
            disabled={
              effectsDisabled ||
              targetUnavailable ||
              inspection?.ready !== true ||
              controller.githubStatus?.authenticated !== true ||
              controller.githubStatus.headMatchesSource !== true ||
              controller.githubStatus.fresh !== true ||
              !pullRequestTitleValid ||
              !pullRequestBodyValid ||
              busy
            }
            onClick={controller.preparePullRequest}
          >
            <GitPullRequest size={14} aria-hidden="true" /> Review pull request
          </button>
          <button
            type="button"
            disabled={
              effectsDisabled ||
              targetUnavailable ||
              inspection === null ||
              controller.githubStatus?.authenticated !== true ||
              controller.githubStatus.headMatchesSource !== true ||
              controller.githubStatus.fresh !== true ||
              busy
            }
            onClick={controller.checkCi}
          >
            <RefreshCw size={14} aria-hidden="true" /> Check CI results for this commit
          </button>
        </div>
        <p>
          If publishing is blocked, open checks and approval to run the required checks and record a
          person&apos;s approval in the Git review. Reviewing a push or pull request here changes
          nothing online. Continue only after checking the branch, latest commit, commits, files,
          destination, and expiry time — the final confirmation defaults to Cancel, and Forgeboard
          checks the whole plan again before sending.
        </p>
      </section>

      <GitHubStatus controller={controller} />
      <CiStatus controller={controller} inspection={inspection} />
      <PullRequestLink
        {...(configuration.pullRequestUrl === undefined
          ? {}
          : { url: configuration.pullRequestUrl })}
      />

      {controller.actionError !== null ? (
        <p className="git-pr-state error" role="alert">
          <CircleAlert size={14} aria-hidden="true" /> {controller.actionError}
        </p>
      ) : null}

      {controller.notice !== null ? (
        <p className="git-pr-state success" role="status">
          <CheckCircle2 size={14} aria-hidden="true" /> {controller.notice}
        </p>
      ) : null}
      {controller.pendingPlan !== null ? (
        <PlanDialog
          plan={controller.pendingPlan}
          busy={controller.busy}
          effectsDisabled={effectsDisabled}
          onCancel={controller.cancelPlan}
          onConfirm={controller.confirmPlan}
        />
      ) : null}
    </section>
  );
}

function ExactGitState({ inspection }: { readonly inspection: GitPrInspectionView }) {
  return (
    <section className="git-pr-exact-state" aria-label="Check results">
      <header>
        <span>
          <GitCommitHorizontal size={14} aria-hidden="true" />
          <strong>Check results</strong>
        </span>
        <span className={`status-chip ${inspection.ready ? 'ok' : 'warning'}`}>
          {inspection.ready ? 'Ready to publish' : 'Blocked'}
        </span>
      </header>
      <dl>
        <Fact label="Branch with changes" value={inspection.sourceBranch} />
        <Fact label="Latest commit" value={inspection.sourceOid} code />
        <Fact label="Remote" value={inspection.remote} />
        <Fact label="Remote address" value={inspection.remoteDisclosure} code />
        <Fact label="Publish to branch" value={inspection.destinationBranch} />
        <Fact label="Pull request merges into" value={inspection.requestedBaseBranch} />
        {inspection.requestedBaseOid === null ? null : (
          <Fact label="Pull request base commit" value={inspection.requestedBaseOid} code />
        )}
        <Fact label="Run started from branch" value={inspection.runBaseRef} />
        <Fact label="Run started from commit" value={inspection.runBaseOid} code />
        <Fact label="Base branch's latest commit" value={inspection.divergenceBaseOid} code />
        <Fact
          label="Compared with base branch now"
          value={`${inspection.ahead} ahead · ${inspection.behind} behind`}
        />
        <Fact
          label="Changes"
          value={`${inspection.fileCount} files · +${inspection.additions} −${inspection.deletions}`}
        />
      </dl>
      <ExactChangesEvidence inspection={inspection} />
      <div className="git-pr-readiness">
        <strong>Before publishing</strong>
        {inspection.readiness.length === 0 ? (
          <span>
            {inspection.ready
              ? 'All required checks and approvals have passed. A few last safety checks run when you prepare and confirm a push.'
              : 'Not ready to publish.'}
          </span>
        ) : (
          <ul>
            {inspection.readiness.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
      </div>
      <small>
        Checked <time dateTime={inspection.inspectedAt}>{inspection.inspectedAt}</time>. This is a
        snapshot; every confirmation checks the latest commit and results again. Preparing a push
        also checks the project&apos;s hooks, transfer settings, complete history, and large-file
        storage (LFS) history.
      </small>
    </section>
  );
}

function ExactChangesEvidence({ inspection }: { readonly inspection: GitPrInspectionView }) {
  return (
    <>
      <div className="git-pr-evidence-list">
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
      <div className="git-pr-evidence-list">
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

function GitHubStatus({ controller }: { readonly controller: GitPrNodeController }) {
  if (controller.githubError !== null) {
    return (
      <p className="git-pr-state error" role="alert">
        <CircleAlert size={14} aria-hidden="true" /> {controller.githubError}
      </p>
    );
  }
  const status = controller.githubStatus;
  if (status === null) return null;
  return (
    <section className="git-pr-github-status" aria-label="GitHub sign-in and repository status">
      <header>
        <strong>GitHub CLI</strong>
        <span className={`status-chip ${status.authenticated && status.fresh ? 'ok' : 'warning'}`}>
          {!status.installed
            ? 'Not installed'
            : !status.fresh
              ? 'Out of date'
              : status.authenticated
                ? 'Signed in'
                : 'Sign-in needed'}
        </span>
      </header>
      <dl>
        <Fact
          label="Command-line tool"
          value={
            status.installed
              ? `gh${status.version === null ? '' : ` · ${status.version}`}`
              : 'gh not installed'
          }
          code
        />
        <Fact label="Host" value={status.hostname} />
        <Fact label="Repository" value={status.ownerRepository ?? 'Unavailable'} />
        <Fact label="Default branch" value={status.defaultBranch ?? 'Unavailable'} />
      </dl>
      <small>
        Checked only when you ask: <time dateTime={status.checkedAt}>{status.checkedAt}</time>.
        Forgeboard never stores GitHub passwords or tokens.
      </small>
      {!status.installed ? (
        <p className="git-pr-state warning" role="status">
          Push still works without it. Install the GitHub CLI only if you want the repository, pull
          request, and CI actions here.
        </p>
      ) : !status.authenticated ? (
        <p className="git-pr-state warning" role="status">
          Sign in with the GitHub CLI, then check again. Forgeboard never asks for or stores your
          token.
        </p>
      ) : !status.fresh ? (
        <p className="git-pr-state warning" role="status">
          This GitHub check is more than five minutes old. Check again before creating a pull
          request or reading CI results.
        </p>
      ) : !status.headMatchesSource ? (
        <p className="git-pr-state warning" role="status">
          GitHub doesn&apos;t have this commit on the destination branch yet. Push the reviewed
          branch, then check again before creating a pull request or relying on CI results.
        </p>
      ) : null}
    </section>
  );
}

function CiStatus({
  controller,
  inspection,
}: {
  readonly controller: GitPrNodeController;
  readonly inspection: GitPrInspectionView | null;
}) {
  if (controller.ciError !== null) {
    return (
      <p className="git-pr-state error" role="alert">
        <CircleAlert size={14} aria-hidden="true" /> {controller.ciError}
      </p>
    );
  }
  const status = controller.ciStatus;
  if (status === null) return null;
  const exact = inspection !== null && status.sourceOid === inspection.sourceOid;
  return (
    <section className="git-pr-ci-status" aria-label="CI results for this commit">
      <header>
        <strong>CI results (automated checks)</strong>
        <span className={`status-chip ${exact ? 'ok' : 'warning'}`}>
          {exact
            ? `${String(status.runs.length)} ${status.runs.length === 1 ? 'run' : 'runs'}`
            : 'Out of date'}
        </span>
      </header>
      <code>{status.sourceOid}</code>
      {!exact ? (
        <p className="git-pr-state warning" role="status">
          These results are for an earlier commit. Check CI again before relying on them.
        </p>
      ) : status.runs.length === 0 ? (
        <p>No CI runs were found for this commit.</p>
      ) : (
        <ul>
          {status.runs.map((run) => {
            const url = safeHttpUrl(run.url);
            return (
              <li key={run.databaseId}>
                <span>
                  <strong>{run.workflowName}</strong>
                  <small>
                    {run.name} · {run.status} · {run.conclusion ?? 'no result yet'}
                  </small>
                </span>
                {url === null ? (
                  <code>{run.headSha}</code>
                ) : (
                  <CopyUrl url={url} label="Copy run URL" />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function PullRequestLink({ url }: { readonly url?: string }) {
  if (url === undefined) return null;
  const safeUrl = safeHttpUrl(url);
  return (
    <section className="git-pr-result-link" aria-label="Created pull request">
      <strong>Last created pull request</strong>
      {safeUrl === null ? (
        <p className="git-pr-state error" role="alert">
          The saved pull request link isn&apos;t valid, so it can&apos;t be opened.
        </p>
      ) : (
        <>
          <CopyUrl url={safeUrl} label="Copy pull request URL" />
          <small>
            Saved when the pull request was created. The current settings or the branch&apos;s
            latest commit may have changed since.
          </small>
        </>
      )}
    </section>
  );
}

function PlanDialog({
  plan,
  busy,
  effectsDisabled,
  onCancel,
  onConfirm,
}: {
  readonly plan: GitPrPendingPlan;
  readonly busy: GitPrNodeController['busy'];
  readonly effectsDisabled: boolean;
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
  const titleId = `git-pr-plan-title-${plan.planId}`;
  const descriptionId = `git-pr-plan-description-${plan.planId}`;

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
    <div className="modal-backdrop git-pr-plan-backdrop" role="presentation">
      <section
        ref={dialog}
        className="git-pr-plan-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={confirming}
        tabIndex={-1}
      >
        <header>
          <div>
            {pullRequest ? (
              <GitPullRequest size={18} aria-hidden="true" />
            ) : (
              <UploadCloud size={18} aria-hidden="true" />
            )}
            <div>
              <span className="eyebrow">{pullRequest ? 'Pull request plan' : 'Push plan'}</span>
              <h2 id={titleId}>{pullRequest ? 'Review the pull request' : 'Review the push'}</h2>
            </div>
          </div>
        </header>
        <p id={descriptionId}>
          Nothing has changed online yet. Check every field before continuing to the final
          confirmation, which defaults to Cancel.
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
          {pullRequest ? <Fact label="Repository" value={plan.ownerRepository} /> : null}
          {pullRequest ? <Fact label="Title" value={plan.title} /> : null}
          {pullRequest ? (
            <Fact label="Mode" value={plan.draft ? 'Draft' : 'Ready for review'} />
          ) : null}
        </dl>
        <section className="git-pr-plan-evidence" aria-label="Commits and changed files">
          <ExactChangesEvidence inspection={plan.inspection} />
        </section>
        {pullRequest ? (
          <section className="git-pr-plan-body" aria-label="Pull request body">
            <strong>Description</strong>
            <pre>{plan.body === '' ? '(no description)' : plan.body}</pre>
          </section>
        ) : null}
        <p className="git-pr-no-force">
          <ShieldCheck size={14} aria-hidden="true" /> Force push is never offered. The latest
          commit and the approval expiry are checked again right before anything is sent.
          {pullRequest
            ? ' A GitHub pull request follows its branch, so commits pushed later can change what it contains.'
            : ''}
        </p>
        <footer>
          <button ref={cancelButton} type="button" disabled={confirming} onClick={onCancel}>
            Go back
          </button>
          <button
            type="button"
            className="button primary"
            disabled={effectsDisabled || confirming}
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

function CopyUrl({ url, label }: { readonly url: string; readonly label: string }) {
  const [notice, setNotice] = useState<string | null>(null);
  const copy = async (): Promise<void> => {
    try {
      if (navigator.clipboard === undefined) {
        setNotice("Clipboard access isn't available. Select and copy the link yourself.");
        return;
      }
      await navigator.clipboard.writeText(url);
      setNotice('Link copied to the clipboard.');
    } catch {
      setNotice("The link couldn't be copied. Select and copy it yourself.");
    }
  };
  return (
    <span className="git-pr-copy-url">
      <code>{url}</code>
      <button type="button" onClick={() => void copy()}>
        {label} <Copy size={12} aria-hidden="true" />
      </button>
      {notice === null ? null : <small role="status">{notice}</small>}
    </span>
  );
}

function runLabel(run: GitPrAgentRunOption): string {
  const worktree =
    run.worktreeState === 'cleanup-pending'
      ? 'cleanup interrupted · unavailable'
      : (run.branch ?? 'no branch');
  return `${run.nodeLabel} · ${run.agentLabel} · ${run.status} · ${worktree}`;
}

function savedRunOptionLabel(runId: string, controller: GitPrNodeController): string {
  if (!controller.agentRunsLoaded) return 'Saved run · loading run history…';
  if (controller.agentRunsError !== null) return 'Saved run · run history unavailable';
  return `Saved run ${runId} · not in recent history`;
}

function operationLabel(operation: NonNullable<GitPrNodeController['busy']>): string {
  switch (operation) {
    case 'inspect':
      return 'Checking changes…';
    case 'prepare-push':
      return 'Preparing the push review…';
    case 'confirm-push':
      return 'Opening the confirmation…';
    case 'github-status':
      return 'Checking GitHub…';
    case 'prepare-pull-request':
      return 'Preparing the pull request review…';
    case 'confirm-pull-request':
      return 'Opening the confirmation…';
    case 'ci-status':
      return 'Checking CI results…';
  }
}

function changedFileLabel(file: {
  readonly oldPath: string | null;
  readonly newPath: string | null;
}) {
  const oldPath = file.oldPath;
  const newPath = file.newPath;
  if (oldPath !== null && newPath !== null && oldPath !== newPath) return `${oldPath} → ${newPath}`;
  return newPath ?? oldPath ?? '(unknown path)';
}

function safeHttpUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      parsed.hostname !== '' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.search === '' &&
      parsed.hash === ''
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}
