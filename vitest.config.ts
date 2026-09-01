import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Sem isto, vitest também roda os .test.js compilados em dist/ (saída
    // de `npm run build`) além dos .test.ts em src/ — mesmo teste duas
    // vezes, e a cópia em dist/ pode estar desatualizada.
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
