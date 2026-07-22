// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkshopNode } from '../canvas/CanvasNode.js';
import { BuiltInContentInspector } from './BuiltInContentInspector.js';

afterEach(cleanup);

describe('BuiltInContentInspector', () => {
  it('authors a product brief, explicit attachments, criteria, variables, and versions', () => {
    const onRecord = vi.fn();
    const onUpdate = vi.fn<(data: Partial<WorkshopNode['data']>) => void>();
    const brief = node('brief', {
      markdown: '# Goal',
      checklist: [{ id: 'check-1', label: 'Local first', checked: false }],
      attachmentIds: [],
      acceptanceCriteria: [],
      variables: {},
      versions: [],
    });
    const file = node('file', {
      title: 'Architecture file',
      file: {
        projectId: 'project-1',
        relativePath: 'ARCHITECTURE.md',
        kind: 'file',
        missing: false,
      },
    });
    render(
      <BuiltInContentInspector
        projectId="project-1"
        node={brief}
        nodes={[brief, file]}
        readOnly={false}
        onRecord={onRecord}
        onUpdate={onUpdate}
        onError={vi.fn()}
      />,
    );

    expect(screen.getByRole('textbox', { name: 'Requirements Markdown source' })).toHaveProperty(
      'value',
      '# Goal',
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Requirements Markdown source' }), {
      target: { value: '# Updated goal' },
    });
    expect(onUpdate).toHaveBeenLastCalledWith({ markdown: '# Updated goal' });

    fireEvent.click(screen.getByRole('button', { name: 'Add checklist item' }));
    expect(onUpdate.mock.calls.at(-1)?.[0].checklist).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Add a done condition' }));
    expect(onUpdate.mock.calls.at(-1)?.[0].acceptanceCriteria).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Add prompt variable' }));
    expect(onUpdate).toHaveBeenLastCalledWith({ variables: { variable_1: '' } });

    fireEvent.click(screen.getByLabelText('Attach Architecture file'));
    expect(onUpdate).toHaveBeenLastCalledWith({ attachmentIds: [file.id] });
    fireEvent.click(screen.getByRole('button', { name: 'Save brief version' }));
    const version = onUpdate.mock.calls.at(-1)?.[0].versions?.[0];
    expect(version).toMatchObject({ markdown: '# Goal', authorId: 'local-user' });
    expect(Date.parse(version?.createdAt ?? '')).not.toBeNaN();
    expect(onRecord).toHaveBeenCalled();
  });

  it('configures local note image references and accessible alternative text', () => {
    const onUpdate = vi.fn<(data: Partial<WorkshopNode['data']>) => void>();
    const note = node('note-image', { markdown: 'A **local** note', images: [], altText: {} });
    const image = node('file', {
      title: 'Wireframe',
      file: {
        projectId: 'project-1',
        relativePath: 'design/wireframe.png',
        kind: 'image',
        missing: false,
      },
    });
    const { rerender } = render(
      <BuiltInContentInspector
        projectId="project-1"
        node={note}
        nodes={[note, image]}
        readOnly={false}
        onRecord={vi.fn()}
        onUpdate={onUpdate}
        onError={vi.fn()}
      />,
    );

    expect(screen.getByRole('textbox', { name: 'Note Markdown source' })).toHaveProperty(
      'value',
      'A **local** note',
    );
    fireEvent.click(screen.getByLabelText('Include image Wireframe'));
    expect(onUpdate.mock.calls.at(-1)?.[0].images).toEqual([image.data.file]);

    const selected = node('note-image', {
      markdown: note.data.markdown ?? '',
      images: [image.data.file as NonNullable<typeof image.data.file>],
      altText: {},
    });
    rerender(
      <BuiltInContentInspector
        projectId="project-1"
        node={selected}
        nodes={[selected, image]}
        readOnly={false}
        onRecord={vi.fn()}
        onUpdate={onUpdate}
        onError={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Alt text for image 1' }), {
      target: { value: 'Login flow wireframe' },
    });
    expect(onUpdate).toHaveBeenLastCalledWith({
      altText: { 'design/wireframe.png': 'Login flow wireframe' },
    });
  });

  it('keeps Markdown source read-only when a content node is locked', () => {
    render(
      <BuiltInContentInspector
        projectId="project-1"
        node={node('brief', { locked: true, markdown: 'Locked' })}
        nodes={[]}
        readOnly={true}
        onRecord={vi.fn()}
        onUpdate={vi.fn()}
        onError={vi.fn()}
      />,
    );
    expect(
      screen
        .getByRole('textbox', { name: 'Requirements Markdown source' })
        .getAttribute('readonly'),
    ).not.toBeNull();
  });

  it('restores an earlier saved brief version through the undo-aware update boundary', () => {
    const onRecord = vi.fn();
    const onUpdate = vi.fn<(data: Partial<WorkshopNode['data']>) => void>();
    render(
      <BuiltInContentInspector
        projectId="project-1"
        node={node('brief', {
          markdown: '# Current',
          versions: [
            {
              id: 'version-1',
              createdAt: '2026-07-15T12:00:00.000Z',
              markdown: '# Earlier',
              authorId: 'local-user',
            },
          ],
        })}
        nodes={[]}
        readOnly={false}
        onRecord={onRecord}
        onUpdate={onUpdate}
        onError={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Restore brief version from/u }));
    expect(onRecord).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith({ markdown: '# Earlier' });
  });
});

function node(
  kind: WorkshopNode['data']['kind'],
  data: Partial<WorkshopNode['data']>,
): WorkshopNode {
  return {
    id: data.title?.toLowerCase().replaceAll(' ', '-') ?? `${kind}-1`,
    type: 'workshop',
    position: { x: 0, y: 0 },
    data: {
      kind,
      title: data.title ?? kind,
      description: '',
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#82909b',
      ...data,
    },
  };
}
