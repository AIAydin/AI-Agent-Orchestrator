// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkshopNode } from '../../canvas/CanvasNode.js';
import { parseWhiteboardDocument } from './model.js';
import { WhiteboardMockupInspector } from './WhiteboardMockupInspector.js';

const exportSvg = vi.fn();

beforeEach(() => {
  exportSvg.mockResolvedValue({
    ok: true,
    value: { fileName: 'Checkout.svg' },
  });
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: { whiteboard: { exportSvg } },
  });
});

afterEach(() => {
  cleanup();
  exportSvg.mockReset();
  Reflect.deleteProperty(window, 'forgeboard');
});

describe('WhiteboardMockupInspector', () => {
  it('creates persisted Excalidraw-compatible shapes and annotations', () => {
    const onRecord = vi.fn();
    const onUpdate = vi.fn();
    renderInspector({ onRecord, onUpdate });

    fireEvent.click(screen.getByRole('button', { name: 'Add rectangle' }));
    expect(onRecord).toHaveBeenCalledTimes(1);
    const shapePatch = onUpdate.mock.calls[0]?.[0] as Partial<WorkshopNode['data']>;
    const shapeDocument = parseWhiteboardDocument(shapePatch.excalidraw);
    expect(shapeDocument).toMatchObject({
      type: 'excalidraw',
      version: 2,
      source: 'https://forgeboard.local',
    });
    expect(shapeDocument.elements).toMatchObject([{ type: 'rectangle', strokeWidth: 2 }]);

    fireEvent.change(screen.getByRole('textbox', { name: 'Annotation' }), {
      target: { value: 'Primary checkout screen' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add annotation' }));
    const annotationPatch = onUpdate.mock.calls.at(-1)?.[0] as Partial<WorkshopNode['data']>;
    expect(annotationPatch.annotationIds).toHaveLength(1);
    expect(typeof annotationPatch.annotationIds?.[0]).toBe('string');
    expect(parseWhiteboardDocument(annotationPatch.excalidraw).elements).toMatchObject([
      { type: 'text', text: 'Primary checkout screen' },
    ]);
  });

  it('exports an inert image through the native bridge and attaches exact context', async () => {
    const onAttachContext = vi.fn().mockReturnValue('Attached exact specification.');
    renderInspector({ node: whiteboardNode(true), onAttachContext });

    fireEvent.click(screen.getByRole('button', { name: 'Export SVG image' }));
    await waitFor(() => expect(exportSvg).toHaveBeenCalledTimes(1));
    const input = exportSvg.mock.calls[0]?.[0] as {
      fileName: string;
      svg: string;
    };
    expect(input.fileName).toBe('Checkout.svg');
    expect(input.svg).toContain('<rect');
    expect(input.svg).not.toContain('<script');
    expect(await screen.findByText('Exported Checkout.svg.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Attach specification' }));
    expect(onAttachContext).toHaveBeenCalledWith('whiteboard-1', 'agent-1');
    expect(screen.getByText('Attached exact specification.')).toBeTruthy();
  });

  it('enforces node and collaboration read-only authority without disabling safe export', () => {
    const onUpdate = vi.fn();
    const onAttachContext = vi.fn();
    renderInspector({
      node: whiteboardNode(true),
      readOnly: true,
      onUpdate,
      onAttachContext,
    });

    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add rectangle' }).disabled).toBe(
      true,
    );
    const addRectangleStatus = screen.getByRole('group', {
      name: 'Add rectangle unavailable',
    });
    const addRectangleTooltip = screen.getByRole('tooltip', {
      name: 'Add rectangle unavailable while editing is locked',
    });
    expect(addRectangleStatus.getAttribute('aria-describedby')).toBe(addRectangleTooltip.id);
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Attach specification',
      }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Export SVG image',
      }).disabled,
    ).toBe(false);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(onAttachContext).not.toHaveBeenCalled();
  });
});

function renderInspector(
  override: {
    readonly node?: WorkshopNode;
    readonly readOnly?: boolean;
    readonly onRecord?: ReturnType<typeof vi.fn>;
    readonly onUpdate?: ReturnType<typeof vi.fn>;
    readonly onAttachContext?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return render(
    <WhiteboardMockupInspector
      node={override.node ?? whiteboardNode(false)}
      nodes={[override.node ?? whiteboardNode(false), agentNode()]}
      readOnly={override.readOnly ?? false}
      onRecord={override.onRecord ?? vi.fn()}
      onUpdate={override.onUpdate ?? vi.fn()}
      onAttachContext={
        override.onAttachContext ?? vi.fn().mockReturnValue('Attached exact specification.')
      }
    />,
  );
}

function whiteboardNode(withElement: boolean): WorkshopNode {
  return {
    id: 'whiteboard-1',
    type: 'workshop',
    position: { x: 0, y: 0 },
    data: {
      kind: 'whiteboard',
      title: 'Checkout',
      description: 'Checkout mockup',
      color: '#c482aa',
      status: 'idle',
      locked: false,
      collapsed: false,
      excalidraw: {
        type: 'excalidraw',
        version: 2,
        source: 'https://forgeboard.local',
        elements: withElement
          ? [
              {
                id: 'shape-1',
                type: 'rectangle',
                x: 20,
                y: 20,
                width: 160,
                height: 90,
                strokeColor: '#334155',
                backgroundColor: '#e2e8f0',
              },
            ]
          : [],
        appState: { viewBackgroundColor: '#ffffff' },
        files: {},
      },
    },
  };
}

function agentNode(): WorkshopNode {
  return {
    id: 'agent-1',
    type: 'workshop',
    position: { x: 300, y: 0 },
    data: {
      kind: 'agent',
      title: 'Agent',
      description: '',
      color: '#d4a85b',
      status: 'idle',
      locked: false,
      collapsed: false,
    },
  };
}
