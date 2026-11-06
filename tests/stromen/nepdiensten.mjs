// Nep-versies van wat de edge functions buiten Supabase aanroepen: Resend,
// Mollie en de media-worker (R2, Word → PDF). Alles wordt vastgelegd zodat een
// test kan nagaan wat er de deur uit ging (aan wie, met welke bijlage) en wat
// er bij Mollie gebeurde. Met `storing` kun je een dienst laten falen.
import { randomUUID } from 'node:crypto';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { API_URL, MEDIA } from './omgeving.mjs';

const echteFetch = globalThis.fetch.bind(globalThis);

export const post = {
  /** Elke mail die naar Resend ging: { to, subject, html, text, from, replyTo, bijlagen, tags } */
  mails: [],
  /** Faal de volgende n verzendingen met een 500 (of 'netwerk': gooi). */
  resendStoring: { aantal: 0, soort: '500' },
  /** R2: sleutel → bytes. */
  r2: new Map(),
  r2Storing: { aantal: 0 },
  /** Word-documenten in de media-opslag (body_storage_key → tekst). */
  media: new Map(),
  mollie: {
    teller: 0,
    betalingen: new Map(),
    /** Sleutels die Mollie weigert bij het valideren. */
    geweigerdeSleutels: new Set(),
    storing: { pad: null, soort: '500', aantal: 0 },
  },
  /** Alles wat naar buiten ging, voor diagnose. */
  log: [],
};

export function wisPost() {
  post.mails.length = 0;
  post.log.length = 0;
}

export function mailsAan(email) {
  const doel = String(email).toLowerCase();
  return post.mails.filter((mail) => mail.to.map((adres) => adres.toLowerCase()).includes(doel));
}

function json(status, data) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

async function nepPdf(tekst) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(tekst.slice(0, 80), { x: 48, y: 780, size: 12, font });
  return new Uint8Array(await doc.save());
}

async function resend(request) {
  if (post.resendStoring.aantal > 0) {
    post.resendStoring.aantal -= 1;
    if (post.resendStoring.soort === 'netwerk') throw new TypeError('fetch failed (nep-netwerkfout Resend)');
    return json(500, { message: 'Nep-storing bij Resend' });
  }
  const body = await request.json();
  // Uniek over processen heen, zoals bij Resend: de database bewaart de id's
  // (met een unieke index), ook van eerdere runs en van scenario's die tegelijk draaien.
  const id = `re_${randomUUID()}`;
  post.mails.push({
    id,
    to: Array.isArray(body.to) ? body.to : [body.to],
    from: body.from,
    replyTo: body.reply_to,
    subject: body.subject,
    html: body.html ?? '',
    text: body.text ?? '',
    bijlagen: (body.attachments ?? []).map((a) => ({
      naam: a.filename,
      bytes: a.content ? Buffer.from(a.content, 'base64') : Buffer.alloc(0),
      contentId: a.content_id ?? null,
    })),
    tags: body.tags ?? [],
    idempotencyKey: request.headers.get('idempotency-key'),
  });
  return json(200, { id });
}

function mollieSleutel(request) {
  return (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
}

function mollieBetalingJson(betaling, embed) {
  const data = {
    resource: 'payment', id: betaling.id, mode: betaling.mode, status: betaling.status,
    amount: betaling.amount, description: betaling.description, metadata: betaling.metadata,
    redirectUrl: betaling.redirectUrl, webhookUrl: betaling.webhookUrl,
    createdAt: betaling.createdAt, paidAt: betaling.paidAt ?? null, expiresAt: betaling.expiresAt ?? null,
    amountRefunded: betaling.amountRefunded, amountRemaining: betaling.amountRemaining,
    _links: { checkout: { href: `https://www.mollie.com/checkout/select-method/${betaling.id}` } },
  };
  if (embed.includes('refunds') || embed.includes('chargebacks')) {
    data._embedded = {
      refunds: embed.includes('refunds') ? betaling.refunds : undefined,
      chargebacks: embed.includes('chargebacks') ? betaling.chargebacks : undefined,
    };
  }
  return data;
}

async function mollie(request, url) {
  const st = post.mollie.storing;
  if (st.aantal > 0 && (!st.pad || st.pad.test(url.pathname))) {
    st.aantal -= 1;
    if (st.soort === 'netwerk') throw new TypeError('fetch failed (nep-netwerkfout Mollie)');
    return json(Number(st.soort) || 500, { status: Number(st.soort) || 500, title: 'Nep-storing', detail: 'Nep-storing bij Mollie' });
  }
  const sleutel = mollieSleutel(request);
  if (!/^(test|live)_/.test(sleutel) || post.mollie.geweigerdeSleutels.has(sleutel)) {
    return json(401, { status: 401, title: 'Unauthorized Request', detail: 'Missing authentication, or failed to authenticate' });
  }
  const pad = url.pathname;
  if (request.method === 'GET' && pad === '/v2/methods') return json(200, { count: 1, _embedded: { methods: [{ id: 'ideal' }] } });
  if (request.method === 'POST' && pad === '/v2/payments') {
    const body = await request.json();
    post.mollie.teller += 1;
    const id = `tr_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const betaling = {
      id, sleutel, mode: sleutel.startsWith('test_') ? 'test' : 'live', status: 'open',
      amount: body.amount, description: body.description, metadata: body.metadata ?? null,
      redirectUrl: body.redirectUrl, webhookUrl: body.webhookUrl, createdAt: new Date().toISOString(),
      expiresAt: body.expiresAt ?? null, refunds: [], chargebacks: [],
      amountRefunded: { currency: body.amount?.currency ?? 'EUR', value: '0.00' },
      amountRemaining: body.amount, idempotencyKey: request.headers.get('idempotency-key'),
    };
    post.mollie.betalingen.set(id, betaling);
    return json(201, mollieBetalingJson(betaling, ''));
  }
  const m = pad.match(/^\/v2\/payments\/([^/]+)(\/refunds)?$/);
  if (m) {
    const betaling = post.mollie.betalingen.get(decodeURIComponent(m[1]));
    // Een betaling bestaat alleen voor de sleutel waarmee hij is aangemaakt (per organisatie).
    if (!betaling || betaling.sleutel !== sleutel) return json(404, { status: 404, title: 'Not Found', detail: 'No payment exists with token' });
    if (!m[2] && request.method === 'GET') return json(200, mollieBetalingJson(betaling, url.searchParams.get('embed') || ''));
    if (m[2] && request.method === 'POST') {
      const body = await request.json();
      const refund = {
        resource: 'refund', id: `re_moll_${betaling.refunds.length + 1}_${betaling.id}`, status: 'pending',
        amount: body.amount, description: body.description ?? '', metadata: body.metadata ?? null,
        paymentId: betaling.id, createdAt: new Date().toISOString(),
      };
      betaling.refunds.push(refund);
      return json(201, refund);
    }
    if (m[2] && request.method === 'GET') return json(200, { count: betaling.refunds.length, _embedded: { refunds: betaling.refunds } });
  }
  return json(404, { status: 404, title: 'Not Found', detail: `Nep-Mollie kent ${request.method} ${pad} niet` });
}

async function media(request, url) {
  const pad = url.pathname;
  if (post.r2Storing.aantal > 0 && /snapshot/.test(pad)) {
    post.r2Storing.aantal -= 1;
    return json(503, { error: 'Nep-storing R2' });
  }
  if (request.method === 'POST' && /^\/internal\/[a-z]+-snapshot$/.test(pad)) {
    const sleutel = request.headers.get('x-storage-key');
    if (!sleutel) return json(400, { error: 'X-Storage-Key ontbreekt' });
    post.r2.set(sleutel, new Uint8Array(await request.arrayBuffer()));
    return json(200, { ok: true, key: sleutel });
  }
  const lees = pad.match(/^\/internal\/[a-z]+-snapshot\/(.+)$/) || pad.match(/^\/internal\/media\/(.+)$/);
  if (request.method === 'GET' && lees) {
    const sleutel = decodeURIComponent(lees[1]);
    const bytes = post.r2.get(sleutel) ?? (post.media.has(sleutel) ? new TextEncoder().encode(post.media.get(sleutel)) : null);
    if (!bytes) return json(404, { error: 'Niet gevonden' });
    return new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  }
  if (request.method === 'POST' && pad === '/internal/office/convert-pdf') {
    const body = await request.json();
    if (!post.media.has(body.storageKey)) return json(404, { error: 'Word-document niet gevonden' });
    return new Response(await nepPdf(`Word-contract ${post.media.get(body.storageKey)}`), { status: 200, headers: { 'content-type': 'application/pdf' } });
  }
  return json(404, { error: `Nep-media-worker kent ${request.method} ${pad} niet` });
}

/** Zet de nep-diensten aan. `functie(naam, request)` handelt aanroepen naar andere edge functions af. */
export function installeer({ functie }) {
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    const url = new URL(request.url);
    if (url.origin === 'https://api.resend.com') {
      post.log.push(`resend ${request.method} ${url.pathname}`);
      return resend(request);
    }
    if (url.origin === 'https://api.mollie.com') {
      post.log.push(`mollie ${request.method} ${url.pathname}${url.search}`);
      return mollie(request, url);
    }
    if (url.origin === new URL(MEDIA).origin) {
      post.log.push(`media ${request.method} ${url.pathname}`);
      return media(request, url);
    }
    const fn = url.href.startsWith(`${API_URL}/functions/v1/`) ? url.pathname.split('/')[3] : null;
    if (fn) {
      post.log.push(`functie ${fn}`);
      return functie(fn, request);
    }
    if (url.origin !== new URL(API_URL).origin) {
      post.log.push(`GEBLOKKEERD ${request.method} ${url.href}`);
      throw new TypeError(`tests/stromen: onverwachte uitgaande aanroep naar ${url.origin}`);
    }
    return echteFetch(input, init);
  };
}

/** Betaal een Mollie-betaling (zoals de klant in de checkout) en bel de webhook zoals Mollie dat doet. */
export async function mollieBetaal(id, { status = 'paid', webhook = true } = {}) {
  const betaling = post.mollie.betalingen.get(id);
  if (!betaling) throw new Error(`nep-Mollie: betaling ${id} bestaat niet`);
  betaling.status = status;
  if (status === 'paid') betaling.paidAt = new Date().toISOString();
  return webhook ? mollieWebhook(id) : null;
}

/** Rond een terugbetaling af bij Mollie en bel de webhook van de betaling. */
export async function mollieTerugbetalingKlaar(betalingId, { status = 'refunded' } = {}) {
  const betaling = post.mollie.betalingen.get(betalingId);
  if (!betaling) throw new Error(`nep-Mollie: betaling ${betalingId} bestaat niet`);
  for (const refund of betaling.refunds) refund.status = status;
  const totaal = betaling.refunds.filter((r) => r.status !== 'failed' && r.status !== 'canceled')
    .reduce((som, r) => som + Number(r.amount?.value ?? 0), 0);
  betaling.amountRefunded = { currency: betaling.amount.currency, value: totaal.toFixed(2) };
  return mollieWebhook(betalingId);
}

/** Mollie roept de webhook aan met alleen het id (application/x-www-form-urlencoded). */
export async function mollieWebhook(id, { url } = {}) {
  const betaling = post.mollie.betalingen.get(id);
  const doel = url ?? betaling?.webhookUrl;
  if (!doel) throw new Error(`nep-Mollie: geen webhook-URL voor ${id}`);
  return globalThis.fetch(doel, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `id=${encodeURIComponent(id)}`,
  });
}
