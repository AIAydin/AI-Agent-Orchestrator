import { describe, expect, it } from 'vitest';

import type { WorkshopNode } from '../canvas/CanvasNode.js';
import {
  initialWorkshopNodeDimensions,
  persistedWorkshopNodeDimensions,
  workshopNodeForPersistence,
} from './node-persistence.js';

describe('workshop node persistence dimensions', () => {
  it('assigns canonical dimensions to every newly created ordinary node', () => {
    expect(initialWorkshopNodeDimensions('task')).toEqual({ width: 320, height: 180 });
    expect(initialWorkshopNodeDimensions('extension')).toEqual({ width: 320, height: 180 });
    expect(initialWorkshopNodeDimensions('group-frame')).toEqual({ width: 520, height: 360 });
  });

  it('preserves explicit user dimensions and fills only missing legacy dimensions', () => {
    expect(persistedWorkshopNodeDimensions(node({ width: 640, height: 410 }))).toEqual({
      width: 640,
      height: 410,
    });
    expect(persistedWorkshopNodeDimensions(node({ width: 480 }))).toEqual({
      width: 480,
      height: 180,
    });
    expect(persistedWorkshopNodeDimensions(node({ width: 20, height: 10 }))).toEqual({
      width: 210,
      height: 92,
    });
    expect(
      persistedWorkshopNodeDimensions(node({ width: 200, height: 100 }, { kind: 'group-frame' })),
    ).toEqual({ width: 360, height: 240 });
  });

  it('serializes an unresized ordinary node with explicit reload-stable dimensions', () => {
    expect(workshopNodeForPersistence(node())).toMatchObject({
      id: 'task-1',
      type: 'task',
      width: 320,
      height: 180,
      position: { x: 10, y: 20 },
    });
  });

  it('gives agent nodes the larger session-window dimensions', () => {
    expect(initialWorkshopNodeDimensions('agent')).toEqual({ width: 560, height: 480 });
  });

  it('floors persisted agent nodes at the agent minimum', () => {
    const node = {
      data: { kind: 'agent' } as WorkshopNode['data'],
      width: 100,
      height: 100,
    };
    expect(persistedWorkshopNodeDimensions(node)).toEqual({ width: 400, height: 320 });
  });

  it('gives preview nodes browser-window dimensions', () => {
    expect(initialWorkshopNodeDimensions('web-preview')).toEqual({ width: 640, height: 480 });
    expect(initialWorkshopNodeDimensions('mobile-preview')).toEqual({ width: 420, height: 640 });
  });

  it('floors persisted preview nodes at their per-kind minimums', () => {
    expect(
      persistedWorkshopNodeDimensions({
        data: { kind: 'web-preview' } as WorkshopNode['data'],
        width: 100,
        height: 100,
      }),
    ).toEqual({ width: 400, height: 300 });
    expect(
      persistedWorkshopNodeDimensions({
        data: { kind: 'mobile-preview' } as WorkshopNode['data'],
        width: 100,
        height: 100,
      }),
    ).toEqual({ width: 320, height: 480 });
  });
});

function node(
  dimensions: Partial<Pick<WorkshopNode, 'height' | 'width'>> = {},
  data: Partial<WorkshopNode['data']> = {},
): WorkshopNode {
  return {
    id: 'task-1',
    type: 'workshop',
    position: { x: 10, y: 20 },
    ...dimensions,
    data: {
      kind: 'task',
      title: 'Task',
      description: 'Task',
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#445566',
      ...data,
    },
  };
}
