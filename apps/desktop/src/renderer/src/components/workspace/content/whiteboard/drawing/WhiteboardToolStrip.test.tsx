// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WhiteboardToolStrip } from './WhiteboardToolStrip.js';

afterEach(cleanup);

const TOOL_LABELS = [
  'Select',
  'Draw rectangle',
  'Draw ellipse',
  'Draw diamond',
  'Draw arrow',
  'Add text',
  'Draw freehand',
];

describe('WhiteboardToolStrip', () => {
  it('offers every tool', () => {
    render(<WhiteboardToolStrip tool="select" readOnly={false} onSelectTool={() => undefined} />);
    for (const label of TOOL_LABELS) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
  });

  it('marks only the active tool as pressed', () => {
    render(<WhiteboardToolStrip tool="freedraw" readOnly={false} onSelectTool={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Draw freehand' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Select' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('reports the chosen tool', () => {
    const onSelectTool = vi.fn();
    render(<WhiteboardToolStrip tool="select" readOnly={false} onSelectTool={onSelectTool} />);
    fireEvent.click(screen.getByRole('button', { name: 'Draw ellipse' }));
    expect(onSelectTool).toHaveBeenCalledWith('ellipse');
  });

  it('disables every tool when the whiteboard is read-only', () => {
    render(<WhiteboardToolStrip tool="select" readOnly onSelectTool={() => undefined} />);
    for (const label of TOOL_LABELS) {
      expect(screen.getByRole('button', { name: label })).toHaveProperty('disabled', true);
    }
  });
});
