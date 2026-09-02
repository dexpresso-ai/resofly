// Publieke deelpagina op /gedeeld/<token> — login-loos. Iemand die een deellink
// heeft gekregen ziet hier wat er met hem is gedeeld en kan het (als de afzender
// dat toestaat) downloaden of lezen. De token in de URL is de sleutel; de
// database bewaart daar alleen de sha256-hash van, en bewaakt intrekken en
// verlopen. Klantgerelateerde bestanden komen hier per definitie nooit terecht:
// die mogen alleen naar de geregistreerde contactpersonen van de klant, via het
// ingelogde klantportaal.
import { useCallback, useEffect, useState } from 'react';
import { Download, FileText, Folder, Lock, StickyNote } from 'lucide-react';
import { Button } from '../components/Ui';
import { supabase } from '../lib/supabase';
import { dateNL } from '../lib/format';
import { brandStyle, ensureBrandFontsLoaded, type BrandingPayload } from '../lib/branding';
import { ReadModal } from '../components/ReadModal';

type ShareItem = {
  itemType: 'attachment' | 'note' | 'document';
  itemId: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number | null;
  modified: string | null;
  path: string | null;
  downloadable: boolean;
  readable: boolean;
};

type Payload = {
  share: {
    itemType: 'folder' | 'attachment' | 'note' | 'document';
    itemName: string | null;
    recipientName: string | null;
    message: string | null;
    canDownload: boolean;
    expiresAt: string | null;
  };
  items: ShareItem[];
  company: { company_name: string | null; trade_name: string | null } | null;
  branding?: BrandingPayload;
};

async function extractFunctionError(error: unknown, fallback: string): Promise<string> {
  const context = (error as { context?: unknown })?.context;
  if (context instanceof Response) {
    try {
      const payload = await context.clone().json().catch(() => null) as { error?: string } | null;
      if (payload?.error) return payload.error;
      const text = await context.text().catch(() => '');
      if (text) return text;
    } catch {
      // val terug op message hieronder
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function fmtBytes(bytes: number | null): string {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function PublicSharePage({ token }: { token: string }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reading, setReading] = useState<{ title: string; html: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const { data, error: fnError } = await supabase.functions.invoke('file-share-public', {
        body: { action: 'get', token },
      });
      if (fnError) throw new Error(await extractFunctionError(fnError, 'Deze deellink kon niet worden geopend.'));
      if (!data?.ok) throw new Error(data?.error || 'Deze deellink kon niet worden geopend.');
      setPayload(data as Payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Deze deellink kon niet worden geopend.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { ensureBrandFontsLoaded([payload?.branding?.headingFont, payload?.branding?.bodyFont]); }, [payload?.branding]);

  async function open(item: ShareItem) {
    setBusyId(item.itemId); setError(null);
    try {
      const { data, error: fnError } = await supabase.functions.invoke('file-share-public', {
        body: { action: 'download', token, itemType: item.itemType, itemId: item.itemId },
      });
      if (fnError) throw new Error(await extractFunctionError(fnError, 'Openen mislukt.'));
      if (!data?.ok) throw new Error(data?.error || 'Openen mislukt.');
      if (data.text) { setReading({ title: data.text.title || item.name, html: data.text.html || '' }); return; }
      if (!data.file?.base64) throw new Error('Openen mislukt.');
      downloadBase64(data.file.base64 as string, data.file.fileName || item.name, data.file.mimeType || 'application/octet-stream');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Openen mislukt.');
    } finally {
      setBusyId(null);
    }
  }

  const companyName = payload?.company?.trade_name || payload?.company?.company_name || 'ResoFly';
  const style = payload?.branding ? brandStyle(payload.branding) : undefined;

  if (loading) {
    return <main className="public-quote-page"><div className="public-quote-card"><h1>Gedeelde bestanden laden…</h1></div></main>;
  }
  if (error && !payload) {
    return <main className="public-quote-page"><div className="public-quote-card">
      <p className="eyebrow">Gedeeld</p>
      <h1>Deze link werkt niet meer</h1>
      <p>{error}</p>
    </div></main>;
  }
  if (!payload) {
    return <main className="public-quote-page"><div className="public-quote-card"><h1>Niets gevonden</h1></div></main>;
  }

  const { share, items } = payload;
  const groups = groupByPath(items);

  return <main className="public-quote-page public-share-page" style={style}>
    <section className="public-quote-card public-quote-hero">
      <div>
        <p className="eyebrow">{companyName}</p>
        <h1>{share.itemName || 'Gedeelde bestanden'}</h1>
        <p>
          {share.recipientName ? `${share.recipientName}, dit` : 'Dit'} is met je gedeeld
          {share.itemType === 'folder' ? ' — de map inclusief alles wat erin zit.' : '.'}
        </p>
      </div>
      {share.expiresAt && <div className="public-quote-status"><Lock size={14} /> Tot {dateNL(share.expiresAt)}</div>}
    </section>

    {error && <div className="public-quote-alert">{error}</div>}

    {share.message && <section className="public-quote-card">
      <h2>Bericht</h2>
      <p className="share-public-message">{share.message}</p>
    </section>}

    <section className="public-quote-card">
      <h2>{items.length === 0 ? 'Inhoud' : `${items.length} ${items.length === 1 ? 'item' : 'items'}`}</h2>
      {items.length === 0
        ? <p className="muted">Er staat op dit moment niets in deze deling.</p>
        : groups.map(group => <div className="share-public-group" key={group.path || '__root__'}>
            {group.path && <h3><Folder size={14} /> {group.path}</h3>}
            <div className="share-public-list">
              {group.items.map(item => <div className="share-public-row" key={`${item.itemType}-${item.itemId}`}>
                <span className="share-public-ic">
                  {item.itemType === 'note' ? <StickyNote size={18} /> : <FileText size={18} />}
                </span>
                <span className="share-public-name">
                  <strong>{item.name}</strong>
                  <span>{[fmtBytes(item.sizeBytes), item.modified ? dateNL(item.modified) : ''].filter(Boolean).join(' · ')}</span>
                </span>
                {item.readable
                  ? <Button onClick={() => open(item)} disabled={busyId === item.itemId}>
                      {busyId === item.itemId ? 'Bezig…' : 'Lezen'}
                    </Button>
                  : item.downloadable
                    ? <Button onClick={() => open(item)} disabled={busyId === item.itemId}>
                        {busyId === item.itemId ? 'Bezig…' : <><Download size={14} /> Downloaden</>}
                      </Button>
                    : <span className="muted">{share.canDownload ? 'Niet beschikbaar' : 'Downloaden staat uit'}</span>}
              </div>)}
            </div>
          </div>)}
      {!share.canDownload && <p className="muted">De afzender heeft downloaden voor deze deling uitgezet.</p>}
    </section>

    {reading && <ReadModal title={reading.title} html={reading.html} onClose={() => setReading(null)} />}

    <p className="share-public-foot">Gedeeld via {companyName}. Deze link is persoonlijk — stuur hem niet door.</p>
  </main>;
}

/** Groepeert de items op hun pad binnen de gedeelde map, zodat de mapstructuur zichtbaar blijft. */
function groupByPath(items: ShareItem[]): Array<{ path: string; items: ShareItem[] }> {
  const map = new Map<string, ShareItem[]>();
  for (const item of items) {
    const key = item.path || '';
    const list = map.get(key);
    if (list) list.push(item); else map.set(key, [item]);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'nl'))
    .map(([path, list]) => ({ path, items: list }));
}

function downloadBase64(base64: string, fileName: string, mimeType: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
}
