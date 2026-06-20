import { escapeHtml, renderEmailLayout, textLines } from './layout.ts';
import type { ContractSignedInternalEmailInput, RenderedEmailTemplate } from './types.ts';

// Interne melding aan de organisatie wanneer een klant heeft getekend.
export function renderContractSignedInternalEmail(input: ContractSignedInternalEmailInput): RenderedEmailTemplate {
  const companyName = input.company?.trade_name || input.company?.company_name || 'ResoFly';
  const signedAt = formatDateTimeNl(input.signedAt);
  const signer = input.signerName?.trim() || input.client.name;

  const introHtml = `${escapeHtml(signer)} heeft contract <strong style="color:#ffffff;">${escapeHtml(input.contract.number)}</strong> ondertekend.`;

  return {
    templateKey: 'contract.signed.internal',
    subject: `Contract ${input.contract.number} is getekend door ${signer}`,
    html: renderEmailLayout({
      brandName: companyName,
      eyebrow: 'Contract ondertekend',
      title: `${input.contract.number} is getekend`,
      preheader: `${signer} heeft het contract ondertekend.`,
      accentColor: input.company?.invoice_accent_color,
      introHtml: `<p style="margin:0;">${introHtml}</p>`,
      bodyHtml: `<div style="background:#121215;border:1px solid #2a2a31;border-radius:18px;padding:18px;margin:18px 0;">
        <p style="margin:0;color:#b6b6c2;line-height:1.7;">
          Klant: <strong style="color:#ffffff;">${escapeHtml(input.client.name)}</strong><br/>
          ${input.contract.title ? `Onderwerp: ${escapeHtml(input.contract.title)}<br/>` : ''}
          Ondertekend door: ${escapeHtml(signer)}${input.signerEmail ? ` (${escapeHtml(input.signerEmail)})` : ''}<br/>
          Ondertekend op: ${escapeHtml(signedAt)}
        </p>
      </div>`,
      cta: input.appUrl ? { label: 'Open contract', url: input.appUrl } : undefined,
    }),
    text: textLines([
      companyName,
      `${input.contract.number} is getekend`,
      '',
      `${signer} heeft contract ${input.contract.number} ondertekend.`,
      '',
      `Klant: ${input.client.name}`,
      input.contract.title ? `Onderwerp: ${input.contract.title}` : undefined,
      `Ondertekend door: ${signer}${input.signerEmail ? ` (${input.signerEmail})` : ''}`,
      `Ondertekend op: ${signedAt}`,
      input.appUrl ? '' : undefined,
      input.appUrl || undefined,
    ]),
  };
}

function formatDateTimeNl(value: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('nl-NL', { dateStyle: 'long', timeStyle: 'short' });
}
