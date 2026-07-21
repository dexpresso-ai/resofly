/**
 * cyrb53 — een snelle, 53-bits niet-cryptografische hash. Wordt gebruikt voor de
 * bestands-hash (file_hash) waarmee de import hetzelfde afschrift herkent.
 *
 * NB: de dedup-sleutel per transactie wordt sinds migratie 20260721010000
 * uitsluitend server-side afgeleid (import_bank_transactions → bank_canonical_key).
 * Dat is bewust: de client-import en de PSD2-sync maakten elk hun eigen sleutel
 * (`tx:`/`h:` versus `eb:`), waardoor dezelfde transactie via beide wegen twee
 * rijen opleverde. Eén afleiding op één plek kan per definitie niet uiteenlopen.
 */
export function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const out = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return out.toString(16).padStart(14, '0');
}

/**
 * Parseert een bedragstekst naar hele centen. Ondersteunt NL ('1.234,56'),
 * EN ('1,234.56'), losse decimalen ('12,50' / '12.50') en hele bedragen met
 * duizendtalscheiding ('1.234' → € 1.234,00).
 *
 * De laatste separator is de decimaalscheiding — BEHALVE als er precies drie
 * cijfers achter staan en er geen andere separator is: dan is het een
 * duizendtalscheiding. Zonder die regel werd '1.234' als € 1,23 gelezen, wat
 * gebeurt bij elk uit Excel heropgeslagen bankbestand met hele euro's.
 */
export function amountToCents(raw: string): number {
  let s = (raw || '').trim().replace(/\s/g, '').replace(/[€$]/g, '');
  if (!s) return 0;
  const neg = /^-/.test(s) || /-$/.test(s) || /^\(.*\)$/.test(s);
  s = s.replace(/[()]/g, '').replace(/^-|-$/g, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // Beide aanwezig: de laatste is de decimaalscheiding, de andere duizendtal.
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma > -1 || lastDot > -1) {
    const sep = lastComma > -1 ? ',' : '.';
    const idx = lastComma > -1 ? lastComma : lastDot;
    const decimals = s.length - idx - 1;
    const onlyOne = s.indexOf(sep) === idx;
    if (decimals === 3 && onlyOne) {
      // '1.234' / '1,234' → duizendtalscheiding, geen decimalen.
      s = s.split(sep).join('');
    } else {
      s = s.replace(/[.,]/g, m => (m === sep ? '.' : ''));
    }
  }
  const value = Math.round(parseFloat(s) * 100);
  if (!Number.isFinite(value)) return 0;
  return neg ? -value : value;
}

/** Normaliseert een datum naar ISO (YYYY-MM-DD). Accepteert ook DD-MM-YYYY en YYYYMMDD. */
export function normalizeDate(raw: string): string | null {
  const s = (raw || '').trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{8})$/.exec(s);
  if (m) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  m = /^(\d{2})[-/.](\d{2})[-/.](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}
