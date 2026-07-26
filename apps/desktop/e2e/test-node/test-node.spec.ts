import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';

import {
  closeElectronAfterTest,
  launchDesktop,
  watchExternalRequests,
} from '../support/electron.js';

const SIDE_EFFECT_FILE = 'forgeboard-test-node-ran.txt';
const COMMAND_LINE = `node -e "require('node:fs').writeFileSync('${SIDE_EFFECT_FILE}','ran')"`;
const DESCRIPTION = 'Writes a file if it ever runs.';

/**
 * The Test node is now a single command line, a description, and Run with an output preview.
 * The exact command the user typed has to survive a full restart, nothing may execute until the
 * user actually asks for a run, and Run alone has to be enough to execute it.
 */
test('a Test node keeps its exact command line across a restart and runs it on request', async () => {
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'forgeboard-test-node-e2e-'));
  const sideEffectPath = join(userDataDirectory, 'demo', 'forgeboard-demo', SIDE_EFFECT_FILE);
  let electronApp: ElectronApplication | null = null;
  const externalRequests: string[] = [];

  try {
    const firstSession = await launchDesktop(userDataDirectory);
    electronApp = firstSession.app;
    let page = firstSession.page;
    watchExternalRequests(page, externalRequests);
    await installDenyAllNativeDialogs(electronApp);
    await openSafeDemo(page);

    let panel = await addAndSelectTestNode(page);
    await test.step('one command line and a description are edited in place', async () => {
      await panel.getByLabel('Command').fill(COMMAND_LINE);
      await panel.getByLabel('Description').fill(DESCRIPTION);
      await expect(panel.getByLabel('Command')).toHaveValue(COMMAND_LINE);
      await expect(panel.locator('.node-face-strip .node-face-status')).toHaveText('Not run');
      await expect(page.locator('.autosave-state')).toContainText('Saved locally');
    });

    await electronApp.close();
    electronApp = null;

    const restoredSession = await launchDesktop(userDataDirectory);
    electronApp = restoredSession.app;
    page = restoredSession.page;
    watchExternalRequests(page, externalRequests);
    await expect(page.locator('.setup-shell')).toHaveCount(0);
    await page.locator('.recent-list button').click();

    await test.step('restart restores the exact command and description, still unrun', async () => {
      panel = await selectTestNode(page);
      await expect(panel.getByLabel('Command')).toHaveValue(COMMAND_LINE);
      await expect(panel.getByLabel('Description')).toHaveValue(DESCRIPTION);
      await expect(panel.locator('.node-face-strip .node-face-status')).toHaveText('Not run');
      // Configuring a command must never be enough to execute it.
      await expect(access(sideEffectPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    await test.step('Run executes that exact command and reports the result on the node', async () => {
      await panel.getByRole('button', { name: 'Run' }).click();
      await expect(panel.locator('.node-face-strip .node-face-status')).toHaveText('Passed', {
        timeout: 60_000,
      });
      await expect(access(sideEffectPath)).resolves.toBeUndefined();
    });

    expect(externalRequests).toEqual([]);
  } finally {
    await closeElectronAfterTest(electronApp);
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

async function openSafeDemo(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Use safe defaults' }).click();
  await page.getByRole('button', { name: /Explore the safe demo/i }).click();
  await expect(page.locator('.project-switcher')).toContainText('forgeboard-demo');
}

async function addAndSelectTestNode(page: Page) {
  await page.locator('.template-section').getByRole('button', { name: /^Test/ }).click();
  return await selectTestNode(page);
}

async function selectTestNode(page: Page) {
  await page.getByRole('article', { name: /^Test: /u }).click();
  const panel = page.getByRole('region', { name: 'Test runner' });
  await expect(panel).toBeVisible();
  return panel;
}

/** Any native confirmation reached from this flow must be refused, never silently approved. */
async function installDenyAllNativeDialogs(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    Object.defineProperty(dialog, 'showMessageBox', {
      configurable: true,
      value: () => Promise.resolve({ response: 0, checkboxChecked: false }),
    });
  });
}
