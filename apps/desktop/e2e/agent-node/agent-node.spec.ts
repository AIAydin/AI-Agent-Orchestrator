import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { expect, test, type ElectronApplication, type Locator } from '@playwright/test';

import {
  closeElectronAfterTest,
  launchDesktop,
  watchExternalRequests,
} from '../support/electron.js';
import { createRepository, findFiles, primarySnapshot } from './fixture.js';
import { choosePath } from './native-confirmation.js';

const READY_MARKER = 'FORGEBOARD_FAKE_OPENCODE_READY';
const EXIT_MARKER = 'FORGEBOARD_FAKE_OPENCODE_EXIT';

/**
 * Agent nodes are their own CLI session: the rail lists the agent CLIs found on this computer and
 * clicking one creates a node that launches straight away, in a managed worktree, leaving the
 * primary checkout untouched. A fake `opencode` on PATH stands in for the real CLI.
 */
test('Agent sessions launch a detected built-in CLI in a managed worktree', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeboard-agent-node-e2e-')));
  const userDataDirectory = join(root, 'user-data');
  const repositoryPath = join(root, 'primary-repository');
  const worktreeRoot = join(root, 'managed-worktrees');
  const fakeBinDirectory = await writeFakeOpenCode(root);
  const before = await createRepository(repositoryPath);
  await mkdir(worktreeRoot, { recursive: true });
  const externalRequests: string[] = [];
  let app: ElectronApplication | null = null;

  try {
    const session = await launchDesktop(userDataDirectory, {
      environment: {
        PATH: `${fakeBinDirectory}${delimiter}${process.env.PATH ?? ''}`,
        // Detection prefers the login shell's PATH. Pin a profile-free shell so the fake CLI on
        // the injected PATH is what the app finds, on any developer machine or CI runner.
        SHELL: '/bin/sh',
      },
    });
    app = session.app;
    const page = session.page;
    watchExternalRequests(page, externalRequests);
    await page.getByRole('button', { name: 'Use safe defaults' }).click();
    await installApprovalHarness(app);

    await page.getByRole('button', { name: 'Settings' }).click();
    const settings = page.locator('.settings-modal');
    await settings.getByRole('button', { name: /Git & previews/ }).click();
    await settings.getByLabel('Managed worktree location').fill(worktreeRoot);
    const saveSettings = settings.getByRole('button', { name: /Save settings/u });
    await expect(saveSettings).toBeEnabled({ timeout: 20_000 });
    await saveSettings.click();
    await expect(settings).toBeHidden();

    await choosePath(app, repositoryPath);
    await page.getByRole('button', { name: /Open a project folder/i }).click();
    await expect(page.locator('.project-switcher')).toContainText('primary-repository');

    const templates = page.locator('.template-section');
    const openCodeTemplate = templates.getByRole('button', { name: /opencode/iu });
    await expect(
      openCodeTemplate,
      `Available templates: ${(await templates.allTextContents()).join(' | ')}`,
    ).toBeVisible();
    await openCodeTemplate.click();

    const agent = page.getByRole('article', { name: /^Agent: /u });
    await expect(agent).toContainText(/opencode/iu);
    await expect(agent.getByLabel('Permission profile')).toHaveValue('worktree-write');
    // No Start button: the session launches itself once the session list settles.
    await expect(agent.getByRole('button', { name: 'Start session' })).toHaveCount(0);
    await expectTerminalText(agent, READY_MARKER);

    const terminal = agent.getByRole('application', { name: 'Terminal' });
    await terminal.click();
    await terminal.pressSequentially('exit');
    await terminal.press('Enter');
    await expectTerminalText(agent, EXIT_MARKER);
    // The CLI runs inside a login shell that stays interactive once the agent exits, so leaving
    // the session takes a second exit.
    await terminal.pressSequentially('exit');
    await terminal.press('Enter');
    await expect(
      agent.getByText(/Session (?:ended|stopped|interrupted|disconnected)/u),
    ).toBeVisible({ timeout: 20_000 });

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

/** Writes a fake `opencode` CLI into its own directory and returns that directory. */
async function writeFakeOpenCode(root: string): Promise<string> {
  const binDirectory = join(root, 'fake-bin');
  await mkdir(binDirectory, { recursive: true });
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
      '    setTimeout(() => process.exit(0), 50);',
      '  });',
      '});',
      'setInterval(() => undefined, 1_000);',
    ].join('\n'),
    'utf8',
  );

  if (process.platform === 'win32') {
    await writeFile(
      join(binDirectory, 'opencode.cmd'),
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
    return binDirectory;
  }

  const executablePath = join(binDirectory, 'opencode');
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
  return binDirectory;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function expectTerminalText(agent: Locator, expected: string): Promise<void> {
  const terminal = agent.getByRole('application', { name: 'Terminal' });
  try {
    await expect
      .poll(async () => (await terminal.textContent()) ?? '', { timeout: 30_000 })
      .toContain(expected);
  } catch (cause) {
    const terminalText =
      (await terminal.count()) === 0
        ? '<terminal not mounted>'
        : await terminal.textContent({ timeout: 1_000 }).catch(() => '<terminal unavailable>');
    const agentText = await agent
      .textContent({ timeout: 1_000 })
      .catch(() => '<agent node unavailable>');
    throw new Error(
      `Agent terminal did not contain ${JSON.stringify(expected)}. Terminal: ${JSON.stringify(terminalText)}. Agent: ${JSON.stringify(agentText)}.`,
      { cause },
    );
  }
}
