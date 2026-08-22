import {
  ActionError, bool, choice, euroCents, id, isoDate, joinShort, num, optChoice,
  optId, optIsoDate, optNum, optStr, orgQuery, row, str,
  type ActionCtx, type ActionDef,
} from './types.ts';
import { computeVpb, type LossCarryForward, type VpbCorrection, type VpbYearRules } from '../vpb.ts';

/**
 * Handelingen rond de ZAKELIJKE MODULE: de BV, de NV en de coöperatie.
 *
 * Vijf schermen die elkaar in vaste volgorde opvolgen, en die volgorde is geen
 * smaak maar wet. Het boekjaar wordt afgesloten, de algemene vergadering bestemt
 * het resultaat (art. 2:216 BW), daarop kan dividend worden uitgekeerd met
 * inhouding van dividendbelasting, de vennootschapsbelasting wordt berekend en
 * geboekt, en ten slotte wordt de jaarrekening opgemaakt, ondertekend,
 * vastgesteld en gedeponeerd (Titel 9 Boek 2 BW). Daarnaast staan het
 * aandeelhoudersregister van art. 2:194 BW en de rekening-courant van de DGA.
 *
 * Veel van wat hier staat is ONOMKEERBAAR: er ontstaat een boekstuk in het
 * grootboek, een schuld aan de Belastingdienst of een wettelijke termijn die
 * gaat lopen. Dat mag — er zit een mens tussen die akkoord geeft — maar dan moet
 * de titel en het onderschrift van het voorstel wél letterlijk zeggen wát er
 * onomkeerbaar gebeurt. Dat is de enige informatie die hij heeft op het moment
 * dat hij op Uitvoeren drukt.
 *
 * Wat hier bewust NIET staat: verwijderen. Een aandeelhouder, een aandelenmutatie,
 * een pandrecht, een rentepercentage of een fiscale correctie wissen kan alleen
 * met de hand in het scherm. Dat zijn registergegevens en onderbouwingen; een
 * agent hoort ze niet weg te kunnen gooien.
 */

// ── Vaste keuzelijsten, één op één met de database ──────────────────────────

const LEGAL_FORMS = ['eenmanszaak', 'vof', 'maatschap', 'cv', 'bv', 'nv', 'cooperatie', 'stichting', 'vereniging'] as const;
const LEGAL_FORM_LABELS: Record<string, string> = {
  eenmanszaak: 'Eenmanszaak', vof: 'VOF', maatschap: 'Maatschap', cv: 'Commanditaire vennootschap',
  bv: 'BV', nv: 'NV', cooperatie: 'Coöperatie', stichting: 'Stichting', vereniging: 'Vereniging',
};

const SHAREHOLDER_KINDS = ['natural_person', 'legal_entity'] as const;
const SHAREHOLDER_KIND_LABELS: Record<string, string> = {
  natural_person: 'natuurlijk persoon', legal_entity: 'rechtspersoon',
};

const SHARE_TX_KINDS = ['issue', 'transfer', 'repurchase', 'cancellation'] as const;
const SHARE_TX_LABELS: Record<string, string> = {
  issue: 'Uitgifte', transfer: 'Overdracht', repurchase: 'Inkoop door de vennootschap', cancellation: 'Intrekking',
};

const ENCUMBRANCE_KINDS = ['pledge', 'usufruct'] as const;
const ENCUMBRANCE_LABELS: Record<string, string> = { pledge: 'Pandrecht', usufruct: 'Vruchtgebruik' };

const DIVIDEND_KINDS = ['final', 'interim'] as const;
const DIVIDEND_KIND_LABELS: Record<string, string> = {
  final: 'uit de vastgestelde winst', interim: 'tussentijds (interim-dividend)',
};

const CORRECTION_CODES = [
  'niet_aftrekbaar', 'gemengde_kosten', 'afschrijvingsbeperking',
  'investeringsaftrek', 'deelnemingsvrijstelling', 'overig',
] as const;
const CORRECTION_LABELS: Record<string, string> = {
  niet_aftrekbaar: 'Niet-aftrekbare kosten',
  gemengde_kosten: 'Beperkt aftrekbare kosten',
  afschrijvingsbeperking: 'Afschrijvingsbeperking gebouwen',
  investeringsaftrek: 'Investeringsaftrek',
  deelnemingsvrijstelling: 'Deelnemingsvrijstelling',
  overig: 'Overige correctie',
};

const SIZE_CLASSES = ['micro', 'klein', 'middelgroot', 'groot'] as const;
const SIZE_CLASS_LABELS: Record<string, string> = {
  micro: 'Micro', klein: 'Klein', middelgroot: 'Middelgroot', groot: 'Groot',
};

const ACCOUNTING_BASES = ['commercieel', 'fiscaal'] as const;
const SIGNATURE_ROLES = ['bestuurder', 'commissaris'] as const;
const ADOPTION_METHODS = ['ava', 'signature_210_5'] as const;
const ADOPTION_METHOD_LABELS: Record<string, string> = {
  ava: 'besluit van de algemene vergadering (art. 2:210 lid 3 BW)',
  signature_210_5: 'door ondertekening (art. 2:210 lid 5 BW)',
};

const ANNUAL_STATUS_LABELS: Record<string, string> = {
  prepared: 'opgemaakt', adopted: 'vastgesteld', filed: 'gedeponeerd', reversed: 'ingetrokken',
};

// ── Kleine hulpjes ──────────────────────────────────────────────────────────

/** Euro's uit het model naar hele centen; de hele module rekent in centen. */
function cents(input: Record<string, unknown>, key: string): number {
  return Math.round(num(input, key) * 100);
}

function optCents(input: Record<string, unknown>, key: string): number | null {
  const value = optNum(input, key);
  return value === null ? null : Math.round(value * 100);
}

/** Basispunten als leesbaar percentage: 1500 → "15,00%". */
function pct(basisPoints: number | null | undefined): string {
  return `${((basisPoints ?? 0) / 100).toFixed(2).replace('.', ',')}%`;
}

/** JJJJ-MM-DD → D-M-JJJJ, zodat een kaart Nederlands leest. */
function dateNL(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const [y, m, d] = String(iso).split('-');
  if (!y || !m || !d) return String(iso);
  return `${Number(d)}-${Number(m)}-${y}`;
}

interface FiscalYearRow {
  id: string;
  label: string;
  period_start: string;
  period_end: string;
  status: 'open' | 'closed';
  result_cents: number | null;
  computed_result_cents: number;
}

/**
 * Het boekjaar zoals het scherm het ziet: mét het server-side (her)berekende
 * resultaat. `list_fiscal_years` is zelf org-scoped op de parameter, en we
 * controleren daarna dat het gevraagde id er ook echt in zit.
 */
async function fiscalYear(ctx: ActionCtx, fiscalYearId: string): Promise<FiscalYearRow> {
  const { data, error } = await ctx.db.rpc('list_fiscal_years', { p_organization_id: ctx.organizationId });
  if (error) throw new ActionError(`Boekjaren ophalen mislukt: ${error.message}`);
  const found = (data ?? []).find((y: FiscalYearRow) => y.id === fiscalYearId);
  if (!found) throw new ActionError('Boekjaar niet gevonden in deze organisatie. Zoek het eerst op met `list_fiscal_years`.');
  return found as FiscalYearRow;
}

interface AnnualAccountLite {
  id: string;
  fiscalYearId: string;
  fiscalYearLabel: string;
  periodEnd: string;
  status: string;
  preparedOn: string;
  prepareDeadline: string;
  extensionMonths: number;
  adoptionDate: string | null;
  adoptionMethod: string | null;
  dischargeGranted: boolean;
  allShareholdersAreDirectors: boolean;
  otherMeetingRightsInformed: boolean;
  articlesAllow2105: boolean;
  filingDate: string | null;
  effectiveSizeClass: string;
  auditRequired: boolean;
  auditorOpinionReceived: boolean;
  auditorName: string | null;
  auditorMissingGround: string | null;
  snapshotHash: string;
  snapshotStale: boolean;
  signatures: Array<{ id: string; personName: string; role: string; signed: boolean; signedOn: string | null; missingReason: string | null }>;
  deadlines: Record<string, unknown>;
}

/** Eén jaarrekening met haar handtekeningen en termijnen; eerst de org-grens. */
async function annualAccount(ctx: ActionCtx, annualAccountId: string): Promise<AnnualAccountLite> {
  await row(ctx, 'annual_accounts', annualAccountId, 'id', 'Jaarrekening');
  const { data, error } = await ctx.db.rpc('get_annual_account', {
    p_organization_id: ctx.organizationId,
    p_annual_account_id: annualAccountId,
  });
  if (error) throw new ActionError(`Jaarrekening ophalen mislukt: ${error.message}`);
  if (!data) throw new ActionError('Jaarrekening niet gevonden in deze organisatie.');
  return data as AnnualAccountLite;
}

/** De Vpb doorrekenen met exact hetzelfde rekenhart als de edge function. */
async function computeCorporateTax(ctx: ActionCtx, fiscalYearId: string) {
  const { data, error } = await ctx.db.rpc('get_corporate_tax_inputs', {
    p_organization_id: ctx.organizationId,
    p_fiscal_year_id: fiscalYearId,
  });
  if (error) throw new ActionError(`Vpb-gegevens ophalen mislukt: ${error.message}`);
  if (!data) throw new ActionError('Geen Vpb-gegevens gevonden voor dit boekjaar.');
  const inputs = data as {
    fiscalYear: { id: string; label: string; periodStart: string; periodEnd: string; status: string };
    rules: VpbYearRules;
    commercialResultCents: number;
    prepaidCents: number;
    corrections: Array<VpbCorrection & { id: string }>;
    lossesCarriedForward: Array<LossCarryForward & { establishedByAssessment: boolean }>;
  };
  const computation = computeVpb({
    rules: inputs.rules,
    commercialResultCents: inputs.commercialResultCents,
    corrections: inputs.corrections.map((c) => ({ code: c.code, label: c.label, amountCents: c.amountCents })),
    lossesCarriedForward: inputs.lossesCarriedForward.map((l) => ({ year: l.year, remainingCents: l.remainingCents })),
    prepaidCents: inputs.prepaidCents,
  });
  return { inputs, computation };
}

/** De niet-teruggedraaide Vpb-berekening van een boekjaar, als die er is. */
async function currentTaxReturn(ctx: ActionCtx, fiscalYearId: string) {
  const { data, error } = await orgQuery(ctx, 'corporate_tax_returns', 'id, year, status, tax_cents, taxable_amount_cents')
    .eq('fiscal_year_id', fiscalYearId).neq('status', 'reversed').maybeSingle();
  if (error) throw new ActionError(`Vpb-berekening ophalen mislukt: ${error.message}`);
  return (data ?? null) as { id: string; year: number; status: string; tax_cents: number; taxable_amount_cents: number } | null;
}

export const BUSINESS_ACTIONS: ActionDef[] = [
  // ══ De module zelf ═══════════════════════════════════════════════════════
  {
    id: 'business.status',
    label: 'Rechtsvorm en de stand van de zakelijke module bekijken',
    module: 'finance',
    kind: 'read',
    description:
      'Geeft de rechtsvorm van deze administratie (BV, NV, coöperatie, eenmanszaak…), het fiscale regime (vpb, ib of overig) en of de betaalde zakelijke module aanstaat, uitstaat of in respijt is. ' +
      'Vraag dit ALTIJD op voordat je iets met aandeelhouders, dividend, DGA-rente, vennootschapsbelasting of de jaarrekening voorstelt: bij een IB-ondernemer bestaan die verplichtingen niet en weigert de database elke schrijfactie.',
    keywords: ['rechtsvorm', 'bv', 'nv', 'coöperatie', 'holding', 'zakelijke module', 'vpb', 'vennootschapsbelasting', 'inkomstenbelasting', 'entiteit'],
    input: {},
    async read(ctx) {
      const { data, error } = await ctx.db.rpc('organization_business_status', { p_organization_id: ctx.organizationId });
      if (error) throw new ActionError(`Stand van de zakelijke module ophalen mislukt: ${error.message}`);
      return { status: (Array.isArray(data) ? data[0] : data) ?? null };
    },
  },

  {
    id: 'business.set_legal_form',
    label: 'Rechtsvorm van de administratie vastleggen',
    module: 'finance',
    kind: 'write',
    description:
      'Zet de rechtsvorm van deze administratie (Instellingen → Facturatie). Dat is geen cosmetisch veld: de rechtsvorm stuurt het rekeningschema, bepaalt of het resultaat bij het afsluiten naar het ondernemingsvermogen of naar de overige reserves gaat, en ontsluit de schermen DGA, Aandeelhouders, Jaarrekening en Vennootschapsbelasting. ' +
      'BV, NV en coöperatie kunnen alleen als de betaalde zakelijke module aanstaat — de database weigert het anders. Controleer eerst `business.status`.',
    keywords: ['rechtsvorm', 'bv', 'nv', 'coöperatie', 'eenmanszaak', 'vof', 'stichting', 'omzetten', 'legal form'],
    input: {
      legal_form: { type: 'string', enum: [...LEGAL_FORMS], description: 'De nieuwe rechtsvorm.' },
    },
    required: ['legal_form'],
    async plan(ctx, input) {
      const form = choice(input, 'legal_form', LEGAL_FORMS);
      const { data, error } = await orgQuery(ctx, 'company_settings', 'legal_form, company_name').maybeSingle();
      if (error) throw new ActionError(`Bedrijfsgegevens ophalen mislukt: ${error.message}`);
      if (!data) throw new ActionError('Er zijn nog geen bedrijfsgegevens vastgelegd; vul die eerst in bij Instellingen → Facturatie.');
      const current = String(data.legal_form ?? 'eenmanszaak');
      if (current === form) throw new ActionError(`De rechtsvorm staat al op ${LEGAL_FORM_LABELS[form]}.`);
      const toVpb = ['bv', 'nv', 'cooperatie'].includes(form);
      return {
        title: `Rechtsvorm vastleggen: ${LEGAL_FORM_LABELS[form]}`,
        sub: joinShort([
          `${data.company_name ?? 'deze administratie'} staat nu op ${LEGAL_FORM_LABELS[current] ?? current}`,
          'stuurt het rekeningschema en de resultaatbestemming',
          toVpb
            ? 'vanaf nu vennootschapsbelasting: DGA, aandeelhouders, jaarrekening en Vpb komen erbij'
            : 'de Vpb-schermen verdwijnen; de app rekent weer met inkomstenbelasting',
        ], 200),
        kind: 'money',
        payload: { legal_form: form, label: LEGAL_FORM_LABELS[form], previous: current },
      };
    },
  },

  // ══ Aandeelhoudersregister (art. 2:194 BW) ═══════════════════════════════
  {
    id: 'shareholder.list',
    label: 'Aandeelhouders in het register bekijken',
    module: 'finance',
    kind: 'read',
    description:
      'Geeft het aandeelhoudersregister van art. 2:194 BW: naam, soort (natuurlijk persoon of rechtspersoon), adres, land, e-mail, of iemand de directeur-grootaandeelhouder is en of op uitkeringen aan hem de inhoudingsvrijstelling dividendbelasting geldt (art. 4 Wet DB 1965) met de onderbouwing daarvan. ' +
      'Dit is de personenlijst, niet het bezit — hoeveel aandelen iemand heeft staat in `shareholder.positions`.',
    keywords: ['aandeelhouder', 'register', 'dga', 'holding', 'inhoudingsvrijstelling', 'aandeelhoudersregister'],
    input: {
      only_dga: { type: 'boolean', description: 'Alleen de directeur-grootaandeelhouder(s).' },
    },
    async read(ctx, input) {
      let query = orgQuery(ctx, 'shareholders',
        'id, name, kind, address_line, postal_code, city, country_code, email, is_dga, withholding_exempt, withholding_exempt_note, note')
        .order('name', { ascending: true });
      if (bool(input, 'only_dga', false)) query = query.eq('is_dga', true);
      const { data, error } = await query;
      if (error) throw new ActionError(`Aandeelhouders ophalen mislukt: ${error.message}`);
      return { shareholders: data ?? [] };
    },
  },

  {
    id: 'shareholder.positions',
    label: 'Aandelenbezit op een peildatum bekijken',
    module: 'finance',
    kind: 'read',
    description:
      'De stand van het register op een peildatum, afgeleid uit de mutaties: per aandeelhouder en soort aandelen het aantal, het belang in basispunten (10.000 = 100%), het nominale en gestorte bedrag en sinds wanneer hij ze heeft. ' +
      'Ingekochte eigen aandelen tellen niet mee in de noemer. Gebruik dit vóór een dividendbesluit: het belang bepaalt de pro-rata verdeling.',
    keywords: ['aandelen', 'belang', 'percentage', 'peildatum', 'bezit', 'stemverhouding', 'kapitaal'],
    input: {
      as_of: { type: 'string', description: 'Peildatum JJJJ-MM-DD. Standaard vandaag.' },
    },
    async read(ctx, input) {
      const asOf = optIsoDate(input, 'as_of') ?? ctx.today;
      const { data, error } = await ctx.db.rpc('shareholder_positions', {
        p_organization_id: ctx.organizationId,
        p_as_of: asOf,
      });
      if (error) throw new ActionError(`Aandelenbezit ophalen mislukt: ${error.message}`);
      return { as_of: asOf, positions: data ?? [] };
    },
  },

  {
    id: 'shareholder.create',
    label: 'Aandeelhouder toevoegen aan het register',
    module: 'finance',
    kind: 'write',
    description:
      'Zet een nieuwe aandeelhouder in het register van art. 2:194 BW. Het adres is geen bijzaak: het wordt letterlijk op de dividendnota afgedrukt. ' +
      'Zet `withholding_exempt` alleen op true als de gebruiker daar uitdrukkelijk om vraagt — dan blijft de inhouding van dividendbelasting achterwege (art. 4 Wet DB 1965) en is de onderbouwing verplicht; bij een controle is dat het enige dat telt. ' +
      'Dit maakt alleen de persoon aan; hoeveel aandelen hij heeft leg je daarna vast met `share_transaction.create`.',
    keywords: ['aandeelhouder toevoegen', 'nieuwe aandeelhouder', 'dga', 'holding', 'register'],
    input: {
      name: { type: 'string', description: 'Naam of statutaire naam.' },
      kind: { type: 'string', enum: [...SHAREHOLDER_KINDS], description: 'natural_person = mens, legal_entity = rechtspersoon (bv. een holding).' },
      address_line: { type: 'string', description: 'Straat en huisnummer — komt op de dividendnota.' },
      postal_code: { type: 'string' },
      city: { type: 'string' },
      country_code: { type: 'string', description: 'Landcode van twee letters, standaard NL.' },
      email: { type: 'string' },
      is_dga: { type: 'boolean', description: 'Dit is de directeur-grootaandeelhouder.' },
      withholding_exempt: { type: 'boolean', description: 'Inhoudingsvrijstelling dividendbelasting (art. 4 Wet DB 1965).' },
      withholding_exempt_note: { type: 'string', description: 'Verplicht bij vrijstelling: waarom hoeft er niet te worden ingehouden?' },
      note: { type: 'string' },
    },
    required: ['name', 'kind'],
    async plan(ctx, input) {
      const name = str(input, 'name', 200);
      const kind = choice(input, 'kind', SHAREHOLDER_KINDS);
      const exempt = bool(input, 'withholding_exempt', false);
      const exemptNote = optStr(input, 'withholding_exempt_note', 500);
      if (exempt && !exemptNote) {
        throw new ActionError('Leg vast waaróm er geen dividendbelasting hoeft te worden ingehouden; zonder onderbouwing wordt de vrijstelling niet vastgelegd.');
      }
      const isDga = bool(input, 'is_dga', false);
      const city = optStr(input, 'city', 120);
      return {
        title: `Aandeelhouder toevoegen: ${name}`,
        sub: joinShort([
          SHAREHOLDER_KIND_LABELS[kind], city,
          isDga ? 'directeur-grootaandeelhouder' : null,
          exempt ? 'inhoudingsvrijstelling dividendbelasting' : null,
        ], 140),
        kind: 'work',
        payload: {
          name,
          input: {
            name, kind,
            addressLine: optStr(input, 'address_line', 200),
            postalCode: optStr(input, 'postal_code', 20),
            city,
            countryCode: (optStr(input, 'country_code', 2) ?? 'NL').toUpperCase(),
            email: optStr(input, 'email', 200),
            isDga, withholdingExempt: exempt, withholdingExemptNote: exemptNote,
            note: optStr(input, 'note', 500),
          },
        },
      };
    },
  },

  {
    id: 'shareholder.update',
    label: 'Gegevens van een aandeelhouder bijwerken',
    module: 'finance',
    kind: 'write',
    description:
      'Past naam, soort, adres, land, e-mail, de DGA-vlag, de inhoudingsvrijstelling of de notitie van een bestaande aandeelhouder aan. Geef alleen wat verandert — de rest blijft staan. ' +
      'Let op het adres: dat wordt op de dividendnota afgedrukt. Zoek de aandeelhouder eerst met `shareholder.list`.',
    keywords: ['aandeelhouder bewerken', 'adres wijzigen', 'verhuisd', 'inhoudingsvrijstelling', 'dga'],
    input: {
      shareholder_id: { type: 'string', description: 'Id uit shareholder.list.' },
      name: { type: 'string' },
      kind: { type: 'string', enum: [...SHAREHOLDER_KINDS] },
      address_line: { type: 'string' },
      postal_code: { type: 'string' },
      city: { type: 'string' },
      country_code: { type: 'string' },
      email: { type: 'string' },
      is_dga: { type: 'boolean' },
      withholding_exempt: { type: 'boolean' },
      withholding_exempt_note: { type: 'string' },
      note: { type: 'string' },
    },
    required: ['shareholder_id'],
    async plan(ctx, input) {
      const shareholderId = id(input, 'shareholder_id');
      const current = await row<{
        name: string; kind: string; address_line: string | null; postal_code: string | null;
        city: string | null; country_code: string; email: string | null; is_dga: boolean;
        withholding_exempt: boolean; withholding_exempt_note: string | null; note: string | null;
      }>(ctx, 'shareholders', shareholderId,
        'name, kind, address_line, postal_code, city, country_code, email, is_dga, withholding_exempt, withholding_exempt_note, note',
        'Aandeelhouder');

      const changed: string[] = [];
      const pick = <T>(label: string, next: T | null, previous: T): T => {
        if (next === null || next === undefined || next === previous) return previous;
        changed.push(label);
        return next;
      };

      const merged = {
        name: pick('naam', optStr(input, 'name', 200), current.name),
        kind: pick('soort', optChoice(input, 'kind', SHAREHOLDER_KINDS), current.kind),
        addressLine: pick('adres', optStr(input, 'address_line', 200), current.address_line),
        postalCode: pick('postcode', optStr(input, 'postal_code', 20), current.postal_code),
        city: pick('plaats', optStr(input, 'city', 120), current.city),
        countryCode: pick('land', optStr(input, 'country_code', 2)?.toUpperCase() ?? null, current.country_code),
        email: pick('e-mail', optStr(input, 'email', 200), current.email),
        isDga: pick('DGA-vlag', typeof input.is_dga === 'boolean' ? input.is_dga as boolean : null, current.is_dga),
        withholdingExempt: pick('inhoudingsvrijstelling',
          typeof input.withholding_exempt === 'boolean' ? input.withholding_exempt as boolean : null, current.withholding_exempt),
        withholdingExemptNote: pick('onderbouwing vrijstelling', optStr(input, 'withholding_exempt_note', 500), current.withholding_exempt_note),
        note: pick('notitie', optStr(input, 'note', 500), current.note),
      };

      if (changed.length === 0) throw new ActionError('Geef minstens één veld dat moet veranderen.');
      if (merged.withholdingExempt && !merged.withholdingExemptNote) {
        throw new ActionError('Leg vast waaróm er geen dividendbelasting hoeft te worden ingehouden; zonder onderbouwing wordt de vrijstelling niet vastgelegd.');
      }

      return {
        title: `Aandeelhouder bijwerken: ${current.name}`,
        sub: joinShort(changed, 140),
        kind: 'work',
        payload: { shareholder_id: shareholderId, name: merged.name, input: merged },
      };
    },
  },

  {
    id: 'share_transaction.list',
    label: 'Aandelenmutaties in het register bekijken',
    module: 'finance',
    kind: 'read',
    description:
      'De volledige mutatiehistorie van het register: uitgiftes, overdrachten, inkopen en intrekkingen, met datum van verkrijging, datum van erkenning of betekening, soort aandelen, aantal, nominaal en gestort per aandeel en de aktereferentie. ' +
      'Uit deze gebeurtenissen wordt het bezit afgeleid; er wordt nergens een saldo bijgehouden.',
    keywords: ['aandelenmutatie', 'uitgifte', 'overdracht', 'inkoop', 'intrekking', 'akte', 'levering', 'historie'],
    input: {
      limit: { type: 'number', description: 'Maximaal aantal mutaties (standaard 50).' },
    },
    async read(ctx, input) {
      const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 200);
      const { data, error } = await orgQuery(ctx, 'share_transactions',
        'id, kind, event_date, acknowledged_on, share_class, quantity, nominal_value_cents, paid_up_cents, from_shareholder_id, to_shareholder_id, deed_reference, note')
        .order('event_date', { ascending: false }).limit(limit);
      if (error) throw new ActionError(`Aandelenmutaties ophalen mislukt: ${error.message}`);
      const { data: holders } = await orgQuery(ctx, 'shareholders', 'id, name');
      const byId = new Map<string, string>((holders ?? []).map((h: { id: string; name: string }) => [h.id, h.name]));
      return {
        transactions: (data ?? []).map((t: Record<string, unknown>) => ({
          ...t,
          from_name: t.from_shareholder_id ? byId.get(String(t.from_shareholder_id)) ?? null : null,
          to_name: t.to_shareholder_id ? byId.get(String(t.to_shareholder_id)) ?? null : null,
        })),
      };
    },
  },

  {
    id: 'share_transaction.create',
    label: 'Aandelenmutatie vastleggen',
    module: 'finance',
    kind: 'write',
    description:
      'Legt een gebeurtenis in het aandelenkapitaal vast: een uitgifte (issue), een overdracht tussen aandeelhouders (transfer), een inkoop door de vennootschap (repurchase) of een intrekking (cancellation). ' +
      'Bij uitgifte is alleen "naar" nodig, bij overdracht "van" én "naar", bij inkoop en intrekking alleen "van". Nominaal en gestort zijn bedragen PER AANDEEL; er kan niet meer gestort zijn dan nominaal — wat daarbovenop is betaald is agio en hoort op 0505. ' +
      'Levering van aandelen in een BV kan alleen bij notariële akte (art. 2:196 BW); noteer de akte erbij. Deze mutatie verschuift met terugwerkende kracht alle belangen en daarmee de dividendverdeling.',
    keywords: ['aandelen uitgeven', 'aandelen overdragen', 'inkoop eigen aandelen', 'intrekking', 'emissie', 'akte', 'notaris', 'mutatie'],
    input: {
      kind: { type: 'string', enum: [...SHARE_TX_KINDS], description: 'issue = uitgifte, transfer = overdracht, repurchase = inkoop door de vennootschap, cancellation = intrekking.' },
      event_date: { type: 'string', description: 'Datum van verkrijging, JJJJ-MM-DD.' },
      acknowledged_on: { type: 'string', description: 'Datum van erkenning of betekening (valt niet altijd samen met de levering).' },
      share_class: { type: 'string', description: 'Soort aandelen, standaard "gewoon".' },
      quantity: { type: 'number', description: 'Aantal aandelen, groter dan nul.' },
      nominal_value_eur: { type: 'number', description: 'Nominale waarde PER AANDEEL in euro.' },
      paid_up_eur: { type: 'number', description: 'Gestort bedrag PER AANDEEL in euro; nooit hoger dan nominaal.' },
      from_shareholder_id: { type: 'string', description: 'Van wie; verplicht behalve bij een uitgifte.' },
      to_shareholder_id: { type: 'string', description: 'Naar wie; verplicht bij uitgifte en overdracht.' },
      deed_reference: { type: 'string', description: 'Verwijzing naar de notariële akte.' },
      note: { type: 'string' },
    },
    required: ['kind', 'event_date', 'quantity', 'nominal_value_eur', 'paid_up_eur'],
    async plan(ctx, input) {
      const kind = choice(input, 'kind', SHARE_TX_KINDS);
      const eventDate = isoDate(input, 'event_date');
      const quantity = Math.trunc(num(input, 'quantity'));
      if (quantity <= 0) throw new ActionError('Het aantal aandelen moet groter dan nul zijn.');
      const nominalCents = cents(input, 'nominal_value_eur');
      const paidUpCents = cents(input, 'paid_up_eur');
      if (paidUpCents > nominalCents) {
        throw new ActionError('Er kan niet meer gestort zijn dan de nominale waarde; wat daarbovenop is betaald is agio en hoort op 0505.');
      }

      const needsFrom = kind !== 'issue';
      const needsTo = kind === 'issue' || kind === 'transfer';
      const fromId = optId(input, 'from_shareholder_id');
      const toId = optId(input, 'to_shareholder_id');
      if (needsFrom && !fromId) throw new ActionError(`Bij "${SHARE_TX_LABELS[kind]}" is "from_shareholder_id" verplicht.`);
      if (needsTo && !toId) throw new ActionError(`Bij "${SHARE_TX_LABELS[kind]}" is "to_shareholder_id" verplicht.`);
      if (kind === 'transfer' && fromId === toId) throw new ActionError('Bij een overdracht moeten "van" en "naar" verschillende aandeelhouders zijn.');

      const fromName = fromId ? (await row<{ name: string }>(ctx, 'shareholders', fromId, 'name', 'Aandeelhouder')).name : null;
      const toName = toId ? (await row<{ name: string }>(ctx, 'shareholders', toId, 'name', 'Aandeelhouder')).name : null;
      const shareClass = optStr(input, 'share_class', 60) ?? 'gewoon';
      const deed = optStr(input, 'deed_reference', 300);

      return {
        title: `${SHARE_TX_LABELS[kind]} vastleggen: ${quantity} aandelen ${shareClass}`,
        sub: joinShort([
          `${fromName ?? 'uitgifte'} → ${toName ?? 'de vennootschap'}`,
          `verkregen ${dateNL(eventDate)}`,
          `nominaal ${euroCents(nominalCents)} p/a, gestort ${euroCents(paidUpCents)} p/a`,
          deed,
          'verschuift met terugwerkende kracht alle belangen en de dividendverdeling',
        ], 200),
        kind: 'work',
        payload: {
          summary: `${SHARE_TX_LABELS[kind]} van ${quantity} aandelen`,
          input: {
            kind, eventDate,
            acknowledgedOn: optIsoDate(input, 'acknowledged_on'),
            shareClass, quantity,
            nominalValueCents: nominalCents,
            paidUpCents,
            fromShareholderId: needsFrom ? fromId : null,
            toShareholderId: needsTo ? toId : null,
            deedReference: deed,
            note: optStr(input, 'note', 500),
          },
        },
      };
    },
  },

  {
    id: 'share_encumbrance.list',
    label: 'Pandrechten en vruchtgebruiken op aandelen bekijken',
    module: 'finance',
    kind: 'read',
    description:
      'Het tweede deel van het register (art. 2:194 lid 2 BW): op welke aandelen een pandrecht of vruchtgebruik rust, wie de houder is, hoeveel aandelen het betreft, sinds wanneer, tot wanneer, en of het stemrecht en het dividendrecht de houder toekomen. ' +
      'Dat laatste doet er echt toe: rust er vruchtgebruik met dividendrecht op een aandeel, dan komt het dividend aan de vruchtgebruiker toe en niet aan de aandeelhouder.',
    keywords: ['pandrecht', 'vruchtgebruik', 'bezwaring', 'pandhouder', 'stemrecht', 'dividendrecht'],
    input: {},
    async read(ctx) {
      const { data, error } = await orgQuery(ctx, 'share_encumbrances',
        'id, shareholder_id, kind, holder_name, holder_address, share_class, quantity, established_on, acknowledged_on, ended_on, has_voting_rights, has_dividend_rights, note')
        .order('established_on', { ascending: false });
      if (error) throw new ActionError(`Pandrechten ophalen mislukt: ${error.message}`);
      const { data: holders } = await orgQuery(ctx, 'shareholders', 'id, name');
      const byId = new Map<string, string>((holders ?? []).map((h: { id: string; name: string }) => [h.id, h.name]));
      return {
        encumbrances: (data ?? []).map((e: Record<string, unknown>) => ({
          ...e, shareholder_name: byId.get(String(e.shareholder_id)) ?? null,
        })),
      };
    },
  },

  {
    id: 'share_encumbrance.create',
    label: 'Pandrecht of vruchtgebruik op aandelen vastleggen',
    module: 'finance',
    kind: 'write',
    description:
      'Legt vast dat er een pandrecht (pledge) of vruchtgebruik (usufruct) op de aandelen van een aandeelhouder rust — verplicht onderdeel van het register (art. 2:194 lid 2 BW). ' +
      'Vraag uitdrukkelijk of het stemrecht en het dividendrecht de houder toekomen: staat het dividendrecht bij de houder, dan gaat de uitkering naar hem in plaats van naar de aandeelhouder.',
    keywords: ['pandrecht', 'vruchtgebruik', 'verpanden', 'pandhouder', 'vruchtgebruiker', 'bezwaring'],
    input: {
      shareholder_id: { type: 'string', description: 'Op wiens aandelen het recht rust (uit shareholder.list).' },
      kind: { type: 'string', enum: [...ENCUMBRANCE_KINDS], description: 'pledge = pandrecht, usufruct = vruchtgebruik.' },
      holder_name: { type: 'string', description: 'Naam van de pandhouder of vruchtgebruiker.' },
      holder_address: { type: 'string' },
      share_class: { type: 'string', description: 'Soort aandelen, standaard "gewoon".' },
      quantity: { type: 'number', description: 'Aantal aandelen waarop het recht rust.' },
      established_on: { type: 'string', description: 'Vestigingsdatum JJJJ-MM-DD.' },
      acknowledged_on: { type: 'string', description: 'Datum van erkenning of betekening.' },
      ended_on: { type: 'string', description: 'Einddatum, als het recht al is geëindigd.' },
      has_voting_rights: { type: 'boolean', description: 'Het stemrecht komt de houder toe.' },
      has_dividend_rights: { type: 'boolean', description: 'Het dividend komt de houder toe.' },
      note: { type: 'string' },
    },
    required: ['shareholder_id', 'kind', 'holder_name', 'quantity', 'established_on'],
    async plan(ctx, input) {
      const shareholderId = id(input, 'shareholder_id');
      const shareholder = await row<{ name: string }>(ctx, 'shareholders', shareholderId, 'name', 'Aandeelhouder');
      const kind = choice(input, 'kind', ENCUMBRANCE_KINDS);
      const holderName = str(input, 'holder_name', 200);
      const quantity = Math.trunc(num(input, 'quantity'));
      if (quantity <= 0) throw new ActionError('Het aantal aandelen moet groter dan nul zijn.');
      const establishedOn = isoDate(input, 'established_on');
      const voting = bool(input, 'has_voting_rights', false);
      const dividend = bool(input, 'has_dividend_rights', false);

      return {
        title: `${ENCUMBRANCE_LABELS[kind]} vastleggen: ${holderName} op ${quantity} aandelen`,
        sub: joinShort([
          `aandelen van ${shareholder.name}`,
          `gevestigd ${dateNL(establishedOn)}`,
          [voting ? 'stemrecht' : null, dividend ? 'dividendrecht' : null].filter(Boolean).join(' en ') || 'geen stem- of dividendrecht voor de houder',
          dividend ? 'het dividend gaat naar de houder, niet naar de aandeelhouder' : null,
        ], 190),
        kind: 'work',
        payload: {
          summary: `${ENCUMBRANCE_LABELS[kind]} van ${holderName}`,
          input: {
            shareholderId, kind, holderName,
            holderAddress: optStr(input, 'holder_address', 300),
            shareClass: optStr(input, 'share_class', 60) ?? 'gewoon',
            quantity, establishedOn,
            acknowledgedOn: optIsoDate(input, 'acknowledged_on'),
            endedOn: optIsoDate(input, 'ended_on'),
            hasVotingRights: voting,
            hasDividendRights: dividend,
            note: optStr(input, 'note', 500),
          },
        },
      };
    },
  },

  // ══ Resultaatbestemming (art. 2:216 BW) ══════════════════════════════════
  {
    id: 'result_appropriation.list',
    label: 'Resultaatbestemmingen per boekjaar bekijken',
    module: 'finance',
    kind: 'read',
    description:
      'De besluiten van de algemene vergadering over de bestemming van het resultaat: per boekjaar het resultaat, hoeveel naar de overige reserves ging en hoeveel als dividend werd toegekend, het vrij uitkeerbare vermogen waarop de balanstest is beoordeeld, of het bestuur de uitkeringstoets heeft goedgekeurd en het bijbehorende boekstuk. ' +
      'Een besluit met toegekend dividend waar nog geen uitkering bij staat, betekent dat het bedrag nog onverdeeld als schuld op 1580 staat en er nog niets is ingehouden.',
    keywords: ['resultaatbestemming', 'winstbestemming', 'reserves', 'dividendbesluit', 'ava', 'algemene vergadering', 'uitkeringstoets'],
    input: {},
    async read(ctx) {
      const { data, error } = await ctx.db.rpc('list_result_appropriations', { p_organization_id: ctx.organizationId });
      if (error) throw new ActionError(`Resultaatbestemmingen ophalen mislukt: ${error.message}`);
      return { appropriations: data ?? [] };
    },
  },

  {
    id: 'result_appropriation.create',
    label: 'Resultaatbestemming vastleggen en boeken',
    module: 'finance',
    kind: 'write',
    description:
      'Legt het besluit van de algemene vergadering over de bestemming van het resultaat vast en BOEKT het meteen: van de resultaatrekening naar de overige reserves (0520) en, voor zover er dividend wordt toegekend, naar een dividendschuld (1580). ' +
      'Wat niet als dividend wordt toegekend, gaat automatisch naar de reserves. Bij een verlies valt er niets uit te keren. ' +
      'Zodra er dividend in zit is `board_approved` verplicht: dat is de bestuursgoedkeuring van de uitkeringstoets (art. 2:216 lid 2 BW) — zonder die goedkeuring heeft het besluit geen gevolgen, en kan de vennootschap na de uitkering haar opeisbare schulden niet betalen dan zijn de bestuurders hoofdelijk verbonden voor het tekort (lid 3). Vraag daar uitdrukkelijk naar. ' +
      'Het boekjaar moet afgesloten zijn.',
    keywords: ['resultaatbestemming', 'winst bestemmen', 'reserves', 'dividend toekennen', 'ava', 'uitkeringstoets', 'balanstest'],
    input: {
      fiscal_year_id: { type: 'string', description: 'Id van het afgesloten boekjaar (uit list_fiscal_years).' },
      decision_date: { type: 'string', description: 'Datum van het besluit van de algemene vergadering, JJJJ-MM-DD.' },
      dividend_eur: { type: 'number', description: 'Hoeveel er als dividend wordt toegekend, in euro. Standaard 0 — dan gaat alles naar de reserves.' },
      board_approved: { type: 'boolean', description: 'Het bestuur keurt de uitkering goed (art. 2:216 lid 2 BW). Verplicht zodra er dividend wordt toegekend.' },
      note: { type: 'string', description: 'Bijvoorbeeld een verwijzing naar de notulen van de AvA.' },
    },
    required: ['fiscal_year_id', 'decision_date'],
    async plan(ctx, input) {
      const fiscalYearId = id(input, 'fiscal_year_id');
      const year = await fiscalYear(ctx, fiscalYearId);
      if (year.status !== 'closed') {
        throw new ActionError(`Boekjaar ${year.label} staat nog open. Sluit het eerst af; een resultaat is pas te bestemmen als het vaststaat.`);
      }
      const resultCents = year.result_cents ?? year.computed_result_cents ?? 0;
      const decisionDate = isoDate(input, 'decision_date');
      const dividendCents = optCents(input, 'dividend_eur') ?? 0;
      if (dividendCents < 0) throw new ActionError('Een negatief dividend bestaat niet.');
      if (dividendCents > 0 && resultCents <= 0) {
        throw new ActionError(`Boekjaar ${year.label} sloot met ${euroCents(resultCents)}; uit een verlies valt niets uit te keren.`);
      }
      if (dividendCents > resultCents) {
        throw new ActionError(`Het toegekende dividend (${euroCents(dividendCents)}) is hoger dan het resultaat van ${year.label} (${euroCents(resultCents)}).`);
      }
      const boardApproved = bool(input, 'board_approved', false);
      if (dividendCents > 0 && !boardApproved) {
        throw new ActionError('Zonder bestuursgoedkeuring van de uitkeringstoets (art. 2:216 lid 2 BW) kan er geen dividend worden toegekend. Vraag de gebruiker of het bestuur die goedkeuring geeft.');
      }
      const reservesCents = resultCents - dividendCents;

      return {
        title: `Resultaatbestemming ${year.label} vastleggen en boeken: ${euroCents(resultCents)}`,
        sub: joinShort([
          `${euroCents(reservesCents)} naar de overige reserves (0520)`,
          dividendCents > 0 ? `${euroCents(dividendCents)} als dividendschuld (1580)` : 'geen dividend',
          `besluit van ${dateNL(decisionDate)}`,
          'ONOMKEERBAAR: dit maakt meteen een boekstuk in het grootboek' + (dividendCents > 0 ? ' en een dividendschuld' : ''),
        ], 220),
        kind: 'money',
        payload: {
          fiscal_year_label: year.label,
          input: {
            fiscalYearId, decisionDate,
            reservesCents, dividendCents,
            boardApproved,
            note: optStr(input, 'note', 500),
          },
        },
      };
    },
  },

  {
    id: 'result_appropriation.reverse',
    label: 'Resultaatbestemming terugdraaien',
    module: 'finance',
    kind: 'write',
    description:
      'Zet een geboekte resultaatbestemming op "teruggedraaid", zodat zij nergens meer meetelt. Er komt geen spiegelpost — die zou op een datum vallen die inmiddels in een afgesloten aangifteperiode kan liggen; het boekstuk zelf gaat op reversed. ' +
      'Alleen een eigenaar of beheerder kan dit, en alleen als er geen opgemaakte jaarrekening op dit boekjaar rust. Is er al dividend uitgekeerd op dit besluit, draai dan eerst die uitkering terug.',
    keywords: ['resultaatbestemming terugdraaien', 'winstbestemming ongedaan', 'reversed', 'corrigeren'],
    input: {
      appropriation_id: { type: 'string', description: 'Id uit result_appropriation.list.' },
    },
    required: ['appropriation_id'],
    async plan(ctx, input) {
      const appropriationId = id(input, 'appropriation_id');
      const appropriation = await row<{
        decision_date: string; result_cents: number; reserves_cents: number; dividend_cents: number; status: string;
      }>(ctx, 'result_appropriations', appropriationId,
        'decision_date, result_cents, reserves_cents, dividend_cents, status', 'Resultaatbestemming');
      if (appropriation.status !== 'posted') throw new ActionError('Deze resultaatbestemming is al teruggedraaid.');

      return {
        title: `Resultaatbestemming van ${dateNL(appropriation.decision_date)} terugdraaien`,
        sub: joinShort([
          `${euroCents(appropriation.reserves_cents)} reserves en ${euroCents(appropriation.dividend_cents)} dividend tellen nergens meer mee`,
          'raakt een geboekt boekstuk in een mogelijk afgesloten periode',
        ], 190),
        kind: 'money',
        payload: { appropriation_id: appropriationId, decision_date: appropriation.decision_date },
      };
    },
  },

  // ══ Dividend ═════════════════════════════════════════════════════════════
  {
    id: 'dividend.list',
    label: 'Dividenduitkeringen en de afdrachtdeadline bekijken',
    module: 'finance',
    kind: 'read',
    description:
      'Alle dividenduitkeringen met soort (uit de vastgestelde winst of tussentijds), besluitdatum, datum van terbeschikkingstelling, bruto, ingehouden dividendbelasting, netto, het toegepaste tarief, de boekstukken en de uiterste aangiftedatum — één maand na terbeschikkingstelling (art. 19 lid 3 AWR). ' +
      'Is die datum verstreken en staat de uitkering nog op "posted", dan is de aangifte dividendbelasting te laat.',
    keywords: ['dividend', 'uitkering', 'dividendbelasting', 'afdracht', 'aangifte', 'deadline', 'inhouding'],
    input: {},
    async read(ctx) {
      const { data, error } = await ctx.db.rpc('list_dividend_distributions', { p_organization_id: ctx.organizationId });
      if (error) throw new ActionError(`Dividenduitkeringen ophalen mislukt: ${error.message}`);
      return { today: ctx.today, distributions: data ?? [] };
    },
  },

  {
    id: 'dividend.detail',
    label: 'Specificatie van één dividenduitkering bekijken',
    module: 'finance',
    kind: 'read',
    description:
      'De regels van één uitkering: per aandeelhouder naam, adres, aantal aandelen, bruto, of de inhoudingsvrijstelling gold met de onderbouwing, ingehouden en netto. ' +
      'Dit is de onderbouwing van de aangifte dividendbelasting en de inhoud van de dividendnota. Let op: dit zijn persoonsgegevens van aandeelhouders — deel ze alleen met wie erom vraagt.',
    keywords: ['dividendnota', 'specificatie', 'per aandeelhouder', 'inhouding', 'aangifte dividendbelasting'],
    input: {
      distribution_id: { type: 'string', description: 'Id uit dividend.list.' },
    },
    required: ['distribution_id'],
    async read(ctx, input) {
      const distributionId = id(input, 'distribution_id');
      const distribution = await row<{ kind: string; decision_date: string; available_date: string; gross_cents: number; tax_cents: number; net_cents: number; status: string }>(
        ctx, 'dividend_distributions', distributionId,
        'kind, decision_date, available_date, gross_cents, tax_cents, net_cents, status', 'Dividenduitkering');
      const { data, error } = await ctx.db.rpc('dividend_distribution_detail', {
        p_organization_id: ctx.organizationId,
        p_distribution_id: distributionId,
      });
      if (error) throw new ActionError(`Specificatie ophalen mislukt: ${error.message}`);
      return { distribution, lines: data ?? [] };
    },
  },

  {
    id: 'dividend.declare',
    label: 'Dividend uitkeren, inhouden en boeken',
    module: 'finance',
    kind: 'write',
    description:
      'Legt een dividenduitkering vast, berekent per aandeelhouder de dividendbelasting en boekt beide. Twee wegen: `final` gaat op een eerder vastgelegde resultaatbestemming (het bruto bedrag moet dan exact overeenkomen met het toegekende dividend, want dat staat al als schuld op 1580) en `interim` ontstaat hier — dan toetst de database de balanstest en is `board_approved` verplicht (art. 2:216 lid 2 BW). ' +
      'De inhouding is per ontvanger: bij een aandeelhouder met inhoudingsvrijstelling (art. 4 Wet DB 1965) blijft zij achterwege. ' +
      'Geef ofwel `lines` met een bedrag per aandeelhouder, ofwel `distribute_pro_rata` met `total_eur` — dan wordt het bedrag naar belang op de besluitdatum verdeeld en krijgt de laatste aandeelhouder het afrondingsrestje.',
    keywords: ['dividend uitkeren', 'dividendbelasting', 'inhouden', 'interim-dividend', 'uitkering', 'naar belang verdelen', 'pro rata'],
    input: {
      kind: { type: 'string', enum: [...DIVIDEND_KINDS], description: 'final = uit de vastgestelde winst, interim = tussentijds.' },
      decision_date: { type: 'string', description: 'Datum van het besluit, JJJJ-MM-DD.' },
      available_date: { type: 'string', description: 'Datum van terbeschikkingstelling; niet vóór het besluit. Hierop wordt ingehouden en hiervan loopt de aangiftetermijn van één maand.' },
      result_appropriation_id: { type: 'string', description: 'Verplicht bij kind=final: het besluit waaruit dit dividend komt (uit result_appropriation.list).' },
      lines: {
        type: 'array',
        description: 'Per aandeelhouder een bruto bedrag.',
        items: {
          type: 'object',
          properties: {
            shareholder_id: { type: 'string' },
            gross_eur: { type: 'number', description: 'Bruto in euro, groter dan nul.' },
          },
        },
      },
      distribute_pro_rata: { type: 'boolean', description: 'Verdeel `total_eur` naar belang op de besluitdatum in plaats van `lines` te gebruiken.' },
      total_eur: { type: 'number', description: 'Totaal bruto bij pro-rata verdeling.' },
      board_approved: { type: 'boolean', description: 'Bestuursgoedkeuring van de uitkeringstoets; verplicht bij kind=interim.' },
      source_account_code: { type: 'string', description: 'Bij kind=interim: ten laste van welke rekening, standaard 0520 (vrije reserves).' },
      note: { type: 'string' },
    },
    required: ['kind', 'decision_date', 'available_date'],
    async plan(ctx, input) {
      const kind = choice(input, 'kind', DIVIDEND_KINDS);
      const decisionDate = isoDate(input, 'decision_date');
      const availableDate = isoDate(input, 'available_date');
      if (availableDate < decisionDate) throw new ActionError('Het dividend kan niet ter beschikking zijn gesteld vóór het besluit.');

      // Wie er iets krijgt, en hoeveel.
      let lines: Array<{ shareholderId: string; grossCents: number }> = [];
      if (bool(input, 'distribute_pro_rata', false)) {
        const totalCents = cents(input, 'total_eur');
        if (totalCents <= 0) throw new ActionError('Geef bij een pro-rata verdeling een positief "total_eur".');
        const { data: positions, error } = await ctx.db.rpc('shareholder_positions', {
          p_organization_id: ctx.organizationId,
          p_as_of: decisionDate,
        });
        if (error) throw new ActionError(`Aandelenbezit ophalen mislukt: ${error.message}`);
        // Eén regel per aandeelhouder: het register kan meerdere soorten aandelen
        // per persoon kennen, maar een dividendbedrag krijgt hij één keer.
        const byHolder = new Map<string, number>();
        for (const p of (positions ?? []) as Array<{ shareholder_id: string; share_basis_points: number }>) {
          byHolder.set(p.shareholder_id, (byHolder.get(p.shareholder_id) ?? 0) + (p.share_basis_points ?? 0));
        }
        const withShares = [...byHolder.entries()].filter(([, bp]) => bp > 0);
        if (withShares.length === 0) throw new ActionError(`Op ${dateNL(decisionDate)} staat er geen aandelenbezit in het register; er valt niets te verdelen.`);
        let handed = 0;
        lines = withShares.map(([shareholderId, bp], index) => {
          // De laatste krijgt het afrondingsrestje, anders telt de verdeling niet
          // op tot het besluit en weigert de database bij een final-dividend terecht.
          const grossCents = index === withShares.length - 1 ? totalCents - handed : Math.round((totalCents * bp) / 10000);
          handed += grossCents;
          return { shareholderId, grossCents };
        });
      } else {
        const raw = Array.isArray(input.lines) ? input.lines as Array<Record<string, unknown>> : [];
        if (raw.length === 0) throw new ActionError('Geef "lines" met een bedrag per aandeelhouder, of zet "distribute_pro_rata" aan met een "total_eur".');
        lines = raw.map((line) => {
          const shareholderId = id(line, 'shareholder_id');
          const grossCents = cents(line, 'gross_eur');
          if (grossCents <= 0) throw new ActionError('Elk bruto bedrag moet groter dan nul zijn; laat aandeelhouders zonder uitkering gewoon weg.');
          return { shareholderId, grossCents };
        });
      }

      const grossCents = lines.reduce((sum, l) => sum + l.grossCents, 0);
      if (grossCents <= 0) throw new ActionError('Het totale bruto dividend moet groter dan nul zijn.');

      // De namen en de vrijstelling erbij, zodat de kaart leesbaar is en de
      // inhouding vooraf te zien is.
      const named: Array<{ shareholderId: string; grossCents: number; name: string; exempt: boolean }> = [];
      for (const line of lines) {
        const holder = await row<{ name: string; withholding_exempt: boolean }>(
          ctx, 'shareholders', line.shareholderId, 'name, withholding_exempt', 'Aandeelhouder');
        named.push({ ...line, name: holder.name, exempt: holder.withholding_exempt });
      }

      let appropriationLabel: string | null = null;
      let resultAppropriationId: string | null = null;
      if (kind === 'final') {
        resultAppropriationId = optId(input, 'result_appropriation_id');
        if (!resultAppropriationId) throw new ActionError('Bij een dividend uit de vastgestelde winst is "result_appropriation_id" verplicht; kies het besluit uit `result_appropriation.list`.');
        const appropriation = await row<{ decision_date: string; dividend_cents: number; status: string }>(
          ctx, 'result_appropriations', resultAppropriationId, 'decision_date, dividend_cents, status', 'Resultaatbestemming');
        if (appropriation.status !== 'posted') throw new ActionError('Dat besluit is teruggedraaid; daar kan geen dividend meer op worden uitgekeerd.');
        if (appropriation.dividend_cents !== grossCents) {
          throw new ActionError(`De verdeling moet precies het toegekende dividend van ${euroCents(appropriation.dividend_cents)} bedragen; nu is het ${euroCents(grossCents)}.`);
        }
        appropriationLabel = `besluit van ${dateNL(appropriation.decision_date)}`;
      }

      const boardApproved = bool(input, 'board_approved', false);
      if (kind === 'interim' && !boardApproved) {
        throw new ActionError('Een tussentijdse uitkering heeft de bestuursgoedkeuring van de uitkeringstoets nodig (art. 2:216 lid 2 BW). Zonder die goedkeuring heeft het besluit geen gevolgen. Vraag de gebruiker daar uitdrukkelijk om.');
      }
      const sourceAccountCode = kind === 'interim' ? (optStr(input, 'source_account_code', 20) ?? '0520') : null;

      // Het tarief is alleen ter informatie op de kaart; de database zoekt het bij
      // het boeken zelf opnieuw op.
      const { data: rateData } = await ctx.db.rpc('dividend_tax_rate_on', { p_date: availableDate });
      const rate = typeof rateData === 'number' ? rateData : null;
      const taxCents = rate === null ? 0
        : named.reduce((sum, l) => sum + (l.exempt ? 0 : Math.round((l.grossCents * rate) / 10000)), 0);

      return {
        title: `Dividend uitkeren: ${euroCents(grossCents)} bruto aan ${named.length} aandeelhouder${named.length === 1 ? '' : 's'}`,
        sub: joinShort([
          DIVIDEND_KIND_LABELS[kind],
          appropriationLabel,
          `ter beschikking ${dateNL(availableDate)}`,
          rate === null
            ? 'LET OP: voor die datum is geen tarief dividendbelasting vastgelegd'
            : `inhouding ${euroCents(taxCents)} (${pct(rate)}), netto ${euroCents(grossCents - taxCents)}`,
          named.map((l) => `${l.name} ${euroCents(l.grossCents)}${l.exempt ? ' (vrijgesteld)' : ''}`).join(', '),
          'ONOMKEERBAAR: twee boekstukken, een afdrachtschuld dividendbelasting en een aangifte uiterlijk één maand na terbeschikkingstelling',
        ], 320),
        kind: 'money',
        payload: {
          gross_cents: grossCents,
          input: {
            kind, decisionDate, availableDate,
            lines: named.map((l) => ({ shareholderId: l.shareholderId, grossCents: l.grossCents })),
            resultAppropriationId,
            boardApproved: kind === 'interim' ? boardApproved : undefined,
            sourceAccountCode: sourceAccountCode ?? undefined,
            note: optStr(input, 'note', 500),
          },
        },
      };
    },
  },

  {
    id: 'dividend.reverse',
    label: 'Dividenduitkering terugdraaien',
    module: 'finance',
    kind: 'write',
    description:
      'Draait een geboekte dividenduitkering terug: beide boekstukken (het besluit en de inhouding) gaan op "teruggedraaid". Alleen een eigenaar of beheerder kan dit. ' +
      'Let op: de afdrachtverplichting die door de terbeschikkingstelling is ontstaan verdwijnt hiermee niet vanzelf uit de werkelijkheid — is er al aangifte dividendbelasting gedaan, overleg dan met de adviseur.',
    keywords: ['dividend terugdraaien', 'uitkering ongedaan', 'reversed', 'corrigeren'],
    input: {
      distribution_id: { type: 'string', description: 'Id uit dividend.list.' },
    },
    required: ['distribution_id'],
    async plan(ctx, input) {
      const distributionId = id(input, 'distribution_id');
      const distribution = await row<{ kind: string; decision_date: string; available_date: string; gross_cents: number; tax_cents: number; status: string }>(
        ctx, 'dividend_distributions', distributionId,
        'kind, decision_date, available_date, gross_cents, tax_cents, status', 'Dividenduitkering');
      if (distribution.status !== 'posted') throw new ActionError('Deze uitkering is al teruggedraaid.');

      return {
        title: `Dividenduitkering van ${dateNL(distribution.decision_date)} terugdraaien: ${euroCents(distribution.gross_cents)}`,
        sub: joinShort([
          DIVIDEND_KIND_LABELS[distribution.kind] ?? distribution.kind,
          `inclusief ${euroCents(distribution.tax_cents)} ingehouden dividendbelasting`,
          `ter beschikking gesteld op ${dateNL(distribution.available_date)}`,
          'raakt twee geboekte boekstukken en een reeds ontstane afdrachtverplichting',
        ], 220),
        kind: 'money',
        payload: { distribution_id: distributionId, decision_date: distribution.decision_date, gross_cents: distribution.gross_cents },
      };
    },
  },

  // ══ DGA: gebruikelijk loon en rekening-courant ═══════════════════════════
  {
    id: 'dga.signals',
    label: 'DGA-signalen bekijken: gebruikelijk loon en rekening-courant',
    module: 'finance',
    kind: 'read',
    description:
      'De kale feiten uit de eigen administratie voor één jaar: het normbedrag gebruikelijk loon naast het geboekte brutoloon, het saldo van de rekening-courant DGA op 31 december (de peildatum voor excessief lenen) en de hoogste stand van het jaar (de toets voor de renteloze grens), met de grenzen ernaast. ' +
      'ResoFly trekt geen conclusies over de fiscale gevolgen; het toont wat er in de boeken staat.',
    keywords: ['dga', 'gebruikelijk loon', 'rekening-courant', 'excessief lenen', 'renteloze grens', 'directeur-grootaandeelhouder'],
    input: {
      year: { type: 'number', description: 'Kalenderjaar. Standaard het lopende jaar.' },
    },
    async read(ctx, input) {
      const year = Math.trunc(optNum(input, 'year') ?? Number(ctx.today.slice(0, 4)));
      const { data, error } = await ctx.db.rpc('dga_signals', { p_organization_id: ctx.organizationId, p_year: year });
      if (error) throw new ActionError(`DGA-signalen ophalen mislukt: ${error.message}`);
      return { year, signals: data ?? null };
    },
  },

  {
    id: 'dga.interest',
    label: 'Renteberekening over de rekening-courant DGA bekijken',
    module: 'finance',
    kind: 'read',
    description:
      'De over het dagsaldo berekende rente van een jaar: per tariefperiode het percentage, het aantal dagen, het gemiddelde saldo en de rente, met de vastgelegde percentagestaffel erbij en of de rente al is geboekt. ' +
      '`hasDaysWithoutRate` betekent dat er dagen zijn zonder vastgelegd percentage; dan kan er niet geboekt worden en moet er eerst een percentage bij.',
    keywords: ['rekening-courant rente', 'dga rente', 'rentepercentage', 'dagsaldo', 'renteberekening'],
    input: {
      year: { type: 'number', description: 'Kalenderjaar. Standaard het lopende jaar.' },
    },
    async read(ctx, input) {
      const year = Math.trunc(optNum(input, 'year') ?? Number(ctx.today.slice(0, 4)));
      const { data: computation, error } = await ctx.db.rpc('compute_dga_interest', {
        p_organization_id: ctx.organizationId, p_year: year,
      });
      if (error) throw new ActionError(`Renteberekening ophalen mislukt: ${error.message}`);
      const { data: rates } = await orgQuery(ctx, 'dga_interest_rates', 'id, valid_from, rate_basis_points, basis_note')
        .order('valid_from', { ascending: false });
      const { data: postings } = await orgQuery(ctx, 'dga_interest_postings', 'id, year, interest_cents, status, journal_entry_id')
        .eq('year', year);
      return { year, computation: computation ?? null, rates: rates ?? [], postings: postings ?? [] };
    },
  },

  {
    id: 'dga.add_interest_rate',
    label: 'Rentepercentage rekening-courant DGA vastleggen',
    module: 'finance',
    kind: 'write',
    description:
      'Legt vanaf een datum een rentepercentage vast voor de rekening-courant met de DGA. De Belastingdienst schrijft geen percentage voor: het moet zakelijk zijn — wat de BV elders als particuliere belegger zou krijgen. Hypotheekrentes, interbancaire tarieven en rekening-courantkredieten zijn uitdrukkelijk géén maatstaf, en ResoFly vult bewust niets voor. ' +
      'Vraag de gebruiker dus altijd zelf om het percentage én om de onderbouwing; verzin het niet. Het percentage geldt tot er een nieuw percentage met een latere ingangsdatum bij komt.',
    keywords: ['rentepercentage', 'zakelijke rente', 'rekening-courant', 'dga', 'staffel', 'rente vastleggen'],
    input: {
      valid_from: { type: 'string', description: 'Vanaf welke datum dit percentage geldt, JJJJ-MM-DD.' },
      rate_percent: { type: 'number', description: 'Percentage, bijvoorbeeld 4.5 voor 4,50%.' },
      basis_note: { type: 'string', description: 'Onderbouwing: waarop is dit percentage gebaseerd?' },
    },
    required: ['valid_from', 'rate_percent'],
    async plan(ctx, input) {
      const validFrom = isoDate(input, 'valid_from');
      const ratePercent = num(input, 'rate_percent');
      if (ratePercent <= 0) throw new ActionError('Vul een percentage groter dan nul in.');
      if (ratePercent > 100) throw new ActionError('Een rente van meer dan 100% is vrijwel zeker een typefout; controleer het percentage.');
      const rateBasisPoints = Math.round(ratePercent * 100);
      const basisNote = optStr(input, 'basis_note', 500);
      const { data: existing } = await orgQuery(ctx, 'dga_interest_rates', 'valid_from')
        .eq('valid_from', validFrom).maybeSingle();
      if (existing) throw new ActionError(`Er staat al een percentage vanaf ${dateNL(validFrom)} in de staffel.`);

      return {
        title: `Rentepercentage rekening-courant DGA vastleggen: ${pct(rateBasisPoints)} vanaf ${dateNL(validFrom)}`,
        sub: joinShort([
          basisNote ?? 'geen onderbouwing opgegeven',
          'ResoFly schrijft geen percentage voor; dit moet zakelijk zijn en onderbouwd',
        ], 170),
        kind: 'money',
        payload: {
          rate_label: pct(rateBasisPoints),
          valid_from: validFrom,
          input: { validFrom, rateBasisPoints, basisNote },
        },
      };
    },
  },

  {
    id: 'dga.book_interest',
    label: 'Rente over de rekening-courant DGA boeken',
    module: 'finance',
    kind: 'write',
    description:
      'Boekt de over het dagsaldo berekende jaarrente op de rekening-courant DGA, tegen 9000 Rentebaten of 9100 Rentelasten. ' +
      'Kan alleen als er voor het hele jaar een percentage is vastgelegd; is er ook maar één dag zonder percentage, dan weigert dit. Bekijk eerst `dga.interest`.',
    keywords: ['rente boeken', 'dga rente', 'rekening-courant', 'journaalpost', 'rentebaten', 'rentelasten'],
    input: {
      year: { type: 'number', description: 'Kalenderjaar waarover de rente wordt geboekt.' },
    },
    required: ['year'],
    async plan(ctx, input) {
      const year = Math.trunc(num(input, 'year'));
      const { data, error } = await ctx.db.rpc('compute_dga_interest', { p_organization_id: ctx.organizationId, p_year: year });
      if (error) throw new ActionError(`Renteberekening ophalen mislukt: ${error.message}`);
      const computation = (data ?? null) as { interestCents: number; hasDaysWithoutRate: boolean; daysInYear: number } | null;
      if (!computation) throw new ActionError(`Er valt over ${year} geen rente te berekenen.`);
      if (computation.hasDaysWithoutRate) {
        throw new ActionError(`Over ${year} zijn er dagen zonder vastgelegd rentepercentage. Leg eerst met \`dga.add_interest_rate\` voor het hele jaar een percentage vast.`);
      }
      if (computation.interestCents === 0) throw new ActionError(`De berekende rente over ${year} is nul; er valt niets te boeken.`);

      const { data: posted } = await orgQuery(ctx, 'dga_interest_postings', 'id, status')
        .eq('year', year).eq('status', 'posted').maybeSingle();
      if (posted) throw new ActionError(`De rente over ${year} is al geboekt. Draai die eerst terug met \`dga.reverse_interest\`.`);

      return {
        title: `DGA-rente ${year} boeken: ${euroCents(computation.interestCents)}`,
        sub: joinShort([
          `berekend over het dagsaldo van ${computation.daysInYear} dagen`,
          'komt op de rekening-courant DGA tegen 9000 Rentebaten of 9100 Rentelasten',
          'ONOMKEERBAAR: dit is een echte journaalpost in het grootboek',
        ], 200),
        kind: 'money',
        payload: { year, interest_cents: computation.interestCents },
      };
    },
  },

  {
    id: 'dga.reverse_interest',
    label: 'Geboekte DGA-rente terugdraaien',
    module: 'finance',
    kind: 'write',
    description:
      'Draait de geboekte rente over de rekening-courant DGA van een jaar terug; het boekstuk gaat op "teruggedraaid". Alleen een eigenaar of beheerder kan dit. Zoek de boeking eerst op met `dga.interest`.',
    keywords: ['rente terugdraaien', 'dga rente', 'reversed', 'corrigeren'],
    input: {
      posting_id: { type: 'string', description: 'Id van de renteboeking (uit dga.interest, veld postings[].id).' },
    },
    required: ['posting_id'],
    async plan(ctx, input) {
      const postingId = id(input, 'posting_id');
      const posting = await row<{ year: number; interest_cents: number; status: string }>(
        ctx, 'dga_interest_postings', postingId, 'year, interest_cents, status', 'Renteboeking');
      if (posting.status !== 'posted') throw new ActionError('Deze renteboeking is al teruggedraaid.');

      return {
        title: `DGA-rente ${posting.year} terugdraaien: ${euroCents(posting.interest_cents)}`,
        sub: 'het geboekte rentestuk telt nergens meer mee; de rekening-courant staat weer zonder rente over dat jaar',
        kind: 'money',
        payload: { posting_id: postingId, year: posting.year, interest_cents: posting.interest_cents },
      };
    },
  },

  // ══ Loonjournaalpost ═════════════════════════════════════════════════════
  {
    id: 'payroll.post_journal',
    label: 'Loonjournaalpost van de salarisverwerker boeken',
    module: 'finance',
    kind: 'write',
    description:
      'Boekt de complete loonjournaalpost van de salarisverwerker in één keer als één boekstuk: loonkosten, nettolonen en loonheffingsschulden. ' +
      'ResoFly voert géén salarisadministratie en rekent niets na — wij kennen de loonheffingstabellen niet. Neem letterlijk over wat de verwerker heeft berekend; wij controleren alleen dat de post sluit en dat elke grootboekrekening bestaat. ' +
      'Geef per regel de grootboekcode en een debet- óf creditbedrag; de totalen moeten exact gelijk zijn.',
    keywords: ['loonjournaalpost', 'salaris', 'loonheffing', 'payroll', 'loonkosten', 'journaalpost boeken', 'nmbrs', 'loonstrook'],
    input: {
      date: { type: 'string', description: 'Boekdatum JJJJ-MM-DD.' },
      description: { type: 'string', description: 'Omschrijving van het boekstuk, bv. "Loonjournaalpost maart 2026".' },
      lines: {
        type: 'array',
        description: 'De regels van de journaalpost, letterlijk zoals de salarisverwerker ze geeft.',
        items: {
          type: 'object',
          properties: {
            account_code: { type: 'string', description: 'Grootboekcode, bv. 4000.' },
            description: { type: 'string' },
            debit_eur: { type: 'number', description: 'Debetbedrag in euro (0 als de regel credit is).' },
            credit_eur: { type: 'number', description: 'Creditbedrag in euro (0 als de regel debet is).' },
          },
        },
      },
    },
    required: ['date', 'description', 'lines'],
    async plan(ctx, input) {
      const date = isoDate(input, 'date');
      const description = str(input, 'description', 200);
      const raw = Array.isArray(input.lines) ? input.lines as Array<Record<string, unknown>> : [];
      if (raw.length === 0) throw new ActionError('Geef de regels van de loonjournaalpost mee.');

      const lines = raw.map((line) => {
        const accountCode = str(line, 'account_code', 20);
        const debitCents = Math.round((optNum(line, 'debit_eur') ?? 0) * 100);
        const creditCents = Math.round((optNum(line, 'credit_eur') ?? 0) * 100);
        if (debitCents < 0 || creditCents < 0) throw new ActionError(`Regel ${accountCode}: bedragen zijn nooit negatief; zet het bedrag op de andere kant.`);
        if (debitCents === 0 && creditCents === 0) throw new ActionError(`Regel ${accountCode} heeft geen bedrag.`);
        if (debitCents > 0 && creditCents > 0) throw new ActionError(`Regel ${accountCode} heeft zowel een debet- als een creditbedrag; kies er één.`);
        return { accountCode, description: optStr(line, 'description', 200) ?? description, debitCents, creditCents };
      });

      const totalDebit = lines.reduce((sum, l) => sum + l.debitCents, 0);
      const totalCredit = lines.reduce((sum, l) => sum + l.creditCents, 0);
      if (totalDebit !== totalCredit) {
        throw new ActionError(`De post sluit niet: ${euroCents(totalDebit)} debet tegen ${euroCents(totalCredit)} credit. Controleer de export van de salarisverwerker.`);
      }

      const codes = [...new Set(lines.map((l) => l.accountCode))];
      const { data: accounts, error } = await orgQuery(ctx, 'ledger_accounts', 'code, name').in('code', codes);
      if (error) throw new ActionError(`Grootboekrekeningen ophalen mislukt: ${error.message}`);
      const known = new Set((accounts ?? []).map((a: { code: string }) => a.code));
      const missing = codes.filter((c) => !known.has(c));
      if (missing.length > 0) {
        throw new ActionError(`Deze grootboekrekeningen bestaan niet in deze administratie: ${missing.join(', ')}. Zoek ze op met \`list_ledger_accounts\`.`);
      }

      return {
        title: `Loonjournaalpost boeken: ${description}`,
        sub: joinShort([
          `${lines.length} regels, ${euroCents(totalDebit)} debet = credit`,
          `boekdatum ${dateNL(date)}`,
          `rekeningen ${codes.join(', ')}`,
          'ONOMKEERBAAR: maakt een journaalpost met loonkosten en loonheffingsschulden in het grootboek',
        ], 230),
        kind: 'money',
        payload: { description, input: { date, description, lines } },
      };
    },
  },

  // ══ Vennootschapsbelasting ═══════════════════════════════════════════════
  {
    id: 'corporate_tax.compute',
    label: 'Vennootschapsbelasting van een boekjaar doorrekenen',
    module: 'finance',
    kind: 'read',
    description:
      'Rekent de Vpb van een boekjaar door zonder iets op te slaan of te boeken: van het commerciële resultaat via de fiscale correcties naar de fiscale winst, dan de verliesverrekening (art. 20 lid 2 Wet Vpb), het belastbare bedrag (naar beneden afgerond op € 5), de belasting volgens de cumulatieve tariefschijven van art. 22 Wet Vpb, de betaalde voorlopige aanslagen en het saldo. ' +
      'Geeft ook de nog te verrekenen verliezen mee, met de aantekening of ze bij beschikking zijn vastgesteld of alleen onze eigen berekening zijn. Dit is een hulpmiddel, geen aangifte en geen advies.',
    keywords: ['vpb', 'vennootschapsbelasting', 'berekenen', 'belastbaar bedrag', 'verliesverrekening', 'tarief', 'fiscale winst'],
    input: {
      fiscal_year_id: { type: 'string', description: 'Id van het boekjaar (uit list_fiscal_years).' },
    },
    required: ['fiscal_year_id'],
    async read(ctx, input) {
      const fiscalYearId = id(input, 'fiscal_year_id');
      await fiscalYear(ctx, fiscalYearId);
      const { inputs, computation } = await computeCorporateTax(ctx, fiscalYearId);
      const current = await currentTaxReturn(ctx, fiscalYearId);
      return {
        fiscal_year: inputs.fiscalYear,
        rules_year: inputs.rules.year,
        brackets: inputs.rules.brackets,
        corrections: inputs.corrections,
        losses_carried_forward: inputs.lossesCarriedForward,
        computation,
        stored_return: current,
      };
    },
  },

  {
    id: 'corporate_tax.list',
    label: 'Vastgelegde Vpb-berekeningen en fiscale correcties bekijken',
    module: 'finance',
    kind: 'read',
    description:
      'Geeft per boekjaar de vastgelegde Vpb-berekeningen (concept, vastgesteld of teruggedraaid) met het belastbare bedrag, de belasting, het te betalen saldo en het moment van vaststellen, plus de fiscale correcties die op een boekjaar staan. ' +
      'Geef `fiscal_year_id` mee om de correcties van dat jaar te zien.',
    keywords: ['vpb', 'aangifte', 'berekeningen', 'correcties', 'vastgesteld', 'concept', 'belastingschuld'],
    input: {
      fiscal_year_id: { type: 'string', description: 'Beperk tot één boekjaar en toon de correcties ervan.' },
    },
    async read(ctx, input) {
      const fiscalYearId = optId(input, 'fiscal_year_id');
      let query = orgQuery(ctx, 'corporate_tax_returns',
        'id, fiscal_year_id, year, commercial_result_cents, corrections_cents, fiscal_profit_cents, loss_used_cents, taxable_amount_cents, tax_cents, prepaid_cents, balance_due_cents, status, finalized_at, note')
        .order('year', { ascending: false });
      if (fiscalYearId) query = query.eq('fiscal_year_id', fiscalYearId);
      const { data: returns, error } = await query;
      if (error) throw new ActionError(`Vpb-berekeningen ophalen mislukt: ${error.message}`);

      let corrections: unknown[] = [];
      if (fiscalYearId) {
        const { data, error: correctionError } = await orgQuery(ctx, 'corporate_tax_corrections', 'id, code, label, amount_cents, note')
          .eq('fiscal_year_id', fiscalYearId).order('created_at', { ascending: true });
        if (correctionError) throw new ActionError(`Fiscale correcties ophalen mislukt: ${correctionError.message}`);
        corrections = data ?? [];
      }
      return { returns: returns ?? [], corrections };
    },
  },

  {
    id: 'corporate_tax.add_correction',
    label: 'Fiscale correctie toevoegen aan een boekjaar',
    module: 'finance',
    kind: 'write',
    description:
      'Voegt een correctie toe waarmee de fiscale winst afwijkt van het commerciële resultaat. Een POSITIEF bedrag verhoogt de fiscale winst (niet-aftrekbare kosten, bijvoorbeeld verkeersboetes), een NEGATIEF bedrag verlaagt hem (investeringsaftrek, deelnemingsvrijstelling). ' +
      'Kan alleen zolang de Vpb-berekening van dat boekjaar nog niet is vastgesteld. Verwijderen kan daarna alleen met de hand in het scherm.',
    keywords: ['fiscale correctie', 'niet-aftrekbaar', 'gemengde kosten', 'investeringsaftrek', 'deelnemingsvrijstelling', 'bijtelling', 'vpb'],
    input: {
      fiscal_year_id: { type: 'string' },
      code: { type: 'string', enum: [...CORRECTION_CODES], description: 'Soort correctie.' },
      label: { type: 'string', description: 'Omschrijving, bv. "verkeersboetes".' },
      amount_eur: { type: 'number', description: 'Bedrag in euro; positief verhoogt de fiscale winst, negatief verlaagt hem.' },
      note: { type: 'string' },
    },
    required: ['fiscal_year_id', 'code', 'label', 'amount_eur'],
    async plan(ctx, input) {
      const fiscalYearId = id(input, 'fiscal_year_id');
      const year = await fiscalYear(ctx, fiscalYearId);
      const code = choice(input, 'code', CORRECTION_CODES);
      const label = str(input, 'label', 200);
      const amountCents = cents(input, 'amount_eur');
      if (amountCents === 0) throw new ActionError('Een correctie van nul heeft geen effect.');

      const current = await currentTaxReturn(ctx, fiscalYearId);
      if (current?.status === 'final') {
        throw new ActionError(`De Vpb-berekening van ${year.label} is al vastgesteld en de correcties zitten op slot. Draai de berekening eerst terug met \`corporate_tax.reverse\`.`);
      }

      return {
        title: `Fiscale correctie toevoegen: ${label}`,
        sub: joinShort([
          year.label,
          CORRECTION_LABELS[code],
          `${amountCents > 0 ? 'verhoogt' : 'verlaagt'} de fiscale winst met ${euroCents(Math.abs(amountCents))}`,
        ], 170),
        kind: 'money',
        payload: {
          label, fiscal_year_label: year.label,
          input: { fiscalYearId, code, label, amountCents, note: optStr(input, 'note', 500) },
        },
      };
    },
  },

  {
    id: 'corporate_tax.save_draft',
    label: 'Vpb-berekening opslaan als concept',
    module: 'finance',
    kind: 'write',
    description:
      'Legt de doorgerekende vennootschapsbelasting van een boekjaar vast als concept. Er wordt nog NIETS geboekt en de fiscale correcties blijven aanpasbaar; dit is alleen om de stand te bewaren. ' +
      'Boeken doe je met `corporate_tax.finalize`.',
    keywords: ['vpb concept', 'opslaan', 'berekening bewaren', 'vennootschapsbelasting'],
    input: {
      fiscal_year_id: { type: 'string' },
      note: { type: 'string' },
    },
    required: ['fiscal_year_id'],
    async plan(ctx, input) {
      const fiscalYearId = id(input, 'fiscal_year_id');
      const year = await fiscalYear(ctx, fiscalYearId);
      const current = await currentTaxReturn(ctx, fiscalYearId);
      if (current?.status === 'final') throw new ActionError(`De Vpb-berekening van ${year.label} is al vastgesteld.`);
      const { computation } = await computeCorporateTax(ctx, fiscalYearId);

      return {
        title: `Vpb-berekening ${year.label} opslaan als concept`,
        sub: joinShort([
          `belastbaar bedrag ${euroCents(computation.taxableAmountCents)}`,
          `belasting ${euroCents(computation.taxCents)} (gemiddeld ${pct(computation.effectiveRateBasisPoints)})`,
          `${computation.balanceDueCents >= 0 ? 'nog te betalen' : 'terug te ontvangen'} ${euroCents(Math.abs(computation.balanceDueCents))}`,
          'er wordt nog niets geboekt',
        ], 200),
        kind: 'money',
        payload: { fiscal_year_id: fiscalYearId, fiscal_year_label: year.label, note: optStr(input, 'note', 500) },
      };
    },
  },

  {
    id: 'corporate_tax.finalize',
    label: 'Vennootschapsbelasting vaststellen en boeken',
    module: 'finance',
    kind: 'write',
    description:
      'Stelt de Vpb-berekening van een boekjaar definitief vast en BOEKT de last op 9900 Vennootschapsbelasting tegen 1540 Te betalen vennootschapsbelasting, op de balansdatum van het boekjaar. De fiscale correcties gaan daarna op slot. ' +
      'Dit is de grondslag voor de aangifte vennootschapsbelasting — laat de gebruiker de uitkomst eerst bekijken met `corporate_tax.compute`. Indienen doet hij zelf of via zijn accountant; ResoFly doet geen aangifte.',
    keywords: ['vpb vaststellen', 'vennootschapsbelasting boeken', 'belastingschuld', 'reservering', '9900', '1540'],
    input: {
      fiscal_year_id: { type: 'string' },
      note: { type: 'string' },
    },
    required: ['fiscal_year_id'],
    async plan(ctx, input) {
      const fiscalYearId = id(input, 'fiscal_year_id');
      const year = await fiscalYear(ctx, fiscalYearId);
      const current = await currentTaxReturn(ctx, fiscalYearId);
      if (current?.status === 'final') throw new ActionError(`De Vpb-berekening van ${year.label} is al vastgesteld.`);
      const { inputs, computation } = await computeCorporateTax(ctx, fiscalYearId);
      const unestablished = inputs.lossesCarriedForward.filter((l) => !l.establishedByAssessment).length;

      return {
        title: `Vennootschapsbelasting ${year.label} vaststellen en boeken: ${euroCents(computation.taxCents)}`,
        sub: joinShort([
          `belastbaar bedrag ${euroCents(computation.taxableAmountCents)}`,
          `${computation.balanceDueCents >= 0 ? 'nog te betalen' : 'terug te ontvangen'} ${euroCents(Math.abs(computation.balanceDueCents))}`,
          `ONOMKEERBAAR: boekt de last op 9900 tegen 1540 op ${dateNL(year.period_end)} en zet de fiscale correcties op slot`,
          unestablished > 0 ? `let op: ${unestablished} verliespost is nog niet bij beschikking vastgesteld — dat is onze eigen berekening` : null,
        ], 300),
        kind: 'money',
        payload: { fiscal_year_id: fiscalYearId, fiscal_year_label: year.label, note: optStr(input, 'note', 500) },
      };
    },
  },

  {
    id: 'corporate_tax.reverse',
    label: 'Vastgestelde Vpb-berekening terugdraaien',
    module: 'finance',
    kind: 'write',
    description:
      'Draait een vastgestelde Vpb-berekening terug, waardoor de geboekte belastingschuld vervalt en de fiscale correcties weer aanpasbaar worden. Alleen een eigenaar of beheerder kan dit. Zoek de berekening op met `corporate_tax.list`.',
    keywords: ['vpb terugdraaien', 'reservering vervallen', 'belastingschuld ongedaan', 'corrigeren'],
    input: {
      return_id: { type: 'string', description: 'Id van de Vpb-berekening (uit corporate_tax.list).' },
    },
    required: ['return_id'],
    async plan(ctx, input) {
      const returnId = id(input, 'return_id');
      const taxReturn = await row<{ year: number; tax_cents: number; taxable_amount_cents: number; status: string }>(
        ctx, 'corporate_tax_returns', returnId, 'year, tax_cents, taxable_amount_cents, status', 'Vpb-berekening');
      if (taxReturn.status === 'reversed') throw new ActionError('Deze Vpb-berekening is al teruggedraaid.');
      if (taxReturn.status !== 'final') throw new ActionError('Deze berekening staat nog als concept; er valt niets terug te draaien.');

      return {
        title: `Vpb-berekening ${taxReturn.year} terugdraaien: ${euroCents(taxReturn.tax_cents)}`,
        sub: joinShort([
          `de geboekte belastingschuld over een belastbaar bedrag van ${euroCents(taxReturn.taxable_amount_cents)} vervalt`,
          'raakt een geboekt boekstuk; de fiscale correcties worden weer aanpasbaar',
        ], 190),
        kind: 'money',
        payload: { return_id: returnId, year: taxReturn.year },
      };
    },
  },

  // ══ Groottecriteria en jaarrekening (Titel 9 Boek 2 BW) ══════════════════
  {
    id: 'annual_accounts.size',
    label: 'Groottegegevens en grootteklasse van een boekjaar bekijken',
    module: 'finance',
    kind: 'read',
    description:
      'Geeft de vastgelegde groottegegevens van een boekjaar (gemiddeld aantal werknemers, balanstotaal, netto-omzet, vervroegd toepassen van nieuwe drempels, eerste boekjaar, openingsklasse, consoliderende moeder) en de uitkomst van de tweejaarstoets van art. 2:395a/396/397 lid 1 BW: micro, klein, middelgroot of groot, met de volledige onderbouwing en de keten van voorgaande jaren. ' +
      'De tweejaarsregel is PLAKKERIG: een klasse blijft staan tot de rechtspersoon er twee opeenvolgende balansdata niet meer in valt. Staat er een `blockingReason`, dan ontbreekt er iets en weigert het opmaken.',
    keywords: ['grootteklasse', 'micro', 'klein', 'middelgroot', 'groot', 'groottecriteria', 'tweejaarstoets', 'werknemers', 'balanstotaal'],
    input: {
      fiscal_year_id: { type: 'string' },
    },
    required: ['fiscal_year_id'],
    async read(ctx, input) {
      const fiscalYearId = id(input, 'fiscal_year_id');
      const year = await fiscalYear(ctx, fiscalYearId);
      const { data: stored, error } = await orgQuery(ctx, 'fiscal_year_size_inputs',
        'average_employees, total_assets_cents, net_turnover_cents, override_reason, early_adopt_new_thresholds, is_first_fiscal_year_of_entity, opening_size_class, consolidating_parent_name, consolidating_parent_city, note')
        .eq('fiscal_year_id', fiscalYearId).maybeSingle();
      if (error) throw new ActionError(`Groottegegevens ophalen mislukt: ${error.message}`);

      let size: unknown = null;
      let sizeError: string | null = null;
      const { data: sizeData, error: determineError } = await ctx.db.rpc('determine_company_size', {
        p_organization_id: ctx.organizationId,
        p_fiscal_year_id: fiscalYearId,
      });
      if (determineError) sizeError = determineError.message;
      else size = sizeData ?? null;

      return { fiscal_year: { id: year.id, label: year.label, status: year.status }, inputs: stored ?? null, size, size_error: sizeError };
    },
  },

  {
    id: 'annual_accounts.save_size_inputs',
    label: 'Groottegegevens van een boekjaar vastleggen',
    module: 'finance',
    kind: 'write',
    description:
      'Legt vast wat de groottetoets niet uit het grootboek kan halen. Het gemiddeld aantal werknemers over het boekjaar (art. 2:395a/396/397 lid 1 onder c BW) is nergens uit af te leiden en dus verplicht — zonder dat getal is de grootteklasse niet te bepalen en weigert het opmaken. ' +
      'Balanstotaal en netto-omzet worden normaal uit de administratie gehaald; vul ze alleen in als je ze bewust wilt overschrijven, en geef dan een reden. ' +
      '`is_first_fiscal_year_of_entity` en `opening_size_class` zijn het startpunt van de plakkerige tweejaarstoets: zonder een van beide draagt de keten niet. Eerste boekjaar kan alleen op het oudste boekjaar in deze administratie.',
    keywords: ['groottegegevens', 'werknemers', 'balanstotaal', 'netto-omzet', 'grootteklasse', 'drempels', 'consoliderende moeder'],
    input: {
      fiscal_year_id: { type: 'string' },
      average_employees: { type: 'number', description: 'Gemiddeld aantal werknemers over het boekjaar; mag een decimaal zijn.' },
      total_assets_eur: { type: 'number', description: 'Balanstotaal in euro. Leeg laten = uit de administratie halen.' },
      net_turnover_eur: { type: 'number', description: 'Netto-omzet in euro. Leeg laten = uit de administratie halen.' },
      override_reason: { type: 'string', description: 'Waarom wijken balanstotaal of omzet af van de administratie?' },
      early_adopt_new_thresholds: { type: 'boolean', description: 'De nieuwe drempelbedragen vervroegd toepassen.' },
      is_first_fiscal_year_of_entity: { type: 'boolean', description: 'Dit is het eerste boekjaar van de rechtspersoon.' },
      opening_size_class: { type: 'string', enum: [...SIZE_CLASSES], description: 'De klasse op de balansdatum vóór dit boekjaar (bij een overstapper).' },
      consolidating_parent_name: { type: 'string' },
      consolidating_parent_city: { type: 'string' },
      note: { type: 'string' },
    },
    required: ['fiscal_year_id', 'average_employees'],
    async plan(ctx, input) {
      const fiscalYearId = id(input, 'fiscal_year_id');
      const year = await fiscalYear(ctx, fiscalYearId);
      const employees = num(input, 'average_employees');
      if (!(employees >= 0)) throw new ActionError('Het gemiddeld aantal werknemers kan niet negatief zijn.');
      const assetsCents = optCents(input, 'total_assets_eur');
      const turnoverCents = optCents(input, 'net_turnover_eur');
      const overrideReason = optStr(input, 'override_reason', 500);
      if ((assetsCents !== null || turnoverCents !== null) && !overrideReason) {
        throw new ActionError('Geef een reden op als je het balanstotaal of de netto-omzet zelf invult in plaats van ze uit de administratie te halen.');
      }
      const parentName = optStr(input, 'consolidating_parent_name', 200);

      return {
        title: `Groottegegevens ${year.label} vastleggen`,
        sub: joinShort([
          `gemiddeld ${employees} werknemer${employees === 1 ? '' : 's'}`,
          assetsCents === null ? 'balanstotaal uit de administratie' : `balanstotaal ${euroCents(assetsCents)}`,
          turnoverCents === null ? 'netto-omzet uit de administratie' : `netto-omzet ${euroCents(turnoverCents)}`,
          bool(input, 'is_first_fiscal_year_of_entity', false) ? 'eerste boekjaar van de rechtspersoon' : null,
          parentName ? `geconsolideerd door ${parentName}` : null,
        ], 220),
        kind: 'work',
        payload: {
          fiscal_year_label: year.label,
          input: {
            fiscalYearId,
            averageEmployees: employees,
            totalAssetsCents: assetsCents,
            netTurnoverCents: turnoverCents,
            overrideReason,
            earlyAdoptNewThresholds: bool(input, 'early_adopt_new_thresholds', false),
            consolidatingParentName: parentName,
            consolidatingParentCity: optStr(input, 'consolidating_parent_city', 120),
            note: optStr(input, 'note', 500),
            isFirstFiscalYearOfEntity: bool(input, 'is_first_fiscal_year_of_entity', false),
            openingSizeClass: optChoice(input, 'opening_size_class', SIZE_CLASSES),
          },
        },
      };
    },
  },

  {
    id: 'annual_accounts.concept',
    label: 'Conceptcijfers van de jaarrekening bekijken',
    module: 'finance',
    kind: 'read',
    description:
      'Haalt de momentopname op zoals zij bij het opmaken bevroren zou worden — exact hetzelfde beeld als de jaarrekening, alleen ongehashed en niet vastgelegd. ' +
      'Gebruik dit om te zien of de balans sluit, wat het resultaat is, welke grootteklasse eruit komt en of de resultaatbestemming en de Vpb erin zitten, vóórdat er wordt opgemaakt. Er wordt niets opgeslagen.',
    keywords: ['conceptcijfers', 'momentopname', 'balans sluit', 'proefjaarrekening', 'voorbeeld', 'snapshot'],
    input: {
      fiscal_year_id: { type: 'string' },
    },
    required: ['fiscal_year_id'],
    async read(ctx, input) {
      const fiscalYearId = id(input, 'fiscal_year_id');
      await fiscalYear(ctx, fiscalYearId);
      const { data, error } = await ctx.db.rpc('build_annual_accounts_snapshot', {
        p_organization_id: ctx.organizationId,
        p_fiscal_year_id: fiscalYearId,
      });
      if (error) throw new ActionError(`Conceptcijfers ophalen mislukt: ${error.message}`);
      const snapshot = (data ?? null) as Record<string, unknown> | null;
      if (!snapshot) throw new ActionError('Er kwamen geen conceptcijfers terug voor dit boekjaar.');
      // Bewust ingekort: de volledige snapshot bevat elke balans- en W&V-regel en
      // is duizenden tokens groot. Wat je nodig hebt om te BESLISSEN of er kan
      // worden opgemaakt, staat hieronder.
      const balance = snapshot.balanceSheetAfterAppropriation as Record<string, unknown> | null;
      const size = snapshot.size as Record<string, unknown> | null;
      return {
        fiscal_year: snapshot.fiscalYear,
        entity: snapshot.entity,
        balance_totals: balance
          ? {
            total_assets_cents: balance.totalAssetsCents,
            total_equity_and_liabilities_cents: balance.totalEquityAndLiabilitiesCents,
            difference_cents: balance.differenceCents,
            balances: balance.balances,
          }
          : null,
        reconciliation: snapshot.reconciliation,
        distributable_equity_cents: snapshot.distributableEquityCents,
        result_appropriation: snapshot.resultAppropriation,
        corporate_tax: snapshot.corporateTax,
        size: size
          ? {
            size_class: size.sizeClass, raw_class: size.rawClass, publication_set: size.publicationSet,
            audit_required: size.auditRequired, blocking_reason: size.blockingReason, warnings: size.warnings,
          }
          : null,
      };
    },
  },

  {
    id: 'annual_accounts.list',
    label: 'Alle jaarrekeningen en deponeertermijnen bekijken',
    module: 'finance',
    kind: 'read',
    description:
      'Per boekjaar de stand van de jaarrekening (opgemaakt, vastgesteld, gedeponeerd of ingetrokken), de grootteklasse, de opmaak- en deponeertermijnen, hoeveel handtekeningen er staan en hoeveel er zonder opgaaf van reden ontbreken, en of de bevroren cijfers inmiddels van de administratie afwijken. ' +
      'Twee deponeertermijnen komen mee: acht dagen na vaststelling (art. 2:394 lid 1 BW) is na vaststelling de strengste, daarnaast staat de harde twaalfmaandsgrens. De "streefdatum" is betwist — ResoFly kiest daar niet tussen.',
    keywords: ['jaarrekening', 'deponeren', 'termijn', 'kvk', 'handelsregister', 'opgemaakt', 'vastgesteld', 'gedeponeerd', 'deadline'],
    input: {},
    async read(ctx) {
      const { data, error } = await ctx.db.rpc('list_annual_accounts', { p_organization_id: ctx.organizationId });
      if (error) throw new ActionError(`Jaarrekeningen ophalen mislukt: ${error.message}`);
      return { today: ctx.today, annual_accounts: data ?? [] };
    },
  },

  {
    id: 'annual_accounts.get',
    label: 'Eén jaarrekening met handtekeningen en termijnen bekijken',
    module: 'finance',
    kind: 'read',
    description:
      'Eén jaarrekening in detail: stand, opmaakdatum en -termijn met eventuele verlenging, vaststelling en methode, kwijting, deponeringen, grootteklasse en grondslag, de accountantsverklaring, de hash van de bevroren cijfers en of die afwijken, plus per ondertekenaar of hij heeft getekend en zo niet, welke reden er is vastgelegd. ' +
      'De bevroren cijfers zelf zitten hier niet in; die zijn te groot. Gebruik de handtekening-id\'s uit dit antwoord voor `annual_accounts.sign`.',
    keywords: ['jaarrekening detail', 'handtekeningen', 'ondertekenaars', 'termijnen', 'deponering', 'hash'],
    input: {
      annual_account_id: { type: 'string', description: 'Id uit annual_accounts.list.' },
    },
    required: ['annual_account_id'],
    async read(ctx, input) {
      const account = await annualAccount(ctx, id(input, 'annual_account_id'));
      const { deadlines, signatures, ...rest } = account;
      return { account: rest, signatures, deadlines };
    },
  },

  {
    id: 'annual_accounts.prepare',
    label: 'Jaarrekening opmaken en de cijfers bevriezen',
    module: 'finance',
    kind: 'write',
    description:
      'Maakt de jaarrekening op (art. 2:210 lid 1 BW): de cijfers worden BEVROREN met een sha256-hash en de opmaaktermijn wordt vastgeklonken. Vanaf dat moment komt alles uit die momentopname; het boekjaar heropenen of de resultaatbestemming terugdraaien kan pas nadat dit stuk is ingetrokken. ' +
      'Verplicht: minstens één bestuurder als ondertekenaar — alle bestuurders én alle commissarissen horen erbij (art. 2:210 lid 2 BW). Waarderen op fiscale grondslagen mag alleen bij een kleine of micro-rechtspersoon en dan alles-of-niets. ' +
      'Ligt er voor dit boekjaar al een GEDEPONEERDE jaarrekening, dan is dit een vervangend stuk en zijn `supersedes_annual_account_id` en `supersede_reason` verplicht; de oude deponering blijft staan, die is een feit (art. 2:394 BW). ' +
      'Bekijk eerst `annual_accounts.concept` en `annual_accounts.size`.',
    keywords: ['jaarrekening opmaken', 'bevriezen', 'ondertekenaars', 'bestuurders', 'commissarissen', 'grondslagen', 'vervangend stuk'],
    input: {
      fiscal_year_id: { type: 'string', description: 'Het afgesloten boekjaar.' },
      prepared_on: { type: 'string', description: 'Opmaakdatum JJJJ-MM-DD. Standaard vandaag.' },
      accounting_basis: { type: 'string', enum: [...ACCOUNTING_BASES], description: 'Waarderingsgrondslagen; standaard commercieel.' },
      signatories: {
        type: 'array',
        description: 'Alle bestuurders en commissarissen die het stuk ondertekenen.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Voor- en achternaam.' },
            role: { type: 'string', enum: [...SIGNATURE_ROLES] },
            shareholder_id: { type: 'string', description: 'Optioneel: dezelfde persoon uit het aandeelhoudersregister.' },
          },
        },
      },
      off_balance_commitments: { type: 'string', description: 'Niet in de balans opgenomen verplichtingen.' },
      policy_change_note: { type: 'string', description: 'Toelichting op een stelselwijziging.' },
      size_class_override: { type: 'string', enum: [...SIZE_CLASSES], description: 'Handmatige grootteklasse; alleen met reden.' },
      size_override_reason: { type: 'string' },
      all_shareholders_are_directors: { type: 'boolean', description: 'Feitelijke bevestiging: alle aandeelhouders zijn tevens bestuurder. Bepaalt of vaststelling door ondertekening (art. 2:210 lid 5 BW) later mogelijk is.' },
      supersedes_annual_account_id: { type: 'string', description: 'De gedeponeerde jaarrekening die dit stuk vervangt.' },
      supersede_reason: { type: 'string', description: 'Waarom was het gedeponeerde stuk onjuist?' },
      note: { type: 'string' },
    },
    required: ['fiscal_year_id', 'signatories'],
    async plan(ctx, input) {
      const fiscalYearId = id(input, 'fiscal_year_id');
      const year = await fiscalYear(ctx, fiscalYearId);
      if (year.status !== 'closed') {
        throw new ActionError(`Boekjaar ${year.label} staat nog open. Een jaarrekening wordt opgemaakt op de afgesloten cijfers.`);
      }
      const preparedOn = optIsoDate(input, 'prepared_on') ?? ctx.today;
      const basis = optChoice(input, 'accounting_basis', ACCOUNTING_BASES) ?? 'commercieel';

      const rawSignatories = Array.isArray(input.signatories) ? input.signatories as Array<Record<string, unknown>> : [];
      if (rawSignatories.length === 0) throw new ActionError('Geef de ondertekenaars op: alle bestuurders en alle commissarissen (art. 2:210 lid 2 BW).');
      const signatories = rawSignatories.map((s) => ({
        name: str(s, 'name', 200),
        role: choice(s, 'role', SIGNATURE_ROLES),
        shareholderId: optId(s, 'shareholder_id'),
      }));
      if (!signatories.some((s) => s.role === 'bestuurder')) throw new ActionError('Geef minstens één bestuurder op als ondertekenaar.');

      const override = optChoice(input, 'size_class_override', SIZE_CLASSES);
      const overrideReason = optStr(input, 'size_override_reason', 500);
      if (override && !overrideReason) throw new ActionError('Een handmatige grootteklasse kan alleen met opgaaf van reden.');

      // Ligt er al een gedeponeerd stuk voor dit boekjaar, dan wordt dit een
      // vervangend stuk en is de reden verplicht.
      const { data: filed } = await orgQuery(ctx, 'annual_accounts', 'id, filing_date')
        .eq('fiscal_year_id', fiscalYearId).eq('status', 'filed').order('filing_date', { ascending: false });
      const supersedes = optId(input, 'supersedes_annual_account_id');
      const supersedeReason = optStr(input, 'supersede_reason', 500);
      if ((filed ?? []).length > 0 && (!supersedes || !supersedeReason)) {
        throw new ActionError(`Voor ${year.label} is al een jaarrekening gedeponeerd. Een nieuw stuk vervangt die deponering: geef "supersedes_annual_account_id" en "supersede_reason" mee.`);
      }
      if (supersedes) await row(ctx, 'annual_accounts', supersedes, 'id', 'Te vervangen jaarrekening');

      return {
        title: `Jaarrekening ${year.label} opmaken en de cijfers bevriezen`,
        sub: joinShort([
          `opgemaakt op ${dateNL(preparedOn)}`,
          `grondslag ${basis}`,
          `ondertekenaars: ${signatories.map((s) => `${s.name} (${s.role})`).join(', ')}`,
          override ? `handmatige klasse ${SIZE_CLASS_LABELS[override]}` : null,
          supersedes ? 'vervangt een eerder GEDEPONEERD stuk van hetzelfde boekjaar; die deponering blijft staan' : null,
          'ONOMKEERBAAR bevroren met een sha256-hash: het boekjaar heropenen of de resultaatbestemming terugdraaien kan pas na intrekking',
        ], 320),
        kind: 'money',
        payload: {
          fiscal_year_label: year.label,
          input: {
            fiscalYearId, preparedOn, accountingBasis: basis,
            signatories: signatories.map((s) => ({ name: s.name, role: s.role, shareholderId: s.shareholderId })),
            offBalanceCommitments: optStr(input, 'off_balance_commitments', 2000),
            policyChangeNote: optStr(input, 'policy_change_note', 2000),
            sizeClassOverride: override,
            sizeOverrideReason: overrideReason,
            note: optStr(input, 'note', 1000),
            allShareholdersAreDirectors: bool(input, 'all_shareholders_are_directors', false),
            supersedesAnnualAccountId: supersedes,
            supersedeReason,
          },
        },
      };
    },
  },

  {
    id: 'annual_accounts.sign',
    label: 'Handtekening of de reden van het ontbreken vastleggen',
    module: 'finance',
    kind: 'write',
    description:
      'Legt per bestuurder of commissaris vast dát hij heeft ondertekend, met de datum, óf waaróm zijn handtekening ontbreekt — die reden wordt in het gedrukte stuk afgedrukt (art. 2:210 lid 2 BW). ' +
      'Dit legt een rechtshandeling van een met naam genoemde persoon vast; doe het alleen als de gebruiker het uitdrukkelijk bevestigt. ' +
      'LET OP: is vastgelegd dat alle aandeelhouders tevens bestuurder zijn en zijn ook de overige voorwaarden van art. 2:210 lid 5 BW vervuld, dan geldt de laatste handtekening van rechtswege als VASTSTELLING én als KWIJTING — een later besluit maakt dat niet ongedaan. ' +
      'De handtekening-id\'s komen uit `annual_accounts.get`.',
    keywords: ['ondertekenen', 'handtekening', 'bestuurder', 'commissaris', 'ontbrekende handtekening', 'reden'],
    input: {
      signature_id: { type: 'string', description: 'Id van de ondertekenaar (uit annual_accounts.get, veld signatures[].id).' },
      signed: { type: 'boolean', description: 'true = getekend, false = niet getekend en de reden vastleggen.' },
      signed_on: { type: 'string', description: 'Datum van ondertekening JJJJ-MM-DD; verplicht bij signed=true.' },
      missing_reason: { type: 'string', description: 'Waarom ontbreekt de handtekening? Verplicht bij signed=false.' },
    },
    required: ['signature_id', 'signed'],
    async plan(ctx, input) {
      const signatureId = id(input, 'signature_id');
      const signature = await row<{ person_name: string; role: string; annual_account_id: string; signed: boolean }>(
        ctx, 'annual_account_signatures', signatureId, 'person_name, role, annual_account_id, signed', 'Ondertekenaar');
      const signed = bool(input, 'signed', true);
      const signedOn = optIsoDate(input, 'signed_on') ?? (signed ? ctx.today : null);
      const missingReason = optStr(input, 'missing_reason', 500);
      if (signed && !signedOn) throw new ActionError('Geef de datum van ondertekening mee.');
      if (!signed && !missingReason) throw new ActionError('Leg vast waaróm de handtekening ontbreekt; die reden wordt in het gedrukte stuk vermeld (art. 2:210 lid 2 BW).');

      const account = await row<{ fiscal_year_id: string; all_shareholders_are_directors: boolean; adoption_date: string | null; status: string }>(
        ctx, 'annual_accounts', signature.annual_account_id,
        'fiscal_year_id, all_shareholders_are_directors, adoption_date, status', 'Jaarrekening');
      const year = await fiscalYear(ctx, account.fiscal_year_id);
      const lid5Risk = account.all_shareholders_are_directors && !account.adoption_date && account.status !== 'reversed';

      return {
        title: signed
          ? `Handtekening vastleggen: ${signature.person_name} (${signature.role}) — jaarrekening ${year.label}`
          : `Reden van ontbrekende handtekening vastleggen: ${signature.person_name} (${signature.role})`,
        sub: joinShort([
          signed ? `ondertekend op ${dateNL(signedOn)}` : missingReason,
          !signed ? 'deze reden wordt letterlijk in het gedrukte stuk afgedrukt' : null,
          signed && lid5Risk
            ? 'LET OP: alle aandeelhouders zijn bestuurder — de laatste handtekening kan van rechtswege vaststelling ÉN kwijting betekenen (art. 2:210 lid 5 BW)'
            : null,
        ], 300),
        kind: 'money',
        payload: {
          signature_id: signatureId,
          person_name: signature.person_name,
          input: { signed, signedOn: signed ? signedOn : null, missingReason: signed ? null : missingReason },
        },
      };
    },
  },

  {
    id: 'annual_accounts.extend_term',
    label: 'Opmaaktermijn van de jaarrekening verlengen',
    module: 'finance',
    kind: 'write',
    description:
      'Legt de verlenging van de opmaaktermijn door de algemene vergadering vast: ten hoogste vijf maanden en alleen op grond van bijzondere omstandigheden (art. 2:210 lid 1 BW). Grond én besluitdatum zijn verplicht. ' +
      'De wettelijke termijn zelf blijft staan; de verlenging komt daar apart bij en schuift ook de tweemaandsgrens van art. 2:394 lid 2 BW op. Een besluit dat ná afloop van de wettelijke termijn is genomen, wordt geweigerd.',
    keywords: ['opmaaktermijn', 'verlengen', 'uitstel', 'vijf maanden', 'bijzondere omstandigheden', 'termijn'],
    input: {
      annual_account_id: { type: 'string' },
      months: { type: 'number', description: 'Aantal maanden, 1 tot en met 5.' },
      reason: { type: 'string', description: 'De bijzondere omstandigheden: waarom kon het bestuur niet op tijd opmaken?' },
      decided_on: { type: 'string', description: 'Datum van het besluit van de algemene vergadering, JJJJ-MM-DD.' },
    },
    required: ['annual_account_id', 'months', 'reason', 'decided_on'],
    async plan(ctx, input) {
      const annualAccountId = id(input, 'annual_account_id');
      const account = await annualAccount(ctx, annualAccountId);
      if (account.status !== 'prepared') {
        throw new ActionError(`De jaarrekening van ${account.fiscalYearLabel} is ${ANNUAL_STATUS_LABELS[account.status] ?? account.status}; verlengen kan alleen zolang zij alleen is opgemaakt.`);
      }
      const months = Math.trunc(num(input, 'months'));
      if (months < 1 || months > 5) throw new ActionError('De verlenging is ten hoogste vijf maanden (art. 2:210 lid 1 BW).');
      const reason = str(input, 'reason', 1000);
      const decidedOn = isoDate(input, 'decided_on');

      return {
        title: `Opmaaktermijn ${account.fiscalYearLabel} verlengen met ${months} maand${months === 1 ? '' : 'en'}`,
        sub: joinShort([
          `besluit van de algemene vergadering op ${dateNL(decidedOn)}`,
          `wettelijke termijn was ${dateNL(account.prepareDeadline)}`,
          reason,
          'verschuift een WETTELIJKE termijn en daarmee ook de tweemaandsgrens van art. 2:394 lid 2 BW',
        ], 260),
        kind: 'money',
        payload: {
          annual_account_id: annualAccountId,
          fiscal_year_label: account.fiscalYearLabel,
          input: { months, reason, decidedOn },
        },
      };
    },
  },

  {
    id: 'annual_accounts.adopt',
    label: 'Jaarrekening vaststellen',
    module: 'finance',
    kind: 'write',
    description:
      'Legt de vaststelling van de jaarrekening vast. Twee methodes: `ava` is een besluit van de algemene vergadering (art. 2:210 lid 3 BW) — dat strekt NIET tot kwijting, dat is een apart besluit dat je met `discharge_granted` vastlegt. ' +
      '`signature_210_5` is vaststelling door ondertekening: die kan alleen als alle aandeelhouders tevens bestuurder zijn, de overige vergadergerechtigden zijn geïnformeerd en hebben ingestemd (art. 2:238 lid 1 BW), de statuten het niet uitsluiten en ALLE ondertekenaars hebben getekend. Die route verleent AUTOMATISCH kwijting en dat kan niet ongedaan worden gemaakt — wijs de gebruiker daar uitdrukkelijk op. ' +
      'Ontbreekt een handtekening zonder opgaaf van reden, dan weigert dit; leg die reden eerst vast met `annual_accounts.sign`. Vaststellen start de achtdagentermijn voor deponeren (art. 2:394 lid 1 BW).',
    keywords: ['vaststellen', 'algemene vergadering', 'ava', 'kwijting', 'décharge', 'accountantsverklaring', 'jaarrekening'],
    input: {
      annual_account_id: { type: 'string' },
      adoption_date: { type: 'string', description: 'Datum van vaststelling JJJJ-MM-DD. Bij signature_210_5 moet dit de dag van de laatste handtekening zijn.' },
      method: { type: 'string', enum: [...ADOPTION_METHODS], description: 'ava = besluit van de algemene vergadering, signature_210_5 = door ondertekening.' },
      discharge_granted: { type: 'boolean', description: 'Bij ava: is er ook kwijting verleend? Bij signature_210_5 volgt de kwijting uit de wet.' },
      all_shareholders_are_directors: { type: 'boolean', description: 'Voorwaarde 1 van art. 2:210 lid 5 BW.' },
      other_meeting_rights_informed: { type: 'boolean', description: 'Voorwaarde 2: de overige vergadergerechtigden zijn geïnformeerd en hebben ingestemd (art. 2:238 lid 1 BW).' },
      articles_allow_210_5: { type: 'boolean', description: 'Voorwaarde 3: de statuten sluiten deze wijze van vaststellen niet uit.' },
      auditor_opinion_received: { type: 'boolean', description: 'Er is een accountantsverklaring ontvangen.' },
      auditor_name: { type: 'string' },
      auditor_missing_ground: { type: 'string', description: 'Op welke grond ontbreekt de accountantsverklaring?' },
    },
    required: ['annual_account_id', 'adoption_date', 'method'],
    async plan(ctx, input) {
      const annualAccountId = id(input, 'annual_account_id');
      const account = await annualAccount(ctx, annualAccountId);
      if (account.status === 'reversed') throw new ActionError('Deze jaarrekening is ingetrokken.');
      if (account.adoptionDate) throw new ActionError(`De jaarrekening van ${account.fiscalYearLabel} is al vastgesteld op ${dateNL(account.adoptionDate)}.`);
      if (account.snapshotStale) throw new ActionError('De bevroren cijfers wijken inmiddels af van de administratie. Trek het stuk in en maak het opnieuw op voordat je vaststelt.');

      const method = choice(input, 'method', ADOPTION_METHODS);
      const adoptionDate = isoDate(input, 'adoption_date');
      const unsigned = account.signatures.filter((s) => !s.signed);
      const unsignedWithoutReason = unsigned.filter((s) => !(s.missingReason ?? '').trim());
      if (unsignedWithoutReason.length > 0) {
        throw new ActionError(`Voor ${unsignedWithoutReason.map((s) => s.personName).join(', ')} ontbreekt de handtekening zonder opgaaf van reden (art. 2:210 lid 2 BW). Leg die reden eerst vast met \`annual_accounts.sign\`.`);
      }

      const allDirectors = bool(input, 'all_shareholders_are_directors', account.allShareholdersAreDirectors);
      const meetingRights = bool(input, 'other_meeting_rights_informed', account.otherMeetingRightsInformed);
      const articles = bool(input, 'articles_allow_210_5', account.articlesAllow2105);
      if (method === 'signature_210_5') {
        if (unsigned.length > 0) {
          throw new ActionError(`Bij vaststelling door ondertekening moeten álle bestuurders en commissarissen hebben getekend; een reden is niet genoeg. Nog niet getekend: ${unsigned.map((s) => s.personName).join(', ')}.`);
        }
        if (!allDirectors || !meetingRights || !articles) {
          throw new ActionError('Bevestig alle drie de voorwaarden van art. 2:210 lid 5 BW: alle aandeelhouders zijn bestuurder, de overige vergadergerechtigden zijn geïnformeerd en hebben ingestemd, en de statuten sluiten het niet uit.');
        }
      }

      const opinionReceived = typeof input.auditor_opinion_received === 'boolean'
        ? input.auditor_opinion_received as boolean : account.auditorOpinionReceived;
      const missingGround = optStr(input, 'auditor_missing_ground', 500) ?? account.auditorMissingGround;
      if (account.auditRequired && !opinionReceived && !missingGround) {
        throw new ActionError('Voor deze rechtspersoon is een accountantscontrole vereist. Geef aan dat de verklaring is ontvangen, of op welke grond zij ontbreekt.');
      }

      const discharge = method === 'signature_210_5' ? true : bool(input, 'discharge_granted', false);

      return {
        title: `Jaarrekening ${account.fiscalYearLabel} vaststellen op ${dateNL(adoptionDate)}`,
        sub: joinShort([
          ADOPTION_METHOD_LABELS[method],
          method === 'signature_210_5'
            ? 'deze route verleent VAN RECHTSWEGE kwijting aan bestuurders en commissarissen; dat is niet terug te draaien'
            : (discharge ? 'mét kwijting voor het gevoerde beleid' : 'zonder kwijting'),
          'ONOMKEERBAAR besluit: start de achtdagentermijn voor deponeren (art. 2:394 lid 1 BW)',
        ], 300),
        kind: 'money',
        payload: {
          annual_account_id: annualAccountId,
          fiscal_year_label: account.fiscalYearLabel,
          input: {
            adoptionDate, method,
            dischargeGranted: discharge,
            allShareholdersAreDirectors: allDirectors,
            otherMeetingRightsInformed: meetingRights,
            articlesAllow2105: articles,
            auditorOpinionReceived: opinionReceived,
            auditorName: optStr(input, 'auditor_name', 200) ?? account.auditorName,
            auditorMissingGround: missingGround,
          },
        },
      };
    },
  },

  {
    id: 'annual_accounts.file',
    label: 'Deponering bij het handelsregister vastleggen',
    module: 'finance',
    kind: 'write',
    description:
      'Legt vast DÁT en WANNÉÉR de jaarrekening bij het handelsregister is gedeponeerd (art. 2:394 BW), met de referentie van het register. ResoFly deponeert NIET zelf: micro, kleine en middelgrote rechtspersonen deponeren digitaal in SBR/XBRL en dat bestand levert ResoFly niet — de gegenereerde PDF is geen deponeerbestand. ' +
      'Is de jaarrekening nog niet vastgesteld, dan kan zij alleen als onvastgesteld stuk worden gedeponeerd (art. 2:394 lid 2 BW); zet dan `unadopted` aan. Dat is een begin, geen einde: de vaststelling moet alsnog komen en daarna moet het vastgestelde stuk binnen acht dagen opnieuw worden gedeponeerd. ' +
      'Ontbreekt een handtekening zonder opgaaf van reden, dan weigert dit.',
    keywords: ['deponeren', 'handelsregister', 'kvk', 'openbaar maken', 'publicatie', 'onvastgesteld', 'sbr', 'xbrl'],
    input: {
      annual_account_id: { type: 'string' },
      filing_date: { type: 'string', description: 'Datum van deponering JJJJ-MM-DD.' },
      filing_reference: { type: 'string', description: 'Bevestigingsnummer of kenmerk van het register.' },
      unadopted: { type: 'boolean', description: 'Gedeponeerd terwijl de jaarrekening nog niet is vastgesteld (art. 2:394 lid 2 BW).' },
      auditor_opinion_received: { type: 'boolean' },
      auditor_name: { type: 'string' },
      auditor_missing_ground: { type: 'string' },
      note: { type: 'string' },
    },
    required: ['annual_account_id', 'filing_date'],
    async plan(ctx, input) {
      const annualAccountId = id(input, 'annual_account_id');
      const account = await annualAccount(ctx, annualAccountId);
      if (account.status === 'reversed') throw new ActionError('Deze jaarrekening is ingetrokken; er valt niets te deponeren.');
      if (account.snapshotStale) throw new ActionError('De bevroren cijfers wijken inmiddels af van de administratie. Los dat eerst op voordat je een deponering vastlegt.');

      const filingDate = isoDate(input, 'filing_date');
      const missingWithoutReason = account.signatures.filter((s) => !s.signed && !(s.missingReason ?? '').trim());
      if (missingWithoutReason.length > 0) {
        throw new ActionError(`Voor ${missingWithoutReason.map((s) => s.personName).join(', ')} ontbreekt de handtekening zonder opgaaf van reden (art. 2:210 lid 2 BW). Leg die reden vast voordat het stuk openbaar wordt gemaakt.`);
      }
      const unadopted = bool(input, 'unadopted', account.adoptionDate === null);
      if (account.adoptionDate === null && !unadopted) {
        throw new ActionError('Deze jaarrekening is nog niet vastgesteld. Stel haar eerst vast, of leg de deponering vast als onvastgesteld stuk (art. 2:394 lid 2 BW) door "unadopted" aan te zetten.');
      }

      const opinionReceived = typeof input.auditor_opinion_received === 'boolean'
        ? input.auditor_opinion_received as boolean : account.auditorOpinionReceived;
      const missingGround = optStr(input, 'auditor_missing_ground', 500) ?? account.auditorMissingGround;
      if (unadopted && account.auditRequired && !opinionReceived && !missingGround) {
        throw new ActionError('Voor deze rechtspersoon is een accountantscontrole vereist. Geef aan dat de verklaring is ontvangen, of op welke grond zij ontbreekt.');
      }

      return {
        title: `Deponering jaarrekening ${account.fiscalYearLabel} vastleggen: ${dateNL(filingDate)}`,
        sub: joinShort([
          unadopted ? 'ONVASTGESTELD gedeponeerd (art. 2:394 lid 2 BW) — na vaststelling moet het stuk binnen acht dagen opnieuw' : `vastgesteld op ${dateNL(account.adoptionDate)}`,
          optStr(input, 'filing_reference', 200),
          'ONOMKEERBAAR: registreert een externe wettelijke handeling; een gedeponeerd stuk kan daarna niet meer worden ingetrokken, alleen vervangen door een opvolgend stuk',
        ], 320),
        kind: 'money',
        payload: {
          annual_account_id: annualAccountId,
          fiscal_year_label: account.fiscalYearLabel,
          input: {
            filingDate,
            filingReference: optStr(input, 'filing_reference', 200),
            unadopted,
            note: optStr(input, 'note', 1000),
            auditorOpinionReceived: opinionReceived,
            auditorName: optStr(input, 'auditor_name', 200) ?? account.auditorName,
            auditorMissingGround: missingGround,
          },
        },
      };
    },
  },

  {
    id: 'annual_accounts.reverse',
    label: 'Jaarrekening intrekken',
    module: 'finance',
    kind: 'write',
    description:
      'Trekt een opgemaakte of vastgestelde jaarrekening in, met opgaaf van reden. Het bevroren stuk wordt ongeldig maar blijft als spoor staan en blokkeert daarna niets meer; pas ná het intrekken kan het boekjaar worden heropend en de resultaatbestemming worden teruggedraaid. ' +
      'Alleen een eigenaar of beheerder kan dit. Een GEDEPONEERD stuk kan niet worden ingetrokken — dat is een feit (art. 2:394 BW) en wordt hersteld met een opvolgend stuk via `annual_accounts.prepare`.',
    keywords: ['jaarrekening intrekken', 'ongeldig maken', 'opnieuw opmaken', 'terugdraaien', 'reversed'],
    input: {
      annual_account_id: { type: 'string' },
      reason: { type: 'string', description: 'Reden van intrekking.' },
    },
    required: ['annual_account_id', 'reason'],
    async plan(ctx, input) {
      const annualAccountId = id(input, 'annual_account_id');
      const account = await annualAccount(ctx, annualAccountId);
      if (account.status === 'reversed') throw new ActionError('Deze jaarrekening is al ingetrokken.');
      if (account.status === 'filed') {
        throw new ActionError('Een gedeponeerd stuk kan niet worden ingetrokken (art. 2:394 BW). Herstel de fout met een opvolgende jaarrekening die deze vervangt.');
      }
      const reason = str(input, 'reason', 1000);

      return {
        title: `Jaarrekening ${account.fiscalYearLabel} intrekken`,
        sub: joinShort([
          `het stuk staat nu op "${ANNUAL_STATUS_LABELS[account.status] ?? account.status}"`,
          reason,
          'maakt de bevroren cijfers ongeldig; pas daarna kan het boekjaar worden heropend en de resultaatbestemming worden teruggedraaid',
        ], 250),
        kind: 'money',
        payload: { annual_account_id: annualAccountId, fiscal_year_label: account.fiscalYearLabel, reason },
      };
    },
  },

  {
    id: 'annual_accounts.render_pdf',
    label: 'Jaarrekening-PDF vastleggen en archiveren',
    module: 'finance',
    kind: 'write',
    description:
      'Laat de server de definitieve jaarrekening-PDF genereren uit de bevroren cijfers en archiveert haar met een sha256 in private opslag, als bijlage bij het stuk. Daardoor is het exemplaar dat de algemene vergadering vaststelde jaren later nog letterlijk terug te halen in plaats van opnieuw opgebouwd. ' +
      'Er wordt niets gemaild of gedeponeerd; dit legt alleen het archiefexemplaar vast.',
    keywords: ['jaarrekening pdf', 'archiveren', 'vastleggen', 'sha256', 'exemplaar', 'bijlage'],
    input: {
      annual_account_id: { type: 'string' },
    },
    required: ['annual_account_id'],
    async plan(ctx, input) {
      const annualAccountId = id(input, 'annual_account_id');
      const account = await annualAccount(ctx, annualAccountId);
      return {
        title: `Jaarrekening-PDF ${account.fiscalYearLabel} vastleggen en archiveren`,
        sub: joinShort([
          `stand: ${ANNUAL_STATUS_LABELS[account.status] ?? account.status}`,
          `hash van de bevroren cijfers ${account.snapshotHash.slice(0, 16)}…`,
          account.snapshotStale ? 'LET OP: de bevroren cijfers wijken af van de administratie' : null,
          'slaat een onveranderlijk exemplaar op als bijlage in private opslag',
        ], 220),
        kind: 'work',
        payload: { annual_account_id: annualAccountId, fiscal_year_label: account.fiscalYearLabel },
      };
    },
  },

  {
    id: 'annual_accounts.render_publication',
    label: 'Publicatiestuk vastleggen en archiveren',
    module: 'finance',
    kind: 'write',
    description:
      'Laat de server het publicatiestuk genereren — de beperktere set die per grootteklasse openbaar wordt gemaakt — en archiveert het met een sha256 als bijlage. ' +
      'Dit is een werk- en archiefstuk: deponeren zelf gaat in SBR/XBRL en dat bestand levert ResoFly niet.',
    keywords: ['publicatiestuk', 'openbaar', 'deponeren', 'archiveren', 'beperkte set', 'grootteklasse'],
    input: {
      annual_account_id: { type: 'string' },
    },
    required: ['annual_account_id'],
    async plan(ctx, input) {
      const annualAccountId = id(input, 'annual_account_id');
      const account = await annualAccount(ctx, annualAccountId);
      return {
        title: `Publicatiestuk ${account.fiscalYearLabel} vastleggen en archiveren`,
        sub: joinShort([
          `openbaar te maken set voor klasse ${SIZE_CLASS_LABELS[account.effectiveSizeClass] ?? account.effectiveSizeClass}`,
          account.snapshotStale ? 'LET OP: de bevroren cijfers wijken af van de administratie' : null,
          'werk- en archiefstuk; het deponeerbestand in SBR/XBRL levert ResoFly niet',
        ], 220),
        kind: 'work',
        payload: { annual_account_id: annualAccountId, fiscal_year_label: account.fiscalYearLabel },
      };
    },
  },
];
