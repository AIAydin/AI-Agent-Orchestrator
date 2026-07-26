import { rm } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';

import type { RepositoryService } from '@forgeboard/git-engine';

import type { DockerReadinessInput } from '../../shared/docker/contracts.js';
import { pullDockerImage, type BeforeDockerCommand } from '../docker/docker-runtime.js';
import {
  assertOutboundExecutionPermit,
  type OutboundExecutionPermit,
} from './outbound-action-gate.js';

/** Low-level outbound executors. Callers must invoke these only through OutboundActionGate. */
export async function executeGitClone(
  permit: OutboundExecutionPermit,
  repositories: RepositoryService,
  remoteUrl: string,
  destinationPath: string,
): Promise<void> {
  assertOutboundExecutionPermit(permit);
  let cloned = false;
  try {
    await repositories.git.run(['clone', '--no-checkout', '--', remoteUrl, destinationPath], {
      cwd: process.cwd(),
      timeoutMs: 120_000,
    });
    cloned = true;
    await repositories.git.run(['-C', destinationPath, 'read-tree', 'HEAD']);
    await repositories.git.runGuarded(
      ['-C', destinationPath, 'reset', '--hard', 'HEAD'],
      {
        repositoryPath: destinationPath,
        operation: 'checkout-smudge',
        attributeSource: 'index',
      },
      { timeoutMs: 120_000 },
    );
  } catch (error) {
    if (cloned) await rm(destinationPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Low-level outbound executor. Callers must invoke it only through OutboundActionGate. */
export async function executeDockerImagePull(
  permit: OutboundExecutionPermit,
  input: DockerReadinessInput,
  beforeCommand?: BeforeDockerCommand,
): Promise<void> {
  assertOutboundExecutionPermit(permit);
  await pullDockerImage(input, {}, beforeCommand);
}

const MAX_UPDATE_RESPONSE_BYTES = 1024 * 1024;
const UPDATE_REQUEST_TIMEOUT_MS = 10_000;

/** Bounded HTTP transport for an explicitly approved update check. Redirects are rejected. */
export async function executeUpdateReleaseRequest(
  permit: OutboundExecutionPermit,
  signal: AbortSignal,
): Promise<string> {
  assertOutboundExecutionPermit(permit);
  const url = new URL(
    'https://api.github.com/repos/AIAydin/AI-Agent-Orchestrator/releases?per_page=20',
  );
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined = undefined;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      signal.removeEventListener('abort', abort);
      operation();
    };
    const fail = (error: Error): void => finish(() => reject(error));
    const req = httpsRequest(
      url,
      {
        method: 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'Artemis-update-check',
          'x-github-api-version': '2022-11-28',
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          fail(
            new Error('The update server redirected unexpectedly; no redirected request was sent.'),
          );
          response.destroy();
          req.destroy();
          return;
        }
        if (status !== 200) {
          fail(new Error(`The update server returned HTTP ${String(status)}.`));
          response.destroy();
          req.destroy();
          return;
        }
        const contentType = response.headers['content-type']
          ?.split(';', 1)[0]
          ?.trim()
          .toLowerCase();
        if (contentType !== 'application/json') {
          fail(new Error('The update server response was not JSON.'));
          response.destroy();
          req.destroy();
          return;
        }
        if (response.headers['content-encoding'] !== undefined) {
          fail(new Error('Compressed update responses are not accepted.'));
          response.destroy();
          req.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer | string) => {
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += value.byteLength;
          if (bytes > MAX_UPDATE_RESPONSE_BYTES) {
            req.destroy(new Error('The update server response exceeded 1 MiB.'));
            return;
          }
          chunks.push(value);
        });
        response.on('end', () => {
          if (bytes > MAX_UPDATE_RESPONSE_BYTES) return;
          finish(() => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        response.on('error', fail);
      },
    );
    const abort = (): void => {
      req.destroy(abortError());
    };
    signal.addEventListener('abort', abort, { once: true });
    req.setTimeout(UPDATE_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('The update check timed out after 10 seconds.'));
    });
    deadline = setTimeout(() => {
      req.destroy(new Error('The update check timed out after 10 seconds.'));
    }, UPDATE_REQUEST_TIMEOUT_MS);
    req.on('error', fail);
    if (signal.aborted) abort();
    else req.end();
  });
}

function abortError(): Error {
  const error = new Error('The update check was cancelled.');
  error.name = 'AbortError';
  return error;
}
