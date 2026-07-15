import { describe, expect, it } from 'vitest';

import { DataOperationGate } from './data-operation-gate.js';

describe('DataOperationGate', () => {
  it('drains admitted work before granting an exclusive data mutation', async () => {
    const gate = new DataOperationGate();
    const operationRelease = deferred<void>();
    const operation = gate.run(async () => await operationRelease.promise);
    let mutationStarted = false;
    const mutation = gate.beginMutation('delete').then(() => {
      mutationStarted = true;
    });

    await Promise.resolve();
    expect(mutationStarted).toBe(false);
    await expect(gate.run(() => 'late operation')).rejects.toThrow(
      'Another local-data operation is in progress.',
    );

    operationRelease.resolve();
    await operation;
    await mutation;
    expect(gate.mutationKind).toBe('delete');

    let completed = false;
    void gate.mutationCompletion.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    gate.finishMutation();
    await gate.mutationCompletion;
    expect(completed).toBe(true);
  });

  it('closes external admissions before shutdown while allowing the internal quit mutation', async () => {
    const gate = new DataOperationGate();
    const operationRelease = deferred<void>();
    const operation = gate.run(async () => await operationRelease.promise);
    gate.beginShutdown();

    await expect(gate.run(() => undefined)).rejects.toThrow('Forgeboard is shutting down.');
    await expect(gate.beginMutation('delete')).rejects.toThrow('Forgeboard is shutting down.');

    let quitStarted = false;
    const quit = gate.beginMutation('quit', { allowDuringShutdown: true }).then(() => {
      quitStarted = true;
    });
    await Promise.resolve();
    expect(quitStarted).toBe(false);

    operationRelease.resolve();
    await operation;
    await quit;
    expect(gate.mutationKind).toBe('quit');
  });
});

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
