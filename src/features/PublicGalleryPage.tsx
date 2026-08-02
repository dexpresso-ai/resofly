// Publieke galerijpagina op /gallerij/<token> — login-loos, met optionele
// pincode. Bezoekers (bijv. een bruidspaar dat de link doorstuurt) kunnen de
// galerij bekijken, favorieten markeren (per apparaat via een localStorage-
// sessiesleutel) en — als de fotograaf dat toestaat — losse bestanden of de
// hele galerij als zip downloaden. Data komt uit de gallery-public edge
// function; media-bytes komen rechtstreeks van de media-api worker met
// kortlevende tokens.
import { useCallback, useEffect, useState } from 'react';
import { Download, Lock } from 'lucide-react';
import { Button, Input } from '../components/Ui';
import { supabase } from '../lib/supabase';
import { dateNL } from '../lib/format';
import { galleryFileUrl, galleryRefreshDelayMs, galleryZipUrl, streamDownloadUrl, type GalleryTokenBundle } from '../lib/gallery';
import { brandStyle, ensureBrandFontsLoaded, type BrandingPayload } from '../lib/branding';
import { GalleryViewer, type GalleryViewerItem } from './GalleryViewer';

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

type PublicGallery = {
  id: string;
  title: string;
  description: string | null;
  format: string;
  hero_template: string;
  published_at: string | null;
  allow_downloads: boolean;
  download_quality: string;
  cover_item_id: string | null;
  expires_at: string | null;
};

type Payload = {
  gallery: PublicGallery;
  items: GalleryViewerItem[];
  categories: Array<{ id: string; name: string }>;
  branding?: BrandingPayload;
  tokens: GalleryTokenBundle;
  myFavoriteIds: string[];
  myLikeIds: string[];
  likeCounts: Record<string, number>;
};

const SESSION_STORAGE_KEY = 'resofly.gallery.session';

function getSessionKey(): string {
  try {
    const existing = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (existing && /^[A-Za-z0-9_-]{16,64}$/.test(existing)) return existing;
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    const key = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    window.localStorage.setItem(SESSION_STORAGE_KEY, key);
    return key;
  } catch {
    // Zonder localStorage (privémodus): tijdelijke sessie voor deze paginaweergave.
    return crypto.randomUUID().replace(/-/g, '').slice(0, 32);
  }
}

export function PublicGalleryPage({ token }: { token: string }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [needsPin, setNeedsPin] = useState(false);
  const [galleryTitle, setGalleryTitle] = useState('');
  const [pin, setPin] = useState('');
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [likeIds, setLikeIds] = useState<Set<string>>(new Set());
  const [likeCounts, setLikeCounts] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionKey] = useState(getSessionKey);

  const load = useCallback(async (pinValue: string) => {
    setLoading(true);
    setError(null);
    try {
      const { data, error } = await supabase.functions.invoke('gallery-public', {
        body: { action: 'getGallery', token, pin: pinValue || undefined, sessionKey },
      });
      if (error) throw new Error(await extractFunctionError(error, 'Galerij laden mislukt'));
      if (!data?.ok) throw new Error(data?.error || 'Galerij laden mislukt');
      if (data.needsPin) {
        setNeedsPin(true);
        setGalleryTitle(String(data.gallery?.title || ''));
        setPayload(null);
      } else {
        setNeedsPin(false);
        const result = data as Payload & { ok: true };
        // Lettertypen van de beeldmaker inladen vóór de galerij verschijnt.
        ensureBrandFontsLoaded([result.branding?.headingFont, result.branding?.bodyFont]);
        setPayload(result);
        setFavoriteIds(new Set((result.myFavoriteIds || []).map(String)));
        setLikeIds(new Set((result.myLikeIds || []).map(String)));
        setLikeCounts(new Map(Object.entries(result.likeCounts ?? {})));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Galerij laden mislukt');
    } finally {
      setLoading(false);
    }
  }, [token, sessionKey]);

  // Eerste laadpoging zonder pincode (de pin-flow neemt het over als die nodig is).
  useEffect(() => { void load(''); }, [load]);

  // Media-tokens leven een uur; ruim daarvoor vernieuwen zodat een galerij die
  // de hele dag open staat niet stilletjes kapotte beelden gaat tonen.
  useEffect(() => {
    if (!payload) return;
    const delay = galleryRefreshDelayMs(payload.tokens);
    if (delay == null) return;
    const timer = window.setTimeout(() => { void load(pin); }, delay);
    return () => window.clearTimeout(timer);
  }, [payload, pin, load]);

  async function sendReaction(item: GalleryViewerItem, on: boolean, reaction: 'favorite' | 'like') {
    const { data, error } = await supabase.functions.invoke('gallery-public', {
      body: { action: 'toggleFavorite', token, pin: pin || undefined, sessionKey, itemId: item.id, on, reaction },
    });
    if (error || !data?.ok) throw new Error('Reactie bijwerken mislukt');
  }

  async function toggleFavorite(item: GalleryViewerItem, on: boolean) {
    setFavoriteIds(prev => {
      const next = new Set(prev);
      if (on) next.add(item.id); else next.delete(item.id);
      return next;
    });
    try {
      await sendReaction(item, on, 'favorite');
    } catch {
      setFavoriteIds(prev => {
        const next = new Set(prev);
        if (on) next.delete(item.id); else next.add(item.id);
        return next;
      });
    }
  }

  async function toggleLike(item: GalleryViewerItem, on: boolean) {
    const shift = (delta: number) => setLikeCounts(prev => {
      const next = new Map(prev);
      next.set(item.id, Math.max(0, (next.get(item.id) ?? 0) + delta));
      return next;
    });
    setLikeIds(prev => {
      const next = new Set(prev);
      if (on) next.add(item.id); else next.delete(item.id);
      return next;
    });
    shift(on ? 1 : -1);
    try {
      await sendReaction(item, on, 'like');
    } catch {
      setLikeIds(prev => {
        const next = new Set(prev);
        if (on) next.delete(item.id); else next.add(item.id);
        return next;
      });
      shift(on ? -1 : 1);
    }
  }

  function downloadItem(item: GalleryViewerItem) {
    if (!payload) return;
    const webPhoto = payload.gallery.download_quality === 'web' && item.media_type === 'photo';
    const r2Key = (webPhoto ? item.preview_key : null) || item.storage_key || item.preview_key;
    let url: string | null = null;
    if (r2Key) {
      url = galleryFileUrl(r2Key, payload.tokens.mediaToken, { download: true });
    } else if (item.stream_uid && item.stream_playback_base && payload.tokens.streamTokens[item.stream_uid]) {
      url = streamDownloadUrl(item.stream_playback_base, payload.tokens.streamTokens[item.stream_uid]);
    }
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = item.file_name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ── Pinscherm ──
  if (needsPin) {
    return (
      <main className="pgal pgal-gate">
        <form
          className="pgal-pin-card"
          onSubmit={(e) => { e.preventDefault(); if (pin.trim()) void load(pin.trim()); }}
        >
          <span className="pgal-pin-icon"><Lock size={22} /></span>
          <h1>{galleryTitle || 'Beveiligde galerij'}</h1>
          <p>Deze galerij is beveiligd met een pincode. Je hebt de code van de maker ontvangen.</p>
          <Input
            autoFocus
            inputMode="numeric"
            placeholder="Pincode"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            maxLength={8}
            aria-label="Pincode"
          />
          {error && <div className="pgal-error">{error}</div>}
          <Button type="submit" variant="primary" disabled={loading || !pin.trim()}>
            {loading ? 'Controleren…' : 'Openen'}
          </Button>
        </form>
      </main>
    );
  }

  if (loading && !payload) {
    return <main className="pgal pgal-gate"><div className="pgal-loading"><span className="boot-spinner" aria-hidden="true" /><span>Galerij laden…</span></div></main>;
  }

  if (error && !payload) {
    return (
      <main className="pgal pgal-gate">
        <div className="pgal-pin-card">
          <h1>Galerij niet beschikbaar</h1>
          <p>{error}</p>
        </div>
      </main>
    );
  }

  if (!payload) return null;

  const downloadableCount = payload.items.filter(i => i.storage_key || i.preview_key).length;

  const branding = payload.branding;

  return (
    // Accentkleur en lettertypen komen als CSS-variabelen binnen, alleen op
    // deze pagina — zo kleuren alle bestaande stijlen mee zonder duplicatie.
    <main className="pgal" style={brandStyle(branding)}>
      {branding?.logoDataUrl && (
        <div className="pgal-brand">
          <img src={branding.logoDataUrl} alt={branding.companyName ?? 'Logo'} />
        </div>
      )}
      {/* De titel en omschrijving staan in de hero van de viewer; hier alleen
          de praktische regel eronder, anders staat alles dubbel. */}
      <header className="pgal-hero">
        <div className="pgal-meta">
          {payload.gallery.published_at && <span>{dateNL(payload.gallery.published_at)}</span>}
          <span>{payload.items.length} item{payload.items.length === 1 ? '' : 's'}</span>
          {payload.gallery.expires_at && <span>Beschikbaar tot {dateNL(payload.gallery.expires_at)}</span>}
          {payload.gallery.allow_downloads && downloadableCount > 0 && (
            <a className="pgal-zip" href={galleryZipUrl(payload.gallery.id, payload.tokens.mediaToken)} download>
              <Download size={14} /> Alles downloaden
            </a>
          )}
        </div>
      </header>
      <section className="pgal-body">
        <GalleryViewer
          items={payload.items}
          bundle={payload.tokens}
          allowDownload={payload.gallery.allow_downloads}
          format={payload.gallery.format}
          categories={payload.categories}
          hero={{
            template: payload.gallery.hero_template,
            title: payload.gallery.title,
            description: payload.gallery.description,
            itemId: payload.gallery.cover_item_id,
          }}
          favorites={favoriteIds}
          canFavorite
          likes={likeIds}
          likeCounts={likeCounts}
          canLike
          onToggleLike={(item, on) => void toggleLike(item, on)}
          onToggleFavorite={(item, on) => void toggleFavorite(item, on)}
          onDownloadItem={downloadItem}
          emptyText="Deze galerij bevat nog geen media."
        />
      </section>
      <footer className="pgal-foot">
        {branding?.footerText && <span className="pgal-foot-own">{branding.footerText}</span>}
        {!branding?.hidePoweredBy && <span>Geleverd via ResoFly</span>}
      </footer>
    </main>
  );
}
