import type { ElectronApplication } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';

import {
  approveNextNativePreviewLaunch,
  type NativePreviewConfirmationBinding,
} from './preview-confirmation.js';

describe('native preview confirmation E2E harness', () => {
  it.each(['start', 'restart'] as const)(
    'approves the exact %s disclosure once and restores the original descriptor',
    async (action) => {
      const fixture = harnessFixture();
      const originalDescriptor = Object.getOwnPropertyDescriptor(fixture.dialog, 'showMessageBox');
      const binding = previewBinding(action);
      let response = -1;

      await approveNextNativePreviewLaunch(fixture.app, binding, async () => {
        response = (await fixture.dialog.showMessageBox(nativeOptions(binding))).response;
      });

      expect(response).toBe(1);
      expect(Object.getOwnPropertyDescriptor(fixture.dialog, 'showMessageBox')).toEqual(
        originalDescriptor,
      );
      expectHarnessStateDeleted();
      await fixture.dialog.showMessageBox({ title: 'Later dialog' });
      expect(fixture.original).toHaveBeenCalledTimes(1);
    },
  );

  it('cancels a prompt whose renderer-bindable command differs and restores the dialog', async () => {
    const fixture = harnessFixture();
    const binding = previewBinding('start');
    let response = -1;

    await expect(
      approveNextNativePreviewLaunch(fixture.app, binding, async () => {
        response = (
          await fixture.dialog.showMessageBox(
            nativeOptions({ ...binding, arguments: ['unreviewed-server.mjs'] }),
          )
        ).response;
      }),
    ).rejects.toThrow('reviewed preview');

    expect(response).toBe(0);
    expect(Object.getOwnPropertyDescriptor(fixture.dialog, 'showMessageBox')?.value).toBe(
      fixture.original,
    );
    expectHarnessStateDeleted();
  });

  it('cancels and rejects a prompt whose executable digest differs from the actual bytes', async () => {
    const fixture = harnessFixture();
    const binding = previewBinding('start');
    let response = -1;

    await expect(
      approveNextNativePreviewLaunch(fixture.app, binding, async () => {
        response = (
          await fixture.dialog.showMessageBox(
            nativeOptions({ ...binding, executableSha256: 'b'.repeat(64) }),
          )
        ).response;
      }),
    ).rejects.toThrow('detail line 5');

    expect(response).toBe(0);
    expect(Object.getOwnPropertyDescriptor(fixture.dialog, 'showMessageBox')?.value).toBe(
      fixture.original,
    );
    expectHarnessStateDeleted();
  });

  it('restores the original descriptor when the renderer action fails before the prompt', async () => {
    const fixture = harnessFixture();
    const failure = new Error('renderer action failed');

    await expect(
      approveNextNativePreviewLaunch(fixture.app, previewBinding('start'), () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(Object.getOwnPropertyDescriptor(fixture.dialog, 'showMessageBox')?.value).toBe(
      fixture.original,
    );
    expectHarnessStateDeleted();
  });

  it('restores the original descriptor after a no-prompt timeout', async () => {
    const fixture = harnessFixture();

    await expect(
      approveNextNativePreviewLaunch(
        fixture.app,
        previewBinding('start'),
        () => Promise.resolve(),
        { pollTimeoutMs: 20 },
      ),
    ).rejects.toThrow();

    expect(Object.getOwnPropertyDescriptor(fixture.dialog, 'showMessageBox')?.value).toBe(
      fixture.original,
    );
    expectHarnessStateDeleted();
  });

  it('deletes its token state when native interceptor installation fails', async () => {
    const installationFailure = new Error('native interceptor installation failed');
    const fixture = harnessFixture({ installationFailure });
    const launchAction = vi.fn(() => Promise.resolve());

    await expect(
      approveNextNativePreviewLaunch(fixture.app, previewBinding('start'), launchAction),
    ).rejects.toBe(installationFailure);

    expect(launchAction).not.toHaveBeenCalled();
    expect(Object.getOwnPropertyDescriptor(fixture.dialog, 'showMessageBox')?.value).toBe(
      fixture.original,
    );
    expectHarnessStateDeleted();
  });

  it('restores after a failed action without overwriting a later dialog owner', async () => {
    const fixture = harnessFixture();
    const later = vi.fn(() => Promise.resolve({ response: 7, checkboxChecked: false }));

    await expect(
      approveNextNativePreviewLaunch(fixture.app, previewBinding('start'), () => {
        Object.defineProperty(fixture.dialog, 'showMessageBox', {
          configurable: true,
          value: later,
        });
        throw new Error('later owner replaced the dialog');
      }),
    ).rejects.toThrow('later owner replaced the dialog');

    expect(Object.getOwnPropertyDescriptor(fixture.dialog, 'showMessageBox')?.value).toBe(later);
    expectHarnessStateDeleted();
  });
});

interface DialogResult {
  checkboxChecked: boolean;
  response: number;
}

interface FakeDialog {
  showMessageBox(options: unknown): Promise<DialogResult>;
}

function harnessFixture(options: { installationFailure?: Error } = {}): {
  app: ElectronApplication;
  dialog: FakeDialog;
  original: ReturnType<typeof vi.fn<() => Promise<DialogResult>>>;
} {
  const original = vi.fn(() => Promise.resolve({ response: 0, checkboxChecked: false }));
  const dialogTarget = {} as FakeDialog;
  Object.defineProperty(dialogTarget, 'showMessageBox', {
    configurable: true,
    enumerable: true,
    value: original,
    writable: false,
  });
  const installationFailure = options.installationFailure;
  const dialog =
    installationFailure === undefined
      ? dialogTarget
      : new Proxy(dialogTarget, {
          defineProperty: (target, property, descriptor) => {
            if (property === 'showMessageBox' && descriptor.value !== original) {
              Reflect.defineProperty(target, property, descriptor);
              throw installationFailure;
            }
            return Reflect.defineProperty(target, property, descriptor);
          },
        });
  const app = {
    evaluate: async (callback: unknown, argument?: unknown) =>
      await (callback as (electron: { dialog: FakeDialog }, value?: unknown) => unknown)(
        { dialog },
        argument,
      ),
  } as unknown as ElectronApplication;
  return { app, dialog, original };
}

function previewBinding(
  action: NativePreviewConfirmationBinding['action'],
): NativePreviewConfirmationBinding {
  return {
    action,
    projectRoot: '/tmp/forgeboard-demo',
    cwd: '/tmp/forgeboard-demo',
    source: 'Literal preview command configured on this canvas node in the UI',
    executable: '/usr/bin/node',
    executableSha256: 'a'.repeat(64),
    arguments: ['/tmp/preview-server.mjs'],
    portRange: { start: 44_000, end: 44_050 },
    trustedHosts: ['127.0.0.1', 'localhost'],
  };
}

function nativeOptions(binding: NativePreviewConfirmationBinding): Record<string, unknown> {
  const restart = binding.action === 'restart';
  return {
    type: 'warning',
    title: restart ? 'Restart development preview?' : 'Start development preview?',
    message: restart
      ? 'Stop the current preview and start this reviewed replacement?'
      : 'Start this reviewed development preview?',
    detail: [
      `Project: ${binding.projectRoot}`,
      `Working directory: ${binding.cwd}`,
      `Source: ${binding.source}`,
      `Executable: ${binding.executable}`,
      `Executable SHA-256: ${binding.executableSha256}`,
      `Arguments: ${JSON.stringify(binding.arguments)}`,
      `Loopback port range: ${String(binding.portRange.start)}-${String(binding.portRange.end)}`,
      `Trusted loopback hosts: ${binding.trustedHosts.join(', ')}`,
      '',
      'Forgeboard will start this local process without a shell. The process itself can still access resources allowed by your operating system.',
    ].join('\n'),
    buttons: ['Cancel', restart ? 'Restart preview' : 'Start preview'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

function expectHarnessStateDeleted(): void {
  const state = globalThis as typeof globalThis & {
    __forgeboardE2ePreviewDialogs?: Map<string, unknown>;
  };
  expect(state.__forgeboardE2ePreviewDialogs).toBeUndefined();
}
