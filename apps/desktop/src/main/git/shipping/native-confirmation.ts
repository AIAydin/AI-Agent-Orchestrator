import type { MessageBoxOptions } from 'electron';

import { displayLiteral } from '../../../shared/text/display-literal.js';
import type { PendingGitShippingPlan } from './git-shipping-service.js';

/** Exact, cancel-default native disclosure for a main-owned Git delivery plan. */
export function shippingConfirmation(plan: PendingGitShippingPlan): MessageBoxOptions {
  const strategy =
    plan.strategy === 'fast-forward-only' ? 'Fast-forward-only merge' : 'Ordered cherry-pick';
  const action =
    plan.strategy === 'fast-forward-only' ? 'Fast-forward primary' : 'Cherry-pick commits';
  return {
    type: 'warning',
    title: 'Deliver reviewed agent commits',
    message: `${strategy} into ${displayLiteral(plan.targetBranch)}?`,
    detail: [
      `Project: ${displayLiteral(plan.projectName)}`,
      `Source: managed agent branch ${displayLiteral(plan.sourceBranch)} (run ${plan.target.kind === 'agent-worktree' ? plan.target.runId : 'invalid'})`,
      `Target: primary branch ${displayLiteral(plan.targetBranch)}`,
      `Strategy: ${strategy}`,
      `Git identity: ${displayLiteral(plan.identity.name)} <${displayLiteral(plan.identity.email)}>`,
      `Identity source: name from ${identitySource(plan.identity.nameSource)}; email from ${identitySource(plan.identity.emailSource)}`,
      `Reviewed base: ${displayLiteral(plan.baseRef)} @ ${plan.baseCommit}`,
      `Commit range: ${plan.baseCommit}..${plan.sourceHead}`,
      `Primary HEAD: ${plan.targetHead}`,
      '',
      `Commits (${String(plan.commits.length)}, oldest first):`,
      ...plan.commits.map((commit) => `• ${commit}`),
      '',
      `Affected files (${String(plan.affectedPaths.length)}):`,
      ...plan.affectedPaths.map((path) => `• ${displayLiteral(path)}`),
      '',
      'Forgeboard will refuse delivery if the owned source, primary branch, primary HEAD, or either working tree changed after review.',
      'This exact bound identity is supplied to Git. Fast-forward creates no commit; cherry-pick uses it as the committer identity.',
      'No force, reset, clean, push, or automatic conflict resolution will run.',
    ].join('\n'),
    buttons: ['Cancel', action],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

function identitySource(source: PendingGitShippingPlan['identity']['nameSource']): string {
  if (source === 'settings') return 'Forgeboard Settings';
  if (source === 'git-config') return 'the primary checkout Git configuration';
  return 'an unavailable source';
}
