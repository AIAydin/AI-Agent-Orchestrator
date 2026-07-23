import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  LOCAL_EFFECT_CAPABILITY_INVENTORY,
  LOCAL_EFFECT_POLICY_REQUIREMENTS,
  LOCAL_EFFECT_PRODUCTION_ROOTS,
} from './capability-policy.js';

const WORKSPACE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../..',
);
const EFFECT_EXPORTS: Readonly<Record<string, ReadonlySet<string>>> = {
  '@forgeboard/agent-adapters': new Set([
    'AgentSession',
    'CliAgentAdapter',
    'createCustomCliAdapter',
    'detectAgent',
    'detectDockerRuntime',
    'launchPreparedAgent',
  ]),
  '@forgeboard/git-engine': new Set([
    'ChangeService',
    'GitExecutor',
    'GitHubCliExecutor',
    'GitHubCommandRunner',
    'GitHubService',
    'GitRemoteConfigurationService',
    'RepositoryService',
    'WorktreeService',
    'assertNoMatchingPushUrlRewrites',
    'assertNoPushTargetRemoteNameCollision',
    'assertNoRepositoryPushOverrides',
    'inspectGitRemoteConfiguration',
    'prepareManagedRoot',
    'readExactRemotePushUrl',
  ]),
  electron: new Set(['shell']),
  'node:child_process': new Set([
    'exec',
    'execFile',
    'execFileSync',
    'execSync',
    'fork',
    'spawn',
    'spawnSync',
  ]),
  'node:fs': new Set([
    'appendFile',
    'appendFileSync',
    'chmod',
    'chmodSync',
    'chown',
    'chownSync',
    'copyFile',
    'copyFileSync',
    'cp',
    'cpSync',
    'createWriteStream',
    'fchmod',
    'fchmodSync',
    'fchown',
    'fchownSync',
    'fdatasync',
    'fdatasyncSync',
    'fsync',
    'fsyncSync',
    'ftruncate',
    'ftruncateSync',
    'futimes',
    'futimesSync',
    'link',
    'linkSync',
    'lchmod',
    'lchmodSync',
    'lchown',
    'lchownSync',
    'lutimes',
    'lutimesSync',
    'mkdir',
    'mkdirSync',
    'mkdtemp',
    'mkdtempSync',
    'open',
    'openSync',
    'rename',
    'renameSync',
    'rm',
    'rmSync',
    'rmdir',
    'rmdirSync',
    'symlink',
    'symlinkSync',
    'truncate',
    'truncateSync',
    'unlink',
    'unlinkSync',
    'utimes',
    'utimesSync',
    'write',
    'writeFile',
    'writeFileSync',
    'writeSync',
    'writev',
    'writevSync',
  ]),
  'node:fs/promises': new Set([
    'appendFile',
    'chmod',
    'chown',
    'copyFile',
    'cp',
    'link',
    'lchmod',
    'lchown',
    'lutimes',
    'mkdir',
    'mkdtemp',
    'open',
    'rename',
    'rm',
    'rmdir',
    'symlink',
    'truncate',
    'unlink',
    'utimes',
    'writeFile',
  ]),
  'node:sqlite': new Set(['DatabaseSync', 'backup']),
};

describe('main-process local effect capability architecture', () => {
  it('requires every mutation-capable platform import to declare an authority policy', async () => {
    expect(await discoverEffectCapabilities()).toEqual(LOCAL_EFFECT_CAPABILITY_INVENTORY);
  });

  it('keeps SQLite construction inside storage and startup-recovery boundaries', () => {
    const sqliteOwners = Object.entries(LOCAL_EFFECT_CAPABILITY_INVENTORY)
      .filter(([, value]) => value.capabilities.some((item) => item.startsWith('node:sqlite#')))
      .map(([file]) => file);
    expect(
      sqliteOwners.filter(
        (file) =>
          !file.startsWith('storage/') && file !== 'storage.ts' && !file.startsWith('recovery/'),
      ),
    ).toEqual([]);
  });

  it('scans the exact desktop-main and main-loaded workspace package roots', () => {
    expect(LOCAL_EFFECT_PRODUCTION_ROOTS).toEqual([
      { relativeRoot: 'apps/desktop/src/main', inventoryPrefix: '' },
      {
        relativeRoot: 'packages/agent-adapters/src',
        inventoryPrefix: 'packages/agent-adapters/src/',
      },
      { relativeRoot: 'packages/git-engine/src', inventoryPrefix: 'packages/git-engine/src/' },
    ]);
    expect(policyFiles('reviewed-domain-operation')).toEqual([
      'packages/git-engine/src/diff/changes.ts',
      'packages/git-engine/src/github/client.ts',
      'packages/git-engine/src/repository/executor.ts',
      'packages/git-engine/src/repository/path-safety.ts',
      'packages/git-engine/src/repository/remotes/config-mutation-transaction.ts',
      'packages/git-engine/src/repository/service.ts',
      'packages/git-engine/src/repository/worktree-recovery/inspection.ts',
      'packages/git-engine/src/repository/worktrees.ts',
    ]);
    expect(LOCAL_EFFECT_POLICY_REQUIREMENTS['reviewed-domain-operation']).toContain(
      'Electron main',
    );
  });

  it('keeps the ordinary-save and pre-database recovery exceptions exact and documented', () => {
    expect(policyFiles('ordinary-project-save')).toEqual(['file-domain/writer.ts']);
    expect(policyFiles('user-selected-project-import')).toEqual(['file-domain/videos/service.ts']);
    expect(policyFiles('journaled-startup-recovery')).toEqual([
      'recovery/database/atomic-restore.ts',
      'recovery/database/interrupted-restore.ts',
      'recovery/database/provenance/inspect.ts',
      'recovery/database/selected-backup.ts',
      'recovery/database/startup-adapter/deferred-staging-cleanup.ts',
      'recovery/database/startup-adapter/initialization-marker.ts',
      'recovery/database/startup-adapter/open-store.ts',
    ]);
    expect(LOCAL_EFFECT_POLICY_REQUIREMENTS['ordinary-project-save']).toContain(
      'expected-content-hash',
    );
    expect(LOCAL_EFFECT_POLICY_REQUIREMENTS['user-selected-project-import']).toContain(
      'native picker',
    );
    expect(LOCAL_EFFECT_POLICY_REQUIREMENTS['journaled-startup-recovery']).toContain('journal');
  });

  it('rejects namespace, default, CommonJS, dynamic, and re-export capability acquisition', () => {
    for (const source of [
      "import fs from 'node:fs';",
      "import * as fs from 'node:fs/promises';",
      "import fs = require('node:fs');",
      "const fs = require('node:fs');",
      "const fs = await import('node:fs/promises');",
      "export { writeFile } from 'node:fs/promises';",
    ]) {
      expect(() => parseCapabilities('synthetic.ts', source)).toThrow('unreviewable');
    }
  });

  it('tracks synchronous process launches and filesystem copy and symlink mutations', () => {
    expect(
      parseCapabilities(
        'synthetic.ts',
        [
          "import { execFileSync, spawnSync } from 'node:child_process';",
          "import { cp, symlink } from 'node:fs/promises';",
          "import { cpSync, symlinkSync } from 'node:fs';",
        ].join('\n'),
      ),
    ).toEqual([
      'node:child_process#execFileSync',
      'node:child_process#spawnSync',
      'node:fs#cpSync',
      'node:fs#symlinkSync',
      'node:fs/promises#cp',
      'node:fs/promises#symlink',
    ]);
  });

  it('tracks package effect entry points including passed capability-bearing types', () => {
    expect(
      parseCapabilities(
        'synthetic.ts',
        [
          "import { CliAgentAdapter, type AgentSession } from '@forgeboard/agent-adapters';",
          "import { GitExecutor, type RepositoryService } from '@forgeboard/git-engine';",
        ].join('\n'),
      ),
    ).toEqual([
      '@forgeboard/agent-adapters#AgentSession',
      '@forgeboard/agent-adapters#CliAgentAdapter',
      '@forgeboard/git-engine#GitExecutor',
      '@forgeboard/git-engine#RepositoryService',
    ]);
    expect(
      parseCapabilities(
        'synthetic.ts',
        "import type { CliAgentAdapter } from '@forgeboard/agent-adapters';",
      ),
    ).toEqual(['@forgeboard/agent-adapters#CliAgentAdapter']);
  });

  it('fails a new main-process package capability owner until its policy is reviewed', () => {
    const capabilities = parseCapabilities(
      'synthetic-new-main-caller.ts',
      "import { GitExecutor } from '@forgeboard/git-engine';",
    );
    expect(() => reviewedCapabilityEntry('synthetic-new-main-caller.ts', capabilities)).toThrow(
      'Unreviewed local effect capability owner',
    );
  });
});

async function discoverEffectCapabilities(): Promise<
  Record<string, { capabilities: readonly string[]; policy: string }>
> {
  const discovered: Record<string, { capabilities: readonly string[]; policy: string }> = {};
  for (const root of LOCAL_EFFECT_PRODUCTION_ROOTS) {
    const absoluteRoot = path.resolve(WORKSPACE_ROOT, root.relativeRoot);
    for (const file of await walk(absoluteRoot)) {
      const relative = path.relative(absoluteRoot, file).split(path.sep).join('/');
      if (!isProductionTypeScript(relative)) continue;
      const inventoryKey = `${root.inventoryPrefix}${relative}`;
      const capabilities = parseCapabilities(file, await readFile(file, 'utf8'));
      if (capabilities.length === 0) continue;
      discovered[inventoryKey] = reviewedCapabilityEntry(inventoryKey, capabilities);
    }
  }
  return discovered;
}

function reviewedCapabilityEntry(
  inventoryKey: string,
  capabilities: readonly string[],
): { capabilities: readonly string[]; policy: string } {
  const declared = LOCAL_EFFECT_CAPABILITY_INVENTORY[inventoryKey];
  if (declared === undefined) {
    throw new Error(
      `Unreviewed local effect capability owner ${inventoryKey}: ${capabilities.join(', ')}`,
    );
  }
  return { capabilities, policy: declared.policy };
}

function parseCapabilities(file: string, source: string): string[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const capabilities: string[] = [];
  for (const statement of parsed.statements) {
    if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference)
    ) {
      const moduleSpecifier = statement.moduleReference.expression;
      if (moduleSpecifier !== undefined) rejectUnreviewableModuleAccess(file, moduleSpecifier);
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined) {
      rejectUnreviewableModuleAccess(file, statement.moduleSpecifier);
    }
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const moduleName = statement.moduleSpecifier.text;
    const effectExports = EFFECT_EXPORTS[moduleName];
    if (effectExports === undefined) continue;
    const clause = statement.importClause;
    if (clause === undefined || clause.name !== undefined) unreviewable(file, moduleName);
    const bindings = clause.namedBindings;
    if (bindings === undefined) unreviewable(file, moduleName);
    if (ts.isNamespaceImport(bindings)) {
      unreviewable(file, moduleName);
    }
    for (const element of bindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (effectExports.has(importedName)) capabilities.push(`${moduleName}#${importedName}`);
    }
  }
  visitDynamicModuleAccess(parsed, file);
  visitGlobalEffects(parsed, capabilities);
  return [...new Set(capabilities)].sort();
}

function visitGlobalEffects(node: ts.Node, capabilities: string[]): void {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'process' &&
    node.expression.name.text === 'kill'
  ) {
    capabilities.push('process#kill');
  }
  ts.forEachChild(node, (child) => visitGlobalEffects(child, capabilities));
}

function visitDynamicModuleAccess(node: ts.Node, file: string): void {
  if (ts.isCallExpression(node) && node.arguments.length === 1) {
    const target = node.arguments[0];
    if (target !== undefined && ts.isStringLiteral(target)) {
      const commonJs = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (commonJs || dynamicImport) rejectUnreviewableModuleAccess(file, target);
    }
  }
  ts.forEachChild(node, (child) => visitDynamicModuleAccess(child, file));
}

function rejectUnreviewableModuleAccess(file: string, moduleSpecifier: ts.Expression): void {
  if (ts.isStringLiteral(moduleSpecifier) && EFFECT_EXPORTS[moduleSpecifier.text] !== undefined) {
    unreviewable(file, moduleSpecifier.text);
  }
}

function unreviewable(file: string, moduleName: string): never {
  throw new Error(
    `${path.relative(WORKSPACE_ROOT, file)} uses unreviewable access to ${moduleName}`,
  );
}

function isProductionTypeScript(relative: string): boolean {
  return (
    relative.endsWith('.ts') &&
    !relative.endsWith('.test.ts') &&
    !relative.endsWith('.integration.test.ts')
  );
}

function policyFiles(policy: string): string[] {
  return Object.entries(LOCAL_EFFECT_CAPABILITY_INVENTORY)
    .filter(([, entry]) => entry.policy === policy)
    .map(([file]) => file)
    .sort();
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const target = path.join(directory, entry.name);
        return entry.isDirectory() ? await walk(target) : [target];
      }),
    )
  ).flat();
}
