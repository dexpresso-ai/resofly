/**
 * De opmaak van de klantmails: de knop en de bovenregel staan in de merkkleur
 * van de organisatie, en blijven leesbaar bij elke merkkleur. Draaien met:
 * npm test
 *
 * Tot november 2026 stond de knoptekst vast op #111111 en de bovenregel in de
 * merkkleur zelf; bij een donkerblauw merk (#00084D) was allebei onzichtbaar.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { accentOnDark, EMAIL_CARD, emailContrast, renderEmailLayout, textOnAccent } from './emailTemplates/layout.ts';
import { renderTransferBlockHtml } from './emailTemplates/fileTransfer.ts';

const ACCENTS = ['#FFD966', '#F7C548', '#2457C5', '#E4572E', '#3F8F4E', '#2B2B2B', '#8A7F70', '#00084D', '#FF00AA', '#7A7A7A', '#FFFFFF', '#000000', '#14B8A6', '#6D28D9'];

test('tekst op de knop en de merkkleur op de kaart halen 4,5 : 1', () => {
  for (const accent of ACCENTS) {
    assert.ok(emailContrast(textOnAccent(accent), accent) >= 4.5, `knop ${accent}`);
    assert.ok(emailContrast(accentOnDark(accent), EMAIL_CARD) >= 4.5, `bovenregel ${accent}`);
    assert.ok(emailContrast(accentOnDark(accent, '#121215'), '#121215') >= 4.5, `code ${accent}`);
  }
  // Een merkkleur die al leest, blijft precies zichzelf.
  assert.equal(accentOnDark('#FFD966'), '#FFD966');
  // Rommel valt terug op het standaardgoud, nooit op iets wat CSS breekt.
  assert.equal(textOnAccent('url(javascript:x)'), '#111111');
});

test('de mail gebruikt de leesbare kleuren', () => {
  const html = renderEmailLayout({
    brandName: 'Studio Noord',
    title: 'Je factuur',
    introHtml: '<p>Hoi</p>',
    cta: { label: 'Bekijk', url: 'https://example.test' },
    accentColor: '#00084D',
  });
  assert.match(html, /background:#00084D;color:#FFFFFF;/);
  assert.doesNotMatch(html, /color:#00084D;font-size:13px/);
  const block = renderTransferBlockHtml({ url: 'https://example.test/t', fileCount: 2, totalBytes: 2048, expiresAt: '2026-12-01T00:00:00Z', accentColor: '#00084D' });
  assert.match(block, /background:#00084D;color:#FFFFFF;/);
});
