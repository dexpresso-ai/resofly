// De sleutel van het klantportaal op een eigen domein (migratie 20261109020000).
//
// Waarom geen inlog bij Supabase daar: die inlog geldt voor het hele account
// van de klant. Is hij ook teamlid bij een andere gebruiker van ResoFly, dan
// opent hij ook diens werkruimte. Wat op een eigen domein in de browser staat,
// kan de beheerder van dat domein uitlezen (hij beheert de DNS). Daarom krijgt
// de klant daar na de link of de code uit de mail een sleutel die alleen het
// portaal van deze gebruiker opent, alleen vanaf dit domein (portal_tokens).
// Die sleutel staat hier en gaat mee in de kop x-portal-token.
//
// Bewust los van het scherm: portalToken.test.ts loopt het na.

import { clientHostInfo } from './clientHost.ts';

/** Waar de sleutel staat (deze browser, dit adres). */
export const PORTAL_TOKEN_STORAGE_KEY = 'resofly.portal.token';

/** De kop waarin de sleutel meegaat (zoals in _shared/portalSession.ts). */
export const PORTAL_TOKEN_HEADER = 'x-portal-token';

/** Staat het portaal hier met een sleutel (een eigen domein)? De Worker zegt het in de meta. */
export function portalTokenMode(): boolean {
  return clientHostInfo()?.tokenLogin === true;
}

/** 32 willekeurige bytes als base64url, zoals de server ze maakt. Wat van schijf komt, keuren we opnieuw. */
export function isPortalTokenValue(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{30,100}$/.test(value);
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function storedPortalToken(): string | null {
  try {
    const value = storage()?.getItem(PORTAL_TOKEN_STORAGE_KEY) ?? null;
    return isPortalTokenValue(value) ? value : null;
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();

/** De sleutel bewaren (na het inloggen) of weggooien (uitloggen, of de server kent hem niet meer). */
export function storePortalToken(token: string | null): void {
  try {
    const store = storage();
    if (token && isPortalTokenValue(token)) store?.setItem(PORTAL_TOKEN_STORAGE_KEY, token);
    else store?.removeItem(PORTAL_TOKEN_STORAGE_KEY);
  } catch {
    // Privémodus of vol: dan geldt de sleutel alleen in dit tabblad niet; inloggen lukt dan niet blijvend.
  }
  for (const listener of [...listeners]) listener();
}

/** Bericht als de sleutel verandert, ook in een ander tabblad. Geeft een functie om te stoppen. */
export function onPortalTokenChange(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === PORTAL_TOKEN_STORAGE_KEY) listener();
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}
