// Gedeelde Resend-verzendhelper voor de `campaigns` Edge Function.
//
// Bewust een aparte, stateless kopie van de send-helper uit `mail/index.ts`
// (die de API-key module-scoped inleest). Zo hoeft de bestaande, betaalkritische
// `mail`-functie NIET aangepast te worden om de campagne-verzending te bedienen —
// een kleine duplicatie weegt op tegen het deploy-risico van het aanraken van
// een werkende functie. Ondersteunt custom `headers` (List-Unsubscribe) via de
// payload.

export async function sendViaResend(
  apiKey: string,
  payload: Record<string, unknown>,
  idempotencyKey: string,
): Promise<Record<string, unknown>> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey.slice(0, 256),
    },
    body: JSON.stringify(payload),
  });

  const responsePayload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    console.error('Resend send failed', responsePayload);
    const providerMessage = String(
      responsePayload.message || responsePayload.error || response.statusText || 'Resend send failed',
    );
    throw new Error(`Resend kon de e-mail niet versturen: ${providerMessage}`);
  }

  return responsePayload;
}

export function resendEmailId(payload: Record<string, unknown>): string {
  return String(payload.id || payload.email_id || '').trim();
}

export function sanitizeTagValue(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256) || 'unknown';
}

export function sanitizeIdempotencyPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128) || 'unknown';
}

export function extractEmailAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return (match ? match[1] : value).trim();
}

export function extractDisplayName(value: string): string | null {
  const match = value.match(/^\s*"?([^"<]*?)"?\s*</);
  const name = match ? match[1].trim() : '';
  return name || null;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|h[1-6]|li|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
