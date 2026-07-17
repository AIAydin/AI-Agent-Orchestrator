import { z } from 'zod';

import {
  GitDeliveryReadinessViewSchema,
  type GitDeliveryReadinessView,
} from '../readiness/index.js';

export const GIT_REMOTE_MAX_REMOTES = 32;
export const GIT_REMOTE_MAX_COMMITS = 256;
export const GIT_REMOTE_MAX_FILES = 256;
export const GIT_REMOTE_MAX_PATH_CHARACTERS = 64 * 1_024;
export const GIT_REMOTE_MAX_DISCLOSED_COUNT = 10_000_000;

export const GitRemoteUuidSchema = z.string().uuid();
export const GitRemoteOidSchema = z.string().regex(/^[a-f0-9]{40,64}$/u);
export const GitRemoteSha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const GitRemoteTimestampSchema = z.string().datetime({ offset: true });

export const GitRemoteDeliveryTargetInputSchema = z
  .object({
    kind: z.literal('agent-worktree'),
    projectId: GitRemoteUuidSchema,
    runId: GitRemoteUuidSchema,
  })
  .strict();
export type GitRemoteDeliveryTargetInput = z.infer<typeof GitRemoteDeliveryTargetInputSchema>;

export const GitRemoteNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, 'Invalid Git remote name.');

/** Safe display identity for existing Git remotes, including names this UI will not mutate. */
export const GitRemoteDisplayNameSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      ![...value].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 31 || code === 127;
      }),
    'Git remote display names cannot contain control characters.',
  );

export const GitRemoteBranchSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(isSafeGitRef, 'Invalid Git branch name.');

export const GitRemoteRefSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(isSafeGitRef, 'Invalid Git reference.');

export const GitRemoteRelativePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(isCanonicalRelativeGitPath, 'Git paths must be normalized repository-relative paths.');

export const GitRemoteWebUrlSchema = z
  .string()
  .max(2_048)
  .url()
  .refine(isCredentialFreeWebUrl, 'URLs must be credential-free HTTP(S) URLs.');

export const GitRemoteEndpointSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(isSafeNetworkEndpoint, 'Remote endpoints cannot contain credentials or paths.');

export const GitRemoteResourceSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(isSafeRemoteResource, 'Remote resources must be normalized and path-free.');

export const GitHubOwnerRepositorySchema = z
  .string()
  .min(3)
  .max(512)
  .regex(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
    'GitHub repositories must identify one owner/repository.',
  )
  .refine(
    (value) => value.split('/').every((segment) => segment !== '.' && segment !== '..'),
    'GitHub owner and repository names cannot be dot segments.',
  );

export const GitRemoteDescriptorViewSchema = z
  .object({
    kind: z.enum(['network', 'local-filesystem']),
    name: GitRemoteDisplayNameSchema,
    endpoint: GitRemoteEndpointSchema,
    resource: GitRemoteResourceSchema,
    transport: z.enum(['https', 'http', 'ssh', 'git', 'local']),
    githubCompatible: z.boolean(),
  })
  .strict()
  .superRefine((remote, context) => {
    const local = remote.kind === 'local-filesystem';
    if (
      local !== (remote.transport === 'local') ||
      (local &&
        (remote.endpoint !== 'local-filesystem' ||
          remote.resource !== 'Local Git repository' ||
          remote.githubCompatible))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Local remotes must use the fixed path-free local disclosure.',
      });
    }
  });
export type GitRemoteDescriptorView = z.infer<typeof GitRemoteDescriptorViewSchema>;

export const GitRemoteChangedFileViewSchema = z
  .object({
    oldPath: GitRemoteRelativePathSchema.nullable(),
    newPath: GitRemoteRelativePathSchema.nullable(),
    status: z.enum(['added', 'modified', 'deleted', 'renamed', 'copied', 'binary', 'unknown']),
  })
  .strict()
  .refine((file) => file.oldPath !== null || file.newPath !== null, {
    message: 'A changed file must disclose at least one repository-relative path.',
  });
export type GitRemoteChangedFileView = z.infer<typeof GitRemoteChangedFileViewSchema>;

export const GitRemoteBoundedChangesFields = {
  commitCount: z.number().int().nonnegative().max(GIT_REMOTE_MAX_DISCLOSED_COUNT),
  commits: z.array(GitRemoteOidSchema).max(GIT_REMOTE_MAX_COMMITS),
  commitsTruncated: z.boolean(),
  fileCount: z.number().int().nonnegative().max(GIT_REMOTE_MAX_DISCLOSED_COUNT),
  files: z.array(GitRemoteChangedFileViewSchema).max(GIT_REMOTE_MAX_FILES),
  filesTruncated: z.boolean(),
  additions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  deletions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
} as const;

export const GitRemoteBoundedChangesViewSchema = z
  .object(GitRemoteBoundedChangesFields)
  .strict()
  .superRefine((changes, context) => {
    validateChangeDisclosure(changes, context, false);
  });
export type GitRemoteBoundedChangesView = z.infer<typeof GitRemoteBoundedChangesViewSchema>;

export const GitRemoteExactChangesFields = {
  commitCount: z.number().int().positive().max(GIT_REMOTE_MAX_COMMITS),
  commits: z.array(GitRemoteOidSchema).min(1).max(GIT_REMOTE_MAX_COMMITS),
  fileCount: z.number().int().nonnegative().max(GIT_REMOTE_MAX_FILES),
  files: z.array(GitRemoteChangedFileViewSchema).max(GIT_REMOTE_MAX_FILES),
  additions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  deletions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
} as const;

export const GitRemoteExactChangesViewSchema = z
  .object(GitRemoteExactChangesFields)
  .strict()
  .superRefine((changes, context) => {
    validateChangeDisclosure(
      { ...changes, commitsTruncated: false, filesTruncated: false },
      context,
      true,
    );
  });
export type GitRemoteExactChangesView = z.infer<typeof GitRemoteExactChangesViewSchema>;

export function validateBoundedChangesView(
  value: z.input<typeof GitRemoteBoundedChangesViewSchema>,
  context: z.RefinementCtx,
): void {
  appendSchemaIssues(GitRemoteBoundedChangesViewSchema.safeParse(value), context);
}

export function validateExactChangesView(
  value: z.input<typeof GitRemoteExactChangesViewSchema>,
  context: z.RefinementCtx,
): void {
  appendSchemaIssues(GitRemoteExactChangesViewSchema.safeParse(value), context);
}

export const GitRemotePlanConfirmationInputSchema = z
  .object({ planId: GitRemoteUuidSchema })
  .strict();
export type GitRemotePlanConfirmationInput = z.infer<typeof GitRemotePlanConfirmationInputSchema>;

export function validateReadyDeliveryEvidence(
  target: GitRemoteDeliveryTargetInput,
  sourceHead: string,
  readiness: GitDeliveryReadinessView,
  readinessApprovalId: string,
  context: z.RefinementCtx,
): void {
  const approval = readiness.approvals.find(
    (candidate) =>
      candidate.approvalId === readinessApprovalId &&
      candidate.authority === 'human' &&
      candidate.evidenceFingerprint === readiness.evidenceFingerprint &&
      candidate.sourceFingerprint.digest === readiness.sourceFingerprint.digest,
  );
  if (
    !readiness.evaluation.ready ||
    readiness.target.projectId !== target.projectId ||
    readiness.target.runId !== target.runId ||
    readiness.sourceFingerprint.sourceHead !== sourceHead ||
    approval === undefined
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['readiness'],
      message: 'Remote delivery requires exact passing checks and current human approval.',
    });
  }
}

export { GitDeliveryReadinessViewSchema };

function validateChangeDisclosure(
  changes: {
    readonly commitCount: number;
    readonly commits: readonly string[];
    readonly commitsTruncated: boolean;
    readonly fileCount: number;
    readonly files: readonly GitRemoteChangedFileView[];
    readonly filesTruncated: boolean;
  },
  context: z.RefinementCtx,
  exact: boolean,
): void {
  if (new Set(changes.commits).size !== changes.commits.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['commits'],
      message: 'Disclosed commits must be unique.',
    });
  }
  const pathCharacters = changes.files.reduce(
    (total, file) => total + (file.oldPath?.length ?? 0) + (file.newPath?.length ?? 0),
    0,
  );
  if (pathCharacters > GIT_REMOTE_MAX_PATH_CHARACTERS) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['files'],
      message: `Changed-file disclosure exceeds ${String(
        GIT_REMOTE_MAX_PATH_CHARACTERS,
      )} path characters.`,
    });
  }
  const commitCountMatches = changes.commitCount === changes.commits.length;
  const fileCountMatches = changes.fileCount === changes.files.length;
  if (
    changes.commitsTruncated !== !commitCountMatches ||
    changes.commitCount < changes.commits.length
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['commitsTruncated'],
      message: 'Commit truncation must match the authoritative commit count.',
    });
  }
  if (changes.filesTruncated !== !fileCountMatches || changes.fileCount < changes.files.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['filesTruncated'],
      message: 'File truncation must match the authoritative file count.',
    });
  }
  if (exact && (!commitCountMatches || !fileCountMatches)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'An actionable delivery plan must disclose its complete commit and file set.',
    });
  }
}

function isSafeGitRef(value: string): boolean {
  if (value.trim() !== value || value === '@') return false;
  if (
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.startsWith('.') ||
    value.endsWith('.') ||
    value.endsWith('.lock') ||
    value.includes('..') ||
    value.includes('//') ||
    value.includes('@{') ||
    /[\\\s~^:?*[\]]/u.test(value)
  ) {
    return false;
  }
  return (
    withoutControlCharacters(value) &&
    value
      .split('/')
      .every(
        (segment) =>
          segment !== '' &&
          !segment.startsWith('.') &&
          !segment.endsWith('.') &&
          !segment.endsWith('.lock'),
      )
  );
}

function isCanonicalRelativeGitPath(value: string): boolean {
  if (value.startsWith('/') || value.includes('\\') || /^[A-Za-z]:/u.test(value)) return false;
  if (!withoutControlCharacters(value)) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function isCredentialFreeWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.hostname !== '' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

function isSafeNetworkEndpoint(value: string): boolean {
  if (
    value.trim() !== value ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('@')
  ) {
    return false;
  }
  if (/^[A-Za-z]:/u.test(value) || !withoutControlCharacters(value)) return false;
  const hostname = value.startsWith('[')
    ? /^\[[0-9A-Fa-f:]+\](?::\d{1,5})?$/u
    : /^[A-Za-z0-9.-]+(?::\d{1,5})?$/u;
  return hostname.test(value);
}

function isSafeRemoteResource(value: string): boolean {
  if (value.trim() !== value || value.startsWith('/') || value.includes('\\')) return false;
  if (
    /^[A-Za-z]:/u.test(value) ||
    value.includes('@') ||
    value.includes('?') ||
    value.includes('#') ||
    !withoutControlCharacters(value)
  ) {
    return false;
  }
  return value
    .replace(/\.git$/u, '')
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function withoutControlCharacters(value: string): boolean {
  return ![...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function appendSchemaIssues(
  result: z.SafeParseReturnType<unknown, unknown>,
  context: z.RefinementCtx,
): void {
  if (result.success) return;
  for (const issue of result.error.issues) context.addIssue(issue);
}
