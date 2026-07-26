import { useEffect, useMemo, useState } from 'react';

import type { CommandConfiguration } from '../../../../shared/application/contracts.js';
import type {
  CheckCommandReadiness,
  CommandReadinessPurpose,
  CommandReadinessRequest,
  CommandReadinessResult,
} from '../../../../shared/command-readiness/contracts.js';
import { commandReadinessMatches } from '../../../../shared/command-readiness/contracts.js';

const READINESS_DEBOUNCE_MS = 180;

export interface NamedCommandDraft {
  readonly id: string;
  readonly label: string;
  readonly purpose: CommandReadinessPurpose;
  readonly command: CommandConfiguration;
}

export type CommandReadinessStatus =
  | { readonly phase: 'not-configured' }
  | { readonly phase: 'checking' }
  | { readonly phase: 'ready'; readonly result: CommandReadinessResult }
  | { readonly phase: 'blocked'; readonly result: CommandReadinessResult }
  | { readonly phase: 'unavailable'; readonly message: string };

export interface CommandReadinessView {
  readonly statuses: Readonly<Record<string, CommandReadinessStatus>>;
  readonly blockingIssues: readonly string[];
  readonly checking: boolean;
}

/** Debounces passive main-process checks and invalidates evidence on any literal argv change. */
export function useCommandReadiness(
  commands: readonly NamedCommandDraft[],
  projectId: string | null,
  check: CheckCommandReadiness | undefined,
): CommandReadinessView {
  const signature = JSON.stringify({ projectId, commands });
  const [statuses, setStatuses] = useState<Record<string, CommandReadinessStatus>>(() =>
    initialStatuses(commands),
  );

  useEffect(() => {
    let current = true;
    const configured = commands.filter(commandNeedsValidation);
    setStatuses(
      Object.fromEntries(
        commands.map((entry) => [
          entry.id,
          commandNeedsValidation(entry)
            ? check
              ? ({ phase: 'checking' } satisfies CommandReadinessStatus)
              : ({
                  phase: 'unavailable',
                  message:
                    'Artemis can’t check this command right now. Reopen Artemis before saving it.',
                } satisfies CommandReadinessStatus)
            : ({ phase: 'not-configured' } satisfies CommandReadinessStatus),
        ]),
      ),
    );
    if (configured.length === 0 || !check) return () => undefined;

    const timer = window.setTimeout(() => {
      for (const entry of configured) {
        const request: CommandReadinessRequest = {
          purpose: entry.purpose,
          command: entry.command,
          projectId,
        };
        void check(request).then(
          (result) => {
            if (!current) return;
            if (!commandReadinessMatches(result, request)) {
              setStatuses((existing) => ({
                ...existing,
                [entry.id]: {
                  phase: 'unavailable',
                  message:
                    'This check belonged to an older version of the command. Check the current program and arguments again.',
                },
              }));
              return;
            }
            setStatuses((existing) => ({
              ...existing,
              [entry.id]: result.ready ? { phase: 'ready', result } : { phase: 'blocked', result },
            }));
          },
          (error: unknown) => {
            if (!current) return;
            setStatuses((existing) => ({
              ...existing,
              [entry.id]: {
                phase: 'unavailable',
                message:
                  error instanceof Error && error.message.trim() !== ''
                    ? error.message
                    : 'Artemis could not check this command.',
              },
            }));
          },
        );
      }
    }, READINESS_DEBOUNCE_MS);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
    // The serialized signature deliberately represents the bounded command values used above.
  }, [check, signature]);

  return useMemo(() => {
    const blockingIssues: string[] = [];
    let checking = false;
    for (const entry of commands) {
      const status = statuses[entry.id];
      if (!status || status.phase === 'not-configured' || status.phase === 'ready') continue;
      if (status.phase === 'checking') {
        checking = true;
        blockingIssues.push(`${entry.label} is still being checked. Nothing is being run.`);
      } else if (status.phase === 'blocked') {
        blockingIssues.push(
          `${entry.label}: ${status.result.reason ?? 'This command is not ready.'}`,
        );
      } else {
        blockingIssues.push(`${entry.label}: ${status.message}`);
      }
    }
    return { statuses, blockingIssues, checking };
  }, [commands, statuses]);
}

function initialStatuses(
  commands: readonly NamedCommandDraft[],
): Record<string, CommandReadinessStatus> {
  return Object.fromEntries(
    commands.map((entry) => [
      entry.id,
      commandNeedsValidation(entry) ? { phase: 'checking' } : { phase: 'not-configured' },
    ]),
  );
}

function commandNeedsValidation(entry: NamedCommandDraft): boolean {
  return entry.command.executable.trim() !== '' || entry.command.arguments.length > 0;
}
