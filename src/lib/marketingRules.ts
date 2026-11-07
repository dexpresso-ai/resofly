// Spiegel van supabase/functions/_shared/marketingRules.ts voor het scherm.
// marketingRules.test.ts houdt de twee gelijk; de database (migratie
// 20261107140000) dwingt de regel zelf af. Deze kopie zorgt alleen dat het
// scherm geen knop toont die de database toch weigert.

/**
 * Mag het team deze blokkering weer opheffen? Alleen een handmatige blokkade
 * of een bounce. Een afmelding of spamklacht is een keuze van de ontvanger.
 */
export function suppressionRemovableByTeam(reason: string | null | undefined): boolean {
  return reason === 'manual' || reason === 'bounced';
}

/** De zin bij een blokkering die vastligt. */
export function suppressionLockedMessage(reason: string | null | undefined): string {
  return reason === 'complained'
    ? 'Deze ontvanger heeft je mail als spam gemeld. Die blokkering kun je niet opheffen.'
    : 'Deze ontvanger heeft zich zelf afgemeld. Die afmelding kun je niet opheffen; alleen de ontvanger kan opnieuw toestemming geven.';
}
