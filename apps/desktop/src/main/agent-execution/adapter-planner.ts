import {
  CliAgentAdapter,
  createCustomCliAdapter,
  getBuiltInAgentManifest,
  planDockerAgentLaunch,
  type PermissionProfile,
} from '@forgeboard/agent-adapters';
import {
  TEST_AGENT_MANIFEST,
  createTestAgentRunCommand,
  type TestAgentAction,
} from '@forgeboard/test-agent';

import type { AppSettings } from '../../shared/contracts.js';
import { customAgentManifest } from '../custom-agent.js';
import { checkDockerReadiness } from '../docker-runtime.js';
import type {
  AgentAdapterPlanner,
  AgentExecutionRequest,
  AgentRuntimeAdapterPlan,
  TrustedAdapterLookup,
} from './contracts.js';

const DOCKER_SAFE_ENVIRONMENT_NAMES = new Set(['COLORTERM', 'LANG', 'LC_ALL', 'TERM']);

export interface DefaultAgentAdapterPlannerOptions {
  readonly getTrustedAdapter: TrustedAdapterLookup;
  readonly resolveTestAgentCliPath: () => Promise<string>;
}

export function createDefaultAgentAdapterPlanner({
  getTrustedAdapter,
  resolveTestAgentCliPath,
}: DefaultAgentAdapterPlannerOptions): AgentAdapterPlanner {
  return async (input, cwd, settings, runId) =>
    await prepareAdapter(input, cwd, settings, runId, {
      getTrustedAdapter,
      resolveTestAgentCliPath,
    });
}

async function prepareAdapter(
  input: AgentExecutionRequest,
  cwd: string,
  settings: AppSettings,
  runId: string,
  dependencies: DefaultAgentAdapterPlannerOptions,
): Promise<AgentRuntimeAdapterPlan> {
  const environment = allowedEnvironment(settings.envAllowlist);
  if (input.adapterId === 'test-agent') {
    if (input.permissionProfile === 'docker-isolated') {
      throw new Error(
        'The bundled deterministic agent runs directly. Choose a container-ready coding-agent adapter for Docker isolation.',
      );
    }
    const cliPath = await dependencies.resolveTestAgentCliPath();
    const adapter = createCustomCliAdapter({ ...TEST_AGENT_MANIFEST, id: 'test-agent' });
    const profile = permissionProfile(input.permissionProfile, cwd, true);
    const actions = testAgentActions(input, runId);
    const plan = adapter.prepareLaunch({
      prompt: createTestAgentRunCommand(actions),
      cwd,
      permissionProfile: profile,
      contextAttachments: input.context.attachments,
      executable: process.execPath,
      extraArguments: [cliPath],
      environment: {
        inherit: 'none',
        variables: { ...environment, ELECTRON_RUN_AS_NODE: '1' },
        unset: [],
      },
    });
    return { adapter, plan, detectionWarnings: [], trustedExtensionAdapter: false };
  }

  const settingsManifest =
    input.adapterId === 'custom' ? customAgentManifest(settings.customAgent) : undefined;
  const builtInManifest = getBuiltInAgentManifest(input.adapterId) ?? settingsManifest;
  const trustedManifest =
    builtInManifest === undefined
      ? await dependencies.getTrustedAdapter(input.adapterId)
      : undefined;
  const manifest = builtInManifest ?? trustedManifest;
  if (manifest === undefined) throw new Error(`No adapter is registered for ${input.adapterId}.`);
  const adapter = new CliAgentAdapter(manifest);

  if (input.permissionProfile === 'docker-isolated') {
    return await prepareDockerAdapter(
      adapter,
      input,
      cwd,
      settings,
      environment,
      trustedManifest !== undefined,
    );
  }

  const executableOverride =
    input.adapterId === 'custom'
      ? manifest.executable.command
      : settings.agentExecutableOverrides[input.adapterId]?.trim();
  const detection = await adapter.detect({
    ...(executableOverride === undefined || executableOverride === ''
      ? {}
      : { executable: executableOverride }),
  });
  if (!detection.available) {
    throw new Error(
      `${manifest.name} is not available: ${detection.reason ?? 'executable not found'}`,
    );
  }
  const configuredModel = manifest.capabilities.modelSelection
    ? settings.agentDefaultModels[input.adapterId]?.trim()
    : undefined;
  const plan = adapter.prepareLaunch({
    prompt: input.prompt,
    cwd,
    permissionProfile: permissionProfile(
      input.permissionProfile,
      cwd,
      false,
      input.adapterId !== 'custom',
    ),
    contextAttachments: input.context.attachments,
    ...(configuredModel === undefined || configuredModel === '' ? {} : { model: configuredModel }),
    executable: detection.executable,
    extraArguments: [],
    environment: { inherit: 'none', variables: environment, unset: [] },
  });
  return {
    adapter,
    plan,
    detectionWarnings: [...detection.capabilityWarnings],
    trustedExtensionAdapter: trustedManifest !== undefined,
  };
}

async function prepareDockerAdapter(
  adapter: CliAgentAdapter,
  input: AgentExecutionRequest,
  cwd: string,
  settings: AppSettings,
  environment: Record<string, string>,
  trustedExtensionAdapter: boolean,
): Promise<AgentRuntimeAdapterPlan> {
  if (!settings.dockerEnabled) {
    throw new Error('Enable and configure Docker isolation in Settings before using it.');
  }
  if (settings.dockerMountHostCredentials) {
    throw new Error(
      'The safe Docker profile does not mount host credentials. Disable that legacy setting and authenticate inside the selected image.',
    );
  }
  const runtime = await checkDockerReadiness({
    dockerExecutable: settings.dockerExecutable,
    image: settings.dockerImage,
    containerExecutable: settings.dockerContainerExecutable,
  });
  if (!runtime.available) {
    throw new Error(`Docker isolation is unavailable: ${runtime.reason ?? 'probe failed'}`);
  }
  const configuredModel = adapter.manifest.capabilities.modelSelection
    ? settings.agentDefaultModels[input.adapterId]?.trim()
    : undefined;
  const providerPlan = adapter.prepareLaunch({
    prompt: input.prompt,
    cwd,
    permissionProfile: permissionProfile(
      'worktree-write',
      cwd,
      false,
      input.adapterId !== 'custom',
    ),
    contextAttachments: input.context.attachments,
    ...(configuredModel === undefined || configuredModel === '' ? {} : { model: configuredModel }),
    executable: adapter.manifest.executable.command,
    extraArguments: [],
    environment: { inherit: 'none', variables: environment, unset: [] },
  });
  const plan = await planDockerAgentLaunch(providerPlan, {
    assignedWorktreePath: cwd,
    worktreeAccess: 'read-write',
    dockerExecutable: runtime.executable,
    image: settings.dockerImage,
    containerExecutable: settings.dockerContainerExecutable,
    userId: positiveContainerIdentity(process.getuid?.()),
    groupId: positiveContainerIdentity(process.getgid?.()),
    cpuLimit: settings.dockerCpuLimit,
    memoryLimitMb: settings.dockerMemoryMb,
    pidsLimit: 256,
    tmpfsSizeMb: 128,
    network:
      settings.dockerNetwork === 'enabled'
        ? { mode: 'bridge', explicitlyApproved: true }
        : { mode: 'none' },
    environmentAllowlist: settings.envAllowlist.filter((name) =>
      DOCKER_SAFE_ENVIRONMENT_NAMES.has(name),
    ),
  });
  return { adapter, plan, detectionWarnings: [], trustedExtensionAdapter };
}

function allowedEnvironment(names: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = process.env[name];
      return value === undefined || value.includes('\0') ? [] : [[name, value]];
    }),
  );
}

function positiveContainerIdentity(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : 1000;
}

function permissionProfile(
  requested: Exclude<AgentExecutionRequest['permissionProfile'], 'docker-isolated'>,
  cwd: string,
  deterministicTestAgent: boolean,
  providerPermissionEnforced = true,
): PermissionProfile {
  const writable = requested === 'worktree-write';
  if (deterministicTestAgent) {
    return {
      id: `test-agent-${requested}`,
      name: writable ? 'Test agent in a dedicated worktree' : 'Test agent read-only plan',
      mode: 'custom',
      enforcement: 'disclosure-only',
      readRoots: [cwd],
      writeRoots: writable ? [cwd] : [],
      network: 'blocked',
      approvalPolicy: 'The exact deterministic action list requires approval before launch.',
      disclosure: writable
        ? 'The local deterministic agent is instructed to write only inside this dedicated worktree.'
        : 'The local deterministic agent receives an action list with no filesystem writes.',
    };
  }
  return {
    id: requested,
    name: writable
      ? 'Dedicated worktree write'
      : providerPermissionEnforced
        ? 'Plan and read only'
        : 'Plan requested (disclosure only)',
    mode: requested,
    enforcement: providerPermissionEnforced ? 'provider' : 'disclosure-only',
    readRoots: [cwd],
    writeRoots: writable ? [cwd] : [],
    network: 'provider-controlled',
    approvalPolicy: 'The exact process launch requires approval in Forgeboard.',
    disclosure: providerPermissionEnforced
      ? writable
        ? 'The provider is asked to confine writes to the dedicated worktree.'
        : 'The provider is asked to run in its plan/read-only mode.'
      : writable
        ? 'The custom process starts in a dedicated worktree, but it has the operating-system permissions of the current user.'
        : 'The custom process is asked to plan only, but no provider-specific flag enforces read-only access.',
  };
}

function testAgentActions(input: AgentExecutionRequest, runId: string): TestAgentAction[] {
  const actions: TestAgentAction[] = [
    { type: 'emit', stream: 'stdout', data: 'Forgeboard deterministic agent started.\n' },
  ];
  if (input.permissionProfile === 'worktree-write') {
    actions.push({
      type: 'write-file',
      path: `forgeboard-agent-output-${runId.slice(0, 8)}.md`,
      content: [
        '# Forgeboard deterministic agent output',
        '',
        'This file was created in a dedicated Git worktree after explicit launch approval.',
        '',
        '## Request',
        '',
        input.prompt,
        '',
      ].join('\n'),
      encoding: 'utf8',
    });
  } else {
    actions.push({
      type: 'emit',
      stream: 'stdout',
      data: 'Read-only plan completed without filesystem writes.\n',
    });
  }
  actions.push({
    type: 'complete',
    metadata: { permissionProfile: input.permissionProfile, runId },
  });
  return actions;
}
