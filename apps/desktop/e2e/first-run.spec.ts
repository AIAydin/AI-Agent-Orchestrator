import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';

import { launchDesktop, watchExternalRequests } from './electron.js';

const shortcutModifier = process.platform === 'darwin' ? 'Meta' : 'Control';

test('a first-time user can configure and persist a local visual workshop', async () => {
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'forgeboard-e2e-'));
  let electronApp: ElectronApplication | null = null;
  const externalRequests: string[] = [];

  try {
    const firstSession = await launchDesktop(userDataDirectory);
    electronApp = firstSession.app;
    let page = firstSession.page;
    watchExternalRequests(page, externalRequests);

    await test.step('the production window starts with a hardened renderer and welcome UI', async () => {
      await expect(page).toHaveTitle('Forgeboard');
      await expect(
        page.getByRole('heading', { name: /Build software in a visual workshop/i }),
      ).toBeVisible();
      await expect(page.getByText('Your code stays on this device')).toBeVisible();
      await expect(page.getByRole('button', { name: /Open local repository/i })).toBeVisible();
      await expect(page.getByRole('button', { name: /Clone repository/i })).toBeVisible();
      await expect(page.getByRole('button', { name: /Create empty project/i })).toBeVisible();
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
        if (!window) throw new Error('Forgeboard did not create its main window.');
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

    await test.step('everyday configuration is completed in the UI', async () => {
      await page.getByRole('button', { name: 'Settings' }).click();
      const settings = page.locator('.settings-modal');
      await expect(settings.getByRole('heading', { name: 'Settings' })).toBeVisible();
      await expect(settings.getByText('All everyday configuration lives here.')).toBeVisible();

      await settings.getByRole('button', { name: 'dark', exact: true }).click();
      await settings.getByRole('button', { name: 'compact', exact: true }).click();
      await settings.getByRole('checkbox', { name: /Reduce motion/ }).check();

      await settings.getByRole('button', { name: /Agents & runtime/ }).click();
      await settings.getByLabel('Default agent').selectOption('test-agent');
      await settings.getByLabel('Default permission profile').selectOption('plan-read-only');
      await settings
        .getByLabel('Environment names allowed into processes')
        .fill('PATH, HOME, LANG, CI');

      await settings.getByRole('button', { name: /Git & previews/ }).click();
      await settings.getByLabel('Preview port start').fill('42000');
      await settings.getByLabel('Preview port end').fill('42099');
      await expect(
        settings.getByRole('checkbox', { name: /Enable collaboration/ }),
      ).not.toBeChecked();

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
      await expect(page.locator('.project-switcher')).toContainText('forgeboard-demo');
      await expect(page.locator('.canvas-title')).toContainText('0 nodes · 0 connections');
      await expect(page.getByText('Context guard active')).toBeVisible();
    });

    await test.step('canvas nodes can be added, edited, locked, duplicated, and deleted', async () => {
      const templates = page.locator('.template-section');
      await templates.getByRole('button', { name: /Product brief/ }).click();

      const inspector = page.locator('.inspector');
      await page.getByRole('article', { name: 'Product brief: Product brief' }).click();
      await expect(inspector.getByLabel('Title')).toHaveValue('Product brief');
      await inspector.getByLabel('Title').fill('Release plan');
      await inspector
        .getByLabel('Description')
        .fill('A local-only release plan configured entirely from the Forgeboard UI.');
      await inspector.getByRole('button', { name: 'Lock' }).click();

      const releasePlan = page.getByRole('article', { name: 'Product brief: Release plan' });
      await expect(releasePlan.locator('[aria-label="Locked"]')).toBeVisible();

      await inspector.getByRole('button', { name: 'Duplicate' }).click();
      const duplicate = page.getByRole('article', { name: 'Product brief: Release plan copy' });
      await expect(duplicate).toBeVisible();
      await clickExposedNodeEdge(page, duplicate);
      await inspector.getByRole('button', { name: 'Delete' }).click();
      await expect(duplicate).toHaveCount(0);

      const canvasRegion = page.locator('.canvas-region');
      const canvasBox = await canvasRegion.boundingBox();
      if (!canvasBox) throw new Error('The canvas must be visible before adding a task.');
      await templates.getByRole('button', { name: /^Task/ }).dragTo(canvasRegion, {
        targetPosition: { x: canvasBox.width * 0.9, y: canvasBox.height * 0.42 },
      });
      const taskNode = page.getByRole('article', { name: 'Task: Task' });
      await expect(taskNode).toBeVisible();
      await expect(page.locator('.canvas-title')).toContainText('2 nodes · 0 connections');
    });

    await test.step('nodes can be connected with the visual handles', async () => {
      const source = page
        .getByRole('article', { name: 'Product brief: Release plan' })
        .locator('.react-flow__handle-right');
      const target = page
        .getByRole('article', { name: 'Task: Task' })
        .locator('.react-flow__handle-left');
      await connectHandles(page, source, target);
      await expect(page.locator('.canvas-title')).toContainText('2 nodes · 1 connections');
      await expect(page.getByText('Connected nodes with a context edge.')).toBeVisible();
    });

    await test.step('the command palette and edit history work from the keyboard', async () => {
      await page.keyboard.press(`${shortcutModifier}+K`);
      const palette = page.getByRole('dialog', { name: 'Command palette' });
      await expect(palette).toBeVisible();
      await palette.getByPlaceholder('Search actions…').fill('Add agent node');
      await page.keyboard.press('Enter');
      await expect(palette).toBeHidden();
      const agentNode = page.getByRole('article', { name: 'Agent: Agent' });
      await expect(agentNode).toBeVisible();

      await clickExposedNodeEdge(page, agentNode);
      await page.locator('.inspector').getByRole('button', { name: 'Delete' }).click();
      await expect(agentNode).toHaveCount(0);
      await page.keyboard.press(`${shortcutModifier}+Z`);
      await expect(agentNode).toBeVisible();
      await page.keyboard.press(`${shortcutModifier}+Shift+Z`);
      await expect(agentNode).toHaveCount(0);

      await page.keyboard.press(`${shortcutModifier}+K`);
      await expect(palette).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(palette).toBeHidden();
    });

    await test.step('canvas and appearance settings survive a full process relaunch', async () => {
      await expect
        .poll(() => readPersistedCanvas(page), { timeout: 15_000 })
        .toEqual({ edges: 1, locked: true, titles: ['Release plan', 'Task'] });

      await electronApp?.close();
      electronApp = null;

      const secondSession = await launchDesktop(userDataDirectory);
      electronApp = secondSession.app;
      page = secondSession.page;
      watchExternalRequests(page, externalRequests);

      await expect(
        page.getByRole('heading', { name: /Build software in a visual workshop/i }),
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
      await expect(page.getByRole('article', { name: 'Task: Task' })).toBeVisible();
      await expect(
        page
          .getByRole('article', { name: 'Product brief: Release plan' })
          .locator('[aria-label="Locked"]'),
      ).toBeVisible();
    });

    expect(externalRequests).toEqual([]);
  } finally {
    await electronApp?.close().catch(() => undefined);
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

async function connectHandles(page: Page, source: Locator, target: Locator): Promise<void> {
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox)
    throw new Error('Both canvas handles must be visible to connect nodes.');

  await source.hover();
  await page.mouse.down();
  await target.hover();
  await page.mouse.up();
}

async function clickExposedNodeEdge(page: Page, node: Locator): Promise<void> {
  const box = await node.boundingBox();
  if (!box) throw new Error('The canvas node must be visible before it can be selected.');
  await page.mouse.click(box.x + box.width - 6, box.y + box.height / 2);
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
          canvas: { load: (projectId: string) => Promise<Result<CanvasResult>> };
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
