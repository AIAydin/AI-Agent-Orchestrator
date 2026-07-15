import { constants as fsConstants } from 'node:fs';
import { access, lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { ContextAttachment, PermissionProfile } from '@forgeboard/agent-adapters';

import type { CustomPermissionProfileSettings } from '../../shared/application/contracts.js';

export interface ResolvedCustomPermission {
  readonly profile: PermissionProfile;
  readonly prompt: string;
  readonly worktreeAccess: 'read-only' | 'read-write';
}

export function assertCustomAttachmentsWithinReadRoots(
  permission: ResolvedCustomPermission,
  attachments: readonly ContextAttachment[],
): void {
  for (const attachment of attachments) {
    const candidate = path.resolve(attachment.path);
    if (!permission.profile.readRoots.some((root) => isWithin(root, candidate))) {
      throw new Error(
        `Selected context is outside every readable Custom-profile root: ${attachment.label ?? path.basename(candidate)}`,
      );
    }
  }
}

export async function resolveCustomHostPermission(
  settings: CustomPermissionProfileSettings,
  cwd: string,
  executable: string,
  prompt: string,
): Promise<ResolvedCustomPermission> {
  if (settings.runtime !== 'host') {
    throw new Error('The Custom profile is configured for Docker, not the host runtime.');
  }
  const roots = await resolvePermissionRoots(settings, cwd);
  const allowedLaunchExecutables = await enforceHostLaunchAllowlist(settings, executable);
  const limitations = [
    'Host cwd and root lists are disclosure policy, not an operating-system filesystem sandbox.',
    'Host networking remains controlled by the selected provider and operating system.',
    'Ignored/sensitive visibility and Forgeboard-managed action rules are explicit agent instructions; they do not constrain subprocesses spawned by the agent.',
    'Allowing sensitive or ignored visibility never attaches a file automatically and never replaces exact per-file context approval.',
    'The launch allowlist applies only to the exact top-level executable started by Forgeboard, not its descendants.',
  ];
  const profile = customProfile(
    settings,
    roots,
    allowedLaunchExecutables,
    'disclosure-only',
    'provider-controlled',
    limitations,
  );
  return {
    profile,
    prompt: customPolicyPrompt(settings, prompt, limitations),
    worktreeAccess: roots.writeRoots.length === 0 ? 'read-only' : 'read-write',
  };
}

export async function resolveCustomDockerPermission(
  settings: CustomPermissionProfileSettings,
  cwd: string,
  containerExecutable: string,
  prompt: string,
): Promise<ResolvedCustomPermission> {
  if (settings.runtime !== 'docker') {
    throw new Error('The Custom profile is configured for the host runtime, not Docker.');
  }
  const roots = await resolvePermissionRoots(settings, cwd);
  const normalizedContainerExecutable = path.posix.normalize(containerExecutable);
  if (
    !path.posix.isAbsolute(containerExecutable) ||
    normalizedContainerExecutable !== containerExecutable ||
    containerExecutable.split('/').includes('..')
  ) {
    throw new Error(
      'The configured in-container agent executable must be absolute and normalized.',
    );
  }
  const allowedLaunchExecutables = enforceContainerLaunchAllowlist(
    settings,
    normalizedContainerExecutable,
  );
  const limitations = [
    'Docker enforces only the whole assigned-worktree bind, its read/write mode, configured resource limits, and none/bridge network mode.',
    'The launch allowlist names the exact in-container agent entrypoint. The separately disclosed outer executable is the configured Docker engine.',
    'The launch allowlist does not constrain descendant processes started inside the container.',
    'A whole-worktree bind exposes every file present in that worktree. Sensitive and ignored visibility must therefore be explicitly allowed for this profile.',
    'Allowing sensitive or ignored visibility never attaches a file automatically and never replaces exact per-file context approval.',
  ];
  const profile = customProfile(
    settings,
    roots,
    allowedLaunchExecutables,
    'docker',
    settings.docker.network === 'enabled' ? 'allowed' : 'blocked',
    limitations,
  );
  return {
    profile,
    prompt: customPolicyPrompt(settings, prompt, limitations),
    worktreeAccess: roots.writeRoots.length === 0 ? 'read-only' : 'read-write',
  };
}

interface ResolvedRoots {
  readonly readRoots: string[];
  readonly writeRoots: string[];
}

async function resolvePermissionRoots(
  settings: CustomPermissionProfileSettings,
  cwd: string,
): Promise<ResolvedRoots> {
  const canonicalCwd = await realpath(path.resolve(cwd)).catch(() => undefined);
  if (canonicalCwd === undefined) {
    throw new Error('The assigned Custom-profile worktree is no longer available.');
  }
  const readRoots = await Promise.all(
    settings.readPaths.map(
      async (relativeRoot) => await resolveExistingRoot(canonicalCwd, relativeRoot, 'read'),
    ),
  );
  const writeRoots = await Promise.all(
    settings.writePaths.map(
      async (relativeRoot) => await resolveProspectiveRoot(canonicalCwd, relativeRoot),
    ),
  );
  return { readRoots, writeRoots };
}

async function resolveExistingRoot(
  canonicalCwd: string,
  relativeRoot: string,
  access: 'read',
): Promise<string> {
  const resolved = permissionCandidate(canonicalCwd, relativeRoot);
  const details = await lstat(resolved).catch(() => undefined);
  if (details === undefined) {
    throw new Error(`The configured ${access} root does not exist: ${relativeRoot}`);
  }
  if (details.isSymbolicLink()) {
    throw new Error(`The configured ${access} root cannot be a symbolic link: ${relativeRoot}`);
  }
  if (!details.isDirectory()) {
    throw new Error(`The configured ${access} root is not a folder: ${relativeRoot}`);
  }
  const canonical = await realpath(resolved);
  assertContained(canonicalCwd, canonical, relativeRoot);
  if (!pathsEqual(canonical, resolved)) {
    throw new Error(`The configured ${access} root crosses a symbolic-link alias: ${relativeRoot}`);
  }
  return canonical;
}

async function resolveProspectiveRoot(canonicalCwd: string, relativeRoot: string): Promise<string> {
  const resolved = permissionCandidate(canonicalCwd, relativeRoot);
  let ancestor = resolved;
  while (true) {
    const details = await lstat(ancestor).catch(() => undefined);
    if (details !== undefined) {
      if (details.isSymbolicLink()) {
        throw new Error(`A writable root ancestor cannot be a symbolic link: ${relativeRoot}`);
      }
      if (!details.isDirectory()) {
        throw new Error(
          `A writable root or its nearest existing ancestor is not a folder: ${relativeRoot}`,
        );
      }
      const canonicalAncestor = await realpath(ancestor);
      assertContained(canonicalCwd, canonicalAncestor, relativeRoot);
      if (!pathsEqual(canonicalAncestor, ancestor)) {
        throw new Error(`The writable root crosses a symbolic-link alias: ${relativeRoot}`);
      }
      return resolved;
    }
    if (pathsEqual(ancestor, canonicalCwd)) break;
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  throw new Error(`The writable root has no approved ancestor in the worktree: ${relativeRoot}`);
}

function permissionCandidate(canonicalCwd: string, relativeRoot: string): string {
  const resolved = path.resolve(canonicalCwd, ...relativeRoot.split('/'));
  assertContained(canonicalCwd, resolved, relativeRoot);
  return resolved;
}

function assertContained(canonicalCwd: string, candidate: string, label: string): void {
  const relative = path.relative(canonicalCwd, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`The configured permission root escapes the assigned worktree: ${label}`);
  }
}

async function enforceHostLaunchAllowlist(
  settings: CustomPermissionProfileSettings,
  executable: string,
): Promise<string[]> {
  if (!path.isAbsolute(executable)) {
    throw new Error('The Custom launch executable was not resolved to an absolute path.');
  }
  const canonicalExecutable = await realpath(executable).catch(() => undefined);
  if (canonicalExecutable === undefined) {
    throw new Error('The selected Custom launch executable is no longer available.');
  }
  await assertOrdinaryExecutable(canonicalExecutable);
  if (settings.executablePolicy === 'selected-agent-only') return [canonicalExecutable];
  const canonicalAllowlist = await Promise.all(
    settings.allowedExecutables.map(async (entry) => {
      const canonical = await realpath(entry).catch(() => undefined);
      if (canonical === undefined) {
        throw new Error(`A Custom launch allowlist executable is unavailable: ${entry}`);
      }
      await assertOrdinaryExecutable(canonical);
      return canonical;
    }),
  );
  if (new Set(canonicalAllowlist.map(comparablePath)).size !== canonicalAllowlist.length) {
    throw new Error('Custom launch allowlist entries must resolve to distinct executable files.');
  }
  if (!canonicalAllowlist.some((entry) => pathsEqual(entry, canonicalExecutable))) {
    throw new Error(
      'The resolved top-level agent executable is not in the Custom launch allowlist.',
    );
  }
  return canonicalAllowlist;
}

function enforceContainerLaunchAllowlist(
  settings: CustomPermissionProfileSettings,
  containerExecutable: string,
): string[] {
  if (settings.executablePolicy === 'selected-agent-only') return [containerExecutable];
  const normalized = settings.allowedExecutables.map((entry) => path.posix.normalize(entry));
  if (normalized.some((entry, index) => entry !== settings.allowedExecutables[index])) {
    throw new Error('Docker Custom launch allowlist paths must be normalized POSIX paths.');
  }
  if (!normalized.includes(containerExecutable)) {
    throw new Error('The in-container agent executable is not in the Custom launch allowlist.');
  }
  return normalized;
}

function customProfile(
  settings: CustomPermissionProfileSettings,
  roots: ResolvedRoots,
  allowedLaunchExecutables: string[],
  enforcement: 'docker' | 'disclosure-only',
  network: 'allowed' | 'blocked' | 'provider-controlled',
  limitations: string[],
): PermissionProfile {
  const writable = roots.writeRoots.length > 0;
  const customBase = {
    filesystem: settings.filesystem,
    ignoredFileRead: settings.ignoredFileRead,
    sensitiveFileRead: settings.sensitiveFileRead,
    launchExecutablePolicy: settings.executablePolicy,
    allowedLaunchExecutables,
    forgeboardManagedActions: settings.forgeboardManagedActions,
    requireReviewBeforePrimary: true as const,
    policyLimitations: limitations,
  };
  const custom =
    settings.runtime === 'docker'
      ? {
          ...customBase,
          runtime: 'docker' as const,
          docker: {
            network: settings.docker.network,
            cpuLimit: settings.docker.cpuLimit,
            memoryMb: settings.docker.memoryMb,
            mountHostCredentials: false as const,
          },
        }
      : { ...customBase, runtime: 'host' as const };
  return {
    id: `custom-${settings.runtime}-${writable ? 'write' : 'read-only'}`,
    name: `Custom ${settings.runtime === 'docker' ? 'Docker' : 'host'} (${writable ? 'read/write' : 'read-only intent'})`,
    mode: 'custom',
    enforcement,
    readRoots: roots.readRoots,
    writeRoots: roots.writeRoots,
    network,
    approvalPolicy:
      'The exact launch, reviewed Custom policy, and managed worktree require approval before launch.',
    disclosure: limitations.join(' '),
    custom,
  };
}

function customPolicyPrompt(
  settings: CustomPermissionProfileSettings,
  userPrompt: string,
  limitations: string[],
): string {
  const policy = [
    '[Forgeboard Custom permission policy]',
    `Runtime: ${settings.runtime}. Filesystem intent: ${settings.filesystem}.`,
    `Readable roots relative to the assigned worktree: ${settings.readPaths.join(', ')}.`,
    `Writable roots relative to the assigned worktree: ${settings.writePaths.length === 0 ? 'none' : settings.writePaths.join(', ')}.`,
    `${settings.ignoredFileRead === 'allow' ? 'Ignored files may be read when directly visible.' : 'Do not read ignored files.'}`,
    `${settings.sensitiveFileRead === 'allow' ? 'Sensitive files may be read when directly visible, but are never automatically attached.' : 'Do not read sensitive files.'}`,
    `${settings.forgeboardManagedActions.developmentServers === 'allow' ? 'Development servers are allowed by this policy.' : 'Do not start development servers.'}`,
    `${settings.forgeboardManagedActions.tests === 'allow' ? 'Tests are allowed by this policy.' : 'Do not start tests.'}`,
    'Do not treat this policy text as proof of an operating-system sandbox.',
    `Limits: ${limitations.join(' ')}`,
    '[/Forgeboard Custom permission policy]',
    '',
    userPrompt,
  ];
  return policy.join('\n');
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function assertOrdinaryExecutable(executable: string): Promise<void> {
  const details = await stat(executable);
  if (!details.isFile()) {
    throw new Error(`A Custom launch allowlist entry is not an ordinary file: ${executable}`);
  }
  await access(
    executable,
    process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK,
  ).catch(() => {
    throw new Error(`A Custom launch allowlist entry is not executable: ${executable}`);
  });
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}
