// Bevestigingsmail naar de klant na het boeken (meeting booking tool).
// De agenda-uitnodiging (.ics / provider-invite) gaat apart mee; dit is de
// begeleidende bevestiging met de gekozen tijden en de begeleidende tekst.
import { renderEmailLayout, escapeHtml, textLines } from './layout.ts';

export type MeetingBookingConfirmedEmailInput = {
  brandName: string;
  recipientName?: string | null;
  title: string;
  whenLines: string[];
  meetingUrl?: string | null;
  inviteMessage?: string | null;
  location?: string | null;
  accentColor?: string | null;
};

export function renderMeetingBookingConfirmedEmail(input: MeetingBookingConfirmedEmailInput): { subject: string; html: string; text: string } {
  const brandName = input.brandName || 'ResoFly';
  const greeting = input.recipientName ? `Beste ${input.recipientName},` : 'Beste,';
  const message = String(input.inviteMessage || '').trim();
  const subject = `Bevestigd: ${input.title}`;

  const whenHtml = input.whenLines.length
    ? `<ul style="margin:0 0 12px;padding-left:18px;">${input.whenLines.map(w => `<li style="margin:0 0 4px;">${escapeHtml(w)}</li>`).join('')}</ul>`
    : '';

  const introHtml = [
    `<p style="margin:0 0 12px;">${escapeHtml(greeting)}</p>`,
    `<p style="margin:0 0 12px;">Je afspraak is bevestigd. Je ontvangt hierbij ook een agenda-uitnodiging.</p>`,
    `<p style="margin:0 0 6px;font-weight:700;">Wanneer</p>`,
    whenHtml,
    input.location ? `<p style="margin:0 0 12px;"><strong>Locatie:</strong> ${escapeHtml(input.location)}</p>` : '',
    input.meetingUrl ? `<p style="margin:0 0 12px;"><strong>Videocall:</strong> <a href="${escapeHtml(input.meetingUrl)}" style="color:inherit;">${escapeHtml(input.meetingUrl)}</a></p>` : '',
    message ? `<p style="margin:12px 0 0;white-space:pre-wrap;">${escapeHtml(message)}</p>` : '',
  ].join('');

  const html = renderEmailLayout({
    brandName,
    eyebrow: brandName,
    preheader: `Bevestigd: ${input.title}`,
    title: 'Afspraak bevestigd',
    introHtml,
    cta: input.meetingUrl ? { label: 'Deelnemen aan videocall', url: input.meetingUrl } : undefined,
    accentColor: input.accentColor,
  });

  const text = textLines([
    greeting,
    '',
    'Je afspraak is bevestigd. Wanneer:',
    ...input.whenLines.map(w => `- ${w}`),
    input.location ? `Locatie: ${input.location}` : false,
    input.meetingUrl ? `Videocall: ${input.meetingUrl}` : false,
    message ? '' : false,
    message || false,
  ]);

  return { subject, html, text };
}
