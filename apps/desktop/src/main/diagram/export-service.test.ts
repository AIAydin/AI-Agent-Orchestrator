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
  ipcMain: {
    handle: electronMock.handle,
    removeHandler: electronMock.removeHandler,
  },
}));

import { DiagramExportService } from './export-service.js';

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.fromWebContents.mockReset();
});

describe('DiagramExportService', () => {
  it('uses a cancel-default native path and writes only revalidated inert SVG', async () => {
    const parent = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parent);
    const dialog = {
      showSaveDialog: vi.fn().mockResolvedValue({ canceled: false, filePath: '/tmp/system.svg' }),
    };
    const writer = vi.fn().mockResolvedValue(undefined);
    const service = new DiagramExportService(dialog as never, undefined, writer);
    service.registerIpcHandler();

    const result = await handler()(liveEvent(), {
      fileName: 'system.svg',
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text fill="#172033">System</text></svg>',
    });
    expect(dialog.showSaveDialog).toHaveBeenCalledWith(
      parent,
      expect.objectContaining({ defaultPath: 'system.svg' }),
    );
    expect(writer).toHaveBeenCalledWith('/tmp/system.svg', expect.stringContaining('<text'), {
      mode: 0o600,
    });
    expect(result).toEqual({ ok: true, value: { fileName: 'system.svg' } });
  });

  it('rejects active SVG before showing a save dialog', async () => {
    electronMock.fromWebContents.mockReturnValue({ isDestroyed: () => false });
    const dialog = { showSaveDialog: vi.fn() };
    const writer = vi.fn();
    new DiagramExportService(dialog as never, undefined, writer).registerIpcHandler();
    const result = await handler()(liveEvent(), {
      fileName: 'unsafe.svg',
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    });
    expect(result).toMatchObject({ ok: false });
    expect(dialog.showSaveDialog).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
  });

  it('preserves an ordinary user-renamed native basename without reporting a false failure', async () => {
    const parent = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parent);
    const filePath = '/tmp/Architecture – draft (final)';
    const dialog = {
      showSaveDialog: vi.fn().mockResolvedValue({ canceled: false, filePath }),
    };
    const writer = vi.fn().mockResolvedValue(undefined);
    new DiagramExportService(dialog as never, undefined, writer).registerIpcHandler();

    const result = await handler()(liveEvent(), {
      fileName: 'architecture.svg',
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Architecture</text></svg>',
    });

    expect(writer).toHaveBeenCalledWith(filePath, expect.stringContaining('<text'), {
      mode: 0o600,
    });
    expect(result).toEqual({
      ok: true,
      value: { fileName: 'Architecture – draft (final)' },
    });
  });
});

function handler() {
  const value = electronMock.handlers.get('diagram:export-svg');
  if (value === undefined) throw new Error('Diagram export handler was not registered.');
  return value;
}

function liveEvent() {
  const mainFrame = {};
  return {
    sender: { mainFrame, isDestroyed: () => false },
    senderFrame: mainFrame,
  };
}
