import test from 'node:test';
import assert from 'node:assert/strict';
import { GOOGLE_LEGACY_CALENDAR_COLORS, vividCalendarColor } from './calendarColors.ts';

/** Kleursterkte: hoe ver de sterkste en zwakste kleurcomponent uit elkaar liggen. */
const chroma = (hex: string) => {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return Math.max(...v) - Math.min(...v);
};
const lightness = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
};

test("Google's oude bleke palet krijgt zijn volle tint, ook in hoofdletters of kort", () => {
  assert.equal(vividCalendarColor('#9fe1e7'), '#039BE5');
  assert.equal(vividCalendarColor('#9FE1E7'), '#039BE5');
  assert.equal(vividCalendarColor('#fad165'), '#F6BF26');
  assert.equal(vividCalendarColor('#c2c2c2'), '#616161');
  // De volle kleuren uit dat palet blijven staan: hun nieuwere Google-tint is zachter.
  assert.equal(vividCalendarColor('#4986e7'), '#4986E7');
  assert.equal(vividCalendarColor('#a47ae2'), '#A47AE2');
  // Lichtlavendel is pastel: voller, maar nog altijd paars en niet ineens diep.
  const lavendel = vividCalendarColor('#b99aff');
  assert.ok(chroma(lavendel) > chroma('#b99aff') && lightness(lavendel) > 0.55, lavendel);
  for (const [pale, vivid] of Object.entries(GOOGLE_LEGACY_CALENDAR_COLORS)) {
    // Grijs → grafiet heeft geen kleur, maar wel meer contrast: donkerder.
    if (pale === '#c2c2c2') assert.ok(lightness(vivid) < lightness(pale));
    else assert.ok(chroma(vivid) >= chroma(pale), `${pale} → ${vivid} is niet voller`);
  }
});

test('het merkgoud en de projectkleuren van de app blijven zoals ze zijn', () => {
  for (const color of ['#FFD966', '#34D399', '#60A5FA', '#A78BFA', '#F472B6', '#F06B6B', '#FF9F43', '#2DD4BF', '#FACC15', '#94A3B8']) {
    assert.equal(vividCalendarColor(color), color);
  }
  assert.equal(vividCalendarColor('#ffd966'), '#FFD966', 'alleen in hoofdletters gezet');
});

test('een andere heel bleke kleur wordt voller in dezelfde tint; grijs blijft grijs', () => {
  const pastelBlauw = vividCalendarColor('#cfe3fb');
  assert.ok(lightness(pastelBlauw) < 0.66, `${pastelBlauw} is nog bleek`);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(pastelBlauw.slice(i, i + 2), 16));
  assert.ok(b > r && b > g, `${pastelBlauw} is geen blauw meer`);
  assert.equal(vividCalendarColor('#eeeeee'), '#EEEEEE');
});

test('onbruikbaar of leeg wordt de terugvalkleur; een korte hexcode telt mee', () => {
  assert.equal(vividCalendarColor(null), '#FFD966');
  assert.equal(vividCalendarColor('blauw', '#2563EB'), '#2563EB');
  assert.equal(vividCalendarColor('#abc'), vividCalendarColor('#aabbcc'));
});
