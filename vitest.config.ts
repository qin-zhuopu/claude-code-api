import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.e2e-spec.ts'],
    exclude: ['**/node_modules/**', '**/repos/**'],
    environment: 'node',
    testTimeout: 120000,
    globals: true,
    bail: 1,
  },
});
