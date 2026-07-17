import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import {
  TEST_AGENT_MANIFEST,
  TestAgentEventSchema,
  TestAgentRunCommandSchema,
  createTestAgentRunCommand,
  runTestAgentProtocol,
  type TestAgentAction,
  type TestAgentEvent,
} from './index.js';
import { parseTestAgentCliArguments } from './cli-arguments.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-test-agent-'));
  temporaryDirectories.push(directory);
  return directory;
}

function protocolHarness(
  cwd: string,
  onEvent?: (event: TestAgentEvent, stdin: PassThrough) => void,
  providerSessionId?: string,
) {
  const stdin = new PassThrough();
  const events: TestAgentEvent[] = [];
  const result = runTestAgentProtocol({
    stdin,
    cwd,
    ...(providerSessionId === undefined ? {} : { providerSessionId }),
    writeLine: (line) => {
      const event = TestAgentEventSchema.parse(JSON.parse(line) as unknown);
      events.push(event);
      onEvent?.(event, stdin);
    },
  });
  return { stdin, events, result };
}

describe('deterministic test-agent protocol', () => {
  it('exports a valid local-only adapter manifest', () => {
    expect(TEST_AGENT_MANIFEST).toMatchObject({
      id: 'forgeboard-test-agent',
      provider: { sendsContextOffDevice: false },
      invocation: {
        runtime: 'pipes',
        output: 'json-lines',
        resumeArguments: ['--resume-session', '{sessionId}', '{extraArgs}'],
      },
      capabilities: { pause: false, resume: true, structuredOutput: true },
    });
  });

  it('preserves one exact reviewed session identity through CLI parsing and protocol readiness', async () => {
    const providerSessionId = 'test-session-reviewed-42';
    expect(parseTestAgentCliArguments(['--resume-session', providerSessionId])).toEqual({
      kind: 'run',
      providerSessionId,
    });
    expect(parseTestAgentCliArguments(['--resume-session'])).toEqual({
      kind: 'error',
      message: '--resume-session requires exactly one valid provider session ID.',
    });
    expect(
      parseTestAgentCliArguments(['--resume-session', providerSessionId, 'unexpected']),
    ).toEqual({
      kind: 'error',
      message: '--resume-session requires exactly one valid provider session ID.',
    });

    const cwd = await temporaryDirectory();
    const harness = protocolHarness(cwd, undefined, providerSessionId);
    harness.stdin.write(`${createTestAgentRunCommand([{ type: 'complete' }])}\n`);
    await expect(harness.result).resolves.toBe(0);
    expect(harness.events[0]).toMatchObject({ type: 'ready', sessionId: providerSessionId });
  });

  it('writes files, streams output, waits for input, and completes in exact order', async () => {
    const cwd = await temporaryDirectory();
    const actions: TestAgentAction[] = [
      { type: 'emit', stream: 'stdout', data: '\u001b[32mworking\u001b[0m' },
      { type: 'write-file', path: 'src/result.txt', content: 'first' },
      { type: 'append-file', path: 'src/result.txt', content: '+second' },
      {
        type: 'wait-for-input',
        requestId: 'approval',
        prompt: 'Continue?',
        expected: 'yes',
      },
      { type: 'complete', metadata: { tests: 4 } },
    ];
    const harness = protocolHarness(cwd, (event, stdin) => {
      if (event.type === 'input-requested') {
        stdin.write(
          `${JSON.stringify({ type: 'input', requestId: event.requestId, data: 'yes' })}\n`,
        );
      }
    });
    harness.stdin.write(`${createTestAgentRunCommand(actions)}\n`);
    const exitCode = await harness.result;

    expect(exitCode).toBe(0);
    expect(await readFile(path.join(cwd, 'src/result.txt'), 'utf8')).toBe('first+second');
    expect(harness.events.map(({ type }) => type)).toEqual([
      'ready',
      'run-started',
      'output',
      'file-written',
      'file-written',
      'input-requested',
      'input-received',
      'completed',
    ]);
    expect(harness.events.map(({ sequence }) => sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(harness.events[2]).toMatchObject({ data: '\u001b[32mworking\u001b[0m' });
  });

  it('fails with the requested deterministic exit code', async () => {
    const cwd = await temporaryDirectory();
    const harness = protocolHarness(cwd);
    harness.stdin.write(
      `${createTestAgentRunCommand([{ type: 'fail', message: 'intentional', exitCode: 23 }])}\n`,
    );

    await expect(harness.result).resolves.toBe(23);
    expect(harness.events.at(-1)).toMatchObject({
      type: 'failed',
      message: 'intentional',
      exitCode: 23,
    });
  });

  it('interrupts an in-flight action through the protocol', async () => {
    const cwd = await temporaryDirectory();
    const harness = protocolHarness(cwd, (event, stdin) => {
      if (event.type === 'run-started') stdin.write(`${JSON.stringify({ type: 'interrupt' })}\n`);
    });
    harness.stdin.write(
      `${createTestAgentRunCommand([{ type: 'sleep', milliseconds: 30_000 }])}\n`,
    );

    await expect(harness.result).resolves.toBe(130);
    expect(harness.events.at(-1)).toMatchObject({ type: 'interrupted' });
  });

  it('rejects traversal before any file action can run', () => {
    expect(() =>
      TestAgentRunCommandSchema.parse({
        type: 'run',
        actions: [{ type: 'write-file', path: '../outside.txt', content: 'nope' }],
      }),
    ).toThrow(/parent traversal/u);
  });
});
