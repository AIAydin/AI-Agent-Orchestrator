import { z } from 'zod';

import { CollaborationManagementCursorSchema } from '@forgeboard/core/collaboration-management';

const InviteCursorValueSchema = z
  .object({ createdAt: z.string().datetime({ offset: true }), id: z.string().uuid() })
  .strict();
export type InviteCursorValue = z.infer<typeof InviteCursorValueSchema>;

export function encodeInviteCursor(value: InviteCursorValue): string {
  return CollaborationManagementCursorSchema.parse(
    Buffer.from(JSON.stringify(InviteCursorValueSchema.parse(value))).toString('base64url'),
  );
}

export function decodeInviteCursor(value: string | undefined): InviteCursorValue | undefined {
  if (value === undefined) return undefined;
  const cursor = CollaborationManagementCursorSchema.parse(value);
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== cursor) throw new Error('invalid');
    return InviteCursorValueSchema.parse(JSON.parse(decoded) as unknown);
  } catch {
    throw new Error('The collaboration invite cursor is invalid.');
  }
}
