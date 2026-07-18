import { describe, expect, it, vi } from 'vitest';

import {
  ProcessAdmissionRestoreError,
  ProcessActivityPresentError,
  createProcessQuiescenceAdmission,
  withProcessQuiescence,
  type ProcessAdmissionService,
} from './process-quiescence.js';
import { DataOperationGate } from './data-operation-gate.js';

describe('withProcessQuiescence', () => {
  it('keeps every admission boundary paused until the guarded mutation finishes', async () => {
    const trace: string[] = [];
    const first = service('first', trace);
    const second = service('second', trace);

    const result = await withProcessQuiescence([first, second], () => {
      trace.push('operation');
      return 'cleaned';
    });

    expect(result).toBe('cleaned');
    expect(trace).toEqual([
      'first:pause',
      'second:pause',
      'operation',
      'second:resume',
      'first:resume',
    ]);
  });

  it('reopens every attempted pause when a later service reports live activity', async () => {
    const trace: string[] = [];
    const first = service('first', trace);
    const active = service('active', trace, new Error('Stop the active preview first.'));
    const neverReached = service('later', trace);
    const operation = vi.fn();

    await expect(withProcessQuiescence([first, active, neverReached], operation)).rejects.toThrow(
      ProcessActivityPresentError,
    );
    expect(operation).not.toHaveBeenCalled();
    expect(trace).toEqual(['first:pause', 'active:pause', 'active:resume', 'first:resume']);
  });

  it('reopens every successful pause when target revalidation or mutation fails', async () => {
    const trace: string[] = [];
    const first = service('first', trace);
    const second = service('second', trace);

    await expect(
      withProcessQuiescence([first, second], () => {
        trace.push('operation');
        throw new Error('The cleanup plan is stale.');
      }),
    ).rejects.toThrow('The cleanup plan is stale.');
    expect(trace).toEqual([
      'first:pause',
      'second:pause',
      'operation',
      'second:resume',
      'first:resume',
    ]);
  });

  it('reports restoration failures after a completed mutation', async () => {
    const trace: string[] = [];
    const broken = service('broken', trace, undefined, new Error('resume failed'));

    await expect(withProcessQuiescence([broken], () => 'cleaned')).rejects.toThrow(
      'cleanup finished, but Forgeboard could not restart',
    );
    expect(trace).toEqual(['broken:pause', 'broken:resume']);
  });

  it('retains both operation and restoration failures', async () => {
    const trace: string[] = [];
    const broken = service('broken', trace, undefined, new Error('resume failed'));

    const failure = await withProcessQuiescence([broken], () => {
      throw new Error('cleanup failed');
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProcessAdmissionRestoreError);
    expect((failure as ProcessAdmissionRestoreError).operationCompleted).toBe(false);
    expect((failure as ProcessAdmissionRestoreError).errors).toEqual([
      expect.objectContaining({ message: 'cleanup failed' }),
      expect.objectContaining({ message: 'resume failed' }),
    ]);
  });

  it('preserves completed-mutation evidence when admission restoration also fails', async () => {
    const trace: string[] = [];
    const broken = service('broken', trace, undefined, new Error('resume failed'));
    const completedFailure = Object.assign(new Error('final persistence failed'), {
      operationCompleted: true,
    });

    const failure = await withProcessQuiescence([broken], () => {
      throw completedFailure;
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProcessAdmissionRestoreError);
    expect((failure as ProcessAdmissionRestoreError).operationCompleted).toBe(true);
    expect((failure as ProcessAdmissionRestoreError).message).toContain('cleanup finished');
    expect((failure as ProcessAdmissionRestoreError).errors).toEqual([
      completedFailure,
      expect.objectContaining({ message: 'resume failed' }),
    ]);
  });

  it('keeps services paused for an asynchronous operation and excludes data mutation', async () => {
    const gate = new DataOperationGate();
    const release = deferred<void>();
    const state = { first: false, second: false };
    const admission = createProcessQuiescenceAdmission(gate, [
      statefulService(state, 'first'),
      statefulService(state, 'second'),
    ]);
    let operationStarted = false;
    const cleanup = admission(async () => {
      operationStarted = true;
      expect(state).toEqual({ first: true, second: true });
      await release.promise;
      expect(state).toEqual({ first: true, second: true });
      return 'cleaned';
    });
    await vi.waitFor(() => expect(operationStarted).toBe(true));

    let mutationStarted = false;
    const mutation = gate.beginMutation('delete').then(() => {
      mutationStarted = true;
    });
    await Promise.resolve();
    expect(mutationStarted).toBe(false);
    await expect(gate.run(() => 'late operation')).rejects.toThrow(
      'Another data change is already in progress. Wait for it to finish, then try again.',
    );

    release.resolve();
    await expect(cleanup).resolves.toBe('cleaned');
    await mutation;
    expect(state).toEqual({ first: false, second: false });
    gate.finishMutation();
  });
});

function service(
  name: string,
  trace: string[],
  pauseFailure?: Error,
  resumeFailure?: Error,
): ProcessAdmissionService {
  return {
    pauseForDataMutation: () => {
      trace.push(`${name}:pause`);
      if (pauseFailure !== undefined) throw pauseFailure;
    },
    resumeAfterPrivacyReset: () => {
      trace.push(`${name}:resume`);
      if (resumeFailure !== undefined) throw resumeFailure;
    },
  };
}

function statefulService<State extends Record<Key, boolean>, Key extends keyof State>(
  state: State,
  key: Key,
): ProcessAdmissionService {
  return {
    pauseForDataMutation: () => {
      state[key] = true as State[Key];
    },
    resumeAfterPrivacyReset: () => {
      state[key] = false as State[Key];
    },
  };
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
