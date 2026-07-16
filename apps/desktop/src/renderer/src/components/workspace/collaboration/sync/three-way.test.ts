import { describe, expect, it } from 'vitest';

import type { CanvasDocument } from '../../../../../../shared/application/contracts.js';
import { canonicalCanvasFromLegacy } from '../../../../../../shared/canvas/adapter.js';
import { collaborationMetadataSnapshotFromCanvas } from '../../../../../../shared/collaboration/index.js';
import { collaborationIntentSurvives, mergeCollaborationIntent } from './three-way.js';

const PROJECT_ID = '00000000-0000-4000-8000-000000000020';
const CANVAS_ID = '00000000-0000-4000-8000-000000000030';

describe('mergeCollaborationIntent', () => {
  it('merges disjoint restart edits even when normal canvas timestamps differ', () => {
    const initial = document('2026-07-15T12:00:00.000Z');
    const migrated = canonicalCanvasFromLegacy(initial);
    if (!migrated.ok) throw new Error(JSON.stringify(migrated.issues));
    const canonical = migrated.canvas;
    const baseline = collaborationMetadataSnapshotFromCanvas(canonical);
    const pending = snapshot({
      ...initial,
      canonical,
      updatedAt: '2026-07-15T12:01:00.000Z',
      nodes: initial.nodes.map((node) =>
        node.id === 'agent-1' ? { ...node, data: { ...node.data, title: 'Local title' } } : node,
      ),
    });
    const remote = snapshot({
      ...initial,
      canonical,
      name: 'Remote canvas name',
      updatedAt: '2026-07-15T12:02:00.000Z',
    });

    const result = mergeCollaborationIntent(baseline, pending, remote);

    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        canvas: { title: 'Remote canvas name', updatedAt: '2026-07-15T12:02:00.000Z' },
        nodes: { 'agent-1': { title: 'Local title' } },
      },
    });
  });

  it('rejects a same-field restart conflict', () => {
    const baseline = snapshot(document('2026-07-15T12:00:00.000Z'));
    const pending = { ...baseline, canvas: { ...baseline.canvas, title: 'Local title' } };
    const remote = { ...baseline, canvas: { ...baseline.canvas, title: 'Remote title' } };

    expect(mergeCollaborationIntent(baseline, pending, remote)).toEqual({ ok: false });
  });

  it('ignores only derived canvas revision noise while retaining entity-level conflicts', () => {
    const baseline = snapshot(document('2026-07-15T12:00:00.000Z'));
    const local = {
      ...baseline,
      canvas: {
        ...baseline.canvas,
        version: baseline.canvas.version + 1,
        updatedAt: '2026-07-15T12:01:00.000Z',
      },
    };
    const remote = {
      ...baseline,
      canvas: {
        ...baseline.canvas,
        version: baseline.canvas.version + 2,
        updatedAt: '2026-07-15T12:02:00.000Z',
      },
    };

    expect(collaborationIntentSurvives(baseline, local, remote)).toBe(true);

    const baselineNode = baseline.nodes['agent-1'];
    if (baselineNode === undefined) throw new Error('Missing test node.');
    const localNodeRevision = {
      ...baseline,
      nodes: {
        ...baseline.nodes,
        'agent-1': {
          ...baselineNode,
          updatedAt: '2026-07-15T12:01:00.000Z',
        },
      },
    };
    const remoteNodeRevision = {
      ...baseline,
      nodes: {
        ...baseline.nodes,
        'agent-1': {
          ...baselineNode,
          updatedAt: '2026-07-15T12:02:00.000Z',
        },
      },
    };
    expect(mergeCollaborationIntent(baseline, localNodeRevision, remoteNodeRevision)).toEqual({
      ok: false,
    });
  });
});

function snapshot(input: CanvasDocument) {
  const migrated = canonicalCanvasFromLegacy(input);
  if (!migrated.ok) throw new Error(JSON.stringify(migrated.issues));
  return collaborationMetadataSnapshotFromCanvas(migrated.canvas);
}

function document(updatedAt: string): CanvasDocument {
  return {
    id: CANVAS_ID,
    projectId: PROJECT_ID,
    name: 'Canvas',
    nodes: [
      {
        id: 'agent-1',
        type: 'agent',
        position: { x: 10, y: 20 },
        data: { kind: 'agent', title: 'Agent', color: '#445566' },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt,
  };
}
