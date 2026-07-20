// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { WorkshopNodeData } from '../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../canvas/interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../runs/agent-session/AgentSessionContext.js';
import { PreviewNodeFace } from './PreviewNodeFace.js';

const updateNodeData = vi.fn();
const recordHistory = vi.fn();

afterEach(cleanup);
beforeEach(() => {
  updateNodeData.mockClear();
  recordHistory.mockClear();
});

function sessionValue(graphReadOnly = false): AgentSessionContextValue {
  return {
    project: { id: 'p1' },
    graphReadOnly,
    updateNodeData,
    recordHistory,
  } as unknown as AgentSessionContextValue;
}

function nodeData(overrides: Partial<WorkshopNodeData> = {}): WorkshopNodeData {
  return {
    kind: 'web-preview',
    title: 'Preview',
    description: '',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#6099c5',
    ...overrides,
  } as WorkshopNodeData;
}

function renderFace(
  kind: 'web-preview' | 'mobile-preview',
  overrides: Partial<WorkshopNodeData> = {},
  graphReadOnly = false,
) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue(graphReadOnly)}>
        <PreviewNodeFace id="n1" kind={kind} data={nodeData({ kind, ...overrides })} />
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

describe('PreviewNodeFace', () => {
  it('shows only a port input and hint while no port is set', () => {
    const { container } = renderFace('web-preview');
    expect(screen.getByLabelText('Preview port')).toHaveProperty('value', '');
    expect(screen.getByText(/enter the port/i)).toBeTruthy();
    expect(container.querySelector('webview')).toBeNull();
    expect(screen.getByRole('button', { name: 'Reload preview' })).toHaveProperty('disabled', true);
  });

  it('persists the typed port on Enter', () => {
    renderFace('web-preview');
    const input = screen.getByLabelText('Preview port');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '5173' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(recordHistory).toHaveBeenCalled();
    expect(updateNodeData).toHaveBeenCalledWith('n1', { previewPort: 5173 });
  });

  it('clears the port when the input is emptied', () => {
    renderFace('web-preview', { previewPort: 5173 });
    const input = screen.getByLabelText('Preview port');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(updateNodeData).toHaveBeenCalledWith('n1', { previewPort: undefined });
  });

  it('renders a partitioned localhost webview once a port is set', () => {
    const { container } = renderFace('web-preview', { previewPort: 5173 });
    const webview = container.querySelector('webview');
    expect(webview?.getAttribute('src')).toBe('http://localhost:5173/');
    expect(webview?.getAttribute('partition')).toBe('preview:p1:n1');
    expect(webview?.closest('.preview-face-body')?.className).toContain('nowheel');
    expect(webview?.closest('.preview-face-body')?.className).toContain('nodrag');
  });

  it('wraps the mobile face in a device frame at the stored preset size', () => {
    const { container } = renderFace('mobile-preview', { previewPort: 5173 });
    const frame = container.querySelector('.preview-face-device-frame') as HTMLElement;
    expect(frame).not.toBeNull();
    expect(frame.style.width).toBe('390px');
    expect(frame.style.height).toBe('844px');
    expect(container.querySelector('webview')).not.toBeNull();
  });

  it('disables the port input for locked nodes and read-only collaborators', () => {
    renderFace('web-preview', { locked: true });
    expect(screen.getByLabelText('Preview port')).toHaveProperty('disabled', true);
    cleanup();
    renderFace('web-preview', {}, true);
    expect(screen.getByLabelText('Preview port')).toHaveProperty('disabled', true);
  });
});
