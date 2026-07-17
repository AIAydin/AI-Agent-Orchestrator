import { describe, expect, it } from 'vitest';

import {
  isAllowedSurfaceRequest,
  redactedConsoleSource,
  validatedSurfaceUrl,
} from './url-policy.js';

describe('preview surface URL policy', () => {
  it('accepts allocated loopback URLs and rejects remote or credentialed URLs', () => {
    expect(validatedSurfaceUrl('http://127.0.0.1:41000/app').port).toBe('41000');
    expect(() => validatedSurfaceUrl('https://example.com:41000/')).toThrow('loopback');
    expect(() => validatedSurfaceUrl('http://user:secret@127.0.0.1:41000/')).toThrow('credentials');
    expect(() => validatedSurfaceUrl('file:///tmp/private')).toThrow('HTTP');
  });

  it('allows only same-origin HTTP and WebSocket resources', () => {
    const allowed = validatedSurfaceUrl('http://127.0.0.1:41000/app');
    expect(isAllowedSurfaceRequest('http://127.0.0.1:41000/script.js', allowed)).toBe(true);
    expect(isAllowedSurfaceRequest('ws://127.0.0.1:41000/socket', allowed)).toBe(true);
    expect(isAllowedSurfaceRequest('http://127.0.0.1:41001/private', allowed)).toBe(false);
    expect(isAllowedSurfaceRequest('https://127.0.0.1:41000/', allowed)).toBe(false);
    expect(isAllowedSurfaceRequest('http://localhost:41000/', allowed)).toBe(false);
  });

  it('redacts query strings, fragments, and remote console sources', () => {
    expect(redactedConsoleSource('http://127.0.0.1:41000/app.js?token=secret#fragment')).toBe(
      'http://127.0.0.1:41000/app.js',
    );
    expect(redactedConsoleSource('https://example.com/app.js?secret=yes')).toBeNull();
  });
});
