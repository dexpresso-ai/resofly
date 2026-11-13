import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { letterSchaal } from './src/lib/letterSchaal';

export default defineConfig({
  plugins: [react()],
  // Elke lettergrootte schaalt met var(--letter): zo staat de maat van de
  // letters op één plek in globals.css. Zie src/lib/letterSchaal.ts.
  css: { postcss: { plugins: [letterSchaal()] } },
  server: { port: 5173 },
});
