import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import {
  CURRENT_SCHEMA_VERSION,
  EntityIdSchema,
  RelativePathSchema,
  TimestampSchema,
} from '../model/domain.js';

export class PathPolicyError extends Error {
  public readonly code:
    | 'INVALID_PATH'
    | 'ROOT_NOT_FOUND'
    | 'PATH_NOT_FOUND'
    | 'PATH_ESCAPE'
    | 'DEVICE_PATH';

  public constructor(code: PathPolicyError['code'], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PathPolicyError';
    this.code = code;
  }
}

export interface CanonicalPathResult {
  readonly rootPath: string;
  readonly path: string;
  readonly relativePath: string;
  readonly exists: boolean;
}

export interface CanonicalPathOptions {
  readonly allowAbsolute?: boolean;
  readonly mustExist?: boolean;
}

function assertOrdinaryPath(candidate: string): void {
  if (candidate.length === 0 || candidate.includes('\0')) {
    throw new PathPolicyError('INVALID_PATH', 'The path is empty or contains a NUL byte');
  }
  if (/^(?:\\\\[?.]\\|\\\\[^\\]+\\[^\\]+|\/dev\/)/i.test(candidate)) {
    throw new PathPolicyError('DEVICE_PATH', 'Device and UNC paths are not accepted');
  }
  if (path.sep === '/' && /^[A-Za-z]:[\\/]/.test(candidate)) {
    throw new PathPolicyError(
      'INVALID_PATH',
      'Windows absolute paths are invalid on this platform',
    );
  }
  if (
    candidate
      .split(/[\\/]/)
      .some((segment) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment))
  ) {
    throw new PathPolicyError('DEVICE_PATH', 'Reserved device names are not accepted');
  }
}

export function isPathContained(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

async function canonicalizePossiblyMissing(
  candidatePath: string,
): Promise<{ path: string; exists: boolean }> {
  let cursor = candidatePath;
  const missingSegments: string[] = [];
  while (true) {
    try {
      await lstat(cursor);
      const canonicalAncestor = await realpath(cursor);
      return {
        path: path.join(canonicalAncestor, ...missingSegments.reverse()),
        exists: missingSegments.length === 0,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw new PathPolicyError('PATH_NOT_FOUND', `No existing ancestor for ${candidatePath}`, {
          cause: error,
        });
      }
      missingSegments.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * Resolves symlinks and proves containment immediately before a filesystem operation.
 * Missing write targets are checked through their nearest existing canonical ancestor.
 */
export async function resolveCanonicalPath(
  root: string,
  candidate: string,
  options: CanonicalPathOptions = {},
): Promise<CanonicalPathResult> {
  assertOrdinaryPath(root);
  assertOrdinaryPath(candidate);

  const absoluteRoot = path.resolve(root);
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(absoluteRoot);
  } catch (error) {
    throw new PathPolicyError(
      'ROOT_NOT_FOUND',
      `The approved root does not exist: ${absoluteRoot}`,
      {
        cause: error,
      },
    );
  }

  if (path.isAbsolute(candidate) && options.allowAbsolute !== true) {
    throw new PathPolicyError('INVALID_PATH', 'Absolute candidate paths require explicit opt-in');
  }
  const absoluteCandidate = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(absoluteRoot, candidate);

  if (!isPathContained(absoluteRoot, absoluteCandidate)) {
    throw new PathPolicyError('PATH_ESCAPE', 'The path traverses outside the approved root');
  }

  const canonicalCandidate = await canonicalizePossiblyMissing(absoluteCandidate);
  if (!isPathContained(canonicalRoot, canonicalCandidate.path)) {
    throw new PathPolicyError('PATH_ESCAPE', 'The canonical path escapes through a symlink');
  }
  if (options.mustExist === true && !canonicalCandidate.exists) {
    throw new PathPolicyError('PATH_NOT_FOUND', `The path does not exist: ${candidate}`);
  }

  return {
    rootPath: canonicalRoot,
    path: canonicalCandidate.path,
    relativePath: path.relative(canonicalRoot, canonicalCandidate.path).split(path.sep).join('/'),
    exists: canonicalCandidate.exists,
  };
}

export interface SensitivePathFinding {
  readonly ruleId: string;
  readonly reason: string;
}

interface SensitiveRule {
  readonly id: string;
  readonly reason: string;
  readonly test: (normalizedPath: string, basename: string) => boolean;
}

const SENSITIVE_RULES: readonly SensitiveRule[] = [
  {
    id: 'dotenv',
    reason: 'Environment files commonly contain credentials',
    test: (_path, basename) => basename === '.env' || basename.startsWith('.env.'),
  },
  {
    id: 'private-key',
    reason: 'Private keys and credential containers must not be attached automatically',
    test: (_path, basename) =>
      /(?:^id_(?:rsa|dsa|ecdsa|ed25519)$|\.(?:pem|key|p12|pfx|jks|keystore)$)/i.test(basename),
  },
  {
    id: 'certificate',
    reason: 'Certificates and signing material are sensitive context',
    test: (_path, basename) => /\.(?:crt|cer|der|p7b|p7c)$/i.test(basename),
  },
  {
    id: 'credential-file',
    reason: 'Known credential and authentication files are denied by default',
    test: (_path, basename) =>
      /^(?:credentials?(?:\.[a-z0-9_-]+)?|secrets?(?:\.[a-z0-9_-]+)?|\.git-credentials|\.netrc|auth\.json|token\.json)$/i.test(
        basename,
      ),
  },
  {
    id: 'package-registry-auth',
    reason: 'Package registry configuration may contain publish or download tokens',
    test: (normalizedPath, basename) =>
      /^(?:\.npmrc|\.pypirc|\.yarnrc(?:\.yml)?)$/i.test(basename) ||
      /(?:^|\/)\.gem\/credentials$/i.test(normalizedPath),
  },
  {
    id: 'cloud-service-account',
    reason: 'Cloud service-account documents commonly contain private credentials',
    test: (_path, basename) =>
      /^(?:service[-_]?account|firebase-adminsdk|gcloud-credentials).*\.json$/i.test(basename),
  },
  {
    id: 'auth-store',
    reason: 'CLI and cloud authentication stores are denied by default',
    test: (normalizedPath) =>
      /(?:^|\/)(?:\.git|\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.docker|\.config\/gcloud)(?:\/|$)/i.test(
        normalizedPath,
      ),
  },
  {
    id: 'database-credentials',
    reason: 'Password databases and vault files are denied by default',
    test: (_path, basename) => /^(?:keychain|login)\.(?:db|keychain-db)$|\.kdbx$/i.test(basename),
  },
];

export function findSensitivePath(relativePath: string): SensitivePathFinding | undefined {
  const normalized = normalizeRelativePath(relativePath);
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  const rule = SENSITIVE_RULES.find((candidate) => candidate.test(normalized, basename));
  return rule === undefined ? undefined : { ruleId: rule.id, reason: rule.reason };
}

export function isSensitivePath(relativePath: string): boolean {
  return findSensitivePath(relativePath) !== undefined;
}

export interface IgnoreSource {
  readonly name: string;
  readonly content: string;
}

export interface IgnoreRule {
  readonly source: string;
  readonly line: number;
  readonly pattern: string;
  readonly negated: boolean;
  readonly directoryOnly: boolean;
  readonly exact: RegExp;
  readonly descendant: RegExp;
}

export interface IgnoreEvaluation {
  readonly ignored: boolean;
  readonly rule?: Pick<IgnoreRule, 'source' | 'line' | 'pattern' | 'negated'>;
}

function normalizeRelativePath(candidate: string): string {
  const normalized = candidate
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/');
  const parsed = RelativePathSchema.safeParse(normalized.replace(/\/$/, ''));
  if (!parsed.success)
    throw new PathPolicyError('INVALID_PATH', parsed.error.issues[0]?.message ?? 'Invalid path');
  return parsed.data;
}

function globBodyToRegex(pattern: string): string {
  let result = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === undefined) break;
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        while (pattern[index + 1] === '*') index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          result += '(?:.*/)?';
        } else {
          result += '.*';
        }
      } else {
        result += '[^/]*';
      }
    } else if (character === '?') {
      result += '[^/]';
    } else if (character === '[') {
      const closing = pattern.indexOf(']', index + 1);
      if (closing === -1) {
        result += '\\[';
      } else {
        const content = pattern.slice(index + 1, closing).replace(/^!/, '^');
        result += `[${content.replace(/\\/g, '\\\\')}]`;
        index = closing;
      }
    } else {
      result += character.replace(/[.+^${}()|\\]/g, '\\$&');
    }
  }
  return result;
}

function compileIgnoreRule(rawLine: string, source: string, line: number): IgnoreRule | undefined {
  let value = rawLine.replace(/\r$/, '').trimEnd();
  if (value.length === 0 || value.startsWith('#')) return undefined;
  if (value.startsWith('\\#') || value.startsWith('\\!')) value = value.slice(1);
  const negated = value.startsWith('!');
  if (negated) value = value.slice(1);
  if (value.length === 0) return undefined;

  const directoryOnly = value.endsWith('/');
  if (directoryOnly) value = value.slice(0, -1);
  const anchored = value.startsWith('/');
  if (anchored) value = value.slice(1);
  if (value.length === 0 || value.includes('\0') || value.split('/').includes('..'))
    return undefined;

  const hasSlash = value.includes('/');
  const prefix = anchored || hasSlash ? '^' : '^(?:.*/)?';
  const body = globBodyToRegex(value);
  return {
    source,
    line,
    pattern: `${negated ? '!' : ''}${value}${directoryOnly ? '/' : ''}`,
    negated,
    directoryOnly,
    exact: new RegExp(`${prefix}${body}$`),
    descendant: new RegExp(`${prefix}${body}/.*$`),
  };
}

export class IgnoreMatcher {
  readonly #rules: readonly IgnoreRule[];

  public constructor(sources: readonly IgnoreSource[]) {
    this.#rules = sources.flatMap((source) =>
      source.content
        .split('\n')
        .map((line, index) => compileIgnoreRule(line, source.name, index + 1))
        .filter((rule): rule is IgnoreRule => rule !== undefined),
    );
  }

  public evaluate(relativePath: string, isDirectory = false): IgnoreEvaluation {
    const normalized = normalizeRelativePath(relativePath);
    let matchingRule: IgnoreRule | undefined;
    for (const rule of this.#rules) {
      const matchesExact = rule.exact.test(normalized) && (!rule.directoryOnly || isDirectory);
      if (matchesExact || rule.descendant.test(normalized)) matchingRule = rule;
    }
    if (matchingRule === undefined) return { ignored: false };
    return {
      ignored: !matchingRule.negated,
      rule: {
        source: matchingRule.source,
        line: matchingRule.line,
        pattern: matchingRule.pattern,
        negated: matchingRule.negated,
      },
    };
  }
}

/** Loads repository-root ignore policy in Git then Forgeboard precedence order. */
export async function loadProjectIgnoreMatcher(projectRoot: string): Promise<IgnoreMatcher> {
  const sources: IgnoreSource[] = [];
  for (const name of ['.gitignore', '.forgeboardignore'] as const) {
    const resolved = await resolveCanonicalPath(projectRoot, name);
    if (!resolved.exists) continue;
    const fileStat = await stat(resolved.path);
    if (!fileStat.isFile()) continue;
    sources.push({ name, content: await readFile(resolved.path, 'utf8') });
  }
  return new IgnoreMatcher(sources);
}

export const SENSITIVE_OVERRIDE_ACKNOWLEDGEMENT =
  'I UNDERSTAND THIS FILE MAY CONTAIN SECRETS AND APPROVE SENDING IT';

export const AttachmentOverrideSchema = z
  .object({
    relativePath: RelativePathSchema,
    reason: z.string().min(20).max(20_000),
    acknowledgement: z.literal(SENSITIVE_OVERRIDE_ACKNOWLEDGEMENT),
    approvalId: EntityIdSchema,
    approvedBy: EntityIdSchema,
    approvedAt: TimestampSchema,
  })
  .strict();
export type AttachmentOverride = z.infer<typeof AttachmentOverrideSchema>;

export const AttachmentManifestEntrySchema = z
  .object({
    relativePath: RelativePathSchema,
    canonicalPath: z.string().min(1).max(4096),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    policy: z.enum(['normal', 'ignored-override', 'sensitive-override']),
    overrideApprovalId: EntityIdSchema.optional(),
  })
  .strict();

export const AttachmentManifestSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    id: EntityIdSchema,
    projectId: EntityIdSchema,
    receivingAdapterId: EntityIdSchema,
    receivingProvider: z.string().min(1).max(300),
    createdAt: TimestampSchema,
    files: z.array(AttachmentManifestEntrySchema).max(10_000),
  })
  .strict();
export type AttachmentManifest = z.infer<typeof AttachmentManifestSchema>;

export class AttachmentPolicyError extends Error {
  public readonly code: 'IGNORED' | 'SENSITIVE' | 'NOT_A_FILE' | 'DUPLICATE';
  public readonly relativePath: string;

  public constructor(code: AttachmentPolicyError['code'], relativePath: string, message: string) {
    super(message);
    this.name = 'AttachmentPolicyError';
    this.code = code;
    this.relativePath = relativePath;
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

export interface BuildAttachmentManifestInput {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly receivingAdapterId: string;
  readonly receivingProvider: string;
  readonly relativePaths: readonly string[];
  readonly ignoreMatcher?: IgnoreMatcher;
  readonly overrides?: readonly AttachmentOverride[];
  readonly manifestId?: string;
  readonly createdAt?: string;
}

/** Builds the exact, hashed context disclosure shown before an external agent launch. */
export async function buildAttachmentManifest(
  input: BuildAttachmentManifestInput,
): Promise<AttachmentManifest> {
  const ignoreMatcher = input.ignoreMatcher ?? (await loadProjectIgnoreMatcher(input.projectRoot));
  const overrideByPath = new Map(
    (input.overrides ?? []).map((override) => {
      const validated = AttachmentOverrideSchema.parse(override);
      return [normalizeRelativePath(validated.relativePath), validated] as const;
    }),
  );
  const normalizedPaths = input.relativePaths.map(normalizeRelativePath);
  if (new Set(normalizedPaths).size !== normalizedPaths.length) {
    throw new AttachmentPolicyError(
      'DUPLICATE',
      '',
      'Attachment manifests cannot contain duplicate paths',
    );
  }

  const files = [];
  for (const relativePath of normalizedPaths) {
    const canonical = await resolveCanonicalPath(input.projectRoot, relativePath, {
      mustExist: true,
    });
    if (canonical.relativePath !== relativePath) {
      throw new AttachmentPolicyError(
        'NOT_A_FILE',
        relativePath,
        'Symbolic-link aliases cannot be attached as agent context',
      );
    }
    const fileStat = await stat(canonical.path);
    if (!fileStat.isFile()) {
      throw new AttachmentPolicyError(
        'NOT_A_FILE',
        relativePath,
        'Only regular files can be attached',
      );
    }

    const sensitive = findSensitivePath(relativePath);
    const ignore = ignoreMatcher.evaluate(relativePath);
    const override = overrideByPath.get(relativePath);
    if (sensitive !== undefined && override === undefined) {
      throw new AttachmentPolicyError('SENSITIVE', relativePath, sensitive.reason);
    }
    if (ignore?.ignored === true && override === undefined) {
      throw new AttachmentPolicyError(
        'IGNORED',
        relativePath,
        `The file is ignored by ${ignore.rule?.source ?? 'an ignore rule'}`,
      );
    }

    files.push({
      relativePath,
      canonicalPath: canonical.path,
      sizeBytes: fileStat.size,
      sha256: await sha256File(canonical.path),
      policy:
        sensitive !== undefined
          ? ('sensitive-override' as const)
          : ignore?.ignored === true
            ? ('ignored-override' as const)
            : ('normal' as const),
      ...(override === undefined ? {} : { overrideApprovalId: override.approvalId }),
    });
  }

  return AttachmentManifestSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: input.manifestId ?? randomUUID(),
    projectId: input.projectId,
    receivingAdapterId: input.receivingAdapterId,
    receivingProvider: input.receivingProvider,
    createdAt: input.createdAt ?? new Date().toISOString(),
    files,
  });
}
