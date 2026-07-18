import type { Dialog } from 'electron';

type StartupDialog = Pick<Dialog, 'showMessageBox' | 'showOpenDialog'>;

/** Packaged smoke must fail instead of waiting for native recovery interaction. */
export function createNonInteractiveSmokeStartupDialog(): StartupDialog {
  const reject = (): Promise<never> =>
    Promise.reject(
      new Error('Packaged smoke cannot continue because startup recovery requires interaction.'),
    );
  return {
    showMessageBox: reject,
    showOpenDialog: reject,
  } as unknown as StartupDialog;
}
