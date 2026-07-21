// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../../file-editor/tabs/FileEditorWorkspace.js', () => ({
  FileEditorWorkspace: ({ readOnly }: { readOnly: boolean }) => (
    <div data-testid="file-editor" data-readonly={String(readOnly)} />
  ),
}));
vi.mock('../../../file-editor/browser/ProjectFileBrowser.js', () => ({
  ProjectFileBrowser: ({
    onSelect,
  }: {
    onSelect: (selection: {
      projectId: string;
      relativePath: string;
      document: { sha256: string | null };
    }) => void;
  }) => (
    <button
      type="button"
      data-testid="file-browser"
      onClick={() =>
        onSelect({ projectId: 'p1', relativePath: 'src/app.ts', document: { sha256: 'abc' } })
      }
    >
      pick
    </button>
  ),
}));

import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../../runs/agent-session/AgentSessionContext.js';
import { FileNodeFace } from './FileNodeFace.js';

const updateNodeData = vi.fn();
const recordHistory = vi.fn();

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'forgeboard');
});
beforeEach(() => {
  updateNodeData.mockClear();
  recordHistory.mockClear();
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: { files: {} },
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
    kind: 'file',
    title: 'File',
    description: '',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#6d9ed0',
    ...overrides,
  } as WorkshopNodeData;
}

function renderFace(overrides: Partial<WorkshopNodeData> = {}) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue()}>
        <FileNodeFace id="n1" data={nodeData(overrides)} />
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

const fileReference = {
  projectId: 'p1',
  relativePath: 'src/app.ts',
  kind: 'file' as const,
  missing: false,
};

describe('FileNodeFace', () => {
  it('shows the file browser and mounts no editor without an assignment', () => {
    renderFace();
    expect(screen.getByTestId('file-browser')).toBeTruthy();
    expect(screen.queryByTestId('file-editor')).toBeNull();
  });

  it('persists the chosen file assignment', () => {
    renderFace();
    fireEvent.click(screen.getByTestId('file-browser'));
    expect(recordHistory).toHaveBeenCalled();
    expect(updateNodeData).toHaveBeenCalledWith('n1', {
      file: {
        projectId: 'p1',
        relativePath: 'src/app.ts',
        kind: 'file',
        missing: false,
        lastKnownHash: 'abc',
      },
    });
  });

  it('mounts the editor when a file is assigned (ResizeObserver absent → eager)', () => {
    renderFace({ file: fileReference });
    expect(screen.getByTestId('file-editor')).toBeTruthy();
    expect(screen.getByTestId('file-editor').getAttribute('data-readonly')).toBe('false');
  });

  it('opens read-only for locked nodes', () => {
    renderFace({ file: fileReference, locked: true });
    expect(screen.getByTestId('file-editor').getAttribute('data-readonly')).toBe('true');
  });
});
