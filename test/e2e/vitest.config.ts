import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/e2e/**/*.spec.ts'],
    exclude: ['**/node_modules/**'],
    environment: 'node',
    testTimeout: 60000,
    globals: true,
    bail: 1,
  },
});
