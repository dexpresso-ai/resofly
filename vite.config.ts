import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { letterSchaal } from './src/lib/letterSchaal';

/**
 * React en Supabase in een eigen bestand, los van de code van de app.
 *
 * Alles in de hoofdbundel (index-*.js) kreeg bij elke deploy een nieuwe naam,
 * ook de ~100 kB (brotli) aan React en Supabase die alleen bij een upgrade
 * verandert. Na elke deploy haalde iedere gebruiker die dus opnieuw op. Nu
 * houden ze hun naam tot een upgrade, en blijven ze in de cache staan
 * (/assets/* is een jaar immutable, zie public/_headers).
 *
 * Twee bestanden en niet één: Supabase krijgt veel vaker een nieuwe versie
 * dan React. Zo kost een upgrade van Supabase niet ook React.
 *
 * Alleen wat de app bij de start toch al laadt. pdf-lib, fontkit, pako en
 * dompurify horen bij losse pagina's en blijven daar: Rollup neemt de
 * statische afhankelijkheden van deze pakketten mee in hetzelfde bestand
 * (tslib, iceberg-js, de CommonJS-hulp van React), maar nooit iets dat alleen
 * via een dynamische import binnenkomt.
 */
const VENDOR_CHUNKS: Array<[name: string, test: RegExp]> = [
  ['vendor-react', /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/],
  ['vendor-supabase', /[\\/]node_modules[\\/]@supabase[\\/]/],
];

export default defineConfig({
  plugins: [react()],
  // Elke lettergrootte schaalt met var(--letter): zo staat de maat van de
  // letters op één plek in globals.css. Zie src/lib/letterSchaal.ts.
  css: { postcss: { plugins: [letterSchaal()] } },
  server: { port: 5173 },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          for (const [name, test] of VENDOR_CHUNKS) if (test.test(id)) return name;
          return undefined;
        },
      },
    },
  },
});
