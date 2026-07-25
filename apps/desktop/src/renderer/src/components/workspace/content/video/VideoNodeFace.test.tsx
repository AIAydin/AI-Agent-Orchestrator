// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../../runs/agent-session/AgentSessionContext.js';
import { VideoNodeFace } from './VideoNodeFace.js';

const updateNodeData = vi.fn();
const recordHistory = vi.fn();
const loadVideo = vi.fn();
const chooseVideo = vi.fn();

afterEach(cleanup);
beforeEach(() => {
  updateNodeData.mockClear();
  recordHistory.mockClear();
  loadVideo.mockReset();
  chooseVideo.mockReset();
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: { files: { loadVideo, chooseVideo } },
  });
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
    kind: 'video',
    title: 'Walkthrough',
    description: '',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#d0748b',
    ...overrides,
  } as WorkshopNodeData;
}

function renderFace(overrides: Partial<WorkshopNodeData> = {}) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue()}>
        <VideoNodeFace id="n1" data={nodeData(overrides)} />
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

const FILE = {
  projectId: 'p1',
  relativePath: 'docs/demo.mp4',
  kind: 'file',
  missing: false,
} as const;

describe('VideoNodeFace', () => {
  it('plays an available project video with nothing but the player below the strip', async () => {
    loadVideo.mockResolvedValue({
      status: 'available',
      projectId: 'p1',
      relativePath: 'docs/demo.mp4',
      playbackUrl: 'forgeboard-video://media/11111111-1111-4111-8111-111111111111',
      mimeType: 'video/mp4',
      sizeBytes: 10,
    });
    const { container } = renderFace({ file: FILE });
    await waitFor(() =>
      expect(container.querySelector('video')?.getAttribute('src')).toContain(
        'forgeboard-video://media/',
      ),
    );
    expect(screen.queryByText(/Drag this node onto an Agent/)).toBeNull();
  });

  it('still tries to load when a saved reference carries a stale missing flag', async () => {
    loadVideo.mockResolvedValue({
      status: 'available',
      projectId: 'p1',
      relativePath: 'docs/demo.mp4',
      playbackUrl: 'forgeboard-video://media/11111111-1111-4111-8111-111111111111',
      mimeType: 'video/mp4',
      sizeBytes: 10,
    });
    const { container } = renderFace({ file: { ...FILE, missing: true } });
    await waitFor(() => expect(loadVideo).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('video')).not.toBeNull());
  });

  it('shows the reconnect hint for missing videos', async () => {
    loadVideo.mockResolvedValue({
      status: 'missing',
      projectId: 'p1',
      relativePath: 'docs/demo.mp4',
      message: 'This video is missing or moved. Choose its new location to reconnect it.',
    });
    renderFace({ file: FILE });
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('missing or moved'),
    );
  });

  it('surfaces element playback failures as a terse message', async () => {
    loadVideo.mockResolvedValue({
      status: 'available',
      projectId: 'p1',
      relativePath: 'docs/demo.mp4',
      playbackUrl: 'forgeboard-video://media/11111111-1111-4111-8111-111111111111',
      mimeType: 'video/mp4',
      sizeBytes: 10,
    });
    const { container } = renderFace({ file: FILE });
    await waitFor(() => expect(container.querySelector('video')).not.toBeNull());
    fireEvent.error(container.querySelector('video')!);
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain("couldn't be played"),
    );
  });

  it('assigns a chosen video to the node', async () => {
    chooseVideo.mockResolvedValue(FILE);
    renderFace();
    fireEvent.click(screen.getByRole('button', { name: 'Choose' }));
    await waitFor(() => expect(recordHistory).toHaveBeenCalled());
    expect(updateNodeData).toHaveBeenCalledWith('n1', { file: FILE });
  });
});
