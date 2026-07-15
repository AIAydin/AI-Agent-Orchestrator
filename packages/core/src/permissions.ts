import { z } from 'zod';

import {
  CURRENT_SCHEMA_VERSION,
  EntityIdSchema,
  RelativePathSchema,
  TimestampSchema,
} from './domain.js';

export const PermissionProfileKindSchema = z.enum([
  'plan-read-only',
  'worktree-write',
  'docker-isolated',
  'custom',
]);
export type PermissionProfileKind = z.infer<typeof PermissionProfileKindSchema>;

const permissionBaseShape = {
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
  id: EntityIdSchema,
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(10_000),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
} as const;

export const HOST_CREDENTIAL_MOUNT_ACKNOWLEDGEMENT =
  'I APPROVE MOUNTING THESE HOST CREDENTIAL PATHS INTO THIS CONTAINER';

export const DockerCredentialMountSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({
      enabled: z.literal(true),
      paths: z.array(z.string().min(1).max(4096)).min(1).max(64),
      approvalId: EntityIdSchema,
      acknowledgement: z.literal(HOST_CREDENTIAL_MOUNT_ACKNOWLEDGEMENT),
    })
    .strict(),
]);

export const PlanReadOnlyPermissionProfileSchema = z
  .object({
    ...permissionBaseShape,
    kind: z.literal('plan-read-only'),
    filesystem: z.literal('project-read-only'),
    network: z.literal('provider-only'),
    processExecution: z.literal('agent-only'),
  })
  .strict();

export const WorktreeWritePermissionProfileSchema = z
  .object({
    ...permissionBaseShape,
    kind: z.literal('worktree-write'),
    filesystem: z.literal('assigned-worktree-write'),
    network: z.enum(['provider-only', 'enabled', 'disabled']),
    processExecution: z.literal('agent-and-approved-commands'),
  })
  .strict();

export const DockerIsolatedPermissionProfileSchema = z
  .object({
    ...permissionBaseShape,
    kind: z.literal('docker-isolated'),
    filesystem: z.literal('single-worktree-mount'),
    network: z.enum(['enabled', 'disabled']),
    processExecution: z.literal('container-only'),
    docker: z
      .object({
        image: z.string().min(1).max(1024),
        nonRootUser: z.string().min(1).max(128),
        cpuLimit: z.number().positive().max(1024),
        memoryMbLimit: z.number().int().positive().max(1_048_576),
        credentialMount: DockerCredentialMountSchema.default({ enabled: false }),
      })
      .strict(),
  })
  .strict();

const CustomFilesystemPolicySchema = z.enum([
  'assigned-worktree-read-only',
  'assigned-worktree-write',
  'explicit-paths',
]);

const CustomManagedActionPolicySchema = z
  .object({
    developmentServers: z.enum(['deny', 'allow']),
    tests: z.enum(['deny', 'allow']),
  })
  .strict();

const AbsoluteExecutablePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\0') && !/[\r\n]/u.test(value))
  .refine(
    (value) => value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\'),
    'Launch executable paths must be absolute',
  );

const CustomRelativeRootSchema = RelativePathSchema.refine(
  (value) =>
    value === '.' ||
    (!value.includes('\\') &&
      !value.endsWith('/') &&
      !value.includes('//') &&
      value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')),
  'Permission roots must use normalized forward-slash relative paths',
);

const customPermissionShape = {
  ...permissionBaseShape,
  kind: z.literal('custom'),
  filesystem: CustomFilesystemPolicySchema,
  readPaths: z.array(CustomRelativeRootSchema).min(1).max(256),
  writePaths: z.array(CustomRelativeRootSchema).max(256),
  ignoredFileRead: z.enum(['deny', 'allow']),
  sensitiveFileRead: z.enum(['deny', 'allow']),
  executablePolicy: z.enum(['selected-agent-only', 'allowlist']),
  allowedLaunchExecutables: z.array(AbsoluteExecutablePathSchema).max(256),
  forgeboardManagedActions: CustomManagedActionPolicySchema,
  processExecution: z.enum(['agent-only', 'agent-and-approved-commands', 'disabled']),
  requireReviewBeforePrimary: z.literal(true),
} as const;

interface CustomPolicyRefinementValue {
  readonly filesystem: 'assigned-worktree-read-only' | 'assigned-worktree-write' | 'explicit-paths';
  readonly readPaths: readonly string[];
  readonly writePaths: readonly string[];
  readonly executablePolicy: 'selected-agent-only' | 'allowlist';
  readonly allowedLaunchExecutables: readonly string[];
}

function refineCustomPolicy(profile: CustomPolicyRefinementValue, context: z.RefinementCtx): void {
  if (new Set(profile.readPaths).size !== profile.readPaths.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['readPaths'],
      message: 'Read roots must be unique',
    });
  }
  if (new Set(profile.writePaths).size !== profile.writePaths.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['writePaths'],
      message: 'Write roots must be unique',
    });
  }
  if (new Set(profile.allowedLaunchExecutables).size !== profile.allowedLaunchExecutables.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['allowedLaunchExecutables'],
      message: 'Launch executable paths must be unique',
    });
  }
  const wholeRead = profile.readPaths.length === 1 && profile.readPaths[0] === '.';
  const wholeWrite = profile.writePaths.length === 1 && profile.writePaths[0] === '.';
  if (
    profile.filesystem === 'assigned-worktree-read-only' &&
    (!wholeRead || profile.writePaths.length > 0)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['filesystem'],
      message: 'Read-only worktree profiles require readPaths [.] and no write paths',
    });
  }
  if (profile.filesystem === 'assigned-worktree-write' && (!wholeRead || !wholeWrite)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['filesystem'],
      message: 'Writable worktree profiles require readPaths and writePaths [.]',
    });
  }
  for (const [index, writePath] of profile.writePaths.entries()) {
    if (!profile.readPaths.some((readPath) => rootContains(readPath, writePath))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['writePaths', index],
        message: 'Every write root must be covered by a read root',
      });
    }
  }
  if (
    profile.executablePolicy === 'selected-agent-only' &&
    profile.allowedLaunchExecutables.length > 0
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['allowedLaunchExecutables'],
      message: 'Selected-agent-only profiles cannot store an allowlist',
    });
  }
  if (profile.executablePolicy === 'allowlist' && profile.allowedLaunchExecutables.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['allowedLaunchExecutables'],
      message: 'Allowlist profiles require an executable path',
    });
  }
}

function rootContains(parent: string, candidate: string): boolean {
  return parent === '.' || candidate === parent || candidate.startsWith(`${parent}/`);
}

export const CustomHostPermissionProfileSchema = z
  .object({
    ...customPermissionShape,
    runtime: z.literal('host'),
    network: z.literal('provider-only'),
    acknowledgesCwdIsNotSandbox: z.literal(true),
  })
  .strict()
  .superRefine(refineCustomPolicy);

export const CustomDockerPermissionProfileSchema = z
  .object({
    ...customPermissionShape,
    runtime: z.literal('docker'),
    filesystem: z.enum(['assigned-worktree-read-only', 'assigned-worktree-write']),
    network: z.enum(['enabled', 'disabled']),
    docker: z
      .object({
        cpuLimit: z.number().positive().max(1024),
        memoryMbLimit: z.number().int().positive().max(1_048_576),
        credentialMount: DockerCredentialMountSchema.default({ enabled: false }),
      })
      .strict(),
  })
  .strict()
  .superRefine((profile, context) => {
    refineCustomPolicy(profile, context);
    if (profile.ignoredFileRead !== 'allow' || profile.sensitiveFileRead !== 'allow') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ignoredFileRead'],
        message: 'A whole-worktree Docker bind requires explicit ignored and sensitive visibility',
      });
    }
  });

export const CustomPermissionProfileSchema = z.union([
  CustomHostPermissionProfileSchema,
  CustomDockerPermissionProfileSchema,
]);

export const PermissionProfileSchema = z.union([
  PlanReadOnlyPermissionProfileSchema,
  WorktreeWritePermissionProfileSchema,
  DockerIsolatedPermissionProfileSchema,
  CustomPermissionProfileSchema,
]);
export type PermissionProfile = z.infer<typeof PermissionProfileSchema>;

export const ApprovalActionSchema = z.enum([
  'agent-launch',
  'command-execute',
  'sensitive-file-override',
  'git-push',
  'pull-request-create',
  'git-merge',
  'git-squash',
  'git-rebase',
  'git-cherry-pick',
  'git-destructive',
  'worktree-remove',
  'branch-delete',
  'external-open',
  'collaboration-join',
  'data-export',
  'external-send',
  'permission-expand',
]);
export type ApprovalAction = z.infer<typeof ApprovalActionSchema>;

export const ApprovalScopeSchema = z
  .object({
    projectId: EntityIdSchema,
    action: ApprovalActionSchema,
    resourceFingerprint: z.string().min(16).max(512),
    agentId: EntityIdSchema.optional(),
    runId: EntityIdSchema.optional(),
  })
  .strict();

export const ApprovalRecordSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    id: EntityIdSchema,
    scope: ApprovalScopeSchema,
    decision: z.enum(['approved', 'denied']),
    decidedBy: EntityIdSchema,
    reason: z.string().min(1).max(20_000),
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema,
    revokedAt: TimestampSchema.optional(),
    consumedAt: TimestampSchema.optional(),
    singleUse: z.boolean().default(true),
  })
  .strict()
  .superRefine((approval, context) => {
    if (Date.parse(approval.expiresAt) <= Date.parse(approval.createdAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'Approval expiry must be later than creation',
      });
    }
    if (
      approval.revokedAt !== undefined &&
      Date.parse(approval.revokedAt) < Date.parse(approval.createdAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['revokedAt'],
        message: 'Approval cannot be revoked before it exists',
      });
    }
  });
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

export const ImpactConfirmationSchema = z
  .object({
    action: ApprovalActionSchema,
    title: z.string().min(1).max(300),
    impact: z.string().min(20).max(20_000),
    affectedResources: z.array(z.string().min(1).max(4096)).min(1).max(10_000),
    requiredPhrase: z.string().min(8).max(300),
    enteredPhrase: z.string().max(300),
  })
  .strict();
export type ImpactConfirmation = z.infer<typeof ImpactConfirmationSchema>;

export function isImpactConfirmationSatisfied(confirmation: ImpactConfirmation): boolean {
  return confirmation.enteredPhrase === confirmation.requiredPhrase;
}

export function isApprovalActive(
  approval: ApprovalRecord,
  expectedScope: z.infer<typeof ApprovalScopeSchema>,
  now = new Date(),
): boolean {
  if (approval.decision !== 'approved' || approval.revokedAt !== undefined) return false;
  if (approval.singleUse && approval.consumedAt !== undefined) return false;
  if (Date.parse(approval.expiresAt) <= now.getTime()) return false;
  return (
    approval.scope.projectId === expectedScope.projectId &&
    approval.scope.action === expectedScope.action &&
    approval.scope.resourceFingerprint === expectedScope.resourceFingerprint &&
    approval.scope.agentId === expectedScope.agentId &&
    approval.scope.runId === expectedScope.runId
  );
}
