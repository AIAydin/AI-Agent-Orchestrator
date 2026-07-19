import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, type Locator, type Page } from '@playwright/test';

export const REVIEW_CHECK_MARKER = 'FORGEBOARD_REVIEW_GATE_DELIVERY';

export async function installFakeCodex(root: string): Promise<string> {
  const bin = join(root, 'bin');
  await mkdir(bin, { recursive: true });
  const executable = join(bin, 'codex');
  await copyFile(
    fileURLToPath(
      new URL('../provider-connections/fixtures/scripts/fake-codex-reviewer.mjs', import.meta.url),
    ),
    executable,
  );
  await chmod(executable, 0o700);
  return executable;
}

export async function addNodeAt(
  page: Page,
  templateName: RegExp,
  articleName: string,
  position: { x: number; y: number },
): Promise<Locator> {
  const canvas = page.locator('.canvas-region');
  const node = page.getByRole('article', { name: articleName, exact: true });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page
      .locator('.template-section')
      .getByRole('button', { name: templateName })
      .dragTo(canvas, {
        targetPosition: position,
      });
    if (
      await node.waitFor({ state: 'visible', timeout: 2_000 }).then(
        () => true,
        () => false,
      )
    ) {
      return node;
    }
    if (attempt < 3) await page.waitForTimeout(250);
  }
  await expect(node).toBeVisible();
  return node;
}

export async function connectAndConfigure(
  page: Page,
  source: Locator,
  target: Locator,
  kind: 'output' | 'review' | 'revision',
): Promise<void> {
  const before = await page.locator('.react-flow__edge').count();
  await source.click();
  await page.waitForTimeout(350);
  const sourcePoint = await handlePoint(source.locator('.react-flow__handle-right'));
  const targetPoint = await handlePoint(target.locator('.react-flow__handle-left'));
  await page.mouse.move(sourcePoint.x, sourcePoint.y);
  await page.mouse.down();
  await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator('.react-flow__edge')).toHaveCount(before + 1);
  const edge = page.locator('.react-flow__edge').last();
  await edge.locator('.react-flow__edge-interaction').dispatchEvent('click');
  const configuration = page.getByRole('group', { name: 'Connection settings' });
  await configuration.getByLabel('Connection type').selectOption(kind);
  if (kind === 'output') {
    await configuration.getByLabel('Output to share').selectOption('diff');
    const required = configuration.getByRole('checkbox', {
      name: 'Require verified output before the next step runs',
    });
    if (!(await required.isChecked())) await required.check();
  } else if (kind === 'review') {
    await configuration.getByLabel('Who reviews').selectOption('gate');
    const approval = configuration.getByRole('checkbox', { name: 'Require approval' });
    if (!(await approval.isChecked())) await approval.check();
    const findings = configuration.getByRole('checkbox', {
      name: 'Require findings in a fixed format',
    });
    if (!(await findings.isChecked())) await findings.check();
  } else {
    await configuration.getByLabel('Loop ID').fill('review-loop');
    await configuration.getByLabel('Maximum attempts').fill('2');
    const review = configuration.getByRole('checkbox', {
      name: 'Stop when review is approved',
    });
    if (!(await review.isChecked())) await review.check();
    const tests = configuration.getByRole('checkbox', {
      name: 'Stop when required tests pass',
    });
    if (await tests.isChecked()) await tests.uncheck();
    await configuration
      .getByLabel('How a person can step in')
      .fill('Cancel safely if both bounded review attempts fail.');
  }
}

async function handlePoint(handle: Locator): Promise<{ x: number; y: number }> {
  const point = await handle.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const candidates = [
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      { x: box.x + box.width * 0.25, y: box.y + box.height / 2 },
      { x: box.x + box.width * 0.75, y: box.y + box.height / 2 },
    ];
    return candidates.find((candidate) => {
      const hit = document.elementFromPoint(candidate.x, candidate.y);
      return hit === element || element.contains(hit);
    });
  });
  if (point === undefined) throw new Error('A visible canvas connection handle was required.');
  return point;
}
