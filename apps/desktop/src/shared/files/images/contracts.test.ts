import { describe, expect, it } from 'vitest';

import { ProjectImageLoadResultSchema } from './contracts.js';

const PROJECT_ID = '66cd302d-c25a-4768-94ca-6a3d6fefef04';
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAAA';

describe('project image response contracts', () => {
  it('accepts only an identity-bound signature-valid inline image payload', () => {
    expect(
      ProjectImageLoadResultSchema.parse({
        status: 'available',
        projectId: PROJECT_ID,
        relativePath: 'design/safe.png',
        dataUrl: PNG_DATA_URL,
      }),
    ).toEqual({
      status: 'available',
      projectId: PROJECT_ID,
      relativePath: 'design/safe.png',
      dataUrl: PNG_DATA_URL,
    });
  });

  it.each([
    'https://attacker.invalid/tracker.png',
    'data:image/svg+xml;base64,PHN2Zy8+',
    'data:image/png;base64,R0lGODlhAAAA',
    'data:image/png;base64,',
    'data:image/png;base64,not-valid-encoding',
  ])('rejects forged or active image payload %j', (dataUrl) => {
    expect(
      ProjectImageLoadResultSchema.safeParse({
        status: 'available',
        projectId: PROJECT_ID,
        relativePath: 'design/safe.png',
        dataUrl,
      }).success,
    ).toBe(false);
  });

  it('rejects renderer-facing metadata that could disagree with the validated bytes', () => {
    expect(
      ProjectImageLoadResultSchema.safeParse({
        status: 'available',
        projectId: PROJECT_ID,
        relativePath: 'design/safe.png',
        dataUrl: PNG_DATA_URL,
        mimeType: 'image/gif',
        sizeBytes: 999,
        sha256: 'a'.repeat(64),
      }).success,
    ).toBe(false);
  });
});
