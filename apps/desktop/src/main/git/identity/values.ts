import { GitIdentityViewSchema, type GitIdentityView } from '../../../shared/git/contracts.js';

export function normalizeGitIdentityValue(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 512 && !containsControlCharacter(trimmed) ? trimmed : '';
}

export function repositoryGitIdentity(nameValue: string, emailValue: string): GitIdentityView {
  const name = normalizeGitIdentityValue(nameValue);
  const email = normalizeGitIdentityValue(emailValue);
  return GitIdentityViewSchema.parse({
    name,
    email,
    nameSource: name === '' ? 'missing' : 'git-config',
    emailSource: email === '' ? 'missing' : 'git-config',
    ready: name !== '' && email !== '',
  });
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}
