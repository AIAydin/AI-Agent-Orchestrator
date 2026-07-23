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
    label: 'Read and plan only',
    description:
      'Ask the provider to read and plan without writing. The launch review shows whether that request is enforced or advisory.',
  },
  {
    value: 'worktree-write',
    label: 'Write in a worktree',
    description:
      'The agent works in its own copy of your project (a Git worktree). You review its changes before they reach your main branch.',
  },
  {
    value: 'docker-isolated',
    label: 'Docker isolated',
    description:
      'The agent runs inside Docker, limited to one worktree and kept away from the rest of your system.',
  },
  {
    value: 'custom',
    label: 'Custom',
    description:
      'Use the access rules from Settings. Docker enforces its limits; rules for runs on this computer are stated to the agent, not enforced by the operating system.',
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
): string | null {
  const dockerRuntime =
    profile === 'docker-isolated' ||
    (profile === 'custom' && settings.customPermissionProfile.runtime === 'docker');
  if (!dockerRuntime) return null;
  if (!settings.dockerEnabled) {
    return 'Turn on and set up Docker in Settings to use this profile.';
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
  return parsed.success ? [] : [...new Set(parsed.error.issues.map((issue) => issue.message))];
}

export function configuredFilesystemLabel(
  filesystem: AppSettings['customPermissionProfile']['filesystem'],
): string {
  switch (filesystem) {
    case 'assigned-worktree-read-only':
      return 'Assigned worktree · read-only';
    case 'assigned-worktree-write':
      return 'Assigned worktree · read and write';
    case 'explicit-paths':
      return 'Specific folders in the assigned worktree';
  }
}

export function accessPolicyWord(value: string): string {
  return value === 'allow' ? 'allowed' : 'not allowed';
}

export function networkModeWord(value: string): string {
  return value === 'enabled' ? 'on' : 'off';
}
