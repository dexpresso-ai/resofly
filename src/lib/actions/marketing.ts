import {
  addContractProject, addSuppression, createFlow, insertRow, removeContractProject,
  removeSuppression, replaceFlowSteps, replaceGalleryCategoryPresets, setGalleryItemOrder,
  setGalleryItemsCategory, updateCampaign, updateFlow, updateRow,
} from '../repository';
import {
  activateFlow, cancelCampaign, cancelFlow, pauseCampaign, pauseFlow, previewCampaignAudience,
  resumeCampaign, resumeFlow, scheduleCampaign, sendCampaign, sendTestCampaign,
} from '../marketing-api';
import { plainTextToEmailHtml } from '../../services/mailService';
import { throwFunctionError } from '../functionErrors';
import { deleteR2Object } from '../r2-api';
import { supabase } from '../supabase';
import { flag, list, optText, patchOf, text, type ActionExecutor } from './types';
import type { CampaignInput } from '../repository';
import type {
  CampaignAudience, FlowStepInput, FlowStopCondition, Gallery, GalleryCategory, UUID,
} from '../../types';

/**
 * Uitvoerders voor de marketing-handelingen: campagnes en follow-up-stromen,
 * contracten met hun sjablonen, en de galerij waarin een project wordt opgeleverd.
 *
 * Elke functie doet precies wat de knop in het scherm doet — zie
 * `supabase/functions/_shared/actions/marketing.ts` voor wat er aan de gebruiker
 * beloofd is op de kaart die hij goedkeurde.
 *
 * DRIE DINGEN OM TE WETEN
 *
 * 1. Tekst van een model wordt nooit rauw opgeslagen. De handelingen vragen om
 *    PLATTE tekst en `plainTextToEmailHtml` maakt daar de mail-HTML van — die
 *    ontsnapt alles, zodat een taalmodel geen opmaak (of erger) in de mailbox van
 *    een klant kan zetten. Dat is dezelfde weg die main.tsx voor `propose_campaign`
 *    gebruikt.
 * 2. Het deellink-token wordt HIER gemaakt, niet op de server. Alleen de hash gaat
 *    de database in; de link zelf bestaat maar één moment en staat in de
 *    bevestigingszin. Zou de server hem maken, dan stond het geheim leesbaar in het
 *    opgeslagen voorstel.
 * 3. De doelgroep telt zichzelf. Na het opslaan vraagt de uitvoerder de echte
 *    telling op bij de campaigns-functie (suppressielijst, contactpersonen, klanten
 *    zonder adres) en noemt die in zijn bevestiging — dat is het getal waar de
 *    gebruiker zijn "versturen" op baseert.
 */

/** Een lege doelgroep, zoals `emptyAudience()` in Marketing.tsx: filter zonder filters. */
function emptyAudience(): CampaignAudience {
  return { mode: 'filter', statuses: [], tags: [], includeContacts: false, manualClientIds: [], customFilters: [] };
}

/**
 * SHA-256 als hex. Gelijk aan de helper in ProjectGallery.tsx; die staat daar
 * privé en dit bestand mag geen gedeelde bestanden aanraken. Zodra iemand hem
 * exporteert hoort deze kopie te verdwijnen.
 */
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** 32 willekeurige bytes als URL-veilige tekst — het deellink-token. */
function randomShareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Roept de contract-workflow-functie aan, met de echte servermelding bij een fout. */
async function invokeContractWorkflow(
  action: string,
  payload: Record<string, unknown>,
  failureMessage: string,
): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.functions.invoke('contract-workflow', { body: { action, ...payload } });
  if (error) await throwFunctionError(error, failureMessage);
  if (!data?.ok) throw new Error(data?.error || failureMessage);
  return data as Record<string, unknown>;
}

/** Het e-mailadres van de ingelogde gebruiker; dat komt onder een interne notitie. */
async function currentUserEmail(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.email ?? null;
}

/**
 * De naam uit de payload, klaar om in een zin te zetten. Een campagne of stroom mag
 * naamloos zijn; dan wordt het "(naamloos)" in plaats van een paar lege aanhalings-
 * tekens die eruitzien als een fout.
 */
function named(payload: Record<string, unknown>, key: string): string {
  const value = optText(payload, key);
  return value ? `"${value}"` : '(naamloos)';
}

function numberOf(payload: Record<string, unknown>, key: string): number {
  const value = Number(payload[key]);
  if (!Number.isFinite(value)) throw new Error(`Deze actie mist "${key}".`);
  return value;
}

export const MARKETING_EXECUTORS: Record<string, ActionExecutor> = {
  // ── Campagnes ─────────────────────────────────────────────────────────────
  'campaign.update_content': async (payload, ctx) => {
    const campaignId = text(payload, 'campaign_id');
    const patch = patchOf(payload);
    const values: Partial<CampaignInput> = {};
    if (typeof patch.name === 'string') values.name = patch.name;
    if (typeof patch.subject === 'string') values.subject = patch.subject;
    if ('preheader' in patch) values.preheader = typeof patch.preheader === 'string' ? patch.preheader : null;
    if (typeof patch.accent_color === 'string') values.accent_color = patch.accent_color;
    if (typeof patch.body_text === 'string') {
      // Beide velden bijwerken: de mail gebruikt de HTML, de tekstversie is de
      // fallback voor mailprogramma's die geen HTML tonen.
      values.body_text = patch.body_text;
      values.body_html = plainTextToEmailHtml(patch.body_text);
    }
    const updated = await updateCampaign(ctx.organizationId, campaignId, values);
    return `Campagne "${updated.name}" bijgewerkt — nog niets verstuurd`;
  },

  'campaign.set_audience': async (payload, ctx) => {
    const campaignId = text(payload, 'campaign_id');
    const audience = patchOf(payload, 'audience') as unknown as CampaignAudience;
    const updated = await updateCampaign(ctx.organizationId, campaignId, { audience });
    // De echte telling komt van de campaigns-functie: die kent de suppressielijst,
    // de contactpersonen en de klanten zonder adres. Mislukt hij, dan is de
    // doelgroep wél opgeslagen — dat mag de melding niet verzwijgen.
    try {
      const preview = await previewCampaignAudience(ctx.organizationId, audience);
      return `Doelgroep van "${updated.name}" opgeslagen — ${preview.sendable} ontvanger${preview.sendable === 1 ? '' : 's'} `
        + `(${preview.matchedClients} klant${preview.matchedClients === 1 ? '' : 'en'}, `
        + `${preview.suppressed} afgemeld, ${preview.withoutEmail} zonder e-mailadres)`;
    } catch {
      return `Doelgroep van "${updated.name}" opgeslagen — het aantal ontvangers kon niet worden opgehaald`;
    }
  },

  'campaign.send_test': async (payload, ctx) => {
    const campaignId = text(payload, 'campaign_id');
    const result = await sendTestCampaign(ctx.organizationId, campaignId, text(payload, 'test_email'));
    return `Testmail van campagne ${named(payload, 'campaign_name')} verstuurd naar ${result.recipientEmail}`;
  },

  'campaign.send_now': async (payload, ctx) => {
    const campaignId = text(payload, 'campaign_id');
    const result = await sendCampaign(ctx.organizationId, campaignId);
    const failed = result.failed > 0 ? `, ${result.failed} mislukt` : '';
    return `Campagne ${named(payload, 'campaign_name')} verstuurd: ${result.materialized} ontvanger${result.materialized === 1 ? '' : 's'} vastgelegd, `
      + `${result.sent} direct de deur uit, nog ${result.remaining} in de wachtrij${failed}`;
  },

  'campaign.schedule': async (payload, ctx) => {
    const campaignId = text(payload, 'campaign_id');
    const when = text(payload, 'scheduled_at');
    // Zoals het datumveld in het scherm: de opgegeven tijd is de tijd van de
    // gebruiker, en pas hier wordt daar een absoluut moment van.
    const moment = new Date(when);
    if (Number.isNaN(moment.getTime())) throw new Error(`"${when}" is geen geldig verzendmoment.`);
    await scheduleCampaign(ctx.organizationId, campaignId, moment.toISOString());
    const readable = moment.toLocaleString('nl-NL', { dateStyle: 'full', timeStyle: 'short' });
    return `Campagne ${named(payload, 'campaign_name')} ingepland voor ${readable}`;
  },

  'campaign.pause': async (payload, ctx) => {
    await pauseCampaign(ctx.organizationId, text(payload, 'campaign_id'));
    return `Campagne ${named(payload, 'campaign_name')} gepauzeerd — de wachtrij blijft staan`;
  },

  'campaign.resume': async (payload, ctx) => {
    await resumeCampaign(ctx.organizationId, text(payload, 'campaign_id'));
    return `Campagne ${named(payload, 'campaign_name')} hervat — de resterende mails gaan uit`;
  },

  'campaign.cancel': async (payload, ctx) => {
    await cancelCampaign(ctx.organizationId, text(payload, 'campaign_id'));
    return `Campagne ${named(payload, 'campaign_name')} geannuleerd — wat nog in de wachtrij stond gaat niet meer uit`;
  },

  // ── Afmeldingen en blokkeringen ───────────────────────────────────────────
  'suppression.add': async (payload, ctx) => {
    const address = text(payload, 'email');
    await addSuppression(ctx.organizationId, address, 'manual');
    return `${address} geblokkeerd — krijgt geen campagnes en vervolgmails meer`;
  },

  'suppression.remove': async (payload, ctx) => {
    const address = text(payload, 'email');
    await removeSuppression(ctx.organizationId, address);
    return `Blokkering van ${address} opgeheven — het adres mag weer marketingmail ontvangen`;
  },

  // ── Follow-up-stromen ─────────────────────────────────────────────────────
  'flow.create': async (payload, ctx) => {
    const created = await createFlow(ctx.organizationId, {
      name: text(payload, 'name'),
      audience: emptyAudience(),
      stop_condition: text(payload, 'stop_condition') as FlowStopCondition,
    });
    return `Follow-up-stroom "${created.name}" aangemaakt als concept — nog zonder stappen en inactief`;
  },

  'flow.update': async (payload, ctx) => {
    const flowId = text(payload, 'flow_id');
    const patch = patchOf(payload);
    const values: Partial<{ name: string; audience: CampaignAudience; stop_condition: FlowStopCondition }> = {};
    if (typeof patch.name === 'string') values.name = patch.name;
    if (typeof patch.stop_condition === 'string') values.stop_condition = patch.stop_condition as FlowStopCondition;
    if (patch.audience && typeof patch.audience === 'object') values.audience = patch.audience as unknown as CampaignAudience;
    const updated = await updateFlow(ctx.organizationId, flowId, values);
    if (!values.audience) return `Stroom "${updated.name}" bijgewerkt`;
    try {
      const preview = await previewCampaignAudience(ctx.organizationId, values.audience);
      return `Stroom "${updated.name}" bijgewerkt — ${preview.sendable} klant${preview.sendable === 1 ? '' : 'en'} komt bij activeren in de reeks`;
    } catch {
      return `Stroom "${updated.name}" bijgewerkt — het aantal klanten kon niet worden opgehaald`;
    }
  },

  'flow.set_steps': async (payload, ctx) => {
    const flowId = text(payload, 'flow_id');
    const raw = Array.isArray(payload.steps) ? payload.steps as Array<Record<string, unknown>> : [];
    if (raw.length === 0) throw new Error('Deze actie mist "steps".');
    const steps: FlowStepInput[] = raw.map((step, index) => {
      const bodyText = String(step.body_text ?? '');
      return {
        step_index: index,
        delay_days: Number(step.delay_days ?? 0),
        subject: String(step.subject ?? ''),
        preheader: typeof step.preheader === 'string' ? step.preheader : null,
        body_html: plainTextToEmailHtml(bodyText),
        body_text: bodyText,
        accent_color: null,
      };
    });
    await replaceFlowSteps(ctx.organizationId, flowId, steps);
    return `Stroom ${named(payload, 'flow_name')} heeft nu ${steps.length} stap${steps.length === 1 ? '' : 'pen'}`;
  },

  'flow.activate': async (payload, ctx) => {
    const flowId = text(payload, 'flow_id');
    const result = await activateFlow(ctx.organizationId, flowId);
    return `Stroom ${named(payload, 'flow_name')} geactiveerd — ${result.enrolled} ingeschreven, ${result.sent} eerste mail${result.sent === 1 ? '' : 's'} direct verstuurd`;
  },

  'flow.pause': async (payload, ctx) => {
    await pauseFlow(ctx.organizationId, text(payload, 'flow_id'));
    return `Stroom ${named(payload, 'flow_name')} gepauzeerd — even geen vervolgmails`;
  },

  'flow.resume': async (payload, ctx) => {
    await resumeFlow(ctx.organizationId, text(payload, 'flow_id'));
    return `Stroom ${named(payload, 'flow_name')} hervat — de vervolgmails gaan weer uit`;
  },

  'flow.stop': async (payload, ctx) => {
    await cancelFlow(ctx.organizationId, text(payload, 'flow_id'));
    return `Stroom ${named(payload, 'flow_name')} gestopt — openstaande vervolgstappen gaan niet meer uit`;
  },

  // ── Contracten ────────────────────────────────────────────────────────────
  'contract.update_details': async (payload, ctx) => {
    const contractId = text(payload, 'contract_id');
    await supabase.from('contracts')
      .update(patchOf(payload))
      .eq('id', contractId)
      .eq('organization_id', ctx.organizationId)
      .throwOnError();
    return `Contract ${optText(payload, 'contract_number') ?? '(onbekend)'} bijgewerkt`;
  },

  'contract.link_project': async (payload, ctx) => {
    await addContractProject(ctx.organizationId, text(payload, 'contract_id'), text(payload, 'project_id'));
    return `Project ${named(payload, 'project_name')} gekoppeld aan contract ${optText(payload, 'contract_number') ?? '(onbekend)'}`;
  },

  'contract.unlink_project': async (payload, ctx) => {
    await removeContractProject(ctx.organizationId, text(payload, 'contract_id'), text(payload, 'project_id'));
    return `Project ${named(payload, 'project_name')} ontkoppeld van contract ${optText(payload, 'contract_number') ?? '(onbekend)'}`;
  },

  'contract.send_for_signature': async (payload, ctx) => {
    const contractId = text(payload, 'contract_id');
    await invokeContractWorkflow('sendContractForSignature', {
      organizationId: ctx.organizationId,
      contractId,
      recipientEmail: text(payload, 'recipient_email'),
      recipientName: optText(payload, 'recipient_name') ?? '',
      personalMessage: optText(payload, 'personal_message') ?? '',
    }, 'Versturen mislukt.');
    const number = optText(payload, 'contract_number') ?? '(onbekend)';
    const to = optText(payload, 'recipient_email') ?? 'de klant';
    return flag(payload, 'resend')
      ? `Ondertekenlink van contract ${number} opnieuw verstuurd naar ${to}`
      : `Contract ${number} ter ondertekening verstuurd naar ${to}`;
  },

  'contract.void': async (payload, ctx) => {
    const contractId = text(payload, 'contract_id');
    const { error } = await supabase.rpc('void_contract', {
      p_contract_id: contractId,
      p_organization_id: ctx.organizationId,
      p_reason: optText(payload, 'reason'),
    });
    if (error) throw error;
    return `Contract ${optText(payload, 'contract_number') ?? '(onbekend)'} ingetrokken — de ondertekenlink werkt niet meer`;
  },

  'contract_template.create': async (payload, ctx) => {
    const name = text(payload, 'name');
    await supabase.from('contract_templates')
      .insert({ organization_id: ctx.organizationId, name, body: plainTextToEmailHtml(text(payload, 'body_text')) })
      .throwOnError();
    return `Contractsjabloon "${name}" aangemaakt`;
  },

  'contract_template.update': async (payload, ctx) => {
    const templateId = text(payload, 'template_id');
    const values: Record<string, unknown> = {};
    const name = optText(payload, 'name');
    if (name) values.name = name;
    const bodyText = optText(payload, 'body_text');
    if (bodyText) values.body = plainTextToEmailHtml(bodyText);
    if (Object.keys(values).length === 0) throw new Error('Deze actie heeft niets om te wijzigen.');
    await supabase.from('contract_templates')
      .update(values)
      .eq('id', templateId)
      .eq('organization_id', ctx.organizationId)
      .throwOnError();
    return `Contractsjabloon "${name ?? optText(payload, 'template_name') ?? '(zonder naam)'}" bijgewerkt`;
  },

  'contract.add_note': async (payload, ctx) => {
    await supabase.from('contract_internal_notes')
      .insert({
        organization_id: ctx.organizationId,
        contract_id: text(payload, 'contract_id'),
        body: text(payload, 'body'),
        author_name: await currentUserEmail(),
      })
      .throwOnError();
    return `Interne notitie geplaatst bij contract ${optText(payload, 'contract_number') ?? '(onbekend)'}`;
  },

  'contract.update_note': async (payload, ctx) => {
    await supabase.from('contract_internal_notes')
      .update({ body: text(payload, 'body') })
      .eq('id', text(payload, 'note_id'))
      .eq('organization_id', ctx.organizationId)
      .throwOnError();
    return `Interne notitie bij contract ${optText(payload, 'contract_number') ?? '(onbekend)'} bijgewerkt`;
  },

  // ── Galerijen ─────────────────────────────────────────────────────────────
  'gallery.create': async (payload, ctx) => {
    const created = await insertRow<Gallery>('galleries', ctx.organizationId, {
      project_id: text(payload, 'project_id'),
      title: text(payload, 'title'),
      format: text(payload, 'format'),
      hero_template: text(payload, 'hero_template'),
    });
    return `Galerij "${created.title}" aangemaakt bij ${optText(payload, 'project_name') ?? 'het project'} — nog een concept`;
  },

  'gallery.update_settings': async (payload, ctx) => {
    const galleryId = text(payload, 'gallery_id');
    const patch = { ...patchOf(payload) };
    // `expires_date` is een dag; de galerij vervalt aan het EIND van die dag, in de
    // tijd van de gebruiker — precies zoals het instellingenscherm het opslaat.
    if ('expires_date' in patch) {
      const day = patch.expires_date;
      delete patch.expires_date;
      patch.expires_at = typeof day === 'string' && day ? new Date(`${day}T23:59:59`).toISOString() : null;
    }
    const updated = await updateRow<Gallery>('galleries', galleryId, patch, ctx.organizationId);
    return `Instellingen van galerij "${updated.title}" opgeslagen`;
  },

  'gallery.publish': async (payload, ctx) => {
    const updated = await updateRow<Gallery>('galleries', text(payload, 'gallery_id'), { status: 'published' }, ctx.organizationId);
    return `Galerij "${updated.title}" gepubliceerd — de klant ziet hem nu in het portaal`;
  },

  'gallery.unpublish': async (payload, ctx) => {
    const updated = await updateRow<Gallery>('galleries', text(payload, 'gallery_id'), { status: 'draft' }, ctx.organizationId);
    return `Galerij "${updated.title}" staat weer op concept — de klant ziet hem niet meer`;
  },

  'gallery.create_share_link': async (payload, ctx) => {
    const galleryId = text(payload, 'gallery_id');
    const pin = optText(payload, 'pin');
    const token = randomShareToken();
    const tokenHash = await sha256Hex(token);
    // De pincode wordt gehasht met het token als zout; de database kent alleen
    // hashes. Pincode wijzigen betekent dus: een nieuwe link genereren.
    const pinHash = pin ? await sha256Hex(`${token}:${pin}`) : null;
    const updated = await updateRow<Gallery>('galleries', galleryId, {
      share_enabled: true,
      share_token_hash: tokenHash,
      share_pin_hash: pinHash,
      share_pin_failed_count: 0,
      share_pin_locked_until: null,
    }, ctx.organizationId);
    // De link staat hier één keer; daarna is hij nergens meer op te vragen.
    const url = `${window.location.origin}/gallerij/${token}`;
    return `Deellink voor "${updated.title}" aangemaakt: ${url}`
      + (pin ? ` (pincode ${pin}) — bewaar de link, hij is later niet meer op te halen` : ' — bewaar de link, hij is later niet meer op te halen');
  },

  'gallery.revoke_share_link': async (payload, ctx) => {
    const updated = await updateRow<Gallery>('galleries', text(payload, 'gallery_id'), {
      share_enabled: false, share_token_hash: null, share_pin_hash: null,
    }, ctx.organizationId);
    return `Deellink van "${updated.title}" ingetrokken — uitgedeelde links werken niet meer`;
  },

  'gallery.set_cover': async (payload, ctx) => {
    const galleryId = text(payload, 'gallery_id');
    const itemId = optText(payload, 'item_id');
    const updated = await updateRow<Gallery>('galleries', galleryId, {
      cover_item_id: itemId,
      cover_preview_key: null,
      cover_thumb_key: null,
      cover_bytes: 0,
    }, ctx.organizationId);
    // Een vervangen eigen coverbeeld hangt aan geen enkel item en verdwijnt dus
    // niet vanzelf; laat staan zou opslag kosten die niemand meer ziet.
    const oldKeys = Array.isArray(payload.old_cover_keys) ? (payload.old_cover_keys as unknown[]).map(String) : [];
    for (const key of oldKeys) void deleteR2Object(key).catch(() => undefined);
    const fileName = optText(payload, 'file_name');
    return fileName
      ? `"${fileName}" is nu de opening van galerij "${updated.title}"`
      : `De opening van galerij "${updated.title}" staat weer op automatisch`;
  },

  'gallery.set_cover_focus': async (payload, ctx) => {
    const x = numberOf(payload, 'focus_x');
    const y = numberOf(payload, 'focus_y');
    const updated = await updateRow<Gallery>('galleries', text(payload, 'gallery_id'), {
      cover_focus_x: x, cover_focus_y: y,
    }, ctx.organizationId);
    return `Focuspunt van de opening van "${updated.title}" staat op ${x}% / ${y}%`;
  },

  'gallery.sort_items': async (payload) => {
    const galleryId = text(payload, 'gallery_id');
    const itemIds = list(payload, 'item_ids');
    await setGalleryItemOrder(galleryId, itemIds as UUID[]);
    const how = optText(payload, 'how');
    return `Volgorde van ${itemIds.length} bestand${itemIds.length === 1 ? '' : 'en'} in "${optText(payload, 'gallery_title') ?? 'de galerij'}" opgeslagen`
      + (how ? ` (${how})` : '');
  },

  'gallery.assign_category': async (payload, ctx) => {
    const itemIds = list(payload, 'item_ids');
    await setGalleryItemsCategory(ctx.organizationId, itemIds as UUID[], optText(payload, 'category_id'));
    const categoryName = optText(payload, 'category_name') ?? 'Zonder categorie';
    return `${itemIds.length} bestand${itemIds.length === 1 ? '' : 'en'} staat nu onder "${categoryName}"`;
  },

  'gallery_category.create': async (payload, ctx) => {
    const created = await insertRow<GalleryCategory>('gallery_categories', ctx.organizationId, {
      gallery_id: text(payload, 'gallery_id'),
      name: text(payload, 'name'),
      position: Number(payload.position ?? 0),
    });
    return `Categorie "${created.name}" toegevoegd aan galerij ${named(payload, 'gallery_title')}`;
  },

  'gallery_category.rename': async (payload, ctx) => {
    const name = text(payload, 'name');
    await updateRow<GalleryCategory>('gallery_categories', text(payload, 'category_id'), { name }, ctx.organizationId);
    return `Categorie ${named(payload, 'was')} heet nu "${name}"`;
  },

  'gallery_category.set_order': async (payload, ctx) => {
    const categoryIds = list(payload, 'category_ids');
    // Eén rij per positie, net als het scherm bij het verschuiven van een categorie.
    for (let i = 0; i < categoryIds.length; i += 1) {
      await updateRow<GalleryCategory>('gallery_categories', categoryIds[i], { position: i }, ctx.organizationId);
    }
    return `Volgorde van ${categoryIds.length} categorie${categoryIds.length === 1 ? '' : 'ën'} in "${optText(payload, 'gallery_title') ?? 'de galerij'}" opgeslagen`;
  },

  'gallery_category.apply_presets': async (payload, ctx) => {
    const galleryId = text(payload, 'gallery_id');
    const rows = Array.isArray(payload.categories) ? payload.categories as Array<Record<string, unknown>> : [];
    if (rows.length === 0) throw new Error('Deze actie mist "categories".');
    const added: string[] = [];
    for (const row of rows) {
      const created = await insertRow<GalleryCategory>('gallery_categories', ctx.organizationId, {
        gallery_id: galleryId, name: String(row.name ?? ''), position: Number(row.position ?? 0),
      });
      added.push(created.name);
    }
    return `${added.length} standaardcategorie${added.length === 1 ? '' : 'ën'} toegevoegd aan "${optText(payload, 'gallery_title') ?? 'de galerij'}": ${added.join(', ')}`;
  },

  'gallery_category.save_presets': async (payload, ctx) => {
    const names = list(payload, 'names');
    const saved = await replaceGalleryCategoryPresets(ctx.organizationId, names);
    return `Standaardcategorieën bewaard (${saved.length}): ${saved.map(p => p.name).join(', ')}`;
  },
};
