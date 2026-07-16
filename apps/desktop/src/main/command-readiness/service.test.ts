import { describe, expect, it, vi } from 'vitest';

import type { Project } from '../../shared/application/contracts.js';
import { CommandReadinessService } from './service.js';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const project: Project = {
  id: PROJECT_ID,
  name: 'Example project',
  path: '/projects/example',
  openedAt: '2026-07-15T18:00:00.000Z',
  missing: false,
  health: {
    isGitRepository: true,
    branch: 'main',
    dirty: false,
    remotes: [],
    packageManager: 'pnpm',
    frameworks: [],
    scripts: { dev: 'vite', test: 'vitest' },
    hasSubmodules: false,
    sensitiveWarnings: [],
  },
};

function service(
  options: {
    project?: Project;
    scripts?: string[];
    resolveError?: Error;
  } = {},
) {
  const resolveCommand = vi.fn((executable: string, arguments_: readonly string[]) => {
    if (options.resolveError) return Promise.reject(options.resolveError);
    return Promise.resolve({
      executable: `/resolved/${executable}`,
      arguments: [...arguments_],
      identities: [],
    });
  });
  return {
    resolveCommand,
    readiness: new CommandReadinessService({ getProject: () => options.project }, '/home/user', {
      resolveCommand,
      canonicalizeProject: () =>
        Promise.resolve({
          path: '/canonical/project',
          identity: {
            path: '/canonical/project',
            device: 1,
            inode: 2,
            size: 3,
            mode: 4,
            modifiedAtMs: 5,
            changedAtMs: 6,
            contentDigest: null,
          },
        }),
      readScripts: () => Promise.resolve(new Set(options.scripts ?? [])),
      now: () => new Date('2026-07-15T18:00:00.000Z'),
    }),
  };
}

describe('CommandReadinessService', () => {
  it('passively validates the exact literal command against a selected project', async () => {
    const fixture = service({ project, scripts: ['dev'] });
    const result = await fixture.readiness.check({
      purpose: 'preview',
      command: {
        executable: 'pnpm',
        arguments: ['run', 'dev', '--', '--host'],
      },
      projectId: PROJECT_ID,
    });

    expect(result).toMatchObject({
      state: 'ready',
      ready: true,
      validationScope: 'project',
      resolvedExecutable: '/resolved/pnpm',
      projectName: 'Example project',
    });
    expect(fixture.resolveCommand).toHaveBeenCalledWith(
      'pnpm',
      ['run', 'dev', '--', '--host'],
      '/canonical/project',
    );
  });

  it('validates only the executable when no project can prove a package script', async () => {
    const fixture = service();
    const result = await fixture.readiness.check({
      purpose: 'check',
      command: { executable: 'pnpm', arguments: ['run', 'test'] },
      projectId: null,
    });

    expect(result).toMatchObject({
      state: 'ready-without-project',
      ready: true,
      validationScope: 'executable',
      projectName: null,
    });
    expect(result.warning).toMatch(/choose a project/u);
    expect(fixture.resolveCommand).toHaveBeenCalledWith('pnpm', [], '/home/user');
  });

  it('fails with actionable UI-safe evidence for missing scripts and dependencies', async () => {
    const missingScript = await service({
      project,
      scripts: ['dev'],
    }).readiness.check({
      purpose: 'check',
      command: { executable: 'pnpm', arguments: ['run', 'test'] },
      projectId: PROJECT_ID,
    });
    expect(missingScript).toMatchObject({
      state: 'script-missing',
      ready: false,
    });
    expect(missingScript.reason).toMatch(/detected script in the UI/u);

    const exactScript = await service({
      project,
      scripts: ['test'],
    }).readiness.check({
      purpose: 'check',
      command: { executable: ' pnpm ', arguments: ['run', ' test '] },
      projectId: PROJECT_ID,
    });
    expect(exactScript).toMatchObject({
      state: 'script-missing',
      ready: false,
    });

    const missingExecutable = await service({
      resolveError: new Error('The configured executable was not found.'),
    }).readiness.check({
      purpose: 'preview',
      command: { executable: 'vite', arguments: [] },
      projectId: null,
    });
    expect(missingExecutable).toMatchObject({
      state: 'executable-missing',
      ready: false,
    });
    expect(missingExecutable.reason).toMatch(/Use Browse/u);
  });

  it('does not accept orphaned argv or project-relative executables without a project', async () => {
    const readiness = service().readiness;
    await expect(
      readiness.check({
        purpose: 'check',
        command: { executable: '', arguments: ['run', 'test'] },
        projectId: null,
      }),
    ).resolves.toMatchObject({ state: 'invalid-configuration', ready: false });
    await expect(
      readiness.check({
        purpose: 'check',
        command: { executable: './tools/check', arguments: [] },
        projectId: null,
      }),
    ).resolves.toMatchObject({ state: 'project-required', ready: false });
    await expect(
      readiness.check({
        purpose: 'check',
        command: { executable: 'C:tools\\check.exe', arguments: [] },
        projectId: null,
      }),
    ).resolves.toMatchObject({ state: 'project-required', ready: false });
    const missingScriptArgument = await readiness.check({
      purpose: 'check',
      command: { executable: 'pnpm', arguments: ['run'] },
      projectId: null,
    });
    expect(missingScriptArgument).toMatchObject({
      state: 'invalid-configuration',
      ready: false,
    });
    expect(missingScriptArgument.reason).toMatch(/adopt a detected script in the UI/u);
  });
});
