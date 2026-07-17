import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication } from '@playwright/test';

import { launchDesktop, watchExternalRequests } from '../support/electron.js';

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
    const taskNode = page.getByRole('article', { name: 'Task: Task' });
    await expect(taskNode).toBeVisible();

    await templates.getByRole('button', { name: /^Group \/ frame/ }).click();
    const groupFrame = page.getByRole('group', { name: 'Group / frame: Group / frame' });
    await expect(groupFrame).toBeVisible();
    await expect(page.locator('.canvas-title')).toContainText('2 nodes · 0 connections');

    const groupConfiguration = page.locator('section[aria-label="Group frame configuration"]');
    await expect(groupConfiguration).toBeVisible();
    const taskMembership = groupConfiguration.locator('input[type="checkbox"][name*="-member-"]');
    await expect(taskMembership).toHaveCount(1);
    await taskMembership.check();
    await expect(groupConfiguration.getByText('1 member', { exact: true })).toBeVisible();

    await groupFrame.getByRole('button', { name: 'Collapse Group / frame' }).click();
    await expect(groupFrame).toHaveClass(/collapsed/u);
    await expect(taskNode).toBeHidden();

    await groupFrame.getByRole('button', { name: 'Expand Group / frame' }).click();
    await expect(groupFrame).not.toHaveClass(/collapsed/u);
    await expect(taskNode).toBeVisible();
    await expect(taskMembership).toBeChecked();

    expect(externalRequests).toEqual([]);
  } finally {
    await electronApp?.close().catch(() => undefined);
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});
