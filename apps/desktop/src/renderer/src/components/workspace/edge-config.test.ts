import { describe, expect, it } from 'vitest';

import { createEdgeData, edgeDataForPersistence } from './edge-config.js';

describe('typed canvas edge configuration', () => {
  it('turns a legacy context connection into an explicit source attachment', () => {
    expect(createEdgeData('context', 'source-node')).toEqual({
      edgeType: 'context',
      config: {
        attachmentMode: 'explicit',
        required: true,
        attachmentIds: ['source-node'],
      },
    });
  });

  it('normalizes every executable edge configuration without carrying arbitrary metadata', () => {
    expect(
      createEdgeData('execute', 'source', {
        config: {
          trigger: 'on-completion',
          approval: 'review-gate',
          approvalGateNodeId: 'gate-1',
          ignored: 'not-config',
        },
      }),
    ).toEqual({
      edgeType: 'execute',
      config: {
        trigger: 'on-completion',
        approval: 'review-gate',
        approvalGateNodeId: 'gate-1',
      },
    });
    expect(createEdgeData('output', 'source')).toMatchObject({
      config: { outputKind: 'artifact', required: true },
    });
    expect(createEdgeData('review', 'source')).toMatchObject({
      config: { reviewer: 'human', requireApproval: true, structuredFindings: true },
    });
    expect(createEdgeData('revision', 'source')).toMatchObject({
      config: { actionableFeedbackRequired: true },
    });
    expect(createEdgeData('dependency', 'source')).toMatchObject({
      config: { requiredStatus: 'succeeded' },
    });
  });

  it('persists only the typed configuration envelope', () => {
    const data = createEdgeData('output', 'source', {
      outputKind: 'diff',
      required: false,
    });
    expect(edgeDataForPersistence(data)).toEqual({
      config: { outputKind: 'diff', required: false },
    });
  });
});
