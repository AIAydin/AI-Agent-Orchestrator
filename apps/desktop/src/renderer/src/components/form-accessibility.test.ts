import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const rendererSource = fileURLToPath(new URL('../', import.meta.url));
const nativeControls = new Set(['input', 'select', 'textarea']);

describe('renderer form accessibility invariants', () => {
  it('gives every native form control an explicit stable name', () => {
    const missing: string[] = [];
    let controlCount = 0;

    for (const file of rendererTsxFiles(rendererSource)) {
      const source = readFileSync(file, 'utf8');
      const sourceFile = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      visitJsx(sourceFile, (node) => {
        const tag = node.tagName.getText(sourceFile);
        if (!nativeControls.has(tag)) return;
        controlCount += 1;
        const hasName = node.attributes.properties.some(
          (attribute) =>
            ts.isJsxAttribute(attribute) && attribute.name.getText(sourceFile) === 'name',
        );
        if (!hasName) missing.push(location(sourceFile, node));
      });
    }

    expect(controlCount).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it('does not nest native buttons inside labels', () => {
    const invalid: string[] = [];
    for (const file of rendererTsxFiles(rendererSource)) {
      const source = readFileSync(file, 'utf8');
      const sourceFile = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const visit = (node: ts.Node): void => {
        if (
          ts.isJsxElement(node) &&
          node.openingElement.tagName.getText(sourceFile) === 'label' &&
          containsNativeButton(node, sourceFile)
        ) {
          invalid.push(location(sourceFile, node));
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }

    expect(invalid).toEqual([]);
  });
});

function rendererTsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return rendererTsxFiles(entryPath);
    return entry.name.endsWith('.tsx') ? [entryPath] : [];
  });
}

function visitJsx(
  sourceFile: ts.SourceFile,
  onElement: (node: ts.JsxOpeningElement | ts.JsxSelfClosingElement) => void,
): void {
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) onElement(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function containsNativeButton(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (
      (ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child)) &&
      child.tagName.getText(sourceFile) === 'button'
    ) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function location(sourceFile: ts.SourceFile, node: ts.Node): string {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${sourceFile.fileName}:${position.line + 1}`;
}
