// Ontvangstpagina van een zending op /ontvang/<token> — login-loos.
//
// Iemand die bestanden kreeg, ziet hier eerst alleen van wie ze komen en
// hoeveel het er zijn. Openen gaat met een code die naar het e-mailadres van
// de ontvanger gaat; zo werkt een doorgestuurde link niet voor een ander. Wie
// al op het klantportaal is ingelogd met hetzelfde adres, komt zonder code
// binnen. De bytes komen via kortlevende links van de media-worker; deze
// pagina krijgt nooit een opslagsleutel te zien.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, FileText, FolderOpen, Image as ImageIcon, KeyRound, Lock, Mail, StickyNote } from 'lucide-react';
import { Button, Input } from '../components/Ui';
import { ReadModal } from '../components/ReadModal';
import { supabase } from '../lib/supabase';
import { supabasePortalAuth } from '../lib/supabasePortal';
import { dateNL } from '../lib/format';
import { fileCountLabel, formatBytes } from '../lib/transfers';
import { brandStyle, ensureBrandFontsLoaded, type BrandingPayload } from '../lib/branding';

type TransferItem = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  path: string | null;
  kind: 'file' | 'text';
  downloadable: boolean;
  readable: boolean;
};

type Payload = {
  state: 'active' | 'revoked' | 'expired' | 'invalid' | 'unknown';
  message?: string;
  company: { name: string | null; email: string | null; phone: string | null; website: string | null } | null;
  branding?: BrandingPayload;
  recipient?: { maskedEmail: string; name: string | null };
  fileCount?: number;
  totalBytes?: number;
  expiresAt?: string;
  senderName?: string | null;
  verified?: boolean;
  subject?: string;
  canDownload?: boolean;
  sentAt?: string | null;
  items?: TransferItem[];
};

const SESSION_PREFIX = 'resofly.transfer.session.';

function sessionKey(token: string): string {
  return `${SESSION_PREFIX}${token.slice(0, 24)}`;
}

function readSession(token: string): string | null {
  try { return window.sessionStorage.getItem(sessionKey(token)); } catch { return null; }
}

function writeSession(token: string, session: string | null): void {
  try {
    if (session) window.sessionStorage.setItem(sessionKey(token), session);
    else window.sessionStorage.removeItem(sessionKey(token));
  } catch { /* privémodus: dan vraagt een herlaad opnieuw een code */ }
}

async function invoke(body: Record<string, unknown>): Promise<Payload & Record<string, unknown>> {
  const { data, error } = await supabase.functions.invoke('file-transfer-public', { body });
  if (error) {
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      const json = await context.clone().json().catch(() => null) as { error?: string } | null;
      if (json?.error) throw new Error(json.error);
    }
    throw new Error(error.message || 'Dat lukte niet.');
  }
  if (!data?.ok) throw new Error(data?.error || 'Dat lukte niet.');
  return data as Payload & Record<string, unknown>;
}

function triggerDownload(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function PublicTransferPage({ token }: { token: string }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [reading, setReading] = useState<{ title: string; html: string } | null>(null);
  const triedPortal = useRef(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const result = await invoke({ action: 'get', token, session: readSession(token) });
      if (result.state === 'active' && !result.verified) writeSession(token, null);
      setPayload(result);
      // Al ingelogd op het klantportaal met hetzelfde adres? Dan geen code nodig.
      if (result.state === 'active' && !result.verified && !triedPortal.current) {
        triedPortal.current = true;
        const { data } = await supabasePortalAuth.getSession().catch(() => ({ data: { session: null } }));
        const accessToken = data?.session?.access_token;
        if (accessToken) {
          try {
            const opened = await invoke({ action: 'portalSession', token, accessToken });
            if (typeof opened.session === 'string') writeSession(token, opened.session);
            setPayload(opened);
          } catch {
            // Ander adres of verlopen portaalsessie: dan gewoon met een code.
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Deze link kon niet worden geopend.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { ensureBrandFontsLoaded([payload?.branding?.headingFont, payload?.branding?.bodyFont]); }, [payload?.branding]);

  async function requestCode() {
    setBusy('code'); setError(null);
    try {
      const result = await invoke({ action: 'requestCode', token });
      setCodeSentTo(String(result.sentTo ?? payload?.recipient?.maskedEmail ?? 'je e-mailadres'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'De code kon niet worden verstuurd.');
    } finally {
      setBusy(null);
    }
  }

  async function verify() {
    setBusy('verify'); setError(null);
    try {
      const result = await invoke({ action: 'verifyCode', token, code });
      if (typeof result.session === 'string') writeSession(token, result.session);
      setPayload(result);
      setCode('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Deze code klopt niet.');
    } finally {
      setBusy(null);
    }
  }

  /** Een verlopen sessie (na een uur): terug naar de code-stap. */
  function sessionExpired(message: string): boolean {
    if (!/sessie is verlopen/i.test(message)) return false;
    writeSession(token, null);
    setPayload((prev) => (prev ? { ...prev, verified: false, items: undefined } : prev));
    setCodeSentTo(null);
    return true;
  }

  async function open(item: TransferItem) {
    setBusy(item.id); setError(null);
    try {
      if (item.readable) {
        const result = await invoke({ action: 'read', token, session: readSession(token), itemId: item.id });
        setReading({ title: String(result.title ?? item.name), html: String(result.html ?? '') });
      } else {
        const result = await invoke({ action: 'download', token, session: readSession(token), itemId: item.id });
        if (typeof result.url === 'string') triggerDownload(result.url);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Openen mislukte.';
      if (!sessionExpired(message)) setError(message);
    } finally {
      setBusy(null);
    }
  }

  async function downloadAll() {
    setBusy('zip'); setError(null);
    try {
      const result = await invoke({ action: 'zip', token, session: readSession(token) });
      if (typeof result.url === 'string') triggerDownload(result.url);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'De zip kon niet worden klaargezet.';
      if (!sessionExpired(message)) setError(message);
    } finally {
      setBusy(null);
    }
  }

  const companyName = payload?.company?.name || 'ResoFly';
  const style = payload?.branding ? brandStyle(payload.branding) : undefined;
  const groups = useMemo(() => groupByPath(payload?.items ?? []), [payload?.items]);
  const downloadable = (payload?.items ?? []).filter((item) => item.downloadable);

  if (loading && !payload) {
    return <main className="public-quote-page"><div className="public-quote-card"><h1>Bestanden laden…</h1></div></main>;
  }
  if (!payload) {
    return <main className="public-quote-page"><div className="public-quote-card">
      <p className="eyebrow">Bestanden</p>
      <h1>Deze link werkt niet</h1>
      <p>{error ?? 'Probeer het later opnieuw.'}</p>
    </div></main>;
  }

  if (payload.state !== 'active') {
    return <main className="public-quote-page public-share-page" style={style}>
      <section className="public-quote-card">
        <p className="eyebrow">{companyName}</p>
        <h1>{payload.state === 'expired' ? 'Niet meer beschikbaar' : payload.state === 'revoked' ? 'Ingetrokken' : 'Deze link werkt niet meer'}</h1>
        <p>{payload.message}</p>
        {payload.company?.email && <p className="muted">Vragen? Mail <a href={`mailto:${payload.company.email}`}>{payload.company.email}</a>.</p>}
      </section>
    </main>;
  }

  if (!payload.verified) {
    return <main className="public-quote-page public-share-page xfer-public" style={style}>
      <section className="public-quote-card public-quote-hero">
        <div>
          <p className="eyebrow">{companyName}</p>
          <h1>{payload.senderName ? `${payload.senderName} heeft je bestanden gestuurd` : 'Er staan bestanden voor je klaar'}</h1>
          <p>{fileCountLabel(payload.fileCount ?? 0)} · {formatBytes(payload.totalBytes ?? 0)}{payload.expiresAt ? ` · beschikbaar tot ${dateNL(payload.expiresAt)}` : ''}</p>
        </div>
        <div className="public-quote-status"><Lock size={14} /> Beveiligd</div>
      </section>

      {error && <div className="public-quote-alert">{error}</div>}

      <section className="public-quote-card xfer-public-gate">
        <h2><KeyRound size={18} /> Open met een code</h2>
        {!codeSentTo
          ? <>
              <p>We sturen een code van zes cijfers naar <strong>{payload.recipient?.maskedEmail}</strong>. Zo weten we dat jij het bent.</p>
              <Button variant="primary" onClick={() => void requestCode()} disabled={busy !== null}>
                <Mail size={15} /> {busy === 'code' ? 'Versturen…' : 'Stuur mij een code'}
              </Button>
            </>
          : <>
              <p>De code is verstuurd naar <strong>{codeSentTo}</strong>. Hij is tien minuten geldig.</p>
              <form className="xfer-code-row" onSubmit={(e) => { e.preventDefault(); void verify(); }}>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/[^\d\s-]/g, '').slice(0, 9))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123 456"
                  aria-label="Code uit de mail"
                  autoFocus
                />
                <Button variant="primary" type="submit" disabled={busy !== null || code.replace(/\D/g, '').length !== 6}>
                  {busy === 'verify' ? 'Controleren…' : 'Openen'}
                </Button>
              </form>
              <button type="button" className="xfer-link-btn" onClick={() => void requestCode()} disabled={busy !== null}>Nieuwe code sturen</button>
            </>}
        <p className="muted xfer-public-note">Geen mail ontvangen? Kijk in je map met ongewenste mail. Deze link is persoonlijk; stuur hem niet door.</p>
      </section>

      <p className="share-public-foot">Verstuurd via {companyName}.</p>
    </main>;
  }

  return <main className="public-quote-page public-share-page xfer-public" style={style}>
    <section className="public-quote-card public-quote-hero">
      <div>
        <p className="eyebrow">{companyName}</p>
        <h1>{payload.subject || 'Bestanden'}</h1>
        <p>
          {payload.senderName ? `Van ${payload.senderName}` : 'Voor jou klaargezet'}
          {payload.sentAt ? ` · ${dateNL(payload.sentAt)}` : ''}
        </p>
      </div>
      {payload.expiresAt && <div className="public-quote-status"><Lock size={14} /> Tot {dateNL(payload.expiresAt)}</div>}
    </section>

    {error && <div className="public-quote-alert">{error}</div>}

    {payload.message && <section className="public-quote-card">
      <h2>Bericht</h2>
      <p className="share-public-message">{payload.message}</p>
    </section>}

    <section className="public-quote-card">
      <div className="xfer-public-list-head">
        <h2>{fileCountLabel(payload.items?.length ?? 0)}</h2>
        {downloadable.length > 1 && <Button onClick={() => void downloadAll()} disabled={busy !== null}>
          <Download size={14} /> {busy === 'zip' ? 'Klaarzetten…' : 'Alles als zip'}
        </Button>}
      </div>
      {groups.map((group) => <div className="share-public-group" key={group.path || '__root__'}>
        {group.path && <h3><FolderOpen size={14} /> {group.path}</h3>}
        <div className="share-public-list">
          {group.items.map((item) => <div className="share-public-row" key={item.id}>
            <span className="share-public-ic">
              {item.kind === 'text' ? <StickyNote size={18} /> : item.mimeType.startsWith('image/') ? <ImageIcon size={18} /> : <FileText size={18} />}
            </span>
            <span className="share-public-name">
              <strong>{item.name}</strong>
              <span>{item.kind === 'text' ? 'Tekst' : formatBytes(item.sizeBytes)}</span>
            </span>
            {item.readable
              ? <Button onClick={() => void open(item)} disabled={busy !== null}>{busy === item.id ? 'Bezig…' : 'Lezen'}</Button>
              : item.downloadable
                ? <Button onClick={() => void open(item)} disabled={busy !== null}>{busy === item.id ? 'Bezig…' : <><Download size={14} /> Downloaden</>}</Button>
                : <span className="muted">Downloaden staat uit</span>}
          </div>)}
        </div>
      </div>)}
      {payload.canDownload === false && <p className="muted">De afzender heeft downloaden voor deze bestanden uitgezet.</p>}
    </section>

    {reading && <ReadModal title={reading.title} html={reading.html} onClose={() => setReading(null)} />}

    <p className="share-public-foot">Verstuurd via {companyName}. Na {payload.expiresAt ? dateNL(payload.expiresAt) : 'de vervaldatum'} worden de bestanden verwijderd. Deze link is persoonlijk — stuur hem niet door.</p>
  </main>;
}

/** Groepeert op pad binnen een meegestuurde map, zodat de mapstructuur zichtbaar blijft. */
function groupByPath(items: TransferItem[]): Array<{ path: string; items: TransferItem[] }> {
  const map = new Map<string, TransferItem[]>();
  for (const item of items) {
    const key = item.path || '';
    map.set(key, [...(map.get(key) ?? []), item]);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'nl')).map(([path, list]) => ({ path, items: list }));
}
