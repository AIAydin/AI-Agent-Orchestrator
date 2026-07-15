// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkshopNode } from './CanvasNode.js';
import { TypedEdgeInspector } from './TypedEdgeInspector.js';
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

describe('TypedEdgeInspector', () => {
  it('disables every connection control when either endpoint is locked', () => {
    const onChange = vi.fn();
    const onUpdateType = vi.fn();
    render(
      <TypedEdgeInspector
        edge={edge(createEdgeData('context', 'brief-1'))}
        nodes={[workshopNode('brief-1', 'brief'), workshopNode('agent-1', 'agent')]}
        readOnly
        onChange={onChange}
        onUpdateType={onUpdateType}
      />,
    );

    expect(screen.getByRole('status').textContent).toMatch(/touches a locked node/u);
    expect(
      screen.getByRole<HTMLFieldSetElement>('group', { name: 'Connection configuration' }),
    ).toHaveProperty('disabled', true);
    expect(
      screen
        .getByRole<HTMLSelectElement>('combobox', { name: 'Connection behavior' })
        .matches(':disabled'),
    ).toBe(true);
    expect(
      screen
        .getByRole<HTMLInputElement>('checkbox', {
          name: 'Block the agent until this exact attachment resolves',
        })
        .matches(':disabled'),
    ).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(onUpdateType).not.toHaveBeenCalled();
  });

  it('shows and updates the exact explicit context attachment contract', () => {
    const onChange = vi.fn();
    render(
      <TypedEdgeInspector
        edge={edge(createEdgeData('context', 'brief-1'))}
        nodes={[workshopNode('brief-1', 'brief'), workshopNode('agent-1', 'agent')]}
        onChange={onChange}
        onUpdateType={vi.fn()}
      />,
    );

    expect(screen.getByText('brief-1', { selector: 'code' })).toBeTruthy();
    expect(screen.getByText(/1 explicit attachment ID/u)).toBeTruthy();
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Block the agent until this exact attachment resolves',
      }),
    );
    expect(onChange).toHaveBeenCalledWith({
      edgeType: 'context',
      config: { attachmentMode: 'explicit', required: false, attachmentIds: ['brief-1'] },
    });
  });

  it('configures execute approval against a real review-gate node', () => {
    const onChange = vi.fn();
    const execute = createEdgeData('execute', 'brief-1', {
      config: { approval: 'review-gate', approvalGateNodeId: 'gate-1' },
    });
    render(
      <TypedEdgeInspector
        edge={edge(execute)}
        nodes={[
          workshopNode('brief-1', 'brief'),
          workshopNode('agent-1', 'agent'),
          workshopNode('gate-1', 'review-gate'),
        ]}
        onChange={onChange}
        onUpdateType={vi.fn()}
      />,
    );

    expect(screen.getByRole('combobox', { name: 'Gate node' })).toMatchObject({ value: 'gate-1' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Trigger' }), {
      target: { value: 'on-completion' },
    });
    expect(onChange).toHaveBeenCalledWith({
      edgeType: 'execute',
      config: {
        trigger: 'on-completion',
        approval: 'review-gate',
        approvalGateNodeId: 'gate-1',
      },
    });
  });

  it('keeps draft revision configuration bounded to valid entity-id characters', () => {
    const onChange = vi.fn<(data: WorkshopEdgeData) => void>();
    render(
      <TypedEdgeInspector
        edge={edge(createEdgeData('revision', 'brief-1'))}
        nodes={[workshopNode('brief-1', 'brief'), workshopNode('agent-1', 'agent')]}
        onChange={onChange}
        onUpdateType={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole('textbox', { name: 'Bounded loop ID' }), {
      target: { value: 'loop 1/unsafe' },
    });
    const sanitized = onChange.mock.calls.at(-1)?.[0];
    expect(sanitized).toMatchObject({
      edgeType: 'revision',
      config: { loopId: 'loop1unsafe', actionableFeedbackRequired: true },
      loop: {
        maximumAttempts: 3,
        stopConditions: ['review-approved'],
      },
    });
    expect(
      sanitized?.edgeType === 'revision' ? sanitized.loop.humanEscapeInstructions : '',
    ).toMatch(/human/u);

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Maximum attempts' }), {
      target: { value: '7' },
    });
    const bounded = onChange.mock.calls.at(-1)?.[0];
    expect(bounded?.edgeType).toBe('revision');
    expect(bounded?.edgeType === 'revision' ? bounded.loop.maximumAttempts : undefined).toBe(7);
  });
});
