import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const MAIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('Forgeboard-owned outbound architecture', () => {
  it('keeps known external-send executors behind the permit-requiring outbound module', async () => {
    const sources = await mainSources();
    expect(callSites(sources, /\.git\.run\(\[\s*['"]clone['"]/gu)).toEqual([
      'outbound/outbound-executors.ts',
    ]);
    expect(importSites(sources, 'pullDockerImage')).toEqual(['outbound/outbound-executors.ts']);
    expect(callSites(sources, /\bnew\s+GitHubCliExecutor\s*\(/gu)).toEqual([
      'outbound/git/executors.ts',
    ]);

    const executor = requiredSource(sources, 'outbound/outbound-executors.ts');
    expect(executor).toContain('assertOutboundExecutionPermit(permit)');
    expect(executor.match(/assertOutboundExecutionPermit\(permit\)/gu)).toHaveLength(2);
    expect(requiredSource(sources, 'projects/project-service.ts')).toContain(
      'authorization.gate.confirmAndExecute',
    );
    expect(requiredSource(sources, 'docker/docker-ipc.ts')).toContain(
      'this.#outbound.confirmAndExecute',
    );
    const gitRemoteExecutor = requiredSource(sources, 'outbound/git/executors.ts');
    expect(gitRemoteExecutor.match(/assertOutboundExecutionPermit\(permit\)/gu)).toHaveLength(4);
  });

  it('has no unenumerated direct external network API in desktop main', async () => {
    const sources = await mainSources();
    const patterns: ReadonlyArray<readonly [string, RegExp]> = [
      ['global fetch', /\bfetch\s*\(/gu],
      ['Node HTTP request', /\bhttps?\.request\s*\(/gu],
      ['Electron net request', /\bnet\.request\s*\(/gu],
      ['WebSocket construction', /\bnew\s+WebSocket\s*\(/gu],
    ];
    const violations = patterns.flatMap(([label, pattern]) =>
      callSites(sources, pattern).map((file) => `${label}: ${file}`),
    );
    expect(violations).toEqual([]);
  });

  it('documents that user-approved execution runtimes remain separate from this gate', async () => {
    const gate = requiredSource(
      sourcesWithoutTests(await mainSources()),
      'outbound/outbound-action-gate.ts',
    );
    expect(gate).toContain(
      'Agent, check, preview, and user terminal subprocess capabilities do not pass through this gate',
    );
  });
});

async function mainSources(): Promise<Map<string, string>> {
  const files = await walk(MAIN_ROOT);
  const sources = new Map<string, string>();
  for (const file of files) {
    const relative = path.relative(MAIN_ROOT, file).split(path.sep).join('/');
    if (
      !file.endsWith('.ts') ||
      relative.endsWith('.test.ts') ||
      relative.endsWith('.integration.test.ts')
    ) {
      continue;
    }
    sources.set(relative, await readFile(file, 'utf8'));
  }
  return sources;
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? await walk(target) : [target];
    }),
  );
  return nested.flat();
}

function callSites(sources: Map<string, string>, pattern: RegExp): string[] {
  return [...sources]
    .filter(([, source]) => {
      pattern.lastIndex = 0;
      return pattern.test(source);
    })
    .map(([file]) => file)
    .sort();
}

function importSites(sources: Map<string, string>, importedName: string): string[] {
  const pattern = new RegExp(
    `import\\s*\\{[^}]*\\b${importedName}\\b[^}]*\\}\\s*from\\s*['"][^'"]+docker-runtime\\.js['"]`,
    'gu',
  );
  return callSites(sources, pattern);
}

function requiredSource(sources: Map<string, string>, file: string): string {
  const source = sources.get(file);
  if (source === undefined) throw new Error(`Missing architecture source ${file}.`);
  return source;
}

function sourcesWithoutTests(sources: Map<string, string>): Map<string, string> {
  return sources;
}
