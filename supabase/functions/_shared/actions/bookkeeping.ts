import {
  ActionError, bool, choice, euroCents, id, ids, isoDate, joinShort, num, optChoice, optId,
  optIsoDate, optNum, optStr, orgQuery, row, str,
  type ActionCtx, type ActionDef,
} from './types.ts';

/**
 * Handelingen rond de ADMINISTRATIE: het rekeningschema, het journaal, de inkoop,
 * de bank, de omzetbelasting, de boekjaren en de vaste activa.
 *
 * Wat hier staat is bewust het zware werk van het boekhoudscherm. Lezen kon al
 * (`list_ledger_accounts`, `list_journal_entries`, `list_bank_transactions`,
 * `list_vat_returns`, `list_fiscal_years`) en de overzichten balans/W&V/proefbalans/
 * grootboekkaart/openstaande posten zitten in `insight.ts`; schrijven kon nog niets.
 *
 * BOEKEN IS ONOMKEERBAAR. Een geboekt boekstuk verdwijnt niet meer — corrigeren gaat
 * alleen met een tegenboeking, en een afgesloten btw-periode of boekjaar vergrendelt
 * de datums die eronder vallen. Daarom zegt elke `sub` letterlijk wát er vastgelegd
 * wordt en wat er daarna níét meer kan: dat is de enige informatie die de gebruiker
 * heeft op het moment dat hij op Uitvoeren drukt.
 */

const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;
type AccountType = typeof ACCOUNT_TYPES[number];

/**
 * Welke rubriek bij welk soort rekening hoort. Spiegelt `REPORT_GROUPS_BY_TYPE` in
 * `src/types.ts` — de databasecheck laat élke rubriek toe, dus zonder deze tabel zou
 * een kostenrekening onder "Voorraden" kunnen belanden zonder dat iets protesteert.
 */
const REPORT_GROUPS_BY_TYPE: Record<AccountType, string[]> = {
  asset: ['immateriele_vaste_activa', 'materiele_vaste_activa', 'financiele_vaste_activa', 'voorraden', 'vorderingen', 'effecten', 'liquide_middelen'],
  liability: ['voorzieningen', 'langlopende_schulden', 'kortlopende_schulden'],
  equity: ['eigen_vermogen'],
  revenue: ['netto_omzet', 'overige_bedrijfsopbrengsten', 'financiele_baten', 'resultaat_deelnemingen'],
  expense: ['inkoopwaarde', 'personeelskosten', 'afschrijvingen', 'overige_bedrijfskosten', 'financiele_lasten', 'belastingen', 'resultaat_deelnemingen'],
};

/**
 * Boekstukken die je niet los tegenboekt: die horen bij een administratieve
 * handeling die zijn eigen terugweg heeft (boekjaar heropenen, bestemming
 * terugdraaien). Los tegenboeken laat het boekjaar in een toestand achter waar
 * geen van beide knoppen nog uit komt; de database weigert het ook.
 */
const SYSTEM_ENTRY_SOURCES = ['year_close', 'result_appropriation', 'corporate_tax', 'dga_interest', 'dividend', 'vat_return'];

/**
 * Uitgegeven stukken en betalingen hebben ook hun eigen terugweg, en de
 * database weigert los tegenboeken (20261105233000). Een tegengeboekte
 * verkoopfactuur bleef "verzonden" met de boeking eraan: crediteren,
 * herinneren en de betaallink weigerden daarna, terwijl de btw verschuldigd
 * bleef. Hier dezelfde regel, met een zin die het model kan doorgeven.
 */
const OWN_WAY_BACK: Record<string, string> = {
  sales_invoice: 'Een verkoopfactuur corrigeer je met "Crediteren" bij de factuur (creditnota); dat boekt omzet en btw netjes terug.',
  credit_note: 'Een creditnota is uitgegeven; maak zo nodig een nieuwe factuur.',
  payment: 'Een bankbetaling draai je terug met "Boeking ongedaan maken" bij de transactie; een Mollie-betaling met een terugbetaling.',
};

const SUPPLIER_STATUS = ['active', 'inactive'] as const;
const PERIOD_TYPES = ['month', 'quarter'] as const;

// ── Kleine hulpjes ──────────────────────────────────────────────────────────

interface AccountRow { id: string; code: string; name: string; type: AccountType; subtype: string | null; is_system: boolean; is_active: boolean }
interface VatCodeRow { id: string; code: string; label: string; rate: number; is_active: boolean }

/** Roept een boekhoud-RPC aan. De service-role slaat RLS over, dus het organisatie-id
 *  uit de geverifieerde sessie is hier de enige grens. */
async function rpc<T>(ctx: ActionCtx, fn: string, params: Record<string, unknown>, label: string): Promise<T> {
  // De organisatie ACHTERAAN, zodat niets in `params` hem kan overschrijven.
  // Stond hij vooraan, dan won een `p_organization_id` in params: nu geeft geen
  // enkele aanroep die mee, maar de tenancy-test ziet een spread niet.
  const { data, error } = await ctx.db.rpc(fn, { ...params, p_organization_id: ctx.organizationId });
  if (error) throw new ActionError(`${label} mislukt: ${error.message}`);
  return data as T;
}

/** Bedrag in euro's uit de invoer naar hele centen. */
function cents(input: Record<string, unknown>, key: string): number {
  return Math.round(num(input, key) * 100);
}
function optCents(input: Record<string, unknown>, key: string): number | null {
  const value = optNum(input, key);
  return value === null ? null : Math.round(value * 100);
}

const accountLabel = (a: { code: string; name: string }) => `${a.code} · ${a.name}`;

/**
 * Handelingen die de schermen achter "owner/admin" zetten, horen hier dezelfde grens
 * te hebben. De uitvoerder in de browser weet de rol niet; de sessie hier wel.
 */
function requireAdmin(ctx: ActionCtx, what: string): void {
  if (!['owner', 'admin'].includes(ctx.role)) {
    throw new ActionError(`${what} kan alleen een eigenaar of beheerder.`);
  }
}

async function loadAccount(ctx: ActionCtx, accountId: string, label = 'Grootboekrekening'): Promise<AccountRow> {
  return await row<AccountRow>(ctx, 'ledger_accounts', accountId, 'id, code, name, type, subtype, is_system, is_active', label);
}

/** Zoekt een grootboekrekening op code — zoals de schermen hun standaardrekeningen kiezen. */
async function accountByCode(ctx: ActionCtx, code: string): Promise<AccountRow | null> {
  const { data } = await orgQuery(ctx, 'ledger_accounts', 'id, code, name, type, subtype, is_system, is_active').eq('code', code).maybeSingle();
  return (data ?? null) as AccountRow | null;
}

async function loadVatCode(ctx: ActionCtx, code: string): Promise<VatCodeRow> {
  const { data, error } = await orgQuery(ctx, 'vat_codes', 'id, code, label, rate, is_active').eq('code', code).maybeSingle();
  if (error) throw new ActionError(`Btw-code ophalen mislukt: ${error.message}`);
  if (!data) throw new ActionError(`Btw-code "${code}" bestaat niet. Bekijk de codes met \`vat_code.list\`.`);
  return data as VatCodeRow;
}

/** Grenzen van een aangifteperiode, zoals het scherm Omzetbelasting ze berekent. */
function periodBounds(periodType: 'month' | 'quarter', year: number, index: number): { from: string; to: string; label: string } {
  const p2 = (n: number) => String(n).padStart(2, '0');
  const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const months = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
  if (periodType === 'month') {
    if (index < 1 || index > 12) throw new ActionError('"period_index" is bij een maandaangifte 1 t/m 12.');
    return { from: `${year}-${p2(index)}-01`, to: `${year}-${p2(index)}-${p2(lastDay(year, index))}`, label: `${months[index - 1]} ${year}` };
  }
  if (index < 1 || index > 4) throw new ActionError('"period_index" is bij een kwartaalaangifte 1 t/m 4.');
  const startMonth = (index - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  return { from: `${year}-${p2(startMonth)}-01`, to: `${year}-${p2(endMonth)}-${p2(lastDay(year, endMonth))}`, label: `Q${index} ${year}` };
}

/** Jaar uit de invoer, met vandaag als terugval. */
function yearOf(ctx: ActionCtx, input: Record<string, unknown>, key = 'year'): number {
  const value = optNum(input, key) ?? Number(ctx.today.slice(0, 4));
  if (!Number.isInteger(value) || value < 2000 || value > 2100) throw new ActionError('"year" moet een jaartal zijn, bijvoorbeeld 2026.');
  return value;
}

/** Eén regel van een memoriaal- of beginbalansboeking, zoals het model hem aanlevert. */
interface RawLine { account_id?: unknown; description?: unknown; debit_eur?: unknown; credit_eur?: unknown; vat_code?: unknown; client_id?: unknown; supplier_id?: unknown; project_id?: unknown }

function rawLines(input: Record<string, unknown>, key = 'lines'): RawLine[] {
  const list = Array.isArray(input[key]) ? input[key] as RawLine[] : [];
  if (list.length === 0) throw new ActionError(`"${key}" heeft minstens één boekingsregel nodig.`);
  return list.slice(0, 100);
}

const lineCents = (line: RawLine, key: 'debit_eur' | 'credit_eur'): number => {
  const raw = line[key];
  if (raw === undefined || raw === null || raw === '') return 0;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new ActionError(`"${key}" moet een bedrag in euro's zijn.`);
  if (value < 0) throw new ActionError(`"${key}" mag niet negatief zijn — zet het bedrag aan de andere kant.`);
  return Math.round(value * 100);
};

// ── Vooruitbetaalde kosten: dezelfde rekenregels als de database ────────────
// (prepaid_build_schedule, 20261111220000) en als src/lib/prepaid.ts, zodat de
// kaart zegt wat er straks geboekt wordt.

const PREPAID_HOW = ['book', 'expense', 'existing'] as const;
/** Subsoorten die nooit "Vooruitbetaalde kosten" zijn; de database weigert ze ook. */
const NOT_PREPAID = ['bank', 'accounts_receivable', 'vat_input', 'psp_clearing', 'fixed_asset', 'accumulated_depreciation', 'accumulated_amortization', 'intangible_asset'];
const VAT_SUBTYPES = ['vat_input', 'vat_output', 'vat_reverse', 'vat_payable'];
const MONTH_NAMES = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

/** De laatste dag van de maand, `offset` maanden na de maand van `iso`. */
function prepaidMonthEnd(iso: string, offset = 0): string {
  const [y, m] = iso.split('-').map(Number);
  const index = (m - 1) + offset;
  const year = y + Math.floor(index / 12);
  const month = ((index % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

const prepaidMonthLabel = (iso: string) => `${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

/** Het schema: per maand een termijn op de laatste dag, het restant met een cent per termijn in de eerste maanden. */
function prepaidTerms(amountCents: number, months: number, startDate: string): Array<{ date: string; cents: number }> {
  const monthly = Math.floor(amountCents / months);
  const remainder = amountCents - monthly * months;
  const terms: Array<{ date: string; cents: number }> = [];
  for (let i = 1; i <= months; i += 1) {
    const cents = monthly + (i <= remainder ? 1 : 0);
    if (cents > 0) terms.push({ date: prepaidMonthEnd(startDate, i - 1), cents });
  }
  return terms;
}

/** "€ 27,78 per maand (28×) en € 27,77 (8×)" */
function prepaidPerMonth(terms: Array<{ cents: number }>): string {
  const groups: Array<{ cents: number; count: number }> = [];
  for (const t of terms) {
    const last = groups[groups.length - 1];
    if (last && last.cents === t.cents) last.count += 1; else groups.push({ cents: t.cents, count: 1 });
  }
  if (groups.length === 0) return '';
  if (groups.length === 1) return `${euroCents(groups[0].cents)} per maand`;
  return `${euroCents(groups[0].cents)} per maand (${groups[0].count}×) en ${groups.slice(1).map((g) => `${euroCents(g.cents)} (${g.count}×)`).join(' en ')}`;
}

interface PrepaidRow {
  id: string; description: string; amount_cents: number; months: number; start_date: string; payment_date: string;
  start_mode: string; start_journal_entry_id: string | null; status: string; prepaid_account_id: string; expense_account_id: string;
}

const prepaidOnBalance = (p: Pick<PrepaidRow, 'start_mode' | 'start_journal_entry_id'>) => p.start_mode === 'existing' || p.start_journal_entry_id != null;

/**
 * Alle rijen van een vraag, in pagina's van duizend. De API geeft er per keer
 * hooguit duizend (max_rows); dertig posten van 36 maanden zijn er al meer, en
 * dan noemde de kaart te weinig termijnen. `make` maakt elke keer een nieuwe,
 * geordende vraag (zelfde patroon als fetchAll in reportRecords.ts).
 */
// deno-lint-ignore no-explicit-any
async function allRows<T>(make: () => any, label: string, cap = 50_000): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; offset < cap; offset += 1000) {
    const { data, error } = await make().range(offset, offset + 999);
    if (error) throw new ActionError(`${label} ophalen mislukt: ${error.message}`);
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

export const BOOKKEEPING_ACTIONS: ActionDef[] = [
  // ── Rekeningschema en btw-codes ───────────────────────────────────────────
  {
    id: 'ledger.sync_chart',
    label: 'Rekeningschema en btw-codes aanmaken of bijwerken',
    module: 'finance',
    kind: 'write',
    description:
      'Zet het standaard Nederlandse rekeningschema en de btw-codes klaar voor deze organisatie, of loopt ze opnieuw langs zodat rekeningen die bij de huidige rechtsvorm horen (aandelenkapitaal, reserves, vennootschapsbelasting) alsnog worden toegevoegd. ' +
      'Bestaande rekeningen blijven onaangeroerd — er wordt alleen toegevoegd wat ontbreekt. Gebruik dit als een organisatie nog niets in het grootboek heeft, of nadat de rechtsvorm is gewijzigd.',
    keywords: ['rekeningschema', 'grootboek inrichten', 'btw-codes', 'setup', 'standaardschema', 'rechtsvorm', 'schema bijwerken'],
    input: {},
    async plan(ctx) {
      const { count } = await ctx.db.from('ledger_accounts')
        .select('id', { count: 'exact', head: true }).eq('organization_id', ctx.organizationId);
      const existing = Number(count ?? 0);
      return {
        title: existing === 0 ? 'Rekeningschema en btw-codes aanmaken' : 'Rekeningschema bijwerken',
        sub: existing === 0
          ? 'de boekhouding is nog niet ingericht — hierna staan het standaardschema en de btw-codes klaar'
          : `${existing} rekeningen aanwezig · alleen ontbrekende rekeningen worden toegevoegd, bestaande blijven staan`,
        kind: 'work',
        payload: { existing },
      };
    },
  },

  {
    id: 'vat_code.list',
    label: 'Btw-codes bekijken',
    module: 'finance',
    kind: 'read',
    description:
      'Geeft de btw-codes van de organisatie: code, omschrijving, tarief, soort en de aangifterubrieken (omzet- en btw-rubriek) waar ze in tellen. ' +
      'Gebruik dit om de juiste code te kiezen vóór een memoriaalboeking, een inkoopfactuurregel of een bankregel — de code is de exacte tekst, niet het label.',
    keywords: ['btw', 'btw-code', 'tarief', 'hoog', 'laag', 'verlegd', 'rubriek', 'omzetbelasting', 'kor'],
    input: { include_inactive: { type: 'boolean', description: 'Ook uitgeschakelde codes meesturen.' } },
    async read(ctx, input) {
      let query = orgQuery(ctx, 'vat_codes', 'id, code, label, rate, kind, sales_box, vat_box, is_system, is_active')
        .order('code', { ascending: true }).limit(200);
      if (!bool(input, 'include_inactive', false)) query = query.eq('is_active', true);
      const { data, error } = await query;
      if (error) throw new ActionError(`Btw-codes ophalen mislukt: ${error.message}`);
      return { vat_codes: data ?? [] };
    },
  },

  {
    id: 'ledger_account.create',
    label: 'Grootboekrekening aanmaken',
    module: 'finance',
    kind: 'write',
    description:
      'Maakt een eigen grootboekrekening aan met code, naam, soort en rubriek. Het soort bepaalt of hij op de balans of in de winst- en verliesrekening valt; de rubriek bepaalt waar hij daarbinnen wordt opgeteld (Titel 9 Boek 2 BW). ' +
      'Bekijk het bestaande schema eerst met `list_ledger_accounts` — codes zijn uniek en een dubbele of net-naast-de-standaard-gekozen code maakt de overzichten rommelig.',
    keywords: ['grootboekrekening', 'rekening aanmaken', 'kostenrekening', 'rekeningschema', 'code', 'rubriek'],
    input: {
      code: { type: 'string', description: 'Rekeningnummer, bijvoorbeeld 4600 of 8040.' },
      name: { type: 'string', description: 'Naam van de rekening.' },
      type: { type: 'string', enum: [...ACCOUNT_TYPES], description: 'asset = bezittingen, liability = schulden, equity = eigen vermogen, revenue = opbrengsten, expense = kosten.' },
      report_group: { type: 'string', description: 'Rubriek in balans/W&V. Moet bij het soort passen; laat leeg om hem later in te delen.' },
      default_vat_code: { type: 'string', description: 'Btw-code die standaard wordt voorgesteld (uit vat_code.list).' },
      is_restricted_reserve: { type: 'boolean', description: 'Alleen bij eigen vermogen: wettelijke of statutaire reserve, telt niet mee als vrij uitkeerbaar bij een dividendbesluit.' },
      is_active: { type: 'boolean', description: 'Standaard aan; uit betekent dat hij niet in de keuzelijsten verschijnt.' },
    },
    required: ['code', 'name', 'type'],
    async plan(ctx, input) {
      const code = str(input, 'code', 20);
      const name = str(input, 'name', 200);
      const type = choice(input, 'type', ACCOUNT_TYPES);
      const existing = await accountByCode(ctx, code);
      if (existing) throw new ActionError(`Er bestaat al een rekening met code ${code} (${existing.name}).`);

      const group = optStr(input, 'report_group', 60);
      if (group && !REPORT_GROUPS_BY_TYPE[type].includes(group)) {
        throw new ActionError(`De rubriek "${group}" hoort niet bij het soort ${type}. Kies uit: ${REPORT_GROUPS_BY_TYPE[type].join(', ')}.`);
      }
      const vatCode = optStr(input, 'default_vat_code', 40);
      if (vatCode) await loadVatCode(ctx, vatCode);

      const restricted = type === 'equity' && bool(input, 'is_restricted_reserve', false);
      const active = bool(input, 'is_active', true);
      return {
        title: `Grootboekrekening aanmaken: ${code} · ${name}`,
        sub: joinShort([type, group ?? 'nog niet ingedeeld', vatCode ? `standaard btw ${vatCode}` : null, restricted ? 'niet-uitkeerbare reserve' : null, active ? null : 'inactief']),
        kind: 'work',
        payload: {
          code, name, type, report_group: group, default_vat_code: vatCode,
          is_restricted_reserve: restricted, is_active: active,
        },
      };
    },
  },

  {
    id: 'ledger_account.update',
    label: 'Grootboekrekening bewerken of uitzetten',
    module: 'finance',
    kind: 'write',
    description:
      'Past naam, soort, rubriek, standaard-btw, het vinkje "wettelijke/statutaire reserve" of de actief-status van een bestaande rekening aan. ' +
      'Bij een SYSTEEMREKENING liggen code, soort en actief-status vast (de automatische boekingen zoeken die op code op) — daar mogen alleen naam, rubriek en standaard-btw wijzigen. ' +
      'LET OP: een rubriekwijziging werkt terug — balans en W&V groeperen op de rubriek zoals die nú is, óók in de vergelijkende cijfers van eerdere perioden. ' +
      'Zoek de rekening eerst met `list_ledger_accounts` en geef alleen wat verandert.',
    keywords: ['rekening bewerken', 'rekening hernoemen', 'rubriek wijzigen', 'rekening uitzetten', 'inactief', 'grootboek'],
    input: {
      account_id: { type: 'string', description: 'Id van de grootboekrekening (uit list_ledger_accounts).' },
      code: { type: 'string', description: 'Nieuwe code. Niet toegestaan bij een systeemrekening.' },
      name: { type: 'string' },
      type: { type: 'string', enum: [...ACCOUNT_TYPES], description: 'Niet toegestaan bij een systeemrekening.' },
      report_group: { type: 'string', description: 'Rubriek in balans/W&V; moet bij het soort passen.' },
      default_vat_code: { type: 'string' },
      is_restricted_reserve: { type: 'boolean', description: 'Alleen bij eigen vermogen.' },
      is_active: { type: 'boolean', description: 'Niet toegestaan bij een systeemrekening.' },
    },
    required: ['account_id'],
    async plan(ctx, input) {
      const accountId = id(input, 'account_id');
      const account = await loadAccount(ctx, accountId);
      const patch: Record<string, unknown> = {};
      const notes: string[] = [];

      const code = optStr(input, 'code', 20);
      const type = optChoice(input, 'type', ACCOUNT_TYPES);
      const active = typeof input.is_active === 'boolean' ? input.is_active as boolean : null;
      if (account.is_system && (code || type || active !== null)) {
        throw new ActionError(`${accountLabel(account)} is een systeemrekening: code, soort en actief-status liggen vast. Naam, rubriek en standaard-btw kun je wel aanpassen.`);
      }
      if (code && code !== account.code) {
        const clash = await accountByCode(ctx, code);
        if (clash) throw new ActionError(`Er bestaat al een rekening met code ${code} (${clash.name}).`);
        patch.code = code;
      }
      const name = optStr(input, 'name', 200);
      if (name) patch.name = name;
      const nextType = type ?? account.type;
      if (type) patch.type = type;

      if (input.report_group !== undefined) {
        const group = optStr(input, 'report_group', 60);
        if (group && !REPORT_GROUPS_BY_TYPE[nextType].includes(group)) {
          throw new ActionError(`De rubriek "${group}" hoort niet bij het soort ${nextType}. Kies uit: ${REPORT_GROUPS_BY_TYPE[nextType].join(', ')}.`);
        }
        patch.report_group = group;
        notes.push('rubriek werkt terug op eerdere perioden');
      }
      if (input.default_vat_code !== undefined) {
        const vatCode = optStr(input, 'default_vat_code', 40);
        if (vatCode) await loadVatCode(ctx, vatCode);
        patch.default_vat_code = vatCode;
      }
      if (typeof input.is_restricted_reserve === 'boolean') {
        if (nextType !== 'equity') throw new ActionError('Het vinkje "wettelijke/statutaire reserve" hoort alleen bij een eigen-vermogensrekening.');
        patch.is_restricted_reserve = input.is_restricted_reserve;
        notes.push(input.is_restricted_reserve ? 'telt niet meer mee als vrij uitkeerbaar' : 'telt weer mee als vrij uitkeerbaar');
      }
      if (active !== null) {
        patch.is_active = active;
        notes.push(active ? 'weer zichtbaar in de keuzelijsten' : 'verdwijnt uit de keuzelijsten bij het boeken');
      }
      if (Object.keys(patch).length === 0) throw new ActionError('Geef minstens één veld dat moet veranderen.');

      return {
        title: `Grootboekrekening bijwerken: ${accountLabel(account)}`,
        sub: joinShort([...Object.keys(patch), ...notes], 120),
        kind: 'work',
        payload: { account_id: accountId, label: accountLabel(account), patch },
      };
    },
  },

  // ── Journaal ──────────────────────────────────────────────────────────────
  {
    id: 'journal.post_manual',
    label: 'Memoriaalboeking boeken',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Boekt een vrije journaalpost (memoriaal) met een datum, een omschrijving en minstens twee regels. Debet en credit moeten exact gelijk zijn. ' +
      'Gebruik dit voor correcties, privé-opnames en herrubriceringen die geen factuur of bankregel zijn. ' +
      'Een btw-code op een omzet- of kostenregel zorgt dat de aangifte de grondslag in de juiste rubriek telt; de btw zelf boek je zelf op 1500/1510. ' +
      'Bij een debiteuren- of crediteurenregel hoort een klant respectievelijk leverancier, zodat de correctie in de openstaande posten per partij meetelt. ' +
      'DIT SCHRIJFT DIRECT IN HET GROOTBOEK: het boekstuk is daarna niet meer te wijzigen of te verwijderen — corrigeren kan alleen met een tegenboeking. In een afgesloten periode boeken lukt niet.',
    keywords: ['memoriaal', 'memoriaalboeking', 'journaalpost', 'boeken', 'correctie', 'debet', 'credit', 'handmatige boeking', 'privé-opname'],
    input: {
      date: { type: 'string', description: 'Boekdatum JJJJ-MM-DD. Moet in een open periode vallen.' },
      description: { type: 'string', description: 'Wat de boeking is, bijvoorbeeld "Correctie telefoonkosten Q1".' },
      lines: {
        type: 'array',
        description: 'Minstens twee regels; het totaal debet moet gelijk zijn aan het totaal credit.',
        items: {
          type: 'object',
          properties: {
            account_id: { type: 'string', description: 'Id van de grootboekrekening (uit list_ledger_accounts).' },
            description: { type: 'string', description: 'Toelichting op deze regel (optioneel).' },
            debit_eur: { type: 'number', description: 'Bedrag debet in euro. Laat leeg als deze regel credit is.' },
            credit_eur: { type: 'number', description: 'Bedrag credit in euro. Laat leeg als deze regel debet is.' },
            vat_code: { type: 'string', description: 'Btw-code voor de rubriekindeling (uit vat_code.list). Optioneel.' },
            client_id: { type: 'string', description: 'Alleen op een debiteurenrekening.' },
            supplier_id: { type: 'string', description: 'Alleen op een crediteurenrekening.' },
            project_id: { type: 'string', description: 'Koppel de regel aan een project (optioneel).' },
          },
          required: ['account_id'],
        },
      },
    },
    required: ['date', 'description', 'lines'],
    async plan(ctx, input) {
      const date = isoDate(input, 'date');
      const description = str(input, 'description', 300);
      const raw = rawLines(input);

      // De regelopbouw spiegelt MemorialModal in src/features/Bookkeeping.tsx: de
      // grondslag volgt de natuurlijke kant van de rekening (omzet = credit − debet,
      // kosten/activa = debet − credit) zodat compute_vat_boxes de regel in de juiste
      // rubriek telt. Die afleiding staat daar inline in het formulier en is niet
      // herbruikbaar, dus hij hoort hier — niet in de uitvoerder.
      const lines: Array<Record<string, unknown>> = [];
      const described: string[] = [];
      let totalDebit = 0;
      let totalCredit = 0;

      for (const line of raw) {
        const accountId = id(line as Record<string, unknown>, 'account_id');
        const debit = lineCents(line, 'debit_eur');
        const credit = lineCents(line, 'credit_eur');
        if (debit === 0 && credit === 0) continue;
        if (debit !== 0 && credit !== 0) throw new ActionError('Een regel is óf debet óf credit, niet allebei.');

        const account = await loadAccount(ctx, accountId);
        if (!account.is_active) throw new ActionError(`${accountLabel(account)} staat op inactief en kan niet geboekt worden.`);

        const entry: Record<string, unknown> = {
          account_id: accountId,
          description: optStr(line as Record<string, unknown>, 'description', 200),
          debit_cents: debit,
          credit_cents: credit,
        };

        const clientId = optId(line as Record<string, unknown>, 'client_id');
        if (clientId) {
          if (account.subtype !== 'accounts_receivable') throw new ActionError(`Een klant hoort alleen op een debiteurenrekening; ${accountLabel(account)} is dat niet.`);
          const client = await row<{ name: string }>(ctx, 'clients', clientId, 'name', 'Klant');
          entry.client_id = clientId;
          described.push(client.name);
        }
        const supplierId = optId(line as Record<string, unknown>, 'supplier_id');
        if (supplierId) {
          if (account.subtype !== 'accounts_payable') throw new ActionError(`Een leverancier hoort alleen op een crediteurenrekening; ${accountLabel(account)} is dat niet.`);
          const supplier = await row<{ name: string }>(ctx, 'suppliers', supplierId, 'name', 'Leverancier');
          entry.supplier_id = supplierId;
          described.push(supplier.name);
        }
        const projectId = optId(line as Record<string, unknown>, 'project_id');
        if (projectId) {
          await row<{ name: string }>(ctx, 'projects', projectId, 'name', 'Project');
          entry.project_id = projectId;
        }

        const vatCode = optStr(line as Record<string, unknown>, 'vat_code', 40);
        if (vatCode) {
          const code = await loadVatCode(ctx, vatCode);
          const base = account.type === 'revenue' ? credit - debit : debit - credit;
          entry.vat_code = code.code;
          entry.vat_rate = code.rate;
          entry.vat_base_cents = base;
          entry.vat_amount_cents = Math.round(base * (code.rate / 100));
        }

        lines.push(entry);
        totalDebit += debit;
        totalCredit += credit;
      }

      if (lines.length < 2) throw new ActionError('Een memoriaalboeking heeft minstens twee regels met een bedrag nodig.');
      if (totalDebit !== totalCredit) {
        throw new ActionError(`Debet (${euroCents(totalDebit)}) en credit (${euroCents(totalCredit)}) zijn niet gelijk; het verschil is ${euroCents(Math.abs(totalDebit - totalCredit))}.`);
      }

      return {
        title: `Memoriaalboeking van ${euroCents(totalDebit)} boeken op ${date}`,
        sub: joinShort([description, `${lines.length} regels`, ...described], 150),
        warning: 'Dit schrijft direct in het grootboek. Je kunt het boekstuk daarna niet meer wijzigen of verwijderen — corrigeren kan alleen met een tegenboeking.',
        kind: 'money',
        payload: { date, description, lines },
      };
    },
  },

  {
    id: 'journal.reverse',
    label: 'Boekstuk tegenboeken',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Maakt een spiegelboeking die een geboekt boekstuk neutraliseert — het origineel blijft staan, het paar telt netto op tot nul. Een tegengeboekte inkoopfactuur gaat terug naar concept, zodat je hem kunt corrigeren en opnieuw boeken. ' +
      'Een verkoopfactuur of creditnota boek je NIET zo tegen (corrigeren gaat met "Crediteren"), en een betaling evenmin (bank: "Boeking ongedaan maken"; Mollie: terugbetalen). ' +
      'Zoek het boekstuk met `list_journal_entries`. Kies de boekdatum van de tegenboeking (standaard vandaag); in een afgesloten periode boeken kan niet. ' +
      'Jaarafsluitingen, resultaatbestemmingen, vennootschapsbelasting, DGA-rente en dividend draai je NIET zo terug — die hebben hun eigen terugweg (boekjaar heropenen, bestemming terugdraaien). ' +
      'DE TEGENBOEKING IS ZELF OOK EEN DEFINITIEVE BOEKING en is niet ongedaan te maken.',
    keywords: ['tegenboeken', 'terugdraaien', 'storneren', 'corrigeren', 'spiegelboeking', 'boekstuk', 'journaalpost'],
    input: {
      entry_id: { type: 'string', description: 'Id van het boekstuk (uit list_journal_entries).' },
      date: { type: 'string', description: 'Boekdatum van de tegenboeking JJJJ-MM-DD. Standaard vandaag.' },
    },
    required: ['entry_id'],
    async plan(ctx, input) {
      const entryId = id(input, 'entry_id');
      const entry = await row<{ entry_number: string | null; date: string; description: string | null; status: string; source_type: string; reversed_by_entry_id: string | null; reverses_entry_id: string | null }>(
        ctx, 'journal_entries', entryId, 'entry_number, date, description, status, source_type, reversed_by_entry_id, reverses_entry_id', 'Boekstuk');
      if (entry.status !== 'posted') throw new ActionError(`Boekstuk ${entry.entry_number ?? ''} staat op "${entry.status}" en is niet geboekt; alleen een geboekt boekstuk kun je tegenboeken.`);
      if (entry.reversed_by_entry_id) throw new ActionError(`Boekstuk ${entry.entry_number ?? ''} is al tegengeboekt.`);
      if (entry.reverses_entry_id) throw new ActionError(`Boekstuk ${entry.entry_number ?? ''} is zelf een tegenboeking; boek het oorspronkelijke boekstuk opnieuw.`);
      if (SYSTEM_ENTRY_SOURCES.includes(entry.source_type)) {
        throw new ActionError(`Boekstuk ${entry.entry_number ?? ''} hoort bij "${entry.source_type}" en draai je terug via de bijbehorende handeling (boekjaar heropenen of bestemming terugdraaien), niet met een losse tegenboeking.`);
      }
      if (OWN_WAY_BACK[entry.source_type]) {
        throw new ActionError(`Boekstuk ${entry.entry_number ?? ''} boek je niet los tegen. ${OWN_WAY_BACK[entry.source_type]}`);
      }
      const date = optIsoDate(input, 'date') ?? ctx.today;
      return {
        title: `Boekstuk ${entry.entry_number ?? entryId.slice(0, 8)} tegenboeken`,
        sub: joinShort([entry.description ?? '', `origineel ${entry.date}`, `tegenboeking op ${date}`], 140),
        warning: 'De spiegelboeking is zelf ook een definitief boekstuk; je kunt hem niet ongedaan maken.',
        kind: 'money',
        payload: { entry_id: entryId, entry_number: entry.entry_number, date },
      };
    },
  },

  {
    id: 'journal.opening_balance',
    label: 'Beginbalans vastleggen',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Legt de eindbalans van het vorige boekhoudpakket vast als één openingsbalans-boekstuk: banksaldo, openstaande debiteuren en crediteuren, activa. ' +
      'Alleen balansrekeningen (bezittingen, schulden, eigen vermogen) horen erin — geen omzet of kosten. Het verschil tussen debet en credit wordt automatisch op de eigen-vermogensrekening gezet zodat de balans sluit. ' +
      'DIT KAN MAAR ÉÉN KEER: er kan maar één geldige beginbalans zijn. Klopt er iets niet, dan moet het boekstuk eerst worden tegengeboekt voordat je een nieuwe vastlegt.',
    keywords: ['beginbalans', 'openingsbalans', 'overstappen', 'startsaldo', 'vorige pakket', 'migratie'],
    input: {
      as_of: { type: 'string', description: 'Peildatum JJJJ-MM-DD, meestal de boekhoud-startdatum.' },
      lines: {
        type: 'array',
        description: 'De balansstanden per rekening.',
        items: {
          type: 'object',
          properties: {
            account_id: { type: 'string', description: 'Id van een balansrekening (asset, liability of equity).' },
            debit_eur: { type: 'number', description: 'Debetstand in euro.' },
            credit_eur: { type: 'number', description: 'Creditstand in euro.' },
          },
          required: ['account_id'],
        },
      },
    },
    required: ['as_of', 'lines'],
    async plan(ctx, input) {
      const asOf = isoDate(input, 'as_of');
      const raw = rawLines(input);

      const { data: existing } = await orgQuery(ctx, 'journal_entries', 'id, entry_number, date')
        .eq('source_type', 'opening_balance').eq('status', 'posted').is('reversed_by_entry_id', null).is('reverses_entry_id', null).maybeSingle();
      if (existing) {
        const e = existing as { entry_number: string | null; date: string };
        throw new ActionError(`Er ligt al een beginbalans (boekstuk ${e.entry_number ?? ''} van ${e.date}). Boek die eerst tegen voordat je een nieuwe vastlegt.`);
      }

      const lines: Array<Record<string, unknown>> = [];
      let totalDebit = 0;
      let totalCredit = 0;
      for (const line of raw) {
        const accountId = id(line as Record<string, unknown>, 'account_id');
        const debit = lineCents(line, 'debit_eur');
        const credit = lineCents(line, 'credit_eur');
        if (debit === 0 && credit === 0) continue;
        if (debit !== 0 && credit !== 0) throw new ActionError('Een regel is óf debet óf credit, niet allebei.');
        const account = await loadAccount(ctx, accountId);
        if (!['asset', 'liability', 'equity'].includes(account.type)) {
          throw new ActionError(`${accountLabel(account)} is een ${account.type}-rekening; een beginbalans bevat alleen balansstanden (asset, liability, equity).`);
        }
        if (!account.is_active) throw new ActionError(`${accountLabel(account)} staat op inactief.`);
        lines.push({ account_id: accountId, description: `Beginbalans ${account.name}`, debit_cents: debit, credit_cents: credit });
        totalDebit += debit;
        totalCredit += credit;
      }
      if (lines.length === 0) throw new ActionError('Geef minstens één rekening met een saldo.');

      const plug = await rpc<{ code: string; name: string } | Array<{ code: string; name: string }> | null>(
        ctx, 'opening_balance_plug_account', {}, 'Sluitpostrekening ophalen');
      const plugRow = Array.isArray(plug) ? plug[0] ?? null : plug;
      const equity = totalDebit - totalCredit;

      return {
        title: `Beginbalans per ${asOf} vastleggen`,
        sub: joinShort([
          `${lines.length} rekeningen`,
          `debet ${euroCents(totalDebit)} · credit ${euroCents(totalCredit)}`,
          `sluitpost ${euroCents(Math.abs(equity))} ${equity >= 0 ? 'credit' : 'debet'} op ${plugRow ? `${plugRow.code} ${plugRow.name}` : 'de eigen-vermogensrekening'}`,
        ], 200),
        warning: 'Je kunt maar één beginbalans hebben. Klopt er hierna iets niet, dan moet je dit boekstuk eerst tegenboeken voordat je een nieuwe kunt vastleggen.',
        kind: 'money',
        payload: { as_of: asOf, lines },
      };
    },
  },

  // ── Leveranciers en inkoopfacturen ────────────────────────────────────────
  {
    id: 'supplier.update',
    label: 'Leverancier bijwerken',
    module: 'finance',
    kind: 'write',
    description:
      'Werkt de gegevens van een bestaande leverancier (crediteur) bij: adres, btw- en KvK-nummer, IBAN, contactgegevens, de standaard kostenrekening en btw-code die bij een nieuwe inkoopfactuur worden voorgesteld, en de status actief/inactief. ' +
      'Zoek de leverancier eerst met `list_suppliers`; een NIEUWE leverancier zet je klaar met `propose_supplier`. Geef alleen wat verandert.',
    keywords: ['leverancier', 'crediteur', 'iban', 'kostenrekening', 'bewerken', 'inactief', 'btw-nummer'],
    input: {
      supplier_id: { type: 'string', description: 'Id van de leverancier (uit list_suppliers).' },
      name: { type: 'string' },
      supplier_code: { type: 'string' },
      contact_name: { type: 'string' },
      email: { type: 'string' },
      phone: { type: 'string' },
      address_line1: { type: 'string' },
      postal_code: { type: 'string' },
      city: { type: 'string' },
      country: { type: 'string' },
      vat_number: { type: 'string' },
      kvk_number: { type: 'string' },
      iban: { type: 'string' },
      default_expense_account_id: { type: 'string', description: 'Grootboekrekening die bij een nieuwe inkoopfactuur wordt voorgesteld.' },
      default_vat_code: { type: 'string', description: 'Btw-code die standaard wordt voorgesteld.' },
      notes: { type: 'string' },
      status: { type: 'string', enum: [...SUPPLIER_STATUS] },
    },
    required: ['supplier_id'],
    async plan(ctx, input) {
      const supplierId = id(input, 'supplier_id');
      const supplier = await row<{ name: string; iban: string | null; email: string | null; default_expense_account_id: string | null; default_vat_code: string | null }>(
        ctx, 'suppliers', supplierId, 'name, iban, email, default_expense_account_id, default_vat_code', 'Leverancier');
      const patch: Record<string, unknown> = {};
      const textFields: Array<[string, number]> = [
        ['name', 200], ['supplier_code', 40], ['contact_name', 120], ['email', 200], ['phone', 40],
        ['address_line1', 200], ['postal_code', 20], ['city', 120], ['country', 120],
        ['vat_number', 40], ['kvk_number', 40], ['iban', 40], ['notes', 1000],
      ];
      for (const [key, max] of textFields) {
        if (input[key] !== undefined) patch[key] = optStr(input, key, max);
      }
      if (input.default_expense_account_id !== undefined) {
        const accountId = optId(input, 'default_expense_account_id');
        if (accountId) await loadAccount(ctx, accountId);
        patch.default_expense_account_id = accountId;
      }
      if (input.default_vat_code !== undefined) {
        const vatCode = optStr(input, 'default_vat_code', 40);
        if (vatCode) await loadVatCode(ctx, vatCode);
        patch.default_vat_code = vatCode;
      }
      const status = optChoice(input, 'status', SUPPLIER_STATUS);
      if (status) patch.status = status;
      if (patch.name === null) throw new ActionError('De naam van een leverancier mag niet leeg zijn.');
      if (Object.keys(patch).length === 0) throw new ActionError('Geef minstens één veld dat moet veranderen.');

      // Het IBAN en het e-mailadres van een leverancier bepalen waar geld heen
      // gaat, en de factuur-inbox vergelijkt er het IBAN op een nieuwe factuur
      // mee (fraudecontrole). Wijzigen gaat daarom altijd langs een mens — ook
      // voor een koppeling met execute_high (humanOnly) — en de kaart toont het
      // oude en het nieuwe adres, zodat de goedkeurder ziet wat er verandert.
      const changed = (key: 'iban' | 'email') => key in patch && (patch[key] ?? null) !== (supplier[key] ?? null);
      const touchesPayment = changed('iban') || changed('email');
      const shown: string[] = [];
      if (changed('iban')) shown.push(`IBAN ${supplier.iban ?? '—'} → ${String(patch.iban ?? '—')}`);
      if (changed('email')) shown.push(`e-mail ${supplier.email ?? '—'} → ${String(patch.email ?? '—')}`);
      // De standaard kostenrekening en btw-code gebruikt de factuur-inbox bij
      // het automatisch boeken van binnengekomen facturen.
      const touchesBooking = ('default_expense_account_id' in patch && patch.default_expense_account_id !== supplier.default_expense_account_id)
        || ('default_vat_code' in patch && patch.default_vat_code !== supplier.default_vat_code);
      const rest = Object.keys(patch).filter((key) => !((key === 'iban' && changed('iban')) || (key === 'email' && changed('email'))));
      return {
        title: `Leverancier bijwerken: ${supplier.name}`,
        sub: joinShort([...shown, ...rest], 220),
        kind: 'work',
        payload: { supplier_id: supplierId, name: supplier.name, patch },
        ...(touchesPayment ? {
          risk: 'high' as const,
          humanOnly: true,
          warning: 'Hiermee verandert het IBAN of het e-mailadres van deze leverancier. Controleer dit bij de leverancier zelf, niet via de mail die erom vraagt.',
        } : touchesBooking ? {
          risk: 'high' as const,
          warning: 'De factuur-inbox boekt binnengekomen facturen van deze leverancier voortaan op de nieuwe kostenrekening of btw-code.',
        } : {}),
      };
    },
  },

  {
    id: 'purchase_invoice.update',
    label: 'Concept-inkoopfactuur bijwerken',
    module: 'finance',
    kind: 'write',
    description:
      'Past een nog niet geboekte CONCEPT-inkoopfactuur aan: leverancier, factuurnummer, datums, project, notities en de regels. ' +
      'Geef je `lines` mee, dan vervangen die alle bestaande regels en worden subtotaal, btw en totaal opnieuw berekend. Een geboekte factuur kan niet meer worden gewijzigd — corrigeren gaat via een tegenboeking. ' +
      'Zoek de factuur met `list_purchase_invoices`; een nieuwe concept-factuur zet je klaar met `propose_purchase_invoice`.',
    keywords: ['inkoopfactuur', 'concept', 'bewerken', 'regels', 'crediteur', 'bedrag aanpassen'],
    input: {
      purchase_invoice_id: { type: 'string', description: 'Id van de inkoopfactuur (uit list_purchase_invoices).' },
      supplier_id: { type: 'string' },
      supplier_invoice_number: { type: 'string', description: 'Het factuurnummer van de leverancier.' },
      date: { type: 'string', description: 'Factuurdatum JJJJ-MM-DD.' },
      due_date: { type: 'string', description: 'Vervaldatum JJJJ-MM-DD.' },
      project_id: { type: 'string' },
      notes: { type: 'string' },
      lines: {
        type: 'array',
        description: 'Vervangt ALLE bestaande regels. Weglaten betekent: regels ongemoeid laten.',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            amount_eur: { type: 'number', description: 'Bedrag EXCL. btw in euro.' },
            vat_code: { type: 'string', description: 'Btw-code (uit vat_code.list); bepaalt het tarief.' },
            account_id: { type: 'string', description: 'Kostenrekening; leeg valt bij het boeken terug op 4500.' },
          },
          required: ['description', 'amount_eur', 'vat_code'],
        },
      },
    },
    required: ['purchase_invoice_id'],
    async plan(ctx, input) {
      const invoiceId = id(input, 'purchase_invoice_id');
      const invoice = await row<{ internal_number: string | null; supplier_invoice_number: string | null; status: string; total_cents: number }>(
        ctx, 'purchase_invoices', invoiceId, 'internal_number, supplier_invoice_number, status, total_cents', 'Inkoopfactuur');
      if (invoice.status !== 'draft') {
        throw new ActionError(`Inkoopfactuur ${invoice.internal_number ?? ''} staat op "${invoice.status}" en is niet meer te wijzigen. Corrigeren kan via een tegenboeking in het grootboek.`);
      }

      const patch: Record<string, unknown> = {};
      const described: string[] = [];

      const supplierId = optId(input, 'supplier_id');
      if (supplierId) {
        const supplier = await row<{ name: string }>(ctx, 'suppliers', supplierId, 'name', 'Leverancier');
        patch.supplier_id = supplierId;
        described.push(supplier.name);
      }
      if (input.supplier_invoice_number !== undefined) patch.supplier_invoice_number = optStr(input, 'supplier_invoice_number', 80);
      const date = optIsoDate(input, 'date');
      if (date) patch.date = date;
      if (input.due_date !== undefined) patch.due_date = optIsoDate(input, 'due_date');
      if (input.project_id !== undefined) {
        const projectId = optId(input, 'project_id');
        if (projectId) await row<{ name: string }>(ctx, 'projects', projectId, 'name', 'Project');
        patch.project_id = projectId;
      }
      if (input.notes !== undefined) patch.notes = optStr(input, 'notes', 2000);

      let lines: Array<Record<string, unknown>> | null = null;
      if (Array.isArray(input.lines)) {
        const raw = input.lines as Array<Record<string, unknown>>;
        if (raw.length === 0) throw new ActionError('Een inkoopfactuur heeft minstens één regel nodig.');
        lines = [];
        let subtotal = 0;
        for (const line of raw.slice(0, 100)) {
          const code = await loadVatCode(ctx, str(line, 'vat_code', 40));
          const accountId = optId(line, 'account_id');
          if (accountId) await loadAccount(ctx, accountId);
          const amount = cents(line, 'amount_eur');
          subtotal += amount;
          lines.push({
            id: crypto.randomUUID(),
            description: str(line, 'description', 300),
            amount_cents: amount,
            vat_code: code.code,
            vat_rate: code.rate,
            account_id: accountId,
          });
        }
        described.push(`${lines.length} regels · ${euroCents(subtotal)} excl. btw`);
      }

      if (Object.keys(patch).length === 0 && !lines) throw new ActionError('Geef minstens één veld of nieuwe regels.');

      return {
        title: `Concept-inkoopfactuur bijwerken: ${invoice.internal_number ?? invoice.supplier_invoice_number ?? invoiceId.slice(0, 8)}`,
        sub: joinShort([...described, ...Object.keys(patch), lines ? 'de bestaande regels worden vervangen' : null], 150),
        kind: 'money',
        payload: { purchase_invoice_id: invoiceId, number: invoice.internal_number, patch, lines },
      };
    },
  },

  {
    id: 'purchase_invoice.book',
    label: 'Inkoopfactuur naar het grootboek boeken',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Boekt een concept-inkoopfactuur in het grootboek: de kosten op de gekozen rekeningen, de voorbelasting op 1500 en de crediteurenstand op 1600. Pas daarna telt de factuur mee in de btw-aangifte en is hij tegen een banktransactie af te letteren. ' +
      'Controleer eerst de regels en de grootboekrekeningen met `list_purchase_invoices`. ' +
      'DIT IS DEFINITIEF: na het boeken is de factuur niet meer te wijzigen en kan alleen nog met een tegenboeking worden gecorrigeerd. Valt de factuurdatum in een afgesloten periode (boekjaar of btw-aangifte), dan boekt ResoFly op de eerste open datum daarna — mogelijk in het volgende boekjaar; de factuurdatum zelf blijft staan.',
    keywords: ['inkoopfactuur boeken', 'grootboek', 'voorbelasting', 'crediteuren', 'definitief', 'boeken'],
    input: { purchase_invoice_id: { type: 'string', description: 'Id van de inkoopfactuur (uit list_purchase_invoices).' } },
    required: ['purchase_invoice_id'],
    async plan(ctx, input) {
      const invoiceId = id(input, 'purchase_invoice_id');
      const invoice = await row<{ internal_number: string | null; supplier_invoice_number: string | null; supplier_id: string | null; date: string; status: string; subtotal_cents: number; vat_cents: number; total_cents: number }>(
        ctx, 'purchase_invoices', invoiceId, 'internal_number, supplier_invoice_number, supplier_id, date, status, subtotal_cents, vat_cents, total_cents', 'Inkoopfactuur');
      if (invoice.status !== 'draft') throw new ActionError(`Inkoopfactuur ${invoice.internal_number ?? ''} staat al op "${invoice.status}" en is dus niet meer te boeken.`);
      const supplier = invoice.supplier_id
        ? await row<{ name: string }>(ctx, 'suppliers', invoice.supplier_id, 'name', 'Leverancier')
        : null;
      // Zoals book_purchase_invoice: in een afgesloten periode gaat de boeking
      // naar de eerste open datum. Dat hoort op de kaart te staan.
      const { data: openDate } = await ctx.db.rpc('first_open_booking_date', { p_organization_id: ctx.organizationId, p_date: invoice.date });
      const bookDate = typeof openDate === 'string' ? openDate.slice(0, 10) : invoice.date;
      return {
        title: `Inkoopfactuur ${invoice.internal_number ?? invoice.supplier_invoice_number ?? ''} naar het grootboek boeken`,
        sub: joinShort([
          supplier?.name,
          `${euroCents(invoice.total_cents)} incl. btw (voorbelasting ${euroCents(invoice.vat_cents)})`,
          bookDate !== invoice.date
            ? `factuurdatum ${invoice.date} valt in een afgesloten periode: geboekt op ${bookDate}`
            : `boekdatum ${invoice.date}`,
        ], 200),
        warning: 'Na het boeken kun je deze factuur niet meer wijzigen; corrigeren kan alleen met een tegenboeking.',
        kind: 'money',
        payload: { purchase_invoice_id: invoiceId, number: invoice.internal_number ?? invoice.supplier_invoice_number, supplier_name: supplier?.name ?? null },
      };
    },
  },

  // ── Factuur-inbox: inkoopfacturen die per e-mail binnenkwamen ─────────────
  //
  // De verwerking (uitlezen, leverancier, dubbelcontrole, concept) zit in de
  // edge functions; hier alleen lezen en de drie knoppen van het scherm. De
  // uitvoerder in de browser roept dezelfde `invoice-inbox`-functie aan als de
  // knop, dus wat Gerrie klaarzet doet precies wat een klik zou doen.

  {
    id: 'purchase_invoice_inbox.list',
    label: 'Per e-mail binnengekomen inkoopfacturen bekijken',
    module: 'finance',
    kind: 'read',
    description:
      'Geeft wat er op het factuur-doorstuuradres binnenkwam: per item de status (ontvangen, wordt uitgelezen, concept klaargezet, geboekt, aandacht nodig, dubbel, genegeerd, mislukt), ' +
      'de reden als er iets te doen is, afzender en onderwerp, de herkende leverancier, het factuurnummer en het totaal, en het id van het klaargezette concept. ' +
      'Standaard alleen wat open staat (aandacht nodig, dubbel, mislukt, nog bezig); met `scope: all` ook de afgehandelde items. ' +
      'Klaarzetten, opnieuw verwerken of negeren doe je met `purchase_invoice_inbox.prepare`, `purchase_invoice_inbox.reprocess` en `purchase_invoice_inbox.reject`.',
    keywords: ['factuur-inbox', 'inkoopfacturen per e-mail', 'binnengekomen facturen', 'factuuradres', 'doorstuuradres facturen', 'aandacht nodig', 'dubbele factuur', 'uitgelezen'],
    input: {
      scope: { type: 'string', enum: ['open', 'all'], description: 'open = alleen wat op een mens wacht of nog loopt (standaard); all = alles behalve weggegooide transportfouten.' },
      limit: { type: 'number', description: 'Maximaal aantal items, standaard 50.' },
    },
    async read(ctx, input) {
      const scope = optChoice(input, 'scope', ['open', 'all'] as const) ?? 'open';
      const limit = Math.min(Math.max(Math.round(optNum(input, 'limit') ?? 50), 1), 200);
      let query = orgQuery(ctx, 'purchase_invoice_inbox',
        'id, status, reason, received_at, sender_email, sender_name, subject, supplier_id, purchase_invoice_id, duplicate_of_purchase_invoice_id, method, confidence, warnings, proposal, attachments, auto_booked')
        .neq('status', 'dropped').order('received_at', { ascending: false }).limit(limit);
      if (scope === 'open') query = query.in('status', ['received', 'processing', 'needs_review', 'duplicate', 'failed']);
      const { data, error } = await query;
      if (error) throw new ActionError(`Factuur-inbox ophalen mislukt: ${error.message}`);
      const rows = (data ?? []) as Array<Record<string, unknown>>;

      // Leveranciersnamen in één extra query erbij (geen join over de service-role heen).
      const supplierIds = [...new Set(rows.map((r) => r.supplier_id).filter((v): v is string => typeof v === 'string'))];
      const names = new Map<string, string>();
      if (supplierIds.length) {
        const { data: sups } = await orgQuery(ctx, 'suppliers', 'id, name').in('id', supplierIds);
        for (const s of (sups ?? []) as Array<{ id: string; name: string }>) names.set(s.id, s.name);
      }

      return {
        items: rows.map((r) => {
          const proposal = (r.proposal && typeof r.proposal === 'object' ? r.proposal : null) as
            { supplier?: { name?: string }; supplier_invoice_number?: string | null; totals?: { total_cents?: number } } | null;
          const total = proposal?.totals?.total_cents;
          const supplierId = typeof r.supplier_id === 'string' ? r.supplier_id : null;
          return {
            inbox_id: r.id,
            status: r.status,
            reason: r.reason ?? null,
            received_at: r.received_at,
            sender: (r.sender_name as string | null) || (r.sender_email as string | null) || null,
            sender_email: r.sender_email ?? null,
            subject: r.subject,
            supplier_id: supplierId,
            supplier_name: (supplierId ? names.get(supplierId) : null) ?? proposal?.supplier?.name ?? null,
            supplier_invoice_number: proposal?.supplier_invoice_number ?? null,
            total_eur: typeof total === 'number' ? Math.round(total) / 100 : null,
            method: r.method ?? null,
            confidence: r.confidence ?? null,
            warnings: Array.isArray(r.warnings) ? r.warnings : [],
            attachments: Array.isArray(r.attachments) ? (r.attachments as Array<{ name?: string }>).map((a) => a.name).filter(Boolean) : [],
            purchase_invoice_id: r.purchase_invoice_id ?? null,
            duplicate_of_purchase_invoice_id: r.duplicate_of_purchase_invoice_id ?? null,
            auto_booked: r.auto_booked === true,
          };
        }),
        note: scope === 'open' ? 'Alleen items die open staan; gebruik scope all voor de afgehandelde.' : null,
      };
    },
  },

  {
    id: 'purchase_invoice_inbox.prepare',
    label: 'Binnengekomen factuur klaarzetten als concept',
    module: 'finance',
    kind: 'write',
    description:
      'Zet een per e-mail binnengekomen factuur uit de factuur-inbox klaar als concept-inkoopfactuur, met het uitgelezen voorstel en de bijlage als bewijsstuk. ' +
      'Nodig als de leverancier niet herkend was (geef dan `supplier_id`, of `create_supplier: true` om hem uit de factuurgegevens aan te maken) of als het item als dubbel is gemarkeerd en je het toch wilt (`allow_duplicate: true`). ' +
      'Er wordt niets geboekt; boeken gaat daarna met `purchase_invoice.book`. Zoek het item met `purchase_invoice_inbox.list`.',
    keywords: ['factuur-inbox', 'klaarzetten', 'concept', 'leverancier kiezen', 'toch klaarzetten', 'dubbel', 'inkoopfactuur per e-mail'],
    input: {
      inbox_id: { type: 'string', description: 'Id van het inbox-item (uit purchase_invoice_inbox.list).' },
      supplier_id: { type: 'string', description: 'Bestaande leverancier om aan de factuur te hangen.' },
      create_supplier: { type: 'boolean', description: 'Maak de leverancier aan uit de uitgelezen factuurgegevens.' },
      allow_duplicate: { type: 'boolean', description: 'Ook klaarzetten als het item als dubbel is gemarkeerd.' },
    },
    required: ['inbox_id'],
    async plan(ctx, input) {
      const inboxId = id(input, 'inbox_id');
      const item = await row<{ status: string; reason: string | null; subject: string; sender_email: string | null; sender_name: string | null; supplier_id: string | null; proposal: Record<string, unknown> | null }>(
        ctx, 'purchase_invoice_inbox', inboxId, 'status, reason, subject, sender_email, sender_name, supplier_id, proposal', 'Inbox-item');
      if (!['needs_review', 'duplicate', 'failed', 'received'].includes(item.status)) {
        throw new ActionError(`Dit item staat op "${item.status}" en kan niet (opnieuw) klaargezet worden.`);
      }
      const allowDuplicate = bool(input, 'allow_duplicate', false);
      if (item.status === 'duplicate' && !allowDuplicate) {
        throw new ActionError('Dit item is als dubbel gemarkeerd. Geef `allow_duplicate: true` als je toch een (tweede) concept wilt.');
      }
      const proposal = item.proposal as { supplier?: { name?: string; matchedId?: string | null }; supplier_invoice_number?: string | null; totals?: { total_cents?: number } } | null;
      const supplierName = proposal?.supplier?.name?.trim() || null;
      const supplierId = optId(input, 'supplier_id');
      const createSupplier = bool(input, 'create_supplier', false);
      let supplierLabel: string;
      if (supplierId) {
        const supplier = await row<{ name: string }>(ctx, 'suppliers', supplierId, 'name', 'Leverancier');
        supplierLabel = supplier.name;
      } else if (createSupplier) {
        if (!supplierName) throw new ActionError('Er is geen leveranciersnaam uitgelezen; geef een `supplier_id`.');
        supplierLabel = `${supplierName} (nieuw)`;
      } else if (item.supplier_id || proposal?.supplier?.matchedId) {
        const known = await row<{ name: string }>(ctx, 'suppliers', item.supplier_id ?? String(proposal?.supplier?.matchedId), 'name', 'Leverancier');
        supplierLabel = known.name;
      } else if (item.reason === 'supplier_unknown' || !proposal) {
        throw new ActionError('De leverancier is niet herkend. Geef een `supplier_id` (zie suppliers) of `create_supplier: true`.');
      } else {
        supplierLabel = supplierName ?? 'leverancier volgens de factuur';
      }
      const total = proposal?.totals?.total_cents;
      return {
        title: `Binnengekomen factuur klaarzetten: ${supplierLabel}`,
        sub: joinShort([
          proposal?.supplier_invoice_number ? `nr. ${proposal.supplier_invoice_number}` : null,
          typeof total === 'number' ? `${euroCents(total)} incl. btw` : null,
          item.status === 'duplicate' ? 'ondanks de dubbelmelding' : null,
          'als concept — boeken doe je daarna',
        ], 160),
        kind: 'money',
        payload: { inbox_id: inboxId, supplier_id: supplierId, create_supplier: createSupplier, allow_duplicate: allowDuplicate, label: supplierLabel },
      };
    },
  },

  {
    id: 'purchase_invoice_inbox.reprocess',
    label: 'Binnengekomen factuur opnieuw verwerken',
    module: 'finance',
    kind: 'write',
    description:
      'Leest een per e-mail binnengekomen factuur opnieuw uit en zet hem klaar als dat kan. Voor items die mislukten door een storing, of die wachtten omdat de AI niet beschikbaar was of het tegoed op was. ' +
      'Een item dat op een leverancierkeuze wacht, help je met `purchase_invoice_inbox.prepare`.',
    keywords: ['factuur-inbox', 'opnieuw verwerken', 'opnieuw uitlezen', 'mislukt', 'herverwerken'],
    input: { inbox_id: { type: 'string', description: 'Id van het inbox-item (uit purchase_invoice_inbox.list).' } },
    required: ['inbox_id'],
    async plan(ctx, input) {
      const inboxId = id(input, 'inbox_id');
      const item = await row<{ status: string; reason: string | null; subject: string; sender_email: string | null; sender_name: string | null }>(
        ctx, 'purchase_invoice_inbox', inboxId, 'status, reason, subject, sender_email, sender_name', 'Inbox-item');
      if (!['needs_review', 'failed', 'received'].includes(item.status)) {
        throw new ActionError(`Dit item staat op "${item.status}" en is niet opnieuw te verwerken.`);
      }
      const label = item.sender_name || item.sender_email || item.subject || inboxId.slice(0, 8);
      return {
        title: `Binnengekomen factuur opnieuw verwerken: ${label}`,
        sub: joinShort([item.subject, item.reason ? `nu: ${item.reason}` : null], 140),
        kind: 'work',
        payload: { inbox_id: inboxId, label },
      };
    },
  },

  {
    id: 'purchase_invoice_inbox.reject',
    label: 'Binnengekomen factuur negeren',
    module: 'finance',
    kind: 'write',
    description:
      'Legt een item uit de factuur-inbox weg: geen factuur, niet van ons, of al op een andere manier verwerkt. Er wordt niets aangemaakt of verwijderd; het item blijft zichtbaar onder "afgehandeld" en is te herstellen.',
    keywords: ['factuur-inbox', 'negeren', 'wegleggen', 'geen factuur', 'spam'],
    input: { inbox_id: { type: 'string', description: 'Id van het inbox-item (uit purchase_invoice_inbox.list).' } },
    required: ['inbox_id'],
    async plan(ctx, input) {
      const inboxId = id(input, 'inbox_id');
      const item = await row<{ status: string; subject: string; sender_email: string | null; sender_name: string | null }>(
        ctx, 'purchase_invoice_inbox', inboxId, 'status, subject, sender_email, sender_name', 'Inbox-item');
      if (!['received', 'needs_review', 'duplicate', 'failed'].includes(item.status)) {
        throw new ActionError(`Dit item staat op "${item.status}" en kan niet genegeerd worden.`);
      }
      const label = item.sender_name || item.sender_email || item.subject || inboxId.slice(0, 8);
      return {
        title: `Binnengekomen factuur negeren: ${label}`,
        sub: joinShort([item.subject, 'blijft zichtbaar onder afgehandeld en is te herstellen'], 140),
        kind: 'work',
        payload: { inbox_id: inboxId, label },
      };
    },
  },

  // ── Bankrekeningen ────────────────────────────────────────────────────────
  {
    id: 'bank_account.list',
    label: 'Bankrekeningen bekijken',
    module: 'finance',
    kind: 'read',
    description:
      'Geeft de bankrekeningen van de organisatie: naam, IBAN, valuta, de gekoppelde grootboekrekening, of hij via PSD2 gekoppeld is of met afschriften wordt gevoed, wanneer er voor het laatst is gesynchroniseerd of ingelezen, en of hij actief is. ' +
      'Gebruik dit om het id te vinden voordat je een rekening bijwerkt, synchroniseert of een transactie boekt.',
    keywords: ['bankrekening', 'iban', 'rekeningen', 'bank', 'gekoppeld', 'psd2'],
    input: { include_inactive: { type: 'boolean', description: 'Ook rekeningen die op inactief staan.' } },
    async read(ctx, input) {
      let query = orgQuery(ctx, 'bank_accounts', 'id, name, iban, currency, ledger_account_id, source, provider, last_synced_at, last_imported_at, is_active')
        .order('name', { ascending: true }).limit(100);
      if (!bool(input, 'include_inactive', false)) query = query.eq('is_active', true);
      const { data, error } = await query;
      if (error) throw new ActionError(`Bankrekeningen ophalen mislukt: ${error.message}`);
      return { bank_accounts: data ?? [] };
    },
  },

  {
    id: 'bank.reconciliation',
    label: 'Saldo-aansluiting van de bank bekijken',
    module: 'finance',
    kind: 'read',
    description:
      'Controleert per bankrekening of het saldo volgens het laatste afschrift aansluit op de grootboekstand, inclusief wat er nog te boeken staat. ' +
      'Geeft ook de waarschuwingen: vermoedelijke dubbele imports, afschriften die intern niet kloppen (beginsaldo + regels ≠ eindsaldo), genegeerde transacties en het ontbreken van een beginbalans. ' +
      'Loopt het uiteen, dan missen er transacties of staan ze dubbel — zonder deze controle merk je dat pas bij de jaarrekening.',
    keywords: ['aansluiting', 'saldo', 'bank', 'controle', 'verschil', 'dubbele import', 'afschrift'],
    input: {},
    async read(ctx) {
      const rows = await rpc<unknown[]>(ctx, 'report_bank_reconciliation', {}, 'Saldo-aansluiting ophalen');
      return { reconciliation: rows ?? [] };
    },
  },

  {
    id: 'bank_account.create',
    label: 'Bankrekening aanmaken',
    module: 'finance',
    kind: 'write',
    description:
      'Maakt een bankrekening aan die met afschriften wordt gevoed (CAMT.053, MT940 of CSV) en koppelt hem aan een grootboekrekening — meestal 1100 Bank. ' +
      'Geef elke bankrekening een EIGEN grootboekrekening: delen twee rekeningen er één, dan is de saldo-aansluiting per rekening niet meer te berekenen. ' +
      'Een bank via PSD2 koppelen kan hier niet; dat vereist toestemming bij de bank zelf.',
    keywords: ['bankrekening aanmaken', 'iban', 'nieuwe rekening', 'handmatige rekening', 'grootboek 1100'],
    input: {
      name: { type: 'string', description: 'Bijvoorbeeld "Rabobank zakelijk".' },
      iban: { type: 'string' },
      currency: { type: 'string', description: 'Valutacode, standaard EUR.' },
      ledger_account_id: { type: 'string', description: 'Id van de grootboekrekening. Laat leeg om 1100 Bank te gebruiken.' },
    },
    required: ['name'],
    async plan(ctx, input) {
      const name = str(input, 'name', 120);
      const iban = optStr(input, 'iban', 40);
      const currency = (optStr(input, 'currency', 3) ?? 'EUR').toUpperCase();
      const accountId = optId(input, 'ledger_account_id');
      const account = accountId ? await loadAccount(ctx, accountId) : await accountByCode(ctx, '1100');
      if (!account) throw new ActionError('Geen grootboekrekening gekozen en 1100 Bank bestaat niet. Maak eerst het rekeningschema aan of geef `ledger_account_id`.');
      if (account.type !== 'asset') throw new ActionError(`${accountLabel(account)} is geen bezittingenrekening; een bankrekening hoort aan een asset-rekening te hangen.`);

      const { data: sharing } = await orgQuery(ctx, 'bank_accounts', 'id, name').eq('ledger_account_id', account.id).limit(1);
      const shared = Array.isArray(sharing) && sharing.length > 0 ? String((sharing[0] as { name: string }).name) : null;

      return {
        title: `Bankrekening aanmaken: ${name}`,
        sub: joinShort([iban, currency, accountLabel(account), shared ? `let op: ${shared} boekt al op deze grootboekrekening — de aansluiting per rekening vervalt dan` : null], 170),
        kind: 'work',
        payload: { name, iban, currency, ledger_account_id: account.id },
      };
    },
  },

  {
    id: 'bank_account.update',
    label: 'Bankrekening bijwerken of uitzetten',
    module: 'finance',
    kind: 'write',
    description:
      'Past naam, IBAN, valuta, de gekoppelde grootboekrekening of de actief-status van een bankrekening aan. Op inactief zetten is de zachte manier om een rekening af te schaffen: de transacties en boekingen blijven bewaard. ' +
      'De grootboekkoppeling wijzigen raakt de saldo-aansluiting van alle al geboekte transacties — doe dat alleen om een fout te herstellen. Zoek de rekening met `bank_account.list`.',
    keywords: ['bankrekening bewerken', 'iban wijzigen', 'grootboekkoppeling', 'inactief', 'bank'],
    input: {
      bank_account_id: { type: 'string' },
      name: { type: 'string' },
      iban: { type: 'string' },
      currency: { type: 'string' },
      ledger_account_id: { type: 'string' },
      is_active: { type: 'boolean' },
    },
    required: ['bank_account_id'],
    async plan(ctx, input) {
      const bankAccountId = id(input, 'bank_account_id');
      const bankAccount = await row<{ name: string; iban: string | null; is_active: boolean }>(
        ctx, 'bank_accounts', bankAccountId, 'name, iban, is_active', 'Bankrekening');
      const patch: Record<string, unknown> = {};
      const notes: string[] = [];

      const name = optStr(input, 'name', 120);
      if (name) patch.name = name;
      if (input.iban !== undefined) patch.iban = optStr(input, 'iban', 40);
      const currency = optStr(input, 'currency', 3);
      if (currency) patch.currency = currency.toUpperCase();
      const accountId = optId(input, 'ledger_account_id');
      let ledgerChanged = false;
      if (accountId) {
        const account = await loadAccount(ctx, accountId);
        if (account.type !== 'asset') throw new ActionError(`${accountLabel(account)} is geen bezittingenrekening.`);
        // Een bankrekening hoort op een liquide-middelenrekening, niet op
        // debiteuren, btw, activa of afschrijvingen: daar vervuilen de
        // bankboekingen de aansluiting (en de btw-aangifte).
        if (account.subtype && !['bank', 'psp_clearing'].includes(account.subtype)) {
          throw new ActionError(`${accountLabel(account)} is geen bank- of kasrekening; een bankrekening koppel je aan een rekening voor liquide middelen.`);
        }
        patch.ledger_account_id = accountId;
        ledgerChanged = true;
        notes.push(`grootboek wordt ${accountLabel(account)} — raakt de saldo-aansluiting van al geboekte transacties`);
      }
      if (input.iban !== undefined && patch.iban !== bankAccount.iban) {
        notes.push(`IBAN ${bankAccount.iban ?? '—'} → ${String(patch.iban ?? '—')}`);
      }
      if (typeof input.is_active === 'boolean') {
        patch.is_active = input.is_active;
        notes.push(input.is_active ? 'weer actief' : 'op inactief — transacties en boekingen blijven bewaard');
      }
      if (Object.keys(patch).length === 0) throw new ActionError('Geef minstens één veld dat moet veranderen.');

      return {
        title: `Bankrekening bijwerken: ${bankAccount.name}`,
        sub: joinShort([...Object.keys(patch), ...notes], 170),
        // De grootboekkoppeling bepaalt waar elke bankboeking landt: dat hoort
        // langs een mens.
        risk: ledgerChanged ? 'high' : 'normal',
        warning: ledgerChanged
          ? 'Alle boekingen van deze bankrekening komen voortaan op de nieuwe grootboekrekening; de saldo-aansluiting van al geboekte transacties verandert mee.'
          : undefined,
        kind: 'work',
        payload: { bank_account_id: bankAccountId, name: bankAccount.name, patch },
      };
    },
  },

  {
    id: 'bank_account.sync',
    label: 'Transacties bij de gekoppelde bank ophalen',
    module: 'finance',
    kind: 'write',
    description:
      'Haalt nieuwe transacties op bij een via PSD2 gekoppelde bank en zet ze in de af-te-letteren-lijst. Al bekende transacties worden overgeslagen. ' +
      'Dit werkt alleen bij een gekoppelde rekening; een rekening die met afschriften wordt gevoed heeft geen synchronisatie. Is de banktoestemming verlopen, dan meldt de synchronisatie dat en moet de bank opnieuw worden gekoppeld — dat kan alleen handmatig. ' +
      'Let op: staan er bankregels met "automatisch boeken" aan, dan kunnen binnengekomen transacties meteen worden geboekt.',
    keywords: ['synchroniseren', 'bank ophalen', 'psd2', 'transacties binnenhalen', 'sync'],
    input: { bank_account_id: { type: 'string', description: 'Id van de bankrekening; weglaten synchroniseert alle gekoppelde rekeningen.' } },
    async plan(ctx, input) {
      const bankAccountId = optId(input, 'bank_account_id');
      // Net als bank.rematch: met actieve regels die automatisch boeken ontstaan
      // er bij het ophalen meteen definitieve boekingen.
      const { data: autoRules } = await orgQuery(ctx, 'bank_rules', 'id, name').eq('auto_book', true).eq('is_active', true);
      const auto: Array<{ name: string }> = (autoRules ?? []) as Array<{ name: string }>;
      const autoRisk = auto.length > 0
        ? {
          risk: 'high' as const,
          warning: `${auto.length} bankregel${auto.length === 1 ? '' : 's'} met automatisch boeken (${auto.map((r) => r.name).join(', ')}) boek${auto.length === 1 ? 't' : 'en'} binnengekomen transacties meteen definitief; terugdraaien kan alleen met een tegenboeking.`,
        }
        : {};
      if (bankAccountId) {
        const bankAccount = await row<{ name: string; source: string; last_synced_at: string | null }>(
          ctx, 'bank_accounts', bankAccountId, 'name, source, last_synced_at', 'Bankrekening');
        if (bankAccount.source === 'import') {
          throw new ActionError(`${bankAccount.name} wordt met afschriften gevoed en heeft geen bankkoppeling om te synchroniseren.`);
        }
        return {
          title: `Transacties ophalen bij de bank: ${bankAccount.name}`,
          sub: joinShort([bankAccount.last_synced_at ? `laatst gesynct ${bankAccount.last_synced_at.slice(0, 10)}` : 'nog niet eerder gesynct', 'bankregels met automatisch boeken kunnen meteen boeken'], 140),
          ...autoRisk,
          kind: 'money',
          payload: { bank_account_id: bankAccountId, name: bankAccount.name },
        };
      }
      const { data } = await orgQuery(ctx, 'bank_accounts', 'id, name, source').neq('source', 'import').eq('is_active', true);
      const linked: Array<{ name: string }> = (data ?? []) as Array<{ name: string }>;
      if (linked.length === 0) throw new ActionError('Er is geen bank gekoppeld; synchroniseren kan alleen bij een rekening met een PSD2-koppeling.');
      return {
        title: `Transacties ophalen bij ${linked.length} gekoppelde bankrekening${linked.length === 1 ? '' : 'en'}`,
        sub: joinShort([...linked.map((a) => a.name), 'bankregels met automatisch boeken kunnen meteen boeken'], 140),
        ...autoRisk,
        kind: 'money',
        payload: { bank_account_id: null, name: null },
      };
    },
  },

  {
    id: 'bank.rematch',
    label: 'Banktransacties opnieuw laten matchen',
    module: 'finance',
    kind: 'write',
    description:
      'Laat de matcher opnieuw over alle openstaande banktransacties lopen en stelt facturen of grootboekrekeningen voor. ' +
      'LET OP: bankregels waarbij "automatisch boeken" aanstaat, BOEKEN de gevonden transacties meteen in het grootboek — dat zijn definitieve boekingen die alleen met een tegenboeking terug te draaien zijn. Zonder zulke regels blijft het bij voorstellen.',
    keywords: ['matchen', 'opnieuw matchen', 'afletteren', 'voorstellen', 'bankregels', 'automatisch boeken'],
    input: { bank_account_id: { type: 'string', description: 'Beperk tot één bankrekening (optioneel).' } },
    async plan(ctx, input) {
      const bankAccountId = optId(input, 'bank_account_id');
      let scope = 'alle bankrekeningen';
      if (bankAccountId) {
        const bankAccount = await row<{ name: string }>(ctx, 'bank_accounts', bankAccountId, 'name', 'Bankrekening');
        scope = bankAccount.name;
      }
      let query = ctx.db.from('bank_transactions').select('id', { count: 'exact', head: true })
        .eq('organization_id', ctx.organizationId).in('status', ['unmatched', 'suggested']);
      if (bankAccountId) query = query.eq('bank_account_id', bankAccountId);
      const { count } = await query;
      const { data: autoRules } = await orgQuery(ctx, 'bank_rules', 'id, name').eq('auto_book', true).eq('is_active', true);
      const auto: Array<{ name: string }> = (autoRules ?? []) as Array<{ name: string }>;

      return {
        title: `Openstaande banktransacties opnieuw matchen (${scope})`,
        sub: joinShort([
          `${Number(count ?? 0)} openstaande transacties`,
          auto.length > 0
            ? `${auto.length} regel${auto.length === 1 ? '' : 's'} met automatisch boeken: ${auto.map((r) => r.name).join(', ')}`
            : 'geen regels met automatisch boeken: het blijft bij voorstellen',
        ], 200),
        // Zonder auto-boekregels is dit ongevaarlijk; mét zulke regels ontstaan er
        // meteen definitieve boekingen, en dat hoort een zwaardere knop te krijgen.
        risk: auto.length > 0 ? 'high' : 'normal',
        warning: auto.length > 0
          ? 'Die regels boeken de gevonden transacties meteen definitief in het grootboek; terugdraaien kan alleen met een tegenboeking.'
          : undefined,
        kind: 'money',
        payload: { bank_account_id: bankAccountId, scope },
      };
    },
  },

  {
    id: 'bank_transaction.book',
    label: 'Banktransactie boeken op een factuur, creditnota, inkoopfactuur of grootboekrekening (ook verdeeld)',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Letter een banktransactie af en boek hem in het grootboek. Drie manieren: `purchase` tegen één geboekte inkoopfactuur, `account` rechtstreeks op één grootboekrekening met optionele btw-code (bankkosten, btw-afdracht, rente), of `split`: een VERDELING over meerdere regels die samen precies het bedrag dekken. ' +
      'Een regel van een verdeling is een verkoopfactuur (`sales_invoice`, alleen bij geld dat binnenkomt), een creditnota die je aan de klant terugbetaalt (`sales_credit_note`, alleen bij geld dat weggaat), een inkoopfactuur (`purchase_invoice`; een creditnota van de leverancier telt negatief) of een grootboekrekening (`ledger`, met btw-code). ' +
      'Bedragen in euro\'s in de richting van het geld: positief = mee met het geld (bij een betaling: wat je betaalt), negatief = de andere kant op (kosten die van een uitbetaling zijn afgehouden). Hoeveel er per stuk openstaat, zie je met `bank_transaction.candidates`; meer dan dat weigert de database. ' +
      'Met `description` geef je de boeking een eigen omschrijving. Voor één BINNENGEKOMEN betaling op één verkoopfactuur kan ook `invoice.reconcile_bank_transaction`. ' +
      'Zoek de transactie met `list_bank_transactions`. DIT IS EEN DEFINITIEVE GROOTBOEKBOEKING; terugdraaien kan alleen met `bank_transaction.unbook`, dat een tegenboeking maakt.',
    keywords: ['afletteren', 'banktransactie boeken', 'betaling koppelen', 'inkoopfactuur betaald', 'bankkosten', 'grootboekrekening', 'btw-afdracht',
      'verdelen', 'splitsen', 'meerdere stukken', 'verzamelbetaling', 'terugbetaling', 'creditnota', 'uitbetaling', 'omschrijving'],
    input: {
      transaction_id: { type: 'string', description: 'Id van de banktransactie (uit list_bank_transactions).' },
      mode: { type: 'string', enum: ['purchase', 'account', 'split'], description: 'purchase = één inkoopfactuur, account = één grootboekrekening, split = een verdeling (allocations).' },
      purchase_invoice_id: { type: 'string', description: 'Bij mode purchase: de inkoopfactuur.' },
      account_id: { type: 'string', description: 'Bij mode account: de grootboekrekening.' },
      vat_code: { type: 'string', description: 'Bij mode account: btw-code, of weglaten voor geen btw.' },
      allocations: {
        type: 'array',
        description: 'Bij mode split: de regels; samen precies het bedrag van de transactie.',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['sales_invoice', 'sales_credit_note', 'purchase_invoice', 'ledger'] },
            document_id: { type: 'string', description: 'Het id van de factuur, creditnota of inkoopfactuur (niet bij ledger).' },
            account_id: { type: 'string', description: 'Bij ledger: de grootboekrekening.' },
            vat_code: { type: 'string', description: 'Bij ledger: btw-code (optioneel).' },
            client_id: { type: 'string', description: 'Bij ledger op debiteuren: de klant (optioneel).' },
            supplier_id: { type: 'string', description: 'Bij ledger op crediteuren: de leverancier (optioneel).' },
            amount_eur: { type: 'number', description: 'Bedrag in euro\'s, in de richting van het geld (negatief = de andere kant op).' },
            description: { type: 'string', description: 'Omschrijving van deze regel (optioneel).' },
          },
          required: ['kind', 'amount_eur'],
        },
      },
      description: { type: 'string', description: 'Eigen omschrijving van de boeking (optioneel, hoogstens 300 tekens).' },
    },
    required: ['transaction_id', 'mode'],
    async plan(ctx, input) {
      const transactionId = id(input, 'transaction_id');
      const mode = choice(input, 'mode', ['purchase', 'account', 'split'] as const);
      const txn = await row<{ booking_date: string; amount_cents: number; counterparty_name: string | null; description: string | null; status: string; is_manual: boolean | null }>(
        ctx, 'bank_transactions', transactionId, 'booking_date, amount_cents, counterparty_name, description, status, is_manual', 'Banktransactie');
      if (txn.status === 'booked') throw new ActionError('Deze transactie is al geboekt. Draai hem eerst terug met `bank_transaction.unbook` als hij anders moet.');
      if (txn.status === 'merged') throw new ActionError('Deze bankregel is samengevoegd met een handmatige mutatie; die draagt de boeking. Boek de handmatige mutatie (zie `list_bank_transactions`), of maak het samenvoegen los met `bank_transaction.unmerge`.');
      const incoming = txn.amount_cents > 0;
      const abs = Math.abs(txn.amount_cents);
      const label = txn.counterparty_name || txn.description || 'Banktransactie';
      const description = optStr(input, 'description', 300);

      const payload: Record<string, unknown> = { transaction_id: transactionId, mode, label, amount_cents: abs, description };
      let target = '';

      if (mode === 'purchase') {
        if (incoming) throw new ActionError('Een ontvangst letter je niet af tegen een inkoopfactuur; kies `account`, `split`, of `invoice.reconcile_bank_transaction` voor een verkoopfactuur.');
        const purchaseId = id(input, 'purchase_invoice_id');
        const purchase = await row<{ internal_number: string | null; supplier_invoice_number: string | null; status: string; total_cents: number; journal_entry_id: string | null }>(
          ctx, 'purchase_invoices', purchaseId, 'internal_number, supplier_invoice_number, status, total_cents, journal_entry_id', 'Inkoopfactuur');
        if (!purchase.journal_entry_id) throw new ActionError('Die inkoopfactuur staat nog niet in het grootboek. Boek hem eerst met `purchase_invoice.book`.');
        if (purchase.status === 'cancelled') throw new ActionError('Die inkoopfactuur is geannuleerd.');
        const number = purchase.internal_number ?? purchase.supplier_invoice_number ?? purchaseId.slice(0, 8);
        payload.purchase_invoice_id = purchaseId;
        payload.target = `inkoopfactuur ${number}`;
        target = `inkoopfactuur ${number} (${euroCents(purchase.total_cents)})`;
      } else if (mode === 'account') {
        const accountId = id(input, 'account_id');
        const account = await loadAccount(ctx, accountId);
        if (!account.is_active) throw new ActionError(`${accountLabel(account)} staat op inactief.`);
        const vatCode = optStr(input, 'vat_code', 40);
        if (vatCode) await loadVatCode(ctx, vatCode);
        payload.line = { account_id: accountId, amount_cents: abs, vat_code: vatCode, description: label };
        payload.target = accountLabel(account);
        target = joinShort([accountLabel(account), vatCode ? `btw ${vatCode}` : 'geen btw'], 60);
      } else {
        // Een verdeling. De database rekent alles na (openstaand per stuk, de
        // kant van het geld, btw); hier wat het model zelf kan verbeteren, en
        // een kaart die zegt wát er per regel gebeurt.
        const raw = Array.isArray(input.allocations) ? input.allocations as Array<Record<string, unknown>> : [];
        if (raw.length === 0) throw new ActionError('Bij mode split hoort "allocations" met minstens één regel.');
        if (raw.length > 100) throw new ActionError('Een verdeling heeft hoogstens 100 regels.');
        const allocations: Array<Record<string, unknown>> = [];
        const described: string[] = [];
        let sum = 0;
        for (const [index, line] of raw.entries()) {
          const nr = `Regel ${index + 1}`;
          const kind = choice(line, 'kind', ['sales_invoice', 'sales_credit_note', 'purchase_invoice', 'ledger'] as const);
          const cents = Math.round(num(line, 'amount_eur') * 100);
          if (cents === 0) throw new ActionError(`${nr}: een bedrag van € 0,00 kan niet.`);
          sum += cents;
          const lineDescription = optStr(line, 'description', 300);
          const signed = cents * (incoming ? 1 : -1);  // bankrichting: + geld erbij
          if (kind === 'sales_invoice') {
            if (signed <= 0) throw new ActionError(`${nr}: een verkoopfactuur hoort bij geld dat binnenkomt. Een terugbetaling koppel je aan de creditnota (sales_credit_note).`);
            const docId = id(line, 'document_id');
            const invoice = await row<{ number: string; status: string; journal_entry_id: string | null }>(ctx, 'invoices', docId, 'number, status, journal_entry_id', 'Verkoopfactuur');
            if (!invoice.journal_entry_id) throw new ActionError(`${nr}: factuur ${invoice.number} staat nog niet in het grootboek; boek hem eerst met \`invoice.post_to_ledger\`.`);
            allocations.push({ kind, invoice_id: docId, amount_cents: cents, description: lineDescription });
            described.push(`factuur ${invoice.number} ${euroCents(cents)}`);
          } else if (kind === 'sales_credit_note') {
            if (signed >= 0) throw new ActionError(`${nr}: een creditnota betaal je terug; dat hoort bij geld dat van je rekening gaat.`);
            const docId = id(line, 'document_id');
            const note = await row<{ number: string; status: string; journal_entry_id: string | null }>(ctx, 'credit_notes', docId, 'number, status, journal_entry_id', 'Creditnota');
            if (note.status !== 'issued' || !note.journal_entry_id) throw new ActionError(`${nr}: creditnota ${note.number} is niet uitgegeven en geboekt.`);
            allocations.push({ kind, credit_note_id: docId, amount_cents: cents, description: lineDescription });
            described.push(`terugbetaling creditnota ${note.number} ${euroCents(cents)}`);
          } else if (kind === 'purchase_invoice') {
            const docId = id(line, 'document_id');
            const purchase = await row<{ internal_number: string | null; supplier_invoice_number: string | null; status: string; journal_entry_id: string | null }>(
              ctx, 'purchase_invoices', docId, 'internal_number, supplier_invoice_number, status, journal_entry_id', 'Inkoopfactuur');
            if (!purchase.journal_entry_id) throw new ActionError(`${nr}: die inkoopfactuur staat nog niet in het grootboek. Boek hem eerst met \`purchase_invoice.book\`.`);
            if (purchase.status === 'cancelled') throw new ActionError(`${nr}: die inkoopfactuur is geannuleerd.`);
            allocations.push({ kind, purchase_invoice_id: docId, amount_cents: cents, description: lineDescription });
            described.push(`inkoopfactuur ${purchase.internal_number ?? purchase.supplier_invoice_number ?? docId.slice(0, 8)} ${euroCents(cents)}`);
          } else {
            const accountId = id(line, 'account_id');
            const account = await loadAccount(ctx, accountId);
            if (!account.is_active) throw new ActionError(`${nr}: ${accountLabel(account)} staat op inactief.`);
            const vatCode = optStr(line, 'vat_code', 40);
            if (vatCode) await loadVatCode(ctx, vatCode);
            const entry: Record<string, unknown> = { kind, account_id: accountId, vat_code: vatCode, amount_cents: cents, description: lineDescription };
            const clientId = optId(line, 'client_id');
            if (clientId) {
              if (account.subtype !== 'accounts_receivable' && account.type !== 'revenue') throw new ActionError(`${nr}: een klant hoort op een debiteuren- of omzetrekening; ${accountLabel(account)} is dat niet.`);
              await row<{ name: string }>(ctx, 'clients', clientId, 'name', 'Klant');
              entry.client_id = clientId;
            }
            const supplierId = optId(line, 'supplier_id');
            if (supplierId) {
              if (account.subtype !== 'accounts_payable') throw new ActionError(`${nr}: een leverancier hoort op een crediteurenrekening; ${accountLabel(account)} is dat niet.`);
              await row<{ name: string }>(ctx, 'suppliers', supplierId, 'name', 'Leverancier');
              entry.supplier_id = supplierId;
            }
            allocations.push(entry);
            described.push(`${accountLabel(account)}${vatCode ? ` (${vatCode})` : ''} ${euroCents(cents)}`);
          }
        }
        if (sum !== abs) {
          throw new ActionError(`De regels tellen op tot ${euroCents(sum)}, maar de transactie is ${euroCents(abs)}. Verdeel precies het hele bedrag (verschil ${euroCents(Math.abs(abs - sum))}).`);
        }
        payload.allocations = allocations;
        payload.target = `${allocations.length} regels`;
        target = described.join(', ');
      }

      return {
        title: `${incoming ? 'Ontvangst' : 'Betaling'} van ${euroCents(abs)} boeken: ${label}`,
        sub: joinShort([`${txn.booking_date}`, `tegen ${target}`, description ? `"${description}"` : null], 220),
        warning: 'Dit is een definitieve grootboekboeking. Terugdraaien kan alleen met een tegenboeking.',
        kind: 'money',
        payload,
      };
    },
  },

  {
    id: 'bank_transaction.candidates',
    label: 'Waartegen kun je een bankmutatie afletteren',
    module: 'finance',
    kind: 'read',
    description:
      'Wat er openstaat om tegen af te letteren, met het bedrag dat de database ook rekent: verkoopfacturen (nog te ontvangen), creditnota\'s waarvan de klant nog geld terugkrijgt, en inkoopfacturen (nog te betalen; negatief = de leverancier moet nog terugbetalen). ' +
      'Gebruik dit vóór `bank_transaction.book` met mode split, zodat de bedragen per regel kloppen.',
    // Bewust zonder "openstaand" en "facturen": die vragen horen bij
    // ledger.open_items (de openstaande posten), niet hier.
    keywords: ['afletteren', 'tegen afletteren', 'verdelen', 'creditnota terugbetalen', 'verzamelbetaling', 'kandidaten', 'restbedrag'],
    input: {},
    async read(ctx) {
      const result = await rpc<Record<string, unknown>>(ctx, 'bank_allocation_candidates', {}, 'Openstaande stukken ophalen');
      const cents = (rows: unknown) => (Array.isArray(rows) ? rows : []).map((r) => {
        const rowData = r as Record<string, unknown>;
        return { ...rowData, open_eur: Number(rowData.open_cents ?? 0) / 100, total_eur: Number(rowData.total_cents ?? 0) / 100 };
      });
      return {
        sales_invoices: cents(result.sales_invoices),
        credit_notes: cents(result.credit_notes),
        purchase_invoices: cents(result.purchase_invoices),
      };
    },
  },

  {
    id: 'bank_transaction.create_manual',
    label: 'Bankmutatie met de hand invoeren',
    module: 'finance',
    kind: 'write',
    description:
      'Voert een bankmutatie in die (nog) niet via een afschrift of de bankkoppeling binnenkwam: een contante storting, een rekening zonder export, of een betaling waar je niet op wilt wachten. Er wordt nog NIETS geboekt; daarna boek je hem met `bank_transaction.book`. ' +
      'Komt dezelfde mutatie later van de bank, dan voegt de matcher hem vanzelf samen met deze (zelfde rekening en bedrag, binnen een week). ' +
      'Staat er al een mutatie met hetzelfde bedrag binnen een week, dan weigert dit; vraag de gebruiker of het echt een andere is en zet dan `allow_duplicate` op true.',
    keywords: ['handmatig', 'mutatie invoeren', 'bankmutatie', 'contant', 'storting', 'zelf invoeren', 'transactie toevoegen', 'kas'],
    input: {
      bank_account_id: { type: 'string', description: 'De bankrekening (uit bank_account.list).' },
      date: { type: 'string', description: 'Datum van de mutatie, JJJJ-MM-DD.' },
      direction: { type: 'string', enum: ['in', 'out'], description: 'in = geld erbij (ontvangst), out = geld eraf (betaling).' },
      amount_eur: { type: 'number', description: 'Bedrag in euro\'s, positief.' },
      counterparty_name: { type: 'string', description: 'Van of aan wie.' },
      counterparty_iban: { type: 'string', description: 'IBAN van de tegenpartij (optioneel).' },
      description: { type: 'string', description: 'Omschrijving; noem het factuurnummer, dan stelt ResoFly de factuur voor.' },
      allow_duplicate: { type: 'boolean', description: 'Alleen als de gebruiker bevestigde dat een gelijke mutatie in dezelfde week echt een andere is.' },
    },
    required: ['bank_account_id', 'date', 'direction', 'amount_eur'],
    async plan(ctx, input) {
      const bankAccountId = id(input, 'bank_account_id');
      const date = isoDate(input, 'date');
      const direction = choice(input, 'direction', ['in', 'out'] as const);
      const amount = cents(input, 'amount_eur');
      if (amount <= 0) throw new ActionError('"amount_eur" moet positief zijn; de richting zit in "direction".');
      const counterparty = optStr(input, 'counterparty_name', 200);
      const description = optStr(input, 'description', 1000);
      if (!counterparty && !description) throw new ActionError('Geef een tegenpartij of een omschrijving.');
      const iban = optStr(input, 'counterparty_iban', 40)?.replace(/\s/g, '').toUpperCase() ?? null;
      if (iban && !/^[A-Z]{2}[0-9]{2}[A-Z0-9]{8,30}$/.test(iban)) throw new ActionError(`IBAN ${iban} klopt niet; laat het weg als je het niet weet.`);
      const allowDuplicate = bool(input, 'allow_duplicate');
      const account = await row<{ name: string; is_active: boolean }>(ctx, 'bank_accounts', bankAccountId, 'name, is_active', 'Bankrekening');
      if (!account.is_active) throw new ActionError(`Bankrekening ${account.name} staat op inactief.`);
      const signed = direction === 'in' ? amount : -amount;

      // Dezelfde vraag als het scherm: staat hij er al? Dan niet stil een tweede.
      const from = new Date(Date.parse(`${date}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
      const to = new Date(Date.parse(`${date}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
      const { data: same } = await orgQuery(ctx, 'bank_transactions', 'booking_date, counterparty_name, description, status, is_manual')
        .eq('bank_account_id', bankAccountId).eq('amount_cents', signed).neq('status', 'merged')
        .gte('booking_date', from).lte('booking_date', to).limit(3);
      const existing = (same ?? []) as Array<{ booking_date: string; counterparty_name: string | null; description: string | null; is_manual: boolean | null }>;
      if (existing.length > 0 && !allowDuplicate) {
        const first = existing[0];
        throw new ActionError(`Lijkt dubbel: op ${first.booking_date} staat al ${euroCents(amount)} (${first.counterparty_name || first.description || 'zonder omschrijving'}, ${first.is_manual ? 'handmatig' : 'van de bank'}). Vraag de gebruiker of dit een andere mutatie is; zo ja, zet "allow_duplicate" op true.`);
      }

      return {
        title: `Bankmutatie invoeren: ${direction === 'in' ? 'ontvangst' : 'betaling'} van ${euroCents(amount)}`,
        sub: joinShort([account.name, date, counterparty, description], 200),
        warning: existing.length > 0 ? `Op dezelfde rekening staat binnen een week al een mutatie van ${euroCents(amount)}; dit wordt een tweede.` : undefined,
        kind: 'money',
        payload: {
          bank_account_id: bankAccountId, date, amount_cents: signed, counterparty_name: counterparty, counterparty_iban: iban,
          description, allow_duplicate: existing.length > 0 && allowDuplicate, account_name: account.name,
        },
      };
    },
  },

  {
    id: 'bank_transaction.update_manual',
    label: 'Handmatige bankmutatie aanpassen',
    module: 'finance',
    kind: 'write',
    description:
      'Past datum, bedrag, tegenpartij of omschrijving aan van een mutatie die met de hand is ingevoerd, zolang hij niet geboekt is en de bank hem niet bevestigde. Een geboekte mutatie draai je eerst terug (`bank_transaction.unbook`); wat van de bank komt, pas je niet aan.',
    keywords: ['handmatige mutatie', 'aanpassen', 'bewerken', 'datum wijzigen', 'bedrag wijzigen', 'bankmutatie'],
    input: {
      transaction_id: { type: 'string' },
      date: { type: 'string', description: 'Datum JJJJ-MM-DD (weglaten = blijft).' },
      amount_eur: { type: 'number', description: 'Bedrag in euro\'s, positief (weglaten = blijft).' },
      direction: { type: 'string', enum: ['in', 'out'], description: 'Weglaten = blijft.' },
      counterparty_name: { type: 'string' },
      counterparty_iban: { type: 'string' },
      description: { type: 'string' },
    },
    required: ['transaction_id'],
    async plan(ctx, input) {
      const transactionId = id(input, 'transaction_id');
      const txn = await row<{ booking_date: string; amount_cents: number; counterparty_name: string | null; counterparty_iban: string | null; description: string | null; status: string; is_manual: boolean | null }>(
        ctx, 'bank_transactions', transactionId, 'booking_date, amount_cents, counterparty_name, counterparty_iban, description, status, is_manual', 'Banktransactie');
      if (!txn.is_manual) throw new ActionError('Alleen een handmatige mutatie pas je aan; wat van de bank komt, blijft zoals de bank het gaf.');
      if (txn.status === 'booked') throw new ActionError('Deze mutatie is geboekt; draai hem eerst terug met `bank_transaction.unbook`.');
      const { data: partner } = await orgQuery(ctx, 'bank_transactions', 'id').eq('merged_into_id', transactionId).maybeSingle();
      if (partner) throw new ActionError('Deze mutatie is al bevestigd door de bank; maak het samenvoegen eerst los met `bank_transaction.unmerge`.');
      const date = optIsoDate(input, 'date') ?? txn.booking_date;
      const amountInput = optNum(input, 'amount_eur');
      const abs = amountInput === null ? Math.abs(txn.amount_cents) : Math.round(amountInput * 100);
      if (abs <= 0) throw new ActionError('"amount_eur" moet positief zijn; de richting zit in "direction".');
      const direction = optChoice(input, 'direction', ['in', 'out'] as const) ?? (txn.amount_cents < 0 ? 'out' : 'in');
      const has = (key: string) => input[key] !== undefined;
      const counterparty = has('counterparty_name') ? optStr(input, 'counterparty_name', 200) : txn.counterparty_name;
      const iban = has('counterparty_iban') ? (optStr(input, 'counterparty_iban', 40)?.replace(/\s/g, '').toUpperCase() ?? null) : txn.counterparty_iban;
      const description = has('description') ? optStr(input, 'description', 1000) : txn.description;
      if (!counterparty && !description) throw new ActionError('Geef een tegenpartij of een omschrijving.');
      const signed = direction === 'in' ? abs : -abs;
      return {
        title: `Handmatige mutatie aanpassen: ${counterparty || description || 'mutatie'}`,
        sub: joinShort([`${txn.booking_date} → ${date}`, `${euroCents(txn.amount_cents)} → ${euroCents(signed)}`, description], 200),
        kind: 'money',
        payload: { transaction_id: transactionId, date, amount_cents: signed, counterparty_name: counterparty, counterparty_iban: iban, description },
      };
    },
  },

  {
    id: 'bank_transaction.delete_manual',
    label: 'Handmatige bankmutatie verwijderen',
    module: 'finance',
    kind: 'write',
    description:
      'Verwijdert een mutatie die met de hand is ingevoerd en nooit geboekt is (een tikfout, of dubbel ingevoerd). Is hij ooit geboekt en teruggedraaid, dan blijft hij bewaard; negeer hem dan met `bank_transaction.set_status`. Wat van de bank komt, verwijder je niet.',
    keywords: ['handmatige mutatie', 'verwijderen', 'weghalen', 'dubbel ingevoerd', 'bankmutatie'],
    input: { transaction_id: { type: 'string' } },
    required: ['transaction_id'],
    async plan(ctx, input) {
      const transactionId = id(input, 'transaction_id');
      const txn = await row<{ booking_date: string; amount_cents: number; counterparty_name: string | null; description: string | null; status: string; is_manual: boolean | null }>(
        ctx, 'bank_transactions', transactionId, 'booking_date, amount_cents, counterparty_name, description, status, is_manual', 'Banktransactie');
      if (!txn.is_manual) throw new ActionError('Alleen een handmatige mutatie kun je verwijderen. Wat van de bank komt, blijft staan; negeer hem als hij niet meetelt.');
      if (txn.status === 'booked') throw new ActionError('Deze mutatie is geboekt. Draai hem eerst terug met `bank_transaction.unbook`.');
      const label = txn.counterparty_name || txn.description || 'Handmatige mutatie';
      return {
        title: `Handmatige mutatie verwijderen: ${label}`,
        sub: joinShort([txn.booking_date, euroCents(txn.amount_cents)], 120),
        kind: 'money',
        payload: { transaction_id: transactionId, label },
      };
    },
  },

  {
    id: 'bank_transaction.merge',
    label: 'Bankregel samenvoegen met een handmatige mutatie',
    module: 'finance',
    kind: 'write',
    description:
      'Een transactie van de bank (afschrift of koppeling) is dezelfde als een mutatie die met de hand is ingevoerd: voeg ze samen, zodat het geld er één keer staat. De handmatige mutatie houdt de boeking. Doet de matcher vanzelf bij één duidelijke kandidaat; dit is voor de twijfelgevallen (twee kandidaten, ander IBAN, verder uit elkaar). Rekening en bedrag moeten gelijk zijn.',
    keywords: ['samenvoegen', 'dubbel', 'handmatige mutatie', 'bevestigen', 'bankregel', 'koppelen aan handmatig'],
    input: {
      transaction_id: { type: 'string', description: 'De transactie van de bank.' },
      manual_transaction_id: { type: 'string', description: 'De handmatig ingevoerde mutatie.' },
    },
    required: ['transaction_id', 'manual_transaction_id'],
    async plan(ctx, input) {
      const bankId = id(input, 'transaction_id');
      const manualId = id(input, 'manual_transaction_id');
      type Txn = { bank_account_id: string; booking_date: string; amount_cents: number; counterparty_name: string | null; description: string | null; status: string; is_manual: boolean | null };
      const cols = 'bank_account_id, booking_date, amount_cents, counterparty_name, description, status, is_manual';
      const bank = await row<Txn>(ctx, 'bank_transactions', bankId, cols, 'Banktransactie');
      const manual = await row<Txn>(ctx, 'bank_transactions', manualId, cols, 'Handmatige mutatie');
      if (bank.is_manual) throw new ActionError('"transaction_id" is zelf een handmatige mutatie; geef de transactie van de bank.');
      if (!manual.is_manual) throw new ActionError('"manual_transaction_id" komt van de bank; samenvoegen gaat met een mutatie die met de hand is ingevoerd.');
      if (bank.status === 'booked') throw new ActionError('Die banktransactie is al geboekt. Draai hem eerst terug, of laat de handmatige mutatie vallen.');
      if (bank.status === 'merged') throw new ActionError('Die banktransactie is al samengevoegd.');
      if (bank.bank_account_id !== manual.bank_account_id) throw new ActionError('De twee staan op verschillende bankrekeningen.');
      if (bank.amount_cents !== manual.amount_cents) throw new ActionError(`De bedragen verschillen (${euroCents(bank.amount_cents)} bij de bank, ${euroCents(manual.amount_cents)} handmatig). Pas de handmatige mutatie eerst aan.`);
      return {
        title: `Samenvoegen: ${euroCents(bank.amount_cents)} van de bank met je handmatige mutatie`,
        sub: joinShort([`bank ${bank.booking_date}: ${bank.description || bank.counterparty_name || '—'}`, `handmatig ${manual.booking_date}: ${manual.counterparty_name || manual.description || '—'}`], 200),
        kind: 'money',
        payload: { transaction_id: bankId, manual_transaction_id: manualId },
      };
    },
  },

  {
    id: 'bank_transaction.unmerge',
    label: 'Samenvoegen met een handmatige mutatie ongedaan maken',
    module: 'finance',
    kind: 'write',
    description:
      'Maakt een bankregel los van de handmatige mutatie waarmee hij is samengevoegd. Daarna staat de bankregel apart open en voegt de matcher hem niet meer vanzelf samen. Is de handmatige mutatie al geboekt, boek de bankregel dan niet nog eens (dan staat het geld er twee keer).',
    keywords: ['losmaken', 'samenvoegen ongedaan maken', 'loskoppelen', 'handmatige mutatie', 'bankregel'],
    input: { transaction_id: { type: 'string', description: 'De bankregel of de handmatige mutatie.' } },
    required: ['transaction_id'],
    async plan(ctx, input) {
      const transactionId = id(input, 'transaction_id');
      const txn = await row<{ booking_date: string; amount_cents: number; counterparty_name: string | null; description: string | null; status: string; is_manual: boolean | null }>(
        ctx, 'bank_transactions', transactionId, 'booking_date, amount_cents, counterparty_name, description, status, is_manual', 'Banktransactie');
      if (txn.is_manual) {
        const { data: partner } = await orgQuery(ctx, 'bank_transactions', 'id').eq('merged_into_id', transactionId).maybeSingle();
        if (!partner) throw new ActionError('Deze handmatige mutatie is niet samengevoegd met een bankregel.');
      } else if (txn.status !== 'merged') {
        throw new ActionError('Deze banktransactie is niet samengevoegd.');
      }
      return {
        title: `Samenvoegen ongedaan maken: ${txn.counterparty_name || txn.description || 'banktransactie'}`,
        sub: joinShort([txn.booking_date, euroCents(txn.amount_cents), txn.is_manual && txn.status === 'booked' ? 'de handmatige mutatie is al geboekt' : null], 160),
        warning: txn.is_manual && txn.status === 'booked' ? 'De bankregel komt apart open te staan; boek hem niet nog eens, anders staat het geld er twee keer.' : undefined,
        kind: 'money',
        payload: { transaction_id: transactionId },
      };
    },
  },

  {
    id: 'bank_transaction.set_status',
    label: 'Banktransactie negeren of weer openzetten',
    module: 'finance',
    kind: 'write',
    description:
      'Zet een openstaande banktransactie op "genegeerd" zodat hij uit de af-te-letteren-lijst verdwijnt, of zet een genegeerde transactie juist terug op openstaand. Er wordt niets geboekt. ' +
      'Let op: een genegeerde transactie staat wél op het afschrift en telt dus gewoon mee in de saldo-aansluiting — negeren verbergt hem, het laat hem niet verdwijnen.',
    keywords: ['negeren', 'genegeerd', 'weer openen', 'banktransactie', 'af te letteren', 'verbergen'],
    input: {
      transaction_id: { type: 'string' },
      status: { type: 'string', enum: ['ignored', 'unmatched'], description: 'ignored = negeren, unmatched = terugzetten op openstaand.' },
    },
    required: ['transaction_id', 'status'],
    async plan(ctx, input) {
      const transactionId = id(input, 'transaction_id');
      const status = choice(input, 'status', ['ignored', 'unmatched'] as const);
      const txn = await row<{ booking_date: string; amount_cents: number; counterparty_name: string | null; description: string | null; status: string }>(
        ctx, 'bank_transactions', transactionId, 'booking_date, amount_cents, counterparty_name, description, status', 'Banktransactie');
      if (txn.status === 'booked') throw new ActionError('Deze transactie is geboekt; draai hem eerst terug met `bank_transaction.unbook`.');
      if (txn.status === 'merged') throw new ActionError('Deze bankregel is samengevoegd met een handmatige mutatie; maak dat eerst los met `bank_transaction.unmerge`.');
      if (txn.status === status) throw new ActionError(`Deze transactie staat al op "${status}".`);
      const label = txn.counterparty_name || txn.description || 'Banktransactie';
      return {
        title: status === 'ignored' ? `Banktransactie negeren: ${label}` : `Banktransactie weer openzetten: ${label}`,
        sub: joinShort([txn.booking_date, euroCents(Math.abs(txn.amount_cents)), status === 'ignored' ? 'telt nog steeds mee in de saldo-aansluiting' : 'komt terug in de af-te-letteren-lijst'], 140),
        kind: 'work',
        payload: { transaction_id: transactionId, status, label },
      };
    },
  },

  {
    id: 'bank_transaction.unbook',
    label: 'Geboekte banktransactie terugdraaien',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Draait een geboekte banktransactie terug: er komt een TEGENBOEKING in het grootboek en de transactie staat weer open om opnieuw af te letteren. ' +
      'De oorspronkelijke boeking blijft staan — het paar telt netto op tot nul. De tegenboeking is zelf definitief en niet ongedaan te maken; in een afgesloten periode lukt terugdraaien niet.',
    keywords: ['terugdraaien', 'unbook', 'tegenboeking', 'verkeerd geboekt', 'banktransactie'],
    input: { transaction_id: { type: 'string' } },
    required: ['transaction_id'],
    async plan(ctx, input) {
      const transactionId = id(input, 'transaction_id');
      const txn = await row<{ booking_date: string; amount_cents: number; counterparty_name: string | null; description: string | null; status: string }>(
        ctx, 'bank_transactions', transactionId, 'booking_date, amount_cents, counterparty_name, description, status', 'Banktransactie');
      if (txn.status !== 'booked') throw new ActionError(`Deze transactie staat op "${txn.status}" en is dus niet geboekt.`);
      const label = txn.counterparty_name || txn.description || 'Banktransactie';
      return {
        title: `Geboekte banktransactie terugdraaien: ${label}`,
        sub: joinShort([txn.booking_date, euroCents(Math.abs(txn.amount_cents)), 'de transactie komt weer op de af-te-letteren-lijst'], 150),
        warning: 'Er komt een tegenboeking in het grootboek. Die is zelf definitief; de oorspronkelijke boeking blijft staan.',
        kind: 'money',
        payload: { transaction_id: transactionId, label },
      };
    },
  },

  // ── Bankregels ────────────────────────────────────────────────────────────
  {
    id: 'bank_rule.list',
    label: 'Bankregels bekijken',
    module: 'finance',
    kind: 'read',
    description:
      'Geeft de herkenningsregels voor de bank: naam, prioriteit, richting, de voorwaarden (IBAN, naam, omschrijving, exact bedrag), de grootboekrekening en btw-code waarop geboekt wordt, en of "automatisch boeken" aanstaat. ' +
      'Gebruik dit om het id te vinden voordat je een regel bijwerkt of uitzet, en om te zien welke regels zonder tussenkomst boeken.',
    keywords: ['bankregel', 'regels', 'herkenning', 'automatisch boeken', 'bankkosten', 'prioriteit'],
    input: { include_inactive: { type: 'boolean', description: 'Ook regels die uitstaan.' } },
    async read(ctx, input) {
      let query = orgQuery(ctx, 'bank_rules',
        'id, name, priority, match_direction, match_counterparty_iban, match_counterparty_name_contains, match_description_contains, match_amount_cents, target_account_id, target_vat_code, auto_book, is_active')
        .order('priority', { ascending: true }).limit(200);
      if (!bool(input, 'include_inactive', false)) query = query.eq('is_active', true);
      const { data, error } = await query;
      if (error) throw new ActionError(`Bankregels ophalen mislukt: ${error.message}`);
      return { bank_rules: data ?? [] };
    },
  },

  {
    id: 'bank_rule.create',
    label: 'Bankregel aanmaken',
    module: 'finance',
    kind: 'write',
    description:
      'Legt een herkenningsregel vast: voldoet een banktransactie aan de voorwaarden (IBAN, naam bevat, omschrijving bevat, exact bedrag), dan wordt de gekozen grootboekrekening en btw-code voorgesteld. Lagere prioriteit gaat vóór. ' +
      'Zet `auto_book` alleen aan als je zeker weet dat de regel nauw genoeg is: dan worden toekomstige transacties die eraan voldoen ZONDER TUSSENKOMST in het grootboek geboekt, en zulke boekingen zijn alleen met een tegenboeking terug te draaien. ' +
      'Geef minstens één voorwaarde — een regel zonder voorwaarden zou op alles matchen.',
    keywords: ['bankregel aanmaken', 'herkenning', 'automatisch boeken', 'bankkosten', 'regel'],
    input: {
      name: { type: 'string', description: 'Bijvoorbeeld "Bankkosten Rabobank".' },
      priority: { type: 'number', description: 'Lager gaat eerst; standaard 100.' },
      match_direction: { type: 'string', enum: ['in', 'out', 'both'], description: 'in = alleen ontvangsten, out = alleen betalingen, both = beide (standaard).' },
      match_counterparty_iban: { type: 'string', description: 'Tegenrekening moet exact dit IBAN zijn.' },
      match_counterparty_name_contains: { type: 'string', description: 'Naam van de tegenpartij bevat deze tekst.' },
      match_description_contains: { type: 'string', description: 'Omschrijving bevat deze tekst.' },
      match_amount_eur: { type: 'number', description: 'Bedrag is exact dit bedrag in euro.' },
      target_account_id: { type: 'string', description: 'Grootboekrekening waarop geboekt wordt. Verplicht bij automatisch boeken.' },
      target_vat_code: { type: 'string', description: 'Btw-code (uit vat_code.list).' },
      auto_book: { type: 'boolean', description: 'Direct boeken zonder tussenkomst. Standaard uit.' },
      is_active: { type: 'boolean', description: 'Standaard aan.' },
    },
    required: ['name'],
    async plan(ctx, input) {
      const name = str(input, 'name', 120);
      const priority = Math.trunc(optNum(input, 'priority') ?? 100);
      const direction = optChoice(input, 'match_direction', ['in', 'out', 'both'] as const) ?? 'both';
      const iban = optStr(input, 'match_counterparty_iban', 40);
      const nameContains = optStr(input, 'match_counterparty_name_contains', 200);
      const descriptionContains = optStr(input, 'match_description_contains', 200);
      const amountCents = optCents(input, 'match_amount_eur');
      if (!iban && !nameContains && !descriptionContains && amountCents === null) {
        throw new ActionError('Geef minstens één voorwaarde (IBAN, naam bevat, omschrijving bevat of een exact bedrag); een regel zonder voorwaarden matcht op alles.');
      }
      const targetId = optId(input, 'target_account_id');
      const account = targetId ? await loadAccount(ctx, targetId) : null;
      const vatCode = optStr(input, 'target_vat_code', 40);
      if (vatCode) await loadVatCode(ctx, vatCode);
      const autoBook = bool(input, 'auto_book', false);
      if (autoBook && !account) throw new ActionError('Automatisch boeken vereist een grootboekrekening.');
      const active = bool(input, 'is_active', true);

      const conditions = [
        iban ? `IBAN ${iban}` : null,
        nameContains ? `naam bevat "${nameContains}"` : null,
        descriptionContains ? `omschrijving bevat "${descriptionContains}"` : null,
        amountCents !== null ? `bedrag ${euroCents(amountCents)}` : null,
      ];
      return {
        title: `Bankregel aanmaken: ${name}`,
        sub: joinShort([
          ...conditions,
          account ? `boekt op ${accountLabel(account)}` : 'nog geen doelrekening',
          autoBook ? 'automatisch boeken aan' : 'stelt alleen voor',
          active ? null : 'staat uit',
        ], 220),
        risk: autoBook ? 'high' : 'normal',
        warning: autoBook
          ? 'Met automatisch boeken worden toekomstige transacties die hieraan voldoen zonder tussenkomst in het grootboek geboekt.'
          : undefined,
        kind: 'work',
        payload: {
          name, priority, match_direction: direction,
          match_counterparty_iban: iban, match_counterparty_name_contains: nameContains,
          match_description_contains: descriptionContains, match_amount_cents: amountCents,
          target_account_id: targetId, target_vat_code: vatCode, auto_book: autoBook, is_active: active,
        },
      };
    },
  },

  {
    id: 'bank_rule.update',
    label: 'Bankregel bijwerken of uitzetten',
    module: 'finance',
    kind: 'write',
    description:
      'Past een bestaande bankregel aan: naam, prioriteit, richting, voorwaarden, doelrekening, btw-code, automatisch boeken of de actief-status. Op inactief zetten is de manier om een regel af te schaffen zonder hem te verwijderen. ' +
      'Zet je `auto_book` aan, dan worden voortaan alle passende transacties zonder tussenkomst geboekt. Zoek de regel met `bank_rule.list` en geef alleen wat verandert.',
    keywords: ['bankregel bewerken', 'regel uitzetten', 'automatisch boeken uit', 'prioriteit', 'voorwaarde'],
    input: {
      rule_id: { type: 'string' },
      name: { type: 'string' },
      priority: { type: 'number' },
      match_direction: { type: 'string', enum: ['in', 'out', 'both'] },
      match_counterparty_iban: { type: 'string' },
      match_counterparty_name_contains: { type: 'string' },
      match_description_contains: { type: 'string' },
      match_amount_eur: { type: 'number' },
      target_account_id: { type: 'string' },
      target_vat_code: { type: 'string' },
      auto_book: { type: 'boolean' },
      is_active: { type: 'boolean' },
    },
    required: ['rule_id'],
    async plan(ctx, input) {
      const ruleId = id(input, 'rule_id');
      const rule = await row<{
        name: string; auto_book: boolean; is_active: boolean; target_account_id: string | null;
        match_counterparty_iban: string | null; match_counterparty_name_contains: string | null;
        match_description_contains: string | null; match_amount_cents: number | null;
      }>(
        ctx, 'bank_rules', ruleId,
        'name, auto_book, is_active, target_account_id, match_counterparty_iban, match_counterparty_name_contains, match_description_contains, match_amount_cents',
        'Bankregel');
      const patch: Record<string, unknown> = {};
      const notes: string[] = [];

      const name = optStr(input, 'name', 120);
      if (name) patch.name = name;
      const priority = optNum(input, 'priority');
      if (priority !== null) patch.priority = Math.trunc(priority);
      const direction = optChoice(input, 'match_direction', ['in', 'out', 'both'] as const);
      if (direction) patch.match_direction = direction;
      if (input.match_counterparty_iban !== undefined) patch.match_counterparty_iban = optStr(input, 'match_counterparty_iban', 40);
      if (input.match_counterparty_name_contains !== undefined) patch.match_counterparty_name_contains = optStr(input, 'match_counterparty_name_contains', 200);
      if (input.match_description_contains !== undefined) patch.match_description_contains = optStr(input, 'match_description_contains', 200);
      if (input.match_amount_eur !== undefined) patch.match_amount_cents = optCents(input, 'match_amount_eur');
      if (input.target_account_id !== undefined) {
        const targetId = optId(input, 'target_account_id');
        if (targetId) {
          const account = await loadAccount(ctx, targetId);
          notes.push(`boekt op ${accountLabel(account)}`);
        }
        patch.target_account_id = targetId;
      }
      if (input.target_vat_code !== undefined) {
        const vatCode = optStr(input, 'target_vat_code', 40);
        if (vatCode) await loadVatCode(ctx, vatCode);
        patch.target_vat_code = vatCode;
      }
      if (typeof input.auto_book === 'boolean') {
        patch.auto_book = input.auto_book;
        notes.push(input.auto_book ? 'automatisch boeken aan' : 'automatisch boeken uit — de regel stelt voortaan alleen voor');
      }
      if (typeof input.is_active === 'boolean') {
        patch.is_active = input.is_active;
        notes.push(input.is_active ? 'staat weer aan' : 'staat uit');
      }
      const willAutoBook = typeof patch.auto_book === 'boolean' ? patch.auto_book : rule.auto_book;
      const willBeActive = typeof patch.is_active === 'boolean' ? patch.is_active : rule.is_active;
      const willHaveTarget = patch.target_account_id !== undefined ? patch.target_account_id : rule.target_account_id;
      if (willAutoBook && !willHaveTarget) throw new ActionError('Automatisch boeken vereist een grootboekrekening.');
      if (Object.keys(patch).length === 0) throw new ActionError('Geef minstens één veld dat moet veranderen.');

      // Dezelfde eis als bij aanmaken: zonder voorwaarden matcht een regel op
      // élke transactie (en met automatisch boeken boekt hij ze allemaal).
      const after = { ...rule, ...patch } as Record<string, unknown>;
      const hasCondition = ['match_counterparty_iban', 'match_counterparty_name_contains', 'match_description_contains']
        .some((key) => typeof after[key] === 'string' && String(after[key]).trim() !== '')
        || (after.match_amount_cents !== null && after.match_amount_cents !== undefined);
      if (!hasCondition) {
        throw new ActionError('Een bankregel houdt minstens één voorwaarde (IBAN, naam bevat, omschrijving bevat of een exact bedrag); zonder voorwaarden matcht hij op alles.');
      }

      // Hoog risico zodra de regel na de wijziging automatisch boekt en er iets
      // verandert aan wát hij boekt of wanneer: aanzetten, weer actief maken,
      // andere voorwaarden, rekening of btw-code. Alleen naam of prioriteit, of
      // iets uitzetten, is gewoon.
      const touchesBooking = Object.keys(patch).some((key) => !['name', 'priority'].includes(key));
      const autoBooksAfter = willAutoBook && willBeActive;
      const risky = autoBooksAfter && touchesBooking;
      return {
        title: `Bankregel bijwerken: ${rule.name}`,
        sub: joinShort([...Object.keys(patch), ...notes], 220),
        risk: risky ? 'high' : 'normal',
        warning: risky
          ? 'Deze regel boekt automatisch: transacties die na de wijziging aan de regel voldoen, worden zonder tussenkomst in het grootboek geboekt. Terugdraaien kan alleen met een tegenboeking.'
          : undefined,
        kind: 'work',
        payload: { rule_id: ruleId, name: rule.name, patch },
      };
    },
  },

  // ── Omzetbelasting ────────────────────────────────────────────────────────
  {
    id: 'vat_return.compute',
    label: 'Btw-aangifte over een periode berekenen',
    module: 'finance',
    kind: 'read',
    description:
      'Rekent de rubrieken 1a t/m 5c van de btw-aangifte uit over een maand of kwartaal, op basis van de geboekte journaalposten. Geeft per rubriek de grondslag en de btw, het saldo (5c), het op hele euro\'s afgeronde bedrag en het afrondingsverschil. ' +
      'Is de periode al afgesloten, dan komen de vastgelegde cijfers terug in plaats van een herberekening. Gebruik dit vóór `vat_return.close_period` — daarna is de periode vergrendeld. ' +
      'Met `list_vat_returns` zie je welke perioden al zijn aangegeven.',
    keywords: ['btw', 'aangifte', 'omzetbelasting', 'rubrieken', 'kwartaal', 'maand', 'berekenen', '5c', 'saldo'],
    input: {
      period_type: { type: 'string', enum: [...PERIOD_TYPES], description: 'month of quarter.' },
      year: { type: 'number', description: 'Jaartal; standaard dit jaar.' },
      period_index: { type: 'number', description: 'Maandnummer 1-12 of kwartaal 1-4.' },
    },
    required: ['period_type', 'period_index'],
    async read(ctx, input) {
      const periodType = choice(input, 'period_type', PERIOD_TYPES);
      const year = yearOf(ctx, input);
      const period = periodBounds(periodType, year, Math.trunc(num(input, 'period_index')));
      const { data: existing } = await orgQuery(ctx, 'vat_returns', 'id, status, rubrieken, finalized_at, filed_at, journal_entry_id')
        .eq('period_type', periodType).eq('year', year).eq('period_index', Math.trunc(num(input, 'period_index')))
        .is('supplements_return_id', null).maybeSingle();
      if (existing) {
        const e = existing as Record<string, unknown>;
        return { period: period.label, from: period.from, to: period.to, finalized: true, status: e.status, rubrieken: e.rubrieken };
      }
      const rubrieken = await rpc<unknown>(ctx, 'compute_vat_return', { p_from: period.from, p_to: period.to }, 'Btw-aangifte berekenen');
      return { period: period.label, from: period.from, to: period.to, finalized: false, status: null, rubrieken };
    },
  },

  {
    id: 'vat_return.icp',
    label: 'ICP-opgaaf berekenen',
    module: 'finance',
    kind: 'read',
    description:
      'Berekent de opgaaf intracommunautaire prestaties over een periode: per EU-afnemer de geleverde goederen en diensten, met land en btw-nummer. Hoort aan te sluiten op rubriek 3b van de btw-aangifte. ' +
      'Meldt ook hoeveel afnemers nog geen btw-nummer op de klantkaart hebben (zonder btw-nummer is de opgaaf en het 0%-tarief niet geldig) en hoeveel ICP-omzet niet aan een klant gekoppeld is.',
    keywords: ['icp', 'intracommunautair', 'eu', 'opgaaf', '3b', 'buitenland', 'btw-nummer'],
    input: {
      period_type: { type: 'string', enum: [...PERIOD_TYPES] },
      year: { type: 'number', description: 'Jaartal; standaard dit jaar.' },
      period_index: { type: 'number', description: 'Maandnummer 1-12 of kwartaal 1-4.' },
    },
    required: ['period_type', 'period_index'],
    async read(ctx, input) {
      const periodType = choice(input, 'period_type', PERIOD_TYPES);
      const year = yearOf(ctx, input);
      const period = periodBounds(periodType, year, Math.trunc(num(input, 'period_index')));
      const declaration = await rpc<unknown>(ctx, 'compute_icp_declaration', { p_from: period.from, p_to: period.to }, 'ICP-opgaaf berekenen');
      return { period: period.label, from: period.from, to: period.to, icp: declaration };
    },
  },

  {
    id: 'vat_return.close_period',
    label: 'Btw-periode afsluiten en doorboeken',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Sluit een btw-periode af: het saldo wordt doorgeboekt naar "Te betalen omzetbelasting" (1530), het afrondingsverschil naar 4900, en de periode wordt VERGRENDELD zodat er niet meer in geboekt kan worden. ' +
      'ResoFly verstuurt de aangifte niet elektronisch. Sluit een periode dus pas af nadat de OB-aangifte zélf bij de Belastingdienst is ingediend — het afsluiten legt vast dat dat gebeurd is. ' +
      'DIT IS ONOMKEERBAAR: de vergrendeling gaat er niet meer af. Nagekomen boekingen schuiven daarna automatisch naar de eerstvolgende open datum, of worden formeel verrekend met `vat_supplement.create`. ' +
      'Bekijk het saldo eerst met `vat_return.compute`.',
    keywords: ['btw afsluiten', 'periode afsluiten', 'aangifte doorboeken', 'vergrendelen', 'omzetbelasting', '1530', 'belastingdienst'],
    input: {
      period_type: { type: 'string', enum: [...PERIOD_TYPES] },
      year: { type: 'number', description: 'Jaartal; standaard dit jaar.' },
      period_index: { type: 'number', description: 'Maandnummer 1-12 of kwartaal 1-4.' },
    },
    required: ['period_type', 'period_index'],
    async plan(ctx, input) {
      const periodType = choice(input, 'period_type', PERIOD_TYPES);
      const year = yearOf(ctx, input);
      const index = Math.trunc(num(input, 'period_index'));
      const period = periodBounds(periodType, year, index);

      const { data: existing } = await orgQuery(ctx, 'vat_returns', 'id, status')
        .eq('period_type', periodType).eq('year', year).eq('period_index', index).is('supplements_return_id', null).maybeSingle();
      if (existing) throw new ActionError(`${period.label} is al afgesloten (status ${(existing as { status: string }).status}).`);

      // Overlapt de periode een al vergrendelde periode (bv. januari terwijl Q1 al
      // dicht is), dan zou er een tweede, overlappende lock ontstaan.
      const { data: closed } = await orgQuery(ctx, 'closed_periods', 'period_start, period_end').limit(200);
      for (const cp of (closed ?? []) as Array<{ period_start: string | null; period_end: string | null }>) {
        if (!cp.period_start || !cp.period_end) continue;
        if (!(period.to < cp.period_start || period.from > cp.period_end)) {
          throw new ActionError(`${period.label} valt binnen een al afgesloten aangifteperiode (${cp.period_start} t/m ${cp.period_end}).`);
        }
      }

      const rubrieken = await rpc<{ saldo?: number; saldo_afgerond?: number | null }>(
        ctx, 'compute_vat_return', { p_from: period.from, p_to: period.to }, 'Btw-aangifte berekenen');
      const saldo = Number(rubrieken?.saldo ?? 0);
      const rounded = rubrieken?.saldo_afgerond ?? (saldo < 0 ? -Math.round(-saldo / 100) * 100 : Math.round(saldo / 100) * 100);
      const direction = rounded > 0 ? 'af te dragen' : rounded < 0 ? 'terug te ontvangen' : 'nihil';

      return {
        title: `Btw-periode ${period.label} afsluiten en doorboeken`,
        sub: joinShort([
          `${euroCents(Math.abs(rounded))} ${direction}`,
          rounded === 0 ? 'nihilaangifte — er wordt niets doorgeboekt' : 'wordt doorgeboekt naar 1530 Te betalen omzetbelasting',
        ], 220),
        warning: `Na het afsluiten kun je in ${period.label} niets meer boeken dat de btw-aangifte raakt (omzet en inkoop met btw); boekingen zonder btw, zoals afschrijvingen en lonen, kunnen nog wel. Die vergrendeling gaat er niet meer af. Je bevestigt hiermee dat de OB-aangifte al bij de Belastingdienst is ingediend.`,
        kind: 'money',
        payload: {
          period_type: periodType, year, period_index: index,
          from: period.from, to: period.to, label: period.label, saldo_cents: rounded,
        },
      };
    },
  },

  {
    id: 'vat_return.set_status',
    label: 'Btw-aangifte als ingediend of betaald markeren',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Zet de status van een afgesloten btw-aangifte (of van een suppletie) op "ingediend" of "betaald". Dit legt alleen vast wat er bij de Belastingdienst is gebeurd; er wordt niets geboekt. ' +
      'De volgorde is vast: van doorgeboekt naar ingediend, en van ingediend naar betaald. Wordt de betaling via de bank afgeletterd tegen "Te betalen omzetbelasting", dan gaat de status vanzelf op betaald. ' +
      'Zoek de aangifte met `list_vat_returns`.',
    keywords: ['aangifte ingediend', 'betaald', 'status', 'belastingdienst', 'btw', 'suppletie'],
    input: {
      vat_return_id: { type: 'string', description: 'Id van de aangifte (uit list_vat_returns).' },
      status: { type: 'string', enum: ['filed', 'paid'], description: 'filed = ingediend, paid = betaald.' },
    },
    required: ['vat_return_id', 'status'],
    async plan(ctx, input) {
      const returnId = id(input, 'vat_return_id');
      const status = choice(input, 'status', ['filed', 'paid'] as const);
      const vatReturn = await row<{ period_type: string; year: number; period_index: number; status: string; supplements_return_id: string | null; rubrieken: { saldo?: number; saldo_afgerond?: number | null } | null }>(
        ctx, 'vat_returns', returnId, 'period_type, year, period_index, status, supplements_return_id, rubrieken', 'Btw-aangifte');
      if (vatReturn.status === status) throw new ActionError(`Die aangifte staat al op "${status}".`);
      if (status === 'filed' && vatReturn.status !== 'finalized') {
        throw new ActionError(`Alleen een doorgeboekte aangifte kun je op ingediend zetten; deze staat op "${vatReturn.status}".`);
      }
      if (status === 'paid' && vatReturn.status !== 'filed') {
        throw new ActionError(`Zet de aangifte eerst op ingediend; deze staat op "${vatReturn.status}".`);
      }
      const label = vatReturn.period_type === 'quarter' ? `Q${vatReturn.period_index} ${vatReturn.year}` : `maand ${vatReturn.period_index} ${vatReturn.year}`;
      const saldo = Number(vatReturn.rubrieken?.saldo_afgerond ?? vatReturn.rubrieken?.saldo ?? 0);
      return {
        title: `Btw-aangifte ${label}${vatReturn.supplements_return_id ? ' (suppletie)' : ''} op "${status === 'filed' ? 'ingediend' : 'betaald'}" zetten`,
        sub: joinShort([`saldo ${euroCents(Math.abs(saldo))} ${saldo >= 0 ? 'te betalen' : 'terug'}`, 'legt alleen de status vast, er wordt niets geboekt'], 140),
        kind: 'work',
        payload: { vat_return_id: returnId, status, label },
      };
    },
  },

  {
    id: 'vat_supplement.preview',
    label: 'Effect van een btw-suppletie vooraf berekenen',
    module: 'finance',
    kind: 'read',
    description:
      'Rekent uit welk rubriek-effect een set correctieboekstukken zou hebben in een suppletie: per rubriek de grondslag en de btw, plus het saldo dat alsnog te betalen of terug te ontvangen is. ' +
      'Gebruik dit vóór `vat_supplement.create` — daarna tellen de boekstukken niet meer mee in de reguliere aangifte. Zoek de boekstukken met `list_journal_entries`.',
    keywords: ['suppletie', 'correctie', 'btw', 'voorberekenen', 'delta', 'rubriek', 'effect'],
    input: {
      entry_ids: { type: 'array', items: { type: 'string' }, description: 'Id\'s van de geboekte correctieboekstukken.' },
    },
    required: ['entry_ids'],
    async read(ctx, input) {
      const entryIds = ids(input, 'entry_ids', 200);
      const delta = await rpc<unknown>(ctx, 'compute_vat_supplement_delta', { p_entry_ids: entryIds }, 'Suppletie-effect berekenen');
      return { entry_ids: entryIds, delta };
    },
  },

  {
    id: 'vat_supplement.create',
    label: 'Btw-suppletie definitief maken',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Corrigeert een al afgesloten btw-aangifte met een formele suppletie: het btw-effect van de gekozen correctieboekstukken wordt doorgeboekt naar "Te betalen omzetbelasting" en die boekstukken tellen daarna NIET MEER mee in de reguliere aangifte. ' +
      'Wettelijk verplicht zodra de correctie per saldo meer dan € 1.000 is; blijft hij daaronder, dan mag je hem gewoon in de eerstvolgende aangifte meenemen. ' +
      'Bekijk het effect eerst met `vat_supplement.preview`. DIT IS ONOMKEERBAAR: de uitsluiting uit de reguliere aangifte en de grootboekboeking blijven staan.',
    keywords: ['suppletie', 'btw corrigeren', 'nagekomen factuur', 'correctie', 'belastingdienst', '1530'],
    input: {
      original_return_id: { type: 'string', description: 'Id van de al afgesloten aangifte die wordt gecorrigeerd (uit list_vat_returns).' },
      entry_ids: { type: 'array', items: { type: 'string' }, description: 'Id\'s van de geboekte correctieboekstukken.' },
      date: { type: 'string', description: 'Boekdatum van de suppletie JJJJ-MM-DD; standaard bepaalt de database hem.' },
      notes: { type: 'string', description: 'Bijvoorbeeld "vergeten inkoopfactuur maart".' },
    },
    required: ['original_return_id', 'entry_ids'],
    async plan(ctx, input) {
      const originalId = id(input, 'original_return_id');
      const entryIds = ids(input, 'entry_ids', 200);
      const original = await row<{ period_type: string; year: number; period_index: number; status: string; period_end: string }>(
        ctx, 'vat_returns', originalId, 'period_type, year, period_index, status, period_end', 'Btw-aangifte');
      if (original.status === 'draft') throw new ActionError('Een suppletie hoort bij een al afgesloten aangifte; deze staat nog op concept.');

      const { data: entries, error } = await orgQuery(ctx, 'journal_entries', 'id, entry_number, status, source_type, date').in('id', entryIds);
      if (error) throw new ActionError(`Boekstukken ophalen mislukt: ${error.message}`);
      const found = (entries ?? []) as Array<{ id: string; entry_number: string | null; status: string; source_type: string }>;
      if (found.length !== entryIds.length) throw new ActionError('Niet alle opgegeven boekstukken bestaan in deze organisatie.');
      const notPosted = found.filter((e) => e.status !== 'posted');
      if (notPosted.length > 0) throw new ActionError(`Alleen geboekte boekstukken kunnen in een suppletie; ${notPosted.map((e) => e.entry_number ?? e.id.slice(0, 8)).join(', ')} niet.`);
      const systemEntries = found.filter((e) => ['year_close', 'vat_return', 'opening_balance', 'result_appropriation', 'corporate_tax', 'dga_interest'].includes(e.source_type));
      if (systemEntries.length > 0) throw new ActionError(`Systeemboekstukken horen niet in een suppletie: ${systemEntries.map((e) => e.entry_number ?? e.id.slice(0, 8)).join(', ')}.`);

      const delta = await rpc<{ saldo?: number; saldo_afgerond?: number | null }>(
        ctx, 'compute_vat_supplement_delta', { p_entry_ids: entryIds }, 'Suppletie-effect berekenen');
      const saldo = Number(delta?.saldo_afgerond ?? delta?.saldo ?? 0);
      const label = original.period_type === 'quarter' ? `Q${original.period_index} ${original.year}` : `maand ${original.period_index} ${original.year}`;

      return {
        title: `Btw-suppletie ${label} definitief maken`,
        sub: joinShort([
          `${found.length} boekstuk${found.length === 1 ? '' : 'ken'}`,
          `${saldo >= 0 ? 'alsnog te betalen' : 'terug te ontvangen'} ${euroCents(Math.abs(saldo))}`,
          'wordt doorgeboekt naar 1530 Te betalen omzetbelasting',
        ], 220),
        warning: 'Deze boekstukken tellen daarna niet meer mee in de reguliere aangifte. Die uitsluiting en de grootboekboeking kun je niet ongedaan maken.',
        kind: 'money',
        payload: {
          original_return_id: originalId, entry_ids: entryIds, label,
          date: optIsoDate(input, 'date'), notes: optStr(input, 'notes', 500),
        },
      };
    },
  },

  // ── Boekjaren ─────────────────────────────────────────────────────────────
  {
    id: 'fiscal_year.open',
    label: 'Nieuw boekjaar openen',
    module: 'finance',
    kind: 'write',
    description:
      'Opent een boekjaar met een begin- en einddatum. Dit mag ook voordat het vorige boekjaar is afgesloten. Een gebroken boekjaar (niet januari–december) is toegestaan; volg de boekjaar-startmaand uit de boekhoudinstellingen. ' +
      'Bekijk de bestaande jaren eerst met `list_fiscal_years`.',
    keywords: ['boekjaar openen', 'nieuw boekjaar', 'jaar', 'gebroken boekjaar', 'periode'],
    input: {
      period_start: { type: 'string', description: 'Begindatum JJJJ-MM-DD.' },
      period_end: { type: 'string', description: 'Einddatum JJJJ-MM-DD.' },
      label: { type: 'string', description: 'Eigen naam, bijvoorbeeld "2026". Standaard leidt de database hem af.' },
    },
    required: ['period_start', 'period_end'],
    async plan(ctx, input) {
      const start = isoDate(input, 'period_start');
      const end = isoDate(input, 'period_end');
      if (end <= start) throw new ActionError('De einddatum moet ná de begindatum liggen.');
      const { data: overlapping } = await orgQuery(ctx, 'fiscal_years', 'label, period_start, period_end').limit(100);
      for (const fy of (overlapping ?? []) as Array<{ label: string; period_start: string; period_end: string }>) {
        if (!(end < fy.period_start || start > fy.period_end)) {
          throw new ActionError(`Dit bereik overlapt met boekjaar ${fy.label} (${fy.period_start} t/m ${fy.period_end}).`);
        }
      }
      return {
        title: `Boekjaar openen: ${start} t/m ${end}`,
        sub: joinShort([optStr(input, 'label', 40), 'je kunt daarna in dit jaar boeken'], 120),
        kind: 'work',
        payload: { period_start: start, period_end: end, label: optStr(input, 'label', 40) },
      };
    },
  },

  {
    id: 'fiscal_year.close',
    label: 'Boekjaar afsluiten',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Sluit een boekjaar af: het resultaat wordt in één boekstuk naar de resultaatrekening geboekt (standaard 0510 Onverdeeld resultaat; bij een eenmanszaak meestal 0500, en dan gaan ook de privé-opnamen en -stortingen naar 0500; bij een vof, maatschap of cv met vennoten naar rato naar hun kapitaalrekeningen) en het HELE JAAR wordt vergrendeld — daarna kan er niets meer in worden geboekt. ' +
      'Alle btw-aangiften van dat jaar moeten eerst zijn afgesloten. ' +
      'Een afgesloten boekjaar kan alleen nog door een eigenaar of beheerder worden heropend; doe dat alleen om een fout te herstellen. Bekijk het te bestemmen resultaat eerst met `list_fiscal_years`.',
    keywords: ['boekjaar afsluiten', 'jaarafsluiting', 'resultaat', '0510', 'vergrendelen', 'jaar dicht'],
    input: { fiscal_year_id: { type: 'string', description: 'Id van het boekjaar (uit list_fiscal_years).' } },
    required: ['fiscal_year_id'],
    async plan(ctx, input) {
      const fiscalYearId = id(input, 'fiscal_year_id');
      const fiscalYear = await row<{ label: string; period_start: string; period_end: string; status: string }>(
        ctx, 'fiscal_years', fiscalYearId, 'label, period_start, period_end, status', 'Boekjaar');
      if (fiscalYear.status !== 'open') throw new ActionError(`Boekjaar ${fiscalYear.label} staat al op "${fiscalYear.status}".`);

      const rows = await rpc<Array<{ id: string; computed_result_cents: number }>>(ctx, 'list_fiscal_years', {}, 'Boekjaren ophalen');
      const computed = (rows ?? []).find((r) => r.id === fiscalYearId)?.computed_result_cents ?? 0;
      const settings = await orgQuery(ctx, 'company_settings', 'year_result_account_code, legal_form').maybeSingle();
      const settingsRow = settings.data as { year_result_account_code?: string; legal_form?: string } | null;
      const resultCode = settingsRow?.year_result_account_code ?? '0510';
      const legalForm = String(settingsRow?.legal_form ?? 'eenmanszaak');

      // Waar het resultaat heen gaat, zoals close_fiscal_year het doet: bij een
      // vof, maatschap of cv met vennoten naar rato naar hun kapitaalrekeningen
      // (en hun privé naar hun eigen kapitaal); bij een eenmanszaak gaat ook het
      // privé naar 0500. Telt de verdeling niet op tot 100%, dan weigert de
      // afsluiting — dat hoort vóór de kaart te blijken, niet erna.
      let destination = `naar ${resultCode}`;
      if (['vof', 'maatschap', 'cv'].includes(legalForm)) {
        const { data: partners, error: partnersError } = await orgQuery(ctx, 'partnership_partners', 'name, profit_share_basis_points').eq('is_active', true);
        if (partnersError) throw new ActionError(`Vennoten ophalen mislukt: ${partnersError.message}`);
        const list = (partners ?? []) as Array<{ name: string; profit_share_basis_points: number }>;
        if (list.length > 0) {
          const total = list.reduce((sum, p) => sum + Number(p.profit_share_basis_points || 0), 0);
          if (total !== 10000) {
            throw new ActionError(`De winstverdeling van de vennoten telt op tot ${(total / 100).toLocaleString('nl-NL')}% in plaats van 100%. Pas de winstaandelen aan (Vennoten) voordat je het boekjaar afsluit.`);
          }
          destination = `naar de kapitaalrekeningen van ${list.length} vennoten (${list.map((p) => `${p.name} ${(p.profit_share_basis_points / 100).toLocaleString('nl-NL')}%`).join(', ')}); hun privé naar hun eigen kapitaal`;
        }
      } else if (legalForm === 'eenmanszaak') {
        destination = `naar ${resultCode}; privé-opnamen en -stortingen naar 0500 Eigen vermogen`;
      }

      return {
        title: `Boekjaar ${fiscalYear.label} definitief afsluiten`,
        sub: joinShort([
          `${fiscalYear.period_start} t/m ${fiscalYear.period_end}`,
          `resultaat ${euroCents(computed)} (${computed >= 0 ? 'winst' : 'verlies'}) ${destination}`,
        ], 260),
        warning: `Na het afsluiten kun je in ${fiscalYear.label} niets meer boeken. Alleen een eigenaar of beheerder kan het jaar nog heropenen.`,
        kind: 'money',
        payload: { fiscal_year_id: fiscalYearId, label: fiscalYear.label, result_cents: computed },
      };
    },
  },

  {
    id: 'fiscal_year.reopen',
    label: 'Boekjaar heropenen',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Heft de vergrendeling van een afgesloten boekjaar op zodat er weer in geboekt kan worden. Het jaarafsluitboekstuk VERVALT en het resultaat staat daarna weer als lopend resultaat op de balans. ' +
      'Alleen een eigenaar of beheerder mag dit, en alleen om een fout te herstellen: eerder uitgedraaide cijfers over dat jaar kunnen erdoor veranderen. Latere afgesloten boekjaren moeten eerst zijn heropend, en een resultaatbestemming van dit jaar moet eerst zijn teruggedraaid.',
    keywords: ['boekjaar heropenen', 'ontgrendelen', 'terugdraaien', 'jaarafsluiting ongedaan', 'fout herstellen'],
    input: { fiscal_year_id: { type: 'string' } },
    required: ['fiscal_year_id'],
    async plan(ctx, input) {
      requireAdmin(ctx, 'Een boekjaar heropenen');
      const fiscalYearId = id(input, 'fiscal_year_id');
      const fiscalYear = await row<{ label: string; status: string; result_cents: number | null; closed_at: string | null }>(
        ctx, 'fiscal_years', fiscalYearId, 'label, status, result_cents, closed_at', 'Boekjaar');
      if (fiscalYear.status !== 'closed') throw new ActionError(`Boekjaar ${fiscalYear.label} staat op "${fiscalYear.status}" en is dus niet afgesloten.`);
      return {
        title: `Boekjaar ${fiscalYear.label} heropenen`,
        sub: joinShort([
          fiscalYear.closed_at ? `afgesloten op ${fiscalYear.closed_at.slice(0, 10)}` : null,
          `jaarafsluitboekstuk van ${euroCents(fiscalYear.result_cents ?? 0)} vervalt`,
        ], 200),
        warning: 'Het jaarafsluitboekstuk vervalt en het resultaat staat weer onbestemd. Cijfers die je eerder over dit jaar hebt uitgedraaid, kunnen daardoor veranderen.',
        kind: 'money',
        payload: { fiscal_year_id: fiscalYearId, label: fiscalYear.label },
      };
    },
  },

  // ── Vaste activa ──────────────────────────────────────────────────────────
  {
    id: 'asset.list',
    label: 'Activaoverzicht bekijken',
    module: 'finance',
    kind: 'read',
    description:
      'Geeft de vaste activa met aanschafwaarde, restwaarde, gebruiksduur, de al geboekte afschrijving, de huidige boekwaarde en de status (actief, volledig afgeschreven, afgestoten). Meldt ook of de aanschaf al op de balans staat. ' +
      'Gebruik dit om het id te vinden voordat je een activum bijwerkt, afschrijft of afstoot.',
    keywords: ['activa', 'vaste activa', 'boekwaarde', 'afschrijving', 'inventaris', 'auto', 'machine'],
    input: {
      status: { type: 'string', enum: ['active', 'fully_depreciated', 'disposed'], description: 'Beperk tot één status.' },
      limit: { type: 'number', description: 'Maximaal aantal activa (standaard 50).' },
    },
    async read(ctx, input) {
      const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 200);
      let query = orgQuery(ctx, 'fixed_assets',
        'id, name, asset_number, category, acquisition_date, acquisition_cost_cents, residual_value_cents, useful_life_months, start_date, status, acquisition_journal_entry_id, disposal_date, disposal_proceeds_cents')
        .order('acquisition_date', { ascending: false }).limit(limit);
      const status = optChoice(input, 'status', ['active', 'fully_depreciated', 'disposed'] as const);
      if (status) query = query.eq('status', status);
      const { data, error } = await query;
      if (error) throw new ActionError(`Activa ophalen mislukt: ${error.message}`);
      const assets = (data ?? []) as Array<Record<string, unknown>>;
      if (assets.length === 0) return { assets: [] };

      const { data: deps } = await orgQuery(ctx, 'asset_depreciations', 'asset_id, amount_cents, status')
        .in('asset_id', assets.map((a) => String(a.id)));
      const posted = new Map<string, number>();
      for (const d of (deps ?? []) as Array<{ asset_id: string; amount_cents: number; status: string }>) {
        if (d.status !== 'posted') continue;
        posted.set(d.asset_id, (posted.get(d.asset_id) ?? 0) + Number(d.amount_cents ?? 0));
      }
      return {
        assets: assets.map((a) => {
          const depreciated = posted.get(String(a.id)) ?? 0;
          return {
            ...a,
            depreciated_cents: depreciated,
            book_value_cents: Number(a.acquisition_cost_cents ?? 0) - depreciated,
            acquisition_booked: a.acquisition_journal_entry_id != null,
          };
        }),
      };
    },
  },

  {
    id: 'asset.schedule',
    label: 'Afschrijvingsschema van een activum bekijken',
    module: 'finance',
    kind: 'read',
    description:
      'Geeft het lineaire afschrijvingsschema van één activum: per termijn de datum, het bedrag, de boekwaarde daarna en of hij al geboekt is. Toont ook hoeveel termijnen er nog te boeken staan. ' +
      'Gebruik dit vóór `asset.post_depreciation` om te zien welke termijnen er in één keer geboekt zouden worden.',
    keywords: ['afschrijvingsschema', 'termijnen', 'afschrijving', 'boekwaarde', 'planning', 'activum'],
    input: { asset_id: { type: 'string', description: 'Id van het activum (uit asset.list).' } },
    required: ['asset_id'],
    async read(ctx, input) {
      const assetId = id(input, 'asset_id');
      const asset = await row<{ name: string; asset_number: string | null; acquisition_cost_cents: number; residual_value_cents: number; useful_life_months: number; status: string }>(
        ctx, 'fixed_assets', assetId, 'name, asset_number, acquisition_cost_cents, residual_value_cents, useful_life_months, status', 'Activum');
      const { data, error } = await orgQuery(ctx, 'asset_depreciations', 'id, period_index, date, amount_cents, accumulated_after_cents, book_value_after_cents, status, journal_entry_id')
        .eq('asset_id', assetId).order('period_index', { ascending: true }).limit(600);
      if (error) throw new ActionError(`Afschrijvingsschema ophalen mislukt: ${error.message}`);
      const schedule = (data ?? []) as Array<{ status: string }>;
      return {
        asset: { id: assetId, ...asset },
        scheduled_count: schedule.filter((d) => d.status === 'scheduled').length,
        posted_count: schedule.filter((d) => d.status === 'posted').length,
        schedule,
      };
    },
  },

  {
    id: 'asset.create',
    label: 'Activum aanmaken',
    module: 'finance',
    kind: 'write',
    description:
      'Legt een vast activum vast met aanschafwaarde (excl. btw), restwaarde, gebruiksduur in maanden en de startdatum van de afschrijving, plus de drie grootboekrekeningen: de activarekening op de balans, de afschrijvingskosten in de W&V en de cumulatieve afschrijving op de balans. ' +
      'Laat je de rekeningen weg, dan worden de standaarden 0100, 4000 en 0150 gebruikt. Aanmaken boekt nog niets — daarvoor zijn `asset.book_acquisition` en `asset.post_depreciation`.',
    keywords: ['activum', 'vast activum', 'inventaris', 'auto', 'machine', 'afschrijven', 'aanschaf'],
    input: {
      name: { type: 'string' },
      asset_number: { type: 'string', description: 'Eigen nummer, bijvoorbeeld ACT-2026-0001.' },
      category: { type: 'string' },
      acquisition_date: { type: 'string', description: 'Aanschafdatum JJJJ-MM-DD.' },
      acquisition_cost_eur: { type: 'number', description: 'Aanschafwaarde EXCL. btw in euro.' },
      residual_value_eur: { type: 'number', description: 'Restwaarde in euro; standaard 0.' },
      useful_life_months: { type: 'number', description: 'Gebruiksduur in maanden, bijvoorbeeld 60 voor vijf jaar.' },
      start_date: { type: 'string', description: 'Startdatum van de afschrijving JJJJ-MM-DD; standaard de aanschafdatum.' },
      asset_account_id: { type: 'string', description: 'Activarekening op de balans; standaard 0100.' },
      depreciation_account_id: { type: 'string', description: 'Afschrijvingskosten in de W&V; standaard 4000.' },
      accumulated_depreciation_account_id: { type: 'string', description: 'Cumulatieve afschrijving op de balans; standaard 0150.' },
      source_purchase_invoice_id: { type: 'string', description: 'De inkoopfactuur waar het activum vandaan komt (optioneel).' },
      notes: { type: 'string' },
    },
    required: ['name', 'acquisition_date', 'acquisition_cost_eur', 'useful_life_months'],
    async plan(ctx, input) {
      const name = str(input, 'name', 200);
      const acquisitionDate = isoDate(input, 'acquisition_date');
      const costCents = cents(input, 'acquisition_cost_eur');
      if (costCents <= 0) throw new ActionError('De aanschafwaarde moet groter zijn dan nul.');
      const residualCents = optCents(input, 'residual_value_eur') ?? 0;
      if (residualCents > costCents) throw new ActionError('De restwaarde mag niet hoger zijn dan de aanschafwaarde.');
      const months = Math.trunc(num(input, 'useful_life_months'));
      if (months <= 0) throw new ActionError('De gebruiksduur moet groter zijn dan 0 maanden.');
      const startDate = optIsoDate(input, 'start_date') ?? acquisitionDate;

      const pick = async (key: string, fallbackCode: string, label: string): Promise<AccountRow> => {
        const givenId = optId(input, key);
        const account = givenId ? await loadAccount(ctx, givenId, label) : await accountByCode(ctx, fallbackCode);
        if (!account) throw new ActionError(`Geen ${label} gekozen en rekening ${fallbackCode} bestaat niet. Geef "${key}" mee of maak eerst het rekeningschema aan.`);
        return account;
      };
      const assetAccount = await pick('asset_account_id', '0100', 'activarekening');
      const depreciationAccount = await pick('depreciation_account_id', '4000', 'afschrijvingskostenrekening');
      const accumulatedAccount = await pick('accumulated_depreciation_account_id', '0150', 'cumulatieve-afschrijvingsrekening');
      if (assetAccount.type !== 'asset') throw new ActionError(`${accountLabel(assetAccount)} is geen bezittingenrekening.`);
      if (depreciationAccount.type !== 'expense') throw new ActionError(`${accountLabel(depreciationAccount)} is geen kostenrekening.`);
      if (accumulatedAccount.type !== 'asset') throw new ActionError(`${accountLabel(accumulatedAccount)} is geen bezittingenrekening.`);

      const sourceInvoiceId = optId(input, 'source_purchase_invoice_id');
      if (sourceInvoiceId) await row<{ id: string }>(ctx, 'purchase_invoices', sourceInvoiceId, 'id', 'Inkoopfactuur');

      const perMonth = Math.round((costCents - residualCents) / months);
      return {
        title: `Activum aanmaken: ${name}`,
        sub: joinShort([
          `${euroCents(costCents)} aanschaf${residualCents ? ` · restwaarde ${euroCents(residualCents)}` : ''}`,
          `${months} maanden (± ${euroCents(perMonth)} per maand)`,
          `${accountLabel(assetAccount)} / ${accountLabel(depreciationAccount)}`,
          'er wordt nog niets geboekt',
        ], 220),
        kind: 'work',
        payload: {
          name,
          asset_number: optStr(input, 'asset_number', 60),
          category: optStr(input, 'category', 120),
          acquisition_date: acquisitionDate,
          acquisition_cost_cents: costCents,
          residual_value_cents: residualCents,
          useful_life_months: months,
          start_date: startDate,
          asset_account_id: assetAccount.id,
          depreciation_account_id: depreciationAccount.id,
          accumulated_depreciation_account_id: accumulatedAccount.id,
          source_purchase_invoice_id: sourceInvoiceId,
          notes: optStr(input, 'notes', 1000),
        },
      };
    },
  },

  {
    id: 'asset.update',
    label: 'Activum bijwerken',
    module: 'finance',
    kind: 'write',
    description:
      'Past een activum aan. Zodra de aanschaf in het grootboek staat of er is afgeschreven, liggen de financiële velden VAST (aanschafdatum, aanschafwaarde, restwaarde, gebruiksduur, startdatum en de drie grootboekrekeningen) — anders zouden het activum en de journaalposten uiteenlopen. ' +
      'Naam, nummer, categorie, bron-inkoopfactuur en notities kunnen altijd. Corrigeren van een al geboekt bedrag gaat via een tegenboeking in het grootboek.',
    keywords: ['activum bewerken', 'gebruiksduur', 'restwaarde', 'hernoemen', 'activa'],
    input: {
      asset_id: { type: 'string' },
      name: { type: 'string' },
      asset_number: { type: 'string' },
      category: { type: 'string' },
      acquisition_date: { type: 'string' },
      acquisition_cost_eur: { type: 'number' },
      residual_value_eur: { type: 'number' },
      useful_life_months: { type: 'number' },
      start_date: { type: 'string' },
      source_purchase_invoice_id: { type: 'string' },
      notes: { type: 'string' },
    },
    required: ['asset_id'],
    async plan(ctx, input) {
      const assetId = id(input, 'asset_id');
      const asset = await row<{ name: string; asset_number: string | null; acquisition_cost_cents: number; residual_value_cents: number; useful_life_months: number; acquisition_journal_entry_id: string | null; status: string }>(
        ctx, 'fixed_assets', assetId, 'name, asset_number, acquisition_cost_cents, residual_value_cents, useful_life_months, acquisition_journal_entry_id, status', 'Activum');
      const { count: postedCount } = await ctx.db.from('asset_depreciations')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', ctx.organizationId).eq('asset_id', assetId).eq('status', 'posted');
      const locked = asset.acquisition_journal_entry_id != null || Number(postedCount ?? 0) > 0;

      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) {
        const name = optStr(input, 'name', 200);
        if (!name) throw new ActionError('De naam van een activum mag niet leeg zijn.');
        patch.name = name;
      }
      if (input.asset_number !== undefined) patch.asset_number = optStr(input, 'asset_number', 60);
      if (input.category !== undefined) patch.category = optStr(input, 'category', 120);
      if (input.notes !== undefined) patch.notes = optStr(input, 'notes', 1000);
      if (input.source_purchase_invoice_id !== undefined) {
        const sourceId = optId(input, 'source_purchase_invoice_id');
        if (sourceId) await row<{ id: string }>(ctx, 'purchase_invoices', sourceId, 'id', 'Inkoopfactuur');
        patch.source_purchase_invoice_id = sourceId;
      }

      const financial: string[] = [];
      const costCents = optCents(input, 'acquisition_cost_eur');
      if (costCents !== null) { patch.acquisition_cost_cents = costCents; financial.push('aanschafwaarde'); }
      const residualCents = optCents(input, 'residual_value_eur');
      if (residualCents !== null) { patch.residual_value_cents = residualCents; financial.push('restwaarde'); }
      const months = optNum(input, 'useful_life_months');
      if (months !== null) {
        if (Math.trunc(months) <= 0) throw new ActionError('De gebruiksduur moet groter zijn dan 0 maanden.');
        patch.useful_life_months = Math.trunc(months);
        financial.push('gebruiksduur');
      }
      const acquisitionDate = optIsoDate(input, 'acquisition_date');
      if (acquisitionDate) { patch.acquisition_date = acquisitionDate; financial.push('aanschafdatum'); }
      const startDate = optIsoDate(input, 'start_date');
      if (startDate) { patch.start_date = startDate; financial.push('startdatum'); }

      if (financial.length > 0 && locked) {
        throw new ActionError(`De aanschaf van ${asset.name} staat in het grootboek of er is al afgeschreven; ${financial.join(', ')} liggen daarmee vast. Corrigeren kan alleen via een tegenboeking.`);
      }
      const nextCost = costCents ?? asset.acquisition_cost_cents;
      const nextResidual = residualCents ?? asset.residual_value_cents;
      if (nextResidual > nextCost) throw new ActionError('De restwaarde mag niet hoger zijn dan de aanschafwaarde.');
      if (Object.keys(patch).length === 0) throw new ActionError('Geef minstens één veld dat moet veranderen.');

      return {
        title: `Activum bijwerken: ${asset.name}`,
        sub: joinShort([...Object.keys(patch), financial.length > 0 ? 'herbereken daarna het afschrijvingsschema' : null], 150),
        kind: 'work',
        payload: { asset_id: assetId, name: asset.name, patch },
      };
    },
  },

  {
    id: 'asset.book_acquisition',
    label: 'Aanschaf van een activum boeken',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Zet de aanschafwaarde op de balans: debet de activarekening, credit een tegenrekening (meestal 1600 Crediteuren of 1100 Bank). Pas daarna verschijnt de boekwaarde op de balans. ' +
      'DOE DIT NIET als de aanschaf al via een inkoopfactuur op de activarekening is geboekt — dan telt hij dubbel. ' +
      'Dit is een definitieve grootboekboeking; corrigeren kan alleen met een tegenboeking. Na het boeken liggen de financiële velden van het activum vast.',
    keywords: ['aanschaf boeken', 'activum op de balans', 'investering', 'tegenrekening', 'boekwaarde'],
    input: {
      asset_id: { type: 'string' },
      credit_account_id: { type: 'string', description: 'Tegenrekening; standaard 1600 Crediteuren.' },
      date: { type: 'string', description: 'Boekdatum JJJJ-MM-DD; standaard de aanschafdatum van het activum.' },
    },
    required: ['asset_id'],
    async plan(ctx, input) {
      const assetId = id(input, 'asset_id');
      const asset = await row<{ name: string; acquisition_date: string; acquisition_cost_cents: number; asset_account_id: string; acquisition_journal_entry_id: string | null; status: string }>(
        ctx, 'fixed_assets', assetId, 'name, acquisition_date, acquisition_cost_cents, asset_account_id, acquisition_journal_entry_id, status', 'Activum');
      if (asset.acquisition_journal_entry_id) throw new ActionError(`De aanschaf van ${asset.name} staat al op de balans.`);
      if (asset.status === 'disposed') throw new ActionError(`${asset.name} is al afgestoten.`);
      const assetAccount = await loadAccount(ctx, asset.asset_account_id, 'Activarekening');
      const givenId = optId(input, 'credit_account_id');
      const creditAccount = givenId ? await loadAccount(ctx, givenId, 'Tegenrekening') : await accountByCode(ctx, '1600');
      if (!creditAccount) throw new ActionError('Geen tegenrekening gekozen en 1600 Crediteuren bestaat niet. Geef `credit_account_id` mee.');
      if (creditAccount.id === assetAccount.id) throw new ActionError('De tegenrekening mag niet dezelfde zijn als de activarekening.');
      const date = optIsoDate(input, 'date') ?? asset.acquisition_date;

      return {
        title: `Aanschaf boeken: ${asset.name} (${euroCents(asset.acquisition_cost_cents)})`,
        sub: joinShort([
          `debet ${accountLabel(assetAccount)} / credit ${accountLabel(creditAccount)}`,
          `boekdatum ${date}`,
        ], 220),
        warning: 'Is de aanschaf al via een inkoopfactuur op de activarekening geboekt, dan telt hij hierna dubbel. Deze boeking corrigeer je alleen met een tegenboeking.',
        kind: 'money',
        payload: { asset_id: assetId, name: asset.name, credit_account_id: creditAccount.id, date },
      };
    },
  },

  {
    id: 'asset.generate_schedule',
    label: 'Afschrijvingsschema (her)berekenen',
    module: 'finance',
    kind: 'write',
    description:
      'Berekent het lineaire afschrijvingsschema van een activum: per maand een termijn, van de startdatum tot het einde van de gebruiksduur, tot aan de restwaarde. Al geboekte termijnen blijven staan; alleen de nog geplande termijnen worden opnieuw gezet. ' +
      'Doe dit na het aanmaken van een activum, of nadat je gebruiksduur of restwaarde hebt gewijzigd. Er wordt niets geboekt — dat gebeurt pas met `asset.post_depreciation`.',
    keywords: ['afschrijvingsschema', 'herberekenen', 'genereren', 'lineair', 'termijnen', 'activum'],
    input: { asset_id: { type: 'string' } },
    required: ['asset_id'],
    async plan(ctx, input) {
      const assetId = id(input, 'asset_id');
      const asset = await row<{ name: string; acquisition_cost_cents: number; residual_value_cents: number; useful_life_months: number; start_date: string; status: string }>(
        ctx, 'fixed_assets', assetId, 'name, acquisition_cost_cents, residual_value_cents, useful_life_months, start_date, status', 'Activum');
      if (asset.status === 'disposed') throw new ActionError(`${asset.name} is afgestoten; er valt niets meer af te schrijven.`);
      const { count } = await ctx.db.from('asset_depreciations')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', ctx.organizationId).eq('asset_id', assetId).eq('status', 'posted');
      const postedCount = Number(count ?? 0);
      return {
        title: `Afschrijvingsschema ${postedCount > 0 ? 'herberekenen' : 'berekenen'}: ${asset.name}`,
        sub: joinShort([
          `${euroCents(asset.acquisition_cost_cents - asset.residual_value_cents)} over ${asset.useful_life_months} maanden vanaf ${asset.start_date}`,
          postedCount > 0 ? `${postedCount} al geboekte termijnen blijven staan` : 'er wordt nog niets geboekt',
        ], 180),
        kind: 'work',
        payload: { asset_id: assetId, name: asset.name },
      };
    },
  },

  {
    id: 'asset.post_depreciation',
    label: 'Afschrijving boeken tot en met een datum',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Boekt alle geplande afschrijvingstermijnen van een activum tot en met de gekozen datum: debet de afschrijvingskosten in de W&V, credit de cumulatieve afschrijving op de balans. Elke termijn wordt een journaalpost. ' +
      'Bekijk eerst met `asset.schedule` welke termijnen er openstaan. DIT ZIJN DEFINITIEVE GROOTBOEKBOEKINGEN; corrigeren kan alleen met een tegenboeking. Valt een termijn in een afgesloten boekjaar, dan boekt ResoFly hem op de eerste open datum daarna (een afschrijving raakt de btw-aangifte niet, dus een afgesloten btw-periode houdt hem niet tegen).',
    keywords: ['afschrijven', 'afschrijving boeken', 'termijn', 'maandafschrijving', 'w&v', 'activum'],
    input: {
      asset_id: { type: 'string' },
      through_date: { type: 'string', description: 'Boek alle termijnen t/m deze datum JJJJ-MM-DD; standaard vandaag.' },
    },
    required: ['asset_id'],
    async plan(ctx, input) {
      const assetId = id(input, 'asset_id');
      const throughDate = optIsoDate(input, 'through_date') ?? ctx.today;
      const asset = await row<{ name: string; status: string }>(ctx, 'fixed_assets', assetId, 'name, status', 'Activum');
      if (asset.status === 'disposed') throw new ActionError(`${asset.name} is afgestoten; er valt niets meer af te schrijven.`);

      const { data, error } = await orgQuery(ctx, 'asset_depreciations', 'amount_cents, date')
        .eq('asset_id', assetId).eq('status', 'scheduled').lte('date', throughDate);
      if (error) throw new ActionError(`Afschrijvingsschema ophalen mislukt: ${error.message}`);
      const due = (data ?? []) as Array<{ amount_cents: number; date: string }>;
      if (due.length === 0) throw new ActionError(`Er staan geen geplande afschrijvingstermijnen t/m ${throughDate} open voor ${asset.name}. Bereken het schema eerst met \`asset.generate_schedule\`.`);
      const total = due.reduce((sum, d) => sum + Number(d.amount_cents ?? 0), 0);

      return {
        title: `Afschrijving boeken t/m ${throughDate}: ${asset.name}`,
        sub: joinShort([
          `${due.length} termijn${due.length === 1 ? '' : 'en'} · ${euroCents(total)} naar de W&V`,
        ], 180),
        warning: `Er komen ${due.length} definitieve journaalposten in het grootboek; corrigeren kan alleen met een tegenboeking.`,
        kind: 'money',
        payload: { asset_id: assetId, name: asset.name, through_date: throughDate, count: due.length, total_cents: total },
      };
    },
  },

  {
    id: 'asset.dispose',
    label: 'Activum afstoten (desinvestering of verkoop)',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Boekt de afstoting van een activum: de boekwaarde gaat eraf (credit de activarekening, debet de cumulatieve afschrijving), de opbrengst komt op de tegenrekening en het verschil tussen opbrengst en boekwaarde wordt als boekwinst of boekverlies op 4950 geboekt. ' +
      'Bij schenken of schroot geef je 0 als opbrengst. De aanschaf moet al op de balans staan. ' +
      'DIT KAN NIET ONGEDAAN WORDEN GEMAAKT — corrigeren kan alleen met een tegenboeking; het activum krijgt de status "afgestoten".',
    keywords: ['desinvestering', 'afstoten', 'verkopen', 'boekwinst', 'boekverlies', '4950', 'activum weg'],
    input: {
      asset_id: { type: 'string' },
      proceeds_eur: { type: 'number', description: 'Opbrengst in euro, EXCLUSIEF btw; 0 bij schenken of schroot.' },
      vat_code: { type: 'string', description: 'Btw over de opbrengst: HOOG (21%, standaard bij een verkoop), LAAG, VRIJ, of leeg voor geen btw (KOR, schenken). Met de KOR standaard leeg.' },
      counter_account_id: { type: 'string', description: 'Tegenrekening voor de opbrengst; standaard 1100 Bank.' },
      date: { type: 'string', description: 'Datum van de afstoting JJJJ-MM-DD; standaard vandaag.' },
    },
    required: ['asset_id', 'proceeds_eur'],
    async plan(ctx, input) {
      const assetId = id(input, 'asset_id');
      const asset = await row<{ name: string; acquisition_cost_cents: number; asset_account_id: string; acquisition_journal_entry_id: string | null; status: string }>(
        ctx, 'fixed_assets', assetId, 'name, acquisition_cost_cents, asset_account_id, acquisition_journal_entry_id, status', 'Activum');
      if (asset.status === 'disposed') throw new ActionError(`${asset.name} is al afgestoten.`);
      if (!asset.acquisition_journal_entry_id) throw new ActionError(`De aanschaf van ${asset.name} staat nog niet op de balans; afstoten kan pas daarna.`);
      const proceeds = cents(input, 'proceeds_eur');
      if (proceeds < 0) throw new ActionError('De opbrengst kan niet negatief zijn.');
      const givenId = optId(input, 'counter_account_id');
      const counterAccount = givenId ? await loadAccount(ctx, givenId, 'Tegenrekening') : await accountByCode(ctx, '1100');
      if (!counterAccount) throw new ActionError('Geen tegenrekening gekozen en 1100 Bank bestaat niet. Geef `counter_account_id` mee.');
      const date = optIsoDate(input, 'date') ?? ctx.today;

      // Btw over de opbrengst: de verkoop van een bedrijfsmiddel is een belaste
      // levering. Standaard HOOG, met de KOR geen btw; de kaart toont het bedrag.
      const { data: settings } = await orgQuery(ctx, 'company_settings', 'kor_enabled').maybeSingle();
      const kor = Boolean((settings as { kor_enabled?: boolean } | null)?.kor_enabled);
      const rawCode = typeof input.vat_code === 'string' ? input.vat_code.trim().toUpperCase() : null;
      const vatCode = proceeds > 0 ? (rawCode === null ? (kor ? '' : 'HOOG') : rawCode) : '';
      let vatCents = 0;
      if (vatCode) {
        const { data: vc } = await orgQuery(ctx, 'vat_codes', 'code, rate, sales_box, kind').eq('code', vatCode).maybeSingle();
        const code = vc as { rate: number | string; sales_box: string | null; kind: string } | null;
        if (!code) throw new ActionError(`Btw-code ${vatCode} bestaat niet in deze administratie.`);
        if (['1a', '1b', '1c', '1d'].includes(String(code.sales_box ?? ''))) vatCents = Math.round(proceeds * Number(code.rate) / 100);
        else if (!['exempt', 'zero', 'kor'].includes(code.kind)) throw new ActionError(`Btw-code ${vatCode} is geen code voor een verkoop in Nederland; kies bijvoorbeeld HOOG, LAAG of VRIJ.`);
      }

      const { data: deps } = await orgQuery(ctx, 'asset_depreciations', 'amount_cents, status').eq('asset_id', assetId).eq('status', 'posted');
      const depreciated = ((deps ?? []) as Array<{ amount_cents: number }>).reduce((sum, d) => sum + Number(d.amount_cents ?? 0), 0);
      const bookValue = asset.acquisition_cost_cents - depreciated;
      const result = proceeds - bookValue;

      return {
        title: `Activum afstoten: ${asset.name} per ${date}`,
        sub: joinShort([
          `boekwaarde ${euroCents(bookValue)} · opbrengst ${euroCents(proceeds)} excl. btw`,
          vatCents ? `btw ${vatCode} ${euroCents(vatCents)} op 1510` : (proceeds > 0 ? 'geen btw' : ''),
          `${result >= 0 ? 'boekwinst' : 'boekverlies'} ${euroCents(Math.abs(result))} op 4950`,
          `opbrengst naar ${accountLabel(counterAccount)}`,
        ], 230),
        warning: 'Het activum krijgt de status "afgestoten" en de boekwaarde gaat van de balans. Je kunt dit niet ongedaan maken; corrigeren kan alleen met een tegenboeking.',
        kind: 'money',
        payload: { asset_id: assetId, name: asset.name, counter_account_id: counterAccount.id, proceeds_cents: proceeds, vat_code: vatCode || null, vat_cents: vatCents, date },
      };
    },
  },
  // ── Vooruitbetaalde kosten ────────────────────────────────────────────────
  {
    id: 'prepaid.list',
    label: 'Vooruitbetaalde kosten bekijken',
    module: 'finance',
    kind: 'read',
    description:
      'Geeft de vooruitbetaalde kosten: betalingen die over meerdere maanden naar de kosten gaan, zoals een verzekering voor drie jaar of een jaarabonnement. Per post de omschrijving, het bedrag, de looptijd, wat er al naar de kosten ging, wat er nog op de balans staat, de status ' +
      '(lopend, afgerond, beëindigd), of het bedrag al op de balans staat, en hoeveel termijnen er t/m het einde van deze maand klaarstaan. Gebruik dit om het id te vinden voordat je termijnen boekt of een post beëindigt.',
    keywords: ['vooruitbetaald', 'vooruitbetaalde kosten', 'vooruitbetaling', 'overlopende activa', 'transitorische posten', 'spreiden', 'verzekering', 'jaarabonnement', 'termijnen', 'op de balans'],
    input: {
      status: { type: 'string', enum: ['active', 'completed', 'ended'], description: 'Beperk tot één status.' },
      limit: { type: 'number', description: 'Maximaal aantal posten (standaard 50).' },
    },
    async read(ctx, input) {
      const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 200);
      let query = orgQuery(ctx, 'prepaid_expenses',
        'id, description, amount_cents, months, start_date, payment_date, start_mode, start_journal_entry_id, status, end_date, end_amount_cents, end_refund_cents, source_purchase_invoice_id')
        .order('start_date', { ascending: false }).limit(limit);
      const status = optChoice(input, 'status', ['active', 'completed', 'ended'] as const);
      if (status) query = query.eq('status', status);
      const { data, error } = await query;
      if (error) throw new ActionError(`Vooruitbetaalde kosten ophalen mislukt: ${error.message}`);
      const items = (data ?? []) as Array<PrepaidRow & Record<string, unknown>>;
      if (items.length === 0) return { prepaid_expenses: [] };

      const through = prepaidMonthEnd(ctx.today);
      const releases = await allRows<{ prepaid_expense_id: string; date: string; amount_cents: number; status: string }>(
        () => orgQuery(ctx, 'prepaid_expense_releases', 'id, prepaid_expense_id, date, amount_cents, status')
          .in('prepaid_expense_id', items.map((p) => p.id)).order('id', { ascending: true }),
        'Termijnen');
      const byItem = new Map<string, Array<{ date: string; amount_cents: number; status: string }>>();
      for (const r of releases) {
        const list = byItem.get(r.prepaid_expense_id) ?? [];
        list.push(r);
        byItem.set(r.prepaid_expense_id, list);
      }
      return {
        through_date: through,
        prepaid_expenses: items.map((p) => {
          const own = byItem.get(p.id) ?? [];
          const released = own.filter((r) => r.status === 'posted').reduce((sum, r) => sum + Number(r.amount_cents ?? 0), 0);
          const onBalance = prepaidOnBalance(p);
          const due = p.status === 'active' && onBalance ? own.filter((r) => r.status === 'scheduled' && r.date <= through) : [];
          const next = own.filter((r) => r.status === 'scheduled').sort((a, b) => a.date.localeCompare(b.date))[0]?.date ?? null;
          return {
            ...p,
            on_balance: onBalance,
            released_cents: released,
            remaining_on_balance_cents: p.status === 'active' && onBalance ? Number(p.amount_cents) - released : 0,
            due_count: due.length,
            due_cents: due.reduce((sum, r) => sum + Number(r.amount_cents ?? 0), 0),
            next_release_date: next,
          };
        }),
      };
    },
  },

  {
    id: 'prepaid.create',
    label: 'Vooruitbetaald bedrag over de maanden spreiden',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Legt een vooruitbetaling vast en boekt hem: het bedrag gaat naar de balans (rekening Vooruitbetaalde kosten) en elke maand gaat er een gelijk deel naar de kostenrekening, op de laatste dag van de maand. Voorbeeld: € 1.000 verzekering met drie jaar dekking = 36 maanden, 28 × € 27,78 en 8 × € 27,77. ' +
      'Kies met "how" hoe het bedrag nu in de boekhouding staat: "book" (nog niet geboekt: debet Vooruitbetaalde kosten / credit counter_account_id, standaard 1100 Bank), "expense" (de factuur is al als kosten geboekt: het bedrag gaat van die kostenrekening, standaard expense_account_id, naar de balans) of "existing" (het staat al op de balansrekening, bijvoorbeeld via de bank of de beginbalans; dan worden alleen de maandtermijnen geboekt). ' +
      'Het bedrag is EXCLUSIEF btw; btw op de factuur hoort via de inkoopfactuur te lopen. Termijnen t/m het einde van deze maand worden meteen geboekt, tenzij post_now false is. DIT ZIJN DEFINITIEVE GROOTBOEKBOEKINGEN; corrigeren kan alleen met tegenboeken. Begon de periode vóór de start van de boekhouding in ResoFly, geef dan het bedrag dat er bij de start nog op de balans stond, de maanden die toen nog over waren, en how "existing".',
    keywords: ['vooruitbetaald', 'vooruitbetaalde kosten', 'vooruitbetaling', 'spreiden', 'verspreiden', 'verdelen', 'over maanden', 'verzekering', 'premie', 'jaarabonnement', 'abonnement', 'huur vooruit', 'overlopende activa', 'transitorisch'],
    input: {
      description: { type: 'string', description: 'Wat er vooruitbetaald is, bijvoorbeeld "Bedrijfsaansprakelijkheidsverzekering 2026–2029".' },
      amount_eur: { type: 'number', description: 'Het bedrag in euro, EXCLUSIEF btw.' },
      months: { type: 'number', description: 'Over hoeveel maanden, bijvoorbeeld 36 voor drie jaar (1 t/m 600).' },
      start_date: { type: 'string', description: 'Eerste dag van de periode JJJJ-MM-DD; standaard de eerste van deze maand. De eerste termijn valt op het einde van die maand.' },
      payment_date: { type: 'string', description: 'Betaal- of factuurdatum JJJJ-MM-DD; standaard vandaag. Daarop gaat het bedrag naar de balans.' },
      expense_account_id: { type: 'string', description: 'Kostenrekening voor de maandbedragen (bijvoorbeeld Verzekeringen); standaard 4500 Algemene kosten.' },
      how: { type: 'string', enum: [...PREPAID_HOW], description: 'book (standaard), expense of existing; zie de omschrijving.' },
      counter_account_id: { type: 'string', description: 'Bij book: de tegenrekening (standaard 1100 Bank). Bij expense: de kostenrekening waarop de factuur al staat (standaard expense_account_id).' },
      prepaid_account_id: { type: 'string', description: 'Balansrekening; standaard "Vooruitbetaalde kosten" (die maakt ResoFly aan als hij er nog niet is).' },
      source_purchase_invoice_id: { type: 'string', description: 'De inkoopfactuur waar het bij hoort (optioneel).' },
      notes: { type: 'string' },
      post_now: { type: 'boolean', description: 'De termijnen t/m het einde van deze maand meteen boeken (standaard true).' },
    },
    required: ['description', 'amount_eur', 'months'],
    async plan(ctx, input) {
      const description = str(input, 'description', 200);
      const amountCents = cents(input, 'amount_eur');
      if (amountCents <= 0) throw new ActionError('Het bedrag moet groter zijn dan nul.');
      if (amountCents > 100_000_000_000) throw new ActionError('Dat bedrag is te groot.');
      const months = Math.trunc(num(input, 'months'));
      if (months < 1 || months > 600) throw new ActionError('"months" is 1 t/m 600 maanden.');
      const startDate = optIsoDate(input, 'start_date') ?? `${ctx.today.slice(0, 8)}01`;
      const paymentDate = optIsoDate(input, 'payment_date') ?? ctx.today;
      const how = optChoice(input, 'how', PREPAID_HOW) ?? 'book';

      const givenExpense = optId(input, 'expense_account_id');
      const expense = givenExpense ? await loadAccount(ctx, givenExpense, 'Kostenrekening') : await accountByCode(ctx, '4500');
      if (!expense) throw new ActionError('Geen kostenrekening gekozen en 4500 Algemene kosten bestaat niet. Geef "expense_account_id" mee of maak eerst het rekeningschema aan.');
      if (expense.type !== 'expense' || !expense.is_active) throw new ActionError(`${accountLabel(expense)} is geen actieve kostenrekening.`);

      const givenPrepaid = optId(input, 'prepaid_account_id');
      let prepaid: AccountRow | null = null;
      if (givenPrepaid) {
        prepaid = await loadAccount(ctx, givenPrepaid, 'Balansrekening');
        if (prepaid.type !== 'asset' || NOT_PREPAID.includes(prepaid.subtype ?? '') || !prepaid.is_active) {
          throw new ActionError(`${accountLabel(prepaid)} is geen geschikte balansrekening voor vooruitbetaalde kosten.`);
        }
      } else {
        const { data } = await orgQuery(ctx, 'ledger_accounts', 'id, code, name, type, subtype, is_system, is_active')
          .eq('subtype', 'prepaid_expenses').eq('is_active', true).order('code', { ascending: true }).limit(1);
        prepaid = ((data ?? []) as AccountRow[])[0] ?? null;
      }
      if (prepaid && prepaid.id === expense.id) throw new ActionError('De balansrekening en de kostenrekening moeten verschillen.');

      let counter: AccountRow | null = null;
      if (how === 'book') {
        const givenCounter = optId(input, 'counter_account_id');
        counter = givenCounter ? await loadAccount(ctx, givenCounter, 'Tegenrekening') : await accountByCode(ctx, '1100');
        if (!counter) throw new ActionError('Geen tegenrekening gekozen en 1100 Bank bestaat niet. Geef "counter_account_id" mee.');
        if (counter.type === 'revenue' || VAT_SUBTYPES.includes(counter.subtype ?? '') || !counter.is_active) {
          throw new ActionError(`${accountLabel(counter)} kan geen tegenrekening zijn; kies de bank, crediteuren of een andere balansrekening.`);
        }
      } else if (how === 'expense') {
        const givenCounter = optId(input, 'counter_account_id');
        counter = givenCounter ? await loadAccount(ctx, givenCounter, 'Kostenrekening van de factuur') : expense;
        if (counter.type !== 'expense') throw new ActionError(`${accountLabel(counter)} is geen kostenrekening; bij how "expense" is de tegenrekening de kostenrekening waarop de factuur staat.`);
      }
      if (counter && prepaid && counter.id === prepaid.id) throw new ActionError('De tegenrekening mag niet de balansrekening zelf zijn.');

      const sourceId = optId(input, 'source_purchase_invoice_id');
      if (sourceId) await row<{ id: string }>(ctx, 'purchase_invoices', sourceId, 'id', 'Inkoopfactuur');

      // Zelfde regel als de database: niets van vóór de start van de boekhouding.
      const { data: settings } = await orgQuery(ctx, 'company_settings', 'bookkeeping_start_date').maybeSingle();
      const bookkeepingStart = (settings as { bookkeeping_start_date?: string | null } | null)?.bookkeeping_start_date ?? null;
      if (bookkeepingStart && prepaidMonthEnd(startDate) < bookkeepingStart) {
        throw new ActionError(`De boekhouding in ResoFly begint op ${bookkeepingStart}. Geef het bedrag dat er op die dag nog op de balans stond, met de maanden die toen nog over waren, en how "existing".`);
      }
      if (bookkeepingStart && how !== 'existing' && paymentDate < bookkeepingStart) {
        throw new ActionError(`De betaling was vóór de start van de boekhouding in ResoFly (${bookkeepingStart}) en zit dus in de beginbalans: gebruik how "existing".`);
      }

      const terms = prepaidTerms(amountCents, months, startDate);
      const through = prepaidMonthEnd(ctx.today);
      const postNow = bool(input, 'post_now', true);
      const due = postNow ? terms.filter((t) => t.date <= through) : [];
      const prepaidLabel = prepaid ? accountLabel(prepaid) : 'Vooruitbetaalde kosten (nieuw)';
      return {
        title: `Vooruitbetaald spreiden: ${description} (${euroCents(amountCents)} over ${months} maanden)`,
        sub: joinShort([
          `${prepaidPerMonth(terms)}, ${prepaidMonthLabel(terms[0].date)} t/m ${prepaidMonthLabel(terms[terms.length - 1].date)}, naar ${accountLabel(expense)}`,
          how === 'existing' ? 'staat al op de balans' : `naar de balans: debet ${prepaidLabel} / credit ${accountLabel(counter!)} op ${paymentDate}`,
          due.length ? `${due.length} termijn${due.length === 1 ? '' : 'en'} t/m ${through} meteen geboekt (${euroCents(due.reduce((s, t) => s + t.cents, 0))})` : null,
        ], 300),
        warning: 'Dit zijn definitieve journaalposten in het grootboek; corrigeren kan alleen met tegenboeken (eerst de termijnen, dan de boeking naar de balans).',
        kind: 'money',
        payload: {
          description, amount_cents: amountCents, months, start_date: startDate, payment_date: paymentDate,
          expense_account_id: expense.id, prepaid_account_id: prepaid?.id ?? null,
          start_mode: how === 'existing' ? 'existing' : 'book', counter_account_id: counter?.id ?? null,
          source_purchase_invoice_id: sourceId, notes: optStr(input, 'notes', 2000),
          post_now: postNow && due.length > 0, through_date: through,
        },
      };
    },
  },

  {
    id: 'prepaid.post_releases',
    label: 'Termijnen van vooruitbetaalde kosten boeken',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Boekt de geplande maandtermijnen van vooruitbetaalde kosten tot en met een datum (uiterlijk het einde van deze maand): debet de kostenrekening, credit Vooruitbetaalde kosten. Van één post (prepaid_expense_id) of van alle lopende posten tegelijk. Elke termijn wordt een journaalpost. ' +
      'Een termijn in een afgesloten boekjaar komt op de eerste open dag daarna; een afgesloten btw-periode houdt hem niet tegen (hij raakt de aangifte niet). Bekijk eerst met `prepaid.list` wat er klaarstaat. DIT ZIJN DEFINITIEVE BOEKINGEN; corrigeren kan alleen met tegenboeken. Handig als maandelijkse taak van een agent.',
    keywords: ['termijnen boeken', 'termijn', 'maandtermijn', 'vrijval', 'vooruitbetaald', 'vooruitbetaalde kosten', 'maandafsluiting', 'naar de kosten', 'spreiden'],
    input: {
      through_date: { type: 'string', description: 'Boek t/m deze datum JJJJ-MM-DD; standaard het einde van deze maand.' },
      prepaid_expense_id: { type: 'string', description: 'Alleen deze post (uit prepaid.list); leeg = alle lopende posten.' },
    },
    async plan(ctx, input) {
      const lastAllowed = prepaidMonthEnd(ctx.today);
      const through = optIsoDate(input, 'through_date') ?? lastAllowed;
      if (through > lastAllowed) throw new ActionError(`Termijnen boek je tot en met het einde van deze maand (${lastAllowed}); latere maanden als ze aan de beurt zijn.`);
      const itemId = optId(input, 'prepaid_expense_id');
      let label: string | null = null;
      let query = orgQuery(ctx, 'prepaid_expenses', 'id, description, start_mode, start_journal_entry_id, status').eq('status', 'active');
      if (itemId) {
        const item = await row<PrepaidRow>(ctx, 'prepaid_expenses', itemId, 'id, description, start_mode, start_journal_entry_id, status', 'Vooruitbetaling');
        if (item.status !== 'active') throw new ActionError(`${item.description} is afgerond of beëindigd; er staan geen termijnen meer open.`);
        if (!prepaidOnBalance(item)) throw new ActionError(`Het bedrag van ${item.description} staat nog niet op de balans. Boek dat eerst (in het scherm Vooruitbetaald).`);
        label = item.description;
        query = query.eq('id', itemId);
      }
      const { data: items, error } = await query.limit(1000);
      if (error) throw new ActionError(`Vooruitbetaalde kosten ophalen mislukt: ${error.message}`);
      const ready = ((items ?? []) as PrepaidRow[]).filter(prepaidOnBalance).map((p) => p.id);
      if (ready.length === 0) throw new ActionError('Er zijn geen lopende vooruitbetalingen die op de balans staan.');
      const due = await allRows<{ amount_cents: number }>(
        () => orgQuery(ctx, 'prepaid_expense_releases', 'id, amount_cents')
          .in('prepaid_expense_id', ready).eq('status', 'scheduled').lte('date', through).order('id', { ascending: true }),
        'Termijnen');
      if (due.length === 0) throw new ActionError(`Er staan geen termijnen open t/m ${through}${label ? ` voor ${label}` : ''}.`);
      const total = due.reduce((sum, r) => sum + Number(r.amount_cents ?? 0), 0);
      return {
        title: `Vooruitbetaalde kosten boeken t/m ${through}${label ? `: ${label}` : ''}`,
        sub: joinShort([`${due.length} termijn${due.length === 1 ? '' : 'en'} · ${euroCents(total)} van de balans naar de kosten`], 180),
        warning: `Er komen ${due.length} definitieve journaalposten in het grootboek; corrigeren kan alleen met tegenboeken.`,
        kind: 'money',
        payload: { through_date: through, prepaid_expense_id: itemId, label, count: due.length, total_cents: total },
      };
    },
  },

  {
    id: 'prepaid.end',
    label: 'Vooruitbetaling eerder beëindigen',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Beëindigt een vooruitbetaling die eerder stopt, bijvoorbeeld een opgezegde verzekering. Eerst gaan de termijnen t/m de einddatum naar de kosten; wat er dan nog op de balans staat, gaat in één keer weg: een terugbetaling (refund_eur) naar refund_account_id (standaard 1100 Bank) en de rest naar de kostenrekening. De overige termijnen vervallen. ' +
      'De einddatum ligt niet vóór de maand van de laatst geboekte termijn en niet na het einde van deze maand. DIT IS EEN DEFINITIEVE BOEKING; terugdraaien kan met tegenboeken.',
    keywords: ['opzeggen', 'opgezegd', 'beëindigen', 'stoppen', 'eerder stoppen', 'terugbetaling', 'restitutie', 'vooruitbetaald', 'vooruitbetaling', 'verzekering opgezegd'],
    input: {
      prepaid_expense_id: { type: 'string', description: 'Id uit prepaid.list.' },
      date: { type: 'string', description: 'Einddatum JJJJ-MM-DD; standaard vandaag.' },
      refund_eur: { type: 'number', description: 'Wat je terugkrijgt, in euro (standaard 0).' },
      refund_account_id: { type: 'string', description: 'Waar de terugbetaling op komt; standaard 1100 Bank.' },
    },
    required: ['prepaid_expense_id'],
    async plan(ctx, input) {
      const itemId = id(input, 'prepaid_expense_id');
      const item = await row<PrepaidRow>(ctx, 'prepaid_expenses', itemId,
        'id, description, amount_cents, months, start_date, payment_date, start_mode, start_journal_entry_id, status, prepaid_account_id, expense_account_id', 'Vooruitbetaling');
      if (item.status !== 'active') throw new ActionError(`${item.description} is al afgerond of beëindigd.`);
      if (!prepaidOnBalance(item)) throw new ActionError(`Het bedrag van ${item.description} staat nog niet op de balans; er valt niets te beëindigen. Verwijder de post in het scherm Vooruitbetaald als hij weg moet.`);
      const date = optIsoDate(input, 'date') ?? ctx.today;
      const lastAllowed = prepaidMonthEnd(ctx.today);
      if (date > lastAllowed) throw new ActionError(`Je beëindigt een post uiterlijk per het einde van deze maand (${lastAllowed}).`);

      const { data, error } = await orgQuery(ctx, 'prepaid_expense_releases', 'date, amount_cents, status').eq('prepaid_expense_id', itemId).limit(1000);
      if (error) throw new ActionError(`Schema ophalen mislukt: ${error.message}`);
      const releases = (data ?? []) as Array<{ date: string; amount_cents: number; status: string }>;
      const posted = releases.filter((r) => r.status === 'posted');
      const lastPosted = posted.map((r) => r.date).sort().pop() ?? null;
      if (lastPosted && date < `${lastPosted.slice(0, 8)}01`) {
        throw new ActionError(`De termijn van ${prepaidMonthLabel(lastPosted)} is al geboekt. Kies een einddatum vanaf ${lastPosted.slice(0, 8)}01, of draai die termijnen eerst terug.`);
      }
      const dueBefore = releases.filter((r) => r.status === 'scheduled' && r.date <= date);
      const rest = Number(item.amount_cents) - posted.reduce((s, r) => s + Number(r.amount_cents), 0) - dueBefore.reduce((s, r) => s + Number(r.amount_cents), 0);
      const refund = optCents(input, 'refund_eur') ?? 0;
      if (refund < 0) throw new ActionError('Een terugbetaling kan niet negatief zijn.');
      if (refund > rest) throw new ActionError(`De terugbetaling (${euroCents(refund)}) is hoger dan wat er dan nog op de balans staat (${euroCents(rest)}).`);
      let refundAccount: AccountRow | null = null;
      if (refund > 0) {
        const given = optId(input, 'refund_account_id');
        refundAccount = given ? await loadAccount(ctx, given, 'Rekening van de terugbetaling') : await accountByCode(ctx, '1100');
        if (!refundAccount) throw new ActionError('Geen rekening voor de terugbetaling gekozen en 1100 Bank bestaat niet. Geef "refund_account_id" mee.');
        if (['revenue', 'expense'].includes(refundAccount.type) || VAT_SUBTYPES.includes(refundAccount.subtype ?? '') || refundAccount.id === item.prepaid_account_id) {
          throw new ActionError(`${accountLabel(refundAccount)} kan niet; kies de bank of een vordering.`);
        }
      }
      return {
        title: `Vooruitbetaling beëindigen per ${date}: ${item.description}`,
        sub: joinShort([
          dueBefore.length ? `eerst ${dueBefore.length} termijn${dueBefore.length === 1 ? '' : 'en'} t/m ${date} naar de kosten` : null,
          refund > 0 ? `${euroCents(refund)} terug naar ${accountLabel(refundAccount!)}` : null,
          rest - refund > 0 ? `${euroCents(rest - refund)} in één keer naar de kosten` : null,
          'de overige termijnen vervallen',
        ], 260),
        warning: 'De post stopt en de geplande termijnen vervallen. Terugdraaien kan met tegenboeken in het Grootboek.',
        kind: 'money',
        payload: { prepaid_expense_id: itemId, description: item.description, date, refund_cents: refund, refund_account_id: refundAccount?.id ?? null },
      };
    },
  },
];
