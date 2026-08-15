import { euro, formatMinutes } from './format';
import type { GerrieActionHandlers, GerrieProposal } from './gerrie-api';

/**
 * Eén bron van waarheid voor "wat stelt Gerrie hier voor, en wat gebeurt er als ik
 * akkoord geef?".
 *
 * Deze twee functies stonden in `GerrieCommandCenter.tsx`, maar de goedkeurwachtrij
 * hangt nu op drie plekken: het commandocentrum (live banen), de agentgalerij
 * (run-historie) én het startscherm. Zou elk scherm z'n eigen labels en uitvoer-
 * schakelaar hebben, dan gaat er ooit één uit de pas lopen — en dat is precies de
 * plek waar geld verstuurd wordt. Dus: hier, en nergens anders.
 */

/** Grove soort van een voorstel; bepaalt alleen het icoontje in de wachtrij. */
export type ProposalKind = 'money' | 'mail' | 'agenda' | 'work' | 'insight' | 'agent';

export interface ProposalInfo {
  title: string;
  sub: string;
  /** `true` = echte actie (versturen/aanmaken/registreren); `false` = opent een formulier. */
  write: boolean;
  kind: ProposalKind;
}

/** Kort label voor een voorstel in de goedkeuringswachtrij. */
export function proposalLabel(p: GerrieProposal): ProposalInfo {
  switch (p.type) {
    case 'send_invoice': return { title: `Factuur ${p.number} versturen`, sub: `naar ${p.recipient_email}`, write: true, kind: 'mail' };
    case 'send_quote': return { title: `Offerte ${p.number} versturen`, sub: `naar ${p.recipient_email}`, write: true, kind: 'mail' };
    case 'send_invoices': return {
      title: p.total === 1 ? `Factuur ${p.items[0].number} versturen` : `${p.total} facturen versturen`,
      sub: p.items.map((i) => i.number).join(', ').slice(0, 80),
      write: true, kind: 'money',
    };
    case 'send_quotes': return {
      title: p.total === 1 ? `Offerte ${p.items[0].number} versturen` : `${p.total} offertes versturen`,
      sub: p.items.map((i) => i.number).join(', ').slice(0, 80),
      write: true, kind: 'money',
    };
    case 'convert_quote': return { title: `Offerte ${p.number} omzetten naar factuur`, sub: p.client_name, write: true, kind: 'money' };
    case 'send_reminders': return { title: `${p.total} herinnering${p.total === 1 ? '' : 'en'} versturen`, sub: p.invoices.map((i) => i.number).join(', ').slice(0, 80) || '1e / 2e / 3e niveau', write: true, kind: 'mail' };
    case 'calendar_event': return { title: `Agenda-item: ${p.title}`, sub: `${p.date} ${p.start_time}–${p.end_time}`, write: true, kind: 'agenda' };
    case 'week_action': return { title: `${p.total} actiepunt${p.total === 1 ? '' : 'en'} toevoegen`, sub: p.items.map((i) => i.title).join(' · ').slice(0, 80), write: true, kind: 'work' };
    case 'time_entry': return { title: `${formatMinutes(p.minutes)} registreren`, sub: [p.client_name, p.project_name].filter(Boolean).join(' · ') || 'geen koppeling', write: true, kind: 'work' };
    case 'edit_time_entry': return {
      title: 'Urenregistratie aanpassen',
      sub: [
        `${p.current.date} · ${formatMinutes(p.current.minutes)}`,
        p.changes.minutes !== undefined ? `wordt ${formatMinutes(p.changes.minutes)}` : '',
        p.changes.entry_date ? `wordt ${p.changes.entry_date}` : '',
      ].filter(Boolean).join(' → '),
      write: true, kind: 'work',
    };
    case 'edit_calendar_event': return {
      title: `Agenda-item aanpassen: ${p.title}`,
      sub: `${p.current.date} ${p.current.start_time}–${p.current.end_time} · ${p.source_name}`,
      write: true, kind: 'agenda',
    };
    case 'cancel_calendar_event': return {
      title: `Agenda-item afzeggen: ${p.title}`,
      sub: `${p.date} ${p.start_time}${p.has_attendees ? ' · genodigden krijgen een afzegging' : ''}`,
      write: true, kind: 'agenda',
    };
    case 'client_contact': return {
      title: `Contactpersoon toevoegen: ${p.name}`,
      sub: [p.client_name, p.role, p.gives_portal_access ? 'mét portaaltoegang' : ''].filter(Boolean).join(' · '),
      write: true, kind: 'work',
    };
    case 'edit_client_contact': return {
      title: `Contactpersoon wijzigen: ${p.name}`,
      sub: [p.client_name, p.changes.gives_portal_access === true ? 'krijgt portaaltoegang' : p.changes.gives_portal_access === false ? 'verliest portaaltoegang' : ''].filter(Boolean).join(' · '),
      write: true, kind: 'work',
    };
    case 'project_team': return {
      title: `Projectteam bijwerken: ${p.project_name}`,
      sub: [p.add.length ? `erbij: ${p.add.map((m) => m.name).join(', ')}` : '', p.remove.length ? `eraf: ${p.remove.map((m) => m.name).join(', ')}` : ''].filter(Boolean).join(' · '),
      write: true, kind: 'work',
    };
    case 'task_assign': return {
      title: `Taak toewijzen: ${p.task_title}`,
      sub: p.assignees.length ? p.assignees.map((a) => a.name).join(', ') : 'niemand meer toegewezen',
      write: true, kind: 'work',
    };
    case 'content': return {
      title: `${p.kind === 'note' ? 'Notitie' : 'Document'} openen: ${p.title}`,
      sub: [p.client_name, p.project_name].filter(Boolean).join(' · '),
      write: false, kind: 'work',
    };
    case 'ticket': return { title: 'Ticket openen', sub: [p.title, p.client_name].filter(Boolean).join(' · '), write: false, kind: 'work' };
    case 'edit_ticket': return { title: `Wijziging ticket openen`, sub: p.title, write: false, kind: 'work' };
    case 'ticket_note': return {
      title: p.is_internal ? 'Interne notitie plaatsen' : 'Reactie naar de klant plaatsen',
      sub: `${p.ticket_title} — ${p.body.slice(0, 60)}${p.body.length > 60 ? '…' : ''}`,
      write: true, kind: 'work',
    };
    case 'invoice': return { title: 'Conceptfactuur openen', sub: `${p.client_name} · ${euro(p.total_eur)}`, write: false, kind: 'money' };
    case 'quote': return { title: 'Conceptofferte openen', sub: `${p.client_name} · ${euro(p.total_eur)}`, write: false, kind: 'money' };
    case 'client': return { title: 'Nieuwe klant openen', sub: p.name, write: false, kind: 'work' };
    case 'edit_invoice': return { title: `Wijziging factuur ${p.number} openen`, sub: p.client_name, write: false, kind: 'money' };
    case 'edit_quote': return { title: `Wijziging offerte ${p.number} openen`, sub: p.client_name, write: false, kind: 'money' };
    case 'edit_client': return { title: 'Wijziging klant openen', sub: p.name, write: false, kind: 'work' };
    case 'project': return { title: 'Project openen', sub: p.name, write: false, kind: 'work' };
    case 'edit_project': return { title: 'Wijziging project openen', sub: p.name, write: false, kind: 'work' };
    case 'task': return { title: 'Taak openen', sub: `${p.title} · ${p.project_name}`, write: false, kind: 'work' };
    case 'edit_task': return { title: 'Wijziging taak openen', sub: p.title, write: false, kind: 'work' };
    case 'report': return { title: `Rapportage openen: ${p.name}`, sub: '', write: false, kind: 'insight' };
    case 'send_client_email': return {
      title: p.total === 1 ? `Mail aan ${p.items[0].client_name || 'de klant'}` : `${p.total} mailtjes naar klanten`,
      sub: p.total === 1 ? p.items[0].subject : p.items.map((i) => i.client_name).filter(Boolean).join(', ').slice(0, 80),
      write: true, kind: 'mail',
    };
    // Akkoord maakt de agent écht aan én zet hem aan — dus een schrijfactie, geen
    // "openen". Zie onCreateAgent in main.tsx.
    case 'agent': return { title: `Agent aanmaken en aanzetten: ${p.name}`, sub: scheduleSummary(p), write: true, kind: 'agent' };
  }
}

/** "Elke maandag om 08:00" — voor het onderschrift van een agent-voorstel. */
function scheduleSummary(p: { schedule_kind: string; hour: number; day_of_week: number | null; day_of_month: number | null }): string {
  const days = ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag'];
  const time = `${String(p.hour).padStart(2, '0')}:00`;
  if (p.schedule_kind === 'daily') return `elke dag om ${time}`;
  if (p.schedule_kind === 'weekly') return `elke ${days[(p.day_of_week ?? 1) - 1]} om ${time}`;
  return `maandelijks op dag ${p.day_of_month ?? 1} om ${time}`;
}

/** Voert een goedgekeurd voorstel uit via de gedeelde handlers (zelfde als de chat-dock). */
export async function executeProposal(p: GerrieProposal, h: GerrieActionHandlers): Promise<void> {
  const need = (fn: (() => Promise<void>) | undefined) => fn ? fn() : Promise.reject(new Error('Deze actie is hier niet beschikbaar.'));
  switch (p.type) {
    case 'invoice': h.onCreateInvoiceDraft?.(p); return;
    case 'quote': h.onCreateQuoteDraft?.(p); return;
    case 'client': h.onCreateClientDraft?.(p); return;
    case 'edit_invoice': h.onEditInvoice?.(p); return;
    case 'edit_quote': h.onEditQuote?.(p); return;
    case 'edit_client': h.onEditClient?.(p); return;
    case 'project': h.onCreateProject?.(p); return;
    case 'edit_project': h.onEditProject?.(p); return;
    case 'task': h.onCreateTask?.(p); return;
    case 'edit_task': h.onEditTask?.(p); return;
    case 'report': h.onCreateReport?.(p); return;
    case 'ticket': h.onCreateTicket?.(p); return;
    case 'edit_ticket': h.onEditTicket?.(p); return;
    case 'content': h.onCreateContent?.(p); return;
    case 'agent': await need(h.onCreateAgent ? () => h.onCreateAgent!(p) : undefined); return;
    // De hele reeks in één keer. De wachtrij gebruikt deze weg alleen als je "alles
    // versturen" kiest; vink je ze los af, dan roept hij onSendClientEmail per mail
    // aan en komt hij hier niet langs. Eén mislukte mail stopt de rest, zodat je
    // niet half-verstuurd achterblijft zonder te weten waar het misging.
    case 'send_client_email': {
      if (!h.onSendClientEmail) throw new Error('Deze actie is hier niet beschikbaar.');
      const failed: string[] = [];
      let sent = 0;
      for (const item of p.items) {
        try { await h.onSendClientEmail(item); sent += 1; }
        catch { failed.push(item.client_name || item.recipient_email); }
      }
      if (failed.length) throw new Error(`${sent} verstuurd, ${failed.length} mislukt (${failed.join(', ')}).`);
      return;
    }
    // Idem voor een reeks facturen/offertes: normaal vink je ze los af, maar wie
    // in één keer akkoord geeft loopt hier langs. Per document een eigen mail,
    // zodat je precies weet welke wél en welke niet gelukt is.
    case 'send_invoices':
    case 'send_quotes': {
      const isInvoice = p.type === 'send_invoices';
      const send = isInvoice ? h.onSendInvoice : h.onSendQuote;
      if (!send) throw new Error('Deze actie is hier niet beschikbaar.');
      const failed: string[] = [];
      let sent = 0;
      for (const doc of p.items) {
        const one = { id: doc.id, number: doc.number, client_name: doc.client_name, recipient_email: doc.recipient_email, recipient_name: doc.recipient_name };
        try {
          if (isInvoice) await h.onSendInvoice!({ type: 'send_invoice', ...one });
          else await h.onSendQuote!({ type: 'send_quote', ...one });
          sent += 1;
        } catch { failed.push(doc.number); }
      }
      if (failed.length) throw new Error(`${sent} verstuurd, ${failed.length} mislukt (${failed.join(', ')}).`);
      return;
    }
    case 'send_invoice': await need(h.onSendInvoice ? () => h.onSendInvoice!(p) : undefined); return;
    case 'send_quote': await need(h.onSendQuote ? () => h.onSendQuote!(p) : undefined); return;
    case 'convert_quote': await need(h.onConvertQuote ? () => h.onConvertQuote!(p) : undefined); return;
    case 'send_reminders': await need(h.onSendReminders ? () => h.onSendReminders!(p) : undefined); return;
    case 'calendar_event': await need(h.onCreateCalendarEvent ? () => h.onCreateCalendarEvent!(p) : undefined); return;
    case 'week_action': await need(h.onCreateWeekAction ? () => h.onCreateWeekAction!(p) : undefined); return;
    case 'time_entry': await need(h.onLogTimeEntry ? () => h.onLogTimeEntry!(p) : undefined); return;
    case 'edit_time_entry': await need(h.onEditTimeEntry ? () => h.onEditTimeEntry!(p) : undefined); return;
    case 'edit_calendar_event': await need(h.onEditCalendarEvent ? () => h.onEditCalendarEvent!(p) : undefined); return;
    case 'cancel_calendar_event': await need(h.onCancelCalendarEvent ? () => h.onCancelCalendarEvent!(p) : undefined); return;
    case 'client_contact': await need(h.onCreateClientContact ? () => h.onCreateClientContact!(p) : undefined); return;
    case 'edit_client_contact': await need(h.onEditClientContact ? () => h.onEditClientContact!(p) : undefined); return;
    case 'project_team': await need(h.onSetProjectTeam ? () => h.onSetProjectTeam!(p) : undefined); return;
    case 'task_assign': await need(h.onAssignTask ? () => h.onAssignTask!(p) : undefined); return;
    case 'ticket_note': await need(h.onAddTicketNote ? () => h.onAddTicketNote!(p) : undefined); return;
  }
}
