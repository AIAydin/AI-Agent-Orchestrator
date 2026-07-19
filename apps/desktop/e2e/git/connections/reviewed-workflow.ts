import { expect, type Locator, type Page } from '@playwright/test';

import { addNodeAt, connectAndConfigure } from '../../review-gate/fixture.js';

export async function configureCodexReviewerConnection(
  settings: Locator,
  executablePath: string,
): Promise<void> {
  await settings.getByRole('button', { name: 'Agents & runtime', exact: true }).click();
  const codex = settings.locator('.provider-connection-card').filter({ hasText: 'Codex CLI' });
  await codex.getByText('Advanced', { exact: true }).click();
  await codex.getByLabel('Executable override').fill(executablePath);
  await codex.getByRole('button', { name: 'Connect with OpenAI' }).click();
  await expect(codex).toContainText('Connected', { timeout: 20_000 });
  await codex.getByRole('button', { name: 'Check OpenAI Codex CLI again' }).click();
  await expect(codex).toContainText('OpenAI Codex CLI executable is ready');
}

export async function runReviewedAgentWorkflow(input: {
  readonly page: Page;
  readonly implementation: Locator;
}): Promise<Locator> {
  const { page, implementation } = input;
  await implementation.click();
  await page.locator('.inspector').getByLabel('Title').fill('Legacy setup agent');
  const legacyImplementation = page.getByRole('article', {
    name: 'Agent: Legacy setup agent',
    exact: true,
  });
  await expect(legacyImplementation).toBeVisible();
  await page.locator('.inspector').getByRole('button', { name: 'Delete' }).click();

  const implementationDraft = await addNodeAt(page, /^Agent/u, 'Agent: Agent', {
    x: 130,
    y: 160,
  });
  await implementationDraft.click();
  await page.locator('.inspector').getByLabel('Title').fill('Implementation');
  const implementationNode = page.getByRole('article', {
    name: 'Agent: Implementation',
    exact: true,
  });
  await implementationNode.click();
  const implementationSettings = page.getByRole('region', { name: 'Agent run settings' });
  await implementationSettings.getByLabel('Agent to run').selectOption('test-agent');
  await implementationSettings.getByLabel('Permission profile').selectOption('worktree-write');
  await implementationSettings
    .getByLabel('Prompt')
    .fill('Create the exact implementation output for review.');

  const reviewer = await addNodeAt(page, /^Agent/u, 'Agent: Agent', { x: 520, y: 460 });
  await reviewer.click();
  await page.locator('.inspector').getByLabel('Title').fill('Codex reviewer');
  const reviewerNode = page.getByRole('article', {
    name: 'Agent: Codex reviewer',
    exact: true,
  });
  await reviewerNode.click();
  const reviewerSettings = page.getByRole('region', { name: 'Agent run settings' });
  await reviewerSettings.getByLabel('Agent to run').selectOption('codex');
  await reviewerSettings.getByLabel('Permission profile').selectOption('plan-read-only');
  await reviewerSettings.getByLabel('Prompt').fill('Review the exact bound implementation output.');

  const testNode = await addNodeAt(page, /^Test/u, 'Test: Test', { x: 520, y: 150 });
  await testNode.click();
  await page.locator('.inspector').getByLabel('Title').fill('Verification test');
  const verificationTest = page.getByRole('article', {
    name: 'Test: Verification test',
    exact: true,
  });
  await verificationTest.click();
  const testSettings = page.getByRole('group', { name: 'Test command configuration' });
  await testSettings.getByLabel('Kind of check').selectOption('test');
  await testSettings.getByLabel('Program').fill(process.execPath);
  await testSettings
    .getByLabel(/Arguments/u)
    .fill('-e\nprocess.stdout.write("reviewed-workflow-test-pass")');
  await testSettings.getByLabel(/Folder to run in/u).fill('.');

  const gate = await addNodeAt(page, /^Review gate/u, 'Review gate: Review gate', {
    x: 850,
    y: 170,
  });
  await gate.click();
  const gateSettings = page.getByRole('region', { name: 'Review gate configuration' });
  const humanApproval = gateSettings.getByRole('checkbox', { name: /Require human approval/u });
  if (await humanApproval.isChecked()) await humanApproval.uncheck();
  const testsMustPass = gateSettings.getByRole('checkbox', { name: 'Tests must pass' });
  if (!(await testsMustPass.isChecked())) await testsMustPass.check();
  const verificationRequirement = gateSettings.getByRole('checkbox', {
    name: /Verification test/u,
  });
  if (!(await verificationRequirement.isChecked())) await verificationRequirement.check();
  await gateSettings.getByRole('combobox', { name: /Reviewer agent/u }).selectOption({
    label: 'Codex reviewer · codex',
  });
  await gateSettings.getByLabel('Maximum attempts').fill('2');

  await page.getByRole('button', { name: 'Zoom to fit the canvas' }).click();
  await connectAndConfigure(page, implementationNode, verificationTest, 'output');
  await connectAndConfigure(page, implementationNode, gate, 'review');
  await connectAndConfigure(page, gate, implementationNode, 'revision');
  await page.getByRole('button', { name: 'Run canvas' }).click();

  const drawer = page.locator('.activity-drawer');
  await drawer.getByRole('tab', { name: /Workflows/ }).click();
  const workflows = drawer.getByRole('tabpanel', { name: 'Workflows' });
  for (const title of [
    'Implementation',
    'Codex reviewer',
    'Verification test',
    'Implementation',
    'Codex reviewer',
    'Verification test',
  ]) {
    await approveWorkflowLaunch(page, workflows, title);
  }
  await expect(workflows.getByRole('region', { name: 'Workflow run summary' })).toContainText(
    /succeeded/iu,
    { timeout: 20_000 },
  );
  const implementationReport = reviewedImplementationReport(page);
  await expect(implementationReport).toContainText(/Attempt 2 · succeeded/iu);

  await implementationNode.click();
  return implementationReport;
}

export async function openReviewedImplementationReport(page: Page): Promise<Locator> {
  const drawer = page.locator('.activity-drawer');
  await drawer.getByRole('tab', { name: /Workflows/ }).click();
  const report = reviewedImplementationReport(page);
  await expect(report).toContainText(/Attempt 2 · succeeded/iu);
  return report;
}

function reviewedImplementationReport(page: Page): Locator {
  const workflows = page.locator('.activity-drawer').getByRole('tabpanel', { name: 'Workflows' });
  return workflows
    .getByRole('region', { name: 'Workflow node status' })
    .getByRole('article')
    .filter({ has: page.getByText('Implementation', { exact: true }) });
}

async function approveWorkflowLaunch(page: Page, workflows: Locator, title: string): Promise<void> {
  const decision = workflows
    .getByRole('region', { name: 'Workflow decisions' })
    .getByRole('article')
    .filter({ hasText: `Start ${title}` });
  await expect(decision).toBeVisible({ timeout: 20_000 });
  await decision.getByRole('button', { name: 'Review what will run' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review what will run' });
  await dialog.getByRole('button', { name: 'Continue to approval' }).click();
  await expect(dialog).toBeHidden();
}
