import { useCallback, useMemo, type JSX } from 'react';
import {
  GitBranch,
  GitPullRequest,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  UploadCloud,
} from 'lucide-react';

import { GITHUB_PULL_REQUEST_BODY_MAX_CHARACTERS } from '../../../../../shared/git/remote/index.js';
import type { NodeFaceProps } from '../canvas/faces/node-face-registry.js';
import { useCanvasNodeInteractions } from '../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../runs/agent-session/AgentSessionContext.js';
import { gitPrConfiguration, gitPrNodeDataPatch } from './configuration.js';
import { GitPrPlanDialog } from './GitPrPlanDialog.js';
import type { GitPrNodeController } from './types.js';
import { useGitPrNodeController } from './useGitPrNodeController.js';

/**
 * Git delivery face: operational strip with the run target, compact
 * branch/remote settings, ahead/behind + commit/file chips, CI/readiness
 * status, and the created pull-request link. The push and pull-request plan
 * confirmations — modal, focus-trapped flows — are now triggered here and
 * rendered as a focus-trapped dialog (GitPrPlanDialog); the sidebar inspector
 * is no longer the only place to publish.
 */
export function GitPrNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const readOnly = session.graphReadOnly || data.locked || interactions.readOnly;
  const configuration = useMemo(
    () => gitPrConfiguration(data, session.settings.gitRemote),
    [data, session.settings.gitRemote],
  );
  const nodeLabels = useMemo(
    () => session.nodeRoster.map((entry) => ({ id: entry.id, data: { title: entry.title } })),
    [session.nodeRoster],
  );
  const onPullRequestCreated = useCallback(
    (pullRequestUrl: string) => {
      session.recordHistory();
      session.updateNodeData(id, gitPrNodeDataPatch({ pullRequestUrl }));
    },
    [id, session],
  );
  const controller = useGitPrNodeController({
    projectId: session.project.id,
    configuration,
    nodes: nodeLabels,
    agents: session.runnableAgents,
    onError: (message) => session.reportError(message),
    onPullRequestCreated,
  });
  const inspection =
    controller.inspection !== null &&
    controller.inspection.targetRunId === configuration.targetRunId &&
    controller.inspection.remote === configuration.remote &&
    controller.inspection.destinationBranch === configuration.destinationBranch &&
    controller.inspection.requestedBaseBranch === configuration.baseBranch
      ? controller.inspection
      : null;
  const busy = controller.busy !== null;
  const targetRunId = configuration.targetRunId;
  const selectedRun = controller.agentRuns.find((run) => run.runId === targetRunId);
  const targetUnavailable =
    targetRunId === undefined || selectedRun?.worktreeState === 'cleanup-pending';
  const githubStatus = controller.githubStatus;
  const githubReady =
    githubStatus?.authenticated === true &&
    githubStatus.headMatchesSource === true &&
    githubStatus.fresh === true;
  const pullRequestTitleValid =
    configuration.pullRequestTitle.trim() !== '' &&
    configuration.pullRequestTitle.length <= 512 &&
    !configuration.pullRequestTitle.includes('\0') &&
    isWellFormedUnicode(configuration.pullRequestTitle);
  const pullRequestBodyValid =
    configuration.pullRequestBody.length <= GITHUB_PULL_REQUEST_BODY_MAX_CHARACTERS &&
    !configuration.pullRequestBody.includes('\0') &&
    isWellFormedUnicode(configuration.pullRequestBody);

  const change = (patch: Parameters<typeof gitPrNodeDataPatch>[0]): void => {
    session.recordHistory();
    session.updateNodeData(id, gitPrNodeDataPatch(patch));
  };

  return (
    <section className="node-face git-pr-node-face" aria-label="Publish changes" aria-busy={busy}>
      <div className="node-face-strip nodrag">
        <span className="node-face-strip-label">
          <GitPullRequest size={12} aria-hidden="true" /> Publish
        </span>
        <span
          className={`node-face-status ${controller.inspectionError === null ? '' : 'failed'}`}
          role="status"
        >
          {busy
            ? 'Working…'
            : inspection?.ready === true
              ? 'Ready to publish'
              : 'Check needed'}
        </span>
      </div>
      <div className="node-face-body nowheel nodrag">
        <fieldset className="git-pr-face-config" disabled={readOnly || busy}>
          <label>
            Finished agent run
            <select
              name={`node-${id}-git-pr-face-run`}
              aria-label="Finished agent run"
              value={targetRunId ?? ''}
              onChange={(event) =>
                change(
                  event.target.value === ''
                    ? { targetRunId: undefined }
                    : { targetRunId: event.target.value },
                )
              }
            >
              <option value="">Choose a finished run…</option>
              {targetRunId !== undefined &&
              !controller.agentRuns.some((run) => run.runId === targetRunId) ? (
                <option value={targetRunId}>Saved run · {targetRunId.slice(0, 8)}</option>
              ) : null}
              {controller.agentRuns.map((run) => (
                <option
                  key={run.runId}
                  value={run.runId}
                  disabled={run.worktreeState === 'cleanup-pending'}
                >
                  {run.nodeLabel} · {run.agentLabel} · {run.status}
                </option>
              ))}
            </select>
          </label>
          <div className="task-face-grid">
            <label>
              Remote
              <input
                name={`node-${id}-git-pr-face-remote`}
                aria-label="Remote"
                maxLength={128}
                value={configuration.remote}
                onChange={(event) => change({ remote: event.target.value })}
              />
            </label>
            <label>
              Base branch
              <input
                name={`node-${id}-git-pr-face-base`}
                aria-label="Base branch"
                maxLength={1024}
                value={configuration.baseBranch}
                onChange={(event) => change({ baseBranch: event.target.value })}
              />
            </label>
          </div>
          <label>
            Destination branch
            <input
              name={`node-${id}-git-pr-face-destination`}
              aria-label="Destination branch"
              maxLength={1024}
              value={configuration.destinationBranch}
              onChange={(event) => change({ destinationBranch: event.target.value })}
            />
          </label>
          <label>
            Pull request title
            <input
              name={`node-${id}-git-pr-face-title`}
              aria-label="Pull request title"
              maxLength={512}
              aria-invalid={!pullRequestTitleValid}
              value={configuration.pullRequestTitle}
              onChange={(event) => change({ pullRequestTitle: event.target.value })}
            />
          </label>
          <label>
            Pull request body
            <textarea
              name={`node-${id}-git-pr-face-body`}
              aria-label="Pull request body"
              rows={3}
              maxLength={GITHUB_PULL_REQUEST_BODY_MAX_CHARACTERS}
              aria-invalid={!pullRequestBodyValid}
              value={configuration.pullRequestBody}
              onChange={(event) => change({ pullRequestBody: event.target.value })}
            />
          </label>
          <label className="git-pr-face-checkbox">
            <input
              type="checkbox"
              name={`node-${id}-git-pr-face-draft`}
              aria-label="Create as a draft pull request"
              checked={configuration.pullRequestDraft}
              onChange={(event) => change({ pullRequestDraft: event.target.checked })}
            />
            Draft pull request
          </label>
        </fieldset>

        <div className="node-face-row git-pr-face-actions">
          <button
            type="button"
            aria-label="Check changes"
            disabled={targetRunId === undefined || busy}
            onClick={controller.inspect}
          >
            {controller.busy === 'inspect' ? (
              <LoaderCircle className="spin" size={12} aria-hidden="true" />
            ) : (
              <GitBranch size={12} aria-hidden="true" />
            )}
            Check changes
          </button>
          <button
            type="button"
            aria-label="Check GitHub sign-in and repository"
            disabled={readOnly || targetUnavailable || inspection === null || busy}
            onClick={controller.checkGitHub}
          >
            {controller.busy === 'github-status' ? (
              <LoaderCircle className="spin" size={12} aria-hidden="true" />
            ) : (
              <ShieldCheck size={12} aria-hidden="true" />
            )}
            GitHub
          </button>
          <button
            type="button"
            aria-label="Check CI results"
            disabled={targetUnavailable || inspection === null || !githubReady || busy}
            onClick={controller.checkCi}
          >
            <RefreshCw size={12} aria-hidden="true" /> CI
          </button>
          <button
            type="button"
            aria-label="Open checks and approval"
            disabled={readOnly || targetRunId === undefined || busy}
            onClick={() => {
              if (targetRunId !== undefined) session.openGitPrReadiness(targetRunId);
            }}
          >
            <ShieldCheck size={12} aria-hidden="true" /> Checks &amp; approval
          </button>
        </div>

        <div className="node-face-row git-pr-face-actions git-pr-face-publish">
          <button
            type="button"
            aria-label="Review push"
            disabled={readOnly || targetUnavailable || inspection?.ready !== true || busy}
            onClick={controller.preparePush}
          >
            {controller.busy === 'prepare-push' ? (
              <LoaderCircle className="spin" size={12} aria-hidden="true" />
            ) : (
              <UploadCloud size={12} aria-hidden="true" />
            )}
            Review push
          </button>
          <button
            type="button"
            aria-label="Review pull request"
            disabled={
              readOnly ||
              targetUnavailable ||
              inspection?.ready !== true ||
              !githubReady ||
              !pullRequestTitleValid ||
              !pullRequestBodyValid ||
              busy
            }
            onClick={controller.preparePullRequest}
          >
            {controller.busy === 'prepare-pull-request' ? (
              <LoaderCircle className="spin" size={12} aria-hidden="true" />
            ) : (
              <GitPullRequest size={12} aria-hidden="true" />
            )}
            Review pull request
          </button>
        </div>

        {controller.inspectionError !== null ? (
          <p role="alert" className="git-pr-face-error">
            {controller.inspectionError}
          </p>
        ) : null}

        {inspection !== null ? (
          <>
            <p className="git-pr-face-route">
              {inspection.sourceBranch} → {inspection.remote}/{inspection.requestedBaseBranch}
            </p>
            <div className="node-face-chips">
              <span>
                {inspection.ahead} ahead · {inspection.behind} behind
              </span>
              <span>
                {inspection.commitCount} commit{inspection.commitCount === 1 ? '' : 's'}
              </span>
              <span>
                {inspection.fileCount} files · +{inspection.additions} −{inspection.deletions}
              </span>
              {controller.ciStatus !== null ? (
                <span>
                  CI · {controller.ciStatus.runs.length} run
                  {controller.ciStatus.runs.length === 1 ? '' : 's'}
                </span>
              ) : null}
            </div>
            {inspection.readiness.length > 0 ? (
              <ul className="review-gate-face-reasons" aria-label="Publish blockers">
                {inspection.readiness.slice(0, 3).map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}

        {controller.githubError !== null ? (
          <p role="alert" className="git-pr-face-error">
            {controller.githubError}
          </p>
        ) : githubStatus !== null ? (
          <p className="git-pr-face-github" role="status">
            GitHub · {githubStatusLabel(githubStatus)}
          </p>
        ) : null}

        {controller.actionError !== null ? (
          <p role="alert" className="git-pr-face-error">
            {controller.actionError}
          </p>
        ) : null}

        {controller.notice !== null ? (
          <p className="git-pr-face-notice" role="status">
            {controller.notice}
          </p>
        ) : null}

        {configuration.pullRequestUrl !== undefined ? (
          <p className="git-pr-face-link">
            Pull request · <code>{configuration.pullRequestUrl}</code>
          </p>
        ) : null}
      </div>

      {controller.pendingPlan !== null ? (
        <GitPrPlanDialog
          plan={controller.pendingPlan}
          busy={controller.busy}
          disabled={readOnly}
          onCancel={controller.cancelPlan}
          onConfirm={controller.confirmPlan}
        />
      ) : null}
    </section>
  );
}

function githubStatusLabel(status: NonNullable<GitPrNodeController['githubStatus']>): string {
  if (!status.installed) return 'CLI not installed';
  if (!status.fresh) return 'Check again';
  if (!status.authenticated) return 'Sign-in needed';
  if (!status.headMatchesSource) return 'Push this commit first';
  return 'Signed in · commit on GitHub';
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
