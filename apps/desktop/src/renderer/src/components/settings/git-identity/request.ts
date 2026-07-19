import type { Project } from '../../../../../shared/application/contracts.js';
import {
  GitIdentityCheckInputSchema,
  sameGitIdentityCheckInput,
  type GitIdentityCheckInput,
} from '../../../../../shared/git/identity/contracts.js';

export function gitIdentityCheckRequest(
  nameValue: string,
  emailValue: string,
  activeProject: Project | null,
): GitIdentityCheckInput | null {
  const name = nameValue.trim();
  const email = emailValue.trim();
  const candidate =
    name === '' && email === ''
      ? activeProject === null
        ? null
        : { source: 'git-config' as const, projectId: activeProject.id }
      : { source: 'settings' as const, name, email };
  if (candidate === null) return null;
  const parsed = GitIdentityCheckInputSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function sameGitIdentityRequest(
  left: GitIdentityCheckInput | null,
  right: GitIdentityCheckInput | null,
): boolean {
  return sameGitIdentityCheckInput(left, right);
}
