import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accentFace,
  brandStyle,
  brandThemeVars,
  contrastRatio,
  headerTheme,
  loginTheme,
  logoNeedsPlate,
  sanitizeStoredBranding,
  type BrandingPayload,
} from './branding.ts';
import { summarizeLogoPixels } from './logoColors.ts';

// Merkkleuren die in de praktijk lastig zijn: heel licht, heel donker, precies
// grijs, verzadigd, en de standaard. Plus kopkleuren van navy tot wit en
// precies in het midden van de grijstrap.
const ACCENTS = [
  '#FFD966', '#F7C548', '#2457C5', '#E4572E', '#3F8F4E', '#2B2B2B', '#8A7F70', '#00084D',
  '#FF00AA', '#7A7A7A', '#FFFFFF', '#000000', '#C2410C', '#14B8A6', '#FFFF00', '#6D28D9',
];
const HEADERS: Array<string | null> = [
  null, '#0F2A4A', '#173A2A', '#FFFFFF', '#F5F0E6', '#E4572E', '#7A7A7A', '#000000',
  '#FFD966', '#3B0A24', '#808080', '#2457C5', '#14B8A6', '#9CA3AF', '#FF00AA',
];

function branding(accentColor: string, headerColor: string | null, clientTheme = 'dark'): BrandingPayload {
  return { logoDataUrl: null, accentColor, footerText: null, hidePoweredBy: false, companyName: null, clientTheme, headerColor };
}

test('alles op de kop leest, voor elke merk- en kopkleur', () => {
  const failures: string[] = [];
  for (const accent of ACCENTS) {
    for (const header of HEADERS) {
      const h = headerTheme(branding(accent, header));
      for (const surface of h.surfaces) {
        for (const [name, ink] of [['tekst', h.ink], ['gedempt', h.ink2], ['merkkleur', h.accent]] as const) {
          const ratio = contrastRatio(ink, surface);
          if (ratio < 4.5) failures.push(`${accent} / ${header ?? 'auto'}: ${name} ${ink} op ${surface} = ${ratio.toFixed(2)}`);
        }
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('zonder kopkleur is de kop het grafiet van de cockpit, in de tint van het merk', () => {
  const gold = headerTheme(branding('#FFD966', null));
  assert.equal(gold.custom, false);
  assert.equal(gold.dark, true);
  // Donker genoeg dat het grafiet blijft: helderheid onder 2%.
  for (const stop of [gold.top, gold.mid, gold.bottom]) assert.ok(contrastRatio(stop, '#000000') < 1.6, stop);
  // Een grijs merk krijgt gewoon grijs grafiet, geen getinte kop.
  const grey = headerTheme(branding('#7A7A7A', null));
  const [r, g, b] = [1, 3, 5].map(i => parseInt(grey.mid.slice(i, i + 2), 16));
  assert.equal(r, g);
  assert.equal(g, b);
});

test('een eigen kopkleur staat er letterlijk, tenzij er niets op leest', () => {
  const navy = headerTheme(branding('#E4572E', '#0F2A4A'));
  assert.equal(navy.mid, '#0F2A4A');
  assert.equal(navy.headerAdjusted, false);
  assert.equal(navy.dark, true);
  // Koraal op navy haalt de 4,5 net niet: op de kop schuift hij op, de tint blijft.
  assert.equal(navy.accentAdjusted, true);

  const grey = headerTheme(branding('#000000', '#808080'));
  assert.equal(grey.headerAdjusted, true);
  assert.notEqual(grey.mid, '#808080');

  const white = headerTheme(branding('#2457C5', '#FFFFFF'));
  assert.equal(white.dark, false, 'op een witte kop staat donkere tekst');
});

test('het knopvlak houdt de tekst erop leesbaar', () => {
  for (const accent of ACCENTS) {
    const vars = brandThemeVars(branding(accent, null));
    const face = vars['--accent-face'];
    const onAccent = vars['--on-accent'];
    assert.equal(face, accentFace(accent.toUpperCase(), onAccent));
    const stops = face.startsWith('linear-gradient') ? face.match(/#[0-9A-F]{6}/g) ?? [] : [face];
    for (const stop of stops) {
      assert.ok(contrastRatio(onAccent, stop) >= 4.5, `${accent}: ${onAccent} op ${stop}`);
    }
  }
});

test('brandThemeVars levert de koptokens, ook zonder huisstijl', () => {
  const vars = brandThemeVars(null);
  for (const token of ['--hdr-top', '--hdr-mid', '--hdr-bottom', '--hdr-ink', '--hdr-ink-2', '--hdr-accent', '--hdr-glass', '--hdr-rings', '--accent-face']) {
    assert.ok(vars[token], `${token} ontbreekt`);
  }
  const h = headerTheme(branding('#2457C5', '#0F2A4A'));
  const themed = brandThemeVars(branding('#2457C5', '#0F2A4A'));
  assert.equal(themed['--hdr-mid'], h.mid);
  assert.equal(themed['--hdr-ink'], h.ink);
  assert.equal(themed['--hdr-scheme'], 'dark');
  assert.match(themed['--hdr-rings'], /^url\("data:image\/svg\+xml,/);
});

test('een donker logo op een donkere kop krijgt een plaatje, een licht logo niet', () => {
  const h = headerTheme(branding('#FFD966', null));
  assert.equal(logoNeedsPlate('#1A1A1A', [h.top, h.mid, h.bottom]), true);
  assert.equal(logoNeedsPlate('#F2F2F2', [h.top, h.mid, h.bottom]), false);
  assert.equal(logoNeedsPlate(null, [h.mid]), false);
  assert.equal(logoNeedsPlate('rood', [h.mid]), false);
});

test('de accenttekst van de galerij wordt tegen de galerij gemeten', () => {
  for (const galleryBg of ['#0B0B0B', '#12110E', '#F6F4F1', '#FFFFFF']) {
    for (const accentColor of ['#FFD966', '#2457C5', '#2B2B2B', '#E4572E']) {
      const style = brandStyle({ ...branding(accentColor, null), galleryBg }) as Record<string, string>;
      const ink = style['--gal-accent-ink'];
      assert.ok(contrastRatio(ink, galleryBg) >= 4.5, `${accentColor} op ${galleryBg}: ${ink}`);
    }
  }
});

test('de galerij krijgt leesbare tekst op de merkkleur en een eigen hovertint', () => {
  // Zonder deze tokens stond de knoptekst in de galerij op het donkere inkt van
  // ResoFly-goud (#1A1405) en werd een knop bij hover goud, wat het merk ook was.
  for (const accentColor of ACCENTS) {
    const style = brandStyle({ ...branding(accentColor, null), galleryBg: '#0B0B0B' }) as Record<string, string>;
    assert.ok(contrastRatio(style['--on-accent'], accentColor) >= 4.5, `${accentColor}: ${style['--on-accent']}`);
    assert.match(style['--accent-hover'], /^#[0-9A-F]{6}$/);
    assert.notEqual(style['--accent-hover'], '#FFD467');
    assert.equal(style['--accent-rgb'], [1, 3, 5].map(i => parseInt(accentColor.slice(i, i + 2), 16)).join(','));
  }
});

test('opgeslagen huisstijl van de schijf wordt opnieuw gekeurd', () => {
  const clean = sanitizeStoredBranding({
    accentColor: '#2457C5',
    headerColor: 'url(javascript:alert(1))',
    logoDarkDataUrl: 'data:image/svg+xml;base64,PHN2Zz4=',
  });
  assert.equal(clean?.headerColor, null);
  assert.equal(clean?.logoDarkDataUrl, null);
  const kept = sanitizeStoredBranding({
    accentColor: '#2457C5',
    headerColor: '#0F2A4A',
    logoDarkDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  });
  assert.equal(kept?.headerColor, '#0F2A4A');
  assert.equal(kept?.logoDarkDataUrl, 'data:image/png;base64,iVBORw0KGgo=');
});

test('kleuren uit een logo: doorzichtig telt niet, wit alleen voor de gemiddelde kleur', () => {
  const px = (r: number, g: number, b: number, a = 255) => [r, g, b, a];
  const data = [
    ...px(15, 42, 74), ...px(15, 42, 74), ...px(15, 42, 74), ...px(16, 43, 75), // navy
    ...px(228, 87, 46), ...px(228, 87, 46), // koraal
    ...px(255, 255, 255), ...px(255, 255, 255), // wit (achtergrond van een jpg)
    ...px(200, 0, 0, 0), ...px(0, 200, 0, 40), // doorzichtig
  ];
  const summary = summarizeLogoPixels(data);
  assert.deepEqual(summary.colors, ['#0F2A4A', '#E4572E']);
  // Gemiddelde van de acht zichtbare pixels, wit meegeteld.
  assert.equal(summary.ink, '#806B70');
  assert.deepEqual(summarizeLogoPixels([0, 0, 0, 0]), { ink: null, colors: [] });
});

// ── Het inlogscherm (2026-11-05) ────────────────────────────────────────────

// Kaartkleuren van wit tot zwart, met precies het midden van de grijstrap
// (waar geen tekst de 4,75 haalt zonder de kaart op te schuiven), verzadigde
// kleuren en de standaard (null = het werkvlak).
const CARDS: Array<string | null> = [
  null, '#FFFFFF', '#F5F0E6', '#000000', '#111111', '#777777', '#7A7A7A', '#808080', '#959595',
  '#0F2A4A', '#E4572E', '#FFD966', '#14B8A6', '#2457C5', '#FF00AA', '#3B0A24', '#C2C2C2', '#4D4D4D',
];
const BUTTONS: Array<string | null> = [null, '#FFFFFF', '#000000', '#E4572E', '#FFD966', '#7A7A7A', '#2457C5', '#F5F0E6', '#0F2A4A'];

function login(accent: string, card: string | null, button: string | null, clientTheme = 'dark', extra: Partial<BrandingPayload> = {}): BrandingPayload {
  return { ...branding(accent, null, clientTheme), loginCard: card, loginButton: button, ...extra };
}

test('alles op de inlogkaart leest, voor elke kaart-, knop- en merkkleur', () => {
  const failures: string[] = [];
  const min = (ink: string, surfaces: string[]) => Math.min(...surfaces.map(bg => contrastRatio(ink, bg)));
  for (const accent of ['#FFD966', '#2457C5', '#7A7A7A', '#00084D', '#FFFFFF']) {
    for (const theme of ['dark', 'light']) {
      for (const card of CARDS) {
        for (const button of BUTTONS) {
          const t = loginTheme(login(accent, card, button, theme));
          const where = `${accent}/${theme} kaart ${card ?? 'auto'} knop ${button ?? 'auto'}`;
          // Een eigen kaart rekent naar de marge van 4,75; het werkvlak is al
          // afgewogen in de tokens (zie de tests hierboven) en blijft gelijk.
          const target = card ? 4.75 : 4.5;
          // De zachte tint telt alleen waar hij gebruikt wordt: bij een eigen
          // kaart (--muted), en altijd als voorbeeldtekst in het invulveld.
          const soft: Array<readonly [string, string, number]> = card ? [['zacht', t.ink3, 4.5]] : [];
          for (const [name, ink, need] of [['tekst', t.ink, target], ['gedempt', t.ink2, target], ['voorbeeldtekst', t.placeholder, 4.5], ...soft] as const) {
            const ratio = min(ink, t.cardSurfaces);
            if (ratio < need - 1e-9) failures.push(`${where}: ${name} ${ink} = ${ratio.toFixed(2)}`);
          }
          const accentRatio = min(t.accentInk, t.cardSurfaces);
          if ((card || button) && accentRatio < 4.75 - 1e-9) failures.push(`${where}: knopkleur als tekst ${t.accentInk} = ${accentRatio.toFixed(2)}`);
          const onButton = contrastRatio(t.onButton, t.button);
          if (onButton < 4.5) failures.push(`${where}: tekst op de knop = ${onButton.toFixed(2)}`);
          // WCAG 1.4.11: de knop zelf, of anders zijn rand, 3 : 1 tegen de kaart.
          const edge = contrastRatio(t.buttonEdge ?? t.button, t.card);
          if (edge < 3 - 1e-9) failures.push(`${where}: knop op de kaart = ${edge.toFixed(2)}`);
          if (card) {
            for (const name of ['--accent-g', '--accent-r'] as const) {
              const ink = t.vars[name];
              const ratio = min(ink, [t.card]);
              if (ratio < 4.75 - 1e-9) failures.push(`${where}: ${name} ${ink} = ${ratio.toFixed(2)}`);
            }
          }
        }
      }
    }
  }
  assert.deepEqual(failures.slice(0, 12), [], `${failures.length} combinaties lezen niet`);
});

test('zonder eigen kleuren verandert er niets aan het inlogscherm', () => {
  for (const theme of ['dark', 'light']) {
    for (const accent of ['#FFD966', '#2457C5', '#7A7A7A']) {
      for (const header of [null, '#0F2A4A', '#FFFFFF']) {
        const b = { ...branding(accent, header, theme) };
        const root = brandThemeVars(b);
        const t = loginTheme(b);
        // De achtergrond is precies de kop.
        for (const name of ['--hdr-top', '--hdr-mid', '--hdr-bottom', '--hdr-ink', '--hdr-ink-2', '--hdr-glow', '--hdr-counter', '--hdr-rings', '--hdr-scheme'] as const) {
          assert.equal(t.vars[name], root[name], `${accent}/${header}/${theme}: ${name}`);
        }
        // De kaart, de tekst en de knop komen van het werkvlak: geen eigen waarden.
        for (const name of ['--surface', '--ink', '--ink-2', '--accent', '--accent-ink', '--on-accent', '--text', '--border']) {
          assert.equal(t.vars[name], undefined, `${accent}/${header}/${theme}: ${name} hoort niet overschreven te worden`);
        }
        assert.equal(t.card, root['--surface']);
        assert.equal(t.vars['--login-card-scheme'], theme);
        assert.equal(t.cardCustom || t.buttonCustom || t.backgroundCustom || t.plain, false);
      }
    }
  }
});

test('een eigen achtergrond staat er letterlijk, effen zonder gloed en ringen', () => {
  const navy = loginTheme(login('#E4572E', null, null, 'dark', { loginBackground: '#0F2A4A' }));
  assert.equal(navy.backgroundCustom, true);
  assert.equal(navy.vars['--hdr-mid'], '#0F2A4A');
  assert.notEqual(navy.vars['--hdr-rings'], 'none');
  // De gloed linksboven is die van de knop (hier: de merkkleur).
  assert.match(navy.vars['--hdr-glow'], /^rgba\(228,87,46,/);

  const plain = loginTheme(login('#E4572E', null, '#14B8A6', 'dark', { loginBackground: '#0F2A4A', loginPlain: true }));
  assert.equal(plain.vars['--hdr-top'], '#0F2A4A');
  assert.equal(plain.vars['--hdr-bottom'], '#0F2A4A');
  assert.equal(plain.vars['--hdr-glow'], 'transparent');
  assert.equal(plain.vars['--hdr-counter'], 'transparent');
  assert.equal(plain.vars['--hdr-rings'], 'none');

  // Een achtergrond midden in de grijstrap schuift op, zoals de kop: er staat
  // tekst op (het laadscherm). Dat meldt de instellingenpagina.
  const grey = loginTheme(login('#FFD966', null, null, 'dark', { loginBackground: '#808080' }));
  assert.equal(grey.background.headerAdjusted, true);
});

test('een kaart midden in de grijstrap schuift op tot de tekst leest', () => {
  const t = loginTheme(login('#FFD966', '#777777', null));
  assert.equal(t.cardAdjusted, true);
  assert.notEqual(t.card, '#777777');
  assert.ok(Math.min(...t.cardSurfaces.map(bg => contrastRatio(t.ink, bg))) >= 4.75);
  // Een kaart waarop het gewoon leest, blijft precies de gekozen kleur.
  const white = loginTheme(login('#FFD966', '#FFFFFF', null));
  assert.equal(white.cardAdjusted, false);
  assert.equal(white.card, '#FFFFFF');
  assert.equal(white.vars['--surface'], '#FFFFFF');
  assert.equal(white.vars['--login-card-scheme'], 'light');
  assert.equal(white.cardDark, false);
});

test('een witte knop op een witte kaart krijgt een rand, een donkere niet', () => {
  const white = loginTheme(login('#FFD966', '#FFFFFF', '#FFFFFF'));
  assert.ok(white.buttonEdge, 'rand verwacht');
  assert.ok(contrastRatio(white.buttonEdge!, '#FFFFFF') >= 3);
  assert.equal(white.vars['--login-btn-edge'], white.buttonEdge);
  const dark = loginTheme(login('#FFD966', '#FFFFFF', '#0F2A4A'));
  assert.equal(dark.buttonEdge, null);
  assert.equal(dark.vars['--login-btn-edge'], undefined);
  // De knopkleur zelf blijft de gekozen kleur; alleen de tekst erop wordt uitgerekend.
  assert.equal(dark.vars['--accent'], '#0F2A4A');
  assert.equal(dark.button, '#0F2A4A');
});

test('een eigen kaart geeft ook de compat-laag mee, zodat het invulveld meekleurt', () => {
  const t = loginTheme(login('#FFD966', '#FFFFFF', null, 'dark'));
  for (const name of ['--bg2', '--bg3', '--panel', '--border', '--border2', '--text', '--muted', '--muted2', '--sheen-rgb', '--sheen-k', '--ink-rgb', '--surface-rgb', '--field', '--line-3', '--focus-line', '--hi']) {
    assert.ok(t.vars[name], `${name} ontbreekt`);
  }
  assert.equal(t.vars['--text'], t.ink);
  // Het invulveld hoort bij de kaart: wit op een witte kaart, niet het bijna-zwart van Donker.
  assert.equal(t.vars['--field'], '#FFFFFF');
  assert.deepEqual(t.cardSurfaces, ['#FFFFFF', '#FFFFFF']);
  const navy = loginTheme(login('#FFD966', '#0F2A4A', null, 'light'));
  assert.ok(navy.cardDark);
  assert.ok(contrastRatio(navy.vars['--field'], '#0F2A4A') > 1, 'een dieper veld op een donkere kaart');
  assert.equal(t.vars['--sheen-rgb'], '26,23,16', 'lichte kaart: glans van inkt, niet van wit');
});

test('de kleuren van het inlogscherm van de schijf worden opnieuw gekeurd', () => {
  const kept = sanitizeStoredBranding({ accentColor: '#FFD966', loginBackground: '#0f2a4a', loginCard: '#FFFFFF', loginButton: '#E4572E', loginPlain: true });
  assert.equal(kept?.loginBackground, '#0F2A4A');
  assert.equal(kept?.loginCard, '#FFFFFF');
  assert.equal(kept?.loginButton, '#E4572E');
  assert.equal(kept?.loginPlain, true);
  const dropped = sanitizeStoredBranding({ accentColor: '#FFD966', loginBackground: 'red', loginCard: 'url(https://x.test/a.png)', loginButton: '#12345', loginPlain: 'true' });
  assert.equal(dropped?.loginBackground, null);
  assert.equal(dropped?.loginCard, null);
  assert.equal(dropped?.loginButton, null);
  assert.equal(dropped?.loginPlain, false);
});
