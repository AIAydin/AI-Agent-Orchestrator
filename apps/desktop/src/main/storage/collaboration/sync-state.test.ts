import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { MIGRATIONS, clearAllTables, migrate, openDatabase } from '../database.js';
import {
  serializeCollaborationMetadataSnapshot,
  type CollaborationMetadataSnapshot,
} from '../../../shared/collaboration/index.js';
import {
  COLLABORATION_SYNC_TTL_MS,
  COLLABORATION_SYNC_MAX_DELIVERY_BYTES_PER_SCOPE,
  COLLABORATION_SYNC_MAX_DELIVERIES_PER_SCOPE,
  collaborationSyncIntegrityMessages,
  checkpointCollaborationSyncState,
  discardRejectedCollaborationComment,
  pruneExpiredCollaborationSyncStates,
  recordCollaborationSyncDelivery,
  recoverCollaborationSyncState,
  settleCollaborationSyncDelivery,
  stageCollaborationSyncDelivery,
  stageCollaborationSyncState,
  type CollaborationSyncStorageScope,
} from './sync-state.js';

const NOW = new Date('2026-07-15T12:00:00.000Z');
const PROJECT_ID = '00000000-0000-4000-8000-000000000020';
const CANVAS_ID = '00000000-0000-4000-8000-000000000030';
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('collaboration sync-state storage', () => {
  it('recovers only the exact authenticated scope after a database restart', () => {
    const { databasePath, database } = databaseFixture();
    stageCollaborationSyncState(database, scope(), snapshot('Baseline'), snapshot('Pending'), NOW);
    database.close();

    const reopened = openDatabase(databasePath);
    migrate(reopened);
    expect(recoverCollaborationSyncState(reopened, scope(), NOW)).toMatchObject({
      baseline: { canvas: { title: 'Baseline' } },
      pending: { canvas: { title: 'Pending' } },
      disposition: 'staged',
    });
    expect(
      recoverCollaborationSyncState(reopened, { ...scope(), subject: 'another-user' }, NOW),
    ).toBeNull();
    expect(
      recoverCollaborationSyncState(
        reopened,
        { ...scope(), serverUrl: 'wss://another.example.test/team' },
        NOW,
      ),
    ).toBeNull();
    expect(
      recoverCollaborationSyncState(reopened, { ...scope(), roomId: 'another-room' }, NOW),
    ).toBeNull();
    reopened.close();
  });

  it('backfills a migration-11 delivered row into the exact ledger during upgrade', () => {
    const directory = mkdtempSync(join(tmpdir(), 'forgeboard-collaboration-v11-'));
    directories.push(directory);
    const databasePath = join(directory, 'forgeboard.sqlite');
    const legacy = openDatabase(databasePath);
    for (let index = 0; index < 11; index += 1) {
      const migration = MIGRATIONS[index];
      if (migration === undefined) throw new Error('Missing migration-11 fixture migration.');
      legacy.exec(migration);
      legacy
        .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)')
        .run(index + 1, NOW.toISOString());
      legacy.exec(`PRAGMA user_version = ${index + 1};`);
    }
    legacy
      .prepare(`INSERT INTO recent_projects(id, path, value_json, opened_at) VALUES(?, ?, ?, ?)`)
      .run(PROJECT_ID, '/tmp/project', '{}', NOW.toISOString());
    legacy
      .prepare(
        `INSERT INTO canvas_documents(id, project_id, value_json, updated_at) VALUES(?, ?, ?, ?)`,
      )
      .run(CANVAS_ID, PROJECT_ID, '{}', NOW.toISOString());
    const base = commentSnapshot([]);
    const pending = commentSnapshot(['comment-a']);
    const receipt = delivery(79, pending);
    legacy
      .prepare(
        `INSERT INTO collaboration_sync_states(
           project_id, canvas_id, server_url, room_id, subject, baseline_json, pending_json,
           delivery_id, snapshot_digest, disposition, updated_at, expires_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?)`,
      )
      .run(
        PROJECT_ID,
        CANVAS_ID,
        scope().serverUrl,
        scope().roomId,
        scope().subject,
        serializeCollaborationMetadataSnapshot(base),
        serializeCollaborationMetadataSnapshot(pending),
        receipt.deliveryId,
        receipt.snapshotDigest,
        NOW.toISOString(),
        new Date(NOW.getTime() + COLLABORATION_SYNC_TTL_MS).toISOString(),
      );
    legacy.close();

    const upgraded = openDatabase(databasePath);
    migrate(upgraded);
    expect(deliveryCount(upgraded)).toBe(1);
    expect(recoverCollaborationSyncState(upgraded, scope(), NOW)).toMatchObject({
      deliveryId: receipt.deliveryId,
      pending: { comments: { 'comment-a': { id: 'comment-a' } } },
      disposition: 'sent',
    });
    expect(collaborationSyncIntegrityMessages(upgraded)).toEqual([]);
    upgraded.close();
  });

  it('expires recovery data and clears it with local-data cleanup', () => {
    const { database } = databaseFixture();
    stageCollaborationSyncState(database, scope(), snapshot('Baseline'), snapshot('Pending'), NOW);
    const expired = new Date(NOW.getTime() + COLLABORATION_SYNC_TTL_MS + 1);
    expect(recoverCollaborationSyncState(database, scope(), expired)).toBeNull();

    checkpointCollaborationSyncState(database, scope(), snapshot('Room'), expired);
    clearAllTables(database);
    expect(recoverCollaborationSyncState(database, scope(), expired)).toBeNull();
    database.close();
  });

  it('stores no credential, path, prompt, terminal, environment, diff, or transcript columns', () => {
    const { database } = databaseFixture();
    for (const table of [
      'collaboration_sync_states',
      'collaboration_sync_deliveries',
      'collaboration_rejected_comment_dismissals',
    ]) {
      const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
      }>;
      const names = columns.map((column) => column.name).join(' ');
      expect(names).not.toMatch(
        /token|credential|path|prompt|terminal|environment|diff|transcript/u,
      );
    }
    database.close();
  });

  it('records a receipt only against an existing staged recovery row', () => {
    const { database } = databaseFixture();
    const pending = snapshot('Pending');
    const receipt = {
      deliveryId: '00000000-0000-4000-8000-000000000099',
      snapshotDigest: digest(pending),
      disposition: 'sent' as const,
    };

    expect(() => recordCollaborationSyncDelivery(database, scope(), receipt)).toThrow(
      /no staged durable recovery record/u,
    );
    stageCollaborationSyncState(database, scope(), snapshot('Baseline'), pending, NOW);
    expect(() => recordCollaborationSyncDelivery(database, scope(), receipt)).not.toThrow();
    expect(recoverCollaborationSyncState(database, scope(), NOW)).toMatchObject({
      deliveryId: receipt.deliveryId,
      snapshotDigest: receipt.snapshotDigest,
      disposition: 'sent',
    });
    database.close();
  });

  it('rolls back staging atomically when durable receipt binding fails', () => {
    const { database } = databaseFixture();
    const baseline = snapshot('Baseline');
    const retained = snapshot('Retained before failure');
    stageCollaborationSyncState(database, scope(), baseline, retained, NOW);
    const candidate = snapshot('Must roll back');

    expect(() =>
      stageCollaborationSyncDelivery(
        database,
        scope(),
        baseline,
        candidate,
        {
          deliveryId: '00000000-0000-4000-8000-000000000080',
          snapshotDigest: 'a'.repeat(64),
          disposition: 'sent',
        },
        NOW,
      ),
    ).toThrow(/digest does not match/u);
    expect(recoverCollaborationSyncState(database, scope(), NOW)).toMatchObject({
      pending: { canvas: { title: 'Retained before failure' } },
      disposition: 'staged',
    });
    expect(deliveryCount(database)).toBe(0);
    database.close();
  });

  it('projects acknowledged A as baseline while later rejected B remains the only recovery addition', () => {
    const { databasePath, database } = databaseFixture();
    const original = commentSnapshot([]);
    const candidateA = commentSnapshot(['comment-a']);
    const candidateAB = commentSnapshot(['comment-a', 'comment-b']);
    const receiptA = delivery(81, candidateA);
    const receiptB = delivery(82, candidateAB);

    stageCollaborationSyncDelivery(database, scope(), original, candidateA, receiptA, NOW);
    settleCollaborationSyncDelivery(database, receiptA.deliveryId, 'acknowledged', NOW);
    stageCollaborationSyncDelivery(
      database,
      scope(),
      original,
      candidateAB,
      receiptB,
      new Date(NOW.getTime() + 1),
    );
    expect(recoverCollaborationSyncState(database, scope(), NOW)).toMatchObject({
      baseline: { comments: { 'comment-a': { id: 'comment-a' } } },
      pending: {
        comments: {
          'comment-a': { id: 'comment-a' },
          'comment-b': { id: 'comment-b' },
        },
      },
      deliveryId: receiptB.deliveryId,
      disposition: 'sent',
    });
    settleCollaborationSyncDelivery(database, receiptB.deliveryId, 'rejected', NOW);
    expect(recoverCollaborationSyncState(database, scope(), NOW)).toMatchObject({
      baseline: { comments: { 'comment-a': { id: 'comment-a' } } },
      pending: {
        comments: {
          'comment-a': { id: 'comment-a' },
          'comment-b': { id: 'comment-b' },
        },
      },
      deliveryId: receiptB.deliveryId,
      disposition: 'rejected',
    });
    database.close();

    const reopened = openDatabase(databasePath);
    migrate(reopened);
    expect(recoverCollaborationSyncState(reopened, scope(), NOW)).toMatchObject({
      baseline: { comments: { 'comment-a': { id: 'comment-a' } } },
      pending: {
        comments: {
          'comment-a': { id: 'comment-a' },
          'comment-b': { id: 'comment-b' },
        },
      },
      deliveryId: receiptB.deliveryId,
      disposition: 'rejected',
    });
    reopened.close();
  });

  it('does not regress acknowledged A when rejected B settles first', () => {
    const { database } = databaseFixture();
    const original = commentSnapshot([]);
    const candidateA = commentSnapshot(['comment-a']);
    const candidateAB = commentSnapshot(['comment-a', 'comment-b']);
    const receiptA = delivery(83, candidateA);
    const receiptB = delivery(84, candidateAB);
    stageCollaborationSyncDelivery(database, scope(), original, candidateA, receiptA, NOW);
    stageCollaborationSyncDelivery(database, scope(), original, candidateAB, receiptB, NOW);

    settleCollaborationSyncDelivery(database, receiptB.deliveryId, 'rejected', NOW);
    settleCollaborationSyncDelivery(database, receiptA.deliveryId, 'acknowledged', NOW);

    expect(recoverCollaborationSyncState(database, scope(), NOW)).toMatchObject({
      baseline: { comments: { 'comment-a': { id: 'comment-a' } } },
      pending: {
        comments: {
          'comment-a': { id: 'comment-a' },
          'comment-b': { id: 'comment-b' },
        },
      },
      deliveryId: receiptB.deliveryId,
      disposition: 'rejected',
    });
    database.close();
  });

  it('reports an intermediate rejected B beneath newer C until C becomes authoritative', () => {
    const { databasePath, database } = databaseFixture();
    const original = commentSnapshot([]);
    const candidateA = commentSnapshot(['comment-a']);
    const candidateAB = commentSnapshot(['comment-a', 'comment-b']);
    const candidateABC = commentSnapshot(['comment-a', 'comment-b', 'comment-c']);
    const receiptA = delivery(94, candidateA);
    const receiptB = delivery(95, candidateAB);
    const receiptC = delivery(96, candidateABC);

    stageCollaborationSyncDelivery(database, scope(), original, candidateA, receiptA, NOW);
    settleCollaborationSyncDelivery(database, receiptA.deliveryId, 'acknowledged', NOW);
    stageCollaborationSyncDelivery(database, scope(), original, candidateAB, receiptB, NOW);
    settleCollaborationSyncDelivery(database, receiptB.deliveryId, 'rejected', NOW);
    stageCollaborationSyncDelivery(database, scope(), candidateA, candidateABC, receiptC, NOW);
    database.close();

    const reopened = openDatabase(databasePath);
    migrate(reopened);
    expect(recoverCollaborationSyncState(reopened, scope(), NOW)).toMatchObject({
      baseline: { comments: { 'comment-a': { id: 'comment-a' } } },
      pending: {
        comments: {
          'comment-a': { id: 'comment-a' },
          'comment-b': { id: 'comment-b' },
          'comment-c': { id: 'comment-c' },
        },
      },
      deliveryId: receiptC.deliveryId,
      disposition: 'sent',
      rejectedCommentIds: ['comment-b'],
    });

    settleCollaborationSyncDelivery(reopened, receiptC.deliveryId, 'acknowledged', NOW);
    expect(recoverCollaborationSyncState(reopened, scope(), NOW)).toMatchObject({
      baseline: {
        comments: {
          'comment-a': { id: 'comment-a' },
          'comment-b': { id: 'comment-b' },
          'comment-c': { id: 'comment-c' },
        },
      },
      disposition: 'acknowledged',
      rejectedCommentIds: [],
    });

    const deletedAgain = commentSnapshot(['comment-a', 'comment-c']);
    const receiptD = delivery(103, deletedAgain);
    stageCollaborationSyncDelivery(reopened, scope(), candidateABC, deletedAgain, receiptD, NOW);
    settleCollaborationSyncDelivery(reopened, receiptD.deliveryId, 'acknowledged', NOW);
    const afterDeletion = recoverCollaborationSyncState(reopened, scope(), NOW);
    expect(afterDeletion).toMatchObject({
      rejectedCommentIds: [],
      rejectedComments: [],
    });
    expect(afterDeletion?.baseline?.comments['comment-b']).toBeUndefined();
    reopened.close();
  });

  it('retains rejected B when a newer acknowledged C omits it', () => {
    const { databasePath, database } = databaseFixture();
    const original = commentSnapshot([]);
    const candidateB = commentSnapshot(['comment-b']);
    const candidateC = commentSnapshot(['comment-c']);
    const receiptB = delivery(97, candidateB);
    const receiptC = delivery(98, candidateC);

    stageCollaborationSyncDelivery(database, scope(), original, candidateB, receiptB, NOW);
    settleCollaborationSyncDelivery(database, receiptB.deliveryId, 'rejected', NOW);
    stageCollaborationSyncDelivery(database, scope(), original, candidateC, receiptC, NOW);
    settleCollaborationSyncDelivery(database, receiptC.deliveryId, 'acknowledged', NOW);
    database.close();

    const reopened = openDatabase(databasePath);
    migrate(reopened);
    expect(recoverCollaborationSyncState(reopened, scope(), NOW)).toMatchObject({
      baseline: { comments: { 'comment-c': { id: 'comment-c' } } },
      pending: { comments: { 'comment-c': { id: 'comment-c' } } },
      disposition: 'acknowledged',
      rejectedCommentIds: ['comment-b'],
      rejectedComments: [{ id: 'comment-b', body: 'comment-b' }],
    });
    const retained = reopened
      .prepare(`SELECT candidate_json FROM collaboration_sync_deliveries WHERE delivery_id = ?`)
      .get(receiptB.deliveryId) as { candidate_json: string };
    expect(JSON.parse(retained.candidate_json)).toMatchObject({
      comments: { 'comment-b': { id: 'comment-b', body: 'comment-b' } },
    });
    expect(() => checkpointCollaborationSyncState(reopened, scope(), candidateC, NOW)).toThrow(
      /rejected collaboration comments cannot be checkpointed away/iu,
    );
    expect(recoverCollaborationSyncState(reopened, scope(), NOW)).toMatchObject({
      rejectedCommentIds: ['comment-b'],
      rejectedComments: [{ id: 'comment-b', body: 'comment-b' }],
    });
    expect(deliveryCount(reopened)).toBe(2);
    reopened.close();
  });

  it('retains an exact re-add rejected after a newer acknowledgement deleted its old value', () => {
    const { database } = databaseFixture();
    const withoutB = commentSnapshot([]);
    const withB = commentSnapshot(['comment-b']);
    const acceptedB = delivery(104, withB);
    const acceptedDeletion = delivery(105, withoutB);
    const rejectedReAdd = delivery(106, withB);

    stageCollaborationSyncDelivery(database, scope(), withoutB, withB, acceptedB, NOW);
    settleCollaborationSyncDelivery(database, acceptedB.deliveryId, 'acknowledged', NOW);
    stageCollaborationSyncDelivery(database, scope(), withB, withoutB, acceptedDeletion, NOW);
    settleCollaborationSyncDelivery(database, acceptedDeletion.deliveryId, 'acknowledged', NOW);
    stageCollaborationSyncDelivery(database, scope(), withoutB, withB, rejectedReAdd, NOW);
    settleCollaborationSyncDelivery(database, rejectedReAdd.deliveryId, 'rejected', NOW);

    expect(recoverCollaborationSyncState(database, scope(), NOW)).toMatchObject({
      baseline: { comments: {} },
      pending: { comments: { 'comment-b': { id: 'comment-b', body: 'comment-b' } } },
      disposition: 'rejected',
      rejectedCommentIds: ['comment-b'],
      rejectedComments: [{ id: 'comment-b', body: 'comment-b' }],
    });
    expect(() => checkpointCollaborationSyncState(database, scope(), withoutB, NOW)).toThrow(
      /rejected collaboration comments cannot be checkpointed away/iu,
    );
    database.close();
  });

  it('durably dismisses only the exact rejected value without rewriting delivery evidence', () => {
    const { databasePath, database } = databaseFixture();
    const original = commentSnapshot([]);
    const candidateB = commentSnapshot(['comment-b']);
    const commentB = candidateB.comments['comment-b'];
    if (commentB === undefined) throw new Error('Missing rejected B fixture.');
    const receiptB = delivery(1_106, candidateB);
    stageCollaborationSyncDelivery(database, scope(), original, candidateB, receiptB, NOW);
    settleCollaborationSyncDelivery(database, receiptB.deliveryId, 'rejected', NOW);
    const evidenceBefore = database
      .prepare(
        `SELECT candidate_json, snapshot_digest FROM collaboration_sync_deliveries
         WHERE delivery_id = ?`,
      )
      .get(receiptB.deliveryId);

    const dismissed = discardRejectedCollaborationComment(
      database,
      scope(),
      commentB,
      receiptB.deliveryId,
      NOW,
    );
    expect(dismissed).toMatchObject({
      pending: { comments: { 'comment-b': { body: 'comment-b' } } },
      rejectedCommentIds: [],
      rejectedComments: [],
      rejectedCommentEntries: [],
      dismissedRejectedComments: [{ id: 'comment-b', body: 'comment-b' }],
    });
    expect(
      database
        .prepare(
          `SELECT candidate_json, snapshot_digest FROM collaboration_sync_deliveries
           WHERE delivery_id = ?`,
        )
        .get(receiptB.deliveryId),
    ).toEqual(evidenceBefore);
    expect(dismissalCount(database)).toBe(1);
    expect(collaborationSyncIntegrityMessages(database)).toEqual([]);
    database.close();

    const reopened = openDatabase(databasePath);
    migrate(reopened);
    expect(recoverCollaborationSyncState(reopened, scope(), NOW)).toMatchObject({
      rejectedCommentEntries: [],
      dismissedRejectedComments: [{ body: 'comment-b' }],
    });
    const remoteC = {
      ...original,
      canvas: { ...original.canvas, title: 'Authenticated remote C' },
    };
    expect(() => checkpointCollaborationSyncState(reopened, scope(), remoteC, NOW)).toThrow(
      /unresolved collaboration intent/iu,
    );
    expect(checkpointCollaborationSyncState(reopened, scope(), original, NOW)).toMatchObject({
      disposition: 'synchronized',
      pending: { canvas: { title: original.canvas.title }, comments: {} },
      dismissedRejectedComments: [],
    });
    expect(deliveryCount(reopened)).toBe(0);
    expect(dismissalCount(reopened)).toBe(0);
    reopened.close();
  });

  it('prunes expired dismissal rows with their bounded recovery scope', () => {
    const { database } = databaseFixture();
    const baseline = commentSnapshot([]);
    const candidate = commentSnapshot(['comment-b']);
    const comment = candidate.comments['comment-b'];
    if (comment === undefined) throw new Error('Missing rejected dismissal fixture.');
    const receipt = delivery(1_114, candidate);
    stageCollaborationSyncDelivery(database, scope(), baseline, candidate, receipt, NOW);
    settleCollaborationSyncDelivery(database, receipt.deliveryId, 'rejected', NOW);
    discardRejectedCollaborationComment(database, scope(), comment, receipt.deliveryId, NOW);
    expect(dismissalCount(database)).toBe(1);

    const expired = new Date(NOW.getTime() + COLLABORATION_SYNC_TTL_MS + 1);
    expect(pruneExpiredCollaborationSyncStates(database, expired)).toBeGreaterThanOrEqual(3);
    expect(dismissalCount(database)).toBe(0);
    expect(deliveryCount(database)).toBe(0);
    expect(recoverCollaborationSyncState(database, scope(), expired)).toBeNull();
    database.close();
  });

  it('reports corrupt exact-value dismissal evidence through storage integrity checks', () => {
    const { database } = databaseFixture();
    const baseline = commentSnapshot([]);
    const candidate = commentSnapshot(['comment-b']);
    const comment = candidate.comments['comment-b'];
    if (comment === undefined) throw new Error('Missing rejected dismissal fixture.');
    const receipt = delivery(1_115, candidate);
    stageCollaborationSyncDelivery(database, scope(), baseline, candidate, receipt, NOW);
    settleCollaborationSyncDelivery(database, receipt.deliveryId, 'rejected', NOW);
    discardRejectedCollaborationComment(database, scope(), comment, receipt.deliveryId, NOW);

    database
      .prepare('UPDATE collaboration_rejected_comment_dismissals SET comment_digest = ?')
      .run('0'.repeat(64));
    expect(collaborationSyncIntegrityMessages(database).join(' ')).toMatch(
      /rejected_comment_dismissals.*digest/iu,
    );
    database.close();
  });

  it('does not checkpoint unrelated local graph intent through a comment dismissal overlay', () => {
    const { database } = databaseFixture();
    const baseline = commentSnapshot([]);
    const withComment = commentSnapshot(['comment-b']);
    const comment = withComment.comments['comment-b'];
    if (comment === undefined) throw new Error('Missing rejected B fixture.');
    const localGraphAndComment = {
      ...withComment,
      canvas: { ...withComment.canvas, title: 'Unrelated local graph intent' },
    };
    const receipt = delivery(1_112, localGraphAndComment);
    stageCollaborationSyncDelivery(database, scope(), baseline, localGraphAndComment, receipt, NOW);
    settleCollaborationSyncDelivery(database, receipt.deliveryId, 'rejected', NOW);
    discardRejectedCollaborationComment(database, scope(), comment, receipt.deliveryId, NOW);
    const remoteC = {
      ...baseline,
      canvas: { ...baseline.canvas, title: 'Authenticated remote C' },
    };

    expect(() => checkpointCollaborationSyncState(database, scope(), remoteC, NOW)).toThrow(
      /unresolved collaboration intent/iu,
    );
    expect(deliveryCount(database)).toBe(1);
    expect(dismissalCount(database)).toBe(1);
    database.close();
  });

  it('rejects stale same-ID content and preserves every other rejected item', () => {
    const { database } = databaseFixture();
    const original = commentSnapshot([]);
    const candidateB = commentSnapshot(['comment-b']);
    const candidateBC = commentSnapshot(['comment-b', 'comment-c']);
    const commentB = candidateB.comments['comment-b'];
    if (commentB === undefined) throw new Error('Missing rejected B fixture.');
    const receiptB = delivery(1_107, candidateB);
    const receiptC = delivery(1_108, candidateBC);
    stageCollaborationSyncDelivery(database, scope(), original, candidateB, receiptB, NOW);
    settleCollaborationSyncDelivery(database, receiptB.deliveryId, 'rejected', NOW);
    stageCollaborationSyncDelivery(database, scope(), original, candidateBC, receiptC, NOW);
    settleCollaborationSyncDelivery(database, receiptC.deliveryId, 'rejected', NOW);

    expect(() =>
      discardRejectedCollaborationComment(
        database,
        scope(),
        { ...commentB, body: 'stale same-ID text' },
        receiptB.deliveryId,
        NOW,
      ),
    ).toThrow(/changed before it could be discarded/u);
    expect(dismissalCount(database)).toBe(0);

    const active = recoverCollaborationSyncState(database, scope(), NOW);
    const entryB = active?.rejectedCommentEntries?.find(
      (entry) => entry.comment.id === commentB.id,
    );
    if (entryB === undefined) throw new Error('Missing active rejected B entry.');
    const afterB = discardRejectedCollaborationComment(
      database,
      scope(),
      entryB.comment,
      entryB.rejectedDeliveryId,
      NOW,
    );
    expect(afterB.rejectedCommentIds).toEqual(['comment-c']);
    expect(afterB.dismissedRejectedComments).toEqual([entryB.comment]);
    expect(() => checkpointCollaborationSyncState(database, scope(), original, NOW)).toThrow(
      /rejected collaboration comments/iu,
    );
    expect(deliveryCount(database)).toBe(2);
    database.close();
  });

  it('shows a later byte-identical rejection after the dismissed delivery cutoff', () => {
    const { database } = databaseFixture();
    const withoutB = commentSnapshot([]);
    const withB = commentSnapshot(['comment-b']);
    const commentB = withB.comments['comment-b'];
    if (commentB === undefined) throw new Error('Missing rejected B fixture.');
    const first = delivery(1_109, withB);
    stageCollaborationSyncDelivery(database, scope(), withoutB, withB, first, NOW);
    settleCollaborationSyncDelivery(database, first.deliveryId, 'rejected', NOW);
    discardRejectedCollaborationComment(database, scope(), commentB, first.deliveryId, NOW);

    const later = delivery(1_110, withB);
    stageCollaborationSyncDelivery(database, scope(), withoutB, withB, later, NOW);
    settleCollaborationSyncDelivery(database, later.deliveryId, 'rejected', NOW);
    expect(recoverCollaborationSyncState(database, scope(), NOW)).toMatchObject({
      rejectedCommentEntries: [
        { comment: { id: 'comment-b', body: 'comment-b' }, rejectedDeliveryId: later.deliveryId },
      ],
      dismissedRejectedComments: [],
    });
    expect(dismissalCount(database)).toBe(1);
    database.close();
  });

  it('accepts a schema-maximum astral comment at the exact dismissal boundary', () => {
    const { database } = databaseFixture();
    const original = commentSnapshot([]);
    const base = commentSnapshot(['comment-b']);
    const comment = base.comments['comment-b'];
    if (comment === undefined) throw new Error('Missing rejected B fixture.');
    const astral = { ...base, comments: { 'comment-b': { ...comment, body: '😀'.repeat(2_000) } } };
    const receipt = delivery(1_111, astral);
    stageCollaborationSyncDelivery(database, scope(), original, astral, receipt, NOW);
    settleCollaborationSyncDelivery(database, receipt.deliveryId, 'rejected', NOW);

    expect(() =>
      discardRejectedCollaborationComment(
        database,
        scope(),
        astral.comments['comment-b'],
        receipt.deliveryId,
        NOW,
      ),
    ).not.toThrow();
    expect(dismissalCount(database)).toBe(1);
    database.close();
  });

  it('keeps a rejected reply active until it is explicitly discarded after its parent', () => {
    const { database } = databaseFixture();
    const base = commentSnapshot([]);
    const parent = {
      id: 'comment-parent',
      nodeId: 'node-1',
      authorId: 'editor-1',
      body: 'Rejected parent',
      createdAt: NOW.toISOString(),
    };
    const reply = {
      id: 'comment-reply',
      nodeId: 'node-1',
      authorId: 'editor-1',
      body: 'Rejected reply',
      replyToId: parent.id,
      createdAt: NOW.toISOString(),
    };
    const review = {
      id: 'review-1',
      nodeId: 'node-1',
      reviewerId: 'editor-1',
      status: 'changes-requested' as const,
      createdAt: NOW.toISOString(),
    };
    const baseline: CollaborationMetadataSnapshot = {
      ...base,
      reviews: { [review.id]: { ...review, commentIds: [] } },
    };
    const candidate: CollaborationMetadataSnapshot = {
      ...baseline,
      comments: { [parent.id]: parent, [reply.id]: reply },
      reviews: {
        [review.id]: {
          ...review,
          commentIds: [parent.id, reply.id],
        },
      },
    };
    const receipt = delivery(1_113, candidate);
    stageCollaborationSyncDelivery(database, scope(), baseline, candidate, receipt, NOW);
    settleCollaborationSyncDelivery(database, receipt.deliveryId, 'rejected', NOW);

    const afterParent = discardRejectedCollaborationComment(
      database,
      scope(),
      parent,
      receipt.deliveryId,
      NOW,
    );
    expect(afterParent).toMatchObject({
      rejectedCommentEntries: [{ comment: { id: reply.id, body: reply.body } }],
      dismissedRejectedComments: [{ id: parent.id }],
    });
    expect(() => checkpointCollaborationSyncState(database, scope(), baseline, NOW)).toThrow(
      /rejected collaboration comments/iu,
    );

    const afterReply = discardRejectedCollaborationComment(
      database,
      scope(),
      reply,
      receipt.deliveryId,
      NOW,
    );
    expect(afterReply.rejectedCommentEntries).toEqual([]);
    expect(afterReply.dismissedRejectedComments).toEqual([parent, reply]);
    expect(checkpointCollaborationSyncState(database, scope(), baseline, NOW)).toMatchObject({
      disposition: 'synchronized',
      pending: { comments: {}, reviews: { 'review-1': { commentIds: [] } } },
    });
    database.close();
  });

  it('retains rejected B when acknowledged C reuses its id with a different body', () => {
    const { database } = databaseFixture();
    const original = commentSnapshot([]);
    const rejectedB = commentSnapshot(['comment-b']);
    const originalComment = rejectedB.comments['comment-b'];
    if (originalComment === undefined) throw new Error('Missing rejected B fixture.');
    const conflictingB: CollaborationMetadataSnapshot = {
      ...rejectedB,
      comments: {
        ...rejectedB.comments,
        'comment-b': { ...originalComment, body: 'conflicting body' },
      },
    };
    const receiptB = delivery(101, rejectedB);
    const receiptC = delivery(102, conflictingB);

    stageCollaborationSyncDelivery(database, scope(), original, rejectedB, receiptB, NOW);
    settleCollaborationSyncDelivery(database, receiptB.deliveryId, 'rejected', NOW);
    stageCollaborationSyncDelivery(database, scope(), original, conflictingB, receiptC, NOW);
    settleCollaborationSyncDelivery(database, receiptC.deliveryId, 'acknowledged', NOW);

    expect(recoverCollaborationSyncState(database, scope(), NOW)).toMatchObject({
      baseline: { comments: { 'comment-b': { body: 'conflicting body' } } },
      rejectedCommentIds: ['comment-b'],
      rejectedComments: [{ id: 'comment-b', body: 'comment-b' }],
    });
    expect(() => checkpointCollaborationSyncState(database, scope(), conflictingB, NOW)).toThrow(
      /rejected collaboration comments cannot be checkpointed away/iu,
    );
    database.close();
  });

  it('keeps the acknowledged prefix through the sliding scope TTL until later B settles', () => {
    const { database } = databaseFixture();
    const original = commentSnapshot([]);
    const candidateA = commentSnapshot(['comment-a']);
    const candidateAB = commentSnapshot(['comment-a', 'comment-b']);
    const receiptA = delivery(92, candidateA);
    const receiptB = delivery(93, candidateAB);
    stageCollaborationSyncDelivery(database, scope(), original, candidateA, receiptA, NOW);
    settleCollaborationSyncDelivery(database, receiptA.deliveryId, 'acknowledged', NOW);
    const later = new Date(NOW.getTime() + 24 * 60 * 60 * 1_000);
    stageCollaborationSyncDelivery(database, scope(), original, candidateAB, receiptB, later);

    const pastAOriginalExpiry = new Date(NOW.getTime() + COLLABORATION_SYNC_TTL_MS + 1);
    expect(pruneExpiredCollaborationSyncStates(database, pastAOriginalExpiry)).toBe(0);
    expect(deliveryCount(database)).toBe(2);
    settleCollaborationSyncDelivery(database, receiptB.deliveryId, 'rejected', pastAOriginalExpiry);
    expect(recoverCollaborationSyncState(database, scope(), pastAOriginalExpiry)).toMatchObject({
      baseline: { comments: { 'comment-a': { id: 'comment-a' } } },
      pending: {
        comments: {
          'comment-a': { id: 'comment-a' },
          'comment-b': { id: 'comment-b' },
        },
      },
      disposition: 'rejected',
    });
    database.close();
  });

  it('keeps the highest-sequence acknowledged cumulative candidate in either settlement order', () => {
    for (const order of ['reject-a-first', 'ack-b-first'] as const) {
      const { database } = databaseFixture();
      const original = commentSnapshot([]);
      const candidateA = commentSnapshot(['comment-a']);
      const candidateAB = commentSnapshot(['comment-a', 'comment-b']);
      const receiptA = delivery(order === 'reject-a-first' ? 85 : 87, candidateA);
      const receiptB = delivery(order === 'reject-a-first' ? 86 : 88, candidateAB);
      stageCollaborationSyncDelivery(database, scope(), original, candidateA, receiptA, NOW);
      stageCollaborationSyncDelivery(database, scope(), original, candidateAB, receiptB, NOW);

      if (order === 'reject-a-first') {
        settleCollaborationSyncDelivery(database, receiptA.deliveryId, 'rejected', NOW);
        settleCollaborationSyncDelivery(database, receiptB.deliveryId, 'acknowledged', NOW);
      } else {
        settleCollaborationSyncDelivery(database, receiptB.deliveryId, 'acknowledged', NOW);
        settleCollaborationSyncDelivery(database, receiptA.deliveryId, 'rejected', NOW);
      }

      expect(recoverCollaborationSyncState(database, scope(), NOW)).toMatchObject({
        baseline: {
          comments: {
            'comment-a': { id: 'comment-a' },
            'comment-b': { id: 'comment-b' },
          },
        },
        pending: {
          comments: {
            'comment-a': { id: 'comment-a' },
            'comment-b': { id: 'comment-b' },
          },
        },
        deliveryId: receiptB.deliveryId,
        disposition: 'acknowledged',
      });
      database.close();
    }
  });

  it('deletes the exact delivery ledger on checkpoint, expiry, and privacy cleanup', () => {
    const { database } = databaseFixture();
    const original = commentSnapshot([]);
    const candidate = commentSnapshot(['comment-a']);
    const receipt = delivery(89, candidate);
    stageCollaborationSyncDelivery(database, scope(), original, candidate, receipt, NOW);
    expect(deliveryCount(database)).toBe(1);
    checkpointCollaborationSyncState(database, scope(), candidate, NOW);
    expect(deliveryCount(database)).toBe(0);

    stageCollaborationSyncDelivery(
      database,
      scope(),
      candidate,
      candidate,
      delivery(90, candidate),
      NOW,
    );
    recoverCollaborationSyncState(
      database,
      scope(),
      new Date(NOW.getTime() + COLLABORATION_SYNC_TTL_MS + 1),
    );
    expect(deliveryCount(database)).toBe(0);

    stageCollaborationSyncDelivery(
      database,
      scope(),
      candidate,
      candidate,
      delivery(91, candidate),
      NOW,
    );
    clearAllTables(database);
    expect(deliveryCount(database)).toBe(0);
    database.close();
  });

  it('fails closed at the per-scope delivery row cap without overwriting retained intent', () => {
    const { database } = databaseFixture();
    const candidate = commentSnapshot(['comment-a']);
    stageCollaborationSyncState(database, scope(), commentSnapshot([]), candidate, NOW);
    for (let index = 0; index < COLLABORATION_SYNC_MAX_DELIVERIES_PER_SCOPE; index += 1) {
      insertRawDelivery(database, 1_000 + index, serializeCollaborationMetadataSnapshot(candidate));
    }

    expect(() =>
      stageCollaborationSyncDelivery(
        database,
        scope(),
        commentSnapshot([]),
        candidate,
        delivery(2_000, candidate),
        NOW,
      ),
    ).toThrow(/too many durable delivery settlements/u);
    expect(deliveryCount(database)).toBe(COLLABORATION_SYNC_MAX_DELIVERIES_PER_SCOPE);
    expect(recoverCollaborationSyncState(database, scope(), NOW)).toMatchObject({
      pending: { comments: { 'comment-a': { id: 'comment-a' } } },
    });
    database.close();
  });

  it('fails closed at the aggregate per-scope delivery byte cap', () => {
    const { database } = databaseFixture();
    const candidate = commentSnapshot(['comment-a']);
    stageCollaborationSyncState(database, scope(), commentSnapshot([]), candidate, NOW);
    const halfLimit = COLLABORATION_SYNC_MAX_DELIVERY_BYTES_PER_SCOPE / 2;
    insertRawDelivery(database, 3_001, null, halfLimit);
    insertRawDelivery(database, 3_002, null, halfLimit);

    expect(() =>
      stageCollaborationSyncDelivery(
        database,
        scope(),
        commentSnapshot([]),
        candidate,
        delivery(3_003, candidate),
        NOW,
      ),
    ).toThrow(/durable delivery byte limit/u);
    expect(deliveryCount(database)).toBe(2);
    database.close();
  });

  it('counts duplicated baselines toward the aggregate delivery byte cap', () => {
    const { database } = databaseFixture();
    const baseline = largeCommentSnapshot();
    const candidate = commentSnapshot(['comment-a']);
    const candidateJson = serializeCollaborationMetadataSnapshot(candidate);
    const baselineJson = serializeCollaborationMetadataSnapshot(baseline);
    stageCollaborationSyncState(database, scope(), baseline, candidate, NOW);
    insertRawDelivery(database, 3_011, candidateJson, undefined, baselineJson);
    insertRawDelivery(database, 3_012, candidateJson, undefined, baselineJson);
    insertRawDelivery(database, 3_013, candidateJson, undefined, baselineJson);

    expect(() =>
      stageCollaborationSyncDelivery(
        database,
        scope(),
        baseline,
        candidate,
        delivery(3_014, candidate),
        NOW,
      ),
    ).toThrow(/durable delivery byte limit/u);
    expect(deliveryCount(database)).toBe(3);
    database.close();
  });

  it('reports ledger candidate scope and digest corruption through integrity checks', () => {
    const { database } = databaseFixture();
    const candidate = commentSnapshot(['comment-a']);
    const receipt = delivery(4_001, candidate);
    stageCollaborationSyncDelivery(database, scope(), commentSnapshot([]), candidate, receipt, NOW);
    const wrongCanvas = {
      ...candidate,
      canvas: {
        ...candidate.canvas,
        id: '00000000-0000-4000-8000-000000000099',
      },
    };
    const wrongCanvasJson = serializeCollaborationMetadataSnapshot(wrongCanvas);
    database
      .prepare(
        `UPDATE collaboration_sync_deliveries
         SET candidate_json = ?, snapshot_digest = ? WHERE delivery_id = ?`,
      )
      .run(
        wrongCanvasJson,
        createHash('sha256').update(wrongCanvasJson).digest('hex'),
        receipt.deliveryId,
      );
    expect(collaborationSyncIntegrityMessages(database).join(' ')).toMatch(/another canvas/u);

    const candidateJson = serializeCollaborationMetadataSnapshot(candidate);
    database
      .prepare(
        `UPDATE collaboration_sync_deliveries
         SET candidate_json = ?, snapshot_digest = ? WHERE delivery_id = ?`,
      )
      .run(candidateJson, 'f'.repeat(64), receipt.deliveryId);
    expect(collaborationSyncIntegrityMessages(database).join(' ')).toMatch(
      /delivery digest mismatch/u,
    );
    database.close();
  });

  it('reports mismatched state delivery, digest, candidate, and acknowledged projection', () => {
    const { database } = databaseFixture();
    const original = commentSnapshot([]);
    const candidate = commentSnapshot(['comment-a']);
    const receipt = delivery(4_002, candidate);
    stageCollaborationSyncDelivery(database, scope(), original, candidate, receipt, NOW);

    database
      .prepare(
        `UPDATE collaboration_sync_states SET delivery_id = ?
         WHERE project_id = ? AND canvas_id = ?`,
      )
      .run('00000000-0000-4000-8000-000000009999', PROJECT_ID, CANVAS_ID);
    expect(collaborationSyncIntegrityMessages(database).join(' ')).toMatch(
      /state delivery identity does not match ledger/u,
    );
    database
      .prepare(
        `UPDATE collaboration_sync_states SET delivery_id = ?, snapshot_digest = ?
         WHERE project_id = ? AND canvas_id = ?`,
      )
      .run(receipt.deliveryId, 'e'.repeat(64), PROJECT_ID, CANVAS_ID);
    expect(collaborationSyncIntegrityMessages(database).join(' ')).toMatch(
      /state digest does not match ledger/u,
    );

    const originalJson = serializeCollaborationMetadataSnapshot(original);
    database
      .prepare(
        `UPDATE collaboration_sync_states SET snapshot_digest = ?, pending_json = ?
         WHERE project_id = ? AND canvas_id = ?`,
      )
      .run(receipt.snapshotDigest, originalJson, PROJECT_ID, CANVAS_ID);
    expect(collaborationSyncIntegrityMessages(database).join(' ')).toMatch(
      /pending candidate does not match ledger/u,
    );

    database
      .prepare(
        `UPDATE collaboration_sync_states SET pending_json = ?
         WHERE project_id = ? AND canvas_id = ?`,
      )
      .run(serializeCollaborationMetadataSnapshot(candidate), PROJECT_ID, CANVAS_ID);
    settleCollaborationSyncDelivery(database, receipt.deliveryId, 'acknowledged', NOW);
    database
      .prepare(
        `UPDATE collaboration_sync_states SET baseline_json = ?
         WHERE project_id = ? AND canvas_id = ?`,
      )
      .run(originalJson, PROJECT_ID, CANVAS_ID);
    expect(collaborationSyncIntegrityMessages(database).join(' ')).toMatch(
      /acknowledged baseline does not match ledger/u,
    );
    database.close();
  });

  it('fails closed at the row quota instead of silently evicting retained user intent', () => {
    const { database } = databaseFixture();
    for (let index = 0; index < 32; index += 1) {
      stageCollaborationSyncState(
        database,
        { ...scope(), subject: `editor-${index}` },
        snapshot('Baseline'),
        snapshot(`Pending ${index}`),
        NOW,
      );
    }
    expect(() =>
      stageCollaborationSyncState(
        database,
        { ...scope(), subject: 'editor-overflow' },
        snapshot('Baseline'),
        snapshot('Must remain local'),
        NOW,
      ),
    ).toThrow(/retained collaboration recovery limit/u);
    expect(
      recoverCollaborationSyncState(database, { ...scope(), subject: 'editor-0' }, NOW),
    ).not.toBeNull();
    database.close();
  });
});

function databaseFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'forgeboard-collaboration-sync-'));
  directories.push(directory);
  const databasePath = join(directory, 'forgeboard.sqlite');
  const database = openDatabase(databasePath);
  migrate(database);
  database
    .prepare(`INSERT INTO recent_projects(id, path, value_json, opened_at) VALUES(?, ?, ?, ?)`)
    .run(PROJECT_ID, '/tmp/project', '{}', NOW.toISOString());
  database
    .prepare(
      `INSERT INTO canvas_documents(id, project_id, value_json, updated_at) VALUES(?, ?, ?, ?)`,
    )
    .run(CANVAS_ID, PROJECT_ID, '{}', NOW.toISOString());
  return { databasePath, database };
}

function scope(): CollaborationSyncStorageScope {
  return {
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    serverUrl: 'wss://collaboration.example.test/team',
    roomId: 'launch-room',
    subject: 'editor-1',
  };
}

function snapshot(title: string): CollaborationMetadataSnapshot {
  return {
    canvas: { id: CANVAS_ID, title, version: 1, updatedAt: NOW.toISOString() },
    nodes: {},
    edges: {},
    groups: {},
    tasks: {},
    comments: {},
    workflow: {},
    reviews: {},
  };
}

function commentSnapshot(ids: readonly string[]): CollaborationMetadataSnapshot {
  return {
    ...snapshot('Comments'),
    nodes: {
      'node-1': {
        id: 'node-1',
        type: 'task',
        title: 'Task',
        position: { x: 0, y: 0 },
      },
    },
    comments: Object.fromEntries(
      ids.map((id) => [
        id,
        {
          id,
          nodeId: 'node-1',
          authorId: 'editor-1',
          body: id,
          createdAt: NOW.toISOString(),
        },
      ]),
    ),
  };
}

function largeCommentSnapshot(): CollaborationMetadataSnapshot {
  const value = commentSnapshot([]);
  return {
    ...value,
    comments: Object.fromEntries(
      Array.from({ length: 1_600 }, (_, index) => {
        const id = `large-comment-${String(index)}`;
        return [
          id,
          {
            id,
            nodeId: 'node-1',
            authorId: 'editor-1',
            body: `${String(index)}-${'x'.repeat(3_880)}`,
            createdAt: NOW.toISOString(),
          },
        ];
      }),
    ),
  };
}

function digest(candidate: CollaborationMetadataSnapshot): string {
  return createHash('sha256')
    .update(serializeCollaborationMetadataSnapshot(candidate))
    .digest('hex');
}

function delivery(sequence: number, candidate: CollaborationMetadataSnapshot) {
  return {
    deliveryId: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    snapshotDigest: digest(candidate),
    disposition: 'sent' as const,
  };
}

function deliveryCount(database: ReturnType<typeof openDatabase>): number {
  const row = database
    .prepare('SELECT COUNT(*) AS count FROM collaboration_sync_deliveries')
    .get() as {
    count: number;
  };
  return row.count;
}

function dismissalCount(database: ReturnType<typeof openDatabase>): number {
  return (
    database
      .prepare('SELECT COUNT(*) AS count FROM collaboration_rejected_comment_dismissals')
      .get() as { count: number }
  ).count;
}

function insertRawDelivery(
  database: ReturnType<typeof openDatabase>,
  sequence: number,
  candidateJson: string | null,
  blobBytes?: number,
  baselineJson?: string,
): void {
  const identity = `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
  const values = scope();
  const common = [
    identity,
    values.projectId,
    values.canvasId,
    values.serverUrl,
    values.roomId,
    values.subject,
  ] as const;
  if (baselineJson !== undefined) {
    if (candidateJson === null)
      throw new Error('A baseline quota fixture requires candidate JSON.');
    database
      .prepare(
        `INSERT INTO collaboration_sync_deliveries(
           delivery_id, project_id, canvas_id, server_url, room_id, subject, baseline_json,
           candidate_json, snapshot_digest, disposition, created_at, expires_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?)`,
      )
      .run(
        ...common,
        baselineJson,
        candidateJson,
        createHash('sha256').update(candidateJson).digest('hex'),
        NOW.toISOString(),
        new Date(NOW.getTime() + COLLABORATION_SYNC_TTL_MS).toISOString(),
      );
    return;
  }
  if (candidateJson === null) {
    database
      .prepare(
        `INSERT INTO collaboration_sync_deliveries(
           delivery_id, project_id, canvas_id, server_url, room_id, subject, candidate_json,
           snapshot_digest, disposition, created_at, expires_at
         ) VALUES(?, ?, ?, ?, ?, ?, zeroblob(?), ?, 'sent', ?, ?)`,
      )
      .run(
        ...common,
        blobBytes ?? 0,
        'a'.repeat(64),
        NOW.toISOString(),
        new Date(NOW.getTime() + COLLABORATION_SYNC_TTL_MS).toISOString(),
      );
    return;
  }
  database
    .prepare(
      `INSERT INTO collaboration_sync_deliveries(
         delivery_id, project_id, canvas_id, server_url, room_id, subject, candidate_json,
         snapshot_digest, disposition, created_at, expires_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?)`,
    )
    .run(
      ...common,
      candidateJson,
      createHash('sha256').update(candidateJson).digest('hex'),
      NOW.toISOString(),
      new Date(NOW.getTime() + COLLABORATION_SYNC_TTL_MS).toISOString(),
    );
}
