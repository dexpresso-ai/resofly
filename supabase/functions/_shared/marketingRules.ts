// ============================================================
// Regels van de marketingmodule die op meer dan één plek gelden.
//
// Puur, zonder Deno-imports: de campaigns-functie, de handelingen van Gerrie
// en het scherm (src/features/Marketing.tsx) lezen dezelfde regel, en `npm
// test` toetst hem (marketingRules.test.ts). De database dwingt de
// afmeldregel zelf af (migratie 20261107140000); deze kopie zorgt dat het
// scherm en Gerrie niets aanbieden wat de database toch weigert.
// ============================================================

/** Waarom een adres op de afmeldlijst staat (email_suppressions.reason). */
export type SuppressionReason = 'unsubscribed' | 'bounced' | 'complained' | 'manual';

/**
 * Mag het team deze blokkering weer opheffen?
 *
 * Alleen wat het team zelf of de techniek erop zette: een handmatige blokkade
 * en een bounce (een adres kan weer werken). Een afmelding via de link of een
 * spamklacht is een keuze van de ontvanger zelf. Tot november 2026 kon elk
 * teamlid die met één klik "weer toestaan", en kreeg de persoon daarna gewoon
 * weer campagnes: in strijd met de AVG en de Telecommunicatiewet.
 */
export function suppressionRemovableByTeam(reason: string | null | undefined): boolean {
  return reason === 'manual' || reason === 'bounced';
}

/** De zin voor scherm en Gerrie als een blokkering vastligt. */
export function suppressionLockedMessage(reason: string | null | undefined): string {
  return reason === 'complained'
    ? 'Deze ontvanger heeft je mail als spam gemeld. Die blokkering kun je niet opheffen.'
    : 'Deze ontvanger heeft zich zelf afgemeld. Die afmelding kun je niet opheffen; alleen de ontvanger kan opnieuw toestemming geven.';
}

/**
 * Wat er gebeurt met ontvangers die een verzendronde al had opgepakt maar nog
 * niet verstuurde, als de campagne intussen niet meer op "verzenden" staat.
 * Gepauzeerd: terug in de wachtrij, hervatten pakt ze weer op. Geannuleerd of
 * weg: overgeslagen, want die mail gaat nooit meer uit.
 */
export function releasedRecipientStatus(campaignStatus: string | null | undefined): 'pending' | 'skipped' {
  return campaignStatus === 'paused' || campaignStatus === 'scheduled' || campaignStatus === 'draft'
    ? 'pending'
    : 'skipped';
}

/**
 * Een onderwerp of preheader is één regel. Een klantnaam met een regeleinde
 * (bijvoorbeeld uit een CSV-import) kwam via {{klantnaam}} anders letterlijk
 * in het onderwerp terecht.
 */
export function singleLine(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, ' ');
}

/**
 * Hoe lang een campagne op "verzenden" mag staan terwijl de ontvangerslijst
 * nog wordt klaargezet (started_at leeg). Daarna neemt de verzendronde het
 * over. Ruim boven de looptijd van een edge function (maximaal 400 seconden).
 */
export const MATERIALIZE_GRACE_MINUTES = 10;
