import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';

import type { IpcResult, Project } from '../src/shared/application/contracts.js';
import {
  approveNextNativeAgentLaunch,
  launchDesktop,
  watchExternalRequests,
} from './support/electron.js';

const COMMIT_IDENTITY = {
  name: 'Forgeboard Worktree E2E',
  email: 'worktree-e2e@forgeboard.invalid',
};
const COMMIT_MESSAGE = 'Commit isolated deterministic agent work';
const DELIVERY_CHECK_MARKER = 'FORGEBOARD_DELIVERY_E2E';
const DELIVERY_DRIFT_FILE = 'delivery-evidence-drift.txt';

test('onboarding gates exact isolated delivery on deterministic checks and human approval', async () => {
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'forgeboard-worktree-review-e2e-'));
  const managedWorktreeRoot = join(await realpath(userDataDirectory), 'ui-configured-worktrees');
  const externalRequests: string[] = [];
  let electronApp: ElectronApplication | null = null;

  try {
    const firstSession = await launchDesktop(userDataDirectory);
    electronApp = firstSession.app;
    let page = firstSession.page;
    watchExternalRequests(page, externalRequests);

    await page.getByRole('button', { name: 'Use safe defaults' }).click();
    await configureGitThroughUi(page, managedWorktreeRoot);
    await page.getByRole('button', { name: /Explore the safe demo/i }).click();
    await expect(page.locator('.canvas-title')).toContainText('0 nodes · 0 connections');

    const primaryPath = await currentProjectPath(page);
    const primaryHeadBefore = git(primaryPath, ['rev-parse', 'HEAD']);
    const primaryStatusBefore = git(primaryPath, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ]);
    const primaryFilesBefore = await trackedFileHashes(primaryPath);

    await page
      .locator('.template-section')
      .getByRole('button', { name: /^Agent/ })
      .click();
    const agentNode = page.getByRole('article', { name: 'Agent: Agent' });
    await expect(agentNode).toBeVisible();
    await agentNode.click();

    const runConfiguration = page.getByRole('region', { name: 'Agent run settings' });
    await runConfiguration.getByLabel('Agent to run').selectOption('test-agent');
    await runConfiguration.getByLabel('Permission profile').selectOption('worktree-write');
    await runConfiguration
      .getByLabel('Prompt')
      .fill('Create the deterministic file for isolated worktree review.');
    await runConfiguration.getByRole('button', { name: /Review & run/ }).click();

    const launchDisclosure = page.getByRole('dialog', { name: 'Review this run before it starts' });
    await expect(launchDisclosure).toContainText('Test agent in a dedicated worktree');
    await expect(launchDisclosure).toContainText('Network: provider-controlled');
    await approveNextNativeAgentLaunch(
      firstSession.app,
      launchDisclosure,
      'test-agent',
      async () => {
        await launchDisclosure.getByRole('button', { name: 'Approve and start' }).click();
      },
    );
    await expect(page.locator('.run-history')).toContainText('succeeded · 1 changed file', {
      timeout: 20_000,
    });

    const firstReport = await openOnlyChangeReport(page);
    const changedFile = (await firstReport.locator('code').innerText()).trim();
    expect(changedFile).toMatch(/^forgeboard-agent-output-[a-f0-9]{8}\.md$/u);
    const worktreePath = await findChangedWorktree(primaryPath, changedFile);
    const agentFileContent = await readFile(join(worktreePath, changedFile), 'utf8');
    expect(agentFileContent).toContain('# Forgeboard deterministic agent output');

    await firstReport.getByRole('button', { name: 'Review this agent’s changes' }).click();
    let reviewDialog = page.getByRole('dialog', { name: /Review changes in forgeboard-demo/ });
    await expect(reviewDialog.getByText('Agent workspace', { exact: true })).toBeVisible();
    const targetRegion = reviewDialog.getByRole('region', { name: 'Agent workspace details' });
    await expect(targetRegion).toContainText(
      'Adding, discarding, and committing changes happens only in this workspace',
    );
    await expect(targetRegion).toContainText('main project files stay untouched');
    const isolatedRunLabel = await targetRegion.locator('strong').innerText();

    const baseComparisonTab = reviewDialog.getByRole('tab', { name: 'Committed changes' });
    await expect(baseComparisonTab).toHaveAttribute('aria-selected', 'true');
    await expect(reviewDialog).toContainText('No committed changes to compare');
    await reviewDialog.getByRole('tab', { name: 'Uncommitted changes' }).click();
    await reviewDialog.getByRole('button', { name: `Add ${changedFile} to commit` }).click();
    await expect(
      reviewDialog.getByRole('button', { name: `Remove ${changedFile} from commit` }),
    ).toBeVisible();
    await reviewDialog.getByLabel('Commit message').fill(COMMIT_MESSAGE);
    await reviewDialog.getByRole('button', { name: /Review commit/ }).click();

    const commitDisclosure = page.getByRole('alertdialog', {
      name: 'Review your commit',
    });
    await expect(commitDisclosure).toContainText('Agent workspace · run');
    await expect(commitDisclosure).toContainText(
      isolatedRunLabel.replace('Agent workspace · ', ''),
    );
    await expect(commitDisclosure).toContainText(COMMIT_MESSAGE);
    await expect(commitDisclosure).toContainText(COMMIT_IDENTITY.name);
    await expect(commitDisclosure).toContainText(COMMIT_IDENTITY.email);
    await expect(commitDisclosure).toContainText(changedFile);

    await approveNativeDialogs(electronApp);
    await commitDisclosure.getByRole('button', { name: 'Continue' }).click();
    await expect(reviewDialog).toContainText(/Created commit [a-f0-9]{12}\./u);
    await expect(reviewDialog).toContainText(
      'No changes to review. Everything here is already committed.',
    );

    const worktreeHeadAfter = git(worktreePath, ['rev-parse', 'HEAD']);
    expect(worktreeHeadAfter).not.toBe(primaryHeadBefore);
    expect(git(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('');
    expect(git(worktreePath, ['log', '-1', '--format=%an%x00%ae%x00%s'])).toBe(
      `${COMMIT_IDENTITY.name}\0${COMMIT_IDENTITY.email}\0${COMMIT_MESSAGE}`,
    );
    await assertPrimaryCheckoutUnchanged({
      primaryPath,
      primaryHeadBefore,
      primaryStatusBefore,
      primaryFilesBefore,
      changedFile,
    });

    await electronApp.close();
    electronApp = null;

    const secondSession = await launchDesktop(userDataDirectory);
    electronApp = secondSession.app;
    page = secondSession.page;
    watchExternalRequests(page, externalRequests);
    await approveNativeDialogs(electronApp);
    await page
      .locator('.recent-list button.recent-open')
      .filter({ hasText: 'forgeboard-demo' })
      .click();
    await expect(page.locator('.canvas-title')).toContainText('1 nodes · 0 connections');

    const persistedReport = await openOnlyChangeReport(page);
    await expect(persistedReport).toContainText(changedFile);
    await persistedReport.getByRole('button', { name: 'Review this agent’s changes' }).click();
    reviewDialog = page.getByRole('dialog', { name: /Review changes in forgeboard-demo/ });
    await expect(reviewDialog.getByText('Agent workspace', { exact: true })).toBeVisible();
    await expect(
      reviewDialog.getByRole('region', { name: 'Agent workspace details' }),
    ).toContainText(isolatedRunLabel);
    await expect(reviewDialog.getByRole('tab', { name: 'Committed changes' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(reviewDialog).toContainText('Committed changes');
    await expect(reviewDialog).toContainText(changedFile);
    await expect(reviewDialog).toContainText('Committed (read-only)');
    await reviewDialog.getByRole('tab', { name: 'Uncommitted changes' }).click();
    await expect(reviewDialog).toContainText(
      'No changes to review. Everything here is already committed.',
    );
    expect(git(worktreePath, ['rev-parse', 'HEAD'])).toBe(worktreeHeadAfter);
    expect(git(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('');
    await assertPrimaryCheckoutUnchanged({
      primaryPath,
      primaryHeadBefore,
      primaryStatusBefore,
      primaryFilesBefore,
      changedFile,
    });

    await reviewDialog.getByRole('tab', { name: 'Committed changes' }).click();
    const readiness = reviewDialog.getByRole('region', { name: 'Delivery readiness' });
    const delivery = reviewDialog.getByRole('region', {
      name: 'Deliver the reviewed changes to the primary branch',
    });
    const reviewDelivery = delivery.getByRole('button', { name: /Review delivery/ });
    await expect(readiness).toContainText('Not ready for delivery');
    await expect(reviewDelivery).toBeDisabled();
    await expect(delivery).toContainText(
      'Run every required check and approve the quality of the current changes first.',
    );

    const lintRequirement = readiness.getByRole('checkbox', { name: /^Lint\b/ });
    await expect(lintRequirement).toBeChecked();
    await lintRequirement.uncheck();
    await expect(readiness.getByRole('button', { name: 'Save required checks' })).toBeDisabled();
    await lintRequirement.check();
    await readiness.getByRole('button', { name: 'Save required checks' }).click();
    await expect(readiness.getByRole('button', { name: 'Run Lint' })).toBeEnabled();
    await expect(reviewDelivery).toBeDisabled();

    const dialogsBeforeCheck = await nativeDialogs(electronApp);
    await readiness.getByRole('button', { name: 'Run Lint' }).click();
    await expect(readiness).toContainText('Passed', { timeout: 20_000 });
    await expect(reviewDialog).toContainText('The check passed. Delivery status was refreshed.');
    const checkDialog = (await nativeDialogs(electronApp)).at(dialogsBeforeCheck.length);
    expectNativeCancelDefault(checkDialog, 'Run delivery check?', ['Cancel', 'Run check']);
    expect(nativeDialogText(checkDialog)).toContain('Lint');
    expect(nativeDialogText(checkDialog)).toContain(DELIVERY_CHECK_MARKER);
    await expect(reviewDelivery).toBeDisabled();

    const dialogsBeforeApproval = await nativeDialogs(electronApp);
    await readiness.getByRole('button', { name: 'Approve quality' }).click();
    await expect(readiness).toContainText('Ready for delivery review');
    await expect(readiness.locator('.git-delivery-quality-binding')).toContainText(
      worktreeHeadAfter.slice(0, 12),
    );
    const approvalDialog = (await nativeDialogs(electronApp)).at(dialogsBeforeApproval.length);
    expectNativeCancelDefault(approvalDialog, 'Approve quality for delivery?', [
      'Cancel',
      'Approve quality',
    ]);
    expect(nativeDialogText(approvalDialog)).toContain(
      'Approve these exact changes and their check results for delivery?',
    );
    await expect(reviewDelivery).toBeEnabled();
    await expect(delivery).toContainText(
      "Forgeboard will double-check the agent's work and the primary branch before delivering.",
    );

    await writeFile(join(worktreePath, DELIVERY_DRIFT_FILE), 'new exact delivery source\n', 'utf8');
    git(worktreePath, ['add', '--', DELIVERY_DRIFT_FILE]);
    git(worktreePath, [
      '-c',
      `user.name=${COMMIT_IDENTITY.name}`,
      '-c',
      `user.email=${COMMIT_IDENTITY.email}`,
      'commit',
      '-m',
      'Change exact delivery evidence',
    ]);
    const deliveryHead = git(worktreePath, ['rev-parse', 'HEAD']);
    expect(deliveryHead).not.toBe(worktreeHeadAfter);

    await reviewDialog.getByRole('button', { name: 'Refresh Git changes' }).click();
    await expect(readiness).toContainText('Not ready for delivery');
    await expect(readiness).toContainText('Existing delivery readiness is out of date');
    await expect(reviewDelivery).toBeDisabled();

    await readiness.getByRole('button', { name: 'Save required checks' }).click();
    await readiness.getByRole('button', { name: 'Run Lint' }).click();
    await expect(readiness).toContainText('Passed', { timeout: 20_000 });
    await readiness.getByRole('button', { name: 'Approve the current results' }).click();
    await expect(readiness).toContainText('Ready for delivery review');
    await expect(readiness.locator('.git-delivery-quality-binding')).toContainText(
      deliveryHead.slice(0, 12),
    );
    await expect(reviewDelivery).toBeEnabled();

    await delivery.getByLabel('Delivery method').selectOption('fast-forward-only');
    await reviewDelivery.click();

    const deliveryDisclosure = page.getByRole('alertdialog', {
      name: 'Review delivery to the primary branch',
    });
    await expect(deliveryDisclosure).toContainText('Move the primary branch forward');
    await expect(deliveryDisclosure).toContainText(COMMIT_IDENTITY.name);
    await expect(deliveryDisclosure).toContainText(COMMIT_IDENTITY.email);
    await expect(deliveryDisclosure).toContainText(deliveryHead);
    await expect(deliveryDisclosure).toContainText(changedFile);
    await expect(deliveryDisclosure).toContainText(DELIVERY_DRIFT_FILE);
    await expect(deliveryDisclosure).toContainText('Required checks for this exact delivery');
    await expect(deliveryDisclosure).toContainText('approved these exact check results');
    await expect(deliveryDisclosure).toContainText(
      'before you confirm and again before it updates the primary branch',
    );

    await deliveryDisclosure
      .getByRole('button', { name: 'Continue to final confirmation' })
      .click();
    await expect(reviewDialog).toContainText(
      'Delivered the reviewed commits to your main project at',
      {
        timeout: 20_000,
      },
    );
    await expect(delivery).toContainText('Delivered to the primary branch at');

    expect(git(primaryPath, ['rev-parse', 'HEAD'])).toBe(deliveryHead);
    expect(git(primaryPath, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('');
    expect(await readFile(join(primaryPath, changedFile), 'utf8')).toBe(agentFileContent);
    expect(await readFile(join(primaryPath, DELIVERY_DRIFT_FILE), 'utf8')).toBe(
      'new exact delivery source\n',
    );
    expect(externalRequests).toEqual([]);
  } finally {
    await electronApp?.close().catch(() => undefined);
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

async function configureGitThroughUi(page: Page, managedWorktreeRoot: string): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.locator('.settings-modal');
  await settings.getByRole('button', { name: /Git & previews/ }).click();
  await settings.getByLabel('Managed worktree location').fill(managedWorktreeRoot);
  await settings.getByLabel('Git identity name').fill(COMMIT_IDENTITY.name);
  await settings.getByLabel('Git identity email').fill(COMMIT_IDENTITY.email);
  await settings.getByRole('button', { name: 'Checks', exact: true }).click();
  const lint = settings.getByRole('group', { name: 'Lint command' });
  await lint.getByLabel('Executable').fill(process.execPath);
  await lint.getByLabel('Arguments').fill(`-e\nprocess.stdout.write("${DELIVERY_CHECK_MARKER}")`);
  await settings.getByRole('button', { name: /Save settings/ }).click();
  await expect(settings).toBeHidden();
}

async function currentProjectPath(page: Page): Promise<string> {
  return await page.evaluate(async () => {
    const forgeboard = (
      window as unknown as {
        forgeboard: { projects: { recent(): Promise<IpcResult<Project[]>> } };
      }
    ).forgeboard;
    const result = await forgeboard.projects.recent();
    if (!result.ok) throw new Error(result.error.message);
    const project = result.value.find((candidate) => !candidate.missing);
    if (project === undefined) throw new Error('The local demo project is missing.');
    return project.path;
  });
}

async function openOnlyChangeReport(page: Page) {
  const drawer = page.locator('.activity-drawer');
  await drawer.getByRole('tab', { name: /Changes/ }).click();
  const panel = drawer.getByRole('tabpanel', { name: 'Changes' });
  const report = panel.locator('.change-report-list article');
  await expect(report).toHaveCount(1);
  await expect(report).toContainText('succeeded');
  return report;
}

interface NativeDialogRecord {
  readonly buttons?: readonly string[] | undefined;
  readonly cancelId?: number | undefined;
  readonly defaultId?: number | undefined;
  readonly detail?: string | undefined;
  readonly message?: string | undefined;
  readonly title?: string | undefined;
}

async function approveNativeDialogs(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ dialog }) => {
    const state = globalThis as typeof globalThis & {
      __forgeboardWorktreeReviewDialogs?: NativeDialogRecord[];
    };
    state.__forgeboardWorktreeReviewDialogs = [];
    Object.defineProperty(dialog, 'showMessageBox', {
      configurable: true,
      value: (...args: unknown[]) => {
        const options = args.at(-1) as NativeDialogRecord;
        state.__forgeboardWorktreeReviewDialogs?.push({
          buttons: options.buttons,
          cancelId: options.cancelId,
          defaultId: options.defaultId,
          detail: options.detail,
          message: options.message,
          title: options.title,
        });
        return Promise.resolve({ response: 1, checkboxChecked: false });
      },
    });
  });
}

async function nativeDialogs(electronApp: ElectronApplication): Promise<NativeDialogRecord[]> {
  return await electronApp.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __forgeboardWorktreeReviewDialogs?: NativeDialogRecord[];
    };
    return state.__forgeboardWorktreeReviewDialogs ?? [];
  });
}

function expectNativeCancelDefault(
  record: NativeDialogRecord | undefined,
  title: string,
  buttons: readonly string[],
): void {
  expect(record).toMatchObject({ title, buttons, defaultId: 0, cancelId: 0 });
}

function nativeDialogText(record: NativeDialogRecord | undefined): string {
  return [record?.title, record?.message, record?.detail].filter(Boolean).join('\n');
}

async function findChangedWorktree(primaryPath: string, changedFile: string): Promise<string> {
  const primaryCanonical = await realpath(primaryPath);
  const worktrees = git(primaryPath, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
  for (const candidate of worktrees) {
    if ((await realpath(candidate)) === primaryCanonical) continue;
    if (await fileExists(join(candidate, changedFile))) return candidate;
  }
  throw new Error(`No managed worktree contains ${changedFile}.`);
}

interface PrimarySnapshot {
  primaryPath: string;
  primaryHeadBefore: string;
  primaryStatusBefore: string;
  primaryFilesBefore: Readonly<Record<string, string>>;
  changedFile: string;
}

async function assertPrimaryCheckoutUnchanged(snapshot: PrimarySnapshot): Promise<void> {
  expect(git(snapshot.primaryPath, ['rev-parse', 'HEAD'])).toBe(snapshot.primaryHeadBefore);
  expect(git(snapshot.primaryPath, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe(
    snapshot.primaryStatusBefore,
  );
  expect(await trackedFileHashes(snapshot.primaryPath)).toEqual(snapshot.primaryFilesBefore);
  expect(await fileExists(join(snapshot.primaryPath, snapshot.changedFile))).toBe(false);
}

async function trackedFileHashes(repository: string): Promise<Readonly<Record<string, string>>> {
  const files = git(repository, ['ls-files']).split('\n').filter(Boolean);
  const entries = await Promise.all(
    files.map(async (file) => {
      const content = await readFile(join(repository, file));
      return [file, createHash('sha256').update(content).digest('hex')] as const;
    }),
  );
  return Object.fromEntries(entries);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function git(repository: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_PARAMETERS: undefined,
      GIT_DIR: undefined,
      GIT_INDEX_FILE: undefined,
      GIT_TERMINAL_PROMPT: '0',
      GIT_WORK_TREE: undefined,
      LC_ALL: 'C',
    },
  }).trimEnd();
}
