import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { migrate, openDatabase } from '../database.js';
import { getRun, saveRun } from '../runs-audit.js';
import { initializeAuditIntegrity } from '../security/audit-integrity.js';
import {
  GitWorktreeMetadataIntentSchema,
  beginGitWorktreeMetadataIntent,
  getGitWorktreeMetadataIntent,
  reconcileGitWorktreeMetadataIntent,
} from './intents.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('durable managed-worktree metadata intents', () => {
  for (const scenario of [
    {
      kind: 'rename-worktree-branch' as const,
      beforeBranch: 'forgeboard/before',
      afterBranch: 'forgeboard/after',
      beforeState: 'active' as const,
      afterState: 'active' as const,
    },
    {
      kind: 'archive-worktree' as const,
      beforeBranch: 'forgeboard/archive',
      afterBranch: 'forgeboard/archive',
      beforeState: 'active' as const,
      afterState: 'archived' as const,
    },
    {
      kind: 'restore-worktree' as const,
      beforeBranch: 'forgeboard/restore',
      afterBranch: 'forgeboard/restore',
      beforeState: 'archived' as const,
      afterState: 'active' as const,
    },
  ]) {
    it(`atomically reconciles ${scenario.kind} after an interrupted effect`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-worktree-intent-'));
      roots.push(root);
      const database = openDatabase(path.join(root, 'state.sqlite3'));
      try {
        migrate(database);
        initializeAuditIntegrity(database);
        const runId = '81000000-0000-4000-8000-000000000001';
        const worktreeId = '81000000-0000-4000-8000-000000000002';
        const intentId = '81000000-0000-4000-8000-000000000003';
        saveRun(database, {
          id: runId,
          projectId: '81000000-0000-4000-8000-000000000004',
          nodeId: 'agent-node',
          adapterId: 'codex',
          status: 'succeeded',
          cwd: path.join(root, 'worktree'),
          branch: scenario.beforeBranch,
          worktreeId,
          worktreeState: scenario.beforeState,
          repositoryRoot: path.join(root, 'repository'),
          managedRoot: path.join(root, 'managed'),
          baseRef: 'main',
          baseCommit: 'a'.repeat(40),
          startedAt: '2026-07-19T10:00:00.000Z',
          endedAt: '2026-07-19T10:01:00.000Z',
          exitCode: 0,
          createdAt: '2026-07-19T10:00:00.000Z',
          updatedAt: '2026-07-19T10:01:00.000Z',
        });
        beginGitWorktreeMetadataIntent(database, {
          intentId,
          runId,
          worktreeId,
          ...scenario,
          createdAt: '2026-07-19T10:02:00.000Z',
        });

        expect(
          reconcileGitWorktreeMetadataIntent(database, {
            intentId,
            worktreeId,
            branch: scenario.afterBranch,
            state: scenario.afterState,
            reconciledAt: '2026-07-19T10:03:00.000Z',
            auditStage: 'interrupted-intent-reconciled',
            auditMetadata: { runId },
          }),
        ).toBe('applied');
        expect(getRun(database, runId)).toMatchObject({
          branch: scenario.afterBranch,
          worktreeState: scenario.afterState,
        });
        expect(getGitWorktreeMetadataIntent(database, runId)).toBeUndefined();
      } finally {
        database.close();
      }
    });
  }

  it('rejects an intent before any effect when the persisted worktree lineage is inconsistent', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-worktree-intent-lineage-'));
    roots.push(root);
    const database = openDatabase(path.join(root, 'state.sqlite3'));
    try {
      migrate(database);
      initializeAuditIntegrity(database);
      const worktreeId = '82000000-0000-4000-8000-000000000002';
      saveRun(database, runRecord(root, '82000000-0000-4000-8000-000000000001', worktreeId));
      saveRun(database, {
        ...runRecord(root, '82000000-0000-4000-8000-000000000005', worktreeId),
        branch: 'forgeboard/inconsistent-sibling',
      });
      expect(() =>
        beginGitWorktreeMetadataIntent(database, {
          intentId: '82000000-0000-4000-8000-000000000003',
          runId: '82000000-0000-4000-8000-000000000001',
          worktreeId,
          kind: 'rename-worktree-branch',
          beforeBranch: 'forgeboard/before',
          afterBranch: 'forgeboard/after',
          beforeState: 'active',
          afterState: 'active',
          createdAt: '2026-07-19T10:02:00.000Z',
        }),
      ).toThrow(/lineage/iu);
      expect(
        getGitWorktreeMetadataIntent(database, '82000000-0000-4000-8000-000000000001'),
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it('keeps the intent and run unchanged when the reconciliation audit cannot be persisted', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-worktree-intent-audit-'));
    roots.push(root);
    const database = openDatabase(path.join(root, 'state.sqlite3'));
    try {
      migrate(database);
      initializeAuditIntegrity(database);
      const runId = '83000000-0000-4000-8000-000000000001';
      const worktreeId = '83000000-0000-4000-8000-000000000002';
      const intentId = '83000000-0000-4000-8000-000000000003';
      saveRun(database, runRecord(root, runId, worktreeId));
      beginGitWorktreeMetadataIntent(database, {
        intentId,
        runId,
        worktreeId,
        kind: 'rename-worktree-branch',
        beforeBranch: 'forgeboard/before',
        afterBranch: 'forgeboard/after',
        beforeState: 'active',
        afterState: 'active',
        createdAt: '2026-07-19T10:02:00.000Z',
      });
      database.exec(`CREATE TRIGGER reject_lifecycle_audit BEFORE INSERT ON audit_events
        WHEN NEW.action = 'rename-worktree-branch'
        BEGIN SELECT RAISE(ABORT, 'simulated audit failure'); END`);
      expect(() =>
        reconcileGitWorktreeMetadataIntent(database, {
          intentId,
          worktreeId,
          branch: 'forgeboard/after',
          state: 'active',
          reconciledAt: '2026-07-19T10:03:00.000Z',
          auditStage: 'interrupted-intent-reconciled',
          auditMetadata: { runId },
        }),
      ).toThrow(/simulated audit failure/iu);
      expect(getRun(database, runId)?.branch).toBe('forgeboard/before');
      expect(getGitWorktreeMetadataIntent(database, runId)?.intentId).toBe(intentId);

      database.exec('DROP TRIGGER reject_lifecycle_audit');
      expect(
        reconcileGitWorktreeMetadataIntent(database, {
          intentId,
          worktreeId,
          branch: 'forgeboard/after',
          state: 'active',
          reconciledAt: '2026-07-19T10:04:00.000Z',
          auditStage: 'interrupted-intent-reconciled',
          auditMetadata: { runId },
        }),
      ).toBe('applied');
      expect(getRun(database, runId)?.branch).toBe('forgeboard/after');
      expect(getGitWorktreeMetadataIntent(database, runId)).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it('rejects kind-inconsistent branch and lifecycle transitions', () => {
    const common = {
      intentId: '84000000-0000-4000-8000-000000000001',
      runId: '84000000-0000-4000-8000-000000000002',
      worktreeId: '84000000-0000-4000-8000-000000000003',
      createdAt: '2026-07-19T10:02:00.000Z',
    };
    expect(
      GitWorktreeMetadataIntentSchema.safeParse({
        ...common,
        kind: 'rename-worktree-branch',
        beforeBranch: 'forgeboard/same',
        afterBranch: 'forgeboard/same',
        beforeState: 'active',
        afterState: 'active',
      }).success,
    ).toBe(false);
    expect(
      GitWorktreeMetadataIntentSchema.safeParse({
        ...common,
        kind: 'archive-worktree',
        beforeBranch: 'forgeboard/before',
        afterBranch: 'forgeboard/changed',
        beforeState: 'active',
        afterState: 'archived',
      }).success,
    ).toBe(false);
  });
});

function runRecord(root: string, id: string, worktreeId: string) {
  return {
    id,
    projectId: '85000000-0000-4000-8000-000000000004',
    nodeId: 'agent-node',
    adapterId: 'codex',
    status: 'succeeded' as const,
    cwd: path.join(root, 'worktree'),
    branch: 'forgeboard/before',
    worktreeId,
    worktreeState: 'active' as const,
    repositoryRoot: path.join(root, 'repository'),
    managedRoot: path.join(root, 'managed'),
    baseRef: 'main',
    baseCommit: 'a'.repeat(40),
    startedAt: '2026-07-19T10:00:00.000Z',
    endedAt: '2026-07-19T10:01:00.000Z',
    exitCode: 0,
    createdAt: '2026-07-19T10:00:00.000Z',
    updatedAt: '2026-07-19T10:01:00.000Z',
  };
}
