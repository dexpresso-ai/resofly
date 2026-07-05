// Bevestigingsmail naar de klant na het boeken (meeting booking tool).
// De agenda-uitnodiging (.ics / provider-invite) gaat apart mee; dit is de
// begeleidende bevestiging met de gekozen tijden en de begeleidende tekst.
// Per-organisatie aanpasbaar via email_templates (sleutel 'meetingBooking.confirmed').
import { renderEmailLayout, escapeHtml, textLines } from './layout.ts';
import { fieldOr, optionalFieldOr, renderContentHtml, renderContentText, type EmailTemplateContent, type TemplateVars } from './content.ts';

export type MeetingBookingConfirmedEmailInput = {
  brandName: string;
  recipientName?: string | null;
  title: string;
  whenLines: string[];
  meetingUrl?: string | null;
  /** Per-link begeleidende tekst die de gebruiker bij deze link heeft ingevuld. */
  inviteMessage?: string | null;
  location?: string | null;
  accentColor?: string | null;
  /** Org-brede, in de editor aangepaste e-mailtekst. */
  content?: EmailTemplateContent | null;
};

const DEFAULT_SUBJECT = 'Bevestigd: {{meeting_title}}';
const DEFAULT_INTRO = 'Beste {{recipient_name}},\nJe afspraak is bevestigd. Je ontvangt hierbij ook een agenda-uitnodiging.';

export function renderMeetingBookingConfirmedEmail(input: MeetingBookingConfirmedEmailInput): { subject: string; html: string; text: string } {
  const brandName = input.brandName || 'ResoFly';
  const recipientName = input.recipientName?.trim() || 'relatie';
  const perLinkNote = String(input.inviteMessage || '').trim();

  const vars: TemplateVars = {
    recipient_name: recipientName,
    company_name: brandName,
    meeting_title: input.title,
    booking_when: input.whenLines[0] ?? '',
  };

  const subject = renderContentText(fieldOr(input.content, 'subject', DEFAULT_SUBJECT), vars).trim() || `Bevestigd: ${input.title}`;
  const introHtml = renderContentHtml(fieldOr(input.content, 'intro', DEFAULT_INTRO), vars);
  const introText = renderContentText(fieldOr(input.content, 'intro', DEFAULT_INTRO), vars);
  const closing = optionalFieldOr(input.content, 'closing', null);
  const closingHtml = closing ? renderContentHtml(closing, vars) : null;
  const closingText = closing ? renderContentText(closing, vars) : null;

  const whenHtml = input.whenLines.length
    ? `<ul style="margin:0 0 12px;padding-left:18px;">${input.whenLines.map(w => `<li style="margin:0 0 4px;">${escapeHtml(w)}</li>`).join('')}</ul>`
    : '';

  const bodyHtml = [
    `<p style="margin:16px 0 6px;font-weight:700;">Wanneer</p>`,
    whenHtml,
    input.location ? `<p style="margin:0 0 12px;"><strong>Locatie:</strong> ${escapeHtml(input.location)}</p>` : '',
    input.meetingUrl ? `<p style="margin:0 0 12px;"><strong>Videocall:</strong> <a href="${escapeHtml(input.meetingUrl)}" style="color:inherit;">${escapeHtml(input.meetingUrl)}</a></p>` : '',
    perLinkNote ? `<p style="margin:12px 0 0;color:#d8d8df;line-height:1.6;white-space:pre-wrap;">${escapeHtml(perLinkNote)}</p>` : '',
    closingHtml ? `<p style="margin:16px 0 0;color:#d8d8df;line-height:1.6;">${closingHtml}</p>` : '',
  ].join('');

  const html = renderEmailLayout({
    brandName,
    eyebrow: brandName,
    preheader: `Bevestigd: ${input.title}`,
    title: 'Afspraak bevestigd',
    introHtml: `<p style="margin:0;">${introHtml}</p>`,
    bodyHtml,
    cta: input.meetingUrl ? { label: 'Deelnemen aan videocall', url: input.meetingUrl } : undefined,
    accentColor: input.accentColor,
  });

  const text = textLines([
    introText,
    '',
    'Wanneer:',
    ...input.whenLines.map(w => `- ${w}`),
    input.location ? `Locatie: ${input.location}` : false,
    input.meetingUrl ? `Videocall: ${input.meetingUrl}` : false,
    perLinkNote ? '' : false,
    perLinkNote || false,
    closingText ? '' : false,
    closingText || false,
  ]);

  return { subject, html, text };
}
