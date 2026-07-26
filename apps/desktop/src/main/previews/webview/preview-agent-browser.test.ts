import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { PreviewAgentBrowser } from './preview-agent-browser.js';

class FakeGuest extends EventEmitter {
  destroyed = false;
  currentUrl = 'https://miro.com/app/board';
  executeJavaScript = vi.fn(() =>
    Promise.resolve({
      url: 'https://miro.com/app/board?token=secret#private',
      title: 'Planning board',
      text: 'Visible board text <not markup>',
      dom: '<html data-secret="hidden"><body><input value="password">Visible board text</body></html>',
    }),
  );
  capturePage = vi.fn(() => Promise.resolve({ toPNG: () => Buffer.from('png bytes', 'utf8') }));
  loadURL = vi.fn(() => Promise.resolve());
  isDestroyed(): boolean {
    return this.destroyed;
  }
  getURL(): string {
    return this.currentUrl;
  }
  destroy(): void {
    this.destroyed = true;
    this.emit('destroyed');
  }
}

describe('PreviewAgentBrowser', () => {
  it('exposes bounded inspection data without leaking console output from a live guest', async () => {
    const browser = new PreviewAgentBrowser();
    const guest = new FakeGuest();
    browser.registerGuest('persist:preview:project-1:preview-1', guest as never);
    guest.emit('console-message', {}, 1, 'loaded board');

    expect(browser.isLive('project-1', 'preview-1')).toBe(true);
    await expect(browser.inspect('project-1', 'preview-1')).resolves.toEqual({
      url: 'https://miro.com/app/board',
      title: 'Planning board',
      text: 'Visible board text <not markup>',
      dom: '<body>Visible board text &lt;not markup&gt;</body>',
      console: [],
    });
    expect(guest.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('innerText'),
      true,
    );
  });

  it('returns PNG screenshots and removes destroyed guests', async () => {
    const browser = new PreviewAgentBrowser();
    const guest = new FakeGuest();
    browser.registerGuest('preview:project-1:preview-1', guest as never);

    await expect(browser.screenshot('project-1', 'preview-1')).resolves.toEqual({
      mimeType: 'image/png',
      data: Buffer.from('png bytes', 'utf8').toString('base64'),
    });
    guest.destroy();
    expect(browser.isLive('project-1', 'preview-1')).toBe(false);
    await expect(browser.inspect('project-1', 'preview-1')).rejects.toThrow('preview-not-live');
  });

  it('shares console output and a DOM outline for a loopback guest', async () => {
    const browser = new PreviewAgentBrowser();
    const guest = new FakeGuest();
    guest.executeJavaScript.mockResolvedValue({
      url: 'http://localhost:5173/dashboard',
      title: 'Dashboard',
      text: 'Revenue up',
      dom: '<main><h1>Revenue up</h1></main>',
    });
    browser.registerGuest('preview:project-1:preview-1', guest as never);
    guest.emit('console-message', { level: 'error', message: 'fetch failed' });

    await expect(browser.inspect('project-1', 'preview-1')).resolves.toEqual({
      url: 'http://localhost:5173/dashboard',
      title: 'Dashboard',
      text: 'Revenue up',
      dom: '<main><h1>Revenue up</h1></main>',
      console: ['[error] fetch failed'],
    });
  });

  it('navigates a loopback guest within its origin and refuses sources without navigate', async () => {
    const browser = new PreviewAgentBrowser();
    const guest = new FakeGuest();
    guest.currentUrl = 'http://localhost:5173/dashboard';
    browser.registerGuest('preview:project-1:preview-1', guest as never);

    await expect(
      browser.navigate('project-1', 'preview-1', 'http://localhost:5173/settings'),
    ).resolves.toEqual({ url: 'http://localhost:5173/settings' });
    expect(guest.loadURL).toHaveBeenCalledWith('http://localhost:5173/settings');
    await expect(
      browser.navigate('project-1', 'preview-1', 'https://example.com/'),
    ).rejects.toThrow('preview-navigation-blocked');

    browser.registerSource('project-1', 'companion-1', {
      isLive: () => true,
      inspect: () => Promise.reject(new Error('unused')),
      screenshot: () => Promise.reject(new Error('unused')),
    });
    await expect(
      browser.navigate('project-1', 'companion-1', 'http://localhost:5173/'),
    ).rejects.toThrow('preview-interaction-unavailable');
  });

  it('keeps the primary guest when a comparison-slot guest registers afterward', async () => {
    const browser = new PreviewAgentBrowser();
    const primary = new FakeGuest();
    const comparison = new FakeGuest();
    comparison.executeJavaScript.mockResolvedValue({
      url: 'https://example.com/comparison',
      title: 'Comparison',
      text: 'comparison',
      dom: '<html></html>',
    });
    browser.registerGuest('preview:project-1:preview-1', primary as never);
    browser.registerGuest('preview:project-1:preview-1:left', comparison as never);

    const inspection = await browser.inspect('project-1', 'preview-1');
    expect(inspection.title).toBe('Planning board');
    expect(comparison.executeJavaScript).not.toHaveBeenCalled();
  });
});
