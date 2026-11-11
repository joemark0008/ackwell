import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC is needed so decorator metadata is emitted (Nest DI by type).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
