import {
  ActionError, bool, choice, euroCents, id, isoDate, joinShort, optChoice, optId,
  optIsoDate, optStr, orgQuery, row,
  type ActionCtx, type ActionDef,
} from './types.ts';

/**
 * Handelingen rond RAPPORTAGE EN INZICHT: de eigen rapportages van de
 * Statistieken-pagina, en de vaste financiële overzichten die rechtstreeks uit het
 * grootboek komen.
 *
 * Wat hier NIET staat en ook niet hoort:
 *  - Een rapportage OPSTELLEN. Dat doet `propose_report`: die opent de rapportbouwer
 *    vooringevuld met een live grafiek, zodat de gebruiker ziet wat hij opslaat.
 *    Hier gaat het alleen om een rapportage die al bestaat.
 *  - CSV-exports. Die leveren een bestand op de schijf van de gebruiker af; een
 *    agent heeft geen schijf. De cijfers zelf lees je hieronder gewoon uit.
 *
 * De vijf grootboekoverzichten zijn ALLEEN LEZEN. Ze rekenen over geboekte
 * journaalposten; boeken, afletteren en aangifte doen blijft handwerk.
 */

// ── Rubrieken van de jaarrekening ───────────────────────────────────────────
// Dezelfde sleutels als `LedgerReportGroup` in src/types.ts. Bewust hier herhaald
// en niet geïmporteerd: dit is Deno-code die niet bij de browserbundel kan. Het is
// een vaste, wettelijke indeling (art. 2:364 / 2:377 BW) die niet meebeweegt.
const GROUP_LABELS: Record<string, string> = {
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
  netto_omzet: 'Netto-omzet',
  overige_bedrijfsopbrengsten: 'Overige bedrijfsopbrengsten',
  inkoopwaarde: 'Kosten van grond- en hulpstoffen en uitbesteed werk',
  personeelskosten: 'Lonen, sociale lasten en pensioenlasten',
  afschrijvingen: 'Afschrijvingen',
  overige_bedrijfskosten: 'Overige bedrijfskosten',
  financiele_baten: 'Rentebaten en soortgelijke opbrengsten',
  financiele_lasten: 'Rentelasten en soortgelijke kosten',
  belastingen: 'Belastingen',
  resultaat_deelnemingen: 'Aandeel in resultaat van deelnemingen',
};

const groupLabel = (key: string | null | undefined) => (key ? GROUP_LABELS[key] ?? key : 'Zonder rubriek');

/**
 * Het veldregister van de rapportbouwer, zoals `src/lib/reporting.ts` het kent en
 * `propose_report` het valideert. Hier alleen nodig om een BESTAANDE rapportage
 * opnieuw te definiëren; een verzonnen bron- of veldsleutel levert anders een
 * rapportage op die leeg op het dashboard staat.
 */
interface ReportSourceSchema {
  label: string;
  dimensions: string[];
  measures: string[];
  enums: Record<string, string[]>;
  dateFields: string[];
}

const REPORT_SCHEMA: Record<string, ReportSourceSchema> = {
  invoices: {
    label: 'Facturen', dimensions: ['client', 'status', 'date'], measures: ['amount'],
    enums: { status: ['draft', 'sent', 'overdue', 'paid', 'cancelled', 'void', 'written_off', 'refunded'] }, dateFields: ['date'],
  },
  quotes: {
    label: 'Offertes', dimensions: ['status', 'client', 'date'], measures: ['amount'],
    enums: { status: ['draft', 'pending_internal_approval', 'internally_approved', 'sent', 'accepted', 'rejected', 'expired', 'paid', 'overdue', 'cancelled'] }, dateFields: ['date'],
  },
  purchase_invoices: {
    label: 'Inkoopfacturen', dimensions: ['supplier', 'status', 'date'], measures: ['amount'],
    enums: { status: ['draft', 'booked', 'paid', 'cancelled'] }, dateFields: ['date'],
  },
  clients: {
    label: 'Klanten', dimensions: ['status', 'created'], measures: ['value'],
    enums: { status: ['active', 'prospect', 'inactive'] }, dateFields: ['created'],
  },
  projects: {
    label: 'Projecten', dimensions: ['client', 'state', 'created'], measures: [],
    enums: { state: ['active', 'archived'] }, dateFields: ['created'],
  },
  tasks: {
    label: 'Taken', dimensions: ['status', 'priority', 'project', 'created', 'deadline'], measures: ['minutes'],
    enums: { status: ['todo', 'doing', 'review', 'done'], priority: ['low', 'med', 'high'] }, dateFields: ['created', 'deadline'],
  },
  tickets: {
    label: 'Tickets', dimensions: ['status', 'priority', 'client', 'created'], measures: [],
    enums: { status: ['new', 'review', 'approved', 'rejected', 'converted'], priority: ['low', 'med', 'high'] }, dateFields: ['created'],
  },
};

const REPORT_AGGS = ['count', 'sum', 'avg', 'min', 'max'] as const;
const REPORT_GRANS = ['day', 'week', 'month', 'quarter', 'year'] as const;
const REPORT_PRESETS = ['all', 'this_month', 'last_month', 'this_quarter', 'this_year', 'last_12m'] as const;
const PRESET_LABELS: Record<string, string> = {
  all: 'Alles', this_month: 'Deze maand', last_month: 'Vorige maand',
  this_quarter: 'Dit kwartaal', this_year: 'Dit jaar', last_12m: 'Laatste 12 maanden',
};

interface ReportDefinitionLite {
  source: string;
  measure: { field: string; agg: string };
  dimension: string | null;
  granularity: string;
  filters: Array<{ field: string; value: string }>;
  datePreset: string;
  chart: string;
}

/** Bouwt een geldige rapportdefinitie of legt uit wat er niet klopt. */
function buildDefinition(input: Record<string, unknown>): ReportDefinitionLite {
  const sourceKey = String(input.source ?? '').trim();
  const schema = REPORT_SCHEMA[sourceKey];
  if (!schema) throw new ActionError(`Onbekende bron "${sourceKey}". Kies uit: ${Object.keys(REPORT_SCHEMA).join(', ')}.`);

  const agg = choice(input, 'measure_agg', REPORT_AGGS);
  let field = '*';
  if (agg !== 'count') {
    field = String(input.measure_field ?? '').trim();
    if (!schema.measures.includes(field)) {
      throw new ActionError(schema.measures.length
        ? `Voor "${sourceKey}" kun je met ${agg} alleen meten op: ${schema.measures.join(', ')}. Of gebruik measure_agg=count.`
        : `Voor "${sourceKey}" is alleen measure_agg=count (Aantal) beschikbaar.`);
    }
  }

  let dimension: string | null = null;
  const dimRaw = String(input.dimension ?? '').trim();
  if (dimRaw) {
    if (!schema.dimensions.includes(dimRaw)) {
      throw new ActionError(`Voor "${sourceKey}" kun je groeperen op: ${schema.dimensions.join(', ')} (of laat dimension leeg voor één totaal).`);
    }
    dimension = dimRaw;
  }

  const granularity = optChoice(input, 'granularity', REPORT_GRANS) ?? 'month';
  const datePreset = optChoice(input, 'date_preset', REPORT_PRESETS) ?? 'this_year';

  const filters: Array<{ field: string; value: string }> = [];
  if (Array.isArray(input.filters)) {
    for (const raw of input.filters as Record<string, unknown>[]) {
      const filterField = String(raw?.field ?? '').trim();
      const filterValue = String(raw?.value ?? '').trim();
      if (!filterField || !filterValue) continue;
      const allowed = schema.enums[filterField];
      if (!allowed) throw new ActionError(`Op "${sourceKey}" kun je niet filteren op "${filterField}". Filterbaar: ${Object.keys(schema.enums).join(', ') || 'niets'}.`);
      if (!allowed.includes(filterValue)) throw new ActionError(`Ongeldige waarde "${filterValue}" voor filter ${filterField}. Kies uit: ${allowed.join(', ')}.`);
      filters.push({ field: filterField, value: filterValue });
    }
  }

  const dimIsDate = dimension ? schema.dateFields.includes(dimension) : false;
  const allowedCharts = !dimension ? ['kpi', 'table'] : dimIsDate ? ['line', 'bar', 'table'] : ['bar', 'pie', 'table'];
  const chart = allowedCharts.includes(String(input.chart ?? '')) ? String(input.chart) : allowedCharts[0];

  return { source: sourceKey, measure: { field, agg }, dimension, granularity, filters, datePreset, chart };
}

/** Korte leesregel voor op de goedkeurkaart: "Facturen · sum·amount · per client · Dit jaar". */
function describeDefinition(def: ReportDefinitionLite): string {
  const schema = REPORT_SCHEMA[def.source];
  const parts = [
    schema?.label ?? def.source,
    def.measure.agg === 'count' ? 'aantal' : `${def.measure.agg} · ${def.measure.field}`,
    def.dimension ? `per ${def.dimension}` : 'één totaal',
    PRESET_LABELS[def.datePreset] ?? def.datePreset,
    ...def.filters.map((f) => `${f.field}: ${f.value}`),
  ];
  return parts.join(' · ');
}

// ── Grootboekoverzichten: gedeelde hulpjes ──────────────────────────────────

/** Roept een rapport-RPC aan. De service-role slaat de can_read_org-check over, dus
 *  het organisatie-id uit de geverifieerde sessie is hier de enige grens. */
async function callReport<T>(ctx: ActionCtx, fn: string, params: Record<string, unknown>, label: string): Promise<T> {
  const { data, error } = await ctx.db.rpc(fn, { p_organization_id: ctx.organizationId, ...params });
  if (error) throw new ActionError(`${label} ophalen mislukt: ${error.message}`);
  return data as T;
}

interface PnlRow { account_id: string | null; code: string | null; name: string; account_type: 'revenue' | 'expense'; report_group: string | null; group_rank: number | null; amount_cents: number }
interface BalanceRow { account_id: string | null; code: string | null; name: string; section: 'asset' | 'liability' | 'equity' | 'result'; report_group: string | null; group_rank: number | null; amount_cents: number }
interface TrialRow { account_id: string; code: string; name: string; account_type: string; debit_cents: number; credit_cents: number; balance_cents: number }
interface LedgerCardRow { entry_id: string | null; entry_number: string | null; date: string | null; description: string | null; debit_cents: number; credit_cents: number; running_balance_cents: number }
interface OpenItemsSide { rows: Record<string, unknown>[]; open_total_cents: number; gl_balance_cents: number; unmatched_cents: number }
interface OpenItems { as_of: string; receivables: OpenItemsSide; payables: OpenItemsSide }

/**
 * Voegt de regels van twee peilmomenten samen tot rubrieken, net als het scherm.
 * Een rekening die alleen in de vergelijkende periode voorkomt hoort er ook bij te
 * staan — met nul in de huidige kolom — anders lijkt een gestopte post verdwenen.
 */
function groupByRubriek<T extends { account_id: string | null; code: string | null; name: string; report_group: string | null; group_rank: number | null; amount_cents: number }>(
  current: T[], previous: T[], sign: (r: T) => number, fallback: (r: T) => string,
) {
  interface Line { code: string | null; name: string; amount_cents: number; previous_cents: number }
  interface Block { group: string; label: string; rank: number; amount_cents: number; previous_cents: number; accounts: Line[]; index: Map<string, Line> }
  const blocks = new Map<string, Block>();
  const absorb = (rows: T[], field: 'amount_cents' | 'previous_cents') => {
    for (const r of rows) {
      const group = r.report_group ?? fallback(r);
      let block = blocks.get(group);
      if (!block) {
        block = { group, label: groupLabel(group), rank: r.group_rank ?? 999, amount_cents: 0, previous_cents: 0, accounts: [], index: new Map() };
        blocks.set(group, block);
      }
      const key = r.account_id ?? r.code ?? r.name;
      let line = block.index.get(key);
      if (!line) {
        line = { code: r.code, name: r.name, amount_cents: 0, previous_cents: 0 };
        block.index.set(key, line);
        block.accounts.push(line);
      }
      const amount = sign(r) * Number(r.amount_cents ?? 0);
      line[field] += amount;
      block[field] += amount;
    }
  };
  absorb(current, 'amount_cents');
  absorb(previous, 'previous_cents');
  return [...blocks.values()]
    .map(({ index: _index, ...block }) => block)
    .sort((a, b) => a.rank - b.rank || a.group.localeCompare(b.group));
}

const sumOf = <T>(rows: T[], pick: (r: T) => number) => rows.reduce((t, r) => t + pick(r), 0);

/** Peildatum of vandaag; de RPC's rekenen tot en met deze dag. */
function asOfOr(ctx: ActionCtx, input: Record<string, unknown>, key = 'as_of'): string {
  return optIsoDate(input, key) ?? ctx.today;
}

export const INSIGHT_ACTIONS: ActionDef[] = [
  // ── Eigen rapportages ─────────────────────────────────────────────────────
  {
    id: 'saved_report.list',
    label: 'Opgeslagen rapportages bekijken',
    module: 'stats',
    kind: 'read',
    description:
      'Geeft de rapportages onder "Mijn rapportages" op de Statistieken-pagina: naam, of hij op het dashboard gepind staat, en de definitie (bron, meetwaarde, groepering, periode en filters). ' +
      'Gebruik dit om het id te vinden voordat je een rapportage bijwerkt of pint. De uitkomst zelf wordt in de browser doorgerekend en staat hier niet bij.',
    keywords: ['rapportage', 'rapport', 'statistieken', 'mijn rapportages', 'opgeslagen', 'dashboard', 'gepind', 'grafiek'],
    input: {
      pinned_only: { type: 'boolean', description: 'Alleen de rapportages die op het startscherm staan.' },
      limit: { type: 'number', description: 'Maximaal aantal (standaard 50).' },
    },
    async read(ctx, input) {
      const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 200);
      let query = orgQuery(ctx, 'saved_reports', 'id, name, is_pinned, position, definition, created_at, updated_at')
        .order('created_at', { ascending: false }).limit(limit);
      if (bool(input, 'pinned_only', false)) query = query.eq('is_pinned', true);
      const { data, error } = await query;
      if (error) throw new ActionError(`Rapportages ophalen mislukt: ${error.message}`);
      const reports = (data ?? []) as Array<Record<string, unknown>>;
      return {
        reports: reports.map((r) => ({
          ...r,
          summary: describeDefinition((r.definition ?? {}) as ReportDefinitionLite),
        })),
        pinned_count: reports.filter((r) => r.is_pinned === true).length,
      };
    },
  },

  {
    id: 'saved_report.update',
    label: 'Opgeslagen rapportage hernoemen of opnieuw definiëren',
    module: 'stats',
    kind: 'write',
    description:
      'Werkt een BESTAANDE opgeslagen rapportage bij: alleen de naam, of ook de definitie. Zoek hem eerst met `saved_report.list` en gebruik het exacte id. ' +
      'Wil je een NIEUWE rapportage maken, gebruik dan `propose_report` — die opent de bouwer met een live grafiek zodat de gebruiker ziet wat hij opslaat. ' +
      'Geef je `source`, dan wordt de definitie in zijn geheel vervangen; alle andere definitievelden horen daar dan bij (wat je weglaat valt terug op de standaard). Geef je `source` niet, dan blijft de definitie ongemoeid. ' +
      'Gebruik EXACT deze bron- en veldsleutels: ' +
      'invoices (client|status|date · sum/avg van amount · status∈[draft,sent,overdue,paid,cancelled,void,written_off,refunded]) · ' +
      'quotes (status|client|date · sum/avg van amount) · ' +
      'purchase_invoices (supplier|status|date · sum/avg van amount · status∈[draft,booked,paid,cancelled]) · ' +
      'clients (status|created · sum/avg van value) · projects (client|state|created · alleen count) · ' +
      'tasks (status|priority|project|created|deadline · sum/avg van minutes) · tickets (status|priority|client|created · alleen count). ' +
      'Let op: staat de rapportage op het dashboard, dan verandert de widget op het startscherm meteen mee.',
    keywords: ['rapportage', 'rapport', 'hernoemen', 'aanpassen', 'wijzigen', 'definitie', 'statistieken', 'grafiek', 'overschrijven'],
    input: {
      report_id: { type: 'string', description: 'Id van de opgeslagen rapportage (exact, uit saved_report.list).' },
      name: { type: 'string', description: 'Nieuwe naam. Laat weg om de naam te laten staan.' },
      source: { type: 'string', enum: Object.keys(REPORT_SCHEMA), description: 'Gegevensbron. Alleen meegeven als de definitie moet veranderen.' },
      measure_agg: { type: 'string', enum: [...REPORT_AGGS], description: 'count (aantal) of een berekening over een getalveld.' },
      measure_field: { type: 'string', description: "Getalveld bij sum/avg/min/max ('amount', 'value', 'minutes'). Weglaten bij count." },
      dimension: { type: 'string', description: 'Veld om op te groeperen. Leeg = één totaal (kerncijfer).' },
      granularity: { type: 'string', enum: [...REPORT_GRANS], description: 'Alleen bij een datum-dimensie.' },
      date_preset: { type: 'string', enum: [...REPORT_PRESETS], description: 'Periodefilter (standaard this_year).' },
      filters: {
        type: 'array', description: 'Status-/categoriefilters.',
        items: { type: 'object', properties: { field: { type: 'string' }, value: { type: 'string' } }, required: ['field', 'value'] },
      },
      chart: { type: 'string', enum: ['bar', 'line', 'pie', 'table', 'kpi'], description: 'Weergave.' },
    },
    required: ['report_id'],
    async plan(ctx, input) {
      const reportId = id(input, 'report_id');
      const report = await row<{ name: string; is_pinned: boolean; definition: ReportDefinitionLite }>(
        ctx, 'saved_reports', reportId, 'name, is_pinned, definition', 'Rapportage');

      const patch: Record<string, unknown> = {};
      const newName = optStr(input, 'name', 120);
      if (newName && newName !== report.name) patch.name = newName;

      const wantsDefinition = String(input.source ?? '').trim() !== '';
      const definitionKeys = ['measure_agg', 'measure_field', 'dimension', 'granularity', 'date_preset', 'filters', 'chart'];
      if (!wantsDefinition && definitionKeys.some((k) => input[k] !== undefined && input[k] !== null && input[k] !== '')) {
        throw new ActionError('Om de definitie te wijzigen hoort "source" erbij — de definitie wordt in zijn geheel vervangen, niet per veld.');
      }
      let described: string | null = null;
      if (wantsDefinition) {
        const definition = buildDefinition(input);
        patch.definition = definition;
        described = describeDefinition(definition);
      }
      if (Object.keys(patch).length === 0) throw new ActionError('Geef een nieuwe naam of een nieuwe definitie (source + velden).');

      return {
        title: patch.definition
          ? `Rapportage opnieuw definiëren: ${report.name}`
          : `Rapportage hernoemen: ${report.name} → ${newName}`,
        sub: joinShort([
          patch.name && patch.definition ? `nieuwe naam "${newName}"` : null,
          described,
          report.is_pinned ? 'staat op het dashboard: de widget verandert mee' : null,
        ]) || 'naam bijwerken',
        kind: 'insight',
        payload: { report_id: reportId, report_name: newName ?? report.name, patch },
      };
    },
  },

  {
    id: 'saved_report.set_pinned',
    label: 'Rapportage op het dashboard pinnen of losmaken',
    module: 'stats',
    kind: 'write',
    description:
      'Zet een opgeslagen rapportage als live widget op het startscherm (gepind) of haalt hem daar weer af. De rapportage zelf blijft gewoon bestaan; alleen de plek op het dashboard verandert. ' +
      'Een gepinde rapportage wordt bij elk bezoek aan het startscherm opnieuw doorgerekend en getoond als minigrafiek met totaal. Zoek de rapportage eerst met `saved_report.list`.',
    keywords: ['pin', 'pinnen', 'losmaken', 'unpin', 'dashboard', 'startscherm', 'widget', 'rapportage', 'vastzetten'],
    input: {
      report_id: { type: 'string', description: 'Id van de opgeslagen rapportage (exact, uit saved_report.list).' },
      is_pinned: { type: 'boolean', description: 'true = op het dashboard zetten, false = eraf halen.' },
    },
    required: ['report_id', 'is_pinned'],
    async plan(ctx, input) {
      const reportId = id(input, 'report_id');
      const report = await row<{ name: string; is_pinned: boolean; definition: ReportDefinitionLite }>(
        ctx, 'saved_reports', reportId, 'name, is_pinned, definition', 'Rapportage');
      const pinned = bool(input, 'is_pinned', true);
      if (report.is_pinned === pinned) {
        throw new ActionError(`"${report.name}" staat al ${pinned ? 'op het dashboard' : 'los van het dashboard'}.`);
      }
      return {
        title: pinned ? `Rapportage op het dashboard: ${report.name}` : `Rapportage van het dashboard halen: ${report.name}`,
        sub: joinShort([
          describeDefinition(report.definition ?? {} as ReportDefinitionLite),
          pinned ? 'verschijnt als minigrafiek op het startscherm' : 'verdwijnt van het startscherm',
        ]),
        kind: 'insight',
        payload: { report_id: reportId, report_name: report.name, is_pinned: pinned },
      };
    },
  },

  // ── Grootboekoverzichten (alleen lezen) ───────────────────────────────────
  {
    id: 'ledger.profit_and_loss',
    label: 'Winst- en verliesrekening opvragen',
    module: 'finance',
    kind: 'read',
    description:
      'Berekent de winst- en verliesrekening over een periode uit de GEBOEKTE journaalposten, gerubriceerd volgens de wettelijke indeling (netto-omzet, inkoopwaarde, personeelskosten, afschrijvingen, overige bedrijfskosten, financiële baten en lasten, belastingen). ' +
      'Bedragen staan in centen en positief georiënteerd: een opbrengst is credit − debet, een kostenpost debet − credit. Het resultaat is opbrengsten − kosten. ' +
      'Geef `compare_from` en `compare_to` mee om er een vergelijkende periode naast te zetten (bijvoorbeeld hetzelfde bereik een jaar eerder). ' +
      'Alleen lezen: dit rekent, het boekt niets. Conceptboekingen tellen niet mee.',
    keywords: ['winst', 'verlies', 'w&v', 'resultaat', 'wenv', 'exploitatie', 'omzet', 'kosten', 'resultatenrekening', 'winst en verliesrekening', 'jaarrekening'],
    input: {
      from: { type: 'string', description: 'Begindatum JJJJ-MM-DD.' },
      to: { type: 'string', description: 'Einddatum JJJJ-MM-DD (tot en met).' },
      compare_from: { type: 'string', description: 'Begindatum van de vergelijkende periode (optioneel).' },
      compare_to: { type: 'string', description: 'Einddatum van de vergelijkende periode (optioneel).' },
    },
    required: ['from', 'to'],
    async read(ctx, input) {
      const from = isoDate(input, 'from');
      const to = isoDate(input, 'to');
      if (from > to) throw new ActionError('"from" ligt na "to".');
      const compareFrom = optIsoDate(input, 'compare_from');
      const compareTo = optIsoDate(input, 'compare_to');
      if ((compareFrom === null) !== (compareTo === null)) {
        throw new ActionError('Geef bij een vergelijking zowel "compare_from" als "compare_to".');
      }

      const current = await callReport<PnlRow[]>(ctx, 'report_profit_and_loss', { p_from: from, p_to: to }, 'Winst- en verliesrekening') ?? [];
      const previous = compareFrom && compareTo
        ? await callReport<PnlRow[]>(ctx, 'report_profit_and_loss', { p_from: compareFrom, p_to: compareTo }, 'Vergelijkende winst- en verliesrekening') ?? []
        : [];

      // De rubriek van een W&V-rekening kan in de database elke waarde hebben. Wat
      // buiten de W&V-rubrieken valt gaat naar de restgroep van zijn eigen soort,
      // zodat er nooit een bedrag buiten het resultaat valt.
      const fallback = (r: PnlRow) => (r.account_type === 'revenue' ? 'overige_bedrijfsopbrengsten' : 'overige_bedrijfskosten');
      const groups = groupByRubriek<PnlRow>(current, previous, () => 1, fallback);

      const totalsFor = (rows: PnlRow[]) => {
        const revenue = sumOf(rows.filter((r) => r.account_type === 'revenue'), (r) => Number(r.amount_cents ?? 0));
        const expense = sumOf(rows.filter((r) => r.account_type === 'expense'), (r) => Number(r.amount_cents ?? 0));
        return { revenue_cents: revenue, expense_cents: expense, result_cents: revenue - expense };
      };
      const totals = totalsFor(current);
      const compareTotals = compareFrom ? totalsFor(previous) : null;

      return {
        period: { from, to },
        compare_period: compareFrom && compareTo ? { from: compareFrom, to: compareTo } : null,
        groups,
        totals,
        compare_totals: compareTotals,
        summary: joinShort([
          `omzet ${euroCents(totals.revenue_cents)}`,
          `kosten ${euroCents(totals.expense_cents)}`,
          `resultaat ${euroCents(totals.result_cents)}`,
        ], 200),
        note: current.length === 0 ? 'Geen geboekte journaalposten in deze periode.' : null,
      };
    },
  },

  {
    id: 'ledger.balance_sheet',
    label: 'Balans opvragen op peildatum',
    module: 'finance',
    kind: 'read',
    description:
      'Geeft de balans op een peildatum uit de geboekte journaalposten: activa, passiva en eigen vermogen, per wettelijke rubriek. ' +
      'De regel "Resultaat lopend boekjaar" is het resultaat van nog niet afgesloten boekjaren; zodra een boekjaar is afgesloten staat dat bedrag op de eigen-vermogenrekening. ' +
      'Bedragen in centen, positief georiënteerd per zijde (activa = debet − credit, passiva en eigen vermogen = credit − debet). Activa en passiva horen gelijk te zijn. ' +
      'Geef `compare_as_of` mee voor een vergelijkende peildatum.',
    keywords: ['balans', 'activa', 'passiva', 'eigen vermogen', 'balanstotaal', 'peildatum', 'vermogen', 'jaarrekening'],
    input: {
      as_of: { type: 'string', description: 'Peildatum JJJJ-MM-DD. Standaard vandaag.' },
      compare_as_of: { type: 'string', description: 'Vergelijkende peildatum (optioneel), bijvoorbeeld een jaar eerder.' },
    },
    async read(ctx, input) {
      const asOf = asOfOr(ctx, input);
      const compareAsOf = optIsoDate(input, 'compare_as_of');

      const current = await callReport<BalanceRow[]>(ctx, 'report_balance_sheet', { p_as_of: asOf }, 'Balans') ?? [];
      const previous = compareAsOf
        ? await callReport<BalanceRow[]>(ctx, 'report_balance_sheet', { p_as_of: compareAsOf }, 'Vergelijkende balans') ?? []
        : [];

      const fallback = (r: BalanceRow) =>
        r.section === 'asset' ? 'vorderingen' : r.section === 'liability' ? 'kortlopende_schulden' : 'eigen_vermogen';
      const isAsset = (r: BalanceRow) => r.section === 'asset';
      const assets = groupByRubriek<BalanceRow>(current.filter(isAsset), previous.filter(isAsset), () => 1, fallback);
      const liabilities = groupByRubriek<BalanceRow>(current.filter((r) => !isAsset(r)), previous.filter((r) => !isAsset(r)), () => 1, fallback);

      const totalsFor = (rows: BalanceRow[]) => ({
        assets_cents: sumOf(rows.filter(isAsset), (r) => Number(r.amount_cents ?? 0)),
        liabilities_and_equity_cents: sumOf(rows.filter((r) => !isAsset(r)), (r) => Number(r.amount_cents ?? 0)),
      });
      const totals = totalsFor(current);
      const compareTotals = compareAsOf ? totalsFor(previous) : null;
      const difference = totals.assets_cents - totals.liabilities_and_equity_cents;

      return {
        as_of: asOf,
        compare_as_of: compareAsOf,
        assets,
        liabilities_and_equity: liabilities,
        totals,
        compare_totals: compareTotals,
        balances: difference === 0,
        summary: joinShort([
          `activa ${euroCents(totals.assets_cents)}`,
          `passiva ${euroCents(totals.liabilities_and_equity_cents)}`,
          difference === 0 ? 'in evenwicht' : `verschil ${euroCents(difference)}`,
        ], 200),
      };
    },
  },

  {
    id: 'ledger.trial_balance',
    label: 'Proef- en saldibalans opvragen',
    module: 'finance',
    kind: 'read',
    description:
      'Geeft de proef-/saldibalans op een peildatum: per grootboekrekening het totaal debet, het totaal credit en het saldo (debet − credit), over alle geboekte journaalposten tot en met die datum. ' +
      'Omdat elke boeking sluit, hoort het totaal debet gelijk te zijn aan het totaal credit — loopt dat uiteen, dan is er iets mis met de administratie. Gebruik dit als controlemiddel of om een rekeningsaldo op te zoeken.',
    keywords: ['proefbalans', 'saldibalans', 'kolommenbalans', 'debet', 'credit', 'saldo', 'grootboek', 'controle', 'aansluiting'],
    input: {
      as_of: { type: 'string', description: 'Peildatum JJJJ-MM-DD. Standaard vandaag.' },
      account_type: { type: 'string', enum: ['asset', 'liability', 'equity', 'revenue', 'expense'], description: 'Beperk tot één soort rekening.' },
    },
    async read(ctx, input) {
      const asOf = asOfOr(ctx, input);
      const type = optChoice(input, 'account_type', ['asset', 'liability', 'equity', 'revenue', 'expense'] as const);
      const all = await callReport<TrialRow[]>(ctx, 'report_trial_balance', { p_as_of: asOf }, 'Proefbalans') ?? [];
      const rows = type ? all.filter((r) => r.account_type === type) : all;
      const debit = sumOf(all, (r) => Number(r.debit_cents ?? 0));
      const credit = sumOf(all, (r) => Number(r.credit_cents ?? 0));
      return {
        as_of: asOf,
        account_type: type,
        rows,
        // De aansluiting geldt over ALLE rekeningen; filteren verandert daar niets aan.
        totals: { debit_cents: debit, credit_cents: credit, difference_cents: debit - credit },
        balances: debit === credit,
        summary: joinShort([
          `${rows.length} rekening${rows.length === 1 ? '' : 'en'}`,
          `debet ${euroCents(debit)}`,
          `credit ${euroCents(credit)}`,
          debit === credit ? 'sluit' : `SLUIT NIET: verschil ${euroCents(debit - credit)}`,
        ], 200),
      };
    },
  },

  {
    id: 'ledger.account_card',
    label: 'Grootboekkaart van één rekening opvragen',
    module: 'finance',
    kind: 'read',
    description:
      'Geeft de grootboekkaart van één rekening over een periode: alle geboekte mutaties met datum, boekstuknummer, omschrijving, debet, credit en het lopende saldo. ' +
      'De eerste regel is het BEGINSALDO: de netto beweging (debet − credit) op die rekening vóór de begindatum; die regel heeft geen datum en geen boekstuknummer. ' +
      'Geef de rekening op met `account_id` of met `account_code` (het nummer uit het rekeningschema, bijvoorbeeld "1300"). Zoek hem anders eerst op met `list_ledger_accounts`.',
    keywords: ['grootboekkaart', 'grootboek', 'rekening', 'mutaties', 'kaart', 'boekstuk', 'saldo', 'rekeningnummer', 'kolom'],
    input: {
      account_id: { type: 'string', description: 'Id van de grootboekrekening (exact).' },
      account_code: { type: 'string', description: 'Of het rekeningnummer uit het schema, bijvoorbeeld "1300".' },
      from: { type: 'string', description: 'Begindatum JJJJ-MM-DD.' },
      to: { type: 'string', description: 'Einddatum JJJJ-MM-DD (tot en met).' },
      limit: { type: 'number', description: 'Maximaal aantal mutatieregels (standaard 100).' },
    },
    required: ['from', 'to'],
    async read(ctx, input) {
      const from = isoDate(input, 'from');
      const to = isoDate(input, 'to');
      if (from > to) throw new ActionError('"from" ligt na "to".');
      const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 500);

      const accountId = optId(input, 'account_id');
      const code = optStr(input, 'account_code', 20);
      if (!accountId && !code) throw new ActionError('Geef "account_id" of "account_code" van de grootboekrekening.');

      let account: { id: string; code: string; name: string; type: string };
      if (accountId) {
        account = await row<{ id: string; code: string; name: string; type: string }>(
          ctx, 'ledger_accounts', accountId, 'id, code, name, type', 'Grootboekrekening');
      } else {
        const { data, error } = await orgQuery(ctx, 'ledger_accounts', 'id, code, name, type').eq('code', code).maybeSingle();
        if (error) throw new ActionError(`Grootboekrekening zoeken mislukt: ${error.message}`);
        if (!data) throw new ActionError(`Er is geen grootboekrekening met code "${code}". Zoek hem op met \`list_ledger_accounts\`.`);
        account = data as { id: string; code: string; name: string; type: string };
      }

      const all = await callReport<LedgerCardRow[]>(
        ctx, 'report_account_ledger', { p_account_id: account.id, p_from: from, p_to: to }, 'Grootboekkaart') ?? [];
      const opening = all.find((r) => r.entry_id === null && r.date === null) ?? null;
      const movements = all.filter((r) => r !== opening);
      const closing = all.length ? Number(all[all.length - 1].running_balance_cents ?? 0) : 0;

      return {
        account: { id: account.id, code: account.code, name: account.name, type: account.type },
        period: { from, to },
        opening_balance_cents: opening ? Number(opening.running_balance_cents ?? 0) : 0,
        rows: movements.slice(0, limit),
        row_count: movements.length,
        truncated: movements.length > limit,
        totals: {
          debit_cents: sumOf(movements, (r) => Number(r.debit_cents ?? 0)),
          credit_cents: sumOf(movements, (r) => Number(r.credit_cents ?? 0)),
          closing_balance_cents: closing,
        },
        summary: joinShort([
          `${account.code} · ${account.name}`,
          `${movements.length} mutatie${movements.length === 1 ? '' : 's'}`,
          `eindsaldo ${euroCents(closing)}`,
        ], 200),
      };
    },
  },

  {
    id: 'ledger.open_items',
    label: 'Openstaande posten (debiteuren en crediteuren) opvragen',
    module: 'finance',
    kind: 'read',
    description:
      'Geeft per factuur en per inkoopfactuur wat er op de peildatum nog openstaat: geboekt − betaald − gecrediteerd, gerekend uit het GROOTBOEK (rekening 1300 debiteuren en 1600 crediteuren). ' +
      'Dit is de harde openstaande-postenlijst: alleen wat werkelijk geboekt is telt mee, dus hij kan afwijken van de factuurstatussen. ' +
      '`gl_balance_cents` is het grootboeksaldo en `unmatched_cents` de beweging die niet aan een factuur is toe te rekenen (beginbalans, vrije boekingen) — is dat niet nul, dan sluit de lijst niet aan op het grootboek en is dat het eerste om uit te zoeken.',
    keywords: ['openstaand', 'openstaande posten', 'debiteuren', 'crediteuren', 'ouderdom', 'nog te ontvangen', 'nog te betalen', 'saldo', 'aansluiting', '1300', '1600'],
    input: {
      as_of: { type: 'string', description: 'Peildatum JJJJ-MM-DD. Standaard vandaag.' },
      side: { type: 'string', enum: ['receivables', 'payables', 'both'], description: 'receivables = debiteuren, payables = crediteuren. Standaard both.' },
      overdue_only: { type: 'boolean', description: 'Alleen posten waarvan de vervaldatum vóór de peildatum ligt.' },
      limit: { type: 'number', description: 'Maximaal aantal regels per zijde (standaard 50).' },
    },
    async read(ctx, input) {
      const asOf = asOfOr(ctx, input);
      const side = optChoice(input, 'side', ['receivables', 'payables', 'both'] as const) ?? 'both';
      const overdueOnly = bool(input, 'overdue_only', false);
      const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 200);

      const report = await callReport<OpenItems>(ctx, 'report_open_items', { p_as_of: asOf }, 'Openstaande posten');
      const empty: OpenItemsSide = { rows: [], open_total_cents: 0, gl_balance_cents: 0, unmatched_cents: 0 };
      const shape = (raw: OpenItemsSide | undefined) => {
        const s = raw ?? empty;
        const rows = (s.rows ?? []).filter((r) => {
          if (!overdueOnly) return true;
          const due = typeof r.due_date === 'string' ? r.due_date : null;
          return due !== null && due < asOf;
        });
        return {
          rows: rows.slice(0, limit),
          row_count: rows.length,
          truncated: rows.length > limit,
          open_total_cents: Number(s.open_total_cents ?? 0),
          gl_balance_cents: Number(s.gl_balance_cents ?? 0),
          unmatched_cents: Number(s.unmatched_cents ?? 0),
        };
      };
      const receivables = side === 'payables' ? null : shape(report?.receivables);
      const payables = side === 'receivables' ? null : shape(report?.payables);

      return {
        as_of: asOf,
        overdue_only: overdueOnly,
        receivables,
        payables,
        summary: joinShort([
          receivables ? `debiteuren ${euroCents(receivables.open_total_cents)} (${receivables.row_count})` : null,
          payables ? `crediteuren ${euroCents(payables.open_total_cents)} (${payables.row_count})` : null,
          receivables && receivables.unmatched_cents !== 0 ? `niet-gekoppeld op 1300: ${euroCents(receivables.unmatched_cents)}` : null,
          payables && payables.unmatched_cents !== 0 ? `niet-gekoppeld op 1600: ${euroCents(payables.unmatched_cents)}` : null,
        ], 220),
      };
    },
  },
];
