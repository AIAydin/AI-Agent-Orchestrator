// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkshopNode } from '../../canvas/CanvasNode.js';
import { NoteImageInspector } from './NoteImageInspector.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('NoteImageInspector', () => {
  it('recovers a moved image through the native chooser and preserves its alt text', async () => {
    const loadImage = vi.fn().mockResolvedValue({
      status: 'missing',
      projectId: 'project-1',
      relativePath: 'old.png',
      message: 'This image is missing or moved. Choose its new location to reconnect it.',
    });
    const chooseImage = vi.fn().mockResolvedValue({
      projectId: 'project-1',
      relativePath: 'design/new.png',
      kind: 'image',
      missing: false,
      lastKnownHash: 'a'.repeat(64),
    });
    vi.stubGlobal('forgeboard', { files: { loadImage, chooseImage } });
    const onRecord = vi.fn();
    const onUpdate = vi.fn();
    render(
      <NoteImageInspector
        projectId="project-1"
        node={note({
          images: [image('old.png')],
          altText: { 'old.png': 'Checkout wireframe' },
        })}
        nodes={[]}
        readOnly={false}
        onRecord={onRecord}
        onUpdate={onUpdate}
        onError={vi.fn()}
      />,
    );

    await screen.findByText('Image missing or moved');
    onRecord.mockClear();
    onUpdate.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Find image' }));

    await waitFor(() => expect(chooseImage).toHaveBeenCalledWith({ projectId: 'project-1' }));
    expect(onRecord).toHaveBeenCalledOnce();
    expect(onUpdate).toHaveBeenLastCalledWith({
      images: [
        {
          projectId: 'project-1',
          relativePath: 'design/new.png',
          kind: 'image',
          missing: false,
          lastKnownHash: 'a'.repeat(64),
        },
      ],
      altText: { 'design/new.png': 'Checkout wireframe' },
    });
  });

  it('renders only the validated inline preview and explains explicit context behavior', async () => {
    vi.stubGlobal('forgeboard', {
      files: {
        chooseImage: vi.fn(),
        loadImage: vi.fn().mockResolvedValue({
          status: 'available',
          projectId: 'project-1',
          relativePath: 'safe.png',
          dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAAA',
        }),
      },
    });
    render(
      <NoteImageInspector
        projectId="project-1"
        node={note({ images: [image('safe.png')], altText: { 'safe.png': 'Safe preview' } })}
        nodes={[]}
        readOnly={false}
        onRecord={vi.fn()}
        onUpdate={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const preview = await screen.findByRole('img', { name: 'Safe preview' });
    expect(preview.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgoAAAAA');
    expect(screen.getByText(/never sends image paths or bytes/u)).toBeTruthy();
  });

  it('enforces locked and collaboration read-only state on every image mutation', async () => {
    const chooseImage = vi.fn();
    vi.stubGlobal('forgeboard', {
      files: {
        chooseImage,
        loadImage: vi.fn().mockResolvedValue({
          status: 'missing',
          projectId: 'project-1',
          relativePath: 'old.png',
          message: 'Moved',
        }),
      },
    });
    const onUpdate = vi.fn();
    render(
      <NoteImageInspector
        projectId="project-1"
        node={note({ images: [image('old.png', true)] })}
        nodes={[]}
        readOnly
        onRecord={vi.fn()}
        onUpdate={onUpdate}
        onError={vi.fn()}
      />,
    );

    await screen.findByText('Image missing or moved');
    expect(screen.getByRole('button', { name: 'Choose image' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(screen.getByRole('button', { name: 'Find image' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Relink' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Clear' }).hasAttribute('disabled')).toBe(true);
    expect(chooseImage).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
  });
});

function note(data: Partial<WorkshopNode['data']>): WorkshopNode {
  return {
    id: 'note-1',
    type: 'workshop',
    position: { x: 0, y: 0 },
    data: {
      kind: 'note-image',
      title: 'Note',
      description: '',
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#aaa',
      markdown: '',
      images: [],
      altText: {},
      ...data,
    },
  };
}

function image(relativePath: string, missing = false) {
  return { projectId: 'project-1', relativePath, kind: 'image' as const, missing };
}
