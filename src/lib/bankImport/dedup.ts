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

/**
 * Een echte kalenderdatum als ISO, of null (31-2 bestaat niet). Alleen jaren
 * van 1900 tot en met 2100: een bankafschrift uit het jaar 103 is rommel.
 */
function isoDate(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || y < 1900 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Normaliseert een datum naar ISO (YYYY-MM-DD): JJJJ-MM-DD (ook met tijd),
 * JJJJ/MM/DD, JJJJMMDD, en Nederlands D-M-JJJJ of DD-MM-JJ.
 *
 * Een Nederlandse datum is altijd dag-maand-jaar, ook zonder voorloopnullen
 * (zo slaat Excel een Rabobank-CSV op). Eerder ging alles behalve DD-MM-JJJJ
 * naar `new Date()`, dat maand-dag leest, en daarna naar UTC: "5-1-2026" werd
 * 30 april (ander kwartaal), "13-1-2026" viel weg. Nu geen Date-gok en geen
 * UTC voor een datum zonder tijd.
 */
export function normalizeDate(raw: string): string | null {
  const s = (raw || '').trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/.exec(s);
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return isoDate(year, Number(m[2]), Number(m[1]));
  }
  // Een datum met een maandnaam, Nederlands of Engels: "5 mei 2026", "05-okt-2026".
  m = /^(\d{1,2})[\s.-]+([a-zé]+)\.?[\s.-]+(\d{4})$/i.exec(s);
  if (m) {
    const month = MONTHS[m[2].toLowerCase().slice(0, 3)];
    return month ? isoDate(Number(m[3]), month, Number(m[1])) : null;
  }
  // Verder alleen nog iets met een woord van minstens drie letters én een jaar
  // van vier cijfers ("Jan 5, 2026"): lokaal lezen, niet via UTC. Eerder ging
  // alles met een letter naar new Date(), en die maakte van rommel als "c)103("
  // het jaar 103.
  if (/[a-z]{3,}/i.test(s) && /(?:^|\D)(?:19|20)\d{2}(?:\D|$)/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return isoDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  return null;
}

/** Maandnamen (de eerste drie letters), Nederlands en Engels. */
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mrt: 3, maa: 3, mar: 3, apr: 4, mei: 5, may: 5, jun: 6, jul: 7, aug: 8,
  sep: 9, okt: 10, oct: 10, nov: 11, dec: 12,
};
