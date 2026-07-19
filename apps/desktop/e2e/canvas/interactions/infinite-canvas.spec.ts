import { expect, test, type ElectronApplication } from '@playwright/test';

import {
  addSeparatedTask,
  clickExposedCorner,
  expectNodeNearCanvasCenter,
  flowNode,
  shortcutModifier,
} from './canvas-actions.js';
import {
  comparableViewport,
  nodeByTitle,
  readPersistedCanvas,
  readRenderedViewport,
  viewportChanged,
} from './canvas-state.js';
import {
  closeCanvasHarness,
  createCanvasUserData,
  openSafeDemo,
  reopenRecentProject,
} from './harness.js';

test('infinite-canvas interactions persist locally without outbound requests', async () => {
  const userDataDirectory = await createCanvasUserData();
  const externalRequests: string[] = [];
  let electronApp: ElectronApplication | null = null;

  try {
    const firstSession = await openSafeDemo(userDataDirectory, externalRequests);
    electronApp = firstSession.app;
    let { page } = firstSession;
    const templates = page.locator('.template-section');
    const inspector = page.locator('.inspector');

    await test.step('search selects and centers an exact canvas node', async () => {
      await templates.getByRole('button', { name: /Product brief/ }).click();
      const brief = page.getByRole('article', {
        name: 'Product brief: Product brief',
        exact: true,
      });
      await expect(brief).toBeVisible();
      await inspector.getByLabel('Title').fill('Canvas Alpha');
      await addSeparatedTask(
        page,
        page.getByRole('article', {
          name: 'Product brief: Canvas Alpha',
          exact: true,
        }),
      );

      const task = page.getByRole('article', {
        name: 'Task: Task',
        exact: true,
      });
      await expect(task).toBeVisible();
      await task.click();
      await inspector.getByLabel('Title').fill('Canvas Beta');

      await page.getByRole('button', { name: 'Nodes', exact: true }).click();
      const search = page.getByRole('textbox', { name: 'Search canvas nodes' });
      await search.fill('beta');
      const result = page.locator('.rail-node-list').getByRole('button', { name: /Canvas Beta/ });
      await expect(result).toBeVisible();
      await expect(page.locator('.rail-node-list button')).toHaveCount(1);
      await result.click();
      await expect(inspector.getByLabel('Title')).toHaveValue('Canvas Beta');
      await expect(
        flowNode(page.getByRole('article', { name: 'Task: Canvas Beta', exact: true })),
      ).toHaveClass(/selected/u);
      await expectNodeNearCanvasCenter(
        page,
        page.getByRole('article', { name: 'Task: Canvas Beta', exact: true }),
      );
      await search.fill('');
    });

    await test.step('minimap, fit, and keyboard multi-selection movement operate on the canvas', async () => {
      const minimap = page.locator('.react-flow__minimap');
      await expect(minimap).toBeVisible();
      await expect(minimap.locator('svg')).toBeVisible();

      const beforeZoom = await readRenderedViewport(page);
      await page.getByRole('button', { name: 'Zoom In' }).click();
      await expect
        .poll(async () => (await readRenderedViewport(page)).zoom)
        .toBeGreaterThan(beforeZoom.zoom);
      await page.getByRole('button', { name: 'Zoom to fit the canvas' }).click();
      await expect(
        page.getByRole('article', {
          name: 'Product brief: Canvas Alpha',
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole('article', { name: 'Task: Canvas Beta', exact: true }),
      ).toBeVisible();

      const alpha = page.getByRole('article', {
        name: 'Product brief: Canvas Alpha',
        exact: true,
      });
      const beta = page.getByRole('article', {
        name: 'Task: Canvas Beta',
        exact: true,
      });
      await clickExposedCorner(page, alpha);
      await page.keyboard.down(shortcutModifier);
      await clickExposedCorner(page, beta);
      await page.keyboard.up(shortcutModifier);
      await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);

      await flowNode(beta).focus();
      await expect
        .poll(async () => {
          const state = await readPersistedCanvas(page);
          return state?.nodes
            .map((node) => node.data.title)
            .filter((title): title is string => title !== undefined)
            .sort();
        })
        .toEqual(['Canvas Alpha', 'Canvas Beta']);
      const before = await readPersistedCanvas(page);
      expect(before).not.toBeNull();
      await flowNode(beta).press('Shift+ArrowRight');
      await expect(page.getByText(/Moved 2 canvas nodes right 10 pixels/)).toBeVisible();
      await expect
        .poll(async () => {
          const after = await readPersistedCanvas(page);
          if (after === null || before === null) return null;
          return {
            alpha: nodeByTitle(after, 'Canvas Alpha').position.x,
            beta: nodeByTitle(after, 'Canvas Beta').position.x,
          };
        })
        .toEqual({
          alpha: nodeByTitle(before as NonNullable<typeof before>, 'Canvas Alpha').position.x + 10,
          beta: nodeByTitle(before as NonNullable<typeof before>, 'Canvas Beta').position.x + 10,
        });
    });

    await test.step('copy, paste, duplicate, and locking preserve honest graph behavior', async () => {
      const beta = page.getByRole('article', {
        name: 'Task: Canvas Beta',
        exact: true,
      });
      await page
        .locator('.rail-node-list button')
        .filter({
          has: page.locator('strong').getByText('Canvas Beta', { exact: true }),
        })
        .click();
      await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
      await page.keyboard.press(`${shortcutModifier}+c`);
      await page.keyboard.press(`${shortcutModifier}+v`);
      await expect(
        page.getByRole('article', {
          name: 'Task: Canvas Beta copy',
          exact: true,
        }),
      ).toBeVisible();
      await page.keyboard.press(`${shortcutModifier}+d`);
      await expect(
        page.getByRole('article', {
          name: 'Task: Canvas Beta copy copy',
          exact: true,
        }),
      ).toBeVisible();

      await page
        .locator('.rail-node-list button')
        .filter({
          has: page.locator('strong').getByText('Canvas Beta', { exact: true }),
        })
        .click();
      await expect(inspector.getByLabel('Title')).toHaveValue('Canvas Beta');
      await inspector.getByRole('button', { name: 'Lock' }).click();
      await expect(beta.locator('[aria-label="Locked"]')).toBeVisible();
      await expect
        .poll(async () => {
          const state = await readPersistedCanvas(page);
          return state === null ? null : nodeByTitle(state, 'Canvas Beta').data.locked;
        })
        .toBe(true);
      const lockedState = await readPersistedCanvas(page);
      expect(lockedState).not.toBeNull();
      await flowNode(beta).focus();
      await flowNode(beta).press('Shift+ArrowDown');
      await expect(page.getByText('Locked selected nodes cannot be moved.')).toBeVisible();
      await page.waitForTimeout(350);
      const afterAttempt = await readPersistedCanvas(page);
      expect(afterAttempt).not.toBeNull();
      expect(
        nodeByTitle(afterAttempt as NonNullable<typeof afterAttempt>, 'Canvas Beta').position,
      ).toEqual(
        nodeByTitle(lockedState as NonNullable<typeof lockedState>, 'Canvas Beta').position,
      );
      await inspector.getByRole('button', { name: 'Unlock' }).click();
    });

    const privateComment = 'Private canvas note retained only on this device.';
    await test.step('a private node comment is created entirely in the local UI', async () => {
      const comments = inspector.getByRole('region', {
        name: 'Private comments',
      });
      await expect(comments.getByText(/Saved only in this project on this device/)).toBeVisible();
      await comments.getByLabel('Add a private comment').fill(privateComment);
      await comments.getByRole('button', { name: 'Save locally' }).click();
      await expect(comments.getByText(privateComment, { exact: true })).toBeVisible();
      await expect(comments.locator('header small')).toHaveText('1');
    });

    let expectedViewport = { x: 0, y: 0, zoom: 1 };
    await test.step('a pure pan and zoom autosaves without a graph edit', async () => {
      await expect(page.locator('.autosave-state')).toContainText('Saved locally');
      const before = await readPersistedCanvas(page);
      expect(before).not.toBeNull();
      const canvas = page.locator('.canvas-region');
      const box = await canvas.boundingBox();
      if (box === null) throw new Error('The canvas must be visible before panning.');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.getByRole('button', { name: 'Zoom In' }).click();
      await page.mouse.wheel(120, 85);

      await expect
        .poll(async () => {
          const after = await readPersistedCanvas(page);
          return viewportChanged(before?.viewport ?? { x: 0, y: 0, zoom: 1 }, after?.viewport);
        })
        .toBe(true);
      const saved = await readPersistedCanvas(page);
      if (saved === null) throw new Error('The panned canvas was not persisted.');
      expectedViewport = saved.viewport;
    });

    await electronApp.close();
    electronApp = null;
    const secondSession = await reopenRecentProject(userDataDirectory, externalRequests);
    electronApp = secondSession.app;
    page = secondSession.page;

    await test.step('graph and exact viewport restore after a full app relaunch', async () => {
      await expect(page.locator('.canvas-title')).toContainText('4 nodes · 0 connections');
      await expect(
        page.getByRole('article', {
          name: 'Product brief: Canvas Alpha',
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole('article', { name: 'Task: Canvas Beta', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('article', {
          name: 'Task: Canvas Beta copy',
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole('article', {
          name: 'Task: Canvas Beta copy copy',
          exact: true,
        }),
      ).toBeVisible();
      await expect
        .poll(async () => comparableViewport(await readRenderedViewport(page)))
        .toEqual(comparableViewport(expectedViewport));

      await page.getByRole('button', { name: 'Nodes', exact: true }).click();
      await page
        .locator('.rail-node-list button')
        .filter({
          has: page.locator('strong').getByText('Canvas Beta', { exact: true }),
        })
        .click();
      const comments = page.locator('.inspector').getByRole('region', { name: 'Private comments' });
      await expect(comments.getByText(privateComment, { exact: true })).toBeVisible();
      await expect(comments.locator('header small')).toHaveText('1');
    });

    expect(externalRequests).toEqual([]);
  } finally {
    await closeCanvasHarness(electronApp, userDataDirectory);
  }
});
