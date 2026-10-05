import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'scripts/**/*.test.mjs'],
    environment: 'node',
    testTimeout: 10_000,
  },
});
