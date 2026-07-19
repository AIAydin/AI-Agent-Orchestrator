import type { AgentSession } from '@forgeboard/agent-adapters';

import type { StoredRunRecord } from '../../storage-schemas.js';

interface PausableRun {
  readonly session: AgentSession;
  record: StoredRunRecord;
}

type SaveRun = (record: StoredRunRecord) => unknown;

/** Removes a claimed pause capability unless main owns both exact process-control primitives. */
export function enforcePauseCapability(
  session: AgentSession,
  mainOwnedRuntime: boolean,
): AgentSession {
  const pauseEnforceable =
    mainOwnedRuntime &&
    session.capabilities.pause &&
    session.pause !== undefined &&
    session.continue !== undefined;
  if (pauseEnforceable || !session.capabilities.pause) return session;
  return {
    pid: session.pid,
    capabilities: { ...session.capabilities, pause: false },
    events: session.events,
    result: session.result,
    writeInput: (data) => session.writeInput(data),
    interrupt: () => session.interrupt(),
    terminate: () => session.terminate(),
  };
}

/** Persists the OS-enforced pause and rolls the process back to running if persistence fails. */
export function pauseActiveRun(run: PausableRun, saveRun: SaveRun, occurredAt: string): void {
  if (!run.session.capabilities.pause || run.session.pause === undefined) {
    throw new Error('This running session cannot safely pause its complete process tree.');
  }
  if (run.record.status === 'paused') return;
  run.session.pause();
  try {
    run.record = { ...run.record, status: 'paused', updatedAt: occurredAt };
    saveRun(run.record);
  } catch (error) {
    try {
      run.session.continue?.();
    } catch {
      // Restart recovery will mark the nonterminal record lost if rollback cannot be enforced.
    }
    run.record = { ...run.record, status: 'running', updatedAt: occurredAt };
    throw error;
  }
}

/** Continues only a durably paused process and rolls it back to paused if persistence fails. */
export function continueActiveRun(run: PausableRun, saveRun: SaveRun, occurredAt: string): void {
  if (!run.session.capabilities.pause || run.session.continue === undefined) {
    throw new Error('This session cannot safely continue a paused process tree.');
  }
  if (run.record.status !== 'paused') {
    throw new Error('Only a paused Agent run can be continued.');
  }
  run.session.continue();
  try {
    run.record = { ...run.record, status: 'running', updatedAt: occurredAt };
    saveRun(run.record);
  } catch (error) {
    try {
      run.session.pause?.();
    } catch {
      // Restart recovery will mark the nonterminal record lost if rollback cannot be enforced.
    }
    run.record = { ...run.record, status: 'paused', updatedAt: occurredAt };
    throw error;
  }
}
