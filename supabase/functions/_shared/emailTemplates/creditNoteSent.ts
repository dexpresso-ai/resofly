import { escapeHtml, renderEmailLayout, textLines } from './layout.ts';
import type { CreditNoteSentEmailInput, RenderedEmailTemplate } from './types.ts';

export function renderCreditNoteSentEmail(input: CreditNoteSentEmailInput): RenderedEmailTemplate {
  const companyName = input.company?.trade_name || input.company?.company_name || 'ResoFly';
  const recipientName = input.recipientName?.trim() || input.client.contact_name || input.client.name || 'relatie';
  const currency = input.creditNote.currency || 'EUR';
  const totalAmount = formatMoney(Number(input.creditNote.total_amount || 0), currency);
  const dateLabel = input.creditNote.date ? formatDateNl(input.creditNote.date) : '-';
  const subject = `Creditfactuur ${input.creditNote.number} van ${companyName}`;

  return {
    templateKey: 'creditNote.sent',
    subject,
    html: renderEmailLayout({
      brandName: companyName,
      eyebrow: companyName,
      title: `Creditfactuur ${input.creditNote.number}`,
      preheader: `Je creditfactuur voor terugbetaling op factuur ${input.invoice.number}.`,
      accentColor: input.company?.invoice_accent_color,
      introHtml: `<p style="margin:0;">Beste ${escapeHtml(recipientName)},<br/>In de bijlage vind je de creditfactuur die hoort bij een (gedeeltelijke) terugbetaling van factuur ${escapeHtml(input.invoice.number)}.</p>`,
      bodyHtml: renderCreditNoteSummary({
        invoiceNumber: input.invoice.number,
        totalAmount,
        dateLabel,
        reason: input.creditNote.reason || null,
      }),
      footerHtml: 'Heb je vragen over deze creditfactuur? Beantwoord dan gerust deze e-mail.',
    }),
    text: textLines([
      companyName,
      `Creditfactuur ${input.creditNote.number}`,
      '',
      `Beste ${recipientName},`,
      `In de bijlage vind je de creditfactuur bij factuur ${input.invoice.number}.`,
      `Creditbedrag: -${totalAmount}`,
      `Datum: ${dateLabel}`,
      input.creditNote.reason ? `Reden: ${input.creditNote.reason}` : undefined,
    ]),
  };
}

function renderCreditNoteSummary(input: { invoiceNumber: string; totalAmount: string; dateLabel: string; reason: string | null }): string {
  return `<div style="background:#121215;border:1px solid #2a2a31;border-radius:18px;padding:18px;margin:18px 0;">
    <p style="margin:0;color:#b6b6c2;line-height:1.7;">
      Oorspronkelijke factuur: ${escapeHtml(input.invoiceNumber)}<br/>
      Creditbedrag: <strong style="color:#ffffff;">-${escapeHtml(input.totalAmount)}</strong><br/>
      Datum: ${escapeHtml(input.dateLabel)}${input.reason ? `<br/>Reden: ${escapeHtml(input.reason)}` : ''}
    </p>
  </div>`;
}

function formatMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: currency || 'EUR' }).format(value || 0);
  } catch {
    return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(value || 0);
  }
}

function formatDateNl(value: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('nl-NL');
}
