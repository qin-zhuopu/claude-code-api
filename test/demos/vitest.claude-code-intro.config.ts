import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/demos/claude-code-intro.spec.ts'],
    environment: 'node',
    testTimeout: 120000,
    globals: true,
    bail: 1,
    reporters: ['verbose'],
    printConsoleTrace: true,
    // 禁用输出截断
    outputTruncationLines: 0,
    // 不隐藏测试输出
    silent: false,
  },
});
