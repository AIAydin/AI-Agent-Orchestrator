import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication, type Locator } from '@playwright/test';

import { launchDesktop, watchExternalRequests } from '../support/electron.js';
import {
  expectExactTerminalNativeConfirmation,
  installTerminalNativeDialogHarness,
  queueTerminalNativeDialogResponse,
  terminalNativeDialogs,
  waitForTerminalNativeDialog,
} from './native-confirmation.js';

const INTERACTIVE_SCRIPT = [
  'process.stdout.write("\\u001b[32mANSI_READY\\u001b[0m\\r\\n");',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.resume();',
  'let pending="";',
  'process.stdin.on("data",chunk=>{',
  'pending+=chunk;',
  'for(;;){',
  'const boundary=pending.search(/[\\r\\n]/u);',
  'if(boundary<0)break;',
  'const line=pending.slice(0,boundary);',
  'pending=pending.slice(boundary+1).replace(/^[\\r\\n]+/u,"");',
  'if(line==="hello")process.stdout.write("\\u001b[36mINPUT_OK:hello\\u001b[0m\\r\\n");',
  'if(line==="exit"){',
  'process.stdout.write("\\u001b[33mCONFIRMED_EXIT\\u001b[0m\\r\\n");',
  'setTimeout(()=>process.exit(0),25);',
  '}',
  '}',
  '});',
  'setInterval(()=>{},1000);',
].join('');
const TERMINAL_ARGUMENTS = ['-e', INTERACTIVE_SCRIPT] as const;
const ENVIRONMENT_VARIABLE_NAMES = ['PATH'] as const;

test('an interactive Terminal node launches a real reviewed PTY entirely from the UI', async () => {
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'forgeboard-terminal-e2e-'));
  let electronApp: ElectronApplication | null = null;
  const externalRequests: string[] = [];

  try {
    const firstSession = await launchDesktop(userDataDirectory);
    electronApp = firstSession.app;
    let page = firstSession.page;
    watchExternalRequests(page, externalRequests);

    await page.getByRole('button', { name: 'Use safe defaults' }).click();
    await page.getByRole('button', { name: /Explore the safe demo/i }).click();
    await expect(page.locator('.project-switcher')).toContainText('forgeboard-demo');

    await test.step('the node and every ordinary process setting are configured in the UI', async () => {
      await page
        .locator('.template-section')
        .getByRole('button', { name: /^Terminal/ })
        .click();
      await page.getByRole('article', { name: 'Terminal: Terminal' }).click();

      const terminalPanel = page.getByRole('region', { name: 'Interactive terminal node' });
      await expect(terminalPanel).toBeVisible();
      await terminalPanel.getByLabel('Executable').fill(process.execPath);
      await terminalPanel.getByRole('button', { name: 'Add argument' }).click();
      await terminalPanel
        .getByRole('textbox', { name: 'Argument 1', exact: true })
        .fill(TERMINAL_ARGUMENTS[0]);
      await terminalPanel.getByRole('button', { name: 'Add argument' }).click();
      await terminalPanel
        .getByRole('textbox', { name: 'Argument 2', exact: true })
        .fill(TERMINAL_ARGUMENTS[1]);
      await terminalPanel.getByLabel('Project-relative working directory').fill('.');
      await terminalPanel
        .getByLabel('Environment variable names allowed into processes')
        .fill(ENVIRONMENT_VARIABLE_NAMES.join(', '));
      await expect(terminalPanel.getByRole('button', { name: 'Review & start' })).toBeEnabled();
    });

    await test.step('the exact terminal configuration survives an Electron close and canvas reload', async () => {
      await electronApp?.close();
      electronApp = null;

      const restoredSession = await launchDesktop(userDataDirectory);
      electronApp = restoredSession.app;
      page = restoredSession.page;
      watchExternalRequests(page, externalRequests);
      await installTerminalNativeDialogHarness(electronApp);

      await expect(page.locator('.setup-shell')).toHaveCount(0);
      await expect(page.locator('.recent-list button')).toHaveCount(1);
      await page.locator('.recent-list button').click();
      await expect(page.locator('.canvas-title')).toContainText('1 nodes · 0 connections');
      await page.getByRole('article', { name: 'Terminal: Terminal' }).click();

      const restoredPanel = page.getByRole('region', { name: 'Interactive terminal node' });
      await expect(restoredPanel.getByLabel('Executable')).toHaveValue(process.execPath);
      await expect(
        restoredPanel.getByRole('textbox', { name: 'Argument 1', exact: true }),
      ).toHaveValue(TERMINAL_ARGUMENTS[0]);
      await expect(
        restoredPanel.getByRole('textbox', { name: 'Argument 2', exact: true }),
      ).toHaveValue(TERMINAL_ARGUMENTS[1]);
      await expect(restoredPanel.getByLabel('Project-relative working directory')).toHaveValue('.');
      await expect(
        restoredPanel.getByLabel('Environment variable names allowed into processes'),
      ).toHaveValue(ENVIRONMENT_VARIABLE_NAMES.join(', '));
      await expect(restoredPanel.getByLabel('Session history')).toHaveValue('');
    });

    const terminalPanel = page.getByRole('region', { name: 'Interactive terminal node' });
    await test.step('cancelling the renderer review creates no session and opens no native prompt', async () => {
      await terminalPanel.getByRole('button', { name: 'Review & start' }).click();
      const review = page.getByRole('dialog', { name: 'Review the exact terminal launch' });
      await expect(review).toBeVisible();
      await expect(review).toContainText(process.execPath);
      await expect(review).toContainText(JSON.stringify(TERMINAL_ARGUMENTS));
      await expect(review).toContainText('Project-relative working directory');
      await expect(review).toContainText('PATH');
      await review.getByRole('button', { name: 'Cancel before launch' }).click();
      await expect(review).toBeHidden();
      await expect(terminalPanel).toContainText('Cancelled before any terminal process launched.');
      await expect(terminalPanel.getByLabel('Session history')).toHaveValue('');
      expect(await terminalNativeDialogs(electronApp!)).toEqual([]);
    });

    const canonicalExecutable = await realpath(process.execPath);
    const canonicalWorkingDirectory = await realpath(
      join(userDataDirectory, 'demo', 'forgeboard-demo'),
    );
    let firstSessionId = '';
    await test.step('the separate owner-bound native confirmation discloses and launches the exact PTY', async () => {
      await terminalPanel.getByRole('button', { name: 'Review & start' }).click();
      const review = page.getByRole('dialog', { name: 'Review the exact terminal launch' });
      await expect(review).toBeVisible();
      await queueTerminalNativeDialogResponse(electronApp!, 1);
      await review.getByRole('button', { name: 'Continue to native confirmation' }).click();

      const nativeReview = await waitForTerminalNativeDialog(electronApp!, 0);
      expectExactTerminalNativeConfirmation(nativeReview, {
        arguments: TERMINAL_ARGUMENTS,
        cwd: canonicalWorkingDirectory,
        environmentVariableNames: ENVIRONMENT_VARIABLE_NAMES,
        executable: canonicalExecutable,
        projectName: 'forgeboard-demo',
      });
      await expect(review).toBeHidden();
      await expect(terminalPanel.locator('.terminal-status')).toHaveText('Running');
      await expectTerminalText(terminalPanel, 'ANSI_READY');
      firstSessionId = await terminalPanel.getByLabel('Session history').inputValue();
      expect(firstSessionId).not.toBe('');
    });

    await test.step('real xterm input reaches the PTY and the confirmed exit is retained in history', async () => {
      const terminal = terminalPanel.getByRole('application', { name: 'Interactive terminal' });
      await terminal.click();
      await terminal.pressSequentially('hello');
      await terminal.press('Enter');
      await expectTerminalText(terminalPanel, 'INPUT_OK:hello');

      await terminal.pressSequentially('exit');
      await terminal.press('Enter');
      await expectTerminalText(terminalPanel, 'CONFIRMED_EXIT');
      await expect(terminalPanel.locator('.terminal-status')).toHaveText('Exited');
      const evidence = terminalPanel.getByRole('region', { name: 'Terminal session evidence' });
      await expect(evidence).toContainText('Process statusExited');
      await expect(evidence).toContainText('Exit code0');
      await expect(terminalPanel.getByLabel('Session history').locator('option')).toHaveCount(1);
      await expect(terminalPanel.getByLabel('Session history').locator('option')).toContainText([
        /Exited/u,
      ]);
    });

    await test.step('restart creates a fresh reviewed session and the responsive fixture confirms termination', async () => {
      await terminalPanel.getByRole('button', { name: 'Review & restart' }).click();
      const review = page.getByRole('dialog', { name: 'Review the exact terminal launch' });
      await queueTerminalNativeDialogResponse(electronApp!, 1);
      await review.getByRole('button', { name: 'Continue to native confirmation' }).click();
      const nativeReview = await waitForTerminalNativeDialog(electronApp!, 1);
      expectExactTerminalNativeConfirmation(nativeReview, {
        arguments: TERMINAL_ARGUMENTS,
        cwd: canonicalWorkingDirectory,
        environmentVariableNames: ENVIRONMENT_VARIABLE_NAMES,
        executable: canonicalExecutable,
        projectName: 'forgeboard-demo',
      });

      await expect(terminalPanel.locator('.terminal-status')).toHaveText('Running');
      await expectTerminalText(terminalPanel, 'ANSI_READY');
      const secondSessionId = await terminalPanel.getByLabel('Session history').inputValue();
      expect(secondSessionId).not.toBe(firstSessionId);
      await terminalPanel.getByRole('button', { name: 'Terminate' }).click();
      await expect(terminalPanel.locator('.terminal-status')).toHaveText('Terminated');
      await expect(
        terminalPanel.getByRole('region', { name: 'Terminal session evidence' }),
      ).toContainText('Process statusTerminated');
      await expect(terminalPanel.getByRole('button', { name: 'Terminate' })).toHaveCount(0);
      await expect(terminalPanel.getByLabel('Session history').locator('option')).toHaveCount(2);
    });

    expect(externalRequests).toEqual([]);
  } finally {
    await electronApp?.close().catch(() => undefined);
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

async function expectTerminalText(panel: Locator, expected: string): Promise<void> {
  await expect
    .poll(
      async () =>
        (await panel.getByRole('application', { name: 'Interactive terminal' }).textContent()) ??
        '',
    )
    .toContain(expected);
}
