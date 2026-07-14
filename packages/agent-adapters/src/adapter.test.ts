import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentAdapterManifestSchema,
  BUILT_IN_AGENT_MANIFESTS,
  CliAgentAdapter,
  type AgentAdapterManifest,
  type AgentEvent,
  detectAgent,
  launchPreparedAgent,
  prepareAgentLaunch,
  prepareAgentResume,
} from './index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-adapter-'));
  temporaryDirectories.push(directory);
  return directory;
}

function permission(cwd: string) {
  return {
    id: 'test-custom',
    name: 'Test custom profile',
    mode: 'custom' as const,
    enforcement: 'disclosure-only' as const,
    readRoots: [cwd],
    writeRoots: [cwd],
    network: 'provider-controlled' as const,
    approvalPolicy: 'The fixture does not request approvals.',
    disclosure: 'Test-only direct process access.',
  };
}

function nodeManifest(overrides: Record<string, unknown> = {}): AgentAdapterManifest {
  return AgentAdapterManifestSchema.parse({
    schemaVersion: 1,
    id: 'node-fixture',
    name: 'Node fixture',
    provider: {
      name: 'Local Node.js',
      sendsContextOffDevice: false,
      disclosure: 'The process stays local.',
    },
    executable: {
      command: process.execPath,
      versionArguments: ['--version'],
      versionPattern: 'v(?<version>\\d+(?:\\.\\d+)+)',
      detectionTimeoutMs: 2_000,
    },
    invocation: {
      runtime: 'pipes',
      launchArguments: [
        '-e',
        'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
        '{extraArgs}',
        '{prompt}',
      ],
      promptTransport: 'argument',
      modelArguments: [],
      context: { strategy: 'prompt-references' },
      permissionArguments: { custom: [] },
      output: 'text',
    },
    capabilities: {
      interactiveInput: true,
      interrupt: true,
      terminate: true,
      resume: false,
      ansiStreaming: true,
      structuredOutput: false,
      modelSelection: false,
      contextAttachments: true,
      permissionModes: ['custom'],
    },
    suggestedEnvironmentVariables: [],
    ...overrides,
  });
}

async function allEvents(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe('adapter manifests', () => {
  it('ships validated and capability-honest built-in manifests', () => {
    expect(BUILT_IN_AGENT_MANIFESTS.map(({ id }) => id)).toEqual([
      'codex',
      'claude',
      'gemini',
      'opencode',
    ]);
    for (const manifest of BUILT_IN_AGENT_MANIFESTS) {
      expect(() => AgentAdapterManifestSchema.parse(manifest)).not.toThrow();
      expect(manifest.capabilities.resume).toBe(manifest.invocation.resumeArguments !== undefined);
      expect(manifest.invocation.runtime).toBe('pty');
    }
  });

  it('rejects manifests that advertise resume without implementing it', () => {
    const manifest = nodeManifest();
    expect(() =>
      AgentAdapterManifestSchema.parse({
        ...manifest,
        capabilities: { ...manifest.capabilities, resume: true },
      }),
    ).toThrow(/Resume capability must exactly match/u);
  });

  it('rejects unknown invocation placeholders', () => {
    const manifest = nodeManifest();
    expect(() =>
      AgentAdapterManifestSchema.parse({
        ...manifest,
        invocation: { ...manifest.invocation, launchArguments: ['{rendererCode}', '{prompt}'] },
      }),
    ).toThrow(/unknown template placeholder/u);
  });
});

describe('launch preparation and execution', () => {
  it('discloses exact argv, cwd, environment names, context, and permission limits', async () => {
    const cwd = await temporaryDirectory();
    const contextPath = path.join(cwd, 'selected file.ts');
    const manifest = nodeManifest();
    const prompt = '$(touch should-never-run)';
    const plan = prepareAgentLaunch(manifest, {
      prompt,
      cwd,
      permissionProfile: permission(cwd),
      contextAttachments: [{ path: contextPath, kind: 'file', explicitlyApproved: true }],
      extraArguments: ['argument with spaces', '; still-one-argument'],
      environment: { inherit: 'none', variables: { FIXTURE_NAME: 'secret-value' }, unset: [] },
    });

    expect(plan.disclosure).toMatchObject({
      executable: process.execPath,
      cwd,
      shell: false,
      runtime: 'pipes',
      environmentVariableNames: ['FIXTURE_NAME'],
      contextAttachments: [{ path: contextPath, kind: 'file', explicitlyApproved: true }],
    });
    expect(plan.disclosure.arguments).toContain('argument with spaces');
    expect(plan.disclosure.arguments).toContain('; still-one-argument');
    expect(plan.disclosure.arguments.at(-1)).toContain(prompt);
    expect(JSON.stringify(plan.disclosure)).not.toContain('secret-value');

    const session = await launchPreparedAgent(plan);
    const eventsPromise = allEvents(session.events);
    const result = await session.result;
    const events = await eventsPromise;
    const output = events
      .filter((event): event is Extract<AgentEvent, { type: 'stream' }> => event.type === 'stream')
      .map((event) => event.data)
      .join('');
    const argv = JSON.parse(output) as string[];

    expect(result.status).toBe('succeeded');
    expect(argv).toEqual(plan.disclosure.arguments.slice(2));
    expect(events.at(0)).toMatchObject({ type: 'lifecycle', phase: 'starting' });
    expect(events.at(-1)).toMatchObject({ type: 'result' });
  });

  it('never evaluates argument text through a shell', async () => {
    const cwd = await temporaryDirectory();
    const marker = path.join(cwd, 'shell-injection-marker');
    const plan = prepareAgentLaunch(nodeManifest(), {
      prompt: `; touch ${marker}`,
      cwd,
      permissionProfile: permission(cwd),
      environment: { inherit: 'safe', variables: {}, unset: [] },
    });
    const session = await launchPreparedAgent(plan);
    await session.result;

    await expect(access(marker)).rejects.toThrow();
  });

  it('normalizes JSON-lines without discarding raw output or session metadata', async () => {
    const cwd = await temporaryDirectory();
    const manifest = nodeManifest({
      invocation: {
        runtime: 'pipes',
        launchArguments: [
          '-e',
          'process.stdout.write(JSON.stringify({type:"hello",session_id:"session-7"})+"\\n")',
          '{extraArgs}',
          '{prompt}',
        ],
        promptTransport: 'argument',
        modelArguments: [],
        context: { strategy: 'prompt-references' },
        permissionArguments: { custom: [] },
        output: 'json-lines',
      },
      capabilities: {
        interactiveInput: true,
        interrupt: true,
        terminate: true,
        resume: false,
        ansiStreaming: true,
        structuredOutput: true,
        modelSelection: false,
        contextAttachments: true,
        permissionModes: ['custom'],
      },
    });
    const adapter = new CliAgentAdapter(manifest);
    const session = await adapter.launch(
      adapter.prepareLaunch({ prompt: 'hello', cwd, permissionProfile: permission(cwd) }),
    );
    const eventsPromise = allEvents(session.events);
    const result = await session.result;
    const events = await eventsPromise;

    expect(events.some((event) => event.type === 'stream')).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'message',
        payload: { type: 'hello', session_id: 'session-7' },
      }),
    );
    expect(result.providerSessionId).toBe('session-7');
  });

  it('preserves ANSI bytes from a real pseudo-terminal stream', async () => {
    const cwd = await temporaryDirectory();
    const manifest = nodeManifest({
      invocation: {
        runtime: 'pty',
        launchArguments: [
          '-e',
          'process.stdout.write("\\u001b[31mred\\u001b[0m")',
          '{extraArgs}',
          '{prompt}',
        ],
        promptTransport: 'argument',
        modelArguments: [],
        context: { strategy: 'prompt-references' },
        permissionArguments: { custom: [] },
        output: 'text',
      },
    });
    const session = await launchPreparedAgent(
      prepareAgentLaunch(manifest, { prompt: 'ansi', cwd, permissionProfile: permission(cwd) }),
    );
    const eventsPromise = allEvents(session.events);
    await expect(session.result).resolves.toMatchObject({ status: 'succeeded' });
    const events = await eventsPromise;
    const output = events
      .filter((event): event is Extract<AgentEvent, { type: 'stream' }> => event.type === 'stream')
      .map((event) => event.data)
      .join('');

    expect(events).toContainEqual(expect.objectContaining({ type: 'stream', channel: 'pty' }));
    expect(output).toContain('\u001b[31mred\u001b[0m');
  });

  it('marks user interruption truthfully', async () => {
    const cwd = await temporaryDirectory();
    const manifest = nodeManifest({
      invocation: {
        runtime: 'pipes',
        launchArguments: ['-e', 'setInterval(() => {}, 1000)', '{extraArgs}', '{prompt}'],
        promptTransport: 'argument',
        modelArguments: [],
        context: { strategy: 'prompt-references' },
        permissionArguments: { custom: [] },
        output: 'text',
      },
    });
    const session = await launchPreparedAgent(
      prepareAgentLaunch(manifest, { prompt: 'wait', cwd, permissionProfile: permission(cwd) }),
    );
    session.interrupt();
    await expect(session.result).resolves.toMatchObject({ status: 'interrupted' });
  });

  it('detects executable versions and prepares supported resume invocations', async () => {
    const detection = await detectAgent(nodeManifest());
    expect(detection).toMatchObject({
      available: true,
      executable: process.execPath,
      version: process.version.slice(1),
    });

    const cwd = await temporaryDirectory();
    const resumable = BUILT_IN_AGENT_MANIFESTS[0];
    expect(resumable).toBeDefined();
    const plan = prepareAgentResume(resumable!, {
      prompt: 'continue safely',
      cwd,
      sessionId: 'session-123',
      permissionProfile: {
        ...permission(cwd),
        id: 'plan',
        name: 'Plan only',
        mode: 'plan-read-only',
        enforcement: 'provider',
        writeRoots: [],
      },
    });
    expect(plan.disclosure.arguments).toContain('resume');
    expect(plan.disclosure.arguments).toContain('session-123');
    expect(plan.resumeSessionId).toBe('session-123');
  });

  it('downgrades capabilities that the installed executable does not advertise', async () => {
    const cwd = await temporaryDirectory();
    const manifest = nodeManifest({
      executable: {
        command: process.execPath,
        versionArguments: ['--version'],
        versionPattern: 'v(?<version>\\d+(?:\\.\\d+)+)',
        detectionTimeoutMs: 2_000,
        capabilityProbe: {
          arguments: ['--help'],
          permissionModes: { custom: ['FORGEBOARD_NONEXISTENT_CAPABILITY'] },
        },
      },
    });
    const adapter = new CliAgentAdapter(manifest);
    const detection = await adapter.detect();

    expect(detection.available).toBe(true);
    expect(detection.effectiveCapabilities?.permissionModes).toEqual([]);
    expect(detection.capabilityWarnings).toContain(
      'The installed executable does not advertise permission mode custom.',
    );
    expect(() =>
      adapter.prepareLaunch({ prompt: 'blocked', cwd, permissionProfile: permission(cwd) }),
    ).toThrow(/detected executable version/u);
  });
});
