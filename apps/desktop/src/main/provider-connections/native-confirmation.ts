import type { BrowserWindow, Dialog, MessageBoxOptions } from 'electron';

import type { ProviderConnectionNativeReview } from './service.js';

export async function confirmProviderConnection(
  dialog: Pick<Dialog, 'showMessageBox'>,
  parent: BrowserWindow,
  review: ProviderConnectionNativeReview,
  assertCurrent: () => void,
): Promise<'approved' | 'denied'> {
  assertCurrent();
  const result = await dialog.showMessageBox(parent, providerConnectionConfirmation(review));
  assertCurrent();
  return result.response === 1 ? 'approved' : 'denied';
}

export function providerConnectionConfirmation(
  review: ProviderConnectionNativeReview,
): MessageBoxOptions {
  const actionLabel =
    review.view.action === 'connect'
      ? 'Connect'
      : review.view.action === 'disconnect'
        ? 'Disconnect'
        : 'Refresh status';
  return {
    type: 'warning',
    title: `${actionLabel} ${review.providerName}`,
    message: `${actionLabel} using ${review.providerName}'s official CLI flow?`,
    detail: [
      `Executable: ${review.executable}`,
      `SHA-256: ${review.executableSha256}`,
      `Validation arguments: ${review.validationArguments.map((args) => JSON.stringify(args)).join(' then ')}`,
      `Action arguments: ${JSON.stringify(review.commandArguments)}`,
      `Follow-up status arguments: ${review.followUpArguments === null ? 'none' : JSON.stringify(review.followUpArguments)}`,
      `Working directory: ${review.cwd}`,
      `Environment variable names: ${JSON.stringify(review.environmentVariableNames)}`,
      `Provider: ${review.providerName}`,
      `Network disclosure: ${review.providerDisclosure}`,
      '',
      'Artemis launches the installed provider CLI locally. The CLI owns browser sign-in, credentials, and logout. Artemis does not receive or store OAuth tokens, but the executable may perform arbitrary local or network effects.',
    ].join('\n'),
    buttons: ['Cancel', actionLabel],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}
