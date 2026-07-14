import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

export interface ElectronSession {
  app: ElectronApplication;
  page: Page;
}

const desktopRoot = resolve(import.meta.dirname, '..');
const mainEntry = join(desktopRoot, 'dist', 'main', 'index.js');
const require = createRequire(import.meta.url);

export async function launchDesktop(userDataDirectory: string): Promise<ElectronSession> {
  await access(mainEntry);

  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
  delete environment.ELECTRON_RENDERER_URL;
  delete environment.ELECTRON_RUN_AS_NODE;

  const app = await electron.launch({
    executablePath: require('electron') as string,
    cwd: desktopRoot,
    args: [mainEntry, `--user-data-dir=${userDataDirectory}`],
    env: environment,
    timeout: 30_000,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

export function watchExternalRequests(page: Page, externalRequests: string[]): void {
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'wss:') &&
      url.hostname !== '127.0.0.1' &&
      url.hostname !== 'localhost' &&
      url.hostname !== '::1'
    ) {
      externalRequests.push(request.url());
    }
  });
}
