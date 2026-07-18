import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';

export interface ElectronSession {
  app: ElectronApplication;
  page: Page;
}

export interface LaunchDesktopOptions {
  readonly entry?: string;
  readonly environment?: Readonly<Record<string, string>>;
}

const desktopRoot = resolve(import.meta.dirname, '../..');
const mainEntry = join(desktopRoot, 'dist', 'main', 'index.js');
const require = createRequire(import.meta.url);

export async function launchDesktop(
  userDataDirectory: string,
  options: LaunchDesktopOptions = {},
): Promise<ElectronSession> {
  const entry = options.entry ?? mainEntry;
  await access(entry);

  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
  delete environment.ELECTRON_RENDERER_URL;
  delete environment.ELECTRON_RUN_AS_NODE;
  Object.assign(environment, options.environment);

  const app = await electron.launch({
    executablePath: require('electron') as string,
    cwd: desktopRoot,
    args: [entry, `--user-data-dir=${userDataDirectory}`],
    env: environment,
    timeout: 30_000,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

export async function approveNextNativeAgentLaunch(
  app: ElectronApplication,
  reviewDialog: Locator,
  expectedAdapterId: string,
  launchAction: () => Promise<unknown>,
  options: { pollTimeoutMs?: number } = {},
): Promise<void> {
  const disclosureFingerprint =
    (await reviewDialog.getByLabel('Security fingerprint (SHA-256)').textContent())?.trim() ?? '';
  expect(disclosureFingerprint).toMatch(/^[0-9a-f]{64}$/u);
  const expiresAt =
    (await reviewDialog.getByLabel('Approval expires at').getAttribute('datetime')) ?? '';
  expect(new Date(expiresAt).toISOString()).toBe(expiresAt);

  const token = randomUUID();
  await app.evaluate(
    ({ dialog }, binding) => {
      interface HarnessRecord {
        error?: string;
        interceptor: (...arguments_: unknown[]) => Promise<{
          checkboxChecked: boolean;
          response: number;
        }>;
        originalDescriptor: PropertyDescriptor | undefined;
        restoreIfOwned: () => void;
        status: 'armed' | 'approved' | 'rejected';
      }
      const state = globalThis as typeof globalThis & {
        __forgeboardE2eAgentLaunchDialogs?: Map<string, HarnessRecord>;
      };
      const records = state.__forgeboardE2eAgentLaunchDialogs ?? new Map<string, HarnessRecord>();
      state.__forgeboardE2eAgentLaunchDialogs = records;
      const originalDescriptor = Object.getOwnPropertyDescriptor(dialog, 'showMessageBox');
      const record: HarnessRecord = {
        interceptor,
        originalDescriptor,
        restoreIfOwned,
        status: 'armed',
      };

      function restoreIfOwned(): void {
        if (Object.getOwnPropertyDescriptor(dialog, 'showMessageBox')?.value !== interceptor)
          return;
        if (originalDescriptor === undefined) {
          Reflect.deleteProperty(dialog, 'showMessageBox');
        } else {
          Object.defineProperty(dialog, 'showMessageBox', originalDescriptor);
        }
      }

      function interceptor(...arguments_: unknown[]): ReturnType<HarnessRecord['interceptor']> {
        restoreIfOwned();
        const options = arguments_.at(-1) as
          | {
              buttons?: unknown;
              cancelId?: unknown;
              defaultId?: unknown;
              detail?: unknown;
              message?: unknown;
              noLink?: unknown;
              title?: unknown;
              type?: unknown;
            }
          | undefined;
        const detailLines = typeof options?.detail === 'string' ? options.detail.split('\n') : [];
        const errors = [
          options?.type === 'warning' ? undefined : 'type must be warning',
          options?.title === 'Launch agent' ? undefined : 'title must identify the agent launch',
          options?.message === `Launch ${binding.adapterId} for this node?`
            ? undefined
            : `message must identify ${binding.adapterId}`,
          JSON.stringify(options?.buttons) === JSON.stringify(['Cancel', 'Launch agent'])
            ? undefined
            : 'buttons must be Cancel then Launch agent',
          options?.defaultId === 0 ? undefined : 'Cancel must be the default action',
          options?.cancelId === 0 ? undefined : 'Cancel must be the escape action',
          options?.noLink === true ? undefined : 'native links must be disabled',
          detailLines.includes(`Security fingerprint (SHA-256): ${binding.disclosureFingerprint}`)
            ? undefined
            : 'detail must contain the exact reviewed disclosure fingerprint',
          detailLines.includes(`Approval expires at: ${binding.expiresAt}`)
            ? undefined
            : 'detail must contain the exact reviewed expiry',
        ].filter((error): error is string => error !== undefined);

        if (errors.length > 0) {
          record.error = errors.join('; ');
          record.status = 'rejected';
          return Promise.resolve({ response: 0, checkboxChecked: false });
        }
        record.status = 'approved';
        return Promise.resolve({ response: 1, checkboxChecked: false });
      }
      records.set(binding.token, record);
      Object.defineProperty(dialog, 'showMessageBox', {
        configurable: true,
        value: interceptor,
      });
    },
    { adapterId: expectedAdapterId, disclosureFingerprint, expiresAt, token },
  );

  let operationFailed = false;
  let operationError: unknown;
  try {
    await launchAction();
    await expect
      .poll(
        async () =>
          await app.evaluate((_, currentToken) => {
            const state = globalThis as typeof globalThis & {
              __forgeboardE2eAgentLaunchDialogs?: Map<string, { error?: string; status: string }>;
            };
            return state.__forgeboardE2eAgentLaunchDialogs?.get(currentToken)?.status ?? 'missing';
          }, token),
        {
          message: 'the owner-bound native agent launch confirmation should open',
          timeout: options.pollTimeoutMs ?? 5_000,
        },
      )
      .not.toBe('armed');

    const result = await app.evaluate((_, currentToken) => {
      const state = globalThis as typeof globalThis & {
        __forgeboardE2eAgentLaunchDialogs?: Map<string, { error?: string; status: string }>;
      };
      return state.__forgeboardE2eAgentLaunchDialogs?.get(currentToken);
    }, token);
    if (result?.status !== 'approved') {
      throw new Error(
        result?.error ?? 'The native agent launch confirmation did not approve the reviewed run.',
      );
    }
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  let cleanupFailed = false;
  let cleanupError: unknown;
  try {
    await app.evaluate(({ dialog }, currentToken) => {
      interface HarnessRecord {
        restoreIfOwned: () => void;
      }
      const state = globalThis as typeof globalThis & {
        __forgeboardE2eAgentLaunchDialogs?: Map<string, HarnessRecord>;
      };
      const records = state.__forgeboardE2eAgentLaunchDialogs;
      const record = records?.get(currentToken);
      record?.restoreIfOwned();
      records?.delete(currentToken);
      if (records?.size === 0) delete state.__forgeboardE2eAgentLaunchDialogs;
      void dialog;
    }, token);
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }
  if (operationFailed) throw operationError;
  if (cleanupFailed) throw cleanupError;
}

export function watchExternalRequests(page: Page, externalRequests: string[]): void {
  const capture = (rawUrl: string): void => {
    const url = new URL(rawUrl);
    if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && !isLoopbackUrl(url)) {
      externalRequests.push(rawUrl);
    }
  };
  page.on('request', (request) => {
    capture(request.url());
  });
  page.on('websocket', (webSocket) => capture(webSocket.url()));
}

export function watchNetworkRequests(page: Page, networkRequests: string[]): void {
  const capture = (rawUrl: string): void => {
    const url = new URL(rawUrl);
    if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
      networkRequests.push(rawUrl);
    }
  };
  page.on('request', (request) => {
    capture(request.url());
  });
  page.on('websocket', (webSocket) => capture(webSocket.url()));
}

function isLoopbackUrl(url: URL): boolean {
  const hostname = url.hostname
    .replace(/^\[|\]$/gu, '')
    .replace(/\.$/u, '')
    .toLowerCase();
  if (hostname === 'localhost' || hostname === '::1' || hostname === '0:0:0:0:0:0:0:1') {
    return true;
  }
  const octets = hostname.split('.').map(Number);
  return (
    octets.length === 4 &&
    octets[0] === 127 &&
    octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
  );
}
