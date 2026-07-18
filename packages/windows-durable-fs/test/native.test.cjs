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
