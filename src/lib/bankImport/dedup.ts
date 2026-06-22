import type { ParsedBankTransaction } from '../../types';

/**
 * cyrb53 — een snelle, 53-bits niet-cryptografische hash. Gebruikt om een stabiele
 * dedup-sleutel te maken voor transacties die geen eigen bank-id hebben (veel
 * CSV-exports). Stabiel betekent: dezelfde regel levert altijd dezelfde sleutel,
 * zodat her-importeren niets dubbel toevoegt (unique(bank_account_id, dedup_key)).
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
 * Vult ontbrekende dedup-sleutels in. Voorkeur: het unieke bank-id (bank_tx_id).
 * Anders een hash van datum+bedrag+tegenrekening+omschrijving, met een volgnummer
 * dat oploopt bij identieke regels binnen hetzelfde bestand — zodat twee échte
 * dezelfde betalingen op dezelfde dag elk een eigen sleutel krijgen, maar een
 * her-import van hetzelfde afschrift exact dezelfde sleutels reproduceert.
 */
export function finalizeDedupKeys(txns: ParsedBankTransaction[]): ParsedBankTransaction[] {
  const seen = new Map<string, number>();
  return txns.map(t => {
    if (t.dedup_key && t.dedup_key.trim()) return t;
    if (t.bank_tx_id && t.bank_tx_id.trim()) return { ...t, dedup_key: `tx:${t.bank_tx_id.trim()}` };
    const canonical = [
      t.booking_date,
      t.amount_cents,
      (t.counterparty_iban || '').toUpperCase().replace(/\s+/g, ''),
      (t.description || '').toLowerCase().replace(/\s+/g, ' ').trim(),
    ].join('|');
    const n = (seen.get(canonical) ?? 0) + 1;
    seen.set(canonical, n);
    return { ...t, dedup_key: `h:${cyrb53(canonical)}:${n}` };
  });
}

/** Parseert een bedragstekst (NL '1.234,56' of EN '1234.56') naar hele centen. */
export function amountToCents(raw: string): number {
  let s = (raw || '').trim().replace(/\s/g, '').replace(/[€$]/g, '');
  if (!s) return 0;
  const neg = /^-/.test(s) || /-$/.test(s) || /^\(.*\)$/.test(s);
  s = s.replace(/[()]/g, '').replace(/^-|-$/g, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  // De laatste separator is de decimaalscheiding; de andere is duizendtal.
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma > -1) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    s = s.replace(/,/g, '');
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
