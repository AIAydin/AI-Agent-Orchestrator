export interface ProcessAdmissionService {
  pauseForDataMutation(): void | Promise<void>;
  resumeAfterPrivacyReset(): void;
}

export interface OrdinaryOperationGate {
  run<Output>(operation: () => Output | Promise<Output>): Promise<Output>;
}

export class ProcessActivityPresentError extends Error {
  public readonly code = 'PROCESS_ACTIVITY_PRESENT';

  public constructor(options?: ErrorOptions) {
    super(
      'Stop or cancel every Forgeboard-managed agent run, terminal, preview, check, and workflow before cleaning up a worktree.',
      options,
    );
    this.name = 'ProcessActivityPresentError';
  }
}

export class ProcessAdmissionRestoreError extends AggregateError {
  public readonly code = 'PROCESS_ADMISSION_RESTORE_FAILED';

  public constructor(
    errors: readonly unknown[],
    public readonly operationCompleted: boolean,
  ) {
    super(
      errors,
      operationCompleted
        ? 'The cleanup completed, but Forgeboard could not reopen every process admission boundary. Restart Forgeboard before starting another process.'
        : 'The cleanup failed, and Forgeboard could not reopen every process admission boundary. Restart Forgeboard before starting another process.',
    );
    this.name = 'ProcessAdmissionRestoreError';
  }
}

/** Binds cleanup admission to the same ordinary-operation gate used by data import and deletion. */
export function createProcessQuiescenceAdmission(
  gate: OrdinaryOperationGate,
  services: readonly ProcessAdmissionService[],
): <Output>(operation: () => Promise<Output>) => Promise<Output> {
  return async <Output>(operation: () => Promise<Output>): Promise<Output> =>
    await gate.run(async () => await withProcessQuiescence(services, operation));
}

/**
 * Temporarily closes every user-process admission boundary around a filesystem mutation.
 *
 * Each service's pause operation must fail when it still owns a pending or live process. Pauses
 * are intentionally sequential, and every attempted boundary is resumed because a pause can fail
 * after closing its admission flag. Callers still revalidate their exact target inside `operation`.
 */
export async function withProcessQuiescence<Output>(
  services: readonly ProcessAdmissionService[],
  operation: () => Output | Promise<Output>,
): Promise<Output> {
  const attempted: ProcessAdmissionService[] = [];
  let outcome:
    | { readonly ok: true; readonly value: Output }
    | { readonly ok: false; error: unknown };
  let phase: 'pausing' | 'operation' = 'pausing';
  try {
    for (const service of services) {
      // A pause implementation can fail after closing its admission flag. Resume every attempted
      // service, not only those whose pause promise fulfilled.
      attempted.push(service);
      await service.pauseForDataMutation();
    }
    phase = 'operation';
    outcome = { ok: true, value: await operation() };
  } catch (error) {
    outcome = { ok: false, error };
  }

  const resumeFailures: unknown[] = [];
  for (const service of attempted.reverse()) {
    try {
      service.resumeAfterPrivacyReset();
    } catch (error) {
      resumeFailures.push(error);
    }
  }

  if (!outcome.ok) {
    const primaryFailure =
      phase === 'pausing'
        ? new ProcessActivityPresentError({ cause: outcome.error })
        : outcome.error;
    if (resumeFailures.length === 0) {
      throw primaryFailure;
    }
    throw new ProcessAdmissionRestoreError(
      [primaryFailure, ...resumeFailures],
      operationDefinitelyCompleted(primaryFailure),
    );
  }
  if (resumeFailures.length > 0) {
    throw new ProcessAdmissionRestoreError(resumeFailures, true);
  }
  return outcome.value;
}

function operationDefinitelyCompleted(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'operationCompleted' in error &&
    error.operationCompleted === true
  );
}
