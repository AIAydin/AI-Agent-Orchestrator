import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { INTEGRATION_UI_MANIFEST } from './manifest.js';

describe('ordinary integration UI coverage', () => {
  it('classifies every inventoried action without treating scoped authority as portable settings', () => {
    const entries = Object.values(INTEGRATION_UI_MANIFEST);

    expect(entries).toHaveLength(12);
    expect(new Set(entries.map((entry) => entry.route))).toEqual(
      new Set([
        'Welcome',
        'Settings > Agents & runtime',
        'Settings > Connectivity',
        'Settings > Data & privacy',
        'Settings > Permissions',
      ]),
    );
    expect(entries.filter((entry) => entry.stateScope === 'device-bound').length).toBeGreaterThan(
      0,
    );
    expect(entries.filter((entry) => entry.stateScope === 'project-bound').length).toBeGreaterThan(
      0,
    );
    expect(entries.filter((entry) => entry.stateScope === 'secret-bound').length).toBeGreaterThan(
      0,
    );
    expect(
      entries
        .filter((entry) => entry.stateScope === 'secret-bound')
        .every((entry) => entry.exportPolicy === 'never-export'),
    ).toBe(true);
    expect(
      entries.every((entry) => entry.controls.length > 0 && entry.limitation.length > 20),
    ).toBe(true);
  });

  it('links every action surface to production UI and an executable interaction test', () => {
    for (const [actionId, entry] of Object.entries(INTEGRATION_UI_MANIFEST)) {
      const source = resolve(entry.evidence.source);
      const test = resolve(entry.evidence.test);

      expect(existsSync(source), `${actionId} production source`).toBe(true);
      expect(existsSync(test), `${actionId} interaction test`).toBe(true);
      expect(readFileSync(test, 'utf8'), `${actionId} evidence title`).toContain(
        `it('${entry.evidence.testTitle}'`,
      );
    }
  });
});
