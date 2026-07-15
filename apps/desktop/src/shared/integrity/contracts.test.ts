import { describe, expect, it } from 'vitest';

import {
  IntegrityCheckInputSchema,
  IntegrityCheckResultSchema,
  SANITIZED_INTEGRITY_MESSAGES,
} from './contracts.js';

describe('integrity IPC contracts', () => {
  it('accepts only an explicit quick or full mode', () => {
    expect(IntegrityCheckInputSchema.parse({ mode: 'quick' })).toEqual({ mode: 'quick' });
    expect(IntegrityCheckInputSchema.parse({ mode: 'full' })).toEqual({ mode: 'full' });
    expect(IntegrityCheckInputSchema.safeParse({ mode: 'deep' }).success).toBe(false);
    expect(IntegrityCheckInputSchema.safeParse({ mode: 'quick', path: '/tmp/data' }).success).toBe(
      false,
    );
  });

  it('requires pass and failure evidence to agree', () => {
    const base = {
      schemaVersion: 1 as const,
      mode: 'quick' as const,
      checkedAt: '2026-07-15T18:00:00.000Z',
    };
    expect(IntegrityCheckResultSchema.parse({ ...base, ok: true, messages: [] })).toMatchObject({
      ok: true,
    });
    expect(
      IntegrityCheckResultSchema.safeParse({
        ...base,
        ok: true,
        messages: [SANITIZED_INTEGRITY_MESSAGES.audit],
      }).success,
    ).toBe(false);
    expect(IntegrityCheckResultSchema.safeParse({ ...base, ok: false, messages: [] }).success).toBe(
      false,
    );
  });

  it('rejects raw or duplicated storage diagnostics', () => {
    const result = {
      schemaVersion: 1,
      mode: 'full',
      checkedAt: '2026-07-15T18:00:00.000Z',
      ok: false,
      messages: ['recent_projects row 1 at /Users/private/project'],
    };
    expect(IntegrityCheckResultSchema.safeParse(result).success).toBe(false);
    expect(
      IntegrityCheckResultSchema.safeParse({
        ...result,
        messages: [SANITIZED_INTEGRITY_MESSAGES.audit, SANITIZED_INTEGRITY_MESSAGES.audit],
      }).success,
    ).toBe(false);
  });
});
