import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
  type DeliveryHumanApprovalRecord,
  type DeliveryReadinessRecord,
} from '../../git/readiness/contracts.js';
import { deliveryEvidenceFingerprint } from '../../git/readiness/fingerprints.js';
import { GIT_DELIVERY_READINESS_MAX_APPROVALS } from '../../../shared/git/readiness/index.js';
import { initializeDeliveryReadinessStorage, SqliteDeliveryReadinessStore } from './repository.js';

const PROJECT_ID = '91000000-0000-4000-8000-000000000001';
const RUN_ID = '91000000-0000-4000-8000-000000000002';
const WORKTREE_ID = '91000000-0000-4000-8000-000000000003';
const READINESS_ID = '91000000-0000-4000-8000-000000000004';
const APPROVAL_ID = '91000000-0000-4000-8000-000000000005';
const NOW = '2026-07-16T20:00:00.000Z';
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('delivery readiness SQLite repository', () => {
  it('uses CAS progress and immutable, exact-source human approvals', () => {
    const { database, store } = openStore();
    const initial = readiness();

    expect(store.createDeliveryReadiness(initial)).toEqual(initial);
    expect(store.getDeliveryReadiness(READINESS_ID)).toEqual(initial);
    expect(store.listDeliveryReadinessForTarget(initial.target).map((record) => record.id)).toEqual(
      [READINESS_ID],
    );

    const updated: DeliveryReadinessRecord = {
      ...initial,
      revision: 1,
      updatedAt: '2026-07-16T20:00:01.000Z',
    };
    expect(() =>
      store.replaceDeliveryReadiness({ ...updated, sourceBranch: 'forgeboard/retargeted' }, 0),
    ).toThrow('authority are immutable');
    expect(() =>
      store.replaceDeliveryReadiness(
        {
          ...updated,
          workflowBinding: {
            ...updated.workflowBinding,
            bindingDigest: 'f'.repeat(64),
          },
        },
        0,
      ),
    ).toThrow('authority are immutable');
    expect(store.replaceDeliveryReadiness(updated, 0)).toEqual(updated);
    expect(() => store.replaceDeliveryReadiness(updated, 0)).toThrow('changed before this update');

    const exactApproval = approval(updated);
    expect(() => store.saveDeliveryReadinessApproval(exactApproval, 0)).toThrow(
      'changed before human approval',
    );
    expect(store.saveDeliveryReadinessApproval(exactApproval, updated.revision)).toEqual(
      exactApproval,
    );
    expect(store.getDeliveryReadinessApproval(APPROVAL_ID)).toEqual(exactApproval);
    expect(store.listDeliveryReadinessApprovals(READINESS_ID)).toEqual([exactApproval]);
    expect(() =>
      database
        .prepare('UPDATE delivery_readiness_approvals SET approved_at = ? WHERE id = ?')
        .run('2026-07-16T21:00:00.000Z', APPROVAL_ID),
    ).toThrow('delivery readiness approvals are immutable');
  });

  it('rejects approvals for another source and detects indexed-record tampering', () => {
    const { database, store } = openStore();
    const record = store.createDeliveryReadiness(readiness());
    expect(() =>
      store.saveDeliveryReadinessApproval(
        {
          ...approval(record),
          sourceFingerprint: {
            ...record.sourceFingerprint,
            digest: 'e'.repeat(64),
          },
        },
        record.revision,
      ),
    ).toThrow('does not match its delivery readiness source');

    database
      .prepare('UPDATE delivery_readiness_records SET source_fingerprint = ? WHERE id = ?')
      .run('f'.repeat(64), READINESS_ID);
    expect(() => store.getDeliveryReadiness(READINESS_ID)).toThrow('indexed columns do not match');
  });

  it('includes the exact workflow binding in human-approval evidence', () => {
    const record = readiness();
    const changedWorkflow: DeliveryReadinessRecord = {
      ...record,
      workflowBinding: {
        ...record.workflowBinding,
        executionRevision: record.workflowBinding.executionRevision + 1,
      },
    };

    expect(deliveryEvidenceFingerprint(changedWorkflow)).not.toBe(
      deliveryEvidenceFingerprint(record),
    );
  });

  it('bounds historical approval views to the shared renderer contract limit', () => {
    const { database, store } = openStore();
    const record = store.createDeliveryReadiness(readiness());
    const insert = database.prepare(
      `INSERT INTO delivery_readiness_approvals(
         id, readiness_id, project_id, run_id, authority, source_fingerprint,
         evidence_fingerprint, approved_at, value_json
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ids: string[] = [];
    for (let index = 0; index < 65; index += 1) {
      const id = `93000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      const evidenceFingerprint =
        index === 0
          ? deliveryEvidenceFingerprint(record)
          : (index + 1).toString(16).padStart(64, '0');
      const approvedAt = new Date(Date.parse(NOW) + index * 1_000).toISOString();
      const value = {
        ...approval(record),
        id,
        evidenceFingerprint,
        approvedAt,
      };
      ids.push(id);
      insert.run(
        id,
        record.id,
        record.target.projectId,
        record.target.runId,
        'human',
        record.sourceFingerprint.digest,
        evidenceFingerprint,
        approvedAt,
        JSON.stringify(value),
      );
    }

    const approvals = store.listDeliveryReadinessApprovals(record.id);
    expect(approvals).toHaveLength(64);
    expect(approvals[0]?.id).toBe(ids.at(-1));
    expect(approvals.some((candidate) => candidate.id === ids[0])).toBe(false);
    expect(
      store.findDeliveryReadinessApprovalForEvidence(record.id, deliveryEvidenceFingerprint(record))
        ?.id,
    ).toBe(ids[0]);
  });

  it('physically bounds rerun approvals while preserving low-sorting current evidence', () => {
    const { database, store } = openStore();
    let current = store.createDeliveryReadiness(readiness());
    const cycles = GIT_DELIVERY_READINESS_MAX_APPROVALS + 17;
    let currentApproval!: DeliveryHumanApprovalRecord;

    for (let index = 0; index < cycles; index += 1) {
      const executionId = `94000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      const updated: DeliveryReadinessRecord = {
        ...current,
        revision: current.revision + 1,
        requiredChecks: current.requiredChecks.map((check) => ({
          ...check,
          state: 'passed',
          executionId,
          executionStatus: 'passed',
          sourceFingerprint: current.sourceFingerprint,
          startedAt: NOW,
          endedAt: NOW,
          exitCode: 0,
          outputDigest: (index + 1).toString(16).padStart(64, '0'),
          failureReason: null,
        })),
      };
      current = store.replaceDeliveryReadiness(updated, current.revision);
      currentApproval = {
        ...approval(current),
        id:
          index === cycles - 1
            ? '03000000-0000-4000-8000-000000000001'
            : `f3000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        approvedAt: NOW,
      };
      store.saveDeliveryReadinessApproval(currentApproval, current.revision);
    }

    const physical = database
      .prepare('SELECT COUNT(*) AS count FROM delivery_readiness_approvals WHERE readiness_id = ?')
      .get(current.id) as { count: number };
    expect(physical.count).toBe(GIT_DELIVERY_READINESS_MAX_APPROVALS);
    expect(
      store.findDeliveryReadinessApprovalForEvidence(
        current.id,
        deliveryEvidenceFingerprint(current),
      ),
    ).toEqual(currentApproval);
    expect(store.listDeliveryReadinessApprovals(current.id)).toContainEqual(currentApproval);
  });

  it('prunes superseded target generations while preserving the newest active record', () => {
    const { store } = openStore();
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const timestamp = new Date(Date.parse(NOW) + index * 1_000).toISOString();
      const id = `98000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      ids.push(id);
      store.createDeliveryReadiness({
        ...readiness(),
        id,
        createdAt: timestamp,
        updatedAt: timestamp,
        requiredChecks: readiness().requiredChecks.map((check) => ({
          ...check,
          updatedAt: timestamp,
        })),
      });
    }

    expect(store.pruneDeliveryReadinessForTarget(readiness().target, 2)).toBe(3);
    expect(
      store.listDeliveryReadinessForTarget(readiness().target).map((record) => record.id),
    ).toEqual([ids[4], ids[3]]);
  });

  it('rolls back generation creation when its in-transaction prune cannot complete', () => {
    const { database, store } = openStore();
    const records = [0, 1, 2].map((index) => {
      const timestamp = new Date(Date.parse(NOW) + index * 1_000).toISOString();
      return {
        ...readiness(),
        id: `99000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        createdAt: timestamp,
        updatedAt: timestamp,
        requiredChecks: readiness().requiredChecks.map((check) => ({
          ...check,
          updatedAt: timestamp,
        })),
      } satisfies DeliveryReadinessRecord;
    });
    store.createDeliveryReadiness(records[0]!);
    store.createDeliveryReadiness(records[1]!);
    database.exec(`
      CREATE TRIGGER reject_test_readiness_prune
      BEFORE DELETE ON delivery_readiness_records
      BEGIN
        SELECT RAISE(ABORT, 'forced readiness prune failure');
      END;
    `);

    expect(() => store.createDeliveryReadiness(records[2]!, 1)).toThrow(
      'forced readiness prune failure',
    );
    expect(
      store.listDeliveryReadinessForTarget(readiness().target).map((record) => record.id),
    ).toEqual([records[1]!.id, records[0]!.id]);
  });
});

function openStore(): { database: DatabaseSync; store: SqliteDeliveryReadinessStore } {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  database.exec('PRAGMA foreign_keys = ON;');
  database.exec(`
    CREATE TABLE recent_projects(id TEXT PRIMARY KEY);
    CREATE TABLE agent_runs(id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
  `);
  initializeDeliveryReadinessStorage(database);
  database.prepare('INSERT INTO recent_projects(id) VALUES(?)').run(PROJECT_ID);
  database.prepare('INSERT INTO agent_runs(id, project_id) VALUES(?, ?)').run(RUN_ID, PROJECT_ID);
  return { database, store: new SqliteDeliveryReadinessStore(database) };
}

function readiness(): DeliveryReadinessRecord {
  const configurationDigest = 'a'.repeat(64);
  const sourceFingerprint = {
    sourceHead: '1'.repeat(40),
    sourceTree: '2'.repeat(40),
    worktreeId: WORKTREE_ID,
    runId: RUN_ID,
    requiredCheckConfigurationDigest: 'b'.repeat(64),
    digest: 'c'.repeat(64),
  };
  return {
    schemaVersion: 1,
    id: READINESS_ID,
    revision: 0,
    target: { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID },
    sourceFingerprint,
    workflowBinding: {
      executionId: 'workflow-execution-1',
      executionRevision: 12,
      canvasId: 'canvas-1',
      sourceNodeId: 'agent-1',
      sourceAttempt: 1,
      sourceOutputDigest: 'e'.repeat(64),
      gates: [
        {
          gateNodeId: 'review-gate-1',
          gateAttempt: 1,
          evidenceDigest: 'f'.repeat(64),
          derivedCheckIds: ['lint'],
        },
      ],
      bindingDigest: '0'.repeat(64),
    },
    sourceBranch: 'forgeboard/test',
    baseCommit: '0'.repeat(40),
    availableChecks: [
      {
        checkId: 'lint',
        label: 'Lint',
        kind: 'lint',
        availability: 'configured',
        configurationDigest,
      },
      ...(['typecheck', 'test', 'build'] as const).map((checkId) => ({
        checkId,
        label: checkId,
        kind: checkId,
        availability: 'unconfigured' as const,
        configurationDigest: null,
      })),
    ],
    requiredChecks: [
      {
        checkId: 'lint',
        label: 'Lint',
        kind: 'lint',
        configurationDigest,
        command: {
          executable: 'node',
          args: ['--version'],
          cwdRelative: '.',
          environmentNames: [],
        },
        resolvedCommand: {
          executable: '/usr/bin/node',
          arguments: ['--version'],
          cwd: '/tmp/worktree',
          environmentVariableNames: [],
          fingerprint: 'd'.repeat(64),
        },
        state: 'missing',
        executionId: null,
        executionStatus: null,
        sourceFingerprint: null,
        startedAt: null,
        endedAt: null,
        updatedAt: NOW,
        exitCode: null,
        outputDigest: null,
        failureReason: null,
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function approval(record: DeliveryReadinessRecord): DeliveryHumanApprovalRecord {
  return {
    schemaVersion: 1,
    id: APPROVAL_ID,
    readinessId: record.id,
    target: record.target,
    authority: 'human',
    sourceFingerprint: record.sourceFingerprint,
    evidenceFingerprint: deliveryEvidenceFingerprint(record),
    actorId: 'local-human',
    actorLabel: 'Local human',
    approvedAt: '2026-07-16T20:00:02.000Z',
  };
}
