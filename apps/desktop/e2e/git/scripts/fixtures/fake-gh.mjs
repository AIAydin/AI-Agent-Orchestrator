#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';

const statePath = process.env.FORGEBOARD_FAKE_GH_STATE;
const logPath = process.env.FORGEBOARD_FAKE_GH_LOG;

if (statePath === undefined || logPath === undefined) {
  fail('FORGEBOARD_FAKE_GH_STATE and FORGEBOARD_FAKE_GH_LOG are required.');
}

const argv = process.argv.slice(2);
const input = await readStandardInput();
await appendFile(
  logPath,
  `${JSON.stringify({
    argv,
    inputSha256: createHash('sha256').update(input).digest('hex'),
    inputCharacters: input.length,
  })}\n`,
  'utf8',
);

if (sameArguments(argv, ['--version'])) {
  process.stdout.write('gh version 2.76.1 (deterministic Artemis E2E fixture)\n');
  process.exit(0);
}

const state = JSON.parse(await readFile(statePath, 'utf8'));

if (
  sameArguments(argv, [
    'config',
    'get',
    'http_unix_socket',
    '--host',
    String(state.repository?.hostname),
  ])
) {
  process.exit(0);
}

if (argv[0] === 'auth' && argv[1] === 'status' && argv[2] === '--hostname' && argv.length === 4) {
  if (state.authenticated === true) {
    process.stdout.write(`Logged in to ${String(argv[3])}\n`);
    process.exit(0);
  }
  process.stderr.write(`Not logged in to ${String(argv[3])}\n`);
  process.exit(1);
}

if (
  argv[0] === 'repo' &&
  argv[1] === 'view' &&
  typeof argv[2] === 'string' &&
  sameArguments(argv.slice(3), ['--json', 'nameWithOwner,url,defaultBranchRef'])
) {
  if (argv[2] !== repositorySelector(state)) {
    fail(`Unexpected repository ${argv[2]}.`);
  }
  process.stdout.write(
    `${JSON.stringify({
      nameWithOwner: state.repository.nameWithOwner,
      url: state.repository.url,
      defaultBranchRef: { name: state.repository.defaultBranch },
    })}\n`,
  );
  process.exit(0);
}

if (
  argv[0] === 'api' &&
  argv[1] === '--hostname' &&
  argv[2] === state.repository?.hostname &&
  (argv.length === 4 || (argv.length === 5 && argv[3] === '--include'))
) {
  const include = argv[3] === '--include';
  const endpoint = argv[include ? 4 : 3];
  if (typeof endpoint !== 'string') fail('GitHub API endpoint was omitted.');
  const prefix = `repos/${String(state.repository.nameWithOwner)}/git/ref/heads/`;
  if (!endpoint.startsWith(prefix)) fail(`Unexpected GitHub API endpoint ${endpoint}.`);
  const branch = decodeURIComponent(endpoint.slice(prefix.length));
  if (branch === state.expectedBaseBranch) {
    writeApiResponse(200, { object: { sha: state.baseOid } }, include);
    process.exit(0);
  }
  if (branch === state.expectedHeadBranch && typeof state.remoteHeadOid === 'string') {
    writeApiResponse(200, { object: { sha: state.remoteHeadOid } }, include);
    process.exit(0);
  }
  writeApiResponse(404, { message: `Branch ${branch} was not found.` }, include);
  process.exit(1);
}

if (argv[0] === 'pr' && argv[1] === 'create') {
  assertFlag(argv, '--repo', repositorySelector(state));
  assertFlag(argv, '--base', state.expectedBaseBranch);
  assertFlag(argv, '--head', state.expectedHeadBranch);
  assertFlag(argv, '--title', state.expectedPullRequestTitle);
  assertFlag(argv, '--body-file', '-');
  if ((argv.includes('--draft') ? true : false) !== (state.expectedDraft === true)) {
    fail('Pull request draft mode did not match fixture state.');
  }
  if (input !== state.expectedPullRequestBody) {
    fail('Pull request body did not match fixture state.');
  }
  process.stdout.write(`${String(state.pullRequestUrl)}\n`);
  process.exit(0);
}

if (argv[0] === 'run' && argv[1] === 'list') {
  assertFlag(argv, '--repo', repositorySelector(state));
  assertFlag(argv, '--branch', state.expectedHeadBranch);
  assertFlag(argv, '--limit', '20');
  assertFlag(
    argv,
    '--json',
    'databaseId,name,workflowName,status,conclusion,url,headBranch,headSha',
  );
  const runs = Array.isArray(state.ciRuns) ? state.ciRuns : [];
  process.stdout.write(`${JSON.stringify(runs)}\n`);
  process.exit(0);
}

fail(`Unrecognized fake gh arguments: ${JSON.stringify(argv)}`);

function assertFlag(arguments_, flag, expected) {
  const index = arguments_.indexOf(flag);
  if (index < 0 || arguments_[index + 1] !== expected) {
    fail(`${flag} did not match deterministic fixture state.`);
  }
}

function sameArguments(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function repositorySelector(state_) {
  return `${String(state_.repository?.hostname)}/${String(state_.repository?.nameWithOwner)}`;
}

function writeApiResponse(status, body, include) {
  const json = JSON.stringify(body);
  if (include) {
    const reason = status === 200 ? 'OK' : 'Not Found';
    process.stdout.write(
      `HTTP/2.0 ${String(status)} ${reason}\ncontent-type: application/json\n\n${json}\n`,
    );
    return;
  }
  process.stdout.write(`${json}\n`);
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(64);
}
