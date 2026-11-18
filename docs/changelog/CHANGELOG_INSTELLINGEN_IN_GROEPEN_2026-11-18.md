# Instellingen in groepen: het menu links, het accountmenu en de pagina (2026-11-18)

## Wat de PO vroeg

> Zorg ervoor dat alle instellingen vanuit het menu makkelijk worden
> gecategoriseerd voor de gebruiker, waardoor de UX en UI beter wordt. Gaat met
> name om het menu aan de linkerkant.

## Wat er mis was

Eerst is de app geopend tegen de nagebootste backend van de tests (Baken,
desktop 1440×900 en telefoon 390×844, licht en donker). Gevonden:

- **Negentien onderdelen onder elkaar.** Het paneel links (Baken, Zenit en
  Stroom) toonde op de pagina Instellingen alle onderdelen als één lijst, in
  een willekeurige volgorde: Logboek tussen Organisatie en Projectsjablonen,
  Boekhouder na Boekhouding, Abonnement onderaan. Wie Online betalen zocht,
  moest de hele lijst lezen.
- **Het menu wist niet waar je was.** In het paneel lichtte niets op, ook niet
  het onderdeel dat openstond. Een tabblad kiezen op de pagina zelf kwam niet
  in het werktabblad terecht, dus de terugknop sloeg het ook over.
- **In het accountmenu vielen onderdelen weg.** Het menu onder je avatar had
  dezelfde negentien regels. Het lijstje schoof binnen het menu: Boekhouder,
  Online betalen, Abonnement, Gegevens, AI, API & webhooks en E-mail stonden
  onder de vouw.
- **Op de pagina schoof de helft uit beeld.** De tabbladen stonden in één rij.
  Op een computer van 1440 breed was alles na Apps alleen te bereiken door
  opzij te schuiven.
- **Menu en pagina hadden elk hun eigen regels.** Het menu verborg AI voor een
  gewoon teamlid, terwijl de pagina het wel toonde. Daar koppel je je eigen AI
  en zet je Gerrie voor jezelf aan of uit.
- **Content schoof door de plakkende balk.** Boven de tabbladen bleef bij
  scrollen een strook open zo hoog als de binnenrand van het werkvlak (24, 16 of
  12px). Daarin waren halve kaarten te zien.

## Wat er nu staat

### Zes groepen, overal dezelfde

| Groep | Onderdelen |
| --- | --- |
| Organisatie | Organisatie & team, Abonnement, Boekhouder, Logboek, Gegevens |
| Werkwijze | Projectsjablonen, Eigen klantvelden, Agenda |
| Wat je klant ziet | Huisstijl, Documentopmaak, Domein, E-mail |
| Geld | Facturatie, Online betalen, Boekhouding |
| AI & koppelingen | AI, API & webhooks |
| Op je apparaat | Meldingen, Apps |

De indeling staat op één plek: `src/lib/settingsMenu.ts`. Daar staat ook wie
wat ziet. Het paneel links, het accountmenu en de pagina lezen allemaal daaruit.
Een groep waarvan iemand niets ziet, verdwijnt met kop en al. De boekhouder
ziet Organisatie (Organisatie & team), Geld (Facturatie, Boekhouding) en Op je
apparaat (Apps).

### Het menu links (Baken, Zenit, Stroom)

- Op de pagina Instellingen toont het paneel de zes groepen met elk een kopje.
  Dat is dezelfde vorm als Geld met zijn Verkoop, Inkoop en Boekhouding.
- Het onderdeel dat openstaat licht op, ook als je het op de pagina zelf koos.
- Het accountmenu (je avatar onderin de rail) toont per groep één regel met
  eronder wat erin zit: "Geld · Facturatie · Online betalen · Boekhouding". Een
  klik opent het eerste onderdeel van die groep. Het menu schuift niet meer en
  past in één keer.

### Het menu van Cockpit

Het accountmenu in de zijbalk houdt alle onderdelen (de stroomtests klikken er
direct op), maar nu onder een kopje per groep. Het onderdeel dat openstaat licht
op.

### De pagina Instellingen

- Bovenaan de zes groepen, als tabbladen. Op een computer passen ze naast
  elkaar.
- Daaronder de onderdelen van de gekozen groep, als keuzestrook (hooguit vijf).
- Kies je een groep opnieuw, dan kom je terug bij het onderdeel waar je in die
  groep was.
- Beide rijen plakken bovenaan. Zodra ze plakken, dekt een vlak in de kleur van
  het werkvlak de strook erboven (`useStickyCover`). In rust niet, anders viel
  het over de kop.
- Op de telefoon heeft de groepenrij geen kader meer: de keuzestrook eronder
  heeft er al een.

### De terugknop

Een onderdeel kiezen op de pagina is nu een stap, net als via het menu. Terug
gaat langs de onderdelen waar je was en daarna omhoog naar het dashboard. Terug
naar hoe de pagina opende zet de pagina ook weer op Organisatie & team. Eerst
bleef hij staan op het onderdeel waar je vandaan kwam.

## Bestanden

- `src/lib/settingsMenu.ts` (nieuw): de groepen, `visibleSettingsTabIds` (één
  regel voor menu en pagina), `settingsTabRoleRule` en
  `ACCOUNTANT_SETTINGS_TABS` (verhuisd uit SimplePages) en `groupSettingsTabs`.
- `src/lib/settingsMenu.test.ts` (nieuw): elk onderdeel in precies één groep,
  elk onderdeel met naam en uitleg, en de regels voor eigenaar, teamlid,
  boekhouder en zonder agenda-module.
- `src/features/SimplePages.tsx`: `SETTINGS_TAB_META` als `Record`, dus
  TypeScript klaagt als een onderdeel geen naam heeft. Verder
  `settingsMenuGroups`, de twee rijen op de pagina, `onTabChange` en
  `useStickyCover`.
- `src/components/ZenitNav.tsx`: het paneel per groep met het actieve
  onderdeel, en het accountmenu per groep.
- `src/components/Sidebar.tsx`: `visibleSettingsGroups` en het accountmenu van
  Cockpit met kopjes. Nieuwe eigenschap `settingsTab`.
- `src/main.tsx`: `settingsTab` naar het menu, en `onTabChange` zet het
  onderdeel in het werktabblad. De `key` blijft gelijk: die zet het logboek op
  nul, en dat hoort alleen bij navigeren via het menu.
- `src/styles/globals.css`, `zenit.css`, `baken.css`: `.settings-nav`,
  `.settings-subtabs`, de kopjes in het accountmenu van Cockpit en de regels
  per groep in het accountmenu van Baken.
- `src/components/InboundInbox.tsx`: de opvangbak verwees naar "Instellingen →
  E-mail & domeinen". Dat onderdeel bestaat niet; het doorstuuradres staat
  onder E-mail.
- `tests/mobile/run.mjs`: de onderdelen van Instellingen gaan via hun groep
  (`settingsPage`). De test eist nu ook dat het gevraagde onderdeel echt
  gekozen is. Eerst sloeg hij een stap die niet in beeld was stilletjes over, en
  mat hij Organisatie & team.
- `tests/terugknop/run.mjs`: nieuw scenario "Instellingen: terug gaat langs de
  onderdelen die je koos".

## Getest

- `npm run typecheck`: groen.
- `npm test`: 1925 tests, alles groen (waarvan 7 nieuw in settingsMenu.test.ts).
- `npm run test:terugknop`: 13 van 13, met het nieuwe scenario.
- `npm run test:mobile -- --theme=both`: zie hieronder.
- Met de hand gekeken (schermafdrukken) in Baken licht en donker, Stroom en
  Cockpit: desktop met het paneel vast, het accountmenu open, gescrold, en de
  telefoon met het menu open.
