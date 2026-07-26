import type { MessageBoxOptions } from 'electron';

import type { GitDeliveryReadinessView } from '../../../shared/git/readiness/index.js';
import { displayLiteral } from '../../../shared/text/display-literal.js';
import type { ExactCheckDisclosure } from '../../workflow/exact-check/contracts.js';

export function deliveryCheckConfirmation(disclosure: ExactCheckDisclosure): MessageBoxOptions {
  return {
    type: 'warning',
    title: 'Run delivery check?',
    message: `Run the ${displayLiteral(disclosure.label)} check with this exact command?`,
    detail: [
      `Program: ${displayLiteral(disclosure.executable)}`,
      `Command arguments: ${JSON.stringify(disclosure.arguments)}`,
      `Folder it runs in: ${displayLiteral(disclosure.cwd)}`,
      `Environment variables it receives: ${
        disclosure.environmentVariableNames.length === 0
          ? '(none)'
          : disclosure.environmentVariableNames.map(displayLiteral).join(', ')
      }`,
      `Fingerprint of this exact command (SHA-256): ${disclosure.fingerprint}`,
      `This approval expires: ${disclosure.expiresAt}`,
      '',
      'This command runs repository code with your computer permissions — only run checks you trust. Artemis keeps its output (up to a size limit) as local evidence; the output can contain anything the command prints.',
      '',
      'Artemis checks again right before running that the program, arguments, folder, environment, run, workspace, and source commit are exactly as reviewed and that nothing changed.',
    ].join('\n'),
    buttons: ['Cancel', 'Run check'],
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
    title: 'Approve quality for delivery?',
    message: 'Approve these exact changes and their check results for delivery?',
    detail: [
      `Source commit: ${readiness.sourceFingerprint.sourceHead}`,
      `Content fingerprint (Git tree): ${readiness.sourceFingerprint.sourceTree}`,
      `Agent workspace ID: ${readiness.sourceFingerprint.worktreeId}`,
      `Agent run ID: ${readiness.sourceFingerprint.runId}`,
      `Check-results fingerprint (SHA-256): ${readiness.evidenceFingerprint}`,
      '',
      `Required checks (${String(readiness.requiredChecks.length)}):`,
      ...readiness.requiredChecks.map(
        (check) =>
          `• ${displayLiteral(check.label)}: ${check.state}${
            check.endedAt === null ? '' : ` at ${check.endedAt}`
          }`,
      ),
      '',
      'This approval is saved and applies only to exactly these committed changes, this check setup, and these check results. Re-running a check, or any change to the code, commands, environment, program, workspace, or run, makes it no longer valid.',
    ].join('\n'),
    buttons: ['Cancel', 'Approve quality'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}
