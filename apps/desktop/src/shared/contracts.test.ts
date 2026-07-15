import { describe, expect, it } from 'vitest';

import {
  AppCloseRequestSchema,
  AppCloseResponseSchema,
  AuditEventSchema,
  AuditListInputSchema,
  BackupResultSchema,
  BranchPrefixSchema,
  ConfirmProjectRecoveryInputSchema,
  ExtensionApproveInputSchema,
  ExtensionDiscoveryViewSchema,
  ExtensionInstallPlanViewSchema,
  ExtensionRemoveInputSchema,
  LocalReferenceSelectionInputSchema,
  LocateProjectRecoveryInputSchema,
  PreviewEventEnvelopeSchema,
  PreviewNavigateInputSchema,
  PreviewStartInputSchema,
  PrepareRunInputSchema,
  ProjectRecoveryAssessmentSchema,
} from './contracts.js';

describe('save-before-close IPC contracts', () => {
  const requestId = '123fae6e-e213-4a10-a0db-0f85b791f7e9';

  it('binds strict renderer responses to one UUID request', () => {
    expect(AppCloseRequestSchema.parse({ requestId })).toEqual({ requestId });
    expect(AppCloseResponseSchema.parse({ requestId, saved: true })).toEqual({
      requestId,
      saved: true,
    });
    expect(AppCloseRequestSchema.safeParse({ requestId, reason: 'renderer-choice' }).success).toBe(
      false,
    );
    expect(
      AppCloseResponseSchema.safeParse({ requestId, saved: true, closeWindow: true }).success,
    ).toBe(false);
    expect(AppCloseResponseSchema.safeParse({ requestId: 'not-a-uuid', saved: true }).success).toBe(
      false,
    );
  });
});

describe('agent-run target contracts', () => {
  it('accepts only a project ID and rejects renderer-selected repository paths', () => {
    const input = {
      projectId: 'c95b77bb-53d0-46f9-b9fc-5df23c0d5843',
      nodeId: 'agent-1',
      adapterId: 'test-agent' as const,
      prompt: 'Inspect the project.',
      permissionProfile: 'plan-read-only' as const,
    };
    expect(PrepareRunInputSchema.parse(input)).toEqual(input);
    expect(
      PrepareRunInputSchema.safeParse({ ...input, repositoryPath: '/renderer/chosen/path' })
        .success,
    ).toBe(false);
  });
});

describe('Git branch prefix contracts', () => {
  it('accepts an explicit relative namespace and rejects unsafe Git ref forms', () => {
    expect(BranchPrefixSchema.parse(' team/agents/ ')).toBe('team/agents/');
    for (const value of [
      '',
      '/absolute/',
      '-option/',
      'refs/heads/duplicate/',
      '../escape/',
      'team//agents/',
      'team\\agents/',
      'team/@{agent}/',
      'team/agent.lock/',
      'team/agent name/',
    ]) {
      expect(BranchPrefixSchema.safeParse(value).success, value).toBe(false);
    }
  });
});

describe('moved-project recovery IPC contracts', () => {
  const projectId = 'c95b77bb-53d0-46f9-b9fc-5df23c0d5843';
  const confirmationId = '123fae6e-e213-4a10-a0db-0f85b791f7e9';
  const health = {
    isGitRepository: true,
    branch: 'main',
    dirty: false,
    remotes: [{ name: 'origin', url: 'https://github.com/example/project.git' }],
    packageManager: 'pnpm' as const,
    frameworks: ['React'],
    scripts: { test: 'vitest' },
    hasSubmodules: false,
    sensitiveWarnings: [],
  };
  const assessment = {
    confirmationId,
    expiresAt: '2026-07-14T16:15:00.000Z',
    projectId,
    original: { name: 'project', path: '/old/project', health },
    candidate: { name: 'project', path: '/new/project', health },
    warnings: [],
  };

  it('keeps folder selection main-owned and confirmation explicit', () => {
    expect(LocateProjectRecoveryInputSchema.parse({ projectId })).toEqual({ projectId });
    expect(
      LocateProjectRecoveryInputSchema.safeParse({ projectId, candidatePath: '/renderer/path' })
        .success,
    ).toBe(false);
    expect(
      ConfirmProjectRecoveryInputSchema.parse({ projectId, confirmationId, confirmed: true }),
    ).toEqual({ projectId, confirmationId, confirmed: true });
    expect(
      ConfirmProjectRecoveryInputSchema.safeParse({
        projectId,
        confirmationId,
        confirmed: false,
      }).success,
    ).toBe(false);
    expect(
      ConfirmProjectRecoveryInputSchema.safeParse({
        projectId,
        confirmationId,
        confirmed: true,
        candidatePath: '/unreviewed/path',
      }).success,
    ).toBe(false);
  });

  it('accepts only a bounded strict assessment for the renderer', () => {
    expect(ProjectRecoveryAssessmentSchema.parse(assessment)).toEqual(assessment);
    expect(
      ProjectRecoveryAssessmentSchema.safeParse({ ...assessment, executable: '/bin/sh' }).success,
    ).toBe(false);
    expect(
      ProjectRecoveryAssessmentSchema.safeParse({
        ...assessment,
        warnings: ['x'.repeat(4_097)],
      }).success,
    ).toBe(false);
  });
});

describe('extension IPC contracts', () => {
  const plan = {
    planId: '123fae6e-e213-4a10-a0db-0f85b791f7e9',
    operation: 'install' as const,
    currentVersion: null,
    manifest: {
      schemaVersion: 1 as const,
      id: 'example.notes',
      name: 'Example notes',
      version: '1.0.0',
      description: 'Adds a safe note.',
      publisher: 'Example',
      requestedPermissions: ['canvas.node.register', 'canvas.data.persist'],
      contributes: {
        agentAdapters: [],
        canvasNodeTypes: [
          {
            id: 'note',
            displayName: 'Note',
            description: 'A safe note.',
            category: 'Planning',
            icon: 'note',
            color: '#8D7DE8',
            capabilities: ['human-editable'],
            fields: [],
            ports: [],
          },
        ],
      },
    },
    manifestJson: '{"schemaVersion":1}',
    manifestDigest: 'a'.repeat(64),
    snapshotDigest: 'b'.repeat(64),
    sourcePath: '/tmp/example.notes',
    requestedPermissions: ['canvas.data.persist', 'canvas.node.register'],
    expiresAt: '2026-07-14T16:15:00.000Z',
  };

  it('validates a strict bounded plan and explicit confirmation inputs', () => {
    expect(ExtensionInstallPlanViewSchema.parse(plan)).toMatchObject({
      planId: plan.planId,
      operation: 'install',
    });
    expect(ExtensionInstallPlanViewSchema.safeParse({ ...plan, unexpected: true }).success).toBe(
      false,
    );
    expect(
      ExtensionInstallPlanViewSchema.safeParse({ ...plan, manifestDigest: 'not-a-digest' }).success,
    ).toBe(false);
    expect(
      ExtensionInstallPlanViewSchema.safeParse({ ...plan, snapshotDigest: 'not-a-digest' }).success,
    ).toBe(false);
    expect(
      ExtensionApproveInputSchema.safeParse({ planId: plan.planId, confirmed: false }).success,
    ).toBe(false);
    expect(
      ExtensionRemoveInputSchema.parse({ extensionId: 'example.notes', confirmation: 'typed-id' }),
    ).toEqual({ extensionId: 'example.notes', confirmation: 'typed-id' });
  });

  it('accepts only explicit bounded native reference chooser requests', () => {
    expect(LocalReferenceSelectionInputSchema.parse({ kind: 'file', multiple: true })).toEqual({
      kind: 'file',
      multiple: true,
    });
    expect(
      LocalReferenceSelectionInputSchema.safeParse({
        kind: 'directory',
        multiple: false,
        path: '/renderer-supplied',
      }).success,
    ).toBe(false);
  });

  it('does not allow unknown or executable extension payloads across discovery IPC', () => {
    const installed = {
      record: {
        schemaVersion: 1 as const,
        extensionId: 'example.notes',
        version: '1.0.0',
        manifestDigest: plan.manifestDigest,
        snapshotDigest: plan.snapshotDigest,
        grantedPermissions: plan.requestedPermissions,
        sourcePath: plan.sourcePath,
        installedAt: '2026-07-14T16:00:00.000Z',
        updatedAt: '2026-07-14T16:00:00.000Z',
      },
      manifest: plan.manifest,
      manifestJson: plan.manifestJson,
      trustState: 'active' as const,
      approvedAt: '2026-07-14T16:00:00.000Z',
    };
    expect(
      ExtensionDiscoveryViewSchema.safeParse({
        registryPath: '/tmp/extensions',
        installed: [{ ...installed, rendererScript: 'malicious.js' }],
        quarantined: [],
        invalid: [],
      }).success,
    ).toBe(false);
  });
});

describe('audit IPC contracts', () => {
  it('accepts only a strict bounded audit list request', () => {
    expect(AuditListInputSchema.parse({ limit: 100 })).toEqual({ limit: 100 });
    expect(AuditListInputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(AuditListInputSchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(AuditListInputSchema.safeParse({ limit: 1.5 }).success).toBe(false);
    expect(AuditListInputSchema.safeParse({ limit: 10, extra: true }).success).toBe(false);
  });

  it('does not permit audit metadata across the renderer boundary', () => {
    const event = {
      sequence: 1,
      occurredAt: '2026-07-14T16:00:00.000Z',
      category: 'agent',
      action: 'launch',
      outcome: 'allowed',
    };
    expect(AuditEventSchema.parse(event)).toEqual(event);
    expect(
      AuditEventSchema.safeParse({ ...event, metadata: { token: 'must-not-cross' } }).success,
    ).toBe(false);
  });
});

describe('backup IPC contracts', () => {
  it('accepts only a bounded integrity result', () => {
    const backup = {
      path: '/tmp/backups/forgeboard.sqlite3',
      createdAt: '2026-07-14T16:00:00.000Z',
      sha256: 'a'.repeat(64),
      sizeBytes: 4096,
    };
    expect(BackupResultSchema.parse(backup)).toEqual(backup);
    expect(BackupResultSchema.safeParse({ ...backup, sha256: 'invalid' }).success).toBe(false);
    expect(BackupResultSchema.safeParse({ ...backup, sizeBytes: 0 }).success).toBe(false);
  });
});

describe('preview IPC contracts', () => {
  const projectId = 'c95b77bb-53d0-46f9-b9fc-5df23c0d5843';

  it('accepts only bounded node-owned launch and navigation requests', () => {
    expect(
      PreviewStartInputSchema.parse({
        projectId,
        nodeId: 'preview-1',
        cwdRelative: 'apps/web',
        readinessPath: '/health',
        urlPath: '/dashboard',
        packageScript: 'dev:web',
      }),
    ).toMatchObject({
      nodeId: 'preview-1',
      readinessPath: '/health',
      packageScript: 'dev:web',
    });
    expect(
      PreviewStartInputSchema.safeParse({
        projectId,
        nodeId: 'preview-1',
        readinessPath: 'https://example.com',
        urlPath: '/',
        cwdRelative: '.',
      }).success,
    ).toBe(false);
    expect(
      PreviewStartInputSchema.safeParse({
        projectId,
        nodeId: 'preview-1',
        readinessPath: '/',
        urlPath: '/',
        cwdRelative: '.',
        packageScript: '--help',
      }).success,
    ).toBe(false);
    expect(
      PreviewNavigateInputSchema.safeParse({
        projectId,
        nodeId: 'preview-1',
        url: 'http://127.0.0.1:41000/',
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it('keeps process output serializable and bounded at the bridge', () => {
    const event = {
      kind: 'output' as const,
      nodeId: 'preview-1',
      sessionId: '123fae6e-e213-4a10-a0db-0f85b791f7e9',
      processId: 'development-server',
      timestamp: '2026-07-14T16:00:00.000Z',
      stream: 'stdout' as const,
      data: 'ready\n',
    };
    expect(PreviewEventEnvelopeSchema.parse(event)).toEqual(event);
    expect(
      PreviewEventEnvelopeSchema.safeParse({ ...event, data: 'x'.repeat(65_537) }).success,
    ).toBe(false);
    expect(
      PreviewEventEnvelopeSchema.safeParse({ ...event, data: Buffer.from('not serializable') })
        .success,
    ).toBe(false);
  });
});
