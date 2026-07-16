// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkshopNode } from '../../canvas/CanvasNode.js';
import { FileContextTargetPicker } from './FileContextTargetPicker.js';

const PROJECT_ID = '70000000-0000-4000-8000-000000000001';

afterEach(cleanup);

describe('FileContextTargetPicker', () => {
  it('attaches the exact configured File node to the keyboard-selected Agent', async () => {
    const onAttach = vi.fn().mockResolvedValue(undefined);
    render(
      <FileContextTargetPicker
        projectId={PROJECT_ID}
        source={fileNode()}
        nodes={[fileNode(), agentNode('agent-1', 'First'), agentNode('agent-2', 'Second')]}
        readOnly={false}
        onAttach={onAttach}
      />,
    );

    fireEvent.change(screen.getByLabelText('Target Agent'), { target: { value: 'agent-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Attach saved disk file' }));

    await waitFor(() =>
      expect(onAttach).toHaveBeenCalledWith('agent-2', {
        schemaVersion: 1,
        kind: 'project-file',
        projectId: PROJECT_ID,
        relativePath: 'src/context.ts',
        sourceNodeId: 'file-1',
      }),
    );
    expect(await screen.findByText(/Attached the saved file/iu)).toBeTruthy();
  });

  it('disables attachment for read-only roles and unavailable File nodes', () => {
    const { rerender } = render(
      <FileContextTargetPicker
        projectId={PROJECT_ID}
        source={fileNode()}
        nodes={[fileNode(), agentNode('agent-1', 'Agent')]}
        readOnly
        onAttach={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Attach saved disk file' }).hasAttribute('disabled'),
    ).toBe(true);

    rerender(
      <FileContextTargetPicker
        projectId={PROJECT_ID}
        source={fileNode({ missing: true })}
        nodes={[fileNode(), agentNode('agent-1', 'Agent')]}
        readOnly={false}
        onAttach={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Attach saved disk file' }).hasAttribute('disabled'),
    ).toBe(true);
  });
});

function fileNode(
  overrides: Partial<NonNullable<WorkshopNode['data']['file']>> = {},
): WorkshopNode {
  return {
    id: 'file-1',
    type: 'workshop',
    position: { x: 0, y: 0 },
    data: {
      kind: 'file',
      title: 'Context file',
      description: 'File',
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#667788',
      file: {
        projectId: PROJECT_ID,
        relativePath: 'src/context.ts',
        kind: 'file',
        missing: false,
        ...overrides,
      },
    },
  };
}

function agentNode(id: string, title: string): WorkshopNode {
  return {
    id,
    type: 'workshop',
    position: { x: 300, y: 0 },
    data: {
      kind: 'agent',
      title,
      description: 'Agent',
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#445566',
    },
  };
}
