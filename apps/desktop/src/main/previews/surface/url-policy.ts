import { isIP } from 'node:net';

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Validates a preview surface URL. Loopback addresses (dev-server mode) are
 * always allowed and still require an explicit port. When `allowedOrigin` is
 * supplied (URL mode — an external site the renderer configured for this
 * node), a URL whose origin matches it is also accepted, with no port
 * requirement (external sites commonly rely on the default 80/443 port).
 */
export function validatedSurfaceUrl(
  candidate: string,
  opts?: { allowedOrigin?: string | undefined },
): URL {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('Preview surface URLs must be valid absolute URLs.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Preview surfaces support only local HTTP or HTTPS URLs.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('Preview surface URLs cannot contain credentials.');
  }
  if (isLoopbackHost(url.hostname)) {
    if (url.port === '') throw new Error('Preview surface URLs require an allocated local port.');
    return url;
  }
  if (opts?.allowedOrigin !== undefined && url.origin === opts.allowedOrigin) return url;
  throw new Error('Preview surfaces can connect only to loopback addresses.');
}

export function isAllowedSurfaceRequest(candidate: string, allowed: URL): boolean {
  if (candidate === 'about:blank' || candidate.startsWith('data:')) return true;
  if (candidate.startsWith('blob:')) {
    return isAllowedSurfaceRequest(candidate.slice('blob:'.length), allowed);
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  const allowedProtocol =
    parsed.protocol === allowed.protocol ||
    (allowed.protocol === 'http:' && parsed.protocol === 'ws:') ||
    (allowed.protocol === 'https:' && parsed.protocol === 'wss:');
  return (
    allowedProtocol &&
    parsed.hostname === allowed.hostname &&
    effectivePort(parsed) === effectivePort(allowed) &&
    parsed.username === '' &&
    parsed.password === ''
  );
}

export function redactedConsoleSource(candidate: string): string | null {
  if (candidate === '') return null;
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol) || !isLoopbackHost(url.hostname)) return null;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().slice(0, 2_048);
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (LOOPBACK_NAMES.has(normalized)) return true;
  const family = isIP(normalized);
  if (family === 4) return normalized.startsWith('127.');
  return false;
}

function effectivePort(url: URL): string {
  if (url.port !== '') return url.port;
  if (url.protocol === 'http:' || url.protocol === 'ws:') return '80';
  if (url.protocol === 'https:' || url.protocol === 'wss:') return '443';
  return '';
}
