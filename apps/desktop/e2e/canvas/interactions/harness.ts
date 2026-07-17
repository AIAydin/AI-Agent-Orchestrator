import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, type ElectronApplication, type Page } from '@playwright/test';

import { launchDesktop, watchExternalRequests } from '../../support/electron.js';

export interface CanvasSessionHarness {
  readonly app: ElectronApplication;
  readonly page: Page;
}

export async function createCanvasUserData(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'forgeboard-canvas-interactions-e2e-'));
}

export async function openSafeDemo(
  userDataDirectory: string,
  externalRequests: string[],
): Promise<CanvasSessionHarness> {
  const session = await launchDesktop(userDataDirectory);
  watchExternalRequests(session.page, externalRequests);
  const setup = session.page.getByRole('button', { name: 'Use safe defaults' });
  await expect(setup).toBeVisible();
  await setup.click();
  await expect(
    session.page.getByRole('heading', {
      name: /Build software in a visual workshop/i,
    }),
  ).toBeVisible();
  await session.page.getByRole('button', { name: /Explore the safe demo/i }).click();
  await expect(session.page.locator('.canvas-title')).toContainText('0 nodes · 0 connections');
  return session;
}

export async function reopenRecentProject(
  userDataDirectory: string,
  externalRequests: string[],
): Promise<CanvasSessionHarness> {
  const session = await launchDesktop(userDataDirectory);
  watchExternalRequests(session.page, externalRequests);
  await expect(session.page.locator('.setup-shell')).toHaveCount(0);
  const recent = session.page.locator('.recent-list button');
  await expect(recent).toHaveCount(1);
  await recent.click();
  return session;
}

export async function closeCanvasHarness(
  app: ElectronApplication | null,
  userDataDirectory: string,
): Promise<void> {
  await app?.close().catch(() => undefined);
  await rm(userDataDirectory, { recursive: true, force: true });
}
