// Galerij-oplevering binnen een project: galerijen aanmaken en beheren,
// foto's/video's uploaden (full-res naar R2, video bij voorkeur naar
// Cloudflare Stream), publiceren richting het klantportaal en een publieke
// deellink (met optionele pincode) uitgeven. Favorieten van de klant komen
// hier live terug (realtime op gallery_favorites).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import {
  ArrowUpDown, CheckSquare, ChevronDown, ChevronUp, Copy, Download, Film, FolderTree, HardDrive, Heart,
  Image as ImageIcon, Layers, Link2, Loader2, Pencil, Plus, Settings2, Sparkles, SlidersHorizontal, Star,
  Trash2, Upload, UploadCloud, X,
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
  setGalleryItemOrder, setGalleryItemsCategory, updateRow,
} from '../lib/repository';
import { deleteR2Object } from '../lib/r2-api';
import {
  GALLERY_MASTER_MAX_BYTES, GALLERY_MULTIPART_THRESHOLD_BYTES, GALLERY_ORIGINAL_MAX_BYTES, GALLERY_PHOTO_TYPES,
  captureVideoPoster, createGalleryViewSession, deleteGalleryStreamVideo, galleryFileUrl,
  galleryRefreshDelayMs, galleryZipUrl,
  generateImageDerivatives, getGalleryStreamStatus, requestGalleryStreamCopy,
  streamDownloadUrl, uploadGalleryFile, uploadGalleryFileVariant, type GalleryTokenBundle,
} from '../lib/gallery';
import { GalleryViewer, galleryItemThumbUrl, hasZippableItems, type GalleryViewerItem } from './GalleryViewer';

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

/**
 * De openingen, gegroepeerd op karakter. Het miniatuur bij elke keuze is puur
 * CSS — geen echte foto nodig om de opbouw te laten zien.
 */
const heroGroups: Array<{ group: string; options: Array<{ key: GalleryHeroTemplate; label: string; hint: string }> }> = [
  {
    group: 'Basis',
    options: [
      { key: 'full', label: 'Volledig beeld', hint: 'Beeldvullend met de titel eroverheen.' },
      { key: 'minimal', label: 'Alleen tekst', hint: 'Geen hero-foto; direct de galerij.' },
    ],
  },
  {
    group: 'Modern',
    options: [
      { key: 'editorial', label: 'Editorial', hint: 'Asymmetrisch; grote titel valt over het beeld.' },
      { key: 'frame', label: 'Kader', hint: 'Beeld in een ruim kader, titel in kapitalen.' },
      { key: 'split', label: 'Beeld naast tekst', hint: 'Half beeld, half tekst.' },
    ],
  },
  {
    group: 'Klassiek',
    options: [
      { key: 'classic', label: 'Klassiek', hint: 'Serif-titel tussen dunne lijnen, veel rust.' },
      { key: 'collage', label: 'Collage', hint: 'Eén groot beeld met twee kleinere.' },
    ],
  },
  {
    group: 'Spectaculair',
    options: [
      { key: 'netflix', label: 'Kopvideo', hint: 'Eén video groot in beeld die stil meespeelt; de rest in rijen eronder.' },
      { key: 'cinematic', label: 'Cinematisch', hint: 'Trage zoom op het beeld, titel zweeft in.' },
      { key: 'mosaic', label: 'Mozaïek', hint: 'Negen beelden achter een gecentreerde titel.' },
    ],
  },
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

/**
 * Het sterretje wijst de opening aan. Bij een video heet dat een kopvideo en bij
 * een foto een cover — het is hetzelfde veld (`cover_item_id`), maar de gebruiker
 * denkt in het ene of het andere.
 */
function coverLabel(item: GalleryViewerItem, isCurrent: boolean): string {
  if (item.media_type === 'video') return isCurrent ? 'Dit is de kopvideo' : 'Als kopvideo instellen';
  return isCurrent ? 'Dit is de cover' : 'Als cover instellen';
}

/** Past dit bestand in een galerij van dit formaat? Spiegelt de DB-trigger. */
function fileFitsFormat(format: GalleryFormat, file: File): boolean {
  const isPhoto = GALLERY_PHOTO_TYPES.has(file.type);
  const isVideo = file.type.startsWith('video/');
  if (format === 'photo') return isPhoto;
  if (format === 'video') return isVideo;
  return isPhoto || isVideo;
}

/**
 * Bestanden uit een sleepactie halen. Beeldmakers slepen zelden losse foto's:
 * ze pakken de hele exportmap. `webkitGetAsEntry` laat ons daar doorheen lopen,
 * inclusief submappen. Waar die API ontbreekt (of bij een gewone bestandssleep)
 * valt alles terug op `dataTransfer.files`.
 *
 * LET OP: de DataTransfer is alleen geldig zolang de drop-handler loopt, dus de
 * entries worden hier synchroon uitgelezen — vóór de eerste await.
 */
async function filesFromDataTransfer(transfer: DataTransfer): Promise<File[]> {
  const entries = Array.from(transfer.items ?? [])
    .filter(item => item.kind === 'file')
    .map(item => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null));
  const direct = Array.from(transfer.files ?? []);
  if (entries.every(entry => entry == null)) return direct;

  const files: File[] = [];
  const walk = async (entry: FileSystemEntry | null): Promise<void> => {
    if (!entry) return;
    if (entry.isFile) {
      const file = await new Promise<File | null>(resolve => {
        (entry as FileSystemFileEntry).file(resolve, () => resolve(null));
      });
      if (file) files.push(file);
      return;
    }
    if (!entry.isDirectory) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries levert per aanroep maximaal ~100 items; doorlezen tot leeg,
    // anders mist een map met 300 foto's er stilzwijgend 200.
    for (let guard = 0; guard < 400; guard += 1) {
      const batch = await new Promise<FileSystemEntry[]>(resolve => {
        reader.readEntries(resolve, () => resolve([]));
      });
      if (batch.length === 0) return;
      for (const child of batch) await walk(child);
    }
  };
  for (const entry of entries) await walk(entry);
  // Niets gevonden (bijv. een geweigerde map) — dan liever de platte lijst dan niets.
  return files.length > 0 ? files : direct;
}

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
  const [selectMode, setSelectMode] = useState(false);
  const [orderMode, setOrderMode] = useState(false);
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
  const [settingsTab, setSettingsTab] = useState<GallerySettingsTab | null>(null);
  const [showShare, setShowShare] = useState(false);
  // Slepen over het paneel: de teller vangt de dragenter/dragleave van elk
  // onderliggend element op, zodat de melding niet knippert.
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);

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
    setSettingsTab(null);
    setShowShare(false);
    dragDepth.current = 0;
    setDragActive(false);
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

  // Favorieten = de persoonlijke selectie van kijkers; likes = de zichtbare
  // waardering. Beide komen uit dezelfde tabel, gescheiden op `reaction`.
  const favoriteCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of favorites) {
      if ((row.reaction ?? 'favorite') !== 'favorite') continue;
      map.set(row.item_id, (map.get(row.item_id) ?? 0) + 1);
    }
    return map;
  }, [favorites]);

  const likeCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of favorites) {
      if (row.reaction !== 'like') continue;
      map.set(row.item_id, (map.get(row.item_id) ?? 0) + 1);
    }
    return map;
  }, [favorites]);

  // ── Aanmaken / verwijderen ──
  async function createGallery() {
    const title = newTitle.trim();
    if (!title || busy) return;
    setBusy(true);
    setError(null);
    try {
      const gallery = await insertRow<Gallery>('galleries', organizationId, {
        project_id: project.id,
        title,
        format: newFormat,
        // Een videogalerij opent standaard filmisch; dat is waar het formaat om
        // vraagt. Aan te passen in de instellingen onder "Opening".
        hero_template: newFormat === 'video' ? 'netflix' : 'full',
      });
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
    if (isVideo && file.size > GALLERY_MASTER_MAX_BYTES) {
      throw new Error('Video is groter dan 30 GB — daar kan Cloudflare Stream geen kijkkopie van maken.');
    }
    if (isPhoto && file.size > GALLERY_ORIGINAL_MAX_BYTES) {
      throw new Error('Foto is groter dan 4 GB.');
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
        // Een foto van 100 megapixel haalt de 64 MB per request; uploadGalleryFile
        // schakelt dan zelf over op delen.
        uploadGalleryFile(file, file.name, file.type, organizationId, gallery.id, uploadGroupId, 'original'),
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

    // ── Video ──
    // De master gaat naar R2: dát is wat de klant downloadt, in de originele
    // resolutie. Cloudflare Stream haalt hem daar vervolgens zélf op voor de
    // kijkkopie — één upload, twee producten. Stream geeft het bronbestand
    // nooit terug, dus zonder deze R2-kopie zou het origineel verloren zijn.
    onProgress('poster maken…');
    const poster = await captureVideoPoster(file);

    let thumbKey: string | null = null;
    let thumbSize = 0;
    if (poster.thumb) {
      const thumb = await uploadGalleryFileVariant(poster.thumb, `thumb-${file.name}.jpg`, 'image/jpeg', organizationId, gallery.id, uploadGroupId, 'thumb');
      thumbKey = thumb.key;
      thumbSize = thumb.size;
    }

    let master: { key: string; size: number };
    try {
      master = await uploadGalleryFile(
        file, file.name, file.type, organizationId, gallery.id, uploadGroupId, 'master',
        (done, totaal) => onProgress(`uploaden… ${Math.round((done / totaal) * 100)}%`),
      );
    } catch (e) {
      if (thumbKey) void deleteR2Object(thumbKey).catch(() => undefined);
      throw e;
    }

    // De kijkkopie is nadrukkelijk niet-blokkerend: de master staat er al, en een
    // galerij met een origineel maar zonder speler is beter dan een mislukte
    // upload van tientallen gigabytes.
    onProgress('kijkkopie aanmaken…');
    let streamUid: string | null = null;
    try {
      const copy = await requestGalleryStreamCopy(organizationId, gallery.id, master.key, file.name);
      if (copy.mode === 'stream') streamUid = copy.uid;
    } catch {
      /* geen kijkkopie — het item toont dat zelf */
    }

    try {
      const inserted = await insertRow<GalleryItem>('gallery_items', organizationId, {
        gallery_id: gallery.id,
        media_type: 'video',
        file_name: file.name,
        content_type: file.type,
        size_bytes: master.size,
        derived_bytes: thumbSize,
        storage_key: master.key,
        thumb_key: thumbKey,
        width: poster.width,
        height: poster.height,
        duration_seconds: poster.duration,
        stream_uid: streamUid,
        stream_status: streamUid ? 'processing' : null,
        sort_order: sortOrder,
      });
      if (streamUid) pollStreamItem(inserted);
      return inserted;
    } catch (e) {
      void deleteR2Object(master.key).catch(() => undefined);
      if (thumbKey) void deleteR2Object(thumbKey).catch(() => undefined);
      if (streamUid) void deleteGalleryStreamVideo(organizationId, streamUid).catch(() => undefined);
      throw e;
    }
  }

  async function handleFiles(fileList: FileList | File[] | null) {
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
    // Grote bestanden gaan in delen van 64 MB. Drie daarvan tegelijk duwt
    // honderden megabytes door het geheugen en maakt de upload juist trager;
    // bij een video-master doen we er dus één tegelijk.
    const hasLarge = files.some(file => file.size > GALLERY_MULTIPART_THRESHOLD_BYTES);
    const workerCount = hasLarge ? 1 : Math.min(3, files.length);
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

  /**
   * Bestanden die op het paneel worden losgelaten. Wat niet in dit galerij-
   * formaat past (RAW-bestanden, sidecars, .DS_Store uit een gesleepte map)
   * wordt overgeslagen en één keer geteld gemeld — niet als losse fouten in de
   * wachtrij, want dan verdwijnt het echte werk uit beeld.
   */
  async function handleDrop(transfer: DataTransfer) {
    if (!openGallery) return;
    if (busy || loading) {
      setError('Er loopt al een upload. Wacht tot die klaar is en sleep daarna opnieuw.');
      return;
    }
    let dropped: File[] = [];
    try {
      dropped = await filesFromDataTransfer(transfer);
    } catch {
      setError('Kon de gesleepte bestanden niet lezen. Gebruik anders de knop “Uploaden”.');
      return;
    }
    const usable = dropped.filter(file => fileFitsFormat(openGallery.format, file));
    const skipped = dropped.length - usable.length;
    if (usable.length === 0) {
      setError(dropped.length === 0
        ? 'Er zaten geen bestanden in wat je losliet.'
        : openGallery.format === 'photo'
          ? 'Geen bruikbare foto’s gevonden. Deze galerij accepteert JPEG, PNG of WebP.'
          : openGallery.format === 'video'
            ? 'Geen bruikbare video’s gevonden in wat je losliet.'
            : 'Geen bruikbare foto’s of video’s gevonden. Foto’s moeten JPEG, PNG of WebP zijn.');
      return;
    }
    if (skipped > 0) {
      setMessage(`${skipped} bestand${skipped === 1 ? '' : 'en'} overgeslagen — die passen niet in deze galerij.`);
      window.setTimeout(() => setMessage(null), 6000);
    }
    await handleFiles(usable);
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
  // Deze acties gooien hun fout dóór: ze worden bediend vanuit het venster
  // "Bestanden", en een melding die achter dat venster verschijnt ziet niemand.
  async function addCategory(name: string) {
    if (!openGallery) return;
    const clean = name.trim();
    if (!clean) return;
    const position = categories.reduce((max, c) => Math.max(max, c.position), -1) + 1;
    await insertRow<GalleryCategory>('gallery_categories', organizationId, {
      gallery_id: openGallery.id, name: clean, position,
    });
    await refreshCategories(openGallery.id);
  }

  async function renameCategory(category: GalleryCategory, name: string) {
    const clean = name.trim();
    if (!openGallery || !clean || clean === category.name) return;
    try {
      await updateRow<GalleryCategory>('gallery_categories', category.id, { name: clean }, organizationId);
    } finally {
      // Ook na een mislukking opnieuw laden: dan staat de oude naam er weer,
      // in plaats van een naam die alleen in het invoerveld bestaat.
      await refreshCategories(openGallery.id);
    }
  }

  /** Wisselt de positie met de buur; de volgorde bepaalt de secties bij de klant. */
  async function moveCategory(category: GalleryCategory, delta: number) {
    if (!openGallery) return;
    const index = categories.findIndex(c => c.id === category.id);
    const target = categories[index + delta];
    if (!target) return;
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
    } finally {
      await refreshCategories(openGallery.id);
    }
  }

  async function removeCategory(category: GalleryCategory) {
    if (!openGallery) return;
    const count = items.filter(i => i.category_id === category.id).length;
    const vraag = count > 0
      ? `“${category.name}” verwijderen? De ${count} bestanden erin blijven bestaan en komen onder “Zonder categorie” te staan.`
      : `“${category.name}” verwijderen?`;
    if (!confirm(vraag)) return;
    await deleteRow('gallery_categories', category.id, organizationId);
    // De database zet category_id op null (on delete set null); lokaal meteen ook.
    setItems(prev => prev.map(i => (i.category_id === category.id ? { ...i, category_id: null } : i)));
    await refreshCategories(openGallery.id);
  }

  /** Neemt de standaardlijst van de organisatie over (voegt alleen ontbrekende toe). */
  async function applyPresets() {
    if (!openGallery) return;
    const list = presets.length > 0 ? presets : await selectGalleryCategoryPresets(organizationId);
    setPresets(list);
    if (list.length === 0) {
      throw new Error('Je hebt nog geen standaardlijst. Maak hier categorieën aan en kies “Als standaard opslaan”.');
    }
    const existing = new Set(categories.map(c => c.name.toLowerCase()));
    let position = categories.reduce((max, c) => Math.max(max, c.position), -1) + 1;
    try {
      for (const preset of list) {
        if (existing.has(preset.name.toLowerCase())) continue;
        await insertRow<GalleryCategory>('gallery_categories', organizationId, {
          gallery_id: openGallery.id, name: preset.name, position: position++,
        });
      }
    } finally {
      await refreshCategories(openGallery.id);
    }
  }

  /** Bewaart de huidige indeling als standaard voor nieuwe galerijen. */
  async function saveAsPresets() {
    setPresets(await replaceGalleryCategoryPresets(organizationId, categories.map(c => c.name)));
  }

  // ── Volgorde ──
  /** Schrijft de opgegeven volgorde weg en houdt de lokale lijst gelijk. */
  async function persistOrder(ordered: GalleryItem[]) {
    if (!openGallery) return;
    const renumbered = ordered.map((item, index) => ({ ...item, sort_order: index }));
    setItems(renumbered);
    try {
      await setGalleryItemOrder(openGallery.id, renumbered.map(i => i.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Volgorde opslaan mislukt.');
      // Terug naar de opgeslagen waarheid, anders zie je een volgorde die niet bestaat.
      const fresh = await selectGalleryItems(organizationId, openGallery.id).catch(() => null);
      if (fresh && openIdRef.current === openGallery.id) setItems(fresh);
    }
  }

  function sortItems(mode: 'name' | 'name-desc' | 'oldest' | 'newest') {
    const sorted = [...items].sort((a, b) => {
      switch (mode) {
        case 'name': return a.file_name.localeCompare(b.file_name, 'nl', { numeric: true, sensitivity: 'base' });
        case 'name-desc': return b.file_name.localeCompare(a.file_name, 'nl', { numeric: true, sensitivity: 'base' });
        case 'newest': return b.created_at.localeCompare(a.created_at);
        case 'oldest':
        default: return a.created_at.localeCompare(b.created_at);
      }
    });
    void persistOrder(sorted);
  }

  /** Sleep-en-neerzetten: `movedId` komt vóór `targetId` te staan. */
  function reorderItem(movedId: string, targetId: string) {
    const from = items.findIndex(i => i.id === movedId);
    const to = items.findIndex(i => i.id === targetId);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(from < to ? to - 1 : to, 0, moved);
    void persistOrder(next);
  }

  // ── Bulkselectie ──
  function toggleSelected(itemId: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId); else next.add(itemId);
      return next;
    });
  }

  /** Zet de categorie van een reeks bestanden; gooit de fout dóór naar de aanroeper. */
  async function assignItemsTo(itemIds: string[], categoryId: string | null) {
    if (!openGallery || itemIds.length === 0) return;
    const ids = new Set(itemIds);
    setBusy(true);
    try {
      await setGalleryItemsCategory(organizationId, itemIds, categoryId);
      setItems(prev => prev.map(i => (ids.has(i.id) ? { ...i, category_id: categoryId } : i)));
    } finally {
      setBusy(false);
    }
  }

  async function assignSelectedTo(categoryId: string | null) {
    if (selectedIds.size === 0) return;
    setError(null);
    try {
      await assignItemsTo(Array.from(selectedIds), categoryId);
      setSelectedIds(new Set());
      setSelectMode(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Toewijzen mislukt.');
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
  const uncategorized = categories.length > 0 ? items.filter(i => !i.category_id).length : 0;

  function openSettings(tab: GallerySettingsTab) {
    // Een sleep die nog "open" stond zou de melding achter het venster laten hangen.
    dragDepth.current = 0;
    setDragActive(false);
    setSettingsTab(tab);
    if (presets.length === 0) void selectGalleryCategoryPresets(organizationId).then(setPresets).catch(() => undefined);
  }

  /**
   * Alleen echte bestandsslepen tellen. Het herschikken van foto's sleept een
   * element (geen 'Files'), dus dat mag deze melding nooit oproepen. Staat er een
   * venster open, dan gaat de sleep dáárover: het paneel houdt zich dan stil.
   */
  function isFileDrag(e: React.DragEvent): boolean {
    if (!writable || settingsTab || showShare) return false;
    return Array.from(e.dataTransfer.types ?? []).includes('Files');
  }

  return (
    <article
      className={`client-panel gal-detail${dragActive ? ' is-dropping' : ''}`}
      onDragEnter={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragActive(true);
      }}
      onDragOver={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(e) => {
        if (!isFileDrag(e)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragActive(false);
      }}
      onDrop={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragActive(false);
        void handleDrop(e.dataTransfer);
      }}
    >
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
          {openGallery.allow_downloads && bundle && hasZippableItems(items) && (
            <a className="btn" href={galleryZipUrl(openGallery.id, bundle.mediaToken)} download title="Alle foto's als zip — video's download je per stuk">
              <Download size={14} /> Zip
            </a>
          )}
          {writable && (
            <>
              <Button onClick={() => openSettings('files')} title="Categorieën beheren en bestanden indelen">
                <FolderTree size={14} /> Bestanden
                {uncategorized > 0 && <span className="gal-badge" title={`${uncategorized} nog niet ingedeeld`}>{uncategorized}</span>}
              </Button>
              {items.length > 0 && categories.length > 0 && (
                <Button
                  onClick={() => { setSelectMode(v => !v); setSelectedIds(new Set()); setOrderMode(false); }}
                  variant={selectMode ? 'primary' : undefined}
                  title="Foto's in het raster aanwijzen en in één keer indelen"
                >
                  <CheckSquare size={14} /> {selectMode ? 'Selectie stoppen' : 'Indelen'}
                </Button>
              )}
              {items.length > 1 && (
                <>
                  <Button
                    onClick={() => { setOrderMode(v => !v); setSelectMode(false); setSelectedIds(new Set()); }}
                    variant={orderMode ? 'primary' : undefined}
                    title="Sleep foto's naar de gewenste plek"
                  >
                    <ArrowUpDown size={14} /> {orderMode ? 'Slepen stoppen' : 'Volgorde'}
                  </Button>
                  <Select
                    inline
                    value=""
                    disabled={busy}
                    onChange={(e) => {
                      const mode = e.target.value as 'name' | 'name-desc' | 'oldest' | 'newest' | '';
                      if (mode) sortItems(mode);
                    }}
                    aria-label="Sorteren"
                  >
                    <option value="">Sorteren…</option>
                    <option value="name">Bestandsnaam (A→Z)</option>
                    <option value="name-desc">Bestandsnaam (Z→A)</option>
                    <option value="oldest">Oudste eerst</option>
                    <option value="newest">Nieuwste eerst</option>
                  </Select>
                </>
              )}
              <Button onClick={() => setShowShare(true)}><Link2 size={14} /> Delen</Button>
              <Button onClick={() => openSettings('general')}><Settings2 size={14} /> Instellingen</Button>
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

      {orderMode && (
        <div className="gal-selectbar">
          <strong>Volgorde aanpassen</strong>
          <span className="gal-cats-help">Sleep een foto op de plek waar hij moet komen. Elke wijziging wordt meteen bewaard.</span>
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
          <button type="button" className="gal-linkbtn" onClick={() => openSettings('files')}>Categorieën beheren</button>
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
        : items.length === 0 && writable
        ? (
          // Een lege galerij is precies het moment om te laten zien dát je kunt
          // slepen; de kale zin "nog geen media" hielp daar niet bij.
          <button
            type="button"
            className={`gal-dropzone${dragActive ? ' is-over' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
          >
            <span className="gal-dropzone-icon"><UploadCloud size={30} /></span>
            <strong>
              {openGallery.format === 'video' ? 'Sleep je video’s hierheen' : 'Sleep je foto’s hierheen'}
            </strong>
            <span className="gal-dropzone-hint">
              Of klik om te bladeren. Hele mappen mogen ook — submappen worden meegenomen.
            </span>
            <span className="gal-dropzone-meta">
              {openGallery.format === 'photo' ? 'JPEG, PNG of WebP' : openGallery.format === 'video' ? 'MP4, MOV, WebM of MKV' : 'JPEG, PNG, WebP en video’s'} · tot 4 GB per bestand
            </span>
          </button>
        )
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
            likeCounts={likeCounts}
            canLike={false}
            selectable={selectMode}
            selected={selectedIds}
            onToggleSelect={(item) => toggleSelected(item.id)}
            reorderable={orderMode}
            onReorder={reorderItem}
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
                  title={coverLabel(viewerItem, openGallery.cover_item_id === viewerItem.id)}
                  aria-label={coverLabel(viewerItem, openGallery.cover_item_id === viewerItem.id)}
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

      {/* Sleepmelding over het hele paneel: zichtbaar waar je ook loslaat. */}
      {dragActive && (
        <div className="gal-dropveil" aria-hidden="true">
          <span className="gal-dropveil-card">
            <UploadCloud size={32} />
            <strong>Laat los om te uploaden</strong>
            <span>naar “{openGallery.title}”</span>
          </span>
        </div>
      )}

      {settingsTab && (
        <GallerySettingsModal
          gallery={openGallery}
          tab={settingsTab}
          onTab={setSettingsTab}
          busy={busy}
          items={items}
          categories={categories}
          bundle={bundle}
          onClose={() => setSettingsTab(null)}
          onSave={async (patch) => { await patchGallery(openGallery, patch); setSettingsTab(null); }}
          onDelete={writable ? () => { setSettingsTab(null); void removeGallery(openGallery); } : undefined}
          files={{
            onAssign: assignItemsTo,
            onAddCategory: addCategory,
            onRenameCategory: renameCategory,
            onMoveCategory: moveCategory,
            onRemoveCategory: removeCategory,
            onApplyPresets: applyPresets,
            onSaveAsPresets: saveAsPresets,
          }}
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

export type GallerySettingsTab = 'general' | 'opening' | 'files';

const gallerySettingsTabs: Array<{ key: GallerySettingsTab; label: string; Icon: typeof ImageIcon }> = [
  { key: 'general', label: 'Algemeen', Icon: SlidersHorizontal },
  { key: 'opening', label: 'Opening', Icon: Sparkles },
  { key: 'files', label: 'Bestanden', Icon: FolderTree },
];

/**
 * Een bestandssleep die op een openstaand venster landt, mag de browser niet
 * "openen" — dan navigeert hij weg van niet-opgeslagen werk. Interne sleepacties
 * (miniaturen naar een categorie) dragen geen 'Files' en gaan hier ongemoeid
 * doorheen.
 */
function swallowFileDrag(e: React.DragEvent) {
  if (!Array.from(e.dataTransfer.types ?? []).includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'none';
}

/** Alles wat het tabblad "Bestanden" mag wijzigen; fouten komen als exception terug. */
type GalleryFileActions = {
  onAssign: (itemIds: string[], categoryId: string | null) => Promise<void>;
  onAddCategory: (name: string) => Promise<void>;
  onRenameCategory: (category: GalleryCategory, name: string) => Promise<void>;
  onMoveCategory: (category: GalleryCategory, delta: number) => Promise<void>;
  onRemoveCategory: (category: GalleryCategory) => Promise<void>;
  onApplyPresets: () => Promise<void>;
  onSaveAsPresets: () => Promise<void>;
};

/**
 * Eén venster voor alles wat je aan een galerij instelt, in drie tabbladen.
 *
 * De opening (hero) hoort bij de galerij als geheel: hij verschijnt precies één
 * keer, bovenaan de pagina. Categorieën zijn enkel een indeling van bestanden en
 * hebben géén eigen opening — daarom staan ze in een eigen tabblad, ver van de
 * hero-keuze vandaan, zodat de indruk van "een hero per categorie" niet ontstaat.
 */
function GallerySettingsModal({
  gallery, tab, onTab, busy, items, categories, bundle, onClose, onSave, onDelete, files,
}: {
  gallery: Gallery;
  tab: GallerySettingsTab;
  onTab: (tab: GallerySettingsTab) => void;
  busy: boolean;
  items: GalleryItem[];
  categories: GalleryCategory[];
  bundle: GalleryTokenBundle | null;
  onClose: () => void;
  onSave: (patch: Partial<Gallery>) => Promise<void>;
  onDelete?: () => void;
  files: GalleryFileActions;
}) {
  const [title, setTitle] = useState(gallery.title);
  const [description, setDescription] = useState(gallery.description ?? '');
  const [format, setFormat] = useState<GalleryFormat>(gallery.format);
  const [heroTemplate, setHeroTemplate] = useState<GalleryHeroTemplate>(gallery.hero_template);
  const [allowDownloads, setAllowDownloads] = useState(gallery.allow_downloads);
  const [quality, setQuality] = useState(gallery.download_quality);
  const [expiresAt, setExpiresAt] = useState(gallery.expires_at ? gallery.expires_at.slice(0, 10) : '');
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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

  const uncategorized = categories.length > 0 ? items.filter(i => !i.category_id).length : 0;
  // Aan beide kanten trimmen: een oude rij met een lege string i.p.v. NULL (of
  // een spatie in de titel) zou het venster anders eeuwig "niet opgeslagen" noemen.
  const dirty = title.trim() !== gallery.title.trim()
    || description.trim() !== (gallery.description ?? '').trim()
    || format !== gallery.format
    || heroTemplate !== gallery.hero_template
    || allowDownloads !== gallery.allow_downloads
    || quality !== gallery.download_quality
    || expiresAt !== (gallery.expires_at ? gallery.expires_at.slice(0, 10) : '');

  return (
    <div className="bk-modal-backdrop gal-modal-shell" onClick={onClose} onDragOver={swallowFileDrag} onDrop={swallowFileDrag}>
      <div
        className={`bk-modal gal-modal${tab === 'files' ? ' gal-modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Galerij-instellingen"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="gal-modal-head">
          <span className="gal-modal-titles">
            <h3>Galerij-instellingen</h3>
            <p>{gallery.title}</p>
          </span>
          <button type="button" className="gal-modal-close" onClick={onClose} aria-label="Sluiten"><X size={18} /></button>
        </header>

        <nav className="gal-modal-tabs" role="tablist" aria-label="Onderdelen">
          {gallerySettingsTabs.map(({ key, label, Icon }) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={`gal-modal-tab${tab === key ? ' is-active' : ''}`}
              onClick={() => onTab(key)}
            >
              <Icon size={14} /> {label}
              {key === 'files' && uncategorized > 0 && <span className="gal-badge">{uncategorized}</span>}
            </button>
          ))}
        </nav>

        <div className="bk-modal-body gal-modal-body">
          {tab === 'general' && (
            <>
              <section className="gal-card">
                <label className="gal-field">
                  <span>Titel</span>
                  <Input value={title} onChange={(e) => setTitle(e.target.value)} />
                </label>
                <label className="gal-field">
                  <span>Omschrijving (zichtbaar voor de klant)</span>
                  <textarea className="form-input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
                </label>
              </section>

              <section className="gal-card">
                <span className="gal-card-title">Wat lever je op?</span>
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
              </section>

              <section className="gal-card">
                <span className="gal-card-title">Levering aan de klant</span>
                <label className="gal-field gal-field-row">
                  <input type="checkbox" checked={allowDownloads} onChange={(e) => setAllowDownloads(e.target.checked)} />
                  <span>Klant mag downloaden</span>
                </label>
                {allowDownloads && (
                  <label className="gal-field">
                    <span>Downloadkwaliteit van foto’s</span>
                    <Select value={quality} onChange={(e) => setQuality(e.target.value as Gallery['download_quality'])}>
                      <option value="original">Originele bestanden (full-res)</option>
                      <option value="web">Webresolutie (kleiner, sneller)</option>
                    </Select>
                    <p className="gal-field-help">
                      Video’s gaan altijd in de originele resolutie: de klant kijkt via de kijkkopie en
                      downloadt het bronbestand zoals jij het hebt aangeleverd.
                    </p>
                  </label>
                )}
                <label className="gal-field">
                  <span>Klanttoegang verloopt op (leeg = nooit)</span>
                  <Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
                </label>
              </section>
            </>
          )}

          {tab === 'opening' && (
            <section className="gal-card">
              <span className="gal-card-title">De opening van de galerij</span>
              <p className="gal-field-help">
                Dit is het eerste wat de klant ziet, bovenaan de pagina — één keer voor de hele galerij.
                Categorieën zijn alleen een indeling van de bestanden en krijgen geen eigen opening.
              </p>
              {heroGroups.map(({ group, options }) => (
                <div key={group} className="gal-hero-group">
                  <span className="gal-hero-group-label">{group}</span>
                  <div className="gal-format-options is-compact gal-hero-options">
                    {options.map(({ key, label, hint }) => (
                      <button
                        key={key}
                        type="button"
                        className={`gal-format-card${heroTemplate === key ? ' is-active' : ''}`}
                        onClick={() => setHeroTemplate(key)}
                        aria-pressed={heroTemplate === key}
                        title={hint}
                      >
                        <span className={`gal-hero-thumb gal-hero-thumb-${key}`} aria-hidden="true" />
                        <span className="gal-format-label">{label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <p className="gal-field-help">
                Welk beeld de opening vult, kies je met het sterretje in de galerij: bij “Kopvideo”
                is dat de video die bovenaan meespeelt, bij de andere openingen de coverfoto.
                Kies je niets, dan pakt de galerij het eerste item.
              </p>
            </section>
          )}

          {tab === 'files' && (
            <GalleryFileSettings
              items={items}
              categories={categories}
              bundle={bundle}
              busy={busy}
              actions={files}
            />
          )}

          {saveError && <div className="error">{saveError}</div>}
        </div>

        <div className="bk-modal-actions gal-modal-actions">
          {onDelete && <Button variant="danger" onClick={onDelete} disabled={busy}><Trash2 size={14} /> Verwijderen</Button>}
          <span className="gal-modal-spacer" />
          {tab === 'files' && !dirty
            ? <span className="gal-field-help">Indelen wordt meteen bewaard.</span>
            : dirty && <span className="gal-unsaved">Nog niet opgeslagen</span>}
          <Button variant="ghost" onClick={onClose} disabled={busy}>{dirty ? 'Annuleren' : 'Sluiten'}</Button>
          <Button
            variant="primary"
            disabled={busy || !title.trim() || !dirty}
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

// ── Bestanden: categorieën beheren en media indelen ─────────────────────────

/** Hoeveel miniaturen we in één keer tonen; grote galerijen laden anders traag. */
const FILE_PAGE_SIZE = 120;

/**
 * Het algemene bestandsscherm van een galerij. Links de categorieën — die
 * tegelijk neerzetplek zijn — rechts de miniaturen. Slepen is de snelle weg;
 * de keuzelijst “Verplaats naar…” is de weg die óók op een tablet werkt, want
 * HTML5-slepen bestaat niet op een aanraakscherm.
 */
function GalleryFileSettings({ items, categories, bundle, busy, actions }: {
  items: GalleryItem[];
  categories: GalleryCategory[];
  bundle: GalleryTokenBundle | null;
  busy: boolean;
  actions: GalleryFileActions;
}) {
  const [bucket, setBucket] = useState<string>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newCategory, setNewCategory] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [overBucket, setOverBucket] = useState<string | null>(null);
  const [limit, setLimit] = useState(FILE_PAGE_SIZE);
  const [working, setWorking] = useState(false);
  const dragIds = useRef<string[]>([]);
  const statusRef = useRef<HTMLDivElement | null>(null);
  // Escape tijdens hernoemen mag de oude naam niet alsnog opslaan via onBlur.
  const skipBlur = useRef(false);

  const counts = useMemo(() => {
    const perCategory = new Map<string, number>();
    let none = 0;
    for (const item of items) {
      if (item.category_id) perCategory.set(item.category_id, (perCategory.get(item.category_id) ?? 0) + 1);
      else none += 1;
    }
    return { perCategory, none };
  }, [items]);

  const visible = useMemo(() => {
    if (bucket === 'all') return items;
    if (bucket === 'none') return items.filter(i => !i.category_id);
    return items.filter(i => i.category_id === bucket);
  }, [items, bucket]);

  // Van categorie wisselen begint weer bovenaan; anders staat een korte lijst
  // met een uitgeklapte "meer tonen"-teller.
  useEffect(() => { setLimit(FILE_PAGE_SIZE); }, [bucket]);

  // Een verdwenen categorie (net verwijderd) mag het filter niet leeg laten staan.
  useEffect(() => {
    if (bucket === 'all' || bucket === 'none') return;
    if (!categories.some(c => c.id === bucket)) setBucket('all');
  }, [categories, bucket]);

  // De knoppen voor de standaardlijst staan onderaan de linkerkolom; de melding
  // erover staat bovenaan. Bij een lange categorielijst zou die buiten beeld
  // vallen en leek de knop niets te doen — dus halen we hem in beeld.
  useEffect(() => {
    if (error || notice) statusRef.current?.scrollIntoView({ block: 'nearest' });
  }, [error, notice]);

  async function run(action: () => Promise<void>, done?: string) {
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      await action();
      if (done) {
        setNotice(done);
        window.setTimeout(() => setNotice(null), 3500);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Actie mislukt.');
    } finally {
      setWorking(false);
    }
  }

  function moveTo(itemIds: string[], categoryId: string | null) {
    if (itemIds.length === 0) return;
    const name = categoryId ? (categories.find(c => c.id === categoryId)?.name ?? 'categorie') : 'Zonder categorie';
    void run(async () => {
      await actions.onAssign(itemIds, categoryId);
      setSelected(new Set());
    }, `${itemIds.length} bestand${itemIds.length === 1 ? '' : 'en'} verplaatst naar “${name}”.`);
  }

  function toggle(itemId: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId); else next.add(itemId);
      return next;
    });
  }

  const locked = busy || working;

  /** Eén rij in de linkerkolom: filter, neerzetplek en (bij categorieën) beheer. */
  function bucketRow(key: string, label: string, count: number, category?: GalleryCategory, index = -1) {
    const droppable = key !== 'all';
    const isRenaming = renaming === key && category;
    return (
      <li
        key={key}
        className={`gal-bucket${bucket === key ? ' is-active' : ''}${overBucket === key ? ' is-over' : ''}`}
        onDragOver={droppable ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOverBucket(key); } : undefined}
        onDragLeave={droppable ? (e) => { if (e.currentTarget === e.target) setOverBucket(null); } : undefined}
        onDrop={droppable ? (e) => {
          e.preventDefault();
          setOverBucket(null);
          const ids = dragIds.current.length > 0
            ? dragIds.current
            : (e.dataTransfer.getData('text/plain') || '').split(',').filter(Boolean);
          dragIds.current = [];
          moveTo(ids, key === 'none' ? null : key);
        } : undefined}
      >
        {isRenaming ? (
          <Input
            autoFocus
            defaultValue={category.name}
            maxLength={60}
            onBlur={(e) => {
              const value = e.target.value;
              setRenaming(null);
              if (skipBlur.current) { skipBlur.current = false; return; }
              void run(() => actions.onRenameCategory(category, value));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') {
                e.stopPropagation();
                skipBlur.current = true;
                (e.target as HTMLInputElement).blur();
              }
            }}
            aria-label={`Naam van ${category.name}`}
          />
        ) : (
          <>
            <button type="button" className="gal-bucket-main" onClick={() => setBucket(key)} aria-pressed={bucket === key}>
              <span className="gal-bucket-name">{label}</span>
              <span className="gal-bucket-count">{count}</span>
            </button>
            {category && (
              <span className="gal-bucket-tools">
                <button type="button" className="icon-btn" onClick={() => setRenaming(key)} title="Hernoemen"><Pencil size={13} /></button>
                <button type="button" className="icon-btn" disabled={index === 0 || locked} onClick={() => void run(() => actions.onMoveCategory(category, -1))} title="Omhoog"><ChevronUp size={13} /></button>
                <button type="button" className="icon-btn" disabled={index === categories.length - 1 || locked} onClick={() => void run(() => actions.onMoveCategory(category, 1))} title="Omlaag"><ChevronDown size={13} /></button>
                <button type="button" className="icon-btn danger" disabled={locked} onClick={() => void run(() => actions.onRemoveCategory(category))} title="Verwijderen"><Trash2 size={13} /></button>
              </span>
            )}
          </>
        )}
      </li>
    );
  }

  return (
    <div className="gal-files-tab">
      {/* Meldingen staan over de volle breedte bovenaan: ze kunnen bij beide
          kolommen horen, en zo staan ze nooit náást het bericht dat je zoekt. */}
      <div ref={statusRef}>
        {error && <div className="error">{error}</div>}
        {notice && <div className="gal-notice">{notice}</div>}
      </div>
      <div className="gal-files">
      <div className="gal-files-side">
        <span className="gal-card-title">Categorieën</span>
        <p className="gal-field-help">
          Dit worden de secties die de klant als knoppen bovenaan de galerij ziet.
        </p>
        <ul className="gal-buckets">
          {bucketRow('all', 'Alle bestanden', items.length)}
          {categories.length > 0 && bucketRow('none', 'Zonder categorie', counts.none)}
          {categories.map((category, index) => bucketRow(
            category.id, category.name, counts.perCategory.get(category.id) ?? 0, category, index,
          ))}
        </ul>
        {categories.length === 0 && (
          <p className="gal-field-help">
            Nog geen categorieën. Voeg er hieronder een toe, of neem je standaardlijst over.
          </p>
        )}
        <form
          className="gal-cat-add"
          onSubmit={(e) => {
            e.preventDefault();
            const name = newCategory.trim();
            if (!name) return;
            void run(async () => { await actions.onAddCategory(name); setNewCategory(''); });
          }}
        >
          <Input
            placeholder="Nieuwe categorie (bijv. Ceremonie)"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            maxLength={60}
          />
          <Button type="submit" variant="primary" disabled={!newCategory.trim() || locked} title="Categorie toevoegen" aria-label="Categorie toevoegen"><Plus size={14} /></Button>
        </form>
        <div className="gal-preset-row">
          <button type="button" className="gal-linkbtn" disabled={locked} onClick={() => void run(() => actions.onApplyPresets())}>
            Standaardlijst overnemen
          </button>
          <button
            type="button"
            className="gal-linkbtn"
            disabled={categories.length === 0 || locked}
            onClick={() => void run(() => actions.onSaveAsPresets(), 'Deze indeling is nu je standaardlijst voor nieuwe galerijen.')}
          >
            Als standaard opslaan
          </button>
        </div>
      </div>

      <div className="gal-files-main">
        <div className="gal-files-bar">
          <strong>{visible.length} bestand{visible.length === 1 ? '' : 'en'}</strong>
          {visible.length > 0 && (
            <>
              <button type="button" className="gal-linkbtn" onClick={() => setSelected(new Set(visible.map(i => i.id)))}>Alles</button>
              <button type="button" className="gal-linkbtn" onClick={() => setSelected(new Set())}>Niets</button>
            </>
          )}
          <span className="gal-modal-spacer" />
          {selected.size > 0 && <span className="gal-files-count">{selected.size} geselecteerd</span>}
          <Select
            inline
            value=""
            disabled={selected.size === 0 || locked}
            onChange={(e) => {
              const value = e.target.value;
              if (!value) return;
              moveTo(Array.from(selected), value === '__none__' ? null : value);
            }}
            aria-label="Verplaats de selectie naar een categorie"
          >
            <option value="">Verplaats naar…</option>
            {categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
            <option value="__none__">Zonder categorie</option>
          </Select>
        </div>

        {items.length === 0
          ? <div className="client-empty-line">Nog geen bestanden in deze galerij. Sleep ze op de galerij om te uploaden.</div>
          : visible.length === 0
            ? <div className="client-empty-line">Geen bestanden in deze categorie.</div>
            : (
              <>
                <p className="gal-field-help">
                  Klik om te selecteren en sleep de selectie naar een categorie links — of gebruik “Verplaats naar…”.
                </p>
                <div className="gal-thumbs">
                  {visible.slice(0, limit).map(item => {
                    const url = bundle ? galleryItemThumbUrl(item, bundle) : null;
                    const isSelected = selected.has(item.id);
                    const categoryName = item.category_id
                      ? categories.find(c => c.id === item.category_id)?.name ?? null
                      : null;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={`gal-thumb${isSelected ? ' is-selected' : ''}`}
                        draggable
                        aria-pressed={isSelected}
                        title={item.file_name}
                        onDragStart={(e) => {
                          // Een niet-geselecteerde foto slepen betekent: alleen die.
                          const ids = isSelected ? Array.from(selected) : [item.id];
                          if (!isSelected) setSelected(new Set([item.id]));
                          dragIds.current = ids;
                          e.dataTransfer.effectAllowed = 'move';
                          // Firefox start geen sleep zonder payload.
                          e.dataTransfer.setData('text/plain', ids.join(','));
                        }}
                        onDragEnd={() => { dragIds.current = []; setOverBucket(null); }}
                        onClick={() => toggle(item.id)}
                      >
                        {url
                          ? <img src={url} alt="" loading="lazy" />
                          : <span className="gal-thumb-fallback">{item.media_type === 'video' ? <Film size={18} /> : <ImageIcon size={18} />}</span>}
                        {item.media_type === 'video' && <span className="gal-thumb-badge"><Film size={11} /></span>}
                        {isSelected && <span className="gal-thumb-check" aria-hidden="true" />}
                        <span className="gal-thumb-foot">{categoryName ?? item.file_name}</span>
                      </button>
                    );
                  })}
                </div>
                {visible.length > limit && (
                  <Button onClick={() => setLimit(value => value + FILE_PAGE_SIZE * 2)}>
                    Nog {visible.length - limit} tonen
                  </Button>
                )}
              </>
            )}
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
    <div className="bk-modal-backdrop gal-modal-shell" onClick={onClose} onDragOver={swallowFileDrag} onDrop={swallowFileDrag}>
      <div className="bk-modal gal-modal" role="dialog" aria-modal="true" aria-label="Galerij delen" onClick={(e) => e.stopPropagation()}>
        <header className="gal-modal-head">
          <span className="gal-modal-titles">
            <h3>Galerij delen</h3>
            <p>{gallery.title}</p>
          </span>
          <button type="button" className="gal-modal-close" onClick={onClose} aria-label="Sluiten"><X size={18} /></button>
        </header>
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
