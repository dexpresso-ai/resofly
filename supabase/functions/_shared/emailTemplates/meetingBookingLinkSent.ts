// Mail naar de klant met de boekingslink (meeting booking tool).
// Per-organisatie aanpasbaar via email_templates (sleutel 'meetingBooking.linkSent');
// lege velden vallen terug op de standaardteksten hieronder.
import { renderEmailLayout, escapeHtml, textLines } from './layout.ts';
import { fieldOr, renderContentHtml, renderContentText, type EmailTemplateContent, type TemplateVars } from './content.ts';

export type MeetingBookingLinkEmailInput = {
  brandName: string;
  recipientName?: string | null;
  title: string;
  /** Per-link intro-tekst die de gebruiker bij deze specifieke link heeft ingevuld. */
  introText?: string | null;
  bookingUrl: string;
  accentColor?: string | null;
  /** Org-brede, in de editor aangepaste e-mailtekst. */
  content?: EmailTemplateContent | null;
};

const DEFAULT_SUBJECT = '{{meeting_title}} — kies een moment';
const DEFAULT_INTRO = 'Beste {{recipient_name}},\nJe kunt zelf een moment kiezen dat jou uitkomt. Klik op de knop hieronder voor de beschikbare tijden.';
const DEFAULT_CTA = 'Kies een moment';

export function renderMeetingBookingLinkEmail(input: MeetingBookingLinkEmailInput): { subject: string; html: string; text: string } {
  const brandName = input.brandName || 'ResoFly';
  const recipientName = input.recipientName?.trim() || 'relatie';
  const perLinkNote = String(input.introText || '').trim();

  const vars: TemplateVars = {
    recipient_name: recipientName,
    company_name: brandName,
    meeting_title: input.title,
  };

  const subject = renderContentText(fieldOr(input.content, 'subject', DEFAULT_SUBJECT), vars).trim() || input.title;
  const introHtml = renderContentHtml(fieldOr(input.content, 'intro', DEFAULT_INTRO), vars);
  const introText = renderContentText(fieldOr(input.content, 'intro', DEFAULT_INTRO), vars);
  const ctaLabel = renderContentText(fieldOr(input.content, 'ctaLabel', DEFAULT_CTA), vars).trim() || DEFAULT_CTA;

  const bodyHtml = perLinkNote ? `<p style="margin:16px 0 0;color:#d8d8df;line-height:1.6;white-space:pre-wrap;">${escapeHtml(perLinkNote)}</p>` : undefined;

  const html = renderEmailLayout({
    brandName,
    eyebrow: brandName,
    preheader: `${input.title} — kies zelf een moment`,
    title: input.title,
    introHtml: `<p style="margin:0;">${introHtml}</p>`,
    bodyHtml,
    cta: { label: ctaLabel, url: input.bookingUrl },
    accentColor: input.accentColor,
    footerHtml: `Werkt de knop niet? Kopieer deze link: <br /><a href="${escapeHtml(input.bookingUrl)}" style="color:#9b9ba7;">${escapeHtml(input.bookingUrl)}</a>`,
  });

  const text = textLines([
    introText,
    '',
    input.bookingUrl,
    perLinkNote ? '' : false,
    perLinkNote || false,
  ]);

  return { subject, html, text };
}
