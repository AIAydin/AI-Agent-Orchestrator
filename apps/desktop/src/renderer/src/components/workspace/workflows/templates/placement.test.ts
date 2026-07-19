import { describe, expect, it } from 'vitest';

import type { WorkshopNode } from '../../canvas/CanvasNode.js';
import { workflowTemplateById } from './catalog.js';
import { collisionFreeTemplateOrigin } from './placement.js';

describe('workflow template placement', () => {
  it('uses the preferred origin on an empty canvas', () => {
    expect(
      collisionFreeTemplateOrigin(workflowTemplateById('single-agent'), [], { x: 220, y: 150 }),
    ).toEqual({ x: 220, y: 150 });
  });

  it('places the complete graph beyond existing default and resized node bounds', () => {
    const existing = [node('default', 900), node('resized', 1_300, 600)];
    const origin = collisionFreeTemplateOrigin(
      workflowTemplateById('multi-screen-product-build'),
      existing,
      { x: 220, y: 150 },
    );
    expect(origin).toEqual({ x: 2_020, y: 150 });
    expect(origin.x).toBeGreaterThan(1_300 + 600);
  });
});

function node(id: string, x: number, width?: number): WorkshopNode {
  return {
    id,
    type: 'workshop',
    position: { x, y: 0 },
    ...(width === undefined ? {} : { width }),
    data: {
      kind: 'agent',
      title: id,
      description: '',
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#445566',
    },
  };
}
