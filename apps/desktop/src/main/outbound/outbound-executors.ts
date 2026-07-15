import { rm } from 'node:fs/promises';

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
