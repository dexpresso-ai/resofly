#!/usr/bin/env node
/*
 * Stromen-test — de echte edge functions van offertes, facturen, herinneringen
 * en contracten, end-to-end tegen een lokale Supabase-stack.
 *
 *   npx supabase start -x studio,imgproxy,mailpit,logflare,vector,supavisor,edge-runtime,postgres-meta,realtime,storage-api
 *   npm install --no-save xss@1.0.15 fast-xml-parser@4.5.0
 *   npm run test:stromen -- [rook] [offertes] [facturen] [mollie] [verzendwijze] [herinneringen] [contracten] [beveiliging] [automatisering] [agenda] [videovergadering] [bank] [marketing] [inrichten] [klantdomein] [notulen] [rapportages] [agents] [boekingslinks] [tickets] [api]
 *
 * Resend, Mollie en de media-worker zijn nep (nepdiensten.mjs): er gaat niets
 * de deur uit, maar elke mail, betaling en PDF wordt vastgelegd en gecontroleerd.
 */
import { existsSync } from 'node:fs';
import './omgeving.mjs';
import { installeer } from './nepdiensten.mjs';
import { roepRequest } from './functies.mjs';
import { samenvatting } from './toets.mjs';

installeer({ functie: roepRequest });

const ALLE = ['rook', 'offertes', 'facturen', 'mollie', 'verzendwijze', 'herinneringen', 'contracten', 'beveiliging', 'automatisering', 'agenda', 'videovergadering', 'documenten', 'verzenddomein', 'bank', 'marketing', 'inrichten', 'klantdomein', 'notulen', 'rapportages', 'agents', 'boekingslinks', 'tickets', 'api']
  .filter((naam) => existsSync(new URL(`./${naam}.mjs`, import.meta.url)));
const gekozen = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
for (const naam of gekozen.length ? gekozen : ALLE) {
  if (!ALLE.includes(naam)) throw new Error(`Onbekend scenario "${naam}". Kies uit: ${ALLE.join(', ')}`);
  const scenario = await import(`./${naam}.mjs`);
  await scenario.default();
}

const fouten = samenvatting();
process.exit(fouten > 0 ? 1 : 0);
