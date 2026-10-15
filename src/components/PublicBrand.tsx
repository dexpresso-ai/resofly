// Merk van de leverancier op alles wat de klant ziet: het klantportaal en de
// publieke offerte-, factuur- en contractpagina. Die pagina's hebben elk
// meerdere losse `<main>`-elementen (laden, link verlopen, niet gevonden, de
// pagina zelf), dus een `style` op één root werkt er niet — vandaar dat de
// kleuren via `applyBrandTheme()` op `:root` landen en hier alleen het logo,
// de kop en de afsluiting staan.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  applyBrandTheme,
  brandThemeVars,
  headerTheme,
  isDarkSurface,
  logoPlate,
  type BrandingPayload,
} from '../lib/branding';
import { analyseLogo } from '../lib/logoColors';

/**
 * Zet de huisstijl van de leverancier op de documentschil zolang deze pagina
 * in beeld is. Vóór de fetch is `branding` nog `null`; dat levert precies het
 * donkere ResoFly-palet dat deze pagina's altijd al hadden, dus er zit geen
 * kleurflits tussen het laadscherm en de geladen pagina.
 */
export function usePublicBrandTheme(
  branding: BrandingPayload | null | undefined,
  pageName: string,
): void {
  // Alleen opnieuw toepassen als er echt iets aan het beeld verandert: de
  // payload wordt na "Akkoord geven" in z'n geheel vervangen door een nieuw
  // object met dezelfde huisstijl erin.
  const key = branding
    ? [branding.accentColor, branding.clientTheme, branding.headingFont, branding.bodyFont,
       branding.companyName, branding.headerColor, branding.logoDataUrl ? 'logo' : ''].join('|')
    : '';
  useEffect(
    () => applyBrandTheme(branding ?? null, pageName),
    [key, pageName], // eslint-disable-line react-hooks/exhaustive-deps
  );
}

/** De gemiddelde kleur per logo, één keer gemeten per sessie. */
const logoInkCache = new Map<string, string | null>();

/**
 * Hoe licht of donker is dit logo? Nodig om te weten of het op de kop een
 * plaatje nodig heeft. Meten kost een paar milliseconden (het logo is al een
 * data-URL); tot het klaar is staat het logo onzichtbaar op zijn plek, zodat er
 * geen plaatje bij komt springen.
 */
export function useLogoInk(src: string | null | undefined): { ink: string | null; ready: boolean } {
  const cached = src ? logoInkCache.get(src) : undefined;
  const [state, setState] = useState<{ src: string | null; ink: string | null; ready: boolean }>(() => ({
    src: src ?? null,
    ink: cached ?? null,
    ready: !src || cached !== undefined,
  }));
  useEffect(() => {
    if (!src) { setState({ src: null, ink: null, ready: true }); return; }
    if (logoInkCache.has(src)) { setState({ src, ink: logoInkCache.get(src) ?? null, ready: true }); return; }
    let alive = true;
    setState({ src, ink: null, ready: false });
    analyseLogo(src)
      .then(summary => summary.ink, () => null)
      .then(ink => {
        logoInkCache.set(src, ink);
        if (alive) setState({ src, ink, ready: true });
      });
    return () => { alive = false; };
  }, [src]);
  // Een nieuw logo is pas klaar als het zelf gemeten is, niet het vorige.
  if (state.src !== (src ?? null)) return { ink: cached ?? null, ready: !src || cached !== undefined };
  return { ink: state.ink, ready: state.ready };
}

/**
 * Het merk van de leverancier: zijn logo, of zonder logo zijn initiaal in een
 * tegel van de merkkleur. `on` zegt waar het staat — op de kop (die vaak donker
 * is) of op een kaart — want daar hangt van af welke versie van het logo we
 * tonen en of het een plaatje nodig heeft:
 *
 * - op een donker vlak de lichte versie, als die er is;
 * - anders het gewone logo, en valt dat weg, dan op een licht plaatje (of een
 *   donker, voor een wit logo op een lichte kaart).
 *
 * Zonder logo én zonder naam: niets. Liever geen merk dan de "R" van ResoFly op
 * andermans pagina.
 */
export function BrandMark({ branding, name, on, className = '' }: {
  branding: BrandingPayload | null | undefined;
  name: string;
  on: 'header' | 'surface';
  className?: string;
}) {
  const backgrounds = useMemo(() => {
    if (on === 'header') {
      const header = headerTheme(branding);
      return [header.top, header.mid];
    }
    return [brandThemeVars(branding)['--surface']];
  }, [branding, on]);
  const dark = isDarkSurface(backgrounds[backgrounds.length - 1]);
  const darkVersion = dark && branding?.logoDarkDataUrl ? branding.logoDarkDataUrl : null;
  const src = darkVersion ?? branding?.logoDataUrl ?? null;
  const { ink, ready } = useLogoInk(darkVersion ? null : src);

  if (!src) {
    if (!name) return null;
    return <span className={`brand-tile ${className}`.trim()} aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>;
  }
  const plate = darkVersion || !ready ? null : logoPlate(ink, backgrounds);
  return <span
    className={`brand-logo${plate ? ` on-plate plate-${plate}` : ''} ${className}`.trim()}
    style={ready ? undefined : { visibility: 'hidden' }}
  >
    <img src={src} alt={branding?.companyName || name} />
  </span>;
}

/** Afsluiting van de leverancier, met "Geleverd via ResoFly" tenzij uitgezet. */
export function PublicBrandFooter({ branding }: { branding: BrandingPayload | null | undefined }) {
  if (!branding) return null;
  if (!branding.footerText && branding.hidePoweredBy) return null;
  return <footer className="public-foot">
    {branding.footerText && <span className="public-foot-own">{branding.footerText}</span>}
    {!branding.hidePoweredBy && <span className="public-foot-by">Geleverd via ResoFly</span>}
  </footer>;
}

export type PublicHeroFact = { label: string; value: ReactNode; sub?: ReactNode; tone?: 'accent' | 'danger' };

/**
 * De kop van een publieke offerte-, factuur- of contractpagina: dezelfde kop
 * als het klantportaal, in de kopkleur van de leverancier, met het merk, wat
 * voor stuk het is, de titel, de status en de kern in glazen tegels.
 */
export function PublicDocHero({ branding, companyName, kind, title, intro, status, facts }: {
  branding: BrandingPayload | null | undefined;
  companyName: string;
  /** "Offerte", "Factuur", "Contract". */
  kind: string;
  title: ReactNode;
  intro?: ReactNode;
  /** De statuspil, bv. "Wacht op akkoord". */
  status?: ReactNode;
  facts?: PublicHeroFact[];
}) {
  return <header className="public-hero">
    <div className="public-hero-top">
      <div className="public-hero-brand">
        <BrandMark branding={branding} name={companyName} on="header" />
        {(!branding?.logoDataUrl || !companyName) && companyName && <span className="public-hero-name">{companyName}</span>}
      </div>
      {status}
    </div>
    <div className="public-hero-title">
      <p className="public-hero-eyebrow">{companyName ? `${kind} van ${companyName}` : kind}</p>
      <h1>{title}</h1>
      {intro && <p className="public-hero-intro">{intro}</p>}
    </div>
    {facts && facts.length > 0 && <div className="public-hero-facts">
      {facts.map(fact => <div key={fact.label} className={`public-hero-fact${fact.tone ? ` is-${fact.tone}` : ''}`}>
        <span>{fact.label}</span>
        <strong>{fact.value}</strong>
        {fact.sub && <em>{fact.sub}</em>}
      </div>)}
    </div>}
  </header>;
}

/**
 * Laden, een verlopen link of niets gevonden: dezelfde grond als de pagina
 * zelf, met één kaart erop. Zonder kop — er is nog geen merk om te tonen.
 */
export function PublicDocState({ children }: { children: ReactNode }) {
  return <main className="public-quote-page public-doc">
    <div className="public-canvas is-state">
      <div className="public-quote-card">{children}</div>
    </div>
  </main>;
}
