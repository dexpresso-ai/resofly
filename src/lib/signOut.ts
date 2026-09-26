import { supabaseAuth } from './supabase';
import { disablePush } from './push-api';

// Werkgegevens die de app per gebruiker in deze browser bewaart. Voorkeuren
// (thema, zoom, weergave) blijven staan; dit hoort bij de persoon die uitlogt.
const USER_DATA_KEY_PREFIXES = [
  'resofly-timer',                  // lopende timer: omschrijving en taak
  'resofly:timer:',
  'resofly-checklist-',             // weekchecklist
  'resofly.pendingCall',            // net gebeld nummer met naam
  'brandcore.activeOrganizationId', // laatst gekozen organisatie
];

/**
 * Uitloggen op dit apparaat: eerst de pushmeldingen uit (anders blijft deze
 * browser afzender, onderwerp en chatregels van de vorige gebruiker tonen, ook
 * op een gedeelde computer), dan de werkgegevens weg, dan de sessie.
 */
export async function signOutOnThisDevice(): Promise<void> {
  await disablePush().catch(() => undefined);
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key && USER_DATA_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) keys.push(key);
    }
    keys.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // Opslag geblokkeerd (privévenster e.d.): dan staat er ook niets.
  }
  await supabaseAuth.signOut();
}
