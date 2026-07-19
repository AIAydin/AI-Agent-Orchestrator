import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ChangeService,
  GitMutationExecutionOptions,
  RepositoryService,
} from '@forgeboard/git-engine';
import type { BrowserWindow } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GitReviewTargetView } from '../../../../shared/git/contracts.js';
import type { ConflictRecoveryTarget } from '../conflict-recovery-service.js';
import { ConflictFileService } from '../conflict-file-service.js';

const PROJECT_ID = '82000000-0000-4000-8000-000000000001';
const RUN_ID = '82000000-0000-4000-8000-000000000002';
const WORKTREE_ID = '82000000-0000-4000-8000-000000000003';
const PATH = 'README.md';
const ORIGINAL = '<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\n';
const RESOLVED = 'reviewed resolution\n';
const TAMPERED = 'unreviewed replacement\n';

const TARGET: GitReviewTargetView = {
  kind: 'agent-worktree',
  projectId: PROJECT_ID,
  runId: RUN_ID,
  nodeId: 'node-1',
  worktreeId: WORKTREE_ID,
  agentId: 'agent-1',
  baseRef: 'main',
  baseCommit: 'a'.repeat(40),
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ConflictFileService authority', () => {
  it('rejects an opaque target whose ownership view changed at the same repository path', async () => {
    const harness = await createHarness();
    const plan = await harness.service.prepare(7, {
      target: { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID },
      path: PATH,
      expectedSha256: sha256(ORIGINAL),
      content: RESOLVED,
    });
    harness.resolveTarget.mockResolvedValueOnce({
      repositoryRoot: harness.root,
      view: { ...TARGET, worktreeId: '82000000-0000-4000-8000-000000000004' },
    });

    await expect(
      harness.service.confirm({
        ownerId: 7,
        planId: plan.planId,
        parent: {} as BrowserWindow,
        assertCurrent: vi.fn(),
      }),
    ).rejects.toThrow(/workspace changed after review/iu);
    expect(harness.changes.stageExactContent).not.toHaveBeenCalled();
  });

  it('passes immutable reviewed bytes to exact staging even if the worktree changes', async () => {
    const harness = await createHarness();
    harness.changes.stageExactContent.mockImplementation(
      async (
        _root: string,
        _path: string,
        content: Uint8Array,
        options: GitMutationExecutionOptions,
      ) => {
        await options.beforeApply?.();
        await writeFile(join(harness.root, PATH), TAMPERED);
        expect(Buffer.from(content).toString('utf8')).toBe(RESOLVED);
        harness.changes.continuationState.mockResolvedValue({
          repositoryRoot: harness.root,
          expectedHead: 'b'.repeat(40),
          operation: 'merge',
          status: { entries: [] },
          conflictedPaths: [],
          stagedPaths: [PATH],
          stagedPatchSha256: 'c'.repeat(64),
          unstagedPatchSha256: 'd'.repeat(64),
          canContinue: true,
          canAbort: true,
        });
        return {} as never;
      },
    );
    const plan = await harness.service.prepare(7, {
      target: { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID },
      path: PATH,
      expectedSha256: sha256(ORIGINAL),
      content: RESOLVED,
    });

    await expect(
      harness.service.confirm({
        ownerId: 7,
        planId: plan.planId,
        parent: {} as BrowserWindow,
        assertCurrent: vi.fn(),
      }),
    ).resolves.toMatchObject({ stagedPath: PATH, inspection: null });
    expect(harness.audit).toHaveBeenCalledWith(
      'resolve-conflict-file-stage',
      'allowed',
      expect.anything(),
    );
  });
});

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-conflict-authority-'));
  roots.push(root);
  await writeFile(join(root, PATH), ORIGINAL);
  const target: ConflictRecoveryTarget = { repositoryRoot: root, view: TARGET };
  const resolveTarget = vi.fn<() => Promise<ConflictRecoveryTarget>>().mockResolvedValue(target);
  const continuationState = vi.fn().mockResolvedValue({
    repositoryRoot: root,
    expectedHead: 'b'.repeat(40),
    operation: 'merge',
    status: { entries: [] },
    conflictedPaths: [PATH],
    stagedPaths: [],
    stagedPatchSha256: 'c'.repeat(64),
    unstagedPatchSha256: 'd'.repeat(64),
    canContinue: false,
    canAbort: true,
  });
  const changes = {
    continuationState,
    stageExactContent: vi.fn(),
  };
  const repositories = {
    git: {
      run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'stage content\n', stderr: '' }),
    },
  };
  const audit = vi.fn();
  const service = new ConflictFileService({
    changes: changes as unknown as ChangeService,
    repositories: repositories as unknown as RepositoryService,
    dialog: { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) },
    resolveTarget,
    audit,
  });
  return { root, service, resolveTarget, changes, audit };
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
