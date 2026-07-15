// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { WorkshopNode } from '../CanvasNode.js';
import { GroupFrameInspector } from './GroupFrameInspector.js';

describe('GroupFrameInspector', () => {
  it('configures group membership entirely in the UI', () => {
    const group = node('group-1', 'group-frame', { childNodeIds: ['agent-1'] });
    const agent = node('agent-1', 'agent');
    const test = node('test-1', 'test');
    const onUpdate = vi.fn();
    render(
      <GroupFrameInspector
        node={group}
        nodes={[group, agent, test]}
        onRecord={vi.fn()}
        onUpdate={onUpdate}
      />,
    );
    expect(screen.getByRole('checkbox', { name: /agent-1/u })).toHaveProperty('checked', true);
    fireEvent.click(screen.getByRole('checkbox', { name: /test-1/u }));
    expect(onUpdate).toHaveBeenCalledWith({ childNodeIds: ['agent-1', 'test-1'] });
  });
});

function node(
  id: string,
  kind: WorkshopNode['data']['kind'],
  data: Partial<WorkshopNode['data']> = {},
): WorkshopNode {
  return {
    id,
    type: 'workshop',
    position: { x: 0, y: 0 },
    data: {
      kind,
      title: id,
      description: '',
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#445566',
      ...data,
    },
  };
}
