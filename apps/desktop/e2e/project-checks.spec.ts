import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { launchDesktop, watchExternalRequests } from './electron.js';

test('project checks configure, approve, execute, cancel, and persist entirely through the UI', async () => {
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'forgeboard-checks-e2e-'));
  let electronApp: ElectronApplication | null = null;
  const externalRequests: string[] = [];

  try {
    const firstSession = await launchDesktop(userDataDirectory);
    electronApp = firstSession.app;
    let page = firstSession.page;
    watchExternalRequests(page, externalRequests);

    await page.getByRole('button', { name: 'Use safe defaults' }).click();
    await configureChecks(page);
    await page.getByRole('button', { name: /Explore the safe demo/i }).click();

    await approveCheckDialogs(electronApp);
    await openChecksDrawer(page);

    const lint = checkCard(page, 'Lint');
    await expect(lint).toContainText('Not run');
    await lint.getByRole('button', { name: 'Run Lint' }).click();
    const lintDisclosure = page.getByRole('dialog', {
      name: 'Review the exact Lint command',
    });
    await expect(lintDisclosure).toContainText('node');
    await expect(lintDisclosure).toContainText('FORGEBOARD_CHECK_E2E');
    await expect(lintDisclosure).toContainText('No process has started');
    await lintDisclosure.getByRole('button', { name: /Continue to native approval/ }).click();
    await expect(lint).toContainText('passed');
    await expect(lint).toContainText('FORGEBOARD_CHECK_E2E');
    await expect(lint).toContainText('Exit 0');

    const tests = checkCard(page, 'Tests');
    await tests.getByRole('button', { name: 'Run Tests' }).click();
    const testDisclosure = page.getByRole('dialog', {
      name: 'Review the exact Tests command',
    });
    await testDisclosure.getByRole('button', { name: /Continue to native approval/ }).click();
    await expect(tests).toContainText('passed');
    await expect(tests).toContainText('FORGEBOARD_TEST_E2E');
    await expect(tests.getByRole('group', { name: 'Tests parsed test summary' })).toContainText(
      '2 passed0 failed1 skipped3 total',
    );

    const build = checkCard(page, 'Build');
    const runBuild = build.getByRole('button', { name: 'Run Build' });
    await expect(runBuild).toBeEnabled();
    await runBuild.click();
    const buildDisclosure = page.getByRole('dialog', {
      name: 'Review the exact Build command',
    });
    await buildDisclosure.getByRole('button', { name: /Continue to native approval/ }).click();
    await expect(build.getByRole('button', { name: 'Cancel Build' })).toBeVisible();
    await expect(build).toContainText('FORGEBOARD_CANCEL_E2E');
    await build.getByRole('button', { name: 'Cancel Build' }).click();
    await expect(build).toContainText('cancelled');

    await electronApp.close();
    electronApp = null;

    const secondSession = await launchDesktop(userDataDirectory);
    electronApp = secondSession.app;
    page = secondSession.page;
    watchExternalRequests(page, externalRequests);
    await page.locator('.recent-list button').click();
    await openChecksDrawer(page);

    await expect(checkCard(page, 'Lint')).toContainText('FORGEBOARD_CHECK_E2E');
    await expect(checkCard(page, 'Lint')).toContainText('passed');
    await expect(checkCard(page, 'Tests')).toContainText('FORGEBOARD_TEST_E2E');
    await expect(checkCard(page, 'Tests')).toContainText('passed');
    await expect(checkCard(page, 'Build')).toContainText('cancelled');

    await approveCheckDialogs(electronApp);
    const restartedBuild = checkCard(page, 'Build');
    await restartedBuild.getByRole('button', { name: 'Run Build' }).click();
    await page
      .getByRole('dialog', { name: 'Review the exact Build command' })
      .getByRole('button', { name: /Continue to native approval/ })
      .click();
    await expect(restartedBuild.getByRole('button', { name: 'Cancel Build' })).toBeVisible();
    const heartbeat = join(
      userDataDirectory,
      'demo',
      'forgeboard-demo',
      'forgeboard-check-heartbeat',
    );
    await expect.poll(async () => await fileSize(heartbeat)).toBeGreaterThan(1);

    await electronApp.close();
    electronApp = null;
    const stoppedSize = await fileSize(heartbeat);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    expect(await fileSize(heartbeat)).toBe(stoppedSize);
    expect(externalRequests).toEqual([]);
  } finally {
    await electronApp?.close().catch(() => undefined);
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

async function configureChecks(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.locator('.settings-modal');
  await settings.getByRole('button', { name: 'Checks', exact: true }).click();

  const lint = settings.getByRole('group', { name: 'Lint command' });
  await lint.getByLabel('Executable').fill('node');
  await lint
    .getByLabel('Arguments · one per line')
    .fill('-e\nprocess.stdout.write("FORGEBOARD_CHECK_E2E")');

  const tests = settings.getByRole('group', { name: 'Tests command' });
  await tests.getByLabel('Executable').fill('node');
  await tests
    .getByLabel('Arguments · one per line')
    .fill('-e\nprocess.stdout.write("Tests: 2 passed, 1 skipped, 3 total\\nFORGEBOARD_TEST_E2E")');

  const build = settings.getByRole('group', { name: 'Build command' });
  await build.getByLabel('Executable').fill('node');
  await build
    .getByLabel('Arguments · one per line')
    .fill(
      '-e\nconst fs=require("node:fs"); process.stdout.write("FORGEBOARD_CANCEL_E2E"); setInterval(() => fs.appendFileSync("forgeboard-check-heartbeat", "x"), 20)',
    );

  await settings.getByRole('button', { name: /Save settings/ }).click();
  await expect(settings).toBeHidden();
}

async function approveCheckDialogs(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ dialog }) => {
    Object.defineProperty(dialog, 'showMessageBox', {
      configurable: true,
      value: () => Promise.resolve({ response: 1, checkboxChecked: false }),
    });
  });
}

async function openChecksDrawer(page: Page): Promise<void> {
  const drawer = page.locator('.activity-drawer');
  await drawer.getByRole('tab', { name: /Checks/ }).click();
  await expect(drawer.getByRole('tabpanel', { name: 'Checks' })).toBeVisible();
}

function checkCard(page: Page, label: string) {
  return page.locator('.project-check-card').filter({
    has: page.getByText(label, { exact: true }),
  });
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}
