'use strict';

const { access, mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

test(
  'MoveFileExW write-through binding moves without implicit replacement',
  {
    skip: process.platform !== 'win32',
  },
  async () => {
    const binding = require('../loader.cjs');
    const root = await mkdtemp(join(tmpdir(), 'forgeboard-windows-durable-fs-'));
    const source = join(root, 'source.sqlite');
    const destination = join(root, 'destination.sqlite');
    try {
      await writeFile(source, 'source');
      binding.moveFileWriteThrough(source, destination, false);
      await assert.rejects(access(source), { code: 'ENOENT' });
      assert.equal(await readFile(destination, 'utf8'), 'source');

      await writeFile(source, 'replacement');
      assert.throws(
        () => binding.moveFileWriteThrough(source, destination, false),
        /durable Windows move/u,
      );
      assert.equal(await readFile(destination, 'utf8'), 'source');

      binding.moveFileWriteThrough(source, destination, true);
      assert.equal(await readFile(destination, 'utf8'), 'replacement');

      const sid = binding.currentUserSid();
      assert.match(sid, /^S-\d(?:-\d+){1,15}$/u);
      binding.protectFilesystemAcl(root, sid, true);
      const directoryAcl = JSON.parse(binding.inspectFilesystemAcl(root));
      assert.equal(directoryAcl.ownerSid, sid);
      assert.equal(directoryAcl.protected, true);
      assert.equal(directoryAcl.rules.length, 2);
      for (const expectedSid of [sid, 'S-1-5-18']) {
        let observed;
        for (const rule of directoryAcl.rules) {
          if (rule.sid === expectedSid) observed = rule;
        }
        assert.deepEqual(observed, {
          sid: expectedSid,
          accessType: 'Allow',
          rights: 0x1f01ff,
          inherited: false,
          inheritanceFlags: 3,
          propagationFlags: 0,
        });
      }
      binding.protectFilesystemAcl(destination, sid, false);
      const fileAcl = JSON.parse(binding.inspectFilesystemAcl(destination));
      assert.equal(fileAcl.ownerSid, sid);
      assert.equal(fileAcl.protected, true);
      assert.equal(fileAcl.rules.length, 2);
      for (const expectedSid of [sid, 'S-1-5-18']) {
        let observed;
        for (const rule of fileAcl.rules) {
          if (rule.sid === expectedSid) observed = rule;
        }
        assert.deepEqual(observed, {
          sid: expectedSid,
          accessType: 'Allow',
          rights: 0x1f01ff,
          inherited: false,
          inheritanceFlags: 0,
          propagationFlags: 0,
        });
      }

      const unpublishedDirectory = join(root, 'restore-directory.staging');
      const publishedDirectory = join(root, 'restore-directory');
      await mkdir(unpublishedDirectory);
      await writeFile(join(unpublishedDirectory, 'database.sqlite'), 'restored');
      binding.moveFileWriteThrough(unpublishedDirectory, publishedDirectory, false);
      await assert.rejects(access(unpublishedDirectory), { code: 'ENOENT' });
      assert.equal(await readFile(join(publishedDirectory, 'database.sqlite'), 'utf8'), 'restored');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
