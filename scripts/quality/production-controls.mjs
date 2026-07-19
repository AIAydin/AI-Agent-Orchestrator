import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const productionRootParents = ['apps', 'packages'];
const repositoryProductionRoots = ['scripts', 'config', '.github/workflows'];
const sourceExtensions = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.mjs',
  '.ts',
  '.tsx',
  '.svg',
  '.yaml',
  '.yml',
]);
const ignoredDirectoryNames = new Set([
  '__fixtures__',
  '__snapshots__',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'release',
  'tests',
]);
const ignoredFilePattern = /(?:^|\.)((?:integration\.)?test|spec|stories)\.[^.]+$/u;
const jsxExtensions = new Set(['.jsx', '.tsx']);
const auditImplementationPath = join(repositoryRoot, 'scripts/quality/production-controls.mjs');

const requiredWorkMarkers = [
  { label: 'unfinished-work marker', pattern: /\b(?:FIXME|HACK|TODO|XXX)\b/gu },
  {
    label: 'fake-success marker',
    pattern: /\b(?:fake|mock(?:ed)?)\s*[- ]?\s*(?:completion|success)\b/giu,
  },
  {
    label: 'placeholder/stub implementation marker',
    pattern: /\b(?:placeholder|stub)\s+(?:control|handler|implementation|response|result)\b/giu,
  },
  { label: 'unimplemented-feature marker', pattern: /\b(?:coming soon|not implemented)\b/giu },
];

export function auditProductionSource(source, filePath) {
  const findings = auditRequiredWorkMarkers(source, filePath);
  if (jsxExtensions.has(extname(filePath))) findings.push(...auditNativeControls(source, filePath));
  return findings;
}

function auditRequiredWorkMarkers(source, filePath) {
  const findings = [];
  for (const marker of requiredWorkMarkers) {
    marker.pattern.lastIndex = 0;
    for (const match of source.matchAll(marker.pattern)) {
      findings.push(finding(filePath, source, match.index, marker.label, match[0]));
    }
  }
  return findings;
}

function auditNativeControls(source, filePath) {
  const scriptKind = extname(filePath) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.JSX;
  const parsed = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const findings = [];

  for (const diagnostic of parsed.parseDiagnostics) {
    findings.push(
      finding(
        filePath,
        source,
        diagnostic.start ?? 0,
        'unparseable JSX prevents control audit',
        ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
      ),
    );
  }

  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(parsed);
      if (tag === 'button' && !hasButtonAction(node.attributes.properties, parsed)) {
        findings.push(
          finding(
            filePath,
            source,
            node.getStart(parsed),
            'inert native button',
            'add an explicit onClick/formAction or a literal submit/reset type',
          ),
        );
      }
      if (tag === 'a' && !hasLinkAction(node.attributes.properties, parsed)) {
        findings.push(
          finding(
            filePath,
            source,
            node.getStart(parsed),
            'inert native link',
            'add an explicit href or onClick',
          ),
        );
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(parsed);
  return findings;
}

function hasButtonAction(attributes, parsed) {
  if (hasUsableEventHandler(attributes, parsed, 'onClick')) return true;
  if (hasExplicitAttribute(attributes, parsed, ['formAction'])) return true;
  const typeAttribute = attributes.find(
    (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(parsed) === 'type',
  );
  if (!typeAttribute || !ts.isJsxAttribute(typeAttribute)) return false;
  const value = literalAttributeValue(typeAttribute.initializer);
  return value === 'reset' || value === 'submit';
}

function hasExplicitAttribute(attributes, parsed, names) {
  return attributes.some(
    (attribute) =>
      ts.isJsxAttribute(attribute) &&
      names.includes(attribute.name.getText(parsed)) &&
      attribute.initializer,
  );
}

function hasUsableEventHandler(attributes, parsed, name) {
  const attribute = attributes.find(
    (candidate) => ts.isJsxAttribute(candidate) && candidate.name.getText(parsed) === name,
  );
  if (!attribute || !ts.isJsxAttribute(attribute) || !attribute.initializer) return false;
  if (!ts.isJsxExpression(attribute.initializer) || !attribute.initializer.expression) return false;
  return !isKnownNoopExpression(attribute.initializer.expression);
}

function hasLinkAction(attributes, parsed) {
  if (hasUsableEventHandler(attributes, parsed, 'onClick')) return true;
  const attribute = attributes.find(
    (candidate) => ts.isJsxAttribute(candidate) && candidate.name.getText(parsed) === 'href',
  );
  if (!attribute || !ts.isJsxAttribute(attribute) || !attribute.initializer) return false;
  if (ts.isStringLiteral(attribute.initializer)) {
    const href = attribute.initializer.text.trim();
    return href !== '' && href !== '#';
  }
  if (!ts.isJsxExpression(attribute.initializer) || !attribute.initializer.expression) return false;
  const expression = attribute.initializer.expression;
  if (ts.isStringLiteral(expression)) {
    const href = expression.text.trim();
    return href !== '' && href !== '#';
  }
  return !isKnownPrimitiveNoop(expression);
}

function isKnownNoopExpression(expression) {
  if (ts.isParenthesizedExpression(expression)) return isKnownNoopExpression(expression.expression);
  if (isKnownPrimitiveNoop(expression)) return true;
  if (!ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression)) return false;
  if (ts.isBlock(expression.body)) return expression.body.statements.length === 0;
  if (ts.isVoidExpression(expression.body))
    return isKnownNoopExpression(expression.body.expression);
  return isKnownNoopExpression(expression.body);
}

function isKnownPrimitiveNoop(expression) {
  if (ts.isParenthesizedExpression(expression)) return isKnownPrimitiveNoop(expression.expression);
  if (
    expression.kind === ts.SyntaxKind.NullKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    ts.isNumericLiteral(expression) ||
    ts.isStringLiteral(expression) ||
    (ts.isIdentifier(expression) && expression.text === 'undefined')
  ) {
    return true;
  }
  return false;
}

function literalAttributeValue(initializer) {
  if (!initializer) return undefined;
  if (ts.isStringLiteral(initializer)) return initializer.text;
  if (!ts.isJsxExpression(initializer) || !initializer.expression) return undefined;
  return ts.isStringLiteral(initializer.expression) ? initializer.expression.text : undefined;
}

function finding(filePath, source, offset, label, detail) {
  const prefix = source.slice(0, offset);
  return {
    filePath,
    line: prefix.split(/\r?\n/u).length,
    label,
    detail: detail.replaceAll(/\s+/gu, ' ').trim(),
  };
}

async function productionFiles() {
  const files = [];
  for (const parent of productionRootParents) {
    for (const entry of await readdir(join(repositoryRoot, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      await collectSourceFiles(join(repositoryRoot, parent, entry.name, 'src'), files);
    }
  }
  for (const root of repositoryProductionRoots) {
    await collectSourceFiles(join(repositoryRoot, root), files);
  }
  return files.sort();
}

async function collectSourceFiles(directory, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectoryNames.has(entry.name))
        await collectSourceFiles(join(directory, entry.name), files);
      continue;
    }
    const absolutePath = join(directory, entry.name);
    if (
      !entry.isFile() ||
      absolutePath === auditImplementationPath ||
      ignoredFilePattern.test(entry.name) ||
      !sourceExtensions.has(extname(entry.name))
    ) {
      continue;
    }
    files.push(absolutePath);
  }
}

export async function auditRepository() {
  const files = await productionFiles();
  const findings = [];
  for (const absolutePath of files) {
    const filePath = relative(repositoryRoot, absolutePath);
    findings.push(...auditProductionSource(await readFile(absolutePath, 'utf8'), filePath));
  }
  return { files, findings };
}

async function main() {
  const { files, findings } = await auditRepository();
  if (findings.length > 0) {
    console.error('Production marker/control audit failed:');
    for (const item of findings) {
      console.error(`- ${item.filePath}:${item.line} ${item.label}: ${item.detail}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `Production marker/control audit passed (${files.length.toLocaleString('en-US')} source/style files).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
