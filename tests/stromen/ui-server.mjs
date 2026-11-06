// Eén adres voor de browser in de UI-test (ui.mjs): /functions/v1/<naam> gaat
// naar de echte edge function in dít proces (met de nepdiensten van
// nepdiensten.mjs), al het andere ongewijzigd naar de gateway van de lokale
// stack (REST, auth, websocket).
//
// Waarom zo: de app praat via supabase-js met één Supabase-adres. In de lokale
// stack draait de edge-runtime niet (esm.sh en deno.land zijn hier niet
// bereikbaar), dus /functions/v1 van de gateway geeft niets. Door de functies
// hier te serveren en de rest door te geven, klikt de browser op precies
// dezelfde code als op staging: echte rechten (RLS), echte functies, alleen
// Resend, Mollie en de media-worker zijn nep.
//
// Elke aanroep komt in `verkeer`, zodat een test kan nagaan welke functie of
// RPC een knop werkelijk aanriep, en met welk antwoord.
import http from 'node:http';
import net from 'node:net';
import { API_URL } from './omgeving.mjs';
import { roepRequest } from './functies.mjs';

/** Kopregels die bij één verbinding horen; die geven we niet door naar een Request. */
const VERBINDINGSKOPPEN = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'expect', 'proxy-connection']);

function leesBody(req) {
  return new Promise((resolve, reject) => {
    const delen = [];
    req.on('data', (deel) => delen.push(deel));
    req.on('end', () => resolve(Buffer.concat(delen)));
    req.on('error', reject);
  });
}

/** De actie uit een JSON-body ({ action: 'sendQuoteEmail', … }), voor het logboek. */
function actieUit(body) {
  if (!body?.length) return null;
  try {
    const json = JSON.parse(body.toString('utf8'));
    return typeof json?.action === 'string' ? json.action : null;
  } catch {
    return null;
  }
}

/**
 * Start de server op een vrije poort van 127.0.0.1. De media-worker van de
 * browser (VITE_R2_WORKER_URL) hangt hier onder /__media/ en geeft een nette
 * 404: de stromen die de UI-test doorloopt hebben hem niet nodig, maar een
 * aanroep komt wel in het logboek.
 */
export async function startUiServer() {
  const gateway = new URL(API_URL);
  const verkeer = [];

  async function functie(req, res, naam) {
    const body = ['GET', 'HEAD'].includes(req.method) ? null : await leesBody(req);
    const headers = new Headers();
    for (const [sleutel, waarde] of Object.entries(req.headers)) {
      if (VERBINDINGSKOPPEN.has(sleutel) || waarde === undefined) continue;
      headers.set(sleutel, Array.isArray(waarde) ? waarde.join(', ') : waarde);
    }
    // Hetzelfde adres als achter de gateway: de functies kennen alleen API_URL.
    const request = new Request(`${API_URL}${req.url}`, {
      method: req.method,
      headers,
      body: body && body.length && req.method !== 'OPTIONS' ? body : undefined,
    });
    const regel = { tijd: Date.now(), soort: 'functie', methode: req.method, pad: req.url.split('?')[0], functie: naam, actie: actieUit(body), status: 0 };
    verkeer.push(regel);
    let antwoord;
    try {
      antwoord = await roepRequest(naam, request);
    } catch (error) {
      // Een functie die niet laadt of gooit: dat moet de test zien, niet de
      // browser als een CORS-fout zonder uitleg.
      regel.status = 599;
      regel.fout = String(error?.stack || error);
      const tekst = JSON.stringify({ ok: false, error: `tests/stromen: functie ${naam} gooide: ${String(error?.message || error)}` });
      res.writeHead(500, { 'content-type': 'application/json', 'access-control-allow-origin': req.headers.origin || '*', 'access-control-allow-headers': '*' });
      res.end(tekst);
      return;
    }
    regel.status = antwoord.status;
    const bytes = Buffer.from(await antwoord.arrayBuffer());
    if (antwoord.status >= 400) regel.antwoord = bytes.toString('utf8').slice(0, 600);
    const kop = {};
    antwoord.headers.forEach((waarde, sleutel) => {
      if (sleutel === 'content-length' || sleutel === 'content-encoding' || sleutel === 'transfer-encoding') return;
      kop[sleutel] = waarde;
    });
    kop['content-length'] = String(bytes.length);
    res.writeHead(antwoord.status, kop);
    res.end(bytes);
  }

  function doorsturen(req, res) {
    const pad = req.url.split('?')[0];
    const rpc = pad.startsWith('/rest/v1/rpc/') ? pad.slice('/rest/v1/rpc/'.length) : null;
    const tabel = !rpc && pad.startsWith('/rest/v1/') ? pad.slice('/rest/v1/'.length) : null;
    const regel = { tijd: Date.now(), soort: rpc ? 'rpc' : tabel ? 'rest' : 'gateway', methode: req.method, pad, rpc, tabel, status: 0 };
    verkeer.push(regel);
    // Kopregels en body ongewijzigd: de gateway ziet wat de browser stuurde.
    const naarGateway = http.request({
      hostname: gateway.hostname,
      port: gateway.port,
      method: req.method,
      path: req.url,
      headers: req.headers,
    }, (terug) => {
      regel.status = terug.statusCode;
      if (terug.statusCode >= 400 && regel.soort !== 'gateway') {
        // Een fout bewaren we (ingekort) voor de diagnose; het antwoord zelf gaat ongewijzigd door.
        const delen = [];
        terug.on('data', (deel) => { if (delen.length < 8) delen.push(deel); });
        terug.on('end', () => { regel.antwoord = Buffer.concat(delen).toString('utf8').slice(0, 600); });
      }
      res.writeHead(terug.statusCode, terug.rawHeaders);
      terug.pipe(res);
    });
    naarGateway.on('error', (error) => {
      regel.status = 598;
      regel.fout = String(error?.message || error);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`tests/stromen: gateway niet bereikbaar: ${regel.fout}`);
    });
    req.pipe(naarGateway);
  }

  function media(req, res) {
    verkeer.push({ tijd: Date.now(), soort: 'media', methode: req.method, pad: req.url.split('?')[0], status: req.method === 'OPTIONS' ? 204 : 404 });
    const cors = { 'access-control-allow-origin': req.headers.origin || '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    res.writeHead(404, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'tests/stromen: geen media-worker in de UI-test' }));
  }

  // Hoeveel verzoeken er nog lopen. De test wacht daarop in plaats van op
  // Playwrights "networkidle": de app probeert telkens opnieuw een realtime-
  // websocket (die draait niet in de lokale stack), en dan wordt het nooit stil.
  let lopend = 0;

  const server = http.createServer((req, res) => {
    lopend += 1;
    let klaar = false;
    const af = () => { if (!klaar) { klaar = true; lopend -= 1; } };
    res.on('finish', af);
    res.on('close', af);
    const pad = req.url.split('?')[0];
    const fn = pad.match(/^\/functions\/v1\/([a-z0-9-]+)/);
    if (fn) {
      functie(req, res, fn[1]).catch((error) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(String(error?.message || error));
      });
      return;
    }
    if (pad.startsWith('/__media/')) { media(req, res); return; }
    doorsturen(req, res);
  });

  // Websockets (realtime) gaan als ruwe tunnel naar de gateway: dan merkt de
  // app precies wat hij tegen de stack zelf zou merken.
  server.on('upgrade', (req, socket, head) => {
    verkeer.push({ tijd: Date.now(), soort: 'websocket', methode: req.method, pad: req.url.split('?')[0], status: 101 });
    const naar = net.connect(Number(gateway.port), gateway.hostname, () => {
      const regels = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) regels.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      naar.write(`${regels.join('\r\n')}\r\n\r\n`);
      if (head?.length) naar.write(head);
      socket.pipe(naar).pipe(socket);
    });
    naar.on('error', () => socket.destroy());
    socket.on('error', () => naar.destroy());
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    verkeer,
    /** Verzoeken die nog geen antwoord hebben (websockets tellen niet mee). */
    lopend: () => lopend,
    async sluit() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
