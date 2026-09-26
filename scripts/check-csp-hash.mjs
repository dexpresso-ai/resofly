// Controleert dat de sha256 in de CSP (public/_headers) hoort bij het inline
// thema-script in index.html. Wijkt die af, dan blokkeert de browser het script
// stilzwijgend — en de verleiding om dan 'unsafe-inline' toe te voegen haalt de
// hele CSP onderuit. Draait in .github/workflows/frontend-checks.yml.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');

const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (inline.length === 0) {
  console.log('Geen inline scripts in index.html — niets te controleren.');
  process.exit(0);
}

let missing = 0;
for (const script of inline) {
  const hash = `'sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}'`;
  if (headers.includes(hash)) {
    console.log(`OK  ${hash} staat in public/_headers`);
  } else {
    missing += 1;
    console.error(`FOUT ${hash} ontbreekt in de script-src van public/_headers (inline script in index.html is gewijzigd).`);
  }
}
process.exit(missing ? 1 : 0);
