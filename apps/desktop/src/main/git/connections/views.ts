import {
  classifyConfiguredRemoteTarget,
  remoteEntryProperty,
  type GitConfiguredRemote,
  type GitManagedRemoteTarget,
  type GitRemoteConfigurationPlan,
  type GitRemoteConfigurationSnapshot,
} from '@forgeboard/git-engine';

import {
  GitConnectionRemoteNameSchema,
  type GitConnectionMutationPlanView,
  type GitConnectionRemoteView,
  type GitConnectionsView,
} from '../../../shared/git/connections/index.js';
import type { GitRemoteDescriptorView } from '../../../shared/git/remote/index.js';

export function gitConnectionsView(
  project: { readonly id: string; readonly name: string },
  snapshot: GitRemoteConfigurationSnapshot,
  capturedAt: string,
): GitConnectionsView {
  return {
    projectId: project.id,
    projectName: safeProjectName(project.name),
    configurationRevision: snapshot.configurationRevision,
    remotes: snapshot.remotes.map((remote) =>
      gitConnectionRemoteView(snapshot.identity.repositoryRoot, remote),
    ),
    capturedAt,
  };
}

export function gitConnectionPlanView(input: {
  readonly planId: string;
  readonly expiresAt: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly plan: GitRemoteConfigurationPlan;
}): GitConnectionMutationPlanView {
  return {
    kind: 'git-remote-mutation',
    planId: input.planId,
    expiresAt: input.expiresAt,
    projectId: input.projectId,
    projectName: safeProjectName(input.projectName),
    sourceRevision: input.plan.configurationRevision,
    operation: input.plan.kind,
    remoteName: input.plan.name,
    before:
      input.plan.before === null
        ? null
        : gitConnectionRemoteView(input.plan.repositoryRoot, input.plan.before),
    after:
      input.plan.target === null
        ? null
        : gitConnectionTargetView(input.plan.name, input.plan.target),
    remoteTrackingRefs: input.plan.removal?.trackingRefs.map((ref) => ref.name) ?? [],
    networkAccess: false,
  };
}

export function gitConnectionRemoteView(
  repositoryRoot: string,
  remote: GitConfiguredRemote,
): GitConnectionRemoteView {
  const fetch = remote.target === null ? null : gitConnectionTargetView(remote.name, remote.target);
  const pushTarget =
    remote.pushUrls.length === 0
      ? remote.target
      : classifyConfiguredRemoteTarget(repositoryRoot, remote.pushUrls).target;
  const push = pushTarget === null ? null : gitConnectionTargetView(remote.name, pushTarget);
  const mutableName = GitConnectionRemoteNameSchema.safeParse(remote.name).success;
  const simple =
    mutableName &&
    remote.directLocalConfiguration &&
    !remote.ambiguous &&
    remote.urls.length === 1 &&
    remote.pushUrls.length === 0 &&
    remote.target !== null &&
    !remote.entries.some((entry) => remoteEntryProperty(entry.key) === 'vcs');
  const management =
    !mutableName || !remote.directLocalConfiguration || remote.ambiguous
      ? 'effective-only'
      : simple
        ? 'managed-simple'
        : 'managed-complex';
  return {
    name: remote.name,
    fetch,
    push,
    management,
    warning:
      management === 'managed-simple'
        ? null
        : !mutableName
          ? "This remote's name contains characters Forgeboard cannot safely edit, so it is read-only here."
          : management === 'effective-only'
            ? 'This remote comes from inherited or unclear Git settings, so it is read-only here.'
            : 'This remote uses advanced settings. It can be removed only after you review the exact change.',
  };
}

export function gitConnectionTargetView(
  name: string,
  target: GitManagedRemoteTarget,
): GitRemoteDescriptorView {
  if (target.kind === 'local-filesystem') {
    return {
      kind: 'local-filesystem',
      name,
      endpoint: 'local-filesystem',
      resource: 'Local Git repository',
      transport: 'local',
      githubCompatible: false,
    };
  }
  return {
    kind: 'network',
    name,
    endpoint: target.endpoint,
    resource: target.resource,
    transport: target.transport,
    githubCompatible: githubCompatible(target.endpoint, target.resource),
  };
}

function githubCompatible(endpoint: string, resource: string): boolean {
  const normalized = resource.replace(/\.git$/iu, '');
  return !endpoint.includes(':') && /^[^/\s]+\/[^/\s]+$/u.test(normalized);
}

function safeProjectName(value: string): string {
  const normalized = [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 31 && code !== 127;
    })
    .join('')
    .trim();
  return normalized === '' ? 'Selected repository' : normalized.slice(0, 512);
}
