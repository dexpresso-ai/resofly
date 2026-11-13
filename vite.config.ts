import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// De versie van deze build. De app bewaart de vorige stand van de werkruimte
// op het apparaat (src/lib/workspaceSnapshot.ts) en toont die alleen aan
// dezelfde versie: een nieuwe versie kan een veld verwachten dat in een oude
// stand ontbreekt. Cloudflare Pages geeft de commit; lokaal telt elke start.
const build = process.env.CF_PAGES_COMMIT_SHA || `lokaal-${Date.now()}`;

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  define: { __RESOFLY_BUILD__: JSON.stringify(build) },
});
