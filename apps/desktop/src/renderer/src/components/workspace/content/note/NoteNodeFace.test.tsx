// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../../runs/agent-session/AgentSessionContext.js';
import { NoteNodeFace } from './NoteNodeFace.js';

const updateNodeData = vi.fn();
const recordHistory = vi.fn();

afterEach(cleanup);
beforeEach(() => {
  updateNodeData.mockClear();
  recordHistory.mockClear();
});

function sessionValue(): AgentSessionContextValue {
  return {
    project: { id: 'p1' },
    graphReadOnly: false,
    updateNodeData,
    recordHistory,
  } as unknown as AgentSessionContextValue;
}

function nodeData(overrides: Partial<WorkshopNodeData> = {}): WorkshopNodeData {
  return {
    kind: 'note-image',
    title: 'Moodboard',
    description: '',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#c5a75f',
    ...overrides,
  } as WorkshopNodeData;
}

function renderFace(overrides: Partial<WorkshopNodeData> = {}) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue()}>
        <NoteNodeFace id="n1" data={nodeData(overrides)} />
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

describe('NoteNodeFace', () => {
  it('edits the note text in place', () => {
    renderFace({ markdown: 'Old note' });
    const editor = screen.getByRole('textbox', { name: 'Note Markdown source' });
    expect(editor).toHaveProperty('value', 'Old note');
    fireEvent.focus(editor);
    expect(recordHistory).toHaveBeenCalled();
    fireEvent.change(editor, { target: { value: 'New note' } });
    expect(updateNodeData).toHaveBeenCalledWith('n1', { markdown: 'New note' });
  });

  it('locks editing for locked nodes', () => {
    renderFace({ locked: true });
    expect(screen.getByRole('textbox', { name: 'Note Markdown source' })).toHaveProperty(
      'readOnly',
      true,
    );
  });

  it('ignores legacy image data without rendering images or settings', () => {
    renderFace({
      images: [{ projectId: 'p1', relativePath: 'docs/hero.png', kind: 'image', missing: false }],
      altText: { 'docs/hero.png': 'Hero' },
    });
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Choose image' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Image settings' })).toBeNull();
  });
});
