import type { GitDelegateAuthorizer, GitDelegatePlan } from '@forgeboard/git-engine';
import type { MessageBoxOptions } from 'electron';

import { displayLiteral } from '../../../shared/text/display-literal.js';

export interface NativeGitDelegateAuthorizationOptions {
  readonly assertCurrent: () => void;
  readonly show: (options: MessageBoxOptions) => Promise<number>;
}

/** Creates a one-operation, owner-bound native confirmation boundary with prompt coalescing. */
export function createNativeGitDelegateAuthorizer(
  options: NativeGitDelegateAuthorizationOptions,
): GitDelegateAuthorizer {
  const decisions = new Map<string, Promise<boolean>>();
  return async (plan) => {
    options.assertCurrent();
    let decision = decisions.get(plan.fingerprint);
    if (decision === undefined) {
      decision = options.show(delegateConfirmation(plan)).then((response) => response === 1);
      decisions.set(plan.fingerprint, decision);
    }
    const approved = await decision;
    options.assertCurrent();
    return approved
      ? {
          approved: true,
          fingerprint: plan.fingerprint,
          assertCurrent: options.assertCurrent,
        }
      : null;
  };
}

export function delegateConfirmation(plan: GitDelegatePlan): MessageBoxOptions {
  const action = operationLabel(plan.operation);
  const commands = plan.filters.flatMap((filter) =>
    filter.declarations
      .filter(({ phase, command }) => phase !== 'required' && command.trim() !== '')
      .map(
        ({ phase, command, origin }) =>
          `${filter.driver} ${phase}: ${literal(command, 2_048)}\n  Configured in: ${literal(origin, 1_024)}`,
      ),
  );
  const paths = plan.filters.flatMap((filter) =>
    filter.disclosedPaths.map((path) => `${filter.driver}: ${literal(path, 1_024)}`),
  );
  const undisclosed = plan.filters.reduce(
    (count, filter) => count + Math.max(0, filter.pathCount - filter.disclosedPaths.length),
    0,
  );
  return {
    type: 'warning',
    title: `Run repository filter commands for ${action}?`,
    message: `Git wants to run ${String(commands.length)} filter command${commands.length === 1 ? '' : 's'} configured by this repository for ${action}. Allow this?`,
    detail: [
      `Repository: ${literal(plan.repositoryPath, 2_048)}`,
      `Fingerprint of this exact plan (SHA-256): ${plan.fingerprint}`,
      '',
      'Exact commands Git will run:',
      ...commands.map((command) => `• ${command}`),
      '',
      'Files these apply to:',
      ...paths.slice(0, 32).map((path) => `• ${path}`),
      ...(undisclosed > 0
        ? [`• …and ${String(undisclosed)} more file(s), covered by the same fingerprint`]
        : []),
      '',
      'Filter commands are tools configured by the repository. They can read or change local files and may use the network with your computer permissions.',
      'Artemis re-reads the filter setup and affected files before running them; any change cancels this approval.',
    ].join('\n'),
    buttons: ['Cancel', 'Run filter commands'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

function operationLabel(operation: GitDelegatePlan['operation']): string {
  if (operation === 'checkout-smudge') return 'checkout';
  if (operation === 'history-update') return 'history update';
  if (operation === 'stage-clean') return 'staging';
  return 'repository inspection';
}

function literal(value: string, maxLength: number): string {
  const encoded = displayLiteral(value);
  return encoded.length > maxLength ? `${encoded.slice(0, maxLength)}…` : encoded;
}
