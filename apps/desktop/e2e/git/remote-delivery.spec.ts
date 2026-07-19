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

import { installFakeCodex } from '../review-gate/fixture.js';
import { launchDesktop, watchExternalRequests } from '../support/electron.js';
import {
  expectNativeCancelDefault,
  installNativeDialogHarness,
  nativeDialogs,
  queueNativeDialogResponse,
  waitForNativeDialog,
} from './connections/native-dialogs.js';
import { writeConfiguredFakeGitHubCli } from './connections/fake-github-cli.js';
import { currentProjectPath, git, gitRemoteUrl } from './connections/repository.js';
import {
  configureCodexReviewerConnection,
  runReviewedAgentWorkflow,
} from './connections/reviewed-workflow.js';
import {
  configureCustomGitHubCliThroughUi,
  configureNetworkRemoteThroughUi,
} from './connections/settings.js';

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
  const sshFixtureBin = join(sandboxRoot, 'ssh-fixture-bin');
  const fakeGhExecutable = join(sandboxRoot, 'fake-gh.mjs');
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
    const fakeCodex = await installFakeCodex(sandboxRoot);
    await mkdir(sshFixtureBin, { recursive: true });
    await Promise.all([
      symlink(
        join(import.meta.dirname, 'scripts', 'fixtures', 'fake-ssh.mjs'),
        join(sshFixtureBin, 'ssh'),
      ),
      writeFile(fakeGhLogPath, '', 'utf8'),
      writeFile(fakeSshLogPath, '', 'utf8'),
      writeFakeGhState(fakeGhStatePath, fakeGhState),
      writeConfiguredFakeGitHubCli({
        executablePath: fakeGhExecutable,
        statePath: fakeGhStatePath,
        logPath: fakeGhLogPath,
      }),
    ]);
    process.env.PATH = `${sshFixtureBin}:${environment.PATH ?? ''}`;
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
    await installNativeDialogHarness(electronApp);

    await page.getByRole('button', { name: 'Use safe defaults' }).click();
    await configureGitThroughUi(page, managedWorktreeRoot, fakeCodex);
    await page.getByRole('button', { name: /Explore the safe demo/i }).click();
    await expect(page.locator('.canvas-title')).toContainText('0 nodes · 0 connections');

    const primaryPath = await currentProjectPath(page);
    const baseBranch = git(primaryPath, ['branch', '--show-current']);
    const baseOid = git(primaryPath, ['rev-parse', 'HEAD']);
    execFileSync('git', ['clone', '--quiet', '--bare', primaryPath, bareRemotePath], {
      env: process.env,
      stdio: 'pipe',
    });
    fakeGhState.repository.defaultBranch = baseBranch;
    fakeGhState.expectedBaseBranch = baseBranch;
    fakeGhState.baseOid = baseOid;
    await writeFakeGhState(fakeGhStatePath, fakeGhState);
    await configureNetworkRemoteThroughUi({
      app: electronApp,
      page,
      name: 'origin',
      url: REMOTE_URL,
    });
    await expect.poll(() => gitRemoteUrl(primaryPath, 'origin')).toBe(REMOTE_URL);
    await configureCustomGitHubCliThroughUi({
      app: electronApp,
      page,
      executablePath: fakeGhExecutable,
      executableFileName: 'fake-gh.mjs',
    });
    expect(await countGhCommand(fakeGhLogPath, ['--version'])).toBe(1);

    await page
      .locator('.template-section')
      .getByRole('button', { name: /^Agent/ })
      .click();
    const agentNode = page.getByRole('article', { name: 'Agent: Agent' });
    await agentNode.click();
    const runConfiguration = page.getByRole('region', {
      name: 'Agent run settings',
    });
    await runConfiguration.getByLabel('Agent to run').selectOption('test-agent');
    await runConfiguration.getByLabel('Permission profile').selectOption('worktree-write');
    await runConfiguration
      .getByLabel('Prompt')
      .fill('Create the deterministic file used by remote-delivery review.');
    const report = await runReviewedAgentWorkflow({ page, implementation: agentNode });
    await report.getByRole('button', { name: 'Review this agent worktree' }).click();
    let reviewDialog = page.getByRole('dialog', {
      name: /Review changes in forgeboard-demo/,
    });
    await reviewDialog.getByRole('tab', { name: 'Uncommitted changes' }).click();
    const changedFiles = reviewDialog
      .getByRole('navigation', { name: 'Changed files' })
      .locator('.git-file-select');
    await expect(changedFiles).toHaveCount(1);
    const changedFile = (await changedFiles.locator('strong').innerText()).trim();
    const worktreePath = await findChangedWorktree(primaryPath, changedFile);
    await reviewDialog.getByRole('button', { name: `Add ${changedFile} to commit` }).click();
    await reviewDialog.getByLabel('Commit message').fill(COMMIT_MESSAGE);
    await reviewDialog.getByRole('button', { name: /Review commit/ }).click();

    const commitDisclosure = page.getByRole('alertdialog', {
      name: 'Review your commit',
    });
    await expect(commitDisclosure).toContainText(COMMIT_MESSAGE);
    await commitDisclosure.getByRole('button', { name: 'Continue' }).click();
    await expect(reviewDialog).toContainText(/Created commit [a-f0-9]{12}\./u);
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
    const inspector = page.getByRole('region', { name: 'Publish changes' });
    const runPicker = inspector.getByLabel('Finished agent run');
    await expect.poll(async () => await runPicker.locator('option').count()).toBeGreaterThan(1);
    const reviewedRun = runPicker.locator('option').filter({ hasText: sourceBranch });
    await expect(reviewedRun).toHaveCount(1);
    const reviewedRunId = await reviewedRun.getAttribute('value');
    if (reviewedRunId === null) throw new Error('Reviewed run option has no value.');
    await runPicker.selectOption(reviewedRunId);
    await inspector.getByLabel('Remote', { exact: true }).fill('origin');
    await inspector.getByLabel('Destination branch').fill(sourceBranch);
    await inspector.getByLabel('Base branch').fill(baseBranch);
    await inspector.getByLabel('Pull request title').fill(PULL_REQUEST_TITLE);
    await inspector.getByLabel('Pull request body').fill(PULL_REQUEST_BODY);
    await inspector.getByLabel('Create as a draft pull request').check();
    fakeGhState.expectedHeadBranch = sourceBranch;
    await writeFakeGhState(fakeGhStatePath, fakeGhState);

    await inspector.getByRole('button', { name: 'Check changes' }).click();
    const exactState = inspector.getByRole('region', { name: 'Check results' });
    await expect(exactState).toContainText(sourceBranch);
    await expect(exactState).toContainText(sourceHead);
    await expect(exactState).toContainText(baseOid);
    await expect(exactState).toContainText('ssh://github.com');
    await expect(exactState).toContainText('Blocked');
    await expect(exactState).toContainText(
      "The required checks and a person's approval haven't been completed yet.",
    );
    await expect(inspector).toContainText("Found in this run's project copy: origin.");

    await inspector.getByRole('button', { name: 'Open checks and approval' }).click();
    reviewDialog = page.getByRole('dialog', {
      name: /Review changes in forgeboard-demo/,
    });
    const readiness = reviewDialog.getByRole('region', {
      name: 'Delivery readiness',
    });
    const workflowExecution = readiness.getByRole('combobox', {
      name: 'Verified workflow execution',
    });
    await expect(workflowExecution.locator('option')).toHaveCount(1);
    await expect(workflowExecution.locator('option').first()).toContainText('revision');
    await workflowExecution.selectOption({ index: 0 });
    const saveRequirements = readiness.getByRole('button', {
      name: 'Save delivery requirements',
    });
    if (await saveRequirements.isEnabled()) await saveRequirements.click();
    await expect(
      readiness.getByRole('button', { name: /^Run (?:Lint|Tests?)$/u }).first(),
    ).toBeEnabled({ timeout: 20_000 });
    for (let index = 0; index < 2; index += 1) {
      const runCheck = readiness.getByRole('button', { name: /^Run (?:Lint|Tests?)$/u }).first();
      if ((await runCheck.count()) === 0) break;
      await queueNativeDialogResponse(electronApp, 1);
      await runCheck.click();
      await expect(
        readiness.getByRole('button', { name: /^Re-run (?:Lint|Tests?)$/u }).first(),
      ).toBeEnabled({ timeout: 20_000 });
    }
    await expect(readiness).toContainText('Passed', { timeout: 20_000 });
    await queueNativeDialogResponse(electronApp, 1);
    await readiness.getByRole('button', { name: 'Approve quality' }).click();
    await expect(readiness).toContainText('Ready for delivery review');
    await expect(readiness).toContainText(sourceHead.slice(0, 12));
    await reviewDialog.getByRole('button', { name: 'Close Git review' }).click();

    await inspector.getByRole('button', { name: 'Recheck changes' }).click();
    await expect(exactState).toContainText('Ready to publish');
    await expect(inspector.getByRole('button', { name: 'Review push' })).toBeEnabled();

    await inspector.getByRole('button', { name: 'Review push' }).click();
    let planDialog = page.getByRole('alertdialog', { name: 'Review the push' });
    await expect(planDialog).toContainText(sourceHead);
    await expect(planDialog).toContainText(sourceBranch);
    await expect(planDialog).toContainText(changedFile);
    await expect(planDialog).toContainText('Force push is never offered');
    const pushCancelDialogIndex = (await nativeDialogs(electronApp)).length;
    await queueNativeDialogResponse(electronApp, 0);
    await planDialog.getByRole('button', { name: 'Continue to final confirmation' }).click();
    await expect(inspector).toContainText(
      'Push cancelled at the final confirmation. Nothing changed online.',
    );
    expect(gitBareRef(bareRemotePath, sourceBranch)).toBeNull();
    expectNativeCancelDefault(
      await waitForNativeDialog(electronApp, pushCancelDialogIndex),
      'Push reviewed branch',
      ['Cancel', 'Push branch'],
    );

    await inspector.getByRole('button', { name: 'Review push' }).click();
    planDialog = page.getByRole('alertdialog', { name: 'Review the push' });
    const pushApproveDialogIndex = (await nativeDialogs(electronApp)).length;
    await queueNativeDialogResponse(electronApp, 1);
    await planDialog.getByRole('button', { name: 'Continue to final confirmation' }).click();
    await expect(inspector).toContainText(
      `Pushed commit ${sourceHead} to origin/${sourceBranch}.`,
      {
        timeout: 20_000,
      },
    );
    expect(gitBareRef(bareRemotePath, sourceBranch)).toBe(sourceHead);
    expectNativeCancelDefault(
      await waitForNativeDialog(electronApp, pushApproveDialogIndex),
      'Push reviewed branch',
      ['Cancel', 'Push branch'],
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
    await inspector.getByRole('button', { name: 'Check GitHub sign-in and repository' }).click();
    const githubStatus = inspector.getByRole('region', {
      name: 'GitHub sign-in and repository status',
    });
    await expect(githubStatus).toContainText('Signed in', { timeout: 20_000 });
    await expect(githubStatus).toContainText(OWNER_REPOSITORY);
    expectNativeCancelDefault(
      await waitForNativeDialog(electronApp, githubDialogIndex),
      'Check GitHub connection',
      ['Cancel', 'Check GitHub'],
    );
    await expect(inspector.getByRole('button', { name: 'Review pull request' })).toBeEnabled();

    const prCreatesBeforeCancel = await countGhCommand(fakeGhLogPath, ['pr', 'create']);
    await inspector.getByRole('button', { name: 'Review pull request' }).click();
    planDialog = page.getByRole('alertdialog', {
      name: 'Review the pull request',
    });
    await expect(planDialog).toContainText(PULL_REQUEST_TITLE);
    await expect(planDialog).toContainText(PULL_REQUEST_BODY);
    await expect(planDialog).toContainText(sourceHead);
    await expect(planDialog).toContainText(`${baseBranch} @ ${baseOid}`);
    await expect(planDialog).toContainText('Draft');
    const prCancelDialogIndex = (await nativeDialogs(electronApp)).length;
    await queueNativeDialogResponse(electronApp, 0);
    await planDialog.getByRole('button', { name: 'Continue to final confirmation' }).click();
    await expect(inspector).toContainText(
      'Pull request cancelled at the final confirmation. Nothing was created.',
    );
    expect(await countGhCommand(fakeGhLogPath, ['pr', 'create'])).toBe(prCreatesBeforeCancel);
    expectNativeCancelDefault(
      await waitForNativeDialog(electronApp, prCancelDialogIndex),
      'Create GitHub pull request',
      ['Cancel', 'Create draft pull request'],
    );

    await inspector.getByRole('button', { name: 'Review pull request' }).click();
    planDialog = page.getByRole('alertdialog', {
      name: 'Review the pull request',
    });
    const prApproveDialogIndex = (await nativeDialogs(electronApp)).length;
    await queueNativeDialogResponse(electronApp, 1);
    await planDialog.getByRole('button', { name: 'Continue to final confirmation' }).click();
    const createdPullRequest = inspector.getByRole('region', {
      name: 'Created pull request',
    });
    await expect(createdPullRequest).toContainText(PULL_REQUEST_URL, {
      timeout: 20_000,
    });
    await expect(
      createdPullRequest.getByRole('button', { name: 'Copy pull request URL' }),
    ).toBeVisible();
    await expect(createdPullRequest.getByRole('link')).toHaveCount(0);
    expectNativeCancelDefault(
      await waitForNativeDialog(electronApp, prApproveDialogIndex),
      'Create GitHub pull request',
      ['Cancel', 'Create draft pull request'],
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
    await inspector.getByRole('button', { name: 'Check CI results for this commit' }).click();
    const ciStatus = inspector.getByRole('region', {
      name: 'CI results for this commit',
    });
    await expect(ciStatus).toContainText('1 run', { timeout: 20_000 });
    await expect(ciStatus).toContainText(sourceHead);
    await expect(ciStatus).toContainText('Remote delivery validation');
    await expect(ciStatus).toContainText('completed · success');
    await expect(ciStatus.getByRole('button', { name: 'Copy run URL' })).toBeVisible();
    expectNativeCancelDefault(
      await waitForNativeDialog(electronApp, ciDialogIndex),
      'Check GitHub CI results',
      ['Cancel', 'Check CI results'],
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

async function configureGitThroughUi(
  page: Page,
  managedWorktreeRoot: string,
  fakeCodex: string,
): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.locator('.settings-modal');
  await settings.getByRole('button', { name: /Git & previews/ }).click();
  await settings.getByLabel('Managed worktree location').fill(managedWorktreeRoot);
  await settings.getByLabel('Git identity name').fill(COMMIT_IDENTITY.name);
  await settings.getByLabel('Git identity email').fill(COMMIT_IDENTITY.email);
  await settings.getByLabel('Default remote').fill('origin');
  await configureCodexReviewerConnection(settings, fakeCodex);
  await settings.getByRole('button', { name: 'Checks', exact: true }).click();
  const lint = settings.getByRole('group', { name: 'Lint command' });
  await lint.getByLabel('Executable').fill(process.execPath);
  await lint.getByLabel('Arguments').fill(`-e\nprocess.stdout.write("${DELIVERY_CHECK_MARKER}")`);
  const tests = settings.getByRole('group', { name: 'Tests command' });
  await tests.getByLabel('Executable').fill(process.execPath);
  await tests
    .getByLabel('Arguments')
    .fill('-e\nprocess.stdout.write("reviewed-workflow-test-pass")');
  await settings.getByRole('button', { name: /Save settings/ }).click();
  await expect(settings).toBeHidden();
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
