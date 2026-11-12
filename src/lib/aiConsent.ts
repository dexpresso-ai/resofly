/**
 * Gerrie aanzetten: wat je leest, wat je aanvinkt, en wanneer Gerrie aanstaat.
 *
 * Een gebruiker zet Gerrie zelf aan, per organisatie (migratie
 * 20261112160000, tabel ai_consents). Daarbij vinkt hij drie punten aan: de
 * AI leest je gegevens en stelt op basis daarvan handelingen voor, de AI kan
 * fouten maken, en de AI beslist niets zelf. Pas daarna kan hij Gerrie
 * gebruiken: de chat, het commandocentrum, de agents, de beslislijst, de
 * rapportages met Gerrie en een gekoppelde eigen AI (MCP).
 *
 * De database en de edge functions dwingen het af (set_ai_consent en
 * supabase/functions/_shared/aiConsent.ts). Dit bestand is de beleving: het
 * scherm en de regel of Gerrie aanstaat.
 *
 * Puur (geen Supabase, geen React), zodat `npm test` het kan nalopen.
 */

import type { AiConsent } from '../types';

export type { AiConsent };

/**
 * De versie van de tekst hieronder. Spiegel van public.ai_terms_version() en
 * van AI_TERMS_VERSION in supabase/functions/_shared/aiConsent.ts;
 * aiConsent.test.ts houdt de drie gelijk.
 *
 * Verander je een punt wezenlijk, hoog dan alle drie op. Wie onder de oude
 * tekst akkoord ging, ziet dan eerst de nieuwe voordat Gerrie weer werkt. Een
 * tikfout herstellen hoeft dat niet.
 */
export const AI_TERMS_VERSION = '2026-11-12';

export type AiConsentPointKey = 'gegevens_lezen' | 'kan_fouten_maken' | 'geen_eigen_beslissingen';

export interface AiConsentPoint {
  key: AiConsentPointKey;
  /** Kort, als kop boven het punt. */
  title: string;
  /** Wat het in gewone woorden betekent. */
  text: string;
  /** De zin naast het vinkje: wat je bevestigt. */
  confirm: string;
}

/**
 * De drie punten, in deze volgorde op het scherm. De sleutels staan ook in
 * set_ai_consent: die weigert aanzetten zonder alle drie.
 *
 * Bewust zonder modelnaam of leverancier: die tonen we nergens
 * (CHANGELOG_AI_MODEL_VERBORGEN_2026-11-11).
 */
export const AI_CONSENT_POINTS: readonly AiConsentPoint[] = [
  {
    key: 'gegevens_lezen',
    title: 'Gerrie leest je gegevens',
    text: 'Gerrie leest de gegevens van deze organisatie waar jij zelf bij mag: klanten, projecten, uren, agenda, mail, tickets, offertes, facturen en de rest. '
      + 'Op basis daarvan beantwoordt hij je vragen en stelt hij handelingen voor, zoals een mail, een factuur of een taak. '
      + 'Wat jij niet mag zien, ziet hij ook niet. Om je te antwoorden gaan die gegevens naar het AI-model van onze AI-leveranciers.',
    confirm: 'Ik begrijp dat Gerrie mijn gegevens leest en op basis daarvan handelingen voorstelt.',
  },
  {
    key: 'kan_fouten_maken',
    title: 'Gerrie kan zich vergissen',
    text: 'Een AI kan iets verkeerd lezen, verkeerd rekenen of iets noemen dat er niet staat. '
      + 'Kijk dus na wat Gerrie zegt en voorstelt, zeker bij bedragen, datums en alles wat naar een klant gaat.',
    confirm: 'Ik begrijp dat Gerrie fouten kan maken, en dat ik controleer wat hij voorstelt.',
  },
  {
    key: 'geen_eigen_beslissingen',
    title: 'Gerrie beslist niets zelf',
    // Eerlijk over de MCP-koppeling: die mag rechtstreeks uitvoeren, maar
    // alleen als de gebruiker dat zelf per koppeling aanzet
    // (CHANGELOG_MCP_UITVOEREN_2026-09-17). "Zet alleen klaar" klopte dan niet.
    text: 'Gerrie voert niets uit zonder toestemming. Hij zet een voorstel klaar, en pas als jij of een collega op Uitvoeren klikt, gebeurt het, met de rechten van wie klikt. '
      + 'Je agents zetten ook alleen klaar. Koppel je je eigen AI, dan voert die alleen zelf iets uit als jij dat per koppeling aanzet onder Instellingen → AI.',
    confirm: 'Ik begrijp dat Gerrie niets zelf beslist en alleen voorstelt; ik keur goed wat er gebeurt.',
  },
];

export const AI_CONSENT_KEYS: readonly AiConsentPointKey[] = AI_CONSENT_POINTS.map(point => point.key);

/** Aan, en onder de tekst die nu geldt. Een akkoord op een oudere tekst telt niet. */
export function consentIsActive(row: Pick<AiConsent, 'enabled' | 'terms_version'> | null | undefined): boolean {
  return Boolean(row && row.enabled === true && row.terms_version === AI_TERMS_VERSION);
}

/** Stond Gerrie aan onder een oudere tekst? Dan zeggen we dat de uitleg veranderde. */
export function consentIsOutdated(row: Pick<AiConsent, 'enabled' | 'terms_version'> | null | undefined): boolean {
  return Boolean(row && row.enabled === true && row.terms_version !== AI_TERMS_VERSION);
}

/** Zijn alle drie de punten aangevinkt? Dan pas mag de knop. */
export function allPointsChecked(checked: ReadonlySet<string> | readonly string[]): boolean {
  const set = checked instanceof Set ? checked : new Set(checked as readonly string[]);
  return AI_CONSENT_KEYS.every(key => set.has(key));
}

/** "aan sinds 12 november 2026" — voor de instellingen. */
export function consentSinceLabel(row: Pick<AiConsent, 'accepted_at'> | null | undefined): string | null {
  if (!row?.accepted_at) return null;
  const date = new Date(row.accepted_at);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Hoe Gerrie voor een teamlid staat, voor het overzicht van een owner of admin.
 * `blocked`: de module Gerrie staat voor hem dicht, dus aanzetten kan hij niet.
 */
export type AiConsentState = 'on' | 'off' | 'outdated' | 'blocked';

export function aiConsentState(row: Pick<AiConsent, 'enabled' | 'terms_version'> | null | undefined, moduleOpen: boolean): AiConsentState {
  if (!moduleOpen) return 'blocked';
  if (consentIsActive(row)) return 'on';
  if (consentIsOutdated(row)) return 'outdated';
  return 'off';
}

export const AI_CONSENT_STATE_LABEL: Record<AiConsentState, string> = {
  on: 'Gerrie aan',
  off: 'Gerrie uit',
  outdated: 'Moet de nieuwe uitleg nog lezen',
  blocked: 'Geen toegang tot Gerrie',
};
