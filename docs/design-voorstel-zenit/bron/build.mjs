// Zet het voorstel in elkaar tot één zelfstandig HTML-bestand.
//
//   node docs/design-voorstel-zenit/bron/build.mjs                 → ../index.html (dubbelklikken werkt)
//   node docs/design-voorstel-zenit/bron/build.mjs --inhoud pad    → dezelfde pagina zonder doctype/head,
//                                                                     zoals het Artifact hem verwacht
//
// tokens.mjs is de enige plek waar een kleur staat; de build schrijft daar de
// blokken voor Nacht (standaard), Dag (systeem) en Dag (gekozen) uit.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { themed, shared } from './tokens.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = f => fs.readFileSync(path.join(dir, f), 'utf8');

const block = i => Object.entries(themed).map(([k, v]) => `  --${k}:${v[i]};`).join('\n');
const tokensCss = `/* ══ Tokens — gegenereerd uit tokens.mjs ══════════════════════════════════
   Nacht is de standaard (ResoFly is donker-eerst). Dag via het systeem of
   [data-theme="light"]. .tn/.td zetten een thema lokaal vast. */
:root{
${Object.entries(shared).map(([k, v]) => `  --${k}:${v};`).join('\n')}
}
:root,.tn{
${block(0)}
  color-scheme:dark;
}
@media (prefers-color-scheme: light){
  :root:not([data-theme="dark"]){
${block(1)}
    color-scheme:light;
  }
}
:root[data-theme="light"],.td{
${block(1)}
  color-scheme:light;
}
`;

const css = [tokensCss, read('base.css'), read('app.css'), read('page.css')].join('\n');
const js = [read('data.js'), read('app.js'), read('page.js')].join('\n');

const content = `<title>ResoFly Zenit</title>
<meta name="claude:viewport-fit-sides" content="cover">
<meta name="description" content="Designvoorstel Zenit: de nieuwe voorkant van ResoFly, voor Dag en Nacht, in Poppins.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&display=swap">
<style>
${css}
</style>
${read('sprite.html')}
${read('page.html')}
<script>
(function(){
'use strict';
${js}
})();
</script>
`;

const at = process.argv.indexOf('--inhoud');
if (at > 0 && process.argv[at + 1]) {
  fs.writeFileSync(path.resolve(process.argv[at + 1]), content);
}
fs.writeFileSync(path.join(dir, '..', 'index.html'), `<!doctype html>
<html lang="nl">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${content}`);
console.log('gebouwd', (content.length / 1024).toFixed(1) + ' KB');
