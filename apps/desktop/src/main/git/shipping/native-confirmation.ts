import type { MessageBoxOptions } from 'electron';

import { displayLiteral } from '../../../shared/text/display-literal.js';
import type { PendingGitShippingPlan } from './git-shipping-service.js';

/** Exact, cancel-default native disclosure for a main-owned Git delivery plan. */
export function shippingConfirmation(plan: PendingGitShippingPlan): MessageBoxOptions {
  const strategy = strategyLabel(plan.strategy);
  const action = strategyAction(plan.strategy);
  const qualityApproval = plan.readiness.approvals.find(
    (approval) => approval.approvalId === plan.readinessApprovalId,
  );
  return {
    type: 'warning',
    title: 'Deliver reviewed agent commits?',
    message: `Deliver the reviewed agent commits to ${displayLiteral(plan.targetBranch)}?`,
    detail: [
      `Project: ${displayLiteral(plan.projectName)}`,
      `Source: agent branch ${displayLiteral(plan.sourceBranch)} (from run ${plan.target.kind === 'agent-worktree' ? plan.target.runId : 'invalid'})`,
      `Target: primary branch ${displayLiteral(plan.targetBranch)}`,
      `Strategy: ${strategy}`,
      `Git author for this delivery: ${displayLiteral(plan.identity.name)} <${displayLiteral(plan.identity.email)}>`,
      `Author source: name from ${identitySource(plan.identity.nameSource)}; email from ${identitySource(plan.identity.emailSource)}`,
      `Base branch and commit: ${displayLiteral(plan.baseRef)} @ ${plan.baseCommit}`,
      `Commit range: ${plan.baseCommit}..${plan.sourceHead}`,
      `Current primary commit: ${plan.targetHead}`,
      '',
      `Commits (${String(plan.commits.length)}, oldest first):`,
      ...plan.commits.map((commit) => `• ${commit}`),
      '',
      `Affected files (${String(plan.affectedPaths.length)}):`,
      ...plan.affectedPaths.map((path) => `• ${displayLiteral(path)}`),
      '',
      `Required checks (${String(plan.readiness.requiredChecks.length)}):`,
      ...plan.readiness.requiredChecks.map(
        (check) =>
          `• ${displayLiteral(check.label)}: passed${check.endedAt === null ? '' : ` at ${check.endedAt}`}`,
      ),
      `Human quality approval: ${qualityApproval === undefined ? 'not recorded yet' : `${displayLiteral(qualityApproval.actorLabel)} at ${qualityApproval.approvedAt}`}`,
      `Check-results fingerprint (SHA-256): ${plan.readiness.evidenceFingerprint}`,
      '',
      'Artemis will refuse to deliver if the check results, the agent branch, the primary branch, its latest commit, or any files changed after your review.',
      deliveryIdentityEffect(plan),
      'Nothing is forced, reset, deleted, or pushed, and conflicts are never resolved automatically.',
    ].join('\n'),
    buttons: ['Cancel', action],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

function strategyLabel(strategy: PendingGitShippingPlan['strategy']): string {
  if (strategy === 'fast-forward-only') return 'Move the primary branch forward';
  if (strategy === 'merge-commit') return 'Create a merge commit on the primary branch';
  if (strategy === 'squash') return 'Combine the reviewed changes into one primary commit';
  if (strategy === 'rebase')
    return 'Replay the agent commits, then move the primary branch forward';
  return 'Copy the reviewed changes one by one';
}

function strategyAction(strategy: PendingGitShippingPlan['strategy']): string {
  if (strategy === 'fast-forward-only') return 'Move primary branch forward';
  if (strategy === 'merge-commit') return 'Create merge commit';
  if (strategy === 'squash') return 'Create squash commit';
  if (strategy === 'rebase') return 'Rebase and deliver';
  return 'Copy changes one by one';
}

function deliveryIdentityEffect(plan: PendingGitShippingPlan): string {
  if (plan.strategy === 'fast-forward-only') {
    return 'Git records no new commit for this delivery, so the existing agent commit authors remain unchanged.';
  }
  if (plan.strategy === 'merge-commit') {
    return 'Git records this exact author on the new merge commit; the existing agent commit authors remain unchanged.';
  }
  if (plan.strategy === 'squash') {
    return 'Git records this exact author on the one new squashed commit; the agent commits remain unchanged.';
  }
  if (plan.strategy === 'rebase') {
    return 'Git replays the agent commits onto the reviewed primary commit, preserving their authors, then moves the primary branch forward.';
  }
  return 'Git records this exact author on each new commit copied to the primary branch.';
}

function identitySource(source: PendingGitShippingPlan['identity']['nameSource']): string {
  if (source === 'settings') return 'Artemis settings';
  if (source === 'git-config') return "the primary checkout's Git settings";
  return 'an unknown source';
}
