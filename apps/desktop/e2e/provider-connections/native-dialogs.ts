import { expect, type ElectronApplication } from '@playwright/test';

export interface ProviderNativeDialog {
  readonly buttons?: readonly string[];
  readonly cancelId?: number;
  readonly defaultId?: number;
  readonly detail?: string;
  readonly message?: string;
  readonly noLink?: boolean;
  readonly response: number;
  readonly title?: string;
  readonly type?: string;
}

export async function installProviderDialogHarness(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    interface HarnessState {
      dialogs: ProviderNativeDialog[];
      responses: number[];
    }
    const state = globalThis as typeof globalThis & {
      __forgeboardProviderDialogs?: HarnessState;
    };
    state.__forgeboardProviderDialogs = { dialogs: [], responses: [] };
    Object.defineProperty(dialog, 'showMessageBox', {
      configurable: true,
      value: (...arguments_: unknown[]) => {
        const options = arguments_.at(-1) as Omit<ProviderNativeDialog, 'response'>;
        const response = state.__forgeboardProviderDialogs?.responses.shift() ?? 0;
        state.__forgeboardProviderDialogs?.dialogs.push({ ...options, response });
        return Promise.resolve({ response, checkboxChecked: false });
      },
    });
  });
}

export async function queueProviderDialogResponse(
  app: ElectronApplication,
  response: 0 | 1,
): Promise<number> {
  return await app.evaluate((_, nextResponse) => {
    const state = globalThis as typeof globalThis & {
      __forgeboardProviderDialogs?: { dialogs: ProviderNativeDialog[]; responses: number[] };
    };
    if (state.__forgeboardProviderDialogs === undefined) {
      throw new Error('Provider native-dialog harness is not installed.');
    }
    const index = state.__forgeboardProviderDialogs.dialogs.length;
    state.__forgeboardProviderDialogs.responses.push(nextResponse);
    return index;
  }, response);
}

export async function waitForProviderDialog(
  app: ElectronApplication,
  index: number,
): Promise<ProviderNativeDialog> {
  await expect
    .poll(async () => await dialogCount(app), {
      message: `provider native confirmation ${String(index)} should open`,
    })
    .toBeGreaterThan(index);
  const dialog = await app.evaluate((_, selected) => {
    const state = globalThis as typeof globalThis & {
      __forgeboardProviderDialogs?: { dialogs: ProviderNativeDialog[] };
    };
    return state.__forgeboardProviderDialogs?.dialogs[selected] ?? null;
  }, index);
  if (dialog === null) throw new Error(`Provider native dialog ${String(index)} is missing.`);
  return dialog;
}

export function expectProviderDisclosure(
  dialog: ProviderNativeDialog,
  input: {
    readonly title: string;
    readonly actionButton: string;
    readonly executable: string;
    readonly actionArguments: readonly string[];
    readonly followUpArguments: readonly string[] | null;
  },
): void {
  expect(dialog).toMatchObject({
    type: 'warning',
    title: input.title,
    buttons: ['Cancel', input.actionButton],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  const detail = dialog.detail ?? '';
  expect(detail).toContain(`Executable: ${input.executable}`);
  expect(detail).toContain('Validation arguments: ["--version"] then ["--help"]');
  expect(detail).toContain(`Action arguments: ${JSON.stringify(input.actionArguments)}`);
  expect(detail).toContain(
    `Follow-up status arguments: ${input.followUpArguments === null ? 'none' : JSON.stringify(input.followUpArguments)}`,
  );
  expect(detail).toContain('Working directory:');
  expect(detail).toContain('Environment variable names:');
  expect(detail).toContain(process.platform === 'win32' ? '"USERPROFILE"' : '"HOME"');
  expect(detail).toContain('"PATH"');
  expect(detail).toContain('Provider: OpenAI Codex');
  expect(detail).toContain('Network disclosure: Codex opens and owns its official sign-in flow');
  expect(detail).toContain('Artemis does not receive or store OAuth tokens');
}

async function dialogCount(app: ElectronApplication): Promise<number> {
  return await app.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __forgeboardProviderDialogs?: { dialogs: ProviderNativeDialog[] };
    };
    return state.__forgeboardProviderDialogs?.dialogs.length ?? 0;
  });
}
