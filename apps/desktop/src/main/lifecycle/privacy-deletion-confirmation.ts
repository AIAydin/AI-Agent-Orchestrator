import type { BrowserWindow, Dialog, MessageBoxOptions } from 'electron';

export async function confirmPrivacyDeletion(
  dialog: Pick<Dialog, 'showMessageBox'>,
  parent: BrowserWindow,
  recordDenial: () => void,
): Promise<boolean> {
  const decision = await dialog.showMessageBox(parent, privacyDeletionConfirmation());
  if (decision.response === 1) return true;
  recordDenial();
  return false;
}

export function privacyDeletionConfirmation(): MessageBoxOptions {
  return {
    type: 'warning',
    title: 'Delete all local Forgeboard data?',
    message: 'Permanently delete all local Forgeboard data from this computer?',
    detail: [
      'This deletes projects and canvases stored by Forgeboard, run and terminal history, settings, integration connections, approvals, audit history, recovery snapshots, and tracked backup records.',
      'Forgeboard will also delete tracked backup files it can reach. Missing or disconnected backup copies may still exist outside Forgeboard and require a separate warning before their records can be forgotten.',
      'Project source folders and Git repositories are not deleted. This action cannot be undone.',
    ].join('\n\n'),
    buttons: ['Cancel', 'Delete all local data'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}
