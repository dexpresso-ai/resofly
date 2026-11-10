import {
  blockInboundSender, createClientCall, creditInvoice, currentSessionUserId, markClientEmailsRead, saveJitsiServer,
  saveOrganizationPortalSettings, savePlannerDayCapacity, shiftProjectTaskPlanning, updateClientCall, withdrawQuote,
} from '../repository';
import { extendBookingLink } from '../meetingBookingApi';
import { renameAiReport } from '../aiReports';
import { sendMessage, startDm } from '../chat';
import { flag, list, optText, patchOf, text, type ActionExecutor } from './types';

/**
 * Uitvoerders voor de losse handelingen uit `supabase/functions/_shared/actions/work.ts`.
 * Elk is precies de knop uit het scherm: dezelfde repository-functie, dezelfde
 * database-controles, dezelfde mail.
 */
export const WORK_EXECUTORS: Record<string, ActionExecutor> = {
  'client_call.log': async (payload, ctx) => {
    const values = patchOf(payload, 'values');
    await createClientCall(ctx.organizationId, values);
    return `Gesprek "${optText(payload, 'subject') ?? ''}" vastgelegd${values.counterpart_name ? ` (met ${String(values.counterpart_name)})` : ''}`;
  },

  'client_call.update': async (payload, ctx) => {
    await updateClientCall(text(payload, 'call_id'), patchOf(payload), ctx.organizationId);
    return `Gesprek "${optText(payload, 'subject') ?? ''}" bijgewerkt`;
  },

  'quote.withdraw': async (payload, ctx) => {
    await withdrawQuote(ctx.organizationId, text(payload, 'quote_id'), optText(payload, 'reason') ?? undefined);
    return `Offerte ${optText(payload, 'number') ?? ''} ingetrokken — de klant kan er niet meer akkoord op geven`;
  },

  'invoice.credit': async (payload, ctx) => {
    const { creditNote } = await creditInvoice(ctx.organizationId, text(payload, 'invoice_id'), optText(payload, 'reason') ?? undefined);
    const number = (creditNote as { number?: string } | null)?.number;
    return `Factuur ${optText(payload, 'number') ?? ''} gecrediteerd${number ? ` met creditfactuur ${number}` : ''}; de factuur staat op geannuleerd`;
  },

  'client_email.mark_read': async (payload, ctx) => {
    const ids = list(payload, 'email_ids');
    await markClientEmailsRead(ctx.organizationId, text(payload, 'client_id'), ids);
    return `${ids.length} bericht${ids.length === 1 ? '' : 'en'} van ${optText(payload, 'client_name') ?? 'de klant'} op gelezen gezet`;
  },

  'inbox.block_sender': async (payload, ctx) => {
    const sender = text(payload, 'sender');
    await blockInboundSender(ctx.organizationId, text(payload, 'alias_id'), sender);
    return `${sender} geblokkeerd: die mail komt niet meer in de opvangbak`;
  },

  'planner.set_day_capacity': async (payload, ctx) => {
    const minutes = Number(payload.minutes);
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('Deze actie mist het aantal minuten.');
    await savePlannerDayCapacity(ctx.organizationId, text(payload, 'user_id'), { minutes, include_weekend: flag(payload, 'include_weekend') });
    return `Weekplanner staat op ${(minutes / 60).toLocaleString('nl-NL')} uur per dag${flag(payload, 'include_weekend') ? ', ook in het weekend' : ''}`;
  },

  'project.shift_planning': async (payload, ctx) => {
    const days = Number(payload.days);
    if (!Number.isFinite(days) || days === 0) throw new Error('Deze actie mist het aantal dagen.');
    const moved = await shiftProjectTaskPlanning(ctx.organizationId, text(payload, 'project_id'), list(payload, 'task_ids'), days, flag(payload, 'shift_deadlines'));
    return `${moved.length} ta${moved.length === 1 ? 'ak' : 'ken'} van "${optText(payload, 'project_name') ?? 'het project'}" ${Math.abs(days)} dag${Math.abs(days) === 1 ? '' : 'en'} ${days > 0 ? 'later' : 'eerder'} gezet`;
  },

  'booking_link.extend': async (payload, ctx) => {
    const days = Number(payload.days) || 120;
    await extendBookingLink(ctx.organizationId, text(payload, 'link_id'), days);
    return `Boekingslink "${optText(payload, 'title') ?? ''}" is nog ${days} dagen geldig`;
  },

  'ai_report.rename': async (payload, ctx) => {
    const title = text(payload, 'title');
    await renameAiReport(ctx.organizationId, text(payload, 'report_id'), title);
    return `Rapportage heet nu "${title}"`;
  },

  'teamchat.send_dm': async (payload, ctx) => {
    // Een bericht draagt de naam van wie het verstuurt. Is het voorstel namens een
    // collega klaargezet (zijn agent), dan verstuurt alleen die collega het.
    const sender = optText(payload, 'sender_user_id');
    if (sender && sender !== await currentSessionUserId()) {
      throw new Error('Dit bericht is namens een collega klaargezet; alleen die collega kan het versturen.');
    }
    const conversationId = await startDm(ctx.organizationId, text(payload, 'user_id'));
    await sendMessage(ctx.organizationId, conversationId, { body: text(payload, 'body') });
    return `Bericht verstuurd aan ${optText(payload, 'recipient') ?? 'je collega'} in de teamchat`;
  },

  'settings.set_ticket_emails': async (payload, ctx) => {
    const enabled = flag(payload, 'enabled');
    await saveOrganizationPortalSettings(ctx.organizationId, { ticket_emails_enabled: enabled });
    return enabled ? 'Klanten krijgen weer mail bij een reactie op hun ticket' : 'Klanten krijgen geen mail meer bij een reactie op hun ticket';
  },

  'settings.save_jitsi_server': async (payload, ctx) => {
    const url = optText(payload, 'url');
    await saveJitsiServer(ctx.organizationId, url);
    return url ? `Videovergaderingen lopen voortaan via ${url}` : 'Videovergaderingen lopen weer via meet.jit.si';
  },
};
