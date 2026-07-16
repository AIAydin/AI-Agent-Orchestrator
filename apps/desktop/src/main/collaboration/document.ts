import type * as Y from 'yjs';

import {
  CollaborationMetadataSnapshotSchema,
  deserializeCollaborationMetadataSnapshot,
  serializeCollaborationMetadataSnapshot,
  type CollaborationMetadataSnapshot,
} from '../../shared/collaboration/index.js';

const COLLABORATION_ROOTS = [
  'canvas',
  'nodes',
  'edges',
  'groups',
  'tasks',
  'comments',
  'workflow',
  'reviews',
] as const;

export const COLLABORATION_LOCAL_METADATA_ORIGIN = Symbol('forgeboard-local-metadata');

export function replaceCollaborationDocument(
  document: Y.Doc,
  input: CollaborationMetadataSnapshot,
  origin: unknown = COLLABORATION_LOCAL_METADATA_ORIGIN,
): CollaborationMetadataSnapshot {
  const snapshot = deserializeCollaborationMetadataSnapshot(
    serializeCollaborationMetadataSnapshot(input),
  );
  document.transact(() => {
    replaceMap(document.getMap('canvas'), snapshot.canvas);
    replaceMap(document.getMap('nodes'), snapshot.nodes);
    replaceMap(document.getMap('edges'), snapshot.edges);
    replaceMap(document.getMap('groups'), snapshot.groups);
    replaceMap(document.getMap('tasks'), snapshot.tasks);
    replaceMap(document.getMap('comments'), snapshot.comments);
    replaceMap(document.getMap('workflow'), snapshot.workflow);
    replaceMap(document.getMap('reviews'), snapshot.reviews);
  }, origin);
  return snapshot;
}

export function collaborationSnapshotFromDocument(document: Y.Doc): CollaborationMetadataSnapshot {
  materializeSharedMaps(document);
  return CollaborationMetadataSnapshotSchema.parse(document.toJSON());
}

export function hasCompleteCollaborationSnapshot(document: Y.Doc): boolean {
  try {
    collaborationSnapshotFromDocument(document);
    return true;
  } catch {
    return false;
  }
}

function replaceMap(map: Y.Map<unknown>, values: Readonly<Record<string, unknown>>): void {
  map.clear();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) map.set(key, structuredClone(value));
  }
}

function materializeSharedMaps(document: Y.Doc): void {
  for (const root of COLLABORATION_ROOTS) document.getMap(root);
  for (const root of document.share.keys()) document.getMap(root);
}
