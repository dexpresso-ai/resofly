import type { OrganizationRole } from '../types';
// Met .ts: zo laadt node --test dit bestand ook.
import { isAccountantRole, isAdminRole } from './permissions.ts';

/**
 * De instellingen, ingedeeld in groepen.
 *
 * Tot 18 november stonden er negentien onderdelen onder elkaar: in het paneel
 * links, in het accountmenu en als één rij tabbladen op de pagina. Wie Online
 * betalen zocht, moest de hele lijst lezen; in het accountmenu vielen E-mail,
 * AI en Abonnement onder de vouw, en op de pagina schoof de helft van de rij
 * uit beeld. Nu hoort elk onderdeel bij één van zes groepen, en tonen alle
 * plekken dezelfde groepen in dezelfde volgorde.
 *
 * Puur (geen React), zodat settingsMenu.test.ts er met `node --test` overheen
 * draait. De iconen en de uitleg per onderdeel staan in SimplePages.tsx.
 */

export type SettingsGroupId = 'organisatie' | 'werkwijze' | 'klant' | 'geld' | 'koppelingen' | 'apparaat';

export const SETTINGS_GROUPS = [
  // Wie er meedoet en wat het kost; Logboek en Gegevens zijn het beheer daarvan.
  { id: 'organisatie', label: 'Organisatie', tabs: ['organisatie', 'abonnement', 'boekhouder', 'logboek', 'gegevens'] },
  // Hoe je je werk inricht.
  { id: 'werkwijze', label: 'Werkwijze', tabs: ['sjablonen', 'klantvelden', 'agenda'] },
  // Alles wat bij je klant aankomt: portaal, PDF's, het adres en de mails.
  { id: 'klant', label: 'Wat je klant ziet', tabs: ['huisstijl', 'documenten', 'domein', 'email'] },
  { id: 'geld', label: 'Geld', tabs: ['facturatie', 'betalen', 'boekhouding'] },
  { id: 'koppelingen', label: 'AI & koppelingen', tabs: ['ai', 'api', 'onedrive'] },
  // Per apparaat, niet per organisatie: meldingen en de losse apps.
  { id: 'apparaat', label: 'Op je apparaat', tabs: ['meldingen', 'apps'] },
] as const satisfies ReadonlyArray<{ id: SettingsGroupId; label: string; tabs: readonly string[] }>;

/** Alle onderdelen, in de volgorde van de groepen. */
export const SETTINGS_TAB_IDS = SETTINGS_GROUPS.flatMap(group => group.tabs);

export type SettingsTab = (typeof SETTINGS_GROUPS)[number]['tabs'][number];

export type SettingsGroup = { id: SettingsGroupId; label: string; tabs: readonly SettingsTab[] };

/** Bij welke groep hoort een onderdeel? */
export function settingsGroupOf(tab: SettingsTab): SettingsGroup {
  return SETTINGS_GROUPS.find(group => (group.tabs as readonly SettingsTab[]).includes(tab)) ?? SETTINGS_GROUPS[0];
}

/** De boekhouder ziet alleen wat bij de financiën hoort, en dan alleen-lezen. */
// Het logboek niet meer: dat is sinds 11 november alleen voor owners en admins.
// Apps wel (2026-11-12): de losse app Financiën is juist voor wie alleen daar komt.
export const ACCOUNTANT_SETTINGS_TABS: SettingsTab[] = ['organisatie', 'apps', 'facturatie', 'boekhouding'];

/**
 * De regels per rol voor de onderdelen. `null` = geen rolregel; dan beslist
 * visibleSettingsTabIds met de regels voor agenda en API.
 */
export function settingsTabRoleRule(tab: SettingsTab, role: OrganizationRole | null | undefined): boolean | null {
  if (isAccountantRole(role)) return ACCOUNTANT_SETTINGS_TABS.includes(tab);
  // Een boekhouder uitnodigen of de toegang intrekken is beheer.
  if (tab === 'boekhouder') return isAdminRole(role);
  // Het logboek is overzicht voor wie de organisatie beheert. Een teamlid zag
  // er per module wie wat deed, met de e-mailadressen van collega's en wie
  // wiens rechten aanpaste. De database geeft het hun ook niet meer
  // (20261111140000).
  if (tab === 'logboek') return isAdminRole(role);
  // Alles exporteren: de eigenaar en de beheerders (keuze van 11 november).
  // Het leest met de eigen rechten, maar het is wel alles in één keer; een
  // gewoon teamlid of de boekhouder doet dat niet. log_data_export weigert hen
  // ook.
  if (tab === 'gegevens') return isAdminRole(role);
  // De kopie in OneDrive: alleen de eigenaar (keuze van 24 november). Hij
  // koppelt zijn eigen OneDrive, en wie bij die map kan, ziet alle bestanden
  // van de klanten; dat beslist de eigenaar, niet een beheerder.
  if (tab === 'onedrive') return role === 'owner';
  return null;
}

/**
 * Welke onderdelen dit teamlid ziet. Eén regel voor de pagina én het menu.
 * Tot 18 november had het menu een eigen lijst, en die verborg AI voor een
 * gewoon teamlid terwijl de pagina het wel toonde: je eigen AI koppel je
 * persoonlijk, met je eigen rechten, en dan moet je hem ook zelf kunnen
 * loskoppelen.
 *
 * - Agenda alleen als de agenda-module openstaat.
 * - API & webhooks alleen voor owners en admins: een API-sleutel is een deur
 *   naar de hele organisatie (api-admin weigert het ook).
 */
export function visibleSettingsTabIds(role: OrganizationRole | null | undefined, { canReadCalendar }: { canReadCalendar: boolean }): SettingsTab[] {
  return SETTINGS_TAB_IDS.filter(tab => {
    const roleRule = settingsTabRoleRule(tab, role);
    if (roleRule !== null) return roleRule;
    if (tab === 'agenda') return canReadCalendar;
    if (tab === 'api') return isAdminRole(role);
    return true;
  });
}

/**
 * Zet onderdelen in hun groepen, in de vaste volgorde. Een groep waarvan dit
 * teamlid niets ziet, verdwijnt, kop en al.
 */
export function groupSettingsTabs<T extends { id: SettingsTab }>(tabs: readonly T[]): Array<{ id: SettingsGroupId; label: string; tabs: T[] }> {
  return SETTINGS_GROUPS
    .map(group => ({
      id: group.id,
      label: group.label,
      tabs: (group.tabs as readonly SettingsTab[]).flatMap(id => tabs.filter(tab => tab.id === id)),
    }))
    .filter(group => group.tabs.length > 0);
}
