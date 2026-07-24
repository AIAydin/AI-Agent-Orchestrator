import { describe, expect, it } from 'vitest';

import type { ExtensionCanvasNodeTypeView } from '../../../../../shared/application/contracts.js';
import {
  NODE_DEFINITIONS,
  NODE_KINDS,
  NodeTypeRegistry,
  extensionNodeTypeKey,
} from './registry.js';

describe('NodeTypeRegistry', () => {
  it('registers the text node kind', () => {
    expect(NODE_KINDS).toContain('text');
    const definition = NODE_DEFINITIONS.text;
    expect(definition.label).toBe('Text');
    expect(definition.color).toBe('#8f9bb3');
  });

  it('registers every required built-in with the complete shared behavior contract', () => {
    const registry = new NodeTypeRegistry();
    expect(registry.builtIns().map(({ kind }) => kind)).toEqual(NODE_KINDS);
    for (const definition of registry.builtIns()) {
      expect(definition.behaviors).toEqual({
        resizable: true,
        collapsible: true,
        lockable: true,
        duplicable: true,
        deletable: true,
        groupable: true,
        commentable: true,
        runHistory: true,
      });
    }
  });

  it('resolves only an exact installed extension identity and rejects duplicate registrations', () => {
    const definition = extensionDefinition();
    const registration = {
      extensionId: 'example.extension',
      extensionVersion: '1.0.0',
      definition,
    };
    const registry = new NodeTypeRegistry([registration]);
    expect(
      registry.resolve({
        kind: 'extension',
        extensionId: registration.extensionId,
        extensionVersion: registration.extensionVersion,
        extensionNodeTypeId: definition.id,
      }),
    ).toMatchObject({
      key: extensionNodeTypeKey('example.extension', '1.0.0', 'example-node'),
      label: 'Example node',
      source: 'installed-extension',
      ports: definition.ports,
    });
    expect(() => registry.registerExtension(registration)).toThrow(/already exists/iu);
  });

  it('renders a persisted extension definition as unavailable without registering executable code', () => {
    const registry = new NodeTypeRegistry();
    expect(
      registry.resolve({
        kind: 'extension',
        extensionId: 'missing.extension',
        extensionVersion: '1.0.0',
        extensionNodeTypeId: 'example-node',
        extensionDefinition: extensionDefinition(),
      }),
    ).toMatchObject({
      source: 'persisted-extension',
      label: 'Example node',
      behaviors: { commentable: true, runHistory: true },
    });
  });
});

function extensionDefinition(): ExtensionCanvasNodeTypeView {
  return {
    id: 'example-node',
    displayName: 'Example node',
    description: 'A declarative extension node.',
    category: 'Examples',
    color: '#778899',
    icon: 'box',
    capabilities: [],
    fields: [],
    ports: [
      { id: 'input', label: 'Input', direction: 'input', dataType: 'any', multiple: false },
      { id: 'output', label: 'Output', direction: 'output', dataType: 'any', multiple: false },
    ],
  };
}
