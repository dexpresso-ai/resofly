import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPortalLoginEmail } from './emailTemplates/portalLogin.ts';

test('de inlogmail: van de leverancier, in het Nederlands, met link en code', () => {
  const mail = renderPortalLoginEmail({
    supplierName: 'Fotostudio <Jansen>',
    accentColor: '#2E8B76',
    loginUrl: 'https://jansen.resofly.com/portal/inloggen?aanvraag=abc_123',
    code: '1234 5678',
    minutes: 15,
  });
  assert.equal(mail.subject, 'Inloggen bij Fotostudio <Jansen>');
  assert.match(mail.html, /het klantportaal van Fotostudio &lt;Jansen&gt;/, 'de naam is ge-escaped');
  assert.ok(!mail.html.includes('<Jansen>'));
  assert.match(mail.html, /href="https:\/\/jansen\.resofly\.com\/portal\/inloggen\?aanvraag=abc_123"/);
  assert.match(mail.html, /12345678/, 'de code zonder spaties');
  assert.match(mail.html, /15 minuten/);
  assert.match(mail.html, /alleen in de browser waarin je hem aanvroeg/);
  assert.match(mail.text, /https:\/\/jansen\.resofly\.com\/portal\/inloggen\?aanvraag=abc_123/);
  assert.match(mail.text, /Vul deze code in op het inlogscherm van jansen\.resofly\.com: 12345678/);
  assert.ok(!/magic link/i.test(mail.html + mail.text), 'geen Engelse standaardtekst');
});

test('de inlogmail zegt waar de code hoort: het adres van de link', () => {
  const mail = renderPortalLoginEmail({
    supplierName: 'Fotostudio Jansen',
    loginUrl: 'https://portaal.fotostudiojansen.nl/portal/inloggen?aanvraag=abc_123',
    code: '12345678',
    minutes: 15,
  });
  assert.match(mail.html, /inlogscherm van <strong[^>]*>portaal\.fotostudiojansen\.nl<\/strong>/);
  assert.match(mail.html, /Vul de code alleen in op portaal\.fotostudiojansen\.nl\. Vraagt een andere website erom, vul hem dan niet in\./);
  assert.match(mail.text, /Vul de code alleen in op portaal\.fotostudiojansen\.nl\./);
  // Een onleesbare link: dan geen adres, maar wel de code.
  const zonder = renderPortalLoginEmail({ supplierName: null, loginUrl: 'geen-url', code: '12345678', minutes: 15 });
  assert.match(zonder.text, /Vul deze code in op het inlogscherm: 12345678/);
  assert.ok(!/alleen in op/.test(zonder.text));
});

test('de inlogmail van het algemene portaal, zonder code', () => {
  const mail = renderPortalLoginEmail({ supplierName: null, loginUrl: 'https://staging.resofly.com/portal/inloggen?aanvraag=x', code: null, minutes: 15 });
  assert.equal(mail.subject, 'Inloggen op je klantportaal');
  assert.ok(!/ander apparaat/.test(mail.html), 'zonder code geen zin over een code');
  assert.ok(!/Vul deze code in/.test(mail.text));
});
