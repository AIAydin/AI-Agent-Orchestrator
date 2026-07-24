import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createWorkflowExecutionRuntime } from '@forgeboard/core';
import { CanvasNodeSchema, CanvasSchema, type CanvasNode } from '@forgeboard/core/domain';
import { RepositoryService } from '@forgeboard/git-engine';
import { describe, expect, it } from 'vitest';

import {
  AppSettingsSchema,
  type AppSettings,
  type Project,
} from '../../../shared/application/contracts.js';
import { GitTargetResolver } from '../../git/git-target-resolver.js';
import { LocalStore } from '../../storage.js';
import { ExactCheckExecutor } from './executor.js';
import { ExactCheckWorkflowAdapter } from './workflow-adapter.js';
import type { WorkflowExecutorContext, WorkflowExecutorPreparation } from '../host/contracts.js';

const PROJECT_ID = '76000000-0000-4000-8000-000000000001';
const EXECUTION_ID = '76000000-0000-4000-8000-000000000002';
const NOW = '2026-07-15T20:00:00.000Z';

describe('ExactCheckWorkflowAdapter integration', () => {
  it('runs the exact canonical Test command in the primary project with a real process reference', async () => {
    await withFixture(async ({ adapter, repository }) => {
      const context = workflowContext(
        testNode({
          executable: process.execPath,
          args: ['-e', "process.stdout.write('adapter:' + process.cwd() + ':success\\n')"],
        }),
      );
      const prepared = await adapter.prepare(context);

      expect(prepared.disclosure).toMatchObject({
        target: { kind: 'primary-project', projectId: PROJECT_ID },
        checkId: 'test',
        kind: 'test',
        cwd: repository,
      });
      const launched = await adapter.launch(context, prepared, approval(prepared));
      expect('pid' in launched.executionReference).toBe(true);
      if ('pid' in launched.executionReference) {
        expect(launched.executionReference.pid).toBeGreaterThan(0);
      }
      await expect(launched.completion).resolves.toMatchObject({
        completion: { status: 'succeeded' },
        evidence: {
          status: 'passed',
          target: { kind: 'primary-project', projectId: PROJECT_ID },
          outputSummary: { truncated: false },
        },
      });
      const result = await launched.completion;
      const evidence = result.evidence as { outputSummary: { tail: string } };
      expect(evidence.outputSummary.tail).toContain(`adapter:${repository}:success`);
    });
  });

  it.skipIf(process.platform === 'win32')(
    'uses an internal reference and failed completion when launch never obtains a PID',
    async () => {
      await withFixture(async ({ adapter, repository }) => {
        const brokenExecutable = path.join(repository, 'broken-workflow-check');
        await writeFile(brokenExecutable, '#!/definitely/missing/interpreter\n', 'utf8');
        await chmod(brokenExecutable, 0o755);
        const context = workflowContext(
          testNode({ executable: './broken-workflow-check', args: [] }),
        );
        const prepared = await adapter.prepare(context);
        const launched = await adapter.launch(context, prepared, approval(prepared));

        expect(launched.executionReference).toMatchObject({
          kind: 'internal',
          executionId: launched.externalId,
        });
        expect('pid' in launched.executionReference).toBe(false);
        const completion = await launched.completion;
        expect(completion).toMatchObject({
          completion: { status: 'failed', failureCode: 'EXACT_CHECK_FAILED' },
          evidence: {
            status: 'failed',
            exitCode: null,
          },
        });
        const evidence = completion.evidence as { outputSummary: { tail: string } };
        expect(evidence.outputSummary.tail).toContain('Failed to start exact check');
      });
    },
  );

  it('delegates cancellation through the real exact-check process handle', async () => {
    await withFixture(async ({ adapter }) => {
      const context = workflowContext(
        testNode({ executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }),
      );
      const prepared = await adapter.prepare(context);
      const launched = await adapter.launch(context, prepared, approval(prepared));

      await launched.cancel();
      await expect(launched.completion).resolves.toMatchObject({
        completion: { status: 'cancelled' },
        evidence: { status: 'cancelled' },
      });
    });
  });
});

async function withFixture(
  run: (fixture: {
    readonly adapter: ExactCheckWorkflowAdapter;
    readonly repository: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-check-adapter-'));
  const repositoryPath = path.join(root, 'project');
  await mkdir(repositoryPath);
  const repository = await realpath(repositoryPath);
  const store = new LocalStore(path.join(root, 'state', 'forgeboard.sqlite3'));
  store.saveProject(project(repository));
  const settings = appSettings(path.join(root, 'worktrees'));
  const gitTargets = new GitTargetResolver(store, new RepositoryService(), () => settings);
  const exact = new ExactCheckExecutor(store, gitTargets, () => settings);
  const adapter = new ExactCheckWorkflowAdapter(exact);
  try {
    await run({ adapter, repository });
  } finally {
    await exact.dispose();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

function workflowContext(node: CanvasNode): WorkflowExecutorContext {
  const canvas = CanvasSchema.parse({
    schemaVersion: 1,
    id: 'canvas-check-adapter',
    projectId: PROJECT_ID,
    name: 'Check adapter integration',
    nodes: [node],
    edges: [],
    groups: [],
    revisionLoops: [],
    viewState: { viewport: { x: 0, y: 0, zoom: 1 } },
    createdAt: NOW,
    updatedAt: NOW,
  });
  return {
    executionId: EXECUTION_ID,
    projectId: PROJECT_ID,
    node,
    attempt: 1,
    runtime: createWorkflowExecutionRuntime(canvas, {
      planId: 'plan-check-adapter',
      runId: EXECUTION_ID,
      scope: { kind: 'workflow' },
      occurredAt: NOW,
    }),
  };
}

function testNode(command: { readonly executable: string; readonly args: readonly string[] }) {
  return CanvasNodeSchema.parse({
    id: 'test-check-adapter',
    title: 'Integration tests',
    color: '#445566',
    icon: 'test',
    position: { x: 0, y: 0 },
    size: { width: 300, height: 200 },
    inspector: { legacyData: { checkKind: 'test' } },
    createdAt: NOW,
    updatedAt: NOW,
    type: 'test',
    data: { command: { ...command, environmentNames: [] }, runIds: ['test-check-adapter'] },
  });
}

function approval(prepared: WorkflowExecutorPreparation) {
  return {
    preparationId: prepared.preparationId,
    approvalFingerprint: prepared.approvalFingerprint,
    approvedBy: 'integration-user',
    approvedAt: NOW,
  };
}

function project(repository: string): Project {
  return {
    id: PROJECT_ID,
    name: 'Workflow check adapter fixture',
    path: repository,
    openedAt: NOW,
    missing: false,
    health: {
      isGitRepository: false,
      branch: null,
      dirty: false,
      remotes: [],
      packageManager: 'unknown',
      frameworks: ['node'],
      scripts: {},
      hasSubmodules: false,
      sensitiveWarnings: [],
    },
  };
}

function appSettings(worktreeRoot: string): AppSettings {
  return AppSettingsSchema.parse({
    theme: 'system',
    reducedMotion: false,
    density: 'comfortable',
    defaultAgent: 'codex',
    defaultPermissionProfile: 'worktree-write',
    worktreeRoot,
    gitRemote: 'origin',
    terminalShell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
    envAllowlist: [],
    developmentCommand: { executable: '', arguments: [] },
    testCommand: { executable: '', arguments: [] },
    lintCommand: { executable: '', arguments: [] },
    typecheckCommand: { executable: '', arguments: [] },
    buildCommand: { executable: '', arguments: [] },
    previewPortStart: 45_000,
    previewPortEnd: 45_100,
    transcriptRetentionDays: 30,
    collaborationEnabled: false,
    collaborationUrl: '',
  });
}
