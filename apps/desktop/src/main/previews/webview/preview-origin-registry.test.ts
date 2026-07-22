import { describe, expect, it, vi } from 'vitest';

import { createPreviewOriginRegistry } from './preview-origin-registry.js';

describe('createPreviewOriginRegistry', () => {
  it('resolves the allowed origin for a guest session by re-resolving its partition session', () => {
    const sessions = new Map<string, symbol>();
    const resolvePartitionSession = vi.fn((partition: string) => {
      let session = sessions.get(partition);
      if (!session) {
        session = Symbol(partition);
        sessions.set(partition, session);
      }
      return session;
    });
    const registry = createPreviewOriginRegistry(resolvePartitionSession);
    registry.setAllowedOrigin('preview:p1:n1', 'https://app.staging.com');

    const guestSession = resolvePartitionSession('preview:p1:n1');
    expect(registry.allowedOriginForGuestSession(guestSession)).toBe('https://app.staging.com');
  });

  it('returns null (loopback mode) for a partition with no registered origin', () => {
    const registry = createPreviewOriginRegistry((partition) => Symbol(partition));
    expect(registry.allowedOriginForGuestSession(Symbol('unregistered'))).toBeNull();
  });

  it('clears the registration when the origin is set back to null', () => {
    const registry = createPreviewOriginRegistry((partition) => partition);
    registry.setAllowedOrigin('preview:p1:n1', 'https://app.staging.com');
    expect(registry.allowedOriginForGuestSession('preview:p1:n1')).toBe('https://app.staging.com');
    registry.setAllowedOrigin('preview:p1:n1', null);
    expect(registry.allowedOriginForGuestSession('preview:p1:n1')).toBeNull();
  });

  it('never confuses two different partitions even when set in overlapping order', () => {
    const registry = createPreviewOriginRegistry((partition) => partition);
    registry.setAllowedOrigin('preview:p1:n1', 'https://app.staging.com');
    registry.setAllowedOrigin('preview:p1:n1:comparison-right', 'https://app.staging.com');
    registry.setAllowedOrigin('preview:p1:n2', null);
    expect(registry.allowedOriginForGuestSession('preview:p1:n1')).toBe('https://app.staging.com');
    expect(registry.allowedOriginForGuestSession('preview:p1:n1:comparison-right')).toBe(
      'https://app.staging.com',
    );
    expect(registry.allowedOriginForGuestSession('preview:p1:n2')).toBeNull();
  });
});
