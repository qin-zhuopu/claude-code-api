import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.e2e-spec.ts'],
    environment: 'node',
    testTimeout: 60000,
    rootDir: '.',
    globals: true,
    bail: 1,
  },
});
