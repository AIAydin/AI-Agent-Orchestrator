#!/usr/bin/env node

import { appendFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { createInterface } from 'node:readline';

const SESSION_ID = 'forgeboard-offline-session-001';
const parsed = parseInvocation(process.argv.slice(2));
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let settled = false;

function fail(message, exitCode = 8) {
  output(`OFFLINE_FIXTURE_REJECTED ${message}\n`);
  settled = true;
  process.exitCode = exitCode;
  lines.close();
}

function parseInvocation(arguments_) {
  const mode = arguments_.shift();
  if (mode !== 'launch' && mode !== 'resume') {
    return { error: 'mode must be launch or resume' };
  }
  if (arguments_.shift() !== '--no-alt-screen') {
    return { error: 'missing --no-alt-screen' };
  }
  if (arguments_.shift() !== '--permission') {
    return { error: 'missing --permission' };
  }
  const permission = arguments_.shift();
  if (permission !== 'read-only' && permission !== 'worktree-write') {
    return { error: 'permission must be read-only or worktree-write' };
  }
  if (arguments_.shift() !== '--model') return { error: 'missing --model' };
  const model = arguments_.shift();
  if (model === undefined || model.length === 0) return { error: 'model must be non-empty' };
  const expectedTail = mode === 'resume' ? 2 : 1;
  if (arguments_.length !== expectedTail) return { error: 'unexpected argument count' };
  const sessionId = mode === 'resume' ? arguments_.shift() : undefined;
  const prompt = arguments_.shift();
  if (prompt === undefined || prompt.length === 0) return { error: 'prompt must be non-empty' };
  return { mode, model, permission, prompt, sessionId };
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function output(data) {
  emit({ type: 'output', stream: 'stdout', data });
}

function usage(inputTokens, outputTokens, costUsd) {
  emit({
    type: 'completed',
    metadata: {
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        total_cost_usd: costUsd,
      },
    },
  });
}

async function start() {
  if ('error' in parsed) {
    fail(parsed.error);
    return;
  }
  if (parsed.mode === 'resume') {
    if (parsed.sessionId !== SESSION_ID) {
      fail(`session ${String(parsed.sessionId)}`, 9);
      return;
    }
    await appendFile('offline-agent-proof.txt', 'resume completed\n');
    output(`OFFLINE_RESUMED ${SESSION_ID} model=${parsed.model}\n`);
    usage(23, 7, 0.0037);
    settled = true;
    lines.close();
    return;
  }
  if (parsed.prompt.includes('RETRY_FAIL')) {
    emit({ type: 'session', thread_id: `${SESSION_ID}-failed` });
    output(`OFFLINE_RETRY_PARENT_FAILED model=${parsed.model}\n`);
    usage(13, 3, 0.0019);
    settled = true;
    process.exitCode = 7;
    lines.close();
    return;
  }
  if (parsed.prompt.includes('RETRY_COMPLETE')) {
    await writeFile('offline-agent-retry.txt', 'retry completed\n');
    emit({ type: 'session', thread_id: `${SESSION_ID}-retry` });
    output(`OFFLINE_RETRY_COMPLETED model=${parsed.model}\n`);
    usage(17, 5, 0.0022);
    settled = true;
    lines.close();
    return;
  }
  emit({ type: 'session', thread_id: SESSION_ID });
  output(`OFFLINE_READY model=${parsed.model}\n`);
}

lines.on('line', (line) => {
  void (async () => {
    if (settled || 'error' in parsed || parsed.mode === 'resume') return;
    await writeFile('offline-agent-proof.txt', `input=${line}\n`);
    output(`OFFLINE_INPUT_RECEIVED ${line}\n`);
  })().catch((error) => {
    fail(error instanceof Error ? error.message : String(error), 1);
  });
});

process.on('SIGINT', () => {
  if (settled) return;
  output(`OFFLINE_INTERRUPTED ${SESSION_ID}\n`);
  usage(31, 11, 0.0042);
  settled = true;
  lines.close();
  process.exitCode = 130;
});

lines.on('close', () => {
  if (!settled) process.exitCode = 8;
});

void start().catch((error) => {
  fail(error instanceof Error ? error.message : String(error), 1);
});
