import { fieldOr, optionalFieldOr, renderContentHtml, renderContentText, type TemplateVars } from './content.ts';
import { escapeHtml, renderEmailLayout, textLines } from './layout.ts';
import type { ContractSignedClientEmailInput, RenderedEmailTemplate } from './types.ts';

// Bevestiging aan de klant nadat hij heeft getekend. Het getekende PDF wordt door
// de contract-public Edge Function als bijlage meegestuurd; deze template levert
// de begeleidende tekst. Per organisatie aanpasbaar via email_templates
// (sleutel 'contract.signed.client'); lege velden vallen terug op de standaard.
const DEFAULT_SUBJECT = 'Bevestiging: contract {{contract_number}} is ondertekend';
const DEFAULT_INTRO = 'Beste {{recipient_name}},\nBedankt — je contract is ondertekend. Een ondertekend exemplaar vind je als bijlage bij deze e-mail.';
const DEFAULT_CTA = 'Bekijk in je klantportaal';

export function renderContractSignedClientEmail(input: ContractSignedClientEmailInput): RenderedEmailTemplate {
  const companyName = input.company?.trade_name || input.company?.company_name || 'ResoFly';
  const recipientName = input.recipientName?.trim() || input.client.contact_name || input.client.name || 'relatie';
  const signedAt = formatDateTimeNl(input.signedAt);

  const vars: TemplateVars = {
    recipient_name: recipientName,
    company_name: companyName,
    contract_number: input.contract.number,
    contract_title: input.contract.title || '',
  };

  const subject = renderContentText(fieldOr(input.content, 'subject', DEFAULT_SUBJECT), vars).trim();
  const introHtml = renderContentHtml(fieldOr(input.content, 'intro', DEFAULT_INTRO), vars);
  const introText = renderContentText(fieldOr(input.content, 'intro', DEFAULT_INTRO), vars);
  const ctaLabel = renderContentText(fieldOr(input.content, 'ctaLabel', DEFAULT_CTA), vars).trim() || DEFAULT_CTA;
  const closing = optionalFieldOr(input.content, 'closing', null);
  const closingHtml = closing ? renderContentHtml(closing, vars) : null;
  const closingText = closing ? renderContentText(closing, vars) : null;

  return {
    templateKey: 'contract.signed.client',
    subject,
    html: renderEmailLayout({
      brandName: companyName,
      eyebrow: companyName,
      title: 'Je contract is ondertekend',
      preheader: 'Bedankt — je contract is ondertekend. Het getekende exemplaar zit in de bijlage.',
      accentColor: input.company?.invoice_accent_color,
      introHtml: `<p style="margin:0;">${introHtml}</p>`,
      bodyHtml: `<div style="background:#121215;border:1px solid #2a2a31;border-radius:18px;padding:18px;margin:18px 0;">
        <p style="margin:0;color:#b6b6c2;line-height:1.7;">
          ${input.contract.title ? `Onderwerp: <strong style="color:#ffffff;">${escapeHtml(input.contract.title)}</strong><br/>` : ''}
          Contractnummer: <strong style="color:#ffffff;">${escapeHtml(input.contract.number)}</strong><br/>
          Ondertekend op: ${escapeHtml(signedAt)}
        </p>
      </div>${closingHtml ? `<p style="margin:16px 0 0;color:#d8d8df;line-height:1.6;">${closingHtml}</p>` : ''}`,
      cta: input.portalUrl ? { label: ctaLabel, url: input.portalUrl } : undefined,
      footerHtml: 'Bewaar dit exemplaar goed. Heb je een vraag? Beantwoord gerust deze e-mail.',
    }),
    text: textLines([
      companyName,
      'Je contract is ondertekend',
      '',
      introText,
      '',
      input.contract.title ? `Onderwerp: ${input.contract.title}` : undefined,
      `Contractnummer: ${input.contract.number}`,
      `Ondertekend op: ${signedAt}`,
      closingText ? '' : undefined,
      closingText || undefined,
      input.portalUrl ? '' : undefined,
      input.portalUrl ? `Klantportaal: ${input.portalUrl}` : undefined,
    ]),
  };
}

function formatDateTimeNl(value: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('nl-NL', { dateStyle: 'long', timeStyle: 'short' });
}
