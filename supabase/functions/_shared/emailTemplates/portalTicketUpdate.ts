import { escapeHtml, renderEmailLayout, sanitizeAccentColor, textLines } from './layout.ts';
import type { PortalTicketUpdateEmailInput, RenderedEmailTemplate } from './types.ts';

// Melding aan een klant over een ticket: ontvangen, nieuw ticket, nieuw
// antwoord of een statuswijziging — of een paar daarvan tegelijk, als ze vlak
// na elkaar gebeurden. Eén mail per ticket per ontvanger; wat erin staat
// bepaalt _shared/portalNotify.ts.
//
// Alles wat van mensen komt (tickettitel, antwoorden, namen) wordt ge-escaped
// en nooit als HTML doorgegeven: een antwoord is platte tekst uit een tekstvak.

/** Langer dan dit wordt een antwoord in de mail afgekapt; het hele stuk staat in het portaal. */
const MAX_REPLY_CHARS = 2000;

export function renderPortalTicketUpdateEmail(input: PortalTicketUpdateEmailInput): RenderedEmailTemplate {
  const companyName = input.companyName?.trim() || 'je leverancier';
  const title = input.ticket.title?.trim() || 'Ticket';
  const recipientName = input.recipientName?.trim() || '';
  const greeting = recipientName ? `Beste ${recipientName},` : 'Hallo,';
  const replies = input.replies ?? [];
  const yourTicket = input.ownTicket ? 'je ticket' : 'het ticket';
  const allFromTeam = replies.length > 0 && replies.every((reply) => reply.fromTeam);

  // ── Onderwerp, kop en eerste zin ──────────────────────────────────────
  let subject: string;
  let heading: string;
  let lead: string;
  if (input.confirmation) {
    subject = `Ticket ontvangen: ${title}`;
    heading = 'We hebben je ticket ontvangen';
    lead = `Bedankt voor je bericht. ${companyName} heeft je ticket ‘${title}’ ontvangen. Je krijgt een e-mail zodra er een antwoord is of de status verandert.`;
  } else if (input.newTicket) {
    subject = `Nieuw ticket: ${title}`;
    heading = input.createdBy ? `${input.createdBy} heeft een ticket ingediend` : 'Er is een ticket voor je aangemaakt';
    lead = input.createdBy
      ? `${input.createdBy} heeft het ticket ‘${title}’ ingediend bij ${companyName}.`
      : `${companyName} heeft een ticket voor je aangemaakt: ‘${title}’.`;
  } else if (replies.length > 0) {
    subject = replies.length === 1 ? `Nieuw antwoord: ${title}` : `${replies.length} nieuwe antwoorden: ${title}`;
    heading = replies.length === 1 ? `Nieuw antwoord op ${yourTicket}` : `${replies.length} nieuwe antwoorden op ${yourTicket}`;
    lead = allFromTeam
      ? `${companyName} heeft gereageerd op ${yourTicket} ‘${title}’.`
      : `Er is gereageerd op ${yourTicket} ‘${title}’.`;
  } else if (input.status) {
    subject = `Ticket ${input.status.sentence}: ${title}`;
    heading = `De status van ${yourTicket} is gewijzigd`;
    lead = `${capitalize(yourTicket)} ‘${title}’ is ${input.status.sentence}.`;
  } else {
    subject = `Update over ${yourTicket}: ${title}`;
    heading = `Update over ${yourTicket}`;
    lead = `Er is iets veranderd aan ${yourTicket} ‘${title}’.`;
  }
  // Een statuswijziging die meekomt met een antwoord krijgt een eigen regel.
  const statusAside = input.status && (input.confirmation || input.newTicket || replies.length > 0)
    ? `De status is nu ‘${input.status.toLabel}’.`
    : null;

  const ctaLabel = replies.length > 0 ? 'Lees en reageer in het portaal' : 'Bekijk het ticket';

  // ── HTML ──────────────────────────────────────────────────────────────
  const statusRow = input.status?.fromLabel
    ? `Status: <strong style="color:#ffffff;">${escapeHtml(input.status.toLabel)}</strong> <span style="color:#8a8a96;">(was ${escapeHtml(input.status.fromLabel)})</span>`
    : `Status: <strong style="color:#ffffff;">${escapeHtml(input.status?.toLabel || input.ticket.statusLabel)}</strong>`;
  const summary = `<div style="background:#121215;border:1px solid #2a2a31;border-radius:18px;padding:18px;margin:18px 0;">
    <p style="margin:0;color:#b6b6c2;line-height:1.7;">Ticket: <strong style="color:#ffffff;">${escapeHtml(title)}</strong><br/>${statusRow}</p>
  </div>`;

  const accent = sanitizeAccentColor(input.accentColor);
  const replyBlocks = replies.map((reply) => {
    const body = truncate(reply.body, MAX_REPLY_CHARS);
    return `<div style="border-left:3px solid ${accent};padding:2px 0 2px 14px;margin:16px 0 0;">
    <p style="margin:0 0 6px;color:#9b9ba7;font-size:13px;"><strong style="color:#ffffff;">${escapeHtml(reply.authorName)}</strong> · ${escapeHtml(formatDateTimeNl(reply.at))}</p>
    <div style="color:#d8d8df;line-height:1.6;">${escapeHtml(body).replace(/\r?\n/g, '<br/>')}</div>
  </div>`;
  }).join('');

  const footerHtml = [
    'Reageren kan in het klantportaal, onder Tickets — dan staat alles netjes bij het ticket.',
    `Je krijgt deze e-mail omdat meldingen over tickets aanstaan in je klantportaal. <a href="${escapeHtml(input.settingsUrl)}" style="color:#d8d8df;">Meldingen beheren</a>`,
    input.footerText ? escapeHtml(input.footerText) : null,
  ].filter(Boolean).join('<br/>');

  const html = renderEmailLayout({
    brandName: input.companyName?.trim() || 'ResoFly',
    eyebrow: input.companyName?.trim() || 'Klantportaal',
    title: heading,
    preheader: lead,
    accentColor: input.accentColor,
    introHtml: `<p style="margin:0 0 10px;">${escapeHtml(greeting)}</p><p style="margin:0;">${escapeHtml(lead)}${statusAside ? `<br/>${escapeHtml(statusAside)}` : ''}</p>`,
    bodyHtml: `${summary}${replyBlocks}`,
    cta: { label: ctaLabel, url: input.ticketUrl },
    footerHtml,
  });

  // ── Platte tekst ──────────────────────────────────────────────────────
  const text = textLines([
    heading,
    '',
    greeting,
    lead,
    statusAside ?? undefined,
    '',
    `Ticket: ${title}`,
    input.status?.fromLabel
      ? `Status: ${input.status.toLabel} (was ${input.status.fromLabel})`
      : `Status: ${input.status?.toLabel || input.ticket.statusLabel}`,
    ...replies.flatMap((reply) => ['', `${reply.authorName} · ${formatDateTimeNl(reply.at)}`, truncate(reply.body, MAX_REPLY_CHARS)]),
    '',
    `${ctaLabel}: ${input.ticketUrl}`,
    '',
    'Reageren kan in het klantportaal, onder Tickets.',
    `Meldingen beheren: ${input.settingsUrl}`,
    input.footerText ? input.footerText : undefined,
  ]);

  return { templateKey: 'portal.ticketUpdate', subject: oneLine(subject), html, text };
}

function truncate(value: string, max: number): string {
  const text = String(value ?? '').trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

/** Een onderwerpregel is één regel: een tickettitel met een regeleinde mag de header niet breken. */
function oneLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 250);
}

function capitalize(value: string): string {
  return value.charAt(0).toLocaleUpperCase('nl-NL') + value.slice(1);
}

/** "3 okt, 14:05" in Nederlandse tijd — de ontvanger zit niet in UTC. */
export function formatDateTimeNl(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('nl-NL', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam',
  }).format(date);
}
