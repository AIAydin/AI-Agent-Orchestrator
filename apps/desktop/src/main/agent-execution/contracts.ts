import { createHash } from 'node:crypto';

import type {
  AgentAdapterManifest,
  AgentSession,
  CliAgentAdapter,
  PreparedAgentLaunch,
} from '@forgeboard/agent-adapters';
import {
  AgentSessionCapabilitiesSchema,
  AgentResultMetadataSchema,
  AgentUsageMetadataSchema,
  ContextAttachmentSchema,
} from '@forgeboard/agent-adapters';
import { AGENT_CONTEXT_ATTACHMENT_LIMIT, type ProcessReference } from '@forgeboard/core';
import type { WorktreeOwnership } from '@forgeboard/git-engine';
import { z } from 'zod';

import {
  PrepareRunInputSchema,
  RunDisclosureSchema,
  type AppSettings,
  type RunDisclosure,
  type RunEventEnvelope,
} from '../../shared/application/contracts.js';
import type { StoredRunRecord } from '../storage.js';

const GENERATED_CONTEXT_MAX_BYTES = 4 * 1024 * 1024;

export const GeneratedAgentContextArtifactSchema = z
  .object({
    path: z.string().min(1).max(32_768),
    content: z.string().max(GENERATED_CONTEXT_MAX_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict()
  .superRefine((artifact, context) => {
    if (artifact.path.includes('\0') || /[\r\n]/u.test(artifact.path)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['path'],
        message: 'Generated context paths cannot contain NUL bytes or line breaks.',
      });
    }
    if (Buffer.byteLength(artifact.content, 'utf8') > GENERATED_CONTEXT_MAX_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['content'],
        message: 'Generated context exceeds the 4 MiB context-file limit.',
      });
    }
    if (createHash('sha256').update(artifact.content, 'utf8').digest('hex') !== artifact.sha256) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sha256'],
        message: 'Generated context digest must match its exact UTF-8 content.',
      });
    }
  });
export type GeneratedAgentContextArtifact = z.infer<typeof GeneratedAgentContextArtifactSchema>;

export const AgentExecutionContextRequestSchema = z
  .object({
    attachments: z.array(ContextAttachmentSchema).max(AGENT_CONTEXT_ATTACHMENT_LIMIT).default([]),
    generatedArtifacts: z
      .array(GeneratedAgentContextArtifactSchema)
      .max(AGENT_CONTEXT_ATTACHMENT_LIMIT)
      .optional(),
    manifestId: z.string().min(1).max(128).optional(),
    manifestDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
  })
  .strict()
  .superRefine((context, refinement) => {
    if ((context.manifestId === undefined) !== (context.manifestDigest === undefined)) {
      refinement.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Context manifest ID and digest must be provided together.',
      });
    }
    if (
      context.attachments.length > 0 &&
      (context.manifestId === undefined || context.manifestDigest === undefined)
    ) {
      refinement.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attachments'],
        message: 'Non-empty agent context requires an exact hashed attachment manifest.',
      });
    }
    context.attachments.forEach((attachment, index) => {
      if (attachment.kind !== 'file') {
        refinement.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['attachments', index, 'kind'],
          message: 'Agent context supports explicit regular files only, not directories.',
        });
      }
      if (attachment.sha256 === undefined) {
        refinement.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['attachments', index, 'sha256'],
          message: 'Every selected context file requires its exact SHA-256 digest.',
        });
      }
    });
    const generatedPaths = new Set<string>();
    for (const [index, artifact] of (context.generatedArtifacts ?? []).entries()) {
      if (generatedPaths.has(artifact.path)) {
        refinement.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['generatedArtifacts', index, 'path'],
          message: 'Generated context artifact paths must be unique.',
        });
      }
      generatedPaths.add(artifact.path);
      const attachment = context.attachments.find(
        (candidate) => candidate.path === artifact.path && candidate.sha256 === artifact.sha256,
      );
      if (attachment?.kind !== 'file') {
        refinement.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['generatedArtifacts', index],
          message: 'Generated context must match one exact digest-bound file attachment.',
        });
      }
    }
  });
export type AgentExecutionContextRequest = z.infer<typeof AgentExecutionContextRequestSchema>;

export const AgentExecutionRequestSchema = PrepareRunInputSchema.extend({
  context: AgentExecutionContextRequestSchema,
  reviewerProtocol: z.boolean().optional(),
}).strict();
export type AgentExecutionRequest = z.infer<typeof AgentExecutionRequestSchema>;

export const PreparedAgentExecutionSchema = z
  .object({
    planId: z.string().uuid(),
    runId: z.string().uuid(),
    ownerId: z.string().min(1).max(512),
    disclosure: RunDisclosureSchema,
    disclosureFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type PreparedAgentExecution = z.infer<typeof PreparedAgentExecutionSchema>;

export const AgentExecutionCompletionSchema = z
  .object({
    runId: z.string().uuid(),
    nodeId: z.string().min(1),
    status: z.enum(['succeeded', 'failed', 'interrupted', 'terminated']),
    exitCode: z.number().int().nullable(),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    changedFiles: z.array(z.string()).max(100_000),
    outputDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    branch: z.string().nullable(),
    worktreeId: z.string().uuid().nullable(),
    worktreePath: z.string().nullable(),
    capabilities: AgentSessionCapabilitiesSchema,
    providerSessionId: AgentResultMetadataSchema.shape.providerSessionId,
    usage: AgentUsageMetadataSchema.optional(),
  })
  .strict();
export type AgentExecutionCompletion = z.infer<typeof AgentExecutionCompletionSchema>;

export interface AgentExecutionLaunchHandle {
  readonly runId: string;
  readonly process: ProcessReference | null;
  readonly capabilities: AgentSession['capabilities'];
  readonly completion: Promise<AgentExecutionCompletion>;
  writeInput(data: string): void;
  interrupt(): void;
  terminate(): Promise<void>;
}

/** Exact, owner-checked execution state is already gone (for example after autonomous expiry). */
export class AgentExecutionNotFoundError extends Error {
  public constructor(message = 'The prepared run no longer exists.') {
    super(message);
    this.name = 'AgentExecutionNotFoundError';
  }
}

export interface AgentRuntimeAdapterPlan {
  readonly adapter: CliAgentAdapter;
  readonly plan: PreparedAgentLaunch;
  readonly detectionWarnings: readonly string[];
  readonly trustedExtensionAdapter: boolean;
  /** Rechecks executable/image identities after approval and immediately before spawn. */
  readonly revalidateBeforeLaunch?: () => Promise<void>;
}

export type AgentAdapterPlanner = (
  input: AgentExecutionRequest,
  cwd: string,
  settings: AppSettings,
  runId: string,
  processAuthorization?: AgentPreparationProcessAuthorization,
  resumeSessionId?: string,
) => Promise<AgentRuntimeAdapterPlan>;

export interface AgentPreparationProcessAuthorization {
  authorize(executable: string, arguments_: readonly string[]): void | Promise<void>;
}

export type TrustedAdapterLookup = (adapterId: string) => Promise<AgentAdapterManifest | undefined>;

export type TrustedAdapterLauncher = (
  adapterId: string,
  expectedManifest: AgentAdapterManifest,
  launch: () => Promise<AgentSession>,
) => Promise<AgentSession>;

export type AgentSessionLauncher = (
  adapter: CliAgentAdapter,
  plan: PreparedAgentLaunch,
) => Promise<AgentSession>;

export interface AgentExecutionStore {
  getProject(projectId: string):
    | {
        readonly id: string;
        readonly path: string;
        readonly missing: boolean;
      }
    | undefined;
  saveRun(record: StoredRunRecord): StoredRunRecord;
  getRun?(runId: string): StoredRunRecord | undefined;
  transferRunWorktreeAuthority?(input: {
    readonly parentRunId: string;
    readonly childRunId: string;
  }): StoredRunRecord;
  transitionRunWorktreeState?(input: {
    readonly runId: string;
    readonly expectedWorktreeId: string;
    readonly expectedState: 'active' | 'cleanup-pending';
    readonly nextState: 'active' | 'cleanup-pending' | 'cleaned';
  }): StoredRunRecord;
  appendAudit(
    category: string,
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ): unknown;
}

export interface AgentExecutionOperations {
  prepare(
    ownerId: string,
    input: AgentExecutionRequest,
    processAuthorization?: AgentPreparationProcessAuthorization,
  ): Promise<PreparedAgentExecution>;
  prepareResume(
    ownerId: string,
    parentRunId: string,
    input: AgentExecutionRequest,
    processAuthorization?: AgentPreparationProcessAuthorization,
  ): Promise<PreparedAgentExecution>;
  prepareRetry(
    ownerId: string,
    parentRunId: string,
    input: AgentExecutionRequest,
    processAuthorization?: AgentPreparationProcessAuthorization,
  ): Promise<PreparedAgentExecution>;
  launch(
    ownerId: string,
    planId: string,
    disclosureFingerprint: string,
    authorizeLaunch?: () => void,
  ): Promise<AgentExecutionLaunchHandle>;
  sendInput(ownerId: string, runId: string, data: string): boolean;
  interrupt(ownerId: string, runId: string): boolean;
  terminate(ownerId: string, runId: string): Promise<boolean>;
  /** Releases every pending plan and active run owned by a disconnected caller. */
  stopOwner?(ownerId: string): Promise<void>;
  resetForPrivacy(): Promise<void>;
  pauseForDataMutation(): void;
  pauseForShutdown(): Promise<void>;
  resumeAfterPrivacyReset(): void;
  dispose(): Promise<void>;
}

export interface PreparedRunState {
  readonly adapter: CliAgentAdapter;
  readonly adapterId: AgentExecutionRequest['adapterId'];
  readonly before: WorkspaceSnapshot;
  readonly context: AgentExecutionContextRequest;
  readonly disclosure: RunDisclosure;
  readonly disclosureFingerprint: string;
  readonly expiresAt: string;
  readonly generation: number;
  readonly nodeId: string;
  readonly ownsWorktreeCleanup: boolean;
  readonly ownerId: string;
  readonly authorityParentRunId: string | null;
  readonly plan: PreparedAgentLaunch;
  readonly planId: string;
  readonly repositoryPath: string;
  readonly revalidateBeforeLaunch: (() => Promise<void>) | undefined;
  readonly trustedExtensionAdapter: boolean;
  readonly worktree: WorktreeOwnership | null;
  record: StoredRunRecord;
}

export interface WorkspaceSnapshot {
  readonly headOid: string | null;
  readonly paths: ReadonlyMap<string, string>;
}

export type AgentExecutionEventSink = (ownerId: string, event: RunEventEnvelope) => void;
