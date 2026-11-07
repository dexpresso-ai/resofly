// De eigen Mollie-koppeling van een organisatie (Instellingen → Betalen), van
// koppelen tot ontkoppelen, met de echte invoice-workflow tegen de lokale stack
// en nep-Mollie (nepdiensten.mjs).
//
// Waarom een eigen scenario: deze koppeling bepaalt waar het geld van klanten
// terechtkomt. In de controle van 6 november 2026 bleek:
//   - op staging ontbrak MOLLIE_TOKEN_ENCRYPTION_KEY: koppelen liep stuk, en de
//     key die er stond was met de ingebouwde sleutel uit de code versleuteld;
//   - koppelen, vervangen en ontkoppelen kwamen niet in het auditlog, en de
//     instellingen zeiden niet welk Mollie-account de betalingen ontving;
//   - een key met een regeleinde kwam via de foutmelding van fetch in de logs.
// Elke stap kijkt daarom ook naar de database, het auditlog, wat er bij Mollie
// aankwam en wat de functie in haar logboek schreef.
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { roep } from './functies.mjs';
import { mollieBetaal, post } from './nepdiensten.mjs';
import { rest, sqlRij, sqlRijen, sql } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, stap, verwacht } from './toets.mjs';
import { maakWereld, REGELS } from './wereld.mjs';

// ── Hulpjes ─────────────────────────────────────────────────────────────

function q(waarde) {
  return `'${String(waarde).replace(/'/g, "''")}'`;
}

function vandaag(plusDagen = 0) {
  const d = new Date(Date.now() + plusDagen * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function mollieSleutel(naam) {
  return `test_${naam}${randomUUID().replace(/-/g, '')}`;
}

/** Een actie van invoice-workflow, zoals supabase.functions.invoke vanuit de app. */
function wf(w, gebruiker, action, extra = {}) {
  return roep('invoice-workflow', { token: gebruiker?.token, body: { action, organizationId: w.orgId, ...extra } });
}

/** Een concept zoals de app het opslaat (PostgREST, met RLS), met een eigen nummer. */
async function nieuwConcept(w) {
  const nummer = `FAC-${vandaag().slice(0, 4)}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
  const res = await rest('invoices?select=*', {
    method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
    body: {
      organization_id: w.orgId, created_by: w.medewerker.id, client_id: w.klantA.id, project_id: null,
      number: nummer, date: vandaag(), due_date: vandaag(14), status: 'draft', notes: null,
      lines: REGELS.map((regel) => ({ id: randomUUID(), ...regel })),
    },
  });
  gelukt(res, 'concept opslaan');
  return res.json[0];
}

/** Versturen met betaallink, zoals de app doet als Mollie gekoppeld is; geeft de betaalrij. */
async function verstuurdMetBetaallink(w) {
  const concept = await nieuwConcept(w);
  const uit = gelukt(await wf(w, w.medewerker, 'sendInvoiceEmail', {
    invoiceId: concept.id, recipientEmail: w.klantA.email, recipientName: `Contact ${w.klantA.name}`, includePaymentLink: true,
  }), 'versturen met betaallink');
  verwacht(!uit.paymentLinkError, `betaallink mislukte: ${uit.paymentLinkError}`);
  const rij = sqlRij(`select status, provider_payment_id from public.invoice_payment_records
                       where invoice_id = ${q(concept.id)} order by created_at desc limit 1`);
  verwacht(rij?.status === 'open' && /^tr_/.test(rij.provider_payment_id ?? ''), `geen open betaallink: ${JSON.stringify(rij)}`);
  return { factuur: concept, betalingId: rij.provider_payment_id };
}

/** Wat de functie in haar logboek schrijft (console), terwijl fn loopt. */
async function metLogboek(fn) {
  const regels = [];
  const oud = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const naam of Object.keys(oud)) {
    console[naam] = (...args) => { regels.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 6 }))).join(' ')); };
  }
  try {
    return { uit: await fn(), regels };
  } finally {
    Object.assign(console, oud);
  }
}

/** Tijdelijk andere secrets voor de functies (process.env is hun Deno.env). */
async function metOmgeving(waarden, fn) {
  const oud = Object.fromEntries(Object.keys(waarden).map((naam) => [naam, process.env[naam]]));
  for (const [naam, waarde] of Object.entries(waarden)) {
    if (waarde === undefined) delete process.env[naam]; else process.env[naam] = waarde;
  }
  try {
    return await fn();
  } finally {
    for (const [naam, waarde] of Object.entries(oud)) {
      if (waarde === undefined) delete process.env[naam]; else process.env[naam] = waarde;
    }
  }
}

/** Een opslag zoals de oude terugval hem maakte: versleuteld met de ingebouwde sleutel uit de code. */
async function oudeOpslag(plain) {
  const materiaal = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('dev-only-token-key'));
  const sleutel = await crypto.subtle.importKey('raw', materiaal, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sleutel, new TextEncoder().encode(plain)));
  return `v1.${Buffer.from(iv).toString('base64url')}.${Buffer.from(cipher).toString('base64url')}`;
}

const mollieAanroepen = (vanaf) => post.log.slice(vanaf).filter((regel) => regel.startsWith('mollie '));

// ── Het scenario ────────────────────────────────────────────────────────

export default async function mollie() {
  groep('Mollie koppelen (Instellingen → Betalen)');

  const w = await stap('wereld maken', () => maakWereld('mollie-koppeling'));
  if (!w) return;
  const sleutel = { een: mollieSleutel('kopeen'), roteer: mollieSleutel('koproteer'), twee: mollieSleutel('koptwee') };
  const STUDIO = { id: 'pfl_studioeen01', name: 'Studio Eén', website: 'https://studio-een.test', status: 'verified' };
  const ANDER = { id: 'pfl_anderacc02', name: 'Ander Account BV', website: 'https://ander.test', status: 'verified' };
  post.mollie.profielen.set(sleutel.een, STUDIO);
  post.mollie.profielen.set(sleutel.roteer, STUDIO); // een nieuwe key van hetzelfde account
  post.mollie.profielen.set(sleutel.twee, ANDER);

  const mollieRegels = () => sqlRijen(`select action, entity_id, entity_label, actor_user_id, metadata from public.audit_logs
    where organization_id = ${q(w.orgId)} and entity_type = 'mollie_connection' order by created_at, id`);
  const instelling = () => sqlRij(`select id, status, mode, key_suffix, api_key_encrypted, metadata
    from public.organization_invoice_mollie_settings where organization_id = ${q(w.orgId)}`);

  // ── 1. Koppelen ───────────────────────────────────────────────────────

  await stap('een key met een regeleinde: geweigerd zonder Mollie te bellen, en de key staat niet in het antwoord of het logboek', async () => {
    const voor = post.log.length;
    const kapot = `${sleutel.een.slice(0, 18)}\n${sleutel.een.slice(18)}`;
    const { uit: res, regels } = await metLogboek(() => wf(w, w.eigenaar, 'saveInvoiceMollieKey', { apiKey: kapot }));
    const uit = geweigerd(res, 'key met regeleinde', [422]);
    verwacht(/alleen letters en cijfers/.test(uit.error), `melding: ${uit.error}`);
    for (const deel of [sleutel.een.slice(5, 18), sleutel.een.slice(18)]) {
      verwacht(!res.tekst.includes(deel), 'de key staat in het antwoord');
      verwacht(!regels.some((regel) => regel.includes(deel)), `de key staat in het logboek: ${regels.join(' | ').slice(0, 300)}`);
    }
    gelijk(mollieAanroepen(voor), [], 'aanroepen bij Mollie');
    gelijk(instelling(), null, 'koppeling');
  });

  await stap('zonder MOLLIE_TOKEN_ENCRYPTION_KEY (zo stond staging op 6 november): een duidelijke melding, Mollie niet gebeld, niets opgeslagen', async () => {
    const voor = post.log.length;
    const res = await metOmgeving({ MOLLIE_TOKEN_ENCRYPTION_KEY: undefined },
      () => wf(w, w.eigenaar, 'saveInvoiceMollieKey', { apiKey: sleutel.een }));
    const uit = geweigerd(res, 'koppelen zonder versleutelsleutel', [500]);
    verwacht(/kan je key niet veilig opslaan/.test(uit.error), `melding: ${uit.error}`);
    gelijk(mollieAanroepen(voor), [], 'aanroepen bij Mollie');
    gelijk(instelling(), null, 'koppeling');
    gelijk(mollieRegels(), [], 'auditregels');
  });

  // Alleen de eigenaar koppelt (besloten op 7 november 2026): met een andere key
  // komt het geld van klanten op een ander account binnen.
  await stap('een beheerder koppelt niet: alleen de eigenaar (403), Mollie niet gebeld, niets opgeslagen', async () => {
    const voor = post.log.length;
    const uit = geweigerd(await wf(w, w.beheerder, 'saveInvoiceMollieKey', { apiKey: sleutel.een }), 'koppelen als beheerder', [403]);
    verwacht(/Alleen de eigenaar/.test(uit.error), `melding: ${uit.error}`);
    gelijk(mollieAanroepen(voor), [], 'aanroepen bij Mollie');
    gelijk(instelling(), null, 'koppeling');
  });

  await stap('eigenaar koppelt: Mollie geeft het profiel; status, database en logboek zonder de key', async () => {
    const voor = post.log.length;
    const { uit: res, regels } = await metLogboek(() => wf(w, w.eigenaar, 'saveInvoiceMollieKey', { apiKey: sleutel.een }));
    const uit = gelukt(res, 'koppelen');
    gelijk([uit.status.status, uit.status.mode, uit.status.key_suffix, uit.openPaymentsPreviousAccount],
      ['connected', 'test', sleutel.een.slice(-4), false], 'status');
    gelijk(uit.status.profile, STUDIO, 'profiel');
    gelijk(mollieAanroepen(voor), ['mollie GET /v2/profiles/me'], 'aanroepen bij Mollie');
    const lezer = gelukt(await wf(w, w.lezer, 'getInvoiceMollieStatus'), 'status als lezer');
    gelijk(lezer.status.profile?.name, STUDIO.name, 'profiel voor een lezer');
    const geheim = sleutel.een.slice(5);
    verwacht(!res.tekst.includes(geheim) && !JSON.stringify(lezer).includes(geheim), 'de key staat in een antwoord');
    verwacht(!regels.some((regel) => regel.includes(geheim)), 'de key staat in het logboek van de functie');
    const rij = instelling();
    verwacht(rij?.api_key_encrypted && !rij.api_key_encrypted.includes(geheim), 'de key staat leesbaar in de database');
    const p = rij.metadata?.profile ?? {};
    gelijk({ id: p.id, name: p.name, website: p.website, status: p.status }, STUDIO, 'profiel in de database');
  });

  await stap('auditlog: "Mollie gekoppeld" door de eigenaar, met profiel en de laatste vier tekens, zonder de key', async () => {
    const regels = mollieRegels();
    gelijk(regels.map((r) => r.action), ['mollie_connected'], 'regels');
    const [r] = regels;
    gelijk([r.actor_user_id, r.entity_id], [w.eigenaar.id, instelling().id], 'wie en welke koppeling');
    gelijk([r.metadata.mode, r.metadata.key_suffix, r.metadata.profile_id, r.metadata.profile_name],
      ['test', sleutel.een.slice(-4), STUDIO.id, STUDIO.name], 'metadata');
    verwacht(r.entity_label.includes(STUDIO.name) && r.entity_label.includes(sleutel.een.slice(-4)), `label: ${r.entity_label}`);
    verwacht(!JSON.stringify(r).includes(sleutel.een.slice(5, 30)), 'de key staat in het auditlog');
  });

  await stap('auditlog over Mollie: eigenaar en beheerder lezen het; lid, lezer, kijker en boekhouder niet', async () => {
    for (const [wie, gebruiker, aantal] of [['eigenaar', w.eigenaar, 1], ['beheerder', w.beheerder, 1], ['lid', w.medewerker, 0],
      ['lezer', w.lezer, 0], ['kijker', w.kijker, 0], ['boekhouder', w.boekhouder, 0]]) {
      const res = await rest(`audit_logs?select=id,action&organization_id=eq.${w.orgId}&entity_type=eq.mollie_connection`, { token: gebruiker.token });
      const gezien = Array.isArray(res.json) ? res.json.length : null;
      const goed = aantal > 0 ? res.status === 200 && gezien === aantal : res.status >= 400 || gezien === 0;
      verwacht(goed, `${wie}: verwacht ${aantal} regel(s), kreeg ${res.status} ${res.tekst.slice(0, 200)}`);
    }
  });

  // ── 2. Een open betaallink, en dan een nieuwe key ─────────────────────

  let open = null;
  await stap('een factuur met een open betaallink bij het eerste account', async () => {
    open = await verstuurdMetBetaallink(w);
    verwacht(post.mollie.betalingen.get(open.betalingId)?.sleutel === sleutel.een, 'betaling niet met de eerste key gemaakt');
  });

  await stap('nieuwe key van hetzelfde account (rotatie): geen waarschuwing, en de open betaling is nog na te kijken', async () => {
    const uit = gelukt(await wf(w, w.eigenaar, 'saveInvoiceMollieKey', { apiKey: sleutel.roteer }), 'key vervangen');
    gelijk([uit.status.key_suffix, uit.status.profile?.id, uit.openPaymentsPreviousAccount], [sleutel.roteer.slice(-4), STUDIO.id, false], 'status');
    const r = mollieRegels().at(-1);
    gelijk([r.action, r.actor_user_id, r.metadata.account_changed, r.metadata.previous_key_suffix],
      ['updated', w.eigenaar.id, false, sleutel.een.slice(-4)], 'auditregel');
    // De webhook kijkt de betaling na met de nieuwe key: dat lukt (zelfde account).
    gelijk(post.mollie.betalingen.get(open.betalingId).status, 'open', 'betaling bij Mollie');
    const res = await mollieBetaal(open.betalingId, { status: 'paid' });
    gelijk(res.status, 200, 'webhook na betalen');
    gelijk(sqlRij(`select status from public.invoices where id = ${q(open.factuur.id)}`)?.status, 'paid', 'factuur');
  });

  let tweedeOpen = null;
  await stap('nog een factuur met een open betaallink', async () => {
    tweedeOpen = await verstuurdMetBetaallink(w);
  });

  await stap('key van een ander Mollie-account terwijl er een link openstaat: gewaarschuwd en vastgelegd', async () => {
    const uit = gelukt(await wf(w, w.eigenaar, 'saveInvoiceMollieKey', { apiKey: sleutel.twee }), 'ander account koppelen');
    gelijk([uit.status.status, uit.status.profile?.id, uit.openPaymentsPreviousAccount], ['connected', ANDER.id, true], 'status');
    const r = mollieRegels().at(-1);
    gelijk([r.action, r.actor_user_id, r.metadata.profile_id, r.metadata.previous_profile_id, r.metadata.account_changed, r.metadata.open_payments_previous_account],
      ['updated', w.eigenaar.id, ANDER.id, STUDIO.id, true, true], 'auditregel');
    // Zoals de waarschuwing zegt: de nieuwe key ziet die betaling niet. De
    // webhook geeft dan geen 200, zodat Mollie het later opnieuw probeert.
    const res = await mollieBetaal(tweedeOpen.betalingId, { status: 'paid' });
    verwacht(res.status >= 500, `webhook gaf ${res.status}`);
    gelijk(sqlRij(`select status from public.invoices where id = ${q(tweedeOpen.factuur.id)}`)?.status, 'sent', 'factuur blijft open');
  });

  await stap('een beheerder vervangt de key niet; een lid, lezer, kijker of boekhouder vervangt of ontkoppelt niets', async () => {
    const voor = instelling();
    const beheer = geweigerd(await wf(w, w.beheerder, 'saveInvoiceMollieKey', { apiKey: sleutel.een }), 'vervangen als beheerder', [403]);
    verwacht(/Alleen de eigenaar/.test(beheer.error), `melding: ${beheer.error}`);
    for (const [wie, gebruiker] of [['lid', w.medewerker], ['lezer', w.lezer], ['kijker', w.kijker], ['boekhouder', w.boekhouder]]) {
      geweigerd(await wf(w, gebruiker, 'saveInvoiceMollieKey', { apiKey: sleutel.een }), `vervangen als ${wie}`, [403]);
      geweigerd(await wf(w, gebruiker, 'deleteInvoiceMollieKey'), `ontkoppelen als ${wie}`, [403]);
    }
    gelijk(instelling(), voor, 'koppeling');
  });

  // ── 3. Ontkoppelen ────────────────────────────────────────────────────

  await stap('een beheerder mag wel ontkoppelen: key en profiel weg, de open link genoemd, en vastgelegd', async () => {
    const uit = gelukt(await wf(w, w.beheerder, 'deleteInvoiceMollieKey'), 'ontkoppelen');
    gelijk([uit.status.status, uit.status.mode, uit.status.key_suffix, uit.status.profile, uit.hadOpenPayments],
      ['revoked', null, null, null, true], 'status');
    const rij = instelling();
    gelijk([rij.status, rij.api_key_encrypted, rij.key_suffix, rij.metadata?.profile ?? null], ['revoked', null, null, null], 'database');
    const r = mollieRegels().at(-1);
    gelijk([r.action, r.actor_user_id, r.metadata.previous_profile_id, r.metadata.previous_key_suffix, r.metadata.had_open_payments],
      ['revoked', w.beheerder.id, ANDER.id, sleutel.twee.slice(-4), true], 'auditregel');
    const lezer = gelukt(await wf(w, w.lezer, 'getInvoiceMollieStatus'), 'status als lezer');
    gelijk([lezer.status.status, lezer.status.profile], ['revoked', null], 'status voor een lezer');
    gelijk(mollieRegels().map((regel) => regel.action), ['mollie_connected', 'updated', 'updated', 'revoked'], 'alle regels');
  });

  await stap('na ontkoppelen: versturen gaat zonder betaallink, en een losse betaallink wordt geweigerd', async () => {
    const voor = post.log.length;
    const concept = await nieuwConcept(w);
    const uit = gelukt(await wf(w, w.medewerker, 'sendInvoiceEmail', {
      invoiceId: concept.id, recipientEmail: w.klantA.email, recipientName: `Contact ${w.klantA.name}`, includePaymentLink: true,
    }), 'versturen');
    verwacht(/Koppel eerst het eigen Mollie-account/.test(String(uit.paymentLinkError)), `melding over de betaallink: ${uit.paymentLinkError}`);
    const link = geweigerd(await wf(w, w.medewerker, 'createInvoicePaymentCheckout', { invoiceId: concept.id }), 'losse betaallink', [409]);
    verwacht(/Koppel eerst het eigen Mollie-account/.test(link.error), `melding: ${link.error}`);
    gelijk(mollieAanroepen(voor), [], 'aanroepen bij Mollie');
  });

  // ── 4. Een koppeling van vóór de fix ──────────────────────────────────

  await stap('een key met de ingebouwde sleutel (staging zonder geheim) werkt, en staat na het eerste gebruik met de echte sleutel in de database', async () => {
    const oud = await oudeOpslag(sleutel.twee);
    sql(`update public.organization_invoice_mollie_settings
            set status = 'connected', mode = 'test', key_suffix = ${q(sleutel.twee.slice(-4))}, api_key_encrypted = ${q(oud)}
          where organization_id = ${q(w.orgId)}`);
    // Staging: MOLLIE_ALLOW_MOCK staat aan (abonnementen), dus de oude sleutel telt.
    const nieuw = await metOmgeving({ MOLLIE_ALLOW_MOCK: 'true' }, () => verstuurdMetBetaallink(w));
    verwacht(post.mollie.betalingen.get(nieuw.betalingId)?.sleutel === sleutel.twee, 'betaling niet met de oude key gemaakt');
    const na = instelling().api_key_encrypted;
    verwacht(na && na !== oud && /^v1\./.test(na), 'de key is niet opnieuw versleuteld');
    // Zonder de ingebouwde sleutel (zoals productie): de webhook leest de key nog,
    // dus hij staat nu met MOLLIE_TOKEN_ENCRYPTION_KEY in de database.
    const res = await metOmgeving({ MOLLIE_ALLOW_MOCK: 'false' }, () => mollieBetaal(nieuw.betalingId, { status: 'paid' }));
    gelijk(res.status, 200, 'webhook na betalen');
    gelijk(sqlRij(`select status from public.invoices where id = ${q(nieuw.factuur.id)}`)?.status, 'paid', 'factuur');
  });
}
