/**
 * Mag de audio van een opname weg, met behoud van transcript en notulen?
 * (Inhoud → Meetings, sinds 25 november.)
 *
 * Alleen als er een transcript is. Zolang de opname wacht op uitschrijven
 * ('uploaded', bijvoorbeeld omdat het AI-tegoed op was) of nog wordt
 * uitgeschreven ('transcribing'), is de audio het enige wat er is: zonder
 * audio kan hij nooit meer worden uitgeschreven. En een opname zonder
 * transcript (uitschrijven mislukt) houdt na het wissen niets over; die
 * verwijder je dan in zijn geheel.
 *
 * Los van index.ts zodat de test hem kan laden: index.ts start bij het laden
 * een server en een Supabase-client. De app toont de knop met dezelfde regel
 * (src/lib/meetingsOverview.ts, canDeleteAudio).
 */

export interface AudioRow {
  status: string;
  storage_key: string | null;
  transcript_text: string | null;
}

export type AudioDeleteDecision =
  | { kind: 'allowed' }
  /** Er is geen audio (meer): niets te doen, en ook geen fout. Zo kan een tweede klik geen kwaad. */
  | { kind: 'gone' }
  | { kind: 'refused'; message: string };

export function audioDeleteDecision(row: AudioRow): AudioDeleteDecision {
  if (!row.storage_key) return { kind: 'gone' };
  if (row.status === 'uploaded' || row.status === 'transcribing') {
    return { kind: 'refused', message: 'Deze opname is nog niet uitgeschreven. Zonder audio kan dat niet meer; wacht tot het transcript er is.' };
  }
  if (!row.transcript_text?.trim()) {
    return { kind: 'refused', message: 'Er is geen transcript van deze opname. Zonder audio blijft er niets van over; verwijder dan de hele opname.' };
  }
  return { kind: 'allowed' };
}
