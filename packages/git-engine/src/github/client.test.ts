import process from 'node:process';

import { describe, expect, it } from 'vitest';

import { GitHubCliExecutor } from './client.js';

describe('GitHubCliExecutor', () => {
  it('passes metacharacters as one literal argument without a shell', async () => {
    const literal = 'title; $(touch never) && echo unsafe';
    const executor = new GitHubCliExecutor(process.execPath);
    const result = await executor.run([
      '-e',
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      literal,
    ]);

    expect(JSON.parse(result.stdout)).toEqual([literal]);
    expect(result.args.at(-1)).toBe(literal);
  });

  it('rejects NUL-containing arguments before starting the executable', async () => {
    const executor = new GitHubCliExecutor(process.execPath);

    await expect(executor.run(['bad\0argument'])).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});
