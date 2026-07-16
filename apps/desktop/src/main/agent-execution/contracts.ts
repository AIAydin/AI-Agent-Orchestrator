import type {
  AgentAdapterManifest,
  AgentSession,
  CliAgentAdapter,
  PreparedAgentLaunch,
} from '@forgeboard/agent-adapters';
import { ContextAttachmentSchema } from '@forgeboard/agent-adapters';
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

export const AgentExecutionContextRequestSchema = z
  .object({
    attachments: z.array(ContextAttachmentSchema).max(AGENT_CONTEXT_ATTACHMENT_LIMIT).default([]),
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
  });
export type AgentExecutionContextRequest = z.infer<typeof AgentExecutionContextRequestSchema>;

export const AgentExecutionRequestSchema = PrepareRunInputSchema.extend({
  context: AgentExecutionContextRequestSchema,
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
    worktreePath: z.string().nullable(),
    providerSessionId: z.string().optional(),
  })
  .strict();
export type AgentExecutionCompletion = z.infer<typeof AgentExecutionCompletionSchema>;

export interface AgentExecutionLaunchHandle {
  readonly runId: string;
  readonly process: ProcessReference | null;
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
  readonly ownerId: string;
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
