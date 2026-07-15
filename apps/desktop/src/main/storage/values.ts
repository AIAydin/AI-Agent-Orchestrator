import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  AppSettingsSchema,
  CanvasDocumentSchema,
  ProjectSchema,
  type AppSettings,
  type CanvasDocument,
  type Project,
} from '../../shared/contracts.js';
import { sanitizeCanvasExtensionData } from '../../shared/extension-values.js';
import {
  canonicalCanvasFromLegacy,
  legacySurfaceFromCanonical,
  synchronizeCanvasDocument,
} from '../../shared/canvas/adapter.js';
import {
  CanvasSnapshotSchema,
  TrustedExtensionLedgerRecordSchema,
  type CanvasSnapshot,
  type TrustedExtensionLedgerRecord,
} from '../storage-schemas.js';

export const TRUSTED_EXTENSION_LEDGER_COLUMNS = `
  extension_id, schema_version, extension_version, manifest_digest, snapshot_digest,
  permissions_json, approved_at, state, operation_id, value_json, updated_at
`;

export interface JsonRow {
  value_json: string;
}

export interface AuditRow {
  sequence: number;
  occurred_at: string;
  category: string;
  action: string;
  outcome: string;
  metadata_json: string;
}

export interface BackupRow {
  id: string;
  canonical_path: string;
  sha256: string;
  size_bytes: number;
}

export interface TrustedExtensionLedgerRow {
  extension_id: string;
  schema_version: number;
  extension_version: string;
  manifest_digest: string;
  snapshot_digest: string;
  permissions_json: string;
  approved_at: string;
  state: string;
  operation_id: string;
  value_json: string;
  updated_at: string;
}

const SECRET_KEY =
  /(token|secret|password|authorization|cookie|credential|signature|api.?key|access.?key|private.?key)/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        SECRET_KEY.test(key) ? '[REDACTED]' : redact(child),
      ]),
    );
  }
  return typeof value === 'string' ? redactSensitiveString(value) : value;
}

export function redactSensitiveString(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:') {
      if (url.username !== '' || url.password !== '') {
        url.username = 'REDACTED';
        url.password = '';
      }
      const query = [...url.searchParams.entries()];
      url.search = '';
      for (const [key, child] of query) {
        url.searchParams.append(
          key,
          SECRET_KEY.test(key) ? 'REDACTED' : redactKnownCredential(child),
        );
      }
      if (url.hash !== '') url.hash = '#REDACTED';
      return url.toString();
    }
  } catch {
    // Non-URL strings are handled by the bounded patterns below.
  }
  return redactKnownCredential(
    value
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/giu, 'Bearer [REDACTED]')
      .replace(
        /(\b[A-Za-z0-9_.-]*(?:token|secret|password|authorization|cookie|credential|signature|api.?key|access.?key|private.?key)[A-Za-z0-9_.-]*\s*[:=]\s*)([^\s,;]+)/giu,
        '$1[REDACTED]',
      ),
  );
}

function redactKnownCredential(value: string): string {
  return value
    .replace(
      /\b(?:(?:sk|rk)_(?:live|test)_|sk-(?:proj-)?|gh[pousr]_|xox[baprs]-)[A-Za-z0-9_-]{16,}\b/gu,
      '[REDACTED]',
    )
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, '[REDACTED]');
}

export function sanitizeProject(project: Project): Project {
  return ProjectSchema.parse({
    ...project,
    health: {
      ...project.health,
      remotes: project.health.remotes.map((remote) => ({
        ...remote,
        url: redactSensitiveString(remote.url),
      })),
      scripts: Object.fromEntries(
        Object.entries(project.health.scripts).map(([name, command]) => [
          name,
          redactSensitiveString(command),
        ]),
      ),
    },
  });
}

export function validateSettings(value: unknown): AppSettings {
  const parsed = AppSettingsSchema.parse(value);
  if (parsed.previewPortEnd <= parsed.previewPortStart) {
    throw new Error('Preview port end must be greater than preview port start.');
  }
  return parsed;
}

export function canvasContentHash(document: CanvasDocument): string {
  const content =
    document.canonical === undefined
      ? ({
          id: document.id,
          projectId: document.projectId,
          name: document.name,
          nodes: document.nodes,
          edges: document.edges,
          viewport: document.viewport,
        } as const)
      : canonicalCanvasContent(document.canonical);
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

function canonicalCanvasContent(canonical: NonNullable<CanvasDocument['canonical']>): unknown {
  const canvas = withoutKeys(canonical, ['createdAt', 'updatedAt']);
  return {
    ...canvas,
    nodes: canonical.nodes.map((node) => withoutKeys(node, ['createdAt', 'updatedAt'])),
    edges: canonical.edges.map((edge) => withoutKeys(edge, ['createdAt'])),
  };
}

function withoutKeys(value: object, keys: readonly string[]): Record<string, unknown> {
  const excluded = new Set(keys);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !excluded.has(key)));
}

export function sanitizeCanvasDocument(value: unknown): CanvasDocument {
  const parsed = sanitizeCanvasExtensionData(CanvasDocumentSchema.parse(value));
  const synchronized = synchronizeCanvasDocument(parsed);
  if (!synchronized.ok) throw canvasMigrationError(synchronized.issues);
  const sanitizedSurface = sanitizeCanvasExtensionData(
    CanvasDocumentSchema.parse(synchronized.document),
  );
  const migrated = canonicalCanvasFromLegacy({
    ...sanitizedSurface,
    canonical: synchronized.document.canonical,
  });
  if (!migrated.ok) throw canvasMigrationError(migrated.issues);
  return CanvasDocumentSchema.parse({
    ...legacySurfaceFromCanonical(migrated.canvas),
    schemaVersion: 2,
    canonical: migrated.canvas,
  });
}

function canvasMigrationError(issues: readonly { entityId: string; message: string }[]): Error {
  const detail = issues.map((issue) => `${issue.entityId}: ${issue.message}`).join('; ');
  return new Error(`Canvas data could not be migrated safely. ${detail}`);
}

export function sanitizeCanvasSnapshot(value: unknown): CanvasSnapshot {
  const parsed = CanvasSnapshotSchema.parse(value);
  const document = sanitizeCanvasDocument(parsed.document);
  return CanvasSnapshotSchema.parse({
    ...parsed,
    document,
    contentHash: isDeepStrictEqual(parsed.document, document)
      ? parsed.contentHash
      : canvasContentHash(document),
  });
}

export function sanitizeReadableCanvasSnapshot(value: unknown): CanvasSnapshot {
  const snapshot = sanitizeCanvasSnapshot(value);
  if (snapshot.contentHash !== canvasContentHash(snapshot.document)) {
    throw new Error(`Snapshot ${snapshot.id} has an invalid content hash.`);
  }
  return snapshot;
}

export function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

export function safeParseJson(value: string): unknown {
  try {
    return parseJson(value);
  } catch {
    return undefined;
  }
}

export function parseTrustedExtensionLedgerRow(
  row: TrustedExtensionLedgerRow,
): TrustedExtensionLedgerRecord {
  const parsed = TrustedExtensionLedgerRecordSchema.parse(parseJson(row.value_json));
  if (!trustedExtensionLedgerMirrorsMatch(parsed, row)) {
    throw new Error('Trusted extension ledger columns do not match their authoritative record.');
  }
  return parsed;
}

export function trustedExtensionLedgerMirrorsMatch(
  record: TrustedExtensionLedgerRecord,
  row: TrustedExtensionLedgerRow,
): boolean {
  return (
    record.extensionId === row.extension_id &&
    record.schemaVersion === row.schema_version &&
    record.extensionVersion === row.extension_version &&
    record.manifestDigest === row.manifest_digest &&
    record.snapshotDigest === row.snapshot_digest &&
    JSON.stringify(record.permissions) === row.permissions_json &&
    record.approvedAt === row.approved_at &&
    record.state === row.state &&
    record.operationId === row.operation_id &&
    record.updatedAt === row.updated_at
  );
}

export function subtractDays(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'invalid JSON';
}

export function scrubCanvasTranscripts(
  document: CanvasDocument,
  cutoff: string,
): { document: CanvasDocument; count: number } {
  const cutoffMs = Date.parse(cutoff);
  let count = 0;
  const nodes = document.nodes.map((node) => {
    const transcript = node.data.transcript;
    if (typeof transcript !== 'string' || transcript === '') return node;
    const timestamp = node.data.transcriptUpdatedAt;
    const parsedTimestamp = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN;
    const effectiveTimestamp = Number.isFinite(parsedTimestamp)
      ? parsedTimestamp
      : Date.parse(document.updatedAt);
    if (effectiveTimestamp >= cutoffMs) return node;
    const data = { ...node.data };
    delete data.transcript;
    delete data.transcriptUpdatedAt;
    count += 1;
    return { ...node, data };
  });
  const scrubbedNodeIds = new Set(
    document.nodes.filter((node, index) => node !== nodes[index]).map((node) => node.id),
  );
  const canonical =
    document.canonical === undefined
      ? undefined
      : {
          ...document.canonical,
          nodes: document.canonical.nodes.map((node) => {
            if (!scrubbedNodeIds.has(node.id)) return node;
            const legacyData = node.inspector['legacyData'];
            if (!isRecord(legacyData)) return node;
            const scrubbedLegacyData = { ...legacyData };
            delete scrubbedLegacyData['transcript'];
            delete scrubbedLegacyData['transcriptUpdatedAt'];
            return {
              ...node,
              inspector: { ...node.inspector, legacyData: scrubbedLegacyData },
            };
          }),
        };
  return count === 0
    ? { document, count }
    : {
        document: CanvasDocumentSchema.parse({
          ...document,
          nodes,
          ...(canonical === undefined ? {} : { canonical }),
        }),
        count,
      };
}
