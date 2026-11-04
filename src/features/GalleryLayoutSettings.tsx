// Het tabblad "Weergave" in de galerij-instellingen: hoe de foto's en video's
// in het album staan. Los van "Opening" (de kop van de pagina en het
// coverbeeld): dit gaat over alles daaronder.
//
// Links de knoppen, rechts een levend voorbeeld met de eigen foto's van de
// galerij — dezelfde GalleryViewer en dezelfde rekenregels als bij de klant,
// alleen verkleind. Wie aan een schuif trekt, ziet het album meebewegen; met
// de knoppen Computer, Tablet en Telefoon zie je hoe het op elk scherm valt.
//
// Wijzigingen zijn een concept tot "Opslaan", net als de rest van het venster.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Expand, Monitor, RotateCcw, Smartphone, Sparkles, Tablet } from 'lucide-react';
import {
  GALLERY_LAYOUT_DEFAULTS, GALLERY_LAYOUT_LIMITS, GALLERY_LAYOUT_PRESETS, GALLERY_LAYOUT_STYLES,
  GALLERY_LAYOUT_STYLE_LABELS, GALLERY_PLAYFULNESS_LABELS,
  applyGalleryLayoutPreset, gapLabel, matchGalleryLayoutPreset, playfulnessHint,
  type GalleryLayout, type GalleryLayoutStyle, type GalleryPlayfulness,
} from '../lib/galleryLayout';
import { brandStyle, ensureBrandFontsLoaded, type BrandingPayload } from '../lib/branding';
import type { GalleryTokenBundle } from '../lib/gallery';
import { GalleryViewer, type GalleryViewerCategory, type GalleryViewerItem } from './GalleryViewer';

type Option<T> = { value: T; label: string; title?: string };

/**
 * Een rij keuzes waarvan er één aan staat. Bewust echte knoppen met
 * `aria-pressed` in een groep met een naam: zo leest een schermlezer "Kolommen,
 * 4, ingedrukt" in plaats van een rij losse cijfers.
 */
function Segmented<T extends string | number | null>({ label, value, options, onChange, disabled = false }: {
  label: string;
  value: T;
  options: Array<Option<T>>;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className={`gal-seg${disabled ? ' is-disabled' : ''}`} role="group" aria-label={label}>
      {options.map(option => (
        <button
          key={String(option.value)}
          type="button"
          className={`gal-seg-opt${option.value === value ? ' is-on' : ''}`}
          aria-pressed={option.value === value}
          title={option.title}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="gal-look-row">
      <span className="gal-look-label">{label}</span>
      {children}
      {hint && <p className="gal-field-help">{hint}</p>}
    </div>
  );
}

// ── Miniaturen: de indeling in een oogopslag, puur CSS ──────────────────────

function StyleGlyph({ style, variant }: { style: GalleryLayoutStyle; variant?: string }) {
  const cls = `gal-glyph gal-glyph-${style}${variant ? ` gal-glyph-v-${variant}` : ''}`;
  switch (style) {
    case 'masonry':
      return (
        <span className={cls} aria-hidden="true">
          <b><i style={{ height: '58%' }} /><i style={{ height: '42%' }} /></b>
          <b><i style={{ height: '34%' }} /><i style={{ height: '66%' }} /></b>
          <b><i style={{ height: '70%' }} /><i style={{ height: '30%' }} /></b>
        </span>
      );
    case 'grid':
      return (
        <span className={cls} aria-hidden="true">
          {variant === 'rhythm'
            ? <><i className="is-big" /><i /><i /><i /><i /></>
            : <><i /><i /><i /><i /><i /><i /><i /><i /></>}
        </span>
      );
    case 'story':
      return (
        <span className={cls} aria-hidden="true">
          <i className="is-wide" />
          <b><i /><i /></b>
        </span>
      );
    case 'prints':
      return (
        <span className={cls} aria-hidden="true">
          <i style={{ transform: 'rotate(-6deg)' }} />
          <i style={{ transform: 'rotate(3deg) translateY(2px)' }} />
          <i style={{ transform: 'rotate(-2deg) translateY(-1px)' }} />
        </span>
      );
    case 'rows':
    default:
      return (
        <span className={cls} aria-hidden="true">
          <b><i style={{ flexGrow: 3 }} /><i style={{ flexGrow: 2 }} /><i style={{ flexGrow: 2.6 }} /></b>
          <b><i style={{ flexGrow: 1.6 }} /><i style={{ flexGrow: 3.2 }} /></b>
        </span>
      );
  }
}

// ── Het voorbeeld ───────────────────────────────────────────────────────────

type Device = 'desktop' | 'tablet' | 'phone';
const DEVICES: Record<Device, { label: string; Icon: typeof Monitor; width: number; height: number }> = {
  desktop: { label: 'Computer', Icon: Monitor, width: 1440, height: 900 },
  tablet: { label: 'Tablet', Icon: Tablet, width: 820, height: 1180 },
  phone: { label: 'Telefoon', Icon: Smartphone, width: 390, height: 844 },
};

/** Zoveel beelden laat het voorbeeld zien; genoeg voor het ritme, licht genoeg om mee te schuiven. */
const PREVIEW_PHOTOS = 48;
const PREVIEW_VIDEOS = 6;
const EMPTY_BUNDLE: GalleryTokenBundle = { mediaToken: '', streamTokens: {}, exp: 0 };

/**
 * Nog geen beelden (of de kijk-tokens zijn er nog niet): vlakken in gangbare
 * verhoudingen. Zo kun je de weergave al ontwerpen vóór de eerste upload.
 */
function placeholderItems(withVideos: boolean, withPhotos: boolean): GalleryViewerItem[] {
  const shapes: Array<[number, number]> = [
    [3, 2], [2, 3], [3, 2], [1, 1], [4, 5], [3, 2], [16, 9], [2, 3], [3, 2], [4, 5],
    [3, 2], [1, 1], [2, 3], [3, 2], [21, 9], [4, 5], [3, 2], [2, 3], [3, 2], [1, 1],
  ];
  const base = { content_type: null, size_bytes: null, category_id: null, storage_key: null, preview_key: null, thumb_key: null, duration_seconds: null, stream_uid: null, stream_status: null, stream_playback_base: null };
  const photos: GalleryViewerItem[] = withPhotos ? shapes.map(([w, h], i) => ({
    ...base, id: `voorbeeld-foto-${i}`, media_type: 'photo', file_name: '', width: w * 1000, height: h * 1000,
  })) : [];
  const videos: GalleryViewerItem[] = withVideos ? ['Aftermovie', 'De ceremonie', 'Interview'].map((name, i) => ({
    ...base, id: `voorbeeld-video-${i}`, media_type: 'video', file_name: name, width: 1920, height: 1080, duration_seconds: [184, 2410, 512][i],
  })) : [];
  return [...videos, ...photos];
}

function LayoutPreview({ layout, items, categories, bundle, format, branding }: {
  layout: GalleryLayout;
  items: GalleryViewerItem[];
  categories: GalleryViewerCategory[];
  bundle: GalleryTokenBundle | null;
  format: string;
  branding?: BrandingPayload | null;
}) {
  const [device, setDevice] = useState<Device>('desktop');
  const paneRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [paneWidth, setPaneWidth] = useState(460);
  const [canvasHeight, setCanvasHeight] = useState(600);

  useEffect(() => {
    if (branding) ensureBrandFontsLoaded([branding.headingFont, branding.bodyFont]);
  }, [branding]);

  // De breedte van het paneel bepaalt de schaal; de hoogte van het canvas
  // (op ware grootte) bepaalt hoe hoog het verkleinde kader wordt. Een
  // transform telt niet mee in de opmaak, dus die hoogte zetten we zelf.
  useEffect(() => {
    const pane = paneRef.current;
    const canvas = canvasRef.current;
    if (!pane || !canvas || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      setPaneWidth(pane.clientWidth);
      setCanvasHeight(canvas.offsetHeight);
    });
    observer.observe(pane);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  const real = Boolean(bundle) && items.length > 0;
  const sample = useMemo(() => {
    if (!real) return placeholderItems(format !== 'photo', format !== 'video');
    // In de volgorde van de galerij, maar per soort begrensd: een album van
    // achthonderd foto's hoeft niet helemaal mee te bewegen met elke schuif.
    let photos = 0;
    let videos = 0;
    return items.filter(item => {
      if (item.media_type === 'video') return (videos += 1) <= PREVIEW_VIDEOS;
      return (photos += 1) <= PREVIEW_PHOTOS;
    });
  }, [real, items, format]);

  const spec = DEVICES[device];
  const inset = device === 'desktop' ? 0 : 24;
  const scale = Math.min(1, Math.max(0.1, (paneWidth - inset) / spec.width));
  // De pagina bij de klant heeft lucht rondom; zonder die marge leest het
  // voorbeeld als een uitsnede in plaats van als de pagina.
  const pagePadding = device === 'phone' ? 12 : device === 'tablet' ? 22 : 34;
  const palette = brandStyle(branding);

  return (
    <div className="gal-look-preview">
      <div className="gal-look-preview-head">
        <span className="gal-card-title">Voorbeeld</span>
        <div className="gal-seg gal-seg-icons" role="group" aria-label="Voorbeeld op">
          {(Object.keys(DEVICES) as Device[]).map(key => {
            const { label, Icon } = DEVICES[key];
            return (
              <button
                key={key}
                type="button"
                className={`gal-seg-opt${device === key ? ' is-on' : ''}`}
                aria-pressed={device === key}
                title={label}
                onClick={() => setDevice(key)}
              >
                <Icon size={14} /> <span>{label}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className={`gal-look-pane is-${device}`} ref={paneRef}>
        <div className="gal-look-device" style={{ width: spec.width * scale, height: canvasHeight * scale }}>
          <div
            ref={canvasRef}
            className="gal-look-canvas"
            style={{
              ...palette,
              width: spec.width,
              minHeight: Math.min(spec.height, 640),
              padding: pagePadding,
              transform: `scale(${scale})`,
            } as CSSProperties}
          >
            <GalleryViewer
              preview
              items={sample}
              bundle={real ? bundle : EMPTY_BUNDLE}
              allowDownload={false}
              format={format}
              categories={real ? categories : []}
              hero={null}
              canFavorite={false}
              layout={layout}
              viewportHeight={spec.height}
            />
          </div>
        </div>
      </div>
      <p className="gal-field-help">
        {real
          ? 'Met je eigen beelden: zo ziet de klant het album. De opening staat er hier niet bij — die stel je in bij “Opening”.'
          : 'Nog geen beelden in deze galerij: de vlakken laten zien hoe de weergave valt. Na het uploaden zie je hier je eigen foto’s.'}
      </p>
    </div>
  );
}

// ── Het tabblad ─────────────────────────────────────────────────────────────

const COLUMN_OPTIONS: Array<Option<number | null>> = [
  { value: null, label: 'Automatisch', title: 'Past zich aan de breedte van het scherm aan' },
  ...Array.from({ length: GALLERY_LAYOUT_LIMITS.columns.max }, (_, i) => ({ value: i + 1, label: String(i + 1) })),
];
const PHONE_COLUMN_OPTIONS: Array<Option<number | null>> = [
  { value: null, label: 'Automatisch' },
  ...Array.from({ length: GALLERY_LAYOUT_LIMITS.phone_columns.max }, (_, i) => ({ value: i + 1, label: String(i + 1) })),
];
const GAP_STOPS: Array<{ value: number; label: string }> = [
  { value: 0, label: 'Naadloos' }, { value: 6, label: 'Smal' }, { value: 16, label: 'Ruim' }, { value: 32, label: 'Royaal' },
];

export function GalleryLayoutSettings({ value, onChange, format, items, categories, bundle, branding }: {
  value: GalleryLayout;
  onChange: (next: GalleryLayout) => void;
  format: string;
  items: GalleryViewerItem[];
  categories: GalleryViewerCategory[];
  bundle: GalleryTokenBundle | null;
  branding?: BrandingPayload | null;
}) {
  const set = <K extends keyof GalleryLayout>(key: K, next: GalleryLayout[K]) => onChange({ ...value, [key]: next });
  const preset = matchGalleryLayoutPreset(value);
  const style = value.style;
  const story = style === 'story';
  const featured = items.filter(item => item.media_type === 'photo' && item.featured).length;
  const hasPhotos = format !== 'video';
  const hasVideos = format !== 'photo';
  const isDefault = preset === 'standard' && value.video_layout === GALLERY_LAYOUT_DEFAULTS.video_layout
    && value.video_size === GALLERY_LAYOUT_DEFAULTS.video_size;

  return (
    <div className="gal-look">
      <div className="gal-look-controls">
        {hasPhotos && (
          <section className="gal-card">
            <span className="gal-look-title">
              <span className="gal-card-title">Stijl</span>
              {!preset && <span className="gal-look-own">Eigen combinatie</span>}
            </span>
            <p className="gal-field-help">
              Een complete weergave in één klik. Daarna kun je alles hieronder nog bijstellen.
            </p>
            <div className="gal-look-presets">
              {GALLERY_LAYOUT_PRESETS.map(option => {
                const applied = applyGalleryLayoutPreset(value, option.key);
                return (
                  <button
                    key={option.key}
                    type="button"
                    className={`gal-format-card gal-look-preset${preset === option.key ? ' is-active' : ''}`}
                    aria-pressed={preset === option.key}
                    title={option.hint}
                    onClick={() => onChange(applied)}
                  >
                    <StyleGlyph style={applied.style} variant={option.key} />
                    <span className="gal-format-label">{option.label}</span>
                  </button>
                );
              })}
            </div>
            {preset && <p className="gal-look-hint">{GALLERY_LAYOUT_PRESETS.find(p => p.key === preset)?.hint}</p>}
          </section>
        )}

        {hasPhotos && (
          <section className="gal-card">
            <span className="gal-card-title">Indeling van de foto’s</span>
            <div className="gal-look-styles">
              {GALLERY_LAYOUT_STYLES.map(key => (
                <button
                  key={key}
                  type="button"
                  className={`gal-format-card gal-look-style${style === key ? ' is-active' : ''}`}
                  aria-pressed={style === key}
                  title={GALLERY_LAYOUT_STYLE_LABELS[key].hint}
                  onClick={() => set('style', key)}
                >
                  <StyleGlyph style={key} />
                  <span className="gal-format-label">{GALLERY_LAYOUT_STYLE_LABELS[key].label}</span>
                </button>
              ))}
            </div>
            <p className="gal-look-hint">{GALLERY_LAYOUT_STYLE_LABELS[style].hint}</p>
            {style === 'grid' && (
              <Row label="Vorm van de tegels" hint="Elke foto wordt in deze vorm bijgesneden; het midden blijft in beeld.">
                <Segmented
                  label="Vorm van de tegels"
                  value={value.tile_shape}
                  onChange={next => set('tile_shape', next)}
                  options={[
                    { value: 'square', label: 'Vierkant', title: '1 : 1' },
                    { value: 'portrait', label: 'Staand', title: '4 : 5' },
                    { value: 'landscape', label: 'Liggend', title: '3 : 2' },
                  ]}
                />
              </Row>
            )}
          </section>
        )}

        {hasPhotos && (
          <section className="gal-card">
            <span className="gal-card-title">Kolommen</span>
            {story ? (
              <p className="gal-field-help">
                Een verhaal kiest per regel zelf één, twee of drie beelden, op hun vorm: liggende foto’s
                breed en alleen, staande in paren. Met de breedte van het album (onder Witruimte) bepaal je
                hoe groot het wordt.
              </p>
            ) : (
              <>
                <Row
                  label={style === 'rows' ? 'Foto’s per rij, ongeveer' : 'Op een breed scherm'}
                  hint={style === 'rows'
                    ? 'Elke foto houdt haar eigen verhouding, dus het aantal per rij wisselt een beetje — de rijen vullen altijd precies de breedte.'
                    : value.columns == null ? 'Automatisch: zo’n 300 pixels per kolom, dus meer kolommen op een groter scherm.' : 'Op een tablet naar verhouding minder.'}
                >
                  <Segmented label="Kolommen op een breed scherm" value={value.columns} options={COLUMN_OPTIONS} onChange={next => set('columns', next)} />
                </Row>
                <Row label="Op een telefoon">
                  <Segmented label="Kolommen op een telefoon" value={value.phone_columns} options={PHONE_COLUMN_OPTIONS} onChange={next => set('phone_columns', next)} />
                </Row>
              </>
            )}
          </section>
        )}

        <section className="gal-card">
          <span className="gal-card-title">Witruimte</span>
          <Row
            label="Tussen de beelden"
            hint={value.gap > 8 ? 'Op een telefoon wordt royale ruimte vanzelf kleiner, zodat de foto’s groot genoeg blijven.' : undefined}
          >
            <div className="gal-look-gap">
              <input
                type="range"
                className="gal-range"
                min={GALLERY_LAYOUT_LIMITS.gap.min}
                max={GALLERY_LAYOUT_LIMITS.gap.max}
                step={1}
                value={value.gap}
                onChange={(e) => set('gap', Number(e.target.value))}
                aria-label="Ruimte tussen de beelden in pixels"
                aria-valuetext={`${value.gap} pixels, ${gapLabel(value.gap).toLowerCase()}`}
              />
              <output className="gal-look-value">{value.gap} px · {gapLabel(value.gap)}</output>
            </div>
            <div className="gal-look-stops">
              {GAP_STOPS.map(stop => (
                <button
                  key={stop.value}
                  type="button"
                  className={`gal-linkbtn${value.gap === stop.value ? ' is-on' : ''}`}
                  onClick={() => set('gap', stop.value)}
                >
                  {stop.label}
                </button>
              ))}
            </div>
          </Row>
          <Row label="Breedte van het album" hint="Smaller = meer wit aan de zijkanten op een groot scherm. De opening blijft op volle breedte.">
            <Segmented
              label="Breedte van het album"
              value={value.width}
              onChange={next => set('width', next)}
              options={[
                { value: 'full', label: 'Volle breedte' },
                { value: 'wide', label: 'Breed', title: 'Hooguit 1680 pixels' },
                { value: 'medium', label: 'Gemiddeld', title: 'Hooguit 1240 pixels' },
                { value: 'narrow', label: 'Smal', title: 'Hooguit 940 pixels' },
              ]}
            />
          </Row>
          <Row
            label="Tussen de hoofdstukken"
            hint={categories.length === 0 ? 'Hoofdstukken zijn de categorieën uit “Bestanden”; deze galerij heeft er nog geen.' : undefined}
          >
            <Segmented
              label="Ruimte tussen de hoofdstukken"
              value={value.section_spacing}
              onChange={next => set('section_spacing', next)}
              options={[
                { value: 'tight', label: 'Compact' },
                { value: 'normal', label: 'Normaal' },
                { value: 'airy', label: 'Ruim' },
                { value: 'grand', label: 'Royaal' },
              ]}
            />
          </Row>
        </section>

        {hasPhotos && (
          <section className="gal-card">
            <span className="gal-card-title">Speelsheid</span>
            <div className="gal-look-play">
              <input
                type="range"
                className="gal-range"
                min={GALLERY_LAYOUT_LIMITS.playfulness.min}
                max={GALLERY_LAYOUT_LIMITS.playfulness.max}
                step={1}
                value={value.playfulness}
                onChange={(e) => set('playfulness', Number(e.target.value) as GalleryPlayfulness)}
                aria-label="Speelsheid"
                aria-valuetext={GALLERY_PLAYFULNESS_LABELS[value.playfulness]}
              />
              <div className="gal-look-ticks" aria-hidden="true">
                {([0, 1, 2, 3] as const).map(level => (
                  <button
                    key={level}
                    type="button"
                    tabIndex={-1}
                    className={value.playfulness === level ? 'is-on' : ''}
                    onClick={() => set('playfulness', level)}
                  >
                    {GALLERY_PLAYFULNESS_LABELS[level]}
                  </button>
                ))}
              </div>
            </div>
            <p className="gal-look-hint">{playfulnessHint(style, value.playfulness)}</p>
            <p className="gal-field-help gal-look-featured">
              <Expand size={13} aria-hidden="true" />
              {featured > 0
                ? `${featured} foto${featured === 1 ? '' : '’s'} groot getoond — die krijgen in elke indeling een grote plek, ook als het album strak is.`
                : 'Wil je zelf bepalen welke foto’s groot komen? Zet in de galerij bij een foto “Groot tonen” aan (het pijltjesknopje).'}
            </p>
          </section>
        )}

        <section className="gal-card">
          <span className="gal-card-title">Afwerking</span>
          <Row label="Hoeken">
            <Segmented
              label="Hoeken"
              value={value.corners}
              onChange={next => set('corners', next)}
              options={[
                { value: 'square', label: 'Recht' },
                { value: 'subtle', label: 'Subtiel' },
                { value: 'soft', label: 'Zacht' },
                { value: 'round', label: 'Rond' },
              ]}
            />
          </Row>
          {hasPhotos && (
            <Row label="Lijst om de foto’s" hint={style === 'prints' ? 'Afdrukken hebben hun eigen papieren rand.' : undefined}>
              <Segmented
                label="Lijst om de foto’s"
                value={value.frame}
                disabled={style === 'prints'}
                onChange={next => set('frame', next)}
                options={[
                  { value: 'none', label: 'Geen' },
                  { value: 'mat', label: 'Passe-partout', title: 'Een papieren rand, als een ingelijste afdruk' },
                  { value: 'line', label: 'Fijne lijn' },
                  { value: 'shadow', label: 'Zwevend', title: 'Een zachte schaduw onder elke foto' },
                ]}
              />
            </Row>
          )}
          {hasPhotos && (
            <Row label="Onder de muis">
              <Segmented
                label="Onder de muis"
                value={value.hover}
                onChange={next => set('hover', next)}
                options={[
                  { value: 'zoom', label: 'Inzoomen' },
                  { value: 'lift', label: 'Optillen' },
                  { value: 'none', label: 'Niets' },
                ]}
              />
            </Row>
          )}
          <Row label="Hoofdstuktitels">
            <Segmented
              label="Hoofdstuktitels"
              value={value.headings}
              onChange={next => set('headings', next)}
              options={[
                { value: 'label', label: 'Klein label' },
                { value: 'title', label: 'Grote titel' },
                { value: 'numbered', label: 'Genummerd', title: '01 Ceremonie, 02 Diner …' },
              ]}
            />
          </Row>
          {hasPhotos && (
            <label className="gal-field gal-field-row gal-look-toggle">
              <input type="checkbox" checked={value.reveal} onChange={(e) => set('reveal', e.target.checked)} />
              <span>
                Foto’s komen zacht binnen tijdens het scrollen
                <small>Wie op zijn apparaat om minder beweging vraagt, krijgt ze meteen.</small>
              </span>
            </label>
          )}
        </section>

        {hasVideos && (
          <section className="gal-card">
            <span className="gal-card-title">Video’s</span>
            <Row
              label="Weergave"
              hint={value.video_layout === 'auto'
                ? 'Automatisch: een videogalerij als raster, anders in rijen zoals bij streamingdiensten.'
                : undefined}
            >
              <Segmented
                label="Weergave van de video’s"
                value={value.video_layout}
                onChange={next => set('video_layout', next)}
                options={[
                  { value: 'auto', label: 'Automatisch' },
                  { value: 'rows', label: 'Rijen' },
                  { value: 'grid', label: 'Raster' },
                ]}
              />
            </Row>
            <Row label="Grootte van de tegels">
              <Segmented
                label="Grootte van de videotegels"
                value={value.video_size}
                onChange={next => set('video_size', next)}
                options={[
                  { value: 'small', label: 'Klein' },
                  { value: 'medium', label: 'Middel' },
                  { value: 'large', label: 'Groot' },
                ]}
              />
            </Row>
          </section>
        )}

        <div className="gal-look-reset">
          <button
            type="button"
            className="gal-linkbtn"
            disabled={isDefault}
            onClick={() => onChange({ ...GALLERY_LAYOUT_DEFAULTS })}
          >
            <RotateCcw size={12} /> Terug naar de standaard
          </button>
          {!isDefault && <span className="gal-field-help"><Sparkles size={11} aria-hidden="true" /> De standaard is de weergave van vóór deze instellingen.</span>}
        </div>
      </div>

      <LayoutPreview
        layout={value}
        items={items}
        categories={categories}
        bundle={bundle}
        format={format}
        branding={branding}
      />
    </div>
  );
}
