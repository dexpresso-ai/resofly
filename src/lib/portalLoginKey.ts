// De sleutel van het eigen inlogadres van het klantportaal: /portal/<sleutel>
// (migratie 20261105110000). De merknaam plus tien tekens uit het
// base32-alfabet, zoals studio-noord-ro2ystqucm.
//
// Eén regel voor de app: het portaal leest hem uit het adres, het opslaan en de
// instellingen keuren hem. Dezelfde vorm staat in de CHECK op
// portal_login_addresses.key en in supabase/functions/_shared/portalAddress.ts;
// portalLoginKey.test.ts legt de drie naast elkaar. /portal/voorbeeld (het
// voorbeeld bij Instellingen → Huisstijl) past er bewust nooit in.

export const PORTAL_LOGIN_KEY_SOURCE = '[a-z0-9]+(?:-[a-z0-9]+)*-[a-z2-7]{10}';

const KEY = new RegExp(`^${PORTAL_LOGIN_KEY_SOURCE}$`);
const PATH = new RegExp(`^/portal/(${PORTAL_LOGIN_KEY_SOURCE})/?$`);

export function isPortalLoginKey(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 48 && KEY.test(value);
}

/** De sleutel uit een pad als /portal/<sleutel>, of null. */
export function portalKeyFromPathname(pathname: string): string | null {
  const match = PATH.exec(pathname);
  return match && isPortalLoginKey(match[1]) ? match[1] : null;
}

/** Het pad van het inlogscherm: het eigen adres, of zonder sleutel het algemene. */
export function portalLoginPath(key: string | null | undefined): string {
  return isPortalLoginKey(key) ? `/portal/${key}` : '/portal';
}
