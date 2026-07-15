import type { GitDelegateAuthorizer, GitDelegatePlan } from '@forgeboard/git-engine';
import type { MessageBoxOptions } from 'electron';

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
          `${filter.driver} ${phase}: ${literal(command, 2_048)}\n  Config: ${literal(origin, 1_024)}`,
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
    title: `Approve Git filter for ${action}`,
    message: `Run ${String(commands.length)} Git filter command${commands.length === 1 ? '' : 's'} for ${action}?`,
    detail: [
      `Repository: ${literal(plan.repositoryPath, 2_048)}`,
      `Plan fingerprint: ${plan.fingerprint}`,
      '',
      'Exact shell commands Git will run:',
      ...commands.map((command) => `• ${command}`),
      '',
      'Affected paths:',
      ...paths.slice(0, 32).map((path) => `• ${path}`),
      ...(undisclosed > 0
        ? [`• …and ${String(undisclosed)} more path(s), bound by the fingerprint`]
        : []),
      '',
      'Git filter commands are repository tooling. They can read or change local files and may access the network with your user permissions.',
      'Forgeboard will re-read the filter configuration and affected paths before execution. Any change invalidates this approval.',
    ].join('\n'),
    buttons: ['Cancel', 'Run exact Git filter'],
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
  const encoded = JSON.stringify(value);
  return encoded.length > maxLength ? `${encoded.slice(0, maxLength)}…` : encoded;
}
