import { escapeHtml, renderEmailLayout, textLines } from './layout.ts';
import type { InvoiceEmailLine, InvoiceSentEmailInput, RenderedEmailTemplate } from './types.ts';

export function renderInvoiceSentEmail(input: InvoiceSentEmailInput): RenderedEmailTemplate {
  const companyName = input.company?.trade_name || input.company?.company_name || 'ResoFly';
  const recipientName = input.recipientName?.trim() || input.client.contact_name || input.client.name || 'relatie';
  const totalAmount = formatEuro(calculateTotal(input.invoice.lines || []));
  const dueDate = input.invoice.due_date ? formatDateNl(input.invoice.due_date) : '-';
  const subject = `Factuur ${input.invoice.number} van ${companyName}`;

  return {
    templateKey: 'invoice.sent',
    subject,
    html: renderEmailLayout({
      brandName: companyName,
      eyebrow: companyName,
      title: `Factuur ${input.invoice.number} staat klaar`,
      preheader: `Je factuur staat klaar om te bekijken${input.paymentUrl ? ' en direct te betalen' : ''}.`,
      accentColor: input.company?.invoice_accent_color,
      introHtml: `<p style="margin:0;">Beste ${escapeHtml(recipientName)},<br/>Je factuur staat klaar. In de bijlage vind je de PDF-snapshot.</p>`,
      bodyHtml: renderInvoiceSummary({
        projectName: input.project?.name || null,
        quoteNumber: input.quote?.number || null,
        totalAmount,
        dueDate,
      }),
      cta: { label: input.paymentUrl ? 'Bekijk en betaal factuur' : 'Bekijk factuur', url: input.publicUrl },
      footerHtml: `Deze beveiligde link is geldig tot ${escapeHtml(formatDateNl(input.expiresAt))}. Werkt de knop niet? Kopieer deze link: ${escapeHtml(input.publicUrl)}`,
    }),
    text: textLines([
      companyName,
      `Factuur ${input.invoice.number} staat klaar`,
      '',
      `Beste ${recipientName},`,
      'Je factuur staat klaar. In de bijlage vind je de PDF-snapshot.',
      input.project?.name ? `Project: ${input.project.name}` : undefined,
      input.quote?.number ? `Gekoppelde offerte: ${input.quote.number}` : undefined,
      `Totaalbedrag: ${totalAmount}`,
      `Vervaldatum: ${dueDate}`,
      '',
      input.publicUrl,
    ]),
  };
}

function renderInvoiceSummary(input: { projectName: string | null; quoteNumber: string | null; totalAmount: string; dueDate: string }): string {
  return `<div style="background:#121215;border:1px solid #2a2a31;border-radius:18px;padding:18px;margin:18px 0;">
    <p style="margin:0;color:#b6b6c2;line-height:1.7;">
      ${input.projectName ? `Project: ${escapeHtml(input.projectName)}<br/>` : ''}
      ${input.quoteNumber ? `Offerte: ${escapeHtml(input.quoteNumber)}<br/>` : ''}
      Totaalbedrag: <strong style="color:#ffffff;">${escapeHtml(input.totalAmount)}</strong><br/>
      Vervaldatum: ${escapeHtml(input.dueDate)}
    </p>
  </div>`;
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
