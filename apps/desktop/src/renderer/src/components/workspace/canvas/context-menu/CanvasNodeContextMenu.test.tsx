// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkshopNode } from '../CanvasNode.js';
import { CanvasNodeContextMenu } from './CanvasNodeContextMenu.js';

afterEach(cleanup);

describe('CanvasNodeContextMenu', () => {
  it('clamps to the canvas, navigates enabled actions, closes, and restores focus', () => {
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(80);
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(60);
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const onClose = vi.fn();
    const view = render(
      <CanvasNodeContextMenu
        {...props()}
        position={{ x: 500, y: 500, boundsWidth: 100, boundsHeight: 100 }}
        returnFocus={trigger}
        onClose={onClose}
      />,
    );

    const menu = screen.getByRole('menu', { name: 'Actions for Task' });
    expect(menu.getAttribute('style')).toContain('left: 12px');
    expect(menu.getAttribute('style')).toContain('top: 32px');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Inspect' }));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(
      screen.getByRole('menuitem', { name: 'Run with dependencies' }),
    );
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
    width.mockRestore();
    height.mockRestore();
  });

  it('runs exact callbacks and disables mutations for read-only or protected nodes', () => {
    const callbacks = props();
    const view = render(<CanvasNodeContextMenu {...callbacks} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Run with dependencies' }));
    expect(callbacks.onRun).toHaveBeenCalledTimes(1);
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);

    view.rerender(<CanvasNodeContextMenu {...callbacks} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    expect(callbacks.onDuplicate).toHaveBeenCalledTimes(1);
    expect(callbacks.onClose).toHaveBeenCalledTimes(2);

    view.rerender(
      <CanvasNodeContextMenu
        {...callbacks}
        node={{ ...node(), data: { ...node().data, locked: true } }}
        inheritedLock
        deletionProtected
      />,
    );
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Collapse' }).disabled).toBe(
      true,
    );
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Unlock' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Delete' }).disabled).toBe(true);

    view.rerender(<CanvasNodeContextMenu {...callbacks} readOnly />);
    expect(
      screen.getByRole<HTMLButtonElement>('menuitem', {
        name: 'Run with dependencies',
      }).disabled,
    ).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Duplicate' }).disabled).toBe(
      true,
    );
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Inspect' }).disabled).toBe(
      false,
    );
  });

  it('exposes an exact reason when workflow eligibility or activity disables Run', () => {
    const callbacks = props();
    render(
      <CanvasNodeContextMenu
        {...callbacks}
        runDisabled
        runDisabledReason="Choose an Agent assignee before running this Task."
      />,
    );

    const run = screen.getByRole<HTMLButtonElement>('menuitem', {
      name: 'Run with dependencies',
    });
    expect(run.disabled).toBe(true);
    const reason = screen.getByRole('tooltip', {
      name: 'Choose an Agent assignee before running this Task.',
    });
    expect(run.getAttribute('aria-describedby')).toBe(reason.id);
    fireEvent.click(run);
    expect(callbacks.onRun).not.toHaveBeenCalled();
  });

  it('disables Collapse for a text node, since a collapsed text node has no visible chrome', () => {
    const callbacks = props();
    render(
      <CanvasNodeContextMenu
        {...callbacks}
        node={{ ...node(), data: { ...node().data, kind: 'text' } }}
      />,
    );
    const collapse = screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Collapse' });
    expect(collapse.disabled).toBe(true);
    const reason = screen.getByRole('tooltip', { name: 'Text nodes cannot be collapsed.' });
    expect(collapse.getAttribute('aria-describedby')).toBe(reason.id);
    fireEvent.click(collapse);
    expect(callbacks.onSetCollapsed).not.toHaveBeenCalled();
  });

  it('dismisses for an outside pointer without running an action', () => {
    const callbacks = props();
    render(<CanvasNodeContextMenu {...callbacks} />);
    fireEvent.pointerDown(document.body);
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);
    expect(callbacks.onDelete).not.toHaveBeenCalled();
  });
});

function props(): React.ComponentProps<typeof CanvasNodeContextMenu> {
  return {
    node: node(),
    position: { x: 20, y: 20, boundsWidth: 800, boundsHeight: 600 },
    readOnly: false,
    inheritedLock: false,
    deletionProtected: false,
    runDisabled: false,
    returnFocus: null,
    onInspect: vi.fn(),
    onRun: vi.fn(),
    onSetCollapsed: vi.fn(),
    onSetLocked: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
  };
}

function node(): WorkshopNode {
  return {
    id: 'task',
    type: 'workshop',
    position: { x: 0, y: 0 },
    data: {
      kind: 'task',
      title: 'Task',
      description: 'Task',
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#58a6a6',
    },
  };
}
