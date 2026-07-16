const BASENAME_LANGUAGES: Readonly<Record<string, string>> = {
  Dockerfile: 'dockerfile',
  Makefile: 'makefile',
  '.dockerignore': 'plaintext',
  '.editorconfig': 'ini',
  '.gitignore': 'plaintext',
  '.forgeboardignore': 'plaintext',
};

const EXTENSION_LANGUAGES: Readonly<Record<string, string>> = {
  bash: 'shell',
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  csv: 'plaintext',
  env: 'plaintext',
  go: 'go',
  graphql: 'graphql',
  h: 'c',
  hpp: 'cpp',
  htm: 'html',
  html: 'html',
  ini: 'ini',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsonc: 'json',
  jsx: 'javascript',
  less: 'less',
  lua: 'lua',
  md: 'markdown',
  mjs: 'javascript',
  php: 'php',
  prisma: 'graphql',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sh: 'shell',
  sql: 'sql',
  svg: 'xml',
  toml: 'ini',
  ts: 'typescript',
  tsx: 'typescript',
  txt: 'plaintext',
  vue: 'html',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'shell',
};

const BUNDLED_DIAGNOSTIC_LANGUAGES = new Set([
  'css',
  'scss',
  'less',
  'html',
  'handlebars',
  'razor',
  'javascript',
  'typescript',
  'json',
]);

export function languageForFile(relativePath: string): string {
  const basename = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  const exact = BASENAME_LANGUAGES[basename];
  if (exact !== undefined) return exact;
  const extensionIndex = basename.lastIndexOf('.');
  if (extensionIndex < 0) return 'plaintext';
  return EXTENSION_LANGUAGES[basename.slice(extensionIndex + 1).toLowerCase()] ?? 'plaintext';
}

export function languageHasBundledDiagnostics(language: string): boolean {
  return BUNDLED_DIAGNOSTIC_LANGUAGES.has(language);
}
