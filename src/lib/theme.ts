import { useCallback, useEffect, useState } from 'react';

/** Donker of licht. Donker is de ResoFly-identiteit en blijft de standaard;
 *  licht is een bewuste keuze van de gebruiker. */
export type Theme = 'dark' | 'light';

/** Zelfde sleutel als het bootstrap-script in index.html — die twee MOETEN
 *  gelijk blijven, anders flitst de app bij elke pagelaad in het verkeerde
 *  thema voordat React draait. */
export const THEME_STORAGE_KEY = 'resofly.theme';

/** De grondkleur per thema, voor de adresbalk op mobiel (`meta[name=theme-color]`).
 *  Gelijk houden aan --bg in globals.css. */
const THEME_COLOR: Record<Theme, string> = { dark: '#12110E', light: '#F1EEE6' };

export function loadTheme(): Theme {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    // Privémodus of geblokkeerde opslag: dan gewoon donker.
    return 'dark';
  }
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
  root.style.colorScheme = theme;
  root.style.background = THEME_COLOR[theme];

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR[theme]);
}

export function useTheme(): [Theme, (next: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(loadTheme);

  // Het bootstrap-script heeft het attribuut al gezet vóór de eerste verf; dit
  // houdt het synchroon als de state later verandert.
  useEffect(() => { applyTheme(theme); }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    applyTheme(next);
    try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* privémodus: niet erg */ }
  }, []);

  return [theme, setTheme];
}
