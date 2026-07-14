#!/usr/bin/env node

import process from 'node:process';

import { TEST_AGENT_PACKAGE_VERSION, createTestAgentStop, runTestAgentProtocol } from './index.js';

const argument = process.argv[2];
if (argument === '--version' || argument === '-v') {
  process.stdout.write(`forgeboard-test-agent ${TEST_AGENT_PACKAGE_VERSION}\n`);
} else if (argument === '--help' || argument === '-h') {
  process.stdout.write(
    [
      'forgeboard-test-agent - deterministic JSON-lines coding-agent fixture',
      '',
      'Write one run command to stdin, then optional input/interrupt/terminate commands.',
      'All protocol events are emitted as JSON lines on stdout.',
      '',
      'Options:',
      '  --version  Show the package version',
      '  --help     Show this help',
      '',
    ].join('\n'),
  );
} else if (argument !== undefined) {
  process.stderr.write(`Unknown argument: ${argument}\n`);
  process.exitCode = 2;
} else {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort(createTestAgentStop('interrupt')));
  process.once('SIGTERM', () => controller.abort(createTestAgentStop('terminate')));
  process.exitCode = await runTestAgentProtocol({
    stdin: process.stdin,
    writeLine: (line) => process.stdout.write(line),
    cwd: process.cwd(),
    signal: controller.signal,
  });
}
