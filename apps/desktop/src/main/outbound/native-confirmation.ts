import type { MessageBoxOptions } from 'electron';

import type { OutboundApprovalPlan, OutboundConfirmationBoundary } from './outbound-action-gate.js';

export interface NativeMessageBoxBoundary {
  show(options: MessageBoxOptions): Promise<number>;
  /** Revalidates that the originating native window is still authorized. */
  assertCurrent?(): void;
}

export function createNativeOutboundConfirmation(
  native: NativeMessageBoxBoundary,
): OutboundConfirmationBoundary {
  return {
    async confirm(plan): Promise<'approved' | 'denied'> {
      native.assertCurrent?.();
      const response = await native.show(outboundMessageBox(plan));
      native.assertCurrent?.();
      return response === 1 ? 'approved' : 'denied';
    },
  };
}

export function outboundMessageBox(plan: OutboundApprovalPlan): MessageBoxOptions {
  const { disclosure } = plan;
  return {
    type: 'warning',
    title: disclosure.title,
    message: disclosure.summary,
    detail: [
      `Action: ${displayLiteral(disclosure.action)}`,
      `Transport: ${displayLiteral(disclosure.destination.transport)}`,
      `Endpoint: ${displayLiteral(disclosure.destination.endpoint)}`,
      `Resource: ${displayLiteral(disclosure.destination.resource)}`,
      ...disclosure.details.map(
        (detail) => `${displayLiteral(detail.label)}: ${displayLiteral(detail.value)}`,
      ),
      '',
      disclosure.warning,
      '',
      `This approval is single-use and expires at ${plan.expiresAt}. If the exact action or destination changes, Forgeboard refuses it.`,
    ].join('\n'),
    buttons: ['Cancel', disclosure.confirmLabel],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

function displayLiteral(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}
