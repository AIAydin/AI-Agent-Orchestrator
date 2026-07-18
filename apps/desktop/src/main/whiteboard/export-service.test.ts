import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => {
  type Handler = (event: unknown, input: unknown) => Promise<unknown>;
  return {
    handlers: new Map<string, Handler>(),
    fromWebContents: vi.fn(),
    handle: vi.fn((channel: string, handler: Handler) =>
      electronMock.handlers.set(channel, handler),
    ),
    removeHandler: vi.fn((channel: string) => electronMock.handlers.delete(channel)),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: electronMock.fromWebContents },
  ipcMain: { handle: electronMock.handle, removeHandler: electronMock.removeHandler },
}));

import { WhiteboardExportService } from './export-service.js';

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.fromWebContents.mockReset();
});

describe('WhiteboardExportService', () => {
  it('uses native selection and writes only revalidated inert SVG with private permissions', async () => {
    const parent = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parent);
    const dialog = {
      showSaveDialog: vi.fn().mockResolvedValue({
        canceled: false,
        filePath: '/tmp/checkout.svg',
      }),
    };
    const writer = vi.fn().mockResolvedValue(undefined);
    new WhiteboardExportService(dialog as never, undefined, writer).registerIpcHandler();

    const result = await handler()(liveEvent(), {
      fileName: 'checkout.svg',
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#fff" /></svg>',
    });
    expect(dialog.showSaveDialog).toHaveBeenCalledWith(
      parent,
      expect.objectContaining({ title: 'Export whiteboard image' }),
    );
    expect(writer).toHaveBeenCalledWith('/tmp/checkout.svg', expect.stringContaining('<rect'), {
      mode: 0o600,
    });
    expect(result).toEqual({ ok: true, value: { fileName: 'checkout.svg' } });
  });

  it('rejects active SVG before showing a native dialog', async () => {
    electronMock.fromWebContents.mockReturnValue({ isDestroyed: () => false });
    const dialog = { showSaveDialog: vi.fn() };
    const writer = vi.fn();
    new WhiteboardExportService(dialog as never, undefined, writer).registerIpcHandler();

    const result = await handler()(liveEvent(), {
      fileName: 'unsafe.svg',
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    });
    expect(result).toMatchObject({ ok: false });
    expect(dialog.showSaveDialog).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
  });
});

function handler() {
  const value = electronMock.handlers.get('whiteboard:export-svg');
  if (value === undefined) throw new Error('Whiteboard export handler was not registered.');
  return value;
}

function liveEvent() {
  const mainFrame = {};
  return {
    sender: { mainFrame, isDestroyed: () => false },
    senderFrame: mainFrame,
  };
}
