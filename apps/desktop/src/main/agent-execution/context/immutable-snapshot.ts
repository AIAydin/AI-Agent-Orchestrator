import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PreparedAgentLaunchSchema, type PreparedAgentLaunch } from '@forgeboard/agent-adapters';
import { findSensitivePath, loadProjectIgnoreMatcher } from '@forgeboard/core';

import type { AgentExecutionContextRequest } from '../contracts.js';
import {
  AGENT_CONTEXT_ATTACHMENT_LIMIT,
  AGENT_CONTEXT_FILE_MAX_BYTES,
  AGENT_CONTEXT_TOTAL_MAX_BYTES,
} from './limits.js';
import { createContextSnapshotDirectory } from './snapshot-store/manager.js';

const DOCKER_CONTEXT_ROOT = '/forgeboard-context';
const DOCKER_WORKTREE_ROOT = '/workspace';
const COPY_BUFFER_BYTES = 64 * 1024;

export const IMMUTABLE_CONTEXT_DISCLOSURE =
  'Immediately before spawn, Forgeboard copies each approved context digest through a stable ordinary-file handle into a private per-run snapshot. The reviewed paths remain logical labels; only main substitutes randomized snapshot paths, and it removes them after the agent session ends.';

export const IMMUTABLE_DOCKER_CONTEXT_DISCLOSURE =
  'Docker receives selected context through one additional private read-only snapshot mount at /forgeboard-context. The approved worktree bind and its read/write policy remain unchanged.';

export interface SnapshotBinding {
  readonly sourcePath: string;
  readonly logicalLaunchPath: string;
  readonly snapshotPath: string;
  readonly snapshotName: string;
  readonly snapshotIdentity: FileIdentity;
  readonly sha256: string;
}

export interface ImmutableContextSnapshot {
  readonly rootPath: string;
  readonly bindings: readonly SnapshotBinding[];
  bind(plan: PreparedAgentLaunch): Promise<PreparedAgentLaunch>;
  cleanup(): Promise<void>;
}

interface ImmutableContextSnapshotOptions {
  readonly runtime: 'host' | 'docker';
  readonly managedRoot?: string;
  readonly createSnapshotDirectory?: typeof createContextSnapshotDirectory;
}

/**
 * Copies exact approved bytes through opened file handles so later source-path replacement cannot
 * change what the agent receives. Randomized snapshot paths never leave the main-process plan.
 */
export async function createImmutableContextSnapshot(
  context: AgentExecutionContextRequest,
  checkoutPath: string,
  options: ImmutableContextSnapshotOptions,
): Promise<ImmutableContextSnapshot | null> {
  if (context.attachments.length === 0) return null;
  if (context.attachments.length > AGENT_CONTEXT_ATTACHMENT_LIMIT) {
    throw new Error(
      `Agent context supports at most ${String(AGENT_CONTEXT_ATTACHMENT_LIMIT)} files.`,
    );
  }

  const canonicalCheckout = await realpath(path.resolve(checkoutPath));
  const ignoreMatcher = await loadProjectIgnoreMatcher(canonicalCheckout);
  const directoryLease = await (options.createSnapshotDirectory ?? createContextSnapshotDirectory)(
    options.runtime === 'host'
      ? { runtime: 'host' }
      : {
          runtime: 'docker',
          managedRoot:
            options.managedRoot ??
            (() => {
              throw new Error(
                'Docker context snapshots require an authoritative managed-worktree root.',
              );
            })(),
          checkoutPath: canonicalCheckout,
        },
  );
  const rootPath = directoryLease.rootPath;
  let cleaned = false;
  let cleanupInFlight: Promise<void> | undefined;
  try {
    const canonicalSnapshotRoot = await realpath(rootPath);
    if (!pathsEqual(canonicalSnapshotRoot, path.resolve(rootPath))) {
      throw new Error('The private context snapshot escaped its approved parent.');
    }
    await chmod(rootPath, 0o700);
    const bindings: SnapshotBinding[] = [];
    const selectedPaths = new Set<string>();
    let totalBytes = 0;
    for (const [index, attachment] of context.attachments.entries()) {
      if (attachment.kind !== 'file' || attachment.sha256 === undefined) {
        throw new Error('Approved context must contain only digest-bound ordinary files.');
      }
      const opened = await openApprovedFile(
        attachment.path,
        attachment.sha256,
        canonicalCheckout,
        ignoreMatcher,
      );
      try {
        if (selectedPaths.has(opened.canonicalPath)) {
          throw new Error('Agent context cannot contain duplicate selected file paths.');
        }
        selectedPaths.add(opened.canonicalPath);
        if (opened.size > AGENT_CONTEXT_FILE_MAX_BYTES) {
          throw new Error(
            `Selected context exceeds the ${formatBytes(AGENT_CONTEXT_FILE_MAX_BYTES)} per-file limit.`,
          );
        }
        totalBytes += opened.size;
        if (totalBytes > AGENT_CONTEXT_TOTAL_MAX_BYTES) {
          throw new Error(
            `Selected context exceeds the ${formatBytes(AGENT_CONTEXT_TOTAL_MAX_BYTES)} aggregate limit.`,
          );
        }
        const snapshotName = snapshotFileName(index, opened.canonicalPath);
        const snapshotPath = path.join(rootPath, snapshotName);
        await copyExactOpenedFile(
          opened.handle,
          snapshotPath,
          attachment.sha256,
          opened.identity,
          rootPath,
        );
        await directoryLease.protectFile(snapshotPath);
        const snapshotIdentity = await verifySnapshotFile(
          snapshotPath,
          rootPath,
          attachment.sha256,
        );
        bindings.push({
          sourcePath: opened.canonicalPath,
          logicalLaunchPath:
            options.runtime === 'docker'
              ? `${DOCKER_WORKTREE_ROOT}/${opened.relativePath}`
              : opened.canonicalPath,
          snapshotPath,
          snapshotName,
          snapshotIdentity,
          sha256: attachment.sha256,
        });
      } finally {
        await opened.handle.close();
      }
    }
    await chmod(rootPath, 0o500);

    const removeSnapshot = async (): Promise<void> => {
      if (cleaned) return;
      await directoryLease.cleanup();
      cleaned = true;
    };
    const cleanup = async (): Promise<void> => {
      if (cleaned) return;
      cleanupInFlight ??= removeSnapshot();
      try {
        await cleanupInFlight;
      } finally {
        if (!cleaned) cleanupInFlight = undefined;
      }
    };
    return {
      rootPath,
      bindings,
      bind: async (plan) => {
        await directoryLease.revalidate(bindings.map(({ snapshotPath }) => snapshotPath));
        await verifySnapshot(rootPath, bindings);
        return bindPreparedLaunch(plan, bindings, rootPath, options.runtime);
      },
      cleanup,
    };
  } catch (error) {
    try {
      await directoryLease.cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Agent context snapshot creation failed and its private files could not be removed.',
      );
    }
    throw error;
  }
}

type IgnoreMatcher = Awaited<ReturnType<typeof loadProjectIgnoreMatcher>>;

interface OpenedApprovedFile {
  readonly canonicalPath: string;
  readonly handle: Awaited<ReturnType<typeof open>>;
  readonly identity: FileIdentity;
  readonly relativePath: string;
  readonly size: number;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

async function openApprovedFile(
  candidate: string,
  expectedDigest: string,
  canonicalCheckout: string,
  ignoreMatcher: IgnoreMatcher,
): Promise<OpenedApprovedFile> {
  const resolved = path.resolve(candidate);
  const before = await lstat(resolved).catch(() => undefined);
  if (before === undefined || !before.isFile() || before.isSymbolicLink()) {
    throw new Error('The selected approved context path is not an ordinary file.');
  }
  const canonicalPath = await realpath(resolved);
  if (!pathsEqual(canonicalPath, resolved)) {
    throw new Error('The selected approved context path crosses a symbolic-link alias.');
  }
  const relativePath = path.relative(canonicalCheckout, canonicalPath).split(path.sep).join('/');
  if (!isContainedRelativePath(path.relative(canonicalCheckout, canonicalPath))) {
    throw new Error('The selected approved context path escapes its approved checkout.');
  }
  if (findSensitivePath(relativePath) !== undefined) {
    throw new Error(
      'An approved context file became sensitive after disclosure. Review what will run.',
    );
  }
  if (ignoreMatcher.evaluate(relativePath).ignored) {
    throw new Error(
      'An approved context file became ignored after disclosure. Review what will run.',
    );
  }

  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const handle = await open(resolved, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    const after = await lstat(resolved);
    if (!opened.isFile() || after.isSymbolicLink() || !sameFileIdentity(opened, after)) {
      throw new Error('Selected context changed while Forgeboard opened it. Review what will run.');
    }
    const afterCanonical = await realpath(resolved);
    if (!pathsEqual(afterCanonical, canonicalPath)) {
      throw new Error('Selected context changed while Forgeboard opened it. Review what will run.');
    }
    return {
      canonicalPath,
      handle,
      identity: fileIdentity(opened),
      relativePath,
      size: opened.size,
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function copyExactOpenedFile(
  source: Awaited<ReturnType<typeof open>>,
  destinationPath: string,
  expectedDigest: string,
  expectedIdentity: FileIdentity,
  rootPath: string,
): Promise<FileIdentity> {
  const destination = await open(
    destinationPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o400,
  );
  const hash = createHash('sha256');
  let position = 0;
  try {
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      await writeAll(destination, chunk, position);
      hash.update(chunk);
      position += bytesRead;
      if (position > AGENT_CONTEXT_FILE_MAX_BYTES) {
        throw new Error(
          `Selected context exceeds the ${formatBytes(AGENT_CONTEXT_FILE_MAX_BYTES)} per-file limit.`,
        );
      }
    }
    const finalIdentity = fileIdentity(await source.stat());
    if (!sameIdentityRecord(expectedIdentity, finalIdentity)) {
      throw new Error('Selected context changed while Forgeboard copied it. Review what will run.');
    }
    if (position !== expectedIdentity.size || hash.digest('hex') !== expectedDigest) {
      throw new Error(
        'The selected context file changed after disclosure and no longer matches its approved digest. Review what will run.',
      );
    }
    await destination.sync();
  } finally {
    await destination.close();
  }
  await chmod(destinationPath, 0o400);
  return await verifySnapshotFile(destinationPath, rootPath, expectedDigest);
}

async function verifySnapshot(
  rootPath: string,
  bindings: readonly SnapshotBinding[],
): Promise<void> {
  const rootDetails = await lstat(rootPath).catch(() => undefined);
  if (rootDetails === undefined || !rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw new Error('The private context snapshot directory changed before launch.');
  }
  if (!pathsEqual(await realpath(rootPath), path.resolve(rootPath))) {
    throw new Error('The private context snapshot directory became an alias before launch.');
  }
  if (process.platform !== 'win32' && (rootDetails.mode & 0o077) !== 0) {
    throw new Error('The private context snapshot directory lost its private permissions.');
  }
  for (const binding of bindings) {
    const identity = await verifySnapshotFile(binding.snapshotPath, rootPath, binding.sha256);
    if (!sameIdentityRecord(binding.snapshotIdentity, identity)) {
      throw new Error('A private context snapshot file changed before launch.');
    }
  }
}

async function verifySnapshotFile(
  snapshotPath: string,
  rootPath: string,
  expectedDigest: string,
): Promise<FileIdentity> {
  const details = await lstat(snapshotPath).catch(() => undefined);
  if (details === undefined || !details.isFile() || details.isSymbolicLink()) {
    throw new Error('A private context snapshot file is no longer an ordinary file.');
  }
  if (process.platform !== 'win32' && (details.mode & 0o222) !== 0) {
    throw new Error('A private context snapshot file became writable before launch.');
  }
  const canonical = await realpath(snapshotPath);
  if (
    !pathsEqual(canonical, path.resolve(snapshotPath)) ||
    !isContainedRelativePath(path.relative(rootPath, canonical))
  ) {
    throw new Error('A private context snapshot file escaped its private directory.');
  }
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const handle = await open(snapshotPath, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(opened, details)) {
      throw new Error('A private context snapshot file changed while Forgeboard opened it.');
    }
    const digest = await digestOpenedFile(handle, opened.size);
    const finalIdentity = fileIdentity(await handle.stat());
    if (!sameIdentityRecord(fileIdentity(opened), finalIdentity) || digest !== expectedDigest) {
      throw new Error('A private context snapshot file changed before launch.');
    }
    return finalIdentity;
  } finally {
    await handle.close();
  }
}

async function digestOpenedFile(
  handle: Awaited<ReturnType<typeof open>>,
  expectedSize: number,
): Promise<string> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let position = 0;
  while (position < expectedSize) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, expectedSize - position),
      position,
    );
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (position !== expectedSize) throw new Error('A private context snapshot file was truncated.');
  return hash.digest('hex');
}

async function writeAll(
  destination: Awaited<ReturnType<typeof open>>,
  chunk: Buffer,
  start: number,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await destination.write(
      chunk,
      offset,
      chunk.length - offset,
      start + offset,
    );
    if (bytesWritten <= 0) throw new Error('Forgeboard could not finish the private context copy.');
    offset += bytesWritten;
  }
}

function bindPreparedLaunch(
  planInput: PreparedAgentLaunch,
  bindings: readonly SnapshotBinding[],
  rootPath: string,
  runtime: 'host' | 'docker',
): PreparedAgentLaunch {
  const plan = PreparedAgentLaunchSchema.parse(planInput);
  if (plan.disclosure.contextAttachments.length !== bindings.length) {
    throw new Error('The prepared launch context no longer matches its approved snapshot.');
  }
  return runtime === 'docker'
    ? bindDockerPlan(plan, bindings, rootPath)
    : bindHostPlan(plan, bindings);
}

function bindHostPlan(
  plan: PreparedAgentLaunch,
  bindings: readonly SnapshotBinding[],
): PreparedAgentLaunch {
  const replacements = bindings.map(
    (binding) => [binding.sourcePath, binding.snapshotPath] as const,
  );
  const rebound = PreparedAgentLaunchSchema.parse({
    ...plan,
    disclosure: {
      ...plan.disclosure,
      arguments: plan.disclosure.arguments.map((argument) => replacePaths(argument, replacements)),
      contextAttachments: plan.disclosure.contextAttachments.map((attachment, index) => {
        const binding = bindings[index];
        if (
          binding === undefined ||
          attachment.path !== binding.logicalLaunchPath ||
          attachment.sha256 !== binding.sha256
        ) {
          throw new Error('The prepared launch context no longer matches its approved snapshot.');
        }
        return { ...attachment, path: binding.snapshotPath };
      }),
    },
    ...(plan.initialStdin === undefined
      ? {}
      : { initialStdin: replacePaths(plan.initialStdin, replacements) }),
  });
  assertPathsAbsent(
    rebound,
    bindings.map(({ sourcePath }) => sourcePath),
  );
  return rebound;
}

function bindDockerPlan(
  plan: PreparedAgentLaunch,
  bindings: readonly SnapshotBinding[],
  rootPath: string,
): PreparedAgentLaunch {
  const replacements = plan.disclosure.contextAttachments.map((attachment, index) => {
    const binding = bindings[index];
    if (
      binding === undefined ||
      attachment.path !== binding.logicalLaunchPath ||
      attachment.sha256 !== binding.sha256
    ) {
      throw new Error('The prepared Docker context no longer matches its approved snapshot.');
    }
    return [attachment.path, `${DOCKER_CONTEXT_ROOT}/${binding.snapshotName}`] as const;
  });
  const contextMount = dockerContextMountArgument(rootPath);
  const arguments_ = insertDockerContextMount(
    plan.disclosure.arguments.map((argument) => replacePaths(argument, replacements)),
    contextMount,
  );
  const rebound = PreparedAgentLaunchSchema.parse({
    ...plan,
    disclosure: {
      ...plan.disclosure,
      arguments: arguments_,
      contextAttachments: plan.disclosure.contextAttachments.map((attachment, index) => ({
        ...attachment,
        path: replacements[index]?.[1],
      })),
      permissionProfile: {
        ...plan.disclosure.permissionProfile,
        readRoots: [
          ...new Set([...plan.disclosure.permissionProfile.readRoots, DOCKER_CONTEXT_ROOT]),
        ],
        disclosure: plan.disclosure.permissionProfile.disclosure.replace(
          'Forgeboard adds no host credential, Docker socket, SSH agent, keychain, or extra host-path mounts.',
          'Forgeboard adds no host credential, Docker socket, SSH agent, or keychain mounts. Selected context uses one private read-only snapshot mount at /forgeboard-context; the approved worktree bind policy is unchanged.',
        ),
      },
      warnings: [
        ...new Set([
          ...plan.disclosure.warnings.map((warning) =>
            warning.replace(
              'Forgeboard adds no host credential, Docker socket, SSH agent, keychain, or extra host-path mounts.',
              'Forgeboard adds no host credential, Docker socket, SSH agent, or keychain mounts. Selected context uses one private read-only snapshot mount at /forgeboard-context; the approved worktree bind policy is unchanged.',
            ),
          ),
          IMMUTABLE_CONTEXT_DISCLOSURE,
          IMMUTABLE_DOCKER_CONTEXT_DISCLOSURE,
        ]),
      ],
    },
    ...(plan.initialStdin === undefined
      ? {}
      : { initialStdin: replacePaths(plan.initialStdin, replacements) }),
  });
  assertPathsAbsent(rebound, [
    ...bindings.map(({ sourcePath }) => sourcePath),
    ...replacements.map(([logicalPath]) => logicalPath),
  ]);
  return rebound;
}

export function dockerContextMountArgument(rootPath: string): string {
  if (
    !path.isAbsolute(rootPath) ||
    rootPath.includes(',') ||
    rootPath.includes('\0') ||
    /[\r\n]/u.test(rootPath)
  ) {
    throw new Error('The private Docker context snapshot path cannot be represented safely.');
  }
  return `type=bind,source=${rootPath},target=${DOCKER_CONTEXT_ROOT},readonly`;
}

function insertDockerContextMount(arguments_: readonly string[], contextMount: string): string[] {
  if (arguments_[0] !== 'run') throw new Error('The prepared Docker launch has an invalid argv.');
  const worktreeMount = arguments_.indexOf('--mount');
  if (worktreeMount < 0 || worktreeMount + 1 >= arguments_.length) {
    throw new Error('The prepared Docker launch omitted its approved worktree mount.');
  }
  if (arguments_.some((argument) => argument.includes(`target=${DOCKER_CONTEXT_ROOT}`))) {
    throw new Error('The prepared Docker launch already uses the private context mount target.');
  }
  return [
    ...arguments_.slice(0, worktreeMount + 2),
    '--mount',
    contextMount,
    ...arguments_.slice(worktreeMount + 2),
  ];
}

function replacePaths(value: string, replacements: readonly (readonly [string, string])[]): string {
  const ordered = [...replacements].sort(([left], [right]) => right.length - left.length);
  let rebound = '';
  let cursor = 0;
  while (cursor < value.length) {
    const fileUrlReplacement = matchedFileUrlReplacement(value, cursor, ordered);
    if (fileUrlReplacement !== null) {
      rebound += fileUrlReplacement.target;
      cursor += fileUrlReplacement.occurrenceLength;
      continue;
    }
    let replacement: { readonly target: string; readonly occurrenceLength: number } | undefined;
    for (const [source, target] of ordered) {
      const occurrenceLength = matchedPathAliasLength(value, cursor, source);
      if (occurrenceLength !== null && isSelectedPathOccurrence(value, cursor, occurrenceLength)) {
        replacement = { target, occurrenceLength };
        break;
      }
    }
    if (replacement === undefined) {
      rebound += value.charAt(cursor);
      cursor += 1;
      continue;
    }
    rebound += replacement.target;
    cursor += replacement.occurrenceLength;
  }
  return rebound;
}

function assertPathsAbsent(plan: PreparedAgentLaunch, forbiddenPaths: readonly string[]): void {
  const fields = [
    ...plan.disclosure.arguments,
    ...plan.disclosure.contextAttachments.map(({ path: attachmentPath }) => attachmentPath),
    ...(plan.initialStdin === undefined ? [] : [plan.initialStdin]),
  ];
  for (const forbidden of forbiddenPaths) {
    if (
      fields.some(
        (field) =>
          containsUnsafeResidualPath(field, forbidden) || containsSelectedFileUrl(field, forbidden),
      )
    ) {
      throw new Error('A mutable selected-context path remained in the rebound launch plan.');
    }
  }
}

interface MatchedFileUrlReplacement {
  readonly occurrenceLength: number;
  readonly target: string;
}

/**
 * Parses local file URLs rather than matching only their display text. A valid URL may percent-
 * encode spaces, Unicode, or even otherwise-unreserved characters, so raw substring replacement is
 * insufficient for proving that the mutable source path left the launch plan.
 */
function matchedFileUrlReplacement(
  value: string,
  start: number,
  replacements: readonly (readonly [string, string])[],
): MatchedFileUrlReplacement | null {
  if (!startsLocalFileUrl(value, start)) return null;
  let tokenEnd = start;
  while (tokenEnd < value.length && !isFileUrlTerminator(value[tokenEnd])) tokenEnd += 1;

  let candidateEnd = tokenEnd;
  while (candidateEnd > start + 'file:'.length) {
    const parsed = parseFileUrl(value.slice(start, candidateEnd));
    if (parsed !== null) {
      for (const [source, target] of replacements) {
        const style = matchingFileUrlStyle(parsed.url, source);
        if (style === null) continue;
        return {
          occurrenceLength: candidateEnd - start,
          target: reboundFileUrl(parsed, target, style),
        };
      }
    }
    const trailing = value[candidateEnd - 1];
    if (trailing === undefined || !isTrailingUrlPunctuation(trailing)) break;
    candidateEnd -= 1;
  }
  return null;
}

function containsSelectedFileUrl(value: string, candidate: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (matchedFileUrlReplacement(value, index, [[candidate, candidate]]) !== null) return true;
  }
  return false;
}

function startsLocalFileUrl(value: string, start: number): boolean {
  if (value.slice(start, start + 'file:'.length).toLowerCase() !== 'file:') return false;
  const before = start === 0 ? undefined : value[start - 1];
  return before === undefined || !/[A-Za-z0-9+.-]/u.test(before);
}

function isFileUrlTerminator(character: string | undefined): boolean {
  if (character === undefined) return true;
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint <= 0x1f || codePoint === 0x7f || /[\s<>"'`]/u.test(character);
}

function isTrailingUrlPunctuation(character: string): boolean {
  return /[.,;:!?)\]}]/u.test(character);
}

interface ParsedFileUrl {
  readonly url: URL;
  readonly preserveLocalhostAuthority: boolean;
}

function parseFileUrl(candidate: string): ParsedFileUrl | null {
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'file:'
      ? {
          url: parsed,
          preserveLocalhostAuthority: /^file:\/\/localhost(?:[/:]|$)/iu.test(candidate),
        }
      : null;
  } catch {
    return null;
  }
}

type FileUrlPathStyle = 'posix' | 'windows';

function matchingFileUrlStyle(parsed: URL, source: string): FileUrlPathStyle | null {
  const styles: readonly FileUrlPathStyle[] =
    process.platform === 'win32' ? ['windows', 'posix'] : ['posix'];
  for (const style of styles) {
    try {
      const decoded = fileURLToPath(parsed, { windows: style === 'windows' });
      if (fileUrlPathsEqual(decoded, source, style)) return style;
    } catch {
      // A URL invalid for one path grammar may still be a valid Docker POSIX path on Windows.
    }
  }
  return null;
}

function fileUrlPathsEqual(left: string, right: string, style: FileUrlPathStyle): boolean {
  if (style === 'windows') {
    return path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase();
  }
  return path.posix.resolve(left) === path.posix.resolve(right);
}

function reboundFileUrl(parsed: ParsedFileUrl, target: string, style: FileUrlPathStyle): string {
  const rebound = pathToFileURL(target, { windows: style === 'windows' });
  rebound.search = parsed.url.search;
  rebound.hash = parsed.url.hash;
  if (parsed.preserveLocalhostAuthority && rebound.hostname === '') {
    return `file://localhost${rebound.pathname}${rebound.search}${rebound.hash}`;
  }
  return rebound.href;
}

/**
 * Treat every exact residual as unsafe unless the surrounding characters prove that it belongs to
 * a different, longer path. This deliberately fails closed independently of the replacement test.
 */
function containsUnsafeResidualPath(value: string, candidate: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const occurrenceLength = matchedPathAliasLength(value, index, candidate);
    if (occurrenceLength !== null && !isDefinitelyDifferentPath(value, index, occurrenceLength)) {
      return true;
    }
  }
  return false;
}

function isSelectedPathOccurrence(value: string, start: number, occurrenceLength: number): boolean {
  const before = start === 0 ? undefined : value[start - 1];
  const afterIndex = start + occurrenceLength;
  const after = afterIndex >= value.length ? undefined : value[afterIndex];
  const startsAtBoundary =
    (!isPathContinuation(before) && !startsAtUriSeparator(value, start)) ||
    hasLocalFileUrlPrefix(value, start);
  const endsAtBoundary =
    !isPathContinuation(after) ||
    (after === '.' && isTrailingSentencePunctuation(value, afterIndex));
  return startsAtBoundary && endsAtBoundary;
}

function isDefinitelyDifferentPath(
  value: string,
  start: number,
  occurrenceLength: number,
): boolean {
  const before = start === 0 ? undefined : value[start - 1];
  const afterIndex = start + occurrenceLength;
  const after = afterIndex >= value.length ? undefined : value[afterIndex];
  const extendsBefore = isPathContinuation(before) && !hasLocalFileUrlPrefix(value, start);
  const extendsAfter =
    isPathContinuation(after) &&
    !(after === '.' && isTrailingSentencePunctuation(value, afterIndex));
  return extendsBefore || extendsAfter;
}

function hasLocalFileUrlPrefix(value: string, start: number): boolean {
  const prefix = value.slice(0, start).toLowerCase();
  return prefix.endsWith('file://') || prefix.endsWith('file://localhost');
}

function startsAtUriSeparator(value: string, start: number): boolean {
  if (!isPlatformPathSeparator(value[start])) return false;
  return /[A-Za-z][A-Za-z0-9+.-]{0,31}:$/u.test(value.slice(0, start));
}

/** Matches the canonical path plus aliases that differ only by repeated path separators. */
function matchedPathAliasLength(value: string, start: number, candidate: string): number | null {
  let valueIndex = start;
  let candidateIndex = 0;
  while (candidateIndex < candidate.length) {
    const candidateCharacter = candidate.charAt(candidateIndex);
    if (isPlatformPathSeparator(candidateCharacter)) {
      const candidateSeparatorStart = candidateIndex;
      while (
        candidateIndex < candidate.length &&
        isPlatformPathSeparator(candidate[candidateIndex])
      ) {
        candidateIndex += 1;
      }
      const valueSeparatorStart = valueIndex;
      while (valueIndex < value.length && isPlatformPathSeparator(value[valueIndex])) {
        valueIndex += 1;
      }
      const requiredSeparators =
        process.platform === 'win32' &&
        candidateSeparatorStart === 0 &&
        candidateIndex - candidateSeparatorStart > 1
          ? 2
          : 1;
      if (valueIndex - valueSeparatorStart < requiredSeparators) return null;
      continue;
    }
    const valueCharacter = value[valueIndex];
    if (
      valueCharacter === undefined ||
      (process.platform === 'win32'
        ? valueCharacter.toLowerCase() !== candidateCharacter.toLowerCase()
        : valueCharacter !== candidateCharacter)
    ) {
      return null;
    }
    valueIndex += 1;
    candidateIndex += 1;
  }
  return valueIndex - start;
}

function isPlatformPathSeparator(character: string | undefined): boolean {
  return (
    character !== undefined &&
    (character === path.sep ||
      (process.platform === 'win32' && (character === '/' || character === '\\')))
  );
}

function isTrailingSentencePunctuation(value: string, periodIndex: number): boolean {
  let cursor = periodIndex + 1;
  while (value[cursor] === '.') cursor += 1;
  const next = value[cursor];
  return next === undefined || /[\s,;:!?"'\u2019\u201d)\]}]/u.test(next);
}

function isPathContinuation(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9._%/\\-]/u.test(character);
}

function snapshotFileName(index: number, sourcePath: string): string {
  const extension = path.extname(sourcePath);
  const safeExtension = /^\.[A-Za-z0-9_-]{1,16}$/u.test(extension) ? extension : '';
  return `${String(index).padStart(4, '0')}${safeExtension}`;
}

function fileIdentity(details: {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}): FileIdentity {
  return {
    dev: details.dev,
    ino: details.ino,
    size: details.size,
    mtimeMs: details.mtimeMs,
    ctimeMs: details.ctimeMs,
  };
}

function sameFileIdentity(
  left: { readonly dev: number; readonly ino: number; readonly size: number },
  right: { readonly dev: number; readonly ino: number; readonly size: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function sameIdentityRecord(left: FileIdentity, right: FileIdentity): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function isContainedRelativePath(relativePath: string): boolean {
  return (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

function formatBytes(bytes: number): string {
  return `${String(bytes / (1024 * 1024))} MiB`;
}
