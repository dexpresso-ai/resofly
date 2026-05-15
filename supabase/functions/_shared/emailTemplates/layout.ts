export type EmailLayoutInput = {
  brandName: string;
  preheader?: string;
  title: string;
  eyebrow?: string;
  introHtml: string;
  bodyHtml?: string;
  cta?: { label: string; url: string };
  footerHtml?: string;
  accentColor?: string | null;
};

export function renderEmailLayout(input: EmailLayoutInput): string {
  const accentColor = sanitizeAccentColor(input.accentColor);
  const brandName = input.brandName || 'ResoFly';
  const escapedBrandName = escapeHtml(brandName);
  const preheader = input.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(input.preheader)}</div>` : '';
  const cta = input.cta
    ? `<p style="margin:28px 0 6px;"><a href="${escapeHtml(input.cta.url)}" style="display:inline-block;background:${accentColor};color:#111111;text-decoration:none;font-weight:700;padding:14px 20px;border-radius:14px;">${escapeHtml(input.cta.label)}</a></p>`
    : '';

  return `<!doctype html>
<html lang="nl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.title)}</title>
  </head>
  <body style="margin:0;background:#111111;font-family:Arial,Helvetica,sans-serif;color:#f5f5f5;">
    ${preheader}
    <div style="max-width:640px;margin:0 auto;padding:32px 20px;">
      <div style="background:#1b1b1f;border:1px solid #303038;border-radius:24px;padding:28px;">
        <p style="margin:0 0 8px;color:${accentColor};font-size:13px;text-transform:uppercase;letter-spacing:.08em;font-weight:700;">${escapeHtml(input.eyebrow || brandName)}</p>
        <h1 style="margin:0 0 16px;font-size:28px;line-height:1.15;color:#ffffff;">${escapeHtml(input.title)}</h1>
        <div style="margin:0;color:#d8d8df;font-size:16px;line-height:1.6;">${input.introHtml}</div>
        ${input.bodyHtml || ''}
        ${cta}
        ${input.footerHtml ? `<div style="margin-top:24px;color:#9b9ba7;font-size:13px;line-height:1.5;">${input.footerHtml}</div>` : ''}
      </div>
      <p style="margin:18px 4px 0;color:#747480;font-size:12px;line-height:1.5;">Verzonden via ${escapedBrandName}.</p>
    </div>
  </body>
</html>`;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char] || char));
}

export function sanitizeAccentColor(value?: string | null): string {
  const candidate = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(candidate) ? candidate : '#FFD966';
}

export function textLines(lines: Array<string | null | undefined | false>): string {
  return lines
    .filter((line): line is string => line !== null && line !== undefined && line !== false)
    .join('\n')
    .trimEnd();
}
