import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadInvoiceSendMethod, loadMollieInvoicingAllowed } from './invoiceSendMethod.ts';

/**
 * De verzendwijze van een organisatie lezen (invoiceSendMethod.ts): altijd per
 * organisatie, en een database zonder de nieuwe kolom gedraagt zich zoals
 * vóór de keuze bestond. Een andere fout mag niet stil "via Mollie" worden.
 */

const ORG = '0000000a-0000-0000-0000-000000000001';
const ANDERE_ORG = '0000000b-0000-0000-0000-000000000002';

type Rij = { organization_id: string; invoice_send_method?: unknown };

function nepDb(rijen: Rij[], fout: { code?: string; message: string } | null = null) {
  const lezingen: Array<{ tabel: string; kolommen: string; filters: Array<[string, unknown]> }> = [];
  const db = {
    from(tabel: string) {
      return {
        select(kolommen: string) {
          const filters: Array<[string, unknown]> = [];
          const query = {
            eq(kolom: string, waarde: unknown) { filters.push([kolom, waarde]); return query; },
            async maybeSingle() {
              lezingen.push({ tabel, kolommen, filters });
              if (fout) return { data: null, error: fout };
              const gevonden = rijen.find((rij) => filters.every(([kolom, waarde]) => (rij as Record<string, unknown>)[kolom] === waarde));
              return { data: gevonden ? { invoice_send_method: gevonden.invoice_send_method ?? null } : null, error: null };
            },
          };
          return query;
        },
      };
    },
  };
  return { db, lezingen };
}

test('leest de keuze van precies deze organisatie', async () => {
  const { db, lezingen } = nepDb([
    { organization_id: ANDERE_ORG, invoice_send_method: 'mollie' },
    { organization_id: ORG, invoice_send_method: 'email' },
  ]);
  assert.equal(await loadInvoiceSendMethod(db, ORG), 'email');
  assert.equal(await loadMollieInvoicingAllowed(db, ORG), false);
  assert.equal(await loadMollieInvoicingAllowed(db, ANDERE_ORG), true);
  assert.deepEqual(lezingen[0], { tabel: 'company_settings', kolommen: 'invoice_send_method', filters: [['organization_id', ORG]] });
});

test('nog niets gekozen of nog geen bedrijfsgegevens: zoals het was', async () => {
  const { db } = nepDb([{ organization_id: ORG, invoice_send_method: null }]);
  assert.equal(await loadInvoiceSendMethod(db, ORG), null);
  assert.equal(await loadMollieInvoicingAllowed(db, ORG), true);
  assert.equal(await loadMollieInvoicingAllowed(db, ANDERE_ORG), true);
  // Een waarde die de database niet zou toelaten, telt niet als een keuze.
  assert.equal(await loadInvoiceSendMethod(nepDb([{ organization_id: ORG, invoice_send_method: 'peppol' }]).db, ORG), null);
});

test('een database van vóór de migratie kent de kolom niet: zoals het was', async () => {
  const kolomOntbreekt = nepDb([], { code: '42703', message: 'column company_settings.invoice_send_method does not exist' });
  assert.equal(await loadMollieInvoicingAllowed(kolomOntbreekt.db, ORG), true);
  const schemaCache = nepDb([], { message: "Could not find the 'invoice_send_method' column of 'company_settings' in the schema cache" });
  assert.equal(await loadInvoiceSendMethod(schemaCache.db, ORG), null);
});

test('een andere fout gooit hij door, in plaats van stil Mollie toe te laten', async () => {
  const { db } = nepDb([], { message: 'canceling statement due to statement timeout' });
  await assert.rejects(() => loadMollieInvoicingAllowed(db, ORG), /verzendwijze/);
});
