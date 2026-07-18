import { describe, expect, it, vi } from 'vitest';

import { performAuditedLocalEffect } from './local-effect.js';

describe('performAuditedLocalEffect', () => {
  it('persists allowed authorization before the effect and revalidates afterward', async () => {
    const order: string[] = [];
    await expect(
      performAuditedLocalEffect({
        assertCurrent: () => order.push('assert'),
        auditAllowed: () => order.push('audit-allowed'),
        effect: () => {
          order.push('effect');
          return 'saved';
        },
        auditFailed: () => order.push('audit-failed'),
      }),
    ).resolves.toBe('saved');
    expect(order).toEqual(['assert', 'audit-allowed', 'effect', 'assert']);
  });

  it('does not start the effect when the required allowed audit fails', async () => {
    const effect = vi.fn();
    await expect(
      performAuditedLocalEffect({
        assertCurrent: vi.fn(),
        auditAllowed: () => {
          throw new Error('audit unavailable');
        },
        effect,
        auditFailed: vi.fn(),
      }),
    ).rejects.toThrow('audit unavailable');
    expect(effect).not.toHaveBeenCalled();
  });

  it('records a redacted failure attempt without masking the original effect error', async () => {
    const auditFailed = vi.fn(() => {
      throw new Error('failure audit unavailable');
    });
    await expect(
      performAuditedLocalEffect({
        assertCurrent: vi.fn(),
        auditAllowed: vi.fn(),
        effect: () => {
          throw new Error('write failed');
        },
        auditFailed,
      }),
    ).rejects.toThrow('write failed');
    expect(auditFailed).toHaveBeenCalledOnce();
  });
});
