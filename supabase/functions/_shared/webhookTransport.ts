// ============================================================
// Een webhook versturen over een verbinding die VASTLIGT op een gecontroleerd
// IP-adres.
//
// Waarom niet gewoon fetch(): fetch zoekt de naam zelf nog eens op. Een naam
// waarvan de DNS-server om en om antwoordt (DNS-rebinding: bij onze controle een
// openbaar adres, bij het versturen 127.0.0.1), glipt dan langs de controle en
// het bericht — met het antwoord in het bezorglog — gaat naar binnen. Hier
// zoeken we de naam één keer op, keuren de adressen, en verbinden met precies
// zo'n goedgekeurd adres. TLS controleert het certificaat nog steeds tegen de
// naam (SNI), dus wie het adres niet echt bezit, komt niet door de handshake.
//
// Het HTTP-deel is bewust klein: één POST (of een GET, voor een agenda-link:
// pinnedGet.ts), `Connection: close`, en van het antwoord de status, de koppen
// en hooguit maxBodyBytes van de inhoud. Zo kan een eindpunt ons ook niet met
// een eindeloos antwoord vol laten lopen. De leesfuncties zijn puur en los
// getest (webhookTransport.test.ts).
// ============================================================

export interface PinnedRequest {
  url: URL;
  /** Het gecontroleerde IP-adres waarmee verbonden wordt. */
  address: string;
  /** Standaard POST (een webhook); GET haalt iets op, zonder inhoud. */
  method?: 'GET' | 'POST';
  headers: Record<string, string>;
  body: string;
  /** Hoe lang het geheel mag duren: verbinden, versturen en het antwoord lezen. */
  timeoutMs: number;
  /** Zoveel bytes van de inhoud van het antwoord lezen we hooguit. */
  maxBodyBytes: number;
}

export interface PinnedResponse {
  status: number;
  /** Het begin van de inhoud, hooguit maxBodyBytes. */
  body: Uint8Array;
  /** De koppen, met namen in kleine letters. Een omleiding volgt deze verbinding nooit; dat beslist de aanroeper. */
  headers?: Map<string, string>;
}

/** Hoe een bericht de deur uit gaat. In productie pinnedTransport; in tests een nabootsing. */
export type WebhookTransport = (request: PinnedRequest) => Promise<PinnedResponse>;

/** Een fout bij het versturen. `connect`: er kwam geen verbinding, een ander adres kan wel lukken. */
export class TransportError extends Error {
  kind: 'connect' | 'timeout' | 'protocol';
  constructor(message: string, kind: 'connect' | 'timeout' | 'protocol' = 'protocol') {
    super(message);
    this.name = 'TransportError';
    this.kind = kind;
  }
}

/** Groter dan dit is geen kop van een antwoord meer. */
const MAX_HEAD_BYTES = 32 * 1024;
/**
 * Zoveel 1xx-tussenantwoorden (100 Continue, 103 Early Hints) slaan we over;
 * daarna is het geen antwoord meer maar een eindpunt dat ons bezighoudt.
 */
const MAX_INTERIM_RESPONSES = 5;

const CRLF = new Uint8Array([13, 10]);
const CRLFCRLF = new Uint8Array([13, 10, 13, 10]);

// ── Het verzoek ──────────────────────────────────────────────────────────────

/**
 * De kop van het verzoek. Geen header-waarde met een regeleinde: alles komt van
 * ons, maar een regeleinde zou er een tweede verzoek van kunnen maken.
 */
export function buildRequestHead(url: URL, headers: Record<string, string>, bodyBytes: number, method: 'GET' | 'POST' = 'POST'): string {
  const lines = [
    `${method} ${url.pathname || '/'}${url.search} HTTP/1.1`,
    `Host: ${url.host}`,
  ];
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9-]+$/.test(name) || /[\r\n\u0000]/.test(String(value))) {
      throw new TransportError(`Ongeldige header: ${name}`);
    }
    if (/^(host|content-length|connection|transfer-encoding)$/i.test(name)) continue;
    lines.push(`${name}: ${value}`);
  }
  if (method === 'POST' || bodyBytes > 0) lines.push(`Content-Length: ${bodyBytes}`);
  lines.push('Accept-Encoding: identity', 'Connection: close');
  return `${lines.join('\r\n')}\r\n\r\n`;
}

// ── Het antwoord ─────────────────────────────────────────────────────────────

/**
 * Leest een HTTP/1.1-antwoord uit een bron van brokken (`next` geeft null aan
 * het eind). Slaat hooguit MAX_INTERIM_RESPONSES 1xx-tussenantwoorden over, en
 * leest van de inhoud nooit meer dan `maxBody` bytes — ook niet bij chunked of
 * zonder Content-Length.
 *
 * De buffer groeit door te verdubbelen en wordt van voren af gelezen: een
 * eindpunt dat byte voor byte antwoordt, kost zo geen kopie van alles wat er al
 * lag bij elke byte, en het zoeken naar het eind van de kop begint waar het
 * vorige keer ophield.
 */
export async function readHttpResponse(
  next: () => Promise<Uint8Array | null>, maxBody: number,
): Promise<PinnedResponse> {
  let store = new Uint8Array(4096);
  let start = 0;
  let end = 0;
  let ended = false;
  const size = () => end - start;
  const view = () => store.subarray(start, end);
  const pull = async (): Promise<boolean> => {
    if (ended) return false;
    const chunk = await next();
    if (!chunk) {
      ended = true;
      return false;
    }
    if (end + chunk.length > store.length) {
      const live = end - start;
      const grown = new Uint8Array(Math.max(store.length, (live + chunk.length) * 2));
      grown.set(store.subarray(start, end));
      store = grown;
      start = 0;
      end = live;
    }
    store.set(chunk, end);
    end += chunk.length;
    return true;
  };

  let status = 0;
  let headers = new Map<string, string>();
  for (let interim = 0; ; interim += 1) {
    if (interim > MAX_INTERIM_RESPONSES) throw new TransportError('Te veel tussenantwoorden (1xx) van het eindpunt.');
    let headEnd = indexOf(view(), CRLFCRLF);
    while (headEnd < 0) {
      if (size() > MAX_HEAD_BYTES) throw new TransportError('De kop van het antwoord is te groot.');
      const searched = Math.max(0, size() - CRLFCRLF.length + 1);
      if (!await pull()) throw new TransportError('Het eindpunt sloot de verbinding zonder (volledig) antwoord.');
      headEnd = indexOf(view(), CRLFCRLF, searched);
    }
    if (headEnd > MAX_HEAD_BYTES) throw new TransportError('De kop van het antwoord is te groot.');
    const head = parseResponseHead(latin1(view().subarray(0, headEnd)));
    start += headEnd + 4;
    // 100 Continue, 103 Early Hints: tussenberichten, het echte antwoord volgt.
    if (head.status >= 100 && head.status < 200 && head.status !== 101) continue;
    status = head.status;
    headers = head.headers;
    break;
  }

  if (status === 101 || status === 204 || status === 304) return { status, body: new Uint8Array(0), headers };

  if (/\bchunked\b/i.test(headers.get('transfer-encoding') ?? '')) {
    return { status, body: await readChunked(), headers };
  }
  const declared = headers.get('content-length');
  const length = declared !== undefined && /^\d+$/.test(declared) ? Number(declared) : null;
  const limit = length === null ? maxBody : Math.min(length, maxBody);
  while (size() < limit && await pull()) { /* lezen tot genoeg of het eind */ }
  return { status, body: view().slice(0, limit), headers };

  async function readChunked(): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      let lineEnd = indexOf(view(), CRLF);
      while (lineEnd < 0) {
        if (size() > 1024) throw new TransportError('Onleesbaar antwoord (chunked).');
        if (!await pull()) return join(parts, total);
        lineEnd = indexOf(view(), CRLF);
      }
      const sizeText = latin1(view().subarray(0, lineEnd)).split(';')[0].trim();
      if (!/^[0-9a-f]{1,8}$/i.test(sizeText)) throw new TransportError('Onleesbaar antwoord (chunked).');
      const chunkSize = parseInt(sizeText, 16);
      start += lineEnd + 2;
      if (chunkSize === 0) return join(parts, total);
      const want = Math.min(chunkSize, maxBody - total);
      while (size() < want && await pull()) { /* de brok binnenhalen */ }
      const piece = view().slice(0, Math.min(want, size()));
      parts.push(piece);
      total += piece.length;
      if (total >= maxBody || piece.length < want) return join(parts, total);
      // De brok is helemaal binnen: hem en zijn CRLF overslaan.
      while (size() < chunkSize + 2 && await pull()) { /* tot en met de CRLF */ }
      if (size() < chunkSize + 2) return join(parts, total);
      start += chunkSize + 2;
    }
  }
}

/** De statusregel en de headers. Gooit bij iets wat geen HTTP/1.x-antwoord is. */
export function parseResponseHead(head: string): { status: number; headers: Map<string, string> } {
  const [statusLine, ...lines] = head.split('\r\n');
  const match = /^HTTP\/1\.[01] (\d{3})(?: .*)?$/.exec(statusLine);
  if (!match) throw new TransportError('Het eindpunt antwoordde niet met HTTP/1.1.');
  const headers = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
  }
  return { status: Number(match[1]), headers };
}

// ── De verbinding (Deno) ─────────────────────────────────────────────────────

interface DenoConn {
  read(buffer: Uint8Array): Promise<number | null>;
  write(data: Uint8Array): Promise<number>;
  close(): void;
}

interface DenoNet {
  connect(options: { hostname: string; port: number; transport?: 'tcp'; signal?: AbortSignal }): Promise<DenoConn>;
  startTls(conn: DenoConn, options: { hostname: string }): Promise<DenoConn>;
}

/**
 * Verstuurt het verzoek over TCP naar `address`, met TLS voor de naam uit de
 * URL. Alles binnen `timeoutMs`; daarna gaat de verbinding dicht.
 */
export const pinnedTransport: WebhookTransport = async (request) => {
  const net = (globalThis as unknown as { Deno?: Partial<DenoNet> }).Deno;
  if (typeof net?.connect !== 'function' || typeof net?.startTls !== 'function') {
    throw new TransportError('Deze omgeving kan geen vaste verbinding opzetten (Deno.connect/startTls ontbreekt).');
  }
  const { url } = request;
  const port = url.port ? Number(url.port) : 443;
  const serverName = url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');

  let timedOut = false;
  let conn: DenoConn | null = null;
  // Breekt een verbinding af die niet tot stand komt (een adres dat niet
  // antwoordt); runtimes zonder `signal` op Deno.connect vangt de race hieronder.
  const abort = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
    try { conn?.close(); } catch { /* al dicht */ }
  }, Math.max(1, request.timeoutMs));

  try {
    let tcp: DenoConn;
    try {
      const connecting = net.connect({ hostname: request.address, port, transport: 'tcp', signal: abort.signal });
      tcp = await new Promise<DenoConn>((resolve, reject) => {
        const connectTimer = setTimeout(() => {
          // Komt de verbinding alsnog, dan meteen weer dicht.
          connecting.then((late) => late.close(), () => {});
          abort.abort();
          reject(new TransportError('timeout', 'timeout'));
        }, Math.max(1, request.timeoutMs));
        connecting.then(
          (opened) => { clearTimeout(connectTimer); resolve(opened); },
          (error) => { clearTimeout(connectTimer); reject(error); },
        );
      });
    } catch (error) {
      if (error instanceof TransportError) throw error;
      throw new TransportError(`Geen verbinding met ${request.address}: ${messageOf(error)}`, 'connect');
    }
    conn = tcp;
    const tls = await net.startTls(tcp, { hostname: serverName });
    conn = tls;
    if (timedOut) throw new TransportError('timeout', 'timeout');

    const encoder = new TextEncoder();
    const method = request.method ?? 'POST';
    const body = method === 'GET' ? new Uint8Array(0) : encoder.encode(request.body);
    await writeAll(tls, concat(encoder.encode(buildRequestHead(url, request.headers, body.byteLength, method)), body));

    const chunk = new Uint8Array(16 * 1024);
    const response = await readHttpResponse(async () => {
      const read = await tls.read(chunk);
      return read === null ? null : chunk.slice(0, read);
    }, request.maxBodyBytes);
    return response;
  } catch (error) {
    if (timedOut || (error instanceof TransportError && error.kind === 'timeout')) {
      throw new TransportError(`Geen antwoord binnen ${Math.round(request.timeoutMs / 1000)} seconden.`, 'timeout');
    }
    if (error instanceof TransportError) throw error;
    throw new TransportError(messageOf(error));
  } finally {
    clearTimeout(timer);
    try { conn?.close(); } catch { /* al dicht */ }
  }
};

async function writeAll(conn: DenoConn, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.length) offset += await conn.write(data.subarray(offset));
}

// ── Kleine hulpjes ───────────────────────────────────────────────────────────

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function join(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = Math.max(0, from); i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function latin1(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
