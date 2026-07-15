import type {
  BrowserWindow,
  Dialog,
  IpcMain,
  IpcMainEvent,
  MessageBoxOptions,
  WebContents,
} from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppCloseRequestSchema, IPC_CHANNELS } from '../shared/contracts.js';
import { CloseCoordinator } from './close-coordinator.js';

const coordinators: CloseCoordinator[] = [];

afterEach(() => {
  for (const coordinator of coordinators.splice(0)) coordinator.dispose();
});

describe('CloseCoordinator', () => {
  it('accepts only the matching main-frame owner response', async () => {
    const fixture = createFixture();
    const pending = fixture.coordinator.requestSave(fixture.window);
    const request = fixture.sentRequest();

    fixture.ipc.emit(responseEvent(createOwner(99)), {
      requestId: request.requestId,
      saved: true,
    });
    fixture.ipc.emit(responseEvent(fixture.owner), {
      requestId: 'c95b77bb-53d0-46f9-b9fc-5df23c0d5843',
      saved: true,
    });
    fixture.ipc.emit(responseEvent(fixture.owner, false), {
      requestId: request.requestId,
      saved: true,
    });
    fixture.ipc.emit(responseEvent(fixture.owner), {
      requestId: request.requestId,
      saved: true,
    });

    await expect(pending).resolves.toBe(true);
    expect(fixture.showMessageBox).not.toHaveBeenCalled();
  });

  it('fails closed behind a cancel-default native confirmation when saving fails', async () => {
    const fixture = createFixture({ nativeResponse: 0 });
    const pending = fixture.coordinator.requestSave(fixture.window);
    const request = fixture.sentRequest();
    fixture.ipc.emit(responseEvent(fixture.owner), {
      requestId: request.requestId,
      saved: false,
    });

    await expect(pending).resolves.toBe(false);
    expect(fixture.showMessageBox).toHaveBeenCalledTimes(1);
    const options = fixture.showMessageBox.mock.calls[0]?.[1] as MessageBoxOptions;
    expect(options).toMatchObject({
      defaultId: 0,
      cancelId: 0,
      buttons: ['Keep Forgeboard Open', 'Close Without Saving'],
    });
  });

  it('allows an explicit native close-without-saving decision', async () => {
    const fixture = createFixture({ nativeResponse: 1 });
    const pending = fixture.coordinator.requestSave(fixture.window);
    const request = fixture.sentRequest();
    fixture.ipc.emit(responseEvent(fixture.owner), {
      requestId: request.requestId,
      saved: false,
    });

    await expect(pending).resolves.toBe(true);
  });

  it('uses the same cancel-default fallback after a renderer timeout', async () => {
    const fixture = createFixture({ responseTimeoutMs: 5 });

    await expect(fixture.coordinator.requestSave(fixture.window)).resolves.toBe(false);
    expect(fixture.showMessageBox).toHaveBeenCalledTimes(1);
    expect((fixture.showMessageBox.mock.calls[0]?.[1] as MessageBoxOptions).detail).toContain(
      'timed out',
    );
  });

  it('deduplicates concurrent requests for the same renderer owner', async () => {
    const fixture = createFixture();
    const first = fixture.coordinator.requestSave(fixture.window);
    const second = fixture.coordinator.requestSave(fixture.window);
    const request = fixture.sentRequest();

    expect(fixture.send).toHaveBeenCalledTimes(1);
    fixture.ipc.emit(responseEvent(fixture.owner), {
      requestId: request.requestId,
      saved: true,
    });
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });

  it('removes its listener and refuses new requests after disposal', async () => {
    const fixture = createFixture();
    fixture.coordinator.dispose();

    await expect(fixture.coordinator.requestSave(fixture.window)).resolves.toBe(false);
    expect(fixture.ipc.removeListener).toHaveBeenCalledWith(
      IPC_CHANNELS.appCloseResponse,
      expect.any(Function),
    );
    expect(fixture.send).not.toHaveBeenCalled();
  });
});

function createFixture(options: { nativeResponse?: number; responseTimeoutMs?: number } = {}) {
  const ipc = new FakeIpc();
  const showMessageBox =
    vi.fn<
      (
        window: BrowserWindow,
        dialogOptions: MessageBoxOptions,
      ) => Promise<{ response: number; checkboxChecked: boolean }>
    >();
  showMessageBox.mockResolvedValue({
    response: options.nativeResponse ?? 0,
    checkboxChecked: false,
  });
  const send = vi.fn();
  const owner = createOwner(7, send);
  const window = {
    isDestroyed: () => false,
    webContents: owner,
  } as unknown as BrowserWindow;
  const coordinator = new CloseCoordinator(
    { showMessageBox } as unknown as Pick<Dialog, 'showMessageBox'>,
    ipc as unknown as Pick<IpcMain, 'on' | 'removeListener'>,
    { responseTimeoutMs: options.responseTimeoutMs ?? 1_000 },
  );
  coordinators.push(coordinator);
  return {
    coordinator,
    ipc,
    owner,
    send,
    showMessageBox,
    window,
    sentRequest: () => {
      const call = send.mock.calls[0];
      if (call === undefined) throw new Error('Expected a close request.');
      expect(call[0]).toBe(IPC_CHANNELS.appCloseRequested);
      return AppCloseRequestSchema.parse(call[1]);
    },
  };
}

class FakeIpc {
  readonly listeners = new Map<string, (event: IpcMainEvent, payload: unknown) => void>();
  readonly on = vi.fn(
    (channel: string, listener: (event: IpcMainEvent, payload: unknown) => void) => {
      this.listeners.set(channel, listener);
      return this;
    },
  );
  readonly removeListener = vi.fn(
    (channel: string, listener: (event: IpcMainEvent, payload: unknown) => void) => {
      if (this.listeners.get(channel) === listener) this.listeners.delete(channel);
      return this;
    },
  );

  emit(event: IpcMainEvent, payload: unknown): void {
    const listener = this.listeners.get(IPC_CHANNELS.appCloseResponse);
    if (listener === undefined) throw new Error('Missing close response listener.');
    listener(event, payload);
  }
}

function createOwner(id: number, send = vi.fn()): WebContents {
  return {
    id,
    isDestroyed: () => false,
    mainFrame: {},
    send,
  } as unknown as WebContents;
}

function responseEvent(owner: WebContents, mainFrame = true): IpcMainEvent {
  return {
    sender: owner,
    senderFrame: mainFrame ? owner.mainFrame : {},
  } as unknown as IpcMainEvent;
}
