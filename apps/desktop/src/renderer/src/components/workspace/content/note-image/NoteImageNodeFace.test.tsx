// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../../runs/agent-session/AgentSessionContext.js';
import { NoteImageNodeFace } from './NoteImageNodeFace.js';

const updateNodeData = vi.fn();
const recordHistory = vi.fn();
const reportError = vi.fn();
const loadImage = vi.fn();
const chooseImage = vi.fn();

afterEach(cleanup);
beforeEach(() => {
  updateNodeData.mockClear();
  recordHistory.mockClear();
  reportError.mockClear();
  loadImage.mockReset();
  chooseImage.mockReset();
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: { files: { loadImage, chooseImage } },
  });
});

function sessionValue(): AgentSessionContextValue {
  return {
    project: { id: 'p1' },
    graphReadOnly: false,
    updateNodeData,
    recordHistory,
    reportError,
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
        <NoteImageNodeFace id="n1" data={nodeData(overrides)} />
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

describe('NoteImageNodeFace', () => {
  it('renders loaded project images in the grid', async () => {
    loadImage.mockResolvedValue({
      status: 'available',
      projectId: 'p1',
      relativePath: 'docs/hero.png',
      dataUrl: 'data:image/png;base64,AAAA',
    });
    renderFace({
      images: [{ projectId: 'p1', relativePath: 'docs/hero.png', kind: 'image', missing: false }],
      altText: { 'docs/hero.png': 'Hero shot' },
    });
    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'Hero shot' }).getAttribute('src')).toBe(
        'data:image/png;base64,AAAA',
      ),
    );
  });

  it('adds an image through the existing chooser', async () => {
    chooseImage.mockResolvedValue({
      projectId: 'p1',
      relativePath: 'docs/new.png',
      missing: false,
    });
    renderFace();
    fireEvent.click(screen.getByRole('button', { name: 'Choose image' }));
    await waitFor(() => expect(recordHistory).toHaveBeenCalled());
    expect(updateNodeData).toHaveBeenCalledWith(
      'n1',
      expect.objectContaining({
        images: [expect.objectContaining({ relativePath: 'docs/new.png', kind: 'image' })],
      }),
    );
  });

  it('surfaces chooser failures through the session error channel', async () => {
    chooseImage.mockRejectedValue(new Error('dialog failed'));
    renderFace();
    fireEvent.click(screen.getByRole('button', { name: 'Choose image' }));
    await waitFor(() => expect(reportError).toHaveBeenCalledWith('dialog failed'));
  });

  it('disables editing for read-only nodes', () => {
    renderFace({ locked: true });
    expect(screen.getByRole('button', { name: 'Choose image' })).toHaveProperty('disabled', true);
  });
});
