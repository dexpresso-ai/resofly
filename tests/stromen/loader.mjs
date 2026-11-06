// Laadt de echte edge functions (Deno) in Node: de imports van esm.sh en
// deno.land wijzen hier naar de pakketten in node_modules, en `serve` uit de
// std-bibliotheek naar een vanger in deze map (std-serve.mjs).
//
// Waarom zo: in deze omgeving zijn esm.sh en deno.land niet bereikbaar, en
// `supabase functions serve` heeft ze nodig. Dezelfde broncode draaien in
// Node test wat er op staging draait, zonder één regel van de functies aan te
// passen.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const ROOT = new URL('../../package.json', import.meta.url).href;
const FUNCTIONS = new URL('../../supabase/functions/', import.meta.url).href;
const ts = createRequire(ROOT)('typescript');

const REMOTE = {
  'https://esm.sh/@supabase/supabase-js@2.45.0': '@supabase/supabase-js',
  'https://esm.sh/pdf-lib@1.17.1': 'pdf-lib',
  'https://esm.sh/@pdf-lib/fontkit@1.1.1': '@pdf-lib/fontkit',
  'https://esm.sh/xss@1.0.15': 'xss',
  'https://esm.sh/fast-xml-parser@4.5.0': 'fast-xml-parser',
  // calendar-integrations (agenda via een ICS-link); zonder deze regel laadde die functie hier niet.
  'https://esm.sh/ical.js@2.1.0': 'ical.js',
};

const LOCAL = {
  'https://deno.land/std@0.224.0/http/server.ts': new URL('./std-serve.mjs', import.meta.url).href,
};

// Deno compileert TypeScript zoals tsc: een import die alleen een type is
// (`import { ActionCtx } from './types.ts'`) verdwijnt, en `constructor(public
// status)` wordt een veld. Node's eigen stripping doet geen van beide; dan faalt
// het laden. Daarom compileert deze loader de edge functions met de
// TypeScript-compiler uit de repo.
export async function load(url, context, next) {
  if (url.startsWith(FUNCTIONS) && url.endsWith('.ts')) {
    const bron = await readFile(new URL(url), 'utf8');
    const { outputText } = ts.transpileModule(bron, {
      fileName: new URL(url).pathname,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        isolatedModules: true,
        inlineSourceMap: true,
        inlineSources: true,
      },
    });
    return { format: 'module', source: outputText, shortCircuit: true };
  }
  return next(url, context);
}

export async function resolve(specifier, context, next) {
  if (LOCAL[specifier]) return { url: LOCAL[specifier], shortCircuit: true };
  if (REMOTE[specifier]) return next(REMOTE[specifier], { ...context, parentURL: ROOT });
  if (/^https?:\/\//.test(specifier)) {
    throw new Error(`tests/stromen: onbekende remote import ${specifier}. Voeg hem toe aan loader.mjs.`);
  }
  return next(specifier, context);
}
