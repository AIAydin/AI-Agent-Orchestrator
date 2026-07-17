import { createHash, randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  AppSettingsSchema,
  CustomAgentConfigurationSchema,
  CustomChecksSchema,
  GitRemoteSettingSchema,
  type AppSettings,
} from '../../../shared/application/contracts.js';
import { CommandConfigurationSchema } from '../../../shared/commands/configuration.js';
import {
  DockerContainerExecutableSchema,
  DockerExecutableSettingSchema,
} from '../../../shared/docker/contracts.js';
import { CustomPermissionProfileSettingsSchema } from '../../../shared/permissions/contracts.js';
import {
  MachineSpecificPathSchema,
  normalizePreviewLoopbackHost,
  OptionalMachineSpecificPathSchema,
  OptionalMachineSpecificValueSchema,
  PreviewTrustedHostsSchema,
} from '../../../shared/settings/values.js';
import {
  SettingsRepairEvidenceSchema,
  type SettingsRepairEvidence,
  type SettingsRepairFieldPath,
} from '../../../shared/settings/repair/contracts.js';
import {
  LegacyAgentExecutableOverridesSchema,
  LegacyBackupDirectorySchema,
  LegacyCommandConfigurationSchema,
  LegacyCustomAgentConfigurationSchema,
  LegacyCustomChecksSchema,
  LegacyCustomPermissionProfileSchema,
  LegacyDockerContainerExecutableSchema,
  LegacyDockerExecutableSchema,
  LegacyGitRemoteSchema,
  LegacyPreviewTrustedHostsSchema,
  LegacyTerminalShellSchema,
  LegacyWorktreeRootSchema,
} from './legacy-schemas.js';
import { assertSettingsRepairEvidenceValue } from './limits.js';

const CurrentAgentOverridesSchema = z.record(z.string(), OptionalMachineSpecificValueSchema);
const commandFields = [
  'developmentCommand',
  'testCommand',
  'lintCommand',
  'typecheckCommand',
  'buildCommand',
] as const;

export interface PlannedSettingsRepair {
  readonly settings: AppSettings;
  readonly evidence: SettingsRepairEvidence;
}

export function planLegacySettingsRepair(
  sourceSettingsJson: string,
  sourceDatabaseVersion: number,
  defaultsInput: AppSettings,
  now = new Date(),
): PlannedSettingsRepair | undefined {
  assertSettingsRepairEvidenceValue(sourceSettingsJson, 'Stored settings');
  const defaults = AppSettingsSchema.parse(defaultsInput);
  const source = parseObject(sourceSettingsJson);
  if (AppSettingsSchema.safeParse(source).success) return undefined;

  const candidate = structuredClone(source);
  const repaired = new Set<SettingsRepairFieldPath>();
  const mark = (field: SettingsRepairFieldPath): void => {
    repaired.add(field);
  };

  repairAgentOverrides(candidate, mark);
  repairCustomAgent(candidate, defaults, mark);
  repairPermissionProfile(candidate, defaults, mark);
  repairSimpleField(
    candidate,
    'worktreeRoot',
    MachineSpecificPathSchema,
    LegacyWorktreeRootSchema,
    defaults.worktreeRoot,
    mark,
  );
  repairSimpleField(
    candidate,
    'gitRemote',
    GitRemoteSettingSchema,
    LegacyGitRemoteSchema,
    defaults.gitRemote,
    mark,
  );
  repairSimpleField(
    candidate,
    'terminalShell',
    OptionalMachineSpecificValueSchema,
    LegacyTerminalShellSchema,
    defaults.terminalShell,
    mark,
  );
  for (const field of commandFields) repairCommand(candidate, field, defaults[field], mark);
  repairCustomChecks(candidate, mark);
  repairPreviewHosts(candidate, defaults, mark);
  const resetDocker = repairDocker(candidate, defaults, mark);
  repairBackupDirectory(candidate, defaults, mark);
  repairDependentDefaults(candidate, defaults, resetDocker, mark);

  if (repaired.size === 0) throw unsafeLegacySettingsError();
  const parsed = AppSettingsSchema.safeParse(candidate);
  if (!parsed.success) throw unsafeLegacySettingsError(parsed.error);

  const repairedSettingsJson = JSON.stringify(parsed.data);
  assertSettingsRepairEvidenceValue(repairedSettingsJson, 'Repaired settings');
  const evidence = SettingsRepairEvidenceSchema.parse({
    id: randomUUID(),
    repairedAt: now.toISOString(),
    sourceDatabaseVersion,
    repairedFieldPaths: [...repaired],
    sourceSettingsSha256: sha256(sourceSettingsJson),
    repairedSettingsSha256: sha256(repairedSettingsJson),
    sourceSettingsJson,
    repairedSettingsJson,
  });
  return { settings: parsed.data, evidence };
}

function repairAgentOverrides(
  candidate: Record<string, unknown>,
  mark: (field: SettingsRepairFieldPath) => void,
): void {
  if (candidate.agentExecutableOverrides === undefined) return;
  if (CurrentAgentOverridesSchema.safeParse(candidate.agentExecutableOverrides).success) return;
  const legacy = LegacyAgentExecutableOverridesSchema.safeParse(candidate.agentExecutableOverrides);
  if (!legacy.success) throw unsafeLegacySettingsError(legacy.error);
  candidate.agentExecutableOverrides = Object.fromEntries(
    Object.entries(legacy.data).filter(
      ([, executable]) => OptionalMachineSpecificValueSchema.safeParse(executable).success,
    ),
  );
  mark('agentExecutableOverrides');
}

function repairCustomAgent(
  candidate: Record<string, unknown>,
  defaults: AppSettings,
  mark: (field: SettingsRepairFieldPath) => void,
): void {
  if (candidate.customAgent === undefined) return;
  if (CustomAgentConfigurationSchema.safeParse(candidate.customAgent).success) return;
  const legacy = LegacyCustomAgentConfigurationSchema.safeParse(candidate.customAgent);
  if (!legacy.success) throw unsafeLegacySettingsError(legacy.error);
  candidate.customAgent = CustomAgentConfigurationSchema.parse({
    ...legacy.data,
    enabled: false,
    executable: defaults.customAgent.executable,
  });
  mark('customAgent');
}

function repairPermissionProfile(
  candidate: Record<string, unknown>,
  defaults: AppSettings,
  mark: (field: SettingsRepairFieldPath) => void,
): void {
  if (candidate.customPermissionProfile === undefined) return;
  if (CustomPermissionProfileSettingsSchema.safeParse(candidate.customPermissionProfile).success) {
    return;
  }
  const legacy = LegacyCustomPermissionProfileSchema.safeParse(candidate.customPermissionProfile);
  if (!legacy.success) throw unsafeLegacySettingsError(legacy.error);
  const normalized = CustomPermissionProfileSettingsSchema.safeParse(legacy.data);
  candidate.customPermissionProfile = normalized.success
    ? normalized.data
    : defaults.customPermissionProfile;
  if (!normalized.success && candidate.defaultPermissionProfile === 'custom') {
    candidate.defaultPermissionProfile = defaults.defaultPermissionProfile;
    mark('defaultPermissionProfile');
  }
  mark('customPermissionProfile');
}

function repairSimpleField(
  candidate: Record<string, unknown>,
  field: SettingsRepairFieldPath,
  currentSchema: z.ZodType,
  legacySchema: z.ZodType,
  fallback: unknown,
  mark: (field: SettingsRepairFieldPath) => void,
): void {
  if (candidate[field] === undefined) return;
  if (currentSchema.safeParse(candidate[field]).success) return;
  const legacy = legacySchema.safeParse(candidate[field]);
  if (!legacy.success) throw unsafeLegacySettingsError(legacy.error);
  candidate[field] = fallback;
  mark(field);
}

function repairCommand(
  candidate: Record<string, unknown>,
  field: (typeof commandFields)[number],
  fallback: AppSettings[(typeof commandFields)[number]],
  mark: (field: SettingsRepairFieldPath) => void,
): void {
  if (candidate[field] === undefined) return;
  if (CommandConfigurationSchema.safeParse(candidate[field]).success) return;
  const legacy = LegacyCommandConfigurationSchema.safeParse(candidate[field]);
  if (!legacy.success) throw unsafeLegacySettingsError(legacy.error);
  candidate[field] = {
    executable: fallback.executable,
    arguments: legacy.data.arguments,
  };
  mark(field);
}

function repairCustomChecks(
  candidate: Record<string, unknown>,
  mark: (field: SettingsRepairFieldPath) => void,
): void {
  if (
    candidate.customChecks === undefined ||
    CustomChecksSchema.safeParse(candidate.customChecks).success
  ) {
    return;
  }
  const legacy = LegacyCustomChecksSchema.safeParse(candidate.customChecks);
  if (!legacy.success) throw unsafeLegacySettingsError(legacy.error);
  candidate.customChecks = legacy.data.map((check) => ({
    ...check,
    command: CommandConfigurationSchema.safeParse(check.command).success
      ? check.command
      : { executable: '', arguments: check.command.arguments },
  }));
  mark('customChecks');
}

function repairPreviewHosts(
  candidate: Record<string, unknown>,
  defaults: AppSettings,
  mark: (field: SettingsRepairFieldPath) => void,
): void {
  if (
    candidate.previewTrustedHosts === undefined ||
    PreviewTrustedHostsSchema.safeParse(candidate.previewTrustedHosts).success
  ) {
    return;
  }
  const legacy = LegacyPreviewTrustedHostsSchema.safeParse(candidate.previewTrustedHosts);
  if (!legacy.success) throw unsafeLegacySettingsError(legacy.error);
  const normalized = [
    ...new Set(legacy.data.map(normalizePreviewLoopbackHost).filter(isString)),
  ].slice(0, 128);
  candidate.previewTrustedHosts = normalized.length > 0 ? normalized : defaults.previewTrustedHosts;
  mark('previewTrustedHosts');
}

function repairDocker(
  candidate: Record<string, unknown>,
  defaults: AppSettings,
  mark: (field: SettingsRepairFieldPath) => void,
): boolean {
  let unsafeReset = false;
  if (
    candidate.dockerExecutable !== undefined &&
    !DockerExecutableSettingSchema.safeParse(candidate.dockerExecutable).success
  ) {
    const legacy = LegacyDockerExecutableSchema.safeParse(candidate.dockerExecutable);
    if (!legacy.success) throw unsafeLegacySettingsError(legacy.error);
    const normalized = DockerExecutableSettingSchema.safeParse(legacy.data);
    candidate.dockerExecutable = normalized.success ? normalized.data : defaults.dockerExecutable;
    unsafeReset ||= !normalized.success;
    mark('dockerExecutable');
  }
  const containerSchema = z.union([z.literal(''), DockerContainerExecutableSchema]);
  if (
    candidate.dockerContainerExecutable !== undefined &&
    !containerSchema.safeParse(candidate.dockerContainerExecutable).success
  ) {
    const legacy = z
      .union([z.literal(''), LegacyDockerContainerExecutableSchema])
      .safeParse(candidate.dockerContainerExecutable);
    if (!legacy.success) throw unsafeLegacySettingsError(legacy.error);
    const normalized = containerSchema.safeParse(legacy.data);
    candidate.dockerContainerExecutable = normalized.success
      ? normalized.data
      : defaults.dockerContainerExecutable;
    unsafeReset ||= !normalized.success;
    mark('dockerContainerExecutable');
  }
  if (unsafeReset && candidate.dockerEnabled !== false) {
    candidate.dockerEnabled = false;
    mark('dockerEnabled');
  }
  return unsafeReset;
}

function repairBackupDirectory(
  candidate: Record<string, unknown>,
  defaults: AppSettings,
  mark: (field: SettingsRepairFieldPath) => void,
): void {
  if (
    candidate.backupDirectory === undefined ||
    OptionalMachineSpecificPathSchema.safeParse(candidate.backupDirectory).success
  ) {
    return;
  }
  const legacy = LegacyBackupDirectorySchema.safeParse(candidate.backupDirectory);
  if (!legacy.success) throw unsafeLegacySettingsError(legacy.error);
  candidate.backupDirectory = defaults.backupDirectory;
  mark('backupDirectory');
  if (candidate.backupsEnabled !== false) {
    candidate.backupsEnabled = false;
    mark('backupsEnabled');
  }
}

function repairDependentDefaults(
  candidate: Record<string, unknown>,
  defaults: AppSettings,
  resetDocker: boolean,
  mark: (field: SettingsRepairFieldPath) => void,
): void {
  const customAgent = CustomAgentConfigurationSchema.safeParse(candidate.customAgent);
  if (candidate.defaultAgent === 'custom' && (!customAgent.success || !customAgent.data.enabled)) {
    candidate.defaultAgent = defaults.defaultAgent;
    mark('defaultAgent');
  }
  if (resetDocker && candidate.defaultPermissionProfile === 'docker-isolated') {
    candidate.defaultPermissionProfile = defaults.defaultPermissionProfile;
    mark('defaultPermissionProfile');
  }
  if (resetDocker) {
    const profile = CustomPermissionProfileSettingsSchema.safeParse(
      candidate.customPermissionProfile,
    );
    if (profile.success && profile.data.runtime === 'docker') {
      candidate.customPermissionProfile = defaults.customPermissionProfile;
      mark('customPermissionProfile');
      if (candidate.defaultPermissionProfile === 'custom') {
        candidate.defaultPermissionProfile = defaults.defaultPermissionProfile;
        mark('defaultPermissionProfile');
      }
    }
  }
}

function parseObject(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw unsafeLegacySettingsError(error);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw unsafeLegacySettingsError();
  }
  return parsed as Record<string, unknown>;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isString(value: string | null): value is string {
  return value !== null;
}

function unsafeLegacySettingsError(cause?: unknown): Error {
  return new Error(
    'Stored settings are invalid outside the known legacy compatibility rules; refusing to replace user data.',
    cause === undefined ? undefined : { cause },
  );
}
