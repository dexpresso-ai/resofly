import {
  clearMySenderIdentity, disableOrganizationMember, ensureInboundAlias, inviteOrganizationMember,
  resetEmailTemplate, revokeOrganizationInvitation, rotateInboundAlias, saveMySenderIdentity,
  sendTeamInvitationEmail, setInboundAliasForwardFrom, setMemberModuleAccess, updateOrganizationMemberRole,
  upsertCompanySettings, upsertEmailTemplate,
} from '../repository';
import { setNotificationPreference, type PushEventType } from '../push-api';
import type { ModuleAccess } from '../permissions';
import { flag, optText, patchOf, text, type ActionExecutor, type ActionRunCtx } from './types';
import type { CompanySettingsInput, EmailTemplateKey, OrganizationRole } from '../../types';

/**
 * Uitvoerders voor de beheer-handelingen. Elke functie doet precies wat de knop in
 * Instellingen doet — zie `supabase/functions/_shared/actions/admin.ts` voor wat er
 * aan de gebruiker beloofd wordt op de kaart die hij goedkeurt.
 */

const ROLE_LABELS: Record<string, string> = { owner: 'owner', admin: 'admin', member: 'member', viewer: 'viewer' };

/** Zelfde domein als in de instellingenkaart en in de server-handeling. */
const INBOUND_DOMAIN = 'inbound.resofly.com';

/**
 * Bouwt de invoer voor `upsertCompanySettings`: de rij zoals hij nu geladen is, met
 * de gewijzigde velden eroverheen. Dat is wat het instellingenscherm ook doet — het
 * houdt één formulier bij en slaat het geheel op.
 *
 * Is er nog geen rij, dan gaan alleen de gewijzigde velden mee. Elke kolom van
 * `company_settings` heeft een databasestandaard, dus de rest vult zichzelf bij het
 * aanmaken; de cast dekt precies dat ene geval af.
 */
function settingsInput(ctx: ActionRunCtx, patch: Record<string, unknown>): CompanySettingsInput {
  const current = ctx.data.companySettings;
  if (!current) return patch as CompanySettingsInput;
  const {
    id: _id, organization_id: _organizationId, created_by: _createdBy,
    created_at: _createdAt, updated_at: _updatedAt, ...rest
  } = current;
  return { ...rest, ...patch } as CompanySettingsInput;
}

/** Slaat een deelwijziging van de bedrijfsinstellingen op. */
async function saveSettings(ctx: ActionRunCtx, payload: Record<string, unknown>): Promise<void> {
  await upsertCompanySettings(ctx.organizationId, settingsInput(ctx, patchOf(payload)));
}

export const ADMIN_EXECUTORS: Record<string, ActionExecutor> = {
  // ── Team ──────────────────────────────────────────────────────────────────
  'team.invite': async (payload, ctx) => {
    const email = text(payload, 'email');
    const role = text(payload, 'role') as OrganizationRole;
    const access = (payload.module_access && typeof payload.module_access === 'object'
      ? payload.module_access : {}) as ModuleAccess;
    const invitation = await inviteOrganizationMember(ctx.organizationId, email, role, access);
    // De uitnodiging staat nu in de database; de mail is een aparte stap. Faalt die,
    // dan blijft de uitnodiging bestaan — dat melden we eerlijk in plaats van
    // "verstuurd", precies zoals het instellingenscherm het doet.
    try {
      await sendTeamInvitationEmail(ctx.organizationId, invitation.id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'onbekende fout';
      return `Uitnodiging voor ${email} aangemaakt als ${ROLE_LABELS[role] ?? role}, maar de uitnodigingsmail kon niet worden verzonden (${reason}). Hij kan zelf inloggen met dit adres om de uitnodiging te accepteren.`;
    }
    return `${email} uitgenodigd als ${ROLE_LABELS[role] ?? role} — er is één gebruikerslicentie gereserveerd`;
  },

  'team.revoke_invitation': async (payload, ctx) => {
    await revokeOrganizationInvitation(text(payload, 'invitation_id'), ctx.organizationId);
    return `Uitnodiging voor ${optText(payload, 'email') ?? 'het teamlid'} ingetrokken — de gebruikerslicentie is vrij`;
  },

  'team.set_role': async (payload, ctx) => {
    const role = text(payload, 'role') as OrganizationRole;
    await updateOrganizationMemberRole(text(payload, 'member_id'), ctx.organizationId, role);
    return `${optText(payload, 'email') ?? 'Het teamlid'} is nu ${ROLE_LABELS[role] ?? role}`;
  },

  'team.set_module_access': async (payload) => {
    const access = (payload.module_access && typeof payload.module_access === 'object'
      ? payload.module_access : {}) as ModuleAccess;
    await setMemberModuleAccess(text(payload, 'member_id'), access);
    return `Modulerechten van ${optText(payload, 'email') ?? 'het teamlid'} opgeslagen`;
  },

  'team.disable': async (payload, ctx) => {
    await disableOrganizationMember(text(payload, 'member_id'), ctx.organizationId);
    return `${optText(payload, 'email') ?? 'Teamlid'} uitgeschakeld — de gebruikerslicentie is vrij`;
  },

  // ── Bedrijfsinstellingen en huisstijl (alle vier dezelfde rij) ────────────
  'branding.save': async (payload, ctx) => {
    await saveSettings(ctx, payload);
    return 'Huisstijl opgeslagen — het klantportaal, de galerijen en de publieke offerte-, factuur- en contractpagina gebruiken hem direct';
  },

  'settings.save_company': async (payload, ctx) => {
    await saveSettings(ctx, payload);
    return 'Bedrijfsgegevens opgeslagen — nieuwe facturen en offertes gebruiken ze direct';
  },

  'settings.set_legal_form': async (payload, ctx) => {
    await saveSettings(ctx, payload);
    return `Rechtsvorm gewijzigd naar ${optText(payload, 'legal_form_label') ?? 'de nieuwe rechtsvorm'}`;
  },

  'settings.save_invoice_layout': async (payload, ctx) => {
    await saveSettings(ctx, payload);
    return 'Factuurstijl en teksten opgeslagen — je volgende factuur-PDF gebruikt ze';
  },

  'settings.save_bookkeeping': async (payload, ctx) => {
    await saveSettings(ctx, payload);
    return 'Boekhoudinstellingen opgeslagen — het grootboek en de btw-aangifte volgen ze vanaf nu';
  },

  'settings.set_default_hourly_rate': async (payload, ctx) => {
    await saveSettings(ctx, payload);
    const label = optText(payload, 'rate_label');
    return label && label !== 'geen tarief'
      ? `Standaard uurtarief staat nu op ${label}`
      : 'Standaard uurtarief weggehaald — uren zonder projecttarief krijgen geen waarde meer';
  },

  // ── E-mailteksten ─────────────────────────────────────────────────────────
  'email_template.save': async (payload, ctx) => {
    const key = text(payload, 'template_key') as EmailTemplateKey;
    await upsertEmailTemplate(ctx.organizationId, key, {
      enabled: true,
      subject: optText(payload, 'subject'),
      intro: optText(payload, 'intro'),
      closing: optText(payload, 'closing'),
      cta_label: optText(payload, 'cta_label'),
    });
    return `E-mailtekst "${optText(payload, 'label') ?? key}" opgeslagen — nieuwe mails gebruiken hem direct`;
  },

  'email_template.reset': async (payload, ctx) => {
    const key = text(payload, 'template_key') as EmailTemplateKey;
    await resetEmailTemplate(ctx.organizationId, key);
    return `E-mailtekst "${optText(payload, 'label') ?? key}" teruggezet op de standaardtekst`;
  },

  // ── Afzender en doorstuuradres ────────────────────────────────────────────
  'sender.set_mine': async (payload, ctx) => {
    await saveMySenderIdentity(ctx.organizationId, {
      from_name: optText(payload, 'from_name'),
      from_email: optText(payload, 'from_email'),
    });
    return `Persoonlijke afzender opgeslagen — je mailt voortaan als ${optText(payload, 'preview') ?? 'jezelf'}`;
  },

  'sender.clear_mine': async (_payload, ctx) => {
    await clearMySenderIdentity(ctx.organizationId);
    return 'Persoonlijke afzender gewist — je mailt weer onder de afzender van de organisatie';
  },

  'inbound_alias.create': async (_payload, ctx) => {
    const alias = await ensureInboundAlias(ctx.organizationId);
    return `Doorstuuradres ${alias.local_part}@${INBOUND_DOMAIN} aangemaakt — zet de doorstuurregel nu bij je mailprovider`;
  },

  'inbound_alias.rotate': async (_payload, ctx) => {
    const alias = await rotateInboundAlias(ctx.organizationId);
    return `Nieuw doorstuuradres ${alias.local_part}@${INBOUND_DOMAIN} aangemaakt — pas de doorstuurregel bij je mailprovider aan; het oude adres levert nog 30 dagen in de opvangbak`;
  },

  'inbound_alias.set_forward_from': async (payload, ctx) => {
    const email = text(payload, 'email');
    await setInboundAliasForwardFrom(ctx.organizationId, text(payload, 'alias_id'), email);
    return `Vastgelegd dat er vanaf ${email} wordt doorgestuurd`;
  },

  // ── Meldingen ─────────────────────────────────────────────────────────────
  'notification.set_preference': async (payload, ctx) => {
    const enabled = flag(payload, 'enabled');
    await setNotificationPreference(ctx.organizationId, text(payload, 'event_type') as PushEventType, enabled);
    return `Melding "${optText(payload, 'label') ?? text(payload, 'event_type')}" staat nu ${enabled ? 'aan' : 'uit'}`;
  },
};
