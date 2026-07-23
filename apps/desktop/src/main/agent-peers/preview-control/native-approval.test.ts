import { describe, expect, it } from 'vitest';

import type { PreviewActionApprovalRequest } from './contracts.js';
import { previewActionMessage } from './native-approval.js';

describe('native preview action approval', () => {
  it('keeps cancel as the safe default and displays exact bounded action authority', () => {
    const message = previewActionMessage(request());

    expect(message).toMatchObject({
      type: 'warning',
      buttons: ['Cancel', 'Allow once'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    expect(message.message).toContain('type into "Search"');
    expect(message.detail).toContain('Site: "https://example.com"');
    expect(message.detail).toContain('Text (700 characters):');
    expect(message.detail).toContain(`"${'x'.repeat(700)}"`);
  });

  it('escapes website and agent control characters in every displayed value', () => {
    const message = previewActionMessage(
      request({
        agentName: 'Agent\nspoof',
        previewName: 'Board\u202ehidden',
        elementName: 'Search\u200bbox',
        textPreview: 'hello\nworld',
      }),
    );

    expect(message.message).toContain('Agent\\nspoof');
    expect(message.detail).toContain('Board\\u202ehidden');
    expect(message.detail).toContain('Search\\u200bbox');
    expect(message.detail).toContain('hello\\nworld');
  });
});

function request(
  overrides: {
    agentName?: string;
    previewName?: string;
    elementName?: string;
    textPreview?: string;
  } = {},
): PreviewActionApprovalRequest {
  const textPreview = overrides.textPreview ?? 'x'.repeat(700);
  return {
    projectId: 'project-1',
    agentNodeId: 'agent-1',
    agentName: overrides.agentName ?? 'Agent A',
    previewNodeId: 'preview-1',
    previewName: overrides.previewName ?? 'Planning board',
    edgeId: 'edge-1',
    intent: {
      pageVersion: 'page-version-1',
      url: 'https://example.com/board',
      origin: 'https://example.com',
      action: 'type',
      element: {
        handle: '11111111-1111-4111-8111-111111111111',
        kind: 'text-input',
        name: overrides.elementName ?? 'Search',
        disabled: false,
        editable: true,
        sensitive: false,
        consequential: false,
        userOnly: false,
        destination: null,
      },
      textPreview,
      textLength: textPreview.length,
      consequential: true,
    },
  };
}
