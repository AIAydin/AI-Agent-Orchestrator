import { randomUUID } from 'node:crypto';

import { expect, type ElectronApplication } from '@playwright/test';

export interface NativePreviewConfirmationBinding {
  readonly action: 'start' | 'restart';
  readonly projectRoot: string;
  readonly cwd: string;
  readonly source: string;
  readonly executable: string;
  readonly executableSha256: string;
  readonly arguments: readonly string[];
  readonly portRange: { readonly start: number; readonly end: number };
  readonly trustedHosts: readonly string[];
}

export async function approveNextNativePreviewLaunch(
  app: ElectronApplication,
  expected: NativePreviewConfirmationBinding,
  launchAction: () => Promise<unknown>,
  options: { pollTimeoutMs?: number } = {},
): Promise<void> {
  expect(expected.executableSha256).toMatch(/^[a-f0-9]{64}$/u);
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
        __forgeboardE2ePreviewDialogs?: Map<string, HarnessRecord>;
      };
      const records = state.__forgeboardE2ePreviewDialogs ?? new Map<string, HarnessRecord>();
      state.__forgeboardE2ePreviewDialogs = records;
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
        const nativeOptions = arguments_.at(-1) as
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
        const restart = binding.action === 'restart';
        const detailLines =
          typeof nativeOptions?.detail === 'string' ? nativeOptions.detail.split('\n') : [];
        const expectedLines = [
          `Project: ${binding.projectRoot}`,
          `Working directory: ${binding.cwd}`,
          `Source: ${binding.source}`,
          `Executable: ${binding.executable}`,
          `Executable SHA-256: ${binding.executableSha256}`,
          `Arguments: ${JSON.stringify(binding.arguments)}`,
          `Loopback port range: ${String(binding.portRange.start)}-${String(binding.portRange.end)}`,
          `Trusted loopback hosts: ${binding.trustedHosts.join(', ')}`,
          '',
          'Artemis will start this local process without a shell. The process itself can still access resources allowed by your operating system.',
        ] as const;
        const errors = [
          nativeOptions?.type === 'warning' ? undefined : 'type must be warning',
          nativeOptions?.title ===
          (restart ? 'Restart development preview?' : 'Start development preview?')
            ? undefined
            : 'title must identify the exact preview action',
          nativeOptions?.message ===
          (restart
            ? 'Stop the current preview and start this reviewed replacement?'
            : 'Start this reviewed development preview?')
            ? undefined
            : 'message must describe the exact preview action',
          JSON.stringify(nativeOptions?.buttons) ===
          JSON.stringify(['Cancel', restart ? 'Restart preview' : 'Start preview'])
            ? undefined
            : 'buttons must be Cancel then the exact preview action',
          nativeOptions?.defaultId === 0 ? undefined : 'Cancel must be the default action',
          nativeOptions?.cancelId === 0 ? undefined : 'Cancel must be the escape action',
          nativeOptions?.noLink === true ? undefined : 'native links must be disabled',
          detailLines.length === expectedLines.length
            ? undefined
            : 'detail must contain only the exact reviewed preview disclosure',
          ...expectedLines.flatMap((line, index) =>
            detailLines[index] === line
              ? []
              : [`detail line ${String(index + 1)} does not match the reviewed preview`],
          ),
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
      try {
        Object.defineProperty(dialog, 'showMessageBox', {
          configurable: true,
          value: interceptor,
        });
      } catch (installError) {
        let restoreError: unknown;
        try {
          restoreIfOwned();
        } catch (error) {
          restoreError = error;
        } finally {
          records.delete(binding.token);
          if (records.size === 0) delete state.__forgeboardE2ePreviewDialogs;
        }
        if (restoreError !== undefined) {
          throw new AggregateError(
            [installError, restoreError],
            'Native preview interceptor installation and restoration both failed.',
          );
        }
        throw installError;
      }
    },
    { ...expected, token },
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
              __forgeboardE2ePreviewDialogs?: Map<string, { error?: string; status: string }>;
            };
            return state.__forgeboardE2ePreviewDialogs?.get(currentToken)?.status ?? 'missing';
          }, token),
        {
          message: 'the exact native preview confirmation should open',
          timeout: options.pollTimeoutMs ?? 5_000,
        },
      )
      .not.toBe('armed');

    const result = await app.evaluate((_, currentToken) => {
      const state = globalThis as typeof globalThis & {
        __forgeboardE2ePreviewDialogs?: Map<string, { error?: string; status: string }>;
      };
      return state.__forgeboardE2ePreviewDialogs?.get(currentToken);
    }, token);
    if (result?.status !== 'approved') {
      throw new Error(
        result?.error ?? 'The native preview confirmation did not approve the reviewed launch.',
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
        __forgeboardE2ePreviewDialogs?: Map<string, HarnessRecord>;
      };
      const records = state.__forgeboardE2ePreviewDialogs;
      records?.get(currentToken)?.restoreIfOwned();
      records?.delete(currentToken);
      if (records?.size === 0) delete state.__forgeboardE2ePreviewDialogs;
      void dialog;
    }, token);
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }
  if (operationFailed && cleanupFailed) {
    throw new AggregateError(
      [operationError, cleanupError],
      'Preview action and native-dialog cleanup both failed.',
    );
  }
  if (operationFailed) throw operationError;
  if (cleanupFailed) throw cleanupError;
}
