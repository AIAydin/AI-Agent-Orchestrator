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
    const audit = vi.fn();
    const service = new DiagramExportService(dialog as never, undefined, writer, audit);
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
    expect(audit.mock.calls[0]?.slice(0, 2)).toEqual(['diagram-svg', 'allowed']);
    const auditMetadata = audit.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    expect(auditMetadata?.format).toBe('svg');
    expect(auditMetadata?.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(audit.mock.invocationCallOrder[0]).toBeLessThan(writer.mock.invocationCallOrder[0]!);
    expect(JSON.stringify(audit.mock.calls)).not.toContain('/tmp/system.svg');
    expect(result).toEqual({ ok: true, value: { fileName: 'system.svg' } });
  });

  it('fails closed before writing when the required export audit cannot persist', async () => {
    electronMock.fromWebContents.mockReturnValue({ isDestroyed: () => false });
    const dialog = {
      showSaveDialog: vi.fn().mockResolvedValue({ canceled: false, filePath: '/tmp/system.svg' }),
    };
    const writer = vi.fn();
    const audit = vi.fn((_action, outcome) => {
      if (outcome === 'allowed') throw new Error('audit unavailable');
    });
    new DiagramExportService(dialog as never, undefined, writer, audit).registerIpcHandler();

    const result = await handler()(liveEvent(), {
      fileName: 'system.svg',
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>System</text></svg>',
    });
    expect(result).toMatchObject({ ok: false, error: { message: 'audit unavailable' } });
    expect(writer).not.toHaveBeenCalled();
    expect(audit.mock.calls.at(-1)?.slice(0, 2)).toEqual(['diagram-svg', 'failed']);
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

  it('records a redacted denial when native export selection is cancelled', async () => {
    electronMock.fromWebContents.mockReturnValue({ isDestroyed: () => false });
    const dialog = { showSaveDialog: vi.fn().mockResolvedValue({ canceled: true }) };
    const writer = vi.fn();
    const audit = vi.fn();
    new DiagramExportService(dialog as never, undefined, writer, audit).registerIpcHandler();

    await expect(
      handler()(liveEvent(), {
        fileName: 'system.svg',
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>System</text></svg>',
      }),
    ).resolves.toEqual({ ok: true, value: null });
    expect(writer).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith('diagram-svg', 'denied', {
      reason: 'native-save-cancelled',
    });
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
