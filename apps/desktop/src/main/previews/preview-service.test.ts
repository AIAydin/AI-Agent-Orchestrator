import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  canonicalPreviewCwd,
  PreviewService,
  type PreviewProcessRequest,
  type PreviewSessionSnapshot,
  type PreviewStartRequest,
  validatePreviewUrl,
  validateTrustedHosts,
} from './preview-service.js';

const SERVER_SOURCE = String.raw`
const http = require('node:http');
const portArg = process.argv.find((value) => value.startsWith('--port='));
const hostArg = process.argv.find((value) => value.startsWith('--host='));
const port = Number(portArg ? portArg.slice(7) : process.env.PREVIEW_PORT);
const host = hostArg ? hostArg.slice(7) : process.env.PREVIEW_HOST;
const label = process.env.LABEL || 'fixture';
const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end(label);
});
server.listen(port, host, () => console.log('READY ' + label + ' ' + host + ':' + port));
function shutdown() { server.close(() => process.exit(0)); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
`;

const HOLD_SOURCE = String.raw`
console.log('HOLDING');
const timer = setInterval(() => {}, 1000);
function shutdown() { clearInterval(timer); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
`;

const services = new Set<PreviewService>();
const temporaryDirectories: string[] = [];
const occupiedServers = new Set<Server>();

afterEach(async () => {
  await Promise.all([...services].map((service) => service.dispose()));
  services.clear();
  await Promise.all(
    [...occupiedServers].map(
      (server) =>
        new Promise<void>((resolvePromise) => {
          server.close(() => resolvePromise());
        }),
    ),
  );
  occupiedServers.clear();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createWorktree(): Promise<{ root: string; cwd: string }> {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-preview-test-'));
  temporaryDirectories.push(root);
  const cwd = join(root, 'worktree');
  await mkdir(cwd);
  return { root, cwd };
}

function processRequest(id: string, label = id): PreviewProcessRequest {
  return {
    id,
    executable: process.execPath,
    args: ['-e', SERVER_SOURCE, '--', '--port={PORT}', '--host={HOST}'],
    environment: { LABEL: label },
    port: {
      envName: 'PREVIEW_PORT',
      argumentPlaceholder: '{PORT}',
      hostEnvName: 'PREVIEW_HOST',
      hostArgumentPlaceholder: '{HOST}',
      urlPath: '/ready',
    },
    readiness: {
      mode: 'all',
      tcp: true,
      http: { path: '/health', acceptedStatusCodes: [200] },
      output: { pattern: `READY ${label}` },
      timeoutMs: 5_000,
    },
  };
}

function request(
  root: string,
  cwd: string,
  processes: PreviewProcessRequest[],
  portRange: { start: number; end: number } = { start: 43_100, end: 43_199 },
): PreviewStartRequest {
  return {
    approvedWorktreeRoot: root,
    cwd,
    processes,
    portRange,
    trustedHosts: ['127.0.0.1', 'localhost', '::1'],
    networkPolicy: 'loopback-only',
    startupTimeoutMs: 5_000,
  };
}

function service(): PreviewService {
  const instance = new PreviewService({ gracefulStopMs: 250, forceStopMs: 250 });
  services.add(instance);
  return instance;
}

async function waitForDead(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    } catch {
      return;
    }
  }
  throw new Error(`Process ${String(pid)} was not cleaned up.`);
}

async function occupyEphemeralPort(): Promise<{ server: Server; port: number }> {
  while (true) {
    const server = createServer();
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0 }, () => resolvePromise());
    });
    const address = server.address();
    if (address && typeof address !== 'string' && address.port <= 65_532) {
      occupiedServers.add(server);
      return { server, port: address.port };
    }
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  }
}

function processPids(snapshot: PreviewSessionSnapshot): number[] {
  return snapshot.processes.flatMap((processSnapshot) =>
    processSnapshot.pid === null ? [] : [processSnapshot.pid],
  );
}

describe('PreviewService', () => {
  it('runs two simultaneous fixture servers with distinct ports, streamed output, and clean stop', async () => {
    const worktree = await createWorktree();
    const output: string[] = [];
    const instance = new PreviewService({
      gracefulStopMs: 250,
      forceStopMs: 250,
      onEvent(event) {
        if (event.type === 'output') output.push(event.data.toString('utf8'));
      },
    });
    services.add(instance);

    const started = await instance.start(
      request(worktree.root, worktree.cwd, [
        processRequest('web', 'web'),
        processRequest('api', 'api'),
      ]),
    );

    expect(started.status).toBe('ready');
    expect(started.processes.map((processSnapshot) => processSnapshot.status)).toEqual([
      'ready',
      'ready',
    ]);
    const ports = started.processes.map((processSnapshot) => processSnapshot.port);
    expect(new Set(ports).size).toBe(2);
    expect(output.join('')).toContain('READY web 127.0.0.1:');
    expect(output.join('')).toContain('READY api 127.0.0.1:');
    await expect(fetch(started.processes[0]?.previewUrl ?? '')).resolves.toMatchObject({
      status: 200,
    });
    await expect(fetch(started.processes[1]?.previewUrl ?? '')).resolves.toMatchObject({
      status: 200,
    });

    const pids = processPids(started);
    const stopped = await instance.stop(started.id);
    expect(stopped.status).toBe('stopped');
    await Promise.all(pids.map(waitForDead));
  });

  it('skips a port already occupied outside the service', async () => {
    const worktree = await createWorktree();
    const occupied = await occupyEphemeralPort();
    const instance = service();

    const started = await instance.start(
      request(worktree.root, worktree.cwd, [processRequest('web')], {
        start: occupied.port,
        end: occupied.port + 3,
      }),
    );

    expect(started.processes[0]?.port).toBe(occupied.port + 1);
    await instance.stop(started.id);
  });

  it('cancels startup and cleans a process that never becomes ready', async () => {
    const worktree = await createWorktree();
    const instance = service();
    const controller = new AbortController();
    const start = instance.start(
      request(worktree.root, worktree.cwd, [
        {
          id: 'waiting',
          executable: process.execPath,
          args: ['-e', HOLD_SOURCE],
          readiness: { output: { pattern: 'WILL NEVER MATCH' }, timeoutMs: 5_000 },
        },
      ]),
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 100);

    await expect(start).rejects.toMatchObject({ name: 'AbortError' });
    const cancelled = instance.list()[0];
    expect(cancelled?.status).toBe('cancelled');
    for (const pid of cancelled ? processPids(cancelled) : []) await waitForDead(pid);
  });

  it('rejects canonical paths outside the approved root, including a symlink escape', async () => {
    const worktree = await createWorktree();
    const outside = await mkdtemp(join(tmpdir(), 'forgeboard-preview-outside-'));
    temporaryDirectories.push(outside);
    const escape = join(worktree.root, 'escape');
    await symlink(outside, escape, 'dir');
    const instance = service();

    await expect(canonicalPreviewCwd(worktree.root, outside)).rejects.toThrow(
      'escapes the approved worktree root',
    );
    await expect(canonicalPreviewCwd(worktree.root, escape)).rejects.toThrow(
      'escapes the approved worktree root',
    );
    await expect(
      instance.start(request(worktree.root, outside, [processRequest('web')])),
    ).rejects.toThrow('escapes the approved worktree root');
    expect(instance.list()).toHaveLength(0);
  });

  it('forces loopback-only child defaults and rejects outbound preview targets', async () => {
    const worktree = await createWorktree();
    const instance = service();
    const environmentSource = String.raw`
const http = require('node:http');
const details = {
  host: process.env.PREVIEW_HOST,
  port: process.env.PREVIEW_PORT,
  httpProxy: process.env.HTTP_PROXY,
  httpsProxy: process.env.HTTPS_PROXY,
  noProxy: process.env.NO_PROXY
};
const server = http.createServer((_request, response) => response.end('local'));
server.listen(Number(details.port), details.host, () => console.log('POLICY ' + JSON.stringify(details)));
function shutdown() { server.close(() => process.exit(0)); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
`;
    const started = await instance.start({
      ...request(worktree.root, worktree.cwd, [
        {
          id: 'policy',
          executable: process.execPath,
          args: ['-e', environmentSource],
          environment: {
            PREVIEW_HOST: '0.0.0.0',
            HTTP_PROXY: 'http://outside.invalid:8080',
          },
          port: { envName: 'PREVIEW_PORT', hostEnvName: 'PREVIEW_HOST' },
          readiness: { output: { pattern: 'POLICY' }, tcp: true, mode: 'all' },
        },
      ]),
      maxLogBytesPerProcess: 1_024,
    });
    const retained = Buffer.concat(
      started.processes[0]?.logs.map((log) => log.data) ?? [],
    ).toString('utf8');

    expect(retained).toContain('"host":"127.0.0.1"');
    expect(retained).toContain('"httpProxy":"http://127.0.0.1:9"');
    expect(retained).toContain('"httpsProxy":"http://127.0.0.1:9"');
    expect(retained).toContain('"noProxy":"127.0.0.1,localhost,::1"');
    expect(started.processes[0]?.previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(validateTrustedHosts(['localhost', '::1'])).toEqual(['127.0.0.1', 'localhost', '::1']);
    expect(() => validateTrustedHosts(['example.com'])).toThrow('loopback-only');
    expect(() => validatePreviewUrl('https://example.com:4400', ['127.0.0.1'], [4400])).toThrow(
      'not trusted',
    );
    expect(() => validatePreviewUrl('http://0.0.0.0:4400', ['127.0.0.1'], [4400])).toThrow(
      'not trusted',
    );
    expect(() => validatePreviewUrl('file:///tmp/index.html', ['127.0.0.1'])).toThrow(
      'HTTP or HTTPS',
    );

    await instance.stop(started.id);
  });

  it.each([
    ['interrupt', 'interrupted'],
    ['kill', 'killed'],
  ] as const)(
    '%s terminates and cleans the complete process group',
    async (method, expectedStatus) => {
      const worktree = await createWorktree();
      const instance = service();
      const started = await instance.start(
        request(worktree.root, worktree.cwd, [
          {
            id: 'worker',
            executable: process.execPath,
            args: ['-e', HOLD_SOURCE],
            readiness: { output: { pattern: 'HOLDING' } },
          },
        ]),
      );
      const pids = processPids(started);

      const finished = await instance[method](started.id);

      expect(finished.status).toBe(expectedStatus);
      await Promise.all(pids.map(waitForDead));
    },
  );

  it('bounds retained raw logs while preserving the newest exact bytes', async () => {
    const worktree = await createWorktree();
    const instance = service();
    const noisySource = String.raw`
const http = require('node:http');
const port = Number(process.env.PREVIEW_PORT);
process.stdout.write('x'.repeat(4096));
const server = http.createServer((_request, response) => response.end('ok'));
server.listen(port, process.env.PREVIEW_HOST, () => process.stdout.write('END-MARKER'));
function shutdown() { server.close(() => process.exit(0)); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
`;
    const started = await instance.start({
      ...request(worktree.root, worktree.cwd, [
        {
          id: 'noisy',
          executable: process.execPath,
          args: ['-e', noisySource],
          port: { envName: 'PREVIEW_PORT', hostEnvName: 'PREVIEW_HOST' },
          readiness: { tcp: true, output: { pattern: 'END-MARKER' }, mode: 'all' },
        },
      ]),
      maxLogBytesPerProcess: 1_024,
    });
    const snapshot = started.processes[0];
    const bytes = Buffer.concat(snapshot?.logs.map((log) => log.data) ?? []);

    expect(snapshot?.retainedLogBytes).toBe(1_024);
    expect(bytes.byteLength).toBe(1_024);
    expect(bytes.toString('utf8')).toMatch(/END-MARKER$/);
    await instance.stop(started.id);
  });

  it('returns canonical in-root working directories', async () => {
    const worktree = await createWorktree();
    await expect(canonicalPreviewCwd(worktree.root, worktree.cwd)).resolves.toBe(
      await realpath(worktree.cwd),
    );
  });
});
