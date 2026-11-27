import { fieldOr, optionalFieldOr, renderContentHtml, renderContentText, type TemplateVars } from './content.ts';
import { accentOnDark, escapeHtml, renderEmailLayout, sanitizeAccentColor, textLines } from './layout.ts';
import type { FileAddedEmailInput, FileSharedEmailInput, RenderedEmailTemplate } from './types.ts';

// Ingebouwde standaardteksten. Een organisatie kan deze per veld overschrijven via
// email_templates (sleutel 'file.shared'); lege velden vallen hierop terug.
const DEFAULT_SUBJECT = '{{sender_name}} deelt “{{item_name}}” met je';
const DEFAULT_INTRO = 'Beste {{recipient_name}},\n{{sender_name}} heeft {{item_kind_lower}} “{{item_name}}” met je gedeeld.';
const DEFAULT_CTA = 'Bekijk {{item_kind_lower}}';

export function renderFileSharedEmail(input: FileSharedEmailInput): RenderedEmailTemplate {
  const companyName = input.company?.trade_name || input.company?.company_name || 'ResoFly';
  const recipientName = input.recipientName?.trim() || 'relatie';
  const senderName = input.senderName?.trim() || companyName;
  const itemKind = input.itemKindLabel || 'bestand';
  const expiry = input.expiresAt ? formatDateNl(input.expiresAt) : null;

  const vars: TemplateVars = {
    recipient_name: recipientName,
    sender_name: senderName,
    company_name: companyName,
    item_name: input.itemName,
    item_kind: itemKind,
    item_kind_lower: itemKind.toLowerCase(),
    client_name: input.clientName || '',
    valid_until: expiry || '',
  };

  const subject = renderContentText(fieldOr(input.content, 'subject', DEFAULT_SUBJECT), vars).trim();
  const introHtml = renderContentHtml(fieldOr(input.content, 'intro', DEFAULT_INTRO), vars);
  const introText = renderContentText(fieldOr(input.content, 'intro', DEFAULT_INTRO), vars);
  const ctaLabel = renderContentText(fieldOr(input.content, 'ctaLabel', DEFAULT_CTA), vars).trim() || 'Bekijken';
  const closing = optionalFieldOr(input.content, 'closing', null);
  const closingHtml = closing ? renderContentHtml(closing, vars) : null;
  const closingText = closing ? renderContentText(closing, vars) : null;

  // Het persoonlijke bericht van de afzender is vrije tekst uit de app: altijd
  // escapen, nooit als HTML doorgeven.
  const personalNote = input.personalMessage?.trim() || null;

  return {
    templateKey: 'file.shared',
    subject,
    html: renderEmailLayout({
      brandName: companyName,
      eyebrow: companyName,
      title: `${itemKind} “${input.itemName}” is met je gedeeld`,
      preheader: `${senderName} deelde ${itemKind.toLowerCase()} “${input.itemName}” met je.`,
      accentColor: input.company?.invoice_accent_color,
      introHtml: `<p style="margin:0;">${introHtml}</p>`,
      bodyHtml: renderShareSummary({
        accent: input.company?.invoice_accent_color ?? null,
        itemKind,
        itemName: input.itemName,
        clientName: input.clientName || null,
        expiry,
        personalNote,
        closingHtml,
      }),
      cta: { label: ctaLabel, url: input.url },
      footerHtml: [
        expiry ? `Deze toegang loopt af op ${escapeHtml(expiry)}.` : null,
        input.accessHint ? escapeHtml(input.accessHint) : null,
        `Werkt de knop niet? Kopieer deze link: ${escapeHtml(input.url)}`,
      ].filter(Boolean).join('<br/>'),
    }),
    text: textLines([
      companyName,
      `${itemKind} “${input.itemName}” is met je gedeeld`,
      '',
      introText,
      '',
      input.clientName ? `Dossier: ${input.clientName}` : undefined,
      personalNote ? `Bericht van ${senderName}: ${personalNote}` : undefined,
      expiry ? `Toegang tot: ${expiry}` : undefined,
      closingText ? '' : undefined,
      closingText || undefined,
      '',
      input.url,
    ]),
  };
}

function renderShareSummary(input: {
  accent: string | null;
  itemKind: string;
  itemName: string;
  clientName: string | null;
  expiry: string | null;
  personalNote: string | null;
  closingHtml: string | null;
}): string {
  const rows = [
    `${escapeHtml(input.itemKind)}: <strong style="color:#ffffff;">${escapeHtml(input.itemName)}</strong>`,
    input.clientName ? `Dossier: ${escapeHtml(input.clientName)}` : null,
    input.expiry ? `Toegang tot: ${escapeHtml(input.expiry)}` : null,
  ].filter(Boolean).join('<br/>');

  const note = input.personalNote
    // De streep in de merkkleur van de afzender; dit stond vast op ResoFly-goud.
    ? `<div style="border-left:3px solid ${accentOnDark(sanitizeAccentColor(input.accent), '#121215')};padding:2px 0 2px 14px;margin:18px 0 0;color:#d8d8df;line-height:1.6;">${escapeHtml(input.personalNote).replace(/\r?\n/g, '<br/>')}</div>`
    : '';

  return `<div style="background:#121215;border:1px solid #2a2a31;border-radius:18px;padding:18px;margin:18px 0;">
    <p style="margin:0;color:#b6b6c2;line-height:1.7;">${rows}</p>
    ${note}
  </div>${input.closingHtml ? `<p style="margin:16px 0 0;color:#d8d8df;line-height:1.6;">${input.closingHtml}</p>` : ''}`;
}

function formatDateNl(value: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('nl-NL');
}

// ── Nieuw in een gedeelde map (20261127120000) ──────────────────────────────
// Een gedeelde map vult zich niet meer vanzelf. Wat iemand er met "Ook delen"
// bij zet, meldt deze mail, tenzij de afzender de melding uitzet. Een
// organisatie kan de teksten per veld overschrijven (sleutel 'file.added');
// src/lib/emailTemplateContent.ts toont dezelfde standaardtekst in de editor,
// en emailTemplateContent.test.ts houdt de twee gelijk.

export const FILE_ADDED_DEFAULTS = {
  subject: 'Nieuw in “{{item_name}}”',
  intro: 'Beste {{recipient_name}},\n{{sender_name}} heeft {{added_sentence}} toegevoegd aan “{{item_name}}”.',
  closing: '',
  ctaLabel: 'Bekijk de map',
} as const;

export const FILE_ADDED_PLACEHOLDERS = ['recipient_name', 'sender_name', 'company_name', 'item_name', 'added_sentence', 'client_name'] as const;

/** Hoeveel namen de mail opsomt; de rest wordt "en nog 3". */
const ADDED_LIST_MAX = 10;

export function renderFileAddedEmail(input: FileAddedEmailInput): RenderedEmailTemplate {
  const companyName = input.company?.trade_name || input.company?.company_name || 'ResoFly';
  const recipientName = input.recipientName?.trim() || 'relatie';
  const senderName = input.senderName?.trim() || companyName;
  const vars: TemplateVars = {
    recipient_name: recipientName,
    sender_name: senderName,
    company_name: companyName,
    item_name: input.folderName,
    added_sentence: input.addedSentence,
    client_name: input.clientName || '',
  };

  const subject = renderContentText(fieldOr(input.content, 'subject', FILE_ADDED_DEFAULTS.subject), vars).trim();
  const introHtml = renderContentHtml(fieldOr(input.content, 'intro', FILE_ADDED_DEFAULTS.intro), vars);
  const introText = renderContentText(fieldOr(input.content, 'intro', FILE_ADDED_DEFAULTS.intro), vars);
  const ctaLabel = renderContentText(fieldOr(input.content, 'ctaLabel', FILE_ADDED_DEFAULTS.ctaLabel), vars).trim() || 'Bekijken';
  const closing = optionalFieldOr(input.content, 'closing', null);
  const closingHtml = closing ? renderContentHtml(closing, vars) : null;
  const closingText = closing ? renderContentText(closing, vars) : null;

  // Namen komen uit de drive: altijd escapen.
  const shown = input.addedNames.slice(0, ADDED_LIST_MAX);
  const rest = input.addedNames.length - shown.length;
  const listHtml = shown.map((name) => `<li style="margin:2px 0;">${escapeHtml(name)}</li>`).join('')
    + (rest > 0 ? `<li style="margin:2px 0;color:#8f8f9b;">en nog ${rest}</li>` : '');

  return {
    templateKey: 'file.added',
    subject,
    html: renderEmailLayout({
      brandName: companyName,
      eyebrow: companyName,
      title: `Nieuw in “${input.folderName}”`,
      preheader: `${senderName} heeft ${input.addedSentence} toegevoegd aan “${input.folderName}”.`,
      accentColor: input.company?.invoice_accent_color,
      introHtml: `<p style="margin:0;">${introHtml}</p>`,
      bodyHtml: `<div style="background:#121215;border:1px solid #2a2a31;border-radius:18px;padding:18px;margin:18px 0;">
    <p style="margin:0 0 6px;color:#b6b6c2;line-height:1.7;">Nieuw in <strong style="color:#ffffff;">${escapeHtml(input.folderName)}</strong>${input.clientName ? ` · dossier ${escapeHtml(input.clientName)}` : ''}:</p>
    <ul style="margin:0;padding-left:20px;color:#d8d8df;line-height:1.6;">${listHtml}</ul>
  </div>${closingHtml ? `<p style="margin:16px 0 0;color:#d8d8df;line-height:1.6;">${closingHtml}</p>` : ''}`,
      cta: { label: ctaLabel, url: input.url },
      footerHtml: [
        input.accessHint ? escapeHtml(input.accessHint) : null,
        `Werkt de knop niet? Kopieer deze link: ${escapeHtml(input.url)}`,
      ].filter(Boolean).join('<br/>'),
    }),
    text: textLines([
      companyName,
      `Nieuw in “${input.folderName}”`,
      '',
      introText,
      '',
      ...shown.map((name) => `- ${name}`),
      rest > 0 ? `- en nog ${rest}` : undefined,
      closingText ? '' : undefined,
      closingText || undefined,
      '',
      input.url,
    ]),
  };
}
