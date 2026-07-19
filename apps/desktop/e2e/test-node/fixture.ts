import { expect, type Locator, type Page } from '@playwright/test';

export const ARTIFACT_PATH = 'reports/test-node-result.json';
export const LIVE_MARKER = 'FORGEBOARD_TEST_NODE_LIVE';
export const PASS_MARKER = 'FORGEBOARD_TEST_NODE_PASSED';

export const LONG_RUNNING_SCRIPT = [
  'const fs=require("node:fs");',
  'fs.mkdirSync("reports",{recursive:true});',
  `process.stdout.write("${LIVE_MARKER}\\nTests: 1 passed, 0 failed, 0 skipped, 1 total\\n");`,
  'setInterval(()=>fs.appendFileSync("reports/test-node-heartbeat","x"),20);',
].join('');

export const PASSING_SCRIPT = [
  'const fs=require("node:fs");',
  'fs.mkdirSync("reports",{recursive:true});',
  `process.stdout.write("${PASS_MARKER}\\nTests: 4 passed, 0 failed, 1 skipped, 5 total\\n");`,
  `fs.writeFileSync(${JSON.stringify(ARTIFACT_PATH)},JSON.stringify({passed:4,failed:0}));`,
].join('');

export async function openSafeDemo(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Use safe defaults' }).click();
  await page.getByRole('button', { name: /Explore the safe demo/i }).click();
  await expect(page.locator('.project-switcher')).toContainText('forgeboard-demo');
}

export async function addAndSelectTestNode(page: Page): Promise<Locator> {
  await page.locator('.template-section').getByRole('button', { name: /^Test/ }).click();
  await page.getByRole('article', { name: 'Test: Test' }).click();
  const panel = page.getByRole('region', { name: 'Test node' });
  await expect(panel).toBeVisible();
  return panel;
}

export async function selectRestoredTestNode(page: Page): Promise<Locator> {
  await page.getByRole('article', { name: 'Test: Test' }).click();
  const panel = page.getByRole('region', { name: 'Test node' });
  await expect(panel).toBeVisible();
  return panel;
}

export async function configureTestNode(
  panel: Locator,
  script: string,
  options: { includeArtifact?: boolean } = {},
): Promise<void> {
  const configuration = panel.getByRole('group', {
    name: 'Test command configuration',
  });
  await configuration.getByLabel('Program').fill('node');
  await configuration.getByLabel(/Arguments/u).fill(`-e\n${script}`);
  await configuration.getByLabel(/Folder to run in/u).fill('.');
  await configuration
    .getByLabel(/Result files to keep/u)
    .fill(options.includeArtifact === false ? '' : ARTIFACT_PATH);
}

export async function openLaunchDecision(page: Page): Promise<Locator> {
  const drawer = page.locator('.activity-drawer');
  await drawer.getByRole('tab', { name: /Workflows/ }).click();
  const workflows = drawer.getByRole('tabpanel', { name: 'Workflows' });
  await workflows.getByRole('button', { name: 'Review what will run' }).click();
  const dialog = page.getByRole('dialog', {
    name: 'Review what will run',
  });
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function expectParsedSummary(
  panel: Locator,
  expected: { passed: number; failed: number; skipped: number; total: number },
): Promise<void> {
  const summary = panel.locator('.test-node-result').first().getByLabel('Test result summary');
  await expect(summary).toContainText(`Passed${String(expected.passed)}`);
  await expect(summary).toContainText(`Failed${String(expected.failed)}`);
  await expect(summary).toContainText(`Skipped${String(expected.skipped)}`);
  await expect(summary).toContainText(`Total${String(expected.total)}`);
}
