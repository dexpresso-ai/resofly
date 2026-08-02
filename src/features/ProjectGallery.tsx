// Galerij-oplevering binnen een project: galerijen aanmaken en beheren,
// foto's/video's uploaden (full-res naar R2, video bij voorkeur naar
// Cloudflare Stream), publiceren richting het klantportaal en een publieke
// deellink (met optionele pincode) uitgeven. Favorieten van de klant komen
// hier live terug (realtime op gallery_favorites).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import {
  CheckSquare, ChevronDown, ChevronUp, Copy, Download, Film, FolderTree, HardDrive, Heart,
  Image as ImageIcon, Layers, Link2, Loader2, Plus, Settings2, Star, Trash2, Upload,
} from 'lucide-react';
import type {
  AppData, Gallery, GalleryCategory, GalleryCategoryPreset, GalleryFavorite, GalleryFormat,
  GalleryHeroTemplate, GalleryItem, OrganizationStorageStatus, Project, UUID,
} from '../types';
import { Button, Input, Select } from '../components/Ui';
import { dateNL } from '../lib/format';
import { supabase, supabaseAuth } from '../lib/supabase';
import {
  deleteRow, fetchOrganizationStorageStatus, insertRow, replaceGalleryCategoryPresets,
  selectGalleryCategories, selectGalleryCategoryPresets, selectGalleryFavorites, selectGalleryItems,
  setGalleryItemsCategory, updateRow,
} from '../lib/repository';
import { deleteR2Object } from '../lib/r2-api';
import {
  GALLERY_ORIGINAL_MAX_BYTES, GALLERY_PHOTO_TYPES,
  captureVideoPoster, createGalleryViewSession, deleteGalleryStreamVideo, galleryFileUrl,
  galleryRefreshDelayMs, galleryZipUrl,
  generateImageDerivatives, getGalleryStreamStatus, requestGalleryStreamUpload, streamBasicUpload,
  streamDownloadUrl, streamTusUpload, uploadGalleryFileVariant, type GalleryTokenBundle,
} from '../lib/gallery';
import { GalleryViewer, type GalleryViewerItem } from './GalleryViewer';

const galleryStatusLabels: Record<Gallery['status'], string> = {
  draft: 'Concept',
  published: 'Gepubliceerd',
  archived: 'Gearchiveerd',
};

/**
 * Het formaat bepaalt zowel de weergave bij de klant als welke bestanden er in
 * de galerij mogen. De database bewaakt dat laatste ook (trigger), zodat het
 * niet alleen een UI-afspraak is.
 */
const galleryFormats: Array<{
  key: GalleryFormat;
  label: string;
  hint: string;
  Icon: typeof ImageIcon;
  accept: string;
}> = [
  { key: 'photo', label: 'Fotogalerij', hint: 'Alleen foto’s, als raster met lightbox.', Icon: ImageIcon, accept: 'image/jpeg,image/png,image/webp' },
  { key: 'video', label: 'Videogalerij', hint: 'Alleen video’s, filmisch met grote tegels.', Icon: Film, accept: 'video/*' },
  { key: 'hybrid', label: 'Foto én video', hint: 'Beide in één oplevering; video’s bovenaan.', Icon: Layers, accept: 'image/jpeg,image/png,image/webp,video/*' },
];

const galleryFormatLabels: Record<GalleryFormat, string> = {
  photo: 'Foto', video: 'Video', hybrid: 'Foto + video',
};

function formatConfig(format: GalleryFormat) {
  return galleryFormats.find(f => f.key === format) ?? galleryFormats[2];
}

/** De vier openingen; het miniatuur ernaast is puur CSS (geen echte foto nodig). */
const heroTemplates: Array<{ key: GalleryHeroTemplate; label: string }> = [
  { key: 'full', label: 'Volledig beeld' },
  { key: 'split', label: 'Beeld naast tekst' },
  { key: 'collage', label: 'Collage' },
  { key: 'minimal', label: 'Alleen tekst' },
];

function fmtBytesShort(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${Math.round(bytes / 1048576)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${bytes} B`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomShareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

type QueueEntry = { name: string; status: 'wacht' | 'bezig' | 'klaar' | 'fout'; detail?: string };

export function GalleryTab({ data, project, organizationId, canWrite, onChanged }: {
  data: AppData;
  project: Project;
  organizationId: UUID;
  canWrite: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const galleries = useMemo(
    () => data.galleries.filter(g => g.project_id === project.id).sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [data.galleries, project.id],
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const openGallery = galleries.find(g => g.id === openId) ?? null;

  const [items, setItems] = useState<GalleryItem[]>([]);
  const [categories, setCategories] = useState<GalleryCategory[]>([]);
  const [presets, setPresets] = useState<GalleryCategoryPreset[]>([]);
  const [showCategories, setShowCategories] = useState(false);
  const [newCategory, setNewCategory] = useState('');
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [favorites, setFavorites] = useState<GalleryFavorite[]>([]);
  const [bundle, setBundle] = useState<GalleryTokenBundle | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [storage, setStorage] = useState<OrganizationStorageStatus | null>(null);

  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newFormat, setNewFormat] = useState<GalleryFormat>('hybrid');
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showShare, setShowShare] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pollTimers = useRef(new Map<string, number>());
  // Asynchroon werk (uploads, Stream-polls, tokenvernieuwing) mag nooit de
  // toestand van een ínmiddels andere galerij overschrijven: media-tokens zijn
  // per galerij geldig, dus een verdwaalde bundel maakt alle beelden stuk.
  const openIdRef = useRef<string | null>(null);
  const refreshTimer = useRef<number | null>(null);
  useEffect(() => { openIdRef.current = openId; }, [openId]);

  const refreshStorage = useCallback(async () => {
    setStorage(await fetchOrganizationStorageStatus(organizationId));
  }, [organizationId]);

  useEffect(() => { void refreshStorage(); }, [refreshStorage]);

  const refreshCategories = useCallback(async (galleryId: string) => {
    try {
      const rows = await selectGalleryCategories(organizationId, galleryId);
      if (openIdRef.current === galleryId) setCategories(rows);
    } catch { /* categorieën zijn nooit blokkerend voor de weergave */ }
  }, [organizationId]);

  const refreshFavorites = useCallback(async (galleryId: string) => {
    try {
      const rows = await selectGalleryFavorites(organizationId, galleryId);
      if (openIdRef.current === galleryId) setFavorites(rows);
    } catch { /* favorieten zijn nooit blokkerend */ }
  }, [organizationId]);

  const refreshSession = useCallback(async (galleryId: string) => {
    try {
      const next = await createGalleryViewSession(organizationId, galleryId);
      if (openIdRef.current !== galleryId) return;
      setBundle(next);
      // Tokens leven een uur; ruim daarvoor automatisch vernieuwen zodat
      // openstaande tabbladen niet stilletjes op 403's lopen.
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
      const delay = galleryRefreshDelayMs(next);
      if (delay != null) {
        refreshTimer.current = window.setTimeout(() => {
          if (openIdRef.current === galleryId) void refreshSession(galleryId);
        }, delay);
      }
    } catch (e) {
      if (openIdRef.current === galleryId) setError(e instanceof Error ? e.message : 'Kon galerij-tokens niet ophalen.');
    }
  }, [organizationId]);

  const stopPolling = useCallback((itemId: string) => {
    const timer = pollTimers.current.get(itemId);
    if (timer) window.clearTimeout(timer);
    pollTimers.current.delete(itemId);
  }, []);

  // ── Stream-verwerking pollen tot de video afspeelbaar is ──
  // Oplopende interval (8s → max 60s) zodat ook een lange 4K-transcode wordt
  // opgepikt, zonder in de tussentijd honderden requests te doen.
  const pollStreamItem = useCallback((item: GalleryItem) => {
    if (!item.stream_uid || pollTimers.current.has(item.id)) return;
    let tries = 0;
    const schedule = () => {
      const delay = Math.min(60_000, 8000 + tries * 4000);
      pollTimers.current.set(item.id, window.setTimeout(() => { void tick(); }, delay));
    };
    const tick = async () => {
      tries += 1;
      // Galerij dicht of item verwijderd? Dan stopt de poll.
      if (openIdRef.current !== item.gallery_id) { stopPolling(item.id); return; }
      try {
        const status = await getGalleryStreamStatus(organizationId, item.stream_uid!);
        if (status.ready) {
          const updated = await updateRow<GalleryItem>('gallery_items', item.id, {
            stream_status: 'ready',
            stream_playback_base: status.playbackBase,
            duration_seconds: status.durationSeconds ?? item.duration_seconds,
          }, organizationId);
          stopPolling(item.id);
          if (openIdRef.current === item.gallery_id) {
            setItems(prev => prev.map(x => (x.id === item.id ? updated : x)));
            await refreshSession(item.gallery_id);
          }
          return;
        }
        if (status.state === 'error') {
          const updated = await updateRow<GalleryItem>('gallery_items', item.id, { stream_status: 'error' }, organizationId);
          stopPolling(item.id);
          if (openIdRef.current === item.gallery_id) setItems(prev => prev.map(x => (x.id === item.id ? updated : x)));
          return;
        }
      } catch { /* tijdelijke fout — volgende poging */ }
      if (tries < 120) schedule(); else stopPolling(item.id);
    };
    schedule();
  }, [organizationId, refreshSession, stopPolling]);

  useEffect(() => {
    const timers = pollTimers.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    };
  }, []);

  // ── Galerij openen: items + favorieten + kijk-tokens laden ──
  useEffect(() => {
    // Polls en de tokenvernieuwing van de vórige galerij stoppen: hun tokens
    // horen bij een andere galerij en zouden de nieuwe weergave breken.
    for (const timer of pollTimers.current.values()) window.clearTimeout(timer);
    pollTimers.current.clear();
    if (refreshTimer.current) { window.clearTimeout(refreshTimer.current); refreshTimer.current = null; }

    if (!openId) { setItems([]); setCategories([]); setFavorites([]); setBundle(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setOnlyFavorites(false);
    setSelectMode(false);
    setSelectedIds(new Set());
    setShowCategories(false);
    (async () => {
      try {
        const [loadedItems] = await Promise.all([
          selectGalleryItems(organizationId, openId),
          refreshCategories(openId),
          refreshFavorites(openId),
          refreshSession(openId),
        ]);
        if (cancelled) return;
        setItems(loadedItems);
        loadedItems.filter(i => i.stream_uid && i.stream_status !== 'ready' && i.stream_status !== 'error').forEach(pollStreamItem);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Kon galerij niet laden.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [openId, organizationId, refreshCategories, refreshFavorites, refreshSession, pollStreamItem]);

  // ── Live favorieten (klant markeert in portaal/deellink) ──
  useEffect(() => {
    if (!openId) return;
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      const { data: sessionData } = await supabaseAuth.getSession();
      const token = sessionData.session?.access_token;
      if (!token || cancelled) return;
      supabase.realtime.setAuth(token);
      channel = supabase
        .channel(`gallery-fav-${openId}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'gallery_favorites', filter: `gallery_id=eq.${openId}` }, () => {
          void refreshFavorites(openId);
        })
        .subscribe();
    })();
    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [openId, refreshFavorites]);

  const favoriteCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const fav of favorites) map.set(fav.item_id, (map.get(fav.item_id) ?? 0) + 1);
    return map;
  }, [favorites]);

  // ── Aanmaken / verwijderen ──
  async function createGallery() {
    const title = newTitle.trim();
    if (!title || busy) return;
    setBusy(true);
    setError(null);
    try {
      const gallery = await insertRow<Gallery>('galleries', organizationId, { project_id: project.id, title, format: newFormat });
      setCreating(false);
      setNewTitle('');
      setNewFormat('hybrid');
      await onChanged();
      setOpenId(gallery.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Galerij aanmaken mislukt.');
    } finally {
      setBusy(false);
    }
  }

  async function removeGallery(gallery: Gallery) {
    if (!confirm(`Galerij “${gallery.title}” en alle media definitief verwijderen?`)) return;
    setBusy(true);
    setError(null);
    try {
      const galleryItems = openId === gallery.id ? items : await selectGalleryItems(organizationId, gallery.id);
      await deleteRow('galleries', gallery.id, organizationId);
      // Best-effort opruiming van R2 + Stream (DB-rijen zijn al weg via cascade).
      for (const item of galleryItems) {
        for (const key of [item.storage_key, item.preview_key, item.thumb_key]) {
          if (key) void deleteR2Object(key).catch(() => undefined);
        }
        if (item.stream_uid) void deleteGalleryStreamVideo(organizationId, item.stream_uid).catch(() => undefined);
      }
      if (openId === gallery.id) setOpenId(null);
      await onChanged();
      await refreshStorage();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verwijderen mislukt.');
    } finally {
      setBusy(false);
    }
  }

  // ── Upload ──
  function setQueueEntry(index: number, patch: Partial<QueueEntry>) {
    setQueue(prev => prev.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  }

  async function uploadOne(gallery: Gallery, file: File, sortOrder: number, onProgress: (detail: string) => void): Promise<GalleryItem> {
    const isPhoto = GALLERY_PHOTO_TYPES.has(file.type);
    const isVideo = file.type.startsWith('video/');
    if (!isPhoto && !isVideo) {
      throw new Error('Alleen JPEG-, PNG- of WebP-foto\'s en videobestanden worden ondersteund.');
    }
    // Het formaat van de galerij is leidend. De database weigert dit ook, maar
    // hier kunnen we het meteen en in begrijpelijke taal melden.
    if (gallery.format === 'photo' && isVideo) {
      throw new Error('Dit is een fotogalerij — video’s kunnen hier niet in. Wijzig het formaat in de instellingen naar “Foto én video”.');
    }
    if (gallery.format === 'video' && isPhoto) {
      throw new Error('Dit is een videogalerij — foto’s kunnen hier niet in. Wijzig het formaat in de instellingen naar “Foto én video”.');
    }
    if (file.size > GALLERY_ORIGINAL_MAX_BYTES) {
      throw new Error('Bestand is groter dan 4 GB.');
    }
    const uploadGroupId = crypto.randomUUID();

    if (isPhoto) {
      onProgress('previews maken…');
      const derived = await generateImageDerivatives(file);
      onProgress('uploaden…');
      // allSettled i.p.v. all: bij een gedeeltelijke fout kennen we de wél
      // geslaagde keys nog en kunnen we ze opruimen. Met Promise.all zouden die
      // bytes onzichtbaar in R2 achterblijven (en niet in het quotum tellen).
      const settled = await Promise.allSettled([
        uploadGalleryFileVariant(file, file.name, file.type, organizationId, gallery.id, uploadGroupId, 'original'),
        uploadGalleryFileVariant(derived.preview, `preview-${file.name}.jpg`, 'image/jpeg', organizationId, gallery.id, uploadGroupId, 'preview'),
        uploadGalleryFileVariant(derived.thumb, `thumb-${file.name}.jpg`, 'image/jpeg', organizationId, gallery.id, uploadGroupId, 'thumb'),
      ]);
      const failure = settled.find(result => result.status === 'rejected');
      if (failure) {
        for (const result of settled) {
          if (result.status === 'fulfilled') void deleteR2Object(result.value.key).catch(() => undefined);
        }
        throw (failure as PromiseRejectedResult).reason;
      }
      const [original, preview, thumb] = settled.map(result => (result as PromiseFulfilledResult<{ key: string; size: number }>).value);
      try {
        return await insertRow<GalleryItem>('gallery_items', organizationId, {
          gallery_id: gallery.id,
          media_type: 'photo',
          file_name: file.name,
          content_type: file.type,
          size_bytes: original.size,
          derived_bytes: preview.size + thumb.size,
          storage_key: original.key,
          preview_key: preview.key,
          thumb_key: thumb.key,
          width: derived.width,
          height: derived.height,
          sort_order: sortOrder,
        });
      } catch (e) {
        for (const key of [original.key, preview.key, thumb.key]) void deleteR2Object(key).catch(() => undefined);
        throw e;
      }
    }

    // Video: eerst een Stream-ticket vragen; 'r2' betekent fallback naar R2.
    onProgress('poster maken…');
    const poster = await captureVideoPoster(file);
    const ticket = await requestGalleryStreamUpload(organizationId, gallery.id, file.name, file.size);

    let thumbKey: string | null = null;
    let thumbSize = 0;
    if (poster.thumb) {
      const thumb = await uploadGalleryFileVariant(poster.thumb, `thumb-${file.name}.jpg`, 'image/jpeg', organizationId, gallery.id, uploadGroupId, 'thumb');
      thumbKey = thumb.key;
      thumbSize = thumb.size;
    }

    if (ticket.mode === 'r2') {
      onProgress('uploaden…');
      // Variant 'source': video's moeten afspeelbaar blijven met een kijk-token,
      // terwijl 'original' (foto's) juist alleen met downloadrecht wordt geserveerd.
      let original: { key: string; size: number };
      try {
        original = await uploadGalleryFileVariant(file, file.name, file.type, organizationId, gallery.id, uploadGroupId, 'source');
      } catch (e) {
        if (thumbKey) void deleteR2Object(thumbKey).catch(() => undefined);
        throw e;
      }
      try {
        return await insertRow<GalleryItem>('gallery_items', organizationId, {
          gallery_id: gallery.id,
          media_type: 'video',
          file_name: file.name,
          content_type: file.type,
          size_bytes: original.size,
          derived_bytes: thumbSize,
          storage_key: original.key,
          thumb_key: thumbKey,
          width: poster.width,
          height: poster.height,
          duration_seconds: poster.duration,
          sort_order: sortOrder,
        });
      } catch (e) {
        void deleteR2Object(original.key).catch(() => undefined);
        if (thumbKey) void deleteR2Object(thumbKey).catch(() => undefined);
        throw e;
      }
    }

    onProgress('uploaden naar Stream…');
    try {
      if (ticket.mode === 'stream-basic') {
        await streamBasicUpload(ticket.uploadURL, file);
      } else {
        await streamTusUpload(ticket.uploadURL, file, (fraction) => onProgress(`uploaden naar Stream… ${Math.round(fraction * 100)}%`));
      }
    } catch (e) {
      if (thumbKey) void deleteR2Object(thumbKey).catch(() => undefined);
      void deleteGalleryStreamVideo(organizationId, ticket.uid).catch(() => undefined);
      throw e;
    }
    try {
      const inserted = await insertRow<GalleryItem>('gallery_items', organizationId, {
        gallery_id: gallery.id,
        media_type: 'video',
        file_name: file.name,
        content_type: file.type,
        size_bytes: file.size,
        derived_bytes: thumbSize,
        thumb_key: thumbKey,
        width: poster.width,
        height: poster.height,
        duration_seconds: poster.duration,
        stream_uid: ticket.uid,
        stream_status: 'processing',
        sort_order: sortOrder,
      });
      pollStreamItem(inserted);
      return inserted;
    } catch (e) {
      if (thumbKey) void deleteR2Object(thumbKey).catch(() => undefined);
      void deleteGalleryStreamVideo(organizationId, ticket.uid).catch(() => undefined);
      throw e;
    }
  }

  async function handleFiles(fileList: FileList | null) {
    // Ook wachten op `loading`: vóórdat de bestaande items binnen zijn zou
    // nextSort op 0 beginnen en zouden nieuwe uploads tussen de bestaande
    // volgorde in springen.
    if (!openGallery || !fileList || fileList.length === 0 || busy || loading) return;
    const files = Array.from(fileList);
    const galleryId = openGallery.id;
    if (fileInputRef.current) fileInputRef.current.value = '';
    setBusy(true);
    setError(null);
    setQueue(files.map(file => ({ name: file.name, status: 'wacht' })));

    let nextSort = items.reduce((max, item) => Math.max(max, item.sort_order), -1) + 1;
    const sortOrders = files.map(() => nextSort++);
    let cursor = 0;
    const workerCount = Math.min(3, files.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= files.length) return;
        setQueueEntry(index, { status: 'bezig' });
        try {
          const inserted = await uploadOne(openGallery, files[index], sortOrders[index], (detail) => setQueueEntry(index, { detail }));
          // Alleen tonen als deze galerij nog open staat (anders zou een item
          // van galerij A in de lijst van galerij B belanden).
          if (openIdRef.current === galleryId) setItems(prev => [...prev, inserted]);
          setQueueEntry(index, { status: 'klaar', detail: undefined });
        } catch (e) {
          setQueueEntry(index, { status: 'fout', detail: e instanceof Error ? e.message : 'Upload mislukt.' });
        }
      }
    }));
    setBusy(false);
    await refreshStorage();
    // Nieuwe media = mogelijk nieuwe Stream-uids zonder token: sessie verversen.
    if (openIdRef.current === galleryId) await refreshSession(galleryId);
    window.setTimeout(() => setQueue(prev => (prev.every(q => q.status === 'klaar') ? [] : prev)), 4000);
  }

  // ── Item-acties ──
  async function removeItem(item: GalleryItem) {
    if (!openGallery) return;
    if (!confirm(`“${item.file_name}” verwijderen uit de galerij?`)) return;
    stopPolling(item.id);
    try {
      await deleteRow('gallery_items', item.id, organizationId);
      setItems(prev => prev.filter(x => x.id !== item.id));
      for (const key of [item.storage_key, item.preview_key, item.thumb_key]) {
        if (key) void deleteR2Object(key).catch(() => undefined);
      }
      if (item.stream_uid) void deleteGalleryStreamVideo(organizationId, item.stream_uid).catch(() => undefined);
      await refreshStorage();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verwijderen mislukt.');
    }
  }

  async function setCover(item: GalleryItem) {
    if (!openGallery) return;
    try {
      await updateRow<Gallery>('galleries', openGallery.id, { cover_item_id: item.id }, organizationId);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cover instellen mislukt.');
    }
  }

  /**
   * Werkt de galerij bij en gooit de fout dóór. De aanroeper (bijv. de
   * deellink-modal) moet weten of het opslaan écht is gelukt: anders zou een
   * mislukte update een deellink tonen waarvan de tokenhash nooit is bewaard.
   */
  // ── Categorieën ──
  async function addCategory(name: string) {
    if (!openGallery) return;
    const clean = name.trim();
    if (!clean) return;
    setError(null);
    try {
      const position = categories.reduce((max, c) => Math.max(max, c.position), -1) + 1;
      await insertRow<GalleryCategory>('gallery_categories', organizationId, {
        gallery_id: openGallery.id, name: clean, position,
      });
      setNewCategory('');
      await refreshCategories(openGallery.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Categorie toevoegen mislukt.');
    }
  }

  async function renameCategory(category: GalleryCategory, name: string) {
    const clean = name.trim();
    if (!openGallery || !clean || clean === category.name) return;
    setError(null);
    try {
      await updateRow<GalleryCategory>('gallery_categories', category.id, { name: clean }, organizationId);
      await refreshCategories(openGallery.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Hernoemen mislukt.');
      await refreshCategories(openGallery.id);
    }
  }

  /** Wisselt de positie met de buur; de volgorde bepaalt de secties bij de klant. */
  async function moveCategory(category: GalleryCategory, delta: number) {
    if (!openGallery) return;
    const index = categories.findIndex(c => c.id === category.id);
    const target = categories[index + delta];
    if (!target) return;
    setError(null);
    // Optimistisch omwisselen zodat de lijst niet zichtbaar "springt".
    setCategories(prev => {
      const next = [...prev];
      next[index] = target;
      next[index + delta] = category;
      return next;
    });
    try {
      await Promise.all([
        updateRow<GalleryCategory>('gallery_categories', category.id, { position: target.position }, organizationId),
        updateRow<GalleryCategory>('gallery_categories', target.id, { position: category.position }, organizationId),
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Volgorde wijzigen mislukt.');
    } finally {
      await refreshCategories(openGallery.id);
    }
  }

  async function removeCategory(category: GalleryCategory) {
    if (!openGallery) return;
    const count = items.filter(i => i.category_id === category.id).length;
    const vraag = count > 0
      ? `“${category.name}” verwijderen? De ${count} foto's erin blijven bestaan en komen onder “Overig” te staan.`
      : `“${category.name}” verwijderen?`;
    if (!confirm(vraag)) return;
    setError(null);
    try {
      await deleteRow('gallery_categories', category.id, organizationId);
      // De database zet category_id op null (on delete set null); lokaal meteen ook.
      setItems(prev => prev.map(i => (i.category_id === category.id ? { ...i, category_id: null } : i)));
      await refreshCategories(openGallery.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verwijderen mislukt.');
    }
  }

  /** Neemt de standaardlijst van de organisatie over (voegt alleen ontbrekende toe). */
  async function applyPresets() {
    if (!openGallery) return;
    setError(null);
    try {
      const list = presets.length > 0 ? presets : await selectGalleryCategoryPresets(organizationId);
      setPresets(list);
      if (list.length === 0) {
        setError('Je hebt nog geen standaardlijst. Stel hier categorieën in en kies “Als standaard opslaan”.');
        return;
      }
      const existing = new Set(categories.map(c => c.name.toLowerCase()));
      let position = categories.reduce((max, c) => Math.max(max, c.position), -1) + 1;
      for (const preset of list) {
        if (existing.has(preset.name.toLowerCase())) continue;
        await insertRow<GalleryCategory>('gallery_categories', organizationId, {
          gallery_id: openGallery.id, name: preset.name, position: position++,
        });
      }
      await refreshCategories(openGallery.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Standaardlijst overnemen mislukt.');
    }
  }

  /** Bewaart de huidige indeling als standaard voor nieuwe galerijen. */
  async function saveAsPresets() {
    setError(null);
    try {
      const saved = await replaceGalleryCategoryPresets(organizationId, categories.map(c => c.name));
      setPresets(saved);
      setMessage('Deze indeling is nu je standaardlijst voor nieuwe galerijen.');
      window.setTimeout(() => setMessage(null), 4000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Standaardlijst opslaan mislukt.');
    }
  }

  // ── Bulkselectie ──
  function toggleSelected(itemId: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId); else next.add(itemId);
      return next;
    });
  }

  async function assignSelectedTo(categoryId: string | null) {
    if (!openGallery || selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    setBusy(true);
    setError(null);
    try {
      await setGalleryItemsCategory(organizationId, ids, categoryId);
      setItems(prev => prev.map(i => (selectedIds.has(i.id) ? { ...i, category_id: categoryId } : i)));
      setSelectedIds(new Set());
      setSelectMode(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Toewijzen mislukt.');
    } finally {
      setBusy(false);
    }
  }

  async function patchGallery(gallery: Gallery, patch: Partial<Gallery>) {
    setBusy(true);
    setError(null);
    try {
      await updateRow<Gallery>('galleries', gallery.id, patch, organizationId);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Opslaan mislukt.');
      throw e;
    } finally {
      setBusy(false);
    }
  }

  function downloadItem(viewerItem: GalleryViewerItem) {
    if (!bundle) return;
    const item = items.find(x => x.id === viewerItem.id);
    if (!item) return;
    let url: string | null = null;
    if (item.storage_key) {
      url = galleryFileUrl(item.storage_key, bundle.mediaToken, { download: true });
    } else if (item.stream_uid && item.stream_playback_base && bundle.streamTokens[item.stream_uid]) {
      url = streamDownloadUrl(item.stream_playback_base, bundle.streamTokens[item.stream_uid]);
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

  const writable = canWrite && !project.archived;

  // ── Opslagmeter ──
  const storageBar = storage && (
    <div className="gal-storage" title="Accountbrede opslag (alle modules samen)">
      <HardDrive size={13} />
      <span>{fmtBytesShort(storage.used_bytes)}{storage.limit_bytes != null ? ` van ${fmtBytesShort(storage.limit_bytes)}` : ''}</span>
      {storage.limit_bytes != null && (
        <span className={`gal-storage-bar${storage.used_bytes / storage.limit_bytes >= 0.9 ? ' warn' : ''}`}>
          <span style={{ width: `${Math.min(100, (storage.used_bytes / storage.limit_bytes) * 100)}%` }} />
        </span>
      )}
    </div>
  );

  // ── Lijstweergave ──
  if (!openGallery) {
    return (
      <article className="client-panel">
        <div className="client-panel-head">
          <h3>Galerijen</h3>
          <div className="client-panel-head-right">
            {storageBar}
            <span>{galleries.length}</span>
            {writable && <Button variant="primary" onClick={() => setCreating(true)}>+ Nieuwe galerij</Button>}
          </div>
        </div>
        {error && <div className="error">{error}</div>}
        {creating && (
          <form className="gal-create" onSubmit={(e) => { e.preventDefault(); void createGallery(); }}>
            <fieldset className="gal-format-picker">
              <legend>Wat lever je op?</legend>
              <div className="gal-format-options">
                {galleryFormats.map(({ key, label, hint, Icon }) => (
                  <button
                    key={key}
                    type="button"
                    className={`gal-format-card${newFormat === key ? ' is-active' : ''}`}
                    onClick={() => setNewFormat(key)}
                    aria-pressed={newFormat === key}
                  >
                    <span className="gal-format-icon"><Icon size={19} /></span>
                    <span className="gal-format-label">{label}</span>
                    <span className="gal-format-hint">{hint}</span>
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="gal-create-row">
              <Input
                autoFocus
                placeholder="Naam van de galerij (bijv. Bruiloft — selectie)"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
              />
              <Button type="submit" variant="primary" disabled={busy || !newTitle.trim()}>Aanmaken</Button>
              <Button type="button" variant="ghost" onClick={() => { setCreating(false); setNewTitle(''); setNewFormat('hybrid'); }}>Annuleren</Button>
            </div>
          </form>
        )}
        {galleries.length === 0 && !creating && (
          <div className="client-empty-line">
            Nog geen galerijen bij dit project. Maak een galerij aan om foto&apos;s en video&apos;s op te leveren aan de klant.
          </div>
        )}
        <div className="gal-list">
          {galleries.map(gallery => {
            const { Icon } = formatConfig(gallery.format);
            return (
              <button key={gallery.id} type="button" className="gal-list-card" onClick={() => setOpenId(gallery.id)}>
                <span className={`gal-list-icon gal-fmt-${gallery.format}`}><Icon size={18} /></span>
                <span className="gal-list-main">
                  <span className="gal-list-title">{gallery.title}</span>
                  <span className="gal-list-sub">
                    <span className="gal-format-tag">{galleryFormatLabels[gallery.format]}</span>
                    {gallery.published_at ? `Gepubliceerd ${dateNL(gallery.published_at)}` : `Aangemaakt ${dateNL(gallery.created_at)}`}
                    {gallery.share_enabled && <> · <Link2 size={11} /> deellink actief</>}
                    {gallery.expires_at && <> · verloopt {dateNL(gallery.expires_at)}</>}
                  </span>
                </span>
                <span className={`status-pill gal-status-${gallery.status}`}>{galleryStatusLabels[gallery.status]}</span>
              </button>
            );
          })}
        </div>
      </article>
    );
  }

  // ── Detailweergave ──
  const shownItems: GalleryViewerItem[] = onlyFavorites ? items.filter(i => favoriteCounts.has(i.id)) : items;
  const favoriteTotal = favoriteCounts.size;

  return (
    <article className="client-panel gal-detail">
      <div className="client-panel-head">
        <div className="gal-detail-title">
          <button type="button" className="gal-back" onClick={() => setOpenId(null)}>← Galerijen</button>
          <h3>{openGallery.title}</h3>
          <span className={`gal-format-tag gal-fmt-${openGallery.format}`}>{galleryFormatLabels[openGallery.format]}</span>
          <span className={`status-pill gal-status-${openGallery.status}`}>{galleryStatusLabels[openGallery.status]}</span>
        </div>
        <div className="client-panel-head-right gal-detail-tools">
          {storageBar}
          {favoriteTotal > 0 && (
            <button
              type="button"
              className={`gal-fav-filter${onlyFavorites ? ' active' : ''}`}
              onClick={() => setOnlyFavorites(v => !v)}
              title="Alleen favorieten van de klant tonen"
            >
              <Heart size={13} fill="currentColor" /> {favoriteTotal}
            </button>
          )}
          {openGallery.allow_downloads && bundle && items.some(i => i.storage_key || i.preview_key) && (
            <a className="btn" href={galleryZipUrl(openGallery.id, bundle.mediaToken)} download title="Alle bestanden als zip">
              <Download size={14} /> Zip
            </a>
          )}
          {writable && (
            <>
              <Button
                onClick={() => {
                  setShowCategories(v => !v);
                  if (presets.length === 0) void selectGalleryCategoryPresets(organizationId).then(setPresets).catch(() => undefined);
                }}
              >
                <FolderTree size={14} /> Categorieën{categories.length > 0 ? ` (${categories.length})` : ''}
              </Button>
              {items.length > 0 && categories.length > 0 && (
                <Button
                  onClick={() => { setSelectMode(v => !v); setSelectedIds(new Set()); }}
                  variant={selectMode ? 'primary' : undefined}
                >
                  <CheckSquare size={14} /> {selectMode ? 'Selectie stoppen' : 'Indelen'}
                </Button>
              )}
              <Button onClick={() => setShowShare(true)}><Link2 size={14} /> Delen</Button>
              <Button onClick={() => setShowSettings(true)}><Settings2 size={14} /> Instellingen</Button>
              {openGallery.status !== 'published'
                ? <Button variant="primary" disabled={busy} onClick={() => { void patchGallery(openGallery, { status: 'published' }).catch(() => undefined); }}>Publiceren</Button>
                : <Button disabled={busy} onClick={() => { void patchGallery(openGallery, { status: 'draft' }).catch(() => undefined); }}>Terug naar concept</Button>}
              <Button variant="primary" disabled={busy || loading} onClick={() => fileInputRef.current?.click()}>
                {busy ? <Loader2 size={14} className="gal-spin" /> : <Upload size={14} />} Uploaden
              </Button>
            </>
          )}
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {message && <div className="gal-notice">{message}</div>}

      {showCategories && writable && (
        <div className="gal-cats">
          <div className="gal-cats-head">
            <strong>Categorieën</strong>
            <span className="gal-cats-help">Bepalen de secties die de klant bovenaan als knoppen ziet.</span>
            <span className="gal-modal-spacer" />
            <Button onClick={() => void applyPresets()}>Standaardlijst overnemen</Button>
            <Button onClick={() => void saveAsPresets()} disabled={categories.length === 0}>Als standaard opslaan</Button>
          </div>
          {categories.length === 0 && (
            <div className="client-empty-line">
              Nog geen categorieën. Voeg er hieronder een toe, of neem je standaardlijst over.
            </div>
          )}
          <ul className="gal-cat-list">
            {categories.map((category, index) => {
              const count = items.filter(i => i.category_id === category.id).length;
              return (
                <li key={category.id} className="gal-cat-row">
                  <Input
                    defaultValue={category.name}
                    onBlur={(e) => void renameCategory(category, e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    aria-label={`Naam van ${category.name}`}
                  />
                  <span className="gal-cat-count">{count} {count === 1 ? 'item' : 'items'}</span>
                  <button type="button" className="icon-btn" disabled={index === 0} onClick={() => void moveCategory(category, -1)} title="Omhoog"><ChevronUp size={14} /></button>
                  <button type="button" className="icon-btn" disabled={index === categories.length - 1} onClick={() => void moveCategory(category, 1)} title="Omlaag"><ChevronDown size={14} /></button>
                  <button type="button" className="icon-btn danger" onClick={() => void removeCategory(category)} title="Verwijderen"><Trash2 size={14} /></button>
                </li>
              );
            })}
          </ul>
          <form className="gal-cat-add" onSubmit={(e) => { e.preventDefault(); void addCategory(newCategory); }}>
            <Input
              placeholder="Nieuwe categorie (bijv. Ceremonie)"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              maxLength={60}
            />
            <Button type="submit" variant="primary" disabled={!newCategory.trim()}><Plus size={14} /> Toevoegen</Button>
          </form>
        </div>
      )}

      {selectMode && (
        <div className="gal-selectbar">
          <strong>{selectedIds.size} geselecteerd</strong>
          <button type="button" className="gal-linkbtn" onClick={() => setSelectedIds(new Set(shownItems.map(i => i.id)))}>Alles</button>
          <button type="button" className="gal-linkbtn" onClick={() => setSelectedIds(new Set())}>Niets</button>
          <span className="gal-modal-spacer" />
          <Select
            inline
            value=""
            disabled={selectedIds.size === 0 || busy}
            onChange={(e) => {
              const value = e.target.value;
              if (!value) return;
              void assignSelectedTo(value === '__none__' ? null : value);
            }}
            aria-label="Toewijzen aan categorie"
          >
            <option value="">Verplaats naar…</option>
            {categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
            <option value="__none__">Geen categorie</option>
          </Select>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={formatConfig(openGallery.format).accept}
        style={{ display: 'none' }}
        onChange={(e) => void handleFiles(e.target.files)}
      />

      {queue.length > 0 && (
        <div className="gal-queue">
          {queue.map((entry, i) => (
            <div key={i} className={`gal-queue-row is-${entry.status}`}>
              <span className="gal-queue-name">{entry.name}</span>
              <span className="gal-queue-status">
                {entry.status === 'wacht' && 'Wachten…'}
                {entry.status === 'bezig' && (entry.detail || 'Bezig…')}
                {entry.status === 'klaar' && 'Klaar'}
                {entry.status === 'fout' && (entry.detail || 'Mislukt')}
              </span>
            </div>
          ))}
        </div>
      )}

      {loading
        ? <div className="galv-empty">Galerij wordt geladen…</div>
        : (
          <GalleryViewer
            items={shownItems}
            bundle={bundle}
            allowDownload
            format={openGallery.format}
            categories={categories}
            hero={{
              template: openGallery.hero_template,
              title: openGallery.title,
              description: openGallery.description,
              itemId: openGallery.cover_item_id,
            }}
            favoriteCounts={favoriteCounts}
            canFavorite={false}
            selectable={selectMode}
            selected={selectedIds}
            onToggleSelect={(item) => toggleSelected(item.id)}
            onDownloadItem={downloadItem}
            emptyText={onlyFavorites
              ? 'De klant heeft nog geen favorieten gemarkeerd.'
              : openGallery.format === 'video'
                ? 'Nog geen video’s. Upload je films om de galerij te vullen.'
                : openGallery.format === 'photo'
                  ? 'Nog geen foto’s. Upload je beelden om de galerij te vullen.'
                  : 'Nog geen media. Upload foto’s of video’s om de galerij te vullen.'}
            renderItemActions={(viewerItem) => writable && (
              <>
                <button
                  type="button"
                  className={`galv-tool${openGallery.cover_item_id === viewerItem.id ? ' active' : ''}`}
                  onClick={(e) => { e.stopPropagation(); const item = items.find(x => x.id === viewerItem.id); if (item) void setCover(item); }}
                  title={openGallery.cover_item_id === viewerItem.id ? 'Dit is de cover' : 'Als cover instellen'}
                >
                  <Star size={14} fill={openGallery.cover_item_id === viewerItem.id ? 'currentColor' : 'none'} />
                </button>
                <button
                  type="button"
                  className="galv-tool danger"
                  onClick={(e) => { e.stopPropagation(); const item = items.find(x => x.id === viewerItem.id); if (item) void removeItem(item); }}
                  title="Verwijderen"
                >
                  <Trash2 size={14} />
                </button>
              </>
            )}
          />
        )}

      {showSettings && (
        <GallerySettingsModal
          gallery={openGallery}
          busy={busy}
          onClose={() => setShowSettings(false)}
          onSave={async (patch) => { await patchGallery(openGallery, patch); setShowSettings(false); }}
          onDelete={writable ? () => { setShowSettings(false); void removeGallery(openGallery); } : undefined}
        />
      )}
      {showShare && (
        <GalleryShareModal
          gallery={openGallery}
          busy={busy}
          onClose={() => setShowShare(false)}
          onPatch={(patch) => patchGallery(openGallery, patch)}
        />
      )}
    </article>
  );
}

// ── Instellingen ────────────────────────────────────────────────────────────

function GallerySettingsModal({ gallery, busy, onClose, onSave, onDelete }: {
  gallery: Gallery;
  busy: boolean;
  onClose: () => void;
  onSave: (patch: Partial<Gallery>) => Promise<void>;
  onDelete?: () => void;
}) {
  const [title, setTitle] = useState(gallery.title);
  const [description, setDescription] = useState(gallery.description ?? '');
  const [format, setFormat] = useState<GalleryFormat>(gallery.format);
  const [heroTemplate, setHeroTemplate] = useState<GalleryHeroTemplate>(gallery.hero_template);
  const [allowDownloads, setAllowDownloads] = useState(gallery.allow_downloads);
  const [quality, setQuality] = useState(gallery.download_quality);
  const [expiresAt, setExpiresAt] = useState(gallery.expires_at ? gallery.expires_at.slice(0, 10) : '');
  const [saveError, setSaveError] = useState<string | null>(null);

  // Alleen sluiten wanneer het opslaan écht gelukt is; anders zou de gebruiker
  // denken dat de instelling is toegepast terwijl er niets is opgeslagen.
  async function save(patch: Partial<Gallery>) {
    setSaveError(null);
    try {
      await onSave(patch);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Opslaan mislukt.');
    }
  }

  return (
    <div className="bk-modal-backdrop" onClick={onClose}>
      <div className="bk-modal gal-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Galerij-instellingen</h3>
        <div className="bk-modal-body gal-modal-body">
          <label className="gal-field">
            <span>Titel</span>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="gal-field">
            <span>Omschrijving (zichtbaar voor de klant)</span>
            <textarea className="form-input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <div className="gal-field">
            <span>Formaat</span>
            <div className="gal-format-options is-compact">
              {galleryFormats.map(({ key, label, Icon }) => (
                <button
                  key={key}
                  type="button"
                  className={`gal-format-card${format === key ? ' is-active' : ''}`}
                  onClick={() => setFormat(key)}
                  aria-pressed={format === key}
                >
                  <span className="gal-format-icon"><Icon size={16} /></span>
                  <span className="gal-format-label">{label}</span>
                </button>
              ))}
            </div>
            <p className="gal-field-help">
              Beperken kan alleen zolang er geen media in staan die er dan uit zouden vallen; “Foto én video” kan altijd.
            </p>
          </div>
          <div className="gal-field">
            <span>Opening (hero)</span>
            <div className="gal-format-options is-compact gal-hero-options">
              {heroTemplates.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  className={`gal-format-card${heroTemplate === key ? ' is-active' : ''}`}
                  onClick={() => setHeroTemplate(key)}
                  aria-pressed={heroTemplate === key}
                >
                  <span className={`gal-hero-thumb gal-hero-thumb-${key}`} aria-hidden="true" />
                  <span className="gal-format-label">{label}</span>
                </button>
              ))}
            </div>
            <p className="gal-field-help">
              De hero-foto is de coverfoto: kies die met het sterretje op een foto in de galerij.
            </p>
          </div>
          <label className="gal-field gal-field-row">
            <input type="checkbox" checked={allowDownloads} onChange={(e) => setAllowDownloads(e.target.checked)} />
            <span>Klant mag downloaden</span>
          </label>
          {allowDownloads && (
            <label className="gal-field">
              <span>Downloadkwaliteit</span>
              <Select value={quality} onChange={(e) => setQuality(e.target.value as Gallery['download_quality'])}>
                <option value="original">Originele bestanden (full-res)</option>
                <option value="web">Webresolutie (kleiner, sneller)</option>
              </Select>
            </label>
          )}
          <label className="gal-field">
            <span>Klanttoegang verloopt op (leeg = nooit)</span>
            <Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </label>
          {saveError && <div className="error">{saveError}</div>}
        </div>
        <div className="bk-modal-actions gal-modal-actions">
          {onDelete && <Button variant="danger" onClick={onDelete} disabled={busy}><Trash2 size={14} /> Verwijderen</Button>}
          <span className="gal-modal-spacer" />
          <Button variant="ghost" onClick={onClose} disabled={busy}>Annuleren</Button>
          <Button
            variant="primary"
            disabled={busy || !title.trim()}
            onClick={() => void save({
              title: title.trim(),
              description: description.trim() || null,
              format,
              hero_template: heroTemplate,
              allow_downloads: allowDownloads,
              download_quality: quality,
              expires_at: expiresAt ? new Date(`${expiresAt}T23:59:59`).toISOString() : null,
            })}
          >
            {busy ? 'Bezig…' : 'Opslaan'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Deellink ────────────────────────────────────────────────────────────────

function GalleryShareModal({ gallery, busy, onClose, onPatch }: {
  gallery: Gallery;
  busy: boolean;
  onClose: () => void;
  onPatch: (patch: Partial<Gallery>) => Promise<void>;
}) {
  const [pin, setPin] = useState('');
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setError(null);
    const cleanPin = pin.trim();
    if (cleanPin && !/^\d{6,8}$/.test(cleanPin)) {
      setError('Pincode moet 6 tot 8 cijfers zijn.');
      return;
    }
    const token = randomShareToken();
    const tokenHash = await sha256Hex(token);
    // De pincode wordt gehasht met het (hoog-entropie) token als zout; de
    // database kent alleen hashes. Pincode wijzigen = nieuwe link genereren.
    const pinHash = cleanPin ? await sha256Hex(`${token}:${cleanPin}`) : null;
    try {
      await onPatch({
        share_enabled: true,
        share_token_hash: tokenHash,
        share_pin_hash: pinHash,
        share_pin_failed_count: 0,
        share_pin_locked_until: null,
      });
    } catch (e) {
      // Nooit een link tonen die niet is opgeslagen: die zou bij de ontvanger
      // op "deze galerijlink bestaat niet" uitkomen.
      setError(e instanceof Error ? e.message : 'Deellink opslaan mislukt. Probeer het opnieuw.');
      return;
    }
    setGeneratedUrl(`${window.location.origin}/gallerij/${token}`);
    setCopied(false);
  }

  async function revoke() {
    setError(null);
    try {
      await onPatch({ share_enabled: false, share_token_hash: null, share_pin_hash: null });
      setGeneratedUrl(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Deellink intrekken mislukt. Probeer het opnieuw.');
    }
  }

  async function copyUrl() {
    if (!generatedUrl) return;
    try {
      await navigator.clipboard.writeText(generatedUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Kopiëren naar het klembord mislukte — selecteer de link handmatig.');
    }
  }

  return (
    <div className="bk-modal-backdrop" onClick={onClose}>
      <div className="bk-modal gal-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Galerij delen</h3>
        <div className="bk-modal-body gal-modal-body">
          <p className="gal-share-note">
            Contactpersonen met portaaltoegang zien gepubliceerde galerijen automatisch in het klantportaal.
            Daarnaast kun je een publieke deellink maken voor wie geen portaal-account heeft.
          </p>
          {gallery.share_enabled && !generatedUrl && (
            <p className="gal-share-note gal-share-active">
              <Link2 size={13} /> Er is al een deellink actief{gallery.share_pin_hash ? ' (met pincode)' : ''}.
              Om veiligheidsredenen tonen we de link maar één keer — genereer een nieuwe als je hem kwijt bent (de oude vervalt dan).
            </p>
          )}
          <label className="gal-field">
            <span>Pincode (optioneel, 6–8 cijfers)</span>
            <Input inputMode="numeric" placeholder="Bijv. 240826" value={pin} onChange={(e) => setPin(e.target.value)} maxLength={8} />
          </label>
          {generatedUrl && (
            <div className="gal-share-url">
              <code>{generatedUrl}</code>
              <Button onClick={() => void copyUrl()}><Copy size={13} /> {copied ? 'Gekopieerd!' : 'Kopiëren'}</Button>
            </div>
          )}
          {error && <div className="error">{error}</div>}
        </div>
        <div className="bk-modal-actions gal-modal-actions">
          {gallery.share_enabled && (
            <Button variant="danger" disabled={busy} onClick={() => void revoke()}>
              Deellink intrekken
            </Button>
          )}
          <span className="gal-modal-spacer" />
          <Button variant="ghost" onClick={onClose} disabled={busy}>Sluiten</Button>
          <Button variant="primary" disabled={busy} onClick={() => void generate()}>
            {gallery.share_enabled ? 'Nieuwe link genereren' : 'Deellink maken'}
          </Button>
        </div>
      </div>
    </div>
  );
}
