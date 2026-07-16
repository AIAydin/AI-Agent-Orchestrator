import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';

import {
  CollaborationPrivacyError,
  validateAwarenessPayload,
  validateCollaborationDocument,
  validateCollaborationUpdate,
} from './metadata.js';
import type { CollaborationContext } from './types.js';

const NOW = '2026-07-14T12:00:00.000Z';

function createValidDocument(): Y.Doc {
  const document = new Y.Doc();
  document.getMap('canvas').set('id', 'canvas-1');
  document.getMap('canvas').set('title', 'Launch plan');
  document.getMap('canvas').set('version', 1);
  document.getMap('canvas').set('updatedAt', NOW);
  document.getMap('nodes').set('node-1', {
    id: 'node-1',
    type: 'task',
    title: 'Implement settings',
    position: { x: 10, y: 20 },
    status: 'idle',
  });
  return document;
}

function updateFrom(source: Y.Doc, mutate: (candidate: Y.Doc) => void): Uint8Array {
  const candidate = new Y.Doc();
  Y.applyUpdate(candidate, Y.encodeStateAsUpdate(source));
  const stateVector = Y.encodeStateVector(source);
  mutate(candidate);
  const update = Y.encodeStateAsUpdate(candidate, stateVector);
  candidate.destroy();
  return update;
}

describe('collaboration metadata privacy allowlist', () => {
  it('accepts canvas graph metadata without repository content', () => {
    const document = createValidDocument();
    expect(validateCollaborationDocument(document).nodes?.['node-1']?.title).toBe(
      'Implement settings',
    );
    document.destroy();
  });

  it.each([
    'repositoryFiles',
    'fileContents',
    'prompts',
    'diffs',
    'terminalOutput',
    'environment',
    'secrets',
    'transcripts',
  ])('rejects the forbidden shared root %s', (rootName) => {
    const document = createValidDocument();
    document.getMap(rootName).set('payload', 'must stay on the device');
    expect(() => validateCollaborationDocument(document)).toThrow(CollaborationPrivacyError);
    document.destroy();
  });

  it('rejects forbidden nested node properties instead of silently stripping them', () => {
    const document = createValidDocument();
    document.getMap('nodes').set('node-2', {
      id: 'node-2',
      type: 'agent',
      title: 'Agent',
      position: { x: 0, y: 0 },
      prompt: 'upload this prompt',
    });
    expect(() => validateCollaborationDocument(document)).toThrow(CollaborationPrivacyError);
    document.destroy();
  });

  it('permits reviewer-owned comments but rejects reviewer canvas edits', () => {
    const document = createValidDocument();
    const ownComment = updateFrom(document, (candidate) => {
      candidate.getMap('comments').set('comment-1', {
        id: 'comment-1',
        nodeId: 'node-1',
        authorId: 'reviewer-1',
        body: 'Please cover the empty state.',
        createdAt: NOW,
      });
    });
    expect(() =>
      validateCollaborationUpdate({
        document,
        update: ownComment,
        role: 'reviewer',
        subject: 'reviewer-1',
        maxDocumentBytes: 100_000,
      }),
    ).not.toThrow();

    const canvasEdit = updateFrom(document, (candidate) => {
      candidate.getMap('canvas').set('title', 'Reviewer changed title');
    });
    expect(() =>
      validateCollaborationUpdate({
        document,
        update: canvasEdit,
        role: 'reviewer',
        subject: 'reviewer-1',
        maxDocumentBytes: 100_000,
      }),
    ).toThrow('Reviewers can only modify comments and review state.');
    document.destroy();
  });

  it("rejects reviewer takeover or deletion of another author's feedback", () => {
    const document = createValidDocument();
    document.getMap('comments').set('comment-1', {
      id: 'comment-1',
      nodeId: 'node-1',
      authorId: 'reviewer-2',
      body: 'Original feedback',
      createdAt: NOW,
    });
    const takeover = updateFrom(document, (candidate) => {
      candidate.getMap('comments').set('comment-1', {
        id: 'comment-1',
        nodeId: 'node-1',
        authorId: 'reviewer-1',
        body: 'Hijacked feedback',
        createdAt: NOW,
      });
    });
    const deletion = updateFrom(document, (candidate) => {
      candidate.getMap('comments').delete('comment-1');
    });

    for (const update of [takeover, deletion]) {
      expect(() =>
        validateCollaborationUpdate({
          document,
          update,
          role: 'reviewer',
          subject: 'reviewer-1',
          maxDocumentBytes: 100_000,
        }),
      ).toThrow('Reviewers can only modify their own review data.');
    }
    document.destroy();
  });

  it('validates awareness identity and rejects arbitrary presence payloads before broadcast', () => {
    const context: CollaborationContext = {
      roomId: 'room-1',
      subject: 'editor-1',
      role: 'editor',
      accessTokenId: 'f5f1c46f-f4ee-483b-a165-f66c408b6573',
      tokenVersion: 0,
      accessTokenExpiresAt: 1_999_999_999,
      ipHash: 'a'.repeat(24),
    };
    const document = new Y.Doc();
    const awareness = new Awareness(document);
    awareness.setLocalState({
      user: { id: 'editor-1', displayName: 'Editor', color: '#6d5efc', role: 'editor' },
      cursor: { x: 15, y: 30 },
      selection: { nodeIds: ['node-1'] },
    });
    const valid = encodeAwarenessUpdate(awareness, [document.clientID]);
    expect(() => validateAwarenessPayload(valid, context)).not.toThrow();

    awareness.setLocalState({
      user: { id: 'editor-1', displayName: 'Editor', color: '#6d5efc', role: 'editor' },
      terminalOutput: 'secret output',
    });
    const invalid = encodeAwarenessUpdate(awareness, [document.clientID]);
    expect(() => validateAwarenessPayload(invalid, context)).toThrow('Invalid presence metadata.');
    awareness.destroy();
    document.destroy();
  });
});
