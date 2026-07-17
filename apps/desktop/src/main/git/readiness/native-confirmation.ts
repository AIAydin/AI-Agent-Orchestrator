import type { MessageBoxOptions } from 'electron';

import type { GitDeliveryReadinessView } from '../../../shared/git/readiness/index.js';
import { displayLiteral } from '../../../shared/text/display-literal.js';
import type { ExactCheckDisclosure } from '../../workflow/exact-check/contracts.js';

export function deliveryCheckConfirmation(disclosure: ExactCheckDisclosure): MessageBoxOptions {
  return {
    type: 'warning',
    title: 'Run delivery check',
    message: `Run the exact ${displayLiteral(disclosure.label)} delivery check?`,
    detail: [
      `Executable: ${displayLiteral(disclosure.executable)}`,
      `Arguments: ${JSON.stringify(disclosure.arguments)}`,
      `Working directory: ${displayLiteral(disclosure.cwd)}`,
      `Environment variable names: ${
        disclosure.environmentVariableNames.length === 0
          ? '(none)'
          : disclosure.environmentVariableNames.map(displayLiteral).join(', ')
      }`,
      `Exact launch fingerprint: ${disclosure.fingerprint}`,
      `Authorization expires: ${disclosure.expiresAt}`,
      '',
      'This command can execute untrusted repository code with your operating-system permissions. Its bounded raw output is retained as local evidence and may contain anything the command prints.',
      '',
      'Forgeboard will revalidate this exact executable, argument array, working directory, environment, managed run, worktree, source commit, and clean state immediately before launch.',
    ].join('\n'),
    buttons: ['Cancel', 'Run exact check'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

export function deliveryHumanApprovalConfirmation(
  readiness: GitDeliveryReadinessView,
): MessageBoxOptions {
  return {
    type: 'warning',
    title: 'Approve delivery readiness',
    message: 'Approve this exact source and deterministic check evidence for delivery?',
    detail: [
      `Source HEAD: ${readiness.sourceFingerprint.sourceHead}`,
      `Source tree: ${readiness.sourceFingerprint.sourceTree}`,
      `Managed worktree ID: ${readiness.sourceFingerprint.worktreeId}`,
      `Managed run ID: ${readiness.sourceFingerprint.runId}`,
      `Evidence fingerprint: ${readiness.evidenceFingerprint}`,
      '',
      `Required checks (${String(readiness.requiredChecks.length)}):`,
      ...readiness.requiredChecks.map(
        (check) =>
          `• ${displayLiteral(check.label)}: ${check.state}${
            check.endedAt === null ? '' : ` at ${check.endedAt}`
          }`,
      ),
      '',
      'Approval is durable but applies only to this exact committed source, required-check configuration, and execution evidence. Any rerun or source, command, environment, executable, worktree, or run drift invalidates it.',
    ].join('\n'),
    buttons: ['Cancel', 'Approve readiness'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}
