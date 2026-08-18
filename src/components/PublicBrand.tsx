// Merk van de leverancier op de publieke tokenpagina's: offerte, factuur en
// contract. Die drie hebben elk vier losse `<main>`-elementen (laden, link
// verlopen, niet gevonden, de pagina zelf), dus een `style` op één root werkt
// er niet — vandaar dat de kleuren via `applyBrandTheme()` op `:root` landen en
// hier alleen het logo en de afsluiting staan.
import { useEffect } from 'react';
import { applyBrandTheme, type BrandingPayload } from '../lib/branding';

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
       branding.companyName, branding.logoDataUrl ? 'logo' : ''].join('|')
    : '';
  useEffect(
    () => applyBrandTheme(branding ?? null, pageName),
    [key, pageName], // eslint-disable-line react-hooks/exhaustive-deps
  );
}

/** Logo van de leverancier boven het document; zonder logo alleen zijn naam. */
export function PublicBrandMark({ branding, name }: {
  branding: BrandingPayload | null | undefined;
  name: string;
}) {
  if (!branding?.logoDataUrl) return null;
  return <div className="public-brand">
    <img src={branding.logoDataUrl} alt={branding.companyName ?? name} />
  </div>;
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
