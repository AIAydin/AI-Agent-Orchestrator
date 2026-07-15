import { describe, expect, it } from 'vitest';

import { assertSandboxedPreloadBundle } from './preload-policy.js';

describe('sandboxed preload bundle policy', () => {
  it('accepts the Electron bridge without Node-only filesystem or crypto dependencies', () => {
    expect(() =>
      assertSandboxedPreloadBundle(
        'const { contextBridge, ipcRenderer } = require("electron");',
        'index.js',
      ),
    ).not.toThrow();
  });

  it.each(['node:crypto', 'node:fs', 'node:fs/promises', 'node:path', 'fs', 'path'])(
    'rejects runtime resolution of %s',
    (moduleSpecifier) => {
      expect(() =>
        assertSandboxedPreloadBundle(
          `const dependency = require("${moduleSpecifier}");`,
          'index.js',
        ),
      ).toThrow(`must not resolve ${moduleSpecifier}`);
    },
  );

  it('rejects an ESM Node-only import as well', () => {
    expect(() =>
      assertSandboxedPreloadBundle("import { createHash } from 'node:crypto';", 'index.js'),
    ).toThrow('must not resolve node:crypto');
  });

  it.each([
    'const fs = require("node:" + "fs");',
    'const fs = globalThis.require("fs");',
    'const fs = process.getBuiltinModule("fs");',
    'const fs = createRequire(import.meta.url)("fs");',
    'const fs = eval("requ" + "ire")("fs");',
    'const fs = Function("return requ" + "ire")()("fs");',
    'const fs = import("node:fs");',
  ])('rejects a dynamic or obfuscated runtime loader: %s', (source) => {
    expect(() => assertSandboxedPreloadBundle(source, 'index.js')).toThrow(
      /must not (?:construct|resolve)|may require only/u,
    );
  });

  it('rejects an accidentally externalized package while retaining Electron as the only bridge', () => {
    expect(() =>
      assertSandboxedPreloadBundle(
        'const electron = require("electron"); const schema = require("zod");',
        'index.js',
      ),
    ).toThrow('may require only the Electron bridge');
  });
});
