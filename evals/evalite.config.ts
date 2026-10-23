import { defineConfig } from 'evalite/config';
import { createInMemoryStorage } from 'evalite/in-memory-storage';

export default defineConfig({
  storage: createInMemoryStorage,
  cache: false,
  scoreThreshold: 100,
  testTimeout: 120000,
  maxConcurrency: 4,
  server: { port: 3006 },
});
