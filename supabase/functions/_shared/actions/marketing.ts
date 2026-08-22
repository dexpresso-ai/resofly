import {
  ActionError, bool, choice, euroCents, id, ids, joinShort, num, optChoice, optId,
  optIsoDate, optNum, optStr, orgQuery, row, str,
  type ActionCtx, type ActionDef,
} from './types.ts';

/**
 * Handelingen rond MARKETING in de brede zin: e-mailcampagnes en follow-up-stromen,
 * contracten met hun sjablonen, en de galerij waarin een project wordt opgeleverd.
 *
 * Wat er al ligt en hier dus NIET nog eens komt: `propose_campaign` (een concept
 * opstellen), `propose_contract` (een concept-contract), `list_campaigns`,
 * `list_contracts`, `list_contract_templates` en `list_galleries`. Die tools maken
 * en tonen; wat hier staat is alles wat daarna komt — de doelgroep samenstellen, de
 * knop "versturen", de ondertekenmail, het publiceren van een oplevering.
 *
 * DE MODULESLEUTEL VOLGT DE APP, niet dit bestand. In de app hangt een contract
 * onder `finance` en een galerij onder `projects` (zie TOOL_MODULES in gerrieCore);
 * de modulerechten van een teamlid worden daarop gecontroleerd. Alleen de campagnes
 * en stromen staan onder `marketing`.
 *
 * ER GAAT HIER ECHT POST DE DEUR UIT. Vier handelingen zijn onomkeerbaar zodra ze
 * langs het akkoord zijn: een campagne versturen, een stroom activeren, een contract
 * ter ondertekening sturen en een deellink genereren. Bij elk daarvan staat in `sub`
 * wat er precies gebeurt en naar wie — dat is het enige wat de gebruiker leest op
 * het moment dat hij op Uitvoeren drukt.
 *
 * WAT BEWUST ONTBREEKT: weggooien. Een campagne, een stroom, een conceptcontract,
 * een sjabloon, een categorie, een galerij of een galerij-item verwijderen kan hier
 * niet. Een campagne die niet doorgaat annuleer je, een stroom stop je, een galerij
 * zet je terug op concept. Ook uploaden en downloaden ontbreekt: een agent heeft
 * geen bestand in handen.
 */

// ── Vaste keuzelijsten, gelijk aan src/types.ts ──────────────────────────────

const CLIENT_STATUSES = ['active', 'prospect', 'inactive'] as const;
const AUDIENCE_MODES = ['filter', 'manual'] as const;
const FILTER_OPERATORS = ['is', 'not', 'filled', 'empty'] as const;
const STOP_CONDITIONS = ['reply', 'open_click_reply', 'click_reply'] as const;
const GALLERY_FORMATS = ['photo', 'video', 'hybrid'] as const;
const GALLERY_QUALITY = ['original', 'web'] as const;
const HERO_TEMPLATES = [
  'full', 'minimal', 'fade',
  'editorial', 'frame', 'split', 'cutout', 'duotone',
  'classic', 'collage', 'arch', 'stack',
  'cinematic', 'mosaic', 'slideshow', 'netflix',
] as const;

const STATUS_LABEL: Record<string, string> = {
  active: 'actief', prospect: 'prospect', inactive: 'inactief',
};
const STOP_LABEL: Record<string, string> = {
  reply: 'geantwoord',
  open_click_reply: 'geopend, geklikt of geantwoord',
  click_reply: 'geklikt of geantwoord',
};
const CAMPAIGN_STATUS_LABEL: Record<string, string> = {
  draft: 'concept', scheduled: 'ingepland', sending: 'aan het versturen',
  sent: 'verstuurd', paused: 'gepauzeerd', cancelled: 'geannuleerd',
};
const FLOW_STATUS_LABEL: Record<string, string> = {
  draft: 'concept', active: 'lopend', paused: 'gepauzeerd', archived: 'gestopt',
};
const CONTRACT_STATUS_LABEL: Record<string, string> = {
  draft: 'concept', pending_internal_approval: 'wacht op interne goedkeuring',
  internally_approved: 'intern goedgekeurd', sent: 'wacht op ondertekening',
  signed: 'ondertekend', declined: 'geweigerd', expired: 'verlopen', voided: 'ingetrokken',
};

// ── Kleine hulpjes ──────────────────────────────────────────────────────────

/** Naam van een klant, of null. Bewust zacht: dit is alleen versiering op de kaart. */
async function clientNameOf(ctx: ActionCtx, clientId: string | null): Promise<string | null> {
  if (!clientId) return null;
  const { data } = await orgQuery(ctx, 'clients', 'name').eq('id', clientId).maybeSingle();
  return data ? String((data as { name: string }).name) : null;
}

/** Bedrag in centen als leesbaar bedrag, of null als er geen bedrag is. */
function centsOrNull(cents: number | null): string | null {
  return cents === null ? null : euroCents(cents);
}

/** Knipt tekst af tot iets wat op een goedkeurkaart past. */
function excerpt(text: string, max = 140): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Een verzendmoment als JJJJ-MM-DDTHH:MM. Bewust ZONDER tijdzone: de browser zet
 * hem straks om met `new Date(...)`, precies zoals het datumveld in het scherm —
 * dus in de tijd van de gebruiker. Zou de server hier al een ISO-tijd maken, dan
 * schoof een campagne twee uur op.
 */
function localDateTime(input: Record<string, unknown>, key: string): string {
  const value = String(input[key] ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(value)) {
    throw new ActionError(`"${key}" moet een moment zijn als JJJJ-MM-DDTUU:MM, bijvoorbeeld 2026-09-01T09:30.`);
  }
  const normalized = value.replace(' ', 'T').slice(0, 16);
  // Ruime ondergrens: de exacte tijdzone kennen we hier niet, dus we weigeren
  // alleen wat onmiskenbaar in het verleden ligt.
  const parsed = Date.parse(`${normalized}:00Z`);
  if (Number.isFinite(parsed) && parsed < Date.now() - 36 * 3600 * 1000) {
    throw new ActionError('Dat verzendmoment ligt in het verleden. Kies een moment in de toekomst.');
  }
  return normalized;
}

/** Een geldig e-mailadres, in kleine letters. */
function email(input: Record<string, unknown>, key: string): string {
  const value = String(input[key] ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new ActionError(`"${key}" moet een geldig e-mailadres zijn.`);
  return value.slice(0, 320);
}

interface AudienceResult {
  /** Precies de vorm die `CampaignAudience` in de app heeft (camelCase!). */
  audience: Record<string, unknown>;
  /** Eén regel die op de goedkeurkaart uitlegt wie er post krijgt. */
  summary: string;
}

/**
 * Bouwt een doelgroep uit losse invoer en legt hem in gewone taal uit.
 *
 * De sleutels zijn camelCase omdat de campaigns-functie ze zo leest; dat is geen
 * slordigheid maar het bestaande contract met `CampaignAudience`.
 *
 * Het aantal ontvangers wordt hier NIET geteld. Die telling zit in de campaigns-
 * edge-function (suppressielijst, contactpersonen, klanten zonder adres) en die
 * hier namaken zou een getal opleveren dat afwijkt van wat er straks echt uitgaat.
 * De uitvoerder in de browser roept de echte telling aan en noemt hem in zijn
 * bevestiging.
 */
async function buildAudience(ctx: ActionCtx, input: Record<string, unknown>): Promise<AudienceResult> {
  const mode = optChoice(input, 'mode', AUDIENCE_MODES) ?? 'filter';

  const statuses: string[] = [];
  if (Array.isArray(input.statuses)) {
    for (const raw of input.statuses as unknown[]) {
      const value = String(raw).trim();
      if (!(CLIENT_STATUSES as readonly string[]).includes(value)) {
        throw new ActionError(`"${value}" is geen klantstatus. Kies uit: ${CLIENT_STATUSES.join(', ')}.`);
      }
      if (!statuses.includes(value)) statuses.push(value);
    }
  }

  const tags = Array.isArray(input.tags)
    ? [...new Set((input.tags as unknown[]).map((t) => String(t).trim()).filter(Boolean))].slice(0, 30)
    : [];

  const includeContacts = bool(input, 'include_contacts', false);

  let manualClientIds: string[] = [];
  let manualNames: string[] = [];
  if (mode === 'manual') {
    manualClientIds = ids(input, 'manual_client_ids', 500);
    const { data, error } = await orgQuery(ctx, 'clients', 'id, name').in('id', manualClientIds);
    if (error) throw new ActionError(`Klanten ophalen mislukt: ${error.message}`);
    const found: Array<Record<string, unknown>> = data ?? [];
    if (found.length !== manualClientIds.length) {
      throw new ActionError(`${manualClientIds.length - found.length} van de opgegeven klanten bestaat niet in deze organisatie.`);
    }
    manualNames = found.map((r) => String(r.name));
  } else if (Array.isArray(input.manual_client_ids) && (input.manual_client_ids as unknown[]).length > 0) {
    throw new ActionError('Handmatig gekozen klanten horen bij mode "manual". Zet mode op "manual" of laat manual_client_ids weg.');
  }

  const customFilters: Array<Record<string, unknown>> = [];
  const filterTexts: string[] = [];
  if (Array.isArray(input.custom_filters) && (input.custom_filters as unknown[]).length > 0) {
    const { data: defs, error } = await orgQuery(ctx, 'client_field_definitions', 'field_key, label, options, is_archived');
    if (error) throw new ActionError(`Klantvelden ophalen mislukt: ${error.message}`);
    const byKey = new Map<string, Record<string, unknown>>(
      (defs ?? []).map((d: Record<string, unknown>) => [String(d.field_key), d]),
    );
    for (const raw of (input.custom_filters as unknown[]).slice(0, 20)) {
      const rule = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
      const fieldKey = String(rule.field_key ?? '').trim();
      const def = byKey.get(fieldKey);
      if (!def) {
        throw new ActionError(`Het klantveld "${fieldKey}" bestaat niet. Bekende velden: ${[...byKey.keys()].join(', ') || 'geen'}.`);
      }
      if (def.is_archived) throw new ActionError(`Het klantveld "${fieldKey}" is gearchiveerd en filtert niets meer.`);
      const operator = String(rule.operator ?? '').trim();
      if (!(FILTER_OPERATORS as readonly string[]).includes(operator)) {
        throw new ActionError(`"${operator}" is geen voorwaarde. Kies uit: ${FILTER_OPERATORS.join(', ')}.`);
      }
      const value = String(rule.value ?? '').trim();
      if ((operator === 'is' || operator === 'not') && !value) {
        throw new ActionError(`De voorwaarde "${operator}" op "${def.label}" heeft een waarde nodig.`);
      }
      const options = Array.isArray(def.options) ? (def.options as unknown[]).map(String) : [];
      if (options.length > 0 && value && !options.includes(value)) {
        throw new ActionError(`"${value}" is geen keuze bij "${def.label}". Kies uit: ${options.join(', ')}.`);
      }
      customFilters.push({ fieldKey, operator, value: operator === 'filled' || operator === 'empty' ? '' : value });
      const words: Record<string, string> = { is: 'is', not: 'is niet', filled: 'is ingevuld', empty: 'is leeg' };
      filterTexts.push(`${def.label} ${words[operator]}${value ? ` ${value}` : ''}`);
    }
  }

  if (mode === 'filter' && statuses.length === 0 && tags.length === 0 && customFilters.length === 0) {
    // Geen filter betekent in de app: iedereen. Dat mag, maar niet per ongeluk.
    if (!bool(input, 'confirm_all_clients', false)) {
      throw new ActionError('Zonder status, label of voorwaarde gaat de campagne naar ALLE klanten. Bevestig dat met confirm_all_clients = true, of geef een filter op.');
    }
  }

  const summary = mode === 'manual'
    ? joinShort([`${manualClientIds.length} handmatig gekozen klant${manualClientIds.length === 1 ? '' : 'en'}`, ...manualNames.slice(0, 4), includeContacts ? 'ook de contactpersonen' : null], 120)
    : joinShort([
      statuses.length ? `status ${statuses.map((s) => STATUS_LABEL[s] ?? s).join(', ')}` : null,
      tags.length ? `label ${tags.join(', ')}` : null,
      ...filterTexts,
      includeContacts ? 'ook de contactpersonen' : null,
    ], 120) || 'alle klanten';

  return {
    audience: { mode, statuses, tags, includeContacts, manualClientIds, customFilters },
    summary,
  };
}

/** De invoerbeschrijving van een doelgroep; drie handelingen delen hem. */
const AUDIENCE_INPUT: Record<string, unknown> = {
  mode: { type: 'string', enum: [...AUDIENCE_MODES], description: '"filter" = op status/labels/vrije velden, "manual" = een handmatig gekozen lijst klanten. Standaard "filter".' },
  statuses: { type: 'array', items: { type: 'string', enum: [...CLIENT_STATUSES] }, description: 'Alleen klanten met deze status.' },
  tags: { type: 'array', items: { type: 'string' }, description: 'Alleen klanten met minstens één van deze labels.' },
  include_contacts: { type: 'boolean', description: 'Ook de contactpersonen van de gekozen klanten aanschrijven, niet alleen het hoofdadres.' },
  manual_client_ids: { type: 'array', items: { type: 'string' }, description: 'Bij mode "manual": de exacte klant-id\'s uit search_clients.' },
  custom_filters: {
    type: 'array',
    description: 'Voorwaarden op vrije klantvelden; ze moeten ALLEMAAL kloppen. Vraag de velden op met `client_field.list`.',
    items: {
      type: 'object',
      properties: {
        field_key: { type: 'string', description: 'De sleutel van het klantveld, bv. "pakket".' },
        operator: { type: 'string', enum: [...FILTER_OPERATORS], description: 'is / is niet / is ingevuld / is leeg.' },
        value: { type: 'string', description: 'De waarde bij "is" en "not"; laat leeg bij "filled" en "empty".' },
      },
    },
  },
  confirm_all_clients: { type: 'boolean', description: 'Alleen nodig als je bewust géén filter zet: bevestigt dat de hele klantenlijst de doelgroep is.' },
};

export const MARKETING_ACTIONS: ActionDef[] = [
  // ══ Campagnes ═════════════════════════════════════════════════════════════
  {
    id: 'campaign.update_content',
    label: 'Inhoud van een campagne bijwerken',
    module: 'marketing',
    kind: 'write',
    description:
      'Schrijft de interne naam, de onderwerpregel, de preheader (het zinnetje dat de ontvanger naast het onderwerp ziet), de tekst en de accentkleur van een BESTAANDE campagne. ' +
      'Gebruik `propose_campaign` om er een aan te maken en deze handeling om hem daarna bij te werken. Alleen een concept of een ingeplande campagne is nog te wijzigen — wat verstuurd is staat vast. ' +
      'Geef de tekst als platte tekst met een witregel tussen de alinea\'s; de app maakt er de mail-HTML van. Wat je weglaat blijft staan.',
    keywords: ['campagne', 'mailing', 'nieuwsbrief', 'onderwerp', 'preheader', 'tekst', 'inhoud', 'accentkleur', 'bijwerken', 'aanpassen'],
    input: {
      campaign_id: { type: 'string', description: 'Id van de campagne (exact, uit list_campaigns).' },
      name: { type: 'string', description: 'Interne naam; die ziet de ontvanger niet.' },
      subject: { type: 'string', description: 'De onderwerpregel die de ontvanger wél ziet.' },
      preheader: { type: 'string', description: 'Kort voorbeeldtekstje onder het onderwerp.' },
      body_text: { type: 'string', description: 'De tekst van de mail, platte tekst met witregels tussen de alinea\'s.' },
      accent_color: { type: 'string', description: 'Hexkleur voor knoppen en accenten, bv. #FFD966.' },
    },
    required: ['campaign_id'],
    async plan(ctx, input) {
      const campaignId = id(input, 'campaign_id');
      const campaign = await row<{ name: string; subject: string; status: string }>(
        ctx, 'email_campaigns', campaignId, 'name, subject, status', 'Campagne');
      if (!['draft', 'scheduled'].includes(campaign.status)) {
        throw new ActionError(`Deze campagne is ${CAMPAIGN_STATUS_LABEL[campaign.status] ?? campaign.status} en kan niet meer worden gewijzigd.`);
      }

      const patch: Record<string, unknown> = {};
      const name = optStr(input, 'name', 200);
      if (name) patch.name = name;
      const subject = optStr(input, 'subject', 300);
      if (subject) patch.subject = subject;
      if (input.preheader !== undefined) patch.preheader = optStr(input, 'preheader', 300);
      const bodyText = optStr(input, 'body_text', 20000);
      if (bodyText) patch.body_text = bodyText;
      const accent = optStr(input, 'accent_color', 9);
      if (accent) {
        if (!/^#[0-9a-f]{6}$/i.test(accent)) throw new ActionError('Geef de accentkleur als hexcode, bijvoorbeeld #FFD966.');
        patch.accent_color = accent;
      }
      if (Object.keys(patch).length === 0) throw new ActionError('Geef minstens één ding dat moet veranderen.');

      const labels: Record<string, string> = {
        name: 'naam', subject: 'onderwerp', preheader: 'preheader', body_text: 'tekst', accent_color: 'accentkleur',
      };
      return {
        title: `Campagne bijwerken: ${campaign.name || '(naamloos)'}`,
        sub: joinShort([
          subject ? `onderwerp wordt "${excerpt(subject, 60)}"` : null,
          ...Object.keys(patch).filter((k) => k !== 'subject').map((k) => labels[k] ?? k),
          'er gaat nog niets de deur uit',
        ]),
        kind: 'mail',
        payload: { campaign_id: campaignId, campaign_name: campaign.name, patch },
      };
    },
  },

  {
    id: 'campaign.set_audience',
    label: 'Doelgroep van een campagne samenstellen',
    module: 'marketing',
    kind: 'write',
    description:
      'Bepaalt wie de campagne krijgt: op klantstatus, labels en voorwaarden op vrije klantvelden ("Pakket is Premium"), of een handmatig gekozen lijst klanten. ' +
      'Met `include_contacts` gaat de mail ook naar de contactpersonen van die klanten en niet alleen naar het hoofdadres. Alle voorwaarden op vrije velden moeten kloppen (EN). ' +
      'Dit verstuurt niets — het legt alleen vast wie in aanmerking komt. De bevestiging noemt het exacte aantal ontvangers dat overblijft nadat afmeldingen en klanten zonder e-mailadres eraf zijn; ' +
      'gebruik dat om te controleren of de doelgroep klopt vóór je `campaign.send_now` voorstelt.',
    keywords: ['doelgroep', 'ontvangers', 'segment', 'selectie', 'wie krijgt', 'filter', 'labels', 'status', 'contactpersonen'],
    input: {
      campaign_id: { type: 'string', description: 'Id van de campagne (exact, uit list_campaigns).' },
      ...AUDIENCE_INPUT,
    },
    required: ['campaign_id'],
    async plan(ctx, input) {
      const campaignId = id(input, 'campaign_id');
      const campaign = await row<{ name: string; status: string }>(ctx, 'email_campaigns', campaignId, 'name, status', 'Campagne');
      if (!['draft', 'scheduled'].includes(campaign.status)) {
        throw new ActionError(`Deze campagne is ${CAMPAIGN_STATUS_LABEL[campaign.status] ?? campaign.status}; de doelgroep ligt vast.`);
      }
      const { audience, summary } = await buildAudience(ctx, input);
      return {
        title: `Doelgroep zetten voor campagne "${campaign.name || '(naamloos)'}"`,
        sub: joinShort([summary, 'afmeldingen en klanten zonder adres vallen automatisch af'], 130),
        kind: 'mail',
        payload: { campaign_id: campaignId, campaign_name: campaign.name, audience },
      };
    },
  },

  {
    id: 'campaign.send_test',
    label: 'Testmail van een campagne versturen',
    module: 'marketing',
    kind: 'write',
    risk: 'high',
    description:
      'Stuurt de campagne als testmail naar één opgegeven adres, zonder tracking en zonder iemand uit de doelgroep aan te raken. De campagne wordt eerst opgeslagen zoals hij nu is. ' +
      'Dit is de veilige manier om te zien hoe de mail eruitziet vóór hij naar het hele segment gaat.',
    keywords: ['testmail', 'proefmail', 'test versturen', 'voorbeeld', 'controleren'],
    input: {
      campaign_id: { type: 'string' },
      test_email: { type: 'string', description: 'Het adres dat de testmail krijgt.' },
    },
    required: ['campaign_id', 'test_email'],
    async plan(ctx, input) {
      const campaignId = id(input, 'campaign_id');
      const testEmail = email(input, 'test_email');
      const campaign = await row<{ name: string; subject: string }>(ctx, 'email_campaigns', campaignId, 'name, subject', 'Campagne');
      if (!String(campaign.subject || '').trim()) throw new ActionError('Deze campagne heeft nog geen onderwerpregel; vul die eerst in.');
      return {
        title: `Testmail sturen van "${campaign.name || '(naamloos)'}"`,
        sub: joinShort([`naar ${testEmail}`, 'één mail, geen tracking, de doelgroep krijgt niets']),
        kind: 'mail',
        payload: { campaign_id: campaignId, campaign_name: campaign.name, test_email: testEmail },
      };
    },
  },

  {
    id: 'campaign.send_now',
    label: 'Campagne nu versturen naar de hele doelgroep',
    module: 'marketing',
    kind: 'write',
    risk: 'high',
    description:
      'Zet de verzending in gang: de ontvangerslijst wordt vastgelegd en de eerste batch gaat direct de deur uit, de rest volgt automatisch. ' +
      'ONOMKEERBAAR — verstuurde mail komt niet terug. Alleen een concept of een ingeplande campagne kan hier gestart worden; een gepauzeerde hervat je met `campaign.resume`. ' +
      'Zet eerst de doelgroep met `campaign.set_audience` en stuur een testmail. Stel dit nooit voor zonder dat de gebruiker er expliciet om vroeg.',
    keywords: ['versturen', 'verzenden', 'nu versturen', 'uitsturen', 'mailing starten', 'campagne starten'],
    input: { campaign_id: { type: 'string' } },
    required: ['campaign_id'],
    async plan(ctx, input) {
      const campaignId = id(input, 'campaign_id');
      const campaign = await row<{ name: string; subject: string; status: string; audience: Record<string, unknown> | null }>(
        ctx, 'email_campaigns', campaignId, 'name, subject, status, audience', 'Campagne');
      if (!['draft', 'scheduled'].includes(campaign.status)) {
        throw new ActionError(`Deze campagne is ${CAMPAIGN_STATUS_LABEL[campaign.status] ?? campaign.status}; alleen een concept of ingeplande campagne kan hier verstuurd worden.`);
      }
      if (!String(campaign.subject || '').trim()) throw new ActionError('Vul eerst een onderwerpregel in.');

      const audience = campaign.audience ?? {};
      const mode = String((audience as Record<string, unknown>).mode ?? 'filter');
      const manual = Array.isArray((audience as Record<string, unknown>).manualClientIds)
        ? ((audience as Record<string, unknown>).manualClientIds as unknown[]).length : 0;
      const statuses = Array.isArray((audience as Record<string, unknown>).statuses)
        ? ((audience as Record<string, unknown>).statuses as unknown[]).map(String) : [];
      const tags = Array.isArray((audience as Record<string, unknown>).tags)
        ? ((audience as Record<string, unknown>).tags as unknown[]).map(String) : [];
      const who = mode === 'manual'
        ? `${manual} handmatig gekozen klant${manual === 1 ? '' : 'en'}`
        : joinShort([
          statuses.length ? `status ${statuses.map((s) => STATUS_LABEL[s] ?? s).join(', ')}` : null,
          tags.length ? `label ${tags.join(', ')}` : null,
        ], 60) || 'ALLE klanten';

      return {
        title: `Campagne NU versturen: ${campaign.name || '(naamloos)'}`,
        sub: joinShort([
          `onderwerp "${excerpt(campaign.subject, 50)}"`,
          `naar ${who}`,
          'onomkeerbaar — de mail gaat direct de deur uit',
        ], 140),
        kind: 'mail',
        payload: { campaign_id: campaignId, campaign_name: campaign.name },
      };
    },
  },

  {
    id: 'campaign.schedule',
    label: 'Campagne inplannen voor later',
    module: 'marketing',
    kind: 'write',
    description:
      'Zet de campagne op "ingepland" met een verzendmoment. Op dat moment stuurt de app hem AUTOMATISCH uit, zonder dat er nog iemand op een knop drukt. ' +
      'Tot dat moment kun je hem nog wijzigen of annuleren. Geef het moment in de tijd van de gebruiker, als JJJJ-MM-DDTUU:MM.',
    keywords: ['inplannen', 'plannen', 'later versturen', 'verzendmoment', 'schedule', 'agenderen'],
    input: {
      campaign_id: { type: 'string' },
      scheduled_at: { type: 'string', description: 'Het verzendmoment, bv. 2026-09-01T09:30 (lokale tijd).' },
    },
    required: ['campaign_id', 'scheduled_at'],
    async plan(ctx, input) {
      const campaignId = id(input, 'campaign_id');
      const when = localDateTime(input, 'scheduled_at');
      const campaign = await row<{ name: string; subject: string; status: string }>(
        ctx, 'email_campaigns', campaignId, 'name, subject, status', 'Campagne');
      if (!['draft', 'scheduled'].includes(campaign.status)) {
        throw new ActionError(`Deze campagne is ${CAMPAIGN_STATUS_LABEL[campaign.status] ?? campaign.status} en kan niet (meer) worden ingepland.`);
      }
      if (!String(campaign.subject || '').trim()) throw new ActionError('Vul eerst een onderwerpregel in.');
      const [date, time] = when.split('T');
      return {
        title: `Campagne inplannen: ${campaign.name || '(naamloos)'}`,
        sub: joinShort([`gaat automatisch uit op ${date} om ${time}`, 'tot dan nog te wijzigen of te annuleren']),
        kind: 'mail',
        payload: { campaign_id: campaignId, campaign_name: campaign.name, scheduled_at: when },
      };
    },
  },

  {
    id: 'campaign.pause',
    label: 'Lopende of ingeplande campagne pauzeren',
    module: 'marketing',
    kind: 'write',
    description:
      'Legt een campagne die aan het versturen is (of klaarstaat om automatisch uit te gaan) stil. Wat al verstuurd is blijft verstuurd; de rest van de wachtrij blijft staan tot je hervat. Omkeerbaar met `campaign.resume`.',
    keywords: ['pauzeren', 'stilleggen', 'stoppen', 'onderbreken', 'pauze'],
    input: { campaign_id: { type: 'string' } },
    required: ['campaign_id'],
    async plan(ctx, input) {
      const campaignId = id(input, 'campaign_id');
      const campaign = await row<{ name: string; status: string }>(ctx, 'email_campaigns', campaignId, 'name, status', 'Campagne');
      if (!['sending', 'scheduled'].includes(campaign.status)) {
        throw new ActionError(`Deze campagne is ${CAMPAIGN_STATUS_LABEL[campaign.status] ?? campaign.status}; alleen een lopende of ingeplande campagne kan gepauzeerd worden.`);
      }
      return {
        title: `Campagne pauzeren: ${campaign.name || '(naamloos)'}`,
        sub: campaign.status === 'sending'
          ? 'de rest van de wachtrij blijft staan tot je hervat'
          : 'hij gaat op het geplande moment niet vanzelf uit',
        kind: 'mail',
        payload: { campaign_id: campaignId, campaign_name: campaign.name },
      };
    },
  },

  {
    id: 'campaign.resume',
    label: 'Gepauzeerde campagne hervatten',
    module: 'marketing',
    kind: 'write',
    risk: 'high',
    description:
      'Laat een gepauzeerde campagne verder gaan: de ontvangers die nog in de wachtrij staan krijgen alsnog hun mail. Er gaat dus ECHT post de deur uit.',
    keywords: ['hervatten', 'doorgaan', 'verder', 'resume', 'weer starten'],
    input: { campaign_id: { type: 'string' } },
    required: ['campaign_id'],
    async plan(ctx, input) {
      const campaignId = id(input, 'campaign_id');
      const campaign = await row<{ name: string; status: string }>(ctx, 'email_campaigns', campaignId, 'name, status', 'Campagne');
      if (campaign.status !== 'paused') {
        throw new ActionError(`Deze campagne is ${CAMPAIGN_STATUS_LABEL[campaign.status] ?? campaign.status}, niet gepauzeerd.`);
      }
      // Hoeveel er nog wachten maakt het verschil tussen "één nakomertje" en
      // "de halve klantenlijst"; dat hoort op de kaart te staan.
      const { count } = await ctx.db.from('email_campaign_recipients')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', ctx.organizationId).eq('campaign_id', campaignId).eq('status', 'pending');
      return {
        title: `Campagne hervatten: ${campaign.name || '(naamloos)'}`,
        sub: joinShort([`nog ${count ?? 0} ontvanger${count === 1 ? '' : 's'} in de wachtrij`, 'die mail gaat hierna echt uit']),
        kind: 'mail',
        payload: { campaign_id: campaignId, campaign_name: campaign.name, pending: count ?? 0 },
      };
    },
  },

  {
    id: 'campaign.cancel',
    label: 'Campagne annuleren',
    module: 'marketing',
    kind: 'write',
    risk: 'high',
    description:
      'Breekt de campagne definitief af. Wat nog in de wachtrij staat gaat NIET meer uit en een ingepland moment vervalt. ONOMKEERBAAR: hervatten kan hierna niet meer. ' +
      'Wat al verstuurd is blijft verstuurd — annuleren haalt geen mail terug. Wil je alleen tijdelijk stilleggen, gebruik dan `campaign.pause`.',
    keywords: ['annuleren', 'afbreken', 'stoppen', 'intrekken', 'niet versturen'],
    input: { campaign_id: { type: 'string' } },
    required: ['campaign_id'],
    async plan(ctx, input) {
      const campaignId = id(input, 'campaign_id');
      const campaign = await row<{ name: string; status: string }>(ctx, 'email_campaigns', campaignId, 'name, status', 'Campagne');
      if (!['draft', 'scheduled', 'sending', 'paused'].includes(campaign.status)) {
        throw new ActionError(`Deze campagne is ${CAMPAIGN_STATUS_LABEL[campaign.status] ?? campaign.status} en kan niet meer geannuleerd worden.`);
      }
      const { count } = await ctx.db.from('email_campaign_recipients')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', ctx.organizationId).eq('campaign_id', campaignId).eq('status', 'pending');
      return {
        title: `Campagne annuleren: ${campaign.name || '(naamloos)'}`,
        sub: joinShort([
          `${count ?? 0} wachtende ontvanger${count === 1 ? '' : 's'} krijgt niets meer`,
          'onomkeerbaar — hervatten kan hierna niet',
        ]),
        kind: 'mail',
        payload: { campaign_id: campaignId, campaign_name: campaign.name, pending: count ?? 0 },
      };
    },
  },

  {
    id: 'campaign.list_recipients',
    label: 'Ontvangers en tracking van een campagne bekijken',
    module: 'marketing',
    kind: 'read',
    description:
      'Geeft per ontvanger van één campagne wat ermee gebeurd is: verstuurd, afgeleverd, geopend, geklikt, geantwoord, gebounced, mislukt of afgemeld — met de bijbehorende momenten. ' +
      '`list_campaigns` geeft de totalen; dit geeft de regels eronder. Handig om te zien wie er reageerde of bij wie de mail stukliep.',
    keywords: ['ontvangers', 'tracking', 'geopend', 'geklikt', 'bounce', 'afgemeld', 'wie heeft gereageerd', 'resultaat'],
    input: {
      campaign_id: { type: 'string' },
      status: {
        type: 'string',
        enum: ['pending', 'sending', 'sent', 'delivered', 'opened', 'clicked', 'bounced', 'failed', 'complained', 'skipped', 'unsubscribed'],
        description: 'Alleen ontvangers met deze status.',
      },
      limit: { type: 'number', description: 'Maximaal aantal regels (standaard 50, maximaal 200).' },
    },
    required: ['campaign_id'],
    async read(ctx, input) {
      const campaignId = id(input, 'campaign_id');
      const campaign = await row<{ name: string; subject: string; status: string }>(
        ctx, 'email_campaigns', campaignId, 'name, subject, status', 'Campagne');
      const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 200);
      let query = orgQuery(ctx, 'email_campaign_recipients',
        'id, to_email, to_name, client_id, contact_id, status, sent_at, delivered_at, opened_at, clicked_at, replied_at, bounced_at, failed_at, unsubscribed_at, error_message')
        .eq('campaign_id', campaignId).order('created_at', { ascending: true }).limit(limit);
      const status = optStr(input, 'status', 30);
      if (status) query = query.eq('status', status);
      const { data, error } = await query;
      if (error) throw new ActionError(`Ontvangers ophalen mislukt: ${error.message}`);

      const { data: stats } = await orgQuery(ctx, 'email_campaign_stats',
        'total, sent, delivered, opened, clicked, replied, bounced, failed, unsubscribed, pending')
        .eq('campaign_id', campaignId).maybeSingle();
      return {
        campaign: { id: campaignId, name: campaign.name, subject: campaign.subject, status: campaign.status },
        totals: stats ?? null,
        recipients: data ?? [],
      };
    },
  },

  // ══ Afmeldingen en blokkeringen ═══════════════════════════════════════════
  {
    id: 'suppression.list',
    label: 'Afmeldingen en geblokkeerde adressen bekijken',
    module: 'marketing',
    kind: 'read',
    description:
      'Geeft de adressen die geen marketingmail meer krijgen, met de reden: "unsubscribed" (zelf afgemeld via de link), "bounced" (adres bestaat niet), "complained" (als spam gemarkeerd) of "manual" (met de hand geblokkeerd). ' +
      'Deze lijst gaat vóór elke doelgroep: staat een adres erop, dan valt het automatisch af.',
    keywords: ['afmeldingen', 'uitschrijvingen', 'blokkeringen', 'suppressie', 'unsubscribe', 'bounce', 'spamklacht', 'zwarte lijst'],
    input: {
      reason: { type: 'string', enum: ['unsubscribed', 'bounced', 'complained', 'manual'], description: 'Alleen deze reden.' },
      limit: { type: 'number', description: 'Maximaal aantal adressen (standaard 100, maximaal 500).' },
    },
    async read(ctx, input) {
      const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 500);
      let query = orgQuery(ctx, 'email_suppressions', 'email, reason, source, created_at')
        .order('created_at', { ascending: false }).limit(limit);
      const reason = optChoice(input, 'reason', ['unsubscribed', 'bounced', 'complained', 'manual'] as const);
      if (reason) query = query.eq('reason', reason);
      const { data, error } = await query;
      if (error) throw new ActionError(`Afmeldingen ophalen mislukt: ${error.message}`);
      return { suppressions: data ?? [] };
    },
  },

  {
    id: 'suppression.add',
    label: 'E-mailadres blokkeren voor marketingmail',
    module: 'marketing',
    kind: 'write',
    description:
      'Zet een adres op de blokkeerlijst. Het valt daarna uit elke doelgroep en krijgt geen campagne of vervolgmail meer. Gewone klantmail (een offerte, een factuur) raakt dit niet. ' +
      'Doe dit als iemand buiten de afmeldlink om vraagt om niets meer te ontvangen.',
    keywords: ['blokkeren', 'afmelden', 'uitschrijven', 'geen mail meer', 'suppressie', 'niet aanschrijven'],
    input: { email: { type: 'string', description: 'Het adres dat geen marketingmail meer krijgt.' } },
    required: ['email'],
    async plan(ctx, input) {
      const address = email(input, 'email');
      const { data: existing } = await orgQuery(ctx, 'email_suppressions', 'email, reason').eq('email', address).maybeSingle();
      if (existing) throw new ActionError(`${address} staat al op de blokkeerlijst (reden: ${(existing as { reason: string }).reason}).`);
      // Wie het adres is maakt de kaart begrijpelijk: "blokkeren" zonder naam is
      // een e-mailadres, mét naam is een klant.
      const { data: client } = await orgQuery(ctx, 'clients', 'name').eq('email', address).maybeSingle();
      return {
        title: `E-mailadres blokkeren: ${address}`,
        sub: joinShort([client ? String((client as { name: string }).name) : null, 'krijgt geen campagnes en vervolgmails meer']),
        kind: 'mail',
        payload: { email: address },
      };
    },
  },

  {
    id: 'suppression.remove',
    label: 'Blokkering van een e-mailadres opheffen',
    module: 'marketing',
    kind: 'write',
    risk: 'high',
    description:
      'Haalt een adres van de blokkeerlijst; het mag daarna weer marketingmail ontvangen. ' +
      'LET OP: stond de reden op "unsubscribed", dan heeft die persoon zich ZELF afgemeld. Hem weer aanschrijven zonder dat hij daar opnieuw om vroeg is in strijd met de AVG. Doe dit alleen als de gebruiker uitdrukkelijk zegt dat de toestemming er weer is.',
    keywords: ['deblokkeren', 'blokkering opheffen', 'weer aanschrijven', 'terugzetten', 'toestemming'],
    input: { email: { type: 'string' } },
    required: ['email'],
    async plan(ctx, input) {
      const address = email(input, 'email');
      const { data: existing } = await orgQuery(ctx, 'email_suppressions', 'email, reason, source, created_at').eq('email', address).maybeSingle();
      if (!existing) throw new ActionError(`${address} staat niet op de blokkeerlijst.`);
      const reason = String((existing as { reason: string }).reason);
      const warning = reason === 'unsubscribed'
        ? 'DEZE PERSOON MELDDE ZICH ZELF AF — alleen deblokkeren met nieuwe toestemming'
        : reason === 'bounced'
          ? 'het adres bouncede eerder; controleer of het klopt'
          : reason === 'complained'
            ? 'deze persoon markeerde de mail als spam'
            : 'handmatig geblokkeerd';
      return {
        title: `Blokkering opheffen: ${address}`,
        sub: joinShort([warning, 'krijgt hierna weer marketingmail'], 130),
        kind: 'mail',
        payload: { email: address, reason },
      };
    },
  },

  // ══ Follow-up-stromen ═════════════════════════════════════════════════════
  {
    id: 'flow.get',
    label: 'Stappen en resultaten van een follow-up-stroom bekijken',
    module: 'marketing',
    kind: 'read',
    description:
      'Geeft één follow-up-stroom in detail: de stopvoorwaarde, de doelgroep, elke stap met zijn wachtdagen en onderwerp, en per stap hoeveel er verstuurd, geopend, geklikt en beantwoord is. ' +
      '`list_campaigns` toont de stromen op hoofdlijnen; dit is wat eronder zit. Doe dit altijd vóór je `flow.set_steps` voorstelt — die vervangt de hele reeks.',
    keywords: ['stroom', 'follow-up', 'opvolging', 'stappen', 'reeks', 'statistiek', 'resultaat'],
    input: { flow_id: { type: 'string', description: 'Id van de stroom (exact, uit list_campaigns).' } },
    required: ['flow_id'],
    async read(ctx, input) {
      const flowId = id(input, 'flow_id');
      const flow = await row<Record<string, unknown>>(
        ctx, 'email_flows', flowId, 'id, name, status, stop_condition, audience, created_at', 'Stroom');
      const [{ data: steps, error: stepError }, { data: stats }, { data: stepStats }] = await Promise.all([
        orgQuery(ctx, 'email_flow_steps', 'step_index, delay_days, subject, preheader, body_text, accent_color')
          .eq('flow_id', flowId).order('step_index', { ascending: true }),
        orgQuery(ctx, 'email_flow_stats', 'enrollments, active, completed, stopped_reacted, stopped_unsubscribed, cancelled')
          .eq('flow_id', flowId).maybeSingle(),
        orgQuery(ctx, 'email_flow_step_stats', 'step_index, sent, opened, clicked, replied, bounced')
          .eq('flow_id', flowId).order('step_index', { ascending: true }),
      ]);
      if (stepError) throw new ActionError(`Stappen ophalen mislukt: ${stepError.message}`);
      return { flow, steps: steps ?? [], totals: stats ?? null, per_step: stepStats ?? [] };
    },
  },

  {
    id: 'flow.create',
    label: 'Follow-up-stroom aanmaken',
    module: 'marketing',
    kind: 'write',
    description:
      'Maakt een nieuwe follow-up-stroom als CONCEPT: een reeks mails die na elkaar uitgaan tot de klant reageert. Er gaat nog niets de deur uit — een concept is inert tot iemand hem activeert. ' +
      'De stopvoorwaarde bepaalt wanneer iemand uit de reeks valt: bij "reply" pas als hij antwoordt, bij "open_click_reply" al bij een opening. Zet daarna de stappen met `flow.set_steps` en de doelgroep met `flow.update`.',
    keywords: ['stroom', 'follow-up', 'opvolging', 'reeks', 'automatisch nabellen', 'drip', 'aanmaken'],
    input: {
      name: { type: 'string', description: 'Interne naam, bv. "Opvolging na offerte".' },
      stop_condition: { type: 'string', enum: [...STOP_CONDITIONS], description: 'Wanneer iemand uit de reeks valt. Standaard "reply".' },
    },
    required: ['name'],
    async plan(_ctx, input) {
      const name = str(input, 'name', 200);
      const stop = optChoice(input, 'stop_condition', STOP_CONDITIONS) ?? 'reply';
      return {
        title: `Follow-up-stroom aanmaken: ${name}`,
        sub: joinShort([`stopt zodra de klant heeft ${STOP_LABEL[stop]}`, 'nog leeg en inactief — er gaat niets uit']),
        kind: 'mail',
        payload: { name, stop_condition: stop },
      };
    },
  },

  {
    id: 'flow.update',
    label: 'Naam, stopvoorwaarde en doelgroep van een stroom bijwerken',
    module: 'marketing',
    kind: 'write',
    description:
      'Wijzigt de interne naam, de stopvoorwaarde en/of de doelgroep van een CONCEPT-stroom. Zodra een stroom loopt staan die dingen vast — wie ingeschreven is, blijft ingeschreven. ' +
      'De doelgroep werkt precies als bij een campagne: op status, labels en voorwaarden op vrije klantvelden, of een handmatige lijst. De bevestiging noemt hoeveel klanten er straks ingeschreven worden.',
    keywords: ['stroom aanpassen', 'doelgroep', 'stopvoorwaarde', 'hernoemen', 'follow-up'],
    input: {
      flow_id: { type: 'string' },
      name: { type: 'string' },
      stop_condition: { type: 'string', enum: [...STOP_CONDITIONS] },
      set_audience: { type: 'boolean', description: 'Zet dit op true als je de doelgroep wilt vervangen; anders blijft de bestaande staan.' },
      ...AUDIENCE_INPUT,
    },
    required: ['flow_id'],
    async plan(ctx, input) {
      const flowId = id(input, 'flow_id');
      const flow = await row<{ name: string; status: string }>(ctx, 'email_flows', flowId, 'name, status', 'Stroom');
      if (flow.status !== 'draft') {
        throw new ActionError(`Deze stroom is ${FLOW_STATUS_LABEL[flow.status] ?? flow.status}; alleen een concept-stroom is nog te wijzigen.`);
      }
      const patch: Record<string, unknown> = {};
      const name = optStr(input, 'name', 200);
      if (name) patch.name = name;
      const stop = optChoice(input, 'stop_condition', STOP_CONDITIONS);
      if (stop) patch.stop_condition = stop;

      let summary: string | null = null;
      if (bool(input, 'set_audience', false)) {
        const built = await buildAudience(ctx, input);
        patch.audience = built.audience;
        summary = built.summary;
      }
      if (Object.keys(patch).length === 0) throw new ActionError('Geef minstens één ding dat moet veranderen (of zet set_audience op true).');

      return {
        title: `Stroom bijwerken: ${flow.name || '(naamloos)'}`,
        sub: joinShort([
          name ? `naam wordt "${name}"` : null,
          stop ? `stopt bij ${STOP_LABEL[stop]}` : null,
          summary ? `doelgroep: ${summary}` : null,
        ], 140),
        kind: 'mail',
        payload: { flow_id: flowId, flow_name: flow.name, patch },
      };
    },
  },

  {
    id: 'flow.set_steps',
    label: 'Stappenreeks van een stroom vervangen',
    module: 'marketing',
    kind: 'write',
    description:
      'Zet de complete reeks vervolgmails van een concept-stroom. De hele bestaande reeks wordt VERVANGEN — haal hem daarom eerst op met `flow.get` en stuur alle stappen mee die moeten blijven, ook de ongewijzigde. ' +
      'Stap 1 gaat direct bij activeren uit (wachtdagen tellen daar niet); elke volgende stap gaat het opgegeven aantal dagen ná de vorige. Geef de tekst als platte tekst met witregels tussen de alinea\'s.',
    keywords: ['stappen', 'vervolgmail', 'reeks', 'wachtdagen', 'stroom vullen', 'herinnering'],
    input: {
      flow_id: { type: 'string' },
      steps: {
        type: 'array',
        description: 'De volledige reeks, in volgorde. Minstens één stap.',
        items: {
          type: 'object',
          properties: {
            delay_days: { type: 'number', description: 'Dagen wachten na de vorige stap. Bij de eerste stap altijd 0.' },
            subject: { type: 'string', description: 'Onderwerpregel van deze mail.' },
            preheader: { type: 'string' },
            body_text: { type: 'string', description: 'De tekst, platte tekst met witregels tussen de alinea\'s.' },
          },
        },
      },
    },
    required: ['flow_id', 'steps'],
    async plan(ctx, input) {
      const flowId = id(input, 'flow_id');
      const flow = await row<{ name: string; status: string }>(ctx, 'email_flows', flowId, 'name, status', 'Stroom');
      if (flow.status !== 'draft') {
        throw new ActionError(`Deze stroom is ${FLOW_STATUS_LABEL[flow.status] ?? flow.status}; stappen wijzigen kan alleen bij een concept.`);
      }
      const raw = Array.isArray(input.steps) ? input.steps as unknown[] : [];
      if (raw.length === 0) throw new ActionError('Geef minstens één stap.');
      if (raw.length > 20) throw new ActionError('Een stroom heeft maximaal twintig stappen.');

      const steps = raw.map((entry, index) => {
        const step = (entry && typeof entry === 'object') ? entry as Record<string, unknown> : {};
        const subject = String(step.subject ?? '').trim();
        if (!subject) throw new ActionError(`Stap ${index + 1} heeft een onderwerp nodig.`);
        const bodyText = String(step.body_text ?? '').trim();
        if (!bodyText) throw new ActionError(`Stap ${index + 1} heeft een tekst nodig.`);
        const delayRaw = Number(step.delay_days ?? 0);
        const delay = index === 0 ? 0 : Math.min(3650, Math.max(0, Math.round(Number.isFinite(delayRaw) ? delayRaw : 0)));
        return {
          step_index: index,
          delay_days: delay,
          subject: subject.slice(0, 300),
          preheader: step.preheader ? String(step.preheader).trim().slice(0, 300) : null,
          body_text: bodyText.slice(0, 20000),
        };
      });

      const { count: existing } = await ctx.db.from('email_flow_steps')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', ctx.organizationId).eq('flow_id', flowId);

      return {
        title: `Stappen zetten in stroom "${flow.name || '(naamloos)'}"`,
        sub: joinShort([
          `${steps.length} stap${steps.length === 1 ? '' : 'pen'}`,
          steps.map((s, i) => (i === 0 ? 'direct' : `+${s.delay_days}d`)).join(' → '),
          existing ? `vervangt de huidige ${existing} stap${existing === 1 ? '' : 'pen'}` : null,
        ], 140),
        kind: 'mail',
        payload: { flow_id: flowId, flow_name: flow.name, steps },
      };
    },
  },

  {
    id: 'flow.activate',
    label: 'Follow-up-stroom activeren',
    module: 'marketing',
    kind: 'write',
    risk: 'high',
    description:
      'Schrijft de hele doelgroep in en stuurt de eerste mail DIRECT uit; de vervolgstappen gaan daarna vanzelf, zonder dat er nog iemand naar kijkt. ' +
      'ONOMKEERBAAR — die eerste mail komt niet terug, en een geactiveerde stroom kun je alleen nog pauzeren of stoppen, niet meer wijzigen. Controleer eerst met `flow.get` of de stappen en de doelgroep kloppen. Stel dit nooit voor zonder dat de gebruiker er expliciet om vroeg.',
    keywords: ['activeren', 'starten', 'aanzetten', 'stroom starten', 'inschrijven'],
    input: { flow_id: { type: 'string' } },
    required: ['flow_id'],
    async plan(ctx, input) {
      const flowId = id(input, 'flow_id');
      const flow = await row<{ name: string; status: string; stop_condition: string; audience: Record<string, unknown> | null }>(
        ctx, 'email_flows', flowId, 'name, status, stop_condition, audience', 'Stroom');
      if (flow.status !== 'draft') {
        throw new ActionError(`Deze stroom is ${FLOW_STATUS_LABEL[flow.status] ?? flow.status}; alleen een concept-stroom kan geactiveerd worden (hervatten doe je met flow.resume).`);
      }
      const { data: steps, error } = await orgQuery(ctx, 'email_flow_steps', 'step_index, delay_days, subject')
        .eq('flow_id', flowId).order('step_index', { ascending: true });
      if (error) throw new ActionError(`Stappen ophalen mislukt: ${error.message}`);
      const list: Array<Record<string, unknown>> = steps ?? [];
      if (list.length === 0) throw new ActionError('Deze stroom heeft nog geen stappen; zet die eerst met `flow.set_steps`.');

      const audience = flow.audience ?? {};
      const mode = String((audience as Record<string, unknown>).mode ?? 'filter');
      const manual = Array.isArray((audience as Record<string, unknown>).manualClientIds)
        ? ((audience as Record<string, unknown>).manualClientIds as unknown[]).length : 0;
      const who = mode === 'manual' ? `${manual} handmatig gekozen klant${manual === 1 ? '' : 'en'}` : 'de ingestelde doelgroep';

      return {
        title: `Follow-up-stroom ACTIVEREN: ${flow.name || '(naamloos)'}`,
        sub: joinShort([
          `${list.length} mail${list.length === 1 ? '' : 's'} naar ${who}`,
          `eerste mail "${excerpt(String(list[0].subject ?? ''), 40)}" gaat direct uit`,
          'onomkeerbaar — de reeks loopt daarna vanzelf door',
        ], 150),
        kind: 'mail',
        payload: { flow_id: flowId, flow_name: flow.name, steps: list.length },
      };
    },
  },

  {
    id: 'flow.pause',
    label: 'Lopende stroom pauzeren',
    module: 'marketing',
    kind: 'write',
    description:
      'Legt een lopende follow-up-stroom stil. Ingeschreven klanten blijven ingeschreven maar krijgen even geen vervolgmail. Omkeerbaar met `flow.resume`.',
    keywords: ['stroom pauzeren', 'stilleggen', 'onderbreken', 'pauze'],
    input: { flow_id: { type: 'string' } },
    required: ['flow_id'],
    async plan(ctx, input) {
      const flowId = id(input, 'flow_id');
      const flow = await row<{ name: string; status: string }>(ctx, 'email_flows', flowId, 'name, status', 'Stroom');
      if (flow.status !== 'active') {
        throw new ActionError(`Deze stroom is ${FLOW_STATUS_LABEL[flow.status] ?? flow.status}, niet lopend.`);
      }
      const { count } = await ctx.db.from('email_flow_enrollments')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', ctx.organizationId).eq('flow_id', flowId).eq('status', 'active');
      return {
        title: `Stroom pauzeren: ${flow.name || '(naamloos)'}`,
        sub: joinShort([`${count ?? 0} lopende inschrijving${count === 1 ? '' : 'en'}`, 'geen vervolgmails tot je hervat']),
        kind: 'mail',
        payload: { flow_id: flowId, flow_name: flow.name },
      };
    },
  },

  {
    id: 'flow.resume',
    label: 'Gepauzeerde stroom hervatten',
    module: 'marketing',
    kind: 'write',
    risk: 'high',
    description:
      'Laat een gepauzeerde stroom verder lopen. De ingeschreven klanten krijgen hun vervolgmails weer, dus er gaat ECHT post de deur uit.',
    keywords: ['stroom hervatten', 'doorgaan', 'verder', 'weer aanzetten'],
    input: { flow_id: { type: 'string' } },
    required: ['flow_id'],
    async plan(ctx, input) {
      const flowId = id(input, 'flow_id');
      const flow = await row<{ name: string; status: string }>(ctx, 'email_flows', flowId, 'name, status', 'Stroom');
      if (flow.status !== 'paused') {
        throw new ActionError(`Deze stroom is ${FLOW_STATUS_LABEL[flow.status] ?? flow.status}, niet gepauzeerd.`);
      }
      const { count } = await ctx.db.from('email_flow_enrollments')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', ctx.organizationId).eq('flow_id', flowId).eq('status', 'active');
      return {
        title: `Stroom hervatten: ${flow.name || '(naamloos)'}`,
        sub: joinShort([`${count ?? 0} inschrijving${count === 1 ? '' : 'en'} loopt weer door`, 'de vervolgmails gaan hierna echt uit']),
        kind: 'mail',
        payload: { flow_id: flowId, flow_name: flow.name },
      };
    },
  },

  {
    id: 'flow.stop',
    label: 'Follow-up-stroom stoppen',
    module: 'marketing',
    kind: 'write',
    risk: 'high',
    description:
      'Beëindigt de stroom definitief: alle lopende inschrijvingen worden geannuleerd en openstaande vervolgstappen gaan NIET meer uit. De stroom komt op "gestopt" te staan; de resultaten blijven leesbaar. ' +
      'ONOMKEERBAAR — hervatten kan hierna niet meer. Wil je alleen tijdelijk stilleggen, gebruik dan `flow.pause`.',
    keywords: ['stroom stoppen', 'beëindigen', 'archiveren', 'annuleren', 'afbreken'],
    input: { flow_id: { type: 'string' } },
    required: ['flow_id'],
    async plan(ctx, input) {
      const flowId = id(input, 'flow_id');
      const flow = await row<{ name: string; status: string }>(ctx, 'email_flows', flowId, 'name, status', 'Stroom');
      if (!['draft', 'active', 'paused'].includes(flow.status)) {
        throw new ActionError(`Deze stroom is al ${FLOW_STATUS_LABEL[flow.status] ?? flow.status}.`);
      }
      const { count } = await ctx.db.from('email_flow_enrollments')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', ctx.organizationId).eq('flow_id', flowId).eq('status', 'active');
      return {
        title: `Stroom stoppen: ${flow.name || '(naamloos)'}`,
        sub: joinShort([
          `${count ?? 0} lopende inschrijving${count === 1 ? '' : 'en'} wordt geannuleerd`,
          'onomkeerbaar — hervatten kan hierna niet',
        ]),
        kind: 'mail',
        payload: { flow_id: flowId, flow_name: flow.name },
      };
    },
  },

  // ══ Contracten ════════════════════════════════════════════════════════════
  // Module 'finance', want dat is waar de app een contract onder hangt.
  {
    id: 'contract.update_details',
    label: 'Kenmerken van een contract bijwerken',
    module: 'finance',
    kind: 'write',
    description:
      'Wijzigt de kenmerken van een CONCEPT-contract: klant, gekoppelde offerte, titel, datum, geldig tot (de ondertekendeadline) en het bedrag met valuta. ' +
      'De inhoud van het contract raakt dit niet — die staat in de tekst of in het Word-document. Zodra een contract verstuurd of ondertekend is, ligt alles vast. Geef alleen wat verandert.',
    keywords: ['contract', 'bewerken', 'titel', 'bedrag', 'geldig tot', 'deadline', 'klant wijzigen', 'offerte koppelen'],
    input: {
      contract_id: { type: 'string', description: 'Id van het contract (exact, uit list_contracts).' },
      client_id: { type: 'string', description: 'Id van de klant.' },
      quote_id: { type: 'string', description: 'Id van de offerte waar dit contract uit voortkomt.' },
      title: { type: 'string' },
      date: { type: 'string', description: 'Contractdatum als JJJJ-MM-DD.' },
      valid_until: { type: 'string', description: 'Ondertekendeadline als JJJJ-MM-DD.' },
      amount_eur: { type: 'number', description: 'Contractwaarde in euro (niet in centen).' },
      currency: { type: 'string', description: 'Valutacode, standaard EUR.' },
    },
    required: ['contract_id'],
    async plan(ctx, input) {
      const contractId = id(input, 'contract_id');
      const contract = await row<{ number: string; title: string; status: string; client_id: string | null }>(
        ctx, 'contracts', contractId, 'number, title, status, client_id', 'Contract');
      if (contract.status !== 'draft') {
        throw new ActionError(`Contract ${contract.number} is ${CONTRACT_STATUS_LABEL[contract.status] ?? contract.status} en kan niet meer worden bewerkt.`);
      }

      const patch: Record<string, unknown> = {};
      const described: string[] = [];

      const clientId = optId(input, 'client_id');
      if (clientId) {
        const client = await row<{ name: string }>(ctx, 'clients', clientId, 'name', 'Klant');
        patch.client_id = clientId;
        described.push(`klant ${client.name}`);
      }
      const quoteId = optId(input, 'quote_id');
      if (quoteId) {
        const quote = await row<{ number: string }>(ctx, 'quotes', quoteId, 'number', 'Offerte');
        patch.quote_id = quoteId;
        described.push(`offerte ${quote.number}`);
      }
      const title = optStr(input, 'title', 300);
      if (title) { patch.title = title; described.push(`titel "${title}"`); }
      const date = optIsoDate(input, 'date');
      if (date) { patch.date = date; described.push(`datum ${date}`); }
      if (input.valid_until !== undefined) {
        const validUntil = optIsoDate(input, 'valid_until');
        patch.valid_until = validUntil;
        described.push(validUntil ? `geldig tot ${validUntil}` : 'geen deadline meer');
      }
      const amount = optNum(input, 'amount_eur');
      if (amount !== null) {
        if (amount < 0) throw new ActionError('Een contractbedrag kan niet negatief zijn.');
        patch.amount_cents = Math.round(amount * 100);
        described.push(`bedrag ${centsOrNull(Math.round(amount * 100))}`);
      }
      const currency = optStr(input, 'currency', 3);
      if (currency) { patch.currency = currency.toUpperCase(); described.push(currency.toUpperCase()); }

      if (Object.keys(patch).length === 0) throw new ActionError('Geef minstens één ding dat moet veranderen.');
      return {
        title: `Contract ${contract.number} bijwerken`,
        sub: joinShort([contract.title || '(zonder titel)', ...described]),
        kind: 'work',
        payload: { contract_id: contractId, contract_number: contract.number, patch },
      };
    },
  },

  {
    id: 'contract.link_project',
    label: 'Project aan een contract koppelen',
    module: 'finance',
    kind: 'write',
    description:
      'Hangt een bestaand project aan een contract, zodat zichtbaar is welke opdracht het contract dekt. Een contract kan meerdere projecten dekken. ' +
      'Het project moet bij dezelfde klant horen als het contract — anders weigert de database de koppeling. Zoek het project met `list_projects`.',
    keywords: ['contract', 'project', 'koppelen', 'verbinden', 'opdracht'],
    input: {
      contract_id: { type: 'string' },
      project_id: { type: 'string' },
    },
    required: ['contract_id', 'project_id'],
    async plan(ctx, input) {
      const contractId = id(input, 'contract_id');
      const projectId = id(input, 'project_id');
      const contract = await row<{ number: string; title: string; client_id: string | null }>(
        ctx, 'contracts', contractId, 'number, title, client_id', 'Contract');
      const project = await row<{ name: string; client_id: string | null; archived: boolean }>(
        ctx, 'projects', projectId, 'name, client_id, archived', 'Project');
      if (contract.client_id && project.client_id && contract.client_id !== project.client_id) {
        throw new ActionError(`"${project.name}" hoort bij een andere klant dan contract ${contract.number}.`);
      }
      const { data: existing } = await orgQuery(ctx, 'contract_projects', 'contract_id')
        .eq('contract_id', contractId).eq('project_id', projectId).maybeSingle();
      if (existing) throw new ActionError(`"${project.name}" hangt al aan contract ${contract.number}.`);
      return {
        title: `Project koppelen aan contract ${contract.number}`,
        sub: joinShort([project.name, contract.title || '(zonder titel)', project.archived ? 'let op: gearchiveerd project' : null]),
        kind: 'work',
        payload: { contract_id: contractId, contract_number: contract.number, project_id: projectId, project_name: project.name },
      };
    },
  },

  {
    id: 'contract.unlink_project',
    label: 'Project van een contract ontkoppelen',
    module: 'finance',
    kind: 'write',
    description:
      'Haalt de koppeling tussen een contract en een project weg. Het project zelf en het contract blijven allebei bestaan; alleen het verband verdwijnt.',
    keywords: ['ontkoppelen', 'losmaken', 'contract', 'project', 'verwijderen koppeling'],
    input: {
      contract_id: { type: 'string' },
      project_id: { type: 'string' },
    },
    required: ['contract_id', 'project_id'],
    async plan(ctx, input) {
      const contractId = id(input, 'contract_id');
      const projectId = id(input, 'project_id');
      const contract = await row<{ number: string; title: string }>(ctx, 'contracts', contractId, 'number, title', 'Contract');
      const project = await row<{ name: string }>(ctx, 'projects', projectId, 'name', 'Project');
      const { data: existing } = await orgQuery(ctx, 'contract_projects', 'contract_id')
        .eq('contract_id', contractId).eq('project_id', projectId).maybeSingle();
      if (!existing) throw new ActionError(`"${project.name}" hangt niet aan contract ${contract.number}.`);
      return {
        title: `Project ontkoppelen van contract ${contract.number}`,
        sub: joinShort([project.name, 'project en contract blijven allebei bestaan']),
        kind: 'work',
        payload: { contract_id: contractId, contract_number: contract.number, project_id: projectId, project_name: project.name },
      };
    },
  },

  {
    id: 'contract.send_for_signature',
    label: 'Contract ter ondertekening versturen',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Mailt de klant een persoonlijke ondertekenlink; de status gaat naar "wacht op ondertekening". Staat het contract al op "wacht op ondertekening", dan is dit een HERINNERING met een nieuwe link. ' +
      'Dit is echte post naar buiten MET RECHTSGEVOLG: de ontvanger kan met die link tekenen, en dan ligt het contract vast. Onomkeerbaar in de zin dat de mail niet terug te halen is. ' +
      'Het contract moet een klant, een titel en inhoud hebben, en de ondertekendeadline mag niet in het verleden liggen. Stel dit nooit voor zonder dat de gebruiker er expliciet om vroeg.',
    keywords: ['versturen', 'ter ondertekening', 'ondertekenen', 'tekenen', 'handtekening', 'opnieuw sturen', 'herinnering'],
    input: {
      contract_id: { type: 'string' },
      recipient_email: { type: 'string', description: 'Afwijkend ontvangeradres; standaard het adres van de klant.' },
      recipient_name: { type: 'string', description: 'Naam van de ondertekenaar; standaard de contactpersoon van de klant.' },
      personal_message: { type: 'string', description: 'Optioneel persoonlijk bericht boven de ondertekenlink.' },
    },
    required: ['contract_id'],
    async plan(ctx, input) {
      const contractId = id(input, 'contract_id');
      const contract = await row<{
        number: string; title: string; status: string; client_id: string | null;
        body: string | null; editor_mode: string | null; body_storage_key: string | null;
        valid_until: string | null; amount_cents: number | null;
      }>(ctx, 'contracts', contractId,
        'number, title, status, client_id, body, editor_mode, body_storage_key, valid_until, amount_cents', 'Contract');

      if (['signed', 'voided', 'declined'].includes(contract.status)) {
        throw new ActionError(`Contract ${contract.number} is ${CONTRACT_STATUS_LABEL[contract.status] ?? contract.status} en kan niet meer verstuurd worden.`);
      }
      if (!contract.client_id) throw new ActionError(`Contract ${contract.number} heeft nog geen klant.`);
      if (!String(contract.title || '').trim()) throw new ActionError(`Contract ${contract.number} heeft nog geen titel.`);
      if (contract.editor_mode === 'office') {
        if (!contract.body_storage_key) throw new ActionError(`Contract ${contract.number} heeft nog geen Word-document.`);
      } else if (!String(contract.body || '').trim()) {
        throw new ActionError(`Contract ${contract.number} heeft nog geen inhoud.`);
      }
      if (contract.valid_until && contract.valid_until < ctx.today) {
        throw new ActionError(`De ondertekendeadline van contract ${contract.number} (${contract.valid_until}) ligt in het verleden. Pas hem eerst aan met \`contract.update_details\`.`);
      }

      const client = await row<{ name: string; email: string | null; contact_name: string | null }>(
        ctx, 'clients', contract.client_id, 'name, email, contact_name', 'Klant');
      const to = String(input.recipient_email ?? '').trim()
        ? email(input, 'recipient_email')
        : (client.email ?? '').trim().toLowerCase();
      if (!to) throw new ActionError(`${client.name} heeft geen e-mailadres; vul dat eerst in of geef recipient_email mee.`);
      const name = optStr(input, 'recipient_name', 200) ?? (client.contact_name || client.name);
      const message = optStr(input, 'personal_message', 2000);
      const resend = contract.status === 'sent';

      return {
        title: resend
          ? `Ondertekenlink OPNIEUW sturen: contract ${contract.number}`
          : `Contract ${contract.number} ter ondertekening versturen`,
        sub: joinShort([
          contract.title,
          `naar ${name} <${to}>`,
          centsOrNull(contract.amount_cents),
          contract.valid_until ? `tekenen vóór ${contract.valid_until}` : null,
          'de ontvanger kan hiermee rechtsgeldig tekenen',
        ], 160),
        kind: 'mail',
        payload: {
          contract_id: contractId, contract_number: contract.number, contract_title: contract.title,
          recipient_email: to, recipient_name: name, personal_message: message ?? '', resend,
        },
      };
    },
  },

  {
    id: 'contract.void',
    label: 'Contract intrekken',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description:
      'Trekt een contract in met een reden. De publieke ondertekenlink wordt onmiddellijk ONGELDIG: een klant die het contract al in zijn mailbox heeft, kan het daarna niet meer tekenen. ' +
      'ONOMKEERBAAR — een ingetrokken contract komt niet terug op "concept"; je maakt een nieuw contract als het alsnog door moet. Een ondertekend contract kan niet ingetrokken worden.',
    keywords: ['intrekken', 'ongeldig maken', 'annuleren', 'terugtrekken', 'void'],
    input: {
      contract_id: { type: 'string' },
      reason: { type: 'string', description: 'Waarom het contract wordt ingetrokken; komt in de contracthistorie.' },
    },
    required: ['contract_id'],
    async plan(ctx, input) {
      const contractId = id(input, 'contract_id');
      const contract = await row<{ number: string; title: string; status: string; client_id: string | null }>(
        ctx, 'contracts', contractId, 'number, title, status, client_id', 'Contract');
      if (['signed', 'voided'].includes(contract.status)) {
        throw new ActionError(`Contract ${contract.number} is ${CONTRACT_STATUS_LABEL[contract.status] ?? contract.status} en kan niet (meer) worden ingetrokken.`);
      }
      const reason = optStr(input, 'reason', 500);
      const clientName = await clientNameOf(ctx, contract.client_id);
      return {
        title: `Contract ${contract.number} intrekken`,
        sub: joinShort([
          contract.title || '(zonder titel)',
          clientName,
          contract.status === 'sent' ? 'de verstuurde ondertekenlink werkt hierna niet meer' : 'onomkeerbaar',
          reason,
        ], 160),
        kind: 'work',
        payload: { contract_id: contractId, contract_number: contract.number, reason },
      };
    },
  },

  {
    id: 'contract_template.create',
    label: 'Contractsjabloon aanmaken',
    module: 'finance',
    kind: 'write',
    description:
      'Legt een herbruikbare contracttekst vast waaruit je later contracten start. Gebruik variabelen als {{klantnaam}}, {{bedrag}} en {{datum}} — die worden bij het aanmaken van een contract één keer ingevuld. ' +
      'Geef de tekst als platte tekst met witregels tussen de alinea\'s. Er verandert niets aan bestaande contracten.',
    keywords: ['sjabloon', 'template', 'standaardcontract', 'model', 'aanmaken'],
    input: {
      name: { type: 'string', description: 'Naam van het sjabloon, bv. "Onderhoudsovereenkomst".' },
      body_text: { type: 'string', description: 'De contracttekst, platte tekst met witregels tussen de alinea\'s en {{variabelen}}.' },
    },
    required: ['name', 'body_text'],
    async plan(ctx, input) {
      const name = str(input, 'name', 200);
      const bodyText = str(input, 'body_text', 40000);
      const { data: existing } = await orgQuery(ctx, 'contract_templates', 'name').eq('name', name).maybeSingle();
      if (existing) throw new ActionError(`Er bestaat al een sjabloon met de naam "${name}".`);
      const tokens = [...new Set(bodyText.match(/\{\{[a-z0-9_]+\}\}/gi) ?? [])];
      return {
        title: `Contractsjabloon aanmaken: ${name}`,
        sub: joinShort([`${bodyText.length} tekens`, tokens.length ? `variabelen: ${tokens.join(', ')}` : 'geen variabelen']),
        kind: 'work',
        payload: { name, body_text: bodyText },
      };
    },
  },

  {
    id: 'contract_template.update',
    label: 'Contractsjabloon bewerken',
    module: 'finance',
    kind: 'write',
    description:
      'Wijzigt de naam en/of de tekst van een bestaand contractsjabloon. Contracten die eerder uit dit sjabloon zijn gemaakt veranderen NIET mee — die hebben hun eigen tekst. ' +
      'Zoek het sjabloon met `list_contract_templates`. Geef de tekst als platte tekst met witregels tussen de alinea\'s.',
    keywords: ['sjabloon', 'template', 'bewerken', 'aanpassen', 'hernoemen'],
    input: {
      template_id: { type: 'string' },
      name: { type: 'string' },
      body_text: { type: 'string', description: 'Vervangt de complete sjabloontekst.' },
    },
    required: ['template_id'],
    async plan(ctx, input) {
      const templateId = id(input, 'template_id');
      const template = await row<{ name: string }>(ctx, 'contract_templates', templateId, 'name', 'Sjabloon');
      const name = optStr(input, 'name', 200);
      const bodyText = optStr(input, 'body_text', 40000);
      if (!name && !bodyText) throw new ActionError('Geef een nieuwe naam of een nieuwe tekst.');
      return {
        title: `Contractsjabloon bewerken: ${template.name}`,
        sub: joinShort([
          name && name !== template.name ? `wordt "${name}"` : null,
          bodyText ? 'de complete tekst wordt vervangen' : null,
          'bestaande contracten veranderen niet mee',
        ]),
        kind: 'work',
        payload: { template_id: templateId, template_name: template.name, name, body_text: bodyText },
      };
    },
  },

  {
    id: 'contract.list_notes',
    label: 'Interne notities bij een contract bekijken',
    module: 'finance',
    kind: 'read',
    description:
      'Geeft de interne notities bij één contract: wat het team onderling heeft vastgelegd over de onderhandeling of de status. Deze notities staan NOOIT in de PDF en gaan nooit mee in een mail naar de klant.',
    keywords: ['interne notitie', 'aantekening', 'memo', 'contract', 'team'],
    input: {
      contract_id: { type: 'string' },
      limit: { type: 'number', description: 'Maximaal aantal notities (standaard 20).' },
    },
    required: ['contract_id'],
    async read(ctx, input) {
      const contractId = id(input, 'contract_id');
      const contract = await row<{ number: string; title: string }>(ctx, 'contracts', contractId, 'number, title', 'Contract');
      const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 100);
      const { data, error } = await orgQuery(ctx, 'contract_internal_notes', 'id, body, author_name, created_at, updated_at')
        .eq('contract_id', contractId).order('created_at', { ascending: false }).limit(limit);
      if (error) throw new ActionError(`Interne notities ophalen mislukt: ${error.message}`);
      return { contract: { id: contractId, number: contract.number, title: contract.title }, notes: data ?? [] };
    },
  },

  {
    id: 'contract.add_note',
    label: 'Interne notitie bij een contract plaatsen',
    module: 'finance',
    kind: 'write',
    description:
      'Voegt een teamnotitie toe bij een contract — bijvoorbeeld waarom een clausule is aangepast of wat er telefonisch is afgesproken. ' +
      'De notitie is alleen voor het team: hij belandt nooit in de contract-PDF en nooit in een mail naar de klant. Je naam en het moment komen er automatisch bij.',
    keywords: ['notitie', 'aantekening', 'memo', 'vastleggen', 'contract'],
    input: {
      contract_id: { type: 'string' },
      body: { type: 'string', description: 'De tekst van de notitie.' },
    },
    required: ['contract_id', 'body'],
    async plan(ctx, input) {
      const contractId = id(input, 'contract_id');
      const body = str(input, 'body', 4000);
      const contract = await row<{ number: string; title: string }>(ctx, 'contracts', contractId, 'number, title', 'Contract');
      return {
        title: `Interne notitie bij contract ${contract.number}`,
        sub: joinShort([excerpt(body), 'alleen voor het team — niet in de PDF of mails'], 150),
        kind: 'work',
        payload: { contract_id: contractId, contract_number: contract.number, body },
      };
    },
  },

  {
    id: 'contract.update_note',
    label: 'Interne contractnotitie bijwerken',
    module: 'finance',
    kind: 'write',
    description:
      'Vervangt de tekst van een bestaande interne notitie bij een contract. Zoek de notitie eerst met `contract.list_notes` en gebruik het exacte id. Blijft intern: nooit in de PDF, nooit in een mail.',
    keywords: ['notitie bewerken', 'aantekening aanpassen', 'memo wijzigen'],
    input: {
      note_id: { type: 'string' },
      body: { type: 'string', description: 'De nieuwe tekst; vervangt de oude volledig.' },
    },
    required: ['note_id', 'body'],
    async plan(ctx, input) {
      const noteId = id(input, 'note_id');
      const body = str(input, 'body', 4000);
      const note = await row<{ body: string; contract_id: string; author_name: string | null }>(
        ctx, 'contract_internal_notes', noteId, 'body, contract_id, author_name', 'Interne notitie');
      const contract = await row<{ number: string }>(ctx, 'contracts', note.contract_id, 'number', 'Contract');
      if (note.body.trim() === body.trim()) throw new ActionError('De notitie heeft die tekst al.');
      return {
        title: `Interne notitie bijwerken bij contract ${contract.number}`,
        sub: joinShort([`was: ${excerpt(note.body, 50)}`, `wordt: ${excerpt(body, 50)}`], 150),
        kind: 'work',
        payload: { note_id: noteId, contract_number: contract.number, body },
      };
    },
  },

  // ══ Galerijen ═════════════════════════════════════════════════════════════
  // Module 'projects', want een galerij is de oplevering van een project.
  {
    id: 'gallery.create',
    label: 'Galerij aanmaken bij een project',
    module: 'projects',
    kind: 'write',
    description:
      'Maakt een lege galerij bij een project: de plek waar de foto\'s en video\'s van die opdracht aan de klant worden opgeleverd. Hij begint als CONCEPT — de klant ziet hem nog niet. ' +
      'Het formaat bepaalt wat erin mag en hoe de opening eruitziet: "photo", "video" of "hybride". Een videogalerij opent standaard filmisch, de rest paginavullend. Uploaden doet de gebruiker zelf.',
    keywords: ['galerij', 'oplevering', 'fotogalerij', 'videogalerij', 'aanmaken', 'gallery'],
    input: {
      project_id: { type: 'string', description: 'Id van het project (exact, uit list_projects).' },
      title: { type: 'string', description: 'Titel die de klant boven de galerij ziet.' },
      format: { type: 'string', enum: [...GALLERY_FORMATS], description: 'photo, video of hybrid. Standaard hybrid.' },
    },
    required: ['project_id', 'title'],
    async plan(ctx, input) {
      const projectId = id(input, 'project_id');
      const title = str(input, 'title', 200);
      const format = optChoice(input, 'format', GALLERY_FORMATS) ?? 'hybrid';
      const project = await row<{ name: string; client_id: string | null }>(ctx, 'projects', projectId, 'name, client_id', 'Project');
      const clientName = await clientNameOf(ctx, project.client_id);
      const heroTemplate = format === 'video' ? 'netflix' : 'full';
      const formatWord = format === 'photo' ? 'foto' : format === 'video' ? 'video' : 'foto en video';
      return {
        title: `Galerij aanmaken: ${title}`,
        sub: joinShort([project.name, clientName, formatWord, 'begint als concept — de klant ziet hem nog niet']),
        kind: 'work',
        payload: { project_id: projectId, project_name: project.name, title, format, hero_template: heroTemplate },
      };
    },
  },

  {
    id: 'gallery.update_settings',
    label: 'Instellingen van een galerij opslaan',
    module: 'projects',
    kind: 'write',
    description:
      'Zet titel, omschrijving, formaat, de opening (het sjabloon van de kop), of de klant mag downloaden, in welke kwaliteit, en tot wanneer de galerij bereikbaar is. ' +
      'LET OP: downloads aanzetten of de vervaldatum verschuiven verandert direct wat de klant mag — bij een gepubliceerde galerij merkt hij dat meteen. Laat weg wat niet verandert.',
    keywords: ['galerij instellingen', 'downloads', 'vervaldatum', 'kwaliteit', 'opening', 'hero', 'titel', 'omschrijving'],
    input: {
      gallery_id: { type: 'string', description: 'Id van de galerij (exact, uit list_galleries).' },
      title: { type: 'string' },
      description: { type: 'string' },
      format: { type: 'string', enum: [...GALLERY_FORMATS] },
      hero_template: { type: 'string', enum: [...HERO_TEMPLATES], description: 'De opening: full/minimal/fade, editorial/frame/split/cutout/duotone, classic/collage/arch/stack, cinematic/mosaic/slideshow/netflix.' },
      allow_downloads: { type: 'boolean', description: 'Mag de klant de bestanden downloaden?' },
      download_quality: { type: 'string', enum: [...GALLERY_QUALITY], description: 'original = het volledige bestand, web = de webversie.' },
      expires_at: { type: 'string', description: 'Laatste dag dat de galerij bereikbaar is (JJJJ-MM-DD). Leeg = geen vervaldatum.' },
    },
    required: ['gallery_id'],
    async plan(ctx, input) {
      const galleryId = id(input, 'gallery_id');
      const gallery = await row<{ title: string; status: string; allow_downloads: boolean; expires_at: string | null }>(
        ctx, 'galleries', galleryId, 'title, status, allow_downloads, expires_at', 'Galerij');

      const patch: Record<string, unknown> = {};
      const described: string[] = [];
      const title = optStr(input, 'title', 200);
      if (title) { patch.title = title; described.push(`titel "${title}"`); }
      if (input.description !== undefined) {
        patch.description = optStr(input, 'description', 2000);
        described.push('omschrijving');
      }
      const format = optChoice(input, 'format', GALLERY_FORMATS);
      if (format) { patch.format = format; described.push(`formaat ${format}`); }
      const hero = optChoice(input, 'hero_template', HERO_TEMPLATES);
      if (hero) { patch.hero_template = hero; described.push(`opening ${hero}`); }
      if (typeof input.allow_downloads === 'boolean') {
        patch.allow_downloads = input.allow_downloads;
        described.push(input.allow_downloads ? 'downloads AAN voor de klant' : 'downloads uit');
      }
      const quality = optChoice(input, 'download_quality', GALLERY_QUALITY);
      if (quality) { patch.download_quality = quality; described.push(`kwaliteit ${quality === 'original' ? 'origineel' : 'web'}`); }
      if (input.expires_at !== undefined) {
        const expires = optIsoDate(input, 'expires_at');
        // Bewust een eigen sleutel: `expires_at` in de database is een tijdstip, en
        // de browser maakt er het EINDE van die dag van in de tijd van de gebruiker —
        // precies zoals het instellingenscherm. Hier al een ISO-tijd maken zou de
        // galerij op een UTC-middernacht laten vervallen, dus twee uur te vroeg.
        patch.expires_date = expires;
        described.push(expires ? `bereikbaar t/m ${expires}` : 'geen vervaldatum meer');
      }
      if (Object.keys(patch).length === 0) throw new ActionError('Geef minstens één instelling die moet veranderen.');

      return {
        title: `Galerij-instellingen opslaan: ${gallery.title}`,
        sub: joinShort([...described, gallery.status === 'published' ? 'de galerij staat GEPUBLICEERD — de klant merkt dit meteen' : null], 150),
        kind: 'work',
        payload: { gallery_id: galleryId, gallery_title: gallery.title, patch },
      };
    },
  },

  {
    id: 'gallery.publish',
    label: 'Galerij publiceren',
    module: 'projects',
    kind: 'write',
    risk: 'high',
    description:
      'Zet de galerij op "gepubliceerd". Vanaf dat moment zien de contactpersonen van de klant met portaaltoegang de oplevering in hun klantportaal. ' +
      'Dit is een oplevering naar buiten: controleer eerst of de juiste bestanden erin staan, of de indeling klopt en of downloads goed staan. Terugdraaien kan met `gallery.unpublish`.',
    keywords: ['publiceren', 'opleveren', 'live zetten', 'vrijgeven', 'zichtbaar maken'],
    input: { gallery_id: { type: 'string' } },
    required: ['gallery_id'],
    async plan(ctx, input) {
      const galleryId = id(input, 'gallery_id');
      const gallery = await row<{ title: string; status: string; project_id: string; allow_downloads: boolean; expires_at: string | null }>(
        ctx, 'galleries', galleryId, 'title, status, project_id, allow_downloads, expires_at', 'Galerij');
      if (gallery.status === 'published') throw new ActionError(`"${gallery.title}" is al gepubliceerd.`);
      const project = await row<{ name: string; client_id: string | null }>(ctx, 'projects', gallery.project_id, 'name, client_id', 'Project');
      const clientName = await clientNameOf(ctx, project.client_id);
      const { count } = await ctx.db.from('gallery_items')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', ctx.organizationId).eq('gallery_id', galleryId);
      if (!count) throw new ActionError(`"${gallery.title}" bevat nog geen bestanden; een lege galerij publiceren heeft geen zin.`);
      return {
        title: `Galerij publiceren: ${gallery.title}`,
        sub: joinShort([
          `${count} bestand${count === 1 ? '' : 'en'}`,
          clientName ? `zichtbaar voor ${clientName} in het portaal` : 'zichtbaar in het klantportaal',
          gallery.allow_downloads ? 'downloaden toegestaan' : 'downloaden uit',
        ], 150),
        kind: 'work',
        payload: { gallery_id: galleryId, gallery_title: gallery.title, items: count },
      };
    },
  },

  {
    id: 'gallery.unpublish',
    label: 'Galerij terugzetten naar concept',
    module: 'projects',
    kind: 'write',
    description:
      'Zet een gepubliceerde galerij terug op "concept". De klant ziet hem daarna niet meer in het portaal. Er gaat niets verloren — de bestanden, categorieën en favorieten blijven staan. ' +
      'Een eventueel uitgedeelde deellink blijft wel werken; die trek je apart in met `gallery.revoke_share_link`.',
    keywords: ['terugzetten', 'concept', 'offline halen', 'verbergen', 'depubliceren'],
    input: { gallery_id: { type: 'string' } },
    required: ['gallery_id'],
    async plan(ctx, input) {
      const galleryId = id(input, 'gallery_id');
      const gallery = await row<{ title: string; status: string; share_enabled: boolean }>(
        ctx, 'galleries', galleryId, 'title, status, share_enabled', 'Galerij');
      if (gallery.status !== 'published') throw new ActionError(`"${gallery.title}" staat niet op gepubliceerd.`);
      return {
        title: `Galerij terugzetten naar concept: ${gallery.title}`,
        sub: joinShort([
          'de klant ziet hem niet meer in het portaal',
          gallery.share_enabled ? 'let op: de publieke deellink blijft wél werken' : null,
        ], 140),
        kind: 'work',
        payload: { gallery_id: galleryId, gallery_title: gallery.title },
      };
    },
  },

  {
    id: 'gallery.create_share_link',
    label: 'Publieke deellink voor een galerij genereren',
    module: 'projects',
    kind: 'write',
    risk: 'high',
    description:
      'Maakt een geheime link waarmee IEDEREEN die hem heeft de galerij kan bekijken — geen inlog, geen portaal. Met een pincode van 6 tot 8 cijfers zit er nog een slot op. ' +
      'De link is maar ÉÉN keer te zien: hij staat in de bevestiging en wordt daarna alleen als hashcode bewaard. Bestond er al een deellink, dan werkt die oude vanaf nu niet meer. ' +
      'Denk na voor je dit voorstelt: een publieke link is de meest open manier om een oplevering te delen.',
    keywords: ['deellink', 'link delen', 'publieke link', 'share', 'pincode', 'zonder inloggen'],
    input: {
      gallery_id: { type: 'string' },
      pin: { type: 'string', description: 'Optionele pincode van 6 tot 8 cijfers die de bezoeker moet invullen.' },
    },
    required: ['gallery_id'],
    async plan(ctx, input) {
      const galleryId = id(input, 'gallery_id');
      const gallery = await row<{ title: string; status: string; share_enabled: boolean; expires_at: string | null }>(
        ctx, 'galleries', galleryId, 'title, status, share_enabled, expires_at', 'Galerij');
      const pin = optStr(input, 'pin', 8);
      if (pin && !/^\d{6,8}$/.test(pin)) throw new ActionError('Een pincode is 6 tot 8 cijfers.');
      return {
        title: `Publieke deellink maken voor "${gallery.title}"`,
        sub: joinShort([
          pin ? `met pincode (${pin.length} cijfers)` : 'ZONDER pincode — iedereen met de link kan kijken',
          gallery.share_enabled ? 'de bestaande deellink vervalt hiermee' : null,
          gallery.expires_at ? 'de vervaldatum van de galerij geldt ook hier' : null,
        ], 150),
        kind: 'work',
        payload: { gallery_id: galleryId, gallery_title: gallery.title, pin },
      };
    },
  },

  {
    id: 'gallery.revoke_share_link',
    label: 'Publieke deellink intrekken',
    module: 'projects',
    kind: 'write',
    risk: 'high',
    description:
      'Zet het delen uit en wist de bewaarde link- en pincodehash. Elke link die je eerder hebt uitgedeeld werkt daarna NIET meer — ook die in mails en appjes die je niet terug kunt halen. ' +
      'ONOMKEERBAAR: dezelfde link komt niet terug, je genereert hoogstens een nieuwe. Het klantportaal is een aparte weg en blijft gewoon werken.',
    keywords: ['deellink intrekken', 'link ongeldig', 'stoppen met delen', 'revoke'],
    input: { gallery_id: { type: 'string' } },
    required: ['gallery_id'],
    async plan(ctx, input) {
      const galleryId = id(input, 'gallery_id');
      const gallery = await row<{ title: string; share_enabled: boolean }>(ctx, 'galleries', galleryId, 'title, share_enabled', 'Galerij');
      if (!gallery.share_enabled) throw new ActionError(`"${gallery.title}" heeft geen actieve deellink.`);
      return {
        title: `Deellink intrekken van "${gallery.title}"`,
        sub: 'onomkeerbaar — alle uitgedeelde links stoppen met werken; het klantportaal blijft wel',
        kind: 'work',
        payload: { gallery_id: galleryId, gallery_title: gallery.title },
      };
    },
  },

  {
    id: 'gallery.set_cover',
    label: 'Coverbeeld van een galerij kiezen',
    module: 'projects',
    kind: 'write',
    description:
      'Wijst een bestand uit de galerij aan als opening — het beeld dat de klant als eerste ziet. Laat `item_id` weg om terug te gaan naar automatisch (het eerste bestand). ' +
      'Stond er een apart geüploade titelkaart als cover, dan vervalt die hiermee. Zoek het bestand met `gallery.list_items`.',
    keywords: ['cover', 'coverbeeld', 'opening', 'titelbeeld', 'hero', 'eerste foto'],
    input: {
      gallery_id: { type: 'string' },
      item_id: { type: 'string', description: 'Id van het bestand dat de opening wordt. Weglaten = terug naar automatisch.' },
    },
    required: ['gallery_id'],
    async plan(ctx, input) {
      const galleryId = id(input, 'gallery_id');
      const gallery = await row<{ title: string; cover_item_id: string | null; cover_preview_key: string | null; cover_thumb_key: string | null }>(
        ctx, 'galleries', galleryId, 'title, cover_item_id, cover_preview_key, cover_thumb_key', 'Galerij');
      const itemId = optId(input, 'item_id');
      let fileName: string | null = null;
      if (itemId) {
        const item = await row<{ file_name: string; gallery_id: string; media_type: string }>(
          ctx, 'gallery_items', itemId, 'file_name, gallery_id, media_type', 'Bestand');
        if (item.gallery_id !== galleryId) throw new ActionError(`"${item.file_name}" hoort bij een andere galerij.`);
        fileName = item.file_name;
      }
      if ((gallery.cover_item_id ?? null) === itemId && !gallery.cover_preview_key) {
        throw new ActionError(itemId ? `"${fileName}" is al de opening.` : 'De opening staat al op automatisch.');
      }
      return {
        title: itemId ? `Coverbeeld kiezen voor "${gallery.title}"` : `Coverbeeld terug op automatisch: ${gallery.title}`,
        sub: joinShort([fileName, gallery.cover_preview_key ? 'het eigen geüploade coverbeeld vervalt' : null]),
        kind: 'work',
        payload: {
          gallery_id: galleryId, gallery_title: gallery.title, item_id: itemId, file_name: fileName,
          old_cover_keys: [gallery.cover_preview_key, gallery.cover_thumb_key].filter(Boolean),
        },
      };
    },
  },

  {
    id: 'gallery.set_cover_focus',
    label: 'Focuspunt van de cover-uitsnede zetten',
    module: 'projects',
    kind: 'write',
    description:
      'Bepaalt welk punt van het coverbeeld in beeld blijft als de opening bijsnijdt — handig als een hoofd of een logo net buiten de uitsnede valt. ' +
      'Geef x en y in procenten: 0 is links/boven, 50 is het midden (de standaard), 100 is rechts/onder.',
    keywords: ['focuspunt', 'uitsnede', 'bijsnijden', 'cover', 'object-position', 'positie'],
    input: {
      gallery_id: { type: 'string' },
      focus_x: { type: 'number', description: 'Horizontaal, 0–100 procent.' },
      focus_y: { type: 'number', description: 'Verticaal, 0–100 procent.' },
    },
    required: ['gallery_id', 'focus_x', 'focus_y'],
    async plan(ctx, input) {
      const galleryId = id(input, 'gallery_id');
      const gallery = await row<{ title: string; cover_focus_x: number; cover_focus_y: number }>(
        ctx, 'galleries', galleryId, 'title, cover_focus_x, cover_focus_y', 'Galerij');
      const clamp = (value: number) => Math.round(Math.min(100, Math.max(0, value)));
      const x = clamp(num(input, 'focus_x'));
      const y = clamp(num(input, 'focus_y'));
      if (x === gallery.cover_focus_x && y === gallery.cover_focus_y) throw new ActionError('Het focuspunt staat daar al.');
      return {
        title: `Focuspunt van de opening zetten: ${gallery.title}`,
        sub: `van ${gallery.cover_focus_x}% / ${gallery.cover_focus_y}% naar ${x}% / ${y}%`,
        kind: 'work',
        payload: { gallery_id: galleryId, gallery_title: gallery.title, focus_x: x, focus_y: y },
      };
    },
  },

  {
    id: 'gallery.sort_items',
    label: 'Volgorde van de bestanden in een galerij wijzigen',
    module: 'projects',
    kind: 'write',
    description:
      'Bepaalt in welke volgorde de klant de bestanden ziet. Kies een sorteerwijze ("name", "name_desc", "oldest", "newest") óf geef zelf de complete lijst bestand-id\'s in de gewenste volgorde. ' +
      'Bij een eigen lijst moeten ALLE bestanden van de galerij erin staan; haal ze op met `gallery.list_items`.',
    keywords: ['volgorde', 'sorteren', 'ordenen', 'rangschikken', 'op naam', 'op datum'],
    input: {
      gallery_id: { type: 'string' },
      sort: { type: 'string', enum: ['name', 'name_desc', 'oldest', 'newest'], description: 'Sorteerwijze; laat weg als je item_ids meegeeft.' },
      item_ids: { type: 'array', items: { type: 'string' }, description: 'De complete lijst bestand-id\'s in de gewenste volgorde.' },
    },
    required: ['gallery_id'],
    async plan(ctx, input) {
      const galleryId = id(input, 'gallery_id');
      const gallery = await row<{ title: string }>(ctx, 'galleries', galleryId, 'title', 'Galerij');
      const { data, error } = await orgQuery(ctx, 'gallery_items', 'id, file_name, created_at, sort_order')
        .eq('gallery_id', galleryId).order('sort_order', { ascending: true }).limit(2000);
      if (error) throw new ActionError(`Bestanden ophalen mislukt: ${error.message}`);
      const items: Array<Record<string, unknown>> = data ?? [];
      if (items.length === 0) throw new ActionError(`"${gallery.title}" bevat nog geen bestanden.`);

      let ordered: string[];
      let how: string;
      if (Array.isArray(input.item_ids) && (input.item_ids as unknown[]).length > 0) {
        ordered = ids(input, 'item_ids', 2000);
        const known = new Set(items.map((i) => String(i.id)));
        const stranger = ordered.find((value) => !known.has(value));
        if (stranger) throw new ActionError('Er staat een bestand in de lijst dat niet in deze galerij zit.');
        if (ordered.length !== items.length) {
          throw new ActionError(`De galerij heeft ${items.length} bestanden; geef ze allemaal in de gewenste volgorde (je gaf er ${ordered.length}).`);
        }
        how = 'handmatige volgorde';
      } else {
        const sort = choice(input, 'sort', ['name', 'name_desc', 'oldest', 'newest'] as const);
        const byName = (a: Record<string, unknown>, b: Record<string, unknown>) =>
          String(a.file_name).localeCompare(String(b.file_name), 'nl', { numeric: true, sensitivity: 'base' });
        const sorted = [...items].sort((a, b) => {
          switch (sort) {
            case 'name': return byName(a, b);
            case 'name_desc': return byName(b, a);
            case 'newest': return String(b.created_at).localeCompare(String(a.created_at));
            default: return String(a.created_at).localeCompare(String(b.created_at));
          }
        });
        ordered = sorted.map((i) => String(i.id));
        how = { name: 'bestandsnaam A→Z', name_desc: 'bestandsnaam Z→A', oldest: 'oudste eerst', newest: 'nieuwste eerst' }[sort];
      }

      return {
        title: `Volgorde wijzigen in "${gallery.title}"`,
        sub: joinShort([how, `${ordered.length} bestand${ordered.length === 1 ? '' : 'en'}`]),
        kind: 'work',
        payload: { gallery_id: galleryId, gallery_title: gallery.title, item_ids: ordered, how },
      };
    },
  },

  {
    id: 'gallery.assign_category',
    label: 'Bestanden aan een categorie toewijzen',
    module: 'projects',
    kind: 'write',
    description:
      'Zet een reeks bestanden in één keer in een categorie — de secties waarin de klant de oplevering ziet (Ceremonie, Diner, Feest). Laat `category_id` weg om ze juist uit hun categorie te halen; ze vallen dan onder "Zonder categorie". ' +
      'Zoek de bestanden met `gallery.list_items` en de categorieën met `gallery.list_categories`.',
    keywords: ['categorie', 'indelen', 'sectie', 'toewijzen', 'bulk', 'groeperen'],
    input: {
      gallery_id: { type: 'string' },
      item_ids: { type: 'array', items: { type: 'string' }, description: 'De bestanden die verhuizen.' },
      category_id: { type: 'string', description: 'Doelcategorie; weglaten = uit de categorie halen.' },
    },
    required: ['gallery_id', 'item_ids'],
    async plan(ctx, input) {
      const galleryId = id(input, 'gallery_id');
      const itemIds = ids(input, 'item_ids', 500);
      const categoryId = optId(input, 'category_id');
      const gallery = await row<{ title: string }>(ctx, 'galleries', galleryId, 'title', 'Galerij');

      const { data, error } = await orgQuery(ctx, 'gallery_items', 'id, file_name, gallery_id').in('id', itemIds);
      if (error) throw new ActionError(`Bestanden ophalen mislukt: ${error.message}`);
      const found: Array<Record<string, unknown>> = data ?? [];
      if (found.length !== itemIds.length) throw new ActionError(`${itemIds.length - found.length} van de opgegeven bestanden bestaat niet.`);
      const stranger = found.find((i) => String(i.gallery_id) !== galleryId);
      if (stranger) throw new ActionError(`"${String(stranger.file_name)}" hoort bij een andere galerij.`);

      let categoryName = 'Zonder categorie';
      if (categoryId) {
        const category = await row<{ name: string; gallery_id: string }>(ctx, 'gallery_categories', categoryId, 'name, gallery_id', 'Categorie');
        if (category.gallery_id !== galleryId) throw new ActionError(`Categorie "${category.name}" hoort bij een andere galerij.`);
        categoryName = category.name;
      }
      return {
        title: `${itemIds.length} bestand${itemIds.length === 1 ? '' : 'en'} naar "${categoryName}"`,
        sub: joinShort([gallery.title, ...found.slice(0, 3).map((i) => String(i.file_name))], 130),
        kind: 'work',
        payload: { gallery_id: galleryId, item_ids: itemIds, category_id: categoryId, category_name: categoryName },
      };
    },
  },

  {
    id: 'gallery_category.create',
    label: 'Categorie in een galerij toevoegen',
    module: 'projects',
    kind: 'write',
    description:
      'Maakt een nieuwe sectie in een galerij (bijvoorbeeld "Ceremonie" of "Groepsfoto\'s"). De categorie komt achteraan; bestanden zet je erin met `gallery.assign_category`.',
    keywords: ['categorie', 'sectie', 'hoofdstuk', 'toevoegen', 'indeling'],
    input: {
      gallery_id: { type: 'string' },
      name: { type: 'string' },
    },
    required: ['gallery_id', 'name'],
    async plan(ctx, input) {
      const galleryId = id(input, 'gallery_id');
      const name = str(input, 'name', 120);
      const gallery = await row<{ title: string }>(ctx, 'galleries', galleryId, 'title', 'Galerij');
      const { data, error } = await orgQuery(ctx, 'gallery_categories', 'name, position').eq('gallery_id', galleryId);
      if (error) throw new ActionError(`Categorieën ophalen mislukt: ${error.message}`);
      const existing: Array<Record<string, unknown>> = data ?? [];
      if (existing.some((c) => String(c.name).toLowerCase() === name.toLowerCase())) {
        throw new ActionError(`"${gallery.title}" heeft al een categorie "${name}".`);
      }
      const position = existing.reduce((max, c) => Math.max(max, Number(c.position) || 0), -1) + 1;
      return {
        title: `Categorie toevoegen: ${name}`,
        sub: joinShort([gallery.title, `komt op plek ${position + 1}`]),
        kind: 'work',
        payload: { gallery_id: galleryId, gallery_title: gallery.title, name, position },
      };
    },
  },

  {
    id: 'gallery_category.rename',
    label: 'Categorie in een galerij hernoemen',
    module: 'projects',
    kind: 'write',
    description: 'Geeft een sectie van een galerij een andere naam. De bestanden erin blijven precies staan waar ze staan.',
    keywords: ['categorie hernoemen', 'sectie', 'naam wijzigen'],
    input: {
      category_id: { type: 'string' },
      name: { type: 'string' },
    },
    required: ['category_id', 'name'],
    async plan(ctx, input) {
      const categoryId = id(input, 'category_id');
      const name = str(input, 'name', 120);
      const category = await row<{ name: string; gallery_id: string }>(ctx, 'gallery_categories', categoryId, 'name, gallery_id', 'Categorie');
      if (category.name === name) throw new ActionError('De categorie heet al zo.');
      const gallery = await row<{ title: string }>(ctx, 'galleries', category.gallery_id, 'title', 'Galerij');
      return {
        title: `Categorie hernoemen: ${category.name}`,
        sub: joinShort([`wordt "${name}"`, gallery.title]),
        kind: 'work',
        payload: { category_id: categoryId, name, was: category.name },
      };
    },
  },

  {
    id: 'gallery_category.set_order',
    label: 'Volgorde van de categorieën wijzigen',
    module: 'projects',
    kind: 'write',
    description:
      'Zet de secties van een galerij in de volgorde waarin de klant ze te zien krijgt. Geef ALLE categorie-id\'s van de galerij in de gewenste volgorde; haal ze op met `gallery.list_categories`.',
    keywords: ['categorieën ordenen', 'volgorde secties', 'verplaatsen', 'sorteren'],
    input: {
      gallery_id: { type: 'string' },
      category_ids: { type: 'array', items: { type: 'string' }, description: 'Alle categorie-id\'s, in de gewenste volgorde.' },
    },
    required: ['gallery_id', 'category_ids'],
    async plan(ctx, input) {
      const galleryId = id(input, 'gallery_id');
      const wanted = ids(input, 'category_ids', 100);
      const gallery = await row<{ title: string }>(ctx, 'galleries', galleryId, 'title', 'Galerij');
      const { data, error } = await orgQuery(ctx, 'gallery_categories', 'id, name, position')
        .eq('gallery_id', galleryId).order('position', { ascending: true });
      if (error) throw new ActionError(`Categorieën ophalen mislukt: ${error.message}`);
      const current: Array<Record<string, unknown>> = data ?? [];
      if (current.length === 0) throw new ActionError(`"${gallery.title}" heeft nog geen categorieën.`);
      const known = new Map(current.map((c) => [String(c.id), String(c.name)]));
      const stranger = wanted.find((value) => !known.has(value));
      if (stranger) throw new ActionError('Er staat een categorie in de lijst die niet bij deze galerij hoort.');
      if (wanted.length !== current.length) {
        throw new ActionError(`De galerij heeft ${current.length} categorieën; geef ze allemaal in de gewenste volgorde (je gaf er ${wanted.length}).`);
      }
      return {
        title: `Volgorde van de categorieën zetten: ${gallery.title}`,
        sub: joinShort(wanted.map((value) => known.get(value) ?? value), 140),
        kind: 'work',
        payload: { gallery_id: galleryId, gallery_title: gallery.title, category_ids: wanted },
      };
    },
  },

  {
    id: 'gallery_category.apply_presets',
    label: 'Standaardcategorieën in een galerij overnemen',
    module: 'projects',
    kind: 'write',
    description:
      'Neemt de standaard-categorielijst van de organisatie over in deze galerij. Alleen wat er nog niet is wordt toegevoegd; bestaande categorieën en hun bestanden blijven ongemoeid.',
    keywords: ['standaardcategorieën', 'presets', 'overnemen', 'standaardindeling', 'toepassen'],
    input: { gallery_id: { type: 'string' } },
    required: ['gallery_id'],
    async plan(ctx, input) {
      const galleryId = id(input, 'gallery_id');
      const gallery = await row<{ title: string }>(ctx, 'galleries', galleryId, 'title', 'Galerij');
      const [{ data: presets, error: presetError }, { data: existing, error: existingError }] = await Promise.all([
        orgQuery(ctx, 'gallery_category_presets', 'name, position').order('position', { ascending: true }),
        orgQuery(ctx, 'gallery_categories', 'name, position').eq('gallery_id', galleryId),
      ]);
      if (presetError) throw new ActionError(`Standaardlijst ophalen mislukt: ${presetError.message}`);
      if (existingError) throw new ActionError(`Categorieën ophalen mislukt: ${existingError.message}`);
      const presetRows: Array<Record<string, unknown>> = presets ?? [];
      if (presetRows.length === 0) {
        throw new ActionError('Er is nog geen standaardlijst. Maak eerst categorieën in een galerij en bewaar die met `gallery_category.save_presets`.');
      }
      const existingRows: Array<Record<string, unknown>> = existing ?? [];
      const have = new Set(existingRows.map((c) => String(c.name).toLowerCase()));
      let position = existingRows.reduce((max, c) => Math.max(max, Number(c.position) || 0), -1) + 1;
      const toAdd = presetRows
        .map((p) => String(p.name))
        .filter((name) => !have.has(name.toLowerCase()))
        .map((name) => ({ name, position: position++ }));
      if (toAdd.length === 0) throw new ActionError(`"${gallery.title}" heeft de standaardcategorieën al allemaal.`);
      return {
        title: `Standaardcategorieën toevoegen aan "${gallery.title}"`,
        sub: joinShort(toAdd.map((c) => c.name), 140),
        kind: 'work',
        payload: { gallery_id: galleryId, gallery_title: gallery.title, categories: toAdd },
      };
    },
  },

  {
    id: 'gallery_category.save_presets',
    label: 'Huidige categorie-indeling als standaard bewaren',
    module: 'projects',
    kind: 'write',
    description:
      'Bewaart de categorieën van deze galerij als de standaardlijst van de organisatie, zodat je ze in een volgende galerij in één klik overneemt. ' +
      'De vorige standaardlijst wordt hierbij VERVANGEN; bestaande galerijen veranderen niet mee.',
    keywords: ['als standaard opslaan', 'presets bewaren', 'standaardindeling', 'sjabloon categorieën'],
    input: { gallery_id: { type: 'string' } },
    required: ['gallery_id'],
    async plan(ctx, input) {
      const galleryId = id(input, 'gallery_id');
      const gallery = await row<{ title: string }>(ctx, 'galleries', galleryId, 'title', 'Galerij');
      const { data, error } = await orgQuery(ctx, 'gallery_categories', 'name, position')
        .eq('gallery_id', galleryId).order('position', { ascending: true });
      if (error) throw new ActionError(`Categorieën ophalen mislukt: ${error.message}`);
      const rows: Array<Record<string, unknown>> = data ?? [];
      if (rows.length === 0) throw new ActionError(`"${gallery.title}" heeft geen categorieën om te bewaren.`);
      const names = rows.map((c) => String(c.name));
      const { count: had } = await ctx.db.from('gallery_category_presets')
        .select('id', { count: 'exact', head: true }).eq('organization_id', ctx.organizationId);
      return {
        title: 'Categorie-indeling als standaard bewaren',
        sub: joinShort([gallery.title, names.join(', '), had ? `vervangt de huidige standaardlijst (${had})` : null], 150),
        kind: 'work',
        payload: { gallery_id: galleryId, gallery_title: gallery.title, names },
      };
    },
  },

  {
    id: 'gallery.list_items',
    label: 'Bestanden in een galerij bekijken',
    module: 'projects',
    kind: 'read',
    description:
      'Geeft de foto\'s en video\'s in één galerij: id, bestandsnaam, soort, categorie, volgorde, formaat en grootte, en bij video of de kijkkopie klaar is. ' +
      'Dit is de lijst die je nodig hebt om een cover te kiezen, bestanden in te delen of de volgorde te zetten.',
    keywords: ['bestanden', 'foto\'s', 'video\'s', 'items', 'galerij-inhoud', 'wat zit erin'],
    input: {
      gallery_id: { type: 'string' },
      category_id: { type: 'string', description: 'Alleen bestanden in deze categorie.' },
      limit: { type: 'number', description: 'Maximaal aantal bestanden (standaard 100, maximaal 500).' },
    },
    required: ['gallery_id'],
    async read(ctx, input) {
      const galleryId = id(input, 'gallery_id');
      const gallery = await row<{ title: string; status: string; format: string; cover_item_id: string | null }>(
        ctx, 'galleries', galleryId, 'title, status, format, cover_item_id', 'Galerij');
      const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 500);
      let query = orgQuery(ctx, 'gallery_items',
        'id, file_name, media_type, category_id, sort_order, size_bytes, width, height, duration_seconds, stream_status, created_at')
        .eq('gallery_id', galleryId).order('sort_order', { ascending: true }).limit(limit);
      const categoryId = optId(input, 'category_id');
      if (categoryId) query = query.eq('category_id', categoryId);
      const { data, error } = await query;
      if (error) throw new ActionError(`Bestanden ophalen mislukt: ${error.message}`);
      return {
        gallery: { id: galleryId, title: gallery.title, status: gallery.status, format: gallery.format, cover_item_id: gallery.cover_item_id },
        items: data ?? [],
      };
    },
  },

  {
    id: 'gallery.list_categories',
    label: 'Categorieën van een galerij bekijken',
    module: 'projects',
    kind: 'read',
    description:
      'Geeft de secties van één galerij in weergavevolgorde, met id, naam en positie, plus de standaard-categorielijst van de organisatie. Nodig om bestanden in te delen of de volgorde te wijzigen.',
    keywords: ['categorieën', 'secties', 'indeling', 'hoofdstukken'],
    input: { gallery_id: { type: 'string' } },
    required: ['gallery_id'],
    async read(ctx, input) {
      const galleryId = id(input, 'gallery_id');
      const gallery = await row<{ title: string }>(ctx, 'galleries', galleryId, 'title', 'Galerij');
      const [{ data: categories, error }, { data: presets }] = await Promise.all([
        orgQuery(ctx, 'gallery_categories', 'id, name, position').eq('gallery_id', galleryId).order('position', { ascending: true }),
        orgQuery(ctx, 'gallery_category_presets', 'name, position').order('position', { ascending: true }),
      ]);
      if (error) throw new ActionError(`Categorieën ophalen mislukt: ${error.message}`);
      return {
        gallery: { id: galleryId, title: gallery.title },
        categories: categories ?? [],
        organization_presets: (presets ?? []).map((p: Record<string, unknown>) => String(p.name)),
      };
    },
  },

  {
    id: 'gallery.list_favorites',
    label: 'Favorieten en waarderingen van de klant bekijken',
    module: 'projects',
    kind: 'read',
    description:
      'Toont wat de klant in een galerij heeft aangevinkt: "favorite" is zijn persoonlijke selectie (welke beelden hij wil afnemen), "like" is een zichtbare duim. ' +
      'Per bestand zie je hoe vaak het gekozen is en door wie — een contactpersoon uit het portaal of een bezoeker via de deellink. Precies wat je nodig hebt om te weten welke foto\'s de klant eruit pikte.',
    keywords: ['favorieten', 'selectie', 'likes', 'gekozen', 'reacties', 'wat vindt de klant'],
    input: {
      gallery_id: { type: 'string' },
      reaction: { type: 'string', enum: ['favorite', 'like'], description: 'Alleen deze soort reactie.' },
    },
    required: ['gallery_id'],
    async read(ctx, input) {
      const galleryId = id(input, 'gallery_id');
      const gallery = await row<{ title: string }>(ctx, 'galleries', galleryId, 'title', 'Galerij');
      let query = orgQuery(ctx, 'gallery_favorites', 'item_id, reaction, actor_kind, actor_label, contact_id, created_at')
        .eq('gallery_id', galleryId).order('created_at', { ascending: true }).limit(2000);
      const reaction = optChoice(input, 'reaction', ['favorite', 'like'] as const);
      if (reaction) query = query.eq('reaction', reaction);
      const { data, error } = await query;
      if (error) throw new ActionError(`Favorieten ophalen mislukt: ${error.message}`);
      const rows: Array<Record<string, unknown>> = data ?? [];

      // Bestandsnamen erbij: een lijst met alleen id's is voor niemand leesbaar.
      const { data: items } = await orgQuery(ctx, 'gallery_items', 'id, file_name').eq('gallery_id', galleryId).limit(2000);
      const nameOf = new Map<string, string>((items ?? []).map((i: Record<string, unknown>) => [String(i.id), String(i.file_name)]));

      const perItem = new Map<string, { file_name: string; favorites: number; likes: number }>();
      for (const entry of rows) {
        const itemId = String(entry.item_id);
        const bucket = perItem.get(itemId) ?? { file_name: nameOf.get(itemId) ?? '(verwijderd bestand)', favorites: 0, likes: 0 };
        if (String(entry.reaction) === 'like') bucket.likes += 1; else bucket.favorites += 1;
        perItem.set(itemId, bucket);
      }
      return {
        gallery: { id: galleryId, title: gallery.title },
        total_reactions: rows.length,
        per_item: [...perItem.entries()].map(([itemId, value]) => ({ item_id: itemId, ...value })),
        reactions: rows.map((entry) => ({ ...entry, file_name: nameOf.get(String(entry.item_id)) ?? null })),
      };
    },
  },

  {
    id: 'storage.status',
    label: 'Opslaggebruik van het account bekijken',
    module: 'projects',
    kind: 'read',
    description:
      'Geeft hoeveel opslag het hele account gebruikt en hoeveel er in het abonnement zit, uitgesplitst naar bijlagen, documenten, opnames en galerijen. ' +
      'Handig vóór een grote oplevering: zit de meter tegen de limiet, dan mislukt een upload. Bij `limit_bytes` null is er geen limiet.',
    keywords: ['opslag', 'ruimte', 'gigabyte', 'limiet', 'vol', 'storage', 'verbruik'],
    input: {},
    async read(ctx) {
      const { data, error } = await ctx.db.rpc('organization_storage_status', { p_organization_id: ctx.organizationId });
      if (error) throw new ActionError(`Opslaggebruik ophalen mislukt: ${error.message}`);
      const status = Array.isArray(data) ? (data[0] ?? null) : data;
      if (!status) throw new ActionError('Opslaggebruik is niet beschikbaar in deze organisatie.');
      return { storage: status };
    },
  },
];
