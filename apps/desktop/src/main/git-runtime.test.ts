import { describe, expect, it } from 'vitest';

import {
  bundledGitRuntime,
  createBundledGitRepositoryService,
  verifyBundledGit,
} from './git-runtime.js';

describe('bundled Git runtime', () => {
  it('uses the packaged executable with a bounded trusted environment', async () => {
    const runtime = bundledGitRuntime();
    expect(runtime.executable).toMatch(
      /[/\\]dugite[/\\]git[/\\](?:bin[/\\]git|cmd[/\\]git\.exe)$/u,
    );
    expect(Object.keys(runtime.environment).sort()).toEqual(
      expect.arrayContaining(['GIT_EXEC_PATH', 'PATH']),
    );
    expect(Object.keys(runtime.environment)).not.toContain('GIT_DIR');
    expect(await verifyBundledGit()).toMatch(/^git version /u);

    const result = await createBundledGitRepositoryService().git.run(['config', '--list'], {
      allowNonZeroExit: true,
    });
    expect(result.executable).toBe(runtime.executable);
  });
});
