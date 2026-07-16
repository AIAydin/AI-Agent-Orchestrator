import {
  CollaborationMetadataSnapshotSchema,
  type CollaborationMetadataSnapshot,
} from '../../../../../../shared/collaboration/index.js';

export type CollaborationThreeWayResult =
  | { readonly ok: true; readonly snapshot: CollaborationMetadataSnapshot }
  | { readonly ok: false };

/** Applies the local delta to the room only when the two sides did not change the same value. */
export function mergeCollaborationIntent(
  baseline: CollaborationMetadataSnapshot | null,
  pending: CollaborationMetadataSnapshot,
  remote: CollaborationMetadataSnapshot | null,
): CollaborationThreeWayResult {
  if (baseline === null) {
    if (remote === null || jsonValuesEqual(remote, pending)) {
      return { ok: true, snapshot: pending };
    }
    return { ok: false };
  }
  if (remote === null) return { ok: false };
  const merged = mergeValue(
    normalizedCanvasRevision(baseline, baseline),
    normalizedCanvasRevision(pending, baseline),
    normalizedCanvasRevision(remote, baseline),
  );
  if (!merged.ok) return { ok: false };
  if (!isJsonRecord(merged.value) || !isJsonRecord(merged.value.canvas)) return { ok: false };
  const parsed = CollaborationMetadataSnapshotSchema.safeParse({
    ...merged.value,
    canvas: {
      ...merged.value.canvas,
      version: Math.max(baseline.canvas.version, pending.canvas.version, remote.canvas.version),
      updatedAt: [baseline.canvas.updatedAt, pending.canvas.updatedAt, remote.canvas.updatedAt]
        .sort()
        .at(-1),
    },
  });
  return parsed.success ? { ok: true, snapshot: parsed.data } : { ok: false };
}

/**
 * Proves that the authenticated room contains every local intent since the baseline. Canvas
 * `version` and `updatedAt` are derived persistence metadata, so they cannot manufacture a conflict
 * or stand in for a real field-level edit.
 */
export function collaborationIntentSurvives(
  baseline: CollaborationMetadataSnapshot,
  local: CollaborationMetadataSnapshot,
  remote: CollaborationMetadataSnapshot,
): boolean {
  const result = mergeCollaborationIntent(baseline, local, remote);
  return result.ok && snapshotsEqualIgnoringCanvasRevision(result.snapshot, remote);
}

function normalizedCanvasRevision(
  snapshot: CollaborationMetadataSnapshot,
  baseline: CollaborationMetadataSnapshot,
): CollaborationMetadataSnapshot {
  const normalized = normalizeDerivedCanvasTimestamps(
    snapshot,
    snapshot.canvas.updatedAt,
    baseline.canvas.updatedAt,
  ) as CollaborationMetadataSnapshot;
  return {
    ...normalized,
    canvas: {
      ...normalized.canvas,
      version: baseline.canvas.version,
      updatedAt: baseline.canvas.updatedAt,
    },
  };
}

/** Legacy/canonical projection stamps an ordinary canvas save onto every projected entity. */
function normalizeDerivedCanvasTimestamps(
  value: unknown,
  canvasUpdatedAt: string,
  normalizedUpdatedAt: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) =>
      normalizeDerivedCanvasTimestamps(item, canvasUpdatedAt, normalizedUpdatedAt),
    );
  }
  if (!isJsonRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === 'updatedAt' && item === canvasUpdatedAt
        ? normalizedUpdatedAt
        : normalizeDerivedCanvasTimestamps(item, canvasUpdatedAt, normalizedUpdatedAt),
    ]),
  );
}

function snapshotsEqualIgnoringCanvasRevision(
  left: CollaborationMetadataSnapshot,
  right: CollaborationMetadataSnapshot,
): boolean {
  return jsonValuesEqual(
    normalizedCanvasRevision(left, right),
    normalizedCanvasRevision(right, right),
  );
}

type MergeResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

function mergeValue(baseline: unknown, local: unknown, remote: unknown): MergeResult {
  if (jsonValuesEqual(local, baseline)) return { ok: true, value: remote };
  if (jsonValuesEqual(remote, baseline) || jsonValuesEqual(remote, local)) {
    return { ok: true, value: local };
  }
  if (isJsonRecord(baseline) && isJsonRecord(local) && isJsonRecord(remote)) {
    const value: Record<string, unknown> = {};
    const keys = new Set([...Object.keys(baseline), ...Object.keys(local), ...Object.keys(remote)]);
    for (const key of keys) {
      const baseHas = Object.hasOwn(baseline, key);
      const localHas = Object.hasOwn(local, key);
      const remoteHas = Object.hasOwn(remote, key);
      const merged = mergeEntry(
        baseHas ? baseline[key] : MISSING,
        localHas ? local[key] : MISSING,
        remoteHas ? remote[key] : MISSING,
      );
      if (!merged.ok) return merged;
      if (merged.value !== MISSING) value[key] = merged.value;
    }
    return { ok: true, value };
  }
  return { ok: false };
}

const MISSING = Symbol('missing');

function mergeEntry(baseline: unknown, local: unknown, remote: unknown): MergeResult {
  if (valuesEqual(local, baseline)) return { ok: true, value: remote };
  if (valuesEqual(remote, baseline) || valuesEqual(remote, local)) {
    return { ok: true, value: local };
  }
  if (baseline === MISSING || local === MISSING || remote === MISSING) return { ok: false };
  return mergeValue(baseline, local, remote);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === MISSING || right === MISSING) return left === right;
  return jsonValuesEqual(left, right);
}

export function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (isJsonRecord(left) && isJsonRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => Object.hasOwn(right, key) && jsonValuesEqual(left[key], right[key]))
    );
  }
  return false;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
