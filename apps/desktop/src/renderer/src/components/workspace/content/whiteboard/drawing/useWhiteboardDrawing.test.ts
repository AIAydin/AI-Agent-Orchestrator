// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  arrowEndpoints,
  createWhiteboardElement,
  parseWhiteboardDocument,
  type WhiteboardDocument,
  type WhiteboardElement,
} from '../model.js';
import { useWhiteboardDrawing } from './useWhiteboardDrawing.js';

afterEach(cleanup);

function documentOf(...elements: WhiteboardElement[]): WhiteboardDocument {
  return { ...parseWhiteboardDocument({}), elements };
}

function setup(
  document: WhiteboardDocument = documentOf(),
  options: { readOnly?: boolean; annotationIds?: string[] } = {},
) {
  const onPersist = vi.fn();
  const onRecordHistory = vi.fn();
  const view = renderHook(() =>
    useWhiteboardDrawing({
      document,
      annotationIds: options.annotationIds ?? [],
      readOnly: options.readOnly ?? false,
      onRecordHistory,
      onPersist,
    }),
  );
  return { ...view, onPersist, onRecordHistory };
}

function persistedDocument(onPersist: ReturnType<typeof vi.fn>): WhiteboardDocument {
  return onPersist.mock.calls[0]?.[0] as WhiteboardDocument;
}

function activeElements(document: WhiteboardDocument): WhiteboardElement[] {
  return document.elements.filter((element) => !element.isDeleted);
}

const RECTANGLE = createWhiteboardElement('rectangle', { x: 0, y: 0, width: 100, height: 100 });

describe('creating shapes by dragging', () => {
  it('commits a rectangle at the dragged bounds', () => {
    const { result, onPersist, onRecordHistory } = setup();
    act(() => {
      result.current.setTool('rectangle');
    });
    act(() => {
      result.current.beginGesture([100, 100]);
    });
    act(() => {
      result.current.extendGesture([300, 250]);
    });
    act(() => {
      result.current.endGesture();
    });

    expect(onRecordHistory).toHaveBeenCalledTimes(1);
    expect(onPersist).toHaveBeenCalledTimes(1);
    expect(activeElements(persistedDocument(onPersist))[0]).toMatchObject({
      type: 'rectangle',
      x: 100,
      y: 100,
      width: 200,
      height: 150,
    });
  });

  it('commits an arrow pointing the way it was dragged', () => {
    const { result, onPersist } = setup();
    act(() => {
      result.current.setTool('arrow');
    });
    act(() => {
      result.current.beginGesture([200, 200]);
    });
    act(() => {
      result.current.extendGesture([50, 40]);
    });
    act(() => {
      result.current.endGesture();
    });

    const arrow = activeElements(persistedDocument(onPersist))[0];
    expect(arrow).toBeDefined();
    if (arrow === undefined) return;
    expect(arrowEndpoints(arrow)).toEqual({ start: [200, 200], end: [50, 40] });
  });

  it('leaves a draft visible while dragging without persisting', () => {
    const { result, onPersist } = setup();
    act(() => {
      result.current.setTool('ellipse');
    });
    act(() => {
      result.current.beginGesture([10, 10]);
    });
    act(() => {
      result.current.extendGesture([60, 80]);
    });

    expect(result.current.draftElement).toMatchObject({
      type: 'ellipse',
      x: 10,
      y: 10,
      width: 50,
      height: 70,
    });
    expect(onPersist).not.toHaveBeenCalled();
  });
});

describe('freehand strokes', () => {
  it('commits a stroke built from the sampled points', () => {
    const { result, onPersist } = setup();
    act(() => {
      result.current.setTool('freedraw');
    });
    act(() => {
      result.current.beginGesture([10, 10]);
    });
    act(() => {
      result.current.extendGesture([40, 10]);
    });
    act(() => {
      result.current.extendGesture([40, 60]);
    });
    act(() => {
      result.current.endGesture();
    });

    const stroke = activeElements(persistedDocument(onPersist))[0];
    expect(stroke).toMatchObject({ type: 'freedraw', x: 10, y: 10 });
    expect(stroke?.points).toHaveLength(3);
  });

  it('persists nothing for a stroke that never moved', () => {
    const { result, onPersist, onRecordHistory } = setup();
    act(() => {
      result.current.setTool('freedraw');
    });
    act(() => {
      result.current.beginGesture([10, 10]);
    });
    act(() => {
      result.current.endGesture();
    });

    expect(onPersist).not.toHaveBeenCalled();
    expect(onRecordHistory).not.toHaveBeenCalled();
  });
});

describe('moving and resizing', () => {
  it('moves the element under the pointer by the drag delta', () => {
    const { result, onPersist } = setup(documentOf(RECTANGLE));
    act(() => {
      result.current.beginGesture([50, 50]);
    });
    act(() => {
      result.current.extendGesture([70, 90]);
    });
    act(() => {
      result.current.endGesture();
    });

    expect(persistedDocument(onPersist).elements[0]).toMatchObject({ x: 20, y: 40 });
  });

  it('selects without persisting when the drag does not move', () => {
    const { result, onPersist } = setup(documentOf(RECTANGLE));
    act(() => {
      result.current.beginGesture([50, 50]);
    });
    act(() => {
      result.current.endGesture();
    });

    expect(result.current.selectedId).toBe(RECTANGLE.id);
    expect(onPersist).not.toHaveBeenCalled();
  });

  it('clears the selection when clicking empty canvas', () => {
    const { result } = setup(documentOf(RECTANGLE));
    act(() => {
      result.current.select(RECTANGLE.id);
    });
    act(() => {
      result.current.beginGesture([500, 500]);
    });

    expect(result.current.selectedId).toBeNull();
  });

  it('resizes from a corner handle, anchoring the opposite corner', () => {
    const { result, onPersist } = setup(documentOf(RECTANGLE));
    act(() => {
      result.current.select(RECTANGLE.id);
    });
    act(() => {
      result.current.beginGesture([100, 100], 'se');
    });
    act(() => {
      result.current.extendGesture([200, 150]);
    });
    act(() => {
      result.current.endGesture();
    });

    expect(persistedDocument(onPersist).elements[0]).toMatchObject({
      x: 0,
      y: 0,
      width: 200,
      height: 150,
    });
  });
});

describe('cancelling and locking', () => {
  it('cancelGesture persists nothing and records no history', () => {
    const { result, onPersist, onRecordHistory } = setup();
    act(() => {
      result.current.setTool('rectangle');
    });
    act(() => {
      result.current.beginGesture([10, 10]);
    });
    act(() => {
      result.current.extendGesture([100, 100]);
    });
    act(() => {
      result.current.cancelGesture();
    });

    expect(result.current.draftElement).toBeNull();
    expect(onPersist).not.toHaveBeenCalled();
    expect(onRecordHistory).not.toHaveBeenCalled();
  });

  it('ignores every gesture on a read-only whiteboard', () => {
    const { result, onPersist } = setup(documentOf(RECTANGLE), { readOnly: true });
    act(() => {
      result.current.setTool('rectangle');
    });
    act(() => {
      result.current.beginGesture([10, 10]);
    });
    act(() => {
      result.current.extendGesture([100, 100]);
    });
    act(() => {
      result.current.endGesture();
    });

    expect(result.current.draftElement).toBeNull();
    expect(onPersist).not.toHaveBeenCalled();
  });

  it('refuses to delete on a read-only whiteboard', () => {
    const { result, onPersist } = setup(documentOf(RECTANGLE), { readOnly: true });
    act(() => {
      result.current.select(RECTANGLE.id);
    });
    act(() => {
      result.current.deleteSelected();
    });

    expect(onPersist).not.toHaveBeenCalled();
  });
});

describe('inline text', () => {
  it('creates a text element at the clicked point and tracks it as an annotation', () => {
    const { result, onPersist } = setup(documentOf(), { annotationIds: ['existing'] });
    act(() => {
      result.current.setTool('text');
    });
    act(() => {
      result.current.beginGesture([40, 60]);
    });

    expect(result.current.textDraft).toMatchObject({ id: null, point: [40, 60], value: '' });

    act(() => {
      result.current.changeText('Login screen');
    });
    act(() => {
      result.current.commitText();
    });

    const created = activeElements(persistedDocument(onPersist))[0];
    expect(created).toMatchObject({ type: 'text', text: 'Login screen', x: 40, y: 60 });
    expect(onPersist.mock.calls[0]?.[1]).toEqual(['existing', created?.id]);
    expect(result.current.textDraft).toBeNull();
  });

  it('persists nothing for blank text', () => {
    const { result, onPersist } = setup();
    act(() => {
      result.current.setTool('text');
    });
    act(() => {
      result.current.beginGesture([40, 60]);
    });
    act(() => {
      result.current.changeText('   ');
    });
    act(() => {
      result.current.commitText();
    });

    expect(onPersist).not.toHaveBeenCalled();
    expect(result.current.textDraft).toBeNull();
  });

  it('discards a draft on cancel', () => {
    const { result, onPersist } = setup();
    act(() => {
      result.current.setTool('text');
    });
    act(() => {
      result.current.beginGesture([40, 60]);
    });
    act(() => {
      result.current.changeText('Discard me');
    });
    act(() => {
      result.current.cancelText();
    });

    expect(onPersist).not.toHaveBeenCalled();
    expect(result.current.textDraft).toBeNull();
  });

  it('edits existing text without re-registering the annotation', () => {
    const text = createWhiteboardElement('text', { x: 5, y: 5, width: 180, height: 42 }, 'Old');
    const { result, onPersist } = setup(documentOf(text), { annotationIds: [text.id] });
    act(() => {
      result.current.editText(text.id);
    });

    expect(result.current.textDraft).toMatchObject({ id: text.id, value: 'Old' });

    act(() => {
      result.current.changeText('New');
    });
    act(() => {
      result.current.commitText();
    });

    expect(persistedDocument(onPersist).elements[0]).toMatchObject({
      text: 'New',
      originalText: 'New',
    });
    expect(onPersist.mock.calls[0]?.[1]).toBeUndefined();
  });
});

describe('deleting', () => {
  it('marks the selection deleted and drops its annotation id', () => {
    const text = createWhiteboardElement('text', { x: 0, y: 0, width: 180, height: 42 }, 'Note');
    const { result, onPersist, onRecordHistory } = setup(documentOf(text), {
      annotationIds: [text.id, 'other'],
    });
    act(() => {
      result.current.select(text.id);
    });
    act(() => {
      result.current.deleteSelected();
    });

    expect(persistedDocument(onPersist).elements[0]).toMatchObject({ isDeleted: true });
    expect(onPersist.mock.calls[0]?.[1]).toEqual(['other']);
    expect(onRecordHistory).toHaveBeenCalledTimes(1);
    expect(result.current.selectedId).toBeNull();
  });
});
