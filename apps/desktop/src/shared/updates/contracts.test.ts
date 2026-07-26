import { describe, expect, it } from 'vitest';

import { UpdateCheckInputSchema, UpdateCheckResultSchema } from './contracts.js';

describe('update contracts', () => {
  it('allows active channels and rejects disabled checks', () => {
    expect(UpdateCheckInputSchema.parse({ channel: 'stable' })).toEqual({
      channel: 'stable',
    });
    expect(UpdateCheckInputSchema.safeParse({ channel: 'disabled' }).success).toBe(false);
  });

  it('accepts only official GitHub release URLs and coherent states', () => {
    const release = {
      id: 12,
      version: '1.2.3',
      tagName: 'v1.2.3',
      name: 'Artemis 1.2.3',
      url: 'https://github.com/AIAydin/AI-Agent-Orchestrator/releases/tag/v1.2.3',
      publishedAt: '2026-07-17T12:00:00.000Z',
      prerelease: false,
    };
    expect(
      UpdateCheckResultSchema.parse({
        channel: 'stable',
        currentVersion: '1.0.0',
        checkedAt: '2026-07-17T12:01:00.000Z',
        status: 'update-available',
        release,
      }).release,
    ).toEqual(release);
    expect(
      UpdateCheckResultSchema.safeParse({
        channel: 'stable',
        currentVersion: '1.0.0',
        checkedAt: '2026-07-17T12:01:00.000Z',
        status: 'up-to-date',
        release: { ...release, url: 'https://example.com/release' },
      }).success,
    ).toBe(false);
    expect(
      UpdateCheckResultSchema.safeParse({
        channel: 'stable',
        currentVersion: '1.2.3+local.1',
        checkedAt: '2026-07-17T12:01:00.000Z',
        status: 'up-to-date',
        release: {
          ...release,
          version: '1.2.3+release.2',
          tagName: 'v1.2.3+release.2',
          url: release.url.replace('v1.2.3', 'v1.2.3%2Brelease.2'),
        },
      }).success,
    ).toBe(true);
    for (const hostile of [
      { url: 'https://github.com/other/repo/releases/tag/v1.2.3' },
      { url: `${release.url}?token=secret` },
      {
        url: 'https://user:password@github.com/AIAydin/AI-Agent-Orchestrator/releases/tag/v1.2.3',
      },
      { tagName: 'v9.9.9' },
      {
        version: '1.2.3-rc.1',
        tagName: 'v1.2.3-rc.1',
        url: release.url.replace('v1.2.3', 'v1.2.3-rc.1'),
        prerelease: false,
      },
    ]) {
      expect(
        UpdateCheckResultSchema.safeParse({
          channel: 'stable',
          currentVersion: '1.0.0',
          checkedAt: '2026-07-17T12:01:00.000Z',
          status: 'update-available',
          release: { ...release, ...hostile },
        }).success,
      ).toBe(false);
    }
    expect(
      UpdateCheckResultSchema.safeParse({
        channel: 'prerelease',
        currentVersion: '0.0.1',
        checkedAt: '2026-07-17T12:01:00.000Z',
        status: 'update-available',
        release: {
          ...release,
          version: '0.1.0',
          tagName: 'v0.1.0',
          url: release.url.replace('v1.2.3', 'v0.1.0'),
          prerelease: true,
        },
      }).success,
    ).toBe(true);
    expect(
      UpdateCheckResultSchema.safeParse({
        channel: 'stable',
        currentVersion: '1.0.0',
        checkedAt: '2026-07-17T12:01:00.000Z',
        status: 'update-available',
        release: { ...release, prerelease: true },
      }).success,
    ).toBe(false);
    expect(
      UpdateCheckResultSchema.safeParse({
        channel: 'stable',
        currentVersion: '2.0.0',
        checkedAt: '2026-07-17T12:01:00.000Z',
        status: 'update-available',
        release,
      }).success,
    ).toBe(false);
  });
});
