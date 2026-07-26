import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  exactPushDestination,
  type ExactPushDestination,
  type GitHubRemoteSnapshot,
  type GitRemote,
} from '@forgeboard/git-engine';

import type { OutboundActionDisclosure } from '../outbound-action-gate.js';

const MAX_REMOTE_URL = 2_048;
const MAX_DISCLOSED_ITEMS = 256;
const MAX_DISCLOSED_LIST_CHARACTERS = 24 * 1_024;
const MAX_DISCLOSED_ITEM_CHARACTERS = 2 * 4_096 + 3;

export interface GitRemoteDestination {
  readonly kind: 'local-filesystem' | 'network';
  readonly name: string;
  readonly endpoint: string;
  /** Exact main/native-only resource. May be a local absolute path. */
  readonly resource: string;
  readonly publicResource: string;
  readonly transport: string;
  readonly githubCompatible: boolean;
  readonly exactPush: ExactPushDestination;
}

export interface GitPushDisclosureInput {
  readonly projectName: string;
  readonly destination: GitRemoteDestination;
  readonly sourceBranch: string;
  readonly destinationBranch: string;
  readonly baseCommit: string;
  readonly sourceHead: string;
  readonly commits: readonly string[];
  readonly files: readonly string[];
  readonly additions: number;
  readonly deletions: number;
  readonly readinessEvidence: string;
}

export interface GitHubCliDisclosure {
  readonly source: 'automatic' | 'custom';
  /** False for both a missing executable and an exact detected executable awaiting validation. */
  readonly available: boolean;
  readonly filename: string | null;
  readonly sha256: string | null;
  /** Exact main/native-only path. Never expose this value through renderer IPC. */
  readonly executablePath: string | null;
}

export interface GitHubStatusDisclosureInput {
  readonly projectName: string;
  readonly destination: GitRemoteDestination;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly sourceHead: string;
  readonly githubCli: GitHubCliDisclosure;
}

export interface GitHubPullRequestDisclosureInput extends GitPushDisclosureInput {
  readonly snapshot: GitHubRemoteSnapshot;
  readonly title: string;
  readonly body: string;
  readonly bodySha256: string;
  readonly bodyCharacters: number;
  readonly draft: boolean;
  readonly githubCli: GitHubCliDisclosure;
}

export interface GitHubCiDisclosureInput {
  readonly projectName: string;
  readonly destination: GitRemoteDestination;
  readonly snapshot: GitHubRemoteSnapshot;
  readonly sourceHead: string;
  readonly githubCli: GitHubCliDisclosure;
}

export function gitRemoteDestination(
  remote: GitRemote,
  repositoryPath: string,
): GitRemoteDestination {
  const remoteName = safeRemoteName(remote.name);
  if (remote.hasRedactedCredentials) {
    throw new Error(
      'The selected Git remote contains embedded credentials. Use a credential helper or SSH agent.',
    );
  }
  if (remote.hasMultiplePushUrls) {
    throw new Error(
      'The selected Git remote has multiple push destinations and cannot be approved exactly.',
    );
  }
  const selected = remote.pushUrl ?? remote.fetchUrl;
  if (selected === null) throw new Error('The selected Git remote has no usable URL.');
  const value = boundedSingleLine(selected, 'Git remote URL', MAX_REMOTE_URL);
  if (!value.includes('://')) {
    if (isNetworkSharePath(value)) {
      throw new Error('Network-share Git destinations are not accepted as local repositories.');
    }
    if (path.isAbsolute(value)) {
      return localDestination(
        remoteName,
        path.resolve(value),
        exactPushDestination(value, repositoryPath),
      );
    }
    if (path.win32.isAbsolute(value)) {
      throw new Error('A local Git path from another operating system is not accepted.');
    }
    if (/^[A-Za-z]:/u.test(value)) {
      throw new Error('Drive-relative local Git destinations are not accepted.');
    }
    if (/^[A-Za-z][A-Za-z0-9+.-]*::/u.test(value)) {
      throw new Error('Git remote-helper destinations are not accepted.');
    }
    const scp = /^(?:([^@/:\s]+)@)?([^/:\s]+):(.+)$/u.exec(value);
    if (scp !== null) {
      const username = scp[1];
      if (username !== undefined && username !== 'git') {
        throw new Error('SSH remotes may use only the standard credential-free git account name.');
      }
      const host = normalizedDnsHost(scp[2] ?? '');
      const resource = boundedSingleLine(scp[3] ?? '', 'Git remote resource', 1_024);
      return {
        kind: 'network',
        name: remoteName,
        endpoint: host,
        resource,
        publicResource: publicRemoteResource(resource),
        transport: 'SSH',
        githubCompatible: repositoryLike(resource),
        exactPush: exactPushDestination(value, repositoryPath),
      };
    }
    return localDestination(
      remoteName,
      path.resolve(repositoryPath, value),
      exactPushDestination(value, repositoryPath),
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error('The selected Git remote URL is invalid.', {
      cause: error,
    });
  }
  if (
    !new Set(['file:', 'https:', 'ssh:']).has(parsed.protocol) ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (parsed.username !== '' && !(parsed.protocol === 'ssh:' && parsed.username === 'git'))
  ) {
    throw new Error('The selected Git remote is not a supported credential-free destination.');
  }
  if (parsed.protocol === 'file:') {
    if (parsed.hostname !== '') {
      throw new Error('Hosted file URLs are not accepted as local Git destinations.');
    }
    let decodedPath: string;
    try {
      decodedPath = fileURLToPath(parsed);
    } catch (error) {
      throw new Error('The selected local Git URL has invalid path encoding.', {
        cause: error,
      });
    }
    const exactPath = boundedSingleLine(decodedPath, 'Local Git path', MAX_REMOTE_URL);
    if (exactPath !== decodedPath || isNetworkSharePath(exactPath)) {
      throw new Error('Network-share or ambiguous local Git URLs are not accepted.');
    }
    return localDestination(
      remoteName,
      path.resolve(exactPath),
      exactPushDestination(value, repositoryPath),
    );
  }
  if (value.includes('%')) {
    throw new Error('Percent-encoded network Git resources are not accepted.');
  }
  if (parsed.hostname === '') throw new Error('The selected Git remote has no hostname.');
  const hostname = parsed.hostname.startsWith('[')
    ? parsed.hostname.toLowerCase()
    : normalizedDnsHost(parsed.hostname);
  const endpoint = parsed.port === '' ? hostname : `${hostname}:${parsed.port}`;
  const resource = boundedSingleLine(parsed.pathname, 'Git remote resource', 1_024);
  const publicResource = publicRemoteResource(resource);
  return {
    kind: 'network',
    name: remoteName,
    endpoint,
    resource,
    publicResource,
    transport: parsed.protocol.slice(0, -1).toUpperCase(),
    githubCompatible:
      parsed.port === '' &&
      !parsed.hostname.startsWith('[') &&
      (parsed.protocol === 'https:' || parsed.protocol === 'ssh:') &&
      repositoryLike(resource),
    exactPush: exactPushDestination(value, repositoryPath),
  };
}

function isNetworkSharePath(value: string): boolean {
  return value.startsWith('\\\\') || value.startsWith('//');
}

function safeRemoteName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error('The selected Git remote name is invalid.');
  }
  return value;
}

function localDestination(
  name: string,
  exactPath: string,
  exactPush: ExactPushDestination,
): GitRemoteDestination {
  return {
    kind: 'local-filesystem',
    name,
    endpoint: 'local-filesystem',
    resource: exactPath,
    publicResource: 'Local Git repository',
    transport: 'Local file access',
    githubCompatible: false,
    exactPush,
  };
}

function normalizedDnsHost(value: string): string {
  const host = boundedSingleLine(value, 'Git remote host', 253).toLowerCase();
  const labels = host.split('.');
  if (
    labels.some(
      (label) =>
        label.length < 1 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label),
    )
  ) {
    throw new Error('The selected Git remote hostname is invalid.');
  }
  return host;
}

function publicRemoteResource(value: string): string {
  const normalized = value.replace(/^\/+|\/+$/gu, '');
  if (
    normalized.length < 1 ||
    normalized.length > 2_048 ||
    normalized.includes('%') ||
    normalized.includes('\\') ||
    normalized.includes('@') ||
    normalized.includes('?') ||
    normalized.includes('#') ||
    normalized
      .replace(/\.git$/u, '')
      .split('/')
      .some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('The selected Git remote resource is invalid.');
  }
  return normalized;
}

export function gitPushDisclosure(input: GitPushDisclosureInput): OutboundActionDisclosure {
  assertImpact(input.commits, input.files);
  return {
    action: 'git-push',
    title: 'Push reviewed branch',
    summary: `Push ${input.sourceBranch} to ${input.destination.name}/${input.destinationBranch}?`,
    confirmLabel: 'Push branch',
    destination: outboundDestination(input.destination, 'git-remote'),
    details: impactDetails(input),
    warning:
      input.destination.kind === 'local-filesystem'
        ? 'The local Git repository you picked can run its own scripts and Git settings as your computer account when it receives this push. Artemis sends only the reviewed commit and branch, blocks force pushes, and does not let the source repository run scripts, fetch extra content, or change what is sent.'
        : "Git may use the sign-in details and network settings already saved on this computer, including credential helpers, certificates, proxies, and your SSH setup; Artemis trusts those for this push. Artemis ignores the repository's own sign-in and address-rewrite settings, sends only the reviewed commit and branch, blocks force pushes, and does not let the source repository run scripts, fetch extra content, or change what is sent.",
  };
}

export function gitHubStatusDisclosure(
  input: GitHubStatusDisclosureInput,
): OutboundActionDisclosure {
  return {
    action: 'github-status-check',
    title: 'Check GitHub connection',
    summary: `Allow GitHub CLI to inspect ${input.destination.publicResource}?`,
    confirmLabel: 'Check GitHub',
    destination: outboundDestination(input.destination, 'github'),
    details: [
      { label: 'Project', value: input.projectName },
      ...gitHubCliDetails(input.githubCli),
      { label: 'Remote', value: input.destination.name },
      { label: 'Base branch', value: input.baseBranch },
      { label: 'Head branch', value: input.headBranch },
      { label: 'Approved commit', value: input.sourceHead },
    ],
    warning: gitHubCliWarning(
      input.githubCli,
      'Artemis never reads or stores your GitHub token. This check only reads your sign-in, repository, and branch status; it does not create or change anything on GitHub.',
    ),
  };
}

export function gitHubPullRequestDisclosure(
  input: GitHubPullRequestDisclosureInput,
): OutboundActionDisclosure {
  assertImpact(input.commits, input.files);
  return {
    action: 'github-pull-request',
    title: 'Create GitHub pull request',
    summary: `Open ${input.snapshot.headBranch} into ${input.snapshot.baseBranch} on ${input.snapshot.ownerRepository}?`,
    confirmLabel: input.draft ? 'Create draft pull request' : 'Create pull request',
    destination: outboundDestination(input.destination, 'github'),
    details: [
      ...impactDetails(input),
      ...gitHubCliDetails(input.githubCli),
      { label: 'GitHub repository', value: input.snapshot.ownerRepository },
      { label: 'Remote base commit', value: input.snapshot.baseOid },
      {
        label: 'Remote source commit',
        value: input.snapshot.headOid ?? 'missing',
      },
      { label: 'Title', value: input.title },
      {
        label: 'Pull request body',
        value: input.body === '' ? '(empty)' : input.body,
      },
      { label: 'Body fingerprint (SHA-256)', value: input.bodySha256 },
      { label: 'Body characters', value: String(input.bodyCharacters) },
      {
        label: 'Mode',
        value: input.draft ? 'Draft pull request' : 'Ready pull request',
      },
    ],
    warning: gitHubCliWarning(
      input.githubCli,
      'Artemis sends the title and body exactly as shown, after checking your approval and both branches again right before sending. A pull request follows its branch: if the branch changes later, the pull request changes with it. Artemis never changes repository visibility or settings.',
    ),
  };
}

export function gitHubCiDisclosure(input: GitHubCiDisclosureInput): OutboundActionDisclosure {
  return {
    action: 'github-ci-status',
    title: 'Check GitHub CI results',
    summary: `Read CI results for ${input.snapshot.ownerRepository}:${input.snapshot.headBranch}?`,
    confirmLabel: 'Check CI results',
    destination: outboundDestination(input.destination, 'github'),
    details: [
      { label: 'Project', value: input.projectName },
      ...gitHubCliDetails(input.githubCli),
      { label: 'GitHub repository', value: input.snapshot.ownerRepository },
      { label: 'Base branch', value: input.snapshot.baseBranch },
      { label: 'Head branch', value: input.snapshot.headBranch },
      { label: 'Reviewed commit', value: input.sourceHead },
    ],
    warning: gitHubCliWarning(
      input.githubCli,
      'This reads up to 20 recent workflow runs from GitHub. Artemis shows a run as current only when its branch and commit exactly match the reviewed commit.',
    ),
  };
}

function gitHubCliDetails(cli: GitHubCliDisclosure) {
  assertGitHubCliDisclosure(cli);
  const detected = cli.executablePath !== null;
  return [
    {
      label: 'How GitHub CLI was found',
      value:
        cli.source === 'automatic'
          ? 'Found automatically on this computer'
          : 'Selected in Settings',
    },
    {
      label: 'GitHub CLI file',
      value: cli.filename ?? 'Not found on this computer',
    },
    { label: 'GitHub CLI fingerprint (SHA-256)', value: cli.sha256 ?? 'Unavailable' },
    {
      label: 'GitHub CLI location',
      value: cli.executablePath ?? 'None found',
    },
    {
      label: 'GitHub CLI check',
      value: cli.available
        ? 'Version checked'
        : detected
          ? 'Found; version check pending'
          : 'Program not found',
    },
  ];
}

function assertGitHubCliDisclosure(cli: GitHubCliDisclosure): void {
  if (!cli.available) {
    if (cli.source !== 'automatic') {
      throw new Error('Unavailable GitHub CLI disclosure evidence is inconsistent.');
    }
    const missing = cli.filename === null && cli.sha256 === null && cli.executablePath === null;
    const unverified = cli.filename !== null && cli.sha256 !== null && cli.executablePath !== null;
    if (!missing && !unverified) {
      throw new Error('Unavailable GitHub CLI disclosure evidence is inconsistent.');
    }
    if (unverified) assertResolvedGitHubCliDisclosure(cli);
    return;
  }
  assertResolvedGitHubCliDisclosure(cli);
}

function assertResolvedGitHubCliDisclosure(cli: GitHubCliDisclosure): void {
  if (
    cli.filename === null ||
    cli.filename.length > 255 ||
    cli.filename !== path.basename(cli.filename) ||
    cli.filename !== path.basename(cli.executablePath ?? '') ||
    cli.executablePath === null ||
    !path.isAbsolute(cli.executablePath) ||
    boundedSingleLine(cli.executablePath, 'GitHub CLI path', 32_768) !== cli.executablePath ||
    cli.sha256 === null ||
    !/^[a-f0-9]{64}$/u.test(cli.sha256)
  ) {
    throw new Error('Available GitHub CLI disclosure evidence is invalid.');
  }
}

function gitHubCliWarning(cli: GitHubCliDisclosure, action: string): string {
  if (!cli.available) {
    if (cli.executablePath !== null) {
      return `The GitHub CLI shown above was found automatically, but its version has not been checked yet. If you approve, Artemis first runs only that exact program with the --version argument and no sign-in details. Sign-in and GitHub requests stay blocked unless that check succeeds. ${action}`;
    }
    return `Artemis did not find GitHub CLI on this computer. Approving keeps it that way; Artemis cannot contact GitHub through gh unless a new program is found and reviewed. ${action}`;
  }
  const selection =
    cli.source === 'automatic'
      ? 'The GitHub CLI found automatically and shown above'
      : 'The custom GitHub CLI selected in Settings and shown above';
  return `${selection} is trusted code on this computer and may use the GitHub account already signed in and your network settings. Artemis ties this action to that exact program and fingerprint, and checks them again before every command. ${action}`;
}

function impactDetails(input: GitPushDisclosureInput) {
  return [
    { label: 'Project', value: input.projectName },
    { label: 'Remote', value: input.destination.name },
    { label: 'Source branch', value: input.sourceBranch },
    { label: 'Destination branch', value: input.destinationBranch },
    {
      label: 'Commit range',
      value: `${input.baseCommit}..${input.sourceHead}`,
    },
    { label: 'Commits', value: disclosedList(input.commits) },
    ...disclosedListDetails('Files', input.files),
    {
      label: 'Changes',
      value: `+${String(input.additions)} / -${String(input.deletions)}`,
    },
    { label: 'Force', value: 'Disabled' },
    { label: 'Readiness evidence', value: input.readinessEvidence },
  ];
}

function outboundDestination(destination: GitRemoteDestination, kind: 'git-remote' | 'github') {
  if (kind === 'github') {
    return {
      kind,
      endpoint: destination.endpoint,
      resource: destination.publicResource.replace(/\.git$/iu, ''),
      transport: 'GitHub CLI HTTPS API',
    } as const;
  }
  return {
    kind,
    endpoint: destination.endpoint,
    resource: destination.resource,
    transport: destination.transport,
  } as const;
}

function assertImpact(commits: readonly string[], files: readonly string[]): void {
  if (
    commits.length < 1 ||
    commits.length > MAX_DISCLOSED_ITEMS ||
    files.length > MAX_DISCLOSED_ITEMS
  ) {
    throw new Error(
      'Remote delivery impact must contain bounded non-empty commits and bounded files.',
    );
  }
  disclosedList(commits);
  disclosedListDetails('Files', files);
}

function disclosedListDetails(
  label: string,
  values: readonly string[],
): ReadonlyArray<{ readonly label: string; readonly value: string }> {
  if (values.length === 0) return [{ label, value: disclosedList(values) }];
  const chunks: string[] = [];
  let current = '';
  for (const value of values) {
    const item = `• ${boundedSingleLine(value, 'Disclosure item', MAX_DISCLOSED_ITEM_CHARACTERS)}`;
    const candidate = current === '' ? item : `${current}\n${item}`;
    if (candidate.length <= MAX_DISCLOSED_LIST_CHARACTERS) {
      current = candidate;
      continue;
    }
    if (current === '')
      throw new Error('Remote delivery disclosure is too large to approve safely.');
    chunks.push(current);
    current = item;
  }
  if (current !== '') chunks.push(current);
  return chunks.map((value, index) => ({
    label: chunks.length === 1 ? label : `${label} (${String(index + 1)}/${String(chunks.length)})`,
    value,
  }));
}

function disclosedList(values: readonly string[]): string {
  if (values.length === 0) return '(none; the approved commits contain no file changes)';
  const list = values
    .map(
      (value) => `• ${boundedSingleLine(value, 'Disclosure item', MAX_DISCLOSED_ITEM_CHARACTERS)}`,
    )
    .join('\n');
  if (list.length > MAX_DISCLOSED_LIST_CHARACTERS) {
    throw new Error('Remote delivery disclosure is too large to approve safely.');
  }
  return list;
}

function repositoryLike(resource: string): boolean {
  const normalized = resource.replace(/^\/+|\/+$/gu, '').replace(/\.git$/iu, '');
  return /^[^/\s]+\/[^/\s]+$/u.test(normalized);
}

function boundedSingleLine(value: string, label: string, maximum: number): string {
  const bounded = value.trim();
  if (
    bounded.length < 1 ||
    bounded.length > maximum ||
    [...bounded].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    })
  ) {
    throw new Error(`${label} must be a bounded single-line value.`);
  }
  return bounded;
}
