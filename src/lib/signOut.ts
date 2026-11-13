import { supabaseAuth } from './supabase';
import { disablePush } from './push-api';
import { clearSnapshots } from './workspaceSnapshot';

// Werkgegevens die de app per gebruiker in deze browser bewaart. Voorkeuren
// (thema, zoom, weergave) blijven staan; dit hoort bij de persoon die uitlogt.
const USER_DATA_KEY_PREFIXES = [
  'resofly-timer',                  // lopende timer: omschrijving en taak
  'resofly:timer:',
  'resofly-checklist-',             // weekchecklist
  'resofly.pendingCall',            // net gebeld nummer met naam
  'brandcore.activeOrganizationId', // laatst gekozen organisatie
  'resofly.chat.drafts.',           // nog niet verstuurde chatberichten
  'resofly.gerrie.decision-outbox', // besluiten van Gerrie die nog op de server moeten komen
  'resofly.onboarding.',            // waar je was in het inrichten van een organisatie
];

/**
 * Uitloggen op dit apparaat: eerst de pushmeldingen uit (anders blijft deze
 * browser afzender, onderwerp en chatregels van de vorige gebruiker tonen, ook
 * op een gedeelde computer), dan de werkgegevens weg, dan de sessie.
 */
export async function signOutOnThisDevice(): Promise<void> {
  await disablePush().catch(() => undefined);
  // De bewaarde stand van de werkruimte (src/lib/workspaceSnapshot.ts): klanten,
  // facturen en taken van deze gebruiker horen na uitloggen niet in de browser.
  // Met een grens: hangt IndexedDB, dan moet uitloggen toch doorgaan. De app
  // wist na het uitloggen nog eens (applySession zonder gebruiker).
  await Promise.race([clearSnapshots(), new Promise(resolve => setTimeout(resolve, 2000))]);
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
