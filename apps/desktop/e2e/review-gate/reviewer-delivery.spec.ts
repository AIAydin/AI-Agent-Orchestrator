import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';

import { launchDesktop, watchExternalRequests } from '../support/electron.js';
import {
  installWorkflowNativeDialogHarness,
  queueWorkflowNativeResponse,
  waitForWorkflowNativeDialog,
} from '../test-node/native-confirmation.js';
import {
  REVIEW_CHECK_MARKER,
  addNodeAt,
  connectAndConfigure,
  installFakeCodex,
} from './fixture.js';

test('reviewer-backed bounded revision becomes exact Git delivery evidence entirely through the UI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-review-gate-e2e-'));
  const userDataDirectory = join(root, 'user-data');
  const worktreeRoot = join(await realpath(root), 'managed-worktrees');
  const counterPath = join(root, 'review-test-attempt.txt');
  const fakeCodex = await installFakeCodex(root);
  const externalRequests: string[] = [];
  let app: ElectronApplication | null = null;

  try {
    const session = await launchDesktop(userDataDirectory);
    app = session.app;
    const page = session.page;
    watchExternalRequests(page, externalRequests);
    await installWorkflowNativeDialogHarness(app);

    await page.getByRole('button', { name: 'Use safe defaults' }).click();
    await configureSettings(app, page, worktreeRoot, fakeCodex);
    await page.getByRole('button', { name: /Explore the safe demo/i }).click();

    const nodes = await configureWorkflow(page, counterPath);
    await page.getByRole('button', { name: 'Fit canvas' }).click();
    await connectAndConfigure(page, nodes.implementation, nodes.testNode, 'output');
    await connectAndConfigure(page, nodes.implementation, nodes.gate, 'review');
    await connectAndConfigure(page, nodes.gate, nodes.implementation, 'revision');
    await expect(page.locator('.canvas-title')).toContainText('4 nodes · 3 connections');
    await expect(page.locator('.autosave-state')).toHaveText('Saved locally');

    await page.getByRole('button', { name: 'Run canvas' }).click();
    const workflows = await openWorkflows(page);
    let nativeDialogIndex = 1;
    nativeDialogIndex = await approveLaunch(
      app,
      page,
      workflows,
      'Implementation',
      nativeDialogIndex,
    );
    nativeDialogIndex = await approveLaunch(
      app,
      page,
      workflows,
      'Codex reviewer',
      nativeDialogIndex,
    );
    nativeDialogIndex = await approveLaunch(
      app,
      page,
      workflows,
      'Verification test',
      nativeDialogIndex,
    );
    await expect(workflowNode(workflows, 'Implementation')).toContainText('Attempt 2', {
      timeout: 20_000,
    });
    await expect(workflowNode(workflows, 'Review gate')).toContainText('Attempt 2');
    await expect(workflowNode(workflows, 'Codex reviewer')).toContainText(
      'Queued for bounded revision after actionable review feedback',
    );
    await nodes.gate.click();
    let gateConfiguration = page.getByRole('region', { name: 'Review gate configuration' });
    await expect(gateConfiguration).toContainText('Pending');
    await expect(gateConfiguration.getByLabel('Reviewer assessment')).toHaveCount(0);
    nativeDialogIndex = await approveLaunch(
      app,
      page,
      workflows,
      'Implementation',
      nativeDialogIndex,
    );
    nativeDialogIndex = await approveLaunch(
      app,
      page,
      workflows,
      'Codex reviewer',
      nativeDialogIndex,
    );
    await approveLaunch(app, page, workflows, 'Verification test', nativeDialogIndex);
    await expect(workflows.getByRole('region', { name: 'Workflow run summary' })).toContainText(
      'succeeded',
      { timeout: 20_000 },
    );

    await nodes.gate.click();
    gateConfiguration = page.getByRole('region', { name: 'Review gate configuration' });
    await expect(gateConfiguration).toContainText('Passed');
    const evidence = gateConfiguration.getByRole('region', {
      name: 'Authoritative review gate evidence',
    });
    await expect(evidence).toContainText('Attempt 2');
    await expect(evidence).toContainText('reviewer passed');
    await expect(evidence.getByLabel('Selected check evidence')).toContainText(
      'test · test · passed · exit 0',
    );
    await expect(evidence.getByLabel('Reviewer assessment')).toContainText(
      'Offline Codex fixture approved the exact bound output.',
    );

    const activity = page.locator('.activity-drawer');
    await activity.getByRole('tab', { name: /Workflows/ }).click();
    const implementationReport = workflowNode(workflows, 'Implementation');
    await expect(implementationReport).toContainText('Attempt 2 · succeeded');
    await implementationReport.getByRole('button', { name: 'Review this agent worktree' }).click();

    const reviewDialog = page.getByRole('dialog', { name: /Review changes in forgeboard-demo/ });
    await expect(reviewDialog).toBeVisible();
    await reviewDialog.getByRole('tab', { name: 'Staged & unstaged' }).click();
    const changedFiles = reviewDialog
      .getByRole('navigation', { name: 'Changed files' })
      .locator('.git-file-select');
    await expect(changedFiles).toHaveCount(1);
    const changedFile = (await changedFiles.locator('strong').innerText()).trim();
    expect(changedFile).toMatch(/^forgeboard-agent-output-[a-f0-9]{8}\.md$/u);
    await reviewDialog.getByRole('button', { name: `Stage ${changedFile}` }).click();
    await expect(
      reviewDialog.getByRole('button', { name: `Unstage ${changedFile}` }),
    ).toBeVisible();
    await expect(
      reviewDialog.getByRole('region', { name: `Diff for ${changedFile}` }),
    ).toContainText('Create the exact implementation output for review.');
    await reviewDialog.getByLabel('Commit message').fill('Bind exact reviewed workflow output');
    await reviewDialog.getByRole('button', { name: /Review commit/ }).click();
    const commitDisclosure = page.getByRole('alertdialog', {
      name: 'Review the exact local commit',
    });
    await expect(commitDisclosure).toContainText(changedFile);
    await queueWorkflowNativeResponse(app, 1);
    await commitDisclosure.getByRole('button', { name: 'Continue to system confirmation' }).click();
    await expect(reviewDialog).toContainText(/Created local commit [a-f0-9]{12}\./u);
    await reviewDialog.getByRole('tab', { name: 'Changes vs base' }).click();
    const readiness = reviewDialog.getByRole('region', { name: 'Delivery readiness' });
    await expect(readiness).toContainText('Not ready for delivery');
    const execution = readiness.getByRole('combobox', { name: 'Verified workflow execution' });
    await expect(execution.locator('option')).toHaveCount(1);
    await expect(execution.locator('option').first()).toContainText('revision');
    const mandatoryTest = readiness.getByRole('checkbox', { name: /^Tests?\b/u });
    await expect(mandatoryTest).toBeChecked();
    await expect(mandatoryTest).toBeDisabled();
    await readiness.getByRole('button', { name: 'Bind workflow requirements' }).click();
    await expect(readiness.getByRole('button', { name: 'Run Test' })).toBeEnabled();
    await expect(
      readiness.getByRole('button', { name: 'Approve reviewed quality' }),
    ).toBeDisabled();

    await queueWorkflowNativeResponse(app, 1);
    await readiness.getByRole('button', { name: 'Run Test' }).click();
    await expect(readiness).toContainText('Passed', { timeout: 20_000 });
    await expect(readiness.getByRole('button', { name: 'Approve reviewed quality' })).toBeEnabled();
    await queueWorkflowNativeResponse(app, 1);
    await readiness.getByRole('button', { name: 'Approve reviewed quality' }).click();
    await expect(readiness).toContainText('Ready for delivery review');
    expect(externalRequests).toEqual([]);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function configureSettings(
  app: ElectronApplication,
  page: Page,
  worktreeRoot: string,
  fakeCodex: string,
) {
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.locator('.settings-modal');
  await settings.getByRole('button', { name: /Git & previews/ }).click();
  await settings.getByLabel('Managed worktree location').fill(worktreeRoot);
  await settings.getByLabel('Git identity name').fill('Forgeboard Reviewer E2E');
  await settings.getByLabel('Git identity email').fill('reviewer-e2e@forgeboard.invalid');
  await settings.getByRole('button', { name: 'Agents & runtime', exact: true }).click();
  const codex = settings.locator('.provider-connection-card').filter({ hasText: 'Codex CLI' });
  await codex.getByText('Advanced', { exact: true }).click();
  await codex.getByLabel('Executable override').fill(fakeCodex);
  await queueWorkflowNativeResponse(app, 1);
  await codex.getByRole('button', { name: /Refresh OpenAI Codex CLI readiness/u }).click();
  await expect(codex).toContainText('Validated');
  await settings.getByRole('button', { name: 'Checks', exact: true }).click();
  const testCommand = settings.getByRole('group', { name: 'Tests command' });
  await testCommand.getByLabel('Executable').fill(process.execPath);
  await testCommand
    .getByLabel('Arguments')
    .fill(`-e\nprocess.stdout.write(${JSON.stringify(REVIEW_CHECK_MARKER)})`);
  await settings.getByRole('button', { name: /Save settings/ }).click();
  await expect(settings).toBeHidden();
}

async function configureWorkflow(page: Page, counterPath: string) {
  const implementation = await addNodeAt(page, /^Agent/u, 'Agent: Agent', { x: 130, y: 160 });
  await implementation.click();
  await page.locator('.inspector').getByLabel('Title').fill('Implementation');
  let agent = page.getByRole('region', { name: 'Agent run configuration' });
  await agent.getByLabel('Installed adapter').selectOption('test-agent');
  await agent.getByLabel('Permission profile').selectOption('worktree-write');
  await agent.getByLabel('Prompt').fill('Create the exact implementation output for review.');

  const reviewer = await addNodeAt(page, /^Agent/u, 'Agent: Agent', { x: 510, y: 470 });
  await reviewer.click();
  await page.locator('.inspector').getByLabel('Title').fill('Codex reviewer');
  agent = page.getByRole('region', { name: 'Agent run configuration' });
  await agent.getByLabel('Installed adapter').selectOption('codex');
  await agent.getByLabel('Permission profile').selectOption('plan-read-only');
  await agent.getByLabel('Prompt').fill('Review the exact bound implementation output.');

  const testNode = await addNodeAt(page, /^Test/u, 'Test: Test', { x: 510, y: 150 });
  await testNode.click();
  await page.locator('.inspector').getByLabel('Title').fill('Verification test');
  const testConfiguration = page.getByRole('group', { name: 'Test command configuration' });
  await testConfiguration.getByLabel('Check kind').selectOption('test');
  await testConfiguration.getByLabel('Executable').fill(process.execPath);
  await testConfiguration.getByLabel(/Arguments/u).fill(`-e\n${attemptScript(counterPath)}`);
  await testConfiguration.getByLabel(/Working directory/u).fill('.');

  const gate = await addNodeAt(page, /^Review gate/u, 'Review gate: Review gate', {
    x: 850,
    y: 160,
  });
  await gate.click();
  await page.locator('.inspector').getByLabel('Title').fill('Review gate');
  const gateConfiguration = page.getByRole('region', { name: 'Review gate configuration' });
  const human = gateConfiguration.getByRole('checkbox', { name: /Require human approval/u });
  if (await human.isChecked()) await human.uncheck();
  await gateConfiguration.getByRole('checkbox', { name: 'Tests must pass' }).check();
  await gateConfiguration.getByRole('checkbox', { name: /Verification test/u }).check();
  await gateConfiguration.getByRole('combobox', { name: /Reviewer agent/u }).selectOption({
    label: 'Codex reviewer · codex',
  });
  await gateConfiguration.getByLabel('Maximum iterations').fill('2');
  return {
    implementation: page.getByRole('article', { name: 'Agent: Implementation', exact: true }),
    reviewer: page.getByRole('article', { name: 'Agent: Codex reviewer', exact: true }),
    testNode: page.getByRole('article', { name: 'Test: Verification test', exact: true }),
    gate: page.getByRole('article', { name: 'Review gate: Review gate', exact: true }),
  };
}

async function openWorkflows(page: Page): Promise<Locator> {
  const drawer = page.locator('.activity-drawer');
  await drawer.getByRole('tab', { name: /Workflows/ }).click();
  return drawer.getByRole('tabpanel', { name: 'Workflows' });
}

async function approveLaunch(
  app: ElectronApplication,
  page: Page,
  workflows: Locator,
  title: string,
  _nativeDialogIndex: number,
): Promise<number> {
  void _nativeDialogIndex;
  const decision = workflows
    .getByRole('region', { name: 'Workflow decisions' })
    .getByRole('article')
    .filter({ hasText: `Launch ${title}` });
  await expect(decision).toBeVisible({ timeout: 20_000 });
  await decision.getByRole('button', { name: 'Review launch' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review this workflow launch' });
  await expect(dialog).toContainText(
    title === 'Verification test'
      ? 'exact-check'
      : title === 'Codex reviewer'
        ? 'OpenAI'
        : 'Local deterministic test process',
  );
  const nativeDialogIndex = await app.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __forgeboardWorkflowDialogs?: { dialogs: unknown[] };
    };
    return state.__forgeboardWorkflowDialogs?.dialogs.length ?? 0;
  });
  await queueWorkflowNativeResponse(app, 1);
  await dialog.getByRole('button', { name: 'Continue to native launch approval' }).click();
  expect(await waitForWorkflowNativeDialog(app, nativeDialogIndex)).toMatchObject({
    title: 'Launch workflow node',
    response: 1,
  });
  await expect(dialog).toBeHidden();
  return nativeDialogIndex + 1;
}

function attemptScript(counterPath: string): string {
  return [
    'const fs=require("node:fs");',
    `const path=${JSON.stringify(counterPath)};`,
    'let attempt=0;',
    'try{attempt=Number(fs.readFileSync(path,"utf8"))||0}catch(error){if(error.code!=="ENOENT")throw error}',
    'attempt+=1;',
    'fs.writeFileSync(path,String(attempt));',
    'process.stdout.write("review-test-attempt:"+String(attempt));',
  ].join('');
}

function workflowNode(workflows: Locator, title: string): Locator {
  const lifecycle = workflows.getByRole('region', { name: 'Workflow node lifecycle' });
  return lifecycle
    .getByRole('article')
    .filter({ has: workflows.page().getByText(title, { exact: true }) });
}
