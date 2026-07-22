import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

import { sandboxedPreloadPolicyPlugin } from './scripts/packaged-smoke/preload-policy.js';

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        // Workspace packages export TypeScript for editor ergonomics. Bundle them into the
        // Electron main process so a packaged download never depends on repo source files.
        exclude: [
          '@forgeboard/agent-adapters',
          '@forgeboard/core',
          '@forgeboard/extension-runtime',
          '@forgeboard/git-engine',
          '@forgeboard/test-agent',
          '@forgeboard/ui',
          '@forgeboard/windows-durable-fs',
        ],
      }),
    ],
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        external: ['@forgeboard/windows-durable-fs/native'],
        input: resolve(import.meta.dirname, 'src/main/index.ts'),
      },
    },
  },
  preload: {
    // Sandboxed preload scripts cannot resolve arbitrary Node packages at runtime. Bundle the
    // narrow bridge and its validation schemas into the generated CommonJS file.
    plugins: [sandboxedPreloadPolicyPlugin()],
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: resolve(import.meta.dirname, 'src/preload/index.ts'),
        output: {
          format: 'cjs',
          entryFileNames: '[name].js',
        },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    plugins: [react()],
    server: {
      port: 5174,
      strictPort: true,
    },
    build: {
      outDir: resolve(import.meta.dirname, 'dist/renderer'),
      emptyOutDir: true,
    },
  },
});
