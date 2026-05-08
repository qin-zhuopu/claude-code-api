import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/demo.simple-query.e2e-spec.ts'],
    environment: 'node',
    testTimeout: 120000,
    rootDir: '.',
    globals: true,
    bail: 1,
  },
});
