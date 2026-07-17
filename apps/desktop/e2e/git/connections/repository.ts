import { execFileSync } from 'node:child_process';

import type { Page } from '@playwright/test';

import type { IpcResult, Project } from '../../../src/shared/application/contracts.js';

export async function currentProjectPath(page: Page): Promise<string> {
  return await page.evaluate(async () => {
    const forgeboard = (
      window as unknown as {
        forgeboard: { projects: { recent(): Promise<IpcResult<Project[]>> } };
      }
    ).forgeboard;
    const result = await forgeboard.projects.recent();
    if (!result.ok) throw new Error(result.error.message);
    const project = result.value.find((candidate) => !candidate.missing);
    if (project === undefined) throw new Error('The local demo project is missing.');
    return project.path;
  });
}

export function git(repository: string, arguments_: readonly string[]): string {
  return execFileSync('git', ['-C', repository, ...arguments_], {
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function gitRemoteUrl(repository: string, name: string): string | null {
  try {
    return git(repository, ['remote', 'get-url', name]);
  } catch {
    return null;
  }
}

export function gitRef(repository: string, ref: string): string | null {
  try {
    return git(repository, ['rev-parse', '--verify', ref]);
  } catch {
    return null;
  }
}
