import { fieldOr, optionalFieldOr, renderContentHtml, renderContentText, type TemplateVars } from './content.ts';
import { escapeHtml, renderEmailLayout, sanitizeAccentColor, textLines } from './layout.ts';
import type {
  FileTransferCodeEmailInput,
  FileTransferEmailInput,
  RenderedEmailTemplate,
} from './types.ts';
import { fileCountSentence, formatBytesNl, formatDateLongNl } from '../fileTransfer.ts';

// ============================================================
// Mails rond een zending (bestanden versturen).
//
//  - file.transfer      — "er staan bestanden voor je klaar". Per organisatie
//                         aan te passen onder Instellingen → E-mailteksten
//                         (sleutel 'file.transfer'); lege velden vallen terug
//                         op FILE_TRANSFER_DEFAULTS.
//  - file.transferCode  — de code om de bestanden te openen. Bewust NIET aan te
//                         passen: een beveiligingsmail hoort er altijd hetzelfde
//                         uit te zien, anders leert een ontvanger niet herkennen
//                         wat echt is.
//
// Nooit bestandsnamen in de mail: die kunnen zelf al gevoelig zijn
// ("Ontslag J. de Vries.pdf"). De ontvanger ziet ze pas na de code.
// ============================================================

export const FILE_TRANSFER_DEFAULTS = {
  subject: '{{transfer_subject}}',
  intro: 'Beste {{recipient_name}},\n{{sender_name}} heeft je {{file_count_sentence}} gestuurd via een beveiligde link.',
  closing: '',
  ctaLabel: 'Bestanden bekijken',
} as const;

/** De plaatshouders die de e-mailteksten-editor toont (src/lib/emailTemplateContent.ts spiegelt dit). */
export const FILE_TRANSFER_PLACEHOLDERS = [
  'recipient_name',
  'sender_name',
  'company_name',
  'transfer_subject',
  'file_count_sentence',
  'total_size',
  'valid_until',
  'client_name',
] as const;

export function renderFileTransferEmail(input: FileTransferEmailInput): RenderedEmailTemplate {
  const companyName = input.company?.trade_name || input.company?.company_name || 'ResoFly';
  const recipientName = input.recipientName?.trim() || 'relatie';
  const senderName = input.senderName?.trim() || companyName;
  const expiry = formatDateLongNl(input.expiresAt);
  const countSentence = fileCountSentence(input.fileCount);
  const totalSize = formatBytesNl(input.totalBytes);

  const vars: TemplateVars = {
    recipient_name: recipientName,
    sender_name: senderName,
    company_name: companyName,
    transfer_subject: input.subject,
    file_count_sentence: countSentence,
    total_size: totalSize,
    valid_until: expiry,
    client_name: input.clientName || '',
  };

  const subject = renderContentText(fieldOr(input.content, 'subject', FILE_TRANSFER_DEFAULTS.subject), vars)
    .replace(/\s+/g, ' ').trim() || input.subject;
  const introHtml = renderContentHtml(fieldOr(input.content, 'intro', FILE_TRANSFER_DEFAULTS.intro), vars);
  const introText = renderContentText(fieldOr(input.content, 'intro', FILE_TRANSFER_DEFAULTS.intro), vars);
  const ctaLabel = renderContentText(fieldOr(input.content, 'ctaLabel', FILE_TRANSFER_DEFAULTS.ctaLabel), vars).trim() || 'Bestanden bekijken';
  const closing = optionalFieldOr(input.content, 'closing', FILE_TRANSFER_DEFAULTS.closing || null);
  const closingHtml = closing ? renderContentHtml(closing, vars) : null;
  const closingText = closing ? renderContentText(closing, vars) : null;
  const personalNote = input.personalMessage?.trim() || null;

  const accessLine = input.portalUser
    ? 'Je opent ze met een code die we naar dit e-mailadres sturen, of via het klantportaal.'
    : 'Je opent ze met een code die we naar dit e-mailadres sturen.';

  return {
    templateKey: 'file.transfer',
    subject,
    html: renderEmailLayout({
      brandName: companyName,
      eyebrow: companyName,
      title: input.subject,
      preheader: `${senderName} stuurde je ${countSentence}.`,
      accentColor: input.company?.invoice_accent_color,
      introHtml: `<p style="margin:0;">${introHtml}</p>`,
      bodyHtml: renderSummary({
        countSentence,
        totalSize,
        expiry,
        personalNote,
        senderName,
        closingHtml,
      }),
      cta: { label: ctaLabel, url: input.url },
      footerHtml: [
        expiry ? `Beschikbaar tot ${escapeHtml(expiry)}; daarna worden de bestanden verwijderd.` : null,
        escapeHtml(accessLine),
        'Deze link is persoonlijk. Stuur hem niet door.',
        `Werkt de knop niet? Kopieer deze link: ${escapeHtml(input.url)}`,
      ].filter(Boolean).join('<br/>'),
    }),
    text: textLines([
      companyName,
      input.subject,
      '',
      introText,
      '',
      `${countSentence} (${totalSize})`,
      personalNote ? `Bericht van ${senderName}: ${personalNote}` : undefined,
      expiry ? `Beschikbaar tot: ${expiry}` : undefined,
      closingText ? '' : undefined,
      closingText || undefined,
      '',
      `${ctaLabel}: ${input.url}`,
      '',
      accessLine,
      'Deze link is persoonlijk. Stuur hem niet door.',
    ]),
  };
}

function renderSummary(input: {
  countSentence: string;
  totalSize: string;
  expiry: string;
  personalNote: string | null;
  senderName: string;
  closingHtml: string | null;
}): string {
  const rows = [
    `<strong style="color:#ffffff;">${escapeHtml(input.countSentence)}</strong> · ${escapeHtml(input.totalSize)}`,
    input.expiry ? `Beschikbaar tot ${escapeHtml(input.expiry)}` : null,
  ].filter(Boolean).join('<br/>');

  const note = input.personalNote
    ? `<div style="border-left:3px solid #FFD966;padding:2px 0 2px 14px;margin:18px 0 0;color:#d8d8df;line-height:1.6;"><span style="color:#9b9ba7;font-size:13px;">Bericht van ${escapeHtml(input.senderName)}</span><br/>${escapeHtml(input.personalNote).replace(/\r?\n/g, '<br/>')}</div>`
    : '';

  return `<div style="background:#121215;border:1px solid #2a2a31;border-radius:18px;padding:18px;margin:18px 0;">
    <p style="margin:0;color:#b6b6c2;line-height:1.7;">${rows}</p>
    ${note}
  </div>${input.closingHtml ? `<p style="margin:16px 0 0;color:#d8d8df;line-height:1.6;">${input.closingHtml}</p>` : ''}`;
}

/**
 * De code om de bestanden te openen. Geen aanpasbare tekst, geen code in het
 * onderwerp (dat staat op vergrendelschermen), en wél wat te doen als je hem
 * niet zelf aanvroeg.
 */
export function renderFileTransferCodeEmail(input: FileTransferCodeEmailInput): RenderedEmailTemplate {
  const companyName = input.companyName?.trim() || 'ResoFly';
  const minutes = Math.max(1, Math.round((input.validSeconds ?? 600) / 60));
  const spaced = `${input.code.slice(0, 3)} ${input.code.slice(3)}`;
  const accent = sanitizeAccentColor(input.accentColor);
  return {
    templateKey: 'file.transferCode',
    subject: `Je code om de bestanden van ${companyName} te openen`,
    html: renderEmailLayout({
      brandName: companyName,
      eyebrow: companyName,
      title: 'Je code',
      preheader: `Geldig voor ${minutes} minuten.`,
      accentColor: input.accentColor,
      introHtml: '<p style="margin:0;">Vul deze code in op de pagina met de bestanden.</p>',
      bodyHtml: `<div style="background:#121215;border:1px solid #2a2a31;border-radius:18px;padding:22px;margin:18px 0;text-align:center;">
        <p style="margin:0;font-size:34px;letter-spacing:.18em;font-weight:700;color:${accent};font-family:'Courier New',Courier,monospace;">${escapeHtml(spaced)}</p>
        <p style="margin:10px 0 0;color:#9b9ba7;font-size:13px;">Geldig voor ${minutes} minuten, en maar één keer te gebruiken.</p>
      </div>`,
      footerHtml: 'Heb je dit niet zelf aangevraagd? Dan hoef je niets te doen: zonder deze code komt niemand bij de bestanden.',
    }),
    text: textLines([
      companyName,
      'Je code om de bestanden te openen:',
      '',
      spaced,
      '',
      `Geldig voor ${minutes} minuten, en maar één keer te gebruiken.`,
      'Heb je dit niet zelf aangevraagd? Dan hoef je niets te doen: zonder deze code komt niemand bij de bestanden.',
    ]),
  };
}

/**
 * Het blok dat een mail uit het mailvenster (Berichten / klantdossier) krijgt
 * als er bestanden bij zitten. Die mail heeft de lichte opmaak van
 * buildClientEmailHtml in de mail-functie, dus dit blok ook.
 */
export function renderTransferBlockHtml(input: {
  url: string;
  fileCount: number;
  totalBytes: number;
  expiresAt: string;
  accentColor?: string | null;
}): string {
  const accent = sanitizeAccentColor(input.accentColor);
  const expiry = formatDateLongNl(input.expiresAt);
  const summary = `${fileCountSentence(input.fileCount)} · ${formatBytesNl(input.totalBytes)}${expiry ? ` · beschikbaar tot ${expiry}` : ''}`;
  return `<div style="margin:22px 0 0;border:1px solid #e4e4e7;border-radius:12px;padding:16px 18px;background:#fafafa;">
  <p style="margin:0 0 4px;font-weight:700;color:#1a1a1a;">Bijgevoegde bestanden</p>
  <p style="margin:0 0 12px;color:#52525b;font-size:14px;">${escapeHtml(summary)}</p>
  <p style="margin:0;"><a href="${escapeHtml(input.url)}" style="display:inline-block;background:${accent};color:#111111;text-decoration:none;font-weight:700;padding:10px 16px;border-radius:10px;">Bestanden bekijken</a></p>
  <p style="margin:12px 0 0;color:#71717a;font-size:12px;line-height:1.5;">Je opent ze met een code die we naar dit e-mailadres sturen. De link is persoonlijk; stuur hem niet door. Werkt de knop niet? ${escapeHtml(input.url)}</p>
</div>`;
}

export function renderTransferBlockText(input: { url: string; fileCount: number; totalBytes: number; expiresAt: string }): string {
  const expiry = formatDateLongNl(input.expiresAt);
  return textLines([
    '',
    `Bijgevoegde bestanden: ${fileCountSentence(input.fileCount)} (${formatBytesNl(input.totalBytes)})${expiry ? `, beschikbaar tot ${expiry}` : ''}`,
    `Bekijken: ${input.url}`,
    'Je opent ze met een code die we naar dit e-mailadres sturen. De link is persoonlijk; stuur hem niet door.',
  ]);
}
