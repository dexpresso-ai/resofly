import { fieldOr, optionalFieldOr, renderContentHtml, renderContentText, type TemplateVars } from './content.ts';
import { escapeHtml, renderEmailLayout, textLines } from './layout.ts';
import type { QuoteEmailLine, QuoteSentEmailInput, RenderedEmailTemplate } from './types.ts';

// Ingebouwde standaardteksten. Een organisatie kan deze per veld overschrijven via
// email_templates (sleutel 'quote.sent'); lege velden vallen hierop terug.
const DEFAULT_SUBJECT = 'Offerte {{quote_number}} van {{company_name}}';
const DEFAULT_INTRO = 'Beste {{recipient_name}},\nJe offerte staat klaar om te bekijken en digitaal goed te keuren.';
const DEFAULT_CTA = 'Bekijk en keur offerte goed';

export function renderQuoteSentEmail(input: QuoteSentEmailInput): RenderedEmailTemplate {
  const companyName = input.company?.trade_name || input.company?.company_name || 'BrandCore';
  const recipientName = input.recipientName?.trim() || input.client.contact_name || input.client.name || 'relatie';
  const expiry = formatDateNl(input.expiresAt);
  const quoteValidUntil = input.quote.valid_until ? formatDateNl(input.quote.valid_until) : expiry;
  const totalAmount = formatEuro(calculateTotal(input.quote.lines || []));

  const vars: TemplateVars = {
    recipient_name: recipientName,
    company_name: companyName,
    quote_number: input.quote.number,
    total_amount: totalAmount,
    valid_until: quoteValidUntil,
    project_name: input.project?.name || '',
  };

  const subject = renderContentText(fieldOr(input.content, 'subject', DEFAULT_SUBJECT), vars).trim();
  const introHtml = renderContentHtml(fieldOr(input.content, 'intro', DEFAULT_INTRO), vars);
  const introText = renderContentText(fieldOr(input.content, 'intro', DEFAULT_INTRO), vars);
  const ctaLabel = renderContentText(fieldOr(input.content, 'ctaLabel', DEFAULT_CTA), vars).trim() || DEFAULT_CTA;
  const closing = optionalFieldOr(input.content, 'closing', null);
  const closingHtml = closing ? renderContentHtml(closing, vars) : null;
  const closingText = closing ? renderContentText(closing, vars) : null;

  return {
    templateKey: 'quote.sent',
    subject,
    html: renderEmailLayout({
      brandName: companyName,
      eyebrow: companyName,
      title: `Offerte ${input.quote.number} staat klaar`,
      preheader: `Je offerte staat klaar om te bekijken en digitaal goed te keuren.`,
      accentColor: input.company?.invoice_accent_color,
      introHtml: `<p style="margin:0;">${introHtml}</p>`,
      bodyHtml: renderQuoteSummary({
        projectName: input.project?.name || null,
        totalAmount,
        validUntil: quoteValidUntil,
        closingHtml,
      }),
      cta: { label: ctaLabel, url: input.publicUrl },
      footerHtml: `Deze beveiligde link is geldig tot ${escapeHtml(expiry)}. Werkt de knop niet? Kopieer deze link: ${escapeHtml(input.publicUrl)}`,
    }),
    text: textLines([
      companyName,
      `Offerte ${input.quote.number} staat klaar`,
      '',
      introText,
      '',
      input.project?.name ? `Project: ${input.project.name}` : undefined,
      `Totaalbedrag: ${totalAmount}`,
      `Geldig tot: ${quoteValidUntil}`,
      closingText ? '' : undefined,
      closingText || undefined,
      '',
      input.publicUrl,
    ]),
  };
}

function renderQuoteSummary(input: { projectName: string | null; totalAmount: string; validUntil: string; closingHtml: string | null }): string {
  return `<div style="background:#121215;border:1px solid #2a2a31;border-radius:18px;padding:18px;margin:18px 0;">
    <p style="margin:0;color:#b6b6c2;line-height:1.7;">
      ${input.projectName ? `Project: ${escapeHtml(input.projectName)}<br/>` : ''}
      Totaalbedrag: <strong style="color:#ffffff;">${escapeHtml(input.totalAmount)}</strong><br/>
      Geldig tot: ${escapeHtml(input.validUntil)}
    </p>
  </div>${input.closingHtml ? `<p style="margin:16px 0 0;color:#d8d8df;line-height:1.6;">${input.closingHtml}</p>` : ''}`;
}

function calculateTotal(lines: QuoteEmailLine[]): number {
  return lines.reduce((sum, line) => {
    const subtotal = Number(line.quantity || 0) * Number(line.unit_price || 0);
    const vat = subtotal * (Number(line.vat || 0) / 100);
    return sum + subtotal + vat;
  }, 0);
}

function formatEuro(value: number): string {
  return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(value || 0);
}

function formatDateNl(value: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('nl-NL');
}
