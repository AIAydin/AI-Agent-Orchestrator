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
      `Action: ${displayEscapedText(disclosure.title)}`,
      `Connection: ${displayEscapedText(disclosure.destination.transport)}`,
      `Address: ${displayEscapedText(disclosure.destination.endpoint)}`,
      `Item: ${displayEscapedText(disclosure.destination.resource)}`,
      ...disclosure.details.map(
        (detail) => `${displayEscapedText(detail.label)}: ${displayEscapedText(detail.value)}`,
      ),
      '',
      displayEscapedText(disclosure.warning),
      '',
      `You can use this approval only once, and it expires at ${plan.expiresAt}. If the action or destination changes, Forgeboard blocks it.`,
    ].join('\n'),
    buttons: ['Cancel', displayEscapedText(disclosure.confirmLabel)],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}
