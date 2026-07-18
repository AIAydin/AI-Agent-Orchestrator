import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const logPath = requiredEnvironment('FORGEBOARD_E2E_TRIPWIRE_LOG');
const realMain = requiredEnvironment('FORGEBOARD_E2E_REAL_MAIN');
record('tripwire.entry', 'local');
const { app, session } = require('electron');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`Missing ${name}.`);
  return value;
}

function record(transport, target) {
  appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, target, transport })}\n`, 'utf8');
}

function inspectUrl(transport, candidate) {
  let url;
  try {
    url = new URL(candidate instanceof URL ? candidate.href : String(candidate));
  } catch {
    return;
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return;
  rejectNetworkAttempt(transport, url.href);
}

function rejectNetworkAttempt(transport, target) {
  record(transport, target);
  throw new Error(`Default-solo network tripwire rejected ${transport} request to ${target}.`);
}

function guardRequest(arguments_, protocol, transport) {
  const first = arguments_[0];
  const url =
    first instanceof URL || typeof first === 'string' ? new URL(String(first)) : undefined;
  const options = url === undefined ? (first ?? {}) : (arguments_[1] ?? {});
  const rawHostname = String(options.hostname ?? options.host ?? url?.hostname ?? 'localhost');
  const port = options.port === undefined ? '' : `:${String(options.port)}`;
  const target = `${options.protocol ?? url?.protocol ?? protocol}//${rawHostname}${port}${options.path ?? url?.pathname ?? '/'}`;
  rejectNetworkAttempt(transport, target);
}

function wrapRequest(module, protocol) {
  const originalRequest = module.request;
  const originalGet = module.get;
  module.request = function tripwireRequest(...arguments_) {
    guardRequest(arguments_, protocol, `${protocol.slice(0, -1)}.request`);
    return Reflect.apply(originalRequest, this, arguments_);
  };
  module.get = function tripwireGet(...arguments_) {
    guardRequest(arguments_, protocol, `${protocol.slice(0, -1)}.get`);
    return Reflect.apply(originalGet, this, arguments_);
  };
}

function socketTarget(arguments_) {
  const first = arguments_[0];
  if (typeof first === 'string') return undefined;
  if (typeof first === 'number') {
    return {
      host: typeof arguments_[1] === 'string' ? arguments_[1] : 'localhost',
      port: first,
    };
  }
  if (first?.path !== undefined) return undefined;
  return { host: first?.host ?? 'localhost', port: first?.port ?? 'unknown' };
}

function guardSocket(arguments_) {
  const target = socketTarget(arguments_);
  if (target !== undefined) {
    rejectNetworkAttempt('socket.connect', `${String(target.host)}:${String(target.port)}`);
  }
}

function wrapSockets() {
  for (const method of ['connect', 'createConnection']) {
    const original = net[method];
    net[method] = function tripwireConnection(...arguments_) {
      guardSocket(arguments_);
      return Reflect.apply(original, this, arguments_);
    };
  }
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function tripwireSocketConnect(...arguments_) {
    guardSocket(arguments_);
    return Reflect.apply(originalConnect, this, arguments_);
  };
}

function wrapFetch() {
  if (typeof globalThis.fetch !== 'function') return;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function tripwireFetch(input, ...rest) {
    inspectUrl(
      'fetch',
      typeof Request === 'function' && input instanceof Request ? input.url : input,
    );
    return Reflect.apply(originalFetch, this, [input, ...rest]);
  };
}

function wrapWebSocket() {
  if (typeof globalThis.WebSocket !== 'function') return;
  const OriginalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class TripwireWebSocket extends OriginalWebSocket {
    constructor(...arguments_) {
      inspectUrl('websocket', arguments_[0]);
      super(...arguments_);
    }
  };
}

function wrapElectronSession() {
  const webRequest = session.defaultSession.webRequest;
  const original = webRequest.onBeforeRequest.bind(webRequest);
  webRequest.onBeforeRequest = (filter, listener) => {
    if (listener === null) return original(filter, null);
    return original(filter, (details, callback) => {
      const url = new URL(details.url);
      if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
        record('electron.session', url.href);
        callback({ cancel: true });
        return;
      }
      listener(details, callback);
    });
  };
  original(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      const url = new URL(details.url);
      record('electron.session', url.href);
      callback({ cancel: true });
    },
  );
  record('tripwire.ready', 'local');
}

wrapFetch();
wrapRequest(http, 'http:');
wrapRequest(https, 'https:');
wrapSockets();
wrapWebSocket();
record('tripwire.bootstrap', 'local');
void app.whenReady().then(wrapElectronSession);

await import(pathToFileURL(realMain).href);
