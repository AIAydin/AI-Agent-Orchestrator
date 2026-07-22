import { useCallback, useMemo, useState } from 'react';

import {
  createArrowElement,
  createFreedrawElement,
  createWhiteboardElement,
  updateWhiteboardElement,
  type WhiteboardDocument,
  type WhiteboardElement,
  type WhiteboardPoint,
} from '../model.js';
import {
  appendStrokePoint,
  dragBounds,
  hitTest,
  resizeBounds,
  type WhiteboardHandle,
} from './geometry.js';

export type WhiteboardTool =
  | 'select'
  | 'rectangle'
  | 'ellipse'
  | 'diamond'
  | 'arrow'
  | 'text'
  | 'freedraw';

type ShapeTool = 'rectangle' | 'ellipse' | 'diamond';

/** An in-flight gesture. Drafts live in local state and never touch the graph until commit. */
export type WhiteboardDraft =
  | {
      readonly kind: 'shape';
      readonly tool: ShapeTool;
      readonly start: WhiteboardPoint;
      readonly current: WhiteboardPoint;
    }
  | { readonly kind: 'arrow'; readonly start: WhiteboardPoint; readonly current: WhiteboardPoint }
  | { readonly kind: 'stroke'; readonly points: readonly WhiteboardPoint[] }
  | {
      readonly kind: 'move';
      readonly id: string;
      readonly start: WhiteboardPoint;
      readonly current: WhiteboardPoint;
    }
  | {
      readonly kind: 'resize';
      readonly id: string;
      readonly handle: WhiteboardHandle;
      readonly current: WhiteboardPoint;
    };

export interface WhiteboardTextDraft {
  /** `null` while creating; the element id while editing an existing one. */
  readonly id: string | null;
  readonly point: WhiteboardPoint;
  readonly value: string;
}

export interface WhiteboardDrawing {
  readonly tool: WhiteboardTool;
  readonly selectedId: string | null;
  /** The document with any in-flight move or resize applied, for rendering. */
  readonly previewDocument: WhiteboardDocument;
  /** The in-progress element being created, for rendering above the committed ones. */
  readonly draftElement: WhiteboardElement | null;
  readonly textDraft: WhiteboardTextDraft | null;
  readonly setTool: (tool: WhiteboardTool) => void;
  readonly select: (id: string | null) => void;
  readonly beginGesture: (point: WhiteboardPoint, handle?: WhiteboardHandle) => void;
  readonly extendGesture: (point: WhiteboardPoint) => void;
  readonly endGesture: () => void;
  readonly cancelGesture: () => void;
  readonly editText: (id: string) => void;
  readonly changeText: (value: string) => void;
  readonly commitText: () => void;
  readonly cancelText: () => void;
  readonly deleteSelected: () => void;
}

export interface WhiteboardDrawingOptions {
  readonly document: WhiteboardDocument;
  readonly annotationIds: readonly string[];
  readonly readOnly: boolean;
  readonly onRecordHistory: () => void;
  /** `undefined` annotation ids means "leave them untouched". */
  readonly onPersist: (
    document: WhiteboardDocument,
    annotationIds: readonly string[] | undefined,
  ) => void;
}

const TEXT_WIDTH = 180;
const TEXT_HEIGHT = 42;

/**
 * Owns the whiteboard's pointer state machine.
 *
 * A gesture keeps its in-progress geometry in local state and writes to the graph exactly
 * once, at commit. That is what keeps a 500-point freehand stroke from triggering 500
 * whole-graph re-renders and 500 undo entries. History is recorded immediately before a
 * commit, so a cancelled gesture leaves no undo entry behind.
 */
export function useWhiteboardDrawing({
  document,
  annotationIds,
  readOnly,
  onRecordHistory,
  onPersist,
}: WhiteboardDrawingOptions): WhiteboardDrawing {
  const [tool, setTool] = useState<WhiteboardTool>('select');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<WhiteboardDraft | null>(null);
  const [textDraft, setTextDraft] = useState<WhiteboardTextDraft | null>(null);

  const elements = document.elements;
  const activeElements = useMemo(
    () => elements.filter((element) => !element.isDeleted),
    [elements],
  );

  const commit = useCallback(
    (next: WhiteboardDocument, nextAnnotationIds: readonly string[] | undefined) => {
      onRecordHistory();
      onPersist(next, nextAnnotationIds);
    },
    [onPersist, onRecordHistory],
  );

  const beginGesture = useCallback(
    (point: WhiteboardPoint, handle?: WhiteboardHandle) => {
      if (readOnly) return;
      if (handle !== undefined && selectedId !== null) {
        setDraft({ kind: 'resize', id: selectedId, handle, current: point });
        return;
      }
      if (tool === 'text') {
        setTextDraft({ id: null, point, value: '' });
        return;
      }
      if (tool === 'select') {
        const hit = hitTest(activeElements, point);
        setSelectedId(hit);
        setDraft(hit === null ? null : { kind: 'move', id: hit, start: point, current: point });
        return;
      }
      if (tool === 'freedraw') {
        setDraft({ kind: 'stroke', points: [point] });
        return;
      }
      if (tool === 'arrow') {
        setDraft({ kind: 'arrow', start: point, current: point });
        return;
      }
      setDraft({ kind: 'shape', tool, start: point, current: point });
    },
    [activeElements, readOnly, selectedId, tool],
  );

  const extendGesture = useCallback((point: WhiteboardPoint) => {
    setDraft((current) => {
      if (current === null) return null;
      if (current.kind === 'stroke') {
        return { ...current, points: appendStrokePoint(current.points, point) };
      }
      return { ...current, current: point };
    });
  }, []);

  const cancelGesture = useCallback(() => {
    setDraft(null);
  }, []);

  const endGesture = useCallback(() => {
    setDraft(null);
    if (draft === null || readOnly) return;
    const created = createdElement(draft);
    if (created !== null) {
      commit({ ...document, elements: [...elements, created] }, undefined);
      setSelectedId(created.id);
      return;
    }
    if (draft.kind === 'move') {
      const element = activeElements.find((candidate) => candidate.id === draft.id);
      const deltaX = draft.current[0] - draft.start[0];
      const deltaY = draft.current[1] - draft.start[1];
      if (element === undefined || (deltaX === 0 && deltaY === 0)) return;
      commit(
        updateWhiteboardElement(document, draft.id, {
          x: element.x + deltaX,
          y: element.y + deltaY,
        }),
        undefined,
      );
      return;
    }
    if (draft.kind === 'resize') {
      const element = activeElements.find((candidate) => candidate.id === draft.id);
      if (element === undefined) return;
      const bounds = resizeBounds(element, draft.handle, draft.current);
      if (
        bounds.x === element.x &&
        bounds.y === element.y &&
        bounds.width === element.width &&
        bounds.height === element.height
      ) {
        return;
      }
      commit(updateWhiteboardElement(document, draft.id, bounds), undefined);
    }
  }, [activeElements, commit, document, draft, elements, readOnly]);

  const editText = useCallback(
    (id: string) => {
      const element = activeElements.find((candidate) => candidate.id === id);
      if (element === undefined || element.type !== 'text') return;
      setSelectedId(id);
      setTextDraft({ id, point: [element.x, element.y], value: element.text ?? '' });
    },
    [activeElements],
  );

  const changeText = useCallback((value: string) => {
    setTextDraft((current) => (current === null ? null : { ...current, value }));
  }, []);

  const cancelText = useCallback(() => {
    setTextDraft(null);
  }, []);

  const commitText = useCallback(() => {
    setTextDraft(null);
    if (textDraft === null || readOnly) return;
    const value = textDraft.value.trim();
    if (value === '') return;
    if (textDraft.id === null) {
      const element = createWhiteboardElement(
        'text',
        { x: textDraft.point[0], y: textDraft.point[1], width: TEXT_WIDTH, height: TEXT_HEIGHT },
        value,
      );
      commit({ ...document, elements: [...elements, element] }, [...annotationIds, element.id]);
      setSelectedId(element.id);
      return;
    }
    commit(
      updateWhiteboardElement(document, textDraft.id, { text: value, originalText: value }),
      undefined,
    );
  }, [annotationIds, commit, document, elements, readOnly, textDraft]);

  const deleteSelected = useCallback(() => {
    if (readOnly || selectedId === null) return;
    if (!activeElements.some((element) => element.id === selectedId)) return;
    commit(
      {
        ...document,
        elements: elements.map((element) =>
          element.id === selectedId
            ? { ...element, isDeleted: true, version: element.version + 1, updated: Date.now() }
            : element,
        ),
      },
      annotationIds.filter((id) => id !== selectedId),
    );
    setSelectedId(null);
  }, [activeElements, annotationIds, commit, document, elements, readOnly, selectedId]);

  const previewDocument = useMemo(() => {
    if (draft === null) return document;
    if (draft.kind === 'move') {
      const element = elements.find((candidate) => candidate.id === draft.id);
      if (element === undefined) return document;
      return updateWhiteboardElement(document, draft.id, {
        x: element.x + (draft.current[0] - draft.start[0]),
        y: element.y + (draft.current[1] - draft.start[1]),
      });
    }
    if (draft.kind === 'resize') {
      const element = elements.find((candidate) => candidate.id === draft.id);
      if (element === undefined) return document;
      return updateWhiteboardElement(
        document,
        draft.id,
        resizeBounds(element, draft.handle, draft.current),
      );
    }
    return document;
  }, [document, draft, elements]);

  const draftElement = useMemo(() => (draft === null ? null : createdElement(draft)), [draft]);

  return {
    tool,
    selectedId,
    previewDocument,
    draftElement,
    textDraft,
    setTool,
    select: setSelectedId,
    beginGesture,
    extendGesture,
    endGesture,
    cancelGesture,
    editText,
    changeText,
    commitText,
    cancelText,
    deleteSelected,
  };
}

/** The element a create-style draft would produce, or `null` for move/resize drafts. */
function createdElement(draft: WhiteboardDraft): WhiteboardElement | null {
  if (draft.kind === 'shape') {
    return createWhiteboardElement(draft.tool, dragBounds(draft.start, draft.current));
  }
  if (draft.kind === 'arrow') return createArrowElement(draft.start, draft.current);
  if (draft.kind === 'stroke') return createFreedrawElement(draft.points);
  return null;
}
