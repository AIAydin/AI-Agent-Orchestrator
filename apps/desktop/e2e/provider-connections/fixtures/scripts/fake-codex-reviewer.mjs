#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const arguments_ = process.argv.slice(2);
if (arguments_.includes('--version')) {
  process.stdout.write('codex-cli 1.2.3\n');
  process.exit(0);
}
if (arguments_.includes('--help')) {
  process.stdout.write('codex resume --model\n');
  process.exit(0);
}

const marker =
  'Your final response must be one dedicated structured message payload matching this exact record shape and bound values:';
const prompt = arguments_.at(-1) ?? '';
const markerIndex = prompt.indexOf(marker);
if (markerIndex < 0 || markerIndex !== prompt.lastIndexOf(marker)) {
  process.exitCode = 21;
} else {
  const start = prompt.indexOf('{', markerIndex + marker.length);
  const end = balancedObjectEnd(prompt, start);
  const template = JSON.parse(prompt.slice(start, end));
  const attachmentPath = prompt
    .split('\n')
    .find((line) => line.startsWith('- file: '))
    ?.slice('- file: '.length);
  if (attachmentPath === undefined) throw new Error('Missing exact reviewed artifact attachment.');
  const attachmentContent = readFileSync(attachmentPath, 'utf8');
  const attachmentDigest = `sha256:${createHash('sha256').update(attachmentContent).digest('hex')}`;
  const attachment = JSON.parse(attachmentContent);
  if (
    !Array.isArray(attachment.files) ||
    attachment.files.length !== 1 ||
    template.assessments.some((assessment) => assessment.reviewedOutputDigest !== attachmentDigest)
  ) {
    throw new Error('The attached reviewed artifact does not match its exact bound digest.');
  }
  const firstAttempt = template.reviewerAttempt === 1;
  const record = {
    ...template,
    assessments: template.assessments.map((assessment) => ({
      ...assessment,
      verdict: firstAttempt ? 'changes-requested' : 'approved',
      findings: firstAttempt
        ? [
            {
              id: 'offline-review-finding',
              severity: 'error',
              message: 'Revise the exact implementation output before delivery.',
              blocking: true,
              path: null,
              line: null,
            },
          ]
        : [],
      summary: firstAttempt
        ? 'Offline Codex fixture requested one exact revision.'
        : 'Offline Codex fixture approved the exact bound output.',
    })),
  };
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  process.stdout.write(
    `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(record) } })}\n`,
  );
  process.stdout.write(`${JSON.stringify({ type: 'turn.completed' })}\n`);
}

function balancedObjectEnd(value, start) {
  if (start < 0) throw new Error('Missing reviewer record.');
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return index + 1;
  }
  throw new Error('Incomplete reviewer record.');
}
