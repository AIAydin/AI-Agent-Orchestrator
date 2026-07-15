import {
  CustomPermissionProfileSettingsSchema,
  type AppSettings,
  type PermissionProfile,
} from '../../../../shared/application/contracts.js';

export const PERMISSION_PROFILE_OPTIONS: readonly {
  value: PermissionProfile;
  label: string;
  description: string;
}[] = [
  {
    value: 'plan-read-only',
    label: 'Plan / read-only',
    description: 'Ask the provider for a read-only plan in the primary checkout.',
  },
  {
    value: 'worktree-write',
    label: 'Worktree write',
    description: 'Give the agent a dedicated, reviewable Git worktree.',
  },
  {
    value: 'docker-isolated',
    label: 'Docker isolated',
    description: 'Use a non-root container with one assigned worktree mount.',
  },
  {
    value: 'custom',
    label: 'Custom',
    description:
      'Use the filesystem, runtime, and Forgeboard action policy configured in Settings.',
  },
] as const;

export function permissionProfileLabel(profile: PermissionProfile): string {
  return (
    PERMISSION_PROFILE_OPTIONS.find((candidate) => candidate.value === profile)?.label ?? profile
  );
}

export function permissionProfileUnavailableReason(
  profile: PermissionProfile,
  settings: AppSettings,
  adapterId: string,
): string | null {
  const dockerRuntime =
    profile === 'docker-isolated' ||
    (profile === 'custom' && settings.customPermissionProfile.runtime === 'docker');
  if (!dockerRuntime) return null;
  if (adapterId === 'test-agent') {
    return 'The bundled deterministic agent runs directly and is not available in Docker.';
  }
  if (!settings.dockerEnabled) {
    return 'Enable and configure Docker in Settings before using this profile.';
  }
  return null;
}

export function permissionProfileNeedsDocker(
  profile: PermissionProfile,
  settings: Pick<AppSettings, 'customPermissionProfile'>,
): boolean {
  return (
    profile === 'docker-isolated' ||
    (profile === 'custom' && settings.customPermissionProfile.runtime === 'docker')
  );
}

export function customPermissionConfigurationIssues(settings: AppSettings): readonly string[] {
  const parsed = CustomPermissionProfileSettingsSchema.safeParse(settings.customPermissionProfile);
  const issues = parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
  if (
    settings.defaultPermissionProfile === 'custom' &&
    settings.customPermissionProfile.runtime === 'docker' &&
    settings.defaultAgent === 'test-agent'
  ) {
    issues.push('Choose a container-ready default agent before making Docker Custom the default.');
  }
  return [...new Set(issues)];
}

export function configuredFilesystemLabel(
  filesystem: AppSettings['customPermissionProfile']['filesystem'],
): string {
  switch (filesystem) {
    case 'assigned-worktree-read-only':
      return 'Assigned worktree · declared read-only';
    case 'assigned-worktree-write':
      return 'Assigned worktree · read and write';
    case 'explicit-paths':
      return 'Explicit assigned-worktree-relative paths';
  }
}
