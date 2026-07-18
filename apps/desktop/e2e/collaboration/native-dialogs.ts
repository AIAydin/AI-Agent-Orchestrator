import { expect, type ElectronApplication } from '@playwright/test';

export interface CollaborationNativeDialog {
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

export async function installCollaborationDialogHarness(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    interface HarnessState {
      dialogs: CollaborationNativeDialog[];
      responses: number[];
    }
    const state = globalThis as typeof globalThis & {
      __forgeboardCollaborationDialogs?: HarnessState;
    };
    state.__forgeboardCollaborationDialogs = { dialogs: [], responses: [] };
    Object.defineProperty(dialog, 'showMessageBox', {
      configurable: true,
      value: (...arguments_: unknown[]) => {
        const options = arguments_.at(-1) as Omit<CollaborationNativeDialog, 'response'>;
        const response = state.__forgeboardCollaborationDialogs?.responses.shift() ?? 0;
        state.__forgeboardCollaborationDialogs?.dialogs.push({
          ...options,
          response,
        });
        return Promise.resolve({ response, checkboxChecked: false });
      },
    });
  });
}

export async function queueCollaborationDialog(
  app: ElectronApplication,
  response: 0 | 1,
): Promise<number> {
  return await app.evaluate((_, nextResponse) => {
    const state = globalThis as typeof globalThis & {
      __forgeboardCollaborationDialogs?: {
        dialogs: CollaborationNativeDialog[];
        responses: number[];
      };
    };
    if (state.__forgeboardCollaborationDialogs === undefined) {
      throw new Error('The collaboration native-dialog harness is not installed.');
    }
    const index = state.__forgeboardCollaborationDialogs.dialogs.length;
    state.__forgeboardCollaborationDialogs.responses.push(nextResponse);
    return index;
  }, response);
}

export async function waitForCollaborationDialog(
  app: ElectronApplication,
  index: number,
): Promise<CollaborationNativeDialog> {
  await expect
    .poll(async () => await dialogCount(app), {
      message: `collaboration native confirmation ${String(index)} should open`,
    })
    .toBeGreaterThan(index);
  const dialog = await app.evaluate((_, selected) => {
    const state = globalThis as typeof globalThis & {
      __forgeboardCollaborationDialogs?: {
        dialogs: CollaborationNativeDialog[];
      };
    };
    return state.__forgeboardCollaborationDialogs?.dialogs[selected] ?? null;
  }, index);
  if (dialog === null) throw new Error(`Collaboration native dialog ${String(index)} is missing.`);
  return dialog;
}

export function expectCancelDefaultDialog(
  dialog: CollaborationNativeDialog,
  input: { title: string; confirmLabel: string; secrets?: readonly string[] },
): void {
  expect(dialog).toMatchObject({
    type: 'warning',
    title: input.title,
    buttons: ['Cancel', input.confirmLabel],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  const serialized = JSON.stringify(dialog);
  for (const secret of input.secrets ?? []) expect(serialized).not.toContain(secret);
}

async function dialogCount(app: ElectronApplication): Promise<number> {
  return await app.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __forgeboardCollaborationDialogs?: {
        dialogs: CollaborationNativeDialog[];
      };
    };
    return state.__forgeboardCollaborationDialogs?.dialogs.length ?? 0;
  });
}
