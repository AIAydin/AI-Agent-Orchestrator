import type { DatabaseSync } from 'node:sqlite';

import {
  TrustedExtensionLedgerRecordSchema,
  TrustedExtensionStateSchema,
  type TrustedExtensionLedgerRecord,
  type TrustedExtensionState,
} from '../storage-schemas.js';
import { transaction } from './database.js';
import {
  parseTrustedExtensionLedgerRow,
  TRUSTED_EXTENSION_LEDGER_COLUMNS,
  type TrustedExtensionLedgerRow,
} from './values.js';
import { assertTrustedExtensionReplacementIsCurrent, writeTrustedExtension } from './writes.js';

export function getTrustedExtension(
  database: DatabaseSync,
  extensionId: string,
): TrustedExtensionLedgerRecord | undefined {
  const row = database
    .prepare(
      `SELECT ${TRUSTED_EXTENSION_LEDGER_COLUMNS}
       FROM trusted_extension_ledger WHERE extension_id = ?`,
    )
    .get(extensionId) as TrustedExtensionLedgerRow | undefined;
  return row ? parseTrustedExtensionLedgerRow(row) : undefined;
}

export function listTrustedExtensions(
  database: DatabaseSync,
  state?: TrustedExtensionState,
): TrustedExtensionLedgerRecord[] {
  const parsedState = state === undefined ? undefined : TrustedExtensionStateSchema.parse(state);
  const rows = (parsedState === undefined
    ? database
        .prepare(
          `SELECT ${TRUSTED_EXTENSION_LEDGER_COLUMNS}
           FROM trusted_extension_ledger ORDER BY extension_id`,
        )
        .all()
    : database
        .prepare(
          `SELECT ${TRUSTED_EXTENSION_LEDGER_COLUMNS}
           FROM trusted_extension_ledger
             WHERE state = ? ORDER BY extension_id`,
        )
        .all(parsedState)) as unknown as TrustedExtensionLedgerRow[];
  return rows.map(parseTrustedExtensionLedgerRow);
}

export function stageTrustedExtension(
  database: DatabaseSync,
  record: TrustedExtensionLedgerRecord,
): TrustedExtensionLedgerRecord {
  const parsed = TrustedExtensionLedgerRecordSchema.parse(record);
  if (parsed.state !== 'pending') {
    throw new Error('A staged trusted extension must be pending.');
  }
  return transaction(database, () => {
    const current = getTrustedExtension(database, parsed.extensionId);
    if (current?.operationId === parsed.operationId) {
      if (current.state === 'active') return current;
      if (current.state === 'revoked') {
        throw new Error('A revoked extension operation cannot be staged again.');
      }
    }
    assertTrustedExtensionReplacementIsCurrent(current, parsed);
    writeTrustedExtension(database, parsed);
    return parsed;
  });
}

export function activateTrustedExtension(
  database: DatabaseSync,
  extensionId: string,
  operationId: string,
  activatedAt = new Date(),
): TrustedExtensionLedgerRecord {
  return transaction(database, () => {
    const current = getTrustedExtension(database, extensionId);
    if (!current) throw new Error('The trusted extension approval does not exist.');
    if (current.operationId !== operationId) {
      throw new Error('The trusted extension operation no longer matches its approval.');
    }
    if (current.state === 'active') return current;
    if (current.state !== 'pending') {
      throw new Error('Only a pending trusted extension approval can be activated.');
    }
    const activated = TrustedExtensionLedgerRecordSchema.parse({
      ...current,
      state: 'active',
      updatedAt: activatedAt.toISOString(),
    });
    assertTrustedExtensionReplacementIsCurrent(current, activated);
    writeTrustedExtension(database, activated);
    return activated;
  });
}

/**
 * Restore the exact previously-active approval after a staged registry mutation fails. The
 * rollback is accepted only while the failed operation still owns the pending row, so a stale
 * caller cannot overwrite a newer approval or revocation.
 */
export function restoreActiveTrustedExtension(
  database: DatabaseSync,
  previousRecord: TrustedExtensionLedgerRecord,
  failedOperationId: string,
  restoredAt = new Date(),
): TrustedExtensionLedgerRecord {
  const previous = TrustedExtensionLedgerRecordSchema.parse(previousRecord);
  if (previous.state !== 'active') {
    throw new Error('Only a previously active trusted extension approval can be restored.');
  }
  return transaction(database, () => {
    const current = getTrustedExtension(database, previous.extensionId);
    if (
      current?.state !== 'pending' ||
      current.operationId !== failedOperationId ||
      previous.operationId === failedOperationId
    ) {
      throw new Error('The failed trusted extension operation is stale or no longer pending.');
    }
    if (Date.parse(previous.updatedAt) > Date.parse(current.updatedAt)) {
      throw new Error('The previous trusted extension approval postdates the failed operation.');
    }
    const minimumRestoredAt = Date.parse(current.updatedAt) + 1;
    const restoredTimestamp = new Date(
      Math.max(restoredAt.getTime(), minimumRestoredAt),
    ).toISOString();
    const restored = TrustedExtensionLedgerRecordSchema.parse({
      ...previous,
      updatedAt: restoredTimestamp,
    });
    writeTrustedExtension(database, restored);
    return restored;
  });
}

export function upsertActiveTrustedExtension(
  database: DatabaseSync,
  record: TrustedExtensionLedgerRecord,
): TrustedExtensionLedgerRecord {
  const parsed = TrustedExtensionLedgerRecordSchema.parse(record);
  if (parsed.state !== 'active') {
    throw new Error('An atomically trusted extension record must be active.');
  }
  return transaction(database, () => {
    const current = getTrustedExtension(database, parsed.extensionId);
    if (current?.state === 'revoked' && current.operationId === parsed.operationId) {
      throw new Error('A revoked extension operation cannot become active again.');
    }
    assertTrustedExtensionReplacementIsCurrent(current, parsed);
    writeTrustedExtension(database, parsed);
    return parsed;
  });
}

export function revokeTrustedExtension(
  database: DatabaseSync,
  extensionId: string,
  removalOperationId: string,
  revokedAt = new Date(),
): TrustedExtensionLedgerRecord {
  return transaction(database, () => {
    const current = getTrustedExtension(database, extensionId);
    if (!current) throw new Error('The trusted extension approval does not exist.');
    if (current.state === 'revoked') {
      if (current.operationId !== removalOperationId) {
        throw new Error('The trusted extension was revoked by a different operation.');
      }
      return current;
    }
    const revoked = TrustedExtensionLedgerRecordSchema.parse({
      ...current,
      state: 'revoked',
      operationId: removalOperationId,
      updatedAt: revokedAt.toISOString(),
    });
    assertTrustedExtensionReplacementIsCurrent(current, revoked);
    writeTrustedExtension(database, revoked);
    return revoked;
  });
}

export function purgeTrustedExtension(
  database: DatabaseSync,
  extensionId: string,
  removalOperationId: string,
): boolean {
  return transaction(database, () => {
    const current = getTrustedExtension(database, extensionId);
    if (!current) return false;
    if (current.state !== 'revoked') {
      throw new Error('A trusted extension must be revoked before its ledger entry is purged.');
    }
    if (current.operationId !== removalOperationId) {
      throw new Error('The trusted extension purge operation does not match its revocation.');
    }
    return (
      Number(
        database
          .prepare(
            `DELETE FROM trusted_extension_ledger
             WHERE extension_id = ? AND state = 'revoked' AND operation_id = ?`,
          )
          .run(extensionId, removalOperationId).changes,
      ) === 1
    );
  });
}
