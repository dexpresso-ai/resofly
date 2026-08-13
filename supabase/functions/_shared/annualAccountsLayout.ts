// ============================================================
// De opbouw van de jaarrekening en het publicatiestuk — als DATA.
//
// Twee documenten uit één bevroren onderbouwing:
//
//   buildAnnualAccountsDocument()  — de volledige jaarrekening: titelblad, balans
//     ná resultaatbestemming met vergelijkende kolom, winst-en-verliesrekening in
//     Model E-volgorde, grondslagen, toelichting op de balans en op de W&V,
//     resultaatbestemming, ondertekening en vaststelling.
//
//   buildPublicationDocument()     — het stuk zoals het gedeponeerd zou worden,
//     beperkt tot wat de groottecategorie voorschrijft.
//
// WAAROM DATA EN GEEN IF-BOOM. De vier publicatievarianten verschillen op zes
// assen (balansdetail, W&V, toelichting, bestuursverslag, accountantsverklaring,
// overige gegevens). Als if-boom in de renderer wordt dat onnavolgbaar en
// onmogelijk te controleren tegen de wet. Daarom staat elke variant als één rij
// in PUBLICATION_SETS, mét het artikel erbij, en leest de opbouw die rij af.
//
// HARDE REGELS
//   * ALLES komt uit de bevroren snapshot van annual_accounts. Nooit uit een
//     live query — anders wijkt een herdruk af van wat de algemene vergadering
//     heeft vastgesteld en wat is gedeponeerd.
//   * Bedragen zijn hele centen uit die snapshot. Hier wordt niet herrekend;
//     alleen opgeteld tot rubriek- en subtotalen die de wet als presentatie
//     voorschrijft, en dat gebeurt op de bevroren regels zelf.
//   * Een verouderde (snapshotStale) of ingetrokken jaarrekening wordt ZICHTBAAR
//     gemarkeerd, nooit stilzwijgend afgedrukt.
//   * Bestuursverslag, accountantsverklaring en overige gegevens genereert
//     ResoFly niet. Ze worden benoemd als checklist waar ze verplicht zijn — een
//     gegenereerde accountantsverklaring zou per definitie vals zijn.
// ============================================================

import {
  type Block,
  type Col,
  type ReportDocument,
  type Row,
  type Signer,
  fmtDateNl,
  fmtEuro,
  fmtEuroOrDash,
  fmtNumberNl,
  safePdfFileName,
} from './reportPdf.ts';

// ------------------------------------------------------------ jsonb-hulpjes
type Json = Record<string, unknown>;

function obj(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}
function rows(value: unknown): Json[] {
  return Array.isArray(value) ? (value.filter((item) => item && typeof item === 'object') as Json[]) : [];
}
function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}
function num(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}
function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
function bool(value: unknown): boolean {
  return value === true || value === 'true';
}

// ------------------------------------------------------------ constanten
export type SizeClass = 'micro' | 'klein' | 'middelgroot' | 'groot';

export const SIZE_CLASS_LABELS: Record<SizeClass, string> = {
  micro: 'micro-rechtspersoon',
  klein: 'kleine rechtspersoon',
  middelgroot: 'middelgrote rechtspersoon',
  groot: 'grote rechtspersoon',
};

export const SIZE_CLASS_ARTICLES: Record<SizeClass, string> = {
  micro: 'art. 2:395a lid 1 BW',
  klein: 'art. 2:396 lid 1 BW',
  middelgroot: 'art. 2:397 lid 1 BW',
  // Groot is de restcategorie: er is geen vrijstellingsartikel dat op haar past.
  groot: 'restcategorie - geen vrijstellingsartikel (art. 2:361 e.v. BW)',
};

const BALANCE_GROUP_LABELS: Record<string, string> = {
  immateriele_vaste_activa: 'Immateriële vaste activa',
  materiele_vaste_activa: 'Materiële vaste activa',
  financiele_vaste_activa: 'Financiële vaste activa',
  voorraden: 'Voorraden',
  vorderingen: 'Vorderingen',
  effecten: 'Effecten',
  liquide_middelen: 'Liquide middelen',
  eigen_vermogen: 'Eigen vermogen',
  voorzieningen: 'Voorzieningen',
  langlopende_schulden: 'Langlopende schulden',
  kortlopende_schulden: 'Kortlopende schulden',
};

const PL_GROUP_LABELS: Record<string, string> = {
  netto_omzet: 'Netto-omzet',
  overige_bedrijfsopbrengsten: 'Overige bedrijfsopbrengsten',
  inkoopwaarde: 'Kosten van grond- en hulpstoffen en uitbesteed werk',
  personeelskosten: 'Lonen, salarissen en sociale lasten',
  afschrijvingen: 'Afschrijvingen op vaste activa',
  overige_bedrijfskosten: 'Overige bedrijfskosten',
  financiele_baten: 'Financiële baten',
  financiele_lasten: 'Financiële lasten',
  belastingen: 'Belastingen over het resultaat',
  resultaat_deelnemingen: 'Aandeel in het resultaat van deelnemingen',
};

/** Rubrieken die het resultaat verhógen; de rest verlaagt het. */
const INCOME_GROUPS = new Set(['netto_omzet', 'overige_bedrijfsopbrengsten', 'financiele_baten', 'resultaat_deelnemingen']);

const OPERATING_INCOME_GROUPS = ['netto_omzet', 'overige_bedrijfsopbrengsten'];
const OPERATING_COST_GROUPS = ['inkoopwaarde', 'personeelskosten', 'afschrijvingen', 'overige_bedrijfskosten'];

/**
 * Art. 2:397 lid 4 BW: een middelgrote rechtspersoon mag een NAUW OMSCHREVEN
 * groep posten samentrekken tot één post "Bruto-bedrijfsresultaat". Wat daar niet
 * onder valt, moet apart worden vermeld — anders wordt er te weinig openbaar
 * gemaakt, en dat is niet meer te herstellen zodra het stuk is gedeponeerd.
 *
 * In ResoFly-rubrieken: de opbrengstposten (netto-omzet en overige bedrijfs-
 * opbrengsten) plus de kosten van grond- en hulpstoffen en uitbesteed werk.
 * BUITEN de samentrekking blijven dus: lonen/salarissen en sociale lasten, de
 * afschrijvingen ÉN de overige bedrijfskosten. Die laatste stond hier eerder wél
 * in, waardoor een afzonderlijk te vermelden post verdween.
 *
 * Deze samentrekking staat hier op rubriekniveau — hardgecodeerd, want zij volgt
 * uit de wet en niet uit een instelling van de gebruiker. Let op: de INHOUD van
 * de vrijstelling staat vast; de precieze lid- en letteraanduidingen van
 * art. 2:377 BW zijn in dit project niet tegen de wettekst geverifieerd. Daarom
 * wordt in het stuk zelf verwezen naar art. 2:397 lid 4 BW mét voorbehoud, en
 * niet naar losse letters van art. 2:377 BW.
 */
const GROSS_MARGIN_GROUPS = ['netto_omzet', 'overige_bedrijfsopbrengsten', 'inkoopwaarde'];

/** Rubrieken die bij de samentrekking apart moeten blijven staan. */
const GROSS_MARGIN_SEPARATE_GROUPS = ['personeelskosten', 'afschrijvingen', 'overige_bedrijfskosten'];

/**
 * De rubrieken die de winst-en-verliesrekening kent. Alles wat hierbuiten valt
 * (de CHECK in de database staat élke rubriek bij élk rekeningtype toe) wordt
 * apart afgedrukt in plaats van weggelaten — zie profitAndLossRows().
 */
const KNOWN_PL_GROUPS = new Set<string>([
  ...OPERATING_INCOME_GROUPS,
  ...OPERATING_COST_GROUPS,
  'financiele_baten',
  'financiele_lasten',
  'belastingen',
  'resultaat_deelnemingen',
]);

/**
 * De hoofdrubrieken van de balans, voor de micro-variant. Art. 2:395a lid 3-4 BW
 * staat een veel schralere balans toe dan de rubrieksbalans van een kleine
 * rechtspersoon; wie meer publiceert dan nodig, kan dat niet terugdraaien.
 */
const BALANCE_MAIN_GROUPS: Record<string, string> = {
  immateriele_vaste_activa: 'Vaste activa',
  materiele_vaste_activa: 'Vaste activa',
  financiele_vaste_activa: 'Vaste activa',
  voorraden: 'Vlottende activa',
  vorderingen: 'Vlottende activa',
  effecten: 'Vlottende activa',
  liquide_middelen: 'Vlottende activa',
  eigen_vermogen: 'Eigen vermogen',
  voorzieningen: 'Voorzieningen',
  langlopende_schulden: 'Schulden',
  kortlopende_schulden: 'Schulden',
};

export const RESOFLY_DISCLAIMER =
  'Opgesteld met ResoFly als hulpmiddel. Geen accountantsproduct en geen fiscaal of juridisch advies; ' +
  'de rechtspersoon blijft verantwoordelijk voor de inhoud, de volledigheid en de tijdige deponering.';

export const PUBLICATION_BANNER =
  'Dit PDF-bestand is een werk- en archiefstuk. Deponeren bij het handelsregister gaat voor micro, kleine en ' +
  'middelgrote rechtspersonen verplicht digitaal in SBR/XBRL (en voor grote rechtspersonen vanaf boekjaar 2025); ' +
  'ResoFly levert dat bestand niet. Gebruik dit stuk om te controleren en te archiveren, niet om te deponeren.';

// ------------------------------------------------------------ publicatievarianten
/**
 * Het detailniveau van de balans. Drie ECHT verschillende niveaus, want micro,
 * klein en middelgroot stonden hier eerder alle drie op hetzelfde niveau:
 *   hoofdrubriek — vaste/vlottende activa, eigen vermogen, voorzieningen,
 *                  schulden. De schrale balans van art. 2:395a lid 3-4 BW.
 *   rubriek      — de elf rapportagerubrieken. De verkorte balans van klein.
 *   rekening     — de rubrieken mét de onderliggende grootboekrekeningen.
 * ResoFly kent geen indeling naar de posten van het Besluit modellen jaarrekening;
 * daarom vertelt het stuk zelf op welk niveau het is opgesteld en dat dit niet per
 * definitie het wettelijk voorgeschreven niveau is.
 */
export type BalanceDetail = 'hoofdrubriek' | 'rubriek' | 'rekening';

export type PublicationSet = {
  sizeClass: SizeClass;
  /** Wat er van de balans wordt getoond. */
  balance: BalanceDetail;
  balanceLabel: string;
  /** Wat het stuk zelf over dat detailniveau vertelt. */
  balanceDetailNote: string;
  profitAndLoss: 'none' | 'gross' | 'full';
  profitAndLossLabel: string | null;
  notes: 'none' | 'limited' | 'extended' | 'full';
  /** Art. 2:396 lid 8 BW: de gegevens van art. 2:380a blijven achterwege. */
  omit380a: boolean;
  managementReport: boolean;
  auditorOpinion: boolean;
  otherInformation: boolean;
  article: string;
  articleNote?: string;
  /** Wat DIT bestand daadwerkelijk bevat. Nooit meer dan dat. */
  contents: string[];
  /**
   * Wat de wet bij deze grootteklasse óók openbaar verlangt en wat dit bestand
   * NIET bevat. Leeg = de set is compleet.
   */
  missing: string[];
};

/** Wat ResoFly aan toelichtingsonderdelen niet opstelt; geldt voor middelgroot en groot. */
const MISSING_NOTE_ITEMS = [
  'Bezoldiging van bestuurders en commissarissen (art. 2:383 BW)',
  'Honoraria van de accountantsorganisatie (art. 2:382a BW)',
  'De volledige opgave van werknemers per bedrijfsonderdeel en buiten Nederland (art. 2:382 BW)',
];

export const PUBLICATION_SETS: Record<SizeClass, PublicationSet> = {
  micro: {
    sizeClass: 'micro',
    balance: 'hoofdrubriek',
    balanceLabel: 'Beperkte balans (micro)',
    balanceDetailNote:
      'Detailniveau: hoofdrubrieken (vaste en vlottende activa, eigen vermogen, voorzieningen, schulden). ' +
      'Art. 2:395a lid 3-4 BW staat een sterk beperkte balans toe; ResoFly houdt daarom bewust het schraalste ' +
      'niveau aan, omdat wat eenmaal openbaar is niet meer beperkt kan worden.',
    profitAndLoss: 'none',
    profitAndLossLabel: null,
    notes: 'none',
    omit380a: true,
    managementReport: false,
    auditorOpinion: false,
    otherInformation: false,
    article: 'art. 2:395a lid 8 jo. lid 3 en 4 BW',
    contents: ['Beperkte balans op het niveau van de hoofdrubrieken'],
    missing: [],
  },
  klein: {
    sizeClass: 'klein',
    balance: 'rubriek',
    balanceLabel: 'Verkorte balans (klein)',
    balanceDetailNote:
      'Detailniveau: rapportagerubrieken (immateriële, materiële en financiële vaste activa, voorraden, ' +
      'vorderingen, effecten, liquide middelen, eigen vermogen, voorzieningen, lang- en kortlopende schulden).',
    profitAndLoss: 'none',
    profitAndLossLabel: null,
    notes: 'limited',
    omit380a: true,
    managementReport: false,
    auditorOpinion: false,
    otherInformation: false,
    article: 'art. 2:396 lid 8 jo. lid 3 en lid 7 BW',
    contents: [
      'Verkorte balans op rubriekniveau',
      'Toelichting, zonder de gegevens van art. 2:380a BW',
    ],
    missing: [],
  },
  middelgroot: {
    sizeClass: 'middelgroot',
    balance: 'rekening',
    balanceLabel: 'Enigszins beperkte balans (middelgroot)',
    balanceDetailNote:
      'Detailniveau: rapportagerubrieken mét de onderliggende grootboekrekeningen. Art. 2:397 BW staat slechts een ' +
      'ENIGSZINS beperkte balans toe, die dicht bij het volledige model blijft; een balans op alleen rubriekniveau ' +
      'zou daarvoor te schraal zijn. ResoFly kent geen indeling naar de posten van het Besluit modellen jaarrekening, ' +
      'dus dit is niet per definitie het wettelijk voorgeschreven niveau — controleer dit met uw accountant.',
    profitAndLoss: 'gross',
    profitAndLossLabel: 'Vereenvoudigde winst-en-verliesrekening (middelgroot)',
    notes: 'extended',
    omit380a: false,
    managementReport: true,
    auditorOpinion: true,
    otherInformation: true,
    article: 'art. 2:397 BW (samentrekking tot Bruto-bedrijfsresultaat: lid 4)',
    articleNote:
      'De inhoud van de vrijstelling voor middelgrote rechtspersonen staat vast; over de precieze lidnummering van ' +
      'art. 2:397 BW en over de letteraanduidingen van art. 2:377 BW spreken de bronnen elkaar tegen. Deze ' +
      'verwijzingen zijn niet tegen de wettekst geverifieerd. Controleer ze voordat u ze in externe communicatie gebruikt.',
    contents: [
      'Enigszins beperkte balans (rubrieken met de onderliggende rekeningen)',
      'Vereenvoudigde winst-en-verliesrekening met de post Bruto-bedrijfsresultaat',
      'Toelichting: grondslagen, eigen vermogen, niet in de balans opgenomen verplichtingen, gemiddeld aantal werknemers en de belastinglast',
    ],
    missing: [
      'Bestuursverslag (art. 2:391 BW)',
      'Accountantsverklaring (art. 2:393 BW)',
      'Overige gegevens (art. 2:392 BW)',
      ...MISSING_NOTE_ITEMS,
    ],
  },
  groot: {
    sizeClass: 'groot',
    balance: 'rekening',
    balanceLabel: 'Balans (per grootboekrekening)',
    balanceDetailNote:
      'Detailniveau: rapportagerubrieken mét de onderliggende grootboekrekeningen. Een grote rechtspersoon maakt de ' +
      'volledige balans volgens het wettelijke model openbaar; ResoFly kent die modelindeling niet en toont daarom de ' +
      'rekeningen zelf. Dat is een andere indeling dan het model voorschrijft — controleer dit met uw accountant.',
    profitAndLoss: 'full',
    profitAndLossLabel: 'Winst-en-verliesrekening (per grootboekrekening)',
    notes: 'full',
    omit380a: false,
    managementReport: true,
    auditorOpinion: true,
    otherInformation: true,
    article: 'geen vrijstellingsartikel van toepassing (art. 2:361 e.v. jo. 2:391, 2:392, 2:393 en 2:394 BW)',
    contents: [
      'Balans met de onderliggende grootboekrekeningen',
      'Winst-en-verliesrekening met de onderliggende grootboekrekeningen',
      'Toelichting: grondslagen, eigen vermogen, niet in de balans opgenomen verplichtingen, gemiddeld aantal werknemers en de belastinglast',
    ],
    missing: [
      'Bestuursverslag (art. 2:391 BW)',
      'Accountantsverklaring (art. 2:393 BW)',
      'Overige gegevens (art. 2:392 BW)',
      ...MISSING_NOTE_ITEMS,
    ],
  },
};

// ------------------------------------------------------------ kolomdefinities
/**
 * Is er geen voorgaand boekjaar, dan verdwijnt de vergelijkende kolom HELEMAAL.
 * Anders zou elke regel "EUR 0,00" tonen onder een kop "vorig boekjaar", en dat
 * presenteert verzonnen nulcijfers als vergelijkende cijfers in een stuk dat wordt
 * vastgesteld en gedeponeerd (art. 2:363 lid 5 BW). De labelkolom neemt de
 * vrijgekomen breedte over, zodat de tabel de volle CONTENT_W blijft vullen.
 */
function amountCols(currentHeader: string, previousHeader: string | null): Col[] {
  if (!previousHeader) {
    return [
      { key: 'label', width: 389, align: 'left' },
      { key: 'current', width: 110, align: 'right', header: currentHeader },
    ];
  }
  return [
    { key: 'label', width: 279, align: 'left' },
    { key: 'current', width: 110, align: 'right', header: currentHeader },
    { key: 'previous', width: 110, align: 'right', header: previousHeader },
  ];
}

/** Is er een voorgaand boekjaar bevroren in de snapshot? */
function hasPreviousFiscalYear(snapshot: Json): boolean {
  return Object.keys(obj(snapshot.previousFiscalYear)).length > 0;
}

/** De kop van de vergelijkende kolom, of null als die kolom niet hoort te bestaan. */
function previousHeaderFor(snapshot: Json): string | null {
  if (!hasPreviousFiscalYear(snapshot)) return null;
  const previous = obj(snapshot.previousFiscalYear);
  return fmtDateNl(str(previous.periodEnd)) || str(previous.label) || 'vorig boekjaar';
}

/** De regel die in de plaats komt van een lege vergelijkende kolom. */
function missingComparativesBlock(snapshot: Json): Block[] {
  if (hasPreviousFiscalYear(snapshot)) return [];
  return [{
    type: 'paragraph',
    small: true,
    text:
      'Vergelijkende cijfers ontbreken: dit is het eerste boekjaar dat in ResoFly is vastgelegd. De kolom met de ' +
      'cijfers van het voorgaande boekjaar is daarom weggelaten en niet met nullen gevuld (art. 2:363 lid 5 BW).',
  }];
}

// ------------------------------------------------------------ afgeleiden
type BalanceLine = {
  section: string;
  group: string;
  rank: number;
  code: string;
  name: string;
  current: number;
  /** null = geen vergelijkend cijfer bekend. Nooit stilzwijgend 0. */
  previous: number | null;
  delta: number;
  restricted: boolean;
  subtype: string;
};

function balanceLines(snapshot: Json): BalanceLine[] {
  return rows(obj(snapshot.balanceSheetAfterAppropriation).rows).map((row) => ({
    section: str(row.section),
    group: str(row.reportGroup),
    rank: num(row.groupRank),
    code: str(row.code),
    name: str(row.name),
    current: num(row.amountCents),
    previous: numOrNull(row.amountPrevCents),
    delta: num(row.appropriationDeltaCents),
    restricted: bool(row.isRestrictedReserve),
    subtype: str(row.subtype),
  }));
}

type PlLine = {
  group: string;
  rank: number;
  code: string;
  name: string;
  accountType: string;
  current: number;
  /** null = geen vergelijkend cijfer bekend. Nooit stilzwijgend 0. */
  previous: number | null;
};

function plLines(snapshot: Json): PlLine[] {
  return rows(obj(snapshot.profitAndLossComparative).rows).map((row) => ({
    group: str(row.reportGroup),
    rank: num(row.groupRank),
    code: str(row.code),
    name: str(row.name),
    accountType: str(row.accountType),
    current: num(row.amountCents),
    previous: numOrNull(row.amountPrevCents),
  }));
}

/**
 * Optellen van vergelijkende cijfers. Weet GEEN van de regels een vergelijkend
 * cijfer, dan is de uitkomst null (streepje) en niet nul.
 */
function sumPrevious(lines: Array<{ previous: number | null }>): number | null {
  if (lines.length === 0 || lines.every((line) => line.previous === null)) return null;
  return lines.reduce((acc, line) => acc + (line.previous ?? 0), 0);
}

/**
 * De rapport-RPC levert opbrengsten én kosten POSITIEF (elk in zijn eigen teken:
 * revenue = credit-debet, expense = debet-credit). Voor optellen tot subtotalen is
 * één richting nodig, dus wordt hier per regel het EFFECT OP HET RESULTAAT bepaald:
 * positief = winstverhogend. Bewust op het type van de rekening en niet op de
 * rubriek — de rubriek is een presentatiekeuze die de gebruiker mag wijzigen, het
 * type niet.
 */
function resultEffect(line: PlLine, field: 'current' | 'previous'): number {
  const amount = line[field] ?? 0;
  return line.accountType === 'revenue' ? amount : -amount;
}

/** Som van het resultaateffect per rubriek. */
function groupEffects(lines: PlLine[], field: 'current' | 'previous'): Map<string, number> {
  const totals = new Map<string, number>();
  for (const line of lines) {
    totals.set(line.group, (totals.get(line.group) ?? 0) + resultEffect(line, field));
  }
  return totals;
}

function sumGroups(totals: Map<string, number>, groups: string[]): number {
  return groups.reduce((acc, group) => acc + (totals.get(group) ?? 0), 0);
}

/**
 * Wat er in de kolom komt te staan: opbrengstrubrieken tonen hun effect, kosten-
 * rubrieken tonen het bedrag positief (zoals in een gedrukte W&V gebruikelijk is).
 */
function presentedGroupAmount(group: string, effect: number): number {
  return INCOME_GROUPS.has(group) ? effect : -effect;
}

// ------------------------------------------------------------ balans
function balanceRowsFor(lines: BalanceLine[], detail: BalanceDetail): Row[] {
  const out: Row[] = [];
  const sides: Array<{ title: string; match: (line: BalanceLine) => boolean; totalLabel: string }> = [
    // De kant volgt uit `section`, niet uit de rubriek: een rekening die per saldo
    // aan de andere kant staat hoort ook daar te worden getoond.
    { title: 'ACTIVA', match: (line) => line.section === 'asset', totalLabel: 'Totaal activa' },
    { title: 'PASSIVA', match: (line) => line.section !== 'asset', totalLabel: 'Totaal passiva' },
  ];

  for (const side of sides) {
    const sideLines = lines.filter(side.match);
    out.push({ kind: 'section', text: side.title });

    if (detail === 'hoofdrubriek') {
      // Micro: alleen de hoofdrubrieken. Een rubriek die ResoFly niet kent krijgt
      // haar eigen regel via humanizeGroup — er mag nooit een bedrag wegvallen.
      const buckets = new Map<string, BalanceLine[]>();
      for (const line of sideLines) {
        const bucket = BALANCE_MAIN_GROUPS[line.group] || humanizeGroup(line.group);
        buckets.set(bucket, [...(buckets.get(bucket) ?? []), line]);
      }
      const ordered = [...buckets.entries()]
        .sort((a, b) => Math.min(...a[1].map((l) => l.rank)) - Math.min(...b[1].map((l) => l.rank)));
      for (const [label, bucketLines] of ordered) {
        out.push({
          kind: 'line',
          cells: {
            label,
            current: fmtEuro(bucketLines.reduce((acc, line) => acc + line.current, 0)),
            previous: fmtEuroOrDash(sumPrevious(bucketLines)),
          },
        });
      }
    } else {
      const groups = [...new Set(sideLines.map((line) => line.group))]
        .sort((a, b) => groupRank(sideLines, a) - groupRank(sideLines, b));

      for (const group of groups) {
        const groupLines = sideLines.filter((line) => line.group === group);
        const label = BALANCE_GROUP_LABELS[group] || humanizeGroup(group);
        const current = groupLines.reduce((acc, line) => acc + line.current, 0);
        const previous = sumPrevious(groupLines);

        if (detail === 'rubriek') {
          out.push({ kind: 'line', cells: { label, current: fmtEuro(current), previous: fmtEuroOrDash(previous) } });
          continue;
        }

        out.push({ kind: 'section', text: label });
        for (const line of groupLines) {
          out.push({
            kind: 'line',
            indent: 12,
            cells: {
              label: `${line.code} ${line.name}`.trim(),
              current: fmtEuro(line.current),
              previous: fmtEuroOrDash(line.previous),
            },
          });
        }
        out.push({
          kind: 'sub',
          cells: { label: `Totaal ${label.toLowerCase()}`, current: fmtEuro(current), previous: fmtEuroOrDash(previous) },
        });
      }
    }

    const sideCurrent = sideLines.reduce((acc, line) => acc + line.current, 0);
    out.push({
      kind: 'total',
      cells: { label: side.totalLabel, current: fmtEuro(sideCurrent), previous: fmtEuroOrDash(sumPrevious(sideLines)) },
    });
    out.push({ kind: 'spacer' });
  }

  return out;
}

function groupRank(lines: BalanceLine[], group: string): number {
  const line = lines.find((candidate) => candidate.group === group);
  return line ? line.rank : 999;
}

function humanizeGroup(group: string): string {
  if (!group) return 'Niet ingedeeld';
  const text = group.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ------------------------------------------------------------ winst-en-verlies
function profitAndLossRows(lines: PlLine[], mode: 'gross' | 'full', detail: 'group' | 'account'): Row[] {
  const current = groupEffects(lines, 'current');
  const previous = groupEffects(lines, 'previous');
  const out: Row[] = [];

  const groupLine = (group: string, label?: string, indent?: number): Row | null => {
    const hasLines = lines.some((line) => line.group === group);
    if (!hasLines) return null;
    return {
      kind: 'line',
      indent,
      cells: {
        label: label || PL_GROUP_LABELS[group] || humanizeGroup(group),
        current: fmtEuro(presentedGroupAmount(group, current.get(group) ?? 0)),
        previous: fmtEuroOrDash(presentedGroupAmount(group, previous.get(group) ?? 0)),
      },
    };
  };

  const accountLines = (group: string): Row[] =>
    detail === 'account'
      ? lines
        .filter((line) => line.group === group)
        .map((line) => ({
          kind: 'line' as const,
          indent: 12,
          cells: {
            label: `${line.code} ${line.name}`.trim(),
            current: fmtEuro(line.current),
            previous: fmtEuroOrDash(line.previous),
          },
        }))
      : [];

  const pushGroup = (group: string, label?: string) => {
    if (!lines.some((line) => line.group === group)) return;
    if (detail === 'account') {
      out.push({ kind: 'section', text: label || PL_GROUP_LABELS[group] || humanizeGroup(group) });
      out.push(...accountLines(group));
      out.push({
        kind: 'sub',
        cells: {
          label: `Totaal ${(label || PL_GROUP_LABELS[group] || humanizeGroup(group)).toLowerCase()}`,
          current: fmtEuro(presentedGroupAmount(group, current.get(group) ?? 0)),
          previous: fmtEuroOrDash(presentedGroupAmount(group, previous.get(group) ?? 0)),
        },
      });
    } else {
      const row = groupLine(group, label);
      if (row) out.push(row);
    }
  };

  if (mode === 'gross') {
    // Art. 2:397 lid 4 BW: alleen de opbrengstposten en de kosten van grond- en
    // hulpstoffen en uitbesteed werk mogen worden samengetrokken. Overige
    // bedrijfskosten, personeelskosten en afschrijvingen blijven APART — die zaten
    // hier eerder ten onrechte in de samentrekking, waardoor er te weinig openbaar
    // werd gemaakt.
    out.push({
      kind: 'line',
      cells: {
        label: 'Bruto-bedrijfsresultaat',
        current: fmtEuro(sumGroups(current, GROSS_MARGIN_GROUPS)),
        previous: fmtEuroOrDash(sumGroups(previous, GROSS_MARGIN_GROUPS)),
      },
    });
    out.push({
      kind: 'note',
      text:
        'Samengetrokken post op grond van art. 2:397 lid 4 BW. Samengevoegd zijn de netto-omzet, de overige ' +
        'bedrijfsopbrengsten en de kosten van grond- en hulpstoffen en uitbesteed werk. Lonen, salarissen en sociale ' +
        'lasten, de afschrijvingen en de overige bedrijfskosten blijven apart vermeld. De inhoud van deze ' +
        'samentrekking staat vast; de lid- en letteraanduidingen van art. 2:377 BW zijn in ResoFly niet tegen de ' +
        'wettekst geverifieerd - controleer de verwijzing voordat u haar in externe communicatie gebruikt.',
    });
    for (const group of GROSS_MARGIN_SEPARATE_GROUPS) {
      const row = groupLine(group);
      if (row) out.push(row);
    }
    out.push({
      kind: 'total',
      cells: {
        label: 'Bedrijfsresultaat',
        current: fmtEuro(sumGroups(current, [...OPERATING_INCOME_GROUPS, ...OPERATING_COST_GROUPS])),
        previous: fmtEuroOrDash(sumGroups(previous, [...OPERATING_INCOME_GROUPS, ...OPERATING_COST_GROUPS])),
      },
    });
  } else {
    for (const group of OPERATING_INCOME_GROUPS) pushGroup(group);
    out.push({
      kind: 'sub',
      cells: {
        label: 'Som der bedrijfsopbrengsten',
        current: fmtEuro(sumGroups(current, OPERATING_INCOME_GROUPS)),
        previous: fmtEuroOrDash(sumGroups(previous, OPERATING_INCOME_GROUPS)),
      },
    });
    out.push({ kind: 'spacer' });
    for (const group of OPERATING_COST_GROUPS) pushGroup(group);
    out.push({
      kind: 'sub',
      cells: {
        label: 'Som der bedrijfslasten',
        current: fmtEuro(-sumGroups(current, OPERATING_COST_GROUPS)),
        previous: fmtEuroOrDash(-sumGroups(previous, OPERATING_COST_GROUPS)),
      },
    });
    out.push({
      kind: 'total',
      cells: {
        label: 'Bedrijfsresultaat',
        current: fmtEuro(sumGroups(current, [...OPERATING_INCOME_GROUPS, ...OPERATING_COST_GROUPS])),
        previous: fmtEuroOrDash(sumGroups(previous, [...OPERATING_INCOME_GROUPS, ...OPERATING_COST_GROUPS])),
      },
    });
    out.push({
      kind: 'note',
      text:
        'De post Bedrijfsresultaat is praktijk (Richtlijnen voor de jaarverslaggeving) en geen wettelijk voorgeschreven ' +
        'regel van Model E; de onderliggende posten zijn dat wel.',
    });
  }

  out.push({ kind: 'spacer' });
  for (const group of ['financiele_baten', 'financiele_lasten']) {
    const row = groupLine(group);
    if (row) out.push(row);
  }
  const preTax = (groups: Map<string, number>) =>
    sumGroups(groups, [...OPERATING_INCOME_GROUPS, ...OPERATING_COST_GROUPS, 'financiele_baten', 'financiele_lasten']);
  out.push({
    kind: 'total',
    cells: {
      label: 'Resultaat voor belastingen',
      current: fmtEuro(preTax(current)),
      previous: fmtEuroOrDash(preTax(previous)),
    },
  });

  const taxRow = groupLine('belastingen');
  if (taxRow) out.push(taxRow);
  const participationRow = groupLine('resultaat_deelnemingen');
  if (participationRow) out.push(participationRow);

  // VANGNET. De database staat élke rapportagerubriek toe bij élk rekeningtype:
  // een opbrengstrekening kan de rubriek 'vorderingen' dragen. Zo'n regel zou door
  // geen enkele tak hierboven worden opgepikt en dus geruisloos uit een wettelijk
  // stuk verdwijnen, terwijl de sluitcontrole hem wél meetelt. Daarom krijgt elke
  // onbekende rubriek een eigen regel, meegeteld in het resultaat. De bedragen
  // staan hier als EFFECT OP HET RESULTAAT (positief = winstverhogend), omdat van
  // een onbekende rubriek niet vaststaat of zij een bate of een last is.
  const unknownGroups = [...new Set(lines.map((line) => line.group))]
    .filter((group) => !KNOWN_PL_GROUPS.has(group))
    .sort((a, b) => a.localeCompare(b, 'nl'));

  if (unknownGroups.length > 0) {
    out.push({ kind: 'spacer' });
    out.push({ kind: 'section', text: 'Posten met een niet-herkende rubriek' });
    for (const group of unknownGroups) {
      out.push({
        kind: 'line',
        cells: {
          label: humanizeGroup(group),
          current: fmtEuro(current.get(group) ?? 0),
          previous: fmtEuroOrDash(previous.get(group) ?? 0),
        },
      });
    }
    const affected = lines.filter((line) => unknownGroups.includes(line.group));
    out.push({
      kind: 'note',
      text:
        `LET OP - ${affected.length} rekening(en) zijn ingedeeld in een rubriek die niet in de ` +
        'winst-en-verliesrekening thuishoort: ' +
        `${affected.map((line) => `${line.code} ${line.name}`.trim()).join('; ')}. ` +
        'Zij zijn hier apart opgenomen en tellen mee in het resultaat, zodat er geen bedrag buiten de opstelling ' +
        'valt. Herstel de rubricering in het rekeningschema en maak de jaarrekening opnieuw op voordat u dit stuk ' +
        'vaststelt of deponeert.',
    });
  }

  const afterTax = (groups: Map<string, number>) =>
    preTax(groups) + (groups.get('belastingen') ?? 0) + (groups.get('resultaat_deelnemingen') ?? 0) +
    sumGroups(groups, unknownGroups);
  out.push({
    kind: 'result',
    cells: {
      label: 'Resultaat na belastingen',
      current: fmtEuro(afterTax(current)),
      previous: fmtEuroOrDash(afterTax(previous)),
    },
  });

  return out;
}

// ------------------------------------------------------------ kopgegevens
function entityLines(snapshot: Json, account: Json): string[] {
  const entity = obj(snapshot.entity);
  const fiscalYear = obj(snapshot.fiscalYear);
  const cityLine = [str(entity.postalCode), str(entity.city)].filter(Boolean).join(' ');
  const legalForm = str(entity.legalForm).toUpperCase();
  const size = effectiveSizeClass(account);

  const lines = [
    `${str(entity.companyName) || str(entity.organizationName)}${legalForm ? ` (${legalForm})` : ''}`,
    str(entity.tradeName) && str(entity.tradeName) !== str(entity.companyName) ? `Handelsnaam: ${str(entity.tradeName)}` : '',
    [str(entity.addressLine1), str(entity.addressLine2)].filter(Boolean).join(', '),
    [cityLine, str(entity.country)].filter(Boolean).join(', '),
    str(entity.kvkNumber) ? `KvK-nummer: ${str(entity.kvkNumber)}` : 'KvK-nummer: niet vastgelegd',
    str(entity.city) ? `Statutaire zetel: ${str(entity.city)}` : '',
    '',
    `Boekjaar ${str(fiscalYear.label)} (${fmtDateNl(str(fiscalYear.periodStart))} t/m ${fmtDateNl(str(fiscalYear.periodEnd))})`,
    `Grootteklasse: ${SIZE_CLASS_LABELS[size]} - ${SIZE_CLASS_ARTICLES[size]}`,
  ];
  return lines.filter((line) => line !== '');
}

function effectiveSizeClass(account: Json): SizeClass {
  const value = str(account.effectiveSizeClass) || str(account.sizeClass);
  return value === 'micro' || value === 'klein' || value === 'middelgroot' || value === 'groot' ? value : 'groot';
}

/** De markeringen die nooit mogen ontbreken: ingetrokken, verouderd, onvastgesteld. */
function statusBanners(account: Json): Block[] {
  const blocks: Block[] = [];

  if (str(account.status) === 'reversed') {
    blocks.push({
      type: 'banner',
      tone: 'warn',
      title: 'INGETROKKEN JAARREKENING',
      text:
        `Deze jaarrekening is ingetrokken op ${fmtDateNl(str(account.reversedAt))}` +
        `${str(account.reverseReason) ? ` met als reden: ${str(account.reverseReason)}` : ''}. ` +
        'Zij is geen geldende jaarrekening van de rechtspersoon en mag niet als zodanig worden gebruikt of gedeponeerd.',
    });
  }

  if (bool(account.snapshotStale)) {
    blocks.push({
      type: 'banner',
      tone: 'warn',
      title: 'LET OP: DE BEVROREN CIJFERS PASSEN NIET MEER BIJ DE ADMINISTRATIE',
      text:
        'Na het opmaken is het boekjaar heropend of is de resultaatbestemming vervangen. De cijfers in dit stuk zijn ' +
        'die van het moment van opmaken en wijken af van de huidige administratie. Controleer of dit stuk nog het ' +
        'juiste is; maak zo nodig een nieuwe jaarrekening op die de oude vervangt.',
    });
  }

  const reconciliation = obj(obj(account.snapshot).reconciliation);
  if (Object.keys(reconciliation).length > 0 && !bool(reconciliation.balances)) {
    blocks.push({
      type: 'banner',
      tone: 'warn',
      title: 'DE CIJFERS SLUITEN NIET AAN',
      text:
        `Balansverschil ${fmtEuro(num(reconciliation.balanceSheetDifferenceCents))}, ` +
        `proefbalansverschil ${fmtEuro(num(reconciliation.trialBalanceDifferenceCents))}. ` +
        'Een niet-sluitende balans mag niet worden vastgesteld of gedeponeerd.',
    });
  }

  return blocks;
}

// ------------------------------------------------------------ toelichtingsblokken
/**
 * De grondslagenparagraaf. LET OP WAT HIER NIET STAAT.
 *
 * ResoFly legt geen nalevingsverklaring af namens het bestuur. De zin "de
 * jaarrekening is opgesteld volgens de bepalingen van Titel 9 Boek 2 BW" is een
 * uitspraak die alleen de rechtspersoon kan doen; een tekstgenerator kan niet
 * weten of zij waar is. Hetzelfde geldt voor de alles-of-niets-voorwaarde van
 * art. 2:396 lid 6 BW: dat ALLE geldende fiscale grondslagen zijn toegepast, kan
 * ResoFly niet vaststellen — het is de voorwaarde zelf, niet de constatering.
 *
 * Daarom is alles hieronder CONSTATEREND geformuleerd ("de in deze administratie
 * gehanteerde grondslag is ...") en staan de acht waarderingsregels als een
 * VOORSTEL dat per post moet worden gecontroleerd, met het voorbehoud vóór de
 * lijst en op normale grootte — niet als kleine letter erachter.
 */
function accountingPolicies(account: Json): Block[] {
  const basis = str(account.accountingBasis) || 'commercieel';
  const blocks: Block[] = [
    { type: 'heading', level: 1, text: 'Grondslagen voor waardering en resultaatbepaling' },
    {
      type: 'paragraph',
      text:
        'De in deze administratie vastgelegde waarderingsgrondslag is ' +
        `${basis === 'fiscaal' ? 'fiscaal' : 'commercieel'}. Bedragen luiden in euro. Art. 2:384 lid 5 BW verlangt ` +
        'dat de grondslagen van de waardering van de activa en de passiva en van de bepaling van het resultaat met ' +
        'betrekking tot elk der posten worden uiteengezet.',
    },
    {
      type: 'banner',
      tone: 'info',
      title: 'VOORSTELTEKST - CONTROLEER EN PAS AAN PER POST',
      text:
        'De hieronder opgesomde grondslagen zijn door ResoFly gegenereerd op basis van de gekozen grondslag. Zij zijn ' +
        'een voorstel en géén weergave van wat de rechtspersoon werkelijk heeft toegepast: ResoFly kan dat niet ' +
        'vaststellen. Vervang of vul aan wat afwijkt. De rechtspersoon is verantwoordelijk voor de jaarrekening; ' +
        'ResoFly is een hulpmiddel en legt geen verklaring af over de naleving van Titel 9 Boek 2 BW.',
    },
  ];

  if (basis === 'fiscaal') {
    blocks.push({
      type: 'paragraph',
      text:
        'Als grondslag is in deze administratie gekozen voor de waarderingsgrondslagen die gelden voor de bepaling ' +
        'van de belastbare winst, bedoeld in hoofdstuk II van de Wet op de vennootschapsbelasting 1969 ' +
        '(art. 2:396 lid 6 BW). Die bepaling verbindt aan deze keuze de voorwaarde dat ALLE voor de rechtspersoon ' +
        'geldende fiscale grondslagen worden toegepast - de keuze is alles-of-niets - en dat daarvan melding wordt ' +
        'gemaakt. Of aan die voorwaarde is voldaan, stelt de rechtspersoon zelf vast; ResoFly constateert alleen de ' +
        'gemaakte keuze en verklaart niet dat aan de voorwaarde is voldaan.',
    });
  } else {
    blocks.push({
      type: 'paragraph',
      text:
        'Voorstel: activa en passiva worden gewaardeerd tegen verkrijgings- of vervaardigingsprijs, verminderd met de ' +
        'noodzakelijk geachte afschrijvingen en waardeverminderingen, tenzij bij de betreffende post anders is vermeld.',
    });
  }

  blocks.push({
    type: 'bullets',
    items: [
      'Immateriële en materiële vaste activa: verkrijgings- of vervaardigingsprijs, verminderd met lineaire afschrijvingen op basis van de verwachte gebruiksduur en met bijzondere waardeverminderingen.',
      'Financiële vaste activa: verkrijgingsprijs, verminderd met duurzame waardeverminderingen.',
      'Voorraden: verkrijgings- of vervaardigingsprijs, of lagere opbrengstwaarde.',
      'Vorderingen: nominale waarde, verminderd met een voorziening voor oninbaarheid.',
      'Liquide middelen: nominale waarde; zij staan ter vrije beschikking tenzij anders vermeld.',
      'Voorzieningen: beste schatting van de bedragen die noodzakelijk zijn om de verplichting per balansdatum af te wikkelen.',
      'Schulden: nominale waarde.',
      'Resultaatbepaling: baten en lasten worden toegerekend aan het jaar waarop zij betrekking hebben; opbrengsten worden verantwoord in het jaar waarin de prestatie is geleverd.',
    ],
  });

  if (str(account.policyChangeNote)) {
    blocks.push({ type: 'heading', level: 2, text: 'Stelselwijziging (art. 2:384 lid 6 BW)' });
    blocks.push({ type: 'paragraph', text: str(account.policyChangeNote) });
  }

  return blocks;
}

/**
 * Het verloop van het eigen vermogen — en de enige plek in het stuk waar de
 * wettelijke en statutaire reserves apart zichtbaar zijn.
 *
 * TWEE DINGEN DIE HIER NIET MEER GEBEUREN.
 *   1. Een leeg verloopoverzicht liet dit blok verdwijnen zónder melding, en
 *      daarmee ook de reserves en de art. 2:216-waarschuwing. Nu komt er een
 *      expliciete regel in de plaats.
 *   2. Voor een kleine rechtspersoon verlangt art. 2:396 lid 5 BW het overzicht
 *      van art. 2:378 lid 1 BW slechts voor de HERWAARDERINGSRESERVE. ResoFly
 *      kan die reserve niet als zodanig herkennen in het rekeningschema; daarom
 *      wordt bij `scope: 'standen'` alleen de uitsplitsing van het eigen vermogen
 *      per balansdatum getoond en niet het verloop. Publiceren wat de wet niet
 *      vraagt, is niet terug te draaien.
 */
function equityMovementBlocks(snapshot: Json, opts: { scope: 'verloop' | 'standen' }): Block[] {
  const movement = rows(snapshot.equityMovement);

  if (movement.length === 0) {
    return [
      { type: 'heading', level: 2, text: 'Eigen vermogen' },
      {
        type: 'paragraph',
        text:
          'Het verloop van het eigen vermogen kon niet worden opgebouwd uit de bevroren cijfers. Daardoor zijn de ' +
          'wettelijke en statutaire reserves in dit stuk niet afzonderlijk zichtbaar en ontbreekt de toets of het ' +
          'eigen vermogen groter is dan de reserves die krachtens de wet of de statuten moeten worden aangehouden ' +
          '(art. 2:216 lid 1 BW). Controleer dit voordat u dit stuk gebruikt, vaststelt of deponeert.',
      },
    ];
  }

  const showMovement = opts.scope === 'verloop';
  const cols: Col[] = showMovement
    ? [
      { key: 'label', width: 199, align: 'left' },
      { key: 'opening', width: 100, align: 'right', header: 'Stand begin' },
      { key: 'movement', width: 100, align: 'right', header: 'Mutatie' },
      { key: 'closing', width: 100, align: 'right', header: 'Stand eind' },
    ]
    : [
      { key: 'label', width: 349, align: 'left' },
      { key: 'closing', width: 150, align: 'right', header: 'Stand eind' },
    ];

  const toRow = (line: Json): Row => ({
    kind: 'line',
    cells: {
      label: `${str(line.code)} ${str(line.name)}`.trim(),
      opening: fmtEuro(num(line.openingCents)),
      movement: fmtEuro(num(line.movementCents)),
      closing: fmtEuro(num(line.closingCents)),
    },
  });

  const isRestricted = (line: Json) =>
    bool(line.isRestrictedReserve) || str(line.subtype) === 'legal_reserve' || str(line.subtype) === 'statutory_reserve';

  const free = movement.filter((line) => !isRestricted(line));
  const restricted = movement.filter(isRestricted);

  const total = (lines: Json[], key: string) => lines.reduce((acc, line) => acc + num(line[key]), 0);

  const tableRows: Row[] = [];
  if (free.length > 0) {
    tableRows.push({ kind: 'section', text: 'Vrij besteedbaar eigen vermogen' });
    tableRows.push(...free.map(toRow));
  }
  if (restricted.length > 0) {
    tableRows.push({ kind: 'spacer' });
    tableRows.push({ kind: 'section', text: 'Wettelijke en statutaire reserves' });
    tableRows.push(...restricted.map(toRow));
    tableRows.push({
      kind: 'sub',
      cells: {
        label: 'Totaal wettelijke en statutaire reserves',
        opening: fmtEuro(total(restricted, 'openingCents')),
        movement: fmtEuro(total(restricted, 'movementCents')),
        closing: fmtEuro(total(restricted, 'closingCents')),
      },
    });
  }
  tableRows.push({
    kind: 'result',
    cells: {
      label: 'Totaal eigen vermogen',
      opening: fmtEuro(total(movement, 'openingCents')),
      movement: fmtEuro(total(movement, 'movementCents')),
      closing: fmtEuro(total(movement, 'closingCents')),
    },
  });

  const reserveNote = restricted.length > 0
    ? 'De wettelijke en statutaire reserves zijn afzonderlijk vermeld. De algemene vergadering is slechts bevoegd tot ' +
      'uitkeringen voor zover het eigen vermogen groter is dan deze reserves (art. 2:216 lid 1 BW); daarnaast is de ' +
      'goedkeuring van het bestuur vereist (art. 2:216 lid 2 BW).'
    : 'Er zijn geen rekeningen aangemerkt als wettelijke of statutaire reserve. ResoFly leidt die niet automatisch af; ' +
      'markeer een reserve zelf in het rekeningschema als de wet haar voorschrijft (art. 2:365 lid 2, 2:389 en 2:390 BW).';

  const scopeNote = showMovement
    ? ''
    : ' Art. 2:396 lid 5 BW verlangt van een kleine rechtspersoon het overzicht van art. 2:378 lid 1 BW slechts voor ' +
      'de herwaarderingsreserve. ResoFly herkent die reserve niet als zodanig in het rekeningschema; daarom is hier ' +
      'alleen de uitsplitsing van het eigen vermogen per balansdatum opgenomen en niet het verloop.';

  return [
    { type: 'heading', level: 2, text: showMovement ? 'Verloop van het eigen vermogen' : 'Eigen vermogen per balansdatum' },
    { type: 'table', cols, rows: tableRows, note: `${reserveNote}${scopeNote}` },
  ];
}

/**
 * Geplaatst en gestort kapitaal. Staat BEWUST los van het verloopoverzicht: die
 * twee vielen eerder samen weg zodra `equityMovement` leeg was.
 *
 * `detail: 'totalen'` toont uitsluitend de totalen per aandelensoort. De wet
 * verlangt het geplaatste en gestorte kapitaal (art. 2:373 BW), géén naamsgewijze
 * uitsplitsing per aandeelhouder. Namen en vermogenspositie van natuurlijke
 * personen horen niet in een stuk dat het handelsregister in gaat — dat is niet
 * terug te draaien. Alleen het interne stuk krijgt `detail: 'namen'`.
 */
function shareCapitalBlocks(snapshot: Json, opts: { detail: 'namen' | 'totalen' }): Block[] {
  const shareholders = rows(snapshot.shareholders);
  if (shareholders.length === 0) return [];

  const cols: Col[] = [
    { key: 'label', width: 219, align: 'left' },
    { key: 'shares', width: 90, align: 'right', header: 'Aandelen' },
    { key: 'nominal', width: 95, align: 'right', header: 'Nominaal' },
    { key: 'paid', width: 95, align: 'right', header: 'Gestort' },
  ];

  const cell = (label: string, holders: Json[]): Row => ({
    kind: 'line',
    cells: {
      label,
      shares: fmtNumberNl(holders.reduce((acc, holder) => acc + num(holder.shares), 0), 0),
      nominal: fmtEuro(holders.reduce((acc, holder) => acc + num(holder.nominalCents), 0)),
      paid: fmtEuro(holders.reduce((acc, holder) => acc + num(holder.paidUpCents), 0)),
    },
  });

  const detailRows: Row[] = [];
  if (opts.detail === 'namen') {
    for (const holder of shareholders) {
      detailRows.push(cell(
        `${str(holder.name)}${str(holder.shareClass) ? ` (${str(holder.shareClass)})` : ''}`,
        [holder],
      ));
    }
  } else {
    const classes = new Map<string, Json[]>();
    for (const holder of shareholders) {
      const key = str(holder.shareClass) || 'Aandelen';
      classes.set(key, [...(classes.get(key) ?? []), holder]);
    }
    for (const [shareClass, holders] of [...classes.entries()].sort((a, b) => a[0].localeCompare(b[0], 'nl'))) {
      detailRows.push(cell(shareClass, holders));
    }
  }

  return [
    { type: 'heading', level: 2, text: 'Geplaatst en gestort kapitaal' },
    {
      type: 'table',
      cols,
      rows: [...detailRows, { ...cell('Totaal', shareholders), kind: 'total' }],
      note: opts.detail === 'totalen'
        ? 'Het geplaatste en gestorte kapitaal is per aandelensoort weergegeven. De namen van de aandeelhouders en hun ' +
          'individuele bezit worden hier niet vermeld: art. 2:373 BW verlangt het kapitaal, geen naamsgewijze ' +
          'uitsplitsing, en dit stuk is bestemd om openbaar te worden gemaakt.'
        : '',
    },
  ];
}

function balanceNotes(
  account: Json,
  snapshot: Json,
  opts: {
    shareholders: 'geen' | 'namen' | 'totalen';
    equityScope: 'verloop' | 'standen';
    omit380a: boolean;
  },
): Block[] {
  const size = obj(snapshot.size);
  const current = obj(size.current);
  const employees = numOrNull(current.employees);
  const blocks: Block[] = [{ type: 'heading', level: 1, text: 'Toelichting op de balans' }];

  blocks.push(...equityMovementBlocks(snapshot, { scope: opts.equityScope }));
  if (opts.shareholders !== 'geen') {
    blocks.push(...shareCapitalBlocks(snapshot, { detail: opts.shareholders }));
  }

  blocks.push({ type: 'heading', level: 2, text: 'Niet in de balans opgenomen verplichtingen (art. 2:381 lid 1 BW)' });
  // GEEN werkinstructie in een stuk dat wordt vastgesteld en gedeponeerd, en geen
  // zin die voor een derde leest als "die zijn er niet". Ontbreekt de opgave, dan
  // constateert het stuk dát zij ontbreekt — meer kan ResoFly niet weten.
  blocks.push({
    type: 'paragraph',
    text: str(account.offBalanceCommitments) ||
      'Bij het opmaken van deze jaarrekening is in deze administratie geen opgave vastgelegd van belangrijke, niet ' +
      'in de balans opgenomen financiële verplichtingen. Dit stuk doet daarover dus geen uitspraak. Art. 2:381 ' +
      'lid 1 BW verlangt die vermelding wel, ook van een kleine rechtspersoon.',
  });

  blocks.push({ type: 'heading', level: 2, text: 'Gemiddeld aantal werknemers (art. 2:382 BW)' });
  blocks.push({
    type: 'paragraph',
    text: employees === null
      ? 'Het gemiddelde aantal werknemers over het boekjaar is niet vastgelegd.'
      : `Gedurende het boekjaar waren gemiddeld ${fmtNumberNl(employees, 2)} werknemers in dienst. Een kleine ` +
        'rechtspersoon vermeldt van de gegevens van art. 2:382 BW slechts dit gemiddelde (art. 2:396 lid 5 BW).',
  });

  const parentName = str(current.consolidatingParentName) || str(size.consolidatingParentName);
  const parentCity = str(current.consolidatingParentCity) || str(size.consolidatingParentCity);
  if (parentName) {
    blocks.push({ type: 'heading', level: 2, text: 'Consoliderende maatschappij (art. 2:396 lid 5 BW)' });
    blocks.push({
      type: 'paragraph',
      text: `De gegevens van de rechtspersoon zijn opgenomen in de geconsolideerde jaarrekening van ${parentName}` +
        `${parentCity ? `, gevestigd te ${parentCity}` : ''}.`,
    });
  }

  if (opts.omit380a) {
    blocks.push({
      type: 'paragraph',
      italic: true,
      muted: true,
      small: true,
      text:
        'In de openbaar gemaakte toelichting blijven de gegevens bedoeld in art. 2:380a BW achterwege ' +
        '(art. 2:396 lid 8 BW). De gedeponeerde toelichting is daardoor een ander document dan de vastgestelde ' +
        'toelichting. Welke gegevens precies onder art. 2:380a BW vallen is in ResoFly niet geverifieerd; ' +
        'bespreek dit met uw accountant voordat u deponeert.',
    });
  }

  return blocks;
}

/**
 * De toelichting op de W&V. `scope: 'openbaar'` laat de volledige fiscale
 * reconciliatie WEG: de wet verlangt een uiteenzetting van de belastingen over
 * het resultaat, niet dat de fiscale correcties en het verloop van verrekenbare
 * verliezen openbaar worden gemaakt. Die route blootleggen in een stuk dat het
 * register in gaat is meer dan nodig en niet terug te draaien.
 */
function profitAndLossNotes(snapshot: Json, opts: { scope: 'volledig' | 'openbaar' } = { scope: 'volledig' }): Block[] {
  const tax = obj(snapshot.corporateTax);
  if (Object.keys(tax).length === 0) {
    return [
      { type: 'heading', level: 1, text: 'Toelichting op de winst-en-verliesrekening' },
      {
        type: 'paragraph',
        text:
          'Er is voor dit boekjaar geen vennootschapsbelastingberekening vastgelegd. De post Belastingen over het ' +
          'resultaat is daardoor niet nader toegelicht.',
      },
    ];
  }

  const status = str(tax.status) || 'onbekend';
  const draftNote = status === 'concept' || status === 'draft'
    ? ' LET OP: de aangifte heeft de status "concept" en is dus nog niet ingediend. Een nog niet ingediende aangifte ' +
      'is geen definitieve onderbouwing van een vast te stellen of te deponeren stuk.'
    : '';

  if (opts.scope === 'openbaar') {
    const result = num(tax.commercialResultCents);
    const taxCents = num(tax.taxCents);
    const effective = result !== 0 ? `${fmtNumberNl((taxCents / result) * 100, 1)}%` : 'niet te bepalen';
    return [
      { type: 'heading', level: 1, text: 'Toelichting op de winst-en-verliesrekening' },
      { type: 'heading', level: 2, text: 'Belastingen over het resultaat' },
      {
        type: 'table',
        cols: [
          { key: 'label', width: 349, align: 'left' },
          { key: 'amount', width: 150, align: 'right', header: 'Boekjaar' },
        ],
        rows: [
          { kind: 'line', cells: { label: 'Last wegens vennootschapsbelasting over het resultaat', amount: fmtEuro(taxCents) } },
          { kind: 'line', cells: { label: 'Effectieve belastingdruk over het commerciële resultaat', amount: effective } },
        ],
        note:
          `Berekend over boekjaar ${str(tax.year)}; de vastgelegde aangifte heeft de status "${status}".${draftNote} ` +
          'De aansluiting tussen het commerciële resultaat en het belastbare bedrag - fiscale correcties en ' +
          'verrekende verliezen uit voorgaande jaren - is opgenomen in de vastgestelde jaarrekening en wordt hier ' +
          'niet openbaar gemaakt.',
      },
    ];
  }

  return [
    { type: 'heading', level: 1, text: 'Toelichting op de winst-en-verliesrekening' },
    { type: 'heading', level: 2, text: 'Belastingen over het resultaat' },
    {
      type: 'table',
      cols: [
        { key: 'label', width: 349, align: 'left' },
        { key: 'amount', width: 150, align: 'right', header: 'Boekjaar' },
      ],
      rows: [
        { kind: 'line', cells: { label: 'Commercieel resultaat', amount: fmtEuro(num(tax.commercialResultCents)) } },
        { kind: 'line', cells: { label: 'Fiscale correcties', amount: fmtEuro(num(tax.correctionsCents)) } },
        { kind: 'sub', cells: { label: 'Fiscale winst', amount: fmtEuro(num(tax.fiscalProfitCents)) } },
        { kind: 'line', cells: { label: 'Verrekend verlies uit voorgaande jaren', amount: fmtEuro(-num(tax.lossUsedCents)) } },
        { kind: 'sub', cells: { label: 'Belastbaar bedrag', amount: fmtEuro(num(tax.taxableAmountCents)) } },
        { kind: 'result', cells: { label: 'Verschuldigde vennootschapsbelasting', amount: fmtEuro(num(tax.taxCents)) } },
      ],
      note:
        `Berekening volgens de aangifte met status "${status}" over ${str(tax.year)}.${draftNote} ` +
        'De aangifte zelf wordt door de rechtspersoon ingediend; ResoFly berekent en legt vast, maar dient niet in.',
    },
  ];
}

function resultAppropriationBlocks(snapshot: Json): Block[] {
  const appropriation = obj(snapshot.resultAppropriation);
  const fiscalYear = obj(snapshot.fiscalYear);
  if (Object.keys(appropriation).length === 0) {
    return [
      { type: 'heading', level: 1, text: 'Resultaatbestemming' },
      {
        type: 'paragraph',
        text:
          'Er is geen geboekt bestemmingsbesluit gevonden bij deze jaarrekening. Dat hoort niet te kunnen: de balans ' +
          'in dit stuk is opgesteld ná resultaatbestemming. Controleer het boekjaar voordat u dit stuk gebruikt.',
      },
    ];
  }

  return [
    { type: 'heading', level: 1, text: 'Resultaatbestemming' },
    {
      type: 'table',
      cols: [
        { key: 'label', width: 349, align: 'left' },
        { key: 'amount', width: 150, align: 'right', header: 'Bedrag' },
      ],
      rows: [
        { kind: 'line', cells: { label: `Resultaat boekjaar ${str(fiscalYear.label)}`, amount: fmtEuro(num(appropriation.resultCents)) } },
        { kind: 'line', cells: { label: 'Toevoeging aan de reserves', amount: fmtEuro(num(appropriation.reservesCents)) } },
        { kind: 'line', cells: { label: 'Uitkering aan aandeelhouders (dividend)', amount: fmtEuro(num(appropriation.dividendCents)) } },
        { kind: 'spacer' },
        {
          kind: 'line',
          cells: {
            label: 'Vrij uitkeerbaar eigen vermogen op balansdatum',
            amount: fmtEuro(num(snapshot.distributableEquityCents)),
          },
        },
      ],
      note:
        'Het vrij uitkeerbare eigen vermogen is berekend over de rekeningen van het eigen vermogen op balansdatum. ' +
        'Het resultaat van een lopend boekjaar telt daarin NIET mee; het is dus geen volledige weergave van de ' +
        'uitkeringsruimte. De balanstest van art. 2:216 lid 1 BW en de uitkeringstest van lid 2 (goedkeuring van het ' +
        'bestuur) blijven de verantwoordelijkheid van de vennootschap.',
    },
    {
      type: 'keyValues',
      pairs: [
        ['Besluitdatum', fmtDateNl(str(appropriation.decisionDate)) || 'niet vastgelegd'],
        ['Goedgekeurd door het bestuur', bool(appropriation.boardApproved) ? 'ja (art. 2:216 lid 2 BW)' : 'niet vastgelegd'],
        ['Toelichting', str(appropriation.note) || '-'],
      ],
    },
  ];
}

function signatureBlocks(account: Json): Block[] {
  const signatures = rows(account.signatures);
  const signers: Signer[] = signatures.map((signature) => ({
    name: str(signature.personName),
    role: str(signature.role),
    signed: bool(signature.signed),
    signedOn: fmtDateNl(str(signature.signedOn)) || null,
    missingReason: str(signature.missingReason) || null,
  }));

  const blocks: Block[] = [
    { type: 'heading', level: 1, text: 'Ondertekening' },
    {
      type: 'paragraph',
      text:
        `Opgemaakt door het bestuur op ${fmtDateNl(str(account.preparedOn))} (art. 2:210 lid 1 BW). De jaarrekening ` +
        'wordt ondertekend door de bestuurders en door de commissarissen; ontbreekt de ondertekening van een of meer ' +
        'van hen, dan wordt daarvan onder opgave van reden melding gemaakt (art. 2:210 lid 2 BW).',
    },
  ];

  if (signers.length === 0) {
    blocks.push({
      type: 'paragraph',
      italic: true,
      text: 'Er zijn geen ondertekenaars vastgelegd bij deze jaarrekening.',
    });
    return blocks;
  }

  blocks.push({ type: 'spacer', height: 8 });
  blocks.push({ type: 'signatures', signers });
  return blocks;
}

/**
 * De ondertekeningsvermelding voor het OPENBAAR TE MAKEN stuk.
 *
 * Art. 2:210 lid 2 BW verlangt dat van een ontbrekende handtekening melding wordt
 * gemaakt ONDER OPGAVE VAN REDEN, en die melding hoort in de jaarrekening zelf —
 * dus ook in het (beperkte) stuk dat openbaar wordt gemaakt. Die vermelding
 * ontbrak hier volledig. Geen handtekeningstrepen: dit stuk wordt niet getekend,
 * het wordt gedeponeerd. Wel de namen, de rollen en per ontbrekende handtekening
 * de opgegeven reden.
 */
function signatureDisclosureBlocks(account: Json): Block[] {
  const signatures = rows(account.signatures);
  const blocks: Block[] = [
    { type: 'heading', level: 1, text: 'Ondertekening (art. 2:210 lid 2 BW)' },
    {
      type: 'paragraph',
      text:
        `Opgemaakt door het bestuur op ${fmtDateNl(str(account.preparedOn)) || 'een niet vastgelegde datum'} ` +
        '(art. 2:210 lid 1 BW). De jaarrekening wordt ondertekend door de bestuurders en door de commissarissen; ' +
        'ontbreekt de ondertekening van een of meer van hen, dan wordt daarvan onder opgave van reden melding ' +
        'gemaakt (art. 2:210 lid 2 BW).',
    },
  ];

  if (signatures.length === 0) {
    blocks.push({
      type: 'banner',
      tone: 'warn',
      title: 'GEEN ONDERTEKENAARS VASTGELEGD',
      text:
        'Er zijn bij deze jaarrekening geen bestuurders of commissarissen als ondertekenaar vastgelegd. De melding ' +
        'van art. 2:210 lid 2 BW kan daardoor niet worden opgemaakt en dit stuk is in die zin onvolledig.',
    });
    return blocks;
  }

  const items = signatures.map((signature) => {
    const who = `${str(signature.personName) || 'naam niet vastgelegd'}` +
      `${str(signature.role) ? ` (${str(signature.role)})` : ''}`;
    if (bool(signature.signed)) {
      const on = fmtDateNl(str(signature.signedOn));
      return `${who}: ondertekend${on ? ` op ${on}` : ''}.`;
    }
    const reason = str(signature.missingReason);
    return reason
      ? `${who}: NIET ondertekend. Opgave van reden: ${reason}`
      : `${who}: NIET ondertekend. Er is geen reden opgegeven, terwijl art. 2:210 lid 2 BW die opgave verlangt.`;
  });

  blocks.push({ type: 'bullets', items });

  const missingWithoutReason = signatures.filter(
    (signature) => !bool(signature.signed) && !str(signature.missingReason),
  );
  if (missingWithoutReason.length > 0) {
    blocks.push({
      type: 'banner',
      tone: 'warn',
      title: 'ONTBREKENDE HANDTEKENING ZONDER OPGAVE VAN REDEN',
      text:
        `Bij ${missingWithoutReason.length} ondertekenaar(s) ontbreekt de handtekening zonder dat een reden is ` +
        'vastgelegd. Art. 2:210 lid 2 BW verlangt dat van een ontbrekende ondertekening melding wordt gemaakt onder ' +
        'opgave van reden. Leg die reden vast voordat u dit stuk openbaar maakt.',
    });
  }

  return blocks;
}

function adoptionBlocks(account: Json): Block[] {
  const method = str(account.adoptionMethod);
  const blocks: Block[] = [{ type: 'heading', level: 1, text: 'Vaststelling' }];

  if (!str(account.adoptionDate)) {
    blocks.push({
      type: 'paragraph',
      text:
        'Deze jaarrekening is nog NIET vastgesteld. Is zij niet binnen twee maanden na afloop van de opmaaktermijn ' +
        'vastgesteld, dan maakt het bestuur de opgemaakte jaarrekening onverwijld openbaar met de vermelding dat zij ' +
        'nog niet is vastgesteld (art. 2:394 lid 2 BW).',
    });
    return blocks;
  }

  // Art. 2:210 lid 5 BW werkt ALLEEN als aan alle drie de voorwaarden is voldaan.
  // Is dat niet bevestigd, dan geldt de ondertekening niet als vaststelling, is er
  // geen vastgestelde jaarrekening en is er ook geen kwijting verleend. Dat mag
  // dus nooit als voldongen feit worden afgedrukt.
  const viaSignature = method === 'signature_210_5';
  const conditions: Array<{ text: string; met: boolean }> = [
    { text: 'Alle aandeelhouders zijn tevens bestuurder', met: bool(account.allShareholdersAreDirectors) },
    {
      text:
        'Alle overige vergadergerechtigden zijn in de gelegenheid gesteld kennis te nemen van de opgemaakte ' +
        'jaarrekening en hebben met deze wijze van vaststelling ingestemd (art. 2:238 lid 1 BW)',
      met: bool(account.otherMeetingRightsInformed),
    },
    { text: 'De statuten sluiten deze wijze van vaststelling niet uit', met: bool(account.articlesAllow2105) },
  ];
  const unmet = conditions.filter((condition) => !condition.met);
  const confirmed = viaSignature && unmet.length === 0;

  blocks.push({
    type: 'keyValues',
    pairs: [
      ['Vastgesteld op', fmtDateNl(str(account.adoptionDate))],
      [
        'Wijze van vaststelling',
        viaSignature
          ? `ondertekening door alle bestuurders en commissarissen (art. 2:210 lid 5 BW)${confirmed ? '' : ' - VOORWAARDEN NIET BEVESTIGD'}`
          : 'besluit van de algemene vergadering (art. 2:210 lid 3 BW)',
      ],
      [
        'Kwijting (décharge) verleend',
        viaSignature && !confirmed
          ? 'niet vast te stellen zolang de voorwaarden van art. 2:210 lid 5 BW niet zijn bevestigd'
          : (bool(account.dischargeGranted) ? 'ja' : 'nee'),
      ],
    ],
  });

  if (viaSignature) {
    if (confirmed) {
      blocks.push({
        type: 'paragraph',
        text:
          'Alle aandeelhouders zijn tevens bestuurder en de drie voorwaarden van art. 2:210 lid 5 BW zijn bevestigd. ' +
          'De ondertekening van deze jaarrekening geldt daarom tevens als vaststelling én — in afwijking van ' +
          'art. 2:210 lid 3 BW — als kwijting aan de bestuurders en commissarissen.',
      });
    } else {
      blocks.push({
        type: 'banner',
        tone: 'warn',
        title: 'DE VASTSTELLING LANGS DEZE WEG STAAT NIET VAST',
        text:
          'Vaststelling door ondertekening werkt alleen als aan alle drie de voorwaarden van art. 2:210 lid 5 BW is ' +
          `voldaan. In deze administratie is niet bevestigd: ${unmet.map((condition) => condition.text.toLowerCase()).join('; ')}. ` +
          'Zolang dat zo is, geldt de ondertekening NIET als vaststelling, is er geen vastgestelde jaarrekening en is ' +
          'er langs deze weg ook geen kwijting verleend. Deponeer dit stuk dan niet als vastgesteld stuk; art. 2:394 ' +
          'lid 1 BW knoopt de deponeertermijn juist aan de dag van vaststelling.',
      });
    }
    blocks.push({
      type: 'bullets',
      items: conditions.map((condition) => `${condition.text}: ${condition.met ? 'bevestigd' : 'NIET bevestigd'}.`),
    });
  } else {
    blocks.push({
      type: 'paragraph',
      text:
        'Vaststelling van de jaarrekening strekt niet tot kwijting aan een bestuurder of commissaris; kwijting is een ' +
        'afzonderlijk besluit van de algemene vergadering (art. 2:210 lid 3 BW).',
    });
  }

  return blocks;
}

/** Bestuursverslag, accountantsverklaring en overige gegevens: benoemen, niet genereren. */
function externalDocumentsChecklist(account: Json, set: PublicationSet): Block[] {
  const items: Array<{ label: string; text: string }> = [];

  if (set.managementReport) {
    items.push({
      label: 'Bestuursverslag (art. 2:391 BW)',
      text: 'Verplicht voor deze grootteklasse. ResoFly genereert het niet; voeg het als bijlage bij de jaarrekening en bij de deponering.',
    });
  }
  if (set.auditorOpinion) {
    items.push({
      label: 'Accountantsverklaring (art. 2:393 BW)',
      text: bool(account.auditorOpinionReceived)
        ? `Ontvangen${str(account.auditorName) ? ` van ${str(account.auditorName)}` : ''}. Voeg de verklaring zelf bij; ResoFly genereert haar niet.`
        : (str(account.auditorMissingGround)
          ? `Nog niet ontvangen. Vastgelegde wettige grond waarom de verklaring ontbreekt: ${str(account.auditorMissingGround)} (art. 2:393 lid 7 BW).`
          : 'De jaarrekening kan niet worden vastgesteld zolang het bevoegde orgaan geen kennis heeft kunnen nemen van de verklaring van de accountant, tenzij onder de overige gegevens een wettige grond wordt meegedeeld waarom zij ontbreekt (art. 2:393 lid 7 BW).'),
    });
  }
  if (set.otherInformation) {
    items.push({
      label: 'Overige gegevens (art. 2:392 BW)',
      text: 'Onder meer de statutaire regeling omtrent de bestemming van de winst en het voorstel daartoe, bijzondere zeggenschapsrechten, winstbewijzen en nevenvestigingen. ResoFly genereert deze gegevens niet.',
    });
  }
  // Ook toelichtingsONDERDELEN kunnen ontbreken. Die stonden nergens benoemd,
  // terwijl de omslag wel een toelichting beloofde.
  if (set.notes === 'extended' || set.notes === 'full') {
    items.push({
      label: 'Toelichtingsonderdelen die ResoFly niet opstelt',
      text:
        'De bezoldiging van bestuurders en commissarissen (art. 2:383 BW), de honoraria van de accountantsorganisatie ' +
        '(art. 2:382a BW) en de volledige opgave van werknemers per bedrijfsonderdeel en buiten Nederland ' +
        '(art. 2:382 BW) worden niet gegenereerd. Voor deze grootteklasse horen zij wel in de toelichting; vul ze ' +
        'zelf aan voordat u het stuk vaststelt of deponeert.',
    });
  }

  if (items.length === 0) return [];

  return [
    {
      type: 'checklist',
      title: 'Stukken die ResoFly niet genereert',
      intro:
        'Voor deze grootteklasse horen de volgende stukken bij de jaarrekening en bij de deponering. Zij worden bewust ' +
        'niet gegenereerd: een gegenereerde accountantsverklaring zou per definitie vals zijn en een bestuursverslag is ' +
        'een verklaring van het bestuur zelf.',
      items,
    },
  ];
}

// ------------------------------------------------------------ het volledige stuk
export function buildAnnualAccountsDocument(
  account: Json,
  opts: { accentColor?: string | null } = {},
): ReportDocument {
  const snapshot = obj(account.snapshot);
  const entity = obj(snapshot.entity);
  const fiscalYear = obj(snapshot.fiscalYear);
  const size = obj(snapshot.size);
  const sizeClass = effectiveSizeClass(account);
  const set = PUBLICATION_SETS[sizeClass];
  const companyName = str(entity.companyName) || str(entity.organizationName) || 'Rechtspersoon';
  const label = str(fiscalYear.label) || fmtDateNl(str(fiscalYear.periodEnd));

  const currentHeader = fmtDateNl(str(fiscalYear.periodEnd));
  const previousHeader = previousHeaderFor(snapshot);

  const blocks: Block[] = [];

  blocks.push({
    type: 'coverTitle',
    title: `Jaarrekening ${label}`,
    subtitle: companyName,
    lines: entityLines(snapshot, account),
  });
  blocks.push(...statusBanners(account));

  const warnings = Array.isArray(size.warnings) ? size.warnings.map((warning) => str(warning)).filter(Boolean) : [];

  blocks.push({
    type: 'keyValues',
    pairs: [
      ['Opgemaakt op', fmtDateNl(str(account.preparedOn))],
      ['Opmaaktermijn verstrijkt', `${fmtDateNl(str(obj(account.deadlines).prepareDeadlineExtended) || str(account.prepareDeadline))} (art. 2:210 lid 1 BW)`],
      ['Waarderingsgrondslag', str(account.accountingBasis) === 'fiscaal' ? 'fiscaal (art. 2:396 lid 6 BW)' : 'commercieel'],
      // GEEN kale juridische conclusie. Of er controleplicht bestaat volgt uit de
      // grootteklasse, en die klasse draagt erkende gebreken (groepsmaatschappijen
      // tellen niet mee, het balanstotaal komt op boekwaarde uit het grootboek).
      // Daarom als BEREKENING met de grondslag erbij, en met een verwijzing naar de
      // kanttekeningen op dezelfde regel.
      [
        'Controleplicht volgens de ingevoerde gegevens',
        `${bool(account.auditRequired) ? 'ja' : 'nee'} - berekend uit de grootteklasse ` +
        `${SIZE_CLASS_LABELS[sizeClass]}; grondslag: ` +
        `${bool(account.auditRequired) ? 'art. 2:393 lid 1 BW' : 'de vrijstelling van art. 2:396 lid 7 BW'}` +
        `${warnings.length > 0 ? '. LET OP: zie de kanttekeningen bij de groottebepaling hieronder' : ''}`,
      ],
      ['Stand', statusLabel(account)],
      ['Kenmerk bevroren cijfers', `sha256 ${str(account.snapshotHash).slice(0, 32)}...`],
    ],
  });

  if (str(account.sizeClassOverride)) {
    blocks.push({
      type: 'banner',
      tone: 'info',
      title: 'Grootteklasse handmatig vastgesteld',
      text:
        `De berekende klasse was ${str(account.sizeClass) || 'onbepaald'}; deze jaarrekening berust op ` +
        `${str(account.sizeClassOverride)}. Reden: ${str(account.sizeOverrideReason) || 'niet vastgelegd'}.`,
    });
  }

  if (warnings.length > 0) {
    blocks.push({ type: 'heading', level: 3, text: 'Kanttekeningen bij de groottebepaling' });
    blocks.push({ type: 'bullets', items: warnings });
  }

  blocks.push({ type: 'pageBreak' });

  // ── Balans ────────────────────────────────────────────────────────────────
  blocks.push({ type: 'heading', level: 1, text: `Balans per ${fmtDateNl(str(fiscalYear.periodEnd))} (na resultaatbestemming)` });
  blocks.push(...missingComparativesBlock(snapshot));
  blocks.push({
    type: 'table',
    cols: amountCols(currentHeader, previousHeader),
    rows: balanceRowsFor(balanceLines(snapshot), 'rekening'),
    note: balanceCheckNote(snapshot),
  });

  // ── Winst-en-verliesrekening ──────────────────────────────────────────────
  blocks.push({ type: 'pageBreak' });
  blocks.push({ type: 'heading', level: 1, text: `Winst-en-verliesrekening ${label}` });
  blocks.push({
    type: 'table',
    cols: amountCols(currentHeader, previousHeader),
    rows: profitAndLossRows(plLines(snapshot), 'full', 'account'),
    note: resultCheckNote(snapshot),
  });

  // ── Toelichting ───────────────────────────────────────────────────────────
  blocks.push({ type: 'pageBreak' });
  blocks.push(...accountingPolicies(account));
  // Het interne stuk gaat NIET naar het register: daar mag de naamsgewijze
  // aandeelhouderstabel wél in staan, en het volledige verloop van het eigen
  // vermogen ook.
  blocks.push(...balanceNotes(account, snapshot, {
    shareholders: 'namen',
    equityScope: 'verloop',
    omit380a: false,
  }));
  blocks.push(...profitAndLossNotes(snapshot, { scope: 'volledig' }));
  blocks.push(...resultAppropriationBlocks(snapshot));

  // ── Ondertekening en vaststelling ─────────────────────────────────────────
  blocks.push({ type: 'pageBreak' });
  blocks.push(...signatureBlocks(account));
  blocks.push(...adoptionBlocks(account));
  blocks.push(...externalDocumentsChecklist(account, set));

  return {
    title: `Jaarrekening ${label} - ${companyName}`,
    subject: `Jaarrekening ${label}`,
    fileName: safePdfFileName(`jaarrekening-${label}-${companyName}`),
    footerText: `${companyName} - jaarrekening ${label}`,
    disclaimer: RESOFLY_DISCLAIMER,
    accentColor: opts.accentColor ?? null,
    // Uit het bevroren stuk, niet van de klok: zo geeft een herdruk dezelfde bytes.
    documentDate: str(account.preparedOn) || null,
    blocks,
  };
}

// ------------------------------------------------------------ het publicatiestuk
export function buildPublicationDocument(
  account: Json,
  opts: { accentColor?: string | null } = {},
): ReportDocument {
  const snapshot = obj(account.snapshot);
  const entity = obj(snapshot.entity);
  const fiscalYear = obj(snapshot.fiscalYear);
  const sizeClass = effectiveSizeClass(account);
  const set = PUBLICATION_SETS[sizeClass];
  const companyName = str(entity.companyName) || str(entity.organizationName) || 'Rechtspersoon';
  const label = str(fiscalYear.label) || fmtDateNl(str(fiscalYear.periodEnd));

  const currentHeader = fmtDateNl(str(fiscalYear.periodEnd));
  const previousHeader = previousHeaderFor(snapshot);

  const blocks: Block[] = [];

  blocks.push({
    type: 'coverTitle',
    title: `Publicatiestuk ${label}`,
    subtitle: companyName,
    lines: entityLines(snapshot, account),
  });

  // De banner staat vóór alles wat op cijfers lijkt: dit stuk is geen
  // deponeerbestand en dat mag geen voetnoot zijn.
  blocks.push({ type: 'banner', tone: 'warn', title: 'WERK- EN ARCHIEFSTUK - GEEN DEPONEERBESTAND', text: PUBLICATION_BANNER });

  // Belooft de omslag meer dan dit bestand levert, dan staat dat er direct onder
  // de titel — niet pas in een checklist na de cijfers.
  if (set.missing.length > 0) {
    blocks.push({
      type: 'banner',
      tone: 'warn',
      title: 'ONVOLLEDIGE SET VOOR DEZE GROOTTEKLASSE',
      text:
        'Dit bestand bevat niet alles wat de wet bij deze grootteklasse openbaar verlangt. Ontbreekt: ' +
        `${set.missing.join('; ')}. Voeg die stukken en gegevens zelf toe; ResoFly genereert ze niet.`,
    });
  }

  blocks.push(...statusBanners(account));

  const deadlines = obj(account.deadlines);
  const hardDeadline = fmtDateNl(str(deadlines.fileDeadlineHard));
  const safeDeadline = fmtDateNl(str(deadlines.fileDeadlineSafe));
  const afterAdoption = fmtDateNl(str(deadlines.fileDeadlineAfterAdoption));

  const deadlinePairs: Array<[string, string]> = [];
  // De betwiste KVK-datum wordt NOOIT verzwegen naast de harde twaalfmaandsgrens.
  // Eén datum afdrukken zou voor de gebruiker kiezen tussen twee rechtsopvattingen
  // en kan bij een DGA-BV twee maanden te laat uitpakken, met art. 2:394 lid 3 jo.
  // 2:248 lid 2 BW als staart. ResoFly kiest niet: beide, mét het woord betwist.
  if (safeDeadline) {
    deadlinePairs.push([
      'Streefdatum bij een BV waarvan alle aandeelhouders bestuurder zijn (BETWIST)',
      `${safeDeadline} - lijn KVK, art. 2:394 lid 1 jo. 2:210 lid 5 BW`,
    ]);
  }
  if (afterAdoption) {
    deadlinePairs.push(['Deponeren binnen acht dagen na vaststelling', `${afterAdoption} (art. 2:394 lid 1 BW)`]);
  }
  deadlinePairs.push(['Uiterste deponeerdatum', `${hardDeadline} (art. 2:394 lid 3 BW)`]);

  blocks.push({
    type: 'keyValues',
    pairs: [
      ['Grootteklasse', `${SIZE_CLASS_LABELS[sizeClass]} (${SIZE_CLASS_ARTICLES[sizeClass]})`],
      ['Omvang van de openbaarmaking', set.article],
      ['Vastgesteld op', str(account.adoptionDate) ? fmtDateNl(str(account.adoptionDate)) : 'nog niet vastgesteld'],
      ['Gedeponeerd op', str(account.filingDate) ? fmtDateNl(str(account.filingDate)) : 'nog niet gedeponeerd'],
      ...deadlinePairs,
    ],
  });

  if (safeDeadline) {
    blocks.push({
      type: 'paragraph',
      small: true,
      text: str(deadlines.disputeNote) ||
        'KVK houdt aan dat een BV waarvan alle aandeelhouders tevens bestuurder zijn binnen tien maanden en acht ' +
        'dagen na afloop van het boekjaar deponeert (art. 2:394 lid 1 jo. 2:210 lid 5 BW). Hof \'s-Hertogenbosch ' +
        '13-9-2022 (ECLI:NL:GHSHE:2022:3141) oordeelde dat de termijn van twaalf maanden (art. 2:394 lid 3 BW) ' +
        'leidend blijft. Een uitspraak van de Hoge Raad ontbreekt; ResoFly toont beide datums en kiest niet.',
    });
  }

  blocks.push({ type: 'heading', level: 3, text: 'Wat dit bestand bevat' });
  blocks.push({ type: 'bullets', items: set.contents });
  if (set.missing.length > 0) {
    blocks.push({ type: 'heading', level: 3, text: 'Wat de wet hier óók verlangt en wat dit bestand NIET bevat' });
    blocks.push({ type: 'bullets', items: set.missing });
  }
  if (set.articleNote) {
    blocks.push({ type: 'paragraph', small: true, italic: true, text: set.articleNote });
  }

  // Art. 2:394 lid 1 BW: op het stuk moet de dag van vaststelling staan.
  // Art. 2:394 lid 2 BW: is er niet vastgesteld, dan de vermelding dát niet.
  if (!str(account.adoptionDate)) {
    blocks.push({
      type: 'banner',
      tone: 'warn',
      title: 'DEZE JAARREKENING IS NOG NIET VASTGESTELD',
      text:
        'Is de jaarrekening niet binnen twee maanden na afloop van de voor het opmaken voorgeschreven termijn ' +
        'vastgesteld, dan maakt het bestuur de opgemaakte jaarrekening onverwijld openbaar met de vermelding dat zij ' +
        'nog niet is vastgesteld (art. 2:394 lid 2 BW). Na vaststelling moet binnen acht dagen alsnog het vastgestelde ' +
        'stuk openbaar worden gemaakt (art. 2:394 lid 1 BW).',
    });
  }

  blocks.push({ type: 'pageBreak' });

  // ── Balans ────────────────────────────────────────────────────────────────
  blocks.push({ type: 'heading', level: 1, text: `${set.balanceLabel} per ${fmtDateNl(str(fiscalYear.periodEnd))}` });
  blocks.push({
    type: 'paragraph',
    small: true,
    text: `Opgesteld na resultaatbestemming. Beperking van de openbaar te maken balans op grond van ${set.article}. ` +
      set.balanceDetailNote,
  });
  blocks.push(...missingComparativesBlock(snapshot));
  blocks.push({
    type: 'table',
    cols: amountCols(currentHeader, previousHeader),
    rows: balanceRowsFor(balanceLines(snapshot), set.balance),
    note: balanceCheckNote(snapshot),
  });

  // ── Winst-en-verliesrekening ──────────────────────────────────────────────
  if (set.profitAndLoss === 'none') {
    blocks.push({ type: 'heading', level: 2, text: 'Winst-en-verliesrekening' });
    blocks.push({
      type: 'paragraph',
      text: sizeClass === 'micro'
        ? 'Een micro-rechtspersoon maakt geen winst-en-verliesrekening openbaar (art. 2:395a lid 8 jo. lid 3 en 4 BW).'
        : 'Een kleine rechtspersoon maakt geen winst-en-verliesrekening openbaar (art. 2:396 lid 8 jo. lid 3 BW).',
    });
  } else {
    blocks.push({ type: 'heading', level: 1, text: `${set.profitAndLossLabel} ${label}` });
    blocks.push({
      type: 'table',
      cols: amountCols(currentHeader, previousHeader),
      rows: profitAndLossRows(
        plLines(snapshot),
        set.profitAndLoss === 'gross' ? 'gross' : 'full',
        set.balance === 'rekening' ? 'account' : 'group',
      ),
      note: set.profitAndLoss === 'gross'
        ? 'De samentrekking tot Bruto-bedrijfsresultaat berust op art. 2:397 lid 4 BW en is op rubriekniveau ' +
          'uitgevoerd. Overige bedrijfskosten, lonen/salarissen en afschrijvingen vallen er NIET onder en staan apart.'
        : resultCheckNote(snapshot),
    });
  }

  // ── Toelichting ───────────────────────────────────────────────────────────
  if (set.notes === 'none') {
    blocks.push({ type: 'heading', level: 2, text: 'Toelichting' });
    blocks.push({
      type: 'paragraph',
      text:
        'Een micro-rechtspersoon maakt geen toelichting openbaar; art. 2:394 BW is slechts van toepassing op de ' +
        'beperkte balans (art. 2:395a lid 8 jo. lid 3 en 4 BW).',
    });
  } else {
    blocks.push({ type: 'pageBreak' });
    // De grondslagen horen in élke toelichting: art. 2:384 lid 5 BW is voor de
    // kleine rechtspersoon niet uitgezonderd. Wat bij klein wél wegvalt, is de
    // rest van de toelichting en de gegevens van art. 2:380a BW.
    blocks.push(...accountingPolicies(account));
    blocks.push(...balanceNotes(account, snapshot, {
      // In het register komen geen namen van aandeelhouders: alleen de totalen per
      // aandelensoort. En het verloop van het eigen vermogen blijft bij klein
      // beperkt tot de standen (art. 2:396 lid 5 BW).
      shareholders: set.notes === 'limited' ? 'geen' : 'totalen',
      equityScope: set.notes === 'limited' ? 'standen' : 'verloop',
      omit380a: set.omit380a,
    }));
    if (set.notes === 'full' || set.notes === 'extended') {
      blocks.push(...profitAndLossNotes(snapshot, { scope: 'openbaar' }));
    }
  }

  // Art. 2:210 lid 2 BW: de melding van een ontbrekende handtekening ONDER OPGAVE
  // VAN REDEN hoort in de jaarrekening zelf, en het publicatiestuk ÍS de (beperkte)
  // jaarrekening die openbaar wordt gemaakt. Die melding ontbrak hier volledig,
  // net als de wijze van vaststelling.
  blocks.push({ type: 'pageBreak' });
  blocks.push(...signatureDisclosureBlocks(account));
  blocks.push(...adoptionBlocks(account));

  blocks.push(...externalDocumentsChecklist(account, set));

  return {
    title: `Publicatiestuk ${label} - ${companyName}`,
    subject: `Publicatiestuk ${label} (${SIZE_CLASS_LABELS[sizeClass]})`,
    fileName: safePdfFileName(`publicatiestuk-${label}-${companyName}`),
    footerText: `${companyName} - publicatiestuk ${label} (${sizeClass})`,
    disclaimer: `${RESOFLY_DISCLAIMER} Dit stuk is geen SBR/XBRL-deponeerbestand.`,
    accentColor: opts.accentColor ?? null,
    // Uit het bevroren stuk, niet van de klok: zo geeft een herdruk dezelfde bytes.
    documentDate: str(account.preparedOn) || null,
    blocks,
  };
}

// ------------------------------------------------------------ controleteksten
function balanceCheckNote(snapshot: Json): string {
  const balance = obj(snapshot.balanceSheetAfterAppropriation);
  const assets = num(balance.totalAssetsCents);
  const liabilities = num(balance.totalEquityAndLiabilitiesCents);
  if (assets === liabilities) {
    return `Sluitcontrole: totaal activa ${fmtEuro(assets)} is gelijk aan totaal passiva ${fmtEuro(liabilities)}.`;
  }
  return `LET OP - de balans sluit niet: totaal activa ${fmtEuro(assets)} tegenover totaal passiva ${fmtEuro(liabilities)} ` +
    `(verschil ${fmtEuro(assets - liabilities)}).`;
}

function resultCheckNote(snapshot: Json): string {
  const lines = plLines(snapshot);
  const computed = lines.reduce((acc, line) => acc + resultEffect(line, 'current'), 0);
  const closed = num(obj(snapshot.fiscalYear).resultCents);
  if (computed === closed) return '';
  return `LET OP - het resultaat volgens deze opstelling (${fmtEuro(computed)}) wijkt af van het resultaat waarmee het ` +
    `boekjaar is afgesloten (${fmtEuro(closed)}). Controleer de administratie voordat u dit stuk gebruikt.`;
}

function statusLabel(account: Json): string {
  switch (str(account.status)) {
    case 'prepared':
      return 'opgemaakt (art. 2:210 lid 1 BW)';
    case 'adopted':
      return `vastgesteld op ${fmtDateNl(str(account.adoptionDate))}`;
    case 'filed':
      return `gedeponeerd op ${fmtDateNl(str(account.filingDate))}${bool(account.filedUnadopted) ? ' (nog niet vastgesteld, art. 2:394 lid 2 BW)' : ''}`;
    case 'reversed':
      return 'ingetrokken';
    default:
      return str(account.status) || 'onbekend';
  }
}
