import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const MAX_LINES = 2_000;
const MAX_FILES_PER_DIRECTORY = 12;
const ROOTS = ['.'];
const DENSITY_ROOTS = ['.github', 'apps', 'config', 'docs', 'packages', 'scripts'];
const ROOT_ALLOWED_FILES = new Set([
  '.dockerignore',
  '.editorconfig',
  '.gitattributes',
  '.gitignore',
  '.npmrc',
  '.prettierignore',
  'AGENTS.md',
  'IMPLEMENTATION_CHECKLIST.md',
  'LICENSE',
  'README.md',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
]);
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
  'test-results',
]);
const EXCLUDED_PATHS = new Set(['apps/desktop/release']);
const GENERATED_FILES = new Set(['pnpm-lock.yaml']);

function isExcludedDirectory(directory) {
  if (EXCLUDED_DIRECTORIES.has(path.basename(directory))) return true;
  return EXCLUDED_PATHS.has(path.relative(repositoryRoot, directory));
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!isExcludedDirectory(candidate)) files.push(...(await sourceFiles(candidate)));
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

async function handWrittenFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!isExcludedDirectory(candidate)) files.push(...(await handWrittenFiles(candidate)));
      continue;
    }
    if (entry.isFile() && !GENERATED_FILES.has(entry.name)) files.push(candidate);
  }
  return files;
}

function lineCount(contents) {
  if (contents.length === 0) return 0;
  return contents.split(/\r\n|\n|\r/u).length;
}

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
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

const denseDirectories = [];
for (const densityRoot of DENSITY_ROOTS) {
  const densityRootPath = path.join(repositoryRoot, densityRoot);
  const densityFiles = await handWrittenFiles(densityRootPath);
  const counts = new Map();
  for (const file of densityFiles) {
    const directory = path.dirname(file);
    counts.set(directory, (counts.get(directory) ?? 0) + 1);
  }
  for (const [directory, count] of counts) {
    if (count > MAX_FILES_PER_DIRECTORY) {
      denseDirectories.push({
        directory: path.relative(repositoryRoot, directory),
        count,
      });
    }
  }
}
denseDirectories.sort((left, right) => left.directory.localeCompare(right.directory));

const looseRootFiles = (await readdir(repositoryRoot, { withFileTypes: true }))
  // Git worktrees use a `.git` pointer file instead of the excluded metadata directory.
  .filter((entry) => entry.isFile() && entry.name !== '.git' && !ROOT_ALLOWED_FILES.has(entry.name))
  .map((entry) => entry.name)
  .sort();

if (violations.length > 0 || denseDirectories.length > 0 || looseRootFiles.length > 0) {
  process.stderr.write(
    [
      'Structure check failed.',
      `Hand-written files may not exceed ${MAX_LINES.toLocaleString()} lines:`,
      ...violations.map(({ file, lines }) => `- ${file}: ${lines.toLocaleString()} lines`),
      `Maintained folders may not contain more than ${MAX_FILES_PER_DIRECTORY.toLocaleString()} direct hand-written files:`,
      ...denseDirectories.map(
        ({ directory, count }) => `- ${directory}: ${count.toLocaleString()} direct files`,
      ),
      'Unexpected loose repository-root files must move into a named subfolder:',
      ...looseRootFiles.map((file) => `- ${file}`),
      'Split each file at a coherent feature or domain boundary; do not minify to evade the gate.',
      '',
    ].join('\n'),
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Structure check passed: ${files.length.toLocaleString()} code/config files are within the ${MAX_LINES.toLocaleString()}-line ceiling, maintained folders contain at most ${MAX_FILES_PER_DIRECTORY.toLocaleString()} direct files, and the root contains only standard entry files.\n`,
  );
}
