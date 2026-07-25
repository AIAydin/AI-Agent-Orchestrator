import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  createGuestAgentSource,
  formattedConsoleMessage,
  type PreviewGuestContents,
} from './preview-guest-agent.js';

const LOCAL_PAGE = {
  url: 'http://localhost:5173/dashboard',
  title: 'Dashboard',
  text: 'Revenue up',
  dom: '<main id="app"><h1>Revenue up</h1></main>',
};

class FakeGuest extends EventEmitter {
  destroyed = false;
  currentUrl = 'http://localhost:5173/dashboard';
  worldReplies: unknown[] = [];
  executeJavaScript = vi.fn((_code: string, _gesture?: boolean) => Promise.resolve<unknown>(LOCAL_PAGE));
  executeJavaScriptInIsolatedWorld = vi.fn((_world: number, _scripts: Array<{ code: string }>) =>
    Promise.resolve<unknown>(this.worldReplies.shift()),
  );
  capturePage = vi.fn(() => Promise.resolve({ toPNG: () => Buffer.from('png bytes', 'utf8') }));
  loadURL = vi.fn((_url: string) => Promise.resolve());
  sendInputEvent = vi.fn();
  insertText = vi.fn((_text: string) => Promise.resolve());
  isDestroyed(): boolean {
    return this.destroyed;
  }
  getURL(): string {
    return this.currentUrl;
  }
}

function guest(): { contents: FakeGuest; source: ReturnType<typeof createGuestAgentSource> } {
  const contents = new FakeGuest();
  return { contents, source: createGuestAgentSource(contents as PreviewGuestContents) };
}

const DESCRIPTOR = {
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

async function scannedHandle(
  contents: FakeGuest,
  source: ReturnType<typeof createGuestAgentSource>,
  descriptor: Record<string, unknown> = DESCRIPTOR,
): Promise<{ handle: string; pageVersion: string }> {
  contents.worldReplies.push(JSON.stringify({ title: 'Dashboard', descriptors: [descriptor] }));
  const elements = await source.source.elements!();
  return { handle: elements.elements[0]!.handle, pageVersion: elements.pageVersion };
}

describe('createGuestAgentSource', () => {
  it('shares console output and a DOM outline for the loopback page', async () => {
    const { contents, source } = guest();
    contents.emit('console-message', { level: 'error', message: 'boom at line 3' });
    contents.emit('console-message', {}, 1, 'legacy info entry');
    await expect(source.source.inspect()).resolves.toEqual({
      url: 'http://localhost:5173/dashboard',
      title: 'Dashboard',
      text: 'Revenue up',
      dom: '<main id="app"><h1>Revenue up</h1></main>',
      console: ['[error] boom at line 3', '[info] legacy info entry'],
    });
  });

  it('stops sharing console output once disposed', async () => {
    const { contents, source } = guest();
    source.dispose();
    contents.emit('console-message', { level: 'error', message: 'after dispose' });
    await expect(source.source.inspect()).resolves.toMatchObject({ console: [] });
  });

  it('falls back to the visible-text projection for non-loopback pages', async () => {
    const { contents, source } = guest();
    contents.executeJavaScript.mockResolvedValue({
      url: 'https://miro.com/app/board',
      title: 'Planning board',
      text: 'Visible <text>',
      dom: '<input value="secret">',
    });
    contents.emit('console-message', { level: 'error', message: 'private' });
    await expect(source.source.inspect()).resolves.toEqual({
      url: 'https://miro.com/app/board',
      title: 'Planning board',
      text: 'Visible <text>',
      dom: '<body>Visible &lt;text&gt;</body>',
      console: [],
    });
  });

  it('lists elements with fresh opaque handles and drops malformed descriptors', async () => {
    const { contents, source } = guest();
    contents.worldReplies.push(
      JSON.stringify({
        title: 'Dashboard',
        descriptors: [DESCRIPTOR, { ...DESCRIPTOR, sensitive: 'no' }],
      }),
    );
    const elements = await source.source.elements!();
    expect(elements.url).toBe('http://localhost:5173/dashboard');
    expect(elements.elements).toHaveLength(1);
    expect(elements.elements[0]).toMatchObject({ kind: 'button', name: 'Add card' });
    expect(elements.elements[0]!.handle).toMatch(/^[0-9a-f-]{36}$/u);
    expect(elements.pageVersion).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('refuses element listing when the guest is not on a loopback page', async () => {
    const { contents, source } = guest();
    contents.currentUrl = 'about:blank';
    await expect(source.source.elements!()).rejects.toThrow('preview-elements-unavailable');
  });

  it('reports a changed page when the in-page registry nonce is gone', async () => {
    const { contents, source } = guest();
    const { handle } = await scannedHandle(contents, source);
    contents.worldReplies.push(JSON.stringify({ state: 'page-changed' }));
    await expect(
      source.source.describeAction!({ kind: 'click', elementHandle: handle }),
    ).rejects.toThrow('preview-page-changed');
  });

  it('rejects unknown handles and mutated elements', async () => {
    const { contents, source } = guest();
    await expect(
      source.source.describeAction!({ kind: 'click', elementHandle: 'nope' }),
    ).rejects.toThrow('preview-element-handle-invalid');
    const { handle } = await scannedHandle(contents, source);
    contents.worldReplies.push(
      JSON.stringify({ state: 'ok', descriptor: { ...DESCRIPTOR, name: 'Delete board' } }),
    );
    await expect(
      source.source.describeAction!({ kind: 'click', elementHandle: handle }),
    ).rejects.toThrow('preview-element-changed');
  });

  it('blocks user-only controls and sensitive text entry', async () => {
    const { contents, source } = guest();
    const userOnly = { ...DESCRIPTOR, userOnly: true };
    const { handle } = await scannedHandle(contents, source, userOnly);
    contents.worldReplies.push(JSON.stringify({ state: 'ok', descriptor: userOnly }));
    await expect(
      source.source.describeAction!({ kind: 'click', elementHandle: handle }),
    ).rejects.toThrow('preview-action-requires-user');

    const plainButton = await scannedHandle(contents, source);
    contents.worldReplies.push(JSON.stringify({ state: 'ok', descriptor: DESCRIPTOR }));
    await expect(
      source.source.describeAction!({
        kind: 'type',
        elementHandle: plainButton.handle,
        text: 'hello',
        replace: true,
      }),
    ).rejects.toThrow('preview-sensitive-entry-blocked');
  });

  it('performs an approved click as trusted input at the element center', async () => {
    const { contents, source } = guest();
    const { handle, pageVersion } = await scannedHandle(contents, source);
    contents.worldReplies.push(JSON.stringify({ state: 'ok', descriptor: DESCRIPTOR }));
    contents.worldReplies.push(
      JSON.stringify({ connected: true, hitMatches: true, x: 120.6, y: 48.2 }),
    );
    await expect(
      source.source.performAction!({ kind: 'click', elementHandle: handle }, pageVersion),
    ).resolves.toEqual({
      performed: true,
      pageVersion,
      url: 'http://localhost:5173/dashboard',
    });
    expect(contents.sendInputEvent).toHaveBeenCalledWith({
      type: 'mouseDown',
      x: 121,
      y: 48,
      button: 'left',
      clickCount: 1,
    });
    expect(contents.sendInputEvent).toHaveBeenCalledWith({
      type: 'mouseUp',
      x: 121,
      y: 48,
      button: 'left',
      clickCount: 1,
    });
  });

  it('refuses a click when the page version is stale or the element is covered', async () => {
    const { contents, source } = guest();
    const { handle, pageVersion } = await scannedHandle(contents, source);
    await expect(
      source.source.performAction!({ kind: 'click', elementHandle: handle }, 'stale-version'),
    ).rejects.toThrow('preview-page-changed');
    contents.worldReplies.push(JSON.stringify({ state: 'ok', descriptor: DESCRIPTOR }));
    contents.worldReplies.push(
      JSON.stringify({ connected: true, hitMatches: false, x: 10, y: 10 }),
    );
    await expect(
      source.source.performAction!({ kind: 'click', elementHandle: handle }, pageVersion),
    ).rejects.toThrow('preview-element-not-visible');
    expect(contents.sendInputEvent).not.toHaveBeenCalled();
  });

  it('types through focus plus trusted text insertion', async () => {
    const { contents, source } = guest();
    const editable = { ...DESCRIPTOR, kind: 'text-input', editable: true };
    const { handle, pageVersion } = await scannedHandle(contents, source, editable);
    contents.worldReplies.push(JSON.stringify({ state: 'ok', descriptor: editable }));
    contents.worldReplies.push(JSON.stringify({ focused: true }));
    await expect(
      source.source.performAction!(
        { kind: 'type', elementHandle: handle, text: 'hello world', replace: true },
        pageVersion,
      ),
    ).resolves.toMatchObject({ performed: true });
    expect(contents.insertText).toHaveBeenCalledWith('hello world');
  });

  it('navigates only within the committed loopback origin', async () => {
    const { contents, source } = guest();
    await expect(source.source.navigate!('http://localhost:5173/settings?tab=2')).resolves.toEqual({
      url: 'http://localhost:5173/settings',
    });
    expect(contents.loadURL).toHaveBeenCalledWith('http://localhost:5173/settings?tab=2');
    await expect(source.source.navigate!('http://localhost:9999/')).rejects.toThrow(
      'preview-navigation-blocked',
    );
    await expect(source.source.navigate!('https://example.com/')).rejects.toThrow(
      'preview-navigation-blocked',
    );
    await expect(source.source.navigate!('not a url')).rejects.toThrow(
      'preview-navigation-blocked',
    );
    expect(contents.loadURL).toHaveBeenCalledTimes(1);
  });

  it('blocks navigation entirely while the guest is off loopback', async () => {
    const { contents, source } = guest();
    contents.currentUrl = 'about:blank';
    await expect(source.source.navigate!('http://localhost:5173/')).rejects.toThrow(
      'preview-navigation-blocked',
    );
  });

  it('bounds scrolling and requires a non-zero delta', async () => {
    const { contents, source } = guest();
    await expect(source.source.scroll!(0)).rejects.toThrow('preview-scroll-delta-required');
    await expect(source.source.scroll!(5_000)).resolves.toMatchObject({
      url: 'http://localhost:5173/dashboard',
    });
    expect(contents.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('window.scrollBy({ top: 1200'),
      true,
    );
  });
});

describe('formattedConsoleMessage', () => {
  it('normalizes both console-message signatures and caps entry length', () => {
    expect(formattedConsoleMessage([{ level: 'warning', message: 'careful' }])).toBe(
      '[warning] careful',
    );
    expect(formattedConsoleMessage([{}, 3, 'legacy error'])).toBe('[error] legacy error');
    expect(formattedConsoleMessage([{}, 0, 'x'.repeat(2_000)])).toBe(
      `[debug] ${'x'.repeat(1_000)}`,
    );
    expect(formattedConsoleMessage(['nothing useful'])).toBeNull();
  });
});
