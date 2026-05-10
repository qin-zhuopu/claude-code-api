import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/demos/streaming.spec.ts'],
    environment: 'node',
    testTimeout: 120000,
    globals: true,
    bail: 1,
    reporters: ['verbose'],
    printConsoleTrace: true,
    outputTruncationLines: 0,
    silent: false,
  },
});
