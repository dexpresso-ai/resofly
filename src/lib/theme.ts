import { useCallback, useSyncExternalStore } from 'react';
import { isDaylight, nextSunChange } from './sun';

/** Donker of licht: wat er op het scherm staat. Donker is de ResoFly-identiteit
 *  en blijft de standaard; licht is een bewuste keuze van de gebruiker. */
export type Theme = 'dark' | 'light';

/** Wat de gebruiker kiest. Naast Nacht ('dark') en Dag ('light') twee standen
 *  die zelf wisselen: 'sun' volgt zon op en zon onder (Zenit, "Met de zon
 *  mee"), 'system' volgt het apparaat. De CSS kent alleen donker en licht
 *  (`data-theme="light"`); deze module rekent een stand om naar één van die twee. */
export type ThemeMode = Theme | 'sun' | 'system';

/** Zelfde sleutel als het bootstrap-script in index.html — die twee MOETEN
 *  gelijk blijven, anders flitst de app bij elke pagelaad in het verkeerde
 *  thema voordat React draait. Bevat de stand, niet het opgeloste thema. */
export const THEME_STORAGE_KEY = 'resofly.theme';

/** De grondkleur per thema, voor de adresbalk op mobiel (`meta[name=theme-color]`).
 *  Gelijk houden aan --bg-deep in globals.css (Belicht) en zenit.css (Zenit),
 *  en aan het bootstrap-script in index.html. */
const THEME_COLOR: Record<'cockpit' | 'zenit', Record<Theme, string>> = {
  cockpit: { dark: '#09090A', light: '#F1F0EC' },
  zenit: { dark: '#08080A', light: '#EDEBE5' },
};

export function loadThemeMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'sun' || stored === 'system' ? stored : 'dark';
  } catch {
    // Privémodus of geblokkeerde opslag: dan gewoon donker.
    return 'dark';
  }
}

/** Welk thema hoort er nu bij deze stand? */
export function resolveTheme(mode: ThemeMode, now: Date = new Date()): Theme {
  if (mode === 'sun') return isDaylight(now) ? 'light' : 'dark';
  if (mode === 'system') {
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return mode;
}

export function loadTheme(): Theme {
  return resolveTheme(loadThemeMode());
}

/** Zet het thema op <html>. Eén functie voor zowel het attribuut als de
 *  adresbalkkleur, anders lopen die twee onvermijdelijk uit elkaar. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'light') root.setAttribute('data-theme', 'light');
  else root.removeAttribute('data-theme');

  // Het bootstrap-script in index.html zet deze twee INLINE op <html>, zodat de
  // eerste verf al de goede kleur heeft voordat de CSS-bundel binnen is. Inline
  // stijl wint van elke stylesheetregel, dus ze moeten hier meebewegen — anders
  // blijft de grond in het oude thema staan en valt tekst weg tegen de
  // achtergrond (contrast 1:1). Eén functie zet alles, anders lopen ze uiteen.
  const color = THEME_COLOR[root.getAttribute('data-look') === 'zenit' ? 'zenit' : 'cockpit'][theme];
  root.style.colorScheme = theme;
  root.style.background = color;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', color);
}

// ── Eén gedeelde stand voor de hele app ────────────────────────────────────
// Het accountmenu zet hem, en alles wat het opgeloste thema nodig heeft leest
// mee. Bij 'sun' wisselt het thema vanzelf bij zon op en zon onder, bij
// 'system' als het apparaat wisselt.

let mode: ThemeMode = typeof window === 'undefined' ? 'dark' : loadThemeMode();
let resolved: Theme = typeof window === 'undefined' ? 'dark' : resolveTheme(mode);
const listeners = new Set<() => void>();
let sunTimer: number | undefined;

function emit() { listeners.forEach(listener => listener()); }

/** Rekent de stand opnieuw om, zet het thema als het veranderde en plant bij
 *  'sun' de volgende wissel. Veilig om vaak aan te roepen. */
function sync(): void {
  const next = resolveTheme(mode);
  const attr: Theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  if (next !== resolved || next !== attr) {
    resolved = next;
    applyTheme(next);
    emit();
  }
  window.clearTimeout(sunTimer);
  sunTimer = undefined;
  if (mode === 'sun' && listeners.size > 0) {
    const wait = nextSunChange(new Date()).getTime() - Date.now() + 1000;
    // Een laptop die slaapt, mist zijn timer; daarom ook opnieuw bij terugkomen.
    sunTimer = window.setTimeout(sync, Math.min(Math.max(wait, 1000), 6 * 3600e3));
  }
}

if (typeof window !== 'undefined') {
  // Alleen zolang de werkruimte meeluistert: een publieke pagina of het
  // klantportaal zet zijn eigen thema (de huisstijl van de leverancier) en daar
  // hoort deze module niet doorheen te praten.
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => { if (mode === 'system' && listeners.size > 0) sync(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && listeners.size > 0 && (mode === 'sun' || mode === 'system')) sync(); });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) sync();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) { window.clearTimeout(sunTimer); sunTimer = undefined; }
  };
}

export function setThemeMode(next: ThemeMode): void {
  mode = next;
  try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* privémodus: niet erg */ }
  sync();
  emit();
}

/** Na een wissel van look (Cockpit ↔ Zenit) hoort de grondkleur mee te gaan. */
export function reapplyTheme(): void {
  applyTheme(resolved);
}

/** De gekozen stand, een setter, en het thema dat er nu op het scherm staat. */
export function useThemeMode(): [ThemeMode, (next: ThemeMode) => void, Theme] {
  const snapshot = useSyncExternalStore(subscribe, () => `${mode}|${resolved}`, () => 'dark|dark');
  const [current, theme] = snapshot.split('|') as [ThemeMode, Theme];
  const set = useCallback((next: ThemeMode) => setThemeMode(next), []);
  return [current, set, theme];
}

/** Donker of licht, zoals het accountmenu van de huidige look het kent. Kiest
 *  iemand daar, dan is dat een vaste stand; stond hij op 'sun' of 'system', dan
 *  toont dit het thema dat er nu staat. */
export function useTheme(): [Theme, (next: Theme) => void] {
  const [, setMode, theme] = useThemeMode();
  return [theme, setMode];
}
