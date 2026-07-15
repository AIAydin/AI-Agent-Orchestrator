import { describe, expect, it, vi } from 'vitest';

import { SANITIZED_INTEGRITY_MESSAGES } from '../../shared/integrity/contracts.js';
import { IntegrityService } from './service.js';

const CHECKED_AT = '2026-07-15T18:00:00.000Z';

describe('IntegrityService', () => {
  it('runs the requested store check and returns strict passing evidence', () => {
    const checkIntegrity = vi.fn(() => ({
      ok: true,
      checkedAt: CHECKED_AT,
      mode: 'quick' as const,
      messages: [],
    }));
    const service = new IntegrityService({ checkIntegrity });

    expect(service.check({ mode: 'quick' })).toEqual({
      schemaVersion: 1,
      ok: true,
      checkedAt: CHECKED_AT,
      mode: 'quick',
      messages: [],
    });
    expect(checkIntegrity).toHaveBeenCalledWith('quick');
  });

  it('maps raw diagnostics to a bounded non-sensitive vocabulary', () => {
    const service = new IntegrityService({
      checkIntegrity: () => ({
        ok: false,
        checkedAt: CHECKED_AT,
        mode: 'full',
        messages: [
          'audit_events row 7: bad hash at /Users/private/repository',
          'recent_projects row 1: /Users/private/repository failed validation',
          'SQLite: page 99 is corrupt near secret-value',
        ],
      }),
    });

    const result = service.check({ mode: 'full' });

    expect(result).toMatchObject({
      ok: false,
      mode: 'full',
      messages: [
        SANITIZED_INTEGRITY_MESSAGES.audit,
        SANITIZED_INTEGRITY_MESSAGES.structural,
        SANITIZED_INTEGRITY_MESSAGES.sqlite,
      ],
    });
    expect(JSON.stringify(result)).not.toContain('/Users/private');
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });

  it('rejects invalid requests before reading storage', () => {
    const checkIntegrity = vi.fn();
    const service = new IntegrityService({ checkIntegrity });

    expect(() => service.check({ mode: 'quick', databasePath: '/tmp/private.sqlite' })).toThrow();
    expect(checkIntegrity).not.toHaveBeenCalled();
  });

  it('fails closed when the store returns contradictory evidence', () => {
    const service = new IntegrityService({
      checkIntegrity: () => ({
        ok: true,
        checkedAt: CHECKED_AT,
        mode: 'quick',
        messages: ['workflow_executions row 4 is invalid'],
      }),
    });

    expect(service.check({ mode: 'quick' })).toMatchObject({
      ok: false,
      messages: [SANITIZED_INTEGRITY_MESSAGES.workflow],
    });
  });

  it('contains unexpected store errors behind a sanitized result', () => {
    const service = new IntegrityService(
      {
        checkIntegrity: () => {
          throw new Error('Cannot open /Users/private/forgeboard.sqlite3');
        },
      },
      () => new Date(CHECKED_AT),
    );

    const result = service.check({ mode: 'full' });

    expect(result).toEqual({
      schemaVersion: 1,
      mode: 'full',
      checkedAt: CHECKED_AT,
      ok: false,
      messages: [SANITIZED_INTEGRITY_MESSAGES.incomplete],
    });
    expect(JSON.stringify(result)).not.toContain('/Users/private');
  });
});
