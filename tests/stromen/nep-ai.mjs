// Nep-ElevenLabs (Scribe, spraak naar tekst) en nep-Claude (de notulen) voor
// notulen.mjs. Er gaat niets de deur uit: elke aanvraag wordt vastgelegd,
// zodat de test kan nagaan wat er naar buiten ging (welke audio, welk
// transcript als context), en elk antwoord ziet eruit zoals bij de echte
// dienst. De webhook van Scribe wordt ondertekend zoals ElevenLabs dat doet
// (`t=<unix>,v0=<hmac>` over "<t>.<body>").
import { createHmac, randomUUID } from 'node:crypto';
import { roep } from './functies.mjs';
import { registreerDienst } from './nepdiensten.mjs';

export const ai = {
  /** Elke aanvraag bij Scribe: { apiKey, model, diarize, taal, webhook, bestand, type, grootte, bytes } */
  scribe: [],
  /** Elke aanvraag bij Claude: { apiKey, model, system, user } */
  claude: [],
  /** Elke vraag aan de poortwachter van Gerrie (_shared/gerrieGuard.ts): { model, bericht } */
  poortwachter: [],
  /** Het oordeel dat de poortwachter de volgende keer geeft; daarna weer TOEGESTAAN. */
  oordeel: null,
  /** request_id → het transcript dat de webhook nog moet bezorgen. */
  wachtrij: new Map(),
  /** Het transcript dat Scribe bij de volgende aanvraag teruggeeft. */
  woorden: null,
  /** Faal de volgende n aanvragen bij Scribe met deze HTTP-status. */
  scribeStoring: { aantal: 0, status: 500 },
  /** Bezorg de webhook al vóórdat het antwoord op de aanvraag terug is (de wedloop). */
  webhookMeteen: false,
  /** Wat de webhook-bezorging opleverde, voor de wedloop-test. */
  bezorgd: [],
};

/** Een gesprek van twee sprekers dat eindigt op `einde` seconden. */
export function gesprek(einde = 43.759) {
  return [
    { text: 'Goedemorgen,', type: 'word', start: 0.12, end: 0.8, speaker_id: 'speaker_0' },
    { text: ' ', type: 'spacing', start: 0.8, end: 0.85, speaker_id: 'speaker_0' },
    { text: 'we', type: 'word', start: 0.85, end: 1.0, speaker_id: 'speaker_0' },
    { text: ' ', type: 'spacing', start: 1.0, end: 1.05, speaker_id: 'speaker_0' },
    { text: 'bespreken', type: 'word', start: 1.05, end: 1.6, speaker_id: 'speaker_0' },
    { text: ' ', type: 'spacing', start: 1.6, end: 1.65, speaker_id: 'speaker_0' },
    { text: 'de', type: 'word', start: 1.65, end: 1.8, speaker_id: 'speaker_0' },
    { text: ' ', type: 'spacing', start: 1.8, end: 1.85, speaker_id: 'speaker_0' },
    { text: 'website.', type: 'word', start: 1.85, end: 2.6, speaker_id: 'speaker_0' },
    { text: 'Prima,', type: 'word', start: 3.1, end: 3.6, speaker_id: 'speaker_1' },
    { text: ' ', type: 'spacing', start: 3.6, end: 3.65, speaker_id: 'speaker_1' },
    { text: 'ik', type: 'word', start: 3.65, end: 3.8, speaker_id: 'speaker_1' },
    { text: ' ', type: 'spacing', start: 3.8, end: 3.85, speaker_id: 'speaker_1' },
    { text: 'stuur', type: 'word', start: 3.85, end: 4.2, speaker_id: 'speaker_1' },
    { text: ' ', type: 'spacing', start: 4.2, end: 4.25, speaker_id: 'speaker_1' },
    { text: 'vrijdag', type: 'word', start: 4.25, end: 4.8, speaker_id: 'speaker_1' },
    { text: ' ', type: 'spacing', start: 4.8, end: 4.85, speaker_id: 'speaker_1' },
    { text: 'de', type: 'word', start: 4.85, end: 5.0, speaker_id: 'speaker_1' },
    { text: ' ', type: 'spacing', start: 5.0, end: 5.05, speaker_id: 'speaker_1' },
    { text: 'teksten.', type: 'word', start: 5.05, end: einde, speaker_id: 'speaker_1' },
  ];
}

function transcriptVan(woorden) {
  return {
    language_code: 'nl', language_probability: 0.98,
    text: woorden.map((w) => w.text).join(''),
    words: woorden,
  };
}

function json(status, data) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

registreerDienst('https://api.elevenlabs.io', async (request, url) => {
  if (request.method !== 'POST' || url.pathname !== '/v1/speech-to-text') {
    return json(404, { detail: `Nep-ElevenLabs kent ${request.method} ${url.pathname} niet` });
  }
  const form = await request.formData();
  const bestand = form.get('file');
  const bytes = bestand ? new Uint8Array(await bestand.arrayBuffer()) : new Uint8Array(0);
  ai.scribe.push({
    apiKey: request.headers.get('xi-api-key'),
    model: form.get('model_id'), diarize: form.get('diarize'), taal: form.get('language_code'),
    korrel: form.get('timestamps_granularity'), webhook: form.get('webhook'),
    bestand: bestand?.name ?? null, type: bestand?.type ?? null, grootte: bytes.byteLength, bytes,
  });
  if (ai.scribeStoring.aantal > 0) {
    ai.scribeStoring.aantal -= 1;
    return json(ai.scribeStoring.status, { detail: { status: 'nep_storing', message: 'Nep-storing bij ElevenLabs' } });
  }
  const transcript = transcriptVan(ai.woorden ?? gesprek());
  if (form.get('webhook') === 'true') {
    const requestId = `req_${randomUUID().replace(/-/g, '')}`;
    ai.wachtrij.set(requestId, transcript);
    if (ai.webhookMeteen) {
      // Zoals een korte opname: ElevenLabs is klaar voordat de functie het
      // request_id heeft kunnen opslaan.
      setTimeout(() => { void scribeWebhook(requestId).then((res) => ai.bezorgd.push(res)); }, 0);
    }
    return json(200, { message: 'Request accepted', request_id: requestId, transcription_id: `tr_${requestId}` });
  }
  return json(200, { ...transcript, transcription_id: `tr_${randomUUID()}` });
});

/** De notulen zoals Claude ze als JSON teruggeeft (zie _shared/claudeSummary.ts). */
export const NOTULEN = {
  samenvatting: 'Kort overleg over de nieuwe website.',
  besproken: ['De teksten voor de website'],
  besluiten: ['De klant levert de teksten aan'],
  actiepunten: ['Spreker 2 stuurt vrijdag de teksten'],
  vervolgafspraken: [],
};

registreerDienst('https://api.anthropic.com', async (request, url) => {
  if (request.method !== 'POST' || url.pathname !== '/v1/messages') {
    return json(404, { type: 'error', error: { type: 'not_found_error', message: `Nep-Claude kent ${url.pathname} niet` } });
  }
  const body = await request.json();
  const user = (body.messages ?? []).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
  const poort = poortwachterAntwoord(body, user);
  if (poort) return poort;
  ai.claude.push({ apiKey: request.headers.get('x-api-key'), model: body.model, system: body.system, user });
  return json(200, {
    id: `msg_${randomUUID().replace(/-/g, '')}`, type: 'message', role: 'assistant', model: body.model,
    stop_reason: 'end_turn', stop_sequence: null,
    content: [{ type: 'text', text: JSON.stringify(NOTULEN) }],
    usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
});

/**
 * De poortwachter van Gerrie stelt zijn vraag niet-streamend, met een eigen
 * systeemprompt. Die krijgt een oordeel terug (standaard TOEGESTAAN, of wat een
 * scenario in `ai.oordeel` zette) en telt niet mee als vraag aan de notulen-AI.
 */
export function poortwachterAntwoord(body, user) {
  const system = typeof body.system === 'string' ? body.system : JSON.stringify(body.system ?? '');
  if (!system.startsWith('Je bent de poortwachter van Gerrie')) return null;
  const bericht = (/<bericht-[0-9a-f]+>\n([\s\S]*)\n<\/bericht-[0-9a-f]+>/.exec(user) ?? [])[1] ?? user;
  ai.poortwachter.push({ model: body.model, bericht });
  const oordeel = ai.oordeel ?? 'TOEGESTAAN';
  ai.oordeel = null;
  return json(200, {
    id: `msg_${randomUUID().replace(/-/g, '')}`, type: 'message', role: 'assistant', model: body.model,
    stop_reason: 'end_turn', stop_sequence: null,
    content: [{ type: 'text', text: oordeel }],
    usage: { input_tokens: 900, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
}

/** Ondertekent een webhook-body zoals ElevenLabs (header ElevenLabs-Signature). */
export function onderteken(body, geheim = process.env.ELEVENLABS_WEBHOOK_SECRET, tijd = Math.floor(Date.now() / 1000)) {
  const mac = createHmac('sha256', geheim).update(`${tijd}.${body}`).digest('hex');
  return `t=${tijd},v0=${mac}`;
}

/**
 * Bezorgt de webhook voor een request_id zoals ElevenLabs: het transcript
 * genest in data.transcription. Met `payload` stuur je iets anders (een fout),
 * met `handtekening` een eigen (ongeldige) handtekening.
 */
export async function scribeWebhook(requestId, { payload, handtekening } = {}) {
  const inhoud = payload ?? {
    type: 'speech_to_text_transcription',
    event_timestamp: Math.floor(Date.now() / 1000),
    data: { request_id: requestId, transcription: ai.wachtrij.get(requestId) },
  };
  const body = JSON.stringify(inhoud);
  return roep('meeting-transcribe-webhook', {
    body, ruw: true, origin: null,
    headers: { 'content-type': 'application/json', 'elevenlabs-signature': handtekening ?? onderteken(body) },
  });
}
