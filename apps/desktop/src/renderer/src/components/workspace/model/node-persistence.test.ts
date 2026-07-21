import { describe, expect, it } from 'vitest';

import type { WorkshopNode } from '../canvas/CanvasNode.js';
import {
  initialWorkshopNodeDimensions,
  persistedWorkshopNodeDimensions,
  workshopNodeForPersistence,
} from './node-persistence.js';

describe('workshop node persistence dimensions', () => {
  it('assigns canonical dimensions to every newly created ordinary node', () => {
    expect(initialWorkshopNodeDimensions('extension')).toEqual({ width: 320, height: 180 });
    expect(initialWorkshopNodeDimensions('file')).toEqual({ width: 320, height: 180 });
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
      type: 'extension',
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

  it('gives document and status nodes face dimensions', () => {
    expect(initialWorkshopNodeDimensions('diagram')).toEqual({ width: 480, height: 360 });
    expect(initialWorkshopNodeDimensions('whiteboard')).toEqual({ width: 560, height: 420 });
    expect(initialWorkshopNodeDimensions('brief')).toEqual({ width: 440, height: 440 });
    expect(initialWorkshopNodeDimensions('note-image')).toEqual({ width: 400, height: 360 });
    expect(initialWorkshopNodeDimensions('task')).toEqual({ width: 340, height: 280 });
    expect(initialWorkshopNodeDimensions('review-gate')).toEqual({ width: 360, height: 300 });
    expect(initialWorkshopNodeDimensions('git-pr')).toEqual({ width: 420, height: 380 });
    expect(initialWorkshopNodeDimensions('test')).toEqual({ width: 400, height: 340 });
  });

  it('floors persisted document and status nodes at their per-kind minimums', () => {
    const floored = (kind: WorkshopNode['data']['kind']) =>
      persistedWorkshopNodeDimensions({
        data: { kind } as WorkshopNode['data'],
        width: 10,
        height: 10,
      });
    expect(floored('diagram')).toEqual({ width: 320, height: 240 });
    expect(floored('whiteboard')).toEqual({ width: 360, height: 280 });
    expect(floored('brief')).toEqual({ width: 320, height: 280 });
    expect(floored('note-image')).toEqual({ width: 300, height: 240 });
    expect(floored('task')).toEqual({ width: 260, height: 200 });
    expect(floored('review-gate')).toEqual({ width: 280, height: 220 });
    expect(floored('git-pr')).toEqual({ width: 320, height: 260 });
    expect(floored('test')).toEqual({ width: 300, height: 240 });
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
      kind: 'extension',
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
