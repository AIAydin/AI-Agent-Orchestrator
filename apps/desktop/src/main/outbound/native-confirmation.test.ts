import { describe, expect, it, vi } from 'vitest';

import { createNativeOutboundConfirmation, outboundMessageBox } from './native-confirmation.js';
import type { OutboundApprovalPlan } from './outbound-action-gate.js';

const plan: OutboundApprovalPlan = {
  id: '10000000-0000-4000-8000-000000000001',
  expiresAt: '2026-07-15T16:05:00.000Z',
  disclosureSha256: 'a'.repeat(64),
  disclosure: {
    action: 'git-clone',
    title: 'Clone Git repository',
    summary: 'Allow Git to clone /owner/repository.git?',
    confirmLabel: 'Clone repository',
    destination: {
      kind: 'git-remote',
      endpoint: 'github.com',
      resource: '/owner/repository.git',
      transport: 'HTTPS',
    },
    details: [{ label: 'Local destination', value: '/tmp/project\nshown-literally' }],
    warning: 'Git may contact the exact remote.',
  },
};

describe('native outbound confirmation', () => {
  it('renders exact action/destination values with cancel as the safe default', () => {
    const options = outboundMessageBox(plan);
    expect(options).toMatchObject({
      buttons: ['Cancel', 'Clone repository'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    expect(options.detail).toContain('Endpoint: github.com');
    expect(options.detail).toContain('/tmp/project\\nshown-literally');
  });

  it('revalidates the native owner before and after the dialog', async () => {
    const order: string[] = [];
    const confirmation = createNativeOutboundConfirmation({
      assertCurrent: () => order.push('owner'),
      show: vi.fn(() => {
        order.push('dialog');
        return Promise.resolve(1);
      }),
    });

    await expect(confirmation.confirm(plan)).resolves.toBe('approved');
    expect(order).toEqual(['owner', 'dialog', 'owner']);
  });
});
