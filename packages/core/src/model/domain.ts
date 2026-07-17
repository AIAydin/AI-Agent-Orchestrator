import { z } from 'zod';

export const CURRENT_SCHEMA_VERSION = 1 as const;

export const EntityIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Invalid entity identifier');

export const TimestampSchema = z.string().datetime({ offset: true });
export const RelativePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\0'), 'Paths cannot contain NUL bytes')
  .refine(
    (value) => !value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value),
    'Path must be relative',
  )
  .refine(
    (value) => !value.replaceAll('\\', '/').split('/').includes('..'),
    'Path cannot traverse outside its root',
  );

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);

export const RunStatusSchema = z.enum([
  'queued',
  'running',
  'waiting-for-approval',
  'paused',
  'cancelling',
  'failed',
  'succeeded',
  'cancelled',
  'lost',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const NodeStatusSchema = z.enum(['draft', 'ready', ...RunStatusSchema.options, 'blocked']);
export type NodeStatus = z.infer<typeof NodeStatusSchema>;

export const PointSchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
export const SizeSchema = z
  .object({ width: z.number().finite().positive(), height: z.number().finite().positive() })
  .strict();

export const LocalFileReferenceSchema = z
  .object({
    projectId: EntityIdSchema,
    relativePath: RelativePathSchema,
    kind: z.enum(['file', 'directory', 'image', 'artifact']),
    missing: z.boolean().default(false),
    lastKnownHash: z.string().min(8).max(256).optional(),
  })
  .strict();

export const CommentSchema = z
  .object({
    id: EntityIdSchema,
    authorId: EntityIdSchema,
    scope: z.enum(['local', 'shared']).optional(),
    body: z.string().min(1).max(100_000),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema.optional(),
    resolvedAt: TimestampSchema.optional(),
  })
  .strict();

export const ResourceRequirementsSchema = z
  .object({
    cpuUnits: z.number().int().positive().max(1024).default(1),
    memoryMb: z.number().int().positive().max(1_048_576).default(256),
    exclusiveKeys: z.array(z.string().min(1).max(128)).max(64).default([]),
  })
  .strict();

const baseNodeShape = {
  id: EntityIdSchema,
  title: z.string().min(1).max(300),
  color: z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/),
  icon: z.string().min(1).max(100),
  position: PointSchema,
  size: SizeSchema,
  collapsed: z.boolean().default(false),
  locked: z.boolean().default(false),
  groupId: EntityIdSchema.optional(),
  comments: z.array(CommentSchema).default([]),
  status: NodeStatusSchema.default('draft'),
  runHistoryIds: z.array(EntityIdSchema).default([]),
  inspector: z.record(JsonValueSchema).default({}),
  resources: ResourceRequirementsSchema.default({}),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
} as const;

const createNodeSchema = <TType extends string, TData extends z.ZodTypeAny>(
  type: TType,
  data: TData,
) => z.object({ ...baseNodeShape, type: z.literal(type), data }).strict();

export const CommandSpecSchema = z
  .object({
    executable: z.string().min(1).max(4096),
    args: z.array(z.string().max(32_768)).max(512).default([]),
    cwdRelative: RelativePathSchema.optional(),
    environmentNames: z
      .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
      .max(512)
      .default([]),
  })
  .strict();

export const AcceptanceCriterionSchema = z
  .object({
    id: EntityIdSchema,
    description: z.string().min(1).max(10_000),
    satisfied: z.boolean().default(false),
    evidence: z.string().max(20_000).optional(),
  })
  .strict();

export const AGENT_CONTEXT_ATTACHMENT_LIMIT = 256;

export const AgentNodeSchema = createNodeSchema(
  'agent',
  z
    .object({
      adapterId: EntityIdSchema.optional(),
      model: z.string().min(1).max(200).optional(),
      permissionProfileId: EntityIdSchema.optional(),
      worktreeId: EntityIdSchema.optional(),
      branch: z.string().min(1).max(1024).optional(),
      // Persisted canvases predate the execution cap and must remain openable without silently
      // discarding selected context. UI linking and every run boundary enforce the limit above.
      contextAttachmentIds: z.array(EntityIdSchema).default([]),
      promptDraft: z.string().max(1_000_000).default(''),
      activeSessionId: EntityIdSchema.optional(),
      streamedOutputArtifactId: EntityIdSchema.optional(),
      pauseSupported: z.boolean().default(false),
      interruptSupported: z.boolean().default(true),
      resumeSupported: z.boolean().default(false),
      tokenUsage: z
        .object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() })
        .strict()
        .optional(),
      cost: z
        .object({ amount: z.number().finite().nonnegative(), currency: z.string().length(3) })
        .strict()
        .optional(),
    })
    .strict(),
);

export const ProductBriefNodeSchema = createNodeSchema(
  'product-brief',
  z
    .object({
      markdown: z.string().max(2_000_000).default(''),
      checklist: z
        .array(
          z
            .object({
              id: EntityIdSchema,
              label: z.string().min(1).max(10_000),
              checked: z.boolean(),
            })
            .strict(),
        )
        .default([]),
      attachmentIds: z.array(EntityIdSchema).default([]),
      acceptanceCriteria: z.array(AcceptanceCriterionSchema).default([]),
      versions: z
        .array(
          z
            .object({
              id: EntityIdSchema,
              createdAt: TimestampSchema,
              markdown: z.string().max(2_000_000),
              authorId: EntityIdSchema,
            })
            .strict(),
        )
        .default([]),
      variables: z.record(z.string().max(100_000)).default({}),
    })
    .strict(),
);

export const TaskNodeSchema = createNodeSchema(
  'task',
  z
    .object({
      description: z.string().max(1_000_000).default(''),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
      assigneeId: EntityIdSchema.optional(),
      dependencyTaskIds: z.array(EntityIdSchema).default([]),
      acceptanceCriteria: z.array(AcceptanceCriterionSchema).default([]),
      relatedFiles: z.array(LocalFileReferenceSchema).default([]),
      taskStatus: z
        .enum(['backlog', 'ready', 'in-progress', 'review', 'done', 'cancelled'])
        .default('backlog'),
    })
    .strict(),
);

export const FileNodeSchema = createNodeSchema(
  'file',
  z
    .object({
      file: LocalFileReferenceSchema.optional(),
      language: z.string().max(100).optional(),
      dirty: z.boolean().default(false),
      historyRefs: z.array(z.string().min(1).max(1024)).default([]),
      readOnly: z.boolean().default(false),
      recoverableWarning: z.string().max(10_000).optional(),
    })
    .strict(),
);

export const DiffReviewTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('primary') }).strict(),
  z
    .object({
      kind: z.literal('agent-run'),
      runId: z.string().uuid(),
    })
    .strict(),
]);
export type DiffReviewTarget = z.infer<typeof DiffReviewTargetSchema>;

export const DiffReviewNodeSchema = createNodeSchema(
  'diff-review',
  z
    .object({
      // The main process resolves this opaque identity. Persisted canvases never carry a checkout
      // root or renderer-supplied worktree path as review authority.
      reviewTarget: DiffReviewTargetSchema.optional(),
      baseRef: z.string().min(1).max(1024).optional(),
      headRef: z.string().min(1).max(1024).optional(),
      worktreeId: EntityIdSchema.optional(),
      files: z.array(RelativePathSchema).default([]),
      viewMode: z.enum(['split', 'unified']).default('split'),
      showWhitespace: z.boolean().default(false),
      ignoreWhitespace: z.boolean().default(false),
      hunkDecisions: z.record(z.enum(['pending', 'accepted', 'rejected'])).default({}),
      lineCommentIds: z.array(EntityIdSchema).default([]),
      revisionRequest: z.string().max(200_000).optional(),
      approval: z.enum(['pending', 'approved', 'changes-requested']).default('pending'),
    })
    .strict(),
);

export const TerminalNodeSchema = createNodeSchema(
  'terminal',
  z
    .object({
      cwdRelative: RelativePathSchema.optional(),
      processStatus: z
        .enum(['idle', 'starting', 'running', 'stopped', 'failed', 'lost'])
        .default('idle'),
      permissionProfileId: EntityIdSchema.optional(),
      command: CommandSpecSchema.optional(),
      ptySessionId: EntityIdSchema.optional(),
      historyArtifactId: EntityIdSchema.optional(),
      lastExitCode: z.number().int().min(-1).max(255).optional(),
    })
    .strict(),
);

const PreviewTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('primary') }).strict(),
  z.object({ kind: z.literal('agent-run'), runId: z.string().uuid() }).strict(),
]);

const PreviewUrlPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith('/') && !value.startsWith('//') && !value.includes('\0'), {
    message: 'Preview paths must be absolute URL paths.',
  });

const PreviewPresetSchema = z.enum(['desktop', 'laptop', 'iphone', 'pixel', 'tablet']);

const PreviewConfigurationShape = {
  target: PreviewTargetSchema.default({ kind: 'primary' }),
  command: CommandSpecSchema.optional(),
  packageScript: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u)
    .optional(),
  cwdRelative: RelativePathSchema.default('.'),
  readinessPath: PreviewUrlPathSchema.default('/'),
  urlPath: PreviewUrlPathSchema.default('/'),
  preset: PreviewPresetSchema.optional(),
  secondaryPreset: PreviewPresetSchema.optional(),
  orientation: z.enum(['portrait', 'landscape']).default('portrait'),
  sideBySide: z.boolean().default(false),
} as const;

export const WebPreviewNodeSchema = createNodeSchema(
  'web-preview',
  z
    .object({
      ...PreviewConfigurationShape,
      serverId: EntityIdSchema.optional(),
      worktreeId: EntityIdSchema.optional(),
      url: z.string().url().optional(),
      detectedUrl: z.boolean().default(false),
      viewport: SizeSchema.default({ width: 1440, height: 900 }),
      navigationHistory: z.array(z.string().url()).max(500).default([]),
      consoleArtifactId: EntityIdSchema.optional(),
      errorArtifactId: EntityIdSchema.optional(),
      screenshotIds: z.array(EntityIdSchema).default([]),
    })
    .strict(),
);

const MobileViewportSchema = z
  .object({
    id: EntityIdSchema,
    name: z.string().min(1).max(200),
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
    orientation: z.enum(['portrait', 'landscape']),
    touch: z.boolean().default(true),
  })
  .strict();

export const MobilePreviewNodeSchema = createNodeSchema(
  'mobile-preview',
  z
    .object({
      ...PreviewConfigurationShape,
      serverId: EntityIdSchema.optional(),
      worktreeId: EntityIdSchema.optional(),
      url: z.string().url().optional(),
      viewports: z.array(MobileViewportSchema).max(12).default([]),
      synchronizedNavigation: z.boolean().default(true),
      screenshotIds: z.array(EntityIdSchema).default([]),
    })
    .strict(),
);

export const TestNodeSchema = createNodeSchema(
  'test',
  z
    .object({
      command: CommandSpecSchema.optional(),
      runIds: z.array(EntityIdSchema).default([]),
      summary: z
        .object({
          passed: z.number().int().nonnegative(),
          failed: z.number().int().nonnegative(),
          skipped: z.number().int().nonnegative(),
        })
        .strict()
        .optional(),
      artifactIds: z.array(EntityIdSchema).default([]),
    })
    .strict(),
);

export const ReviewGateNodeSchema = createNodeSchema(
  'review-gate',
  z
    .object({
      humanApprovalRequired: z.boolean().default(true),
      requiredCheckIds: z.array(EntityIdSchema).default([]),
      lintRequired: z.boolean().default(false),
      testsRequired: z.boolean().default(false),
      reviewerAgentId: EntityIdSchema.optional(),
      retryPolicy: z
        .object({
          maximumIterations: z.number().int().min(1).max(100),
          backoffMs: z.number().int().min(0).max(86_400_000),
        })
        .strict()
        .default({ maximumIterations: 3, backoffMs: 0 }),
      gateState: z.enum(['pending', 'passed', 'failed', 'waiting-for-human']).default('pending'),
    })
    .strict(),
);

export const GitPullRequestDeliveryTargetSchema = z
  .object({
    kind: z.literal('agent-run'),
    runId: z.string().uuid(),
  })
  .strict();
export type GitPullRequestDeliveryTarget = z.infer<typeof GitPullRequestDeliveryTargetSchema>;

const GitRemoteNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Invalid Git remote name');

const GitBranchNameSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(isSafeGitBranchName, 'Invalid Git branch name');

const PullRequestTitleSchema = z
  .string()
  .max(512)
  .refine((value) => !value.includes('\0'), 'Pull request text cannot contain NUL bytes');

const PullRequestBodySchema = z
  .string()
  .max(32_768)
  .refine((value) => !value.includes('\0'), 'Pull request text cannot contain NUL bytes');

const PullRequestWebUrlSchema = z
  .string()
  .max(2_048)
  .url()
  .refine(
    isCredentialFreePullRequestUrl,
    'Pull request URLs must be credential-free HTTP(S) pull request links',
  );

export const GitPullRequestNodeSchema = createNodeSchema(
  'git-pr',
  z
    .object({
      // Main resolves this opaque persisted identity. Every branch, OID, path, check, and URL below
      // is configuration or cached display only and never grants delivery authority.
      deliveryTarget: GitPullRequestDeliveryTargetSchema.optional(),
      // Retained so legacy canvases remain openable; delivery never resolves authority from it.
      worktreeId: EntityIdSchema.optional(),
      branch: z.string().min(1).max(1024).optional(),
      remote: GitRemoteNameSchema.optional(),
      destinationBranch: GitBranchNameSchema.optional(),
      baseBranch: GitBranchNameSchema.optional(),
      pullRequestTitle: PullRequestTitleSchema.optional(),
      pullRequestBody: PullRequestBodySchema.optional(),
      pullRequestDraft: z.boolean().default(false),
      commitIds: z.array(z.string().regex(/^[0-9a-f]{7,64}$/i)).default([]),
      ahead: z.number().int().nonnegative().default(0),
      behind: z.number().int().nonnegative().default(0),
      mergeReadiness: z
        .enum(['unknown', 'ready', 'conflicts', 'checks-failing'])
        .default('unknown'),
      pullRequestUrl: PullRequestWebUrlSchema.optional(),
      checkIds: z.array(EntityIdSchema).default([]),
    })
    .strict(),
);

function isSafeGitBranchName(value: string): boolean {
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
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    }) &&
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

function isCredentialFreePullRequestUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      parsed.hostname !== '' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.search === '' &&
      parsed.hash === '' &&
      /^\/[^/]+\/[^/]+\/pull\/[1-9]\d*\/?$/u.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

export const DiagramNodeSchema = createNodeSchema(
  'diagram',
  z
    .object({
      mermaidSource: z.string().max(2_000_000).default(''),
      exportArtifactIds: z.array(EntityIdSchema).default([]),
      lastRenderError: z.string().max(20_000).optional(),
      agentEditable: z.boolean().default(true),
    })
    .strict(),
);

export const WhiteboardMockupNodeSchema = createNodeSchema(
  'whiteboard-mockup',
  z
    .object({
      excalidraw: JsonValueSchema.default({}),
      annotationIds: z.array(EntityIdSchema).default([]),
      exportArtifactIds: z.array(EntityIdSchema).default([]),
      contextSpecificationArtifactId: EntityIdSchema.optional(),
    })
    .strict(),
);

export const NoteImageNodeSchema = createNodeSchema(
  'note-image',
  z
    .object({
      markdown: z.string().max(1_000_000).default(''),
      images: z.array(LocalFileReferenceSchema).default([]),
      altText: z.record(z.string().max(10_000)).default({}),
    })
    .strict(),
);

export const GroupFrameNodeSchema = createNodeSchema(
  'group-frame',
  z
    .object({
      purpose: z.enum(['product-surface', 'workflow-stage', 'feature-area', 'custom']),
      childNodeIds: z.array(EntityIdSchema).default([]),
      layout: z.enum(['freeform', 'horizontal', 'vertical', 'grid']).default('freeform'),
      autoFit: z.boolean().default(false),
    })
    .strict(),
);

export const ExtensionNodeSchema = createNodeSchema(
  'extension',
  z
    .object({
      extensionId: EntityIdSchema,
      extensionVersion: z.string().min(1).max(128),
      nodeTypeId: EntityIdSchema,
      definition: JsonValueSchema,
      values: z.record(JsonValueSchema).default({}),
      availability: z.enum(['active', 'quarantined', 'unavailable']).default('active'),
    })
    .strict(),
);

export const CanvasNodeSchema = z.discriminatedUnion('type', [
  AgentNodeSchema,
  ProductBriefNodeSchema,
  TaskNodeSchema,
  FileNodeSchema,
  DiffReviewNodeSchema,
  TerminalNodeSchema,
  WebPreviewNodeSchema,
  MobilePreviewNodeSchema,
  TestNodeSchema,
  ReviewGateNodeSchema,
  GitPullRequestNodeSchema,
  DiagramNodeSchema,
  WhiteboardMockupNodeSchema,
  NoteImageNodeSchema,
  GroupFrameNodeSchema,
  ExtensionNodeSchema,
]);
export type CanvasNode = z.infer<typeof CanvasNodeSchema>;
export type CanvasNodeType = CanvasNode['type'];

const edgeBaseShape = {
  id: EntityIdSchema,
  sourceNodeId: EntityIdSchema,
  targetNodeId: EntityIdSchema,
  sourceHandle: z.string().min(1).max(100).optional(),
  targetHandle: z.string().min(1).max(100).optional(),
  label: z.string().max(300).optional(),
  status: RunStatusSchema.optional(),
  inspector: z.record(JsonValueSchema).default({}),
  createdAt: TimestampSchema,
} as const;

const createEdgeSchema = <TType extends string, TConfig extends z.ZodTypeAny>(
  type: TType,
  config: TConfig,
) => z.object({ ...edgeBaseShape, type: z.literal(type), config }).strict();

export const ContextEdgeSchema = createEdgeSchema(
  'context',
  z
    .object({
      attachmentMode: z.literal('explicit').default('explicit'),
      required: z.boolean().default(true),
      attachmentIds: z.array(EntityIdSchema).default([]),
    })
    .strict(),
);
export const ExecuteEdgeSchema = createEdgeSchema(
  'execute',
  z
    .object({
      trigger: z.enum(['on-success', 'on-completion']).default('on-success'),
      approval: z.enum(['none', 'human', 'review-gate']).default('none'),
      approvalGateNodeId: EntityIdSchema.optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.approval === 'review-gate' && value.approvalGateNodeId === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['approvalGateNodeId'],
          message: 'A review gate is required',
        });
      }
      if (value.approval !== 'review-gate' && value.approvalGateNodeId !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['approvalGateNodeId'],
          message: 'Only review-gate approval accepts a gate node',
        });
      }
    }),
);
export const OutputEdgeSchema = createEdgeSchema(
  'output',
  z
    .object({
      outputKind: z.enum(['branch', 'diff', 'preview', 'test-result', 'artifact']),
      required: z.boolean().default(true),
    })
    .strict(),
);
export const ReviewEdgeSchema = createEdgeSchema(
  'review',
  z
    .object({
      reviewer: z.enum(['human', 'agent', 'gate']),
      requireApproval: z.boolean().default(true),
      structuredFindings: z.boolean().default(true),
    })
    .strict(),
);
export const RevisionEdgeSchema = createEdgeSchema(
  'revision',
  z
    .object({
      loopId: EntityIdSchema.optional(),
      actionableFeedbackRequired: z.literal(true).default(true),
    })
    .strict(),
);
export const DependencyEdgeSchema = createEdgeSchema(
  'dependency',
  z.object({ requiredStatus: z.literal('succeeded').default('succeeded') }).strict(),
);

export const CanvasEdgeSchema = z.discriminatedUnion('type', [
  ContextEdgeSchema,
  ExecuteEdgeSchema,
  OutputEdgeSchema,
  ReviewEdgeSchema,
  RevisionEdgeSchema,
  DependencyEdgeSchema,
]);
export type CanvasEdge = z.infer<typeof CanvasEdgeSchema>;
export type CanvasEdgeType = CanvasEdge['type'];

export const RevisionLoopSchema = z
  .object({
    id: EntityIdSchema,
    implementationNodeId: EntityIdSchema,
    reviewNodeId: EntityIdSchema,
    reviewEdgeId: EntityIdSchema,
    revisionEdgeId: EntityIdSchema,
    maximumAttempts: z.number().int().min(1).max(100),
    stopConditions: z
      .array(z.enum(['review-approved', 'tests-passed', 'human-accepted']))
      .min(1)
      .max(3),
    humanEscapeHatch: z
      .object({
        enabled: z.literal(true),
        approvalRequired: z.literal(true),
        instructions: z.string().min(10).max(10_000),
      })
      .strict(),
  })
  .strict();
export type RevisionLoop = z.infer<typeof RevisionLoopSchema>;

export const CanvasGroupSchema = z
  .object({
    id: EntityIdSchema,
    title: z.string().min(1).max(300),
    nodeIds: z.array(EntityIdSchema).default([]),
    position: PointSchema,
    size: SizeSchema,
    color: z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/),
    locked: z.boolean().default(false),
  })
  .strict();

export const CanvasViewStateSchema = z
  .object({
    viewport: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        zoom: z.number().positive().max(16),
      })
      .strict(),
    selectedNodeIds: z.array(EntityIdSchema).default([]),
    selectedEdgeIds: z.array(EntityIdSchema).default([]),
    minimapVisible: z.boolean().default(true),
    snapToGrid: z.boolean().default(false),
    gridSize: z.number().int().positive().max(1000).default(16),
  })
  .strict();

export const WorkflowLimitsSchema = z
  .object({
    maximumConcurrency: z.number().int().min(1).max(256).default(4),
    maximumCpuUnits: z.number().int().min(1).max(4096).default(16),
    maximumMemoryMb: z.number().int().min(128).max(4_194_304).default(16_384),
  })
  .strict();

export const CanvasSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    id: EntityIdSchema,
    projectId: EntityIdSchema,
    name: z.string().min(1).max(300),
    nodes: z.array(CanvasNodeSchema).default([]),
    edges: z.array(CanvasEdgeSchema).default([]),
    groups: z.array(CanvasGroupSchema).default([]),
    viewState: CanvasViewStateSchema,
    revisionLoops: z.array(RevisionLoopSchema).default([]),
    workflowLimits: WorkflowLimitsSchema.default({}),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type Canvas = z.infer<typeof CanvasSchema>;

export const RepositoryLocationSchema = z
  .object({
    path: z.string().min(1).max(4096),
    canonicalPath: z.string().min(1).max(4096),
    status: z.enum(['available', 'missing', 'moved', 'unauthorized']),
    lastVerifiedAt: TimestampSchema,
  })
  .strict();

export const ProjectSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    id: EntityIdSchema,
    name: z.string().min(1).max(300),
    repository: RepositoryLocationSchema,
    canvasIds: z.array(EntityIdSchema).default([]),
    defaultCanvasId: EntityIdSchema.optional(),
    settingsId: EntityIdSchema,
    archivedAt: TimestampSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((project, context) => {
    if (
      project.defaultCanvasId !== undefined &&
      !project.canvasIds.includes(project.defaultCanvasId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultCanvasId'],
        message: 'The default canvas must belong to the project',
      });
    }
  });
export type Project = z.infer<typeof ProjectSchema>;

export const CheckResultSchema = z
  .object({
    id: EntityIdSchema,
    runId: EntityIdSchema,
    producerNodeId: EntityIdSchema.optional(),
    producerAttempt: z.number().int().positive().optional(),
    reviewedNodeId: EntityIdSchema.optional(),
    reviewedNodeAttempt: z.number().int().positive().optional(),
    reviewedOutputDigest: z.string().min(8).max(256).optional(),
    kind: z.enum(['lint', 'typecheck', 'test', 'build', 'custom']),
    command: CommandSpecSchema,
    status: z.enum(['queued', 'running', 'passed', 'failed', 'cancelled', 'lost']),
    exitCode: z.number().int().min(-1).max(255).optional(),
    startedAt: TimestampSchema.optional(),
    endedAt: TimestampSchema.optional(),
    rawOutputArtifactId: EntityIdSchema.optional(),
    summary: JsonValueSchema.optional(),
  })
  .strict();
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const TaskRecordSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    id: EntityIdSchema,
    projectId: EntityIdSchema,
    canvasId: EntityIdSchema,
    nodeId: EntityIdSchema,
    status: z.enum(['backlog', 'ready', 'in-progress', 'review', 'done', 'cancelled']),
    acceptanceCriteria: z.array(AcceptanceCriterionSchema),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

export const SessionRecordSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    id: EntityIdSchema,
    projectId: EntityIdSchema,
    nodeId: EntityIdSchema,
    adapterId: EntityIdSchema,
    provider: z.string().min(1).max(200),
    status: RunStatusSchema,
    externalSessionId: z.string().min(1).max(2048).optional(),
    transcriptArtifactId: EntityIdSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

export const WorktreeRecordSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    id: EntityIdSchema,
    projectId: EntityIdSchema,
    runId: EntityIdSchema,
    branch: z.string().min(1).max(1024),
    canonicalPath: z.string().min(1).max(4096),
    baseCommit: z.string().regex(/^[0-9a-f]{7,64}$/i),
    ownerAdapterId: EntityIdSchema,
    status: z.enum(['provisioning', 'active', 'archived', 'cleanup-pending', 'removed', 'lost']),
    cleanupPolicy: z.enum(['manual', 'after-merge', 'after-retention']),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type WorktreeRecord = z.infer<typeof WorktreeRecordSchema>;

export const SnapshotRecordSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    id: EntityIdSchema,
    projectId: EntityIdSchema,
    canvasId: EntityIdSchema,
    kind: z.enum(['autosave', 'manual', 'undo-checkpoint', 'recovery']),
    sequence: z.number().int().nonnegative(),
    contentHash: z.string().min(8).max(256),
    storageReference: z.string().min(1).max(4096),
    createdAt: TimestampSchema,
  })
  .strict();
export type SnapshotRecord = z.infer<typeof SnapshotRecordSchema>;

export const CollaborationRecordSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    id: EntityIdSchema,
    projectId: EntityIdSchema,
    canvasId: EntityIdSchema,
    roomId: EntityIdSchema,
    enabled: z.boolean(),
    role: z.enum(['owner', 'editor', 'reviewer', 'viewer']),
    status: z.enum(['offline', 'connecting', 'connected', 'error']),
    serverOrigin: z.string().url(),
    updatedAt: TimestampSchema,
  })
  .strict();
export type CollaborationRecord = z.infer<typeof CollaborationRecordSchema>;
