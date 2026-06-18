import { fieldOr, optionalFieldOr, renderContentHtml, renderContentText, type TemplateVars } from './content.ts';
import { escapeHtml, renderEmailLayout, textLines } from './layout.ts';
import type { InvoiceEmailLine, InvoiceSentEmailInput, RenderedEmailTemplate } from './types.ts';

// Ingebouwde standaardteksten. Een organisatie kan deze per veld overschrijven via
// email_templates (sleutel 'invoice.sent'); lege velden vallen hierop terug.
const DEFAULT_SUBJECT = 'Factuur {{invoice_number}} van {{company_name}}';
const DEFAULT_INTRO = 'Beste {{recipient_name}},\nJe factuur staat klaar. In de bijlage vind je de PDF-snapshot.';
const DEFAULT_CTA_WITH_PAYMENT = 'Bekijk en betaal factuur';
const DEFAULT_CTA_WITHOUT_PAYMENT = 'Bekijk factuur';

export function renderInvoiceSentEmail(input: InvoiceSentEmailInput): RenderedEmailTemplate {
  const companyName = input.company?.trade_name || input.company?.company_name || 'ResoFly';
  const recipientName = input.recipientName?.trim() || input.client.contact_name || input.client.name || 'relatie';
  const totalAmount = formatEuro(calculateTotal(input.invoice.lines || []));
  const dueDate = input.invoice.due_date ? formatDateNl(input.invoice.due_date) : '-';
  const hasPayment = Boolean(input.paymentUrl);
  const defaultCta = hasPayment ? DEFAULT_CTA_WITH_PAYMENT : DEFAULT_CTA_WITHOUT_PAYMENT;

  const vars: TemplateVars = {
    recipient_name: recipientName,
    company_name: companyName,
    invoice_number: input.invoice.number,
    total_amount: totalAmount,
    due_date: dueDate,
    project_name: input.project?.name || '',
    quote_number: input.quote?.number || '',
  };

  const subject = renderContentText(fieldOr(input.content, 'subject', DEFAULT_SUBJECT), vars).trim();
  const introHtml = renderContentHtml(fieldOr(input.content, 'intro', DEFAULT_INTRO), vars);
  const introText = renderContentText(fieldOr(input.content, 'intro', DEFAULT_INTRO), vars);
  const ctaLabel = renderContentText(fieldOr(input.content, 'ctaLabel', defaultCta), vars).trim() || defaultCta;
  const closing = optionalFieldOr(input.content, 'closing', null);
  const closingHtml = closing ? renderContentHtml(closing, vars) : null;
  const closingText = closing ? renderContentText(closing, vars) : null;

  return {
    templateKey: 'invoice.sent',
    subject,
    html: renderEmailLayout({
      brandName: companyName,
      eyebrow: companyName,
      title: `Factuur ${input.invoice.number} staat klaar`,
      preheader: `Je factuur staat klaar om te bekijken${hasPayment ? ' en direct te betalen' : ''}.`,
      accentColor: input.company?.invoice_accent_color,
      introHtml: `<p style="margin:0;">${introHtml}</p>`,
      bodyHtml: renderInvoiceSummary({
        projectName: input.project?.name || null,
        quoteNumber: input.quote?.number || null,
        totalAmount,
        dueDate,
        closingHtml,
      }),
      cta: { label: ctaLabel, url: input.publicUrl },
      footerHtml: `Deze beveiligde link is geldig tot ${escapeHtml(formatDateNl(input.expiresAt))}. Werkt de knop niet? Kopieer deze link: ${escapeHtml(input.publicUrl)}`,
    }),
    text: textLines([
      companyName,
      `Factuur ${input.invoice.number} staat klaar`,
      '',
      introText,
      '',
      input.project?.name ? `Project: ${input.project.name}` : undefined,
      input.quote?.number ? `Gekoppelde offerte: ${input.quote.number}` : undefined,
      `Totaalbedrag: ${totalAmount}`,
      `Vervaldatum: ${dueDate}`,
      closingText ? '' : undefined,
      closingText || undefined,
      '',
      input.publicUrl,
    ]),
  };
}

function renderInvoiceSummary(input: { projectName: string | null; quoteNumber: string | null; totalAmount: string; dueDate: string; closingHtml: string | null }): string {
  return `<div style="background:#121215;border:1px solid #2a2a31;border-radius:18px;padding:18px;margin:18px 0;">
    <p style="margin:0;color:#b6b6c2;line-height:1.7;">
      ${input.projectName ? `Project: ${escapeHtml(input.projectName)}<br/>` : ''}
      ${input.quoteNumber ? `Offerte: ${escapeHtml(input.quoteNumber)}<br/>` : ''}
      Totaalbedrag: <strong style="color:#ffffff;">${escapeHtml(input.totalAmount)}</strong><br/>
      Vervaldatum: ${escapeHtml(input.dueDate)}
    </p>
  </div>${input.closingHtml ? `<p style="margin:16px 0 0;color:#d8d8df;line-height:1.6;">${input.closingHtml}</p>` : ''}`;
}

function calculateTotal(lines: InvoiceEmailLine[]): number {
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
