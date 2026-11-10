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

// Er kunnen meer CSP-regels zijn (het voorbeeld van het portaal heeft een eigen
// regel die inlijsten door de eigen origin toestaat); de hash hoort in élke regel.
//
// Eén uitzondering: het kader van de rapportages (public/rapport-weergave.html).
// Daar draait HTML die Gerrie schreef, met een eigen script, in een sandbox zonder
// eigen herkomst. Die CSP heeft 'unsafe-inline' en juist GEEN hash: een hash in
// script-src schakelt 'unsafe-inline' uit, en dan rekent geen enkele rapportage
// zijn cijfers uit. Wat dat kader veilig houdt, controleren we hieronder: geen
// netwerk, geen 'self' in script-src, alleen de eigen app mag het inlijsten.
const REPORT_FRAME_PATHS = new Set(['/rapport-weergave', '/rapport-weergave.html']);
const policyLines = [];
let currentPath = null;
for (const line of headers.split('\n')) {
  if (!line.trim() || line.trim().startsWith('#')) continue;
  if (!/^\s/.test(line)) { currentPath = line.trim(); continue; }
  if (line.trim().startsWith('Content-Security-Policy:')) policyLines.push({ path: currentPath, policy: line.trim() });
}
const policies = policyLines.filter((p) => !REPORT_FRAME_PATHS.has(p.path)).map((p) => p.policy);
if (policies.length === 0) {
  console.error('FOUT geen Content-Security-Policy gevonden in public/_headers.');
  process.exit(1);
}

let missing = 0;

const frames = policyLines.filter((p) => REPORT_FRAME_PATHS.has(p.path));
for (const path of REPORT_FRAME_PATHS) {
  if (!frames.some((p) => p.path === path)) { missing += 1; console.error(`FOUT geen CSP voor het rapportagekader op ${path}.`); }
}
for (const { path, policy } of frames) {
  const directive = (name) => (policy.match(new RegExp(`${name}\\s+([^;]*)`)) ?? [])[1]?.trim() ?? null;
  const problems = [];
  if (directive('default-src') !== "'none'") problems.push("default-src moet 'none' zijn");
  if (directive('connect-src') !== "'none'") problems.push("connect-src moet 'none' zijn");
  if (directive('frame-ancestors') !== "'self'") problems.push("frame-ancestors moet 'self' zijn");
  if (/'self'|https?:|\*/.test(directive('script-src') ?? '')) problems.push('script-src mag geen herkomst of host noemen');
  if (/https?:\/\/(?!fonts\.(googleapis|gstatic)\.com)/.test(policy)) problems.push('alleen Google Fonts mag van buiten komen');
  if (problems.length) { missing += 1; console.error(`FOUT rapportagekader ${path}: ${problems.join('; ')}.`); }
  else console.log(`OK  rapportagekader ${path}: netwerk dicht, alleen de eigen app mag inlijsten`);
}
for (const script of inline) {
  const hash = `'sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}'`;
  const without = policies.filter((policy) => !policy.includes(hash)).length;
  if (without === 0) {
    console.log(`OK  ${hash} staat in alle ${policies.length} CSP-regels van public/_headers`);
  } else {
    missing += 1;
    console.error(`FOUT ${hash} ontbreekt in ${without} van de ${policies.length} CSP-regels van public/_headers (inline script in index.html is gewijzigd).`);
  }
}
process.exit(missing ? 1 : 0);
