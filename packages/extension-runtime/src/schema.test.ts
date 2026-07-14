import { CODEX_MANIFEST } from '@forgeboard/agent-adapters';
import { describe, expect, it } from 'vitest';

import {
  ExtensionManifestSchema,
  extensionNodeTypeId,
  requiredPermissionsForManifest,
} from './schema.js';
import { exampleCanvasExtension } from './test-fixtures.js';

describe('ExtensionManifestSchema', () => {
  it('accepts a bounded, declarative canvas contribution', () => {
    const manifest = ExtensionManifestSchema.parse(exampleCanvasExtension());

    expect(requiredPermissionsForManifest(manifest)).toEqual([
      'canvas.data.persist',
      'canvas.node.register',
    ]);
    expect(extensionNodeTypeId(manifest.id, manifest.contributes.canvasNodeTypes[0]!.id)).toBe(
      'example.notes.decision',
    );
  });

  it('accepts namespaced validated agent adapters with explicit provider permissions', () => {
    const manifest = ExtensionManifestSchema.parse({
      schemaVersion: 1,
      id: 'example.agent',
      name: 'Example agent adapter',
      version: '1.0.0',
      description: 'Packages a validated local CLI adapter.',
      publisher: 'Example publisher',
      requestedPermissions: [
        'agent.adapter.register',
        'agent.process.launch',
        'agent.context.selected-read',
        'agent.provider.network',
      ],
      contributes: {
        agentAdapters: [{ ...CODEX_MANIFEST, id: 'example.agent.codex' }],
        canvasNodeTypes: [],
      },
    });

    expect(requiredPermissionsForManifest(manifest)).toEqual([
      'agent.adapter.register',
      'agent.context.selected-read',
      'agent.process.launch',
      'agent.provider.network',
    ]);
  });

  it('rejects adapter ids whose empty namespace segments would fail desktop IPC validation', () => {
    const result = ExtensionManifestSchema.safeParse({
      schemaVersion: 1,
      id: 'example.agent',
      name: 'Malformed adapter namespace',
      version: '1.0.0',
      description: 'Attempts to contribute an adapter with an ambiguous id.',
      publisher: 'Example publisher',
      requestedPermissions: [
        'agent.adapter.register',
        'agent.process.launch',
        'agent.context.selected-read',
        'agent.provider.network',
      ],
      contributes: {
        agentAdapters: [{ ...CODEX_MANIFEST, id: 'example.agent..codex' }],
        canvasNodeTypes: [],
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('dot-separated'))).toBe(
        true,
      );
    }
  });

  it('rejects executable renderer modules and unknown high-risk permissions', () => {
    const manifest = {
      ...exampleCanvasExtension(),
      rendererModule: './renderer.js',
      requestedPermissions: [
        'canvas.node.register',
        'canvas.data.persist',
        'renderer.execute-code',
      ],
    };

    const result = ExtensionManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain(
        'requestedPermissions.2',
      );
      expect(result.error.issues.some((issue) => issue.message.includes('rendererModule'))).toBe(
        true,
      );
    }
  });

  it('rejects even known permissions when contributions do not justify them', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...exampleCanvasExtension(),
      requestedPermissions: ['canvas.node.register', 'canvas.data.persist', 'agent.process.launch'],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('not justified'))).toBe(
        true,
      );
    }
  });

  it('rejects traversal in optional documentation resources', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...exampleCanvasExtension(),
      documentationFile: '../outside.md',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['documentationFile']);
    }
  });

  it('enforces strict Semantic Version 2.0.0 syntax', () => {
    for (const version of ['1.0.0-ALPHA', '1.0.0-alpha', '1.0.0-alpha.1+build.001', '1.0.0+001']) {
      expect(
        ExtensionManifestSchema.safeParse({ ...exampleCanvasExtension(), version }).success,
      ).toBe(true);
    }

    for (const version of ['01.0.0', '1.01.0', '1.0.01', '1.0.0-01', '1.0.0-alpha.01', 'v1.0.0']) {
      expect(
        ExtensionManifestSchema.safeParse({ ...exampleCanvasExtension(), version }).success,
      ).toBe(false);
    }
  });

  it('rejects inconsistent field definitions before they reach a renderer', () => {
    const manifest = exampleCanvasExtension();
    const contributes = manifest.contributes as {
      canvasNodeTypes: Array<{ fields: unknown[] }>;
    };
    contributes.canvasNodeTypes[0]!.fields.push({
      id: 'status',
      kind: 'number',
      label: 'Duplicate and invalid range',
      minimum: 5,
      maximum: 2,
    });

    const result = ExtensionManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages).toEqual(
        expect.arrayContaining([
          'Duplicate field id: status',
          'A number field minimum cannot exceed its maximum.',
        ]),
      );
    }
  });
});
