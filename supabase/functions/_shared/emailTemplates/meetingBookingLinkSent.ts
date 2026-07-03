// Mail naar de klant met de boekingslink (meeting booking tool).
import { renderEmailLayout, escapeHtml, textLines } from './layout.ts';

export type MeetingBookingLinkEmailInput = {
  brandName: string;
  recipientName?: string | null;
  title: string;
  introText?: string | null;
  bookingUrl: string;
  accentColor?: string | null;
};

export function renderMeetingBookingLinkEmail(input: MeetingBookingLinkEmailInput): { subject: string; html: string; text: string } {
  const brandName = input.brandName || 'ResoFly';
  const greeting = input.recipientName ? `Beste ${input.recipientName},` : 'Beste,';
  const intro = String(input.introText || '').trim();
  const subject = `${input.title} — kies een moment`;

  const introHtml = [
    `<p style="margin:0 0 12px;">${escapeHtml(greeting)}</p>`,
    `<p style="margin:0 0 12px;">Je kunt zelf een moment kiezen dat jou uitkomt. Klik op de knop hieronder voor de beschikbare tijden.</p>`,
    intro ? `<p style="margin:0 0 12px;white-space:pre-wrap;">${escapeHtml(intro)}</p>` : '',
  ].join('');

  const html = renderEmailLayout({
    brandName,
    eyebrow: brandName,
    preheader: `${input.title} — kies zelf een moment`,
    title: input.title,
    introHtml,
    cta: { label: 'Kies een moment', url: input.bookingUrl },
    accentColor: input.accentColor,
    footerHtml: `Werkt de knop niet? Kopieer deze link: <br /><a href="${escapeHtml(input.bookingUrl)}" style="color:#9b9ba7;">${escapeHtml(input.bookingUrl)}</a>`,
  });

  const text = textLines([
    greeting,
    '',
    'Je kunt zelf een moment kiezen dat jou uitkomt via onderstaande link:',
    input.bookingUrl,
    intro ? '' : false,
    intro || false,
  ]);

  return { subject, html, text };
}
