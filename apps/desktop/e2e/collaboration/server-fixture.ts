import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export interface CollaborationServerFixture {
  readonly httpUrl: string;
  readonly webSocketUrl: string;
  readonly ownerAccessToken: string;
  stop(): Promise<void>;
}

const SERVER_ENTRY = resolve(import.meta.dirname, '../../../collab-server/dist/index.js');
const ADMIN_TOKEN = 'electron-e2e-admin-token-at-least-24-chars';

export async function startCollaborationServer(): Promise<CollaborationServerFixture> {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-collaboration-e2e-'));
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...processEnv(),
      NODE_ENV: 'test',
      FORGEBOARD_COLLAB_HOST: '127.0.0.1',
      FORGEBOARD_COLLAB_PORT: '0',
      FORGEBOARD_COLLAB_DATABASE_PATH: join(root, 'collaboration.sqlite'),
      FORGEBOARD_COLLAB_SIGNING_KEY: 'electron-e2e-signing-key-with-at-least-thirty-two-bytes',
      FORGEBOARD_COLLAB_ADMIN_TOKEN: ADMIN_TOKEN,
      FORGEBOARD_COLLAB_ALLOWED_ORIGINS: 'forgeboard://desktop',
      FORGEBOARD_COLLAB_REQUIRE_ORIGIN: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const httpUrl = await listeningUrl(child);
    const ownerAccessToken = await createOwnerRoom(httpUrl);
    return {
      httpUrl,
      webSocketUrl: httpUrl.replace(/^http:/u, 'ws:'),
      ownerAccessToken,
      stop: async () => {
        await stopProcess(child);
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await stopProcess(child);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function listeningUrl(child: ChildProcess): Promise<string> {
  if (child.stdout === null || child.stderr === null) {
    throw new Error('The collaboration server did not expose output pipes.');
  }
  const stdout = child.stdout;
  const stderr = child.stderr;
  stdout.setEncoding('utf8');
  stderr.setEncoding('utf8');
  return await new Promise<string>((resolvePromise, reject) => {
    let output = '';
    let errors = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out starting collaboration server. ${errors}`));
    }, 15_000);
    const onOutput = (chunk: string): void => {
      output += chunk;
      const match = /listening on (http:\/\/[^;\s]+);/u.exec(output);
      if (match?.[1] === undefined) return;
      cleanup();
      resolvePromise(loopbackUrl(match[1]));
    };
    const onError = (chunk: string): void => {
      errors = `${errors}${chunk}`.slice(-4_096);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(
        new Error(`Collaboration server exited before listening (${String(code)}). ${errors}`),
      );
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      stdout.off('data', onOutput);
      stderr.off('data', onError);
      child.off('exit', onExit);
    };
    stdout.on('data', onOutput);
    stderr.on('data', onError);
    child.once('exit', onExit);
  });
}

function loopbackUrl(reported: string): string {
  const url = new URL(reported);
  if (url.hostname === '[::]' || url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
  return url.toString().replace(/\/$/u, '');
}

async function createOwnerRoom(httpUrl: string): Promise<string> {
  const response = await fetch(`${httpUrl}/v1/rooms`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      roomId: 'invite-e2e-room',
      owner: { id: 'owner-e2e', displayName: 'Owner E2E' },
    }),
  });
  const body = (await response.json()) as { accessToken?: unknown };
  if (response.status !== 201 || typeof body.accessToken !== 'string') {
    throw new Error(`Could not bootstrap the E2E collaboration room (${String(response.status)}).`);
  }
  return body.accessToken;
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolvePromise) => child.once('exit', () => resolvePromise()));
  child.kill('SIGTERM');
  const forceTimeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
  let confirmationTimeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        confirmationTimeout = setTimeout(
          () => reject(new Error('The collaboration server did not exit after SIGKILL.')),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(forceTimeout);
    if (confirmationTimeout !== undefined) clearTimeout(confirmationTimeout);
  }
}

function processEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
