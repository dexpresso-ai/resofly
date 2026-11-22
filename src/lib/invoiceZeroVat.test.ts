import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientCountryCode as appCountry, zeroVatIssues as appIssues } from './invoiceZeroVat.ts';
import { clientCountryCode as serverCountry, zeroVatIssues as serverIssues, zeroVatRefusal } from '../../supabase/functions/_shared/invoiceZeroVat.ts';

/**
 * 0% btw zonder reden, of met een reden die niet bij het land van de klant
 * past (bevinding 11, controle van 22 november 2026). Het formulier waarschuwt
 * en de server weigert, met dezelfde regels en dezelfde zinnen.
 */
const CODES = {
  HOOG: { kind: 'standard', salesBox: '1a' },
  NUL: { kind: 'zero', salesBox: '1e' },
  EXPORT: { kind: 'zero', salesBox: '3a' },
  ICP_GOED: { kind: 'icp_goods', salesBox: '3b' },
  ICP_DIENST: { kind: 'icp_services', salesBox: '3b' },
  VERL_VERK: { kind: 'reverse_charge_sales', salesBox: '1e' },
  VRIJ: { kind: 'exempt', salesBox: null },
};
const regel = (vat: number, vat_code?: string, unit_price = 500) => ({ description: 'Fotoreportage', quantity: 1, unit_price, vat, ...(vat_code ? { vat_code } : {}) });
const gent = { name: 'Studio Gent', country: 'België', vat_number: null };
const utrecht = { name: 'Bakkerij Aalbers', country: 'Nederland', vat_number: 'NL009876543B01' };
const boston = { name: 'Boston Media', country: 'Verenigde Staten', vat_number: null };

test('0% zonder code heeft geen reden; met een code die het uitlegt wel', () => {
  const zonder = serverIssues([regel(0)], CODES, utrecht);
  assert.deepEqual(zonder.map((i) => i.problem), ['zonder_reden']);
  assert.match(zonder[0].message, /Fotoreportage.*0% btw, maar niet waarom/);
  for (const code of ['NUL', 'VERL_VERK', 'VRIJ']) assert.deepEqual(serverIssues([regel(0, code)], CODES, utrecht), [], code);
  // Een onbekende code legt niets uit.
  assert.match(serverIssues([regel(0, 'ICP')], CODES, utrecht)[0].message, /btw-code "ICP" bestaat niet/);
});

test('tekstregels, de KOR en een administratie zonder btw-codes: niets te melden', () => {
  assert.deepEqual(serverIssues([regel(0, undefined, 0)], CODES, utrecht), [], 'een regel van € 0');
  assert.deepEqual(serverIssues([regel(0)], CODES, utrecht, { korEnabled: true }), [], 'met de KOR wordt het KOR');
  assert.deepEqual(serverIssues([regel(0)], {}, utrecht), [], 'zonder codes valt er niets te kiezen');
  assert.deepEqual(serverIssues([regel(0)], { HOOG: CODES.HOOG }, utrecht), [], 'alleen codes met btw: ook niets te kiezen');
  assert.deepEqual(serverIssues([regel(21, 'HOOG')], CODES, gent), [], '21% aan België');
});

test('de reden moet bij het land passen', () => {
  assert.deepEqual(serverIssues([regel(0, 'NUL')], CODES, gent).map((i) => i.problem), ['nul_in_eu']);
  assert.deepEqual(serverIssues([regel(0, 'NUL')], CODES, boston), [], 'dienst buiten de EU: niet in Nederland belast');
  assert.deepEqual(serverIssues([regel(0, 'EXPORT')], CODES, utrecht).map((i) => i.problem), ['export_niet_buiten_eu']);
  assert.deepEqual(serverIssues([regel(0, 'EXPORT')], CODES, gent).map((i) => i.problem), ['export_niet_buiten_eu']);
  assert.deepEqual(serverIssues([regel(0, 'EXPORT')], CODES, boston), []);
  assert.deepEqual(serverIssues([regel(0, 'ICP_DIENST')], CODES, utrecht).map((i) => i.problem), ['icp_in_nederland']);
  assert.deepEqual(serverIssues([regel(0, 'ICP_GOED')], CODES, boston).map((i) => i.problem), ['icp_buiten_eu']);
  assert.deepEqual(serverIssues([regel(0, 'ICP_DIENST')], CODES, gent), []);
});

test('het land komt uit het veld Land, anders uit het btw-nummer; onbekend is geen land', () => {
  assert.equal(serverCountry({ country: 'belgië' }), 'BE');
  assert.equal(serverCountry({ country: 'DE' }), 'DE');
  assert.equal(serverCountry({ country: '', vat_number: 'BE 0123.456.789' }), 'BE');
  assert.equal(serverCountry({ country: '', vat_number: 'EL123456789' }), 'GR');
  assert.equal(serverCountry({ country: 'Atlantis' }), null);
  assert.equal(serverCountry({ country: '', vat_number: null }), null);
  // Een land dat we niet kennen: niet weigeren op het land.
  assert.deepEqual(serverIssues([regel(0, 'NUL')], CODES, { name: 'X', country: 'Atlantis' }), []);
});

test('de weigering noemt elke regel', () => {
  const issues = serverIssues([regel(0), { ...regel(0, 'NUL'), description: 'Reiskosten' }], CODES, gent);
  const zin = zeroVatRefusal(issues) ?? '';
  assert.match(zin, /2 regels/);
  assert.match(zin, /Fotoreportage/);
  assert.match(zin, /Reiskosten/);
  assert.equal(zeroVatRefusal([]), null);
});

test('app en server zeggen hetzelfde', () => {
  const klanten = [gent, utrecht, boston, { name: 'Leeg', country: '', vat_number: 'DE123456789' }, null];
  const regels = [[regel(0)], [regel(0, 'NUL')], [regel(0, 'EXPORT')], [regel(0, 'ICP_GOED'), regel(0, 'ICP_DIENST')], [regel(21, 'HOOG'), regel(0, 'VRIJ')]];
  for (const klant of klanten) {
    assert.equal(appCountry(klant), serverCountry(klant));
    for (const lijst of regels) {
      for (const korEnabled of [false, true]) {
        assert.deepEqual(appIssues(lijst, CODES, klant, { korEnabled }), serverIssues(lijst, CODES, klant, { korEnabled }));
      }
    }
  }
});
