import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scaleFontDecl, scaleSize } from './letterSchaal.ts';

// De bouwstap die elke lettergrootte laat meeschalen met var(--letter). Gaat
// hier iets mis, dan krimpt een invoerveld onder de 16px (iOS zoomt dan bij
// elke tik in), of verandert een maat die bewust vast staat.

const scaled = (token: string) => `max(10px, calc(${token} * var(--letter, 1)))`;

test('px en rem schalen mee, met 10px als bodem', () => {
  assert.equal(scaleSize('12px'), scaled('12px'));
  assert.equal(scaleSize('12.5px'), scaled('12.5px'));
  assert.equal(scaleSize('.92rem'), scaled('.92rem'));
  assert.equal(scaleFontDecl({ prop: 'font-size', value: '13px', selector: '.tc-title' }), scaled('13px'));
});

test('kleine tekst, em, % en functies blijven staan', () => {
  for (const value of ['10px', '9.5px', '8px', '.5rem', '1.2em', '90%', 'inherit', '0', 'clamp(24px,3vw,34px)', 'var(--x)', 'calc(12px + 1vw)']) {
    assert.equal(scaleFontDecl({ prop: 'font-size', value, selector: '.x' }), null, value);
  }
});

test('een invoerveld van 16px blijft 16px: anders zoomt iOS in', () => {
  for (const selector of [
    '.form-input,.form-textarea,.form-select,.select-control .select-trigger,\n  .lines-editor input,.line input',
    '.ticket-search input',
    '.agx-input textarea',
    '.tmc-search input,.tmc-input',
    ':root[data-stroom] .sl-pal-in input',
    '[contenteditable]',
  ]) {
    assert.equal(scaleFontDecl({ prop: 'font-size', value: '16px', selector }), null, selector);
  }
  // Een veld met een kleinere letter zoomt toch al; dat schaalt gewoon mee.
  assert.equal(scaleFontDecl({ prop: 'font-size', value: '13px', selector: '.form-input' }), scaled('13px'));
  // Een kop van 16px is geen veld, ook al staat "form" in de naam.
  assert.equal(scaleFontDecl({ prop: 'font-size', value: '16px', selector: '.client-form-intro h3' }), scaled('16px'));
  assert.equal(scaleFontDecl({ prop: 'font-size', value: '16px', selector: '.select-option' }), scaled('16px'));
});

test('font: alleen de lettergrootte verandert', () => {
  assert.equal(scaleFontDecl({ prop: 'font', value: '600 12.5px/1.2 var(--font-sans)' }), `600 ${scaled('12.5px')}/1.2 var(--font-sans)`);
  assert.equal(scaleFontDecl({ prop: 'font', value: '500 14px var(--font-sans)' }), `500 ${scaled('14px')} var(--font-sans)`);
  // De regelhoogte achter de schuine streep is geen lettergrootte.
  assert.equal(scaleFontDecl({ prop: 'font', value: '600 9px/18px var(--font-sans)' }), null);
  assert.equal(scaleFontDecl({ prop: 'font', value: '600 clamp(32px,4.6cqi,56px)/1.03 var(--font-sans)' }), null);
  assert.equal(scaleFontDecl({ prop: 'font', value: 'inherit' }), null);
  assert.equal(scaleFontDecl({ prop: 'font', value: '400 16.5px/1 var(--font-sans)', selector: ':root[data-stroom] .sl-pal-in input' }), null);
});

test('printregels blijven staan', () => {
  assert.equal(scaleFontDecl({ prop: 'font-size', value: '12px', selector: '.x', inPrint: true }), null);
});
