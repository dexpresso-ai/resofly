/**
 * Naam, icoon en uitleg van elk onderdeel van de instellingen, en de groepen
 * zoals het paneel links, het accountmenu en de pagina ze tonen.
 *
 * Stond tot november 2026 in features/SimplePages.tsx. Het paneel links
 * (components/Sidebar.tsx) importeerde het daarvandaan en trok zo de hele
 * instellingenpagina, met de documentopmaak-editor, in de bundel die bij elke
 * start laadt. Nu laadt die pagina pas als je hem opent.
 */
import { Bell, BookOpen, Building2, Calculator, CalendarCog, Cloud, CreditCard, Download, Globe, History, LayoutTemplate, ListChecks, Mail, MonitorSmartphone, Palette, Plug, Receipt, ShieldCheck, Sparkles, SlidersHorizontal, Users, Wallet, Webhook, type LucideIcon } from 'lucide-react';
import { SETTINGS_TAB_IDS, groupSettingsTabs, type SettingsGroupId, type SettingsTab } from '../lib/settingsMenu';

export type SettingsTabMeta = { label: string; Icon: LucideIcon; description: string };

/** Naam, icoon en uitleg per onderdeel. Een Record, zodat TypeScript klaagt
 *  als een onderdeel uit lib/settingsMenu.ts hier nog geen gezicht heeft. */
const SETTINGS_TAB_META: Record<SettingsTab, SettingsTabMeta> = {
  organisatie: { label: 'Organisatie & team', Icon: Users, description: 'Beheer je werkruimte, teamleden en rollen.' },
  logboek: { label: 'Logboek', Icon: History, description: 'Wie wat wanneer en waar heeft aangepast: facturen verstuurd, documenten gewijzigd, taken afgerond, rechten aangepast. Per regel zie je wat er veranderde, van oud naar nieuw.' },
  sjablonen: { label: 'Projectsjablonen', Icon: ListChecks, description: 'Leg je vaste werkwijze vast als standaardtaken en subtaken, en rol die bij elk nieuw project in één klik uit.' },
  klantvelden: { label: 'Eigen klantvelden', Icon: SlidersHorizontal, description: 'Verzin je eigen velden bij een klant — en gebruik ze als variabele in je campagnes en mailings.' },
  huisstijl: { label: 'Huisstijl', Icon: Palette, description: 'Je logo, merkkleur, kopkleur en lettertypen op wat je klant ziet — het klantportaal, je offerte-, factuur- en contractpagina\'s, je offerte- en factuur-PDF\'s en de galerij — met een live voorbeeld van je klantportaal ernaast.' },
  domein: { label: 'Domein', Icon: Globe, description: 'Het adres waarop je klanten hun portaal, albums, offertes, facturen en contracten openen: je webadres bij ResoFly of je eigen domein. En het domein waarvan je mail verstuurt.' },
  documenten: { label: 'Documentopmaak', Icon: LayoutTemplate, description: 'Sleep de gegevens van je offertes en facturen naar de plek waar jij ze wilt hebben, of kies een kant-en-klaar sjabloon. Je klant krijgt precies de PDF die je hier ziet.' },
  meldingen: { label: 'Meldingen', Icon: Bell, description: 'Ontvang OS-meldingen op je apparaat bij nieuwe tickets, chatberichten, e-mails en boekingen — ook als ResoFly dicht is.' },
  apps: { label: 'Apps', Icon: MonitorSmartphone, description: 'Zet Agenda, Financiën en Communicatie elk als eigen app op je telefoon of computer. Zo\'n app opent meteen op de goede pagina.' },
  agenda: { label: 'Agenda', Icon: CalendarCog, description: 'Koppel Google Calendar of Microsoft Outlook, maak eigen ResoFly-agenda\'s, abonneer op een agenda via een link en zet de sync met je telefoon aan.' },
  facturatie: { label: 'Facturatie', Icon: Receipt, description: 'Bedrijfsgegevens en betaalteksten die op je facturen en offertes verschijnen. De opmaak en het briefpapier staan bij Documentopmaak.' },
  boekhouding: { label: 'Boekhouding', Icon: BookOpen, description: 'De boekhoud-startdatum (knipdatum) en de KOR-regeling voor je grootboek en BTW-aangifte.' },
  boekhouder: { label: 'Boekhouder', Icon: Calculator, description: 'Geef je boekhouder of accountant een gratis gastaccount dat alleen je financiën kan inzien — niets wijzigen, geen klantdossiers of projecten.' },
  betalen: { label: 'Online betalen', Icon: CreditCard, description: 'Kies of je facturen per e-mail of via Mollie verstuurt, en koppel Mollie zodat klanten je facturen direct online kunnen betalen.' },
  abonnement: { label: 'Abonnement', Icon: ShieldCheck, description: 'Je ResoFly-abonnement, betaalstatus en gebruikerslicenties.' },
  gegevens: { label: 'Gegevens', Icon: Download, description: 'Download al je gegevens in één keer: om over te stappen naar een ander pakket, voor je archief of voor je accountant.' },
  ai: { label: 'AI', Icon: Sparkles, description: 'Zet Gerrie, de AI-assistent, voor jezelf aan of uit. Koppel je eigen AI (Claude, ChatGPT, Gemini) aan deze werkruimte, en bekijk het verbruik en de kosten van Gerrie per gebruiker.' },
  onedrive: { label: 'OneDrive', Icon: Cloud, description: 'Houd een kopie van de bestanden uit Inhoud en de klantdossiers bij in je OneDrive. ResoFly blijft leidend: wat je hier verandert of verwijdert, gebeurt daar ook.' },
  api: { label: 'API & webhooks', Icon: Webhook, description: 'Koppel andere software aan ResoFly — een webshop, je urenapp, Zapier, Make of n8n — met een API-sleutel.' },
  email: { label: 'E-mail', Icon: Mail, description: 'Pas de teksten van je offerte-, factuur- en herinneringsmails en van de ticketmeldingen aan klanten aan, bepaal of klanten e-mail krijgen over hun tickets, en verstuur een testmail om je configuratie te controleren.' },
};

export type SettingsTabInfo = SettingsTabMeta & { id: SettingsTab };

/** Alle onderdelen, in de volgorde van hun groepen. */
export const SETTINGS_TABS: SettingsTabInfo[] = SETTINGS_TAB_IDS.map(id => ({ id, ...SETTINGS_TAB_META[id] }));

/** Het icoon van een groep: in het accountmenu staat per groep één regel. */
const SETTINGS_GROUP_ICONS: Record<SettingsGroupId, LucideIcon> = {
  organisatie: Building2,
  werkwijze: ListChecks,
  klant: Palette,
  geld: Wallet,
  koppelingen: Plug,
  apparaat: MonitorSmartphone,
};

export type SettingsMenuGroup = { id: SettingsGroupId; label: string; Icon: LucideIcon; tabs: SettingsTabInfo[] };

/** Wat dit teamlid in de instellingen ziet, per groep. Lege groepen vallen weg. */
export function settingsMenuGroups(visible: readonly SettingsTab[]): SettingsMenuGroup[] {
  return groupSettingsTabs(SETTINGS_TABS.filter(tab => visible.includes(tab.id)))
    .map(group => ({ ...group, Icon: SETTINGS_GROUP_ICONS[group.id] }));
}
