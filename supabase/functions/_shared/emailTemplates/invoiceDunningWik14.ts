import { fieldOr, renderContentHtml, renderContentText, type TemplateVars } from './content.ts';
import { escapeHtml, renderEmailLayout, textLines } from './layout.ts';
import type { InvoiceDunningWik14EmailInput, RenderedEmailTemplate } from './types.ts';

// Begeleidende e-mail bij de formele aanmaning. De juridisch strikte tekst
// (WIK-14-dagenbrief) zit in de bijgevoegde PDF; deze mail vat de bedragen samen en
// noemt bij consumenten de wettelijk vereiste kernzin. Bedragen komen in HELE CENTEN.
function formatEuroCents(cents: number): string {
  return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format((Number(cents) || 0) / 100);
}

function formatDateNl(value: string | null | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('nl-NL');
}

export function renderInvoiceDunningWik14Email(input: InvoiceDunningWik14EmailInput): RenderedEmailTemplate {
  const isConsumer = input.clientKind === 'consumer';
  const companyName = input.company?.trade_name || input.company?.company_name || 'ResoFly';
  const recipientName = input.recipientName?.trim() || input.client.contact_name || input.client.name || 'relatie';
  const a = input.amounts;

  const principal = formatEuroCents(a.principalCents);
  const interest = formatEuroCents(a.interestCents);
  const costs = formatEuroCents(a.collectionCostsCents);
  const costsVat = formatEuroCents(a.collectionCostsVatCents);
  const total = formatEuroCents(a.totalClaimCents);
  const hasVat = a.collectionCostsVatCents > 0;
  const costsLabel = hasVat ? `${costs} + ${costsVat} btw` : `${costs}`;

  // Consument: de incassokosten worden pas ná de 14-dagen-termijn verschuldigd, dus
  // "nu te voldoen" = hoofdsom + rente. Zakelijk: alles is direct opeisbaar.
  const dueNowCents = isConsumer ? a.principalCents + a.interestCents : a.totalClaimCents;
  const dueNow = formatEuroCents(dueNowCents);
  const deadline = formatDateNl(input.deadlineDate);
  const dueDate = input.invoice.due_date ? formatDateNl(input.invoice.due_date) : '-';
  const interestLabel = isConsumer ? 'wettelijke rente' : 'wettelijke handelsrente';

  const vars: TemplateVars = {
    recipient_name: recipientName,
    company_name: companyName,
    invoice_number: input.invoice.number,
    due_date: dueDate,
    deadline,
    principal_amount: principal,
    interest_amount: interest,
    collection_costs: costsLabel,
    total_amount: total,
    due_now_amount: dueNow,
  };

  const defaultSubject = `Aanmaning factuur ${input.invoice.number} — reageer vóór ${deadline}`;
  const defaultIntro = isConsumer
    ? `Ondanks eerdere berichten staat factuur ${input.invoice.number} nog open. Met deze aanmaning verzoeken wij u dringend het openstaande bedrag — de hoofdsom plus de tot op heden verschenen wettelijke rente — te voldoen. Betaalt u niet binnen veertien dagen vanaf de dag nadat deze brief bij u is bezorgd, dan bent u daarnaast een vergoeding voor incassokosten van ${costsLabel} verschuldigd en blijft de wettelijke rente oplopen.`
    : `Ondanks eerdere berichten staat factuur ${input.invoice.number} nog open. Uw onderneming is van rechtswege in verzuim. Met deze aanmaning sommeren wij u het volledige openstaande bedrag — inclusief wettelijke handelsrente en buitengerechtelijke incassokosten — binnen veertien dagen te voldoen.`;
  const defaultClosing = `De volledige aanmaning met de specificatie van de bedragen vindt u in de bijgevoegde brief (PDF). Heeft u inmiddels betaald? Dan kunt u dit bericht als niet verzonden beschouwen.`;
  const defaultCta = input.paymentUrl ? 'Nu betalen' : 'Factuur bekijken';

  const subject = renderContentText(fieldOr(input.content, 'subject', defaultSubject), vars).trim() || defaultSubject;
  const introHtml = renderContentHtml(fieldOr(input.content, 'intro', defaultIntro), vars);
  const introText = renderContentText(fieldOr(input.content, 'intro', defaultIntro), vars);
  const closing = renderContentText(fieldOr(input.content, 'closing', defaultClosing), vars);
  const closingHtml = renderContentHtml(fieldOr(input.content, 'closing', defaultClosing), vars);
  const ctaLabel = renderContentText(fieldOr(input.content, 'ctaLabel', defaultCta), vars).trim() || defaultCta;

  return {
    templateKey: 'invoice.dunning.wik14',
    subject,
    html: renderEmailLayout({
      brandName: companyName,
      eyebrow: 'Aanmaning',
      title: `Aanmaning factuur ${input.invoice.number}`,
      preheader: `Openstaand: ${dueNow}. Reageer vóór ${deadline}.`,
      accentColor: input.company?.invoice_accent_color,
      introHtml: `<p style="margin:0;">${introHtml}</p>`,
      bodyHtml: renderDunningSummary({ isConsumer, interestLabel, principal, interest, costsLabel, total, dueNow, deadline, closingHtml }),
      cta: { label: ctaLabel, url: input.paymentUrl || input.publicUrl },
      footerHtml: `De formele aanmaning zit als PDF in de bijlage. Werkt de knop niet? Kopieer deze link: ${escapeHtml(input.paymentUrl || input.publicUrl)}`,
    }),
    text: textLines([
      companyName,
      `Aanmaning factuur ${input.invoice.number}`,
      '',
      introText,
      '',
      `Hoofdsom: ${principal}`,
      `${interestLabel[0].toUpperCase()}${interestLabel.slice(1)}: ${interest}`,
      isConsumer ? `Incassokosten bij uitblijven betaling: ${costsLabel}` : `Incassokosten: ${costsLabel}`,
      isConsumer ? `Nu te voldoen (hoofdsom + rente): ${dueNow}` : `Totaal te voldoen: ${total}`,
      `Uiterste betaaldatum: ${deadline}`,
      '',
      closing || undefined,
      '',
      input.paymentUrl || input.publicUrl,
    ]),
  };
}

function renderDunningSummary(input: { isConsumer: boolean; interestLabel: string; principal: string; interest: string; costsLabel: string; total: string; dueNow: string; deadline: string; closingHtml: string }): string {
  return `<div style="background:#121215;border:1px solid #2a2a31;border-radius:18px;padding:18px;margin:18px 0;">
    <p style="margin:0;color:#b6b6c2;line-height:1.9;">
      Hoofdsom: <strong style="color:#ffffff;">${escapeHtml(input.principal)}</strong><br/>
      ${escapeHtml(input.interestLabel[0].toUpperCase() + input.interestLabel.slice(1))}: <strong style="color:#ffffff;">${escapeHtml(input.interest)}</strong><br/>
      Incassokosten${input.isConsumer ? ' (bij uitblijven betaling)' : ''}: <strong style="color:#ffffff;">${escapeHtml(input.costsLabel)}</strong><br/>
      ${input.isConsumer
        ? `Nu te voldoen: <strong style="color:#ffffff;">${escapeHtml(input.dueNow)}</strong>`
        : `Totaal te voldoen: <strong style="color:#ffffff;">${escapeHtml(input.total)}</strong>`}<br/>
      Uiterste datum: <span style="color:#e7a23d;">${escapeHtml(input.deadline)}</span>
    </p>
  </div>
  ${input.closingHtml ? `<p style="margin:16px 0 0;color:#d8d8df;line-height:1.6;">${input.closingHtml}</p>` : ''}`;
}
