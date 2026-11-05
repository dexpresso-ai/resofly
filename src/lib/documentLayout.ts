// ============================================================
// Opmaak van offertes en facturen: welk gegeven waar op het papier staat.
//
// Waarom dit bestaat:
// - De PDF die de klant kreeg (invoice-workflow, quote-workflow) en het
//   voorbeeld in de app (src/lib/pdf.ts) waren twee losse tekenroutines. Het
//   voorbeeld beloofde "1:1 wat de klant ontvangt", maar alleen het voorbeeld
//   gebruikte het briefpapier en de lettergrootte, en geen van beide zette het
//   logo erop. Nu tekenen ze allebei met deze ene module, dus kunnen ze niet
//   meer uit elkaar lopen.
// - Een organisatie kan de velden zelf op de pagina slepen (Instellingen →
//   Documentopmaak). Wie dat niet wil, krijgt `builtInLayout()`: de
//   standaardopmaak, met logo en merkkleur.
//
// Een pagina heeft drie zones, van boven naar beneden:
//   kop    — vrij geplaatste blokken (logo, velden, tekst, lijnen, vlakken);
//            staan op pagina 1, en op elke pagina als `repeatHeader` aan staat.
//   inhoud — de regels, totalen, btw-vermeldingen, notities…, in een vaste
//            volgorde onder elkaar vanaf `bodyTop`; loopt door op een volgende
//            pagina.
//   voet   — vrij geplaatste blokken vanaf `footerTop`; op elke pagina.
// Een vrij blok in de inhoudszone zou onder doorlopende regels belanden; de
// editor laat ze daar daarom niet staan.
//
// SPIEGEL: supabase/functions/_shared/documentLayout.ts is een kopie van dit
// bestand voor de edge functions. src/lib/documentLayout.test.ts houdt de twee
// gelijk. Geen imports: dit draait ongewijzigd in de browser, in node (tests)
// en in Deno. pdf-lib komt als parameter binnen (`renderDocumentPdf`), omdat
// de app hem uit npm haalt en de edge functions van esm.sh.
// ============================================================

// ---- Vanaf hier is dit bestand gelijk aan zijn spiegel (zie de test). ----

export const DOCUMENT_LAYOUT_VERSION = 1;

/** A4 in punten (1/72 inch), de maat waarin pdf-lib tekent. */
export const PAGE_WIDTH = 595.28;
export const PAGE_HEIGHT = 841.89;

/** Grenzen van alles wat in een opmaak kan staan; ook de editor houdt zich hieraan. */
export const LAYOUT_LIMITS = {
  bodyTop: { min: 60, max: 520 },
  footerTop: { min: 640, max: 822 },
  continueTop: { min: 36, max: 300 },
  marginX: { min: 24, max: 96 },
  baseSize: { min: 8, max: 14 },
  size: { min: 6, max: 40 },
  weight: { min: 0.25, max: 6 },
  opacity: { min: 0.04, max: 1 },
  blocks: 60,
  text: 600,
  caption: 40,
} as const;

/**
 * Wat voor stuk het is. Een creditfactuur en een aanmaning hebben geen eigen
 * opmaak: ze gebruiken die van de factuur (kop, voet, logo, briefpapier,
 * stijl), zodat alles wat de klant van je krijgt er hetzelfde uitziet.
 */
export type DocumentKind = 'invoice' | 'quote' | 'credit_note' | 'dunning';
/** De twee opmaken die je kunt instellen. */
export type LayoutKind = 'invoice' | 'quote';
export type LayoutAlign = 'left' | 'center' | 'right';
export type LayoutTone = 'text' | 'muted' | 'accent';
export type LayoutLabel = 'none' | 'inline' | 'above';
export type LayoutBlockType = 'field' | 'text' | 'logo' | 'line' | 'box';
export type LayoutFlowKey = 'intro' | 'lines' | 'totals' | 'vat_notes' | 'payment' | 'notes' | 'online_link' | 'closing';
export type TableStyle = 'tinted' | 'lines' | 'plain';
export type TotalsStyle = 'line' | 'filled';

/** Welke opmaak een stuk gebruikt: de offerte de zijne, de rest die van de factuur. */
export function layoutKind(kind: DocumentKind): LayoutKind {
  return kind === 'quote' ? 'quote' : 'invoice';
}

// ── Lettertypen ─────────────────────────────────────────────────────────────
//
// Een PDF heeft zonder ingesloten bestanden alleen Helvetica, Times en
// Courier. De letters van de huisstijl sluiten we daarom in (ingekort tot de
// gebruikte tekens); de bestanden komen uit public/fonts/pdf (app) en
// supabase/functions/_shared/pdfFonts.ts (server), gemaakt door
// scripts/pdf-lettertypen.mjs. De sleutels zijn die van BRAND_FONTS in
// src/lib/branding.ts, zodat "Zoals je huisstijl" letterlijk je huisstijl is.

export type PdfFontKey =
  | 'system' | 'inter' | 'jost' | 'space-grotesk' | 'dm-sans' | 'playfair' | 'cormorant' | 'lora' | 'bebas'
  | 'helvetica' | 'times' | 'courier';
/** `auto` = de letter van je huisstijl (koppen of tekst). */
export type PdfFontChoice = 'auto' | PdfFontKey;

export interface PdfFontDefinition {
  key: PdfFontKey;
  label: string;
  hint: string;
  /** Zit in elke PDF-lezer; hoeft niet ingesloten te worden. */
  standard: boolean;
  /** Bestandsnaam zonder gewicht: `${file}-400.woff`. */
  file?: string;
  /** Heeft een vet gewicht (anders tekent vet in het gewone). */
  bold: boolean;
  serif: boolean;
  /** Alleen geschikt voor koppen (Bebas Neue: alleen hoofdletters). */
  headingOnly?: boolean;
  /** Voor de editor: hoe de browser dezelfde letter laat zien. */
  css: string;
}

export const PDF_FONTS: PdfFontDefinition[] = [
  { key: 'system', label: 'Poppins', hint: 'De huisstijl van ResoFly — vriendelijk en neutraal.', standard: false, file: 'poppins', bold: true, serif: false, css: "'Poppins', system-ui, sans-serif" },
  { key: 'inter', label: 'Inter', hint: 'Helder en zakelijk; leest rustig op elk formaat.', standard: false, file: 'inter', bold: true, serif: false, css: "'Inter', system-ui, sans-serif" },
  { key: 'jost', label: 'Jost', hint: 'Geometrisch en modern, met een Bauhaus-inslag.', standard: false, file: 'jost', bold: true, serif: false, css: "'Jost', system-ui, sans-serif" },
  { key: 'space-grotesk', label: 'Space Grotesk', hint: 'Eigenzinnig modern; valt op zonder te schreeuwen.', standard: false, file: 'space-grotesk', bold: true, serif: false, css: "'Space Grotesk', system-ui, sans-serif" },
  { key: 'dm-sans', label: 'DM Sans', hint: 'Zacht en open; prettig voor langere teksten.', standard: false, file: 'dm-sans', bold: true, serif: false, css: "'DM Sans', system-ui, sans-serif" },
  { key: 'playfair', label: 'Playfair Display', hint: 'Klassiek en elegant; sterke koppen met contrast.', standard: false, file: 'playfair-display', bold: true, serif: true, css: "'Playfair Display', Georgia, serif" },
  { key: 'cormorant', label: 'Cormorant Garamond', hint: 'Verfijnd en licht; heel geschikt voor bruiloften.', standard: false, file: 'cormorant-garamond', bold: true, serif: true, css: "'Cormorant Garamond', Georgia, serif" },
  { key: 'lora', label: 'Lora', hint: 'Warme serif die ook in lopende tekst goed leest.', standard: false, file: 'lora', bold: true, serif: true, css: "'Lora', Georgia, serif" },
  { key: 'bebas', label: 'Bebas Neue', hint: 'Uitgesproken, in kapitalen — alleen voor koppen.', standard: false, file: 'bebas-neue', bold: false, serif: false, headingOnly: true, css: "'Bebas Neue', Impact, sans-serif" },
  { key: 'helvetica', label: 'Helvetica', hint: 'Zit in elke PDF-lezer: de kleinste PDF.', standard: true, bold: true, serif: false, css: "Helvetica, Arial, 'Liberation Sans', sans-serif" },
  { key: 'times', label: 'Times', hint: 'Klassiek, met schreef; zit in elke PDF-lezer.', standard: true, bold: true, serif: true, css: "'Times New Roman', Times, 'Liberation Serif', serif" },
  { key: 'courier', label: 'Courier', hint: 'Als van een typemachine; zit in elke PDF-lezer.', standard: true, bold: true, serif: false, css: "'Courier New', Courier, 'Liberation Mono', monospace" },
];

const PDF_FONT_INDEX: Record<string, PdfFontDefinition> = Object.fromEntries(PDF_FONTS.map(font => [font.key, font]));

export function pdfFont(key: string | null | undefined): PdfFontDefinition {
  return PDF_FONT_INDEX[str(key)] ?? PDF_FONT_INDEX.system;
}

export const TABLE_STYLES: Array<{ value: TableStyle; label: string }> = [
  { value: 'tinted', label: 'Kop in je merkkleur' },
  { value: 'lines', label: 'Alleen lijnen' },
  { value: 'plain', label: 'Zonder kleur' },
];

export const TOTALS_STYLES: Array<{ value: TotalsStyle; label: string }> = [
  { value: 'line', label: 'Lijn boven het totaal' },
  { value: 'filled', label: 'Totaal in een vlak' },
];

export interface LayoutBlock {
  /** Vast kenmerk binnen de opmaak, voor de editor. */
  id: string;
  type: LayoutBlockType;
  /** Bij `field`: welk gegeven (een sleutel uit DOCUMENT_FIELDS). */
  field?: string;
  /** Bij `text`: de tekst zelf, eventueel met {{velden}}. */
  text?: string;
  /** Plaats en maat in punten, vanaf linksboven. Tekst mag langer worden dan `h`. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Lettergrootte in punten; leeg = de standaard van het veld bij de basisgrootte. */
  size?: number;
  bold?: boolean;
  align?: LayoutAlign;
  tone?: LayoutTone;
  label?: LayoutLabel;
  /** Eigen label in plaats van het standaardlabel ("Factuurnummer"). */
  caption?: string;
  /** Eerste regel vet, zoals de naam boven een adres. */
  firstBold?: boolean;
  /** Een lijst op één regel, met een punt ertussen. */
  inline?: boolean;
  /** Vlak: hoe vol de kleur is. */
  opacity?: number;
  /** Lijn: dikte in punten. */
  weight?: number;
}

export interface LayoutFlowItem {
  key: LayoutFlowKey;
  show: boolean;
  /** Bij `intro` en `closing`: de tekst, eventueel met {{velden}}. */
  text?: string;
}

export interface DocumentLayout {
  version: 1;
  /** Met welk standaardsjabloon deze opmaak begon; alleen voor de editor. */
  preset?: string;
  /** Waar de inhoud op pagina 1 begint (punten vanaf boven). */
  bodyTop: number;
  /** Waar de voet begint; alles eronder staat op elke pagina. */
  footerTop: number;
  /** Waar de inhoud op een vervolgpagina begint, als de kop niet herhaalt. */
  continueTop: number;
  /** Linker- en rechterkantlijn van de inhoud. */
  marginX: number;
  /** De kop op elke pagina herhalen (handig bij briefpapier met vaste kop). */
  repeatHeader: boolean;
  table: {
    quantity: boolean;
    unitPrice: boolean;
    vatRate: boolean;
    /** Het bedrag per regel inclusief of exclusief btw. */
    lineTotals: 'incl' | 'excl';
    style: TableStyle;
  };
  totalsStyle: TotalsStyle;
  flow: LayoutFlowItem[];
  blocks: LayoutBlock[];
}

/** Wat er in company_settings.document_layouts staat. `null` = de standaardopmaak. */
export interface DocumentLayouts {
  version: 1;
  /** Letter voor koppen (titel, naam); `auto` = die van je huisstijl. */
  headingFont: PdfFontChoice;
  /** Letter voor de rest; `auto` = die van je huisstijl. */
  bodyFont: PdfFontChoice;
  invoice: DocumentLayout | null;
  quote: DocumentLayout | null;
}

// ── De velden ───────────────────────────────────────────────────────────────

export type FieldShape = 'text' | 'lines' | 'rows';
export type FieldGroup = 'bedrijf' | 'klant' | 'document';

export interface DocumentFieldDefinition {
  key: string;
  group: FieldGroup;
  /** Naam in de lijst met velden. */
  name: string;
  /** Uitleg in de lijst met velden. */
  hint: string;
  shape: FieldShape;
  /** Label op het document: [factuur, offerte]. */
  caption: [string, string];
  /** Een ander label op een creditfactuur of aanmaning; anders dat van de factuur. */
  captionOther?: Partial<Record<'credit_note' | 'dunning', string>>;
  /** Alleen zinvol op dit soort document. */
  only?: DocumentKind;
  /** In het koplettertype (titel, naam). */
  heading?: boolean;
  /** Maat en stijl van een nieuw blok; `size` is ten opzichte van de basisgrootte. */
  defaults: {
    w: number;
    h: number;
    size: number;
    bold?: boolean;
    tone?: LayoutTone;
    align?: LayoutAlign;
    label?: LayoutLabel;
    firstBold?: boolean;
  };
}

export const FIELD_GROUPS: Array<{ key: FieldGroup; name: string }> = [
  { key: 'bedrijf', name: 'Jouw bedrijf' },
  { key: 'klant', name: 'Klant' },
  { key: 'document', name: 'Document' },
];

export const DOCUMENT_FIELDS: DocumentFieldDefinition[] = [
  { key: 'bedrijf.naam', group: 'bedrijf', name: 'Bedrijfsnaam', hint: 'Je merknaam, of anders je bedrijfsnaam.', shape: 'text', caption: ['Bedrijfsnaam', 'Bedrijfsnaam'], heading: true, defaults: { w: 240, h: 24, size: 4, bold: true } },
  { key: 'bedrijf.gegevens', group: 'bedrijf', name: 'Bedrijfsgegevens', hint: 'Adres, e-mail, telefoon en website onder elkaar.', shape: 'lines', caption: ['Van', 'Van'], defaults: { w: 220, h: 92, size: -1, tone: 'muted' } },
  { key: 'bedrijf.adres', group: 'bedrijf', name: 'Adres', hint: 'Straat, postcode, plaats en land.', shape: 'lines', caption: ['Adres', 'Adres'], defaults: { w: 200, h: 48, size: -1, tone: 'muted' } },
  { key: 'bedrijf.contact', group: 'bedrijf', name: 'Contact', hint: 'E-mail, telefoon en website.', shape: 'lines', caption: ['Contact', 'Contact'], defaults: { w: 200, h: 36, size: -1, tone: 'muted' } },
  { key: 'bedrijf.email', group: 'bedrijf', name: 'E-mailadres', hint: 'Je zakelijke e-mailadres.', shape: 'text', caption: ['E-mail', 'E-mail'], defaults: { w: 200, h: 14, size: -1, tone: 'muted' } },
  { key: 'bedrijf.telefoon', group: 'bedrijf', name: 'Telefoon', hint: 'Je telefoonnummer.', shape: 'text', caption: ['Telefoon', 'Telefoon'], defaults: { w: 160, h: 14, size: -1, tone: 'muted' } },
  { key: 'bedrijf.website', group: 'bedrijf', name: 'Website', hint: 'Je website.', shape: 'text', caption: ['Website', 'Website'], defaults: { w: 200, h: 14, size: -1, tone: 'muted' } },
  { key: 'bedrijf.kvk', group: 'bedrijf', name: 'KvK-nummer', hint: 'Hoort op elke factuur en offerte.', shape: 'text', caption: ['KvK', 'KvK'], defaults: { w: 160, h: 14, size: -1, tone: 'muted', label: 'inline' } },
  { key: 'bedrijf.btw', group: 'bedrijf', name: 'Btw-nummer', hint: 'Je btw-id; hoort op elke factuur (behalve met de KOR).', shape: 'text', caption: ['Btw-nummer', 'Btw-nummer'], defaults: { w: 200, h: 14, size: -1, tone: 'muted', label: 'inline' } },
  { key: 'bedrijf.iban', group: 'bedrijf', name: 'IBAN', hint: 'Waar je klant naar betaalt.', shape: 'text', caption: ['IBAN', 'IBAN'], defaults: { w: 200, h: 14, size: -1, tone: 'muted', label: 'inline' } },
  { key: 'bedrijf.registratie', group: 'bedrijf', name: 'KvK, btw en IBAN', hint: 'De drie nummers onder elkaar, of op één regel.', shape: 'rows', caption: ['Bedrijfsgegevens', 'Bedrijfsgegevens'], defaults: { w: 220, h: 44, size: -1, tone: 'muted' } },
  { key: 'klant.gegevens', group: 'klant', name: 'Klantgegevens', hint: 'Naam, t.a.v., adres en btw-nummer van je klant.', shape: 'lines', caption: ['Factuur aan', 'Offerte voor'], captionOther: { credit_note: 'Creditfactuur aan', dunning: 'Aan' }, defaults: { w: 260, h: 100, size: 0, label: 'above', firstBold: true } },
  { key: 'klant.naam', group: 'klant', name: 'Klantnaam', hint: 'De naam van je klant.', shape: 'text', caption: ['Klant', 'Klant'], defaults: { w: 240, h: 16, size: 0, bold: true } },
  { key: 'klant.contactpersoon', group: 'klant', name: 'Contactpersoon', hint: 'Ter attentie van.', shape: 'text', caption: ['T.a.v.', 'T.a.v.'], defaults: { w: 240, h: 14, size: 0, label: 'inline' } },
  { key: 'klant.adres', group: 'klant', name: 'Adres klant', hint: 'Straat, postcode, plaats en land van je klant.', shape: 'lines', caption: ['Adres', 'Adres'], defaults: { w: 240, h: 48, size: 0 } },
  { key: 'klant.btw', group: 'klant', name: 'Btw-nummer klant', hint: 'Verplicht bij btw verlegd en ICP.', shape: 'text', caption: ['Btw-nummer', 'Btw-nummer'], defaults: { w: 220, h: 14, size: -1, label: 'inline' } },
  { key: 'klant.kvk', group: 'klant', name: 'KvK-nummer klant', hint: 'Het KvK-nummer van je klant.', shape: 'text', caption: ['KvK', 'KvK'], defaults: { w: 180, h: 14, size: -1, label: 'inline' } },
  { key: 'klant.email', group: 'klant', name: 'E-mail klant', hint: 'Het e-mailadres van je klant.', shape: 'text', caption: ['E-mail', 'E-mail'], defaults: { w: 220, h: 14, size: -1 } },
  { key: 'klant.nummer', group: 'klant', name: 'Klantnummer', hint: 'Je eigen nummer voor deze klant.', shape: 'text', caption: ['Klantnummer', 'Klantnummer'], defaults: { w: 180, h: 14, size: -1, label: 'inline' } },
  { key: 'document.titel', group: 'document', name: 'Titel', hint: 'FACTUUR of OFFERTE, groot.', shape: 'text', caption: ['Titel', 'Titel'], heading: true, defaults: { w: 220, h: 30, size: 14, bold: true } },
  { key: 'document.nummer', group: 'document', name: 'Nummer', hint: 'Het factuur- of offertenummer.', shape: 'text', caption: ['Factuurnummer', 'Offertenummer'], captionOther: { credit_note: 'Creditfactuurnummer' }, defaults: { w: 200, h: 14, size: 0, bold: true, label: 'inline' } },
  { key: 'document.datum', group: 'document', name: 'Datum', hint: 'De factuur- of offertedatum.', shape: 'text', caption: ['Factuurdatum', 'Offertedatum'], captionOther: { credit_note: 'Datum', dunning: 'Datum' }, defaults: { w: 200, h: 14, size: -1, label: 'inline' } },
  { key: 'document.vervaldatum', group: 'document', name: 'Vervaldatum / geldig tot', hint: 'Bij een factuur de vervaldatum, bij een offerte tot wanneer hij geldt.', shape: 'text', caption: ['Vervaldatum', 'Geldig tot'], captionOther: { dunning: 'Uiterste betaaldatum' }, defaults: { w: 200, h: 14, size: -1, label: 'inline' } },
  { key: 'document.project', group: 'document', name: 'Project', hint: 'Het project waar het document bij hoort.', shape: 'text', caption: ['Project', 'Project'], defaults: { w: 220, h: 14, size: -1, label: 'inline' } },
  { key: 'document.offerte', group: 'document', name: 'Bij offerte', hint: 'Het nummer van de offerte waar deze factuur uit komt.', shape: 'text', caption: ['Offerte', 'Offerte'], only: 'invoice', defaults: { w: 200, h: 14, size: -1, label: 'inline' } },
  { key: 'document.gegevens', group: 'document', name: 'Documentgegevens', hint: 'Nummer, datum, vervaldatum en project onder elkaar.', shape: 'rows', caption: ['Factuurgegevens', 'Offertegegevens'], captionOther: { credit_note: 'Creditfactuurgegevens', dunning: 'Gegevens' }, defaults: { w: 220, h: 64, size: -1 } },
  { key: 'document.totaal', group: 'document', name: 'Totaalbedrag', hint: 'Het totaal inclusief btw, los te plaatsen.', shape: 'text', caption: ['Totaal', 'Totaal'], captionOther: { credit_note: 'Totaal credit', dunning: 'Totaal te voldoen' }, defaults: { w: 200, h: 18, size: 2, bold: true, label: 'inline' } },
  { key: 'document.betaalinstructie', group: 'document', name: 'Betaalinstructie', hint: 'Je betaaltekst uit Instellingen → Facturatie.', shape: 'text', caption: ['Betaling', 'Betaling'], defaults: { w: 320, h: 28, size: -1, tone: 'muted' } },
  { key: 'document.voettekst', group: 'document', name: 'Voettekst', hint: 'Je afsluitende tekst uit Instellingen → Facturatie.', shape: 'text', caption: ['Voettekst', 'Voettekst'], defaults: { w: 360, h: 24, size: -2, tone: 'muted' } },
  { key: 'document.pagina', group: 'document', name: 'Paginanummer', hint: '"Pagina 1 van 2".', shape: 'text', caption: ['Pagina', 'Pagina'], defaults: { w: 120, h: 12, size: -2, tone: 'muted', align: 'right' } },
];

const FIELD_INDEX: Record<string, DocumentFieldDefinition> = Object.fromEntries(DOCUMENT_FIELDS.map(field => [field.key, field]));

/** Andere namen voor dezelfde velden in {{…}}, voor wie het zo leest. */
const TOKEN_ALIASES: Record<string, string> = {
  'document.geldig_tot': 'document.vervaldatum',
  'bedrijf.btwnummer': 'bedrijf.btw',
  'klant.btwnummer': 'klant.btw',
};

export function fieldDefinition(key: string | null | undefined): DocumentFieldDefinition | null {
  return key ? FIELD_INDEX[key] ?? null : null;
}

export function fieldCaption(key: string, kind: DocumentKind): string {
  const field = FIELD_INDEX[key];
  if (!field) return key;
  if (kind === 'credit_note' || kind === 'dunning') return field.captionOther?.[kind] ?? field.caption[0];
  return kind === 'quote' ? field.caption[1] : field.caption[0];
}

export function fieldsFor(kind: DocumentKind): DocumentFieldDefinition[] {
  return DOCUMENT_FIELDS.filter(field => !field.only || field.only === kind);
}

export interface FlowItemDefinition {
  key: LayoutFlowKey;
  name: string;
  hint: string;
  /** Kan niet weg: zonder regels, totalen of btw-vermeldingen klopt het document niet. */
  required: boolean;
  /** Heeft een eigen tekst (inleiding, afsluiting). */
  hasText?: boolean;
}

export const FLOW_ITEMS: FlowItemDefinition[] = [
  { key: 'intro', name: 'Inleiding', hint: 'Een eigen tekst boven de regels, bijv. "Beste {{klant.contactpersoon}}, …".', required: false, hasText: true },
  { key: 'lines', name: 'Regels', hint: 'Omschrijving, aantal, prijs, btw en bedrag; loopt door op de volgende pagina.', required: true },
  { key: 'totals', name: 'Totalen', hint: 'Subtotaal, btw per tarief en het totaal.', required: true },
  { key: 'vat_notes', name: 'Btw-vermeldingen', hint: 'Verplicht bij btw verlegd, ICP, export of vrijstelling; verschijnt alleen als het nodig is.', required: true },
  { key: 'payment', name: 'Betaling', hint: 'Je betaaltekst en je IBAN.', required: false },
  { key: 'notes', name: 'Notities', hint: 'De notitie die je bij het document schrijft.', required: false },
  { key: 'online_link', name: 'Online bekijken', hint: 'De link naar de online factuur of offerte; verschijnt pas bij versturen.', required: false },
  { key: 'closing', name: 'Afsluiting', hint: 'Een eigen tekst onder alles, bijv. "Met vriendelijke groet".', required: false, hasText: true },
];

const FLOW_KEYS = FLOW_ITEMS.map(item => item.key);
const REQUIRED_FLOW = FLOW_ITEMS.filter(item => item.required).map(item => item.key);

// ── De gegevens van één document ────────────────────────────────────────────

export interface DocumentLine {
  description: string;
  quantity: number;
  unitPrice: number;
  vatRate: number;
  /** Regelbedrag exclusief btw, al cent-exact afgerond door de aanroeper. */
  net: number;
  /** Regelbedrag inclusief btw, idem. */
  gross: number;
}

export interface DocumentTotals {
  subtotal: number;
  vat: number;
  total: number;
  vatBreakdown: Array<{ rate: number; base: number; vat: number }>;
}

export interface DocumentCompany {
  /** Merknaam, of anders de juridische naam. */
  displayName: string;
  /** De naam zoals ingeschreven bij de KvK. */
  legalName: string;
  addressLines: string[];
  email: string;
  phone: string;
  website: string;
  kvk: string;
  vat: string;
  iban: string;
  paymentTerms: string;
  footer: string;
}

export interface DocumentClient {
  name: string;
  contactName: string;
  addressLines: string[];
  email: string;
  phone: string;
  vat: string;
  kvk: string;
  code: string;
}

export interface DocumentData {
  kind: DocumentKind;
  number: string;
  date: string | null;
  /** Vervaldatum (factuur) of geldig tot (offerte). */
  secondDate: string | null;
  projectName: string;
  /** Bij een factuur: het nummer van de offerte waar hij uit komt. */
  quoteNumber: string;
  company: DocumentCompany;
  client: DocumentClient | null;
  lines: DocumentLine[];
  totals: DocumentTotals;
  /** Verplichte btw-vermeldingen (art. 35a Wet OB), al opgesteld door de aanroeper. */
  vatNotes: string[];
  notes: string;
  /** Pas bekend bij versturen; zonder link geen linkregel. */
  onlineLink: { label: string; url: string } | null;
  /** Eigen rijen voor "Documentgegevens" (creditfactuur, aanmaning). */
  metaRows?: Array<{ label: string; value: string }>;
  /** Label bij het totaal; standaard "Totaal". */
  totalsLabel?: string;
  /** Kopje boven de notitie; standaard "Notities" ("Reden" op een creditfactuur). */
  notesCaption?: string;
  /** Vervangt de betaalregels: op een creditfactuur "wordt terugbetaald" of "vervalt". */
  paymentLines?: string[];
  /** Vervangt de hele inhoud door een brief (de aanmaning). */
  body?: DocumentBodyPart[];
}

/** Een stuk briefinhoud, voor een stuk dat geen regels en totalen heeft (de aanmaning). */
export type DocumentBodyPart =
  | { type: 'paragraph'; text: string; bold?: boolean; tone?: 'text' | 'muted' }
  | { type: 'rows'; caption?: string; rows: Array<{ label: string; value: string; bold?: boolean }> }
  | { type: 'gap'; size: number };

/** De kolommen van company_settings die een document nodig heeft. */
export interface CompanyRowLike {
  company_name?: string | null;
  trade_name?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  postal_code?: string | null;
  city?: string | null;
  country?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  kvk_number?: string | null;
  vat_number?: string | null;
  iban?: string | null;
  invoice_payment_terms?: string | null;
  invoice_footer?: string | null;
}

/** De kolommen van clients die een document nodig heeft. */
export interface ClientRowLike {
  name?: string | null;
  contact_name?: string | null;
  email?: string | null;
  phone?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  postal_code?: string | null;
  city?: string | null;
  country?: string | null;
  vat_number?: string | null;
  kvk_number?: string | null;
  client_code?: string | null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function addressLines(row: { address_line1?: string | null; address_line2?: string | null; postal_code?: string | null; city?: string | null; country?: string | null }): string[] {
  return [
    str(row.address_line1),
    str(row.address_line2),
    [str(row.postal_code), str(row.city)].filter(Boolean).join(' '),
    str(row.country),
  ].filter(Boolean);
}

export const DEFAULT_FOOTER = 'Bedankt voor het vertrouwen.';

/**
 * Zet de rijen uit de database om in de gegevens van één document. App en
 * server roepen dit allebei aan, zodat "T.a.v." en de volgorde van een adres
 * nergens anders kunnen uitvallen.
 */
export function buildDocumentData(input: {
  kind: DocumentKind;
  number?: string | null;
  date?: string | null;
  secondDate?: string | null;
  company?: CompanyRowLike | null;
  client?: ClientRowLike | null;
  lines: DocumentLine[];
  totals: DocumentTotals;
  vatNotes?: string[];
  notes?: string | null;
  projectName?: string | null;
  quoteNumber?: string | null;
  onlineLink?: { label: string; url: string } | null;
  metaRows?: Array<{ label: string; value: string }>;
  totalsLabel?: string;
  notesCaption?: string;
  paymentLines?: string[];
  body?: DocumentBodyPart[];
}): DocumentData {
  const company = input.company ?? {};
  const legalName = str(company.company_name);
  const tradeName = str(company.trade_name);
  const client = input.client
    ? {
      name: str(input.client.name) || 'Klant',
      contactName: str(input.client.contact_name),
      addressLines: addressLines(input.client),
      email: str(input.client.email),
      phone: str(input.client.phone),
      vat: str(input.client.vat_number),
      kvk: str(input.client.kvk_number),
      code: str(input.client.client_code),
    }
    : null;
  return {
    kind: input.kind,
    number: str(input.number) || '-',
    date: str(input.date) || null,
    secondDate: str(input.secondDate) || null,
    projectName: str(input.projectName),
    quoteNumber: input.kind === 'invoice' ? str(input.quoteNumber) : '',
    company: {
      displayName: tradeName || legalName,
      legalName: legalName || tradeName,
      addressLines: addressLines(company),
      email: str(company.email),
      phone: str(company.phone),
      website: str(company.website),
      kvk: str(company.kvk_number),
      vat: str(company.vat_number),
      iban: str(company.iban),
      paymentTerms: str(company.invoice_payment_terms),
      footer: str(company.invoice_footer) || DEFAULT_FOOTER,
    },
    client,
    lines: input.lines,
    totals: input.totals,
    vatNotes: (input.vatNotes ?? []).map(str).filter(Boolean),
    notes: str(input.notes),
    onlineLink: input.onlineLink && str(input.onlineLink.url)
      ? { label: str(input.onlineLink.label), url: str(input.onlineLink.url) }
      : null,
    ...(input.metaRows ? { metaRows: input.metaRows.map(row => ({ label: str(row.label), value: str(row.value) })).filter(row => row.value) } : {}),
    ...(input.totalsLabel ? { totalsLabel: str(input.totalsLabel) } : {}),
    ...(input.notesCaption ? { notesCaption: str(input.notesCaption) } : {}),
    ...(input.paymentLines ? { paymentLines: input.paymentLines.map(str).filter(Boolean) } : {}),
    ...(input.body ? { body: input.body } : {}),
  };
}

// ── Bedragen ────────────────────────────────────────────────────────────────

/** Een regel zoals hij in de database staat (quotes.lines, invoices.lines). */
export interface SalesLineLike {
  description?: string | null;
  quantity?: number | string | null;
  unit_price?: number | string | null;
  vat?: number | string | null;
}

function amount(value: number | string | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value == null) return 0;
  const parsed = Number(String(value).replace(',', '.').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Euro's naar hele centen, "half van nul af" — exact zoals src/lib/money.ts. */
function cents(euros: number): number {
  if (!Number.isFinite(euros)) return 0;
  const scaled = euros * 100;
  return scaled >= 0 ? Math.round(scaled + 1e-6) : -Math.round(Math.abs(scaled) + 1e-6);
}

/**
 * Regels en totalen, cent-exact en met de btw per tarief afgerond. Dezelfde
 * rekenregels als src/lib/money.ts (computeTotals, lineNet, lineGross) en als
 * calculateTotals in invoice-workflow; de test houdt de app-kant gelijk. De
 * offerte-PDF rekende vroeger met losse kommagetallen en zonder btw per tarief.
 */
export function documentAmounts(lines: SalesLineLike[]): { lines: DocumentLine[]; totals: DocumentTotals } {
  const baseByRate = new Map<number, number>();
  let subtotal = 0;
  const out: DocumentLine[] = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    const quantity = amount(line.quantity);
    const unitPrice = amount(line.unit_price);
    const vatRate = amount(line.vat);
    const net = cents(quantity * unitPrice);
    const vat = cents((net / 100) * (vatRate / 100));
    subtotal += net;
    baseByRate.set(vatRate, (baseByRate.get(vatRate) ?? 0) + net);
    out.push({ description: str(line.description), quantity, unitPrice, vatRate, net: net / 100, gross: (net + vat) / 100 });
  }
  let vatTotal = 0;
  const vatBreakdown: DocumentTotals['vatBreakdown'] = [];
  for (const [rate, base] of [...baseByRate.entries()].sort((a, b) => a[0] - b[0])) {
    const vat = cents((base / 100) * (rate / 100));
    vatTotal += vat;
    vatBreakdown.push({ rate, base: base / 100, vat: vat / 100 });
  }
  return { lines: out, totals: { subtotal: subtotal / 100, vat: vatTotal / 100, total: (subtotal + vatTotal) / 100, vatBreakdown } };
}

// ── Creditfactuur en aanmaning als document ─────────────────────────────────

/**
 * Een creditfactuur in de opmaak van de factuur. De bedragen komen uit de
 * opgeslagen creditnota (zo is hij geboekt) en staan negatief op het papier.
 * De btw per tarief alleen als die uit de regels precies op het opgeslagen
 * bedrag uitkomt; anders één btw-regel, zodat de PDF nooit een cent afwijkt
 * van de boeking.
 */
export function creditNoteDocument(input: {
  number: string | null;
  date: string | null;
  /** Het factuurnummer zoals de klant het kent. */
  invoiceReference: string | null;
  invoiceDate: string | null;
  company?: CompanyRowLike | null;
  client?: ClientRowLike | null;
  lines: SalesLineLike[];
  subtotal: number;
  vat: number;
  total: number;
  vatNotes?: string[];
  reason?: string | null;
  /** false = een onbetaalde factuur vervalt; er wordt niets terugbetaald. */
  refunded?: boolean;
}): DocumentData {
  const amounts = documentAmounts(input.lines);
  const exact = cents(amounts.totals.subtotal) === cents(input.subtotal) && cents(amounts.totals.vat) === cents(input.vat);
  const neg = (n: number) => (n === 0 ? 0 : -n);
  return buildDocumentData({
    kind: 'credit_note',
    number: input.number,
    date: input.date,
    secondDate: null,
    company: input.company,
    client: input.client,
    lines: amounts.lines.map(line => ({ ...line, unitPrice: neg(line.unitPrice), net: neg(line.net), gross: neg(line.gross) })),
    totals: {
      subtotal: neg(input.subtotal),
      vat: neg(input.vat),
      total: neg(input.total),
      vatBreakdown: exact ? amounts.totals.vatBreakdown.map(row => ({ rate: row.rate, base: neg(row.base), vat: neg(row.vat) })) : [],
    },
    vatNotes: input.vatNotes,
    notes: input.reason,
    notesCaption: 'Reden',
    totalsLabel: 'Totaal credit',
    paymentLines: [input.refunded === false ? 'Hiermee vervalt de factuur; u hoeft niets meer te betalen.' : 'Dit bedrag wordt aan u terugbetaald.'],
    metaRows: [
      { label: 'Creditfactuurnummer', value: str(input.number) || '-' },
      { label: 'Datum', value: input.date ? formatDocDate(input.date) : '' },
      { label: 'Creditering van factuur', value: str(input.invoiceReference) },
      { label: 'Factuurdatum', value: input.invoiceDate ? formatDocDate(input.invoiceDate) : '' },
      { label: 'Klantnummer', value: str(input.client?.client_code) },
    ],
    onlineLink: null,
  });
}

/** Een aanmaning in de opmaak van de factuur: de kop, de voet en het logo, met de brief ertussen. */
export function dunningDocument(input: Omit<DunningLetterInput, 'signature' | 'accountHolder'> & {
  company?: CompanyRowLike | null;
  client?: ClientRowLike | null;
  /** De datum van de brief (de rekendatum van de vordering). */
  letterDate: string | null;
  invoiceDate: string | null;
}): DocumentData {
  const company = input.company ?? {};
  const signature = str(company.trade_name) || str(company.company_name);
  const accountHolder = str(company.company_name) || signature;
  return buildDocumentData({
    kind: 'dunning',
    number: input.invoiceNumber,
    date: input.letterDate,
    // Een onderneming krijgt een vaste uiterste datum; een consument veertien
    // dagen vanaf de bezorging (art. 6:96 lid 6 BW), dus geen datum.
    secondDate: input.consumer ? null : input.deadlineDate,
    company: input.company,
    client: input.client,
    lines: [],
    totals: { subtotal: input.totalClaimCents / 100, vat: 0, total: input.totalClaimCents / 100, vatBreakdown: [] },
    notes: null,
    onlineLink: null,
    metaRows: [
      { label: 'Datum', value: input.letterDate ? formatDocDate(input.letterDate) : '' },
      { label: 'Factuurnummer', value: input.invoiceNumber },
      { label: 'Factuurdatum', value: input.invoiceDate ? formatDocDate(input.invoiceDate) : '' },
      { label: 'Vervaldatum factuur', value: input.invoiceDueDate ? formatDocDate(input.invoiceDueDate) : '' },
      { label: 'Uiterste betaaldatum', value: !input.consumer && input.deadlineDate ? formatDocDate(input.deadlineDate) : '' },
      { label: 'Klantnummer', value: str(input.client?.client_code) },
    ],
    body: dunningLetterBody({ ...input, signature, accountHolder }),
  });
}

// ── Notatie ─────────────────────────────────────────────────────────────────

/** "1.234,50" — met de hand, zodat browser, node en Deno exact hetzelfde schrijven. */
function groupedAmount(cents: number): string {
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString();
  const decimals = (abs % 100).toString().padStart(2, '0');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${grouped},${decimals}`;
}

/** "€ 1.234,50", "€ -12,00". De bedragen zijn al afgerond door de aanroeper. */
export function formatDocMoney(euros: number): string {
  const value = Number.isFinite(euros) ? euros : 0;
  const cents = value >= 0 ? Math.round(value * 100 + 1e-6) : -Math.round(Math.abs(value) * 100 + 1e-6);
  return `€ ${cents < 0 ? '-' : ''}${groupedAmount(cents)}`;
}

/** "2026-11-05" → "5-11-2026", zoals de PDF's het al schreven. */
export function formatDocDate(value: string | null | undefined): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(value));
  if (!match) return str(value) || '-';
  return `${Number(match[3])}-${Number(match[2])}-${match[1]}`;
}

/** 1.5 → "1,5"; 2 → "2". */
export function formatQuantity(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 1000) / 1000;
  return String(rounded).replace('.', ',');
}

export function formatRate(value: number): string {
  return `${formatQuantity(Number.isFinite(value) ? value : 0)}%`;
}

export function documentTitle(kind: DocumentKind): string {
  return { invoice: 'FACTUUR', quote: 'OFFERTE', credit_note: 'CREDITFACTUUR', dunning: 'AANMANING' }[kind];
}

export function documentPdfFileName(kind: DocumentKind, number: string | null | undefined): string {
  const safe = str(number).replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  const prefix = { invoice: 'factuur', quote: 'offerte', credit_note: 'creditfactuur', dunning: 'aanmaning' }[kind];
  return `${prefix}-${safe || 'concept'}.pdf`;
}

// ── De aanmaning ────────────────────────────────────────────────────────────

/** Wat een aanmaning nodig heeft; alle bedragen in centen. */
export interface DunningLetterInput {
  invoiceNumber: string;
  invoiceDueDate: string | null;
  /** Consument (veertiendagenbrief, art. 6:96 lid 6 BW) of onderneming (sommatie). */
  consumer: boolean;
  principalCents: number;
  interestCents: number;
  interestDays: number;
  /** Het rentepercentage, al als tekst ("8" of "12,15"). */
  interestRatePct: string;
  collectionCostsCents: number;
  collectionCostsVatCents: number;
  totalClaimCents: number;
  /** Uiterste betaaldatum bij een onderneming. */
  deadlineDate: string | null;
  iban: string;
  /** De rekeninghouder (juridische naam); de bank controleert die naam. */
  accountHolder: string;
  publicUrl: string;
  /** Ondertekening, de naam van het bedrijf. */
  signature: string;
}

/**
 * De tekst van een aanmaning. Dezelfde zinnen en bedragen als de brief die
 * invoice-workflow al verstuurde (consument: de veertiendagenbrief met de
 * incassokosten pas bij uitblijven van betaling; onderneming: sommatie); nu in
 * de opmaak van de factuur, met logo. Wijzig de juridische tekst hier niet
 * zonder dat na te gaan: de WIK-brief moet aan wettelijke eisen voldoen.
 */
export function dunningLetterBody(input: DunningLetterInput): DocumentBodyPart[] {
  const euros = (cents: number) => formatDocMoney((Number(cents) || 0) / 100);
  const consumer = input.consumer;
  const dueNowCents = consumer ? input.principalCents + input.interestCents : input.totalClaimCents;
  const interestLabel = consumer ? 'wettelijke rente' : 'wettelijke handelsrente';
  const hasVat = input.collectionCostsVatCents > 0;
  const vatSentence = hasVat
    ? `De incassokosten worden verhoogd met ${euros(input.collectionCostsVatCents)} btw (incassokosten inclusief btw: ${euros(input.collectionCostsCents + input.collectionCostsVatCents)}).`
    : 'Over de incassokosten wordt geen btw in rekening gebracht.';
  const intro = `Ondanks eerdere herinneringen is factuur ${input.invoiceNumber} met vervaldatum ${formatDocDate(input.invoiceDueDate)} nog niet volledig voldaan. De openstaande hoofdsom bedraagt ${euros(input.principalCents)}.`;
  const demand = consumer
    ? `Wij verzoeken u het openstaande bedrag van ${euros(dueNowCents)} (de hoofdsom en de tot op heden verschenen wettelijke rente) te voldoen binnen veertien dagen vanaf de dag nadat deze brief bij u is bezorgd. Betaalt u niet binnen deze termijn, dan bent u daarnaast een vergoeding voor buitengerechtelijke incassokosten van ${euros(input.collectionCostsCents)} verschuldigd, en blijft de wettelijke rente oplopen. ${vatSentence}`
    : `Uw onderneming is van rechtswege in verzuim. Wij sommeren u het volledige openstaande bedrag van ${euros(input.totalClaimCents)} — de hoofdsom, de wettelijke handelsrente en de buitengerechtelijke incassokosten — te voldoen binnen veertien dagen, uiterlijk op ${formatDocDate(input.deadlineDate)}. ${vatSentence}`;
  const rows: Array<{ label: string; value: string; bold?: boolean }> = [
    { label: 'Hoofdsom (openstaand)', value: euros(input.principalCents) },
    { label: `${interestLabel[0].toUpperCase()}${interestLabel.slice(1)} (${input.interestDays} dagen, ${input.interestRatePct}%)`, value: euros(input.interestCents) },
    { label: consumer ? 'Buitengerechtelijke incassokosten (bij uitblijven betaling)' : 'Buitengerechtelijke incassokosten', value: euros(input.collectionCostsCents) },
  ];
  if (hasVat) rows.push({ label: 'Btw over incassokosten', value: euros(input.collectionCostsVatCents) });
  if (consumer) {
    rows.push({ label: 'Nu te voldoen (hoofdsom + rente)', value: euros(dueNowCents), bold: true });
    rows.push({ label: 'Totaal bij niet-tijdige betaling', value: euros(input.totalClaimCents), bold: true });
  } else {
    rows.push({ label: 'Totaal te voldoen', value: euros(input.totalClaimCents), bold: true });
  }
  const iban = str(input.iban);
  const payment = iban
    ? `U kunt het bedrag overmaken op ${iban} t.n.v. ${str(input.accountHolder) || str(input.signature)} onder vermelding van factuurnummer ${input.invoiceNumber}. Online betalen of de factuur bekijken kan via: ${input.publicUrl}`
    : `Bekijk of betaal de factuur online via: ${input.publicUrl}`;
  return [
    { type: 'paragraph', text: `Betreft: aanmaning factuur ${input.invoiceNumber}`, bold: true },
    { type: 'gap', size: 4 },
    { type: 'paragraph', text: intro },
    { type: 'paragraph', text: demand },
    { type: 'rows', caption: 'Specificatie', rows },
    { type: 'paragraph', text: payment },
    { type: 'paragraph', text: 'Wij vertrouwen op een tijdige betaling. Heeft u vragen of heeft u inmiddels betaald, neem dan contact met ons op.' },
    { type: 'gap', size: 6 },
    { type: 'paragraph', text: 'Met vriendelijke groet,' },
    { type: 'paragraph', text: str(input.signature), bold: true },
  ];
}

// ── Tekst die een standaardlettertype van pdf-lib kan tekenen ───────────────
//
// De standaardletters van pdf-lib coderen in WinAnsi: ASCII, Latin-1 en 27
// tekens daarbuiten (€, ‘ ’ “ ”, – —, …). Eén emoji in een factuurregel liet
// vroeger de hele PDF mislukken; nu valt alleen dat ene teken weg.

const WINANSI_EXTRA = new Set([
  0x152, 0x153, 0x160, 0x161, 0x178, 0x17d, 0x17e, 0x192, 0x2c6, 0x2dc, 0x2013, 0x2014, 0x2018, 0x2019,
  0x201a, 0x201c, 0x201d, 0x201e, 0x2020, 0x2021, 0x2022, 0x2026, 0x2030, 0x2039, 0x203a, 0x20ac, 0x2122,
]);

export function pdfSafeText(value: unknown): string {
  const source = String(value ?? '')
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t -   　]/g, ' ')
    .replace(/[‐‑−]/g, '-')
    .replace(/[​-‍⁠﻿]/g, '');
  let out = '';
  for (const char of source) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 10 || (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WINANSI_EXTRA.has(code)) out += char;
  }
  return out;
}

// ── Kleur ───────────────────────────────────────────────────────────────────

const HEX = /^#[0-9A-Fa-f]{6}$/;

function hexOr(value: unknown, fallback: string): string {
  const text = str(value);
  return HEX.test(text) ? text.toUpperCase() : fallback;
}

function channels(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map(c => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function luminance(hex: string): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = channels(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function documentContrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function blend(front: string, back: string, alpha: number): string {
  const f = channels(front);
  const k = channels(back);
  return toHex(f[0] * alpha + k[0] * (1 - alpha), f[1] * alpha + k[1] * (1 - alpha), f[2] * alpha + k[2] * (1 - alpha));
}

function toHsl(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = channels(hex).map(c => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return { h: h < 0 ? h + 360 : h, s, l };
}

function fromHsl(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return toHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

/**
 * De merkkleur als TEKST op wit papier. Merkgoud (#FFD966) haalt op wit maar
 * 1,4 : 1 — als factuurtitel onleesbaar. We schuiven alleen de helderheid op
 * tot 4,5 : 1, zodat het herkenbaar dezelfde kleur blijft (zoals de
 * klantpagina's in src/lib/branding.ts).
 */
function readableOnPaper(accent: string): string {
  if (documentContrast(accent, '#FFFFFF') >= 4.5) return accent;
  const { h, s, l } = toHsl(accent);
  for (let next = l; next >= 0; next -= 0.02) {
    const candidate = fromHsl(h, s, Math.max(0, next));
    if (documentContrast(candidate, '#FFFFFF') >= 4.5) return candidate;
  }
  return '#000000';
}

// ── Stijl ───────────────────────────────────────────────────────────────────

export interface DocumentStyle {
  ink: string;
  muted: string;
  /** De merkkleur zelf: vlakken, balken, lijnen. */
  accent: string;
  /** De merkkleur als tekst op papier. */
  accentInk: string;
  /** Tekst óp een vlak in de merkkleur. */
  onAccent: string;
  baseSize: number;
  headingFont: PdfFontKey;
  bodyFont: PdfFontKey;
}

/** De kolommen van company_settings die de stijl bepalen. */
export interface StyleRowLike {
  invoice_template_text_color?: string | null;
  brand_accent_color?: string | null;
  invoice_accent_color?: string | null;
  invoice_font_size?: number | string | null;
  brand_heading_font?: string | null;
  brand_body_font?: string | null;
}

/** Een letter van de huisstijl als letter voor de PDF; onbekend wordt Poppins. */
function brandPdfFont(key: string | null | undefined): PdfFontKey {
  const font = PDF_FONT_INDEX[str(key)];
  return font && !font.standard ? font.key : 'system';
}

export function resolveDocumentStyle(
  row: StyleRowLike | null | undefined,
  fonts: { heading?: PdfFontChoice; body?: PdfFontChoice } = {},
): DocumentStyle {
  const ink = hexOr(row?.invoice_template_text_color, '#1A1A1A');
  const accent = hexOr(row?.brand_accent_color, hexOr(row?.invoice_accent_color, '#FFD966'));
  const size = Math.round(Number(row?.invoice_font_size ?? 10));
  const baseSize = Number.isFinite(size) ? Math.max(LAYOUT_LIMITS.baseSize.min, Math.min(LAYOUT_LIMITS.baseSize.max, size)) : 10;
  const onAccent = documentContrast(accent, '#111111') >= documentContrast(accent, '#FFFFFF') ? '#111111' : '#FFFFFF';
  const heading = !fonts.heading || fonts.heading === 'auto' ? brandPdfFont(row?.brand_heading_font) : pdfFont(fonts.heading).key;
  let body = !fonts.body || fonts.body === 'auto' ? brandPdfFont(row?.brand_body_font) : pdfFont(fonts.body).key;
  // Bebas Neue heeft alleen kapitalen: niet voor lopende tekst.
  if (pdfFont(body).headingOnly) body = 'system';
  return {
    ink,
    // Gedempt: de tekstkleur, 30% naar wit. Bij de standaard #1A1A1A is dat
    // #5F5F5F, vrijwel het grijs van de oude PDF's, en 6,4 : 1 op wit.
    muted: blend(ink, '#FFFFFF', 0.7),
    accent,
    accentInk: readableOnPaper(accent),
    onAccent,
    baseSize,
    headingFont: heading,
    bodyFont: body,
  };
}

/** De standaardletter die het dichtst bij een ingesloten letter komt (als die niet laadt). */
export function standardFallback(key: PdfFontKey): PdfFontKey {
  const font = pdfFont(key);
  if (font.standard) return font.key;
  return font.serif ? 'times' : 'helvetica';
}

// ── Standaardsjablonen ──────────────────────────────────────────────────────

export type LayoutPresetKey = 'standaard' | 'strak' | 'briefpapier';

export const LAYOUT_PRESETS: Array<{ key: LayoutPresetKey; name: string; hint: string }> = [
  { key: 'standaard', name: 'Standaard', hint: 'Logo en merkkleur bovenaan, je klant links en de gegevens rechts. Past bij iedereen.' },
  { key: 'strak', name: 'Strak', hint: 'Veel wit, de titel in je merkkleur en het totaal in een vlak.' },
  { key: 'briefpapier', name: 'Voor briefpapier', hint: 'Laat boven en onder ruimte vrij voor je eigen briefpapier.' },
];

function defaultFlow(kind: DocumentKind): LayoutFlowItem[] {
  return [
    { key: 'intro', show: false, text: '' },
    { key: 'lines', show: true },
    { key: 'totals', show: true },
    { key: 'vat_notes', show: true },
    { key: 'payment', show: layoutKind(kind) === 'invoice' },
    { key: 'notes', show: true },
    { key: 'online_link', show: true },
    { key: 'closing', show: false, text: '' },
  ];
}

const RIGHT_COLUMN_X = 327.28; // 595,28 − 48 − 220: een kolom van 220 tegen de rechterkantlijn

function presetBlocks(key: LayoutPresetKey): LayoutBlock[] {
  if (key === 'strak') {
    return [
      { id: 'logo', type: 'logo', x: 48, y: 48, w: 200, h: 48 },
      { id: 'afzender', type: 'field', field: 'bedrijf.gegevens', x: RIGHT_COLUMN_X, y: 48, w: 220, h: 80, align: 'right' },
      { id: 'titel', type: 'field', field: 'document.titel', x: 48, y: 136, w: 300, h: 34, size: 26, tone: 'accent', align: 'left' },
      { id: 'klant', type: 'field', field: 'klant.gegevens', x: 48, y: 188, w: 260, h: 100, label: 'above' },
      { id: 'gegevens', type: 'field', field: 'document.gegevens', x: RIGHT_COLUMN_X, y: 188, w: 220, h: 64, align: 'right' },
      { id: 'voetlijn', type: 'line', x: 48, y: 772, w: 499.28, h: 6, tone: 'muted', weight: 0.4 },
      { id: 'voettekst', type: 'field', field: 'document.voettekst', x: 48, y: 784, w: 330, h: 14 },
      { id: 'pagina', type: 'field', field: 'document.pagina', x: 427.28, y: 784, w: 120, h: 12 },
      { id: 'registratie', type: 'field', field: 'bedrijf.registratie', x: 48, y: 802, w: 499.28, h: 12, inline: true },
    ];
  }
  if (key === 'briefpapier') {
    return [
      { id: 'titel', type: 'field', field: 'document.titel', x: RIGHT_COLUMN_X, y: 150, w: 220, h: 30, align: 'right' },
      { id: 'gegevens', type: 'field', field: 'document.gegevens', x: RIGHT_COLUMN_X, y: 188, w: 220, h: 64, align: 'right' },
      { id: 'klant', type: 'field', field: 'klant.gegevens', x: 48, y: 188, w: 260, h: 100, label: 'above' },
      { id: 'pagina', type: 'field', field: 'document.pagina', x: 427.28, y: 744, w: 120, h: 12 },
    ];
  }
  return [
    { id: 'balk', type: 'box', x: 0, y: 0, w: PAGE_WIDTH, h: 10, tone: 'accent', opacity: 1 },
    { id: 'logo', type: 'logo', x: 48, y: 40, w: 220, h: 54 },
    { id: 'titel', type: 'field', field: 'document.titel', x: RIGHT_COLUMN_X, y: 40, w: 220, h: 30, align: 'right' },
    { id: 'gegevens', type: 'field', field: 'document.gegevens', x: RIGHT_COLUMN_X, y: 82, w: 220, h: 64, align: 'right' },
    { id: 'afzender', type: 'field', field: 'bedrijf.gegevens', x: 48, y: 104, w: 220, h: 80 },
    { id: 'klant', type: 'field', field: 'klant.gegevens', x: 48, y: 198, w: 260, h: 100, label: 'above' },
    { id: 'registratie', type: 'field', field: 'bedrijf.registratie', x: RIGHT_COLUMN_X, y: 198, w: 220, h: 60, label: 'above', align: 'right' },
    { id: 'voetlijn', type: 'line', x: 48, y: 772, w: 499.28, h: 6, tone: 'muted', weight: 0.45 },
    { id: 'voettekst', type: 'field', field: 'document.voettekst', x: 48, y: 786, w: 360, h: 24 },
    { id: 'pagina', type: 'field', field: 'document.pagina', x: 427.28, y: 786, w: 120, h: 12 },
  ];
}

/** Een standaardsjabloon als bewerkbare opmaak (de editor begint hiermee). */
export function presetLayout(key: LayoutPresetKey, kind: DocumentKind): DocumentLayout {
  const strak = key === 'strak';
  const brief = key === 'briefpapier';
  return {
    version: 1,
    preset: key,
    bodyTop: brief ? 312 : strak ? 306 : 318,
    footerTop: brief ? 740 : 768,
    continueTop: brief ? 150 : 62,
    marginX: 48,
    repeatHeader: false,
    table: { quantity: true, unitPrice: true, vatRate: true, lineTotals: 'incl', style: strak ? 'lines' : 'tinted' },
    totalsStyle: strak ? 'filled' : 'line',
    flow: defaultFlow(kind),
    blocks: presetBlocks(key),
  };
}

/**
 * De opmaak voor wie niets heeft ingesteld. Met eigen briefpapier geen
 * gekleurde balk over de kop van dat papier heen — zo deden de PDF's het al.
 */
export function builtInLayout(kind: DocumentKind, options: { letterhead?: boolean } = {}): DocumentLayout {
  const layout = presetLayout('standaard', kind);
  if (options.letterhead) layout.blocks = layout.blocks.filter(block => block.id !== 'balk');
  delete layout.preset;
  return layout;
}

/** De opmaak die voor dit document geldt: de eigen, anders de standaard. */
export function resolveDocumentLayout(layouts: DocumentLayouts | null | undefined, kind: DocumentKind, options: { letterhead?: boolean } = {}): DocumentLayout {
  const own = kind === 'quote' ? layouts?.quote : layouts?.invoice;
  return own ?? builtInLayout(kind, options);
}

// ── Saneren: wat uit de database komt, vertrouwen we niet ───────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.max(min, Math.min(max, n)) * 100) / 100;
}

function optionalNum(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.round(Math.max(min, Math.min(max, n)) * 100) / 100;
}

function oneOf<T extends string>(value: unknown, options: readonly T[]): T | undefined {
  return typeof value === 'string' && (options as readonly string[]).includes(value) ? value as T : undefined;
}

function optionalBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').slice(0, max) : '';
}

const BLOCK_TYPES: readonly LayoutBlockType[] = ['field', 'text', 'logo', 'line', 'box'];
const ALIGNS: readonly LayoutAlign[] = ['left', 'center', 'right'];
const TONES: readonly LayoutTone[] = ['text', 'muted', 'accent'];
const LABELS: readonly LayoutLabel[] = ['none', 'inline', 'above'];
const FONT_CHOICE_KEYS: readonly PdfFontChoice[] = ['auto', ...PDF_FONTS.map(font => font.key)];
const TABLE_STYLE_KEYS: readonly TableStyle[] = ['tinted', 'lines', 'plain'];
const TOTALS_STYLE_KEYS: readonly TotalsStyle[] = ['line', 'filled'];
const PRESET_KEYS: readonly LayoutPresetKey[] = ['standaard', 'strak', 'briefpapier'];

function normalizeBlock(raw: unknown): LayoutBlock | null {
  if (!isRecord(raw)) return null;
  const type = oneOf(raw.type, BLOCK_TYPES);
  if (!type) return null;
  const field = type === 'field' ? str(raw.field) : '';
  if (type === 'field' && !FIELD_INDEX[field]) return null;
  const x = num(raw.x, 0, PAGE_WIDTH - 8, 48);
  const y = num(raw.y, 0, PAGE_HEIGHT - 4, 48);
  const block: LayoutBlock = {
    id: str(raw.id),
    type,
    x,
    y,
    w: num(raw.w, 8, PAGE_WIDTH - x, 160),
    h: num(raw.h, 4, PAGE_HEIGHT - y, 16),
  };
  if (type === 'field') block.field = field;
  if (type === 'text') block.text = cleanText(raw.text, LAYOUT_LIMITS.text);
  const size = optionalNum(raw.size, LAYOUT_LIMITS.size.min, LAYOUT_LIMITS.size.max);
  if (size !== undefined) block.size = size;
  const bold = optionalBool(raw.bold);
  if (bold !== undefined) block.bold = bold;
  const align = oneOf(raw.align, ALIGNS);
  if (align) block.align = align;
  const tone = oneOf(raw.tone, TONES);
  if (tone) block.tone = tone;
  const label = oneOf(raw.label, LABELS);
  if (label) block.label = label;
  const caption = cleanText(raw.caption, LAYOUT_LIMITS.caption).replace(/\n/g, ' ').trim();
  if (caption) block.caption = caption;
  const firstBold = optionalBool(raw.firstBold);
  if (firstBold !== undefined) block.firstBold = firstBold;
  const inline = optionalBool(raw.inline);
  if (inline !== undefined) block.inline = inline;
  const opacity = optionalNum(raw.opacity, LAYOUT_LIMITS.opacity.min, LAYOUT_LIMITS.opacity.max);
  if (opacity !== undefined) block.opacity = opacity;
  const weight = optionalNum(raw.weight, LAYOUT_LIMITS.weight.min, LAYOUT_LIMITS.weight.max);
  if (weight !== undefined) block.weight = weight;
  return block;
}

function normalizeFlow(raw: unknown, kind: DocumentKind): LayoutFlowItem[] {
  const seen = new Set<LayoutFlowKey>();
  const flow: LayoutFlowItem[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isRecord(item)) continue;
    const key = oneOf(item.key, FLOW_KEYS);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const entry: LayoutFlowItem = { key, show: REQUIRED_FLOW.includes(key) ? true : item.show === true };
    if (FLOW_ITEMS.find(def => def.key === key)?.hasText) entry.text = cleanText(item.text, LAYOUT_LIMITS.text);
    flow.push(entry);
  }
  // Wat ontbreekt komt erbij. De regels, totalen en btw-vermeldingen moeten er
  // altijd zijn, in die volgorde: een ontbrekende komt direct na zijn
  // voorganger. Al het andere (ook een onderdeel dat er later bij komt) gaat
  // uit achteraan, waar het de gekozen volgorde niet verstoort.
  for (const fallback of defaultFlow(kind)) {
    if (seen.has(fallback.key)) continue;
    seen.add(fallback.key);
    if (!REQUIRED_FLOW.includes(fallback.key)) {
      flow.push({ ...fallback, show: false });
      continue;
    }
    const at = FLOW_KEYS.indexOf(fallback.key);
    let index = -1;
    for (let i = at - 1; i >= 0 && index === -1; i--) {
      const found = flow.findIndex(item => item.key === FLOW_KEYS[i]);
      if (found !== -1) index = found + 1;
    }
    if (index === -1) {
      const next = flow.findIndex(item => FLOW_KEYS.indexOf(item.key) > at);
      index = next === -1 ? flow.length : next;
    }
    flow.splice(index, 0, { ...fallback, show: true });
  }
  return flow;
}

/**
 * Een opmaak uit de database of uit de editor, gekeurd: onbekende velden en
 * blokken vallen weg, getallen blijven op de pagina, teksten zijn begrensd.
 * Geeft `null` als het geen opmaak is; dan geldt de standaard.
 */
export function normalizeDocumentLayout(raw: unknown, kind: DocumentKind = 'invoice'): DocumentLayout | null {
  if (!isRecord(raw) || raw.version !== DOCUMENT_LAYOUT_VERSION) return null;
  const table = isRecord(raw.table) ? raw.table : {};
  const used = new Set<string>();
  const blocks: LayoutBlock[] = [];
  for (const item of Array.isArray(raw.blocks) ? raw.blocks.slice(0, LAYOUT_LIMITS.blocks) : []) {
    const block = normalizeBlock(item);
    if (!block) continue;
    let id = /^[A-Za-z0-9_-]{1,24}$/.test(block.id) ? block.id : `b${blocks.length + 1}`;
    for (let n = 2; used.has(id); n++) id = `${id.slice(0, 20)}-${n}`;
    used.add(id);
    blocks.push({ ...block, id });
  }
  const layout: DocumentLayout = {
    version: 1,
    bodyTop: num(raw.bodyTop, LAYOUT_LIMITS.bodyTop.min, LAYOUT_LIMITS.bodyTop.max, 318),
    footerTop: num(raw.footerTop, LAYOUT_LIMITS.footerTop.min, LAYOUT_LIMITS.footerTop.max, 768),
    continueTop: num(raw.continueTop, LAYOUT_LIMITS.continueTop.min, LAYOUT_LIMITS.continueTop.max, 62),
    marginX: num(raw.marginX, LAYOUT_LIMITS.marginX.min, LAYOUT_LIMITS.marginX.max, 48),
    repeatHeader: raw.repeatHeader === true,
    table: {
      quantity: table.quantity !== false,
      unitPrice: table.unitPrice !== false,
      vatRate: table.vatRate !== false,
      lineTotals: table.lineTotals === 'excl' ? 'excl' : 'incl',
      style: oneOf(table.style, TABLE_STYLE_KEYS) ?? 'tinted',
    },
    totalsStyle: oneOf(raw.totalsStyle, TOTALS_STYLE_KEYS) ?? 'line',
    flow: normalizeFlow(raw.flow, kind),
    blocks,
  };
  const preset = oneOf(raw.preset, PRESET_KEYS);
  if (preset) layout.preset = preset;
  return layout;
}

/** company_settings.document_layouts → gekeurde opmaak per soort document. */
export function parseDocumentLayouts(raw: unknown): DocumentLayouts {
  const value = isRecord(raw) ? raw : {};
  // `font` was één keuze voor alles (alleen Helvetica, Times of Courier);
  // een oude waarde geldt dan voor koppen én tekst.
  const legacy = oneOf(value.font, FONT_CHOICE_KEYS);
  const heading = oneOf(value.headingFont, FONT_CHOICE_KEYS) ?? legacy ?? 'auto';
  let body = oneOf(value.bodyFont, FONT_CHOICE_KEYS) ?? legacy ?? 'auto';
  if (body !== 'auto' && pdfFont(body).headingOnly) body = 'auto';
  return {
    version: 1,
    headingFont: heading,
    bodyFont: body,
    invoice: normalizeDocumentLayout(value.invoice, 'invoice'),
    quote: normalizeDocumentLayout(value.quote, 'quote'),
  };
}

/** De letterkeuze uit de opmaak, zoals resolveDocumentStyle hem wil. */
export function layoutFonts(layouts: DocumentLayouts | null | undefined): { heading: PdfFontChoice; body: PdfFontChoice } {
  return { heading: layouts?.headingFont ?? 'auto', body: layouts?.bodyFont ?? 'auto' };
}

/**
 * Wat er in de kolom komt. Niets eigens ingesteld → `null`, zodat de
 * standaardopmaak meegroeit met verbeteringen in ResoFly in plaats van op de
 * stand van vandaag vast te blijven staan.
 */
export function serializeDocumentLayouts(layouts: DocumentLayouts | null | undefined): DocumentLayouts | null {
  const clean = parseDocumentLayouts(layouts);
  if (!clean.invoice && !clean.quote && clean.headingFont === 'auto' && clean.bodyFont === 'auto') return null;
  return clean;
}

// ── Nieuwe blokken (de editor) ──────────────────────────────────────────────

export function uniqueBlockId(blocks: LayoutBlock[], base: string): string {
  const stem = base.replace(/[^A-Za-z0-9_-]+/g, '').slice(0, 18) || 'blok';
  const used = new Set(blocks.map(block => block.id));
  if (!used.has(stem)) return stem;
  for (let n = 2; ; n++) if (!used.has(`${stem}-${n}`)) return `${stem}-${n}`;
}

/** Een nieuw blok voor een veld, met de standaardmaat van dat veld. */
export function newFieldBlock(field: string, blocks: LayoutBlock[], at: { x: number; y: number }): LayoutBlock | null {
  const def = FIELD_INDEX[field];
  if (!def) return null;
  const block: LayoutBlock = {
    id: uniqueBlockId(blocks, field.split('.')[1] ?? field),
    type: 'field',
    field,
    x: at.x,
    y: at.y,
    w: def.defaults.w,
    h: def.defaults.h,
  };
  if (def.defaults.align) block.align = def.defaults.align;
  if (def.defaults.label) block.label = def.defaults.label;
  if (def.defaults.firstBold) block.firstBold = true;
  return clampBlock(block);
}

export function newShapeBlock(type: 'text' | 'logo' | 'line' | 'box', blocks: LayoutBlock[], at: { x: number; y: number }): LayoutBlock {
  const sizes = { text: { w: 260, h: 28 }, logo: { w: 200, h: 54 }, line: { w: 220, h: 6 }, box: { w: 220, h: 40 } }[type];
  const block: LayoutBlock = { id: uniqueBlockId(blocks, type === 'box' ? 'vlak' : type === 'line' ? 'lijn' : type === 'text' ? 'tekst' : 'logo'), type, x: at.x, y: at.y, w: sizes.w, h: sizes.h };
  if (type === 'text') block.text = 'Bedankt voor je opdracht, {{klant.contactpersoon|klant.naam}}!';
  if (type === 'line') { block.tone = 'accent'; block.weight = 0.8; }
  if (type === 'box') { block.tone = 'accent'; block.opacity = 0.12; }
  return clampBlock(block);
}

/** Houdt een blok binnen de pagina. */
export function clampBlock(block: LayoutBlock): LayoutBlock {
  const w = Math.max(8, Math.min(PAGE_WIDTH, block.w));
  const h = Math.max(4, Math.min(PAGE_HEIGHT, block.h));
  const x = Math.max(0, Math.min(PAGE_WIDTH - w, block.x));
  const y = Math.max(0, Math.min(PAGE_HEIGHT - h, block.y));
  const round = (n: number) => Math.round(n * 100) / 100;
  return { ...block, x: round(x), y: round(y), w: round(w), h: round(h) };
}

// ── Controle: staat erop wat erop moet? ─────────────────────────────────────

export interface LayoutIssue {
  id: string;
  message: string;
  /** Velden die het oplossen; de editor biedt ze aan als knop. */
  add: string[];
}

/**
 * Wat er volgens de wet op een factuur hoort (art. 35a Wet OB) en op elk
 * zakelijk stuk (KvK-nummer, Handelsregisterbesluit art. 42): mist een veld in
 * de opmaak, dan zeggen we dat, met de knop om het toe te voegen. Met eigen
 * briefpapier kan het daar al op staan; dat zegt de melding dan ook.
 */
export function layoutIssues(layout: DocumentLayout, kind: DocumentKind, options: { kor?: boolean; letterhead?: boolean } = {}): LayoutIssue[] {
  const fields = new Set(layout.blocks.filter(block => block.type === 'field').map(block => block.field));
  const has = (...keys: string[]) => keys.some(key => fields.has(key));
  const paper = options.letterhead ? ' Staat het al op je briefpapier, dan is het goed.' : '';
  const issues: LayoutIssue[] = [];
  const doc = kind === 'quote' ? 'offerte' : 'factuur';
  if (!has('document.nummer', 'document.gegevens')) {
    issues.push({ id: 'nummer', message: `Het ${doc}nummer staat er niet op.`, add: ['document.gegevens', 'document.nummer'] });
  }
  if (!has('document.datum', 'document.gegevens')) {
    issues.push({ id: 'datum', message: `De ${doc}datum staat er niet op.`, add: ['document.gegevens', 'document.datum'] });
  }
  if (!has('bedrijf.gegevens', 'bedrijf.adres')) {
    issues.push({ id: 'afzender', message: `Je naam en adres horen op de ${doc}.${paper}`, add: ['bedrijf.gegevens', 'bedrijf.adres'] });
  }
  if (!has('bedrijf.kvk', 'bedrijf.registratie')) {
    issues.push({ id: 'kvk', message: `Je KvK-nummer hoort op elke ${doc}.${paper}`, add: ['bedrijf.registratie', 'bedrijf.kvk'] });
  }
  if (kind === 'invoice' && !options.kor && !has('bedrijf.btw', 'bedrijf.registratie')) {
    issues.push({ id: 'btw', message: `Je btw-nummer hoort op de factuur.${paper}`, add: ['bedrijf.registratie', 'bedrijf.btw'] });
  }
  if (!has('klant.gegevens') && !(has('klant.naam') && (kind === 'quote' || has('klant.adres')))) {
    issues.push({
      id: 'klant',
      message: kind === 'invoice' ? 'De naam en het adres van je klant horen op de factuur.' : 'De naam van je klant staat er niet op.',
      add: ['klant.gegevens'],
    });
  }
  return issues;
}

// ── Voorbeeldgegevens (editor, tests) ───────────────────────────────────────

/**
 * Een voorbeelddocument met JOUW bedrijfsgegevens en een verzonnen klant. De
 * klant heeft bewust alles ingevuld (twee adresregels, land, btw-nummer): dan
 * zie je in de editor hoe groot een blok hooguit wordt.
 */
export function sampleDocumentData(kind: DocumentKind, company: CompanyRowLike | null | undefined): DocumentData {
  const named = {
    company_name: 'Jouw Bedrijf B.V.',
    address_line1: 'Voorbeeldstraat 1',
    postal_code: '1234 AB',
    city: 'Amsterdam',
    email: 'hallo@jouwbedrijf.nl',
    kvk_number: '12345678',
    vat_number: 'NL123456789B01',
    iban: 'NL00BANK0123456789',
    ...Object.fromEntries(Object.entries(company ?? {}).filter(([, value]) => str(value))),
  } as CompanyRowLike;
  const client: ClientRowLike = {
    name: 'Bakkerij De Korenaar',
    contact_name: 'Sanne de Vries',
    address_line1: 'Molenweg 12',
    address_line2: 'Unit 4',
    postal_code: '3511 AB',
    city: 'Utrecht',
    country: 'Nederland',
    vat_number: 'NL987654321B01',
    email: 'sanne@korenaar.nl',
    client_code: 'K-0107',
  };
  if (kind === 'credit_note') {
    return creditNoteDocument({
      number: 'CN-2026-0007',
      date: '2026-11-12',
      invoiceReference: 'FAC-2026-0042',
      invoiceDate: '2026-11-05',
      company: named,
      client,
      lines: [{ description: 'Gedeeltelijke terugbetaling factuur FAC-2026-0042 – fotografie dubbel gefactureerd', quantity: 1, unit_price: 380, vat: 21 }],
      subtotal: 380,
      vat: 79.8,
      total: 459.8,
      reason: 'De fotografie stond twee keer op de factuur.',
      refunded: true,
    });
  }
  if (kind === 'dunning') {
    return dunningDocument({
      company: named,
      client,
      letterDate: '2026-12-10',
      invoiceNumber: 'FAC-2026-0042',
      invoiceDate: '2026-11-05',
      invoiceDueDate: '2026-11-19',
      consumer: false,
      principalCents: 207040,
      interestCents: 1192,
      interestDays: 21,
      interestRatePct: '10,15',
      collectionCostsCents: 31056,
      collectionCostsVatCents: 0,
      totalClaimCents: 239288,
      deadlineDate: '2026-12-24',
      iban: str(named.iban),
      publicUrl: 'https://app.resofly.nl/invoice/voorbeeld',
    });
  }
  const lines: DocumentLine[] = [
    { description: 'Ontwerp en uitwerking huisstijl, inclusief twee correctierondes', quantity: 1, unitPrice: 1250, vatRate: 21, net: 1250, gross: 1512.5 },
    { description: 'Fotografie op locatie (halve dag)', quantity: 4, unitPrice: 95, vatRate: 21, net: 380, gross: 459.8 },
    { description: 'Drukwerk visitekaartjes', quantity: 250, unitPrice: 0.36, vatRate: 9, net: 90, gross: 98.1 },
  ];
  return buildDocumentData({
    kind,
    number: kind === 'quote' ? 'OFF-2026-0042' : 'FAC-2026-0042',
    date: '2026-11-05',
    secondDate: kind === 'quote' ? '2026-12-05' : '2026-11-19',
    company: named,
    client,
    lines,
    totals: {
      subtotal: 1720,
      vat: 350.4,
      total: 2070.4,
      vatBreakdown: [{ rate: 9, base: 90, vat: 8.1 }, { rate: 21, base: 1630, vat: 342.3 }],
    },
    notes: kind === 'quote' ? 'Planning in overleg; we starten binnen twee weken na akkoord.' : 'Graag het factuurnummer vermelden bij betaling.',
    projectName: 'Nieuwe huisstijl',
    quoteNumber: kind === 'invoice' ? 'OFF-2026-0038' : null,
    onlineLink: {
      label: kind === 'quote' ? 'Bekijk en keur deze offerte online goed:' : 'Bekijk en betaal deze factuur online:',
      url: 'https://app.resofly.nl/' + (kind === 'quote' ? 'quote' : 'invoice') + '/voorbeeld',
    },
  });
}

// ── Plannen: waar komt elk stukje tekst ─────────────────────────────────────

export type FontRef = 'body' | 'bodyBold' | 'heading' | 'headingBold';
/** Breedte van een tekst in punten. */
export type Measure = (text: string, size: number, font: FontRef) => number;

export type PlanOp =
  | { t: 'text'; x: number; y: number; text: string; size: number; font: FontRef; color: string }
  | { t: 'rect'; x: number; y: number; w: number; h: number; color: string; opacity: number }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; width: number; color: string; opacity: number }
  | { t: 'image'; x: number; y: number; w: number; h: number };

export interface PlanBox { x: number; y: number; w: number; h: number }

export interface PlanPage {
  /** Alles op deze pagina; `y` van tekst is de basislijn, gemeten vanaf boven. */
  ops: PlanOp[];
  /** Waar elk vrij blok werkelijk staat (na meegroeien en opschuiven). */
  boxes: Record<string, PlanBox>;
  /** Waar elk onderdeel van de inhoud staat. */
  flow: Array<{ key: LayoutFlowKey; box: PlanBox }>;
  flowTop: number;
  flowBottom: number;
}

export interface DocumentPlan {
  pages: PlanPage[];
}

/**
 * Waar de basislijn ligt, als deel van de lettergrootte. De standaardletters
 * zoals pdf-lib ze meet; een ingesloten letter meet de tekenmodule zelf
 * (`documentFontTools`). Poppins en Playfair rekenen met een ruime bovenkant
 * (1,05); begrensd op 0,82 zodat een regel van 1,3 × de grootte niet in de
 * volgende regel loopt.
 */
const STANDARD_ASCENT: Record<string, number> = { helvetica: 0.718, times: 0.683, courier: 0.629 };
const ASCENT_RANGE = { min: 0.68, max: 0.82 };

/** Meten en opschonen van tekst; de PDF en de editor gebruiken dezelfde. */
export interface TextTools {
  measure: Measure;
  /** Tekst die deze letter kan tekenen (een ingesloten letter mist bijv. Š). */
  clean(text: string, font: FontRef): string;
  /** Basislijn als deel van de lettergrootte. */
  ascent(font: FontRef): number;
}
const FLOW_GAP = 16;

function lineHeight(size: number): number {
  return Math.round(size * 1.3 * 100) / 100;
}

type FieldValue =
  | { shape: 'text'; text: string }
  | { shape: 'lines'; lines: string[] }
  | { shape: 'rows'; rows: Array<{ label: string; value: string }> };

interface PlanContext extends TextTools {
  data: DocumentData;
  style: DocumentStyle;
  page: number;
  pages: number;
  /** Blok dat de juridische naam bovenaan zijn adres krijgt (zie `planDocument`). */
  legalNameBlock: string | null;
}

function fieldValue(key: string, ctx: PlanContext, blockId: string): FieldValue {
  const { data } = ctx;
  const kind = data.kind;
  const company = data.company;
  const client = data.client;
  const legal = ctx.legalNameBlock === blockId && company.legalName ? [company.legalName] : [];
  const contact = [company.email, company.phone, company.website].filter(Boolean);
  switch (key) {
    case 'bedrijf.naam': return { shape: 'text', text: company.displayName };
    case 'bedrijf.gegevens': return { shape: 'lines', lines: [...legal, ...company.addressLines, ...contact] };
    case 'bedrijf.adres': return { shape: 'lines', lines: [...legal, ...company.addressLines] };
    case 'bedrijf.contact': return { shape: 'lines', lines: contact };
    case 'bedrijf.email': return { shape: 'text', text: company.email };
    case 'bedrijf.telefoon': return { shape: 'text', text: company.phone };
    case 'bedrijf.website': return { shape: 'text', text: company.website };
    case 'bedrijf.kvk': return { shape: 'text', text: company.kvk };
    case 'bedrijf.btw': return { shape: 'text', text: company.vat };
    case 'bedrijf.iban': return { shape: 'text', text: company.iban };
    case 'bedrijf.registratie': return {
      shape: 'rows',
      rows: [
        { label: 'KvK', value: company.kvk },
        { label: 'Btw-nummer', value: company.vat },
        { label: 'IBAN', value: company.iban },
      ].filter(row => row.value),
    };
    case 'klant.gegevens': return {
      shape: 'lines',
      lines: client
        ? [
          client.name,
          client.contactName ? `T.a.v. ${client.contactName}` : '',
          ...client.addressLines,
          client.vat ? `Btw-nummer: ${client.vat}` : '',
          client.email,
        ].filter(Boolean)
        : ['Geen klant gekozen'],
    };
    case 'klant.naam': return { shape: 'text', text: client?.name ?? '' };
    case 'klant.contactpersoon': return { shape: 'text', text: client?.contactName ?? '' };
    case 'klant.adres': return { shape: 'lines', lines: client?.addressLines ?? [] };
    case 'klant.btw': return { shape: 'text', text: client?.vat ?? '' };
    case 'klant.kvk': return { shape: 'text', text: client?.kvk ?? '' };
    case 'klant.email': return { shape: 'text', text: client?.email ?? '' };
    case 'klant.nummer': return { shape: 'text', text: client?.code ?? '' };
    case 'document.titel': return { shape: 'text', text: documentTitle(kind) };
    case 'document.nummer': return { shape: 'text', text: data.number };
    case 'document.datum': return { shape: 'text', text: data.date ? formatDocDate(data.date) : '' };
    case 'document.vervaldatum': return { shape: 'text', text: data.secondDate ? formatDocDate(data.secondDate) : '' };
    case 'document.project': return { shape: 'text', text: data.projectName };
    case 'document.offerte': return { shape: 'text', text: kind === 'invoice' ? data.quoteNumber : '' };
    case 'document.gegevens': return data.metaRows ? { shape: 'rows', rows: data.metaRows } : {
      shape: 'rows',
      rows: [
        { label: fieldCaption('document.nummer', kind), value: data.number },
        { label: fieldCaption('document.datum', kind), value: data.date ? formatDocDate(data.date) : '' },
        { label: fieldCaption('document.vervaldatum', kind), value: data.secondDate ? formatDocDate(data.secondDate) : '' },
        { label: 'Project', value: data.projectName },
        { label: 'Offerte', value: kind === 'invoice' ? data.quoteNumber : '' },
        { label: 'Klantnummer', value: client?.code ?? '' },
      ].filter(row => row.value),
    };
    case 'document.totaal': return { shape: 'text', text: formatDocMoney(data.totals.total) };
    case 'document.betaalinstructie': return { shape: 'text', text: company.paymentTerms };
    case 'document.voettekst': return { shape: 'text', text: company.footer };
    case 'document.pagina': return { shape: 'text', text: `Pagina ${ctx.page} van ${ctx.pages}` };
    default: return { shape: 'text', text: '' };
  }
}

function valueAsText(value: FieldValue): string {
  if (value.shape === 'text') return value.text;
  if (value.shape === 'lines') return value.lines.join(', ');
  return value.rows.map(row => `${row.label} ${row.value}`).join(', ');
}

/** {{klant.naam}} en {{klant.contactpersoon|klant.naam}} (terugval op een ander veld of letterlijke tekst). */
function fillTokens(text: string, ctx: PlanContext): string {
  return text.replace(/\{\{\s*([a-z_.]+)\s*(?:\|([^}]*))?\}\}/gi, (_match, rawKey: string, fallback?: string) => {
    const key = TOKEN_ALIASES[rawKey.toLowerCase()] ?? rawKey.toLowerCase();
    const value = FIELD_INDEX[key] ? valueAsText(fieldValue(key, ctx, '')) : '';
    if (value) return value;
    const alt = str(fallback);
    if (!alt) return '';
    const altKey = TOKEN_ALIASES[alt.toLowerCase()] ?? alt.toLowerCase();
    return FIELD_INDEX[altKey] ? valueAsText(fieldValue(altKey, ctx, '')) : alt;
  });
}

/** Alle velden die je in een tekst kunt gebruiken, als {{sleutel}}. */
export function tokenList(kind: DocumentKind): Array<{ token: string; name: string }> {
  return fieldsFor(kind)
    .filter(field => field.key !== 'document.pagina')
    .map(field => ({ token: `{{${field.key}}}`, name: field.name }));
}

function splitWord(word: string, size: number, font: FontRef, maxWidth: number, measure: Measure): string[] {
  const pieces: string[] = [];
  let current = '';
  for (const char of word) {
    const candidate = current + char;
    if (current && measure(candidate, size, font) > maxWidth) {
      pieces.push(current);
      current = char;
    } else current = candidate;
  }
  if (current) pieces.push(current);
  return pieces;
}

/** Breekt tekst af op de breedte; een lege regel blijft een witregel. */
function wrapText(text: string, size: number, font: FontRef, maxWidth: number, tools: TextTools): string[] {
  const out: string[] = [];
  const measure = tools.measure;
  for (const paragraph of tools.clean(text, font).split('\n')) {
    const clean = paragraph.replace(/ {2,}/g, ' ').trim();
    if (!clean) { out.push(''); continue; }
    let current = '';
    for (const word of clean.split(' ')) {
      const pieces = measure(word, size, font) > maxWidth ? splitWord(word, size, font, maxWidth, measure) : [word];
      for (const piece of pieces) {
        const candidate = current ? `${current} ${piece}` : piece;
        if (!current || measure(candidate, size, font) <= maxWidth) current = candidate;
        else { out.push(current); current = piece; }
      }
    }
    if (current) out.push(current);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  while (out.length > 0 && out[0] === '') out.shift();
  return out;
}

function toneColor(tone: LayoutTone | undefined, style: DocumentStyle, fallback: LayoutTone = 'text'): string {
  const value = tone ?? fallback;
  return value === 'muted' ? style.muted : value === 'accent' ? style.accentInk : style.ink;
}

function fillColor(tone: LayoutTone | undefined, style: DocumentStyle): string {
  const value = tone ?? 'accent';
  return value === 'muted' ? style.muted : value === 'accent' ? style.accent : style.ink;
}

/** Een tekstregel; `top` is de bovenkant van de regel. */
function textOp(text: string, x: number, top: number, w: number, size: number, font: FontRef, color: string, align: LayoutAlign, ctx: PlanContext): PlanOp | null {
  if (!text) return null;
  const width = ctx.measure(text, size, font);
  const left = align === 'right' ? x + w - width : align === 'center' ? x + (w - width) / 2 : x;
  return { t: 'text', x: round2(left), y: round2(top + ctx.ascent(font) * size), text, size, font, color };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface RenderedBlock { ops: PlanOp[]; height: number }

/** Het kopje boven een veld: klein, in kapitalen, met een lijntje in de merkkleur. */
function captionOps(caption: string, x: number, y: number, w: number, size: number, align: LayoutAlign, ctx: PlanContext): RenderedBlock {
  const capSize = Math.max(6, size - 2);
  const ops: PlanOp[] = [];
  const op = textOp(ctx.clean(caption, 'bodyBold').toUpperCase(), x, y, w, capSize, 'bodyBold', ctx.style.muted, align, ctx);
  if (op) ops.push(op);
  const ruleY = round2(y + lineHeight(capSize) + 1.5);
  const ruleW = Math.min(w, 180);
  const ruleX = align === 'right' ? x + w - ruleW : align === 'center' ? x + (w - ruleW) / 2 : x;
  ops.push({ t: 'line', x1: round2(ruleX), y1: ruleY, x2: round2(ruleX + ruleW), y2: ruleY, width: 0.6, color: ctx.style.accent, opacity: 1 });
  return { ops, height: lineHeight(capSize) + 8 };
}

function blockSize(block: LayoutBlock, def: DocumentFieldDefinition | null, ctx: PlanContext, fallbackDelta = 0): number {
  if (block.size) return block.size;
  return Math.max(LAYOUT_LIMITS.size.min, ctx.style.baseSize + (def ? def.defaults.size : fallbackDelta));
}

function renderFieldBlock(block: LayoutBlock, ctx: PlanContext): RenderedBlock {
  const def = FIELD_INDEX[block.field ?? ''];
  if (!def) return { ops: [], height: block.h };
  const value = fieldValue(def.key, ctx, block.id);
  const size = blockSize(block, def, ctx);
  const lh = lineHeight(size);
  const bold = block.bold ?? def.defaults.bold ?? false;
  const font: FontRef = def.heading ? (bold ? 'headingBold' : 'heading') : bold ? 'bodyBold' : 'body';
  const color = toneColor(block.tone ?? def.defaults.tone, ctx.style);
  const align = block.align ?? def.defaults.align ?? 'left';
  const caption = block.caption ?? fieldCaption(def.key, ctx.data.kind);
  const labelMode = block.label ?? def.defaults.label ?? 'none';
  const ops: PlanOp[] = [];
  let y = block.y;

  const empty = value.shape === 'text' ? !value.text : value.shape === 'lines' ? value.lines.length === 0 : value.rows.length === 0;
  if (empty) return { ops, height: block.h };

  if (labelMode === 'above') {
    const head = captionOps(caption, block.x, y, block.w, size, align, ctx);
    ops.push(...head.ops);
    y += head.height;
  }

  const pushLines = (lines: string[], lineFont: (index: number) => FontRef, lineColor: string) => {
    lines.forEach((line, index) => {
      const op = textOp(line, block.x, y, block.w, size, lineFont(index), lineColor, align, ctx);
      if (op) ops.push(op);
      y += lh;
    });
  };

  if (value.shape === 'text') {
    const prefix = labelMode === 'inline' ? (/[.:]$/.test(caption) ? `${caption} ` : `${caption}: `) : '';
    pushLines(wrapText(prefix + value.text, size, font, block.w, ctx), () => font, color);
  } else if (value.shape === 'lines') {
    if (block.inline) {
      pushLines(wrapText(value.lines.join(' · '), size, font, block.w, ctx), () => font, color);
    } else {
      const firstBold = block.firstBold ?? def.defaults.firstBold ?? false;
      value.lines.forEach((line, index) => {
        const lineFont: FontRef = index === 0 && firstBold ? (def.heading ? 'headingBold' : 'bodyBold') : font;
        const lineColor = index === 0 && firstBold ? ctx.style.ink : color;
        pushLines(wrapText(line, size, lineFont, block.w, ctx), () => lineFont, lineColor);
      });
    }
  } else if (block.inline) {
    pushLines(wrapText(value.rows.map(row => `${row.label} ${row.value}`).join(' · '), size, font, block.w, ctx), () => font, color);
  } else {
    // Twee kolommen: het label gedempt links, de waarde ernaast of tegen de rechterkant.
    const labelWidth = Math.min(block.w * 0.55, Math.max(...value.rows.map(row => ctx.measure(ctx.clean(row.label, 'body'), size, 'body'))) + 10);
    for (const row of value.rows) {
      const label = textOp(ctx.clean(row.label, 'body'), block.x, y, labelWidth, size, 'body', ctx.style.muted, 'left', ctx);
      if (label) ops.push(label);
      const valueLines = wrapText(row.value, size, font, Math.max(20, block.w - labelWidth), ctx);
      valueLines.forEach((line, index) => {
        const op = textOp(line, block.x + labelWidth, y + index * lh, block.w - labelWidth, size, font, color, align === 'right' ? 'right' : 'left', ctx);
        if (op) ops.push(op);
      });
      y += Math.max(1, valueLines.length) * lh;
    }
  }
  return { ops, height: Math.max(block.h, y - block.y) };
}

function renderBlock(block: LayoutBlock, ctx: PlanContext, logo: { width: number; height: number } | null): RenderedBlock {
  const { style } = ctx;
  if (block.type === 'box') {
    return { ops: [{ t: 'rect', x: block.x, y: block.y, w: block.w, h: block.h, color: fillColor(block.tone, style), opacity: block.opacity ?? 0.12 }], height: block.h };
  }
  if (block.type === 'line') {
    const y = round2(block.y + block.h / 2);
    return { ops: [{ t: 'line', x1: block.x, y1: y, x2: round2(block.x + block.w), y2: y, width: block.weight ?? 0.8, color: fillColor(block.tone, style), opacity: 1 }], height: block.h };
  }
  if (block.type === 'logo') {
    if (logo && logo.width > 0 && logo.height > 0) {
      const scale = Math.min(block.w / logo.width, block.h / logo.height);
      const w = round2(logo.width * scale);
      const h = round2(logo.height * scale);
      const align = block.align ?? 'left';
      const x = align === 'right' ? block.x + block.w - w : align === 'center' ? block.x + (block.w - w) / 2 : block.x;
      return { ops: [{ t: 'image', x: round2(x), y: block.y, w, h }], height: block.h };
    }
    // Zonder logo de naam, in het koplettertype: zo staat er altijd een afzender bovenaan.
    const size = block.size ?? Math.max(LAYOUT_LIMITS.size.min, Math.min(style.baseSize + 8, block.h * 0.62));
    const lines = wrapText(ctx.data.company.displayName || ctx.data.company.legalName, size, 'headingBold', block.w, ctx);
    const ops: PlanOp[] = [];
    lines.forEach((line, index) => {
      const op = textOp(line, block.x, block.y + index * lineHeight(size), block.w, size, 'headingBold', toneColor(block.tone, style), block.align ?? 'left', ctx);
      if (op) ops.push(op);
    });
    return { ops, height: Math.max(block.h, lines.length * lineHeight(size)) };
  }
  if (block.type === 'text') {
    const size = blockSize(block, null, ctx, 0);
    const font: FontRef = block.bold ? 'bodyBold' : 'body';
    const lines = wrapText(fillTokens(block.text ?? '', ctx), size, font, block.w, ctx);
    const ops: PlanOp[] = [];
    lines.forEach((line, index) => {
      const op = textOp(line, block.x, block.y + index * lineHeight(size), block.w, size, font, toneColor(block.tone, style), block.align ?? 'left', ctx);
      if (op) ops.push(op);
    });
    return { ops, height: Math.max(block.h, lines.length * lineHeight(size)) };
  }
  return renderFieldBlock(block, ctx);
}

/**
 * Tekent een groep vrije blokken. Groeit een blok door zijn inhoud (een lang
 * klantadres), dan schuift een blok eronder mee in plaats van eroverheen te
 * vallen — maar alleen als die twee in het ontwerp niet al over elkaar lagen.
 */
function placeBlocks(blocks: LayoutBlock[], ctx: PlanContext, logo: { width: number; height: number } | null, page: PlanPage, clipBottom: number, pushLimit: number): number {
  const sorted = [...blocks].sort((a, b) => a.y - b.y || a.x - b.x);
  const placed: Array<{ x: number; w: number; designBottom: number; bottom: number }> = [];
  // Alleen blokken die boven `pushLimit` beginnen tellen mee voor hoe ver de
  // inhoud omlaag moet; een vlak dat bewust in het inhoudsgebied staat niet.
  let lowest = 0;
  for (const block of sorted) {
    let shift = 0;
    for (const prev of placed) {
      const overlapX = prev.x < block.x + block.w - 0.5 && block.x < prev.x + prev.w - 0.5;
      if (!overlapX || prev.designBottom > block.y + 1) continue;
      const gap = Math.max(0, Math.min(8, block.y - prev.designBottom));
      shift = Math.max(shift, prev.bottom + gap - block.y);
    }
    const moved = shift > 0 ? { ...block, y: round2(block.y + shift) } : block;
    const rendered = renderBlock(moved, ctx, logo);
    for (const op of rendered.ops) {
      if (op.t === 'text' && op.y > clipBottom) continue;
      page.ops.push(op);
    }
    page.boxes[block.id] = { x: moved.x, y: moved.y, w: moved.w, h: round2(rendered.height) };
    placed.push({ x: block.x, w: block.w, designBottom: block.y + block.h + shift, bottom: moved.y + rendered.height });
    if (block.y < pushLimit) lowest = Math.max(lowest, moved.y + rendered.height);
  }
  return lowest;
}

/**
 * Rekent het hele document uit: welke tekst, lijn en vlak op welke pagina. De
 * editor tekent dit plan als SVG, `renderDocumentPdf` als PDF — daarom ziet de
 * editor er precies zo uit als de PDF.
 */
export function planDocument(
  layout: DocumentLayout,
  data: DocumentData,
  style: DocumentStyle,
  env: { measure: Measure; logo: { width: number; height: number } | null; ascent?: (font: FontRef) => number; clean?: (text: string, font: FontRef) => string },
): DocumentPlan {
  const measure = env.measure;
  const standardAscent = (font: FontRef) => STANDARD_ASCENT[font === 'heading' || font === 'headingBold' ? style.headingFont : style.bodyFont] ?? 0.72;
  const base = style.baseSize;
  const flowX = layout.marginX;
  const flowW = PAGE_WIDTH - layout.marginX * 2;
  const flowBottom = layout.footerTop - 10;
  const footerBlocks = layout.blocks.filter(block => block.y >= layout.footerTop);
  const headerBlocks = layout.blocks.filter(block => block.y < layout.footerTop);

  // De juridische naam hoort op de factuur. Staat hij al in beeld (als
  // bedrijfsnaam of als naam in plaats van het logo) en is hij gelijk aan de
  // merknaam, dan niet nog eens boven het adres.
  const hasNameField = layout.blocks.some(block => block.type === 'field' && block.field === 'bedrijf.naam');
  const hasNameAsLogo = !env.logo && layout.blocks.some(block => block.type === 'logo');
  const nameVisible = hasNameField || hasNameAsLogo;
  const legalBlock = layout.blocks.find(block => block.type === 'field' && (block.field === 'bedrijf.gegevens' || block.field === 'bedrijf.adres'));
  const needsLegal = Boolean(data.company.legalName) && !(nameVisible && data.company.displayName === data.company.legalName);
  const ctx: PlanContext = {
    data,
    style,
    measure,
    clean: env.clean ?? ((text: string) => pdfSafeText(text)),
    ascent: env.ascent ?? standardAscent,
    page: 1,
    pages: 1,
    legalNameBlock: needsLegal && legalBlock ? legalBlock.id : null,
  };

  const pages: PlanPage[] = [];
  let page!: PlanPage;
  let y = 0;

  const startPage = () => {
    page = { ops: [], boxes: {}, flow: [], flowTop: 0, flowBottom };
    pages.push(page);
    ctx.page = pages.length;
    if (pages.length === 1 || layout.repeatHeader) {
      const lowest = placeBlocks(headerBlocks, ctx, env.logo, page, flowBottom, layout.bodyTop);
      // Groeit een kopblok tot in de inhoud (een lang klantadres), dan begint
      // de inhoud lager; er blijft altijd ruimte voor een paar regels over.
      const pushed = lowest > 0 ? lowest + 10 : 0;
      page.flowTop = Math.max(layout.bodyTop, Math.min(pushed, flowBottom - 60));
    } else {
      const size = Math.max(6, base - 1);
      const label = `${data.kind === 'quote' ? 'Offerte' : 'Factuur'} ${data.number} (vervolg)`;
      const top = Math.max(16, layout.continueTop - 26);
      const left = textOp(ctx.clean(label, 'bodyBold'), flowX, top, flowW / 2, size, 'bodyBold', style.muted, 'left', ctx);
      if (left) page.ops.push(left);
      const right = textOp(ctx.clean(data.company.displayName, 'body'), flowX + flowW / 2, top, flowW / 2, size, 'body', style.muted, 'right', ctx);
      if (right) page.ops.push(right);
      const lineY = round2(top + lineHeight(size) + 2);
      page.ops.push({ t: 'line', x1: flowX, y1: lineY, x2: flowX + flowW, y2: lineY, width: 0.4, color: style.muted, opacity: 0.5 });
      page.flowTop = layout.continueTop;
    }
    y = page.flowTop;
  };

  const markFlow = (key: LayoutFlowKey, top: number, bottom: number) => {
    page.flow.push({ key, box: { x: flowX, y: round2(top), w: flowW, h: round2(Math.max(0, bottom - top)) } });
  };

  /** Tekstregels onder elkaar, met een nieuwe pagina als het niet meer past. */
  const flowLines = (key: LayoutFlowKey | null, lines: string[], size: number, font: FontRef, color: string, options: { caption?: string; width?: number; keep?: number } = {}) => {
    if (lines.length === 0) return;
    const lh = lineHeight(size);
    const width = Math.min(flowW, options.width ?? flowW);
    const capHeight = options.caption ? lineHeight(Math.max(6, size - 2)) + 8 : 0;
    const keep = Math.min(lines.length, options.keep ?? 2);
    if (y + capHeight + keep * lh > flowBottom) startPage();
    let top = y;
    if (options.caption) {
      const head = captionOps(options.caption, flowX, y, width, size, 'left', ctx);
      page.ops.push(...head.ops);
      y += head.height;
    }
    for (const line of lines) {
      if (y + lh > flowBottom) {
        if (key) markFlow(key, top, y);
        startPage();
        top = y;
      }
      const op = textOp(line, flowX, y, width, size, font, color, 'left', ctx);
      if (op) page.ops.push(op);
      y += lh;
    }
    if (key) markFlow(key, top, y);
  };

  const planLines = () => {
    const size = Math.max(6, base - 1);
    const lh = lineHeight(size);
    const headSize = Math.max(6, base - 2);
    const headHeight = Math.max(20, lineHeight(headSize) + 9);
    const pad = 6;
    const right = flowX + flowW - pad;
    const columns: Array<{ key: 'quantity' | 'unitPrice' | 'vatRate' | 'total'; label: string; right: number }> = [];
    let edge = right;
    const add = (key: 'quantity' | 'unitPrice' | 'vatRate' | 'total', label: string, width: number) => {
      columns.unshift({ key, label, right: edge });
      edge -= width;
    };
    add('total', layout.table.lineTotals === 'excl' ? 'Excl. btw' : 'Totaal', 84);
    if (layout.table.vatRate) add('vatRate', 'Btw', 44);
    if (layout.table.unitPrice) add('unitPrice', 'Prijs', 78);
    if (layout.table.quantity) add('quantity', 'Aantal', 50);
    const descX = flowX + pad;
    const descW = Math.max(60, edge - descX - 8);
    let top = y;

    const header = () => {
      const headTop = y;
      if (layout.table.style === 'tinted') {
        page.ops.push({ t: 'rect', x: flowX, y: headTop, w: flowW, h: headHeight, color: style.accent, opacity: 0.16 });
      }
      const labelTop = headTop + (headHeight - lineHeight(headSize)) / 2 + 0.5;
      const desc = textOp('Omschrijving', descX, labelTop, descW, headSize, 'bodyBold', style.muted, 'left', ctx);
      if (desc) page.ops.push(desc);
      for (const column of columns) {
        const op = textOp(column.label, column.right - 80, labelTop, 80, headSize, 'bodyBold', style.muted, 'right', ctx);
        if (op) page.ops.push(op);
      }
      const ruleY = round2(headTop + headHeight);
      if (layout.table.style === 'lines') page.ops.push({ t: 'line', x1: flowX, y1: ruleY, x2: flowX + flowW, y2: ruleY, width: 0.8, color: style.accent, opacity: 1 });
      if (layout.table.style === 'plain') page.ops.push({ t: 'line', x1: flowX, y1: ruleY, x2: flowX + flowW, y2: ruleY, width: 0.5, color: style.muted, opacity: 0.6 });
      y = headTop + headHeight + 6;
    };

    if (y + headHeight + lh + 14 > flowBottom) startPage();
    top = y;
    header();
    const amountFor = (line: DocumentLine, key: 'quantity' | 'unitPrice' | 'vatRate' | 'total'): string => {
      if (key === 'quantity') return formatQuantity(line.quantity);
      if (key === 'unitPrice') return formatDocMoney(line.unitPrice);
      if (key === 'vatRate') return formatRate(line.vatRate);
      return formatDocMoney(layout.table.lineTotals === 'excl' ? line.net : line.gross);
    };

    const nextTop = layout.repeatHeader ? layout.bodyTop : layout.continueTop;
    const fullPage = Math.floor((flowBottom - nextTop - headHeight - 14) / lh);
    data.lines.forEach((line, rowIndex) => {
      let remaining = wrapText(line.description || '-', size, 'body', descW, ctx);
      if (remaining.length === 0) remaining = ['-'];
      let first = true;
      let fresh = false;
      while (remaining.length > 0) {
        const room = Math.floor((flowBottom - y - 4) / lh);
        // Past de regel niet meer, maar op een nieuwe pagina wel in één keer?
        // Dan liever helemaal naar de volgende pagina dan halverwege breken.
        // Op een verse pagina nooit nog eens: dan gaat er minstens één regel op.
        if (!fresh && (room < 1 || (first && remaining.length > room && remaining.length <= fullPage))) {
          markFlow('lines', top, y);
          startPage();
          top = y;
          header();
          fresh = true;
          continue;
        }
        fresh = false;
        const chunk = remaining.slice(0, Math.max(1, room));
        remaining = remaining.slice(chunk.length);
        if (rowIndex > 0 && first && layout.table.style !== 'plain') {
          const sepY = round2(y - 4);
          page.ops.push({ t: 'line', x1: flowX, y1: sepY, x2: flowX + flowW, y2: sepY, width: 0.35, color: style.muted, opacity: 0.35 });
        }
        chunk.forEach((text, index) => {
          const op = textOp(text, descX, y + index * lh, descW, size, 'body', style.ink, 'left', ctx);
          if (op) page.ops.push(op);
        });
        if (first) {
          for (const column of columns) {
            const op = textOp(amountFor(line, column.key), column.right - 120, y, 120, size, column.key === 'total' ? 'bodyBold' : 'body', style.ink, 'right', ctx);
            if (op) page.ops.push(op);
          }
        }
        y += chunk.length * lh + 8;
        first = false;
      }
    });
    markFlow('lines', top, y);
  };

  const planTotals = () => {
    const size = Math.max(6, base - 1);
    const rowHeight = Math.round(size * 1.6 * 100) / 100;
    const totalSize = base + 3;
    const totalHeight = Math.round(totalSize * 1.9 * 100) / 100;
    const width = Math.min(240, flowW);
    const x = flowX + flowW - width;
    const rows: Array<[string, string]> = [['Subtotaal', formatDocMoney(data.totals.subtotal)]];
    if (data.totals.vatBreakdown.length > 0) {
      // Per tarief de grondslag én het btw-bedrag (art. 35a lid 1 Wet OB).
      for (const row of data.totals.vatBreakdown) rows.push([`Btw ${formatRate(row.rate)} over ${formatDocMoney(row.base)}`, formatDocMoney(row.vat)]);
    } else rows.push(['Btw', formatDocMoney(data.totals.vat)]);
    const height = rows.length * rowHeight + 8 + totalHeight;
    if (y + height > flowBottom) startPage();
    const top = y;
    for (const [label, value] of rows) {
      const left = textOp(label, x, y, width - 90, size, 'body', style.ink, 'left', ctx);
      if (left) page.ops.push(left);
      const amount = textOp(value, x, y, width, size, 'body', style.ink, 'right', ctx);
      if (amount) page.ops.push(amount);
      y += rowHeight;
    }
    y += 4;
    const filled = layout.totalsStyle === 'filled';
    if (filled) page.ops.push({ t: 'rect', x: x - 10, y, w: width + 10, h: totalHeight, color: style.accent, opacity: 1 });
    else page.ops.push({ t: 'line', x1: x, y1: round2(y + 1), x2: x + width, y2: round2(y + 1), width: 0.9, color: style.accent, opacity: 1 });
    const textTop = y + (totalHeight - lineHeight(totalSize)) / 2 + 1;
    const color = filled ? style.onAccent : style.ink;
    const pad = filled ? 8 : 0;
    const label = textOp(ctx.clean(data.totalsLabel || 'Totaal', 'bodyBold'), x, textTop, width - 90, totalSize, 'bodyBold', color, 'left', ctx);
    if (label) page.ops.push(label);
    const amount = textOp(formatDocMoney(data.totals.total), x, textTop, width - pad, totalSize, 'bodyBold', color, 'right', ctx);
    if (amount) page.ops.push(amount);
    y += totalHeight;
    markFlow('totals', top, y);
  };

  /** Een brief in plaats van regels en totalen (de aanmaning). */
  const planBody = (parts: DocumentBodyPart[]) => {
    for (const part of parts) {
      if (part.type === 'gap') {
        y += Math.max(0, Math.min(60, part.size));
        continue;
      }
      if (part.type === 'paragraph') {
        const font: FontRef = part.bold ? 'bodyBold' : 'body';
        flowLines(null, wrapText(part.text, base, font, flowW, ctx), base, font, part.tone === 'muted' ? style.muted : style.ink, { keep: 2 });
        y += Math.round(base * 0.6);
        continue;
      }
      // Een rij bedragen: label links, bedrag rechts, en bij elkaar op één pagina.
      const size = base;
      const rowHeight = Math.round(size * 1.55 * 100) / 100;
      const capHeight = part.caption ? lineHeight(Math.max(6, size - 2)) + 8 : 0;
      if (y + capHeight + part.rows.length * rowHeight > flowBottom) startPage();
      if (part.caption) {
        const head = captionOps(part.caption, flowX, y, flowW, size, 'left', ctx);
        page.ops.push(...head.ops);
        y += head.height;
      }
      for (const row of part.rows) {
        const font: FontRef = row.bold ? 'bodyBold' : 'body';
        const label = textOp(ctx.clean(row.label, font), flowX, y, flowW - 130, size, font, row.bold ? style.ink : style.muted, 'left', ctx);
        if (label) page.ops.push(label);
        const value = textOp(ctx.clean(row.value, font), flowX, y, flowW, size, font, style.ink, 'right', ctx);
        if (value) page.ops.push(value);
        y += rowHeight;
      }
      y += Math.round(base * 0.8);
    }
  };

  startPage();
  if (data.body) planBody(data.body);
  let first = true;
  for (const item of data.body ? [] : layout.flow) {
    // Een creditfactuur zegt altijd wat er met het bedrag gebeurt, ook als de
    // betaalregel op de factuur uit staat. Een eigen inleiding of afsluiting is
    // voor de factuur geschreven ("hierbij ontvang je onze factuur"): niet op
    // een creditfactuur.
    const forced = item.key === 'payment' && Boolean(data.paymentLines?.length);
    if (!item.show && !forced) continue;
    if ((item.key === 'intro' || item.key === 'closing') && data.kind === 'credit_note') continue;
    const before = y;
    const gap = first ? 0 : FLOW_GAP;
    const at = y + gap;
    const pageBefore = pages.length;
    y = at;
    switch (item.key) {
      case 'lines': planLines(); break;
      case 'totals': planTotals(); break;
      case 'vat_notes': flowLines('vat_notes', data.vatNotes.flatMap(note => wrapText(note, Math.max(6, base - 2), 'body', flowW, ctx)), Math.max(6, base - 2), 'body', style.muted); break;
      case 'payment': {
        const size = Math.max(6, base - 1);
        const lines = data.paymentLines
          ? data.paymentLines.flatMap(line => wrapText(line, size, 'body', flowW * 0.7, ctx))
          : [
            ...(data.company.paymentTerms ? wrapText(data.company.paymentTerms, size, 'body', flowW * 0.7, ctx) : []),
            ...(data.company.iban ? wrapText(`IBAN ${data.company.iban}${data.company.legalName ? ` t.n.v. ${data.company.legalName}` : ''}`, size, 'body', flowW * 0.7, ctx) : []),
          ];
        flowLines('payment', lines, size, 'body', style.ink, { caption: 'Betaling', width: flowW * 0.7 });
        break;
      }
      case 'notes': {
        const size = Math.max(6, base - 1);
        flowLines('notes', data.notes ? wrapText(data.notes, size, 'body', flowW * 0.75, ctx) : [], size, 'body', style.muted, { caption: data.notesCaption || 'Notities', width: flowW * 0.75 });
        break;
      }
      case 'online_link': {
        if (!data.onlineLink) break;
        const size = Math.max(6, base - 2);
        const lines = wrapText(data.onlineLink.url, size, 'body', flowW, ctx);
        const labelLines = wrapText(data.onlineLink.label, size, 'bodyBold', flowW, ctx);
        const lh = lineHeight(size);
        if (y + (labelLines.length + lines.length) * lh > flowBottom) startPage();
        const top = y;
        for (const line of labelLines) {
          const op = textOp(line, flowX, y, flowW, size, 'bodyBold', style.muted, 'left', ctx);
          if (op) page.ops.push(op);
          y += lh;
        }
        for (const line of lines) {
          const op = textOp(line, flowX, y, flowW, size, 'body', style.muted, 'left', ctx);
          if (op) page.ops.push(op);
          y += lh;
        }
        markFlow('online_link', top, y);
        break;
      }
      case 'intro':
      case 'closing': {
        const text = fillTokens(item.text ?? '', ctx);
        flowLines(item.key, wrapText(text, base, 'body', flowW, ctx), base, 'body', style.ink, { keep: 1 });
        break;
      }
    }
    // Leverde dit onderdeel niets op (geen notitie, geen link), dan ook geen witruimte.
    if (pages.length === pageBefore && y === at) y = before;
    else first = false;
  }

  // De voet, nu het aantal pagina's vaststaat (voor "Pagina 1 van 2").
  pages.forEach((current, index) => {
    ctx.page = index + 1;
    ctx.pages = pages.length;
    page = current;
    placeBlocks(footerBlocks, ctx, env.logo, current, PAGE_HEIGHT - 4, 0);
  });
  return { pages };
}

// ── PDF ─────────────────────────────────────────────────────────────────────
//
// Hoe pdf-lib heet in de app (npm) en in de edge functions (esm.sh) maakt niet
// uit: dit is precies het stukje van pdf-lib dat we gebruiken. De opties van
// de teken-methoden zijn bewust `any`: pdf-lib's eigen optietypes (Color,
// PDFFont) kunnen we hier niet noemen zonder import.

export interface PdfFontLike {
  widthOfTextAtSize(text: string, size: number): number;
  heightAtSize(size: number, options?: { descender?: boolean }): number;
  getCharacterSet(): number[];
}
export interface PdfImageLike { width: number; height: number }
export interface PdfPageLike {
  getSize(): { width: number; height: number };
  // deno-lint-ignore no-explicit-any
  drawText(text: string, options: any): void;
  // deno-lint-ignore no-explicit-any
  drawRectangle(options: any): void;
  // deno-lint-ignore no-explicit-any
  drawLine(options: any): void;
  // deno-lint-ignore no-explicit-any
  drawImage(image: any, options: any): void;
}
export interface PdfDocumentLike {
  // deno-lint-ignore no-explicit-any
  addPage(page?: any): PdfPageLike;
  // deno-lint-ignore no-explicit-any
  embedFont(font: any, options?: any): Promise<PdfFontLike>;
  // deno-lint-ignore no-explicit-any
  registerFontkit(fontkit: any): void;
  embedPng(bytes: Uint8Array): Promise<PdfImageLike>;
  embedJpg(bytes: Uint8Array): Promise<PdfImageLike>;
  // deno-lint-ignore no-explicit-any
  copyPages(source: any, indices: number[]): Promise<PdfPageLike[]>;
  getPageCount(): number;
  save(): Promise<Uint8Array>;
}
export interface PdfLibLike {
  PDFDocument: {
    create(): Promise<PdfDocumentLike>;
    load(bytes: Uint8Array, options?: { ignoreEncryption?: boolean }): Promise<PdfDocumentLike>;
  };
  rgb(red: number, green: number, blue: number): unknown;
}

export interface DocumentAssets {
  logo?: { bytes: Uint8Array; type: 'png' | 'jpg' } | null;
  /** Eigen briefpapier: een PDF (eerste pagina) of een afbeelding, op elke pagina. */
  letterhead?: { kind: 'pdf' | 'image'; bytes: Uint8Array; type?: 'png' | 'jpg' } | null;
}

/** Een data-URL (base64) als bytes en mime-type; `null` als het er geen is. */
export function dataUrlBytes(dataUrl: string | null | undefined): { bytes: Uint8Array; mime: string } | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(str(dataUrl));
  if (!match) return null;
  try {
    const payload = match[3] ?? '';
    const binary = match[2] ? atob(payload) : decodeURIComponent(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { bytes, mime: (match[1] || 'application/octet-stream').toLowerCase() };
  } catch {
    return null;
  }
}

function imageType(mime: string, bytes: Uint8Array): 'png' | 'jpg' | null {
  if (mime.includes('png') || (bytes[0] === 0x89 && bytes[1] === 0x50)) return 'png';
  if (/jpe?g/.test(mime) || (bytes[0] === 0xff && bytes[1] === 0xd8)) return 'jpg';
  return null;
}

/** Logo en briefpapier uit een company_settings-rij. WebP kan een PDF niet aan; dan de naam. */
export function documentAssetsFromSettings(row: {
  brand_logo_data_url?: string | null;
  invoice_template_kind?: string | null;
  invoice_template_data_url?: string | null;
  invoice_template_mime_type?: string | null;
} | null | undefined): DocumentAssets {
  const assets: DocumentAssets = {};
  const logo = dataUrlBytes(row?.brand_logo_data_url);
  const logoType = logo ? imageType(logo.mime, logo.bytes) : null;
  if (logo && logoType) assets.logo = { bytes: logo.bytes, type: logoType };
  if (row?.invoice_template_data_url && row.invoice_template_kind && row.invoice_template_kind !== 'none') {
    const paper = dataUrlBytes(row.invoice_template_data_url);
    if (paper) {
      const mime = str(row.invoice_template_mime_type).toLowerCase() || paper.mime;
      if (row.invoice_template_kind === 'pdf' || mime === 'application/pdf') assets.letterhead = { kind: 'pdf', bytes: paper.bytes };
      else {
        const type = imageType(mime, paper.bytes);
        if (type) assets.letterhead = { kind: 'image', bytes: paper.bytes, type };
      }
    }
  }
  return assets;
}

/** Waar de ingesloten letters vandaan komen: @pdf-lib/fontkit en de bestanden. */
export interface PdfFontSource {
  fontkit: unknown;
  /** "inter-700" → de bytes van public/fonts/pdf/inter-700.woff, of null. */
  load(name: string): Promise<Uint8Array | null>;
}

const STANDARD_FONT_NAMES: Record<string, [string, string]> = {
  helvetica: ['Helvetica', 'Helvetica-Bold'],
  times: ['Times-Roman', 'Times-Bold'],
  courier: ['Courier', 'Courier-Bold'],
};

const FONT_REFS: FontRef[] = ['body', 'bodyBold', 'heading', 'headingBold'];

function pdfColor(lib: PdfLibLike, hex: string): unknown {
  const [r, g, b] = channels(HEX.test(hex) ? hex : '#000000');
  return lib.rgb(r / 255, g / 255, b / 255);
}

/**
 * De letters van een stijl, ingesloten in een document; ook de editor meet
 * hiermee. Laadt een ingesloten letter niet (geen bron, bestand weg), dan de
 * dichtstbijzijnde standaardletter, met een waarschuwing: liever een factuur
 * in Helvetica dan geen factuur.
 */
export async function embedDocumentFonts(
  doc: PdfDocumentLike,
  style: DocumentStyle,
  source?: PdfFontSource | null,
  warn: (message: string, error?: unknown) => void = () => {},
): Promise<Record<FontRef, PdfFontLike>> {
  const cache = new Map<string, Promise<PdfFontLike | null>>();
  let fontkitRegistered = false;
  // Eén waarschuwing per letter, niet per gewicht.
  const warned = new Set<string>();
  const warnOnce = (key: string, message: string, error?: unknown) => {
    if (warned.has(key)) return;
    warned.add(key);
    warn(message, error);
  };
  const standard = (key: PdfFontKey, bold: boolean): Promise<PdfFontLike | null> => {
    const name = STANDARD_FONT_NAMES[standardFallback(key)][bold ? 1 : 0];
    if (!cache.has(name)) cache.set(name, doc.embedFont(name));
    return cache.get(name)!;
  };
  const embedded = (key: PdfFontKey, bold: boolean): Promise<PdfFontLike | null> => {
    const def = pdfFont(key);
    if (def.standard || !def.file) return Promise.resolve(null);
    const name = `${def.file}-${bold && def.bold ? 700 : 400}`;
    if (!cache.has(name)) {
      cache.set(name, (async () => {
        if (!source) {
          warnOnce(def.key, `Het lettertype ${def.label} kon niet in de PDF (geen lettertypen beschikbaar); er staat nu ${pdfFont(standardFallback(key)).label}.`);
          return null;
        }
        try {
          if (!fontkitRegistered) {
            doc.registerFontkit(source.fontkit);
            fontkitRegistered = true;
          }
          const bytes = await source.load(name);
          if (!bytes || bytes.length === 0) throw new Error(`${name} niet gevonden`);
          return await doc.embedFont(bytes, { subset: true });
        } catch (error) {
          warnOnce(def.key, `Het lettertype ${def.label} kon niet in de PDF; er staat nu ${pdfFont(standardFallback(key)).label}.`, error);
          return null;
        }
      })());
    }
    return cache.get(name)!;
  };
  const pick = async (key: PdfFontKey, bold: boolean): Promise<PdfFontLike> =>
    (await embedded(key, bold)) ?? (await standard(key, bold))!;
  const [body, bodyBold, heading, headingBold] = await Promise.all([
    pick(style.bodyFont, false),
    pick(style.bodyFont, true),
    pick(style.headingFont, false),
    pick(style.headingFont, true),
  ]);
  return { body, bodyBold, heading, headingBold };
}

export function measureWith(fonts: Record<FontRef, PdfFontLike>): Measure {
  return (text, size, font) => fonts[font].widthOfTextAtSize(text, size);
}

/** Tekens die een ingesloten letter (het "latin"-deel) mist, met wat er wel kan. */
const CHARSET_FALLBACK: Record<string, string> = { 'Š': 'S', 'š': 's', 'Ž': 'Z', 'ž': 'z', 'Ÿ': 'Y', 'ƒ': 'f' };

/**
 * Meten, opschonen en de basislijn, voor precies deze letters. Het plan van
 * de editor en de PDF komen zo uit dezelfde maten.
 */
export function documentFontTools(fonts: Record<FontRef, PdfFontLike>): TextTools {
  const sets = {} as Record<FontRef, Set<number>>;
  const ascents = {} as Record<FontRef, number>;
  for (const ref of FONT_REFS) {
    sets[ref] = new Set(fonts[ref].getCharacterSet());
    const ascent = fonts[ref].heightAtSize(1, { descender: false });
    ascents[ref] = Math.max(ASCENT_RANGE.min, Math.min(ASCENT_RANGE.max, Number.isFinite(ascent) && ascent > 0 ? ascent : 0.72));
  }
  return {
    measure: measureWith(fonts),
    clean(text, font) {
      const set = sets[font];
      let out = '';
      for (const char of pdfSafeText(text)) {
        const code = char.codePointAt(0) ?? 0;
        if (code === 10 || set.has(code)) out += char;
        else {
          const alt = CHARSET_FALLBACK[char];
          if (alt && set.has(alt.codePointAt(0) ?? 0)) out += alt;
        }
      }
      return out;
    },
    ascent: font => ascents[font],
  };
}

/**
 * Tekent een offerte of factuur. Een logo of briefpapier dat niet te lezen is
 * laat de PDF niet mislukken: dan zonder, en `onWarning` hoort waarom.
 */
export async function renderDocumentPdf(lib: PdfLibLike, input: {
  layout: DocumentLayout;
  data: DocumentData;
  style: DocumentStyle;
  assets?: DocumentAssets;
  /** De ingesloten letters; zonder komen er standaardletters in. */
  fonts?: PdfFontSource | null;
  onWarning?: (message: string, error?: unknown) => void;
}): Promise<Uint8Array> {
  const warn = input.onWarning ?? (() => {});
  const doc = await lib.PDFDocument.create();
  const fonts = await embedDocumentFonts(doc, input.style, input.fonts, warn);
  const tools = documentFontTools(fonts);

  let logo: PdfImageLike | null = null;
  if (input.assets?.logo) {
    try {
      logo = input.assets.logo.type === 'png' ? await doc.embedPng(input.assets.logo.bytes) : await doc.embedJpg(input.assets.logo.bytes);
    } catch (error) {
      warn('Het logo kon niet in de PDF; de naam staat er nu.', error);
    }
  }

  let paperPdf: PdfDocumentLike | null = null;
  let paperImage: PdfImageLike | null = null;
  const paper = input.assets?.letterhead;
  if (paper) {
    try {
      if (paper.kind === 'pdf') {
        paperPdf = await lib.PDFDocument.load(paper.bytes, { ignoreEncryption: true });
        if (paperPdf.getPageCount() < 1) paperPdf = null;
      } else {
        paperImage = paper.type === 'jpg' ? await doc.embedJpg(paper.bytes) : await doc.embedPng(paper.bytes);
      }
    } catch (error) {
      paperPdf = null;
      paperImage = null;
      warn('Het briefpapier kon niet worden gebruikt; de PDF is zonder gemaakt.', error);
    }
  }

  const plan = planDocument(input.layout, input.data, input.style, {
    ...tools,
    logo: logo ? { width: logo.width, height: logo.height } : null,
  });

  for (const planned of plan.pages) {
    let page: PdfPageLike;
    if (paperPdf) {
      const [copied] = await doc.copyPages(paperPdf, [0]);
      page = doc.addPage(copied);
    } else {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      if (paperImage) {
        // Als omslag: de pagina helemaal vullen, zonder vervormen.
        const ratio = paperImage.width / paperImage.height;
        const pageRatio = PAGE_WIDTH / PAGE_HEIGHT;
        const width = ratio > pageRatio ? PAGE_HEIGHT * ratio : PAGE_WIDTH;
        const height = ratio > pageRatio ? PAGE_HEIGHT : PAGE_WIDTH / ratio;
        page.drawImage(paperImage, { x: (PAGE_WIDTH - width) / 2, y: (PAGE_HEIGHT - height) / 2, width, height });
      }
    }
    const pageHeight = page.getSize().height;
    for (const op of planned.ops) {
      if (op.t === 'text') {
        page.drawText(op.text, { x: op.x, y: pageHeight - op.y, size: op.size, font: fonts[op.font], color: pdfColor(lib, op.color) });
      } else if (op.t === 'rect') {
        page.drawRectangle({ x: op.x, y: pageHeight - op.y - op.h, width: op.w, height: op.h, color: pdfColor(lib, op.color), opacity: op.opacity });
      } else if (op.t === 'line') {
        page.drawLine({ start: { x: op.x1, y: pageHeight - op.y1 }, end: { x: op.x2, y: pageHeight - op.y2 }, thickness: op.width, color: pdfColor(lib, op.color), opacity: op.opacity });
      } else if (logo) {
        page.drawImage(logo, { x: op.x, y: pageHeight - op.y - op.h, width: op.w, height: op.h });
      }
    }
  }
  return await doc.save();
}
