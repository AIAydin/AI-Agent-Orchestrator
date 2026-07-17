import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';

import type { IpcResult, Project } from '../../src/shared/application/contracts.js';
import {
  approveNextNativeAgentLaunch,
  launchDesktop,
  watchExternalRequests,
} from '../support/electron.js';

const COMMIT_IDENTITY = {
  name: 'Forgeboard Remote E2E',
  email: 'remote-e2e@forgeboard.invalid',
};
const COMMIT_MESSAGE = 'Prepare exact remote delivery';
const DELIVERY_CHECK_MARKER = 'FORGEBOARD_REMOTE_DELIVERY_E2E';
const OWNER_REPOSITORY = 'forgeboard-e2e/remote-delivery';
const REMOTE_URL = `git@github.com:${OWNER_REPOSITORY}.git`;
const REPOSITORY_URL = `https://github.com/${OWNER_REPOSITORY}`;
const PULL_REQUEST_URL = `${REPOSITORY_URL}/pull/17`;
const PULL_REQUEST_TITLE = 'Deliver the exact reviewed agent commit';
const PULL_REQUEST_BODY = 'Created only after exact local readiness and remote-head review.';

test('push and GitHub PR delivery require exact review while all transport stays local', async () => {
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'forgeboard-remote-delivery-e2e-'));
  const sandboxRoot = await realpath(userDataDirectory);
  const managedWorktreeRoot = join(sandboxRoot, 'ui-configured-worktrees');
  const fixtureBin = join(sandboxRoot, 'fixture-bin');
  const fakeGhStatePath = join(sandboxRoot, 'fake-gh-state.json');
  const fakeGhLogPath = join(sandboxRoot, 'fake-gh.jsonl');
  const fakeSshLogPath = join(sandboxRoot, 'fake-ssh.jsonl');
  const bareRemotePath = join(sandboxRoot, 'remote-delivery.git');
  const environment = preserveEnvironment([
    'PATH',
    'FORGEBOARD_FAKE_GH_STATE',
    'FORGEBOARD_FAKE_GH_LOG',
    'FORGEBOARD_FAKE_SSH_REPOSITORY',
    'FORGEBOARD_FAKE_SSH_LOG',
    'GIT_SSH_VARIANT',
    'GIT_TERMINAL_PROMPT',
  ]);
  const externalRequests: string[] = [];
  let electronApp: ElectronApplication | null = null;

  const fakeGhState: FakeGhState = {
    authenticated: true,
    repository: {
      hostname: 'github.com',
      nameWithOwner: OWNER_REPOSITORY,
      url: REPOSITORY_URL,
      defaultBranch: 'main',
    },
    expectedBaseBranch: 'main',
    expectedHeadBranch: 'pending-agent-branch',
    expectedPullRequestTitle: PULL_REQUEST_TITLE,
    expectedPullRequestBody: PULL_REQUEST_BODY,
    expectedDraft: true,
    pullRequestUrl: PULL_REQUEST_URL,
    baseOid: '0'.repeat(40),
    ciRuns: [],
  };

  try {
    await mkdir(fixtureBin, { recursive: true });
    await Promise.all([
      symlink(
        join(import.meta.dirname, 'scripts', 'fixtures', 'fake-gh.mjs'),
        join(fixtureBin, 'gh'),
      ),
      symlink(
        join(import.meta.dirname, 'scripts', 'fixtures', 'fake-ssh.mjs'),
        join(fixtureBin, 'ssh'),
      ),
      writeFile(fakeGhLogPath, '', 'utf8'),
      writeFile(fakeSshLogPath, '', 'utf8'),
      writeFakeGhState(fakeGhStatePath, fakeGhState),
    ]);
    process.env.PATH = `${fixtureBin}:${environment.PATH ?? ''}`;
    process.env.FORGEBOARD_FAKE_GH_STATE = fakeGhStatePath;
    process.env.FORGEBOARD_FAKE_GH_LOG = fakeGhLogPath;
    process.env.FORGEBOARD_FAKE_SSH_REPOSITORY = bareRemotePath;
    process.env.FORGEBOARD_FAKE_SSH_LOG = fakeSshLogPath;
    process.env.GIT_SSH_VARIANT = 'ssh';
    process.env.GIT_TERMINAL_PROMPT = '0';

    const session = await launchDesktop(userDataDirectory);
    electronApp = session.app;
    const page = session.page;
    watchExternalRequests(page, externalRequests);

    await page.getByRole('button', { name: 'Use safe defaults' }).click();
    await configureGitThroughUi(page, managedWorktreeRoot);
    await page.getByRole('button', { name: /Explore the safe demo/i }).click();
    await expect(page.locator('.canvas-title')).toContainText('0 nodes · 0 connections');

    const primaryPath = await currentProjectPath(page);
    const baseBranch = git(primaryPath, ['branch', '--show-current']);
    const baseOid = git(primaryPath, ['rev-parse', 'HEAD']);
    execFileSync('git', ['clone', '--quiet', '--bare', primaryPath, bareRemotePath], {
      env: process.env,
      stdio: 'pipe',
    });
    git(primaryPath, ['remote', 'add', 'origin', REMOTE_URL]);
    fakeGhState.repository.defaultBranch = baseBranch;
    fakeGhState.expectedBaseBranch = baseBranch;
    fakeGhState.baseOid = baseOid;
    await writeFakeGhState(fakeGhStatePath, fakeGhState);

    await page
      .locator('.template-section')
      .getByRole('button', { name: /^Agent/ })
      .click();
    const agentNode = page.getByRole('article', { name: 'Agent: Agent' });
    await agentNode.click();
    const runConfiguration = page.getByRole('region', { name: 'Agent run configuration' });
    await runConfiguration.getByLabel('Installed adapter').selectOption('test-agent');
    await runConfiguration.getByLabel('Permission profile').selectOption('worktree-write');
    await runConfiguration
      .getByLabel('Prompt')
      .fill('Create the deterministic file used by remote-delivery review.');
    await runConfiguration.getByRole('button', { name: /Review & run/ }).click();

    const launchDisclosure = page.getByRole('dialog', { name: 'Review the exact agent launch' });
    await approveNextNativeAgentLaunch(session.app, launchDisclosure, 'test-agent', async () => {
      await launchDisclosure.getByRole('button', { name: 'Approve & launch' }).click();
    });
    await expect(page.locator('.run-history')).toContainText('succeeded · 1 changed file', {
      timeout: 20_000,
    });

    const report = await openOnlyChangeReport(page);
    const changedFile = (await report.locator('code').innerText()).trim();
    const worktreePath = await findChangedWorktree(primaryPath, changedFile);
    await report.getByRole('button', { name: 'Review this agent worktree' }).click();
    let reviewDialog = page.getByRole('dialog', { name: /Review changes in forgeboard-demo/ });
    await reviewDialog.getByRole('tab', { name: 'Staged & unstaged' }).click();
    await reviewDialog.getByRole('button', { name: `Stage ${changedFile}` }).click();
    await reviewDialog.getByLabel('Commit message').fill(COMMIT_MESSAGE);
    await reviewDialog.getByRole('button', { name: /Review commit/ }).click();

    const commitDisclosure = page.getByRole('alertdialog', {
      name: 'Review the exact local commit',
    });
    await expect(commitDisclosure).toContainText(COMMIT_MESSAGE);
    await installNativeDialogHarness(electronApp);
    await commitDisclosure.getByRole('button', { name: 'Continue to system confirmation' }).click();
    await expect(reviewDialog).toContainText(/Created local commit [a-f0-9]{12}\./u);
    const sourceHead = git(worktreePath, ['rev-parse', 'HEAD']);
    const sourceBranch = git(worktreePath, ['branch', '--show-current']);
    expect(sourceHead).not.toBe(baseOid);
    await reviewDialog.getByRole('button', { name: 'Close Git review' }).click();

    await page
      .locator('.template-section')
      .getByRole('button', { name: /^Git \/ PR/ })
      .click();
    const gitPrNode = page.getByRole('article', { name: 'Git / PR: Git / PR' });
    await gitPrNode.click();
    const inspector = page.getByRole('region', { name: 'Git and pull request delivery' });
    const runPicker = inspector.getByLabel('Terminal agent run');
    await expect.poll(async () => await runPicker.locator('option').count()).toBeGreaterThan(1);
    await runPicker.selectOption({ index: 1 });
    await inspector.getByLabel('Remote', { exact: true }).fill('origin');
    await inspector.getByLabel('Destination branch').fill(sourceBranch);
    await inspector.getByLabel('Base branch').fill(baseBranch);
    await inspector.getByLabel('Pull request title').fill(PULL_REQUEST_TITLE);
    await inspector.getByLabel('Pull request body').fill(PULL_REQUEST_BODY);
    await inspector.getByLabel('Create as draft pull request').check();
    fakeGhState.expectedHeadBranch = sourceBranch;
    await writeFakeGhState(fakeGhStatePath, fakeGhState);

    await inspector.getByRole('button', { name: 'Inspect exact Git state' }).click();
    const exactState = inspector.getByRole('region', { name: 'Exact Git state' });
    await expect(exactState).toContainText(sourceBranch);
    await expect(exactState).toContainText(sourceHead);
    await expect(exactState).toContainText(baseOid);
    await expect(exactState).toContainText('ssh://github.com');
    await expect(exactState).toContainText('Blocked');
    await expect(exactState).toContainText(
      'Delivery checks and human quality approval have not been prepared.',
    );
    await expect(inspector).toContainText('Discovered in this agent worktree: origin.');

    await inspector.getByRole('button', { name: 'Open readiness checks & approval' }).click();
    reviewDialog = page.getByRole('dialog', { name: /Review changes in forgeboard-demo/ });
    const readiness = reviewDialog.getByRole('region', { name: 'Delivery readiness' });
    const lintRequirement = readiness.getByRole('checkbox', { name: /^Lint\b/ });
    await lintRequirement.uncheck();
    await lintRequirement.check();
    await readiness.getByRole('button', { name: 'Save required checks' }).click();
    await readiness.getByRole('button', { name: 'Run Lint' }).click();
    await expect(readiness).toContainText('Passed', { timeout: 20_000 });
    await readiness.getByRole('button', { name: 'Approve reviewed quality' }).click();
    await expect(readiness).toContainText('Ready for delivery review');
    await expect(readiness).toContainText(sourceHead.slice(0, 12));
    await reviewDialog.getByRole('button', { name: 'Close Git review' }).click();

    await inspector.getByRole('button', { name: 'Refresh exact Git state' }).click();
    await expect(exactState).toContainText('Evidence ready');
    await expect(inspector.getByRole('button', { name: 'Review push' })).toBeEnabled();

    await inspector.getByRole('button', { name: 'Review push' }).click();
    let planDialog = page.getByRole('alertdialog', { name: 'Review exact branch push' });
    await expect(planDialog).toContainText(sourceHead);
    await expect(planDialog).toContainText(sourceBranch);
    await expect(planDialog).toContainText(changedFile);
    await expect(planDialog).toContainText('Force push is never offered');
    const pushCancelDialogIndex = (await nativeDialogs(electronApp)).length;
    await queueNativeDialogResponse(electronApp, 0);
    await planDialog.getByRole('button', { name: 'Continue to system confirmation' }).click();
    await expect(inspector).toContainText(
      'Push cancelled in the system confirmation. No remote branch changed.',
    );
    expect(gitBareRef(bareRemotePath, sourceBranch)).toBeNull();
    expectNativeCancelDefault(
      await waitForNativeDialog(electronApp, pushCancelDialogIndex),
      'Push reviewed branch',
      ['Cancel', 'Push exact branch'],
    );

    await inspector.getByRole('button', { name: 'Review push' }).click();
    planDialog = page.getByRole('alertdialog', { name: 'Review exact branch push' });
    const pushApproveDialogIndex = (await nativeDialogs(electronApp)).length;
    await queueNativeDialogResponse(electronApp, 1);
    await planDialog.getByRole('button', { name: 'Continue to system confirmation' }).click();
    await expect(inspector).toContainText(`Pushed exact ${sourceHead}`, { timeout: 20_000 });
    expect(gitBareRef(bareRemotePath, sourceBranch)).toBe(sourceHead);
    expectNativeCancelDefault(
      await waitForNativeDialog(electronApp, pushApproveDialogIndex),
      'Push reviewed branch',
      ['Cancel', 'Push exact branch'],
    );
    const sshRecords = await readJsonLines<SshLogRecord>(fakeSshLogPath);
    expect(sshRecords).toEqual([
      {
        argv: ['git@github.com', `git-receive-pack '${OWNER_REPOSITORY}.git'`],
      },
    ]);

    fakeGhState.remoteHeadOid = sourceHead;
    await writeFakeGhState(fakeGhStatePath, fakeGhState);
    const githubDialogIndex = (await nativeDialogs(electronApp)).length;
    await queueNativeDialogResponse(electronApp, 1);
    await inspector.getByRole('button', { name: 'Check GitHub auth & repository' }).click();
    const githubStatus = inspector.getByRole('region', {
      name: 'GitHub CLI and repository status',
    });
    await expect(githubStatus).toContainText('Authenticated', { timeout: 20_000 });
    await expect(githubStatus).toContainText(OWNER_REPOSITORY);
    expectNativeCancelDefault(
      await waitForNativeDialog(electronApp, githubDialogIndex),
      'Check GitHub connection',
      ['Cancel', 'Check GitHub'],
    );
    await expect(inspector.getByRole('button', { name: 'Review pull request' })).toBeEnabled();

    const prCreatesBeforeCancel = await countGhCommand(fakeGhLogPath, ['pr', 'create']);
    await inspector.getByRole('button', { name: 'Review pull request' }).click();
    planDialog = page.getByRole('alertdialog', { name: 'Review pull request snapshot' });
    await expect(planDialog).toContainText(PULL_REQUEST_TITLE);
    await expect(planDialog).toContainText(PULL_REQUEST_BODY);
    await expect(planDialog).toContainText(sourceHead);
    await expect(planDialog).toContainText(`${baseBranch} @ ${baseOid}`);
    await expect(planDialog).toContainText('Draft');
    const prCancelDialogIndex = (await nativeDialogs(electronApp)).length;
    await queueNativeDialogResponse(electronApp, 0);
    await planDialog.getByRole('button', { name: 'Continue to system confirmation' }).click();
    await expect(inspector).toContainText(
      'Pull request cancelled in the system confirmation. Nothing was created.',
    );
    expect(await countGhCommand(fakeGhLogPath, ['pr', 'create'])).toBe(prCreatesBeforeCancel);
    expectNativeCancelDefault(
      await waitForNativeDialog(electronApp, prCancelDialogIndex),
      'Create GitHub pull request',
      ['Cancel', 'Create draft PR'],
    );

    await inspector.getByRole('button', { name: 'Review pull request' }).click();
    planDialog = page.getByRole('alertdialog', { name: 'Review pull request snapshot' });
    const prApproveDialogIndex = (await nativeDialogs(electronApp)).length;
    await queueNativeDialogResponse(electronApp, 1);
    await planDialog.getByRole('button', { name: 'Continue to system confirmation' }).click();
    const createdPullRequest = inspector.getByRole('region', { name: 'Created pull request' });
    await expect(createdPullRequest).toContainText(PULL_REQUEST_URL, { timeout: 20_000 });
    await expect(
      createdPullRequest.getByRole('button', { name: 'Copy pull request URL' }),
    ).toBeVisible();
    await expect(createdPullRequest.getByRole('link')).toHaveCount(0);
    expectNativeCancelDefault(
      await waitForNativeDialog(electronApp, prApproveDialogIndex),
      'Create GitHub pull request',
      ['Cancel', 'Create draft PR'],
    );
    const ghAfterPullRequest = await readJsonLines<GhLogRecord>(fakeGhLogPath);
    const pullRequestCommands = ghAfterPullRequest.filter((record) =>
      startsWithArguments(record.argv, ['pr', 'create']),
    );
    expect(pullRequestCommands).toHaveLength(1);
    expect(pullRequestCommands[0]).toMatchObject({
      inputCharacters: PULL_REQUEST_BODY.length,
      inputSha256: createHash('sha256').update(PULL_REQUEST_BODY).digest('hex'),
    });

    fakeGhState.ciRuns = [
      {
        databaseId: 8042,
        name: 'Remote delivery validation',
        workflowName: 'CI',
        status: 'completed',
        conclusion: 'success',
        url: `${REPOSITORY_URL}/actions/runs/8042`,
        headBranch: sourceBranch,
        headSha: sourceHead,
      },
    ];
    await writeFakeGhState(fakeGhStatePath, fakeGhState);
    const ciDialogIndex = (await nativeDialogs(electronApp)).length;
    await queueNativeDialogResponse(electronApp, 1);
    await inspector.getByRole('button', { name: 'Check CI for exact HEAD' }).click();
    const ciStatus = inspector.getByRole('region', { name: 'CI for exact source HEAD' });
    await expect(ciStatus).toContainText('1 run', { timeout: 20_000 });
    await expect(ciStatus).toContainText(sourceHead);
    await expect(ciStatus).toContainText('Remote delivery validation');
    await expect(ciStatus).toContainText('completed · success');
    await expect(ciStatus.getByRole('button', { name: 'Copy run URL' })).toBeVisible();
    expectNativeCancelDefault(
      await waitForNativeDialog(electronApp, ciDialogIndex),
      'Refresh GitHub CI status',
      ['Cancel', 'Refresh CI'],
    );

    const finalGhRecords = await readJsonLines<GhLogRecord>(fakeGhLogPath);
    expect(finalGhRecords.some((record) => startsWithArguments(record.argv, ['--version']))).toBe(
      true,
    );
    expect(
      finalGhRecords.some((record) =>
        startsWithArguments(record.argv, ['auth', 'status', '--hostname', 'github.com']),
      ),
    ).toBe(true);
    expect(
      finalGhRecords.some((record) =>
        startsWithArguments(record.argv, ['repo', 'view', `github.com/${OWNER_REPOSITORY}`]),
      ),
    ).toBe(true);
    expect(
      finalGhRecords.some(
        (record) =>
          startsWithArguments(record.argv, ['run', 'list']) &&
          flagValue(record.argv, '--branch') === sourceBranch,
      ),
    ).toBe(true);
    expect(externalRequests).toEqual([]);
  } finally {
    await electronApp?.close().catch(() => undefined);
    restoreEnvironment(environment);
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
  await settings.getByLabel('Default remote').fill('origin');
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
  const report = drawer
    .getByRole('tabpanel', { name: 'Changes' })
    .locator('.change-report-list article');
  await expect(report).toHaveCount(1);
  return report;
}

async function findChangedWorktree(primaryPath: string, changedFile: string): Promise<string> {
  const primaryCanonical = await realpath(primaryPath);
  const worktrees = git(primaryPath, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
  for (const candidate of worktrees) {
    if ((await realpath(candidate)) === primaryCanonical) continue;
    try {
      await access(join(candidate, changedFile));
      return candidate;
    } catch {
      // Keep looking for the owner-bound worktree containing the deterministic output.
    }
  }
  throw new Error(`No managed worktree contains ${changedFile}.`);
}

function git(repository: string, arguments_: readonly string[]): string {
  return execFileSync('git', ['-C', repository, ...arguments_], {
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitBareRef(repository: string, branch: string): string | null {
  try {
    return execFileSync('git', [`--git-dir=${repository}`, 'rev-parse', `refs/heads/${branch}`], {
      encoding: 'utf8',
      env: process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

interface NativeDialogRecord {
  readonly buttons?: readonly string[] | undefined;
  readonly cancelId?: number | undefined;
  readonly defaultId?: number | undefined;
  readonly detail?: string | undefined;
  readonly message?: string | undefined;
  readonly response: number;
  readonly title?: string | undefined;
}

async function installNativeDialogHarness(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ dialog }) => {
    const state = globalThis as typeof globalThis & {
      __forgeboardRemoteDeliveryDialogs?: NativeDialogRecord[];
      __forgeboardRemoteDeliveryResponses?: number[];
    };
    state.__forgeboardRemoteDeliveryDialogs = [];
    state.__forgeboardRemoteDeliveryResponses = [];
    Object.defineProperty(dialog, 'showMessageBox', {
      configurable: true,
      value: (...arguments_: unknown[]) => {
        const options = arguments_.at(-1) as Omit<NativeDialogRecord, 'response'>;
        const response = state.__forgeboardRemoteDeliveryResponses?.shift() ?? 1;
        state.__forgeboardRemoteDeliveryDialogs?.push({
          buttons: options.buttons,
          cancelId: options.cancelId,
          defaultId: options.defaultId,
          detail: options.detail,
          message: options.message,
          response,
          title: options.title,
        });
        return Promise.resolve({ response, checkboxChecked: false });
      },
    });
  });
}

async function queueNativeDialogResponse(
  electronApp: ElectronApplication,
  response: 0 | 1,
): Promise<void> {
  await electronApp.evaluate((_, nextResponse) => {
    const state = globalThis as typeof globalThis & {
      __forgeboardRemoteDeliveryResponses?: number[];
    };
    if (state.__forgeboardRemoteDeliveryResponses === undefined) {
      throw new Error('The native dialog harness is not installed.');
    }
    state.__forgeboardRemoteDeliveryResponses.push(nextResponse);
  }, response);
}

async function nativeDialogs(electronApp: ElectronApplication): Promise<NativeDialogRecord[]> {
  return await electronApp.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __forgeboardRemoteDeliveryDialogs?: NativeDialogRecord[];
    };
    return state.__forgeboardRemoteDeliveryDialogs ?? [];
  });
}

async function waitForNativeDialog(
  electronApp: ElectronApplication,
  index: number,
): Promise<NativeDialogRecord> {
  await expect.poll(async () => (await nativeDialogs(electronApp)).length).toBeGreaterThan(index);
  const record = (await nativeDialogs(electronApp))[index];
  if (record === undefined) throw new Error(`Native dialog ${String(index)} was not recorded.`);
  return record;
}

function expectNativeCancelDefault(
  record: NativeDialogRecord,
  title: string,
  buttons: readonly string[],
): void {
  expect(record).toMatchObject({ title, buttons, defaultId: 0, cancelId: 0 });
}

interface FakeGhState {
  authenticated: boolean;
  repository: {
    hostname: string;
    nameWithOwner: string;
    url: string;
    defaultBranch: string;
  };
  expectedBaseBranch: string;
  expectedHeadBranch: string;
  expectedPullRequestTitle: string;
  expectedPullRequestBody: string;
  expectedDraft: boolean;
  pullRequestUrl: string;
  baseOid: string;
  remoteHeadOid?: string;
  ciRuns: Array<{
    databaseId: number;
    name: string;
    workflowName: string;
    status: string;
    conclusion: string | null;
    url: string;
    headBranch: string;
    headSha: string;
  }>;
}

interface GhLogRecord {
  readonly argv: string[];
  readonly inputCharacters: number;
  readonly inputSha256: string;
}

interface SshLogRecord {
  readonly argv: string[];
}

async function writeFakeGhState(path: string, state: FakeGhState): Promise<void> {
  await writeFile(path, `${JSON.stringify(state)}\n`, 'utf8');
}

async function countGhCommand(path: string, prefix: readonly string[]): Promise<number> {
  return (await readJsonLines<GhLogRecord>(path)).filter((record) =>
    startsWithArguments(record.argv, prefix),
  ).length;
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function startsWithArguments(actual: readonly string[], expected: readonly string[]): boolean {
  return expected.every((argument, index) => actual[index] === argument);
}

function flagValue(arguments_: readonly string[], flag: string): string | undefined {
  const index = arguments_.indexOf(flag);
  return index < 0 ? undefined : arguments_[index + 1];
}

type PreservedEnvironment = Record<string, string | undefined>;

function preserveEnvironment(names: readonly string[]): PreservedEnvironment {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnvironment(environment: PreservedEnvironment): void {
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
