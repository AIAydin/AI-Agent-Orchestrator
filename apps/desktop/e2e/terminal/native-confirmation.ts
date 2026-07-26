import { expect, type ElectronApplication } from '@playwright/test';

export interface NativeTerminalDialogRecord {
  readonly buttons?: readonly string[] | undefined;
  readonly cancelId?: number | undefined;
  readonly defaultId?: number | undefined;
  readonly detail?: string | undefined;
  readonly message?: string | undefined;
  readonly noLink?: boolean | undefined;
  readonly ownerId?: number | undefined;
  readonly response: number;
  readonly title?: string | undefined;
  readonly type?: string | undefined;
  readonly windowIds: readonly number[];
}

export async function installTerminalNativeDialogHarness(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow, dialog }) => {
    interface HarnessState {
      dialogs: NativeTerminalDialogRecord[];
      responses: number[];
    }
    const state = globalThis as typeof globalThis & {
      __forgeboardTerminalDialogs?: HarnessState;
    };
    state.__forgeboardTerminalDialogs = { dialogs: [], responses: [] };
    Object.defineProperty(dialog, 'showMessageBox', {
      configurable: true,
      value: (...arguments_: unknown[]) => {
        const options = arguments_.at(-1) as Omit<
          NativeTerminalDialogRecord,
          'ownerId' | 'response' | 'windowIds'
        >;
        const owner = arguments_.length > 1 ? arguments_[0] : undefined;
        const ownerId =
          owner !== null && typeof owner === 'object' && 'id' in owner
            ? (owner as { id?: number }).id
            : undefined;
        const windowIds = BrowserWindow.getAllWindows().map((window) => window.id);
        // An unarmed native prompt must choose the safe action instead of silently launching.
        const response = state.__forgeboardTerminalDialogs?.responses.shift() ?? 0;
        state.__forgeboardTerminalDialogs?.dialogs.push({
          buttons: options.buttons,
          cancelId: options.cancelId,
          defaultId: options.defaultId,
          detail: options.detail,
          message: options.message,
          noLink: options.noLink,
          ownerId,
          response,
          title: options.title,
          type: options.type,
          windowIds,
        });
        return Promise.resolve({ response, checkboxChecked: false });
      },
    });
  });
}

export async function queueTerminalNativeDialogResponse(
  app: ElectronApplication,
  response: 0 | 1,
): Promise<void> {
  await app.evaluate((_, nextResponse) => {
    const state = globalThis as typeof globalThis & {
      __forgeboardTerminalDialogs?: { responses: number[] };
    };
    if (state.__forgeboardTerminalDialogs === undefined) {
      throw new Error('The terminal native-dialog harness is not installed.');
    }
    state.__forgeboardTerminalDialogs.responses.push(nextResponse);
  }, response);
}

export async function terminalNativeDialogs(
  app: ElectronApplication,
): Promise<NativeTerminalDialogRecord[]> {
  return await app.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __forgeboardTerminalDialogs?: { dialogs: NativeTerminalDialogRecord[] };
    };
    return state.__forgeboardTerminalDialogs?.dialogs ?? [];
  });
}

export async function waitForTerminalNativeDialog(
  app: ElectronApplication,
  index: number,
): Promise<NativeTerminalDialogRecord> {
  await expect.poll(async () => (await terminalNativeDialogs(app)).length).toBeGreaterThan(index);
  const record = (await terminalNativeDialogs(app))[index];
  if (record === undefined) {
    throw new Error(`Native terminal dialog ${String(index)} was not recorded.`);
  }
  return record;
}

export function expectExactTerminalNativeConfirmation(
  record: NativeTerminalDialogRecord,
  expected: {
    readonly arguments: readonly string[];
    readonly cwd: string;
    readonly environmentVariableNames: readonly string[];
    readonly executable: string;
    readonly projectName: string;
  },
): void {
  expect(record).toMatchObject({
    type: 'warning',
    title: 'Launch local terminal?',
    message: `Launch a terminal for ${expected.projectName}?`,
    buttons: ['Cancel', 'Launch terminal'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    response: 1,
  });
  expect(record.ownerId).toBeDefined();
  expect(record.windowIds).toContain(record.ownerId);
  expect(record.ownerId).toBe(record.windowIds[0]);

  const detail = record.detail ?? '';
  expect(detail).toContain(`Project: ${expected.projectName}`);
  expect(detail).toContain(`Program: ${JSON.stringify(expected.executable)}`);
  expect(detail).toContain(`Folder to run in: ${JSON.stringify(expected.cwd)}`);
  expect(detail).toContain(
    `Environment variable names: ${expected.environmentVariableNames
      .map((name) => JSON.stringify(name))
      .join(', ')}`,
  );
  expect(detail).toContain(`Arguments (${String(expected.arguments.length)}):`);
  expected.arguments.forEach((argument, index) => {
    expect(detail).toContain(`${String(index + 1)}. ${JSON.stringify(argument)}`);
  });
  expect(detail).toContain('your user account on this computer (not sandboxed)');
  expect(detail).toContain('This one-time launch approval expires at');
}
