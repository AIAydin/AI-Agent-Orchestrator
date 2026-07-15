import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { CollaborationMetadataSnapshotSchema } from '../../shared/collaboration/index.js';
import {
  collaborationSnapshotFromDocument,
  hasCompleteCollaborationSnapshot,
  replaceCollaborationDocument,
} from './document.js';

const NOW = '2026-07-15T12:00:00.000Z';

function snapshot() {
  return CollaborationMetadataSnapshotSchema.parse({
    canvas: {
      id: 'canvas-1',
      title: 'Safe canvas title',
      version: 1,
      updatedAt: NOW,
    },
    nodes: {
      'task-1': {
        id: 'task-1',
        type: 'task',
        title: 'Safe task title',
        position: { x: 10, y: 20 },
      },
    },
    edges: {},
    groups: {},
    tasks: {
      'task-1': { id: 'task-1', title: 'Safe task title', status: 'ready' },
    },
    comments: {},
    workflow: {},
    reviews: {},
  });
}

describe('collaboration Yjs document projection', () => {
  it('round-trips only the strict metadata roots and replaces stale values', () => {
    const document = new Y.Doc();
    document.getMap('nodes').set('stale-node', { id: 'stale-node' });

    replaceCollaborationDocument(document, snapshot());

    expect(collaborationSnapshotFromDocument(document)).toEqual(snapshot());
    expect(document.getMap('nodes').has('stale-node')).toBe(false);
    expect([...document.share.keys()].sort()).toEqual([
      'canvas',
      'comments',
      'edges',
      'groups',
      'nodes',
      'reviews',
      'tasks',
      'workflow',
    ]);
    expect(JSON.stringify(document.toJSON())).not.toMatch(
      /prompt|token|fileContents|repositoryPath/u,
    );
  });

  it('rejects unknown shared roots instead of persisting or forwarding them', () => {
    const document = new Y.Doc();
    replaceCollaborationDocument(document, snapshot());
    document.getMap('credentials').set('accessToken', 'SECRET_DO_NOT_FORWARD');

    expect(hasCompleteCollaborationSnapshot(document)).toBe(false);
    expect(() => collaborationSnapshotFromDocument(document)).toThrow();
  });
});
