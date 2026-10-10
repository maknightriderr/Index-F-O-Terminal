import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Component and logic tests for the terminal UI. jsdom + React Testing Library; the same
// '@/' alias as the app. No network, no backend: components get fixtures or mocked hooks.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
