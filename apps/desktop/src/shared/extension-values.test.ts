import { describe, expect, it } from 'vitest';

import { CanvasDocumentSchema, type ExtensionCanvasNodeTypeView } from './contracts.js';
import { sanitizeCanvasExtensionData } from './extension-values.js';

const definition: ExtensionCanvasNodeTypeView = {
  id: 'release-card',
  displayName: 'Release card',
  description: 'A bounded declarative extension node.',
  category: 'Planning',
  icon: 'note',
  color: '#4F46E5',
  capabilities: ['human-editable'],
  fields: [
    {
      id: 'state',
      kind: 'select',
      label: 'State',
      required: true,
      options: [
        { label: 'Draft', value: 'draft' },
        { label: 'Ready', value: 'ready' },
      ],
      defaultValue: 'draft',
    },
    {
      id: 'references',
      kind: 'file-reference',
      label: 'References',
      required: false,
      multiple: true,
    },
  ],
  ports: [],
};

describe('authoritative extension canvas value sanitation', () => {
  it('strips undeclared data and values while normalizing declared bounded fields', () => {
    const document = CanvasDocumentSchema.parse({
      id: '00000000-0000-4000-8000-000000000001',
      projectId: '00000000-0000-4000-8000-000000000002',
      name: 'Workshop',
      nodes: [
        {
          id: 'extension-node',
          type: 'workshop',
          position: { x: 0, y: 0 },
          data: {
            kind: 'extension',
            title: 'Release',
            description: '',
            status: 'idle',
            locked: false,
            collapsed: false,
            color: '#4F46E5',
            extensionId: 'example.release',
            extensionVersion: '1.0.0',
            extensionNodeTypeId: definition.id,
            extensionDefinition: definition,
            extensionValues: {
              state: 'not-a-declared-option',
              references: ['/tmp/reference.md', '/tmp/reference.md'],
              hiddenPayload: 'must not persist',
            },
            hiddenTopLevelPayload: 'must not persist',
          },
        },
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      updatedAt: '2026-07-14T16:00:00.000Z',
    });

    const sanitized = sanitizeCanvasExtensionData(document);
    const data = sanitized.nodes[0]?.data;
    expect(data).not.toHaveProperty('hiddenTopLevelPayload');
    expect(data?.['extensionValues']).toEqual({
      state: 'draft',
      references: ['/tmp/reference.md'],
    });
  });

  it('rejects extension nodes without a bounded persisted definition', () => {
    const document = CanvasDocumentSchema.parse({
      id: '00000000-0000-4000-8000-000000000001',
      projectId: '00000000-0000-4000-8000-000000000002',
      name: 'Workshop',
      nodes: [
        {
          id: 'extension-node',
          type: 'workshop',
          position: { x: 0, y: 0 },
          data: {
            kind: 'extension',
            title: 'Release',
            description: '',
            status: 'idle',
            locked: false,
            collapsed: false,
            color: '#4F46E5',
            extensionId: 'example.release',
            extensionVersion: '1.0.0',
            extensionNodeTypeId: 'release-card',
            extensionValues: {},
          },
        },
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      updatedAt: '2026-07-14T16:00:00.000Z',
    });

    expect(() => sanitizeCanvasExtensionData(document)).toThrow();
  });
});
