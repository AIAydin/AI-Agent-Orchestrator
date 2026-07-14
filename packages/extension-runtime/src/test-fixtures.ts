export function exampleCanvasExtension(version = '1.0.0'): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'example.notes',
    name: 'Example notes',
    version,
    description: 'Adds a declarative decision note to the canvas.',
    publisher: 'Example publisher',
    requestedPermissions: ['canvas.node.register', 'canvas.data.persist'],
    contributes: {
      agentAdapters: [],
      canvasNodeTypes: [
        {
          id: 'decision',
          displayName: 'Decision',
          description: 'Records a bounded project decision.',
          category: 'Planning',
          icon: 'note',
          color: '#4F46E5',
          capabilities: ['context-source', 'human-editable'],
          fields: [
            {
              id: 'summary',
              kind: 'multiline',
              label: 'Summary',
              required: true,
              maxLength: 4_000,
            },
            {
              id: 'status',
              kind: 'select',
              label: 'Status',
              options: [
                { label: 'Proposed', value: 'proposed' },
                { label: 'Accepted', value: 'accepted' },
              ],
              defaultValue: 'proposed',
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
        },
      ],
    },
  };
}
