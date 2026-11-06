import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRANDING_COLUMNS, DEFAULT_BRANDING, NEWEST_BRANDING_COLUMNS, sanitizeBranding, withoutNewestBrandingColumns } from './branding.ts';

test('de kleuren van het inlogscherm gaan mee naar het portaal, gekeurd', () => {
  const branding = sanitizeBranding({
    brand_accent_color: '#FFD966',
    brand_login_bg_color: '#0f2a4a',
    brand_login_card_color: '#FFFFFF',
    brand_login_button_color: '#E4572E',
    brand_login_plain: true,
  });
  assert.equal(branding.loginBackground, '#0F2A4A');
  assert.equal(branding.loginCard, '#FFFFFF');
  assert.equal(branding.loginButton, '#E4572E');
  assert.equal(branding.loginPlain, true);

  const bad = sanitizeBranding({ brand_login_bg_color: 'red', brand_login_card_color: 'url(x)', brand_login_button_color: null, brand_login_plain: 'true' });
  assert.equal(bad.loginBackground, null);
  assert.equal(bad.loginCard, null);
  assert.equal(bad.loginButton, null);
  assert.equal(bad.loginPlain, false);

  assert.deepEqual(
    [DEFAULT_BRANDING.loginBackground, DEFAULT_BRANDING.loginCard, DEFAULT_BRANDING.loginButton, DEFAULT_BRANDING.loginPlain],
    [null, null, null, false],
  );
});

test('zonder de nieuwste migratie valt alleen het inlogscherm terug', () => {
  for (const column of NEWEST_BRANDING_COLUMNS) assert.ok(BRANDING_COLUMNS.split(',').includes(column), column);
  const legacy = withoutNewestBrandingColumns(BRANDING_COLUMNS).split(',');
  for (const column of NEWEST_BRANDING_COLUMNS) assert.ok(!legacy.includes(column), column);
  // De kopkleur en de lichte logoversie (20261015000000) staan overal en blijven.
  for (const column of ['brand_header_color', 'brand_logo_dark_data_url', 'brand_accent_color', 'brand_logo_data_url']) {
    assert.ok(legacy.includes(column), column);
  }
});

test('de huisstijl die naar buiten gaat is een vaste lijst, nooit de hele rij', () => {
  const branding = sanitizeBranding({ brand_accent_color: '#123456', invoice_template_data_url: 'data:…', default_hourly_rate_cents: 9500, organization_id: 'org' });
  assert.deepEqual(Object.keys(branding).sort(), Object.keys(DEFAULT_BRANDING).sort());
});
