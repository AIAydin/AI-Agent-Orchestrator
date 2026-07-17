import { describe, expect, it } from 'vitest';

import type { CanvasDocument } from '../../../../../shared/application/contracts.js';
import {
  appendLocalComment,
  appendSharedComment,
  localCommentsForNode,
  sharedCanonicalCommentsForNode,
} from './comment-model.js';

const NOW = '2026-07-17T12:00:00.000Z';

describe('local node comment model', () => {
  it('keeps local and shared comments in distinct canonical scopes', () => {
    const local = appendLocalComment(document(), 'node-1', '  Private plan  ', {
      id: 'local:1',
      createdAt: NOW,
    });
    const both = appendSharedComment(local, 'node-1', {
      id: 'shared-1',
      authorId: 'reviewer-1',
      body: 'Room review',
      createdAt: NOW,
    });

    expect(localCommentsForNode(both, 'node-1')).toMatchObject([
      { id: 'local:1', scope: 'local', body: 'Private plan' },
    ]);
    expect(sharedCanonicalCommentsForNode(both, 'node-1')).toMatchObject([
      { id: 'shared-1', scope: 'shared', body: 'Room review' },
    ]);
  });

  it('treats historical unscoped comments as local and does not modify missing nodes', () => {
    const historical = appendLocalComment(document(), 'node-1', 'Historical', {
      id: 'historical-1',
      createdAt: NOW,
    });
    if (historical?.canonical === undefined) throw new Error('Expected canonical canvas.');
    const comment = historical.canonical.nodes[0]?.comments[0];
    if (comment === undefined) throw new Error('Expected historical comment.');
    const unscoped = Object.fromEntries(
      Object.entries(comment).filter(([key]) => key !== 'scope'),
    ) as Omit<typeof comment, 'scope'>;
    const legacy = {
      ...historical,
      canonical: {
        ...historical.canonical,
        nodes: historical.canonical.nodes.map((node) =>
          node.id === 'node-1' ? { ...node, comments: [unscoped] } : node,
        ),
      },
    };

    expect(localCommentsForNode(legacy, 'node-1')).toHaveLength(1);
    expect(sharedCanonicalCommentsForNode(legacy, 'node-1')).toHaveLength(0);
    expect(appendLocalComment(legacy, 'missing', 'No target', { id: 'x', createdAt: NOW })).toEqual(
      legacy,
    );
  });
});

function document(): CanvasDocument {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    projectId: '00000000-0000-4000-8000-000000000002',
    name: 'Comments',
    nodes: [
      {
        id: 'node-1',
        type: 'task',
        position: { x: 0, y: 0 },
        data: { kind: 'task', title: 'Task', color: '#445566' },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt: NOW,
  };
}
