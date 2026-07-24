import type { ElectronApplication, Locator } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';

import { approveNextNativeAgentLaunch, closeElectronAfterTest } from './electron.js';

const FINGERPRINT = 'a'.repeat(64);
const EXPIRES_AT = '2099-07-15T00:05:00.000Z';

describe('Electron E2E cleanup', () => {
  it('uses Playwright process-group cleanup without starting a graceful close', async () => {
    const killForTests = vi.fn(() => Promise.resolve());
    const close = vi.fn(() => Promise.resolve());
    const app = {
      _toImpl: () => ({
        _browserContext: {
          _browser: { killForTests },
        },
      }),
      close,
    } as unknown as ElectronApplication;

    await closeElectronAfterTest(app);

    expect(killForTests).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });
});

describe('native agent launch E2E harness', () => {
  it('approves the exact reviewed binding and restores the complete original descriptor', async () => {
    const fixture = harnessFixture();
    const originalDescriptor = Object.getOwnPropertyDescriptor(fixture.dialog, 'showMessageBox');

    let response = -1;
    await approveNextNativeAgentLaunch(fixture.app, reviewDialog(), 'codex', async () => {
      response = (await fixture.dialog.showMessageBox(nativeOptions())).response;
    });

    expect(response).toBe(1);
    expect(Object.getOwnPropertyDescriptor(fixture.dialog, 'showMessageBox')).toEqual(
      originalDescriptor,
    );
    await fixture.dialog.showMessageBox({ title: 'Later dialog' });
    expect(fixture.original).toHaveBeenCalledTimes(1);
  });

  it('cancels and rejects a native prompt whose fingerprint differs from the renderer review', async () => {
    const fixture = harnessFixture();
    let response = -1;

    await expect(
      approveNextNativeAgentLaunch(fixture.app, reviewDialog(), 'codex', async () => {
        response = (
          await fixture.dialog.showMessageBox(
            nativeOptions({ fingerprint: `b${FINGERPRINT.slice(1)}` }),
          )
        ).response;
      }),
    ).rejects.toThrow('exact reviewed disclosure fingerprint');

    expect(response).toBe(0);
    expect(Object.getOwnPropertyDescriptor(fixture.dialog, 'showMessageBox')?.value).toBe(
      fixture.original,
    );
  });

  it('restores the original descriptor when the renderer action rejects before a dialog opens', async () => {
    const fixture = harnessFixture();
    const failure = new Error('renderer action failed');

    await expect(
      approveNextNativeAgentLaunch(fixture.app, reviewDialog(), 'codex', () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(Object.getOwnPropertyDescriptor(fixture.dialog, 'showMessageBox')?.value).toBe(
      fixture.original,
    );
  });

  it('restores after a no-dialog timeout', async () => {
    const fixture = harnessFixture();

    await expect(
      approveNextNativeAgentLaunch(fixture.app, reviewDialog(), 'codex', () => Promise.resolve(), {
        pollTimeoutMs: 20,
      }),
    ).rejects.toThrow();

    expect(Object.getOwnPropertyDescriptor(fixture.dialog, 'showMessageBox')?.value).toBe(
      fixture.original,
    );
  });

  it('does not overwrite a later dialog replacement while cleaning up a failed action', async () => {
    const fixture = harnessFixture();
    const later = vi.fn(() => Promise.resolve({ response: 7, checkboxChecked: false }));

    await expect(
      approveNextNativeAgentLaunch(fixture.app, reviewDialog(), 'codex', () => {
        Object.defineProperty(fixture.dialog, 'showMessageBox', {
          configurable: true,
          enumerable: false,
          value: later,
          writable: false,
        });
        throw new Error('later owner replaced the dialog');
      }),
    ).rejects.toThrow('later owner replaced the dialog');

    expect(Object.getOwnPropertyDescriptor(fixture.dialog, 'showMessageBox')?.value).toBe(later);
  });
});

interface DialogResult {
  checkboxChecked: boolean;
  response: number;
}

interface FakeDialog {
  showMessageBox(options: unknown): Promise<DialogResult>;
}

function harnessFixture(): {
  app: ElectronApplication;
  dialog: FakeDialog;
  original: ReturnType<typeof vi.fn<() => Promise<DialogResult>>>;
} {
  const original = vi.fn(() => Promise.resolve({ response: 0, checkboxChecked: false }));
  const dialog = {} as FakeDialog;
  Object.defineProperty(dialog, 'showMessageBox', {
    configurable: true,
    enumerable: true,
    value: original,
    writable: false,
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

function reviewDialog(): Locator {
  return {
    getByLabel: (label: string) => {
      if (label === 'Security fingerprint (SHA-256)') {
        return { textContent: () => Promise.resolve(FINGERPRINT) };
      }
      if (label === 'Approval expires at') {
        return { getAttribute: () => Promise.resolve(EXPIRES_AT) };
      }
      throw new Error(`Unexpected review label: ${label}`);
    },
  } as unknown as Locator;
}

function nativeOptions(
  overrides: { expiresAt?: string; fingerprint?: string } = {},
): Record<string, unknown> {
  return {
    type: 'warning',
    title: 'Launch agent',
    message: 'Launch codex for this node?',
    detail: [
      `Security fingerprint (SHA-256): ${overrides.fingerprint ?? FINGERPRINT}`,
      `Approval expires at: ${overrides.expiresAt ?? EXPIRES_AT}`,
    ].join('\n'),
    buttons: ['Cancel', 'Launch agent'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}
