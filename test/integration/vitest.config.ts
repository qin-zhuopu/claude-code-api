import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/integration/**/*.spec.ts'],
    exclude: ['**/node_modules/**'],
    environment: 'node',
    testTimeout: 60000,
    globals: true,
    bail: 1,
    fileParallelism: false,
  },
});
