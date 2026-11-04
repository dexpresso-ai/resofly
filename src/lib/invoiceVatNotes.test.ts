import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invoiceVatNotes as appNotes } from './invoiceVatNotes.ts';
import { invoiceVatNotes as serverNotes } from '../../supabase/functions/_shared/invoiceVatNotes.ts';

/**
 * De pdf in de app (concept/voorbeeld) en de verzonden pdf (invoice-workflow)
 * moeten dezelfde verplichte btw-vermeldingen tonen.
 */
const CODES = {
  HOOG: { kind: 'standard', salesBox: '1a' },
  EXPORT: { kind: 'zero', salesBox: '3a' },
  ICP_GOED: { kind: 'icp_goods', salesBox: '3b' },
  ICP_DIENST: { kind: 'icp_services', salesBox: '3b' },
  VERL_VERK: { kind: 'reverse_charge_sales', salesBox: '1e' },
  VRIJ: { kind: 'exempt', salesBox: null },
  KOR: { kind: 'kor', salesBox: null },
};

test('app en server geven dezelfde btw-vermeldingen', () => {
  const cases = [
    [{ vat_code: 'HOOG' }],
    [{ vat_code: 'VERL_VERK' }, { vat_code: 'HOOG' }],
    [{ vat_code: 'ICP_GOED' }, { vat_code: 'ICP_DIENST' }, { vat_code: 'EXPORT' }],
    [{ vat_code: 'VRIJ' }, { vat_code: 'KOR' }, { vat_code: null }],
  ];
  for (const lines of cases) assert.deepEqual(appNotes(lines, CODES), serverNotes(lines, CODES));
});
