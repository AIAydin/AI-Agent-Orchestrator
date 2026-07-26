import {
  CliAgentAdapter,
  AgentAdapterManifestSchema,
  detectDockerRuntime,
  getBuiltInAgentManifest,
  locateAgentExecutable,
  planDockerAgentLaunch,
  PreparedAgentLaunchSchema,
  type AgentAdapterManifest,
  type PermissionProfile,
} from '@forgeboard/agent-adapters';

import type { AppSettings } from '../../shared/application/contracts.js';
import { customAgentManifest } from '../custom-agent/custom-agent.js';
import { resolveDockerExecutable } from '../docker/docker-runtime.js';
import type {
  AgentAdapterPlanner,
  AgentExecutionRequest,
  AgentPreparationProcessAuthorization,
  AgentRuntimeAdapterPlan,
  TrustedAdapterLookup,
} from './contracts.js';
import {
  assertCustomAttachmentsWithinReadRoots,
  resolveCustomDockerPermission,
  resolveCustomHostPermission,
  type ResolvedCustomPermission,
} from './custom-permission.js';
import {
  assertLaunchExecutableIdentity,
  captureLaunchExecutableIdentity,
} from './launch-integrity.js';

const DOCKER_SAFE_ENVIRONMENT_NAMES = new Set(['COLORTERM', 'LANG', 'LC_ALL', 'TERM']);

export interface DefaultAgentAdapterPlannerOptions {
  readonly getTrustedAdapter: TrustedAdapterLookup;
}

export function createDefaultAgentAdapterPlanner({
  getTrustedAdapter,
}: DefaultAgentAdapterPlannerOptions): AgentAdapterPlanner {
  return async (input, cwd, settings, _runId, processAuthorization, resumeSessionId) =>
    await prepareAdapter(
      input,
      cwd,
      settings,
      { getTrustedAdapter },
      processAuthorization,
      resumeSessionId,
    );
}

async function prepareAdapter(
  input: AgentExecutionRequest,
  cwd: string,
  settings: AppSettings,
  dependencies: DefaultAgentAdapterPlannerOptions,
  processAuthorization?: AgentPreparationProcessAuthorization,
  resumeSessionId?: string,
): Promise<AgentRuntimeAdapterPlan> {
  const environment = allowedEnvironment(settings.envAllowlist);
  const settingsManifest =
    input.adapterId === 'custom' ? customAgentManifest(settings.customAgent) : undefined;
  const builtInManifest = getBuiltInAgentManifest(input.adapterId) ?? settingsManifest;
  const trustedManifest =
    builtInManifest === undefined
      ? await dependencies.getTrustedAdapter(input.adapterId)
      : undefined;
  const baseManifest = builtInManifest ?? trustedManifest;
  const manifest =
    baseManifest === undefined ? undefined : reviewerProtocolManifest(baseManifest, input);
  if (manifest === undefined) throw new Error(`No adapter is registered for ${input.adapterId}.`);
  assertModelSelectionSupported(input, manifest);
  const adapter = new CliAgentAdapter(manifest);

  if (
    input.permissionProfile === 'docker-isolated' ||
    (input.permissionProfile === 'custom' && settings.customPermissionProfile.runtime === 'docker')
  ) {
    return await prepareDockerAdapter(
      adapter,
      input,
      cwd,
      settings,
      environment,
      trustedManifest !== undefined,
      processAuthorization,
      resumeSessionId,
    );
  }

  const executableOverride =
    input.adapterId === 'custom'
      ? manifest.executable.command
      : settings.agentExecutableOverrides[input.adapterId]?.trim();
  const location = await locateAgentExecutable(manifest, {
    ...(executableOverride === undefined || executableOverride === ''
      ? {}
      : { executable: executableOverride }),
    cwd,
  });
  if (!location.available || location.executable === null) {
    throw new Error(
      `${manifest.name} is not available: ${location.reason ?? 'executable not found'}`,
    );
  }
  const custom =
    input.permissionProfile === 'custom'
      ? await resolveCustomHostPermission(
          settings.customPermissionProfile,
          cwd,
          location.executable,
          input.prompt,
        )
      : undefined;
  if (custom !== undefined) {
    assertCustomAttachmentsWithinReadRoots(custom, input.context.attachments);
  }
  const configuredModel = manifest.capabilities.modelSelection
    ? (input.model ?? settings.agentDefaultModels[input.adapterId]?.trim())
    : undefined;
  const request: Parameters<CliAgentAdapter['prepareLaunch']>[0] = {
    prompt: custom?.prompt ?? input.prompt,
    cwd,
    permissionProfile:
      custom === undefined
        ? permissionProfile(
            // Headless runs provision a worktree for every writable profile, so a
            // "Write in current directory" node discloses as worktree-write here.
            input.permissionProfile === 'project-write'
              ? 'worktree-write'
              : input.permissionProfile,
            cwd,
            input.adapterId !== 'custom',
          )
        : providerBaseProfile(manifest, custom, cwd),
    contextAttachments: input.context.attachments,
    ...(configuredModel === undefined || configuredModel === '' ? {} : { model: configuredModel }),
    executable: location.executable,
    extraArguments: [],
    environment: { inherit: 'none', variables: environment, unset: [] },
  };
  const plan =
    resumeSessionId === undefined
      ? adapter.prepareLaunch(request)
      : adapter.prepareResume({ ...request, sessionId: resumeSessionId });
  const executableIdentity = await captureLaunchExecutableIdentity(location.executable);
  return {
    adapter,
    plan: custom === undefined ? plan : applyCustomDisclosure(plan, custom),
    detectionWarnings: [],
    trustedExtensionAdapter: trustedManifest !== undefined,
    revalidateBeforeLaunch: async () => {
      await assertLaunchExecutableIdentity(executableIdentity);
    },
  };
}

function reviewerProtocolManifest(
  manifest: AgentAdapterManifest,
  input: AgentExecutionRequest,
): AgentAdapterManifest {
  if (!input.reviewerProtocol) return manifest;
  if (manifest.id === 'codex') {
    return AgentAdapterManifestSchema.parse({
      ...manifest,
      capabilities: { ...manifest.capabilities, resume: false },
      invocation: {
        ...manifest.invocation,
        runtime: 'pipes',
        launchArguments: [
          'exec',
          '--json',
          '{permissionArgs}',
          '{modelArgs}',
          '{extraArgs}',
          '{prompt}',
        ],
        resumeArguments: undefined,
        output: 'json-lines',
      },
    });
  }
  if (manifest.id === 'claude') {
    return AgentAdapterManifestSchema.parse({
      ...manifest,
      capabilities: { ...manifest.capabilities, resume: false },
      invocation: {
        ...manifest.invocation,
        runtime: 'pipes',
        launchArguments: [
          '-p',
          '--verbose',
          '--output-format',
          'stream-json',
          '{permissionArgs}',
          '{modelArgs}',
          '{extraArgs}',
          '{prompt}',
        ],
        resumeArguments: undefined,
        output: 'json-lines',
      },
    });
  }
  throw new Error(
    `Adapter ${manifest.id} cannot emit the strict structured reviewer protocol in this build.`,
  );
}

function assertModelSelectionSupported(
  input: AgentExecutionRequest,
  manifest: { readonly name: string; readonly capabilities: { readonly modelSelection: boolean } },
): void {
  if (input.model !== undefined && !manifest.capabilities.modelSelection) {
    throw new Error(`${manifest.name} does not support selecting a model.`);
  }
}

async function prepareDockerAdapter(
  adapter: CliAgentAdapter,
  input: AgentExecutionRequest,
  cwd: string,
  settings: AppSettings,
  environment: Record<string, string>,
  trustedExtensionAdapter: boolean,
  processAuthorization?: AgentPreparationProcessAuthorization,
  resumeSessionId?: string,
): Promise<AgentRuntimeAdapterPlan> {
  if (processAuthorization === undefined) {
    throw new Error(
      'Docker agent preparation requires an owner-bound native probe approval before any configured executable can run.',
    );
  }
  if (!settings.dockerEnabled) {
    throw new Error('Enable and configure Docker isolation in Settings before using it.');
  }
  if (settings.dockerMountHostCredentials) {
    throw new Error(
      'The safe Docker profile does not mount host credentials. Disable that legacy setting and authenticate inside the selected image.',
    );
  }
  const custom =
    input.permissionProfile === 'custom'
      ? await resolveCustomDockerPermission(
          settings.customPermissionProfile,
          cwd,
          settings.dockerContainerExecutable,
          input.prompt,
        )
      : undefined;
  if (custom !== undefined) {
    assertCustomAttachmentsWithinReadRoots(custom, input.context.attachments);
  }
  const dockerExecutable = await resolveDockerExecutable(settings.dockerExecutable);
  const dockerExecutableIdentity = await captureLaunchExecutableIdentity(dockerExecutable);
  const runtime = await detectDockerRuntime(
    {
      dockerExecutable,
      image: settings.dockerImage,
      timeoutMs: 5_000,
    },
    dockerProbeHooks(processAuthorization),
  );
  if (!runtime.available) {
    throw new Error(`Docker isolation is unavailable: ${runtime.reason ?? 'probe failed'}`);
  }
  await assertLaunchExecutableIdentity(dockerExecutableIdentity);
  if (runtime.imageId === undefined || runtime.imageId.trim() === '') {
    throw new Error('Docker isolation is unavailable: the selected image has no stable image ID.');
  }
  const approvedImageId = runtime.imageId;
  const configuredModel = adapter.manifest.capabilities.modelSelection
    ? (input.model ?? settings.agentDefaultModels[input.adapterId]?.trim())
    : undefined;
  const providerRequest: Parameters<CliAgentAdapter['prepareLaunch']>[0] = {
    prompt: custom?.prompt ?? input.prompt,
    cwd,
    permissionProfile:
      custom === undefined
        ? permissionProfile('worktree-write', cwd, input.adapterId !== 'custom')
        : providerBaseProfile(adapter.manifest, custom, cwd),
    contextAttachments: input.context.attachments,
    ...(configuredModel === undefined || configuredModel === '' ? {} : { model: configuredModel }),
    executable: adapter.manifest.executable.command,
    extraArguments: [],
    environment: { inherit: 'none', variables: environment, unset: [] },
  };
  const providerPlan =
    resumeSessionId === undefined
      ? adapter.prepareLaunch(providerRequest)
      : adapter.prepareResume({ ...providerRequest, sessionId: resumeSessionId });
  const dockerPolicy = custom?.profile.custom;
  const plan = await planDockerAgentLaunch(providerPlan, {
    assignedWorktreePath: cwd,
    worktreeAccess: custom?.worktreeAccess ?? 'read-write',
    dockerExecutable: runtime.executable,
    image: approvedImageId,
    containerExecutable: settings.dockerContainerExecutable,
    userId: positiveContainerIdentity(process.getuid?.()),
    groupId: positiveContainerIdentity(process.getgid?.()),
    cpuLimit:
      custom === undefined
        ? settings.dockerCpuLimit
        : settings.customPermissionProfile.docker.cpuLimit,
    memoryLimitMb:
      custom === undefined
        ? settings.dockerMemoryMb
        : settings.customPermissionProfile.docker.memoryMb,
    pidsLimit: 256,
    tmpfsSizeMb: 128,
    network:
      (custom === undefined
        ? settings.dockerNetwork
        : settings.customPermissionProfile.docker.network) === 'enabled'
        ? { mode: 'bridge', explicitlyApproved: true }
        : { mode: 'none' },
    environmentAllowlist: settings.envAllowlist.filter((name) =>
      DOCKER_SAFE_ENVIRONMENT_NAMES.has(name),
    ),
    virtualContextAttachments:
      input.context.generatedArtifacts?.map((artifact) => ({
        path: artifact.path,
        kind: 'file' as const,
        explicitlyApproved: true as const,
        sha256: artifact.sha256,
      })) ?? [],
  });
  const imageBindingWarning = `Docker image ${settings.dockerImage} was reviewed as immutable image ID ${approvedImageId}; the approved launch uses that exact ID.`;
  const dockerPreflightWarning =
    'Plan preparation invoked only the identity-bound Docker client for bounded daemon/version and image-metadata inspection; it did not run the image or its agent entrypoint.';
  const boundPlan = PreparedAgentLaunchSchema.parse({
    ...plan,
    disclosure: {
      ...plan.disclosure,
      warnings: [
        ...new Set([...plan.disclosure.warnings, imageBindingWarning, dockerPreflightWarning]),
      ],
    },
  });
  return {
    adapter,
    plan:
      custom === undefined
        ? boundPlan
        : PreparedAgentLaunchSchema.parse({
            ...boundPlan,
            disclosure: {
              ...boundPlan.disclosure,
              permissionProfile: custom.profile,
              warnings: [
                ...new Set([
                  ...providerPlan.disclosure.warnings,
                  ...boundPlan.disclosure.warnings,
                  custom.profile.disclosure,
                  ...(dockerPolicy === undefined ? [] : dockerPolicy.policyLimitations),
                ]),
              ],
            },
          }),
    detectionWarnings: [],
    trustedExtensionAdapter,
    revalidateBeforeLaunch: async () => {
      await assertLaunchExecutableIdentity(dockerExecutableIdentity);
      const current = await detectDockerRuntime(
        {
          dockerExecutable: runtime.executable,
          image: settings.dockerImage,
          timeoutMs: 5_000,
        },
        dockerProbeHooks(processAuthorization),
      );
      if (!current.available || current.imageId !== approvedImageId) {
        throw new Error('The reviewed Docker image changed. Review what will run.');
      }
      await assertLaunchExecutableIdentity(dockerExecutableIdentity);
    },
  };
}

function dockerProbeHooks(authorization: AgentPreparationProcessAuthorization | undefined) {
  return authorization === undefined
    ? {}
    : {
        beforeProbe: async (probe: {
          readonly executable: string;
          readonly arguments: readonly string[];
        }) => {
          await authorization.authorize(probe.executable, probe.arguments);
        },
      };
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
  requested: Exclude<
    AgentExecutionRequest['permissionProfile'],
    'docker-isolated' | 'project-write'
  >,
  cwd: string,
  providerPermissionEnforced = true,
): PermissionProfile {
  const writable = requested === 'worktree-write';
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

function providerBaseProfile(
  manifest: AgentAdapterManifest,
  custom: ResolvedCustomPermission,
  cwd: string,
): PermissionProfile {
  const preferred = custom.worktreeAccess === 'read-only' ? 'plan-read-only' : 'worktree-write';
  const requested = manifest.capabilities.permissionModes.includes(preferred)
    ? preferred
    : manifest.capabilities.permissionModes.includes('custom')
      ? 'custom'
      : undefined;
  if (requested === undefined) {
    throw new Error(
      `${manifest.name} does not support a permission mode compatible with this Custom profile.`,
    );
  }
  if (requested === 'custom') return custom.profile;
  const providerPermissionEnforced =
    (manifest.invocation.permissionArguments[requested]?.length ?? 0) > 0;
  return permissionProfile(requested, cwd, providerPermissionEnforced);
}

function applyCustomDisclosure(
  plan: ReturnType<CliAgentAdapter['prepareLaunch']>,
  custom: ResolvedCustomPermission,
) {
  return PreparedAgentLaunchSchema.parse({
    ...plan,
    disclosure: {
      ...plan.disclosure,
      permissionProfile: custom.profile,
      warnings: [...new Set([...plan.disclosure.warnings, custom.profile.disclosure])],
    },
  });
}
