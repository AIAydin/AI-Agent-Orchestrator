import { expect, type ElectronApplication, type Locator } from '@playwright/test';

export interface NativeDialogRecord {
  readonly buttons?: readonly string[] | undefined;
  readonly cancelId?: number | undefined;
  readonly defaultId?: number | undefined;
  readonly detail?: string | undefined;
  readonly message?: string | undefined;
  readonly noLink?: boolean | undefined;
  readonly response: number;
  readonly title?: string | undefined;
  readonly type?: string | undefined;
}

export async function installNativeDialogHarness(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    interface HarnessState {
      dialogs: NativeDialogRecord[];
      responses: number[];
    }
    const state = globalThis as typeof globalThis & {
      __forgeboardGitConnectionDialogs?: HarnessState;
    };
    state.__forgeboardGitConnectionDialogs = { dialogs: [], responses: [] };
    Object.defineProperty(dialog, 'showMessageBox', {
      configurable: true,
      value: (...arguments_: unknown[]) => {
        const options = arguments_.at(-1) as Omit<NativeDialogRecord, 'response'>;
        const response = state.__forgeboardGitConnectionDialogs?.responses.shift() ?? 1;
        state.__forgeboardGitConnectionDialogs?.dialogs.push({
          buttons: options.buttons,
          cancelId: options.cancelId,
          defaultId: options.defaultId,
          detail: options.detail,
          message: options.message,
          noLink: options.noLink,
          response,
          title: options.title,
          type: options.type,
        });
        return Promise.resolve({ response, checkboxChecked: false });
      },
    });
  });
}

export async function queueNativeDialogResponse(
  app: ElectronApplication,
  response: 0 | 1,
): Promise<void> {
  await app.evaluate((_, nextResponse) => {
    const state = globalThis as typeof globalThis & {
      __forgeboardGitConnectionDialogs?: { responses: number[] };
    };
    if (state.__forgeboardGitConnectionDialogs === undefined) {
      throw new Error('The Git connection native-dialog harness is not installed.');
    }
    state.__forgeboardGitConnectionDialogs.responses.push(nextResponse);
  }, response);
}

export async function nativeDialogs(app: ElectronApplication): Promise<NativeDialogRecord[]> {
  return await app.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __forgeboardGitConnectionDialogs?: { dialogs: NativeDialogRecord[] };
    };
    return state.__forgeboardGitConnectionDialogs?.dialogs ?? [];
  });
}

export async function waitForNativeDialog(
  app: ElectronApplication,
  index: number,
): Promise<NativeDialogRecord> {
  await expect.poll(async () => (await nativeDialogs(app)).length).toBeGreaterThan(index);
  const record = (await nativeDialogs(app))[index];
  if (record === undefined) throw new Error(`Native dialog ${String(index)} was not recorded.`);
  return record;
}

export async function continuePlanWithNativeResponse(input: {
  readonly app: ElectronApplication;
  readonly plan: Locator;
  readonly response: 0 | 1;
  readonly title: string;
  readonly buttons: readonly string[];
}): Promise<NativeDialogRecord> {
  const index = (await nativeDialogs(input.app)).length;
  await queueNativeDialogResponse(input.app, input.response);
  await input.plan.getByRole('button', { name: 'Continue to system confirmation' }).click();
  const record = await waitForNativeDialog(input.app, index);
  expectNativeCancelDefault(record, input.title, input.buttons);
  await expect(input.plan).toBeHidden();
  return record;
}

export function expectNativeCancelDefault(
  record: NativeDialogRecord,
  title: string,
  buttons: readonly string[],
): void {
  expect(record).toMatchObject({
    type: 'warning',
    title,
    buttons,
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
}

export function nativeDialogText(record: NativeDialogRecord): string {
  return [record.title, record.message, record.detail].filter(Boolean).join('\n');
}

export async function selectNextNativePath(
  app: ElectronApplication,
  selectedPath: string | null,
): Promise<void> {
  await app.evaluate(({ dialog }, path) => {
    Object.defineProperty(dialog, 'showOpenDialog', {
      configurable: true,
      value: () =>
        Promise.resolve(
          path === null
            ? { canceled: true, filePaths: [] }
            : { canceled: false, filePaths: [path] },
        ),
    });
  }, selectedPath);
}
