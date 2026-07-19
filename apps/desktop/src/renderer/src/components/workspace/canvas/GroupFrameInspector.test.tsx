// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkshopNode } from './CanvasNode.js';
import { GroupFrameInspector } from './GroupFrameInspector.js';

afterEach(cleanup);

describe('GroupFrameInspector', () => {
  it('configures frame behavior and membership entirely in the UI', () => {
    const group = node('group-1', 'group-frame', {
      purpose: 'custom',
      layout: 'freeform',
      autoFit: false,
      childNodeIds: ['agent-1'],
    });
    const agent = node('agent-1', 'agent');
    const test = node('test-1', 'test');
    const onRecord = vi.fn();
    const onUpdate = vi.fn();
    render(
      <GroupFrameInspector
        node={group}
        nodes={[group, agent, test]}
        onRecord={onRecord}
        onUpdate={onUpdate}
        onFit={vi.fn()}
        onArrange={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Group purpose' }), {
      target: { value: 'feature-area' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Member layout' }), {
      target: { value: 'grid' },
    });
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: /Automatically fit the group to its members/u,
      }),
    );
    expect(screen.getByRole('checkbox', { name: /agent-1/u })).toHaveProperty('checked', true);
    fireEvent.click(screen.getByRole('checkbox', { name: /test-1/u }));

    expect(onUpdate.mock.calls).toEqual([
      [{ purpose: 'feature-area' }],
      [{ layout: 'grid' }],
      [{ autoFit: true }],
      [{ childNodeIds: ['agent-1', 'test-1'] }],
    ]);
    expect(onRecord).toHaveBeenCalledTimes(4);
    for (let index = 0; index < onRecord.mock.invocationCallOrder.length; index += 1) {
      expect(onRecord.mock.invocationCallOrder[index]).toBeLessThan(
        onUpdate.mock.invocationCallOrder[index] ?? Number.POSITIVE_INFINITY,
      );
    }
  });

  it('delegates fit and arrange so the graph owner records only real geometry changes', () => {
    const group = node('group-1', 'group-frame', {
      layout: 'vertical',
      childNodeIds: ['agent-1'],
    });
    const onRecord = vi.fn();
    const onFit = vi.fn();
    const onArrange = vi.fn();
    render(
      <GroupFrameInspector
        node={group}
        nodes={[group, node('agent-1', 'agent')]}
        onRecord={onRecord}
        onUpdate={vi.fn()}
        onFit={onFit}
        onArrange={onArrange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Fit to members' }));
    fireEvent.click(screen.getByRole('button', { name: 'Arrange members' }));

    expect(onFit).toHaveBeenCalledTimes(1);
    expect(onArrange).toHaveBeenCalledWith('vertical');
    expect(onRecord).not.toHaveBeenCalled();
  });

  it('honestly disables layout actions that cannot change members', () => {
    const { rerender } = render(
      <GroupFrameInspector
        node={node('group-1', 'group-frame', {
          layout: 'freeform',
          childNodeIds: ['agent-1'],
        })}
        nodes={[node('group-1', 'group-frame'), node('agent-1', 'agent')]}
        onRecord={vi.fn()}
        onUpdate={vi.fn()}
        onFit={vi.fn()}
        onArrange={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Fit to members' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(screen.getByRole('button', { name: 'Arrange members' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText(/Freeform keeps members where they are/u)).toBeTruthy();

    rerender(
      <GroupFrameInspector
        node={node('group-1', 'group-frame', {
          layout: 'grid',
          childNodeIds: [],
        })}
        nodes={[node('group-1', 'group-frame'), node('agent-1', 'agent')]}
        onRecord={vi.fn()}
        onUpdate={vi.fn()}
        onFit={vi.fn()}
        onArrange={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Fit to members' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Arrange members' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText(/Add at least one member before fitting or arranging/u)).toBeTruthy();
  });

  it('does not offer membership mutation for locked nodes or members of another locked frame', () => {
    const group = node('group-1', 'group-frame');
    const lockedGroup = node('group-2', 'group-frame', {
      locked: true,
      childNodeIds: ['protected'],
    });
    render(
      <GroupFrameInspector
        node={group}
        nodes={[
          group,
          lockedGroup,
          node('protected', 'agent'),
          node('locked', 'task', { locked: true }),
        ]}
        onRecord={vi.fn()}
        onUpdate={vi.fn()}
        onFit={vi.fn()}
        onArrange={vi.fn()}
      />,
    );

    const protectedMember = screen.getByRole('checkbox', {
      name: /protected/u,
    });
    const lockedMember = screen.getByRole('checkbox', {
      name: /^locked task/u,
    });
    const reasons = screen.getAllByRole('tooltip', {
      name: 'Unlock this node or its current group first.',
    });
    expect(protectedMember).toHaveProperty('disabled', true);
    expect(lockedMember).toHaveProperty('disabled', true);
    expect(reasons.length).toBeGreaterThanOrEqual(2);
    expect(protectedMember.closest('label')?.getAttribute('aria-describedby')).toBeTruthy();
    expect(lockedMember.closest('label')?.getAttribute('aria-describedby')).toBeTruthy();
  });

  it('offers nested frames while disabling an ancestor that would create a cycle', () => {
    const outer = node('outer', 'group-frame', { childNodeIds: ['group-1'] });
    const group = node('group-1', 'group-frame', { childNodeIds: [] });
    const nested = node('nested', 'group-frame', { childNodeIds: [] });
    const onUpdate = vi.fn();
    render(
      <GroupFrameInspector
        node={group}
        nodes={[outer, group, nested]}
        onRecord={vi.fn()}
        onUpdate={onUpdate}
        onFit={vi.fn()}
        onArrange={vi.fn()}
      />,
    );

    expect(screen.getByRole('checkbox', { name: /outer/u })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('checkbox', { name: /nested/u }));
    expect(onUpdate).toHaveBeenCalledWith({ childNodeIds: ['nested'] });
    expect(
      screen.getByRole('tooltip', { name: 'A group cannot contain one of its ancestors.' }),
    ).toBeTruthy();
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
