/**
 * De tekst van een bankbestand uit de bytes, zonder imports: zo is het met
 * `node --test` te testen (encoding.test.ts).
 *
 * Eerder las de app elk bestand als UTF-8 (`file.text()`). Sommige banken
 * (Rabobank en ING worden vaak genoemd) leveren ISO-8859-1 of Windows-1252;
 * dan werd "Café Hé Zuid" "Caf� H� Zuid", en matchte zo'n naam nergens meer
 * op. Geldige UTF-8 blijft UTF-8 (een BOM gaat eraf); is het geen geldige
 * UTF-8, dan lezen we Windows-1252, dat ISO-8859-1 helemaal omvat.
 */
export function decodeBankBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}
