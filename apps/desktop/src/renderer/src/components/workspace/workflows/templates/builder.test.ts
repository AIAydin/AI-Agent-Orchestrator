import { describe, expect, it } from 'vitest';

import { AppSettingsSchema } from '../../../../../../shared/application/contracts.js';
import { buildWorkflowTemplate } from './builder.js';
import { WORKFLOW_TEMPLATES } from './catalog.js';

const settings = AppSettingsSchema.parse({
  theme: 'system',
  reducedMotion: false,
  density: 'comfortable',
  defaultAgent: 'test-agent',
  defaultPermissionProfile: 'worktree-write',
  worktreeRoot: '/tmp/forgeboard-worktrees',
  terminalShell: '/bin/sh',
  envAllowlist: ['PATH', 'CI'],
  developmentCommand: { executable: 'pnpm', arguments: ['dev'] },
  lintCommand: { executable: 'pnpm', arguments: ['lint'] },
  testCommand: { executable: 'pnpm', arguments: ['test'] },
  previewPortStart: 41_000,
  previewPortEnd: 41_999,
  transcriptRetentionDays: 30,
  collaborationEnabled: false,
  collaborationUrl: '',
});

describe('first-party workflow templates', () => {
  it('publishes the five required, uniquely named catalog entries', () => {
    expect(WORKFLOW_TEMPLATES.map(({ id }) => id)).toEqual([
      'single-agent',
      'parallel-implementations',
      'implement-review-loop',
      'bug-investigation',
      'multi-screen-product-build',
    ]);
    for (const template of WORKFLOW_TEMPLATES) {
      expect(new Set(template.nodes.map(({ key }) => key)).size).toBe(template.nodes.length);
    }
  });

  it.each(WORKFLOW_TEMPLATES)(
    'builds a persistable, host-plannable $name graph with exact local defaults',
    (template) => {
      const built = buildWorkflowTemplate(template.id, settings, { x: 100, y: 200 }, ids());
      expect(built.nodes).toHaveLength(template.nodes.length);
      expect(built.edges).toHaveLength(template.edges.length);
      expect(new Set(built.nodes.map(({ id }) => id)).size).toBe(built.nodes.length);
      expect(new Set(built.edges.map(({ id }) => id)).size).toBe(built.edges.length);
      expect(built.nodes.every(({ position }) => position.x >= 100 && position.y >= 200)).toBe(
        true,
      );
      for (const node of built.nodes.filter(({ data }) => data.kind === 'agent')) {
        expect(node.data).toMatchObject({
          adapterId: 'test-agent',
          permissionProfile: 'worktree-write',
        });
      }
      for (const node of built.nodes.filter(({ data }) => data.kind === 'test')) {
        expect(node.data.command).toEqual({ executable: 'pnpm', arguments: ['test'] });
      }
    },
  );

  it('creates a bounded implement-review revision loop and honest multi-screen drafts', () => {
    const loop = buildWorkflowTemplate('implement-review-loop', settings, { x: 0, y: 0 }, ids());
    const revision = loop.edges.find(({ data }) => data?.edgeType === 'revision');
    expect(revision?.data).toMatchObject({
      config: { actionableFeedbackRequired: true },
      loop: {
        maximumAttempts: 3,
        stopConditions: ['review-approved', 'human-accepted'],
      },
    });
    expect(
      revision?.data?.edgeType === 'revision' ? revision.data.config.loopId : undefined,
    ).toMatch(/^[0-9a-f-]{36}$/u);

    const product = buildWorkflowTemplate(
      'multi-screen-product-build',
      settings,
      { x: 0, y: 0 },
      ids(),
    );
    expect(product.nodes.map(({ data }) => data.kind)).toEqual([
      'brief',
      'agent',
      'web-preview',
      'mobile-preview',
      'test',
      'agent',
      'review-gate',
    ]);
    expect(product.nodes.find(({ data }) => data.kind === 'mobile-preview')?.data).toMatchObject({
      previewPreset: 'iphone',
      previewSecondaryPreset: 'tablet',
      previewSideBySide: true,
    });
    const previewIds = new Set(
      product.nodes
        .filter(({ data }) => data.kind === 'web-preview' || data.kind === 'mobile-preview')
        .map(({ id }) => id),
    );
    expect(
      product.edges.every(
        ({ source, target }) => !previewIds.has(source) && !previewIds.has(target),
      ),
    ).toBe(true);
    expect(
      product.edges.some(
        ({ data }) => data?.edgeType === 'review' && data.config.reviewer === 'agent',
      ),
    ).toBe(true);
  });
});

function ids(): () => string {
  let value = 1;
  return () => `00000000-0000-4000-8000-${(value++).toString(16).padStart(12, '0')}`;
}
