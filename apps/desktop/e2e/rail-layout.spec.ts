import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, expect, type ElectronApplication } from '@playwright/test';

import { launchDesktop } from './support/electron.js';

test('the project rail never overflows horizontally, even at narrow widths', async () => {
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
  } finally {
    await electronApp?.close().catch(() => undefined);
    await rm(userDataDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
});
