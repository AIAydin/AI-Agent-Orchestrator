import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, expect, type ElectronApplication } from '@playwright/test';

import { closeElectronAfterTest, launchDesktop } from './support/electron.js';

test('the project rail stays bounded and can give its space back to the canvas', async () => {
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'forgeboard-rail-layout-'));
  const managedWorktreeRoot = join(await realpath(userDataDirectory), 'managed-worktrees');
  let electronApp: ElectronApplication | null = null;
  try {
    const session = await launchDesktop(userDataDirectory);
    electronApp = session.app;
    const page = session.page;

    await page.getByRole('button', { name: 'Use safe defaults' }).click();
    await page.getByRole('button', { name: 'Settings' }).click();
    const settings = page.locator('.settings-modal');
    await settings.getByRole('button', { name: /Git & previews/ }).click();
    await settings.getByLabel('Managed worktree location').fill(managedWorktreeRoot);
    const save = settings.getByRole('button', { name: /Save settings/ });
    await expect(save).toBeEnabled({ timeout: 20_000 });
    await save.click();
    await expect(settings).toBeHidden();
    await page.getByRole('button', { name: /Explore the safe demo/i }).click();
    await expect(page.locator('.project-switcher')).toContainText('forgeboard-demo');
    await expect(page.locator('.workspace-project-tree')).toBeVisible();

    await electronApp.evaluate(({ BrowserWindow }) => {
      const [win] = BrowserWindow.getAllWindows();
      win?.setSize(1024, 800);
    });
    await page.waitForTimeout(400);

    const expanders = page.locator('.workspace-project-tree-list [aria-expanded="false"]');
    const expanderCount = await expanders.count();
    for (let index = 0; index < Math.min(expanderCount, 3); index += 1) {
      await expanders.first().click();
    }
    const firstFile = page
      .locator('.workspace-project-tree-list [role="treeitem"][draggable="true"]')
      .first();
    if ((await firstFile.count()) > 0) await firstFile.click();
    await page.waitForTimeout(300);

    // A long agent title must not widen the attach panel past the rail.
    await page.evaluate(() => {
      const option = document.querySelector('.workspace-project-tree-attach select option');
      if (option) option.textContent = 'An agent title that is far wider than the project rail';
    });
    await page.waitForTimeout(200);

    const overflows = await page.evaluate(() => {
      const rail = document.querySelector('.project-rail');
      if (!rail) return ['missing .project-rail'];
      const railRight = rail.getBoundingClientRect().right;
      const offenders: string[] = [];
      if (rail.scrollWidth > rail.clientWidth + 1) {
        offenders.push(`rail scrollWidth ${rail.scrollWidth} > clientWidth ${rail.clientWidth}`);
      }
      const walk = (element: Element): void => {
        // Tooltip bubbles intentionally pop outside their trigger while hidden.
        if (element.classList.contains('workspace-tooltip-content')) return;
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.right - railRight > 1) {
          offenders.push(
            `${element.tagName}.${String(element.className).slice(0, 60)} right=${rect.right.toFixed(1)} rail=${railRight.toFixed(1)}`,
          );
        }
        for (const child of element.children) walk(child);
      };
      for (const child of rail.children) walk(child);
      return offenders;
    });
    expect(overflows).toEqual([]);

    const grid = page.locator('.workspace-grid');
    const rail = page.locator('.project-rail');
    const canvas = page.locator('.canvas-region');
    const railWidth = (await rail.boundingBox())?.width ?? 0;
    const openCanvasWidth = (await canvas.boundingBox())?.width ?? 0;

    await page.getByRole('button', { name: 'Hide project sidebar' }).click();
    await expect(rail).toBeHidden();
    await expect(grid).toHaveClass(/project-sidebar-closed/u);
    await expect(page.getByRole('button', { name: 'Show project sidebar' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect((await canvas.boundingBox())?.width ?? 0).toBeGreaterThan(
      openCanvasWidth + railWidth - 2,
    );

    await page.getByRole('button', { name: 'Show project sidebar' }).click();
    await expect(rail).toBeVisible();
    await expect(grid).not.toHaveClass(/project-sidebar-closed/u);
  } finally {
    await closeElectronAfterTest(electronApp);
    await rm(userDataDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
});
