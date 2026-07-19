// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkshopNode } from '../../canvas/CanvasNode.js';

const renderDiagram = vi.hoisted(() => vi.fn());
vi.mock('./mermaid-renderer.js', () => ({
  renderMermaidDiagram: renderDiagram,
}));

import { MermaidDiagramInspector } from './MermaidDiagramInspector.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  renderDiagram.mockReset();
});

describe('MermaidDiagramInspector', () => {
  it('keeps source and sanitized preview synchronized and exports through the preload bridge', async () => {
    const source = 'flowchart LR\nA-->B';
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Rendered</text></svg>';
    renderDiagram.mockResolvedValue(svg);
    const exportSvg = vi.fn().mockResolvedValue({
      ok: true,
      value: { fileName: 'System-map.svg' },
    });
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: { diagram: { exportSvg } },
    });
    const onRecord = vi.fn();
    const onUpdate = vi.fn();
    render(
      <MermaidDiagramInspector
        node={diagramNode(source)}
        readOnly={false}
        onRecord={onRecord}
        onUpdate={onUpdate}
      />,
    );

    fireEvent.change(screen.getByRole('textbox', { name: 'Mermaid source' }), {
      target: { value: 'sequenceDiagram\nA->>B: Review' },
    });
    expect(onUpdate).toHaveBeenCalledWith({
      mermaidSource: 'sequenceDiagram\nA->>B: Review',
    });

    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'System/map diagram' })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Export SVG' }));
    await waitFor(() =>
      expect(exportSvg).toHaveBeenCalledWith({
        fileName: 'System-map.svg',
        svg,
      }),
    );
    expect(await screen.findByText('Exported System-map.svg.')).toBeTruthy();
  });

  it('shows parse errors without retaining a stale preview and respects read-only authority', async () => {
    renderDiagram.mockRejectedValue(new Error('Parse error on line 2'));
    render(
      <MermaidDiagramInspector
        node={diagramNode('not a diagram')}
        readOnly
        onRecord={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('textbox', { name: 'Mermaid source' }).getAttribute('readonly'),
    ).not.toBeNull();
    expect((await screen.findByRole('alert')).textContent).toContain('Parse error on line 2');
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Export SVG' }).disabled).toBe(
      true,
    );
  });

  it('invalidates the prior preview and export as soon as the persisted source changes', async () => {
    const priorSvg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Prior</text></svg>';
    renderDiagram.mockResolvedValueOnce(priorSvg).mockReturnValueOnce(new Promise(() => {}));
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: { diagram: { exportSvg: vi.fn() } },
    });
    const view = render(
      <MermaidDiagramInspector
        node={diagramNode('flowchart LR\nA-->B')}
        readOnly={false}
        onRecord={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByRole('img')).toBeTruthy());
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Export SVG' }).disabled).toBe(
      false,
    );

    view.rerender(
      <MermaidDiagramInspector
        node={diagramNode('flowchart LR\nA-->C')}
        readOnly={false}
        onRecord={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );

    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Export SVG' }).disabled).toBe(
      true,
    );
  });
});

function diagramNode(mermaidSource: string): WorkshopNode {
  return {
    id: 'diagram-1',
    type: 'workshop',
    position: { x: 0, y: 0 },
    data: {
      kind: 'diagram',
      title: 'System/map',
      description: '',
      color: '#6558c7',
      status: 'idle',
      locked: false,
      collapsed: false,
      mermaidSource,
    },
  };
}
