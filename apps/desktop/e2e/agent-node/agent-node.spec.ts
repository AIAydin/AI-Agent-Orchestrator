import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication, type Locator } from '@playwright/test';

import {
  closeElectronAfterTest,
  launchDesktop,
  watchExternalRequests,
} from '../support/electron.js';
import { createRepository, findFiles, primarySnapshot } from './fixture.js';
import { choosePath } from './native-confirmation.js';

const MODEL_ID = 'openai/gpt-5.1';
const READY_MARKER = 'FORGEBOARD_FAKE_OPENCODE_READY';
const EXIT_MARKER = 'FORGEBOARD_FAKE_OPENCODE_EXIT';

test('Agent sessions launch a reconstructed built-in command in a managed worktree', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeboard-agent-node-e2e-')));
  const userDataDirectory = join(root, 'user-data');
  const repositoryPath = join(root, 'primary-repository');
  const worktreeRoot = join(root, 'managed-worktrees');
  const fakeExecutable = await writeFakeOpenCode(root);
  const before = await createRepository(repositoryPath);
  await mkdir(worktreeRoot, { recursive: true });
  const externalRequests: string[] = [];
  let app: ElectronApplication | null = null;

  try {
    const session = await launchDesktop(userDataDirectory);
    app = session.app;
    const page = session.page;
    watchExternalRequests(page, externalRequests);
    await page.getByRole('button', { name: 'Use safe defaults' }).click();
    await installApprovalHarness(app);

    await page.getByRole('button', { name: 'Settings' }).click();
    const settings = page.locator('.settings-modal');
    await settings.getByRole('button', { name: /Git & previews/ }).click();
    await settings.getByLabel('Managed worktree location').fill(worktreeRoot);
    await settings.getByRole('button', { name: 'Agents & runtime' }).click();
    const openCode = settings.locator('.agent-setting').filter({ hasText: 'OpenCode' });
    await openCode.getByLabel('Executable override').fill(fakeExecutable);
    await openCode.getByLabel('Default model (optional)').selectOption(MODEL_ID);
    await settings.getByLabel('Default agent').selectOption('opencode');
    const openCodeReadiness = settings
      .locator('.agent-readiness-list')
      .getByRole('button', { name: /Check OpenCode again/u });
    await openCodeReadiness.click();
    await expect(openCodeReadiness).toBeEnabled({ timeout: 20_000 });
    const readinessMessages = await settings.locator('.agent-readiness-list').allTextContents();
    await expect(
      settings.locator('.agent-readiness-list').getByText(/executable is ready/u),
      `OpenCode readiness: ${readinessMessages.join(' | ')}`,
    ).toBeVisible({ timeout: 20_000 });
    const saveSettings = settings.getByRole('button', {
      name: /Save settings/u,
    });
    const blockingMessages = await settings.locator('footer [role="alert"]').allTextContents();
    await expect(
      saveSettings,
      `Settings save remained blocked: ${blockingMessages.join(' | ')}`,
    ).toBeEnabled();
    await saveSettings.click();
    await expect(settings).toBeHidden();

    await choosePath(app, repositoryPath);
    await page.getByRole('button', { name: /Open a project folder/i }).click();
    await expect(page.locator('.project-switcher')).toContainText('primary-repository');
    const templates = page.locator('.template-section');
    const openCodeTemplate = templates.getByRole('button', {
      name: /opencode/iu,
    });
    await expect(
      openCodeTemplate,
      `Available templates: ${(await templates.allTextContents()).join(' | ')}`,
    ).toBeVisible();
    await openCodeTemplate.click();

    const agent = page.getByRole('article', { name: /^Agent: /u });
    await expect(agent).toContainText(/opencode/iu);
    await expect(agent.getByLabel('Permission profile')).toHaveValue('worktree-write');
    await agent.getByRole('button', { name: 'Start session' }).click();
    await expectTerminalText(agent, READY_MARKER);

    const terminal = agent.getByRole('application', { name: 'Terminal' });
    await terminal.click();
    await terminal.pressSequentially('exit');
    await terminal.press('Enter');
    await expectTerminalText(agent, EXIT_MARKER);
    await terminal.pressSequentially('exit');
    await terminal.press('Enter');
    await expect(agent.getByText(/Session ended/u)).toBeVisible({
      timeout: 20_000,
    });

    expect(await primarySnapshot(repositoryPath)).toEqual(before);
    expect(await findFiles(repositoryPath, 'forgeboard-agent-proof.txt')).toEqual([]);
    const proofFiles = await findFiles(worktreeRoot, 'forgeboard-agent-proof.txt');
    expect(proofFiles).toHaveLength(1);
    expect(await readFile(proofFiles[0]!, 'utf8')).toBe('managed worktree session\n');
    expect(externalRequests).toEqual([]);
  } finally {
    await closeElectronAfterTest(app);
    await rm(root, { recursive: true, force: true });
  }
});

async function installApprovalHarness(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    Object.defineProperty(dialog, 'showMessageBox', {
      configurable: true,
      value: () => Promise.resolve({ response: 1, checkboxChecked: false }),
    });
  });
}

async function writeFakeOpenCode(root: string): Promise<string> {
  const scriptPath = join(root, 'fake-opencode.mjs');
  await writeFile(
    scriptPath,
    [
      "import { writeFile } from 'node:fs/promises';",
      "import process from 'node:process';",
      `process.stdout.write(${JSON.stringify(`${READY_MARKER}\n`)});`,
      "process.stdin.setEncoding('utf8');",
      "let pending = '';",
      "process.stdin.on('data', (chunk) => {",
      '  pending += chunk;',
      "  if (!pending.includes('exit')) return;",
      "  void writeFile('forgeboard-agent-proof.txt', 'managed worktree session\\n').then(() => {",
      `    process.stdout.write(${JSON.stringify(`${EXIT_MARKER}\n`)});`,
      '    process.exit(0);',
      '  });',
      '});',
      'setInterval(() => undefined, 1_000);',
    ].join('\n'),
    'utf8',
  );

  if (process.platform === 'win32') {
    const executablePath = join(root, 'fake-opencode.cmd');
    await writeFile(
      executablePath,
      [
        '@echo off',
        'if "%~1"=="--version" (',
        '  echo 1.2.3',
        '  exit /b 0',
        ')',
        'if "%~1"=="--help" (',
        '  echo --session --model --prompt',
        '  exit /b 0',
        ')',
        `"${process.execPath}" "${scriptPath}" %*`,
      ].join('\r\n'),
      'utf8',
    );
    return executablePath;
  }

  const executablePath = join(root, 'fake-opencode');
  await writeFile(
    executablePath,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      '  echo 1.2.3',
      '  exit 0',
      'fi',
      'if [ "$1" = "--help" ]; then',
      '  echo --session --model --prompt',
      '  exit 0',
      'fi',
      `exec ${shellQuote(process.execPath)} ${shellQuote(scriptPath)} "$@"`,
    ].join('\n'),
    'utf8',
  );
  await chmod(executablePath, 0o700);
  return executablePath;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function expectTerminalText(agent: Locator, expected: string): Promise<void> {
  await expect
    .poll(
      async () => (await agent.getByRole('application', { name: 'Terminal' }).textContent()) ?? '',
      { timeout: 20_000 },
    )
    .toContain(expected);
}
