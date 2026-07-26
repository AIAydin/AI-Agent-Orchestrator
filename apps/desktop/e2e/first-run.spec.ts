import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';

import {
  closeElectronAfterTest,
  launchDesktop,
  openCanvasNodeDetails,
  renameCanvasNode,
  runCanvasNodeContextAction,
  watchExternalRequests,
} from './support/electron.js';

const shortcutModifier = process.platform === 'darwin' ? 'Meta' : 'Control';

test('a first-time user can configure and persist a local visual workshop', async () => {
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'forgeboard-e2e-'));
  let electronApp: ElectronApplication | null = null;
  const externalRequests: string[] = [];
  let taskTitle = '';

  try {
    const firstSession = await launchDesktop(userDataDirectory);
    electronApp = firstSession.app;
    let page = firstSession.page;
    watchExternalRequests(page, externalRequests);

    await test.step('safe first-run defaults require no files or code editing', async () => {
      const setup = page.getByRole('dialog', {
        name: 'Ready to build without wiring config files?',
      });
      await expect(setup).toBeVisible();
      await expect(setup.getByText('No Artemis cloud')).toBeVisible();
      await expect(setup.getByText('Local by default')).toBeVisible();
      await expect(setup.getByText('Changes stay reviewable')).toBeVisible();
      await setup.getByRole('button', { name: 'Use safe defaults' }).click();
      await expect(setup).toBeHidden();
    });

    await test.step('the production window starts with a hardened renderer and welcome UI', async () => {
      await expect(page).toHaveTitle('Artemis');
      await expect(
        page.getByRole('heading', {
          name: /Build software in a visual workshop/i,
        }),
      ).toBeVisible();
      await expect(page.getByText('Your code stays on this device')).toBeVisible();
      await expect(page.getByRole('button', { name: /Open a project folder/i })).toBeVisible();
      await expect(page.getByRole('button', { name: /Clone a repository/i })).toBeVisible();
      await expect(page.getByRole('button', { name: /Create a new project/i })).toBeVisible();
      await expect(page.getByRole('button', { name: /Explore the safe demo/i })).toBeVisible();
      await expect(page.getByText('No recent projects')).toBeVisible();

      const rendererGlobals = await page.evaluate(() => ({
        bridge: typeof (globalThis as { forgeboard?: unknown }).forgeboard,
        nodeRequire: typeof (globalThis as { require?: unknown }).require,
        nodeProcess: typeof (globalThis as { process?: unknown }).process,
      }));
      expect(rendererGlobals).toEqual({
        bridge: 'object',
        nodeRequire: 'undefined',
        nodeProcess: 'undefined',
      });

      const security = await firstSession.app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (!window) throw new Error('Artemis did not create its main window.');
        const webContents = window.webContents as typeof window.webContents & {
          getLastWebPreferences(): {
            allowRunningInsecureContent?: boolean;
            contextIsolation?: boolean;
            nodeIntegration?: boolean;
            sandbox?: boolean;
            webSecurity?: boolean;
          };
        };
        const preferences = webContents.getLastWebPreferences();
        return {
          contextIsolation: preferences.contextIsolation,
          nodeIntegration: preferences.nodeIntegration,
          sandbox: preferences.sandbox,
          webSecurity: preferences.webSecurity,
          allowRunningInsecureContent: preferences.allowRunningInsecureContent,
        };
      });
      expect(security).toEqual({
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      });
    });

    await test.step('available everyday configuration is completed in the UI', async () => {
      await page.getByRole('button', { name: 'Settings' }).click();
      const settings = page.locator('.settings-modal');
      await expect(settings.getByRole('heading', { name: 'Settings' })).toBeVisible();
      await expect(settings.getByText('Change how Artemis works here.')).toBeVisible();

      await settings.getByRole('button', { name: 'dark', exact: true }).click();
      await settings.getByRole('button', { name: 'compact', exact: true }).click();
      await settings.getByRole('checkbox', { name: /Reduce motion/ }).check();

      await expect(settings.getByRole('button', { name: 'Extensions', exact: true })).toHaveCount(
        0,
      );
      await expect(settings.getByRole('button', { name: 'Checks', exact: true })).toHaveCount(0);

      await settings.getByRole('button', { name: /Agents & runtime/ }).click();
      await settings.getByLabel('Default agent').selectOption('codex');

      await settings.getByRole('button', { name: 'Permissions', exact: true }).click();
      await settings.getByLabel('Default permission profile').selectOption('plan-read-only');

      await settings.getByRole('button', { name: /Git & previews/ }).click();
      await settings.getByLabel('Preview port start').fill('42000');
      await settings.getByLabel('Preview port end').fill('42099');
      await expect(settings.getByRole('heading', { name: /^Collaboration$/u })).toHaveCount(0);

      await settings.getByRole('button', { name: /Data & privacy/ }).click();
      await settings.getByLabel('Backup folder').fill(join(userDataDirectory, 'backups'));

      await settings.getByRole('button', { name: /Save settings/ }).click();
      await expect(settings).toBeHidden();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
      await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'true');

      await page.getByRole('button', { name: 'Settings' }).click();
      await page
        .locator('.settings-modal')
        .getByRole('button', { name: 'light', exact: true })
        .click();
      await page
        .locator('.settings-modal')
        .getByRole('button', { name: /Save settings/ })
        .click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    });

    await test.step('the safe local demo opens without an account or network', async () => {
      await page.getByRole('button', { name: /Explore the safe demo/i }).click();
      await expect(page.locator('.project-switcher')).toContainText('artemis-demo');
      await expect(page.locator('.canvas-title')).toContainText('0 nodes · 0 connections');
    });

    await test.step('canvas nodes can be added, edited, locked, duplicated, and deleted', async () => {
      const templates = page.locator('.template-section');
      await templates.getByRole('button', { name: /Product brief/ }).click();

      const initialBrief = page.getByRole('article', { name: /^Product brief: /u });
      await renameCanvasNode(initialBrief, 'Release plan');
      const releasePlan = page.getByRole('article', {
        name: 'Product brief: Release plan',
      });
      const details = await openCanvasNodeDetails(releasePlan);
      await details
        .getByLabel('Description')
        .fill('A local-only release plan configured entirely from the Artemis UI.');
      await details.getByRole('button', { name: 'Close node details' }).click();
      await runCanvasNodeContextAction(page, releasePlan, 'Lock');
      await expect(releasePlan.locator('[aria-label="Locked"]')).toBeVisible();

      await runCanvasNodeContextAction(page, releasePlan, 'Duplicate');
      const duplicate = page.getByRole('article', {
        name: 'Product brief: Release plan copy',
      });
      await expect(duplicate).toBeVisible();
      if (await duplicate.locator('[aria-label="Locked"]').isVisible()) {
        await runCanvasNodeContextAction(page, duplicate, 'Unlock');
      }
      await runCanvasNodeContextAction(page, duplicate, 'Delete');
      await expect(duplicate).toHaveCount(0);

      const canvasRegion = page.locator('.canvas-region');
      const canvasBox = await canvasRegion.boundingBox();
      const releasePlanBox = await releasePlan.boundingBox();
      if (!canvasBox || !releasePlanBox)
        throw new Error('The canvas and release-plan node must be visible before adding a note.');
      const minimapBox = await page.locator('.react-flow__minimap').boundingBox();
      await templates.getByRole('button', { name: /^Note/ }).dragTo(canvasRegion, {
        targetPosition: separatedDropPosition(canvasBox, releasePlanBox, minimapBox),
      });
      const noteNode = page.getByRole('article', { name: /^Note: /u });
      await expect(noteNode).toBeVisible();
      taskTitle = (await noteNode.getAttribute('aria-label'))?.replace(/^Note: /u, '') ?? '';
      expect(taskTitle).not.toBe('');
      await expect(page.locator('.canvas-title')).toContainText('2 nodes · 0 connections');
    });

    await test.step('nodes can be connected with the visual handles', async () => {
      const releasePlan = page.getByRole('article', {
        name: 'Product brief: Release plan',
      });
      await runCanvasNodeContextAction(page, releasePlan, 'Unlock');
      await expect(releasePlan.locator('[aria-label="Locked"]')).toHaveCount(0);

      const source = connectionHandle(releasePlan, 'source');
      const target = connectionHandle(page.getByRole('article', { name: /^Note: /u }), 'target');
      await connectHandles(page, source, target);
      await expect(page.locator('.canvas-title')).toContainText('2 nodes · 1 connections');
      await expect(
        page.getByText('Connected the nodes with a context link.').first(),
      ).toBeVisible();

      await runCanvasNodeContextAction(page, releasePlan, 'Lock');
      await expect(releasePlan.locator('[aria-label="Locked"]')).toBeVisible();
    });

    await test.step('the command palette and edit history work from the keyboard', async () => {
      await page.keyboard.press(`${shortcutModifier}+K`);
      const palette = page.getByRole('dialog', { name: 'Command palette' });
      await expect(palette).toBeVisible();
      // Deliberately not "Add an agent": agent nodes now launch a real CLI session the moment
      // they appear, so a first-run journey would depend on whichever agents this computer has.
      await palette.getByPlaceholder('Search actions…').fill('Add a product brief');
      await page.keyboard.press('Enter');
      await expect(palette).toBeHidden();
      const paletteNode = page
        .getByRole('article', { name: /^Product brief: /u })
        .filter({ hasNotText: 'Release plan' });
      await expect(paletteNode).toBeVisible();

      await clickExposedNodeEdge(page, paletteNode);
      await runCanvasNodeContextAction(page, paletteNode, 'Delete');
      await expect(paletteNode).toHaveCount(0);
      await page.keyboard.press(`${shortcutModifier}+Z`);
      await expect(paletteNode).toBeVisible();
      await page.keyboard.press(`${shortcutModifier}+Shift+Z`);
      await expect(paletteNode).toHaveCount(0);

      await page.keyboard.press(`${shortcutModifier}+K`);
      await expect(palette).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(palette).toBeHidden();
    });

    await test.step('canvas and appearance settings survive a full process relaunch', async () => {
      await expect
        .poll(() => readPersistedCanvas(page), { timeout: 15_000 })
        .toEqual({
          edges: 1,
          locked: true,
          titles: ['Release plan', taskTitle].sort((left, right) => left.localeCompare(right)),
        });

      await electronApp?.close();
      electronApp = null;

      const secondSession = await launchDesktop(userDataDirectory);
      electronApp = secondSession.app;
      page = secondSession.page;
      watchExternalRequests(page, externalRequests);

      await expect(page.locator('.setup-shell')).toHaveCount(0);
      await expect(
        page.getByRole('heading', {
          name: /Build software in a visual workshop/i,
        }),
      ).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
      await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'true');
      await expect(page.locator('.recent-list button')).toHaveCount(1);
      await page.locator('.recent-list button').click();

      await expect(page.locator('.canvas-title')).toContainText('2 nodes · 1 connections');
      await expect(
        page.getByRole('article', { name: 'Product brief: Release plan' }),
      ).toBeVisible();
      await expect(page.getByRole('article', { name: /^Note: /u })).toBeVisible();
      await expect(
        page
          .getByRole('article', { name: 'Product brief: Release plan' })
          .locator('[aria-label="Locked"]'),
      ).toBeVisible();
    });

    await test.step('complete deletion cannot be undone by a stale canvas autosave', async () => {
      const recentBeforeDeletion = await readRecentProjects(page);
      if (!recentBeforeDeletion.ok || recentBeforeDeletion.value.length !== 1) {
        throw new Error('The persisted project must exist before deletion.');
      }
      const deletedProjectId = recentBeforeDeletion.value[0]?.id ?? '';

      await page.getByRole('button', { name: 'Settings' }).click();
      const settings = page.locator('.settings-modal');
      await settings.getByRole('button', { name: /Data & privacy/ }).click();
      await settings.getByRole('button', { name: /Create backup now/ }).click();
      await expect(settings.getByText(/Backup created at/)).toBeVisible();
      await expect
        .poll(async () => await readdir(join(userDataDirectory, 'backups')))
        .toHaveLength(2);
      await settings.getByLabel(/Type DELETE ALL LOCAL DATA/).fill('DELETE ALL LOCAL DATA');
      await approveNextPrivacyDeletion(electronApp!);
      await settings.getByRole('button', { name: 'Delete local data' }).click();

      await expect
        .poll(() => readDeletedSetupState(page), {
          timeout: 60_000,
          intervals: [100, 250, 500, 1_000],
          message: 'local deletion should reset persisted setup state and render the setup shell',
        })
        .toEqual({ errorText: null, settingsReset: true, setupVisible: true });
      const resetSetup = page.locator('.setup-shell');
      await expect(resetSetup).toHaveAttribute('role', 'dialog');
      await expect(resetSetup).toHaveAttribute('aria-modal', 'true');
      await expect(
        resetSetup.getByRole('heading', {
          name: 'Ready to build without wiring config files?',
        }),
      ).toBeVisible();
      await page.waitForTimeout(2_500);
      await expect.poll(() => readRecentProjects(page)).toEqual({ ok: true, value: [] });
      await expect.poll(async () => await readdir(join(userDataDirectory, 'backups'))).toEqual([]);
      await expect(loadCanvasForProject(page, deletedProjectId)).resolves.toMatchObject({
        ok: false,
        error: { message: 'The selected project is no longer available.' },
      });
    });

    expect(externalRequests).toEqual([]);
  } finally {
    await closeElectronAfterTest(electronApp);
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

/**
 * Connection handles render as siblings of `.canvas-node`, not children, so the node surface can
 * clip its own chrome without slicing the handles. Reach them through the React Flow wrapper.
 */
function connectionHandle(node: Locator, side: 'source' | 'target'): Locator {
  return node
    .locator('xpath=ancestor::*[contains(@class, "react-flow__node")][1]')
    .locator(`.node-handle.${side}`);
}

async function connectHandles(page: Page, source: Locator, target: Locator): Promise<void> {
  // The floating minimap overlays the bottom-right of the canvas and, on smaller
  // windows, covers a node's handles. It is not what this test proves, so take it
  // out of the hit-testing path for the drag and restore it afterwards.
  const restoreMinimap = await hideMinimap(page);
  try {
    const sourcePoint = await exposedHandlePoint(source, 'source');
    const targetPoint = await exposedHandlePoint(target, 'target');

    await page.mouse.move(sourcePoint.x, sourcePoint.y);
    await page.mouse.down();
    await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 12 });
    await page.mouse.up();
  } finally {
    await restoreMinimap();
  }
}

/** Hides the minimap overlay, returning a function that puts it back. */
async function hideMinimap(page: Page): Promise<() => Promise<void>> {
  const minimap = page.locator('.react-flow__minimap');
  if ((await minimap.count()) === 0) return () => Promise.resolve();
  await minimap.evaluate((element: HTMLElement) => {
    element.dataset.e2ePreviousDisplay = element.style.display;
    element.style.display = 'none';
  });
  return async () => {
    await minimap.evaluate((element: HTMLElement) => {
      element.style.display = element.dataset.e2ePreviousDisplay ?? '';
      delete element.dataset.e2ePreviousDisplay;
    });
  };
}

async function exposedHandlePoint(
  handle: Locator,
  label: 'source' | 'target',
): Promise<{ x: number; y: number }> {
  const result = await handle.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const candidates = [
      center,
      { x: box.x + box.width * 0.25, y: box.y + box.height / 2 },
      { x: box.x + box.width * 0.75, y: box.y + box.height / 2 },
    ];
    for (const point of candidates) {
      const hit = document.elementFromPoint(point.x, point.y);
      if (hit === element || element.contains(hit)) return { point, obstruction: '' };
    }
    const hit = document.elementFromPoint(center.x, center.y);
    return {
      point: null,
      obstruction: hit ? `${hit.nodeName}.${hit.getAttribute('class') ?? ''}` : 'nothing',
    };
  });
  expect(result.point, `${label} handle was obscured by ${result.obstruction}`).not.toBeNull();
  return result.point ?? { x: 0, y: 0 };
}

/**
 * Where to drop a second node so both it and its connection handles stay
 * reachable. Small CI windows push the clamped position into the bottom-right,
 * where the minimap floats over the canvas and swallows the handles — so the
 * drop keeps clear of the minimap's real rectangle when one is on screen.
 */
function separatedDropPosition(
  canvas: { x: number; y: number; width: number; height: number },
  source: { x: number; y: number; width: number; height: number },
  minimap: { x: number; y: number; width: number; height: number } | null,
): { x: number; y: number } {
  const estimatedNodeWidth = 250;
  const estimatedNodeHeight = 120;
  const gap = 90;
  // Handles hang outside the node box, so keep a margin beyond its edges.
  const handleMargin = 24;
  const sourceTop = source.y - canvas.y;
  const above = sourceTop - estimatedNodeHeight - gap;
  const below = sourceTop + source.height + gap;
  const x = Math.min(Math.max(source.x - canvas.x, 80), canvas.width - estimatedNodeWidth);
  const y = above >= 70 ? above : Math.min(below, canvas.height - estimatedNodeHeight - 40);
  if (minimap === null) return { x, y };

  const minimapLeft = minimap.x - canvas.x;
  const minimapTop = minimap.y - canvas.y;
  const overlaps =
    x + estimatedNodeWidth + handleMargin > minimapLeft &&
    y + estimatedNodeHeight + handleMargin > minimapTop;
  if (!overlaps) return { x, y };

  const clearAbove = minimapTop - estimatedNodeHeight - handleMargin;
  if (clearAbove >= 70) return { x, y: clearAbove };
  return { x: Math.max(minimapLeft - estimatedNodeWidth - handleMargin, 80), y };
}

async function clickExposedNodeEdge(page: Page, node: Locator): Promise<void> {
  const box = await node.boundingBox();
  if (!box) throw new Error('The canvas node must be visible before it can be selected.');
  // Duplicates are offset down and right. Click that genuinely exposed corner rather than the
  // midpoint on the right edge, which is occupied by React Flow's connection handle.
  await page.mouse.click(box.x + box.width - 16, box.y + box.height - 16);
}

type BrowserIpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } };

interface BrowserProject {
  id: string;
}

interface BrowserSettings {
  onboardingCompleted: boolean;
}

function readRecentProjects(page: Page): Promise<BrowserIpcResult<BrowserProject[]>> {
  return page.evaluate(() => {
    const api = (
      globalThis as unknown as {
        forgeboard: {
          projects: {
            recent: () => Promise<BrowserIpcResult<BrowserProject[]>>;
          };
        };
      }
    ).forgeboard;
    return api.projects.recent();
  });
}

function loadCanvasForProject(page: Page, projectId: string): Promise<BrowserIpcResult<unknown>> {
  return page.evaluate((selectedProjectId) => {
    const api = (
      globalThis as unknown as {
        forgeboard: {
          canvas: { load: (id: string) => Promise<BrowserIpcResult<unknown>> };
        };
      }
    ).forgeboard;
    return api.canvas.load(selectedProjectId);
  }, projectId);
}

function readDeletedSetupState(page: Page): Promise<{
  errorText: string | null;
  settingsReset: boolean;
  setupVisible: boolean;
}> {
  return page.evaluate(async () => {
    const api = (
      globalThis as unknown as {
        forgeboard: {
          settings: { get: () => Promise<BrowserIpcResult<BrowserSettings>> };
        };
      }
    ).forgeboard;
    const settings = await api.settings.get();
    const setup = document.querySelector('.setup-shell');
    const setupVisible =
      setup instanceof HTMLElement &&
      getComputedStyle(setup).visibility !== 'hidden' &&
      setup.getBoundingClientRect().width > 0 &&
      setup.getBoundingClientRect().height > 0;
    const error = document.querySelector('[role="alert"]');
    const errorText = error?.textContent?.trim() || null;
    return {
      errorText,
      settingsReset: settings.ok && settings.value.onboardingCompleted === false,
      setupVisible,
    };
  });
}

async function approveNextPrivacyDeletion(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ dialog }) => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(dialog, 'showMessageBox');
    const interceptor = (...args: unknown[]) => {
      if (originalDescriptor === undefined) {
        Reflect.deleteProperty(dialog, 'showMessageBox');
      } else {
        Object.defineProperty(dialog, 'showMessageBox', originalDescriptor);
      }
      const options = args.at(-1) as
        | {
            buttons?: unknown;
            cancelId?: unknown;
            defaultId?: unknown;
            title?: unknown;
          }
        | undefined;
      if (
        options?.title !== 'Delete all local Artemis data?' ||
        JSON.stringify(options.buttons) !== JSON.stringify(['Cancel', 'Delete all local data']) ||
        options.defaultId !== 0 ||
        options.cancelId !== 0
      ) {
        throw new Error('Unexpected native privacy-deletion confirmation.');
      }
      return Promise.resolve({ response: 1, checkboxChecked: false });
    };
    Object.defineProperty(dialog, 'showMessageBox', {
      configurable: true,
      value: interceptor,
    });
  });
}

async function readPersistedCanvas(
  page: Page,
): Promise<{ edges: number; locked: boolean; titles: string[] } | null> {
  return page.evaluate(async () => {
    interface Result<T> {
      ok: boolean;
      value?: T;
    }
    interface ProjectResult {
      id: string;
    }
    interface CanvasResult {
      edges: unknown[];
      nodes: { data: { locked?: unknown; title?: unknown } }[];
    }
    const api = (
      globalThis as unknown as {
        forgeboard: {
          canvas: {
            load: (projectId: string) => Promise<Result<CanvasResult>>;
          };
          projects: { recent: () => Promise<Result<ProjectResult[]>> };
        };
      }
    ).forgeboard;
    const projects = await api.projects.recent();
    const project = projects.value?.[0];
    if (!projects.ok || !project) return null;
    const canvas = await api.canvas.load(project.id);
    if (!canvas.ok || !canvas.value) return null;
    const releasePlan = canvas.value.nodes.find((node) => node.data.title === 'Release plan');
    return {
      edges: canvas.value.edges.length,
      locked: releasePlan?.data.locked === true,
      titles: canvas.value.nodes
        .map((node) => String(node.data.title))
        .sort((left, right) => left.localeCompare(right)),
    };
  });
}
