/**
 * De inrichtingsstappen van een nieuwe organisatie (src/features/OrganizationSetup.tsx):
 * welke stappen er zijn, wat een rechtsvorm in ResoFly betekent, en de
 * controles op de bedrijfsgegevens. Los van het scherm, zodat npm test ze
 * zonder browser naloopt.
 *
 * Wat hier niet staat, bewaakt de database: wie mag afronden
 * (complete_organization_onboarding), wie de bedrijfsgegevens mag schrijven
 * (de policies op company_settings) en dat een BV, NV of coöperatie de
 * zakelijke module nodig heeft (enforce_company_legal_form). Deze controles
 * zijn er voor de gebruiker: een fout zien vóór hij op een factuur staat.
 */
import { BUSINESS_LEGAL_FORMS, LEGAL_FORM_LABELS } from '../types.ts';
import type { InvoiceSendMethod, LegalForm, VatReturnPeriodType } from '../types';
import { isDutchVatIdFormat, looksLikeTaxNumberWithoutCountry, normalizeVatId } from './vatId.ts';

// ── De stappen ───────────────────────────────────────────────────────────────

export type OnboardingStepKey =
  | 'welkom' | 'rechtsvorm' | 'abonnement' | 'bedrijf' | 'webadres' | 'btw'
  | 'huisstijl' | 'facturen' | 'mollie' | 'klaar';

export interface OnboardingStep {
  key: OnboardingStepKey;
  /** In de stappenlijst. */
  title: string;
  /** De regel eronder. */
  hint: string;
  /** Mag je overslaan; de stap staat dan als "later" in het overzicht. */
  optional?: boolean;
}

/**
 * De volgorde is bewust. Het abonnement staat direct na de rechtsvorm: een BV
 * heeft de zakelijke module nodig, en die hoort bij een lopend abonnement. Zo
 * ligt de rechtsvorm vast voordat de bedrijfsgegevens en de btw-instellingen
 * erop voortbouwen. Het webadres (jansen.resofly.com, migratie
 * 20261108230000) komt direct na de bedrijfsgegevens: dan staat de naam er
 * al om een voorstel uit te maken, en elke mail aan een klant linkt ernaar.
 */
export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  { key: 'welkom', title: 'Welkom', hint: 'Wat we samen inrichten' },
  { key: 'rechtsvorm', title: 'Rechtsvorm', hint: 'Eenmanszaak, vof, bv …' },
  { key: 'abonnement', title: 'Abonnement', hint: 'Pakket en modules', optional: true },
  { key: 'bedrijf', title: 'Bedrijfsgegevens', hint: 'Naam, adres, KvK, btw, IBAN' },
  { key: 'webadres', title: 'Je webadres', hint: 'Het adres voor je klanten' },
  { key: 'btw', title: 'Btw en boekhouding', hint: 'KOR, aangifte, boekjaar' },
  { key: 'huisstijl', title: 'Huisstijl', hint: 'Logo en merkkleur', optional: true },
  { key: 'facturen', title: 'Facturen versturen', hint: 'Per e-mail of via Mollie' },
  { key: 'mollie', title: 'Mollie koppelen', hint: 'Online laten betalen', optional: true },
  { key: 'klaar', title: 'Klaar', hint: 'Controleren en starten' },
];

/**
 * Welke stappen deze organisatie krijgt. Een administratie onder een holding
 * (isChild) heeft geen eigen abonnement: dat hoort bij de moeder.
 */
export function onboardingSteps(options: { isChild: boolean }): OnboardingStep[] {
  return ONBOARDING_STEPS.filter(step => !(options.isChild && step.key === 'abonnement'));
}

export function isOnboardingStepKey(value: unknown): value is OnboardingStepKey {
  return typeof value === 'string' && ONBOARDING_STEPS.some(step => step.key === value);
}

/**
 * Tot waar je in de stappenlijst mag springen: elke stap die je al afrondde,
 * en de eerste die nog open staat. Verder vooruit niet, want een latere stap
 * bouwt op wat je eerder koos (de rechtsvorm, de verzendwijze).
 */
export function reachableSteps(steps: readonly OnboardingStep[], completed: ReadonlySet<OnboardingStepKey>): Set<OnboardingStepKey> {
  const reachable = new Set<OnboardingStepKey>();
  for (const step of steps) {
    reachable.add(step.key);
    if (!completed.has(step.key)) break;
  }
  for (const key of completed) reachable.add(key);
  return reachable;
}

/**
 * Bij welke stap je verdergaat. De opgeslagen stap als die nog bereikbaar is;
 * anders de eerste stap die nog open staat. Zo staat een nieuwe stap vanzelf
 * voor wie al verder was: na de stap Webadres (november 2026) viel iemand die
 * bij Mollie zat anders terug naar Welkom, en moest hij alles opnieuw langs.
 */
export function resumeStep(steps: readonly OnboardingStep[], completed: ReadonlySet<OnboardingStepKey>, saved: OnboardingStepKey | null): OnboardingStepKey {
  if (saved && steps.some(step => step.key === saved) && reachableSteps(steps, completed).has(saved)) return saved;
  return steps.find(step => !completed.has(step.key))?.key ?? steps[steps.length - 1]?.key ?? 'welkom';
}

// ── Waar je bent: per organisatie, in deze browser ──────────────────────────

/** Voortgang van de stappen. Alleen keuzes, nooit gegevens of sleutels. */
export interface OnboardingProgress {
  step: OnboardingStepKey;
  completed: OnboardingStepKey[];
  /**
   * Een gekozen BV, NV of coöperatie die nog niet kon worden vastgelegd: de
   * zakelijke module staat nog niet aan. De stap Abonnement legt hem vast
   * zodra dat wel zo is.
   */
  pendingLegalForm: LegalForm | null;
}

/** Valt onder het voorvoegsel dat signOutOnThisDevice opruimt. */
export const ONBOARDING_PROGRESS_PREFIX = 'resofly.onboarding.';

export function onboardingProgressKey(organizationId: string): string {
  return `${ONBOARDING_PROGRESS_PREFIX}${organizationId}`;
}

export function isLegalForm(value: unknown): value is LegalForm {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LEGAL_FORM_LABELS, value);
}

/**
 * Leest de opgeslagen voortgang terug. Wat er niet uitziet als voortgang
 * (oude vorm, met de hand aangepast, een andere app op hetzelfde domein),
 * wordt genegeerd: dan begin je gewoon bij Welkom.
 */
export function parseOnboardingProgress(raw: string | null | undefined): OnboardingProgress | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (!isOnboardingStepKey(record.step)) return null;
  const completed = Array.isArray(record.completed)
    ? [...new Set(record.completed.filter(isOnboardingStepKey))]
    : [];
  const pending = isLegalForm(record.pendingLegalForm) ? record.pendingLegalForm : null;
  return { step: record.step, completed, pendingLegalForm: pending };
}

export function serializeOnboardingProgress(progress: OnboardingProgress): string {
  return JSON.stringify({
    step: progress.step,
    completed: [...new Set(progress.completed)],
    pendingLegalForm: progress.pendingLegalForm,
  });
}

// ── Rechtsvormen ────────────────────────────────────────────────────────────

export type LegalFormGroup = 'ib' | 'rechtspersoon';

export interface LegalFormInfo {
  form: LegalForm;
  label: string;
  group: LegalFormGroup;
  /** Eén regel op de kaart. */
  tagline: string;
  /** Welke belasting over de winst. */
  tax: string;
  /** Hoort bij de zakelijke module (de database weigert hem anders). */
  needsBusinessModule: boolean;
  /** Wat de keuze in ResoFly verandert. */
  inResoFly: string[];
  /** Voorbeeld voor de bedrijfsnaam. */
  nameExample: string;
}

const IB_FORMS: readonly LegalForm[] = ['eenmanszaak', 'vof', 'maatschap', 'cv'];

/** Rechtsvormen waarvan de winst in de inkomstenbelasting valt. */
export function isIncomeTaxForm(form: LegalForm): boolean {
  return IB_FORMS.includes(form);
}

/** Een BV, NV of coöperatie: alleen met de zakelijke module. */
export function needsBusinessModule(form: LegalForm): boolean {
  return BUSINESS_LEGAL_FORMS.includes(form);
}

export const LEGAL_FORM_INFO: Record<LegalForm, LegalFormInfo> = {
  eenmanszaak: {
    form: 'eenmanszaak', label: LEGAL_FORM_LABELS.eenmanszaak, group: 'ib',
    tagline: 'Je onderneemt alleen, op eigen naam.',
    tax: 'Inkomstenbelasting',
    needsBusinessModule: false,
    inResoFly: [
      'De winst is van jou: privé opnemen en storten boek je op je eigen vermogen.',
      'Je boekjaar is het kalenderjaar.',
      'Bij Uren houd je het urencriterium bij, voor de zelfstandigenaftrek.',
    ],
    nameExample: 'Studio Jansen',
  },
  vof: {
    form: 'vof', label: LEGAL_FORM_LABELS.vof, group: 'ib',
    tagline: 'Je onderneemt samen met een of meer vennoten.',
    tax: 'Inkomstenbelasting, per vennoot',
    needsBusinessModule: false,
    inResoFly: [
      'Je legt de vennoten en hun winstaandeel vast bij Financiën → Vennoten.',
      'Bij de jaarafsluiting gaat de winst naar de kapitaalrekening van elke vennoot.',
      'Je boekjaar is het kalenderjaar.',
    ],
    nameExample: 'Jansen & De Vries V.O.F.',
  },
  maatschap: {
    form: 'maatschap', label: LEGAL_FORM_LABELS.maatschap, group: 'ib',
    tagline: 'Samenwerking van vrije beroepen, zoals artsen of advocaten.',
    tax: 'Inkomstenbelasting, per maat',
    needsBusinessModule: false,
    inResoFly: [
      'De maten en hun winstaandeel leg je vast bij Financiën → Vennoten.',
      'Bij de jaarafsluiting gaat de winst naar de kapitaalrekening van elke maat.',
      'Je boekjaar is het kalenderjaar.',
    ],
    nameExample: 'Maatschap Jansen en De Vries',
  },
  cv: {
    form: 'cv', label: LEGAL_FORM_LABELS.cv, group: 'ib',
    tagline: 'Een vof met stille vennoten die alleen geld inbrengen.',
    tax: 'Inkomstenbelasting, per vennoot',
    needsBusinessModule: false,
    inResoFly: [
      'Beherende en stille (commanditaire) vennoten leg je vast bij Financiën → Vennoten.',
      'Bij de jaarafsluiting gaat de winst naar hun kapitaalrekeningen.',
      'Je boekjaar is het kalenderjaar.',
    ],
    nameExample: 'Jansen C.V.',
  },
  bv: {
    form: 'bv', label: LEGAL_FORM_LABELS.bv, group: 'rechtspersoon',
    tagline: 'Een rechtspersoon met aandelen; vaak ben je zelf directeur-grootaandeelhouder.',
    tax: 'Vennootschapsbelasting',
    needsBusinessModule: true,
    inResoFly: [
      'Een rekeningschema met aandelenkapitaal en reserves.',
      'Vennootschapsbelasting, de dga-regels en het aandeelhoudersregister.',
      'De jaarrekening en de stukken voor de KvK.',
      'Een holding met een werk-bv: meerdere administraties naast elkaar.',
    ],
    nameExample: 'Studio Jansen B.V.',
  },
  nv: {
    form: 'nv', label: LEGAL_FORM_LABELS.nv, group: 'rechtspersoon',
    tagline: 'Een rechtspersoon met aandelen, meestal een groter bedrijf.',
    tax: 'Vennootschapsbelasting',
    needsBusinessModule: true,
    inResoFly: [
      'Een rekeningschema met aandelenkapitaal en reserves.',
      'Vennootschapsbelasting, de dga-regels en het aandeelhoudersregister.',
      'De jaarrekening en de stukken voor de KvK.',
    ],
    nameExample: 'Jansen Holding N.V.',
  },
  cooperatie: {
    form: 'cooperatie', label: LEGAL_FORM_LABELS.cooperatie, group: 'rechtspersoon',
    tagline: 'Een vereniging van leden die samen ondernemen.',
    tax: 'Vennootschapsbelasting',
    needsBusinessModule: true,
    inResoFly: [
      'Vennootschapsbelasting en de jaarrekening.',
      'Het resultaat blijft in de coöperatie tot de leden over de bestemming besluiten.',
    ],
    nameExample: 'Coöperatie De Werkplaats U.A.',
  },
  stichting: {
    form: 'stichting', label: LEGAL_FORM_LABELS.stichting, group: 'rechtspersoon',
    tagline: 'Een rechtspersoon met een doel, zonder leden of aandeelhouders.',
    tax: 'Meestal geen winstbelasting',
    needsBusinessModule: false,
    inResoFly: [
      'Het resultaat blijft in de stichting, in het eigen vermogen.',
      'Geen vennoten, aandeelhouders of dga.',
    ],
    nameExample: 'Stichting De Werkplaats',
  },
  vereniging: {
    form: 'vereniging', label: LEGAL_FORM_LABELS.vereniging, group: 'rechtspersoon',
    tagline: 'Een rechtspersoon met leden, zoals een club of brancheclub.',
    tax: 'Meestal geen winstbelasting',
    needsBusinessModule: false,
    inResoFly: [
      'Het resultaat blijft in de vereniging, in het eigen vermogen.',
      'Geen vennoten, aandeelhouders of dga.',
    ],
    nameExample: 'Vereniging De Werkplaats',
  },
};

export const LEGAL_FORM_GROUPS: ReadonlyArray<{ group: LegalFormGroup; title: string; text: string; forms: LegalForm[] }> = [
  {
    group: 'ib',
    title: 'Zonder rechtspersoon',
    text: 'Je bent zelf aansprakelijk, en de winst valt in je inkomstenbelasting.',
    forms: ['eenmanszaak', 'vof', 'maatschap', 'cv'],
  },
  {
    group: 'rechtspersoon',
    title: 'Met rechtspersoon',
    text: 'Het bedrijf staat op zichzelf en heeft een notariële akte.',
    forms: ['bv', 'nv', 'cooperatie', 'stichting', 'vereniging'],
  },
];

/**
 * Waar het jaarresultaat heen gaat bij de jaarafsluiting (Instellingen →
 * Boekhouding legt dezelfde keuze uit). Bij een eenmanszaak is de winst van
 * de eigenaar: 0500 Eigen vermogen. Bij een BV, NV of coöperatie blijft hij op
 * 0510 tot er over de bestemming is besloten; een vof, maatschap of cv met
 * vennoten boekt hem toch naar de kapitaalrekeningen.
 */
export function defaultYearResultAccount(form: LegalForm): '0500' | '0510' {
  return form === 'eenmanszaak' ? '0500' : '0510';
}

/**
 * Voor de inkomstenbelasting is het boekjaar het kalenderjaar. Alleen een
 * rechtspersoon kan een gebroken boekjaar hebben.
 */
export function fiscalYearMustBeCalendarYear(form: LegalForm): boolean {
  return isIncomeTaxForm(form);
}

// ── Bedrijfsgegevens ────────────────────────────────────────────────────────

/** Is dit land Nederland? De kolom is vrije tekst; de standaard is 'Nederland'. */
export function isDutchCountry(country: string | null | undefined): boolean {
  const value = String(country ?? '').trim().toLowerCase();
  return value === '' || ['nederland', 'nl', 'the netherlands', 'netherlands', 'holland'].includes(value);
}

/** Alleen de cijfers van een KvK-nummer. */
export function normalizeKvk(value: string): string {
  return value.replace(/\D/g, '');
}

/** Een KvK-nummer heeft 8 cijfers. */
export function isKvkNumber(value: string): boolean {
  const raw = value.trim();
  return /^[\d\s.]+$/.test(raw) && /^\d{8}$/.test(normalizeKvk(raw));
}

/** "1234ab" → "1234 AB". Laat andere invoer ongemoeid (behalve de spaties). */
export function normalizeDutchPostcode(value: string): string {
  const compact = value.replace(/\s+/g, '').toUpperCase();
  return /^[1-9]\d{3}[A-Z]{2}$/.test(compact) ? `${compact.slice(0, 4)} ${compact.slice(4)}` : value.trim();
}

/** Een Nederlandse postcode: 4 cijfers (niet met 0 beginnend) en 2 letters. */
export function isDutchPostcode(value: string): boolean {
  return /^[1-9]\d{3}\s?[A-Za-z]{2}$/.test(value.trim());
}

/** Bewust ruim: één @, iets ervoor, een domein met een punt erin. */
export function isEmailAddress(value: string): boolean {
  const v = value.trim();
  return v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

/**
 * Een website als https-adres: "studio.nl" → "https://studio.nl". Null als het
 * geen gewoon webadres is: alleen http(s), en een domein met een punt. Zo komt
 * er nooit een javascript:- of data:-adres op een factuur of in het portaal.
 */
export function normalizeWebsite(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  if (/\s/.test(raw)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(url.hostname)) return null;
  const path = url.pathname === '/' ? '' : url.pathname;
  return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}${path}${url.search}`;
}

/** Een telefoonnummer: cijfers met de gebruikelijke tekens, minstens 6 cijfers. */
export function isPhoneNumber(value: string): boolean {
  const v = value.trim();
  return /^[+()\d\s./-]{6,40}$/.test(v) && (v.match(/\d/g) ?? []).length >= 6;
}

/** De lengte van een IBAN per land (de SEPA-landen en een paar buren). */
const IBAN_LENGTHS: Record<string, number> = {
  AD: 24, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20,
  ES: 24, FI: 18, FR: 27, GB: 22, GI: 23, GR: 27, HR: 21, HU: 28, IE: 22, IS: 26,
  IT: 27, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MT: 31, NL: 18, NO: 15, PL: 28,
  PT: 25, RO: 24, SE: 24, SI: 19, SK: 24, SM: 27, VA: 22,
};

/** Hoofdletters, zonder spaties of streepjes. */
export function normalizeIban(value: string): string {
  return value.replace(/[\s-]/g, '').toUpperCase();
}

/** "NL91ABNA0417164300" → "NL91 ABNA 0417 1643 00", zoals op een factuur. */
export function formatIban(value: string): string {
  const compact = normalizeIban(value);
  return compact.replace(/(.{4})(?=.)/g, '$1 ');
}

/**
 * Klopt het IBAN? Landcode, lengte voor dat land, en het controlegetal
 * (modulus 97). Eén verkeerd getypt cijfer valt zo altijd op.
 */
export function isValidIban(value: string): boolean {
  const iban = normalizeIban(value);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const expected = IBAN_LENGTHS[iban.slice(0, 2)];
  if (expected !== undefined && iban.length !== expected) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const digits = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** Een btw-id van een ander EU-land: landcode en 2 tot 13 letters of cijfers. */
function isForeignVatIdShape(value: string): boolean {
  return /^(AT|BE|BG|CY|CZ|DE|DK|EE|EL|ES|FI|FR|HR|HU|IE|IT|LT|LU|LV|MT|PL|PT|RO|SE|SI|SK|XI)[A-Z0-9]{2,13}$/.test(value);
}

export interface CompanyDraft {
  company_name: string;
  trade_name: string;
  address_line1: string;
  address_line2: string;
  postal_code: string;
  city: string;
  country: string;
  email: string;
  phone: string;
  website: string;
  kvk_number: string;
  vat_number: string;
  iban: string;
}

export type CompanyField = keyof CompanyDraft;

export interface CompanyCheck {
  /** Per veld wat er niet klopt. Zolang er iets in staat, gaat de stap niet verder. */
  errors: Partial<Record<CompanyField, string>>;
  /** Wat goed is om te weten, maar je niet tegenhoudt. */
  notes: string[];
}

const MAX_LENGTH: Partial<Record<CompanyField, number>> = {
  company_name: 200, trade_name: 200, address_line1: 200, address_line2: 200,
  postal_code: 20, city: 100, country: 80, email: 254, phone: 40, website: 200,
  kvk_number: 40, vat_number: 40, iban: 42,
};

/**
 * Controleert de bedrijfsgegevens. Verplicht is wat op elke factuur moet
 * staan: naam en adres, en een e-mailadres om te mailen. KvK, btw-id en IBAN
 * kunnen nog ontbreken (wie net begint, heeft ze niet altijd), maar als ze er
 * staan, moeten ze kloppen.
 */
export function checkCompanyDraft(draft: CompanyDraft, legalForm: LegalForm, options: { korEnabled?: boolean } = {}): CompanyCheck {
  const errors: CompanyCheck['errors'] = {};
  const notes: string[] = [];
  const v = (field: CompanyField) => String(draft[field] ?? '').trim();
  const dutch = isDutchCountry(draft.country);

  for (const [field, max] of Object.entries(MAX_LENGTH) as Array<[CompanyField, number]>) {
    if (v(field).length > max) errors[field] = `Dit is te lang: hooguit ${max} tekens.`;
  }

  if (v('company_name').length < 2) errors.company_name = 'Vul de naam van je bedrijf in, zoals hij bij de KvK staat.';
  if (!v('address_line1')) errors.address_line1 = 'Vul je straat en huisnummer in. Dat adres hoort op elke factuur.';
  if (!v('postal_code')) errors.postal_code = 'Vul je postcode in.';
  else if (dutch && !isDutchPostcode(v('postal_code'))) errors.postal_code = 'Een postcode is 4 cijfers en 2 letters, bijvoorbeeld 3411 AB.';
  if (!v('city')) errors.city = 'Vul je plaats in.';
  if (!v('country')) errors.country = 'Vul het land in.';

  if (!v('email')) errors.email = 'Vul een e-mailadres in. Je klanten zien het op je facturen.';
  else if (!isEmailAddress(v('email'))) errors.email = 'Dit is geen geldig e-mailadres.';

  if (v('phone') && !isPhoneNumber(v('phone'))) errors.phone = 'Dit lijkt geen telefoonnummer.';
  if (v('website') && !normalizeWebsite(v('website'))) errors.website = 'Vul een gewoon webadres in, zoals studiojansen.nl.';

  const kvk = v('kvk_number');
  if (kvk) {
    if (dutch && !isKvkNumber(kvk)) errors.kvk_number = 'Een KvK-nummer heeft 8 cijfers.';
  } else {
    notes.push('Je KvK-nummer hoort op je facturen en offertes. Heb je het nog niet, vul het dan later in bij Instellingen → Facturatie.');
  }

  const vat = normalizeVatId(v('vat_number'));
  if (vat) {
    if (looksLikeTaxNumberWithoutCountry(vat)) {
      errors.vat_number = 'Zet NL voor je btw-id: NL, 9 cijfers, B en 2 cijfers, bijvoorbeeld NL123456789B01.';
    } else if (vat.startsWith('NL')) {
      if (!isDutchVatIdFormat(vat)) errors.vat_number = 'Een Nederlands btw-id is NL, 9 cijfers, B en 2 cijfers, bijvoorbeeld NL123456789B01.';
    } else if (!isForeignVatIdShape(vat)) {
      errors.vat_number = 'Dit lijkt geen btw-id. Het begint met de landcode, bijvoorbeeld NL123456789B01.';
    }
  } else if (!options.korEnabled) {
    notes.push('Zonder btw-id kun je geen factuur met btw versturen. Gebruik je de kleineondernemersregeling (KOR), dan is het niet nodig; die kies je in de volgende stap.');
  }
  if (legalForm === 'eenmanszaak') {
    notes.push('Gebruik als eenmanszaak je btw-identificatienummer, niet je omzetbelastingnummer. In dat laatste staat je BSN; dat hoort niet op een factuur.');
  }

  const iban = v('iban');
  if (iban) {
    if (!isValidIban(iban)) errors.iban = 'Dit IBAN klopt niet. Controleer de letters en cijfers, bijvoorbeeld NL91 ABNA 0417 1643 00.';
  } else {
    notes.push('Zonder IBAN weet je klant niet waar hij naartoe kan overmaken. Het staat op elke factuur.');
  }

  return { errors, notes };
}

/**
 * De gegevens zoals ze worden opgeslagen: netjes, en leeg als null. De
 * bedrijfsnaam is in de database nooit null (standaard ''), dus die blijft tekst.
 */
export function normalizeCompanyDraft(draft: CompanyDraft): Omit<Record<CompanyField, string | null>, 'company_name'> & { company_name: string } {
  const clean = (value: string) => {
    const v = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/ {2,}/g, ' ').trim();
    return v === '' ? null : v;
  };
  const dutch = isDutchCountry(draft.country);
  const vat = normalizeVatId(draft.vat_number);
  const kvk = draft.kvk_number.trim();
  return {
    company_name: clean(draft.company_name) ?? '',
    trade_name: clean(draft.trade_name),
    address_line1: clean(draft.address_line1),
    address_line2: clean(draft.address_line2),
    postal_code: clean(dutch ? normalizeDutchPostcode(draft.postal_code) : draft.postal_code),
    city: clean(draft.city),
    country: clean(draft.country) ?? 'Nederland',
    email: clean(draft.email.toLowerCase()),
    phone: clean(draft.phone),
    website: draft.website.trim() ? normalizeWebsite(draft.website) : null,
    kvk_number: kvk ? (dutch && isKvkNumber(kvk) ? normalizeKvk(kvk) : clean(kvk)) : null,
    vat_number: vat || null,
    iban: draft.iban.trim() ? formatIban(draft.iban) : null,
  };
}

// ── Btw en boekhouding ─────────────────────────────────────────────────────

export const MONTH_NAMES = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'] as const;

export const VAT_PERIOD_LABELS: Record<VatReturnPeriodType, string> = {
  quarterly: 'Per kwartaal',
  monthly: 'Per maand',
};

/** Een datum als JJJJ-MM-DD, zonder tijdzone-verschuiving. */
function isoDay(year: number, monthIndex: number, day: number): string {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Twee voor de hand liggende startdatums voor de boekhouding. */
export function bookkeepingStartSuggestions(today: Date): Array<{ label: string; value: string }> {
  const year = today.getFullYear();
  const quarterMonth = Math.floor(today.getMonth() / 3) * 3;
  const options = [
    { label: `1 januari ${year}`, value: isoDay(year, 0, 1) },
    { label: `Begin dit kwartaal (1 ${MONTH_NAMES[quarterMonth]})`, value: isoDay(year, quarterMonth, 1) },
  ];
  return options.filter((option, index) => options.findIndex(o => o.value === option.value) === index);
}

/** Een echte datum als JJJJ-MM-DD (geen 31 februari). */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d && y >= 1990 && y <= 2100;
}

/** Een uurtarief in euro's naar centen; null als leeg, undefined als het niet klopt. */
export function parseHourlyRateCents(value: string): number | null | undefined {
  const v = value.trim().replace(/\s/g, '').replace(/^€/, '').replace(',', '.');
  if (!v) return null;
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(v)) return undefined;
  const cents = Math.round(Number(v) * 100);
  return cents >= 0 && cents <= 10_000_00 ? cents : undefined;
}

// ── Facturen versturen ────────────────────────────────────────────────────────

export const PAYMENT_TERM_DAYS = [14, 30] as const;

/** De betaaltekst onder de totalen van een factuur. */
export function paymentTermsText(days: number, method: InvoiceSendMethod | null): string {
  return method === 'mollie'
    ? `Graag betalen binnen ${days} dagen na de factuurdatum, online via de betaallink of per overboeking onder vermelding van het factuurnummer.`
    : `Graag betalen binnen ${days} dagen na de factuurdatum, onder vermelding van het factuurnummer.`;
}

// ── Mollie ──────────────────────────────────────────────────────────────────

/**
 * Wat er niet klopt aan een geplakte Mollie-key, vóór hij naar de server gaat.
 * De server controleert hem daarna echt bij Mollie (saveInvoiceMollieKey); dit
 * vangt alleen de bekende vergissingen op, met een melding die zegt wat je
 * wel moet kopiëren.
 */
export function mollieKeyProblem(value: string): string | null {
  const key = value.trim();
  if (!key) return 'Plak je API-key van Mollie.';
  if (/\s/.test(key)) return 'Er staat een spatie of regeleinde in de key. Kopieer hem opnieuw, in zijn geheel.';
  if (/^access_/.test(key)) return 'Dit is een access token van Mollie, geen API-key. Kopieer de key bij Developers → API-keys; die begint met live_ of test_.';
  if (/^(pfl|org)_/.test(key)) return 'Dit is een profiel- of organisatie-id van Mollie, geen API-key. De API-key begint met live_ of test_.';
  if (!/^(live|test)_/.test(key)) return 'Een API-key van Mollie begint met live_ (echte betalingen) of test_ (proberen).';
  if (!/^(live|test)_[A-Za-z0-9]{16,128}$/.test(key)) return 'Na live_ of test_ volgen alleen letters en cijfers. Kopieer de key opnieuw uit je Mollie-dashboard.';
  return null;
}

export function mollieKeyMode(value: string): 'live' | 'test' | null {
  const key = value.trim();
  if (key.startsWith('live_')) return 'live';
  if (key.startsWith('test_')) return 'test';
  return null;
}

// ── Afronden ────────────────────────────────────────────────────────────────

/** De naam in ResoFly: de handelsnaam als die er is, anders de bedrijfsnaam. */
export function organizationDisplayName(companyName: string | null | undefined, tradeName: string | null | undefined): string {
  const pick = String(tradeName ?? '').trim() || String(companyName ?? '').trim();
  return pick.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 120);
}

export interface FinishCheck {
  /** Zonder deze zaken kan het niet: de knop Afronden blijft dicht. */
  blocking: Array<{ step: OnboardingStepKey; text: string }>;
}

/**
 * Wat er nog moet voordat je kunt afronden. De database controleert de
 * bedrijfsnaam zelf ook (complete_organization_onboarding).
 */
export function finishCheck(input: {
  companyName: string | null | undefined;
  addressLine1: string | null | undefined;
  savedLegalForm: LegalForm;
  pendingLegalForm: LegalForm | null;
  /** Het gekozen webadres (de naam), of null. Undefined = niet bekend, niet tegenhouden. */
  clientSubdomain?: string | null;
}): FinishCheck {
  const blocking: FinishCheck['blocking'] = [];
  if (input.pendingLegalForm && input.pendingLegalForm !== input.savedLegalForm) {
    blocking.push({
      step: 'rechtsvorm',
      text: `Je koos ${LEGAL_FORM_LABELS[input.pendingLegalForm]}, maar die staat nog niet vast: zet eerst de zakelijke module aan, of kies een andere rechtsvorm.`,
    });
  }
  if (!String(input.companyName ?? '').trim()) blocking.push({ step: 'bedrijf', text: 'De naam van je bedrijf ontbreekt nog.' });
  if (!String(input.addressLine1 ?? '').trim()) blocking.push({ step: 'bedrijf', text: 'Je adres ontbreekt nog; dat hoort op elke factuur.' });
  // De database eist het ook (complete_organization_onboarding).
  if (input.clientSubdomain === null) blocking.push({ step: 'webadres', text: 'Kies nog het webadres voor je klanten.' });
  return { blocking };
}
