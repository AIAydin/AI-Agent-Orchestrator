#!/usr/bin/env node

import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const statePath = join(root, 'oauth-state.json');
const invocationsPath = join(root, 'oauth-invocations.jsonl');
const arguments_ = process.argv.slice(2);

await appendFile(
  invocationsPath,
  `${JSON.stringify({ arguments: arguments_, environmentNames: Object.keys(process.env).sort() })}\n`,
);

if (matches(['--version'])) {
  process.stdout.write('codex-cli 1.2.3\n');
  process.exit(0);
}
if (matches(['--help'])) {
  process.stdout.write(
    'resume --resume --model --sandbox read-only workspace-write --permission-mode plan manual\n',
  );
  process.exit(0);
}

const state = await readState();
if (matches(['login'])) {
  await writeState({ ...state, codex: true });
  process.stdout.write('Official Codex browser sign-in completed locally for the test fixture.\n');
  process.exit(0);
}
if (matches(['login', 'status'])) {
  if (state.codex) {
    process.stdout.write(
      'Logged in using ChatGPT as oauth-fixture-person@example.invalid account_test_123 token_fixture_secret\n',
    );
    process.exit(0);
  }
  process.stdout.write('Not logged in\n');
  process.exit(1);
}
if (matches(['logout'])) {
  await writeState({ ...state, codex: false });
  process.exit(0);
}
if (matches(['auth', 'login'])) {
  await writeState({ ...state, claude: true });
  process.stdout.write('Official Claude browser sign-in completed locally for the test fixture.\n');
  process.exit(0);
}
if (matches(['auth', 'status', '--json'])) {
  process.stderr.write('Fixture diagnostic that must not contaminate status JSON.\n');
  process.stdout.write(
    JSON.stringify({
      loggedIn: state.claude,
      authMethod: 'oauth',
      email: 'oauth-fixture-person@example.invalid',
      accountId: 'account_test_456',
      token: 'token_fixture_secret',
    }),
  );
  process.exit(state.claude ? 0 : 1);
}
if (matches(['auth', 'logout'])) {
  await writeState({ ...state, claude: false });
  process.exit(0);
}

process.stderr.write(`Rejected unexpected provider fixture argv: ${JSON.stringify(arguments_)}\n`);
process.exit(64);

function matches(expected) {
  return (
    expected.length === arguments_.length &&
    expected.every((value, index) => value === arguments_[index])
  );
}

async function readState() {
  try {
    const value = JSON.parse(await readFile(statePath, 'utf8'));
    return { codex: value.codex === true, claude: value.claude === true };
  } catch {
    return { codex: false, claude: false };
  }
}

async function writeState(value) {
  await writeFile(statePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}
