import { defineConfig } from 'tsup';

export default defineConfig({
  clean: true,
  dts: true,
  entry: ['src/index.ts'],
  format: ['esm'],
  noExternal: [/^@forgeboard\/core(?:\/.*)?$/u],
  platform: 'node',
  removeNodeProtocol: false,
  target: 'node22',
});
