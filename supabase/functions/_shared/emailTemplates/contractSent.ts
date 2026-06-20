import { fieldOr, optionalFieldOr, renderContentHtml, renderContentText, type TemplateVars } from './content.ts';
import { escapeHtml, renderEmailLayout, textLines } from './layout.ts';
import type { ContractSentEmailInput, RenderedEmailTemplate } from './types.ts';

// Ingebouwde standaardteksten. Een organisatie kan deze per veld overschrijven via
// email_templates (sleutel 'contract.sent'); lege velden vallen hierop terug.
const DEFAULT_SUBJECT = 'Onderteken je contract {{contract_number}} van {{company_name}}';
const DEFAULT_INTRO = 'Beste {{recipient_name}},\nJe contract staat klaar om digitaal te ondertekenen. Bekijk het rustig door en zet je handtekening zodra je akkoord bent.';
const DEFAULT_CTA = 'Bekijk en onderteken contract';

export function renderContractSentEmail(input: ContractSentEmailInput): RenderedEmailTemplate {
  const companyName = input.company?.trade_name || input.company?.company_name || 'ResoFly';
  const recipientName = input.recipientName?.trim() || input.client.contact_name || input.client.name || 'relatie';
  const expiry = formatDateNl(input.expiresAt);
  const validUntil = input.contract.valid_until ? formatDateNl(input.contract.valid_until) : null;

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
  const personalMessage = input.personalMessage?.trim() || null;

  return {
    templateKey: 'contract.sent',
    subject,
    html: renderEmailLayout({
      brandName: companyName,
      eyebrow: companyName,
      title: `Contract ${input.contract.number} staat klaar`,
      preheader: 'Je contract staat klaar om digitaal te ondertekenen.',
      accentColor: input.company?.invoice_accent_color,
      introHtml: `<p style="margin:0;">${introHtml}</p>`,
      bodyHtml: renderContractSummary({
        title: input.contract.title || null,
        validUntil,
        personalMessageHtml: personalMessage ? escapeHtml(personalMessage).replace(/\r?\n/g, '<br/>') : null,
        closingHtml,
      }),
      cta: { label: ctaLabel, url: input.publicUrl },
      footerHtml: `Deze beveiligde link is geldig tot ${escapeHtml(expiry)}. Werkt de knop niet? Kopieer deze link: ${escapeHtml(input.publicUrl)}`,
    }),
    text: textLines([
      companyName,
      `Contract ${input.contract.number} staat klaar`,
      '',
      introText,
      '',
      input.contract.title ? `Onderwerp: ${input.contract.title}` : undefined,
      validUntil ? `Ondertekenen vóór: ${validUntil}` : undefined,
      personalMessage ? '' : undefined,
      personalMessage || undefined,
      closingText ? '' : undefined,
      closingText || undefined,
      '',
      input.publicUrl,
    ]),
  };
}

function renderContractSummary(input: {
  title: string | null;
  validUntil: string | null;
  personalMessageHtml: string | null;
  closingHtml: string | null;
}): string {
  const summary = `<div style="background:#121215;border:1px solid #2a2a31;border-radius:18px;padding:18px;margin:18px 0;">
    <p style="margin:0;color:#b6b6c2;line-height:1.7;">
      ${input.title ? `Onderwerp: <strong style="color:#ffffff;">${escapeHtml(input.title)}</strong><br/>` : ''}
      ${input.validUntil ? `Ondertekenen vóór: ${escapeHtml(input.validUntil)}` : 'Onderteken op een moment dat jou uitkomt.'}
    </p>
  </div>`;
  const personal = input.personalMessageHtml
    ? `<p style="margin:16px 0 0;color:#d8d8df;line-height:1.6;">${input.personalMessageHtml}</p>`
    : '';
  const closing = input.closingHtml
    ? `<p style="margin:16px 0 0;color:#d8d8df;line-height:1.6;">${input.closingHtml}</p>`
    : '';
  return `${summary}${personal}${closing}`;
}

function formatDateNl(value: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('nl-NL');
}
