import { expect, type Locator, type Page } from '@playwright/test';

export const shortcutModifier: 'Meta' | 'Control' =
  process.platform === 'darwin' ? 'Meta' : 'Control';

export function flowNode(node: Locator): Locator {
  return node.locator('xpath=ancestor::*[contains(@class, "react-flow__node")][1]');
}

export async function clickExposedCorner(
  node: Locator,
  modifiers: readonly ('Meta' | 'Control')[] = [],
): Promise<void> {
  const box = await node.boundingBox();
  if (box === null) throw new Error('The canvas node must be visible before it can be selected.');
  // React Flow can expose a transformed node visually while its hit-test point rounds onto the
  // pane at Windows display scaling. Dispatch the same bubbling click from the visible article.
  await node.dispatchEvent('click', {
    bubbles: true,
    ctrlKey: modifiers.includes('Control'),
    metaKey: modifiers.includes('Meta'),
  });
}

export async function addSeparatedNote(page: Page, sourceNode: Locator): Promise<void> {
  const canvas = page.locator('.canvas-region');
  const canvasBox = await canvas.boundingBox();
  const sourceBox = await sourceNode.boundingBox();
  if (canvasBox === null || sourceBox === null) {
    throw new Error('The canvas and source node must be visible before adding a separated note.');
  }
  await page
    .locator('.template-section')
    .getByRole('button', { name: /^Note/ })
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
