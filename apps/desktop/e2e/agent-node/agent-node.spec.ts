import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication } from '@playwright/test';

import { launchDesktop, watchExternalRequests } from '../support/electron.js';
import {
  ADAPTER_ID,
  INITIAL_PROMPT,
  INPUT_TEXT,
  MODEL_ID,
  RETRY_FAILURE_PROMPT,
  RETRY_PROMPT,
  createRepository,
  findFiles,
  primarySnapshot,
  writeOfflineExtension,
} from './fixture.js';
import {
  addAndConfigureAgent,
  approvePreparedRun,
  configureThroughUi,
  openRepository,
} from './interactions.js';

test('Agent node discloses capabilities, streams, resumes, retries, and restores offline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-agent-node-e2e-'));
  const userDataDirectory = join(root, 'user-data');
  const repositoryPath = join(root, 'primary-repository');
  const extensionPath = join(root, 'offline-extension');
  const worktreeRoot = join(await realpath(root), 'managed-worktrees');
  const before = await createRepository(repositoryPath);
  await writeOfflineExtension(extensionPath);
  const externalRequests: string[] = [];
  let app: ElectronApplication | null = null;

  try {
    const session = await launchDesktop(userDataDirectory);
    app = session.app;
    let page = session.page;
    watchExternalRequests(page, externalRequests);

    await test.step('all ordinary setup is completed in the UI', async () => {
      await configureThroughUi(app!, page, extensionPath, worktreeRoot);
      await openRepository(app!, page, repositoryPath);
    });

    let configuration = await addAndConfigureAgent(page, INITIAL_PROMPT);
    const history = page.getByRole('region', { name: 'Attempt history' });
    const liveOutput = page.getByRole('region', { name: 'Live output' });

    await test.step('capability and model selection are visible before launch', async () => {
      await expect(configuration.getByLabel('Agent to run')).toHaveValue(ADAPTER_ID);
      await expect(configuration.getByLabel('Model (optional)')).toBeEnabled();
      await expect(configuration.getByLabel('Model (optional)')).toHaveValue(MODEL_ID);
      await expect(configuration.getByRole('button', { name: 'Pause' })).toHaveCount(0);
    });

    await test.step('locking the Agent honestly disables configuration and launch', async () => {
      await page.getByRole('button', { name: 'Lock', exact: true }).click();
      await expect(configuration.getByLabel('Agent to run')).toBeDisabled();
      await expect(configuration.getByLabel('Prompt')).toBeDisabled();
      await expect(
        configuration.getByRole('button', { name: 'Review and run Agent' }),
      ).toBeDisabled();
      await page.getByRole('button', { name: 'Unlock', exact: true }).click();
      await expect(
        configuration.getByRole('button', { name: 'Review and run Agent' }),
      ).toBeEnabled();
    });

    await test.step('the approved run streams input and is interrupted with normalized metadata', async () => {
      await approvePreparedRun(
        app!,
        page,
        async () => configuration.getByRole('button', { name: 'Review and run Agent' }).click(),
        [
          'Local offline fixture',
          'PIPES',
          MODEL_ID,
          '--model',
          '--permission',
          'worktree-write',
          'managed-worktrees',
          INITIAL_PROMPT,
        ],
      );
      await expect(liveOutput).toContainText(`OFFLINE_READY model=${MODEL_ID}`, {
        timeout: 20_000,
      });
      await configuration.getByLabel('Message to the running agent').fill(INPUT_TEXT);
      await configuration.getByRole('button', { name: 'Send input', exact: true }).click();
      await expect(liveOutput).toContainText(`OFFLINE_INPUT_RECEIVED ${INPUT_TEXT}`);
      await expect(configuration.getByRole('button', { name: 'Interrupt' })).toBeVisible();
      await expect(
        configuration.getByRole('button', { name: 'Pause or continue Agent process' }),
      ).toBeDisabled();
      await configuration.getByRole('button', { name: 'Interrupt' }).click();
      await expect(liveOutput).toContainText('OFFLINE_INTERRUPTED forgeboard-offline-session-001');

      const interrupted = history.getByRole('article', {
        name: 'Initial run attempt Interrupted',
      });
      await expect(interrupted).toBeVisible({ timeout: 20_000 });
      await expect(interrupted).toContainText('42');
      await expect(interrupted).toContainText('$0.0042');
      await expect(interrupted).toContainText(MODEL_ID);
      await expect(interrupted).toContainText('Available for resume review (adapter manifest)');
      await expect(interrupted.getByRole('button', { name: 'Resume review' })).toBeEnabled();
      await expect(page.locator('.autosave-state')).toHaveText('Saved locally');
    });

    await test.step('resume reuses provider identity but requires a fresh exact approval', async () => {
      const interrupted = history.getByRole('article', {
        name: 'Initial run attempt Interrupted',
      });
      await approvePreparedRun(
        app!,
        page,
        async () => interrupted.getByRole('button', { name: 'Resume review' }).click(),
        [
          'Resume of attempt',
          'fresh immutable disclosure',
          MODEL_ID,
          'forgeboard-offline-session-001',
        ],
      );
      await expect(liveOutput).toContainText('OFFLINE_RESUMED forgeboard-offline-session-001');
      const resumed = history.getByRole('article', { name: 'Resumed run attempt Succeeded' });
      await expect(resumed).toBeVisible({ timeout: 20_000 });
      await expect(resumed).toContainText('Based on attempt');
      await expect(resumed).toContainText('30');
      await expect(resumed).toContainText('$0.0037');
      await resumed.getByText('Output preview').click();
      await expect(resumed).toContainText('OFFLINE_RESUMED forgeboard-offline-session-001');
      await expect(interrupted).toContainText('Superseded by newer resume');
    });

    await test.step('retry starts from an eligible failure in a fresh worktree and approval', async () => {
      await configuration.getByLabel('Prompt').fill(RETRY_FAILURE_PROMPT);
      await approvePreparedRun(
        app!,
        page,
        async () => configuration.getByRole('button', { name: 'Review and run Agent' }).click(),
        [RETRY_FAILURE_PROMPT, MODEL_ID],
      );
      await expect(liveOutput).toContainText('OFFLINE_RETRY_PARENT_FAILED');
      const failed = history.getByRole('article', { name: 'Initial run attempt Failed' });
      await expect(failed).toBeVisible({ timeout: 20_000 });
      await expect(failed).toContainText('16');
      await expect(failed).toContainText('$0.0019');

      await configuration.getByLabel('Prompt').fill(RETRY_PROMPT);
      await approvePreparedRun(
        app!,
        page,
        async () => failed.getByRole('button', { name: 'Retry review' }).click(),
        ['Retry of attempt', 'fresh immutable disclosure', RETRY_PROMPT, MODEL_ID],
      );
      await expect(liveOutput).toContainText('OFFLINE_RETRY_COMPLETED');
      const retry = history.getByRole('article', { name: 'Retry attempt Succeeded' });
      await expect(retry).toBeVisible({ timeout: 20_000 });
      await expect(retry).toContainText('Based on attempt');
      await expect(retry).toContainText('22');
      await expect(retry).toContainText('$0.0022');
      await retry.getByText('Output preview').click();
      await expect(retry).toContainText('OFFLINE_RETRY_COMPLETED');
    });

    await app.close();
    app = null;
    const restored = await launchDesktop(userDataDirectory);
    app = restored.app;
    page = restored.page;
    watchExternalRequests(page, externalRequests);
    await page.locator('.recent-list button').click();
    await page.getByRole('article', { name: 'Agent: Agent' }).click();
    configuration = page.getByRole('region', { name: 'Agent run settings' });
    const restoredHistory = page.getByRole('region', { name: 'Attempt history' });

    await test.step('restart restores durable history, lineage, output, and completion metadata', async () => {
      await expect(configuration.getByLabel('Agent to run')).toHaveValue(ADAPTER_ID);
      await expect(restoredHistory.getByRole('article')).toHaveCount(4);
      await expect(
        restoredHistory.getByRole('article', { name: 'Initial run attempt Interrupted' }),
      ).toContainText('$0.0042');
      await expect(
        restoredHistory.getByRole('article', { name: 'Resumed run attempt Succeeded' }),
      ).toContainText('Based on attempt');
      await expect(
        restoredHistory.getByRole('article', { name: 'Retry attempt Succeeded' }),
      ).toContainText('$0.0022');
    });

    await test.step('only managed worktrees changed and no external request escaped', async () => {
      expect(await primarySnapshot(repositoryPath)).toEqual(before);
      expect(await findFiles(repositoryPath, 'offline-agent-proof.txt')).toEqual([]);
      expect(await findFiles(repositoryPath, 'offline-agent-retry.txt')).toEqual([]);
      const proofFiles = await findFiles(worktreeRoot, 'offline-agent-proof.txt');
      const retryFiles = await findFiles(worktreeRoot, 'offline-agent-retry.txt');
      expect(proofFiles).toHaveLength(1);
      expect(retryFiles).toHaveLength(1);
      expect(await readFile(proofFiles[0]!, 'utf8')).toBe(
        `input=${INPUT_TEXT}\nresume completed\n`,
      );
      expect(await readFile(retryFiles[0]!, 'utf8')).toBe('retry completed\n');
      expect(externalRequests).toEqual([]);
    });
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
