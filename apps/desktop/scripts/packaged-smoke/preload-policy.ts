import type { Plugin } from 'vite';

const FORBIDDEN_SANDBOXED_PRELOAD_MODULES = [
  'crypto',
  'fs',
  'fs/promises',
  'module',
  'node:crypto',
  'node:fs',
  'node:fs/promises',
  'node:module',
  'node:path',
  'path',
] as const;

const ELECTRON_REQUIRE = /\brequire\s*\(\s*(["'])electron\1\s*\)/gu;
const FORBIDDEN_RUNTIME_LOADERS = [
  /\bimport\s*\(/u,
  /\beval\s*\(/u,
  /\bFunction\s*\(/u,
  /\bcreateRequire\b/u,
  /\bgetBuiltinModule\b/u,
  /\b_linkedBinding\b/u,
  /\bprocess\s*\.\s*binding\b/u,
] as const;

export function assertSandboxedPreloadBundle(source: string, fileName: string): void {
  for (const moduleSpecifier of FORBIDDEN_SANDBOXED_PRELOAD_MODULES) {
    if (source.includes(`"${moduleSpecifier}"`) || source.includes(`'${moduleSpecifier}'`)) {
      throw new Error(
        `Sandboxed preload bundle ${fileName} must not resolve ${moduleSpecifier}; import a browser-safe package subpath instead`,
      );
    }
  }
  if (/["']node:/u.test(source)) {
    throw new Error(`Sandboxed preload bundle ${fileName} must not resolve Node built-ins.`);
  }
  const withoutElectronBridge = source.replace(ELECTRON_REQUIRE, '');
  if (
    /\brequire\s*(?:\/\*[\s\S]*?\*\/\s*)?\(/u.test(withoutElectronBridge) ||
    /\[\s*(["'])require\1\s*\]/u.test(withoutElectronBridge)
  ) {
    throw new Error(
      `Sandboxed preload bundle ${fileName} may require only the Electron bridge dependency.`,
    );
  }
  if (FORBIDDEN_RUNTIME_LOADERS.some((pattern) => pattern.test(source))) {
    throw new Error(
      `Sandboxed preload bundle ${fileName} must not construct or dynamically resolve runtime dependencies.`,
    );
  }
}

export function sandboxedPreloadPolicyPlugin(): Plugin {
  return {
    name: 'forgeboard-sandboxed-preload-policy',
    generateBundle(_options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type === 'chunk') {
          const runtimeImports = [...output.imports, ...output.dynamicImports];
          const forbiddenImports = runtimeImports.filter((specifier) => specifier !== 'electron');
          if (forbiddenImports.length > 0) {
            const importers = output.moduleIds
              .flatMap((moduleId) => {
                const imported = this.getModuleInfo(moduleId)?.importedIds ?? [];
                const forbidden = imported.filter((specifier) =>
                  forbiddenImports.includes(specifier),
                );
                return forbidden.length > 0 ? [`${moduleId} -> ${forbidden.join(', ')}`] : [];
              })
              .join('; ');
            throw new Error(
              `Sandboxed preload chunk ${fileName} has runtime dependencies other than Electron: ${forbiddenImports.join(', ')}.${importers ? ` Importers: ${importers}.` : ''}`,
            );
          }
          assertSandboxedPreloadBundle(output.code, fileName);
        }
      }
    },
  };
}
