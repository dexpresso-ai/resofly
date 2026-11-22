/**
 * 0% btw op een verkoopfactuur: staat erbij waaróm, en past die reden bij het
 * land van de klant?
 *
 * Waarom dit bestaat (controle van 22 november 2026, bevinding 11): een regel
 * met 0% zonder btw-code ging gewoon de deur uit. Op de factuur stond "Btw 0%"
 * zonder reden en zonder het btw-nummer van de afnemer, de omzet kwam in
 * rubriek 1e in plaats van 3b, en niet in de ICP-opgaaf. Hetzelfde met de code
 * NUL (het Nederlandse 0%-tarief) bij een klant in België. Met de code
 * ICP_DIENST weigerde versturen wél ("vul het btw-nummer in"): wie de code
 * wegliet, kwam er dus makkelijker vanaf.
 *
 * De regels, per regel met een bedrag (een tekstregel van € 0 telt niet):
 *  - 0% zonder (bekende) btw-code: geen reden, dus niet versturen. Met de KOR
 *    aan maakt de database van zo'n regel vanzelf KOR; dan niet. Kent de
 *    administratie helemaal geen btw-codes, dan valt er niets te kiezen en
 *    kijken we niet.
 *  - NUL (0%, rubriek 1e) aan een klant in een ander EU-land: dat is ICP
 *    (ondernemer) of Nederlandse btw (particulier), nooit het Nederlandse
 *    0%-tarief. Buiten de EU mag het wel: een dienst aan een ondernemer daar is
 *    "niet bij u belast" en hoort in 1e.
 *  - Export (0%, rubriek 3a) aan een klant in Nederland of de EU.
 *  - ICP aan een klant in Nederland of buiten de EU.
 * Weten we het land niet (leeg en geen btw-nummer, of een naam die we niet
 * kennen), dan kijken we niet naar het land: liever niets zeggen dan iets
 * fouts weigeren.
 *
 * Puur: geen database, geen Deno. src/lib/invoiceZeroVat.ts is een kopie voor
 * de waarschuwing in het factuurformulier; src/lib/invoiceZeroVat.test.ts
 * houdt de twee gelijk.
 */

export interface ZeroVatCodeInfo {
  kind: string;
  salesBox?: string | null;
}

export interface ZeroVatLine {
  description?: string | null;
  quantity?: unknown;
  unit_price?: unknown;
  vat?: unknown;
  vat_code?: string | null;
}

export interface ZeroVatClient {
  name?: string | null;
  country?: string | null;
  vat_number?: string | null;
}

export type ZeroVatProblem = 'zonder_reden' | 'nul_in_eu' | 'export_niet_buiten_eu' | 'icp_in_nederland' | 'icp_buiten_eu';

export interface ZeroVatIssue {
  /** Volgnummer van de regel (vanaf 1), zoals in het formulier. */
  line: number;
  problem: ZeroVatProblem;
  message: string;
}

/** Soorten btw-code die zeggen waarom er 0% op een verkoopregel staat. */
const ZERO_REASON_KINDS = new Set(['zero', 'exempt', 'kor', 'reverse_charge_sales', 'icp_goods', 'icp_services']);

const EU = new Set(['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK']);

/** Landnamen zoals ze in het vrije veld "Land" staan. Onbekend: null, nooit een gok. */
const COUNTRY_NAMES: Record<string, string> = {
  nederland: 'NL', netherlands: 'NL', 'the netherlands': 'NL', holland: 'NL',
  belgie: 'BE', 'belgië': 'BE', belgium: 'BE', belgique: 'BE',
  duitsland: 'DE', germany: 'DE', deutschland: 'DE',
  frankrijk: 'FR', france: 'FR',
  luxemburg: 'LU', luxembourg: 'LU',
  spanje: 'ES', spain: 'ES', 'españa': 'ES', espana: 'ES',
  italie: 'IT', 'italië': 'IT', italy: 'IT', italia: 'IT',
  oostenrijk: 'AT', austria: 'AT', 'österreich': 'AT', osterreich: 'AT',
  ierland: 'IE', ireland: 'IE',
  denemarken: 'DK', denmark: 'DK',
  zweden: 'SE', sweden: 'SE',
  finland: 'FI',
  polen: 'PL', poland: 'PL',
  portugal: 'PT',
  griekenland: 'GR', greece: 'GR',
  tsjechie: 'CZ', 'tsjechië': 'CZ', czechia: 'CZ', 'czech republic': 'CZ',
  slowakije: 'SK', slovakia: 'SK',
  hongarije: 'HU', hungary: 'HU',
  roemenie: 'RO', 'roemenië': 'RO', romania: 'RO',
  bulgarije: 'BG', bulgaria: 'BG',
  kroatie: 'HR', 'kroatië': 'HR', croatia: 'HR',
  slovenie: 'SI', 'slovenië': 'SI', slovenia: 'SI',
  estland: 'EE', estonia: 'EE',
  letland: 'LV', latvia: 'LV',
  litouwen: 'LT', lithuania: 'LT',
  malta: 'MT',
  cyprus: 'CY',
  'verenigd koninkrijk': 'GB', 'united kingdom': 'GB', engeland: 'GB', uk: 'GB', 'groot-brittannie': 'GB', 'groot-brittannië': 'GB',
  zwitserland: 'CH', switzerland: 'CH', schweiz: 'CH',
  noorwegen: 'NO', norway: 'NO',
  ijsland: 'IS', iceland: 'IS',
  'verenigde staten': 'US', 'united states': 'US', usa: 'US', amerika: 'US',
  canada: 'CA',
  australie: 'AU', 'australië': 'AU', australia: 'AU',
  turkije: 'TR', turkey: 'TR',
};

function isoCode(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^[A-Za-z]{2}$/.test(value)) {
    const code = value.toUpperCase();
    // Het btw-nummer van Griekenland begint met EL; de landcode is GR.
    return code === 'EL' ? 'GR' : code === 'UK' ? 'GB' : code;
  }
  return COUNTRY_NAMES[value.toLowerCase()] ?? null;
}

/**
 * Het land van de klant: uit het veld Land, anders uit het begin van zijn
 * btw-nummer. Null als we het niet weten.
 */
export function clientCountryCode(client: ZeroVatClient | null | undefined): string | null {
  const fromCountry = isoCode(String(client?.country ?? ''));
  if (fromCountry) return fromCountry;
  const vat = String(client?.vat_number ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const prefix = /^([A-Z]{2})[0-9A-Z]/.exec(vat)?.[1] ?? null;
  // XI (Noord-Ierland) en onbekende voorvoegsels: geen land.
  if (!prefix || prefix === 'XI') return null;
  const code = isoCode(prefix);
  return code && (EU.has(code) || ['GB', 'CH', 'NO'].includes(code)) ? code : null;
}

function amount(line: ZeroVatLine): number {
  const value = (Number(line.quantity) || 0) * (Number(line.unit_price) || 0);
  return Number.isFinite(value) ? value : 0;
}

function lineName(line: ZeroVatLine, index: number): string {
  const text = String(line.description ?? '').trim();
  return text ? `"${text.length > 60 ? `${text.slice(0, 57)}…` : text}"` : `${index + 1}`;
}

export function zeroVatIssues(
  lines: ZeroVatLine[] | null | undefined,
  codes: Record<string, ZeroVatCodeInfo>,
  client: ZeroVatClient | null | undefined,
  options: { korEnabled?: boolean } = {},
): ZeroVatIssue[] {
  const issues: ZeroVatIssue[] = [];
  // Zonder één code die 0% uitlegt valt er niets te kiezen (het formulier
  // toont dan een kaal percentageveld); dan niet weigeren.
  const hasCodes = Object.values(codes ?? {}).some((info) => ZERO_REASON_KINDS.has(info.kind));
  const country = clientCountryCode(client);
  const who = String(client?.name ?? '').trim() || 'de klant';
  const where = String(client?.country ?? '').trim() || country || '';
  (lines ?? []).forEach((line, index) => {
    if (!line || Math.abs(amount(line)) < 0.005) return;
    const name = lineName(line, index);
    const code = String(line.vat_code ?? '').trim();
    const info = code ? codes?.[code] : undefined;
    const rate = Number(line.vat) || 0;
    if (!info) {
      if (rate !== 0 || !hasCodes || options.korEnabled) return;
      issues.push({
        line: index + 1,
        problem: 'zonder_reden',
        message: `Regel ${name} heeft 0% btw, maar niet waarom${code ? ` (de btw-code "${code}" bestaat niet in je administratie)` : ''}. Kies bij die regel de reden: bijvoorbeeld "ICP diensten" voor een ondernemer in een ander EU-land, "Export buiten EU", "BTW verlegd" of "Vrijgesteld". Alleen als het Nederlandse 0%-tarief echt geldt, kies je "BTW 0%".`,
      });
      return;
    }
    if (!country) return;
    const inEu = EU.has(country);
    if (info.kind === 'zero' && info.salesBox === '3a') {
      if (country === 'NL') {
        issues.push({ line: index + 1, problem: 'export_niet_buiten_eu', message: `Regel ${name} staat op export buiten de EU, maar ${who} zit in Nederland. Kies het btw-tarief dat in Nederland geldt.` });
      } else if (inEu) {
        issues.push({ line: index + 1, problem: 'export_niet_buiten_eu', message: `Regel ${name} staat op export buiten de EU, maar ${who} zit in ${where}, binnen de EU. Kies "ICP goederen" of "ICP diensten" (met het btw-nummer van je klant).` });
      }
      return;
    }
    if (info.kind === 'zero') {
      if (country !== 'NL' && inEu) {
        issues.push({ line: index + 1, problem: 'nul_in_eu', message: `Regel ${name} heeft het Nederlandse 0%-tarief, maar ${who} zit in ${where}. Is je klant daar ondernemer, kies dan "ICP diensten" of "ICP goederen" en vul zijn btw-nummer in. Is het een particulier, dan reken je meestal gewoon Nederlandse btw.` });
      }
      return;
    }
    if (info.kind === 'icp_goods' || info.kind === 'icp_services') {
      if (country === 'NL') {
        issues.push({ line: index + 1, problem: 'icp_in_nederland', message: `Regel ${name} staat op ICP (een ondernemer in een ander EU-land), maar ${who} zit in Nederland. Kies het gewone btw-tarief, of "BTW verlegd" als de verleggingsregeling geldt.` });
      } else if (!inEu) {
        issues.push({ line: index + 1, problem: 'icp_buiten_eu', message: `Regel ${name} staat op ICP (een ondernemer in een ander EU-land), maar ${who} zit in ${where}, buiten de EU. Kies "Export buiten EU" voor goederen; een dienst aan een ondernemer buiten de EU is niet in Nederland belast ("BTW 0%").` });
      }
    }
  });
  return issues;
}

/** Eén zin voor een weigering, of null als er niets is. */
export function zeroVatRefusal(issues: ZeroVatIssue[]): string | null {
  if (issues.length === 0) return null;
  const head = issues.length === 1 ? 'Deze factuur kan zo niet de deur uit.' : `Deze factuur kan zo niet de deur uit (${issues.length} regels).`;
  return `${head} ${issues.map((issue) => issue.message).join(' ')}`;
}
