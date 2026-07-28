import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createPlatformReleaseInfo, platformReleasePlan } from './artifacts.mjs';
import { createPublicationSummary, writePublicationFiles } from './publication.mjs';

const targets = [
  ['darwin', 'arm64', 'signed-and-notarized'],
  ['darwin', 'x64', 'signed-and-notarized'],
  ['linux', 'x64', 'not-applicable'],
  ['win32', 'x64', 'signed'],
];

describe('release publication summary', () => {
  it('labels a release unsigned when any desktop artifact is unsigned', () => {
    const records = releaseInfo();
    records[1].signing.status = 'unsigned-development';
    records[1].signing.message = 'No trusted distribution signature was found.';

    const summary = createPublicationSummary(records, '# Prepared notes');

    assert.equal(summary.title, 'Artemis v0.1.0 (unsigned development; Linux checksum-only)');
    assert.match(summary.notes, /Unsigned development release/u);
    assert.match(summary.notes, /macOS x64: `unsigned-development`/u);
    assert.match(summary.notes, /# Prepared notes/u);
  });

  it('reports signed but unnotarized macOS artifacts without claiming full trust', () => {
    const records = releaseInfo();
    records[0].signing.status = 'signed-not-notarized';

    const summary = createPublicationSummary(records, '# Prepared notes');

    assert.equal(
      summary.title,
      'Artemis v0.1.0 (macOS signed, not notarized; Windows signed; Linux checksum-only)',
    );
    assert.match(summary.notes, /no stapled notarization ticket/u);
  });

  it('uses the signed release label only for notarized macOS and signed Windows metadata', () => {
    const summary = createPublicationSummary(releaseInfo(), '# Prepared notes');

    assert.equal(
      summary.title,
      'Artemis v0.1.0 (macOS signed and notarized; Windows signed; Linux checksum-only)',
    );
    assert.match(summary.notes, /Windows Authenticode signature were verified/u);
    assert.doesNotMatch(summary.notes, /Unsigned development release/u);
  });

  it('rejects incomplete metadata and empty prepared notes', () => {
    assert.throws(
      () => createPublicationSummary(releaseInfo().slice(1), '# Notes'),
      /one verified metadata record/u,
    );
    assert.throws(() => createPublicationSummary(releaseInfo(), '  '), /notes are required/u);
  });

  it('uses canonical signing text instead of manifest-controlled Markdown', () => {
    const records = releaseInfo();
    records[0].signing.message = '\n# injected heading';

    const summary = createPublicationSummary(records, '# Prepared notes');

    assert.doesNotMatch(summary.notes, /injected heading/u);
    assert.match(summary.notes, /stapled macOS notarization ticket were verified/u);
  });

  it('writes publication files only for a complete artifact set from the expected commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeboard-publication-'));
    const output = join(root, 'publication');
    const notesPath = join(root, 'prepared.md');
    const sourceCommit = 'a'.repeat(40);
    try {
      await writeFile(notesPath, '# Artemis v0.1.0\n');
      for (const [platform, architecture, status] of targets) {
        const plan = platformReleasePlan('0.1.0', platform, architecture);
        for (const artifact of plan.artifacts) await writeFile(join(root, artifact), artifact);
        const info = createPlatformReleaseInfo({
          version: '0.1.0',
          platform,
          architecture,
          environment: { GITHUB_SHA: sourceCommit },
          signing: { status, message: `${platform} build evidence.` },
        });
        await writeFile(join(root, plan.infoName), `${JSON.stringify(info)}\n`);
      }

      const summary = await writePublicationFiles(root, notesPath, output, sourceCommit);
      assert.equal(await readFile(join(output, 'title.txt'), 'utf8'), `${summary.title}\n`);
      assert.equal(await readFile(join(output, 'notes.md'), 'utf8'), summary.notes);
      await assert.rejects(
        writePublicationFiles(root, notesPath, output, 'b'.repeat(40)),
        /not expected commit/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function releaseInfo() {
  return targets.map(([platform, architecture, status]) => ({
    version: '0.1.0',
    platform,
    architecture,
    signing: { status, message: `${platform} signing evidence.` },
  }));
}
