import { mkdtemp, readdir, rm } from 'node:fs/promises';
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

    await test.step('safe first-run defaults require no files or code editing', async () => {
      const setup = page.getByRole('dialog', {
        name: /Ready to build without wiring config files/i,
      });
      await expect(setup).toBeVisible();
      await expect(setup.getByText('No Forgeboard cloud')).toBeVisible();
      await expect(setup.getByText('Local by default')).toBeVisible();
      await expect(setup.getByText('Changes stay reviewable')).toBeVisible();
      await setup.getByRole('button', { name: 'Use safe defaults' }).click();
      await expect(setup).toBeHidden();
    });

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

      await settings.getByRole('button', { name: 'Extensions', exact: true }).click();
      await expect(settings.getByRole('heading', { name: 'Local extensions' })).toBeVisible();
      await expect(settings.getByText('Data-only by design')).toBeVisible();
      await expect(
        settings.getByText('No trusted extensions active', { exact: true }),
      ).toBeVisible();
      await expect(settings.getByRole('button', { name: /Choose extension folder/ })).toBeVisible();

      await settings.getByRole('button', { name: /Agents & runtime/ }).click();
      await settings.getByLabel('Default agent').selectOption('test-agent');
      await settings.getByLabel('Default permission profile').selectOption('plan-read-only');
      await settings
        .getByLabel('Environment names allowed into processes')
        .fill('PATH, HOME, LANG, CI');

      await settings.getByRole('button', { name: /Git & previews/ }).click();
      await settings.getByLabel('Branch prefix').fill('team/agents/');
      await settings.getByLabel('Preview port start').fill('42000');
      await settings.getByLabel('Preview port end').fill('42099');
      await expect(
        settings.getByRole('heading', { name: /Self-hosted collaboration/ }),
      ).toHaveCount(0);

      await settings.getByRole('button', { name: /Data & privacy/ }).click();
      await settings.getByLabel('Backup directory').fill(join(userDataDirectory, 'backups'));

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
      await expect(inspector.getByLabel('Title')).toHaveValue('Release plan copy');
      await inspector.getByRole('button', { name: 'Delete' }).click();
      await expect(duplicate).toHaveCount(0);

      const canvasRegion = page.locator('.canvas-region');
      const canvasBox = await canvasRegion.boundingBox();
      if (!canvasBox) throw new Error('The canvas must be visible before adding a task.');
      await templates.getByRole('button', { name: /^Task/ }).dragTo(canvasRegion, {
        targetPosition: { x: canvasBox.width * 0.75, y: canvasBox.height * 0.18 },
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

      await expect(page.locator('.setup-shell')).toHaveCount(0);
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
        .toHaveLength(1);
      await settings.getByLabel(/Type DELETE ALL LOCAL DATA/).fill('DELETE ALL LOCAL DATA');
      await settings.getByRole('button', { name: 'Delete local data' }).click();

      await expect(
        page.getByRole('dialog', { name: /Ready to build without wiring config files/i }),
      ).toBeVisible({ timeout: 30_000 });
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
    await electronApp?.close().catch(() => undefined);
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

async function connectHandles(page: Page, source: Locator, target: Locator): Promise<void> {
  await assertHandleIsExposed(source);
  await assertHandleIsExposed(target);
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox)
    throw new Error('Both canvas handles must be visible to connect nodes.');

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
}

async function assertHandleIsExposed(handle: Locator): Promise<void> {
  const exposed = await handle.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit === element || element.contains(hit);
  });
  expect(exposed).toBe(true);
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

function readRecentProjects(page: Page): Promise<BrowserIpcResult<BrowserProject[]>> {
  return page.evaluate(() => {
    const api = (
      globalThis as unknown as {
        forgeboard: {
          projects: { recent: () => Promise<BrowserIpcResult<BrowserProject[]>> };
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
