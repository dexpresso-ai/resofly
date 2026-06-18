import { fieldOr, renderContentHtml, renderContentText, type TemplateVars } from './content.ts';
import { escapeHtml, renderEmailLayout, textLines } from './layout.ts';
import type { InvoiceEmailLine, InvoiceReminderEmailInput, RenderedEmailTemplate } from './types.ts';

type ReminderCopy = {
  eyebrow: string;
  title: (number: string) => string;
  preheader: string;
  // Standaardteksten als plaatshouder-strings. Per niveau te overschrijven via
  // email_templates (sleutel 'invoice.reminder.1' / '.2' / '.3').
  defaultSubject: string;
  defaultIntro: string;
  defaultClosing: string;
  cta: (hasPayment: boolean) => string;
};

// Drie oplopende tonen. L1 vriendelijk, L2 steviger, L3 formele aanmaning.
const COPY: Record<1 | 2 | 3, ReminderCopy> = {
  1: {
    eyebrow: 'Betalingsherinnering',
    title: (number) => `Herinnering voor factuur ${number}`,
    preheader: 'Een vriendelijke herinnering dat deze factuur nog openstaat.',
    defaultSubject: 'Herinnering: factuur {{invoice_number}} staat nog open',
    defaultIntro:
      'Beste {{recipient_name}},\nWaarschijnlijk is het u ontschoten — onderstaande factuur is {{days_sentence}} en staat bij ons nog als onbetaald geregistreerd. Mogelijk heeft u de betaling al gedaan; in dat geval kunt u deze herinnering als niet verzonden beschouwen.',
    defaultClosing: 'Wilt u de betaling alsnog in orde maken? Alvast bedankt.',
    cta: (hasPayment) => (hasPayment ? 'Bekijk en betaal factuur' : 'Bekijk factuur'),
  },
  2: {
    eyebrow: 'Tweede herinnering',
    title: (number) => `Tweede herinnering voor factuur ${number}`,
    preheader: 'De vervaldatum van deze factuur is inmiddels ruim verstreken.',
    defaultSubject: 'Tweede herinnering: factuur {{invoice_number}} nog niet voldaan',
    defaultIntro:
      'Beste {{recipient_name}},\nOndanks onze eerdere herinnering hebben wij nog geen betaling van onderstaande factuur ontvangen. De vervaldatum is inmiddels {{days_sentence}}. Wij verzoeken u vriendelijk doch dringend het openstaande bedrag alsnog te voldoen.',
    defaultClosing: 'Heeft u vragen over deze factuur? Neem dan gerust contact met ons op.',
    cta: (hasPayment) => (hasPayment ? 'Betaal de factuur nu' : 'Bekijk factuur'),
  },
  3: {
    eyebrow: 'Aanmaning',
    title: (number) => `Aanmaning voor factuur ${number}`,
    preheader: 'Laatste betalingsherinnering voordat verdere stappen volgen.',
    defaultSubject: 'Aanmaning: laatste betalingsherinnering factuur {{invoice_number}}',
    defaultIntro:
      'Beste {{recipient_name}},\nDit is de laatste betalingsherinnering voor onderstaande factuur, die {{days_sentence}}. Wij verzoeken u het volledige openstaande bedrag binnen 7 dagen te voldoen. Blijft betaling uit, dan zijn wij genoodzaakt verdere (incasso)stappen te ondernemen.',
    defaultClosing: 'Heeft u inmiddels betaald? Dan zijn onze administraties elkaar gekruist en kunt u deze aanmaning als afgehandeld beschouwen.',
    cta: (hasPayment) => (hasPayment ? 'Betaal nu direct' : 'Bekijk factuur'),
  },
};

export function renderInvoiceReminderEmail(input: InvoiceReminderEmailInput): RenderedEmailTemplate {
  const level = (input.level === 2 ? 2 : input.level === 3 ? 3 : 1) as 1 | 2 | 3;
  const copy = COPY[level];
  const companyName = input.company?.trade_name || input.company?.company_name || 'ResoFly';
  const recipientName = input.recipientName?.trim() || input.client.contact_name || input.client.name || 'relatie';
  const totalAmount = formatEuro(calculateTotal(input.invoice.lines || []));
  const dueDate = input.invoice.due_date ? formatDateNl(input.invoice.due_date) : '-';
  const daysOverdue = resolveDaysOverdue(input);
  const hasPayment = Boolean(input.paymentUrl);
  const defaultCta = copy.cta(hasPayment);

  const vars: TemplateVars = {
    recipient_name: recipientName,
    company_name: companyName,
    invoice_number: input.invoice.number,
    total_amount: totalAmount,
    due_date: dueDate,
    days_overdue: daysOverdue !== null ? String(daysOverdue) : '',
    days_sentence: daysSentence(daysOverdue),
    project_name: input.project?.name || '',
  };

  const subject = renderContentText(fieldOr(input.content, 'subject', copy.defaultSubject), vars).trim();
  const introHtml = renderContentHtml(fieldOr(input.content, 'intro', copy.defaultIntro), vars);
  const introText = renderContentText(fieldOr(input.content, 'intro', copy.defaultIntro), vars);
  const closing = renderContentText(fieldOr(input.content, 'closing', copy.defaultClosing), vars);
  const closingHtml = renderContentHtml(fieldOr(input.content, 'closing', copy.defaultClosing), vars);
  const ctaLabel = renderContentText(fieldOr(input.content, 'ctaLabel', defaultCta), vars).trim() || defaultCta;

  return {
    templateKey: 'invoice.reminder',
    subject,
    html: renderEmailLayout({
      brandName: companyName,
      eyebrow: copy.eyebrow,
      title: copy.title(input.invoice.number),
      preheader: copy.preheader,
      accentColor: input.company?.invoice_accent_color,
      introHtml: `<p style="margin:0;">${introHtml}</p>`,
      bodyHtml: renderReminderSummary({
        projectName: input.project?.name || null,
        totalAmount,
        dueDate,
        daysOverdue,
        closingHtml,
      }),
      cta: { label: ctaLabel, url: input.paymentUrl || input.publicUrl },
      footerHtml: `In de bijlage vindt u de factuur als PDF. Werkt de knop niet? Kopieer deze link: ${escapeHtml(input.paymentUrl || input.publicUrl)}`,
    }),
    text: textLines([
      companyName,
      copy.title(input.invoice.number),
      '',
      introText,
      '',
      input.project?.name ? `Project: ${input.project.name}` : undefined,
      `Factuur: ${input.invoice.number}`,
      `Totaalbedrag: ${totalAmount}`,
      `Vervaldatum: ${dueDate}${daysOverdue !== null ? ` (${daysOverdue} dagen verstreken)` : ''}`,
      '',
      closing || undefined,
      '',
      input.paymentUrl || input.publicUrl,
    ]),
  };
}

function renderReminderSummary(input: { projectName: string | null; totalAmount: string; dueDate: string; daysOverdue: number | null; closingHtml: string }): string {
  return `<div style="background:#121215;border:1px solid #2a2a31;border-radius:18px;padding:18px;margin:18px 0;">
    <p style="margin:0;color:#b6b6c2;line-height:1.7;">
      ${input.projectName ? `Project: ${escapeHtml(input.projectName)}<br/>` : ''}
      Openstaand bedrag: <strong style="color:#ffffff;">${escapeHtml(input.totalAmount)}</strong><br/>
      Vervaldatum: ${escapeHtml(input.dueDate)}${input.daysOverdue !== null ? ` <span style="color:#e7a23d;">(${input.daysOverdue} dagen verstreken)</span>` : ''}
    </p>
  </div>
  ${input.closingHtml ? `<p style="margin:16px 0 0;color:#d8d8df;line-height:1.6;">${input.closingHtml}</p>` : ''}`;
}

// "X dagen over de vervaldatum" / "vandaag verlopen" als zinsdeel voor de intro.
function daysSentence(daysOverdue: number | null): string {
  if (daysOverdue === null) return 'inmiddels vervallen';
  if (daysOverdue <= 0) return 'vandaag vervallen';
  if (daysOverdue === 1) return '1 dag over de vervaldatum';
  return `${daysOverdue} dagen over de vervaldatum`;
}

function resolveDaysOverdue(input: InvoiceReminderEmailInput): number | null {
  if (typeof input.daysOverdue === 'number' && Number.isFinite(input.daysOverdue)) return Math.max(0, Math.round(input.daysOverdue));
  if (!input.invoice.due_date) return null;
  const due = new Date(input.invoice.due_date);
  if (Number.isNaN(due.getTime())) return null;
  const diffMs = Date.now() - due.getTime();
  return Math.max(0, Math.floor(diffMs / (24 * 60 * 60 * 1000)));
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
