import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentAdapterManifestSchema,
  AgentResultMetadataSchema,
  BUILT_IN_AGENT_MANIFESTS,
  CliAgentAdapter,
  type AgentAdapterManifest,
  type AgentEvent,
  detectAgent,
  launchPreparedAgent,
  prepareAgentLaunch,
  prepareAgentResume,
  resolveWindowsBatchLaunch,
} from './index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe('Windows batch agent launch', () => {
  it('routes safe cmd shims through the system processor without enabling a general shell', () => {
    expect(
      resolveWindowsBatchLaunch(
        'C:\\Tools\\opencode.cmd',
        ['run', '--model', 'openai/gpt-5.1'],
        { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
        'win32',
      ),
    ).toEqual({
      executable: 'C:\\Windows\\System32\\cmd.exe',
      arguments: [
        '/d',
        '/s',
        '/v:off',
        '/c',
        '""C:\\Tools\\opencode.cmd" "run" "--model" "openai/gpt-5.1""',
      ],
      windowsVerbatimArguments: true,
      windowsPty: {
        arguments: ['/d', '/q', '/v:off'],
        initialInput: 'call "C:\\Tools\\opencode.cmd" "run" "--model" "openai/gpt-5.1" & exit',
      },
    });
  });

  it('rejects command-shell metacharacters and leaves native executables unchanged', () => {
    expect(() =>
      resolveWindowsBatchLaunch(
        'C:\\Tools\\opencode.cmd',
        ['prompt & whoami'],
        { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
        'win32',
      ),
    ).toThrow(/metacharacters/u);
    expect(
      resolveWindowsBatchLaunch('/opt/opencode', ['run', 'prompt & data'], {}, 'linux'),
    ).toEqual({
      executable: '/opt/opencode',
      arguments: ['run', 'prompt & data'],
    });
  });
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
    custom: {
      runtime: 'host' as const,
      filesystem: 'assigned-worktree-write' as const,
      ignoredFileRead: 'deny' as const,
      sensitiveFileRead: 'deny' as const,
      launchExecutablePolicy: 'selected-agent-only' as const,
      allowedLaunchExecutables: [process.execPath],
      forgeboardManagedActions: {
        developmentServers: 'deny' as const,
        tests: 'deny' as const,
      },
      requireReviewBeforePrimary: true as const,
      policyLimitations: ['Test fixture disclosure only.'],
    },
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

async function waitForFileGrowth(filePath: string, minimumLength: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await readFile(filePath, 'utf8')).length >= minimumLength) return;
    } catch {
      // The child may not have created the marker yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the child process marker to grow.');
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

  it('reserves disclosure-only provider modes for the main-owned custom adapter', () => {
    const manifest = nodeManifest();
    expect(() =>
      AgentAdapterManifestSchema.parse({
        ...manifest,
        invocation: {
          ...manifest.invocation,
          permissionArguments: {},
          permissionArgumentPolicy: 'optional-disclosure',
        },
        capabilities: { ...manifest.capabilities, permissionModes: ['plan-read-only'] },
      }),
    ).toThrow(/reserved for Artemis's Settings-owned custom adapter/u);
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

  it('runs final authorization at the exact pipe spawn boundary', async () => {
    const cwd = await temporaryDirectory();
    const marker = path.join(cwd, 'must-not-spawn');
    const base = nodeManifest();
    const manifest = nodeManifest({
      invocation: {
        ...base.invocation,
        launchArguments: [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`,
          '{extraArgs}',
          '{prompt}',
        ],
      },
    });
    const plan = prepareAgentLaunch(manifest, {
      prompt: 'test',
      cwd,
      permissionProfile: permission(cwd),
      environment: { inherit: 'none', variables: {}, unset: [] },
    });

    await expect(
      launchPreparedAgent(plan, () => {
        throw new Error('launch authority revoked');
      }),
    ).rejects.toThrow('launch authority revoked');
    await expect(access(marker)).rejects.toThrow();
  });

  it('normalizes JSON-lines without discarding raw output or session metadata', async () => {
    const cwd = await temporaryDirectory();
    const manifest = nodeManifest({
      invocation: {
        runtime: 'pipes',
        launchArguments: [
          '-e',
          'process.stdout.write(JSON.stringify({type:"hello",thread_id:"session-7"})+"\\n"+JSON.stringify({type:"completed",total_cost_usd:0.0042,metadata:{usage:{input_tokens:13,cached_input_tokens:3,output_tokens:5,total_tokens:18}}})+"\\n")',
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
        payload: { type: 'hello', thread_id: 'session-7' },
      }),
    );
    expect(result.providerSessionId).toBe('session-7');
    expect(result.usage).toEqual({
      inputTokens: 13,
      cachedInputTokens: 3,
      outputTokens: 5,
      totalTokens: 18,
      costUsd: 0.0042,
    });
    expect(session.capabilities).toEqual({
      interactiveInput: true,
      interrupt: true,
      terminate: true,
      pause: process.platform !== 'win32',
      resume: false,
      source: 'manifest',
    });
  });

  it('rejects unbounded result metadata and never advertises unenforceable process pause', () => {
    expect(() =>
      AgentResultMetadataSchema.parse({
        status: 'succeeded',
        exitCode: 0,
        signal: null,
        startedAt: '2026-07-17T12:00:00.000Z',
        endedAt: '2026-07-17T12:00:01.000Z',
        durationMs: 1_000,
        providerSessionId: `session-${'x'.repeat(1_024)}`,
      }),
    ).toThrow();
    expect(() =>
      AgentResultMetadataSchema.parse({
        status: 'succeeded',
        exitCode: 0,
        signal: null,
        startedAt: '2026-07-17T12:00:00.000Z',
        endedAt: '2026-07-17T12:00:01.000Z',
        durationMs: 1_000,
        usage: { totalTokens: 1_000_000_000_001 },
      }),
    ).toThrow();
    expect(() =>
      AgentAdapterManifestSchema.parse({
        ...nodeManifest(),
        capabilities: { ...nodeManifest().capabilities, pause: true },
      }),
    ).toThrow(/pause/u);
  });

  it.runIf(process.platform !== 'win32')(
    'suspends and continues the exact host process group without restarting it',
    async () => {
      const cwd = await temporaryDirectory();
      const marker = path.join(cwd, 'ticks.txt');
      const descendantMarker = path.join(cwd, 'descendant-ticks.txt');
      const manifest = nodeManifest({
        invocation: {
          runtime: 'pipes',
          launchArguments: [
            '-e',
            'const fs=require("node:fs"),{spawn}=require("node:child_process");const [marker,descendant]=process.argv.slice(1);setInterval(()=>fs.appendFileSync(marker,"x"),20);spawn(process.execPath,["-e",`const fs=require("node:fs");setInterval(()=>fs.appendFileSync(${JSON.stringify(descendant)},"x"),20)`],{stdio:"ignore"})',
            marker,
            descendantMarker,
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
      const adapter = new CliAgentAdapter(manifest);
      const session = await adapter.launch(
        adapter.prepareLaunch({ prompt: 'tick', cwd, permissionProfile: permission(cwd) }),
      );
      expect(session.capabilities.pause).toBe(true);
      expect(typeof session.pause).toBe('function');
      expect(typeof session.continue).toBe('function');
      const originalPid = session.pid;

      await waitForFileGrowth(marker, 1);
      await waitForFileGrowth(descendantMarker, 1);
      session.pause?.();
      await new Promise((resolve) => setTimeout(resolve, 60));
      const pausedLength = (await readFile(marker, 'utf8')).length;
      const pausedDescendantLength = (await readFile(descendantMarker, 'utf8')).length;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await readFile(marker, 'utf8')).length).toBe(pausedLength);
      expect((await readFile(descendantMarker, 'utf8')).length).toBe(pausedDescendantLength);

      session.continue?.();
      await waitForFileGrowth(marker, pausedLength + 1);
      await waitForFileGrowth(descendantMarker, pausedDescendantLength + 1);
      expect(session.pid).toBe(originalPid);
      session.pause?.();
      session.terminate();
      await session.result;
    },
  );

  it.runIf(process.platform !== 'win32')(
    'continues a paused process group before delivering a real interrupt',
    async () => {
      const cwd = await temporaryDirectory();
      const manifest = nodeManifest({
        invocation: {
          runtime: 'pipes',
          launchArguments: [
            '-e',
            'process.on("SIGINT",()=>process.exit(0));setInterval(()=>{},1000)',
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
      const adapter = new CliAgentAdapter(manifest);
      const session = await adapter.launch(
        adapter.prepareLaunch({ prompt: 'wait', cwd, permissionProfile: permission(cwd) }),
      );

      session.pause?.();
      session.interrupt();
      await expect(session.result).resolves.toMatchObject({ status: 'interrupted' });
    },
  );

  it('preserves ANSI styling semantics from a real pseudo-terminal stream', async () => {
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
    // Windows ConPTY may insert terminal housekeeping sequences and canonicalize SGR reset from
    // `ESC[0m` to `ESC[m`. The ordered color, text, and reset semantics must still survive.
    const colorIndex = output.indexOf('\u001b[31m');
    const textIndex = output.indexOf('red', colorIndex + 1);
    const afterText = output.slice(textIndex + 'red'.length);
    expect(colorIndex).toBeGreaterThanOrEqual(0);
    expect(textIndex).toBeGreaterThan(colorIndex);
    expect(afterText.includes('\u001b[0m') || afterText.includes('\u001b[m')).toBe(true);
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
    const probes: Array<{
      readonly kind: 'version' | 'capability';
      readonly executable: string;
      readonly arguments: readonly string[];
    }> = [];
    const detection = await detectAgent(nodeManifest(), {
      beforeProbe: (probe) => {
        probes.push(probe);
      },
    });
    expect(detection).toMatchObject({
      available: true,
      executable: process.execPath,
      version: process.version.slice(1),
    });
    expect(probes).toEqual([
      {
        kind: 'version',
        executable: process.execPath,
        arguments: ['--version'],
      },
    ]);

    const cwd = await temporaryDirectory();
    const resumable = BUILT_IN_AGENT_MANIFESTS[0];
    expect(resumable).toBeDefined();
    const basePermission = { ...permission(cwd), custom: undefined };
    const plan = prepareAgentResume(resumable!, {
      prompt: 'continue safely',
      cwd,
      sessionId: 'session-123',
      permissionProfile: {
        ...basePermission,
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

  it('fails closed for every permission mode when the capability probe itself fails', async () => {
    const cwd = await temporaryDirectory();
    const manifest = nodeManifest({
      executable: {
        command: process.execPath,
        versionArguments: ['--version'],
        versionPattern: 'v(?<version>\\d+(?:\\.\\d+)+)',
        detectionTimeoutMs: 2_000,
        capabilityProbe: {
          arguments: ['-e', 'process.exit(17)'],
          permissionModes: { custom: ['supported'] },
        },
      },
    });
    const adapter = new CliAgentAdapter(manifest);

    const detection = await adapter.detect();

    expect(detection.available).toBe(true);
    expect(detection.effectiveCapabilities?.permissionModes).toEqual([]);
    expect(detection.capabilityWarnings.join(' ')).toContain(
      'Permission modes are disabled until a probe succeeds.',
    );
    expect(() =>
      adapter.prepareLaunch({ prompt: 'blocked', cwd, permissionProfile: permission(cwd) }),
    ).toThrow(/detected executable version/u);
  });
});
