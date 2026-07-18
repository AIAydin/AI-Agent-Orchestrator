import { EntityIdSchema } from '@forgeboard/core/domain';
import { z } from 'zod';

import {
  CanonicalFilePathSchema,
  ProjectFileIdSchema,
} from '../../../../../shared/files/contracts.js';

export const WORKSPACE_CONTEXT_DRAG_MIME = 'application/x-forgeboard-context-file';
export const WORKSPACE_CONTEXT_DRAG_MAX_BYTES = 8_192;

export const WorkspaceContextDragPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('project-file'),
    projectId: ProjectFileIdSchema,
    relativePath: CanonicalFilePathSchema,
    sourceNodeId: EntityIdSchema.optional(),
  })
  .strict();

export type WorkspaceContextDragPayload = z.infer<typeof WorkspaceContextDragPayloadSchema>;

export function writeWorkspaceContextDrag(
  dataTransfer: DataTransfer,
  untrustedPayload: WorkspaceContextDragPayload,
): void {
  const payload = WorkspaceContextDragPayloadSchema.parse(untrustedPayload);
  const serialized = JSON.stringify(payload);
  if (new TextEncoder().encode(serialized).byteLength > WORKSPACE_CONTEXT_DRAG_MAX_BYTES) {
    throw new Error('The dragged file data is too large to attach.');
  }
  dataTransfer.setData(WORKSPACE_CONTEXT_DRAG_MIME, serialized);
  dataTransfer.effectAllowed = 'copy';
}

export function readWorkspaceContextDrag(
  dataTransfer: Pick<DataTransfer, 'getData'>,
): WorkspaceContextDragPayload | null {
  const serialized = dataTransfer.getData(WORKSPACE_CONTEXT_DRAG_MIME);
  if (
    serialized.length === 0 ||
    new TextEncoder().encode(serialized).byteLength > WORKSPACE_CONTEXT_DRAG_MAX_BYTES
  ) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(serialized);
    const payload = WorkspaceContextDragPayloadSchema.safeParse(parsed);
    return payload.success ? payload.data : null;
  } catch {
    return null;
  }
}

export function hasWorkspaceContextDrag(dataTransfer: Pick<DataTransfer, 'types'>): boolean {
  return Array.from(dataTransfer.types).includes(WORKSPACE_CONTEXT_DRAG_MIME);
}
