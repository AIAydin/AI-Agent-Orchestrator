import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const MAX_LINES = 2_000;
const ROOTS = ['.'];
const CODE_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.less',
  '.mjs',
  '.scss',
  '.sh',
  '.sql',
  '.svg',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);
const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.pnpm-store',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'release',
  'test-results',
]);
const GENERATED_FILES = new Set(['pnpm-lock.yaml']);

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) files.push(...(await sourceFiles(candidate)));
      continue;
    }
    if (
      entry.isFile() &&
      !GENERATED_FILES.has(entry.name) &&
      CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
    ) {
      files.push(candidate);
    }
  }
  return files;
}

function lineCount(contents) {
  if (contents.length === 0) return 0;
  return contents.split(/\r\n|\n|\r/u).length;
}

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const files = (
  await Promise.all(ROOTS.map(async (root) => await sourceFiles(path.join(repositoryRoot, root))))
)
  .flat()
  .sort();
const violations = [];
for (const file of files) {
  const lines = lineCount(await readFile(file, 'utf8'));
  if (lines > MAX_LINES) {
    violations.push({ file: path.relative(repositoryRoot, file), lines });
  }
}

if (violations.length > 0) {
  process.stderr.write(
    [
      `Structure check failed: hand-written files may not exceed ${MAX_LINES.toLocaleString()} lines.`,
      ...violations.map(({ file, lines }) => `- ${file}: ${lines.toLocaleString()} lines`),
      'Split each file at a coherent feature or domain boundary; do not minify to evade the gate.',
      '',
    ].join('\n'),
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Structure check passed: ${files.length.toLocaleString()} files are within the ${MAX_LINES.toLocaleString()}-line ceiling.\n`,
  );
}
