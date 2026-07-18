import type { MessageBoxOptions } from 'electron';

import { displayLiteral } from '../../../shared/text/display-literal.js';
import type { PendingGitShippingPlan } from './git-shipping-service.js';

/** Exact, cancel-default native disclosure for a main-owned Git delivery plan. */
export function shippingConfirmation(plan: PendingGitShippingPlan): MessageBoxOptions {
  const strategy =
    plan.strategy === 'fast-forward-only'
      ? 'Move the primary branch forward'
      : 'Copy the reviewed changes one by one';
  const action =
    plan.strategy === 'fast-forward-only'
      ? 'Move primary branch forward'
      : 'Copy changes one by one';
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
      'Forgeboard will refuse to deliver if the check results, the agent branch, the primary branch, its latest commit, or any files changed after your review.',
      'Git records this exact author with the delivery. Moving the branch forward creates no new commit; copying changes one by one records it as who made each new commit.',
      'Nothing is forced, reset, deleted, or pushed, and conflicts are never resolved automatically.',
    ].join('\n'),
    buttons: ['Cancel', action],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

function identitySource(source: PendingGitShippingPlan['identity']['nameSource']): string {
  if (source === 'settings') return 'Forgeboard settings';
  if (source === 'git-config') return "the primary checkout's Git settings";
  return 'an unknown source';
}
