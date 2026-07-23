import { describe, expect, it } from 'vitest';

import {
  ExtensionCanvasNodeTypeViewSchema,
  InstalledExtensionViewSchema,
  type ExtensionDiscoveryView,
} from '../../../../../shared/application/contracts.js';
import { hydrateNodeData } from './helpers.js';

const definition = ExtensionCanvasNodeTypeViewSchema.parse({
  id: 'decision',
  displayName: 'Decision',
  description: 'Records a decision.',
  category: 'Planning',
  icon: 'note',
  color: '#4f46e5',
  capabilities: [],
  fields: [],
  ports: [],
});

const installed = InstalledExtensionViewSchema.parse({
  record: {
    schemaVersion: 1,
    extensionId: 'example.notes',
    version: '1.0.0',
    manifestDigest: 'a'.repeat(64),
    snapshotDigest: 'b'.repeat(64),
    grantedPermissions: ['canvas.node.register'],
    sourcePath: '/tmp/example.notes',
    installedAt: '2026-07-18T12:00:00.000Z',
    updatedAt: '2026-07-18T12:00:00.000Z',
  },
  manifest: {
    schemaVersion: 1,
    id: 'example.notes',
    name: 'Example notes',
    version: '1.0.0',
    description: 'Adds decision nodes.',
    publisher: 'Example',
    requestedPermissions: ['canvas.node.register'],
    contributes: { agentAdapters: [], canvasNodeTypes: [definition] },
  },
  manifestJson: '{}',
  trustState: 'active',
  approvedAt: '2026-07-18T12:00:00.000Z',
});

const discovery: Pick<ExtensionDiscoveryView, 'installed' | 'quarantined'> = {
  installed: [installed],
  quarantined: [],
};

describe('extension node hydration', () => {
  it('preserves the user-selected shared accent colour while refreshing declarative metadata', () => {
    const hydrated = hydrateNodeData(
      {
        kind: 'extension',
        title: 'Architecture choice',
        description: 'Choose a storage engine.',
        status: 'idle',
        locked: false,
        collapsed: false,
        color: '#123456',
        extensionId: installed.manifest.id,
        extensionVersion: installed.manifest.version,
        extensionNodeTypeId: definition.id,
        extensionDefinition: { ...definition, displayName: 'Stale definition' },
        extensionValues: {},
      },
      discovery,
    );

    expect(hydrated.color).toBe('#123456');
    expect(hydrated.extensionDefinition?.displayName).toBe('Decision');
    expect(hydrated.extensionAvailability).toBe('active');
  });
});

describe('removed agent compatibility', () => {
  it('clears the retired adapter from a saved Agent node so the current default takes over', () => {
    const hydrated = hydrateNodeData(
      {
        kind: 'agent',
        title: 'Implementation',
        description: '',
        status: 'idle',
        locked: false,
        collapsed: false,
        adapterId: 'test-agent',
      },
      discovery,
    );

    expect(hydrated).toMatchObject({ kind: 'agent' });
    expect(hydrated).not.toHaveProperty('adapterId');
  });
});
