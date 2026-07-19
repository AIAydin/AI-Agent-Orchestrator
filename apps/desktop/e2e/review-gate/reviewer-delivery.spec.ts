import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';

import { launchDesktop, watchExternalRequests } from '../support/electron.js';
import { currentProjectPath, git } from '../git/connections/repository.js';
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

const IDENTITY = {
  name: 'Forgeboard Reviewer E2E',
  email: 'reviewer-e2e@forgeboard.invalid',
};

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
    await page.getByRole('button', { name: 'Zoom to fit the canvas' }).click();
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
      'Queued to try again after the review asked for changes',
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
      /succeeded/iu,
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
    await expect(implementationReport).toContainText(/Attempt 2 · succeeded/iu);
    await implementationReport.getByRole('button', { name: 'Review this agent worktree' }).click();

    const reviewDialog = page.getByRole('dialog', { name: /Review changes in forgeboard-demo/ });
    await expect(reviewDialog).toBeVisible();
    await reviewDialog.getByRole('tab', { name: 'Uncommitted changes', exact: true }).click();
    const changedFiles = reviewDialog
      .getByRole('navigation', { name: 'Changed files' })
      .locator('.git-file-select');
    await expect(changedFiles).toHaveCount(1);
    const changedFile = (await changedFiles.locator('strong').innerText()).trim();
    expect(changedFile).toMatch(/^forgeboard-agent-output-[a-f0-9]{8}\.md$/u);
    await reviewDialog.getByRole('button', { name: `Add ${changedFile} to commit` }).click();
    await expect(
      reviewDialog.getByRole('button', { name: `Remove ${changedFile} from commit` }),
    ).toBeVisible();
    await reviewDialog.getByLabel('Commit message').fill('Bind exact reviewed workflow output');
    await reviewDialog.getByRole('button', { name: /Review commit/ }).click();
    const commitDisclosure = page.getByRole('alertdialog', {
      name: 'Review your commit',
    });
    await expect(commitDisclosure).toContainText(changedFile);
    await queueWorkflowNativeResponse(app, 1);
    await commitDisclosure.getByRole('button', { name: 'Continue' }).click();
    await expect(reviewDialog).toContainText(/Created commit [a-f0-9]{12}\./u);
    const primaryPath = await currentProjectPath(page);
    const worktreePath = await findChangedWorktree(primaryPath, changedFile);
    const reviewedContent = await readFile(join(worktreePath, changedFile), 'utf8');
    await writeFile(
      join(primaryPath, changedFile),
      'primary conflict for visual recovery\n',
      'utf8',
    );
    git(primaryPath, ['add', '--', changedFile]);
    git(primaryPath, [
      '-c',
      `user.name=${IDENTITY.name}`,
      '-c',
      `user.email=${IDENTITY.email}`,
      'commit',
      '-m',
      'Create primary conflict for visual recovery',
    ]);
    await reviewDialog.getByRole('tab', { name: 'Committed changes', exact: true }).click();
    const readiness = reviewDialog.getByRole('region', { name: 'Delivery readiness' });
    await expect(readiness).toContainText('Not ready for delivery');
    const execution = readiness.getByRole('combobox', { name: 'Verified workflow execution' });
    await expect(execution.locator('option')).toHaveCount(1);
    await expect(execution.locator('option').first()).toContainText('revision');
    const mandatoryTest = readiness.getByRole('checkbox', { name: /^Tests?\b/u });
    await expect(mandatoryTest).toBeChecked();
    await expect(mandatoryTest).toBeDisabled();
    await readiness.getByRole('button', { name: 'Save delivery requirements' }).click();
    await expect(readiness.getByRole('button', { name: 'Run Test' })).toBeEnabled();
    await expect(readiness.getByRole('button', { name: 'Approve quality' })).toBeDisabled();

    await queueWorkflowNativeResponse(app, 1);
    await readiness.getByRole('button', { name: 'Run Test' }).click();
    await expect(readiness).toContainText('Passed', { timeout: 20_000 });
    await expect(readiness.getByRole('button', { name: 'Approve quality' })).toBeEnabled();
    await queueWorkflowNativeResponse(app, 1);
    await readiness.getByRole('button', { name: 'Approve quality' }).click();
    await expect(readiness).toContainText('Ready for delivery review');

    const delivery = reviewDialog.getByRole('region', {
      name: 'Deliver the reviewed changes to the primary branch',
    });
    await delivery.getByLabel('Delivery method').selectOption('merge-commit');
    await delivery.getByRole('button', { name: 'Review delivery…' }).click();
    const deliveryDisclosure = page.getByRole('alertdialog', {
      name: 'Review delivery to the primary branch',
    });
    await expect(deliveryDisclosure).toContainText('Create a merge commit on the primary branch');
    await queueWorkflowNativeResponse(app, 1);
    await deliveryDisclosure
      .getByRole('button', { name: 'Continue to final confirmation' })
      .click();

    await expect(reviewDialog.getByText('Resolve the Git operation')).toBeVisible();
    await expect(reviewDialog.getByLabel('Conflicted file')).toHaveValue(changedFile);
    await expect(reviewDialog.getByLabel('Ours')).toHaveValue(
      'primary conflict for visual recovery\n',
    );
    await expect(reviewDialog.getByLabel('Theirs')).toHaveValue(reviewedContent);
    await reviewDialog.getByRole('button', { name: 'Use theirs' }).click();
    await expect(reviewDialog.getByLabel('Merged result')).toHaveValue(reviewedContent);
    await reviewDialog.getByRole('button', { name: 'Review resolved file…' }).click();
    await queueWorkflowNativeResponse(app, 1);
    await reviewDialog.getByRole('button', { name: 'Confirm apply and stage…' }).click();
    await expect(reviewDialog).toContainText(`${changedFile} is resolved and staged`);
    await reviewDialog.getByRole('button', { name: 'Review Continue…' }).click();
    await queueWorkflowNativeResponse(app, 1);
    await reviewDialog.getByRole('button', { name: 'Confirm continue in system dialog…' }).click();
    await expect
      .poll(() => git(primaryPath, ['status', '--porcelain=v1', '--untracked-files=all']))
      .toBe('');
    await expect
      .poll(async () => await readFile(join(primaryPath, changedFile), 'utf8'))
      .toBe(reviewedContent);
    expect(externalRequests).toEqual([]);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function findChangedWorktree(primaryPath: string, changedFile: string): Promise<string> {
  const primary = await realpath(primaryPath);
  const candidates = git(primaryPath, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
  for (const candidate of candidates) {
    if ((await realpath(candidate)) === primary) continue;
    try {
      await readFile(join(candidate, changedFile));
      return candidate;
    } catch {
      // Keep looking for the managed worktree that owns this exact reviewed output.
    }
  }
  throw new Error(`No managed worktree contains ${changedFile}.`);
}

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
  await settings.getByLabel('Git identity name').fill(IDENTITY.name);
  await settings.getByLabel('Git identity email').fill(IDENTITY.email);
  await settings.getByRole('button', { name: 'Agents & runtime', exact: true }).click();
  const codex = settings.locator('.provider-connection-card').filter({ hasText: 'Codex CLI' });
  await codex.getByText('Advanced', { exact: true }).click();
  await codex.getByLabel('Executable override').fill(fakeCodex);
  await queueWorkflowNativeResponse(app, 1);
  await codex.getByRole('button', { name: 'Connect with OpenAI' }).click();
  await expect(codex).toContainText('Connected', { timeout: 20_000 });
  await queueWorkflowNativeResponse(app, 1);
  await codex.getByRole('button', { name: 'Check OpenAI Codex CLI again' }).click();
  await expect(codex).toContainText('OpenAI Codex CLI executable is ready');
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
  await page.getByRole('article', { name: 'Agent: Implementation', exact: true }).click();
  let agent = page.getByRole('region', { name: 'Agent run settings' });
  await agent.getByLabel('Agent to run').selectOption('test-agent');
  await agent.getByLabel('Permission profile').selectOption('worktree-write');
  await agent.getByLabel('Prompt').fill('Create the exact implementation output for review.');

  const reviewer = await addNodeAt(page, /^Agent/u, 'Agent: Agent', { x: 510, y: 470 });
  await reviewer.click();
  await page.locator('.inspector').getByLabel('Title').fill('Codex reviewer');
  await page.getByRole('article', { name: 'Agent: Codex reviewer', exact: true }).click();
  agent = page.getByRole('region', { name: 'Agent run settings' });
  await agent.getByLabel('Agent to run').selectOption('codex');
  await agent.getByLabel('Permission profile').selectOption('plan-read-only');
  await agent.getByLabel('Prompt').fill('Review the exact bound implementation output.');

  const testNode = await addNodeAt(page, /^Test/u, 'Test: Test', { x: 510, y: 150 });
  await testNode.click();
  await page.locator('.inspector').getByLabel('Title').fill('Verification test');
  await page.getByRole('article', { name: 'Test: Verification test', exact: true }).click();
  const testConfiguration = page.getByRole('group', { name: 'Test command configuration' });
  await testConfiguration.getByLabel('Kind of check').selectOption('test');
  await testConfiguration.getByLabel('Program').fill(process.execPath);
  await testConfiguration.getByLabel(/Arguments/u).fill(`-e\n${attemptScript(counterPath)}`);
  await testConfiguration.getByLabel(/Folder to run in/u).fill('.');

  const gate = await addNodeAt(page, /^Review gate/u, 'Review gate: Review gate', {
    x: 850,
    y: 160,
  });
  await gate.click();
  await page.locator('.inspector').getByLabel('Title').fill('Review gate');
  await page.getByRole('article', { name: 'Review gate: Review gate', exact: true }).click();
  const gateConfiguration = page.getByRole('region', { name: 'Review gate configuration' });
  const human = gateConfiguration.getByRole('checkbox', { name: /Require human approval/u });
  if (await human.isChecked()) await human.uncheck();
  await gateConfiguration.getByRole('checkbox', { name: 'Tests must pass' }).check();
  await gateConfiguration.getByRole('checkbox', { name: /Verification test/u }).check();
  await gateConfiguration.getByRole('combobox', { name: /Reviewer agent/u }).selectOption({
    label: 'Codex reviewer · codex',
  });
  await gateConfiguration.getByLabel('Maximum attempts').fill('2');
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
    .filter({ hasText: `Start ${title}` });
  try {
    await expect(decision).toBeVisible({ timeout: 20_000 });
  } catch (error) {
    throw new Error(
      `No launch decision for ${title}. Workflow UI: ${await workflows.innerText()}`,
      {
        cause: error,
      },
    );
  }
  await decision.getByRole('button', { name: 'Review what will run' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review what will run' });
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
  await dialog.getByRole('button', { name: 'Continue to approval' }).click();
  expect(await waitForWorkflowNativeDialog(app, nativeDialogIndex)).toMatchObject({
    title: 'Run workflow node',
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
  const lifecycle = workflows.getByRole('region', { name: 'Workflow node status' });
  return lifecycle
    .getByRole('article')
    .filter({ has: workflows.page().getByText(title, { exact: true }) });
}
