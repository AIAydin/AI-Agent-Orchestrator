import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/**/*.test.{ts,tsx}', 'apps/**/*.test.{ts,tsx}'],
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            'apps/desktop/release/**',
            '**/*.integration.test.ts',
            '**/*.e2e.test.ts',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['packages/**/*.integration.test.ts', 'apps/**/*.integration.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', 'apps/desktop/release/**'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
