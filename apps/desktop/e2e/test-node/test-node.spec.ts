import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication } from '@playwright/test';

import {
  closeElectronAfterTest,
  launchDesktop,
  watchExternalRequests,
} from '../support/electron.js';
import {
  ARTIFACT_PATH,
  LIVE_MARKER,
  LONG_RUNNING_SCRIPT,
  PASS_MARKER,
  PASSING_SCRIPT,
  addAndSelectTestNode,
  configureTestNode,
  expectParsedSummary,
  openLaunchDecision,
  openSafeDemo,
  selectRestoredTestNode,
} from './fixture.js';
import {
  expectExactLaunchConfirmation,
  expectExactNodeCancelConfirmation,
  installWorkflowNativeDialogHarness,
  queueWorkflowNativeResponse,
  waitForWorkflowNativeDialog,
} from './native-confirmation.js';

test('a Test node streams, cancels, reruns, verifies artifacts, and restores entirely through the UI', async () => {
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'forgeboard-test-node-e2e-'));
  let electronApp: ElectronApplication | null = null;
  const externalRequests: string[] = [];

  try {
    const firstSession = await launchDesktop(userDataDirectory);
    electronApp = firstSession.app;
    let page = firstSession.page;
    watchExternalRequests(page, externalRequests);
    await installWorkflowNativeDialogHarness(electronApp);
    await openSafeDemo(page);

    const panel = await addAndSelectTestNode(page);
    await test.step('configure the long-running exact command and artifact path in the UI', async () => {
      await configureTestNode(panel, LONG_RUNNING_SCRIPT);
      const configuration = panel.getByRole('group', {
        name: 'Test command configuration',
      });
      await expect(configuration.getByLabel('Program')).toHaveValue('node');
      await expect(configuration.getByLabel(/Arguments/u)).toHaveValue(
        `-e\n${LONG_RUNNING_SCRIPT}`,
      );
      await expect(configuration.getByLabel(/Result files to keep/u)).toHaveValue(ARTIFACT_PATH);
    });

    await test.step('review the exact launch, observe live parsed output, and cancel only the node', async () => {
      await panel.getByRole('button', { name: 'Review and run' }).click();
      const launch = await openLaunchDecision(page);
      await expect(launch).toContainText(LIVE_MARKER);
      await expect(launch).toContainText(ARTIFACT_PATH);
      await queueWorkflowNativeResponse(electronApp!, 1);
      await launch.getByRole('button', { name: 'Continue to approval' }).click();
      expectExactLaunchConfirmation(await waitForWorkflowNativeDialog(electronApp!, 0), {
        artifactPath: ARTIFACT_PATH,
        marker: LIVE_MARKER,
      });

      await expect(panel.locator('.node-face-strip .node-face-status')).toHaveText('Running');
      await expect(panel.getByLabel('Test output').first()).toContainText(LIVE_MARKER);
      await expectParsedSummary(panel, {
        passed: 1,
        failed: 0,
        skipped: 0,
        total: 1,
      });

      await queueWorkflowNativeResponse(electronApp!, 1);
      await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
      expectExactNodeCancelConfirmation(await waitForWorkflowNativeDialog(electronApp!, 1));
      await expect(panel.locator('.node-face-strip .node-face-status')).toHaveText('Cancelled');
      await expect.poll(async () => await panel.textContent()).toContain(LIVE_MARKER);
      await expectParsedSummary(panel, {
        passed: 1,
        failed: 0,
        skipped: 0,
        total: 1,
      });
    });

    await test.step('reconfigure, rerun, parse the passing summary, and expose a verified artifact', async () => {
      await configureTestNode(panel, PASSING_SCRIPT);
      await panel.getByRole('button', { name: 'Review and run' }).click();
      const launch = await openLaunchDecision(page);
      await expect(launch).toContainText(PASS_MARKER);
      await queueWorkflowNativeResponse(electronApp!, 1);
      await launch.getByRole('button', { name: 'Continue to approval' }).click();
      expectExactLaunchConfirmation(await waitForWorkflowNativeDialog(electronApp!, 2), {
        artifactPath: ARTIFACT_PATH,
        marker: PASS_MARKER,
      });

      await expect(panel.locator('.node-face-strip .node-face-status')).toHaveText('Passed');
      await expect(panel.getByLabel('Test output').first()).toContainText(PASS_MARKER);
      await expectParsedSummary(panel, {
        passed: 4,
        failed: 0,
        skipped: 1,
        total: 5,
      });
      const workflows = page
        .locator('.activity-drawer')
        .getByRole('tabpanel', { name: 'Workflows' });
      const refresh = workflows.getByRole('button', { name: 'Refresh' });
      const artifacts = panel.getByLabel('Verified test artifacts');
      await expect(async () => {
        await refresh.click();
        await expect(refresh).toBeEnabled();
        await expect(artifacts).toContainText(ARTIFACT_PATH, { timeout: 1_000 });
      }).toPass({ timeout: 30_000 });
      await expect(
        artifacts.getByRole('button', { name: 'Reveal test-node-result.json' }),
      ).toBeVisible();
      await expect(
        artifacts.getByRole('button', { name: 'Open test-node-result.json' }),
      ).toBeVisible();
      await expect(panel.getByRole('region', { name: 'Previous test attempts' })).toContainText(
        'Cancelled',
      );
    });

    await electronApp.close();
    electronApp = null;

    const restoredSession = await launchDesktop(userDataDirectory);
    electronApp = restoredSession.app;
    page = restoredSession.page;
    watchExternalRequests(page, externalRequests);
    await expect(page.locator('.setup-shell')).toHaveCount(0);
    await page.locator('.recent-list button').click();
    const restoredPanel = await selectRestoredTestNode(page);

    await test.step('restart restores the prior output, summary, artifact, and cancelled attempt', async () => {
      await expect(restoredPanel.locator('.node-face-strip .node-face-status')).toHaveText(
        'Passed',
      );
      await expect(restoredPanel.getByLabel('Test output').first()).toContainText(PASS_MARKER);
      await expectParsedSummary(restoredPanel, {
        passed: 4,
        failed: 0,
        skipped: 1,
        total: 5,
      });
      await expect(restoredPanel.getByLabel('Verified test artifacts')).toContainText(
        ARTIFACT_PATH,
      );
      await expect(
        restoredPanel.getByRole('region', { name: 'Previous test attempts' }),
      ).toContainText('Cancelled');
    });

    expect(externalRequests).toEqual([]);
  } finally {
    await closeElectronAfterTest(electronApp);
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});
