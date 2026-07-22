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

  it('still accepts loopback URLs when an unrelated allowed origin is configured', () => {
    expect(
      validatedSurfaceUrl('http://127.0.0.1:41000/app', {
        allowedOrigin: 'https://app.staging.com',
      }).port,
    ).toBe('41000');
  });

  it('accepts the configured external origin and rejects any other remote origin', () => {
    const url = validatedSurfaceUrl('https://app.staging.com/dashboard', {
      allowedOrigin: 'https://app.staging.com',
    });
    expect(url.hostname).toBe('app.staging.com');
    expect(() =>
      validatedSurfaceUrl('https://evil.example.com/', {
        allowedOrigin: 'https://app.staging.com',
      }),
    ).toThrow('loopback');
  });

  it('rejects credentials and non-http(s) schemes even for the configured origin', () => {
    expect(() =>
      validatedSurfaceUrl('https://user:pass@app.staging.com/', {
        allowedOrigin: 'https://app.staging.com',
      }),
    ).toThrow('credentials');
    expect(() =>
      validatedSurfaceUrl('file:///tmp/x', { allowedOrigin: 'https://app.staging.com' }),
    ).toThrow('HTTP');
  });

  it('does not require an explicit port for the configured external origin', () => {
    expect(() =>
      validatedSurfaceUrl('https://app.staging.com/', { allowedOrigin: 'https://app.staging.com' }),
    ).not.toThrow();
  });
});
