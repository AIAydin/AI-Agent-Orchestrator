import { access } from 'node:fs/promises';

import { GitExecutor, RepositoryService } from '@forgeboard/git-engine';
import { setupEnvironment } from 'dugite';

const TRUSTED_RUNTIME_NAMES = [
  'PATH',
  'GIT_EXEC_PATH',
  'GIT_CONFIG_SYSTEM',
  'GIT_TEMPLATE_DIR',
  'GIT_SSL_CAINFO',
  'PREFIX',
] as const;

export interface BundledGitRuntime {
  executable: string;
  environment: Readonly<Record<string, string>>;
}

let cachedRuntime: BundledGitRuntime | undefined;

/**
 * Resolve Artemis's packaged Git distribution. The result is process-owned and is never
 * influenced by repository content, renderer input, imported settings, or the host PATH.
 */
export function bundledGitRuntime(): BundledGitRuntime {
  if (cachedRuntime !== undefined) return cachedRuntime;
  const { env, gitLocation } = setupEnvironment({});
  const environment = Object.fromEntries(
    TRUSTED_RUNTIME_NAMES.flatMap((name) => {
      const value = env[name];
      return value === undefined ? [] : [[name, value] as const];
    }),
  );
  cachedRuntime = { executable: gitLocation, environment };
  return cachedRuntime;
}

export function createBundledGitRepositoryService(): RepositoryService {
  const runtime = bundledGitRuntime();
  return new RepositoryService(
    new GitExecutor({
      executable: runtime.executable,
      trustedRuntimeEnvironment: runtime.environment,
    }),
  );
}

export async function verifyBundledGit(): Promise<string> {
  const runtime = bundledGitRuntime();
  await access(runtime.executable);
  const result = await createBundledGitRepositoryService().git.run(['--version'], {
    timeoutMs: 5_000,
  });
  const version = result.stdout.trim();
  if (!/^git version \d+\./u.test(version)) {
    throw new Error('Artemis bundled Git returned an invalid version response.');
  }
  return version;
}
