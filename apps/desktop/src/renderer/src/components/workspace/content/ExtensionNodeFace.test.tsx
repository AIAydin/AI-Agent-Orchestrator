// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type {
  ExtensionCanvasFieldView,
  ExtensionCanvasNodeTypeView,
} from '../../../../../shared/application/contracts.js';
import type { WorkshopNodeData } from '../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../canvas/interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../runs/agent-session/AgentSessionContext.js';
import { ExtensionNodeFace } from './ExtensionNodeFace.js';

const updateNodeData = vi.fn();
const reportError = vi.fn();

afterEach(cleanup);
beforeEach(() => {
  updateNodeData.mockClear();
  reportError.mockClear();
});

function sessionValue(): AgentSessionContextValue {
  return {
    graphReadOnly: false,
    updateNodeData,
    reportError,
  } as unknown as AgentSessionContextValue;
}

const textField: ExtensionCanvasFieldView = {
  id: 'greeting',
  label: 'Greeting',
  required: false,
  kind: 'text',
} as unknown as ExtensionCanvasFieldView;

const definition: ExtensionCanvasNodeTypeView = {
  id: 'hello',
  displayName: 'Hello node',
  fields: [textField],
} as unknown as ExtensionCanvasNodeTypeView;

function nodeData(overrides: Partial<WorkshopNodeData> = {}): WorkshopNodeData {
  return {
    kind: 'extension',
    title: 'Hello',
    description: '',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#8d7de8',
    extensionId: 'acme.hello',
    extensionVersion: '1.0.0',
    extensionDefinition: definition,
    extensionValues: {},
    extensionAvailability: 'active',
    ...overrides,
  } as unknown as WorkshopNodeData;
}

function renderFace(overrides: Partial<WorkshopNodeData> = {}) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue()}>
        <ExtensionNodeFace id="n1" data={nodeData(overrides)} />
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

describe('ExtensionNodeFace', () => {
  it('edits extension field values in place', () => {
    renderFace();
    fireEvent.change(screen.getByRole('textbox', { name: /Greeting/ }), {
      target: { value: 'Hi there' },
    });
    expect(updateNodeData).toHaveBeenCalledWith('n1', {
      extensionValues: { greeting: 'Hi there' },
    });
  });

  it('disables the field wrapper when read-only', () => {
    const { container } = renderFace({ locked: true });
    const fieldset = container.querySelector('fieldset.node-face-body') as HTMLFieldSetElement;
    expect(fieldset.disabled).toBe(true);
  });

  it('shows a hint when the extension definition is missing', () => {
    const data = { ...nodeData(), extensionDefinition: undefined } as unknown as WorkshopNodeData;
    render(
      <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
        <AgentSessionProvider value={sessionValue()}>
          <ExtensionNodeFace id="n1" data={data} />
        </AgentSessionProvider>
      </CanvasNodeInteractionProvider>,
    );
    expect(screen.getByText(/missing its definition/)).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
