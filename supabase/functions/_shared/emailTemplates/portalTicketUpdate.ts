import { fieldOr, optionalFieldOr, renderContentHtml, renderContentText, type TemplateVars } from './content.ts';
import { escapeHtml, renderEmailLayout, sanitizeAccentColor, textLines } from './layout.ts';
import type { PortalTicketTemplateKey, PortalTicketUpdateEmailInput, RenderedEmailTemplate } from './types.ts';

// Melding aan een klant over een ticket: ontvangen, nieuw ticket, nieuw
// antwoord of een statuswijziging — of een paar daarvan tegelijk, als ze vlak
// na elkaar gebeurden. Eén mail per ticket per ontvanger; wat erin staat
// bepaalt _shared/portalNotify.ts.
//
// Onderwerp, aanhef & bericht, afsluiting en knoptekst zijn per soort melding
// per organisatie aan te passen (email_templates, Instellingen → E-mail). Vast
// blijven: het ticket met de status, de antwoorden zelf, de link naar het
// ticket en de regel "Meldingen beheren" onderaan.
//
// Alles wat van mensen komt (tickettitel, antwoorden, namen, eigen teksten)
// wordt ge-escaped en nooit als HTML doorgegeven.

/** Langer dan dit wordt een antwoord in de mail afgekapt; het hele stuk staat in het portaal. */
const MAX_REPLY_CHARS = 2000;

/**
 * De ingebouwde standaardteksten per soort melding. Een organisatie kan ze per
 * veld overschrijven; lege velden vallen hierop terug. De editor in de app
 * (src/lib/emailTemplateContent.ts) toont dezelfde teksten —
 * src/lib/emailTemplateContent.test.ts houdt beide gelijk.
 */
export const PORTAL_TICKET_DEFAULTS: Record<PortalTicketTemplateKey, { subject: string; intro: string; closing: string; ctaLabel: string }> = {
  'portal.ticket.received': {
    subject: 'Ticket ontvangen: {{ticket_title}}',
    intro: 'Beste {{recipient_name}},\nBedankt voor je bericht. {{company_name}} heeft je ticket ‘{{ticket_title}}’ ontvangen. Je krijgt een e-mail zodra er een antwoord is of de status verandert.',
    closing: '',
    ctaLabel: 'Bekijk het ticket',
  },
  'portal.ticket.created': {
    subject: 'Nieuw ticket: {{ticket_title}}',
    intro: 'Beste {{recipient_name}},\n{{created_by}} heeft het ticket ‘{{ticket_title}}’ aangemaakt.',
    closing: '',
    ctaLabel: 'Bekijk het ticket',
  },
  'portal.ticket.reply': {
    subject: '{{new_replies}}: {{ticket_title}}',
    intro: 'Beste {{recipient_name}},\n{{reply_author}} heeft gereageerd op het ticket ‘{{ticket_title}}’.',
    closing: '',
    ctaLabel: 'Lees en reageer in het portaal',
  },
  'portal.ticket.status': {
    subject: 'Ticket {{status_sentence}}: {{ticket_title}}',
    intro: 'Beste {{recipient_name}},\nHet ticket ‘{{ticket_title}}’ is {{status_sentence}}.',
    closing: '',
    ctaLabel: 'Bekijk het ticket',
  },
};

export const PORTAL_TICKET_TEMPLATE_KEYS = Object.keys(PORTAL_TICKET_DEFAULTS) as PortalTicketTemplateKey[];

/**
 * De plaatshouders die de editor per melding aanbiedt. Ingevuld worden ze
 * altijd allemaal (een plaatshouder die bij een melding niet past is leeg of
 * 0), maar alleen deze zijn zinvol.
 */
const COMMON_PLACEHOLDERS = ['recipient_name', 'company_name', 'client_name', 'ticket_title', 'ticket_status'];
export const PORTAL_TICKET_PLACEHOLDERS: Record<PortalTicketTemplateKey, string[]> = {
  'portal.ticket.received': [...COMMON_PLACEHOLDERS],
  'portal.ticket.created': [...COMMON_PLACEHOLDERS, 'created_by'],
  'portal.ticket.reply': [...COMMON_PLACEHOLDERS, 'reply_author', 'new_replies', 'reply_count'],
  'portal.ticket.status': [...COMMON_PLACEHOLDERS, 'previous_status', 'status_sentence'],
};

/** Welke tekst geldt voor deze mail: de belangrijkste gebeurtenis erin. */
export function portalTicketTemplateKey(input: Pick<PortalTicketUpdateEmailInput, 'confirmation' | 'newTicket' | 'replies'>): PortalTicketTemplateKey {
  if (input.confirmation) return 'portal.ticket.received';
  if (input.newTicket) return 'portal.ticket.created';
  if ((input.replies ?? []).length > 0) return 'portal.ticket.reply';
  return 'portal.ticket.status';
}

export function renderPortalTicketUpdateEmail(input: PortalTicketUpdateEmailInput): RenderedEmailTemplate {
  const companyName = input.companyName?.trim() || 'je leverancier';
  const title = input.ticket.title?.trim() || 'Ticket';
  const replies = input.replies ?? [];
  const yourTicket = input.ownTicket ? 'je ticket' : 'het ticket';
  const currentStatus = input.status?.toLabel || input.ticket.statusLabel;

  const key = portalTicketTemplateKey(input);
  const defaults = PORTAL_TICKET_DEFAULTS[key];
  const content = input.content?.[key] ?? null;

  const vars: TemplateVars = {
    recipient_name: input.recipientName?.trim() || 'relatie',
    company_name: companyName,
    client_name: input.clientName?.trim() || '',
    ticket_title: title,
    ticket_status: currentStatus,
    previous_status: input.status?.fromLabel || '',
    status_sentence: input.status?.sentence || `nu ‘${currentStatus}’`,
    created_by: input.createdBy?.trim() || companyName,
    // Wie het laatst reageerde: "Studio Lopik heeft gereageerd" leest ook goed
    // als er in dezelfde mail nog een eerder antwoord staat.
    reply_author: replies.length ? replies[replies.length - 1].authorName : companyName,
    reply_count: String(replies.length),
    new_replies: replies.length > 1 ? `${replies.length} nieuwe antwoorden` : 'Nieuw antwoord',
  };

  // ── Onderwerp, kop en tekst ───────────────────────────────────────────
  const subject = oneLine(renderContentText(fieldOr(content, 'subject', defaults.subject), vars))
    || oneLine(renderContentText(defaults.subject, vars));
  const heading = headingFor(key, input, yourTicket, replies.length);
  const intro = fieldOr(content, 'intro', defaults.intro);
  const introHtml = renderContentHtml(intro, vars);
  const introText = renderContentText(intro, vars).trim();
  const closing = optionalFieldOr(content, 'closing', defaults.closing || null);
  const closingHtml = closing ? renderContentHtml(closing, vars) : null;
  const closingText = closing ? renderContentText(closing, vars).trim() : null;
  const ctaLabel = oneLine(renderContentText(fieldOr(content, 'ctaLabel', defaults.ctaLabel), vars))
    || oneLine(renderContentText(defaults.ctaLabel, vars));

  // Een statuswijziging die meekomt met een andere melding krijgt een eigen regel.
  const statusAside = input.status && key !== 'portal.ticket.status'
    ? `De status is nu ‘${input.status.toLabel}’.`
    : null;

  // ── HTML ──────────────────────────────────────────────────────────────
  const statusRow = input.status?.fromLabel
    ? `Status: <strong style="color:#ffffff;">${escapeHtml(input.status.toLabel)}</strong> <span style="color:#8a8a96;">(was ${escapeHtml(input.status.fromLabel)})</span>`
    : `Status: <strong style="color:#ffffff;">${escapeHtml(currentStatus)}</strong>`;
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
  const closingBlock = closingHtml ? `<p style="margin:16px 0 0;color:#d8d8df;line-height:1.6;">${closingHtml}</p>` : '';

  const footerHtml = [
    'Reageren kan in het klantportaal, onder Tickets — dan staat alles netjes bij het ticket.',
    `Je krijgt deze e-mail omdat meldingen over tickets aanstaan in je klantportaal. <a href="${escapeHtml(input.settingsUrl)}" style="color:#d8d8df;">Meldingen beheren</a>`,
    input.footerText ? escapeHtml(input.footerText) : null,
  ].filter(Boolean).join('<br/>');

  const html = renderEmailLayout({
    brandName: input.companyName?.trim() || 'ResoFly',
    eyebrow: input.companyName?.trim() || 'Klantportaal',
    title: heading,
    preheader: oneLine(introText).slice(0, 200),
    accentColor: input.accentColor,
    introHtml: `<p style="margin:0;">${introHtml}${statusAside ? `<br/>${escapeHtml(statusAside)}` : ''}</p>`,
    bodyHtml: `${summary}${replyBlocks}${closingBlock}`,
    cta: { label: ctaLabel, url: input.ticketUrl },
    footerHtml,
  });

  // ── Platte tekst ──────────────────────────────────────────────────────
  const text = textLines([
    heading,
    '',
    introText,
    statusAside ?? undefined,
    '',
    `Ticket: ${title}`,
    input.status?.fromLabel
      ? `Status: ${input.status.toLabel} (was ${input.status.fromLabel})`
      : `Status: ${currentStatus}`,
    ...replies.flatMap((reply) => ['', `${reply.authorName} · ${formatDateTimeNl(reply.at)}`, truncate(reply.body, MAX_REPLY_CHARS)]),
    closingText ? '' : undefined,
    closingText || undefined,
    '',
    `${ctaLabel}: ${input.ticketUrl}`,
    '',
    'Reageren kan in het klantportaal, onder Tickets.',
    `Meldingen beheren: ${input.settingsUrl}`,
    input.footerText ? input.footerText : undefined,
  ]);

  return { templateKey: 'portal.ticketUpdate', subject, html, text };
}

/** De kop van de mail: vast per soort melding, niet aanpasbaar. */
function headingFor(key: PortalTicketTemplateKey, input: PortalTicketUpdateEmailInput, yourTicket: string, replyCount: number): string {
  switch (key) {
    case 'portal.ticket.received':
      return 'We hebben je ticket ontvangen';
    case 'portal.ticket.created':
      return input.createdBy?.trim() ? `${input.createdBy.trim()} heeft een ticket ingediend` : 'Er is een ticket voor je aangemaakt';
    case 'portal.ticket.reply':
      return replyCount === 1 ? `Nieuw antwoord op ${yourTicket}` : `${replyCount} nieuwe antwoorden op ${yourTicket}`;
    case 'portal.ticket.status':
      return input.status ? `De status van ${yourTicket} is gewijzigd` : `Update over ${yourTicket}`;
  }
}

function truncate(value: string, max: number): string {
  const text = String(value ?? '').trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

/** Een onderwerpregel is één regel: een tickettitel met een regeleinde mag de header niet breken. */
function oneLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 250);
}

/** "3 okt, 14:05" in Nederlandse tijd — de ontvanger zit niet in UTC. */
export function formatDateTimeNl(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('nl-NL', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam',
  }).format(date);
}
