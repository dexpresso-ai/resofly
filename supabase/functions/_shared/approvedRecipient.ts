// ============================================================
// Wat er op de goedkeurkaart stond, is waar de mail heen gaat.
//
// Een voorstel ("herinnering voor factuur 2026-014 naar kees@jansen.nl") wordt
// goedgekeurd op het adres dat erop staat. Wordt het e-mailadres van de klant
// daarna nog gewijzigd — per ongeluk, of door iemand die de post wil omleiden —
// dan keurde niemand die nieuwe ontvanger goed. De verzendfuncties nemen het
// adres anders zelf uit het klantdossier, op het moment van versturen.
//
// Daarom geeft de uitvoerder het goedgekeurde adres mee als
// `expectedRecipientEmail`, en weigert de server als het adres waar hij nu
// heen zou sturen, een ander is. Er gaat dan niets de deur uit; het voorstel
// opnieuw klaarzetten toont het nieuwe adres.
//
// Zonder `expectedRecipientEmail` (een knop in het scherm, waar het adres op dat
// moment zelf gekozen wordt, of een voorstel van vóór deze regel) is er niets
// te vergelijken en gaat alles zoals het ging.
// ============================================================

/** Zoals de verzendfuncties een adres vergelijken: zonder spaties, in kleine letters. */
export function normalizeRecipient(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

/** Is het adres veranderd sinds de goedkeuring? Zonder goedgekeurd adres: nee. */
export function approvedRecipientChanged(approved: unknown, current: unknown): boolean {
  const expected = normalizeRecipient(approved);
  if (!expected) return false;
  return expected !== normalizeRecipient(current);
}

export const RECIPIENT_CHANGED_MESSAGE =
  'Het e-mailadres van de klant is veranderd sinds dit voorstel is goedgekeurd; er is niets verstuurd. Zet het opnieuw klaar als het nieuwe adres klopt.';
