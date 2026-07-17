import { describe, expect, it } from 'vitest';

import { canonicalCanvasFromLegacy, legacySurfaceFromCanonical } from './adapter.js';
import type { LegacyCanvasDocument, LegacyCanvasNode } from './types.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const T1 = '2026-07-17T12:00:00.000Z';
const T2 = '2026-07-17T12:01:00.000Z';

describe('Git/PR canvas adapter', () => {
  it('round-trips the opaque delivery target and UI-authored remote configuration', () => {
    const migrated = canonicalCanvasFromLegacy(
      document(
        gitNode({
          deliveryTarget: { kind: 'agent-run', runId: RUN_ID },
          remote: 'origin',
          destinationBranch: 'feature/remote-delivery',
          baseBranch: 'main',
          pullRequestTitle: 'Add safe remote delivery',
          pullRequestBody: 'Confirm the exact disclosed impact before publication.',
          pullRequestDraft: true,
          pullRequestUrl: 'https://github.com/forgeboard/example/pull/42',
        }),
      ),
    );

    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.canvas.nodes[0]).toMatchObject({
      type: 'git-pr',
      data: {
        deliveryTarget: { kind: 'agent-run', runId: RUN_ID },
        remote: 'origin',
        destinationBranch: 'feature/remote-delivery',
        baseBranch: 'main',
        pullRequestTitle: 'Add safe remote delivery',
        pullRequestBody: 'Confirm the exact disclosed impact before publication.',
        pullRequestDraft: true,
        pullRequestUrl: 'https://github.com/forgeboard/example/pull/42',
      },
    });

    const surface = legacySurfaceFromCanonical(migrated.canvas);
    expect(surface.nodes[0]?.data).toMatchObject({
      deliveryTarget: { kind: 'agent-run', runId: RUN_ID },
      destinationBranch: 'feature/remote-delivery',
      pullRequestDraft: true,
    });
    const roundTripped = canonicalCanvasFromLegacy({
      ...surface,
      canonical: migrated.canvas,
      updatedAt: T2,
    });
    expect(roundTripped.ok).toBe(true);
    if (!roundTripped.ok) return;
    expect(roundTripped.canvas.nodes[0]?.data).toEqual(migrated.canvas.nodes[0]?.data);
  });

  it('preserves new canonical configuration when an older renderer omits unknown fields', () => {
    const initial = canonicalCanvasFromLegacy(
      document(
        gitNode({
          deliveryTarget: { kind: 'agent-run', runId: RUN_ID },
          remote: 'origin',
          destinationBranch: 'feature/remote-delivery',
          baseBranch: 'main',
          pullRequestTitle: 'Safe delivery',
          pullRequestBody: '',
          pullRequestDraft: false,
        }),
      ),
    );
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const surface = legacySurfaceFromCanonical(initial.canvas);
    const olderSurface = {
      ...surface,
      updatedAt: T2,
      nodes: surface.nodes.map((node) => ({
        ...node,
        data: Object.fromEntries(
          Object.entries(node.data).filter(
            ([key]) =>
              ![
                'deliveryTarget',
                'remote',
                'destinationBranch',
                'baseBranch',
                'pullRequestTitle',
                'pullRequestBody',
                'pullRequestDraft',
              ].includes(key),
          ),
        ),
      })),
      canonical: initial.canvas,
    };

    const preserved = canonicalCanvasFromLegacy(olderSurface);
    expect(preserved.ok).toBe(true);
    if (!preserved.ok) return;
    expect(preserved.canvas.nodes[0]?.data).toMatchObject({
      deliveryTarget: { kind: 'agent-run', runId: RUN_ID },
      remote: 'origin',
      destinationBranch: 'feature/remote-delivery',
      baseBranch: 'main',
      pullRequestTitle: 'Safe delivery',
      pullRequestBody: '',
      pullRequestDraft: false,
    });
  });

  it('keeps legacy worktree display data without manufacturing delivery authority', () => {
    const migrated = canonicalCanvasFromLegacy(
      document(
        gitNode({
          worktreeId: 'legacy-worktree',
          branch: 'legacy/agent-branch',
          baseBranch: 'main',
          commitIds: ['abcdef1'],
          ahead: 1,
        }),
      ),
    );

    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.canvas.nodes[0]).toMatchObject({
      type: 'git-pr',
      data: { worktreeId: 'legacy-worktree', branch: 'legacy/agent-branch', ahead: 1 },
    });
    expect(migrated.canvas.nodes[0]?.data).not.toHaveProperty('deliveryTarget');
  });

  it('fails closed on path-bearing targets and untrusted pull-request links', () => {
    const unsafeValues = [
      { deliveryTarget: { kind: 'agent-run', runId: RUN_ID, worktreePath: '/private/worktree' } },
      { deliveryTarget: { kind: 'agent-run', runId: 'renderer-path' } },
      { pullRequestUrl: 'file:///private/repository/pull/42' },
      { pullRequestUrl: 'https://example.com/owner/repository/pull/42?token=secret' },
    ];

    for (const data of unsafeValues) {
      expect(canonicalCanvasFromLegacy(document(gitNode(data)))).toMatchObject({
        ok: false,
        issues: [{ code: 'INVALID_TYPED_NODE', entityId: 'git-1' }],
      });
    }
  });
});

function gitNode(data: Record<string, unknown>): LegacyCanvasNode {
  return {
    id: 'git-1',
    type: 'git-pr',
    position: { x: 10, y: 20 },
    width: 360,
    height: 220,
    data: {
      kind: 'git-pr',
      title: 'Git delivery',
      color: '#445566',
      locked: false,
      collapsed: false,
      status: 'idle',
      ...data,
    },
  };
}

function document(node: LegacyCanvasNode): LegacyCanvasDocument {
  return {
    id: 'canvas-1',
    projectId: 'project-1',
    name: 'Remote delivery',
    nodes: [node],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt: T1,
  };
}
