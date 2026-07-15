import { describe, expect, it } from 'vitest';

import {
  CanvasDocumentSchema,
  ExtensionCanvasNodeTypeViewSchema,
  InstalledExtensionViewSchema,
  type ExtensionDiscoveryView,
} from '../../../../shared/application/contracts.js';
import {
  createExtensionNodeBinding,
  normalizeExtensionFieldValues,
  resolveExtensionNodeBinding,
} from './extension-nodes.js';

const definition = ExtensionCanvasNodeTypeViewSchema.parse({
  id: 'decision',
  displayName: 'Decision',
  description: 'Records a bounded decision.',
  category: 'Planning',
  icon: 'note',
  color: '#4F46E5',
  capabilities: ['human-editable'],
  fields: [
    {
      id: 'summary',
      kind: 'multiline',
      label: 'Summary',
      required: true,
      defaultValue: 'Draft',
      maxLength: 4_000,
    },
    {
      id: 'accepted',
      kind: 'boolean',
      label: 'Accepted',
      required: false,
      defaultValue: true,
    },
  ],
  ports: [
    {
      id: 'context',
      label: 'Context',
      direction: 'output',
      dataType: 'context',
      multiple: true,
    },
  ],
});

const installed = InstalledExtensionViewSchema.parse({
  record: {
    schemaVersion: 1,
    extensionId: 'example.notes',
    version: '1.0.0',
    manifestDigest: 'a'.repeat(64),
    snapshotDigest: 'b'.repeat(64),
    grantedPermissions: ['canvas.data.persist', 'canvas.node.register'],
    sourcePath: '/tmp/example.notes',
    installedAt: '2026-07-14T16:00:00.000Z',
    updatedAt: '2026-07-14T16:00:00.000Z',
  },
  manifest: {
    schemaVersion: 1,
    id: 'example.notes',
    name: 'Example notes',
    version: '1.0.0',
    description: 'Adds decision notes.',
    publisher: 'Example',
    requestedPermissions: ['canvas.data.persist', 'canvas.node.register'],
    contributes: { agentAdapters: [], canvasNodeTypes: [definition] },
  },
  manifestJson: '{}',
  trustState: 'active',
  approvedAt: '2026-07-14T16:00:00.000Z',
});

const activeDiscovery: Pick<ExtensionDiscoveryView, 'installed' | 'quarantined'> = {
  installed: [installed],
  quarantined: [],
};

describe('declarative extension canvas nodes', () => {
  it('creates safe default values and prefers the current trusted definition', () => {
    const binding = createExtensionNodeBinding(installed, definition);
    expect(binding.values).toEqual({ summary: 'Draft', accepted: true });

    const resolved = resolveExtensionNodeBinding(
      {
        extensionId: binding.extensionId,
        extensionVersion: binding.extensionVersion,
        nodeTypeId: binding.nodeTypeId,
        definition: { ...binding.definition, displayName: 'Stale local copy' },
        values: { summary: 'Persisted answer', accepted: false },
      },
      activeDiscovery,
    );

    expect(resolved).toMatchObject({
      availability: 'active',
      definition: { displayName: 'Decision' },
      values: { summary: 'Persisted answer', accepted: false },
    });
  });

  it('keeps a validated projection and values visible but disabled after removal or quarantine', () => {
    const input = {
      extensionId: installed.manifest.id,
      extensionVersion: installed.manifest.version,
      nodeTypeId: definition.id,
      definition,
      values: { summary: 'Saved locally', accepted: true },
    };

    expect(resolveExtensionNodeBinding(input, { installed: [], quarantined: [] })).toMatchObject({
      availability: 'unavailable',
      values: input.values,
    });
    expect(
      resolveExtensionNodeBinding(input, {
        installed: [],
        quarantined: [
          {
            extensionId: installed.manifest.id,
            ledgerState: 'revoked',
            reason: 'Trust revoked for test.',
          },
        ],
      }),
    ).toMatchObject({ availability: 'quarantined', values: input.values });
  });

  it('drops undeclared values and replaces out-of-bounds field data with safe defaults', () => {
    const bounded = ExtensionCanvasNodeTypeViewSchema.parse({
      ...definition,
      id: 'bounded',
      fields: [
        {
          id: 'short',
          kind: 'text',
          label: 'Short text',
          required: false,
          defaultValue: 'ok',
          maxLength: 3,
        },
        {
          id: 'score',
          kind: 'number',
          label: 'Score',
          required: false,
          defaultValue: 5,
          minimum: 0,
          maximum: 10,
        },
        {
          id: 'files',
          kind: 'file-reference',
          label: 'Files',
          required: false,
          multiple: true,
        },
      ],
    });

    expect(
      normalizeExtensionFieldValues(bounded, {
        short: 'too long',
        score: 99,
        files: ['relative/path', '/tmp/safe', '/tmp/safe'],
        undeclared: '<script>',
      }),
    ).toEqual({ short: 'ok', score: 5, files: [] });
    expect(
      normalizeExtensionFieldValues(bounded, {
        short: 'yes',
        score: 8,
        files: ['/tmp/a', '/tmp/a', '/tmp/b'],
      }),
    ).toEqual({ short: 'yes', score: 8, files: ['/tmp/a', '/tmp/b'] });
  });

  it('round-trips the generic data projection, values, and declared port handles', () => {
    const binding = createExtensionNodeBinding(installed, definition);
    const parsed = CanvasDocumentSchema.parse({
      id: '123fae6e-e213-4a10-a0db-0f85b791f7e9',
      projectId: '223fae6e-e213-4a10-a0db-0f85b791f7e9',
      name: 'Extension canvas',
      nodes: [
        {
          id: 'extension-node',
          type: 'extension',
          position: { x: 10, y: 20 },
          data: {
            kind: 'extension',
            extensionId: binding.extensionId,
            extensionVersion: binding.extensionVersion,
            extensionNodeTypeId: binding.nodeTypeId,
            extensionDefinition: binding.definition,
            extensionValues: { summary: 'Persisted answer', accepted: false },
            extensionAvailability: 'active',
          },
        },
        {
          id: 'consumer',
          type: 'task',
          position: { x: 200, y: 20 },
          data: { kind: 'task' },
        },
      ],
      edges: [
        {
          id: 'edge-1',
          source: 'extension-node',
          target: 'consumer',
          sourceHandle: 'context',
          targetHandle: 'input',
          type: 'context',
        },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
      updatedAt: '2026-07-14T16:00:00.000Z',
    });

    expect(parsed.nodes[0]?.data.extensionValues).toEqual({
      summary: 'Persisted answer',
      accepted: false,
    });
    expect(parsed.edges[0]).toMatchObject({ sourceHandle: 'context', targetHandle: 'input' });
  });
});
