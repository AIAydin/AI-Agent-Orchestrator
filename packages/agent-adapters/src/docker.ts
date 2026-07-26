import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import {
  ContextAttachmentSchema,
  PreparedAgentLaunchSchema,
  type ContextAttachment,
  type PreparedAgentLaunch,
} from './schema.js';

const CONTAINER_WORKDIR = '/workspace';
const CONTAINER_HOME = '/home/forgeboard';
const MAX_PROBE_OUTPUT = 65_536;
const FIXED_CONTAINER_ENVIRONMENT = [
  ['HOME', CONTAINER_HOME],
  ['XDG_CONFIG_HOME', `${CONTAINER_HOME}/.config`],
  ['XDG_CACHE_HOME', `${CONTAINER_HOME}/.cache`],
  ['TMPDIR', '/tmp'],
] as const;
const FORBIDDEN_CONTAINER_ENVIRONMENT = new Set([
  'AWS_SHARED_CREDENTIALS_FILE',
  'AZURE_CONFIG_DIR',
  'DOCKER_CERT_PATH',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_HOST',
  'DOCKER_TLS_VERIFY',
  'GIT_ASKPASS',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'HOME',
  'KUBECONFIG',
  'SSH_ASKPASS',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'USERPROFILE',
  'XDG_RUNTIME_DIR',
]);

export function isForbiddenDockerEnvironmentName(
  name: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const comparableName = platform === 'win32' ? name.toUpperCase() : name;
  return (
    FORBIDDEN_CONTAINER_ENVIRONMENT.has(comparableName) || comparableName.startsWith('DOCKER_')
  );
}

const withoutNulOrLineBreak = (value: string): boolean =>
  !value.includes('\0') && !/[\r\n]/u.test(value);

const DockerExecutableSchema = z
  .string()
  .min(1)
  .max(32_768)
  .refine(withoutNulOrLineBreak, 'Docker executable paths cannot contain NUL or line breaks.')
  .refine((value) => path.isAbsolute(value), 'The Docker executable path must be absolute.');

const DockerImageSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._/@:-]*$/u,
    'Docker image references cannot contain whitespace or CLI metacharacters.',
  )
  .refine((value) => !value.split('/').some((segment) => segment === '..'));

const ContainerExecutableSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(withoutNulOrLineBreak, 'Container executable paths cannot contain NUL or line breaks.')
  .refine((value) => path.posix.isAbsolute(value), 'Container executable must be absolute.')
  .refine(
    (value) => path.posix.normalize(value) === value && !value.split('/').includes('..'),
    'Container executable must be normalized.',
  );

const HostWorktreePathSchema = z
  .string()
  .min(1)
  .max(32_768)
  .refine(withoutNulOrLineBreak, 'Worktree paths cannot contain NUL or line breaks.')
  .refine((value) => path.isAbsolute(value), 'Assigned worktree path must be absolute.');

const EnvironmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);

export const DockerNetworkPolicySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z.object({ mode: z.literal('bridge'), explicitlyApproved: z.literal(true) }).strict(),
]);
export type DockerNetworkPolicy = z.infer<typeof DockerNetworkPolicySchema>;

export const DockerLaunchOptionsSchema = z
  .object({
    assignedWorktreePath: HostWorktreePathSchema,
    worktreeAccess: z.enum(['read-only', 'read-write']),
    dockerExecutable: DockerExecutableSchema,
    image: DockerImageSchema,
    containerExecutable: ContainerExecutableSchema,
    userId: z.number().int().min(1).max(2_147_483_647),
    groupId: z.number().int().min(1).max(2_147_483_647),
    cpuLimit: z.number().finite().min(0.1).max(256).default(2),
    memoryLimitMb: z.number().int().min(128).max(1_048_576).default(4_096),
    pidsLimit: z.number().int().min(16).max(65_536).default(256),
    tmpfsSizeMb: z.number().int().min(16).max(16_384).default(128),
    network: DockerNetworkPolicySchema.default({ mode: 'none' }),
    environmentAllowlist: z.array(EnvironmentNameSchema).max(128).default([]),
    virtualContextAttachments: z.array(ContextAttachmentSchema).max(256).default([]),
  })
  .strict()
  .superRefine((options, context) => {
    const comparableNames = options.environmentAllowlist.map((name) =>
      process.platform === 'win32' ? name.toUpperCase() : name,
    );
    const uniqueNames = new Set(comparableNames);
    if (uniqueNames.size !== options.environmentAllowlist.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['environmentAllowlist'],
        message: 'Docker environment allowlist names must be unique.',
      });
    }
    options.environmentAllowlist.forEach((name, index) => {
      if (isForbiddenDockerEnvironmentName(name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['environmentAllowlist', index],
          message: `${name} can expose host credentials or a host control socket.`,
        });
      }
    });
  });
export type DockerLaunchOptions = z.input<typeof DockerLaunchOptionsSchema>;
export type ParsedDockerLaunchOptions = z.output<typeof DockerLaunchOptionsSchema>;

export const DockerRuntimeDetectionOptionsSchema = z
  .object({
    dockerExecutable: DockerExecutableSchema,
    image: DockerImageSchema,
    timeoutMs: z.number().int().min(100).max(30_000).default(5_000),
  })
  .strict();
export type DockerRuntimeDetectionOptions = z.input<typeof DockerRuntimeDetectionOptionsSchema>;

export interface DockerRuntimeDetection {
  executable: string;
  image: string;
  executableAvailable: boolean;
  daemonAvailable: boolean;
  imageAvailable: boolean;
  imageCompatible: boolean;
  available: boolean;
  checkedAt: string;
  daemonVersion?: string;
  imageId?: string;
  reason?: string;
}

export interface DockerRuntimeDetectionHooks {
  /** Revalidates main-process authority immediately before each Docker subprocess starts. */
  readonly beforeProbe?: (probe: {
    readonly executable: string;
    readonly arguments: readonly string[];
  }) => void | Promise<void>;
}

export type DockerHostPathStyle = 'posix' | 'win32';

export class DockerLaunchValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DockerLaunchValidationError';
  }
}

function hostPathApi(style: DockerHostPathStyle): typeof path.posix {
  return style === 'win32' ? path.win32 : path.posix;
}

export function mapWorktreePathToContainer(
  canonicalWorktreePath: string,
  canonicalHostPath: string,
  style: DockerHostPathStyle = process.platform === 'win32' ? 'win32' : 'posix',
): string {
  const hostPath = hostPathApi(style);
  if (!hostPath.isAbsolute(canonicalWorktreePath) || !hostPath.isAbsolute(canonicalHostPath)) {
    throw new DockerLaunchValidationError('Worktree path mapping requires absolute host paths.');
  }
  const worktree = hostPath.normalize(canonicalWorktreePath);
  const candidate = hostPath.normalize(canonicalHostPath);
  const relative = hostPath.relative(worktree, candidate);
  if (relative === '') return CONTAINER_WORKDIR;
  if (
    relative === '..' ||
    relative.startsWith(`..${hostPath.sep}`) ||
    hostPath.isAbsolute(relative)
  ) {
    throw new DockerLaunchValidationError('A local path escapes the assigned worktree.');
  }
  return path.posix.join(CONTAINER_WORKDIR, ...relative.split(hostPath.sep));
}

function isPathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function assertNotCredentialRoot(canonicalWorktree: string): void {
  const home = path.resolve(os.homedir());
  const sensitiveRoots = [
    path.join(home, '.aws'),
    path.join(home, '.docker'),
    path.join(home, '.gnupg'),
    path.join(home, '.kube'),
    path.join(home, '.ssh'),
    path.join(home, 'Library', 'Keychains'),
  ];
  if (
    sensitiveRoots.some(
      (sensitiveRoot) =>
        isPathWithin(sensitiveRoot, canonicalWorktree) ||
        isPathWithin(canonicalWorktree, sensitiveRoot),
    )
  ) {
    throw new DockerLaunchValidationError(
      'The assigned worktree cannot be a host credential, Docker config, or keychain directory.',
    );
  }
}

async function validateCanonicalWorktree(requestedPath: string): Promise<string> {
  const resolved = path.resolve(requestedPath);
  const requestedStats = await lstat(resolved).catch((error: unknown) => {
    throw new DockerLaunchValidationError(
      `Assigned worktree is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  if (requestedStats.isSymbolicLink() || !requestedStats.isDirectory()) {
    throw new DockerLaunchValidationError(
      'Assigned worktree must be an ordinary, non-symlink directory.',
    );
  }
  const canonical = await realpath(resolved);
  if (!pathsEqual(canonical, resolved)) {
    throw new DockerLaunchValidationError(
      'Assigned worktree paths cannot contain symbolic-link aliases.',
    );
  }
  if (path.dirname(canonical) === canonical) {
    throw new DockerLaunchValidationError('The filesystem root cannot be assigned as a worktree.');
  }
  if (canonical.includes(',')) {
    throw new DockerLaunchValidationError(
      'Assigned worktree path cannot contain a comma in Docker mount syntax.',
    );
  }
  assertNotCredentialRoot(canonical);
  return canonical;
}

async function validateWorktreePath(
  candidatePath: string,
  canonicalWorktree: string,
): Promise<string> {
  const resolved = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(canonicalWorktree, candidatePath);
  if (!isPathWithin(canonicalWorktree, resolved)) {
    throw new DockerLaunchValidationError(
      `Local path escapes the assigned worktree: ${candidatePath}`,
    );
  }

  const relative = path.relative(canonicalWorktree, resolved);
  let current = canonicalWorktree;
  for (const segment of relative === '' ? [] : relative.split(path.sep)) {
    current = path.join(current, segment);
    let currentStats;
    try {
      currentStats = await lstat(current);
    } catch (error) {
      if (isFileNotFound(error)) break;
      throw error;
    }
    if (currentStats.isSymbolicLink()) {
      throw new DockerLaunchValidationError(`Local path crosses a symbolic link: ${candidatePath}`);
    }
    const canonicalCurrent = await realpath(current);
    if (!pathsEqual(canonicalCurrent, current)) {
      throw new DockerLaunchValidationError(
        `Local path escapes through an alias: ${candidatePath}`,
      );
    }
  }
  return resolved;
}

async function validateContextAttachment(
  attachment: ContextAttachment,
  canonicalWorktree: string,
  virtualAttachments: ReadonlyMap<string, ContextAttachment>,
): Promise<{ attachment: ContextAttachment; hostPath: string; containerPath: string }> {
  const resolved = await validateWorktreePath(attachment.path, canonicalWorktree);
  const virtual = virtualAttachments.get(resolved);
  if (virtual !== undefined) {
    if (
      attachment.kind !== 'file' ||
      virtual.kind !== 'file' ||
      attachment.sha256 === undefined ||
      virtual.sha256 !== attachment.sha256 ||
      path.resolve(virtual.path) !== resolved
    ) {
      throw new DockerLaunchValidationError(
        'Virtual context must match one exact digest-bound file attachment.',
      );
    }
    return {
      attachment: {
        ...attachment,
        path: mapWorktreePathToContainer(
          canonicalWorktree,
          resolved,
          process.platform === 'win32' ? 'win32' : 'posix',
        ),
      },
      hostPath: resolved,
      containerPath: mapWorktreePathToContainer(
        canonicalWorktree,
        resolved,
        process.platform === 'win32' ? 'win32' : 'posix',
      ),
    };
  }
  let attachmentStats;
  try {
    attachmentStats = await lstat(resolved);
  } catch (error) {
    throw new DockerLaunchValidationError(
      `Context attachment is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (attachmentStats.isSymbolicLink()) {
    throw new DockerLaunchValidationError('Context attachments cannot be symbolic links.');
  }
  if (
    (attachment.kind === 'file' && !attachmentStats.isFile()) ||
    (attachment.kind === 'directory' && !attachmentStats.isDirectory())
  ) {
    throw new DockerLaunchValidationError(
      `Context attachment kind does not match its host path: ${attachment.path}`,
    );
  }
  const canonical = await realpath(resolved);
  if (!pathsEqual(canonical, resolved)) {
    throw new DockerLaunchValidationError('Context attachment paths cannot contain aliases.');
  }
  const containerPath = mapWorktreePathToContainer(
    canonicalWorktree,
    canonical,
    process.platform === 'win32' ? 'win32' : 'posix',
  );
  return {
    attachment: { ...attachment, path: containerPath },
    hostPath: canonical,
    containerPath,
  };
}

function replaceKnownHostPaths(
  value: string,
  mappings: readonly { hostPath: string; containerPath: string }[],
): string {
  return [...mappings]
    .sort((left, right) => right.hostPath.length - left.hostPath.length)
    .reduce(
      (rewritten, mapping) => rewritten.replaceAll(mapping.hostPath, mapping.containerPath),
      value,
    );
}

function assertContainerPath(pathValue: string): void {
  const normalized = path.posix.normalize(pathValue);
  const relative = path.posix.relative(CONTAINER_WORKDIR, normalized);
  if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
    throw new DockerLaunchValidationError('A container path escapes /workspace.');
  }
}

function isUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol !== 'file:';
  } catch {
    return false;
  }
}

function isWindowsHostPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\');
}

function looksLikePathArgument(value: string): boolean {
  if (value === '') return false;
  // WHATWG URLs treat a Windows drive prefix such as `C:` as a URL scheme. Classify host paths
  // first so native absolute paths still receive canonical worktree containment checks.
  if (isWindowsHostPath(value)) return true;
  if (isUrl(value)) return false;
  return (
    path.isAbsolute(value) ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('.\\') ||
    value.startsWith('..\\') ||
    (!/\s/u.test(value) && (value.includes('/') || value.includes('\\')))
  );
}

function splitPathArgument(argument: string): { prefix: string; value: string } | undefined {
  const equals = argument.indexOf('=');
  if (equals > 0) {
    const prefix = argument.slice(0, equals);
    const value = argument.slice(equals + 1);
    if (!/\s/u.test(prefix) && !prefix.includes('://') && looksLikePathArgument(value)) {
      return { prefix: `${prefix}=`, value };
    }
  }
  return looksLikePathArgument(argument) ? { prefix: '', value: argument } : undefined;
}

function assertNoUnsupportedHostPathText(value: string, source: string): void {
  if (/file:\/\//iu.test(value)) {
    throw new DockerLaunchValidationError(`${source} contains an unsupported file URL.`);
  }
  const valueWithoutUrls = value.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`,;)]+/giu, '');
  if (/(?:^|[^A-Za-z0-9_.])\.\.(?:[/\\]|$|[^A-Za-z0-9_.])/u.test(valueWithoutUrls)) {
    throw new DockerLaunchValidationError(`${source} contains path traversal.`);
  }
  if (
    /(?:^|[^A-Za-z0-9_.])[A-Za-z]:[\\/]/u.test(valueWithoutUrls) ||
    /(?:^|[^A-Za-z0-9_.])\\\\/u.test(valueWithoutUrls)
  ) {
    throw new DockerLaunchValidationError(`${source} contains an unsupported Windows host path.`);
  }

  const absolutePaths = valueWithoutUrls.matchAll(
    /(?:^|[^A-Za-z0-9._~@%+?-])(\/[^\s"'`,;)\]}>]*)/gu,
  );
  for (const match of absolutePaths) {
    const pathValue = match[1] ?? '';
    if (pathValue === '') continue;
    if (pathValue === CONTAINER_WORKDIR || pathValue.startsWith(`${CONTAINER_WORKDIR}/`)) {
      assertContainerPath(pathValue);
      continue;
    }
    throw new DockerLaunchValidationError(`${source} contains an unsupported host path.`);
  }
}

async function validateEmbeddedRelativePaths(
  value: string,
  canonicalWorktree: string,
  source: string,
): Promise<void> {
  const valueWithoutUrls = value.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`,;)]+/giu, '');
  const matches = valueWithoutUrls.matchAll(
    /(?:^|[^A-Za-z0-9._~@%+-])([A-Za-z0-9._-]+(?:[/\\][A-Za-z0-9._-]+)+)/gu,
  );
  for (const match of matches) {
    const candidate = match[1] ?? '';
    if (candidate === '') continue;
    if (process.platform !== 'win32' && candidate.includes('\\')) {
      throw new DockerLaunchValidationError(
        `${source} contains an unsupported Windows-style relative path.`,
      );
    }
    await validateWorktreePath(candidate, canonicalWorktree);
  }
}

async function rewriteArgument(
  argument: string,
  canonicalWorktree: string,
  mappings: readonly { hostPath: string; containerPath: string }[],
  index: number,
): Promise<string> {
  let rewritten = replaceKnownHostPaths(argument, mappings);
  const pathArgument = splitPathArgument(rewritten);
  if (pathArgument !== undefined) {
    if (
      pathArgument.value === CONTAINER_WORKDIR ||
      pathArgument.value.startsWith(`${CONTAINER_WORKDIR}/`)
    ) {
      assertContainerPath(pathArgument.value);
    } else if (isWindowsHostPath(pathArgument.value) && process.platform !== 'win32') {
      throw new DockerLaunchValidationError(
        `Argument ${String(index)} contains a foreign Windows host path.`,
      );
    } else {
      const hostPath = await validateWorktreePath(pathArgument.value, canonicalWorktree);
      if (path.isAbsolute(pathArgument.value)) {
        rewritten = `${pathArgument.prefix}${mapWorktreePathToContainer(
          canonicalWorktree,
          hostPath,
          process.platform === 'win32' ? 'win32' : 'posix',
        )}`;
      }
    }
  }
  assertNoUnsupportedHostPathText(rewritten, `Argument ${String(index)}`);
  await validateEmbeddedRelativePaths(rewritten, canonicalWorktree, `Argument ${String(index)}`);
  return rewritten;
}

function filterContainerEnvironment(
  plan: PreparedAgentLaunch,
  options: ParsedDockerLaunchOptions,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of [...options.environmentAllowlist].sort()) {
    const value = plan.environment[name];
    if (value === undefined) continue;
    assertNoUnsupportedHostPathText(value, `Environment variable ${name}`);
    environment[name] = value;
  }
  return environment;
}

function dockerPermissionProfile(
  plan: PreparedAgentLaunch,
  options: ParsedDockerLaunchOptions,
  canonicalWorktree: string,
) {
  const writable = options.worktreeAccess === 'read-write';
  const networkAllowed = options.network.mode === 'bridge';
  const disclosure = [
    `Docker enforces one ${writable ? 'writable' : 'read-only'} assigned-worktree bind at ${CONTAINER_WORKDIR}.`,
    `The container runs as a non-root uid:gid with all Linux capabilities dropped, no-new-privileges, a read-only root filesystem, bounded tmpfs storage at /tmp and ${CONTAINER_HOME}, no IPC namespace, and a PID limit.`,
    "No seccomp override is supplied, so Docker's configured default remains in force.",
    networkAllowed
      ? 'Docker bridge networking is enabled by explicit approval.'
      : 'Docker networking is disabled.',
    'Artemis adds no host credential, Docker socket, SSH agent, keychain, or extra host-path mounts.',
  ].join(' ');
  return {
    id: `docker-${writable ? 'read-write' : 'read-only'}`,
    name: `Docker isolated (${writable ? 'read/write worktree' : 'read-only worktree'})`,
    mode: 'docker-isolated' as const,
    enforcement: 'docker' as const,
    readRoots: [canonicalWorktree],
    writeRoots: writable ? [canonicalWorktree] : [],
    network: networkAllowed ? ('allowed' as const) : ('blocked' as const),
    approvalPolicy: networkAllowed
      ? 'Docker bridge networking was explicitly approved for this launch.'
      : 'No network access is approved for this Docker launch.',
    disclosure: `${disclosure} Provider disclosure: ${plan.manifest.provider.disclosure}`,
  };
}

function buildDockerArguments(
  plan: PreparedAgentLaunch,
  options: ParsedDockerLaunchOptions,
  canonicalWorktree: string,
  environmentNames: readonly string[],
  commandArguments: readonly string[],
): string[] {
  const mount = `type=bind,source=${canonicalWorktree},target=${CONTAINER_WORKDIR}${
    options.worktreeAccess === 'read-only' ? ',readonly' : ''
  }`;
  const arguments_ = [
    'run',
    '--pull',
    'never',
    '--rm',
    '--init',
    '--interactive',
    ...(plan.disclosure.runtime === 'pty' ? ['--tty'] : []),
    '--user',
    `${String(options.userId)}:${String(options.groupId)}`,
    '--workdir',
    CONTAINER_WORKDIR,
    '--mount',
    mount,
    '--cpus',
    String(options.cpuLimit),
    '--memory',
    `${String(options.memoryLimitMb)}m`,
    '--pids-limit',
    String(options.pidsLimit),
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '--tmpfs',
    `/tmp:rw,noexec,nosuid,nodev,size=${String(options.tmpfsSizeMb)}m,mode=1777`,
    '--tmpfs',
    `${CONTAINER_HOME}:rw,noexec,nosuid,nodev,size=${String(options.tmpfsSizeMb)}m,mode=0700,uid=${String(options.userId)},gid=${String(options.groupId)}`,
    '--ipc',
    'none',
    '--network',
    options.network.mode,
    '--entrypoint',
    options.containerExecutable,
  ];
  for (const [name, value] of FIXED_CONTAINER_ENVIRONMENT) {
    arguments_.push('--env', `${name}=${value}`);
  }
  for (const name of environmentNames) arguments_.push('--env', name);
  arguments_.push(options.image, ...commandArguments);
  return arguments_;
}

export async function planDockerAgentLaunch(
  planInput: PreparedAgentLaunch,
  optionsInput: DockerLaunchOptions,
): Promise<PreparedAgentLaunch> {
  const plan = PreparedAgentLaunchSchema.parse(planInput);
  const options = DockerLaunchOptionsSchema.parse(optionsInput);
  const canonicalWorktree = await validateCanonicalWorktree(options.assignedWorktreePath);
  const resolvedCwd = path.resolve(plan.disclosure.cwd);
  const canonicalCwd = await realpath(resolvedCwd).catch(() => undefined);
  if (
    canonicalCwd === undefined ||
    !pathsEqual(resolvedCwd, canonicalWorktree) ||
    !pathsEqual(canonicalCwd, canonicalWorktree)
  ) {
    throw new DockerLaunchValidationError(
      'Prepared launch cwd must exactly match the canonical assigned worktree.',
    );
  }

  const virtualAttachments = new Map(
    options.virtualContextAttachments.map((attachment) => [
      path.resolve(attachment.path),
      attachment,
    ]),
  );
  if (virtualAttachments.size !== options.virtualContextAttachments.length) {
    throw new DockerLaunchValidationError('Virtual context attachment paths must be unique.');
  }
  const validatedAttachments = await Promise.all(
    plan.disclosure.contextAttachments.map(async (attachment) =>
      validateContextAttachment(attachment, canonicalWorktree, virtualAttachments),
    ),
  );
  const selectedPaths = new Set(
    plan.disclosure.contextAttachments.map((attachment) => path.resolve(attachment.path)),
  );
  if ([...virtualAttachments.keys()].some((candidate) => !selectedPaths.has(candidate))) {
    throw new DockerLaunchValidationError(
      'Virtual context was not present in the prepared attachment selection.',
    );
  }
  const mappings = validatedAttachments.map(({ hostPath, containerPath }) => ({
    hostPath,
    containerPath,
  }));
  const commandArguments: string[] = [];
  for (const [index, argument] of plan.disclosure.arguments.entries()) {
    commandArguments.push(await rewriteArgument(argument, canonicalWorktree, mappings, index));
  }

  const initialStdin =
    plan.initialStdin === undefined
      ? undefined
      : replaceKnownHostPaths(plan.initialStdin, mappings);
  if (initialStdin !== undefined) {
    assertNoUnsupportedHostPathText(initialStdin, 'Initial stdin');
    await validateEmbeddedRelativePaths(initialStdin, canonicalWorktree, 'Initial stdin');
  }
  const environment = filterContainerEnvironment(plan, options);
  const forwardedEnvironmentNames = Object.keys(environment).sort();
  const disclosedEnvironmentNames = [
    ...FIXED_CONTAINER_ENVIRONMENT.map(([name]) => name),
    ...forwardedEnvironmentNames,
  ].sort();
  const permissionProfile = dockerPermissionProfile(plan, options, canonicalWorktree);
  const dockerArguments = buildDockerArguments(
    plan,
    options,
    canonicalWorktree,
    forwardedEnvironmentNames,
    commandArguments,
  );
  if (dockerArguments.filter((argument) => argument === '--mount').length !== 1) {
    throw new DockerLaunchValidationError('Docker launch must contain exactly one bind mount.');
  }

  const enforcementWarning = permissionProfile.disclosure;
  const fixedEnvironmentDisclosure = FIXED_CONTAINER_ENVIRONMENT.map(
    ([name, value]) => `${name}=${value}`,
  ).join(', ');
  const environmentWarning = `Fixed nonsecret container environment: ${fixedEnvironmentDisclosure}. ${
    forwardedEnvironmentNames.length === 0
      ? 'No host environment variables are forwarded into the container.'
      : `Only these approved host environment variable names are forwarded: ${forwardedEnvironmentNames.join(', ')}. Their values are intentionally omitted from this disclosure.`
  }`;

  return PreparedAgentLaunchSchema.parse({
    ...plan,
    disclosure: {
      ...plan.disclosure,
      executable: options.dockerExecutable,
      arguments: dockerArguments,
      cwd: canonicalWorktree,
      shell: false,
      environmentVariableNames: disclosedEnvironmentNames,
      contextAttachments: validatedAttachments.map(({ attachment }) => attachment),
      permissionProfile,
      warnings: [enforcementWarning, environmentWarning],
    },
    environment,
    ...(initialStdin === undefined ? {} : { initialStdin }),
  });
}

interface ProbeResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  reason?: string;
}

async function runProbe(
  executable: string,
  arguments_: readonly string[],
  timeoutMs: number,
): Promise<ProbeResult> {
  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const environment: NodeJS.ProcessEnv = {};
    if (process.platform === 'win32' && process.env['SYSTEMROOT'] !== undefined) {
      environment['SYSTEMROOT'] = process.env['SYSTEMROOT'];
    }
    const child = spawn(executable, [...arguments_], {
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ exitCode: null, stdout, stderr, reason: 'Docker detection timed out.' });
    }, timeoutMs);
    const appendStdout = (chunk: Buffer): void => {
      if (stdout.length >= MAX_PROBE_OUTPUT) return;
      stdout += chunk.toString('utf8').slice(0, MAX_PROBE_OUTPUT - stdout.length);
    };
    const appendStderr = (chunk: Buffer): void => {
      if (stderr.length >= MAX_PROBE_OUTPUT) return;
      stderr += chunk.toString('utf8').slice(0, MAX_PROBE_OUTPUT - stderr.length);
    };
    child.stdout.on('data', appendStdout);
    child.stderr.on('data', appendStderr);
    child.on('error', (error) => finish({ exitCode: null, stdout, stderr, reason: error.message }));
    child.on('close', (exitCode) => finish({ exitCode, stdout, stderr }));
  });
}

interface InspectedDockerImage {
  id: string;
  os: string;
  architecture?: string;
  declaredVolumes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uiSafeText(value: string, maximumLength = 2_048): string {
  const withoutControlCharacters = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159) ? ' ' : character;
    })
    .join('');
  return withoutControlCharacters.replace(/\s+/gu, ' ').trim().slice(0, maximumLength);
}

function parseInspectedDockerImage(output: string): InspectedDockerImage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new DockerLaunchValidationError(
      'Docker returned malformed metadata for the configured local image.',
    );
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    throw new DockerLaunchValidationError(
      'Docker returned an unexpected metadata shape for the configured local image.',
    );
  }

  const metadata = parsed[0];
  const id = typeof metadata['Id'] === 'string' ? metadata['Id'].trim() : '';
  const imageOs = typeof metadata['Os'] === 'string' ? metadata['Os'].trim().toLowerCase() : '';
  const architecture =
    typeof metadata['Architecture'] === 'string' && metadata['Architecture'].trim() !== ''
      ? metadata['Architecture'].trim()
      : undefined;
  const config = metadata['Config'];
  if (
    !/^sha256:[a-f0-9]{64}$/u.test(id) ||
    !/^[a-z][a-z0-9._-]{0,63}$/u.test(imageOs) ||
    !isRecord(config)
  ) {
    throw new DockerLaunchValidationError(
      'Docker image metadata is incomplete and cannot be validated safely.',
    );
  }

  const volumeSources = [config['Volumes']];
  const legacyConfig = metadata['ContainerConfig'];
  if (isRecord(legacyConfig)) volumeSources.push(legacyConfig['Volumes']);
  const declaredVolumes = new Set<string>();
  for (const volumes of volumeSources) {
    if (volumes === undefined || volumes === null) continue;
    if (!isRecord(volumes)) {
      throw new DockerLaunchValidationError(
        'Docker image volume metadata is malformed and cannot be validated safely.',
      );
    }
    for (const volumePath of Object.keys(volumes)) declaredVolumes.add(volumePath);
  }

  return {
    id,
    os: imageOs,
    ...(architecture === undefined ? {} : { architecture }),
    declaredVolumes: [...declaredVolumes].sort(),
  };
}

function probeFailureOutput(probe: ProbeResult): string {
  return uiSafeText([probe.stderr, probe.stdout].filter(Boolean).join(' '));
}

export async function detectDockerRuntime(
  optionsInput: DockerRuntimeDetectionOptions,
  hooks: DockerRuntimeDetectionHooks = {},
): Promise<DockerRuntimeDetection> {
  const options = DockerRuntimeDetectionOptionsSchema.parse(optionsInput);
  const checkedAt = new Date().toISOString();
  let canonicalExecutable: string;
  try {
    canonicalExecutable = await realpath(options.dockerExecutable);
    const executableStats = await stat(canonicalExecutable);
    if (!executableStats.isFile()) throw new Error('Docker executable is not an ordinary file.');
    if (process.platform !== 'win32') await access(canonicalExecutable, fsConstants.X_OK);
  } catch (error) {
    return {
      executable: options.dockerExecutable,
      image: options.image,
      executableAvailable: false,
      daemonAvailable: false,
      imageAvailable: false,
      imageCompatible: false,
      available: false,
      checkedAt,
      reason: uiSafeText(error instanceof Error ? error.message : String(error)),
    };
  }

  const versionArguments = ['version', '--format', '{{.Server.Version}}'] as const;
  await hooks.beforeProbe?.({ executable: canonicalExecutable, arguments: versionArguments });
  const version = await runProbe(canonicalExecutable, versionArguments, options.timeoutMs);
  if (version.exitCode !== 0) {
    return {
      executable: canonicalExecutable,
      image: options.image,
      executableAvailable: true,
      daemonAvailable: false,
      imageAvailable: false,
      imageCompatible: false,
      available: false,
      checkedAt,
      reason:
        (version.reason === undefined ? undefined : uiSafeText(version.reason)) ??
        `Docker daemon probe exited with code ${String(version.exitCode)}: ${probeFailureOutput(version)}`,
    };
  }

  const imageArguments = ['image', 'inspect', options.image] as const;
  await hooks.beforeProbe?.({ executable: canonicalExecutable, arguments: imageArguments });
  const image = await runProbe(canonicalExecutable, imageArguments, options.timeoutMs);
  if (image.exitCode !== 0) {
    return {
      executable: canonicalExecutable,
      image: options.image,
      executableAvailable: true,
      daemonAvailable: true,
      imageAvailable: false,
      imageCompatible: false,
      available: false,
      checkedAt,
      daemonVersion: uiSafeText(version.stdout, 256),
      reason:
        (image.reason === undefined ? undefined : uiSafeText(image.reason)) ??
        `Docker image is not available locally (exit ${String(image.exitCode)}): ${probeFailureOutput(image)}`,
    };
  }

  let inspectedImage: InspectedDockerImage;
  try {
    inspectedImage = parseInspectedDockerImage(image.stdout);
    if (inspectedImage.os !== 'linux') {
      throw new DockerLaunchValidationError(
        `The configured image targets ${inspectedImage.os}, but Artemis Docker isolation requires a Linux image.`,
      );
    }
    if (inspectedImage.declaredVolumes.length > 0) {
      const visibleVolumes = inspectedImage.declaredVolumes.slice(0, 8).join(', ');
      const suffix = inspectedImage.declaredVolumes.length > 8 ? ', ...' : '';
      throw new DockerLaunchValidationError(
        `The configured image declares Docker volumes (${uiSafeText(visibleVolumes, 512)}${suffix}); use an image with no declared volumes so Artemis can enforce its exact storage policy.`,
      );
    }
  } catch (error) {
    return {
      executable: canonicalExecutable,
      image: options.image,
      executableAvailable: true,
      daemonAvailable: true,
      imageAvailable: true,
      imageCompatible: false,
      available: false,
      checkedAt,
      daemonVersion: uiSafeText(version.stdout, 256),
      reason: uiSafeText(error instanceof Error ? error.message : String(error)),
    };
  }

  return {
    executable: canonicalExecutable,
    image: options.image,
    executableAvailable: true,
    daemonAvailable: true,
    imageAvailable: true,
    imageCompatible: true,
    available: true,
    checkedAt,
    daemonVersion: uiSafeText(version.stdout, 256),
    imageId: inspectedImage.id,
  };
}
