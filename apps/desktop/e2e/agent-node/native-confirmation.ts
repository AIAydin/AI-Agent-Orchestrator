import { expect, type ElectronApplication, type Locator } from '@playwright/test';

import { EXTENSION_ID } from './fixture.js';

export async function choosePath(app: ElectronApplication, selectedPath: string): Promise<void> {
  await app.evaluate(({ dialog }, path) => {
    Object.defineProperty(dialog, 'showOpenDialog', {
      configurable: true,
      value: () => Promise.resolve({ canceled: false, filePaths: [path] }),
    });
  }, selectedPath);
}

export async function approveExtensionInstall(
  app: ElectronApplication,
  review: Locator,
): Promise<void> {
  const token = `${EXTENSION_ID}:${Date.now().toString(36)}`;
  await app.evaluate(
    ({ BrowserWindow, dialog }, binding) => {
      const state = globalThis as typeof globalThis & {
        __forgeboardExtensionApproval?: { error?: string; status: string };
      };
      const original = Object.getOwnPropertyDescriptor(dialog, 'showMessageBox');
      const interceptor = (...arguments_: unknown[]) => {
        const options = arguments_.at(-1) as Record<string, unknown>;
        const owner = arguments_[0] as { id?: number } | undefined;
        const errors = [
          options.type === 'warning' ? undefined : 'type',
          options.title === 'Install extension' ? undefined : 'title',
          options.message === `Install ${binding.extensionId} 1.0.0?` ? undefined : 'message',
          JSON.stringify(options.buttons) === JSON.stringify(['Cancel', 'Install'])
            ? undefined
            : 'buttons',
          options.defaultId === 0 ? undefined : 'default',
          options.cancelId === 0 ? undefined : 'cancel',
          options.noLink === true ? undefined : 'links',
          typeof options.detail === 'string' &&
          options.detail.includes('Manifest fingerprint (SHA-256):')
            ? undefined
            : 'manifest digest',
          typeof options.detail === 'string' &&
          options.detail.includes('Full package fingerprint (SHA-256):')
            ? undefined
            : 'snapshot digest',
          BrowserWindow.getAllWindows().some((window) => window.id === owner?.id)
            ? undefined
            : 'owner',
        ].filter((error): error is string => error !== undefined);
        state.__forgeboardExtensionApproval = {
          status: errors.length === 0 ? 'approved' : 'rejected',
          ...(errors.length === 0 ? {} : { error: errors.join(', ') }),
        };
        if (original === undefined) Reflect.deleteProperty(dialog, 'showMessageBox');
        else Object.defineProperty(dialog, 'showMessageBox', original);
        return Promise.resolve({ response: errors.length === 0 ? 1 : 0, checkboxChecked: false });
      };
      state.__forgeboardExtensionApproval = { status: `armed:${binding.token}` };
      Object.defineProperty(dialog, 'showMessageBox', { configurable: true, value: interceptor });
    },
    { extensionId: EXTENSION_ID, token },
  );

  await review
    .getByRole('checkbox', { name: 'I reviewed these exact details and permissions' })
    .check();
  await review.getByRole('button', { name: 'Continue to confirmation' }).click();
  await expect
    .poll(async () => {
      return await app.evaluate(() => {
        const state = globalThis as typeof globalThis & {
          __forgeboardExtensionApproval?: { error?: string; status: string };
        };
        return state.__forgeboardExtensionApproval;
      });
    })
    .toMatchObject({ status: 'approved' });
}
