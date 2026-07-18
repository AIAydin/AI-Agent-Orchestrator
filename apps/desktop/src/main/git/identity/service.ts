import type { RepositoryService } from '@forgeboard/git-engine';

import type { Project } from '../../../shared/application/contracts.js';
import {
  GitIdentityCheckInputSchema,
  GitIdentityCheckResultSchema,
  type GitIdentityCheckInput,
  type GitIdentityCheckResult,
} from '../../../shared/git/identity/contracts.js';
import { GitIdentityViewSchema, type GitIdentityView } from '../../../shared/git/contracts.js';
import { repositoryGitIdentity } from './values.js';

interface GitIdentityStore {
  getProject(projectId: string): Project | undefined;
}

export class GitIdentityService {
  public constructor(
    private readonly store: GitIdentityStore,
    private readonly repositories: RepositoryService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async check(input: GitIdentityCheckInput): Promise<GitIdentityCheckResult> {
    const request = GitIdentityCheckInputSchema.parse(input);
    const identity =
      request.source === 'settings'
        ? await this.#checkSettingsIdentity(request.name, request.email)
        : await this.#checkRepositoryIdentity(request.projectId);
    return GitIdentityCheckResultSchema.parse({
      request,
      identity,
      checkedAt: this.now().toISOString(),
    });
  }

  async #checkSettingsIdentity(name: string, email: string): Promise<GitIdentityView> {
    await this.#assertGitAcceptsIdentity(name, email);
    return GitIdentityViewSchema.parse({
      name,
      email,
      nameSource: 'settings',
      emailSource: 'settings',
      ready: true,
    });
  }

  async #checkRepositoryIdentity(projectId: string): Promise<GitIdentityView> {
    const project = this.store.getProject(projectId);
    if (project === undefined) throw new Error('The selected project no longer exists.');
    if (project.missing)
      throw new Error('Locate the missing project before checking Git identity.');
    const repositoryRoot = await this.repositories.resolveRepositoryRoot(project.path);
    if (repositoryRoot !== project.path) {
      throw new Error(
        'Reopen the project from its main repository folder before checking identity.',
      );
    }
    const [name, email] = await Promise.all([
      this.#readGitConfig(repositoryRoot, 'user.name'),
      this.#readGitConfig(repositoryRoot, 'user.email'),
    ]);
    const identity = repositoryGitIdentity(name, email);
    if (identity.ready)
      await this.#assertGitAcceptsIdentity(identity.name, identity.email, repositoryRoot);
    return identity;
  }

  async #readGitConfig(repositoryRoot: string, key: 'user.name' | 'user.email'): Promise<string> {
    const result = await this.repositories.git.run(['-C', repositoryRoot, 'config', '--get', key], {
      allowNonZeroExit: true,
      maxOutputBytes: 4_096,
    });
    return result.exitCode === 0 ? result.stdout.trim() : '';
  }

  async #assertGitAcceptsIdentity(
    name: string,
    email: string,
    repositoryRoot?: string,
  ): Promise<void> {
    const result = await this.repositories.git.run(
      [
        ...(repositoryRoot === undefined ? [] : ['-C', repositoryRoot]),
        '-c',
        `user.name=${name}`,
        '-c',
        `user.email=${email}`,
        'var',
        'GIT_AUTHOR_IDENT',
      ],
      { allowNonZeroExit: true, maxOutputBytes: 4_096 },
    );
    const effective = parseAuthorIdentity(result.stdout);
    if (result.exitCode !== 0 || effective?.name !== name || effective.email !== email) {
      throw new Error('Git rejected this name or email. Check both values and try again.');
    }
  }
}

function parseAuthorIdentity(
  value: string,
): { readonly name: string; readonly email: string } | null {
  const match = /^(.*) <([^<>]*)> \d+ [+-]\d{4}$/u.exec(value.trim());
  return match === null || match[1] === undefined || match[2] === undefined
    ? null
    : { name: match[1], email: match[2] };
}
