import { describe, expect, it } from 'vitest';

import type { WorkshopNode } from '../CanvasNode.js';
import type { WorkshopEdge } from '../../model/types.js';
import { captureSelectedSubgraph, instantiateClipboardSelection } from './selection-clipboard.js';

describe('canvas selection clipboard', () => {
  it('captures selected nodes and only edges internal to that selection', () => {
    const first = node('first', true);
    const second = node('second', true);
    const outside = node('outside', false);
    const internal = edge('internal', 'first', 'second');
    const external = edge('external', 'second', 'outside');

    expect(captureSelectedSubgraph([first, second, outside], [internal, external])).toEqual({
      nodes: [first, second],
      edges: [internal],
    });
  });

  it('uses the inspector selection when React Flow has not marked a node selected', () => {
    const fallback = node('fallback', false);
    expect(captureSelectedSubgraph([fallback], [], 'fallback').nodes).toEqual([fallback]);
  });

  it('captures a selected frame with its valid members and their internal edges', () => {
    const frame = node('frame', true, {
      kind: 'group-frame',
      childNodeIds: ['child', 'missing'],
    });
    const child = node('child', false);
    const outside = node('outside', false);
    const internal = edge('internal', 'frame', 'child');
    const external = edge('external', 'child', 'outside');

    expect(captureSelectedSubgraph([frame, child, outside], [internal, external])).toEqual({
      nodes: [frame, child],
      edges: [internal],
    });
  });

  it('creates fresh unlocked nodes and remaps internal references and edges', () => {
    const first = node('first', true, {
      locked: true,
      status: 'succeeded',
      runId: 'run-1',
      runIds: ['run-1'],
      transcript: 'private output',
      changedFiles: ['src/a.ts'],
      childNodeIds: ['second', 'outside'],
      reviewerAgentId: 'second',
    });
    const second = node('second', true, { gateState: 'passed' });
    const internal = edge('internal', 'first', 'second');
    const ids = ['first-copy', 'second-copy', 'edge-copy'];

    const duplicate = instantiateClipboardSelection(
      { nodes: [first, second], edges: [internal] },
      { createId: () => ids.shift() as string, offset: 48 },
    );

    expect(
      duplicate.nodes.map(({ id, position, selected, width, height }) => ({
        id,
        position,
        selected,
        width,
        height,
      })),
    ).toEqual([
      {
        id: 'first-copy',
        position: { x: 58, y: 68 },
        selected: true,
        width: 320,
        height: 180,
      },
      {
        id: 'second-copy',
        position: { x: 58, y: 68 },
        selected: true,
        width: 320,
        height: 180,
      },
    ]);
    expect(duplicate.nodes[0]?.data).toMatchObject({
      title: 'first copy',
      locked: false,
      status: 'idle',
      childNodeIds: ['second-copy', 'outside'],
      reviewerAgentId: 'second-copy',
    });
    expect(duplicate.nodes[0]?.data).not.toHaveProperty('runId');
    expect(duplicate.nodes[0]?.data).not.toHaveProperty('runIds');
    expect(duplicate.nodes[0]?.data).not.toHaveProperty('transcript');
    expect(duplicate.nodes[0]?.data).not.toHaveProperty('changedFiles');
    expect(duplicate.nodes[1]?.data.gateState).toBe('pending');
    expect(duplicate.edges[0]).toMatchObject({
      id: 'edge-copy',
      source: 'first-copy',
      target: 'second-copy',
      selected: false,
      data: { config: { attachmentIds: ['first-copy'] } },
    });
  });

  it('remaps group-frame child membership for duplicated nodes in the selected subgraph', () => {
    const group = node('group', true, {
      kind: 'group-frame',
      childNodeIds: ['child', 'outside'],
    });
    const child = node('child', true);
    const ids = ['group-copy', 'child-copy'];

    const duplicate = instantiateClipboardSelection(
      { nodes: [group, child], edges: [] },
      { createId: () => ids.shift() as string },
    );

    expect(duplicate.nodes[0]?.data.childNodeIds).toEqual(['child-copy']);
  });

  it('remaps product-brief attachments that are included in the duplicated selection', () => {
    const brief = node('brief', true, {
      kind: 'brief',
      attachmentIds: ['file', 'outside'],
    });
    const file = node('file', true, { kind: 'file' });
    const ids = ['brief-copy', 'file-copy'];

    const duplicate = instantiateClipboardSelection(
      { nodes: [brief, file], edges: [] },
      { createId: () => ids.shift() as string },
    );

    expect(duplicate.nodes[0]?.data.attachmentIds).toEqual(['file-copy', 'outside']);
  });

  it('gives a duplicated custom check a fresh producer ID and remaps its selected gate', () => {
    const producerId = '5b4926a6-c0b0-4bb7-9ef5-c0d845277d66';
    const testCopyId = '7d37c611-650f-4667-bcb5-acd12ae47c30';
    const gateCopyId = 'b42dbaaf-1451-4888-955f-b8b887ae0dda';
    const test = node('test-node', true, {
      kind: 'test',
      checkKind: 'custom',
      runIds: [producerId],
    });
    const gate = node('gate', true, {
      kind: 'review-gate',
      requiredCheckIds: [producerId, 'test'],
    });
    const ids = [testCopyId, gateCopyId];

    const duplicate = instantiateClipboardSelection(
      { nodes: [test, gate], edges: [] },
      { createId: () => ids.shift() as string },
    );

    expect(duplicate.nodes[0]?.data.runIds).toEqual([testCopyId]);
    expect(duplicate.nodes[1]?.data.requiredCheckIds).toEqual([testCopyId, 'test']);
  });
});

function node(
  id: string,
  selected: boolean,
  data: Partial<WorkshopNode['data']> = {},
): WorkshopNode {
  return {
    id,
    type: 'workshop',
    selected,
    position: { x: 10, y: 20 },
    data: {
      kind: 'task',
      title: id,
      description: `${id} description`,
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#445566',
      ...data,
    },
  };
}

function edge(id: string, source: string, target: string): WorkshopEdge {
  return {
    id,
    source,
    target,
    data: {
      edgeType: 'context',
      config: {
        attachmentMode: 'explicit',
        required: true,
        attachmentIds: [source],
      },
    },
  };
}
