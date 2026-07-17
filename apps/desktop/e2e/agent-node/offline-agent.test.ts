import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('./fixtures/scripts/offline-agent.mjs', import.meta.url));
const temporaryDirectories: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe('offline Agent-node fixture', () => {
  it('fails closed for an argv shape outside the exact reviewed contract', async () => {
    const fixture = await launch(['launch', '--model', 'offline-model-v1', 'prompt']);
    const result = await fixture.result;

    expect(result.exitCode).toBe(8);
    expect(JSON.stringify(result.events)).toContain('OFFLINE_FIXTURE_REJECTED');
  });

  it('streams interactive input and reports normalized usage before interruption', async () => {
    const fixture = await launch(reviewedArguments('launch', 'wait'));
    await fixture.waitFor('OFFLINE_READY');
    fixture.child.stdin.write('approved-interactive-input\n');
    await fixture.waitFor('OFFLINE_INPUT_RECEIVED approved-interactive-input');
    fixture.child.kill('SIGINT');
    const result = await fixture.result;

    expect(result.exitCode).toBe(130);
    expect(await readFile(join(fixture.cwd, 'offline-agent-proof.txt'), 'utf8')).toBe(
      'input=approved-interactive-input\n',
    );
    expect(JSON.stringify(result.events)).toContain('"total_tokens":42,"total_cost_usd":0.0042');
  });

  it('creates a failed retry parent and preserves the reviewed resume session identity', async () => {
    const failed = await launch(reviewedArguments('launch', 'RETRY_FAIL'));
    const failedResult = await failed.result;
    expect(failedResult.exitCode).toBe(7);
    expect(failedResult.events).toContainEqual({
      type: 'session',
      thread_id: 'forgeboard-offline-session-001-failed',
    });

    const initial = await launch(reviewedArguments('launch', 'wait'));
    await initial.waitFor('OFFLINE_READY');
    initial.child.stdin.write('input-before-resume\n');
    await initial.waitFor('OFFLINE_INPUT_RECEIVED');
    initial.child.kill('SIGINT');
    await initial.result;

    const resumed = await launch(
      reviewedArguments('resume', 'resume prompt', 'forgeboard-offline-session-001'),
      initial.cwd,
    );
    const resumedResult = await resumed.result;
    expect(resumedResult.exitCode).toBe(0);
    expect(JSON.stringify(resumedResult.events)).toContain(
      'OFFLINE_RESUMED forgeboard-offline-session-001',
    );
    expect(await readFile(join(initial.cwd, 'offline-agent-proof.txt'), 'utf8')).toContain(
      'resume completed',
    );
  });
});

function reviewedArguments(
  mode: 'launch' | 'resume',
  prompt: string,
  sessionId?: string,
): string[] {
  return [
    mode,
    '--no-alt-screen',
    '--permission',
    'worktree-write',
    '--model',
    'offline-model-v1',
    ...(mode === 'resume' ? [sessionId ?? 'missing-session'] : []),
    prompt,
  ];
}

async function launch(arguments_: string[], existingCwd?: string) {
  const cwd = existingCwd ?? (await mkdtemp(join(tmpdir(), 'forgeboard-offline-agent-')));
  if (existingCwd === undefined) temporaryDirectories.push(cwd);
  const child = spawn(process.execPath, [script, ...arguments_], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  const events: unknown[] = [];
  let output = '';
  const waiters: Array<{ marker: string; resolve: () => void }> = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
    for (const waiter of [...waiters]) {
      if (output.includes(waiter.marker)) waiter.resolve();
    }
  });
  const result = new Promise<{ events: unknown[]; exitCode: number | null }>((resolve) => {
    child.on('close', (exitCode) => {
      for (const line of output.trim().split('\n')) {
        if (line.length > 0) events.push(JSON.parse(line));
      }
      resolve({ events, exitCode });
    });
  });
  return {
    child,
    cwd,
    result,
    waitFor: async (marker: string) => {
      if (output.includes(marker)) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${marker}`)), 3_000);
        waiters.push({
          marker,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      });
    },
  };
}
