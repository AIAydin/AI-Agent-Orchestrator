import { expect, type Locator, type Page } from '@playwright/test';

export const shortcutModifier = process.platform === 'darwin' ? 'Meta' : 'Control';

export function flowNode(node: Locator): Locator {
  return node.locator('xpath=ancestor::*[contains(@class, "react-flow__node")][1]');
}

export async function clickExposedCorner(page: Page, node: Locator): Promise<void> {
  const box = await node.boundingBox();
  if (box === null) throw new Error('The canvas node must be visible before it can be selected.');
  await page.mouse.click(box.x + 14, box.y + 14);
}

export async function addSeparatedTask(page: Page, sourceNode: Locator): Promise<void> {
  const canvas = page.locator('.canvas-region');
  const canvasBox = await canvas.boundingBox();
  const sourceBox = await sourceNode.boundingBox();
  if (canvasBox === null || sourceBox === null) {
    throw new Error('The canvas and source node must be visible before adding a separated task.');
  }
  await page
    .locator('.template-section')
    .getByRole('button', { name: /^Task/ })
    .dragTo(canvas, {
      targetPosition: {
        x: Math.max(120, Math.min(canvasBox.width - 280, sourceBox.x - canvasBox.x + 360)),
        y: Math.max(180, Math.min(canvasBox.height - 180, sourceBox.y - canvasBox.y + 190)),
      },
    });
}

export async function expectNodeNearCanvasCenter(page: Page, node: Locator): Promise<void> {
  await expect
    .poll(async () => {
      const canvas = await page.locator('.canvas-region').boundingBox();
      const nodeBox = await node.boundingBox();
      if (canvas === null || nodeBox === null) return Number.POSITIVE_INFINITY;
      const deltaX = nodeBox.x + nodeBox.width / 2 - (canvas.x + canvas.width / 2);
      const deltaY = nodeBox.y + nodeBox.height / 2 - (canvas.y + canvas.height / 2);
      return Math.hypot(deltaX, deltaY);
    })
    .toBeLessThan(230);
}
