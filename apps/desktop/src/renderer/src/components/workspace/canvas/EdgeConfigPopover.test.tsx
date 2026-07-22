// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkshopNode } from './CanvasNode.js';
import { EdgeConfigPopover } from './EdgeConfigPopover.js';
import { createEdgeData, type WorkshopEdgeData } from '../model/edge-config.js';
import type { WorkshopEdge } from '../model/types.js';

afterEach(cleanup);

function workshopNode(id: string, kind: WorkshopNode['data']['kind']): WorkshopNode {
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
    },
  };
}

function edge(data: WorkshopEdgeData): WorkshopEdge {
  return {
    id: 'edge-1',
    source: 'brief-1',
    target: 'agent-1',
    data,
  };
}

describe('EdgeConfigPopover', () => {
  it('renders the connection type selector and typed fields for the current edge', () => {
    render(
      <EdgeConfigPopover
        edge={edge(createEdgeData('context', 'brief-1'))}
        nodes={[workshopNode('brief-1', 'brief'), workshopNode('agent-1', 'agent')]}
        onUpdateType={vi.fn()}
        onUpdateData={vi.fn()}
      />,
    );

    expect(
      screen.getByRole<HTMLSelectElement>('combobox', { name: 'Connection type' }),
    ).toMatchObject({ value: 'context' });
    expect(screen.getByText('brief-1', { selector: 'code' })).toBeTruthy();
    expect(screen.getByText(/1 attachment will be shared/u)).toBeTruthy();
  });

  it('invokes onUpdateType when the connection type changes', () => {
    const onUpdateType = vi.fn();
    render(
      <EdgeConfigPopover
        edge={edge(createEdgeData('context', 'brief-1'))}
        nodes={[workshopNode('brief-1', 'brief'), workshopNode('agent-1', 'agent')]}
        onUpdateType={onUpdateType}
        onUpdateData={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Connection type' }), {
      target: { value: 'review' },
    });
    expect(onUpdateType).toHaveBeenCalledWith('review');
  });

  it('invokes onUpdateData when a typed field changes', () => {
    const onUpdateData = vi.fn<(data: WorkshopEdgeData) => void>();
    render(
      <EdgeConfigPopover
        edge={edge(createEdgeData('context', 'brief-1'))}
        nodes={[workshopNode('brief-1', 'brief'), workshopNode('agent-1', 'agent')]}
        onUpdateType={vi.fn()}
        onUpdateData={onUpdateData}
      />,
    );

    fireEvent.click(screen.getByLabelText('Muted'));
    expect(onUpdateData).toHaveBeenCalledWith({
      edgeType: 'context',
      config: {
        attachmentMode: 'explicit',
        required: true,
        muted: true,
        attachmentIds: ['brief-1'],
      },
    });
  });

  it('disables every control and shows a lock notice when read-only', () => {
    const onUpdateType = vi.fn();
    const onUpdateData = vi.fn();
    render(
      <EdgeConfigPopover
        edge={edge(createEdgeData('context', 'brief-1'))}
        nodes={[workshopNode('brief-1', 'brief'), workshopNode('agent-1', 'agent')]}
        readOnly
        onUpdateType={onUpdateType}
        onUpdateData={onUpdateData}
      />,
    );

    expect(screen.getByRole('status').textContent).toMatch(/linked to a locked node/u);
    expect(
      screen.getByRole<HTMLFieldSetElement>('group', { name: 'Connection settings' }),
    ).toHaveProperty('disabled', true);
    expect(
      screen
        .getByRole<HTMLSelectElement>('combobox', { name: 'Connection type' })
        .matches(':disabled'),
    ).toBe(true);
    expect(onUpdateType).not.toHaveBeenCalled();
    expect(onUpdateData).not.toHaveBeenCalled();
  });
});
