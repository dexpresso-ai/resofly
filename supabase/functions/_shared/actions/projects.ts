import {
  ActionError, bool, euroCents, id, ids, isoDate, joinShort, optChoice, optId,
  optIsoDate, optNum, optStr, orgQuery, row, str,
  type ActionCtx, type ActionDef,
} from './types.ts';

/**
 * Handelingen rond PROJECTEN EN PLANNING: het project zelf voorbij wat het
 * chatformulier kent, de projectsjablonen, de weekplanner en de bezetting en
 * voortgang van een project.
 *
 * De basis zit al als eersteklas tool in gerrieCore: `propose_project`,
 * `propose_edit_project`, `propose_task`, `propose_edit_task`, `propose_week_action`,
 * `propose_project_team`, `propose_task_assign`, `list_projects` en `list_tasks`.
 * Wat hier staat is de rest van wat de schermen kunnen en die tools níét:
 *
 *  - de commerciële kant van een project (facturatiewijze, uurtarief, urenbudget,
 *    kleur) die `propose_edit_project` niet kent;
 *  - de projectsjablonen uit Instellingen — aanmaken, de standaardtakenlijst
 *    vastleggen en uitrollen op een project;
 *  - de weekplanner voorbij één losse datum: een losse taak zonder project, een
 *    weekstrook over meerdere dagen, het blijven-liggen werk meenemen, en het
 *    afvinken van de actiepunten van de week;
 *  - de reacties onder een taak, het projectteam met zijn bezetting, en het
 *    projectdashboard met voortgang, urenbudget en effectief uurtarief.
 *
 * Waar het NIET over gaat: de contractkoppeling van een project en de galerij bij
 * een project. Die horen bij de contract- en galerijfamilie (`contract.*`,
 * `gallery.*`) en staan dáár, zodat er van elk ding één weg is.
 *
 * Wat bewust ONTBREEKT: een project, taak, sjabloon, urenregistratie of actiepunt
 * weggooien. Dat is definitief (een project sleept zijn taken, subtaken en
 * R2-bijlagen mee) en hoort niet bij wat een agent mag. Een project dat klaar is
 * archiveer je met `propose_edit_project`; een sjabloon dat niet meer geldt zet je
 * op inactief; een actiepunt dat niet doorgaat vink je af. Bestanden uploaden
 * ontbreekt ook: een agent heeft geen bestand in handen.
 */

const TASK_STATUS = ['todo', 'doing', 'review', 'done'] as const;
const PRIORITY = ['low', 'med', 'high'] as const;
const BILLING_TYPE = ['hourly', 'fixed_price'] as const;
const PROJECT_PHASE = ['planning', 'active', 'review', 'overdue', 'completed'] as const;

const STATUS_LABELS: Record<string, string> = { todo: 'Te doen', doing: 'Bezig', review: 'Review', done: 'Klaar' };
const PRIORITY_LABELS: Record<string, string> = { low: 'laag', med: 'normaal', high: 'hoog' };
const BILLING_LABELS: Record<string, string> = { hourly: 'urenbasis', fixed_price: 'aangenomen prijs' };
const PHASE_LABELS: Record<string, string> = {
  planning: 'Planning', active: 'Actief', review: 'Review', overdue: 'Te laat', completed: 'Afgerond',
};

/** Naam van een klant, of null — bewust zacht, dit is versiering op een kaart. */
async function clientNameOf(ctx: ActionCtx, clientId: string | null): Promise<string | null> {
  if (!clientId) return null;
  const { data } = await orgQuery(ctx, 'clients', 'name').eq('id', clientId).maybeSingle();
  return data ? String((data as { name: string }).name) : null;
}

/** De maandag van de week waar deze dag in valt — zoals `startOfWeek` in de app. */
function mondayOf(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const weekday = (date.getUTCDay() + 6) % 7; // 0 = maandag
  date.setUTCDate(date.getUTCDate() - weekday);
  return date.toISOString().slice(0, 10);
}

/** Dagen tussen twee JJJJ-MM-DD-datums (b − a). */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function toNumber(value: unknown): number {
  const parsed = Number(String(value ?? '').replace(',', '.').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

interface FinanceLineRow { quantity?: unknown; unit_price?: unknown; vat?: unknown }

/**
 * Subtotaal (excl. btw) en totaal (incl. btw) van factuurregels, in centen.
 * Btw per tarief afgerond — de NL-conventie die de app en `gerrieCore` ook volgen.
 */
function lineTotals(lines: unknown): { subtotal_cents: number; total_cents: number } {
  const list = Array.isArray(lines) ? lines as FinanceLineRow[] : [];
  const baseByRate = new Map<number, number>();
  let subtotal = 0;
  for (const line of list) {
    const net = Math.round(toNumber(line.quantity) * toNumber(line.unit_price) * 100);
    subtotal += net;
    const rate = toNumber(line.vat);
    baseByRate.set(rate, (baseByRate.get(rate) ?? 0) + net);
  }
  let vat = 0;
  for (const [rate, base] of baseByRate.entries()) vat += Math.round((base * rate) / 100);
  return { subtotal_cents: subtotal, total_cents: subtotal + vat };
}

/** Facturen die niet meetellen als omzet: nog concept, of ingetrokken. */
const NON_COUNTING_INVOICE_STATUS = ['draft', 'cancelled', 'void'];

interface TaskRow {
  id: string; title: string; status: string; end_date: string | null;
  planned_date: string | null; planned_end_date: string | null;
}

/**
 * De fase zoals de projecttijdbalk hem afleidt — zelfde volgorde van beslissen als
 * `deriveProjectPhase` in ProjectTimeline.tsx, zodat "te laat" hier hetzelfde
 * betekent als op het scherm.
 */
function derivePhase(
  project: { archived: boolean; start_date: string | null; end_date: string | null },
  tasks: Array<{ status: string }>,
  today: string,
): typeof PROJECT_PHASE[number] {
  const allDone = tasks.length > 0 && tasks.every((t) => t.status === 'done');
  if (project.archived || allDone) return 'completed';
  if (project.end_date && project.end_date < today) return 'overdue';
  if (tasks.some((t) => t.status === 'review')) return 'review';
  if (tasks.some((t) => t.status === 'doing')) return 'active';
  if (project.start_date && project.start_date <= today) return 'active';
  return 'planning';
}

/** Een weekstrook is een taak die over meerdere dagen loopt. */
function isSpanning(task: { planned_date: string | null; planned_end_date: string | null }): boolean {
  return Boolean(task.planned_date && task.planned_end_date && task.planned_end_date > task.planned_date);
}

export const PROJECTS_ACTIONS: ActionDef[] = [
  {
    id: 'project.update_billing',
    label: 'Facturatiewijze, uurtarief, urenbudget en kleur van een project instellen',
    module: 'projects',
    kind: 'write',
    description:
      'Werkt de commerciële kant van een project bij die het gewone projectformulier wél kent maar `propose_edit_project` niet: facturatiewijze (urenbasis of aangenomen prijs), uurtarief, begrote uren en de projectkleur. ' +
      'De facturatiewijze bepaalt of nieuwe urenregistraties standaard declarabel zijn (urenbasis wel, aangenomen prijs niet); het uurtarief bepaalt de declarabele waarde van die uren (leeg = het bedrijfsbrede standaardtarief); de begrote uren geven het projectdashboard zijn "begroot vs. werkelijk" en het effectieve uurtarief. ' +
      'Let op: dit verandert alleen wat er vanaf nu geldt — al geregistreerde uren houden het tarief dat ze bij het boeken kregen. ' +
      'Geef alleen de velden die veranderen. Zoek het project met `list_projects`; naam, klant, omschrijving en datums wijzig je met `propose_edit_project`.',
    keywords: ['uurtarief', 'tarief', 'facturatie', 'urenbasis', 'aangenomen prijs', 'fixed price', 'budget', 'begrote uren', 'urenbudget', 'kleur', 'projectkleur', 'marge'],
    input: {
      project_id: { type: 'string', description: 'Id van het project (exact, uit list_projects).' },
      billing_type: { type: 'string', enum: [...BILLING_TYPE], description: 'hourly = urenbasis (uren zijn declarabel), fixed_price = aangenomen prijs (afrekenen via offerte/factuur).' },
      hourly_rate_euro: { type: 'number', description: 'Uurtarief in hele euro\'s, bv. 85 of 92.50. Geef 0 om terug te vallen op het bedrijfsbrede standaardtarief.' },
      budgeted_hours: { type: 'number', description: 'Urenbudget voor dit project in uren, bv. 40. Geef 0 om het budget weg te halen.' },
      color: { type: 'string', description: 'Hexkleur van het project in lijsten, kanban en tijdbalk, bv. #FFD966.' },
    },
    required: ['project_id'],
    async plan(ctx, input) {
      const projectId = id(input, 'project_id');
      const project = await row<{ name: string; client_id: string | null; billing_type: string; hourly_rate_cents: number | null; budgeted_minutes: number | null }>(
        ctx, 'projects', projectId, 'name, client_id, billing_type, hourly_rate_cents, budgeted_minutes', 'Project');

      const patch: Record<string, unknown> = {};
      const described: string[] = [];

      const billing = optChoice(input, 'billing_type', BILLING_TYPE);
      if (billing) {
        patch.billing_type = billing;
        described.push(`facturatie ${BILLING_LABELS[billing]}`);
      }

      const rate = optNum(input, 'hourly_rate_euro');
      if (rate !== null) {
        if (rate < 0) throw new ActionError('Een uurtarief kan niet negatief zijn.');
        const cents = rate === 0 ? null : Math.round(rate * 100);
        patch.hourly_rate_cents = cents;
        described.push(cents === null ? 'uurtarief terug naar het standaardtarief' : `uurtarief ${euroCents(cents)}`);
      }

      const hours = optNum(input, 'budgeted_hours');
      if (hours !== null) {
        if (hours < 0) throw new ActionError('Een urenbudget kan niet negatief zijn.');
        const minutes = hours === 0 ? null : Math.round(hours * 60);
        patch.budgeted_minutes = minutes;
        described.push(minutes === null ? 'urenbudget weggehaald' : `budget ${hours} uur`);
      }

      const color = optStr(input, 'color', 9);
      if (color) {
        if (!/^#[0-9a-f]{6}$/i.test(color)) throw new ActionError('Geef de kleur als hexcode, bijvoorbeeld #FFD966.');
        patch.color = color;
        described.push(`kleur ${color}`);
      }

      if (Object.keys(patch).length === 0) throw new ActionError('Geef minstens één veld dat moet veranderen.');
      const clientName = await clientNameOf(ctx, project.client_id);

      return {
        title: `Projectinstellingen bijwerken: ${project.name}`,
        sub: joinShort([clientName, ...described], 170),
        kind: 'work',
        payload: { project_id: projectId, project_name: project.name, patch },
      };
    },
  },

  {
    id: 'project_template.list',
    label: 'Projectsjablonen met hun standaardtaken bekijken',
    module: 'projects',
    kind: 'read',
    description:
      'Geeft de projectsjablonen van de organisatie: naam, omschrijving, of het sjabloon actief is en hoeveel standaardtaken erin zitten. ' +
      'Met `template_id` krijg je van dat ene sjabloon ook de volledige takenlijst terug — titel, status, prioriteit, labels, de dagoffsets ten opzichte van de projectstart, de geschatte duur en de subtaken. ' +
      'Hier haal je het `template_id` vandaan dat `project_template.apply`, `project_template.update` en `project_template.set_tasks` nodig hebben. Wil je een sjabloon wijzigen, lees het dan éérst hiermee: `set_tasks` vervangt de hele lijst.',
    keywords: ['sjabloon', 'sjablonen', 'template', 'standaardtaken', 'werkwijze', 'checklist', 'draaiboek'],
    input: {
      template_id: { type: 'string', description: 'Van dit sjabloon ook de volledige takenlijst meesturen (optioneel).' },
      include_inactive: { type: 'boolean', description: 'Ook de op inactief gezette sjablonen meesturen (standaard true).' },
    },
    async read(ctx, input) {
      const templateId = optId(input, 'template_id');
      let query = orgQuery(ctx, 'project_templates', 'id, name, description, is_active, created_at')
        .order('name', { ascending: true }).limit(200);
      if (!bool(input, 'include_inactive', true)) query = query.eq('is_active', true);
      const { data, error } = await query;
      if (error) throw new ActionError(`Projectsjablonen ophalen mislukt: ${error.message}`);
      const templates = (data ?? []) as Array<Record<string, unknown>>;

      const { data: taskData, error: taskError } = await orgQuery(ctx, 'project_template_tasks',
        'id, template_id, position, title, description, status, priority, tags, start_offset_days, due_offset_days, planned_offset_days, estimated_minutes, subtasks')
        .order('position', { ascending: true }).limit(2000);
      if (taskError) throw new ActionError(`Standaardtaken ophalen mislukt: ${taskError.message}`);
      const tasks = (taskData ?? []) as Array<Record<string, unknown>>;

      const countByTemplate = new Map<string, number>();
      for (const task of tasks) {
        const key = String(task.template_id);
        countByTemplate.set(key, (countByTemplate.get(key) ?? 0) + 1);
      }

      return {
        count: templates.length,
        templates: templates.map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          is_active: t.is_active,
          task_count: countByTemplate.get(String(t.id)) ?? 0,
        })),
        tasks: templateId ? tasks.filter((t) => String(t.template_id) === templateId) : null,
      };
    },
  },

  {
    id: 'project_template.create',
    label: 'Projectsjabloon aanmaken',
    module: 'projects',
    kind: 'write',
    description:
      'Maakt een nieuw, leeg projectsjabloon aan — de vaste werkwijze die je bij elk project opnieuw gebruikt. Het sjabloon staat daarna in Instellingen en is meteen actief, maar heeft nog geen standaardtaken: die leg je in een tweede stap vast met `project_template.set_tasks`. ' +
      'Een sjabloon aanmaken verandert niets aan bestaande projecten.',
    keywords: ['sjabloon', 'template', 'nieuw sjabloon', 'werkwijze vastleggen', 'draaiboek'],
    input: {
      name: { type: 'string', description: 'Naam van het sjabloon, bv. "Bruiloftsreportage".' },
      description: { type: 'string', description: 'Korte toelichting waar dit sjabloon voor is (optioneel).' },
    },
    required: ['name'],
    async plan(ctx, input) {
      const name = str(input, 'name', 120);
      const description = optStr(input, 'description', 500);
      const { data: existing } = await orgQuery(ctx, 'project_templates', 'id, name').eq('name', name).maybeSingle();
      if (existing) throw new ActionError(`Er bestaat al een sjabloon met de naam "${name}".`);
      return {
        title: `Projectsjabloon aanmaken: ${name}`,
        sub: joinShort([description, 'nog zonder standaardtaken — die leg je daarna vast'], 170),
        kind: 'work',
        payload: { name, description },
      };
    },
  },

  {
    id: 'project_template.update',
    label: 'Projectsjabloon hernoemen of op inactief zetten',
    module: 'projects',
    kind: 'write',
    description:
      'Past de naam, de omschrijving of de actief-stand van een projectsjabloon aan. Op inactief zetten is de zachte manier om een sjabloon af te schaffen: hij verdwijnt uit de keuzelijst bij een nieuw project, maar blijft met zijn standaardtaken bewaard en projecten die er ooit mee gemaakt zijn veranderen niet. ' +
      'De standaardtaken zelf wijzig je met `project_template.set_tasks`. Zoek het sjabloon met `project_template.list`.',
    keywords: ['sjabloon hernoemen', 'sjabloon uitzetten', 'inactief', 'archiveren', 'template'],
    input: {
      template_id: { type: 'string', description: 'Id van het sjabloon (uit project_template.list).' },
      name: { type: 'string' },
      description: { type: 'string' },
      is_active: { type: 'boolean', description: 'false = uit de keuzelijst halen, true = weer aanbieden.' },
    },
    required: ['template_id'],
    async plan(ctx, input) {
      const templateId = id(input, 'template_id');
      const template = await row<{ name: string; is_active: boolean }>(
        ctx, 'project_templates', templateId, 'name, is_active', 'Projectsjabloon');

      const patch: Record<string, unknown> = {};
      const described: string[] = [];
      const name = optStr(input, 'name', 120);
      if (name && name !== template.name) { patch.name = name; described.push(`heet voortaan "${name}"`); }
      if (input.description !== undefined) {
        patch.description = optStr(input, 'description', 500);
        described.push('omschrijving bijgewerkt');
      }
      if (typeof input.is_active === 'boolean' && input.is_active !== template.is_active) {
        patch.is_active = input.is_active;
        described.push(input.is_active ? 'weer te kiezen bij een nieuw project' : 'niet meer te kiezen bij een nieuw project');
      }
      if (Object.keys(patch).length === 0) throw new ActionError('Geef minstens één ding dat moet veranderen.');

      return {
        title: `Projectsjabloon aanpassen: ${template.name}`,
        sub: joinShort([...described, 'bestaande projecten blijven ongewijzigd'], 170),
        kind: 'work',
        payload: { template_id: templateId, name: template.name, patch },
      };
    },
  },

  {
    id: 'project_template.set_tasks',
    label: 'Standaardtaken van een projectsjabloon vastleggen',
    module: 'projects',
    kind: 'write',
    description:
      'Zet de takenlijst van een projectsjabloon op precies deze lijst, in deze volgorde — hetzelfde als op "Opslaan" drukken in de sjablooneditor. ' +
      'De lijst VERVANGT de bestaande standaardtaken: een taak die je weglaat verdwijnt uit het sjabloon. Lees daarom eerst `project_template.list` met dit `template_id` en stuur de taken die moeten blijven mee, mét hun `id`; een taak zonder `id` komt er als nieuwe bij. ' +
      'Datums leg je relatief vast als dagoffsets ten opzichte van de startdatum van het project: `due_offset_days: 14` is twee weken na de start, `-3` is drie dagen ervóór. Laat een offset weg en die datum blijft bij het uitrollen leeg. ' +
      'Projecten die eerder met dit sjabloon zijn uitgerold veranderen NIET mee.',
    keywords: ['standaardtaken', 'sjabloontaken', 'takenlijst', 'template', 'draaiboek', 'checklist', 'stappen', 'subtaken', 'offset'],
    input: {
      template_id: { type: 'string', description: 'Id van het sjabloon (uit project_template.list).' },
      tasks: {
        type: 'array',
        description: 'De VOLLEDIGE nieuwe takenlijst, in de volgorde waarin ze in het project moeten staan.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Id van een bestaande standaardtaak die blijft (uit project_template.list). Weglaten bij een nieuwe taak.' },
            title: { type: 'string' },
            description: { type: 'string' },
            status: { type: 'string', enum: [...TASK_STATUS], description: 'Standaard todo.' },
            priority: { type: 'string', enum: [...PRIORITY], description: 'Standaard med.' },
            tags: { type: 'array', items: { type: 'string' } },
            start_offset_days: { type: 'number', description: 'Dagen na de projectstart voor de startdatum (-3650 t/m 3650).' },
            due_offset_days: { type: 'number', description: 'Dagen na de projectstart voor de deadline.' },
            planned_offset_days: { type: 'number', description: 'Dagen na de projectstart voor de plandatum in de weekplanner.' },
            estimated_minutes: { type: 'number', description: 'Geschatte duur in minuten (0 t/m 1440). Standaard 60.' },
            subtasks: { type: 'array', items: { type: 'string' }, description: 'Labels van de subtaken, in volgorde.' },
          },
          required: ['title'],
        },
      },
    },
    required: ['template_id', 'tasks'],
    async plan(ctx, input) {
      const templateId = id(input, 'template_id');
      const template = await row<{ name: string }>(ctx, 'project_templates', templateId, 'name', 'Projectsjabloon');

      const raw = Array.isArray(input.tasks) ? input.tasks as Array<Record<string, unknown>> : [];
      if (raw.length === 0) throw new ActionError('Geef de takenlijst mee. Een sjabloon zonder taken leveren doe je niet per ongeluk — laat dat via het scherm lopen.');
      if (raw.length > 100) throw new ActionError('Een sjabloon met meer dan honderd standaardtaken is niet werkbaar.');

      const { data: currentData, error } = await orgQuery(ctx, 'project_template_tasks', 'id, title')
        .eq('template_id', templateId);
      if (error) throw new ActionError(`Standaardtaken ophalen mislukt: ${error.message}`);
      const current = (currentData ?? []) as Array<{ id: string; title: string }>;
      const currentIds = new Set(current.map((t) => String(t.id)));

      const offset = (task: Record<string, unknown>, key: string): number | null => {
        const value = optNum(task, key);
        if (value === null) return null;
        const rounded = Math.round(value);
        if (rounded < -3650 || rounded > 3650) throw new ActionError(`"${key}" moet tussen -3650 en 3650 dagen liggen.`);
        return rounded;
      };

      const tasks = raw.map((task, index) => {
        const title = str(task, 'title', 200);
        const taskId = optId(task, 'id');
        if (taskId && !currentIds.has(taskId)) {
          throw new ActionError(`De standaardtaak met id ${taskId} hoort niet bij dit sjabloon. Laat het id weg om hem als nieuwe taak toe te voegen.`);
        }
        const minutes = optNum(task, 'estimated_minutes');
        if (minutes !== null && (minutes < 0 || minutes > 1440)) {
          throw new ActionError(`De geschatte duur van "${title}" moet tussen 0 en 1440 minuten liggen.`);
        }
        return {
          id: taskId,
          position: index,
          title,
          description: optStr(task, 'description', 2000),
          status: optChoice(task, 'status', TASK_STATUS) ?? 'todo',
          priority: optChoice(task, 'priority', PRIORITY) ?? 'med',
          tags: Array.isArray(task.tags) ? (task.tags as unknown[]).map((t) => String(t).trim()).filter(Boolean).slice(0, 20) : [],
          start_offset_days: offset(task, 'start_offset_days'),
          due_offset_days: offset(task, 'due_offset_days'),
          planned_offset_days: offset(task, 'planned_offset_days'),
          estimated_minutes: minutes === null ? 60 : Math.round(minutes),
          subtask_labels: Array.isArray(task.subtasks)
            ? (task.subtasks as unknown[]).map((s) => String(s).trim()).filter(Boolean).slice(0, 30)
            : [],
        };
      });

      const keptIds = new Set(tasks.map((t) => t.id).filter((v): v is string => Boolean(v)));
      const dropped = current.filter((t) => !keptIds.has(String(t.id)));
      const added = tasks.filter((t) => !t.id).length;

      return {
        title: `Standaardtaken vastleggen in sjabloon: ${template.name}`,
        sub: joinShort([
          `${tasks.length} ta${tasks.length === 1 ? 'ak' : 'ken'} in het sjabloon`,
          added > 0 ? `${added} nieuw` : null,
          dropped.length > 0 ? `${dropped.length} verdwijnt uit het sjabloon (${dropped.map((t) => t.title).join(', ')})` : null,
          'bestaande projecten veranderen niet mee',
        ], 200),
        kind: 'work',
        payload: { template_id: templateId, template_name: template.name, tasks },
      };
    },
  },

  {
    id: 'project_template.apply',
    label: 'Projectsjabloon uitrollen op een project',
    module: 'projects',
    kind: 'write',
    description:
      'Maakt in één keer alle standaardtaken van een sjabloon aan op een bestaand project, met datums die worden uitgerekend vanaf een ankerdatum: sjabloonoffset + ankerdatum. Zonder `start_date` is de startdatum van het project het anker; heeft het project die niet, dan komen de taken datumloos binnen. ' +
      'Alles gebeurt in één databasetransactie — of alle taken komen erin, of geen enkele. ' +
      'De taken worden TOEGEVOEGD, niet vervangen: twee keer uitrollen geeft de takenlijst dubbel, en weggooien kan een agent niet. Maak het project eerst aan met `propose_project`; zoek het sjabloon met `project_template.list`.',
    keywords: ['sjabloon uitrollen', 'toepassen', 'template', 'standaardtaken aanmaken', 'draaiboek starten', 'nieuw project'],
    input: {
      project_id: { type: 'string', description: 'Id van het project (exact, uit list_projects).' },
      template_id: { type: 'string', description: 'Id van het sjabloon (uit project_template.list).' },
      start_date: { type: 'string', description: 'Ankerdatum JJJJ-MM-DD voor de dagoffsets. Weglaten = de startdatum van het project.' },
    },
    required: ['project_id', 'template_id'],
    async plan(ctx, input) {
      const projectId = id(input, 'project_id');
      const templateId = id(input, 'template_id');
      const project = await row<{ name: string; client_id: string | null; start_date: string | null; archived: boolean }>(
        ctx, 'projects', projectId, 'name, client_id, start_date, archived', 'Project');
      const template = await row<{ name: string; is_active: boolean }>(
        ctx, 'project_templates', templateId, 'name, is_active', 'Projectsjabloon');

      const { data, error } = await orgQuery(ctx, 'project_template_tasks', 'title, due_offset_days')
        .eq('template_id', templateId).order('position', { ascending: true });
      if (error) throw new ActionError(`Standaardtaken ophalen mislukt: ${error.message}`);
      const tasks = (data ?? []) as Array<{ title: string; due_offset_days: number | null }>;
      if (tasks.length === 0) throw new ActionError(`Het sjabloon "${template.name}" heeft nog geen standaardtaken; er valt niets uit te rollen.`);

      const anchor = optIsoDate(input, 'start_date') ?? project.start_date;
      const { count: existingTasks } = await ctx.db.from('tasks')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', ctx.organizationId).eq('project_id', projectId);
      const clientName = await clientNameOf(ctx, project.client_id);

      return {
        title: `Sjabloon "${template.name}" uitrollen op ${project.name}`,
        sub: joinShort([
          clientName,
          `${tasks.length} ta${tasks.length === 1 ? 'ak' : 'ken'} erbij`,
          anchor ? `datums gerekend vanaf ${anchor}` : 'het project heeft geen startdatum — de taken komen zonder datum binnen',
          (existingTasks ?? 0) > 0 ? `let op: er staan al ${existingTasks} taken op dit project, deze komen ERBIJ` : null,
        ], 220),
        kind: 'work',
        payload: {
          project_id: projectId, project_name: project.name,
          template_id: templateId, template_name: template.name,
          start_date: anchor, task_count: tasks.length,
        },
      };
    },
  },

  {
    id: 'task.add_comment',
    label: 'Reactie bij een taak plaatsen',
    module: 'projects',
    kind: 'write',
    description:
      'Zet een reactie bovenaan de commentsectie van een taak — de plek voor een update, een beslissing of een overdracht, zodat de volgende die de taak oppakt weet wat er speelt. ' +
      'Dit is een INTERNE aantekening: de klant ziet hem nergens. Wil je iets naar de klant sturen, gebruik dan een ticketnotitie of een klantmail. ' +
      'De reactie komt erbij, niets wordt overschreven. Zoek de taak met `list_tasks`; lees de bestaande reacties met `task.list_comments`.',
    keywords: ['comment', 'reactie', 'opmerking', 'update', 'overdracht', 'beslissing', 'aantekening', 'taak'],
    input: {
      task_id: { type: 'string', description: 'Id van de taak (exact, uit list_tasks).' },
      text: { type: 'string', description: 'De tekst van de reactie.' },
    },
    required: ['task_id', 'text'],
    async plan(ctx, input) {
      const taskId = id(input, 'task_id');
      const text = str(input, 'text', 4000);
      const task = await row<{ title: string; project_id: string | null; status: string; comments: unknown }>(
        ctx, 'tasks', taskId, 'title, project_id, status, comments', 'Taak');
      const existing = Array.isArray(task.comments) ? task.comments.length : 0;

      let projectName: string | null = null;
      if (task.project_id) {
        const { data } = await orgQuery(ctx, 'projects', 'name').eq('id', task.project_id).maybeSingle();
        if (data) projectName = String((data as { name: string }).name);
      }
      const excerpt = text.replace(/\s+/g, ' ').trim();

      return {
        title: `Reactie plaatsen bij taak: ${task.title}`,
        sub: joinShort([
          projectName ?? 'losse taak',
          existing > 0 ? `komt boven ${existing} eerdere reactie${existing === 1 ? '' : 's'}` : 'eerste reactie',
          `"${excerpt.length > 120 ? `${excerpt.slice(0, 119)}…` : excerpt}"`,
        ], 220),
        kind: 'work',
        payload: { task_id: taskId, task_title: task.title, text },
      };
    },
  },

  {
    id: 'task.list_comments',
    label: 'Reacties bij een taak lezen',
    module: 'projects',
    kind: 'read',
    description:
      'Geeft de reacties die bij een taak staan, nieuwste eerst: de tekst, wanneer hij geplaatst is en door wie (als dat is vastgelegd). Zo lees je de laatste stand van zaken terug voordat je zelf iets toevoegt met `task.add_comment`. ' +
      'Geeft er ook de subtaken bij, zodat je in één keer ziet hoever de taak is. Zoek de taak met `list_tasks`.',
    keywords: ['comments', 'reacties', 'opmerkingen', 'taakgeschiedenis', 'subtaken', 'stand van zaken'],
    input: { task_id: { type: 'string', description: 'Id van de taak (exact, uit list_tasks).' } },
    required: ['task_id'],
    async read(ctx, input) {
      const taskId = id(input, 'task_id');
      const task = await row<{ title: string; status: string; project_id: string | null; comments: unknown; subtasks: unknown }>(
        ctx, 'tasks', taskId, 'title, status, project_id, comments, subtasks', 'Taak');
      const comments = Array.isArray(task.comments) ? task.comments as Array<Record<string, unknown>> : [];
      const subtasks = Array.isArray(task.subtasks) ? task.subtasks as Array<Record<string, unknown>> : [];

      let projectName: string | null = null;
      if (task.project_id) {
        const { data } = await orgQuery(ctx, 'projects', 'name').eq('id', task.project_id).maybeSingle();
        if (data) projectName = String((data as { name: string }).name);
      }

      return {
        task: {
          id: taskId,
          title: task.title,
          status: task.status,
          status_label: STATUS_LABELS[task.status] ?? task.status,
          project_id: task.project_id,
          project_name: projectName,
        },
        comment_count: comments.length,
        comments,
        subtasks: subtasks.map((s) => ({ label: s.label, done: Boolean(s.done) })),
        subtasks_done: subtasks.filter((s) => Boolean(s.done)).length,
      };
    },
  },

  {
    id: 'task.quick_plan',
    label: 'Losse taak zonder project op een dag in de weekplanner zetten',
    module: 'projects',
    kind: 'write',
    description:
      'Maakt met alleen een titel en een dag een taak aan die LOS in de weekplanner staat — zonder project en zonder klant, precies zoals de snelinvoer in een dagkolom. Gebruik dit voor werk dat (nog) nergens bij hoort; `propose_task` heeft altijd een project nodig. ' +
      'Vul je ook `planned_end_date` in, dan wordt het meteen een weekstrook over die dagen heen. Een project of klant koppel je later met `propose_edit_task`. ' +
      'Reken "morgen" of "vrijdag" zelf om naar JJJJ-MM-DD op basis van de datum van vandaag.',
    keywords: ['losse taak', 'snelinvoer', 'weekplanner', 'to-do', 'zonder project', 'op mijn lijstje', 'inplannen'],
    input: {
      title: { type: 'string', description: 'Wat er moet gebeuren.' },
      planned_date: { type: 'string', description: 'De dag waarop de taak in de weekplanner staat (JJJJ-MM-DD).' },
      planned_end_date: { type: 'string', description: 'Laatste dag bij werk over meerdere dagen (JJJJ-MM-DD); maakt er een weekstrook van.' },
      estimated_minutes: { type: 'number', description: 'Geschatte duur in minuten (0 t/m 1440). Leeg = geen schatting; de taak telt dan nergens als tijd mee.' },
      priority: { type: 'string', enum: [...PRIORITY], description: 'Standaard med.' },
    },
    required: ['title', 'planned_date'],
    async plan(ctx, input) {
      const title = str(input, 'title', 200);
      const plannedDate = isoDate(input, 'planned_date');
      const plannedEnd = optIsoDate(input, 'planned_end_date');
      if (plannedEnd && plannedEnd <= plannedDate) {
        throw new ActionError('"planned_end_date" moet ná "planned_date" liggen. Laat hem weg voor werk van één dag.');
      }
      const minutes = optNum(input, 'estimated_minutes');
      if (minutes !== null && (minutes < 0 || minutes > 1440)) {
        throw new ActionError('De geschatte duur moet tussen 0 en 1440 minuten liggen.');
      }
      const priority = optChoice(input, 'priority', PRIORITY) ?? 'med';

      // Dezelfde titel op dezelfde dag is vrijwel altijd een dubbele: een agent die
      // twee keer draaide, of een gebruiker die het al gevraagd had. Weggooien kan
      // een agent niet, dus liever hier stoppen dan een dubbele kaart neerzetten.
      const { data: twin } = await orgQuery(ctx, 'tasks', 'id')
        .eq('planned_date', plannedDate).eq('title', title).maybeSingle();
      if (twin) throw new ActionError(`Er staat op ${plannedDate} al een taak "${title}" in de weekplanner.`);

      return {
        title: `Losse taak op ${plannedDate}: ${title}`,
        sub: joinShort([
          plannedEnd ? `weekstrook t/m ${plannedEnd} (${daysBetween(plannedDate, plannedEnd) + 1} dagen)` : 'werk van één dag',
          minutes !== null ? `${Math.round(minutes)} min` : 'geen tijdschatting',
          priority !== 'med' ? `prioriteit ${PRIORITY_LABELS[priority]}` : null,
          plannedDate < ctx.today ? 'let op: die dag is al geweest' : null,
          'zonder project en zonder klant',
        ], 190),
        kind: 'work',
        payload: {
          title,
          planned_date: plannedDate,
          planned_end_date: plannedEnd,
          estimated_minutes: minutes === null ? null : Math.round(minutes),
          priority,
        },
      };
    },
  },

  {
    id: 'task.set_week_bar',
    label: 'Taak over meerdere dagen uitsmeren of weer op één dag zetten',
    module: 'projects',
    kind: 'write',
    description:
      'Zet de plandatum én de einddatum van de planning van een bestaande taak in één keer — dat is wat een weekstrook in de weekplanner is: werk dat over meerdere dagen loopt. Laat `planned_end_date` weg en de taak wordt weer een gewone dagkaart op `planned_date`. ' +
      '`propose_edit_task` kan wél de plandatum maar NIET de einddatum van de planning; daarvoor is deze handeling. ' +
      'Dit raakt alleen de PLANNING. De inhoudelijke deadline van de taak (`end_date`) blijft staan — die wijzig je met `propose_edit_task`. Zoek de taak met `list_tasks`.',
    keywords: ['weekstrook', 'meerdaags', 'uitsmeren', 'doorlopen', 'planning', 'weekplanner', 'balk', 'meerdere dagen'],
    input: {
      task_id: { type: 'string', description: 'Id van de taak (exact, uit list_tasks).' },
      planned_date: { type: 'string', description: 'Eerste dag van de planning (JJJJ-MM-DD).' },
      planned_end_date: { type: 'string', description: 'Laatste dag (JJJJ-MM-DD). Weglaten = weer werk van één dag.' },
    },
    required: ['task_id', 'planned_date'],
    async plan(ctx, input) {
      const taskId = id(input, 'task_id');
      const plannedDate = isoDate(input, 'planned_date');
      const plannedEnd = optIsoDate(input, 'planned_end_date');
      if (plannedEnd && plannedEnd <= plannedDate) {
        throw new ActionError('"planned_end_date" moet ná "planned_date" liggen. Laat hem weg voor werk van één dag.');
      }
      const task = await row<{ title: string; planned_date: string | null; planned_end_date: string | null; end_date: string | null; project_id: string | null }>(
        ctx, 'tasks', taskId, 'title, planned_date, planned_end_date, end_date, project_id', 'Taak');
      if ((task.planned_date ?? null) === plannedDate && (task.planned_end_date ?? null) === plannedEnd) {
        throw new ActionError(`"${task.title}" staat al precies zo gepland.`);
      }

      let projectName: string | null = null;
      if (task.project_id) {
        const { data } = await orgQuery(ctx, 'projects', 'name').eq('id', task.project_id).maybeSingle();
        if (data) projectName = String((data as { name: string }).name);
      }
      const was = task.planned_date
        ? (task.planned_end_date && task.planned_end_date > task.planned_date
          ? `${task.planned_date} t/m ${task.planned_end_date}`
          : task.planned_date)
        : 'niet ingepland';

      return {
        title: plannedEnd
          ? `Taak uitsmeren over ${daysBetween(plannedDate, plannedEnd) + 1} dagen: ${task.title}`
          : `Taak op ${plannedDate} zetten: ${task.title}`,
        sub: joinShort([
          projectName,
          `nu: ${was}`,
          `wordt: ${plannedEnd ? `${plannedDate} t/m ${plannedEnd}` : plannedDate}`,
          task.end_date ? `deadline ${task.end_date} blijft staan` : null,
        ], 200),
        kind: 'work',
        payload: {
          task_id: taskId, task_title: task.title,
          planned_date: plannedDate, planned_end_date: plannedEnd,
        },
      };
    },
  },

  {
    id: 'task.carry_over',
    label: 'Blijven liggen werk meenemen naar een dag',
    module: 'projects',
    kind: 'write',
    description:
      'Verplaatst open taken met een plandatum in het VERLEDEN in één keer naar één dag — de knop "Meenemen naar vandaag" van de weekplanner. Elke taak komt achteraan de rij van die dag te staan. ' +
      'Zonder `task_ids` neemt hij alles mee wat blijven liggen is: taken die niet klaar zijn, een plandatum vóór de doeldag hebben en geen weekstrook zijn. Standaard alleen jouw werk — wat aan jou is toegewezen of aan niemand — net als "Mijn week"; met `scope: "all"` het werk van het hele team. ' +
      'Dit verzet alleen de PLANDATUM. De inhoudelijke deadline van elke taak blijft staan, zodat je blijft zien dat er iets te laat is.',
    keywords: ['blijven liggen', 'rollover', 'meenemen', 'achterstand', 'doorschuiven', 'vandaag', 'inhalen', 'weekplanner'],
    input: {
      to_date: { type: 'string', description: 'De dag waarnaar alles gaat (JJJJ-MM-DD). Standaard vandaag.' },
      task_ids: { type: 'array', items: { type: 'string' }, description: 'Alleen deze taken meenemen (uit list_tasks). Weglaten = alles wat blijven liggen is.' },
      scope: { type: 'string', enum: ['mine', 'all'], description: 'mine (standaard) = aan jou of aan niemand toegewezen; all = het hele team.' },
    },
    async plan(ctx, input) {
      const toDate = optIsoDate(input, 'to_date') ?? ctx.today;
      const scope = optChoice(input, 'scope', ['mine', 'all'] as const) ?? 'mine';
      const wanted = Array.isArray(input.task_ids) && (input.task_ids as unknown[]).length > 0
        ? ids(input, 'task_ids', 200)
        : null;

      let query = orgQuery(ctx, 'tasks', 'id, title, status, planned_date, planned_end_date, project_id')
        .not('planned_date', 'is', null).lt('planned_date', toDate).neq('status', 'done')
        .order('planned_date', { ascending: true }).limit(300);
      if (wanted) query = query.in('id', wanted);
      const { data, error } = await query;
      if (error) throw new ActionError(`Taken ophalen mislukt: ${error.message}`);

      let rows = ((data ?? []) as TaskRow[]).filter((t) => !isSpanning(t));
      if (wanted) {
        const found = new Set(rows.map((t) => String(t.id)));
        const missing = wanted.filter((x) => !found.has(x));
        if (missing.length) {
          throw new ActionError(`Deze taken zijn niet blijven liggen (klaar, geen plandatum vóór ${toDate}, of een weekstrook): ${missing.join(', ')}.`);
        }
      }

      // "Mijn week" toont wat aan mij is toegewezen én wat aan niemand hangt; die
      // regel houden we hier aan, anders neemt een agent stilletjes andermans werk mee.
      if (scope === 'mine' && rows.length > 0) {
        const { data: assigneeData, error: assigneeError } = await orgQuery(ctx, 'task_assignees', 'task_id, user_id')
          .in('task_id', rows.map((t) => String(t.id)));
        if (assigneeError) throw new ActionError(`Toewijzingen ophalen mislukt: ${assigneeError.message}`);
        const byTask = new Map<string, string[]>();
        for (const a of (assigneeData ?? []) as Array<{ task_id: string; user_id: string }>) {
          const key = String(a.task_id);
          const list = byTask.get(key);
          if (list) list.push(String(a.user_id)); else byTask.set(key, [String(a.user_id)]);
        }
        rows = rows.filter((t) => {
          const assignees = byTask.get(String(t.id));
          return !assignees || assignees.length === 0 || assignees.includes(ctx.userId);
        });
      }

      if (rows.length === 0) {
        throw new ActionError(scope === 'mine'
          ? `Er is niets van jou blijven liggen vóór ${toDate}.`
          : `Er is niets blijven liggen vóór ${toDate}.`);
      }
      const oldest = rows[0].planned_date ?? toDate;

      return {
        title: rows.length === 1
          ? `Taak meenemen naar ${toDate}: ${rows[0].title}`
          : `${rows.length} blijven liggen taken meenemen naar ${toDate}`,
        sub: joinShort([
          scope === 'mine' ? 'jouw werk' : 'het hele team',
          `oudste stond op ${oldest}`,
          ...rows.slice(0, 4).map((t) => t.title),
          rows.length > 4 ? `en ${rows.length - 4} meer` : null,
          'de deadlines blijven staan',
        ], 220),
        kind: 'work',
        payload: {
          to_date: toDate,
          task_ids: rows.map((t) => String(t.id)),
          titles: rows.map((t) => String(t.title)),
        },
      };
    },
  },

  {
    id: 'week_action.list',
    label: 'Actiepunten van een week bekijken',
    module: 'projects',
    kind: 'read',
    description:
      'Geeft de losse actiepunten op je checklist "Actiepunten deze week" in de weekplanner: de tekst, of hij al afgevinkt is en bij welke week hij hoort. Dit zijn PERSOONLIJKE punten — je ziet alleen die van jezelf, collega\'s hebben hun eigen lijst. ' +
      'Hier haal je het `note_id` vandaan dat `week_action.set_done` nodig heeft. Nieuwe actiepunten zet je erop met `propose_week_action`.',
    keywords: ['actiepunten', 'checklist', 'weekplanner', 'to-do', 'lijstje', 'deze week', 'afvinken'],
    input: {
      date: { type: 'string', description: 'Een dag in de gewenste week (JJJJ-MM-DD); de week wordt er zelf uit afgeleid. Standaard de week van vandaag.' },
      include_done: { type: 'boolean', description: 'Ook de al afgevinkte punten meesturen (standaard true).' },
      all_weeks: { type: 'boolean', description: 'Alle weken in plaats van één (standaard false).' },
    },
    async read(ctx, input) {
      const day = optIsoDate(input, 'date') ?? ctx.today;
      const weekStart = mondayOf(day);
      const allWeeks = bool(input, 'all_weeks', false);

      // planner_notes zijn persoonlijk (RLS: user_id = auth.uid()). Dit draait met de
      // service-role en slaat RLS over, dus zelf op de ingelogde gebruiker filteren.
      let query = orgQuery(ctx, 'planner_notes', 'id, text, done, week_start, position, created_at')
        .eq('user_id', ctx.userId)
        .order('week_start', { ascending: false }).order('position', { ascending: true }).limit(200);
      if (!allWeeks) query = query.eq('week_start', weekStart);
      if (!bool(input, 'include_done', true)) query = query.eq('done', false);
      const { data, error } = await query;
      if (error) throw new ActionError(`Actiepunten ophalen mislukt: ${error.message}`);
      const notes = (data ?? []) as Array<Record<string, unknown>>;

      return {
        week_start: allWeeks ? null : weekStart,
        count: notes.length,
        open_count: notes.filter((n) => !n.done).length,
        notes,
        note: notes.length === 0
          ? (allWeeks ? 'Er staan geen actiepunten op je lijst.' : `Geen actiepunten in de week van ${weekStart}.`)
          : null,
      };
    },
  },

  {
    id: 'week_action.set_done',
    label: 'Actiepunt van de week afvinken of weer openzetten',
    module: 'projects',
    kind: 'write',
    description:
      'Zet het vinkje bij een of meer actiepunten van de weekplanner aan of uit. Afgevinkte punten blijven staan (doorgestreept) — ze verdwijnen niet, dus je kunt ze altijd weer openzetten. ' +
      'Werkt alleen op JOUW eigen actiepunten; die van een collega kun je niet aanraken. Zoek de punten met `week_action.list`.',
    keywords: ['afvinken', 'actiepunt', 'checklist', 'weekplanner', 'klaar', 'afgehandeld', 'vinkje'],
    input: {
      note_ids: { type: 'array', items: { type: 'string' }, description: 'Id\'s van de actiepunten (uit week_action.list).' },
      done: { type: 'boolean', description: 'true = afvinken, false = weer openzetten.' },
    },
    required: ['note_ids', 'done'],
    async plan(ctx, input) {
      const noteIds = ids(input, 'note_ids', 50);
      const done = bool(input, 'done', true);
      const { data, error } = await orgQuery(ctx, 'planner_notes', 'id, text, done, week_start')
        .eq('user_id', ctx.userId).in('id', noteIds);
      if (error) throw new ActionError(`Actiepunten ophalen mislukt: ${error.message}`);
      const rows = (data ?? []) as Array<{ id: string; text: string; done: boolean; week_start: string }>;
      if (rows.length === 0) throw new ActionError('Geen van deze actiepunten staat op jouw lijst.');
      if (rows.length !== noteIds.length) {
        const found = new Set(rows.map((r) => String(r.id)));
        throw new ActionError(`Deze actiepunten staan niet op jouw lijst: ${noteIds.filter((x) => !found.has(x)).join(', ')}.`);
      }
      const changing = rows.filter((r) => Boolean(r.done) !== done);
      if (changing.length === 0) throw new ActionError(`Die actiepunten staan al ${done ? 'afgevinkt' : 'open'}.`);

      return {
        title: changing.length === 1
          ? `Actiepunt ${done ? 'afvinken' : 'weer openzetten'}: ${changing[0].text}`
          : `${changing.length} actiepunten ${done ? 'afvinken' : 'weer openzetten'}`,
        sub: joinShort([`week van ${changing[0].week_start}`, ...changing.map((r) => r.text)], 190),
        kind: 'work',
        payload: {
          note_ids: changing.map((r) => String(r.id)),
          texts: changing.map((r) => String(r.text)),
          done,
        },
      };
    },
  },

  {
    id: 'project.team',
    label: 'Projectteam van een project bekijken',
    module: 'projects',
    kind: 'read',
    description:
      'Geeft wie er aan een project gekoppeld is: het projectteam met naam, e-mail en rol, plus hoeveel taken van dit project aan elk teamlid zijn toegewezen. Alleen wie in het projectteam zit is in het taakformulier te kiezen als toegewezene. ' +
      'Geeft er ook bij wie er nog NIET aan gekoppeld is, zodat je meteen weet wie je met `propose_project_team` kunt toevoegen. `list_team_members` geeft alleen de hele organisatie; dit geeft de bezetting van dit ene project.',
    keywords: ['projectteam', 'wie werkt eraan', 'bezetting', 'teamleden', 'toegewezen', 'medewerkers'],
    input: { project_id: { type: 'string', description: 'Id van het project (exact, uit list_projects).' } },
    required: ['project_id'],
    async read(ctx, input) {
      const projectId = id(input, 'project_id');
      const project = await row<{ name: string; client_id: string | null }>(
        ctx, 'projects', projectId, 'name, client_id', 'Project');

      const [memberRes, orgRes, taskRes] = await Promise.all([
        orgQuery(ctx, 'project_members', 'id, user_id, created_at').eq('project_id', projectId),
        orgQuery(ctx, 'organization_members', 'user_id, email, role').eq('status', 'active'),
        orgQuery(ctx, 'tasks', 'id, status').eq('project_id', projectId),
      ]);
      if (memberRes.error) throw new ActionError(`Projectteam ophalen mislukt: ${memberRes.error.message}`);
      if (orgRes.error) throw new ActionError(`Teamleden ophalen mislukt: ${orgRes.error.message}`);
      if (taskRes.error) throw new ActionError(`Taken ophalen mislukt: ${taskRes.error.message}`);

      const members = (memberRes.data ?? []) as Array<{ id: string; user_id: string; created_at: string }>;
      const orgMembers = (orgRes.data ?? []) as Array<{ user_id: string; email: string | null; role: string }>;
      const tasks = (taskRes.data ?? []) as Array<{ id: string; status: string }>;
      const byUser = new Map(orgMembers.map((m) => [String(m.user_id), m]));

      // Hoeveel (open) taken van dit project hangen aan wie.
      const openTaskIds = new Set(tasks.filter((t) => t.status !== 'done').map((t) => String(t.id)));
      const assignedByUser = new Map<string, { total: number; open: number }>();
      if (tasks.length > 0) {
        const { data: assignees } = await orgQuery(ctx, 'task_assignees', 'task_id, user_id')
          .in('task_id', tasks.map((t) => String(t.id)));
        for (const a of (assignees ?? []) as Array<{ task_id: string; user_id: string }>) {
          const key = String(a.user_id);
          const entry = assignedByUser.get(key) ?? { total: 0, open: 0 };
          entry.total += 1;
          if (openTaskIds.has(String(a.task_id))) entry.open += 1;
          assignedByUser.set(key, entry);
        }
      }

      const memberUserIds = new Set(members.map((m) => String(m.user_id)));
      return {
        project: { id: projectId, name: project.name, client_name: await clientNameOf(ctx, project.client_id) },
        count: members.length,
        members: members.map((m) => {
          const info = byUser.get(String(m.user_id));
          const counts = assignedByUser.get(String(m.user_id)) ?? { total: 0, open: 0 };
          return {
            project_member_id: m.id,
            user_id: m.user_id,
            name: info?.email ?? 'Onbekend teamlid',
            email: info?.email ?? null,
            role: info?.role ?? null,
            /** Teamlid staat niet (meer) actief in de organisatie maar hangt nog wel aan het project. */
            still_in_organization: Boolean(info),
            assigned_tasks: counts.total,
            open_tasks: counts.open,
          };
        }),
        not_on_team: orgMembers.filter((m) => !memberUserIds.has(String(m.user_id)))
          .map((m) => ({ user_id: m.user_id, name: m.email ?? 'Teamlid', email: m.email, role: m.role })),
      };
    },
  },

  {
    id: 'project.dashboard',
    label: 'Voortgang, uren en marge van een project opvragen',
    module: 'projects',
    kind: 'read',
    description:
      'Rekent het projectoverzicht uit dat op het projectdashboard staat: hoeveel taken er klaar, open en te laat zijn, hoeveel uren er geboekt zijn tegenover het urenbudget, wat er gefactureerd is en wat dat neerkomt op een effectief uurtarief. ' +
      'Het effectieve uurtarief is de gefactureerde omzet EXCLUSIEF btw (zonder concepten en ingetrokken facturen) gedeeld door de werkelijk geboekte uren — dat is de maat of een aangenomen prijs uit kan. ' +
      'Bedragen staan in centen. Alleen lezen: dit rekent, het boekt en factureert niets. Zoek het project met `list_projects`.',
    keywords: ['projectdashboard', 'voortgang', 'marge', 'rendement', 'effectief uurtarief', 'begroot', 'budget', 'gefactureerd', 'uren', 'loopt het uit'],
    input: { project_id: { type: 'string', description: 'Id van het project (exact, uit list_projects).' } },
    required: ['project_id'],
    async read(ctx, input) {
      const projectId = id(input, 'project_id');
      const project = await row<{
        name: string; client_id: string | null; archived: boolean; start_date: string | null; end_date: string | null;
        billing_type: string; hourly_rate_cents: number | null; budgeted_minutes: number | null;
      }>(ctx, 'projects', projectId,
        'name, client_id, archived, start_date, end_date, billing_type, hourly_rate_cents, budgeted_minutes', 'Project');

      const [taskRes, invoiceRes, timeRes] = await Promise.all([
        orgQuery(ctx, 'tasks', 'id, title, status, end_date, planned_date, planned_end_date').eq('project_id', projectId).limit(1000),
        orgQuery(ctx, 'invoices', 'id, number, status, lines').eq('project_id', projectId).limit(500),
        orgQuery(ctx, 'time_entries', 'minutes, billable, hourly_rate_cents').eq('project_id', projectId).limit(2000),
      ]);
      if (taskRes.error) throw new ActionError(`Taken ophalen mislukt: ${taskRes.error.message}`);
      if (invoiceRes.error) throw new ActionError(`Facturen ophalen mislukt: ${invoiceRes.error.message}`);
      if (timeRes.error) throw new ActionError(`Uren ophalen mislukt: ${timeRes.error.message}`);

      const tasks = (taskRes.data ?? []) as TaskRow[];
      const invoices = (invoiceRes.data ?? []) as Array<{ id: string; number: string; status: string; lines: unknown }>;
      const entries = (timeRes.data ?? []) as Array<{ minutes: number; billable: boolean; hourly_rate_cents: number | null }>;

      const doneTasks = tasks.filter((t) => t.status === 'done').length;
      const openTasks = tasks.length - doneTasks;
      const overdueTasks = tasks.filter((t) => t.status !== 'done' && t.end_date && t.end_date < ctx.today);

      const trackedMinutes = entries.reduce((sum, e) => sum + Number(e.minutes ?? 0), 0);
      // Declarabele waarde precies zoals `timeEntryValueCents` in de app: niet
      // declarabel of geen tarief = geen waarde.
      const trackedValueCents = entries.reduce((sum, e) => (
        e.billable && e.hourly_rate_cents ? sum + Math.round((Number(e.minutes ?? 0) / 60) * Number(e.hourly_rate_cents)) : sum
      ), 0);

      let invoicedTotalCents = 0;
      let invoicedSubtotalCents = 0;
      for (const invoice of invoices) {
        const totals = lineTotals(invoice.lines);
        invoicedTotalCents += totals.total_cents;
        if (!NON_COUNTING_INVOICE_STATUS.includes(String(invoice.status))) invoicedSubtotalCents += totals.subtotal_cents;
      }

      const effectiveRateCents = trackedMinutes > 0 && invoicedSubtotalCents > 0
        ? Math.round(invoicedSubtotalCents / (trackedMinutes / 60))
        : null;
      const budgetedMinutes = project.budgeted_minutes;
      const budgetPct = budgetedMinutes && budgetedMinutes > 0
        ? Math.round((trackedMinutes / budgetedMinutes) * 1000) / 10
        : null;
      const phase = derivePhase(project, tasks, ctx.today);

      return {
        project: {
          id: projectId,
          name: project.name,
          client_name: await clientNameOf(ctx, project.client_id),
          archived: project.archived,
          start_date: project.start_date,
          end_date: project.end_date,
          phase,
          phase_label: PHASE_LABELS[phase],
          billing_type: project.billing_type,
          billing_label: BILLING_LABELS[project.billing_type] ?? project.billing_type,
          hourly_rate_cents: project.hourly_rate_cents,
        },
        tasks: {
          total: tasks.length,
          done: doneTasks,
          open: openTasks,
          overdue: overdueTasks.length,
          overdue_titles: overdueTasks.slice(0, 10).map((t) => t.title),
          progress_pct: tasks.length > 0 ? Math.round((doneTasks / tasks.length) * 100) : 0,
        },
        hours: {
          tracked_minutes: trackedMinutes,
          tracked_hours: Math.round((trackedMinutes / 60) * 100) / 100,
          billable_value_cents: trackedValueCents,
          budgeted_minutes: budgetedMinutes,
          budget_used_pct: budgetPct,
          over_budget: budgetPct !== null && budgetPct > 100,
        },
        money: {
          invoiced_total_cents: invoicedTotalCents,
          invoiced_excl_vat_cents: invoicedSubtotalCents,
          invoice_count: invoices.length,
          effective_hourly_rate_cents: effectiveRateCents,
        },
        summary: joinShort([
          `${doneTasks}/${tasks.length} taken klaar`,
          overdueTasks.length > 0 ? `${overdueTasks.length} te laat` : null,
          `${Math.round((trackedMinutes / 60) * 10) / 10} uur geboekt`,
          budgetPct !== null ? `${budgetPct}% van het budget` : null,
          `gefactureerd ${euroCents(invoicedSubtotalCents)} excl. btw`,
          effectiveRateCents !== null ? `effectief ${euroCents(effectiveRateCents)}/uur` : null,
        ], 220),
      };
    },
  },

  {
    id: 'project.phases',
    label: 'Projecten met hun fase op de tijdbalk bekijken',
    module: 'projects',
    kind: 'read',
    description:
      'Geeft de projecten met de fase die de projecttijdbalk eraan geeft: planning (nog niet begonnen), actief (bezig of de start is geweest), review (er ligt werk ter beoordeling), te laat (de einddatum is voorbij en er is nog werk) of afgerond (alle taken klaar, of gearchiveerd). ' +
      'Daarbij per project de looptijd, de voortgang in procenten en hoeveel taken er nog open staan. Dit is de lijst waarmee je ziet WAAR het knelt; `list_projects` geeft alleen de kale rijen. ' +
      'Filter met `phase` op één fase, bijvoorbeeld "overdue" voor alles wat uitloopt.',
    keywords: ['tijdbalk', 'timeline', 'planning', 'fase', 'te laat', 'uitgelopen', 'achterstand', 'loopt', 'gantt', 'overzicht projecten'],
    input: {
      phase: { type: 'string', enum: [...PROJECT_PHASE], description: 'Alleen projecten in deze fase.' },
      client_id: { type: 'string', description: 'Alleen projecten van deze klant (uit search_clients).' },
      include_archived: { type: 'boolean', description: 'Ook gearchiveerde projecten (standaard false).' },
      limit: { type: 'number', description: 'Hoogste aantal projecten (standaard 50, max 200).' },
    },
    async read(ctx, input) {
      const phase = optChoice(input, 'phase', PROJECT_PHASE);
      const clientId = optId(input, 'client_id');
      const limit = Math.min(Math.max(Math.round(optNum(input, 'limit') ?? 50), 1), 200);

      let query = orgQuery(ctx, 'projects', 'id, name, client_id, archived, start_date, end_date, created_at')
        .order('start_date', { ascending: true }).limit(500);
      if (!bool(input, 'include_archived', false)) query = query.eq('archived', false);
      if (clientId) query = query.eq('client_id', clientId);
      const { data, error } = await query;
      if (error) throw new ActionError(`Projecten ophalen mislukt: ${error.message}`);
      const projects = (data ?? []) as Array<{
        id: string; name: string; client_id: string | null; archived: boolean;
        start_date: string | null; end_date: string | null; created_at: string;
      }>;
      if (projects.length === 0) return { count: 0, phase: phase ?? null, projects: [], phase_counts: {} };

      const { data: taskData, error: taskError } = await orgQuery(ctx, 'tasks', 'project_id, status, end_date')
        .in('project_id', projects.map((p) => p.id)).limit(5000);
      if (taskError) throw new ActionError(`Taken ophalen mislukt: ${taskError.message}`);
      const byProject = new Map<string, Array<{ status: string; end_date: string | null }>>();
      for (const t of (taskData ?? []) as Array<{ project_id: string; status: string; end_date: string | null }>) {
        const key = String(t.project_id);
        const list = byProject.get(key);
        if (list) list.push(t); else byProject.set(key, [t]);
      }

      const clientIds = [...new Set(projects.map((p) => p.client_id).filter((c): c is string => Boolean(c)))];
      const names = new Map<string, string>();
      if (clientIds.length) {
        const { data: clients } = await orgQuery(ctx, 'clients', 'id, name').in('id', clientIds);
        for (const c of (clients ?? []) as Array<{ id: string; name: string }>) names.set(String(c.id), String(c.name));
      }

      const rows = projects.map((p) => {
        const tasks = byProject.get(String(p.id)) ?? [];
        const done = tasks.filter((t) => t.status === 'done').length;
        const derived = derivePhase(p, tasks, ctx.today);
        return {
          id: p.id,
          name: p.name,
          client_name: p.client_id ? names.get(p.client_id) ?? null : null,
          phase: derived,
          phase_label: PHASE_LABELS[derived],
          start_date: p.start_date,
          end_date: p.end_date,
          days_overdue: p.end_date && p.end_date < ctx.today ? daysBetween(p.end_date, ctx.today) : null,
          task_count: tasks.length,
          done_tasks: done,
          open_tasks: tasks.length - done,
          overdue_tasks: tasks.filter((t) => t.status !== 'done' && t.end_date && t.end_date < ctx.today).length,
          progress_pct: tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0,
        };
      });

      const phaseCounts: Record<string, number> = {};
      for (const r of rows) phaseCounts[r.phase] = (phaseCounts[r.phase] ?? 0) + 1;
      const filtered = phase ? rows.filter((r) => r.phase === phase) : rows;

      return {
        count: filtered.length,
        phase: phase ?? null,
        phase_counts: phaseCounts,
        projects: filtered.slice(0, limit),
      };
    },
  },
];
