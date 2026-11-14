import type { Proposal } from './gerrieCore.ts';

/**
 * Wat Gerrie in de chat zegt over wat hij heeft klaargezet.
 *
 * Tot 14 november stond dit als één lange keten in gerrieCore.ts, met als laatste
 * tak "Ik heb een conceptfactuur voor je klaargezet". Elk soort voorstel dat er
 * niet in stond, viel daarop terug: uren op een project, een projectteam, een taak
 * toewijzen, een contactpersoon, een agent, en alles wat via de handelingenregistry
 * loopt (een projectsjabloon, iets verwijderen, een boeking). Vroeg iemand om een
 * project of een sjabloon, dan zei Gerrie dat hij een factuur had klaargezet. Die
 * zin kwam ook in het gesprek terecht, waarna het model hem bij volgende vragen
 * zelf ging herhalen.
 *
 * Nu heeft elk soort voorstel een eigen zin. De switch is uitputtend: een nieuw
 * soort voorstel zonder zin geeft een typefout (deno check), en
 * gerrieProposalText.test.ts vergelijkt de soorten met die in gerrieCore.ts.
 */
export function chatProposalText(proposal: Proposal): string {
  const p = proposal;
  switch (p.type) {
    // De registry schrijft de titel zelf ("Projectsjabloon aanmaken: Website",
    // "Taak "Offerte maken" verwijderen"); die naam klopt altijd.
    case 'action': return `Ik heb dit voor je klaargezet — ${trimEnd(p.title)}.${p.risk === 'high' ? ' Let op: dit kun je niet terugdraaien.' : ''} Bevestig hieronder als het klopt.`;
    case 'invoice': return `Ik heb een conceptfactuur voor ${p.client_name} klaargezet. Controleer hem en sla op:`;
    case 'quote': return `Ik heb een conceptofferte voor ${p.client_name} klaargezet. Controleer hem en sla op:`;
    case 'client': return 'Ik heb de nieuwe klant voor je klaargezet. Controleer de gegevens en sla op:';
    case 'send_invoice': return `Wil je dat ik factuur ${p.number} naar ${p.recipient_email} verstuur? Bevestig hieronder.`;
    case 'send_quote': return `Wil je dat ik offerte ${p.number} naar ${p.recipient_email} verstuur? Bevestig hieronder.`;
    case 'send_invoices': return `Ik heb ${p.total} factu${p.total === 1 ? 'ur' : 'ren'} klaargezet om te versturen. Vink hieronder aan welke er weg mogen.`;
    case 'send_quotes': return `Ik heb ${p.total} offerte${p.total === 1 ? '' : 's'} klaargezet om te versturen. Vink hieronder aan welke er weg mogen.`;
    case 'convert_quote': return `Wil je dat ik offerte ${p.number} omzet naar een factuur? Bevestig hieronder.`;
    case 'edit_invoice': return `Ik heb de wijziging van concept-factuur ${p.number} klaargezet. Controleer hem en sla op:`;
    case 'edit_quote': return `Ik heb de wijziging van concept-offerte ${p.number} klaargezet. Controleer hem en sla op:`;
    case 'edit_client': return `Ik heb de wijziging van klant ${p.name} klaargezet. Controleer de gegevens en sla op:`;
    case 'send_reminders': return `Ik heb ${p.total} herinnering${p.total === 1 ? '' : 'en'} klaargezet. Vink hieronder aan welke er weg mogen.`;
    case 'project': return `Ik heb het project "${p.name}" voor je klaargezet. Controleer en sla op:`;
    case 'edit_project': return `Ik heb de wijziging van project "${p.name}" klaargezet. Controleer en sla op:`;
    case 'project_team': return `Ik heb een teamwijziging voor project "${p.project_name}" klaargezet${teamChange(p.add, p.remove)}. Bevestig hieronder.`;
    case 'task': return `Ik heb de taak "${p.title}" voor je klaargezet. Controleer en sla op:`;
    case 'create_tasks': return `Ik heb ${p.total} ta${p.total === 1 ? 'ak' : 'ken'} klaargezet in "${p.project_name}". Vink hieronder aan welke je wilt aanmaken.`;
    case 'edit_task': return `Ik heb de wijziging van taak "${p.title}" klaargezet. Controleer en sla op:`;
    case 'task_assign': return p.assignees.length
      ? `Wil je dat ik de taak "${p.task_title}" toewijs aan ${names(p.assignees.map((a) => a.name))}? Bevestig hieronder.`
      : `Wil je dat ik niemand meer aan de taak "${p.task_title}" koppel? Bevestig hieronder.`;
    case 'week_action': return `Wil je dat ik deze ${p.total} actiepunt${p.total === 1 ? '' : 'en'} toevoeg? Bevestig hieronder.`;
    case 'time_entry': return `Wil je dat ik ${duration(p.minutes)} registreer${p.project_name ? ` op project "${p.project_name}"` : p.client_name ? ` bij ${p.client_name}` : ''}? Bevestig hieronder.`;
    case 'edit_time_entry': return 'Wil je dat ik deze urenregistratie aanpas? Bevestig hieronder.';
    case 'calendar_event': return `Wil je dat ik dit agenda-item aanmaak in "${p.source_name}"? Bevestig hieronder.`;
    case 'edit_calendar_event': return `Wil je dat ik het agenda-item "${p.title}" aanpas? Bevestig hieronder.`;
    case 'cancel_calendar_event': return `Wil je dat ik het agenda-item "${p.title}" afzeg?${p.has_attendees ? ' De genodigden krijgen dan een afzegging.' : ''} Bevestig hieronder.`;
    case 'client_contact': return `Wil je dat ik ${p.name} als contactpersoon toevoeg bij ${p.client_name}? Bevestig hieronder.`;
    case 'edit_client_contact': return `Ik heb de wijziging van contactpersoon ${p.name} (${p.client_name}) klaargezet. Bevestig hieronder.`;
    case 'report': return `Ik heb de rapportage "${p.name}" voor je klaargezet op de Statistieken-pagina. Controleer de grafiek en sla hem op:`;
    case 'supplier': return `Ik heb de leverancier "${p.name}" klaargezet. Controleer de gegevens en sla op:`;
    case 'purchase_invoice': return 'Ik heb een concept-inkoopfactuur klaargezet. Controleer de regels en boek hem zelf:';
    case 'contract': return `Ik heb een concept-contract "${p.title}" klaargezet. Controleer de tekst en sla op:`;
    case 'campaign': return `Ik heb een concept-campagne "${p.name}" klaargezet. Er gaat niets weg — jij bepaalt de doelgroep en drukt zelf op verzenden:`;
    case 'content': return `Ik heb ${p.kind === 'note' ? 'de notitie' : 'het document'} "${p.title}" klaargezet. Controleer en sla op:`;
    case 'ticket': return `Ik heb het ticket "${p.title}" voor je klaargezet. Controleer het en sla op:`;
    case 'edit_ticket': return `Ik heb de wijziging van ticket "${p.title}" klaargezet. Controleer en sla op:`;
    case 'ticket_note': return `Wil je dat ik deze ${p.is_internal ? 'interne notitie' : 'reactie (zichtbaar voor de klant)'} bij "${p.ticket_title}" plaats? Bevestig hieronder.`;
    case 'send_client_email': return p.total === 1
      ? `Ik heb een mail aan ${p.items[0]?.client_name || 'de klant'} klaargezet. Lees hem hieronder na; hij gaat pas weg als jij hem aanvinkt.`
      : `Ik heb ${p.total} mails aan klanten klaargezet. Lees ze hieronder na; er gaat pas iets weg als jij het aanvinkt.`;
    // Akkoord maakt de agent meteen aan én zet hem aan (onCreateAgent in main.tsx).
    case 'agent': return `Ik heb de agent "${p.name}" voor je klaargezet. Geef je akkoord, dan wordt hij meteen aangemaakt en aangezet.`;
    default: {
      // Hier komt alleen een voorstel in een vorm die deze code niet kent (een
      // oud gesprek). Dan liever niets benoemen dan iets verkeerds.
      const unknown: never = p;
      void unknown;
      return 'Ik heb het voor je klaargezet. Bevestig hieronder als het klopt.';
    }
  }
}

/**
 * De zin die tot 14 november onder élk onbekend voorstel stond. Staat hij in een
 * oud gesprek onder iets anders dan een factuur, dan halen we hem weg bij het
 * teruglezen: anders leest het model dat hij een factuur maakte toen er om een
 * project gevraagd werd, en zegt hij het bij de volgende vraag zelf.
 */
export const OLD_INVOICE_FALLBACK = 'Ik heb een conceptfactuur voor je klaargezet. Controleer hem en sla op:';

/** Een eerdere aanroep van een tool, zoals hij in `ai_messages.tool_calls` staat. */
export interface StoredToolCall { name: string; input?: Record<string, unknown>; summary?: unknown }

/**
 * Een bericht uit de geschiedenis zoals het model het terugleest: de tekst, met
 * daaronder een notitie over wat er toen werd klaargezet.
 *
 * `labels` is TOOL_LABELS uit gerrieCore.ts ("Project aanmaken", "Uren
 * registreren"); die wordt gebruikt voor oude berichten zonder `summary`.
 */
export function historyContent(content: string, toolCalls: unknown, labels: Record<string, string>): string {
  const prop = proposeCall(toolCalls);
  let text = content;
  if (prop && prop.name !== 'propose_invoice' && text.trim() === OLD_INVOICE_FALLBACK) text = '';
  const note = prop ? proposalHistoryNote(prop, labels) : '';
  if (!note) return text;
  return text ? `${text}\n${note}` : note;
}

/** Beknopte notitie over een eerder voorstel, zodat het model context houdt bij vervolgvragen. */
export function proposalHistoryNote(prop: StoredToolCall, labels: Record<string, string>): string {
  const input = prop.input ?? {};
  if (prop.name === 'propose_client') return `[Eerder voorgesteld: nieuwe klant "${String(input.name ?? '')}".]`;
  if (prop.name === 'propose_invoice' || prop.name === 'propose_quote') {
    const kind = prop.name === 'propose_quote' ? 'conceptofferte' : 'conceptfactuur';
    const lines = Array.isArray(input.lines)
      ? (input.lines as Record<string, unknown>[]).map((l) => `${num(l.quantity)}× ${String(l.description ?? '')} à €${num(l.unit_price)} (${num(l.vat)}% btw)`).join('; ')
      : '';
    return `[Eerder voorgesteld: ${kind} voor client_id ${String(input.client_id ?? '?')}; regels: ${lines}. Wil de gebruiker hierop voortborduren (bijv. "maak er een offerte van"), gebruik dan dezelfde klant en regels met het juiste type.]`;
  }
  // Sinds 14 november bewaart de chat wat er precies klaarstond ("project Website",
  // "90 minuten urenregistratie"). Oudere berichten hebben alleen de toolnaam.
  if (typeof prop.summary === 'string' && prop.summary.trim()) return `[Eerder voorgesteld: ${prop.summary.trim().slice(0, 300)}.]`;
  if (prop.name === 'propose_action') return `[Eerder voorgesteld: de handeling ${String(input.action_id ?? '?')}.]`;
  const label = labels[prop.name];
  const named = typeof input.name === 'string' ? input.name : typeof input.title === 'string' ? input.title : '';
  return label ? `[Eerder voorgesteld: ${label.charAt(0).toLowerCase()}${label.slice(1)}${named ? ` ("${named.slice(0, 120)}")` : ''}.]` : '';
}

function proposeCall(toolCalls: unknown): StoredToolCall | null {
  if (!Array.isArray(toolCalls)) return null;
  const found = toolCalls.find((t) => t && typeof (t as { name?: unknown }).name === 'string' && (t as { name: string }).name.startsWith('propose_'));
  return (found as StoredToolCall | undefined) ?? null;
}

/** "1 uur", "45 minuten", "2 uur en 15 minuten". */
function duration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} minuten`;
  return m === 0 ? `${h} uur` : `${h} uur en ${m} minuten`;
}

/** "Anna", "Anna en Bram", "Anna, Bram en Cor". */
function names(list: string[]): string {
  if (list.length <= 1) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')} en ${list[list.length - 1]}`;
}

/** " (erbij: Anna; eraf: Bram)" achter een teamwijziging. */
function teamChange(add: Array<{ name: string }>, remove: Array<{ name: string }>): string {
  const parts = [
    add.length ? `erbij: ${names(add.map((m) => m.name))}` : '',
    remove.length ? `eraf: ${names(remove.map((m) => m.name))}` : '',
  ].filter(Boolean);
  return parts.length ? ` (${parts.join('; ')})` : '';
}

/** Een titel eindigt soms al op een punt; dan geen tweede erachter. */
function trimEnd(title: string): string {
  return title.trim().replace(/[.\s]+$/, '');
}

/** Zoals num() in gerrieCore.ts: "1,5" telt als 1.5, iets onleesbaars als 0. */
function num(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value == null) return 0;
  const parsed = Number(String(value).replace(',', '.').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}
