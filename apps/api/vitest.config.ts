import { defineConfig } from 'vitest/config';
// Integration files share one database, so run them one after another.
// Integration tests do real database and queue work: allow more than vitest's 5 seconds on a busy machine or CI runner.
export default defineConfig({ test: { fileParallelism: false, testTimeout: 30_000, hookTimeout: 60_000 } });
