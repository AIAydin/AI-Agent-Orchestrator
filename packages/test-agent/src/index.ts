import { constants as fsConstants } from 'node:fs';
import { access, appendFile, lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod';

export const TEST_AGENT_PACKAGE_VERSION = '0.1.0';
export const TEST_AGENT_PROTOCOL_VERSION = 1 as const;

const RelativeFilePathSchema = z
  .string()
  .min(1)
  .max(16_384)
  .refine((value) => !value.includes('\0') && !/[\r\n]/u.test(value), {
    message: 'File paths cannot contain NUL bytes or line breaks.',
  })
  .refine((value) => !path.isAbsolute(value), { message: 'File path must be relative.' })
  .refine((value) => !value.split(/[\\/]/u).some((part) => part === '..' || part === ''), {
    message: 'File path cannot be empty or contain parent traversal.',
  });

export const TestAgentActionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('emit'),
      stream: z.enum(['stdout', 'stderr']),
      data: z.string().max(1_000_000),
    })
    .strict(),
  z
    .object({
      type: z.literal('write-file'),
      path: RelativeFilePathSchema,
      content: z.string().max(10_000_000),
      encoding: z.enum(['utf8', 'base64']).default('utf8'),
    })
    .strict(),
  z
    .object({
      type: z.literal('append-file'),
      path: RelativeFilePathSchema,
      content: z.string().max(10_000_000),
      encoding: z.enum(['utf8', 'base64']).default('utf8'),
    })
    .strict(),
  z
    .object({ type: z.literal('sleep'), milliseconds: z.number().int().min(0).max(300_000) })
    .strict(),
  z
    .object({
      type: z.literal('wait-for-input'),
      requestId: z.string().min(1).max(128),
      prompt: z.string().max(4_096),
      expected: z.string().max(1_000_000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('fail'),
      message: z.string().min(1).max(4_096),
      exitCode: z.number().int().min(1).max(255).default(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('complete'),
      metadata: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
]);
export type TestAgentAction = z.input<typeof TestAgentActionSchema>;

export const TestAgentRunCommandSchema = z
  .object({
    type: z.literal('run'),
    actions: z.array(TestAgentActionSchema).max(10_000),
  })
  .strict();
export type TestAgentRunCommand = z.input<typeof TestAgentRunCommandSchema>;

export const TestAgentInputCommandSchema = z
  .object({
    type: z.literal('input'),
    requestId: z.string().min(1).max(128),
    data: z.string().max(1_000_000),
  })
  .strict();

export const TestAgentControlCommandSchema = z.discriminatedUnion('type', [
  TestAgentRunCommandSchema,
  TestAgentInputCommandSchema,
  z.object({ type: z.literal('interrupt') }).strict(),
  z.object({ type: z.literal('terminate') }).strict(),
]);
export type TestAgentControlCommand = z.infer<typeof TestAgentControlCommandSchema>;

const TestAgentEventBaseSchema = z.object({
  protocolVersion: z.literal(TEST_AGENT_PROTOCOL_VERSION),
  sequence: z.number().int().nonnegative(),
});

export const TestAgentEventSchema = z.discriminatedUnion('type', [
  TestAgentEventBaseSchema.extend({
    type: z.literal('ready'),
    sessionId: z.string().trim().min(1).max(1_024).optional(),
  }).strict(),
  TestAgentEventBaseSchema.extend({
    type: z.literal('run-started'),
    actionCount: z.number().int().nonnegative(),
  }).strict(),
  TestAgentEventBaseSchema.extend({
    type: z.literal('output'),
    stream: z.enum(['stdout', 'stderr']),
    data: z.string(),
  }).strict(),
  TestAgentEventBaseSchema.extend({
    type: z.literal('file-written'),
    path: z.string(),
    operation: z.enum(['write', 'append']),
    bytes: z.number().int().nonnegative(),
  }).strict(),
  TestAgentEventBaseSchema.extend({
    type: z.literal('input-requested'),
    requestId: z.string(),
    prompt: z.string(),
  }).strict(),
  TestAgentEventBaseSchema.extend({
    type: z.literal('input-received'),
    requestId: z.string(),
    data: z.string(),
  }).strict(),
  TestAgentEventBaseSchema.extend({
    type: z.literal('protocol-error'),
    message: z.string(),
  }).strict(),
  TestAgentEventBaseSchema.extend({
    type: z.literal('failed'),
    message: z.string(),
    exitCode: z.number().int(),
  }).strict(),
  TestAgentEventBaseSchema.extend({
    type: z.literal('completed'),
    metadata: z.record(z.string(), z.unknown()),
  }).strict(),
  TestAgentEventBaseSchema.extend({ type: z.literal('interrupted') }).strict(),
  TestAgentEventBaseSchema.extend({ type: z.literal('terminated') }).strict(),
]);
export type TestAgentEvent = z.infer<typeof TestAgentEventSchema>;

export const TEST_AGENT_MANIFEST = Object.freeze({
  schemaVersion: 1,
  id: 'forgeboard-test-agent',
  name: 'Forgeboard deterministic test agent',
  provider: {
    name: 'Local deterministic test process',
    sendsContextOffDevice: false,
    disclosure:
      'This test agent runs locally and performs only the JSON-lines actions explicitly supplied to it.',
  },
  executable: {
    command: 'forgeboard-test-agent',
    versionArguments: ['--version'],
    versionPattern: 'forgeboard-test-agent\\s+(?<version>\\d+(?:\\.\\d+)+)',
  },
  invocation: {
    runtime: 'pipes',
    launchArguments: ['{extraArgs}'],
    resumeArguments: ['--resume-session', '{sessionId}', '{extraArgs}'],
    promptTransport: 'stdin',
    promptTerminator: '\n',
    modelArguments: [],
    context: { strategy: 'none' },
    permissionArguments: { custom: [] },
    output: 'json-lines',
  },
  capabilities: {
    interactiveInput: true,
    interrupt: true,
    terminate: true,
    pause: false,
    resume: true,
    ansiStreaming: false,
    structuredOutput: true,
    modelSelection: false,
    contextAttachments: false,
    permissionModes: ['custom'],
  },
  suggestedEnvironmentVariables: [],
} as const);

export interface TestAgentProtocolOptions {
  stdin: Readable;
  writeLine: (line: string) => void;
  cwd: string;
  providerSessionId?: string;
  signal?: AbortSignal;
}

type UnsequencedTestAgentEvent = TestAgentEvent extends infer Event
  ? Event extends TestAgentEvent
    ? Omit<Event, 'protocolVersion' | 'sequence'>
    : never
  : never;

class TestAgentStop extends Error {
  public constructor(public readonly kind: 'interrupt' | 'terminate') {
    super(kind);
    this.name = 'TestAgentStop';
  }
}

function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason as unknown;
  return reason instanceof Error ? reason : new Error('Test agent operation aborted.');
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await access(value, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolveSafeWritePath(cwd: string, relativePath: string): Promise<string> {
  const root = await realpath(cwd);
  const target = path.resolve(root, relativePath);
  if (!isWithin(root, target))
    throw new Error('File action escaped the assigned working directory.');

  if (await pathExists(target)) {
    const targetStat = await lstat(target);
    if (targetStat.isSymbolicLink()) throw new Error('Refusing to write through a symbolic link.');
    const targetRealPath = await realpath(target);
    if (!isWithin(root, targetRealPath)) {
      throw new Error('Existing file resolves outside the assigned working directory.');
    }
  }

  let existingParent = path.dirname(target);
  while (!(await pathExists(existingParent))) {
    const next = path.dirname(existingParent);
    if (next === existingParent) throw new Error('Could not resolve a safe parent directory.');
    existingParent = next;
  }
  const realParent = await realpath(existingParent);
  if (!isWithin(root, realParent)) {
    throw new Error('File parent resolves outside the assigned working directory.');
  }
  return target;
}

function encodedContent(content: string, encoding: 'utf8' | 'base64'): string | Buffer {
  return encoding === 'base64' ? Buffer.from(content, 'base64') : content;
}

export async function runTestAgentProtocol(options: TestAgentProtocolOptions): Promise<number> {
  const controller = new AbortController();
  const externalAbort = (): void => {
    const reason = options.signal?.reason as unknown;
    controller.abort(reason instanceof TestAgentStop ? reason : new TestAgentStop('interrupt'));
  };
  options.signal?.addEventListener('abort', externalAbort, { once: true });
  if (options.signal?.aborted === true) externalAbort();

  let sequence = 0;
  const emit = (event: UnsequencedTestAgentEvent): void => {
    const parsed = TestAgentEventSchema.parse({
      ...event,
      protocolVersion: TEST_AGENT_PROTOCOL_VERSION,
      sequence: sequence++,
    });
    options.writeLine(`${JSON.stringify(parsed)}\n`);
  };

  let runCommand: z.infer<typeof TestAgentRunCommandSchema> | undefined;
  let resolveRun: ((command: z.infer<typeof TestAgentRunCommandSchema>) => void) | undefined;
  let rejectRun: ((error: Error) => void) | undefined;
  const pendingInputs = new Map<string, (data: string) => void>();
  const runReady = new Promise<z.infer<typeof TestAgentRunCommandSchema>>((resolve, reject) => {
    resolveRun = resolve;
    rejectRun = reject;
  });
  const lines = createInterface({ input: options.stdin, crlfDelay: Infinity });

  const stop = (kind: 'interrupt' | 'terminate'): void => {
    if (!controller.signal.aborted) controller.abort(new TestAgentStop(kind));
  };

  lines.on('line', (line) => {
    let command: TestAgentControlCommand;
    try {
      command = TestAgentControlCommandSchema.parse(JSON.parse(line) as unknown);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid JSON-lines command.';
      emit({ type: 'protocol-error', message });
      if (runCommand === undefined) rejectRun?.(new Error(message));
      return;
    }

    if (command.type === 'interrupt' || command.type === 'terminate') {
      stop(command.type);
      return;
    }
    if (command.type === 'input') {
      const resolver = pendingInputs.get(command.requestId);
      if (resolver === undefined) {
        emit({
          type: 'protocol-error',
          message: `No input request is waiting for ${command.requestId}.`,
        });
      } else {
        pendingInputs.delete(command.requestId);
        resolver(command.data);
      }
      return;
    }
    if (runCommand !== undefined) {
      emit({ type: 'protocol-error', message: 'Only one run command is allowed per process.' });
      return;
    }
    runCommand = command;
    resolveRun?.(command);
  });
  lines.on('close', () => {
    if (runCommand === undefined) rejectRun?.(new Error('stdin closed before a run command.'));
  });

  emit({
    type: 'ready',
    ...(options.providerSessionId === undefined ? {} : { sessionId: options.providerSessionId }),
  });
  try {
    const command = await runReady;
    emit({ type: 'run-started', actionCount: command.actions.length });
    for (const action of command.actions) {
      if (controller.signal.aborted) throw controller.signal.reason;
      switch (action.type) {
        case 'emit':
          emit({ type: 'output', stream: action.stream, data: action.data });
          break;
        case 'write-file':
        case 'append-file': {
          const target = await resolveSafeWritePath(options.cwd, action.path);
          await mkdir(path.dirname(target), { recursive: true });
          const content = encodedContent(action.content, action.encoding);
          if (action.type === 'write-file') await writeFile(target, content);
          else await appendFile(target, content);
          emit({
            type: 'file-written',
            path: action.path,
            operation: action.type === 'write-file' ? 'write' : 'append',
            bytes: Buffer.byteLength(content),
          });
          break;
        }
        case 'sleep':
          await delay(action.milliseconds, undefined, { signal: controller.signal });
          break;
        case 'wait-for-input': {
          const input = new Promise<string>((resolve, reject) => {
            const abort = (): void => reject(abortReason(controller.signal));
            controller.signal.addEventListener('abort', abort, { once: true });
            pendingInputs.set(action.requestId, (value) => {
              controller.signal.removeEventListener('abort', abort);
              resolve(value);
            });
          });
          emit({ type: 'input-requested', requestId: action.requestId, prompt: action.prompt });
          const data = await input;
          emit({ type: 'input-received', requestId: action.requestId, data });
          if (action.expected !== undefined && data !== action.expected) {
            emit({
              type: 'failed',
              message: `Input for ${action.requestId} did not match the expected value.`,
              exitCode: 2,
            });
            return 2;
          }
          break;
        }
        case 'fail':
          emit({ type: 'failed', message: action.message, exitCode: action.exitCode });
          return action.exitCode;
        case 'complete':
          emit({ type: 'completed', metadata: action.metadata });
          return 0;
      }
    }
    emit({ type: 'completed', metadata: {} });
    return 0;
  } catch (error) {
    const reason: unknown = controller.signal.aborted ? abortReason(controller.signal) : error;
    if (reason instanceof TestAgentStop) {
      emit({ type: reason.kind === 'interrupt' ? 'interrupted' : 'terminated' });
      return reason.kind === 'interrupt' ? 130 : 143;
    }
    const message = reason instanceof Error ? reason.message : String(reason);
    emit({ type: 'failed', message, exitCode: 1 });
    return 1;
  } finally {
    options.signal?.removeEventListener('abort', externalAbort);
    lines.close();
  }
}

export function createTestAgentRunCommand(actions: readonly TestAgentAction[]): string {
  return JSON.stringify(TestAgentRunCommandSchema.parse({ type: 'run', actions }));
}

export function createTestAgentStop(kind: 'interrupt' | 'terminate'): Error {
  return new TestAgentStop(kind);
}
