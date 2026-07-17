import { describe, expect, it } from 'vitest';

import type { WorkshopNode } from '../canvas/CanvasNode.js';
import { applyNodeDataPatch } from './node-data-patch.js';

describe('applyNodeDataPatch', () => {
  it('removes every explicitly cleared runtime field instead of retaining non-JSON undefined values', () => {
    const current: WorkshopNode['data'] = {
      kind: 'agent',
      title: 'Agent',
      description: 'Run locally',
      color: '#445566',
      status: 'idle',
      locked: false,
      collapsed: false,
      adapterId: 'extension.agent',
      model: 'model-v1',
      worktreeId: 'worktree-1',
      branch: 'agent/work',
      interactiveInputSupported: true,
      providerSessionAvailable: true,
    };

    const patched = applyNodeDataPatch(current, {
      model: undefined,
      worktreeId: undefined,
      branch: undefined,
      interactiveInputSupported: undefined,
      providerSessionAvailable: undefined,
      status: 'queued',
    });

    expect(patched).toEqual({
      kind: 'agent',
      title: 'Agent',
      description: 'Run locally',
      color: '#445566',
      adapterId: 'extension.agent',
      status: 'queued',
      locked: false,
      collapsed: false,
    });
    expect(Object.values(patched)).not.toContain(undefined);
  });
});
