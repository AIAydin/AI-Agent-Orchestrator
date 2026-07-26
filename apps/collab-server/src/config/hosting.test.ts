import { describe, expect, it } from 'vitest';

import { loadCollaborationConfig } from '../config.js';

const PRODUCTION_SECRETS = {
  NODE_ENV: 'production',
  FORGEBOARD_COLLAB_SIGNING_KEY: 'hosting-signing-key-with-at-least-thirty-two-bytes',
  FORGEBOARD_COLLAB_ADMIN_TOKEN: 'hosting-admin-token-at-least-24-characters',
} as const;

describe('collaboration hosting configuration', () => {
  it('uses the hosting platform PORT while preserving an explicit Artemis override', () => {
    expect(loadCollaborationConfig({ ...PRODUCTION_SECRETS, PORT: '10000' }).port).toBe(10_000);
    expect(
      loadCollaborationConfig({
        ...PRODUCTION_SECRETS,
        PORT: '10000',
        FORGEBOARD_COLLAB_PORT: '4321',
      }).port,
    ).toBe(4_321);
  });

  it('keeps the safe development port when no platform port is present', () => {
    expect(
      loadCollaborationConfig({
        NODE_ENV: 'test',
        FORGEBOARD_COLLAB_SIGNING_KEY: 'hosting-signing-key-with-at-least-thirty-two-bytes',
      }).port,
    ).toBe(1_234);
  });
});
