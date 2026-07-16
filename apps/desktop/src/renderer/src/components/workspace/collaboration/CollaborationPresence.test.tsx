// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CollaborationAwarenessEntry } from '../../../../../shared/collaboration/index.js';
import type { WorkshopNode } from '../canvas/CanvasNode.js';
import { CollaborationPresence } from './CollaborationPresence.js';

vi.mock('@xyflow/react', () => ({
  ViewportPortal: ({ children }: { readonly children: React.ReactNode }) => <>{children}</>,
}));

describe('CollaborationPresence', () => {
  it('renders remote cursors and selected-node identity in canvas coordinates', () => {
    const view = render(
      <CollaborationPresence awareness={[peer(7)]} nodes={[node('task-1', 30, 40)]} />,
    );
    const cursor = view.container.querySelector('.collaboration-cursor');
    const selection = view.container.querySelector('.collaboration-selection');
    expect(cursor?.textContent).toContain('Remote Editor');
    expect(cursor?.getAttribute('style')).toContain('translate(120px, 240px)');
    expect(selection?.textContent).toBe('RE');
    expect(selection?.getAttribute('style')).toContain('translate(30px, 40px)');
    expect(selection?.getAttribute('style')).toContain('width: 280px');
    expect(selection?.getAttribute('style')).toContain('height: 160px');
  });

  it('omits selections for nodes that do not exist locally', () => {
    const view = render(<CollaborationPresence awareness={[peer(7)]} nodes={[]} />);
    expect(view.container.querySelector('.collaboration-selection')).toBeNull();
    expect(view.container.querySelector('.collaboration-cursor')).not.toBeNull();
  });
});

function peer(clientId: number): CollaborationAwarenessEntry {
  return {
    clientId,
    state: {
      user: {
        id: 'remote-editor',
        displayName: 'Remote Editor',
        color: '#6d5efc',
        role: 'editor',
      },
      cursor: { x: 120, y: 240 },
      selection: { nodeIds: ['task-1'] },
      activity: { nodeId: 'task-1', status: 'editing' },
    },
  };
}

function node(id: string, x: number, y: number): WorkshopNode {
  return {
    id,
    type: 'workshop',
    position: { x, y },
    width: 280,
    height: 160,
    data: {
      kind: 'task',
      title: 'Task',
      description: '',
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#445566',
    },
  };
}
