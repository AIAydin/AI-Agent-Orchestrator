import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, test, type ElectronApplication } from '@playwright/test';

import {
  closeElectronAfterTest,
  launchDesktop,
  watchNetworkRequests,
} from '../support/electron.js';
import { readTripwireLog } from './fixtures/tripwire-log.js';

const desktopRoot = resolve(import.meta.dirname, '../..');
const tripwireEntry = resolve(import.meta.dirname, 'fixtures/scripts/default-solo-tripwire.mjs');
const realMainEntry = join(desktopRoot, 'dist/main/index.js');

test('first launch, safe demo, idle, shutdown, and relaunch stay local by default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-default-solo-network-e2e-'));
  const userDataDirectory = join(root, 'user-data');
  const logPath = join(root, 'network-attempts.jsonl');
  const rendererRequests: string[] = [];
  let app: ElectronApplication | null = null;

  try {
    const first = await launchWithTripwire(userDataDirectory, logPath);
    app = first.app;
    watchNetworkRequests(first.page, rendererRequests);
    await first.page.getByRole('button', { name: 'Use safe defaults' }).click();
    await expect(
      first.page.getByRole('heading', {
        name: /Build software in a visual workshop/i,
      }),
    ).toBeVisible();
    await first.page.getByRole('button', { name: /Explore the safe demo/i }).click();
    await expect(first.page.locator('.canvas-title')).toContainText('0 nodes · 0 connections');
    await first.page.waitForTimeout(750);
    await app.close();
    app = null;

    const second = await launchWithTripwire(userDataDirectory, logPath);
    app = second.app;
    watchNetworkRequests(second.page, rendererRequests);
    await expect(second.page.locator('.setup-shell')).toHaveCount(0);
    const recent = second.page.locator('.recent-list button');
    await expect(recent).toHaveCount(1);
    await recent.click();
    await expect(second.page.locator('.canvas-title')).toContainText('0 nodes · 0 connections');
    await second.page.waitForTimeout(750);
    await app.close();
    app = null;

    expect(rendererRequests).toEqual([]);
    expect(await readTripwireLog(logPath)).toEqual([
      { pid: expect.any(Number), target: 'local', transport: 'tripwire.entry' },
      { pid: expect.any(Number), target: 'local', transport: 'tripwire.bootstrap' },
      { pid: expect.any(Number), target: 'local', transport: 'tripwire.ready' },
      { pid: expect.any(Number), target: 'local', transport: 'tripwire.entry' },
      { pid: expect.any(Number), target: 'local', transport: 'tripwire.bootstrap' },
      { pid: expect.any(Number), target: 'local', transport: 'tripwire.ready' },
    ]);
  } catch (error) {
    const startupRecords = await readTripwireLog(logPath);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} Tripwire startup records: ${JSON.stringify(startupRecords)}`,
      { cause: error },
    );
  } finally {
    await closeElectronAfterTest(app);
    await rm(root, { recursive: true, force: true });
  }
});

async function launchWithTripwire(userDataDirectory: string, logPath: string) {
  return await launchDesktop(userDataDirectory, {
    entry: tripwireEntry,
    environment: {
      FORGEBOARD_E2E_REAL_MAIN: realMainEntry,
      FORGEBOARD_E2E_TRIPWIRE_LOG: logPath,
    },
  });
}
