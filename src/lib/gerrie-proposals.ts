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
export type ProposalKind = 'money' | 'mail' | 'agenda' | 'work' | 'insight';

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
    case 'convert_quote': return { title: `Offerte ${p.number} omzetten naar factuur`, sub: p.client_name, write: true, kind: 'money' };
    case 'send_reminders': return { title: `${p.total} herinnering${p.total === 1 ? '' : 'en'} versturen`, sub: '1e / 2e / 3e niveau', write: true, kind: 'mail' };
    case 'calendar_event': return { title: `Agenda-item: ${p.title}`, sub: `${p.date} ${p.start_time}–${p.end_time}`, write: true, kind: 'agenda' };
    case 'week_action': return { title: `${p.total} actiepunt${p.total === 1 ? '' : 'en'} toevoegen`, sub: p.items.map((i) => i.title).join(' · ').slice(0, 80), write: true, kind: 'work' };
    case 'time_entry': return { title: `${formatMinutes(p.minutes)} registreren`, sub: [p.client_name, p.project_name].filter(Boolean).join(' · ') || 'geen koppeling', write: true, kind: 'work' };
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
  }
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
    case 'send_invoice': await need(h.onSendInvoice ? () => h.onSendInvoice!(p) : undefined); return;
    case 'send_quote': await need(h.onSendQuote ? () => h.onSendQuote!(p) : undefined); return;
    case 'convert_quote': await need(h.onConvertQuote ? () => h.onConvertQuote!(p) : undefined); return;
    case 'send_reminders': await need(h.onSendReminders ? () => h.onSendReminders!(p) : undefined); return;
    case 'calendar_event': await need(h.onCreateCalendarEvent ? () => h.onCreateCalendarEvent!(p) : undefined); return;
    case 'week_action': await need(h.onCreateWeekAction ? () => h.onCreateWeekAction!(p) : undefined); return;
    case 'time_entry': await need(h.onLogTimeEntry ? () => h.onLogTimeEntry!(p) : undefined); return;
  }
}
