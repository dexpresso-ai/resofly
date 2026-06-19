import PostalMime from 'postal-mime';

export interface Env {
  /** URL van de Supabase mail-inbound Edge Function. */
  MAIL_INBOUND_ENDPOINT: string;
  /** Gedeeld secret (wrangler secret put MAIL_INBOUND_SECRET). */
  MAIL_INBOUND_SECRET: string;
  /** Inbound-domein, bijv. inbound.resofly.nl (informatief/loggen). */
  INBOUND_DOMAIN: string;
}

// Cloudflare Email Worker: vangt antwoorden op reply+<id>@<inbound-domein> op,
// parseert de MIME en stuurt een schone JSON-payload naar de Supabase
// mail-inbound-functie. Die koppelt het antwoord aan de juiste klant/thread.
export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const to = message.to ?? '';
    const token = extractToken(to);

    let parsed: Awaited<ReturnType<PostalMime['parse']>>;
    try {
      const raw = await streamToUint8Array(message.raw, message.rawSize);
      parsed = await new PostalMime().parse(raw);
    } catch (error) {
      console.error('email-inbound: MIME parse mislukt', errMsg(error));
      throw error;
    }

    const payload = {
      token,
      to,
      from: message.from || parsed.from?.address || '',
      fromName: parsed.from?.name || '',
      subject: parsed.subject || message.headers.get('subject') || '',
      text: parsed.text || '',
      html: typeof parsed.html === 'string' ? parsed.html : '',
      messageId: parsed.messageId || message.headers.get('message-id') || '',
      inReplyTo: parsed.inReplyTo || message.headers.get('in-reply-to') || '',
      autoSubmitted: message.headers.get('auto-submitted') || '',
      receivedAt: new Date().toISOString(),
    };

    const response = await fetch(env.MAIL_INBOUND_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-inbound-secret': env.MAIL_INBOUND_SECRET,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      // Gooien zodat Cloudflare dit als (tijdelijke) fout registreert en de mail
      // niet stilletjes verdwijnt; in de Worker-logs is het terug te zien.
      throw new Error(`mail-inbound gaf ${response.status}: ${detail.slice(0, 200)}`);
    }
  },
};

function extractToken(to: string): string | null {
  const match = to.match(/reply\+([^@]+)@/i);
  return match ? match[1] : null;
}

async function streamToUint8Array(stream: ReadableStream<Uint8Array>, size: number): Promise<Uint8Array> {
  const result = new Uint8Array(size);
  let offset = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
