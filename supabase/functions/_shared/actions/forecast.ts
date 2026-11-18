import {
  ActionError, bool, id, joinShort, optId, optStr, orgQuery, row, str,
  type ActionCtx, type ActionDef,
} from './types.ts';
import {
  COST_SOURCE_TEXT, DEFAULT_ASSUMPTIONS, FORECAST_FIELDS, ForecastInputError, applyForecastPatch, changeNote,
  computeForecast, describeAssumptions, diffAssumptions, historyRange, monthLabel, normalizeAssumptions,
  numberText, parseForecastInputs, pctText, summarizeForecast, wholeEuroText,
  type ForecastAssumptions, type ForecastInputs, type ForecastResult,
} from '../forecast.ts';

/**
 * Handelingen rond de PROGNOSE (Financiën → Prognose): wat een organisatie de
 * komende maanden verwacht aan nieuwe projecten, omzet, kosten en winst.
 *
 * Gerrie, de agents, de MCP en de API kunnen een prognose lezen en een
 * wijziging KLAARZETTEN; een mens keurt goed, en dan schrijft de browser hem
 * weg langs dezelfde weg als de knop Bewaren (CLAUDE.md, regel 2). De kaart
 * noemt wat er verandert én wat dat doet met de verwachte winst, uitgerekend
 * met dezelfde regels als het scherm (../forecast.ts). Zo weet wie goedkeurt
 * wat hij daarna op de pagina ziet.
 *
 * Elke stand van een prognose bewaart de database (forecast_versions). Een
 * goedgekeurde wijziging die toch niet goed uitpakt, zet je terug met
 * `restore_version`, of op de pagina onder Geschiedenis.
 */

const MAX_FORECASTS = 50;

interface ForecastRow {
  id: string;
  name: string;
  notes: string | null;
  assumptions: unknown;
  version: number;
  change_note: string | null;
  created_at: string;
  updated_at: string;
}

const FORECAST_COLUMNS = 'id, name, notes, assumptions, version, change_note, created_at, updated_at';

/** Bedragen voor het model in euro's, zoals de aannames: dan rekent het niet in twee eenheden. */
const eur = (cents: number) => Math.round(cents) / 100;

function inputError(error: unknown): never {
  if (error instanceof ForecastInputError) throw new ActionError(error.message);
  throw error;
}

/**
 * De cijfers waarop de prognoses rusten: één aanroep voor alle prognoses.
 * forecast_history draait als security definer; de organisatie komt hier uit
 * de sessie. Projecten alleen voor wie Projecten mag lezen: de service-role
 * ziet alles, dus die grens trekken we hier zelf.
 */
async function loadInputs(ctx: ActionCtx, starts: Array<string | null>): Promise<ForecastInputs> {
  const range = historyRange(ctx.today, starts);
  const { data, error } = await ctx.db.rpc('forecast_history', {
    p_from: `${range.from}-01`,
    p_to: `${range.to}-01`,
    p_organization_id: ctx.organizationId,
  });
  if (error) throw new ActionError(`De cijfers voor de prognose ophalen mislukt: ${error.message}`);
  const inputs = parseForecastInputs(data, ctx.today);
  if (ctx.canRead && !ctx.canRead('projects')) {
    return { ...inputs, projects_visible: false, months: inputs.months.map((month) => ({ ...month, projects: null })) };
  }
  return inputs;
}

function startOf(assumptions: unknown): string | null {
  return normalizeAssumptions(assumptions).start_month;
}

async function loadForecasts(ctx: ActionCtx): Promise<ForecastRow[]> {
  const { data, error } = await orgQuery(ctx, 'forecasts', FORECAST_COLUMNS)
    .order('created_at', { ascending: true }).limit(MAX_FORECASTS);
  if (error) throw new ActionError(`Prognoses ophalen mislukt: ${error.message}`);
  return (data ?? []) as ForecastRow[];
}

/** Een naam komt per organisatie één keer voor (de database dwingt het ook af). */
async function assertNameFree(ctx: ActionCtx, name: string, exceptId: string | null): Promise<void> {
  const taken = (await loadForecasts(ctx)).some((forecast) => forecast.id !== exceptId && forecast.name.toLowerCase() === name.toLowerCase());
  if (taken) throw new ActionError(`Er is al een prognose met de naam "${name}". Kies een andere naam, of pas die prognose aan met forecast.update.`);
}

function cleanName(raw: string): string {
  const name = raw.replace(/\s+/g, ' ').trim();
  if (name.length > 80) throw new ActionError('Een naam van een prognose is hooguit 80 tekens.');
  return name;
}

/** De invoer voor een wijziging: alles behalve de eigen velden van de handeling. */
function patchFrom(input: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of PATCH_FIELDS) if (key in input) patch[key] = input[key];
  return patch;
}

/** Wat een prognose voor het model betekent: aannames, uitkomst, en per maand de cijfers. */
function forecastView(result: ForecastResult, includeMonths: boolean) {
  const { effective, totals } = result;
  return {
    summary: summarizeForecast(result),
    assumptions: result.assumptions,
    assumptions_text: describeAssumptions(result),
    effective: {
      start_month: effective.start_month,
      end_month: effective.end_month,
      months: effective.months,
      projects_per_month: Math.round(effective.projects_per_month * 100) / 100,
      revenue_per_project: eur(effective.revenue_per_project_cents),
      other_revenue: eur(effective.other_revenue_cents),
      fixed_costs: eur(effective.fixed_costs_cents),
      automatic: effective.auto,
    },
    totals: {
      projects: result.baseline.projects_visible ? Math.round(totals.projects * 10) / 10 : null,
      revenue: eur(totals.revenue_cents),
      costs: eur(totals.costs_cents),
      profit: eur(totals.profit_cents),
      margin_pct: totals.margin_pct,
    },
    so_far: result.so_far
      ? {
        months: result.so_far.months,
        expected_profit: eur(result.so_far.expected.profit_cents),
        actual_profit: eur(result.so_far.actual.profit_cents),
        expected_revenue: eur(result.so_far.expected.revenue_cents),
        actual_revenue: eur(result.so_far.actual.revenue_cents),
      }
      : null,
    months: includeMonths
      ? result.months.map((month) => ({
        month: month.month,
        projects: result.baseline.projects_visible ? Math.round(month.projects * 10) / 10 : null,
        revenue: eur(month.revenue_cents),
        costs: eur(month.costs_cents),
        profit: eur(month.profit_cents),
        cumulative_profit: eur(month.cumulative_profit_cents),
        actual: month.actual
          ? { revenue: eur(month.actual.revenue_cents), costs: eur(month.actual.costs_cents), profit: eur(month.actual.profit_cents), projects: month.actual.projects, complete: month.actual.complete }
          : null,
      }))
      : undefined,
  };
}

function baselineText(result: ForecastResult): string {
  const base = result.baseline;
  if (base.months === 0 || !base.from || !base.to) {
    return 'Er zijn nog geen cijfers uit de laatste twaalf maanden: alles wat automatisch is, staat op nul. Vul de verwachting zelf in.';
  }
  return joinShort([
    `Geleerd van ${monthLabel(base.from)} t/m ${monthLabel(base.to)} (${base.months} ${base.months === 1 ? 'maand' : 'maanden'})`,
    base.projects_visible ? `gemiddeld ${numberText(base.projects_per_month, 2)} nieuwe projecten per maand van ${wholeEuroText(base.revenue_per_project_cents)}` : 'projecten niet zichtbaar (geen leesrecht op Projecten)',
    `overige omzet ${wholeEuroText(base.other_revenue_cents)} per maand`,
    `kosten ${wholeEuroText(base.fixed_costs_cents)} per maand (${COST_SOURCE_TEXT[base.cost_source]})`,
  ], 400);
}

/** "winst € 48.000 → € 61.500 over 12 maanden". */
function effectText(before: ForecastResult | null, after: ForecastResult): string {
  const span = `${after.effective.months} ${after.effective.months === 1 ? 'maand' : 'maanden'}`;
  const was = wholeEuroText(before?.totals.profit_cents ?? after.totals.profit_cents);
  const is = wholeEuroText(after.totals.profit_cents);
  return !before || was === is ? `verwachte winst ${is} over ${span}` : `verwachte winst ${was} → ${is} over ${span}`;
}

// ── Het invoerschema van een wijziging ──────────────────────────────────────

const ITEM_PROPERTIES = {
  label: { type: 'string', description: 'Naam van de post, bijvoorbeeld "Nieuwe medewerker" of "Opdracht Jansen".' },
  kind: { type: 'string', enum: ['revenue', 'cost'], description: 'revenue = extra omzet, cost = extra kosten.' },
  amount: { type: 'number', description: "Bedrag PER MAAND in euro's exclusief btw (een eenmalige post: from en to dezelfde maand)." },
  from: { type: 'string', description: 'Eerste maand, JJJJ-MM.' },
  to: { type: ['string', 'null'], description: 'Laatste maand (tot en met), JJJJ-MM. Leeg/null = tot het eind van de prognose.' },
};

const PATCH_INPUT: Record<string, unknown> = {
  start_month: { type: ['string', 'null'], description: 'Eerste maand van de prognose, JJJJ-MM. null of "" = deze maand (schuift elke maand mee).' },
  months: { type: 'number', description: 'Aantal maanden vooruit, 1 t/m 36.' },
  projects_per_month: { type: ['number', 'null'], description: 'Nieuwe projecten per maand, mag een breuk zijn (2.5). null = automatisch: het gemiddelde van de laatste twaalf maanden.' },
  revenue_per_project: { type: ['number', 'null'], description: "Omzet per project in euro's EXCLUSIEF btw. null = automatisch: wat een project het afgelopen jaar gemiddeld opbracht." },
  project_months: { type: 'number', description: 'Over hoeveel maanden de omzet van een project binnenkomt, vanaf de start: 1 t/m 24 (1 = alles in de startmaand).' },
  other_revenue: { type: ['number', 'null'], description: "Omzet zonder project per maand (abonnementen, losse verkoop) in euro's exclusief btw. null = automatisch." },
  growth_pct: { type: 'number', description: 'Groei per jaar in procenten op het aantal projecten en de overige omzet, -90 t/m 300. 10 = tien procent per jaar, geleidelijk.' },
  fixed_costs: { type: ['number', 'null'], description: "Vaste kosten per maand in euro's exclusief btw. null = automatisch: het gemiddelde van ALLE kosten van de laatste twaalf maanden." },
  cost_increase_pct: { type: 'number', description: 'Stijging van de vaste kosten per jaar in procenten, -50 t/m 100.' },
  variable_cost_pct: { type: 'number', description: 'Kosten als percentage van de omzet (inkoop, uitbesteed werk, freelancers), 0 t/m 100. Let op: de automatische vaste kosten bevatten al alle kosten van vorig jaar; verlaag of zet fixed_costs als je dit gebruikt, anders tel je dubbel.' },
  month_projects: {
    type: 'object',
    description: 'Per maand een eigen aantal nieuwe projecten, voor vakantie of seizoen: { "2027-07": 1, "2027-08": 0 }. Een maand op null gaat terug naar de verwachting. Vult aan: andere maanden blijven staan.',
    additionalProperties: { type: ['number', 'null'] },
  },
  add_items: {
    type: 'array',
    description: 'Extra posten erbij: een nieuwe medewerker, een investering, een grote opdracht, een gewonnen offerte.',
    items: { type: 'object', properties: ITEM_PROPERTIES, required: ['label', 'kind', 'amount', 'from'] },
  },
  update_items: {
    type: 'array',
    description: 'Bestaande posten wijzigen (id uit forecast.list); geef alleen wat verandert.',
    items: { type: 'object', properties: { id: { type: 'string', description: 'Het id van de post, bijvoorbeeld "post-2".' }, ...ITEM_PROPERTIES }, required: ['id'] },
  },
  remove_item_ids: { type: 'array', items: { type: 'string' }, description: 'Id\'s van posten die weg moeten (uit forecast.list).' },
};

const PATCH_FIELDS = Object.keys(PATCH_INPUT);

const FIELD_GUIDE = FORECAST_FIELDS.map((field) => `${field.key} (${field.label}${field.auto ? ', null = automatisch' : ''})`).join('; ');

export const FORECAST_ACTIONS: ActionDef[] = [
  {
    id: 'forecast.list',
    label: 'Prognoses bekijken (projecten, omzet, kosten, winst)',
    module: 'finance',
    kind: 'read',
    description:
      'Geeft de prognoses (forecast) onder Financiën → Prognose: per prognose de aannames, wat automatisch uit de cijfers komt, de uitkomst (nieuwe projecten, omzet, kosten, winst en marge) en per maand de cijfers. ' +
      'Voor een prognose die al begon staat bij de voorbije maanden ook wat er werkelijk gebeurde (actual). Daarnaast: waar "automatisch" op rust (de laatste twaalf hele maanden), de cijfers van die maanden, en de openstaande en geaccepteerde offertes. ' +
      'Bedragen in euro\'s exclusief btw. Gebruik dit vóór je een prognose aanpast (forecast.update), zodat je het id, de posten en de huidige winst kent. ' +
      'Is er nog geen prognose, dan staat er een automatische bij (niet bewaard): maak er een met forecast.create.',
    keywords: ['prognose', 'prognoses', 'forecast', 'verwachting', 'begroting', 'budget', 'vooruitblik', 'scenario', 'komend jaar', 'volgend jaar', 'verwachte winst', 'verwachte omzet', 'omzetprognose', 'winstprognose'],
    input: {
      forecast_id: { type: 'string', description: 'Eén prognose (met haar laatste versies). Weglaten = allemaal.' },
      include_months: { type: 'boolean', description: 'De cijfers per maand meegeven (standaard true).' },
    },
    async read(ctx, input) {
      const forecastId = optId(input, 'forecast_id');
      const includeMonths = bool(input, 'include_months', true);
      let rows: ForecastRow[];
      if (forecastId) rows = [await row<ForecastRow>(ctx, 'forecasts', forecastId, FORECAST_COLUMNS, 'Prognose')];
      else rows = await loadForecasts(ctx);

      const inputs = await loadInputs(ctx, rows.map((forecast) => startOf(forecast.assumptions)));
      const automatic = computeForecast(DEFAULT_ASSUMPTIONS, inputs, ctx.today);
      const forecasts = rows.map((forecast) => ({
        id: forecast.id,
        name: forecast.name,
        notes: forecast.notes,
        version: forecast.version,
        last_change: forecast.change_note,
        updated_at: forecast.updated_at,
        ...forecastView(computeForecast(forecast.assumptions, inputs, ctx.today), includeMonths),
      }));

      let versions: Array<{ version: number; created_at: string; change: string | null }> | undefined;
      if (forecastId) {
        const { data, error } = await orgQuery(ctx, 'forecast_versions', 'version, created_at, change_note')
          .eq('forecast_id', forecastId).order('version', { ascending: false }).limit(10);
        if (error) throw new ActionError(`De versies ophalen mislukt: ${error.message}`);
        versions = ((data ?? []) as Array<{ version: number; created_at: string; change_note: string | null }>)
          .map((version) => ({ version: version.version, created_at: version.created_at, change: version.change_note }));
      }

      const pipeline = inputs.pipeline;
      const decided = pipeline.won_count + pipeline.lost_count;
      return {
        today: ctx.today,
        forecasts,
        versions,
        automatic: rows.length === 0 ? { note: 'Nog geen prognose bewaard. Dit is de automatische, uit de cijfers van het afgelopen jaar.', ...forecastView(automatic, includeMonths) } : undefined,
        baseline: {
          text: baselineText(automatic),
          from: automatic.baseline.from,
          to: automatic.baseline.to,
          months: automatic.baseline.months,
          projects_per_month: Math.round(automatic.baseline.projects_per_month * 100) / 100,
          revenue_per_project: eur(automatic.baseline.revenue_per_project_cents),
          other_revenue: eur(automatic.baseline.other_revenue_cents),
          costs_per_month: eur(automatic.baseline.fixed_costs_cents),
          cost_source: automatic.baseline.cost_source,
        },
        last_12_months: automatic.history.map((month) => ({
          month: month.month, projects: month.projects, revenue: eur(month.revenue_cents), costs: eur(month.costs_cents), profit: eur(month.profit_cents),
        })),
        last_12_months_totals: {
          revenue: eur(automatic.history_totals.revenue_cents),
          costs: eur(automatic.history_totals.costs_cents),
          profit: eur(automatic.history_totals.profit_cents),
        },
        pipeline: {
          open_quotes: pipeline.open_count,
          open_quotes_amount: eur(pipeline.open_cents),
          accepted_not_invoiced: pipeline.accepted_count,
          accepted_not_invoiced_amount: eur(pipeline.accepted_cents),
          win_rate_pct: decided >= 3 ? Math.round((pipeline.won_count / decided) * 100) : null,
          note: 'Offertes tellen niet vanzelf mee in een prognose (die zitten al in het gemiddelde). Zet een grote opdracht of een geaccepteerde offerte als extra post erbij als de gebruiker dat wil.',
        },
        fields: FIELD_GUIDE,
      };
    },
  },

  {
    id: 'forecast.create',
    label: 'Nieuwe prognose maken',
    module: 'finance',
    kind: 'write',
    description:
      'Maakt een NIEUWE prognose (een scenario, zoals "Voorzichtig" of "Met extra medewerker"), leeg (alles automatisch uit de cijfers) of als kopie van een bestaande (copy_from_id), met meteen de aanpassingen die je meegeeft. ' +
      'Een bestaande prognose aanpassen doe je met forecast.update. Velden: ' + FIELD_GUIDE + '. ' +
      'Extra posten met add_items; per maand een eigen aantal projecten met month_projects. Bedragen in euro\'s exclusief btw. ' +
      'De kaart noemt de aannames en de verwachte winst; pas na akkoord wordt hij aangemaakt.',
    keywords: ['prognose', 'forecast', 'scenario', 'nieuwe prognose', 'begroting', 'budget', 'verwachting', 'kopie', 'what-if', 'wat als'],
    input: {
      name: { type: 'string', description: 'Naam, uniek binnen de organisatie, bijvoorbeeld "Voorzichtig 2027".' },
      notes: { type: 'string', description: 'Optioneel: een toelichting voor wie hem later leest.' },
      copy_from_id: { type: 'string', description: 'Optioneel: begin met de aannames van deze prognose (id uit forecast.list).' },
      ...PATCH_INPUT,
    },
    required: ['name'],
    async plan(ctx, input) {
      const name = cleanName(str(input, 'name', 200));
      await assertNameFree(ctx, name, null);
      const copyFrom = optId(input, 'copy_from_id');
      const source = copyFrom ? await row<ForecastRow>(ctx, 'forecasts', copyFrom, FORECAST_COLUMNS, 'Prognose om te kopiëren') : null;
      const base = source ? normalizeAssumptions(source.assumptions) : normalizeAssumptions(DEFAULT_ASSUMPTIONS);
      let next: ForecastAssumptions;
      let changes: string[];
      try { ({ next, changes } = applyForecastPatch(base, patchFrom(input))); } catch (error) { inputError(error); }

      const inputs = await loadInputs(ctx, [next.start_month]);
      const result = computeForecast(next, inputs, ctx.today);
      const origin = source ? `kopie van ${source.name}` : 'automatisch uit je cijfers';
      return {
        title: `Nieuwe prognose: ${name}`,
        sub: joinShort([origin, ...changes.slice(0, 3), changes.length > 3 ? `en ${changes.length - 3} meer` : null, effectText(null, result)], 240),
        kind: 'insight',
        payload: {
          name,
          notes: optStr(input, 'notes', 2000),
          assumptions: next,
          change_note: changeNote([source ? `Kopie van ${source.name}` : 'Nieuwe prognose', ...changes], 'AI-voorstel: '),
        },
      };
    },
  },

  {
    id: 'forecast.update',
    label: 'Prognose aanpassen',
    module: 'finance',
    kind: 'write',
    description:
      'Past een BESTAANDE prognose aan: groei, aantal projecten, omzet per project, kosten, het begin of de looptijd, per maand een eigen aantal projecten, of extra posten (een nieuwe medewerker, een investering, een grote opdracht). ' +
      'Zoek hem eerst op met forecast.list (id, posten, huidige winst). Geef alleen wat verandert; null bij een automatisch veld zet het terug op automatisch. Velden: ' + FIELD_GUIDE + '. ' +
      'Een eerdere stand terugzetten: restore_version (nummer uit forecast.list met forecast_id). ' +
      'De kaart toont elke wijziging en de verwachte winst ervoor en erna. Bedragen in euro\'s exclusief btw.',
    keywords: ['prognose', 'forecast', 'aanpassen', 'wijzigen', 'groei', 'scenario', 'begroting', 'budget', 'verwachting', 'extra medewerker', 'investering', 'seizoen', 'terugzetten', 'wat als'],
    input: {
      forecast_id: { type: 'string', description: 'Id van de prognose (exact, uit forecast.list).' },
      name: { type: 'string', description: 'Nieuwe naam. Weglaten = blijft.' },
      notes: { type: ['string', 'null'], description: 'Nieuwe toelichting; "" of null maakt hem leeg. Weglaten = blijft.' },
      restore_version: { type: 'number', description: 'Zet de aannames van deze eerdere versie terug (uit forecast.list met forecast_id). Andere velden komen daar bovenop.' },
      ...PATCH_INPUT,
    },
    required: ['forecast_id'],
    async plan(ctx, input) {
      const forecastId = id(input, 'forecast_id');
      const current = await row<ForecastRow>(ctx, 'forecasts', forecastId, FORECAST_COLUMNS, 'Prognose');
      const currentAssumptions = normalizeAssumptions(current.assumptions);

      let base = currentAssumptions;
      let restored: number | null = null;
      if (input.restore_version !== undefined && input.restore_version !== null && input.restore_version !== '') {
        const version = Number(input.restore_version);
        if (!Number.isInteger(version) || version < 1) throw new ActionError('"restore_version" moet een versienummer zijn (uit forecast.list met forecast_id).');
        const { data, error } = await orgQuery(ctx, 'forecast_versions', 'version, assumptions')
          .eq('forecast_id', forecastId).eq('version', version).maybeSingle();
        if (error) throw new ActionError(`De versie ophalen mislukt: ${error.message}`);
        if (!data) throw new ActionError(`Versie ${version} van "${current.name}" bestaat niet (meer). Kijk met forecast.list (forecast_id) welke er zijn.`);
        base = normalizeAssumptions((data as { assumptions: unknown }).assumptions);
        restored = version;
      }

      let next: ForecastAssumptions;
      try { ({ next } = applyForecastPatch(base, patchFrom(input))); } catch (error) { inputError(error); }
      const changes = diffAssumptions(currentAssumptions, next);

      const patch: Record<string, unknown> = {};
      if (input.name !== undefined && input.name !== null && String(input.name).trim() !== '') {
        const name = cleanName(String(input.name));
        if (name !== current.name) {
          await assertNameFree(ctx, name, forecastId);
          patch.name = name;
          changes.unshift(`Naam: ${current.name} → ${name}`);
        }
      }
      if (input.notes !== undefined) {
        const notes = input.notes === null ? null : optStr(input, 'notes', 2000);
        if (notes !== current.notes) {
          patch.notes = notes;
          changes.push(notes ? 'Toelichting aangepast' : 'Toelichting weg');
        }
      }
      if (changes.length === 0) {
        throw new ActionError(`Er verandert niets aan "${current.name}": dit staat er al zo. Kijk met forecast.list wat er nu staat.`);
      }
      patch.assumptions = next;

      const inputs = await loadInputs(ctx, [currentAssumptions.start_month, next.start_month]);
      const before = computeForecast(currentAssumptions, inputs, ctx.today);
      const after = computeForecast(next, inputs, ctx.today);
      const lead = restored !== null ? [`versie ${restored} terugzetten`] : [];
      return {
        title: `Prognose aanpassen: ${current.name}`,
        sub: joinShort([...lead, ...changes.slice(0, 3), changes.length > 3 ? `en ${changes.length - 3} meer` : null, effectText(before, after)], 260),
        kind: 'insight',
        payload: {
          forecast_id: forecastId,
          forecast_name: (patch.name as string | undefined) ?? current.name,
          expected_version: current.version,
          patch,
          change_note: changeNote(restored !== null ? [`Versie ${restored} teruggezet`, ...changes] : changes, 'AI-voorstel: '),
        },
      };
    },
  },

  {
    id: 'forecast.delete',
    label: 'Prognose verwijderen',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Verwijdert een prognose met haar hele geschiedenis. Er gaat geen boekhouding of factuur mee weg: een prognose is alleen een verwachting. ' +
      'Alleen als de gebruiker er echt om vraagt; een andere verwachting maak je liever als nieuwe prognose (forecast.create met copy_from_id).',
    keywords: ['prognose', 'forecast', 'verwijderen', 'weggooien', 'scenario'],
    input: {
      forecast_id: { type: 'string', description: 'Id van de prognose (exact, uit forecast.list).' },
    },
    required: ['forecast_id'],
    async plan(ctx, input) {
      const forecastId = id(input, 'forecast_id');
      const current = await row<ForecastRow>(ctx, 'forecasts', forecastId, FORECAST_COLUMNS, 'Prognose');
      const assumptions = normalizeAssumptions(current.assumptions);
      return {
        title: `Prognose verwijderen: ${current.name}`,
        sub: joinShort([
          `versie ${current.version}`,
          `${assumptions.months} maanden`,
          assumptions.growth_pct !== 0 ? `groei ${pctText(assumptions.growth_pct)}` : null,
          assumptions.items.length > 0 ? `${assumptions.items.length} extra ${assumptions.items.length === 1 ? 'post' : 'posten'}` : null,
        ]),
        kind: 'insight',
        warning: 'Na verwijderen zijn deze prognose en al haar versies weg.',
        payload: { forecast_id: forecastId, forecast_name: current.name },
      };
    },
  },
];
