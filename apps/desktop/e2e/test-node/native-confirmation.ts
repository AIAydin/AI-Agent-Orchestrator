import { expect, type ElectronApplication } from '@playwright/test';

export interface WorkflowNativeDialogRecord {
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

export async function installWorkflowNativeDialogHarness(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow, dialog }) => {
    interface HarnessState {
      dialogs: WorkflowNativeDialogRecord[];
      responses: number[];
    }
    const state = globalThis as typeof globalThis & {
      __forgeboardWorkflowDialogs?: HarnessState;
    };
    state.__forgeboardWorkflowDialogs = { dialogs: [], responses: [] };
    Object.defineProperty(dialog, 'showMessageBox', {
      configurable: true,
      value: (...arguments_: unknown[]) => {
        const options = arguments_.at(-1) as Omit<
          WorkflowNativeDialogRecord,
          'ownerId' | 'response' | 'windowIds'
        >;
        const owner = arguments_.length > 1 ? arguments_[0] : undefined;
        const ownerId =
          owner !== null && typeof owner === 'object' && 'id' in owner
            ? (owner as { id?: number }).id
            : undefined;
        const response = state.__forgeboardWorkflowDialogs?.responses.shift() ?? 0;
        state.__forgeboardWorkflowDialogs?.dialogs.push({
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
          windowIds: BrowserWindow.getAllWindows().map((window) => window.id),
        });
        return Promise.resolve({ response, checkboxChecked: false });
      },
    });
  });
}

export async function queueWorkflowNativeResponse(
  app: ElectronApplication,
  response: 0 | 1,
): Promise<void> {
  await app.evaluate((_, nextResponse) => {
    const state = globalThis as typeof globalThis & {
      __forgeboardWorkflowDialogs?: { responses: number[] };
    };
    if (state.__forgeboardWorkflowDialogs === undefined) {
      throw new Error('The workflow native-dialog harness is not installed.');
    }
    state.__forgeboardWorkflowDialogs.responses.push(nextResponse);
  }, response);
}

export async function waitForWorkflowNativeDialog(
  app: ElectronApplication,
  index: number,
): Promise<WorkflowNativeDialogRecord> {
  await expect
    .poll(async () => await nativeDialogCount(app), {
      message: `workflow native dialog ${String(index + 1)} should open`,
    })
    .toBeGreaterThan(index);
  const record = await app.evaluate((_, targetIndex) => {
    const state = globalThis as typeof globalThis & {
      __forgeboardWorkflowDialogs?: { dialogs: WorkflowNativeDialogRecord[] };
    };
    return state.__forgeboardWorkflowDialogs?.dialogs[targetIndex];
  }, index);
  if (record === undefined) throw new Error(`Workflow native dialog ${String(index)} is missing.`);
  return record;
}

export function expectExactLaunchConfirmation(
  record: WorkflowNativeDialogRecord,
  expected: { readonly artifactPath: string; readonly marker: string },
): void {
  expect(record).toMatchObject({
    type: 'warning',
    title: 'Launch workflow node',
    message: 'Launch this exact prepared workflow action?',
    buttons: ['Cancel', 'Launch node'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    response: 1,
  });
  expectOwnedNativeDialog(record);
  expect(record.detail).toContain('Executor: exact-check');
  expect(record.detail).toContain('"executable"');
  expect(record.detail).toContain('"arguments"');
  expect(record.detail).toContain('"-e"');
  expect(record.detail).toContain(expected.marker);
  expect(record.detail).toContain(expected.artifactPath);
  expect(record.detail).toContain('"cwd"');
  expect(record.detail).toContain('"environmentVariableNames"');
}

export function expectExactNodeCancelConfirmation(record: WorkflowNativeDialogRecord): void {
  expect(record).toMatchObject({
    type: 'warning',
    title: 'Cancel workflow node',
    message: 'Stop only this active workflow node attempt?',
    buttons: ['Keep running', 'Cancel node'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    response: 1,
  });
  expectOwnedNativeDialog(record);
  expect(record.detail).toMatch(/^Node: .+/u);
  expect(record.detail).toContain('verify the current execution, node, and attempt');
}

function expectOwnedNativeDialog(record: WorkflowNativeDialogRecord): void {
  expect(record.ownerId).toBeDefined();
  expect(record.windowIds).toContain(record.ownerId);
  expect(record.ownerId).toBe(record.windowIds[0]);
}

async function nativeDialogCount(app: ElectronApplication): Promise<number> {
  return await app.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __forgeboardWorkflowDialogs?: { dialogs: WorkflowNativeDialogRecord[] };
    };
    return state.__forgeboardWorkflowDialogs?.dialogs.length ?? 0;
  });
}
