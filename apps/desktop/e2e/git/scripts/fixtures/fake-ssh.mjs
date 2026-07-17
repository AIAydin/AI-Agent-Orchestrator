#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { appendFile } from 'node:fs/promises';

const repositoryPath = process.env.FORGEBOARD_FAKE_SSH_REPOSITORY;
const logPath = process.env.FORGEBOARD_FAKE_SSH_LOG;

if (repositoryPath === undefined || logPath === undefined) {
  fail('FORGEBOARD_FAKE_SSH_REPOSITORY and FORGEBOARD_FAKE_SSH_LOG are required.');
}

const argv = process.argv.slice(2);
await appendFile(logPath, `${JSON.stringify({ argv })}\n`, 'utf8');

if (!argv.includes('git@github.com'))
  fail('Only the deterministic GitHub fixture host is allowed.');
const command = argv.at(-1);
if (command !== "git-receive-pack 'forgeboard-e2e/remote-delivery.git'") {
  fail(`Unexpected SSH command: ${String(command)}`);
}

const child = spawn('git-receive-pack', [repositoryPath], {
  env: process.env,
  shell: false,
  stdio: 'inherit',
});
child.once('error', (error) => fail(error.message));
child.once('close', (code) => process.exit(code ?? 1));

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(64);
}
