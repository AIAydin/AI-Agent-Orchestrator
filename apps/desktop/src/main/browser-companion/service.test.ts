import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PreviewAgentBrowser } from '../previews/webview/preview-agent-browser.js';
import { BrowserCompanionService } from './service.js';

class FakeChrome extends EventEmitter {
  readonly stdio = [null, null, null, new PassThrough(), new PassThrough()];
  readonly pid = 1234;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  pageUrl = 'about:blank';
  invalidSessionOnce = false;
  attachmentCount = 0;
  elementDescriptor = {
    connected: true,
    kind: 'button',
    name: 'Add card',
    disabled: false,
    editable: false,
    sensitive: false,
    consequential: false,
    userOnly: false,
    opensNewWindow: false,
    destination: null,
  };
  elementHitMatches = true;
  readonly commands: Array<{
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
  }> = [];

  constructor() {
    super();
    (this.stdio[3] as PassThrough).on('data', (chunk: Buffer) => {
      for (const raw of chunk.toString('utf8').split('\0')) {
        if (raw === '') continue;
        const command = JSON.parse(raw) as {
          id: number;
          method: string;
          params?: Record<string, unknown>;
          sessionId?: string;
        };
        this.#respond(command);
      }
    });
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true;
    this.signalCode = signal;
    this.emit('exit', null, signal);
    return true;
  }

  emitScreencastFrame(data = Buffer.from('jpeg').toString('base64')): void {
    (this.stdio[4] as PassThrough).write(
      `${JSON.stringify({
        method: 'Page.screencastFrame',
        sessionId: `session-${this.attachmentCount}`,
        params: { data, sessionId: 41 },
      })}\0`,
    );
  }

  emitTargetCreated(targetId = 'popup-1'): void {
    (this.stdio[4] as PassThrough).write(
      `${JSON.stringify({
        method: 'Target.targetCreated',
        params: {
          targetInfo: { targetId, type: 'page', url: 'https://popup.example/' },
        },
      })}\0`,
    );
  }

  #respond(command: {
    id: number;
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
  }): void {
    this.commands.push(command);
    if (command.method === 'Target.attachToTarget') this.attachmentCount += 1;
    if (command.method === 'Page.navigate' && typeof command.params?.['url'] === 'string') {
      this.pageUrl = command.params['url'];
    }
    queueMicrotask(() => {
      if (command.method === 'Runtime.evaluate' && this.invalidSessionOnce) {
        this.invalidSessionOnce = false;
        (this.stdio[4] as PassThrough).write(
          `${JSON.stringify({
            id: command.id,
            error: { message: 'Session with given id not found.' },
          })}\0`,
        );
        return;
      }
      const result = fakeResult(
        command.method,
        command.params,
        this.pageUrl,
        this.attachmentCount,
        this.elementDescriptor,
        this.elementHitMatches,
      );
      (this.stdio[4] as PassThrough).write(`${JSON.stringify({ id: command.id, result })}\0`);
      if (command.method === 'Browser.close') {
        this.exitCode = 0;
        this.emit('exit', 0, null);
      }
    });
  }
}

function fakeResult(
  method: string,
  params: Record<string, unknown> | undefined,
  pageUrl: string,
  attachmentCount: number,
  elementDescriptor: Record<string, unknown>,
  elementHitMatches: boolean,
): unknown {
  if (method === 'Browser.getVersion') return { product: 'Chrome/150.0.0.0' };
  if (method === 'Target.getTargets') {
    return {
      targetInfos: [{ targetId: 'target-1', type: 'page', url: pageUrl }],
    };
  }
  if (method === 'Target.attachToTarget') return { sessionId: `session-${attachmentCount}` };
  if (method === 'Page.getFrameTree') {
    return {
      frameTree: {
        frame: { id: 'frame-1', loaderId: 'loader-1', url: pageUrl },
      },
    };
  }
  if (method === 'Page.createIsolatedWorld') return { executionContextId: 19 };
  if (method === 'Page.getNavigationHistory') {
    return {
      currentIndex: 1,
      entries: [{ id: 1 }, { id: 2 }, { id: 3 }],
    };
  }
  if (method === 'Page.captureScreenshot') return { data: Buffer.from('png').toString('base64') };
  if (method === 'Runtime.evaluate') {
    const rawExpression = params?.['expression'];
    const expression = typeof rawExpression === 'string' ? rawExpression : '';
    if (expression.includes('document.querySelectorAll(selector)')) {
      return { result: { objectId: 'elements-array-1' } };
    }
    if (expression === 'document.title.slice(0, 1024)') {
      return { result: { value: 'Miro board' } };
    }
    return expression.includes('innerText')
      ? {
          result: {
            value: {
              url: pageUrl,
              title: 'Miro board',
              text: 'Visible board',
              dom: '<html><body>Visible board</body></html>',
            },
          },
        }
      : {
          result: { value: { url: pageUrl, title: 'Miro board' } },
        };
  }
  if (method === 'Runtime.getProperties') {
    return {
      result: [{ name: '0', value: { objectId: 'element-1' } }, { name: 'length' }],
    };
  }
  if (method === 'Runtime.callFunctionOn') {
    const declaration =
      typeof params?.['functionDeclaration'] === 'string' ? params['functionDeclaration'] : '';
    if (declaration.includes('return this.map(describe)')) {
      return { result: { value: [elementDescriptor] } };
    }
    if (declaration.includes('return describe(this)')) {
      return { result: { value: elementDescriptor } };
    }
    if (declaration.includes('getBoundingClientRect')) {
      return {
        result: {
          value: {
            connected: true,
            hitMatches: elementHitMatches,
            x: 20,
            y: 30,
            width: 120,
            height: 40,
          },
        },
      };
    }
    if (declaration.includes('this.focus')) return { result: { value: true } };
  }
  return {};
}

describe('BrowserCompanionService', () => {
  let root: string;
  let previewBrowser: PreviewAgentBrowser;
  let chrome: FakeChrome;
  let service: BrowserCompanionService;
  const spawnChrome = vi.fn();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeboard-browser-companion-test-'));
    previewBrowser = new PreviewAgentBrowser();
    chrome = new FakeChrome();
    spawnChrome.mockReset();
    spawnChrome.mockReturnValue(chrome);
    service = new BrowserCompanionService({
      userDataPath: root,
      previewBrowser,
      findExecutable: () => '/Applications/Google Chrome',
      spawnChrome: spawnChrome as never,
    });
  });

  afterEach(async () => {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('launches Chrome with a dedicated profile and private pipe, then exposes read-only inspection', async () => {
    const status = await service.open({
      projectId: 'project-1',
      nodeId: 'preview-1',
      url: 'https://miro.com/',
    });

    expect(status).toMatchObject({ state: 'connected', title: 'Miro board' });
    expect(spawnChrome).toHaveBeenCalledWith(
      '/Applications/Google Chrome',
      expect.arrayContaining([
        '--remote-debugging-pipe',
        expect.stringMatching(/^--user-data-dir=/u),
        'about:blank',
      ]),
      expect.objectContaining({
        stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
      }),
    );
    expect(previewBrowser.isLive('project-1', 'preview-1')).toBe(true);
    const downloadPolicyIndex = chrome.commands.findIndex(
      (command) => command.method === 'Browser.setDownloadBehavior',
    );
    const initialNavigationIndex = chrome.commands.findIndex(
      (command) => command.method === 'Page.navigate',
    );
    expect(downloadPolicyIndex).toBeGreaterThanOrEqual(0);
    expect(initialNavigationIndex).toBeGreaterThan(downloadPolicyIndex);
    await expect(previewBrowser.inspect('project-1', 'preview-1')).resolves.toMatchObject({
      title: 'Miro board',
      text: 'Visible board',
      console: [],
    });
    await expect(
      service.snapshot({ projectId: 'project-1', nodeId: 'preview-1' }),
    ).resolves.toEqual({
      mimeType: 'image/png',
      data: Buffer.from('png').toString('base64'),
    });
  });

  it('rejects non-HTTPS external URLs before spawning Chrome', async () => {
    await expect(
      service.open({
        projectId: 'project-1',
        nodeId: 'preview-1',
        url: 'http://example.com/',
      }),
    ).rejects.toThrow(/HTTPS/u);
    expect(spawnChrome).not.toHaveBeenCalled();
  });

  it('forwards viewport, pointer, and navigation commands to the attached Chrome tab', async () => {
    await service.open({
      projectId: 'project-1',
      nodeId: 'preview-1',
      url: 'https://miro.com/',
    });
    await service.setViewport({
      projectId: 'project-1',
      nodeId: 'preview-1',
      width: 900,
      height: 600,
    });
    await service.dispatchInput({
      projectId: 'project-1',
      nodeId: 'preview-1',
      event: {
        kind: 'pointer',
        type: 'mousePressed',
        x: 120,
        y: 80,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      },
    });
    await service.navigate({
      projectId: 'project-1',
      nodeId: 'preview-1',
      action: 'back',
    });

    const viewportCommand = chrome.commands.find(
      (command) => command.method === 'Emulation.setDeviceMetricsOverride',
    );
    expect(viewportCommand?.params).toMatchObject({ width: 900, height: 600 });
    const pointerCommand = chrome.commands.find(
      (command) => command.method === 'Input.dispatchMouseEvent',
    );
    expect(pointerCommand?.params).toMatchObject({
      type: 'mousePressed',
      x: 120,
      y: 80,
    });
    const navigationCommand = chrome.commands.find(
      (command) => command.method === 'Page.navigateToHistoryEntry',
    );
    expect(navigationCommand?.params).toEqual({ entryId: 1 });
  });

  it('exposes page-bound element handles and performs only a revalidated approved action', async () => {
    await service.open({
      projectId: 'project-1',
      nodeId: 'preview-1',
      url: 'https://miro.com/',
    });

    const inspected = await previewBrowser.elements('project-1', 'preview-1');
    expect(inspected.url).toBe('https://miro.com/');
    expect(inspected.elements).toHaveLength(1);
    const handle = inspected.elements[0]?.handle ?? '';
    expect(handle).toMatch(/^[0-9a-f-]{36}$/u);

    const action = { kind: 'click' as const, elementHandle: handle };
    const intent = await previewBrowser.describeAction('project-1', 'preview-1', action);
    expect(intent).toMatchObject({
      action: 'click',
      origin: 'https://miro.com',
      element: { name: 'Add card', userOnly: false },
    });
    await expect(
      previewBrowser.performAction('project-1', 'preview-1', action, intent.pageVersion),
    ).resolves.toMatchObject({ performed: true });
    chrome.emitTargetCreated();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

    expect(chrome.commands).toContainEqual(
      expect.objectContaining({
        method: 'Browser.setDownloadBehavior',
        params: { behavior: 'deny' },
      }),
    );
    expect(
      chrome.commands.filter((command) => command.method === 'Input.dispatchMouseEvent'),
    ).toHaveLength(2);
    expect(chrome.commands).toContainEqual(
      expect.objectContaining({
        method: 'Target.closeTarget',
        params: { targetId: 'popup-1' },
      }),
    );
  });

  it('blocks agent entry into secret and authentication controls before approval', async () => {
    chrome.elementDescriptor = {
      connected: true,
      kind: 'text-input',
      name: 'Password',
      disabled: false,
      editable: true,
      sensitive: true,
      consequential: true,
      userOnly: true,
      opensNewWindow: false,
      destination: null,
    };
    await service.open({
      projectId: 'project-1',
      nodeId: 'preview-1',
      url: 'https://miro.com/',
    });
    const inspected = await previewBrowser.elements('project-1', 'preview-1');
    const handle = inspected.elements[0]?.handle ?? '';
    await expect(
      previewBrowser.describeAction('project-1', 'preview-1', {
        kind: 'type',
        elementHandle: handle,
        text: 'never-share-this',
        replace: true,
      }),
    ).rejects.toThrow('preview-action-requires-user');
    expect(chrome.commands.some((command) => command.method === 'Input.insertText')).toBe(false);
  });

  it('rejects a click when another page element covers the approved control', async () => {
    await service.open({
      projectId: 'project-1',
      nodeId: 'preview-1',
      url: 'https://miro.com/',
    });
    const inspected = await previewBrowser.elements('project-1', 'preview-1');
    const handle = inspected.elements[0]?.handle ?? '';
    const action = { kind: 'click' as const, elementHandle: handle };
    const intent = await previewBrowser.describeAction('project-1', 'preview-1', action);
    chrome.elementHitMatches = false;

    await expect(
      previewBrowser.performAction('project-1', 'preview-1', action, intent.pageVersion),
    ).rejects.toThrow('preview-element-not-visible');
    expect(chrome.commands.some((command) => command.method === 'Input.dispatchMouseEvent')).toBe(
      false,
    );
  });

  it('streams compressed Chrome frames once and acknowledges them immediately', async () => {
    await service.open({
      projectId: 'project-1',
      nodeId: 'preview-1',
      url: 'https://miro.com/',
    });
    chrome.emitScreencastFrame();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

    expect(
      service.frame({
        projectId: 'project-1',
        nodeId: 'preview-1',
        afterSequence: 0,
      }),
    ).toEqual({
      sequence: 1,
      mimeType: 'image/jpeg',
      data: Buffer.from('jpeg').toString('base64'),
    });
    expect(
      service.frame({
        projectId: 'project-1',
        nodeId: 'preview-1',
        afterSequence: 1,
      }),
    ).toBeNull();
    expect(chrome.commands).toContainEqual(
      expect.objectContaining({
        method: 'Page.screencastFrameAck',
        params: { sessionId: 41 },
      }),
    );
  });

  it('recovers when Chrome replaces the attached page session', async () => {
    await service.open({
      projectId: 'project-1',
      nodeId: 'preview-1',
      url: 'https://miro.com/',
    });
    chrome.invalidSessionOnce = true;

    await expect(
      service.status({ projectId: 'project-1', nodeId: 'preview-1' }),
    ).resolves.toMatchObject({ state: 'connected', title: 'Miro board' });
    expect(chrome.attachmentCount).toBe(2);
  });

  it('does not carry agent consent across a manual cross-origin navigation', async () => {
    await service.open({
      projectId: 'project-1',
      nodeId: 'preview-1',
      url: 'https://miro.com/',
    });
    chrome.pageUrl = 'https://accounts.google.com/';

    await expect(previewBrowser.inspect('project-1', 'preview-1')).rejects.toThrow(
      'preview-origin-changed',
    );
    await expect(previewBrowser.screenshot('project-1', 'preview-1')).rejects.toThrow(
      'preview-origin-changed',
    );
  });

  it('privacy reset closes Chrome, revokes agent access, and clears all companion profiles', async () => {
    await service.open({
      projectId: 'project-1',
      nodeId: 'preview-1',
      url: 'https://miro.com/',
    });
    await service.resetForPrivacy();
    expect(previewBrowser.isLive('project-1', 'preview-1')).toBe(false);
    expect(chrome.exitCode).toBe(0);
    await expect(
      service.status({ projectId: 'project-1', nodeId: 'preview-1' }),
    ).resolves.toMatchObject({
      state: 'closed',
    });
  });
});
