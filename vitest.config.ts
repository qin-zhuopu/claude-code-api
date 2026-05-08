import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/repos/**', 'test/demos/**'],
    environment: 'node',
    testTimeout: 120000,
    globals: true,
    bail: 1,
  },
});
