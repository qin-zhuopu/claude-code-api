import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/demos/memory.spec.ts'],
    environment: 'node',
    testTimeout: 120000,
    globals: true,
    bail: 1,
  },
});
