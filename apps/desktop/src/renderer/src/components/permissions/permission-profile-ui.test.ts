import { describe, expect, it } from 'vitest';

import { PERMISSION_PROFILE_OPTIONS, permissionProfileLabel } from './permission-profile-ui.js';

describe('PERMISSION_PROFILE_OPTIONS', () => {
  it('offers Write in current directory and no Custom entry', () => {
    const values = PERMISSION_PROFILE_OPTIONS.map((option) => option.value);
    expect(values).toEqual([
      'plan-read-only',
      'worktree-write',
      'project-write',
      'docker-isolated',
    ]);
    expect(permissionProfileLabel('project-write')).toBe('Write in current directory');
  });

  it('keeps a readable label for the legacy custom value on old saved nodes', () => {
    expect(permissionProfileLabel('custom')).toBe('custom');
  });
});
