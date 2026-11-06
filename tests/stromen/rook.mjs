// Rooktest van de harnas: één offerte door de hele keten.
import { roep } from './functies.mjs';
import { mailsAan } from './nepdiensten.mjs';
import { rest, rpc } from './supabase.mjs';
import { gelukt, gelijk, groep, stap, verwacht } from './toets.mjs';
import { maakWereld, REGELS } from './wereld.mjs';

export default async function rook() {
  groep('Rooktest harnas');
  const w = await stap('wereld maken', () => maakWereld('rook'));
  if (!w) return;
  const offerte = await stap('concept-offerte opslaan als lid', async () => {
    const res = await rest('quotes?select=*', {
      method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, client_id: w.klantA.id, number: 'OFF-ROOK-0001', date: '2026-11-06', valid_until: '2026-12-31', lines: REGELS, status: 'draft' },
    });
    gelukt(res, 'opslaan');
    return res.json[0];
  });
  await stap('ter goedkeuring en goedkeuren', async () => {
    gelukt(await rpc('submit_quote_for_internal_approval', { p_quote_id: offerte.id, p_organization_id: w.orgId }, w.medewerker.token), 'indienen');
    gelukt(await rpc('approve_quote_internal', { p_quote_id: offerte.id, p_organization_id: w.orgId }, w.beheerder.token), 'goedkeuren');
  });
  const verstuurd = await stap('versturen via quote-workflow', async () => {
    const res = await roep('quote-workflow', { token: w.medewerker.token, body: { action: 'sendQuoteEmail', organizationId: w.orgId, quoteId: offerte.id } });
    return gelukt(res, 'versturen');
  });
  const token = await stap('mail ontvangen met link en PDF', async () => {
    const mails = mailsAan(w.klantA.email);
    gelijk(mails.length, 1, 'aantal mails');
    verwacht(mails[0].bijlagen.some((b) => b.naam.endsWith('.pdf')), 'PDF-bijlage ontbreekt');
    const m = `${mails[0].html} ${mails[0].text}`.match(/\/quote\/([A-Za-z0-9_-]{20,})/);
    verwacht(m, 'geen offertelink in de mail');
    verwacht(!JSON.stringify(verstuurd).includes(m[1]), 'de link ging terug naar de verzender');
    return m[1];
  });
  await stap('publiek bekijken en akkoord geven', async () => {
    const bekijk = await roep('quote-public', { body: { action: 'getQuote', token } });
    gelukt(bekijk, 'bekijken');
    const akkoord = await roep('quote-public', { body: { action: 'acceptQuote', token, name: 'Anna Klant', email: w.klantA.email, note: 'Akkoord' } });
    gelukt(akkoord, 'akkoord');
  });
  await stap('omzetten naar factuur', async () => {
    const res = await rpc('convert_accepted_quote_to_invoice', { p_quote_id: offerte.id, p_organization_id: w.orgId }, w.medewerker.token);
    const factuur = gelukt(res, 'omzetten');
    const rij = Array.isArray(factuur) ? factuur[0] : factuur;
    gelijk(Number(rij.total_amount), 173.63, 'factuurtotaal');
  });
}
