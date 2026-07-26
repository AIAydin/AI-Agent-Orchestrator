'use strict';

const assert = require('node:assert/strict');
const { access, mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { app } = require('electron');

async function verifyElectronAbiAndDirectoryPublication() {
  const binding = require('../loader.cjs');
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-windows-electron-abi-'));
  try {
    const sid = binding.currentUserSid();
    binding.protectFilesystemAcl(root, sid, true);
    const acl = JSON.parse(binding.inspectFilesystemAcl(root));
    assert.equal(acl.ownerSid, sid);
    assert.equal(acl.protected, true);
    const staging = join(root, 'restore.staging');
    const published = join(root, 'restore');
    await mkdir(staging);
    await writeFile(join(staging, 'database.sqlite'), 'restored');
    binding.moveFileWriteThrough(staging, published, false);
    await assert.rejects(access(staging), { code: 'ENOENT' });
    assert.equal(await readFile(join(published, 'database.sqlite'), 'utf8'), 'restored');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

app
  .whenReady()
  .then(async () => {
    if (process.platform === 'win32') {
      await verifyElectronAbiAndDirectoryPublication();
    }
  })
  .then(
    () => app.exit(0),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      app.exit(1);
    },
  );
