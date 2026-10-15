// Instellingen → Huisstijl: het merk van de leverancier, met het échte
// klantportaal ernaast als voorbeeld.
//
// Links staan de instellingen, rechts het portaal in een iframe
// (/portal/voorbeeld) met verzonnen gegevens. Elke wijziging gaat met
// postMessage naar dat voorbeeld, ook vóór Opslaan; zie src/lib/portalPreview.ts.
// Het voorbeeld draait op dezelfde componenten en dezelfde CSS als het echte
// portaal, dus het kan niet uit de pas lopen zoals de oude nagebouwde
// voorbeeldkaartjes deden.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction } from 'react';
import { Check, Maximize2, Minimize2, Monitor, RefreshCcw, Smartphone } from 'lucide-react';
import { Button, Input, Select } from '../components/Ui';
import { useLogoInk } from '../components/PublicBrand';
import {
  BRAND_BODY_FONTS,
  BRAND_FONTS,
  CLIENT_THEMES,
  GALLERY_BACKGROUNDS,
  brandFont,
  brandStyle,
  brandThemeVars,
  contrastRatio,
  ensureBrandFontsLoaded,
  headerTheme,
  isDarkSurface,
  isLighterThan,
  logoPlate,
  suggestHeaderColor,
  type BrandingPayload,
} from '../lib/branding';
import { analyseLogo } from '../lib/logoColors';
import { PORTAL_PREVIEW_PATH, PORTAL_PREVIEW_READY, portalPreviewMessage, type PortalPreviewScreen } from '../lib/portalPreview';
import type { CompanySettingsInput } from '../types';

type SetForm = Dispatch<SetStateAction<CompanySettingsInput>>;

const HEX = /^#[0-9A-Fa-f]{6}$/;

/** Max. logobreedte; groter heeft geen zin en het logo gaat als data-URL mee. */
const BRAND_LOGO_MAX_WIDTH = 600;
const BRAND_LOGO_MAX_BYTES = 300 * 1024;

/**
 * Schaalt het logo terug en levert een data-URL op. Data-URL i.p.v. R2 omdat de
 * publieke galerijpagina geen sessie heeft en dus geen media-token kan gebruiken;
 * zo blijft het logo daar gewoon zichtbaar. PNG blijft PNG (transparantie),
 * de rest wordt JPEG.
 */
async function logoToDataUrl(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    throw new Error('Kies een PNG-, JPEG- of WebP-bestand.');
  }
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, BRAND_LOGO_MAX_WIDTH / bitmap.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas niet beschikbaar.');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const usePng = file.type === 'image/png';
    const dataUrl = canvas.toDataURL(usePng ? 'image/png' : 'image/jpeg', usePng ? undefined : 0.9);
    if (dataUrl.length > BRAND_LOGO_MAX_BYTES * 1.4) {
      throw new Error('Dit logo is te groot. Gebruik een kleiner bestand (richtlijn: onder 300 kB).');
    }
    return dataUrl;
  } finally {
    bitmap.close();
  }
}

/** De kleuren die in het logo zitten, als knopjes onder de kleurvelden. */
function useLogoColors(src: string | null | undefined): string[] {
  const [colors, setColors] = useState<string[]>([]);
  useEffect(() => {
    if (!src) { setColors([]); return; }
    let alive = true;
    analyseLogo(src).then(
      summary => { if (alive) setColors(summary.colors); },
      () => { if (alive) setColors([]); },
    );
    return () => { alive = false; };
  }, [src]);
  return colors;
}

/** De huisstijl zoals die in het formulier staat, als de klantpagina hem krijgt. */
function formBranding(form: CompanySettingsInput): BrandingPayload {
  return portalPreviewMessage(form, 'overview').branding;
}

export function BrandStudio({ form, setForm, canWrite }: { form: CompanySettingsInput; setForm: SetForm; canWrite: boolean }) {
  return <div className="brand-studio">
    <div className="brand-studio-grid">
      <BrandingCard form={form} setForm={setForm} canWrite={canWrite} />
      <BrandPreviewPanel form={form} />
    </div>
  </div>;
}

// ── De instellingen ─────────────────────────────────────────────────────────

function LogoField({ label, value, onChange, canWrite, dark = false, help }: {
  label: string;
  value: string | null | undefined;
  onChange: (value: string | null) => void;
  canWrite: boolean;
  dark?: boolean;
  help: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  async function pick(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      onChange(await logoToDataUrl(file));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Logo verwerken mislukt.');
    }
  }
  return <div className="brand-logo-row">
    <div className={`brand-logo-preview${dark ? ' is-dark' : ''}`}>
      {value ? <img src={value} alt={label} /> : <span className="brand-logo-empty">{dark ? 'Geen lichte versie' : 'Geen logo'}</span>}
    </div>
    <div className="brand-logo-actions">
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        style={{ display: 'none' }}
        onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }}
      />
      <Button onClick={() => fileRef.current?.click()} disabled={!canWrite}>{value ? 'Ander bestand' : 'Kiezen'}</Button>
      {value && <Button variant="ghost" onClick={() => onChange(null)} disabled={!canWrite}>Verwijderen</Button>}
      <p className="settings-help">{help}</p>
      {error && <div className="error">{error}</div>}
    </div>
  </div>;
}

function ColorField({ id, label, value, onChange, disabled, fromLogo, fromLogoLabel }: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  fromLogo: string[];
  fromLogoLabel: string;
}) {
  return <>
    <div className="brand-color-row">
      <input
        type="color"
        className="brand-color"
        value={HEX.test(value) ? value.toLowerCase() : '#000000'}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        disabled={disabled}
        aria-label={`${label} kiezen`}
      />
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        disabled={disabled}
        maxLength={7}
        aria-label={`${label} als hexcode`}
      />
    </div>
    {fromLogo.length > 0 && <div className="brand-from-logo">
      <span>Uit je logo</span>
      {fromLogo.map(color => <button
        key={color}
        type="button"
        className={`brand-from-logo-swatch${value.toUpperCase() === color ? ' is-active' : ''}`}
        style={{ background: color }}
        onClick={() => onChange(color)}
        disabled={disabled}
        title={`${color} als ${fromLogoLabel}`}
        aria-label={`${color} als ${fromLogoLabel}`}
      />)}
    </div>}
  </>;
}

function BrandingCard({ form, setForm, canWrite }: { form: CompanySettingsInput; setForm: SetForm; canWrite: boolean }) {
  // Het voorbeeld moet de échte letters tonen, dus de gekozen families laden.
  useEffect(() => {
    ensureBrandFontsLoaded([form.brand_heading_font, form.brand_body_font]);
  }, [form.brand_heading_font, form.brand_body_font]);

  const branding = useMemo(() => formBranding(form), [form]);
  const header = useMemo(() => headerTheme(branding), [branding]);
  const logoColors = useLogoColors(form.brand_logo_data_url);
  const ownHeader = HEX.test(form.brand_header_color ?? '');
  // Wie even op Automatisch zet en terug op Eigen kleur, krijgt zijn kleur terug.
  const lastHeader = useRef<string | null>(form.brand_header_color ?? null);
  if (ownHeader) lastHeader.current = form.brand_header_color!;

  const set = <K extends keyof CompanySettingsInput>(key: K, value: CompanySettingsInput[K]) =>
    setForm(prev => ({ ...prev, [key]: value }));

  return (
    <section className="settings-card brand-card">
      <h3>Je merk</h3>
      <p className="settings-help">
        Naam, logo, kleuren en lettertypen: zo zien je klanten je in het klantportaal, op je offerte-, factuur- en
        contractpagina's, in de galerij en in je e-mails. In het voorbeeld zie je het portaal meteen veranderen.
      </p>

      <div className="brand-grid">
        <div className="brand-field brand-field-wide">
          <label className="brand-label" htmlFor="brand-trade-name">Merknaam</label>
          <Input
            id="brand-trade-name"
            value={form.trade_name ?? ''}
            onChange={(e) => set('trade_name', e.target.value)}
            placeholder="Bijv. Studio Noord"
            disabled={!canWrite}
          />
          <p className="settings-help">De naam waaronder je naar buiten treedt. Je juridische bedrijfsnaam staat bij Facturatie.</p>
        </div>

        <div className="brand-field brand-field-wide">
          <span className="brand-label">Logo</span>
          <LogoField
            label="Je logo"
            value={form.brand_logo_data_url}
            onChange={(value) => set('brand_logo_data_url', value)}
            canWrite={canWrite}
            help={`PNG, JPEG of WebP. We schalen het automatisch terug naar ${BRAND_LOGO_MAX_WIDTH}px breed.`}
          />
          <div className="brand-subfield">
            <span className="brand-label">Logo voor op donker <em>optioneel</em></span>
            <LogoField
              label="Lichte versie van je logo"
              value={form.brand_logo_dark_data_url}
              onChange={(value) => set('brand_logo_dark_data_url', value)}
              canWrite={canWrite}
              dark
              help="Valt je logo weg op een donkere kop, dan zetten we het op een licht plaatje. Met een lichte versie hoeft dat niet."
            />
          </div>
        </div>

        <div className="brand-field brand-field-wide">
          <label className="brand-label" htmlFor="brand-accent">Merkkleur</label>
          <ColorField
            id="brand-accent"
            label="Merkkleur"
            value={form.brand_accent_color}
            onChange={(value) => set('brand_accent_color', value)}
            disabled={!canWrite}
            fromLogo={logoColors}
            fromLogoLabel="merkkleur"
          />
          <p className="settings-help">Hoofdknoppen, het gekozen tabblad, de stip bij iets nieuws, links en de focusrand. Ook op je facturen, offertes, contracten en e-mails.</p>
        </div>

        <div className="brand-field brand-field-wide">
          <label className="brand-label" htmlFor="brand-header">Kopkleur</label>
          <div className="brand-seg" role="group" aria-label="Kopkleur">
            <button
              type="button"
              aria-pressed={!ownHeader}
              onClick={() => set('brand_header_color', null)}
              disabled={!canWrite}
            >Automatisch</button>
            <button
              type="button"
              aria-pressed={ownHeader}
              onClick={() => set('brand_header_color', lastHeader.current ?? suggestHeaderColor(form.brand_accent_color))}
              disabled={!canWrite}
            >Eigen kleur</button>
          </div>
          <ColorField
            id="brand-header"
            label="Kopkleur"
            value={ownHeader ? form.brand_header_color! : header.mid}
            onChange={(value) => set('brand_header_color', value)}
            disabled={!canWrite || !ownHeader}
            fromLogo={ownHeader ? logoColors : []}
            fromLogoLabel="kopkleur"
          />
          <p className="settings-help">
            Het vlak bovenin het klantportaal en je offerte-, factuur- en contractpagina, en achter het inlogscherm.
            Automatisch is diep grafiet in de tint van je merkkleur, net als je eigen werkruimte.
          </p>
        </div>

        <div className="brand-field brand-field-wide">
          <span className="brand-label">Werkvlak</span>
          <div className="brand-theme-row">
            {CLIENT_THEMES.map(option => {
              const vars = brandThemeVars({ ...branding, clientTheme: option.value });
              return <button
                key={option.value}
                type="button"
                className={`brand-theme-card${form.brand_client_theme === option.value ? ' is-active' : ''}`}
                onClick={() => set('brand_client_theme', option.value)}
                disabled={!canWrite}
                aria-pressed={form.brand_client_theme === option.value}
              >
                {/* Een miniatuur van het portaal met precies de tokens die het
                    straks krijgt: de kop, het werkvlak, een kaart en een knop. */}
                <span className="brand-theme-mini" style={vars as CSSProperties} aria-hidden="true">
                  <span className="brand-theme-mini-kop"><i /></span>
                  <span className="brand-theme-mini-canvas">
                    <span className="brand-theme-mini-card"><i /><b /></span>
                  </span>
                </span>
                <strong>{option.label}</strong>
                <small>{option.hint}</small>
              </button>;
            })}
          </div>
          <p className="settings-help">
            Licht of donker voor alles onder de kop. Vlakken, randen en tekst rekenen we uit je merkkleur uit; ze
            halen overal het vereiste contrast.
          </p>
        </div>

        <div className="brand-field">
          <span className="brand-label">Lettertype koppen</span>
          <Select
            value={form.brand_heading_font}
            onChange={(e) => set('brand_heading_font', e.target.value)}
            disabled={!canWrite}
          >
            {BRAND_FONTS.map(font => <option key={font.key} value={font.key}>{font.label}</option>)}
          </Select>
          <p className="settings-help">{brandFont(form.brand_heading_font).hint}</p>
        </div>

        <div className="brand-field">
          <span className="brand-label">Lettertype tekst</span>
          <Select
            value={form.brand_body_font}
            onChange={(e) => set('brand_body_font', e.target.value)}
            disabled={!canWrite}
          >
            {BRAND_BODY_FONTS.map(font => <option key={font.key} value={font.key}>{font.label}</option>)}
          </Select>
          <p className="settings-help">{brandFont(form.brand_body_font).hint}</p>
        </div>

        <div className="brand-field brand-field-wide">
          <span className="brand-label">Leesbaarheid</span>
          <ReadabilityChecks branding={branding} />
          <p className="settings-help">
            Rekent mee terwijl je kiest. Een kleur die als tekst te weinig afsteekt, schuiven we in helderheid op tot
            hij leest; de tint blijft die van jou.
          </p>
        </div>

        <div className="brand-field brand-field-wide">
          <span className="brand-label">Achtergrond van de galerij</span>
          <div className="brand-bg-row">
            {GALLERY_BACKGROUNDS.map(option => (
              <button
                key={option.value}
                type="button"
                className={`brand-bg-swatch${form.brand_gallery_bg?.toUpperCase() === option.value ? ' is-active' : ''}`}
                style={{ background: option.value }}
                onClick={() => set('brand_gallery_bg', option.value)}
                disabled={!canWrite}
                title={option.label}
                aria-label={option.label}
                aria-pressed={form.brand_gallery_bg?.toUpperCase() === option.value}
              />
            ))}
            <input
              type="color"
              className="brand-color"
              value={HEX.test(form.brand_gallery_bg) ? form.brand_gallery_bg.toLowerCase() : '#0b0b0b'}
              onChange={(e) => set('brand_gallery_bg', e.target.value.toUpperCase())}
              disabled={!canWrite}
              aria-label="Eigen achtergrondkleur"
            />
          </div>
          {/* De galerij heeft een eigen achtergrond; dit is hoe een kop met
              categorieën daarop staat, met de echte letters en kleuren. */}
          <div
            className="brand-preview"
            style={{
              ...brandStyle({ ...branding, galleryBg: form.brand_gallery_bg }),
              background: HEX.test(form.brand_gallery_bg) ? form.brand_gallery_bg : undefined,
              fontFamily: brandFont(form.brand_body_font).stack,
            } as CSSProperties}
          >
            {form.brand_logo_data_url && <img className="brand-preview-logo" src={form.brand_logo_data_url} alt="" />}
            <h4 style={{ fontFamily: brandFont(form.brand_heading_font).stack }}>Bruiloft Sanne &amp; Tim</h4>
            <p>De mooiste beelden van jullie dag — kies je favorieten en download ze in hoge resolutie.</p>
            <span className="brand-preview-chips">
              <span className="brand-preview-chip is-active">Ceremonie</span>
              <span className="brand-preview-chip">Diner</span>
              <span className="brand-preview-chip">Feest</span>
            </span>
          </div>
          <p className="settings-help">Tekst, randen en knoppen in de galerij passen zich aan: bij een lichte achtergrond wordt de tekst donker.</p>
        </div>

        <div className="brand-field brand-field-wide">
          <label className="brand-label" htmlFor="brand-footer">Afsluiting onder je klantpagina's</label>
          <Input
            id="brand-footer"
            value={form.brand_footer_text ?? ''}
            onChange={(e) => set('brand_footer_text', e.target.value || null)}
            placeholder="Bijv. Bedankt voor het vertrouwen — Studio Noord"
            disabled={!canWrite}
            maxLength={160}
          />
        </div>

        <label className="brand-field brand-field-wide check-row">
          <input
            type="checkbox"
            checked={form.brand_hide_powered_by}
            onChange={(e) => set('brand_hide_powered_by', e.target.checked)}
            disabled={!canWrite}
          />
          <span>&ldquo;Geleverd via ResoFly&rdquo; verbergen onder je klantpagina's</span>
        </label>
      </div>
    </section>
  );
}

// ── Leesbaarheid ────────────────────────────────────────────────────────────

type CheckRow = { title: string; ratio: number | null; adjusted: boolean; note: string };

function ratioLabel(ratio: number): string {
  return `${ratio.toFixed(1).replace('.', ',')} : 1`;
}

/**
 * Wat de afleiding met de gekozen kleuren deed, in gewone woorden. Alles haalt
 * de norm (dat bewaakt src/lib/branding.test.ts); een ↻ betekent dat we een
 * kleur hebben bijgesteld om daar te komen, zodat dat geen verrassing is.
 */
function ReadabilityChecks({ branding }: { branding: BrandingPayload }) {
  const vars = brandThemeVars(branding);
  const header = headerTheme(branding);
  const accent = vars['--accent'];
  const onAccent = vars['--on-accent'];
  const accentInk = vars['--accent-ink'];
  const surface = vars['--surface'];
  const worst = (ink: string) => Math.min(...header.surfaces.map(bg => contrastRatio(ink, bg)));

  const headerDark = isDarkSurface(header.mid);
  const darkVersion = headerDark && Boolean(branding.logoDarkDataUrl);
  const { ink: logoInk, ready: logoReady } = useLogoInk(darkVersion ? null : branding.logoDataUrl);
  const plate = branding.logoDataUrl && !darkVersion && logoReady ? logoPlate(logoInk, [header.top, header.mid]) : null;

  const rows: CheckRow[] = [
    {
      title: 'Tekst op je knoppen',
      ratio: contrastRatio(onAccent, accent),
      adjusted: false,
      note: onAccent === '#000000' || onAccent === '#FFFFFF'
        ? 'Puur zwart of wit: meer laat deze merkkleur niet toe.'
        : isDarkSurface(onAccent) ? 'Bijna-wit op je merkkleur.' : 'Bijna-zwart op je merkkleur.',
    },
    {
      title: 'Je merkkleur als tekst',
      ratio: contrastRatio(accentInk, surface),
      adjusted: accentInk !== accent,
      note: accentInk === accent
        ? 'Links en bedragen staan in je merkkleur zelf.'
        : `Links en bedragen staan in ${accentInk}: dezelfde tint, ${isLighterThan(accentInk, accent) ? 'lichter' : 'donkerder'}.`,
    },
    {
      title: 'Tekst op de kop',
      ratio: worst(header.ink),
      adjusted: header.headerAdjusted,
      note: header.headerAdjusted
        ? `Op je kopkleur las geen tekst goed genoeg; de kop staat daarom ${isLighterThan(header.mid, branding.headerColor ?? header.mid) ? 'iets lichter' : 'iets donkerder'} (${header.mid}).`
        : header.dark ? 'Lichte tekst op een donkere kop.' : 'Donkere tekst op een lichte kop.',
    },
    {
      title: 'Je merkkleur op de kop',
      ratio: worst(header.accent),
      adjusted: header.accentAdjusted,
      note: header.accentAdjusted
        ? `Op de kop staat hij als ${header.accent}, zodat de groet en het gekozen tabblad afsteken.`
        : 'Steekt genoeg af tegen de kop.',
    },
    {
      title: 'Logo op de kop',
      ratio: null,
      adjusted: Boolean(plate),
      note: !branding.logoDataUrl
        ? 'Zonder logo staat je initiaal in een tegel van je merkkleur.'
        : darkVersion ? 'Op de kop staat je lichte versie.'
          : !logoReady ? 'Even meten…'
            : plate ? 'Je logo valt weg op de kop; het komt op een licht plaatje. Met een lichte versie hoeft dat niet.'
              : 'Je logo steekt genoeg af tegen de kop.',
    },
  ];

  return <ul className="brand-checks" aria-live="polite">
    {rows.map(row => <li key={row.title} className={`brand-check${row.adjusted ? ' is-adjusted' : ''}`}>
      <span className="brand-check-icon" aria-hidden="true">{row.adjusted ? <RefreshCcw size={12} /> : <Check size={12} />}</span>
      <span className="brand-check-text"><strong>{row.title}</strong><span>{row.note}</span></span>
      {row.ratio !== null && <span className="brand-check-ratio">{ratioLabel(row.ratio)}</span>}
    </li>)}
  </ul>;
}

// ── Het voorbeeld ───────────────────────────────────────────────────────────

const PREVIEW_SIZES = {
  // Een laptop; het portaal is op 1100px precies zo breed als op een groot scherm.
  desktop: { width: 1100, height: 760 },
  phone: { width: 390, height: 780 },
} as const;

const SCREENS: Array<{ id: PortalPreviewScreen; label: string }> = [
  { id: 'overview', label: 'Overzicht' },
  { id: 'invoice', label: 'Factuur' },
  { id: 'login', label: 'Inloggen' },
];

function BrandPreviewPanel({ form }: { form: CompanySettingsInput }) {
  const [screen, setScreen] = useState<PortalPreviewScreen>('overview');
  const [device, setDevice] = useState<'desktop' | 'phone'>('desktop');
  const [full, setFull] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [viewportHeight, setViewportHeight] = useState(() => (typeof window === 'undefined' ? 900 : window.innerHeight));

  const message = useMemo(() => portalPreviewMessage(form, screen), [form, screen]);
  const messageRef = useRef(message);
  messageRef.current = message;

  // Elke wijziging meteen naar het voorbeeld.
  useEffect(() => {
    if (ready) frameRef.current?.contentWindow?.postMessage(message, window.location.origin);
  }, [message, ready]);

  // Het voorbeeld meldt zich zodra het geladen is; dan krijgt het de huidige stand.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.source !== frameRef.current?.contentWindow) return;
      if ((event.data as { type?: unknown } | null)?.type !== PORTAL_PREVIEW_READY) return;
      setReady(true);
      setFailed(false);
      frameRef.current?.contentWindow?.postMessage(messageRef.current, window.location.origin);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Meldt het voorbeeld zich niet, dan zeggen we dat liever dan een leeg vlak te laten staan.
  useEffect(() => {
    if (ready) return;
    const timer = window.setTimeout(() => setFailed(true), 10000);
    return () => window.clearTimeout(timer);
  }, [ready]);

  useEffect(() => {
    const element = stageRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setStage({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    const onResize = () => setViewportHeight(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => { observer.disconnect(); window.removeEventListener('resize', onResize); };
  }, []);

  useEffect(() => {
    if (!full) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setFull(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);

  const size = PREVIEW_SIZES[device];
  const phone = device === 'phone';
  const chrome = phone ? 20 : 30;
  // Past in de breedte van het paneel, en in de hoogte van het scherm (het
  // paneel blijft naast de instellingen staan terwijl je scrolt).
  const maxHeight = full ? Math.max(240, stage.height - 8) : Math.max(320, viewportHeight - 250);
  const maxWidth = Math.max(160, stage.width - (phone ? 20 : 0));
  const scale = Math.max(phone ? 0.5 : 0.3, Math.min(1, maxWidth / size.width, (maxHeight - chrome) / size.height));
  const host = typeof window === 'undefined' ? '' : window.location.host;

  return <section className={`settings-card brand-preview-panel${full ? ' is-full' : ''}`} aria-label="Voorbeeld van het klantportaal">
    <div className="brand-preview-bar">
      <div className="brand-preview-title">
        <h3>Zo ziet je klant het</h3>
        <p>Het klantportaal, met verzonnen gegevens.</p>
      </div>
      <div className="brand-preview-controls">
        <div className="brand-seg" role="group" aria-label="Scherm">
          {SCREENS.map(option => <button key={option.id} type="button" aria-pressed={screen === option.id} onClick={() => setScreen(option.id)}>{option.label}</button>)}
        </div>
        <div className="brand-seg" role="group" aria-label="Toestel">
          <button type="button" aria-pressed={!phone} onClick={() => setDevice('desktop')} title="Desktop"><Monitor size={14} aria-hidden="true" /><span>Desktop</span></button>
          <button type="button" aria-pressed={phone} onClick={() => setDevice('phone')} title="Telefoon"><Smartphone size={14} aria-hidden="true" /><span>Telefoon</span></button>
        </div>
        <Button onClick={() => setFull(value => !value)} aria-pressed={full}>
          {full ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}
          {full ? 'Sluiten' : 'Volledig scherm'}
        </Button>
      </div>
    </div>
    <div className="brand-preview-stage" ref={stageRef}>
      <div
        className={`brand-preview-device is-${device}`}
        style={{ width: Math.round(size.width * scale) + (phone ? 20 : 0) }}
      >
        {!phone && <div className="brand-preview-chrome" aria-hidden="true"><i /><i /><i /><span>{host}/portal</span></div>}
        <div className="brand-preview-viewport" style={{ width: Math.round(size.width * scale), height: Math.round(size.height * scale) }}>
          <iframe
            ref={frameRef}
            src={PORTAL_PREVIEW_PATH}
            title="Voorbeeld van het klantportaal"
            style={{ width: size.width, height: size.height, transform: `scale(${scale})` }}
          />
        </div>
      </div>
      {failed && !ready && <p className="brand-preview-failed">Het voorbeeld kon niet worden geladen. Ververs de pagina om het opnieuw te proberen.</p>}
    </div>
    <p className="settings-help brand-preview-foot">Wat je kiest, zie je hier meteen. Je klanten zien het pas na Opslaan.</p>
  </section>;
}
