import { describe, expect, it } from 'vitest';

import { AuditEventSchema, AuditListInputSchema } from './contracts.js';

describe('audit IPC contracts', () => {
  it('accepts only a strict bounded audit list request', () => {
    expect(AuditListInputSchema.parse({ limit: 100 })).toEqual({ limit: 100 });
    expect(AuditListInputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(AuditListInputSchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(AuditListInputSchema.safeParse({ limit: 1.5 }).success).toBe(false);
    expect(AuditListInputSchema.safeParse({ limit: 10, extra: true }).success).toBe(false);
  });

  it('does not permit audit metadata across the renderer boundary', () => {
    const event = {
      sequence: 1,
      occurredAt: '2026-07-14T16:00:00.000Z',
      category: 'agent',
      action: 'launch',
      outcome: 'allowed',
    };
    expect(AuditEventSchema.parse(event)).toEqual(event);
    expect(
      AuditEventSchema.safeParse({ ...event, metadata: { token: 'must-not-cross' } }).success,
    ).toBe(false);
  });
});
