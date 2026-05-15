import { escapeHtml, renderEmailLayout, textLines } from './layout.ts';
import type { RenderedEmailTemplate, TestResendEmailInput } from './types.ts';

export function renderResendTestEmail(input: TestResendEmailInput): RenderedEmailTemplate {
  const organizationName = input.organizationName || 'ResoFly';
  const recipientName = input.recipientName?.trim() || 'daar';
  const subject = `Resend testmail vanuit ${organizationName}`;

  return {
    templateKey: 'test.resend',
    subject,
    html: renderEmailLayout({
      brandName: organizationName,
      eyebrow: organizationName,
      title: 'Resend is gekoppeld 🚀',
      preheader: 'Je Resend-koppeling werkt server-side.',
      introHtml: `<p style="margin:0;">Hoi ${escapeHtml(recipientName)},<br/>Deze testmail is server-side verzonden vanuit je Supabase Edge Function. Je API-key staat dus niet in de browser.</p>`,
      footerHtml: 'Je kunt deze basis nu gebruiken voor offerte-mails, factuur-mails, uitnodigingen en notificaties.',
    }),
    text: textLines([
      organizationName,
      'Resend is gekoppeld',
      '',
      `Hoi ${recipientName},`,
      'Deze testmail is server-side verzonden vanuit je Supabase Edge Function. Je API-key staat dus niet in de browser.',
      'Je kunt deze basis nu gebruiken voor offerte-mails, factuur-mails, uitnodigingen en notificaties.',
    ]),
  };
}
