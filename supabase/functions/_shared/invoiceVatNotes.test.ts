import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invoiceVatNotes } from './invoiceVatNotes.ts';

const CODES = {
  HOOG: { kind: 'standard', salesBox: '1a' },
  NUL: { kind: 'zero', salesBox: '1e' },
  EXPORT: { kind: 'zero', salesBox: '3a' },
  ICP_GOED: { kind: 'icp_goods', salesBox: '3b' },
  ICP_DIENST: { kind: 'icp_services', salesBox: '3b' },
  VERL_VERK: { kind: 'reverse_charge_sales', salesBox: '1e' },
  VRIJ: { kind: 'exempt', salesBox: null },
  KOR: { kind: 'kor', salesBox: null },
};

test('gewone binnenlandse factuur: geen extra vermelding', () => {
  assert.deepEqual(invoiceVatNotes([{ vat_code: 'HOOG' }, { vat_code: 'NUL' }, {}], CODES), { notes: [], needsCustomerVatNumber: false, reasons: [] });
});

test('verlegd en ICP: vermelding én btw-nummer van de afnemer verplicht', () => {
  const verlegd = invoiceVatNotes([{ vat_code: 'VERL_VERK' }], CODES);
  assert.equal(verlegd.needsCustomerVatNumber, true);
  assert.match(verlegd.notes[0], /^Btw verlegd/);
  const icp = invoiceVatNotes([{ vat_code: 'ICP_GOED' }, { vat_code: 'ICP_DIENST' }], CODES);
  assert.equal(icp.needsCustomerVatNumber, true);
  assert.equal(icp.notes.length, 2);
  assert.match(icp.notes[0], /Intracommunautaire levering/);
  assert.match(icp.notes[1], /Btw verlegd: dienst/);
});

test('export, vrijstelling en KOR: vermelding zonder btw-nummerplicht', () => {
  const r = invoiceVatNotes([{ vat_code: 'EXPORT' }, { vat_code: 'VRIJ' }, { vat_code: 'KOR' }], CODES);
  assert.equal(r.needsCustomerVatNumber, false);
  assert.deepEqual(r.notes.map((n) => n.split(' ')[0]), ['Uitvoer', 'Vrijgesteld', 'Vrijgesteld']);
});

test('onbekende code wordt genegeerd', () => {
  assert.deepEqual(invoiceVatNotes([{ vat_code: 'ONBEKEND' }], CODES).notes, []);
});
