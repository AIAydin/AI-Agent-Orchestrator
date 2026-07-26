import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication } from '@playwright/test';

import {
  closeElectronAfterTest,
  launchDesktop,
  watchExternalRequests,
} from '../support/electron.js';

test('group membership and collapse behavior work entirely from the canvas UI', async () => {
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'forgeboard-canvas-groups-e2e-'));
  let electronApp: ElectronApplication | null = null;
  const externalRequests: string[] = [];

  try {
    const session = await launchDesktop(userDataDirectory);
    electronApp = session.app;
    const { page } = session;
    watchExternalRequests(page, externalRequests);

    await page.getByRole('button', { name: 'Use safe defaults' }).click();
    await page.getByRole('button', { name: /Explore the safe demo/i }).click();
    await expect(page.locator('.canvas-title')).toContainText('0 nodes · 0 connections');

    const templates = page.locator('.template-section');
    await templates.getByRole('button', { name: /^Task/ }).click();
    const taskNode = page.getByRole('article', { name: /^Task: /u });
    await expect(taskNode).toBeVisible();

    const canvas = page.locator('.canvas-region');
    const canvasBox = await canvas.boundingBox();
    if (!canvasBox) throw new Error('The canvas must be visible before adding a group.');
    await templates.getByRole('button', { name: /^Group/ }).dragTo(canvas, {
      targetPosition: {
        x: Math.max(80, Math.min(320, canvasBox.width - 580)),
        y: 80,
      },
    });
    const groupFrame = page.getByRole('group', { name: /^Group: /u });
    await expect(groupFrame).toBeVisible();
    await expect(page.locator('.canvas-title')).toContainText('2 nodes · 0 connections');

    const taskDragHandle = taskNode.locator('.canvas-node-title');
    const [taskDragHandleBox, taskBox, groupBox] = await Promise.all([
      taskDragHandle.boundingBox(),
      taskNode.boundingBox(),
      groupFrame.boundingBox(),
    ]);
    if (!taskDragHandleBox || !taskBox || !groupBox) {
      throw new Error('The task and group must be visible before grouping the task.');
    }
    const deltaX = groupBox.x + 48 - taskBox.x;
    const deltaY = groupBox.y + 58 - taskBox.y;
    await page.mouse.move(
      taskDragHandleBox.x + taskDragHandleBox.width / 2,
      taskDragHandleBox.y + taskDragHandleBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      taskDragHandleBox.x + taskDragHandleBox.width / 2 + deltaX,
      taskDragHandleBox.y + taskDragHandleBox.height / 2 + deltaY,
      { steps: 8 },
    );
    await page.mouse.up();
    const movedTaskBox = await taskNode.boundingBox();
    if (
      !movedTaskBox ||
      movedTaskBox.x < groupBox.x ||
      movedTaskBox.y < groupBox.y ||
      movedTaskBox.x + movedTaskBox.width > groupBox.x + groupBox.width ||
      movedTaskBox.y + movedTaskBox.height > groupBox.y + groupBox.height
    ) {
      throw new Error(
        `The task did not move fully into the group: before=${JSON.stringify(taskBox)} after=${JSON.stringify(movedTaskBox)} target=${JSON.stringify(groupBox)}`,
      );
    }
    await expect(groupFrame.getByText('1 member', { exact: true })).toBeVisible();

    await groupFrame.getByRole('button', { name: /^Collapse /u }).click();
    await expect(groupFrame).toHaveClass(/collapsed/u);
    await expect(taskNode).toBeHidden();

    await groupFrame.getByRole('button', { name: /^Expand /u }).click();
    await expect(groupFrame).not.toHaveClass(/collapsed/u);
    await expect(taskNode).toBeVisible();
    await expect(groupFrame.getByText('1 member', { exact: true })).toBeVisible();

    expect(externalRequests).toEqual([]);
  } finally {
    await closeElectronAfterTest(electronApp);
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});
