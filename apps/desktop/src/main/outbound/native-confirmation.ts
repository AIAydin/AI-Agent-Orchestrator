import type { MessageBoxOptions } from 'electron';

import { displayEscapedText } from '../../shared/text/display-literal.js';
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
    title: displayEscapedText(disclosure.title),
    message: displayEscapedText(disclosure.summary),
    detail: [
      `Action: ${displayEscapedText(disclosure.action)}`,
      `Transport: ${displayEscapedText(disclosure.destination.transport)}`,
      `Endpoint: ${displayEscapedText(disclosure.destination.endpoint)}`,
      `Resource: ${displayEscapedText(disclosure.destination.resource)}`,
      ...disclosure.details.map(
        (detail) => `${displayEscapedText(detail.label)}: ${displayEscapedText(detail.value)}`,
      ),
      '',
      displayEscapedText(disclosure.warning),
      '',
      `This approval is single-use and expires at ${plan.expiresAt}. If the exact action or destination changes, Forgeboard refuses it.`,
    ].join('\n'),
    buttons: ['Cancel', displayEscapedText(disclosure.confirmLabel)],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}
