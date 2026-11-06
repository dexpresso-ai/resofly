# Changelog — De huisstijl op het inlogscherm van het klantportaal, met eigen kleuren — 2026-11-06

## Aanleiding

> De branding instellingen moeten ook terugkomen op het klant inlogscherm. Bouw dit zorgvuldig en
> foutloos voor me. Dat betekent dat men zelf de kleuren kan configureren van de klant login.

Wat er was:

- **Eén inlogadres voor iedereen: `/portal`.** Welke leverancier bij een bezoeker hoort, bleek pas
  na het inloggen, uit zijn e-mailadres. Een klant die voor het eerst kwam, zag daarom altijd de
  standaardstijl van ResoFly met "Klantportaal" als naam. Pas daarna, en alleen op hetzelfde
  apparaat, stond het inlogscherm in het merk van de leverancier.
- Het adres vóór het inloggen naar de server sturen om de huisstijl op te halen, kon niet: dan
  verklapt het inlogscherm van elk e-mailadres bij wie het klant is. Dat stond ook zo in de code.
- **Kleuren voor het inlogscherm** kon je niet kiezen. Het volgde de kopkleur, het werkvlak en de
  merkkleur.

## Wat er is veranderd

### Een eigen inlogadres per organisatie

- Elke organisatie heeft nu een eigen adres: **`/portal/<sleutel>`**, bijvoorbeeld
  `/portal/studio-noord-ro2ystqucm`. Op dat adres staat het inlogscherm meteen in de huisstijl,
  ook voor wie er nog nooit was: logo (of initiaal), naam, lettertypen, afsluiting, en de kleuren
  hieronder.
- **De sleutel** is de merknaam plus tien willekeurige tekens (50 bits), zoals het doorstuuradres
  van de inkoopfacturen. Leesbaar voor de klant, maar niet te raden. Met alleen een bedrijfsnaam kun
  je dus niet aftasten of iemand ResoFly gebruikt. En het inlogscherm verklapt nog steeds van geen
  enkel e-mailadres wie de leverancier is: de sleutel staat al in het adres dat de leverancier zelf
  uitdeelt.
- **Alle mails met een link naar het portaal** gebruiken dat adres: de welkomstmail, de
  ticketmeldingen (ook de deeplink naar een ticket en naar de meldingsinstellingen), een gedeeld
  bestand voor een contactpersoon, en de bevestiging van een getekend contract. Zonder adres
  (bijvoorbeeld zolang de migratie nog moet) gaat de mail met `/portal`, zoals voorheen.
- **In de app** staat het adres bij Instellingen → Huisstijl, met *Kopiëren* en *Openen*, en bij
  een klant onder *Klantportaal*. Zet het ook op je website.
- `/portal` zelf werkt nog precies zoals voorheen.

### De kleuren van het inlogscherm

Instellingen → Huisstijl heeft een nieuw blok, *Inlogscherm van je klantportaal*:

- **Achtergrond**: automatisch (de kopkleur) of een eigen kleur. Met de schakelaar **Effen** zonder
  verloop, gloed en ringen.
- **Inlogkaart**: automatisch (het werkvlak, licht of donker) of een eigen kleur.
- **Knop**: automatisch (de merkkleur) of een eigen kleur. Ook de focusrand, het stipje en de regel
  boven "Inloggen" krijgen die kleur.
- **Leesbaarheid**, net als bij de kop: wat de afleiding met je kleuren deed, met de verhouding.
  Tekst op de kaart, tekst op de knop, de knop tegen de kaart, de knopkleur als tekst, de
  achtergrond en het logo op de kaart.
- Het **voorbeeld** ernaast springt naar *Inloggen* zodra je in dit blok werkt, met het eigen adres
  in de adresbalk.

**Wat je ook kiest, het leest** (`loginTheme()` in `src/lib/branding.ts`):

- Tekst op de kaart is bijna-zwart of bijna-wit, wat het best leest, en haalt 4,75 : 1 op de kaart
  en op het invulveld. Een kaart midden in de grijstrap (bijvoorbeeld #777777) laat geen tekst tot de
  norm komen. Dan schuift de kaart een stukje van het midden af, net als de kop, en dat staat bij
  *Leesbaarheid*.
- Gedempte tekst haalt dezelfde marge, de voorbeeldtekst in het invulveld 4,5 : 1.
- Tekst op de knop haalt 4,5 : 1. Steekt de knop zelf minder dan 3 : 1 af tegen de kaart (een witte
  knop op een witte kaart), dan krijgt hij een rand in dezelfde tint (WCAG 1.4.11), en het tegeltje
  met de initiaal en het stipje ook.
- De meldingen onder de knop ("Als dit adres bij ons bekend is…", een fout) worden tegen de kaart
  gemeten.
- Het invulveld hoort bij de kaart. Het werkvlak heeft er een vaste kleur voor (bijna-zwart in
  Donker), die op `:root` vastligt en niet meekleurde: een wit veld op een witte kaart, een dieper
  veld op een donkere.

**Zonder eigen kleuren verandert er niets** aan het inlogscherm, met drie bewuste uitzonderingen:

- In het lichte werkvlak werd de onderkant van het inlogscherm licht: een regel voor het
  inlogscherm van de werkruimte (`:root[data-theme="light"] .login`) won van die van het portaal.
  Nu is het hele scherm in de kopkleur, zoals bedoeld ("het hele scherm in de kopkleur met de kaart
  erop").
- Een lichte merkkleur op een witte kaart (het standaardgoud in Licht) krijgt de rand uit het punt
  hierboven.
- De voorbeeldtekst in het invulveld heeft een vaste, leesbare tint in plaats van die van de browser.

### Na de inloglink

- De inloglink in de mail komt terug op `/portal` (het terugkeeradres dat Supabase kent). Het
  apparaat onthoudt daarom bij het aanvragen de sleutel even (twee uur, zoals een deeplink).
  - Hij telt alleen bij de terugkeer van de inloglink zelf (`?code=…`, of `?error=…` bij een
    verlopen link). Dan staat het laadscherm in de huisstijl, of het inlogscherm van de leverancier
    als de link verlopen is.
  - Wie bij meer leveranciers klant is, komt in het dossier van de leverancier via wiens adres hij
    inlogde. Een deeplink uit een mail gaat nog altijd voor.
  - Een gewoon bezoek aan `/portal` gebruikt hem niet. Anders liet iemand die op een gedeelde
    computer een link aanvroeg en hem nooit opende, `/portal` twee uur in de huisstijl van zijn
    leverancier achter.
  - Een aanvraag op `/portal` zonder sleutel wist een oude.
- **Op het eigen adres** valt het scherm nooit terug op een huisstijl die het apparaat van een
  (andere) leverancier onthield. Zolang de huisstijl onderweg is, of als hij niet komt, is het even
  neutraal.
- **Uitloggen** met de knop laat in het tabblad niets meer van de vorige klant staan: niet wat op
  schijf stond, niet wat er nog in het geheugen zat, en ook geen sleutel die niet uit het adres
  kwam. Een sessie die vanzelf verloopt telt niet als uitloggen. De huisstijl staat dan nog op
  schijf, en het scherm toont hem dus ook, net als na herladen.

### Gerrie

- *Huisstijl bekijken* geeft ook de kleuren van het inlogscherm en het eigen inlogadres. Het leest
  dat adres alleen (`portal_login_key`); een lees-handeling maakt niets aan, ook geen sleutel.
- *Huisstijl opslaan* kan de drie kleuren zetten (of op "automatisch") en de achtergrond effen
  maken. Zoals altijd: voorstellen, een mens keurt goed.

## Hoe het werkt

| Waar | Wat |
| --- | --- |
| `supabase/migrations/20261106080000_klantlogin_huisstijl.sql` | Kolommen `brand_login_bg_color`, `brand_login_card_color`, `brand_login_button_color` (hex of leeg, CHECK) en `brand_login_plain`. Tabel `portal_login_addresses` (één sleutel per organisatie, CHECK op de vorm). `generate_portal_login_key` (alleen service-role), `ensure_portal_login_key` (maakt het adres als het er nog niet is) en `portal_login_key` (leest alleen); authenticated alleen met leesrecht op Klanten. Elke bestaande organisatie krijgt meteen een adres. `create_child_organization` neemt de kleuren over van de moeder. |
| `portal-login` (edge function) | Nieuwe actie `getBranding`: bij een geldige sleutel de huisstijl via `loadBranding`, nooit het id of gegevens van de organisatie. Een eigen rem per afzender (120 per 10 minuten). Onbekend of ongeldig: `null`, dan neutraal. |
| `_shared/portalAddress.ts` | De sleutelregel, de link naar het portaal en `loadPortalLoginKey` (gooit nooit). |
| `_shared/branding.ts` | De loginkleuren in de huisstijl, met een terugval als de migratie nog moet. |
| `client-portal` | Elk dossier krijgt het inlogadres van zijn leverancier mee, voor de dossierkeuze. |
| `src/lib/branding.ts` | `loginTheme()` / `loginThemeVars()`: alle kleuren van het inlogscherm, inline op `main.portal.login`. |
| `src/features/portal/ClientPortal.tsx` | Leest de sleutel uit het adres, haalt de huisstijl op (hooguit vier seconden wachten, dan neutraal) en past de kleuren toe. |
| `src/features/BrandStudio.tsx` | Het blok *Inlogscherm van je klantportaal*. |
| `src/lib/portalLoginKey.ts` | De sleutelregel voor de app; de test legt hem naast de CHECK en de server. |

**Privacy en tenancy:** het adres geeft alleen wat de klant van de leverancier al ziet (logo, naam,
kleuren, letters, afsluiting). De tabel met sleutels is voor anon en authenticated dicht. Een
teamlid leest het adres van de eigen organisatie alleen via `ensure_portal_login_key`, dat het
modulerecht op Klanten controleert. Een sleutel kan een teamlid niet omzetten: die staat al in
verstuurde mails. De tabel heeft het boekhouder-hek, zodat de rooktest (`accountant_fence_gaps`)
geen gat ziet.

## Controle achteraf: wat er nog mis was, en is hersteld

Een onafhankelijke review van de eerste versie (`acfc26a`) vond zes echte problemen. De eerste drie
zag de reviewer in Chromium gebeuren. Alle zes zijn hersteld en met dezelfde scenario's
nagelopen.

| # | Wat er mis was | Hersteld |
| --- | --- | --- |
| 1 | Na uitloggen bleef de huisstijl van de vorige klant staan als hij via de onthouden sleutel binnenkwam (`/portal` na de inloglink). Op een gedeelde computer zag de volgende bezoeker zo bij wie hij klant was. En wie alleen een link aanvroeg, liet `/portal` twee uur in die huisstijl achter. | Uitloggen ruimt ook een sleutel op die niet uit het adres kwam. De onthouden sleutel telt alleen bij de terugkeer van de inloglink. Een aanvraag zonder sleutel wist een oude. |
| 2 | Op het adres van leverancier A stond eerst de huisstijl die het apparaat van leverancier B onthield. Was `getBranding` traag of mislukte het, dan bleef het complete inlogscherm van B staan. | Met een sleutel nooit terugvallen op de onthouden huisstijl: zolang hij onderweg is, of als hij niet komt, neutraal. |
| 3 | Een hexcode intypen lukte niet. Bij een half getypte code sprong het veld op Automatisch en ging het dicht. De bestaande kopkleur had dezelfde fout, en een half getypte merkkleur werd bij Opslaan stil het standaardgoud. | Het kleurveld houdt een eigen concept bij. Alleen een volledige code gaat het formulier in, en bij weggaan met een halve code komt de geldende kleur terug. Dat geldt voor alle kleurvelden. |
| 4 | Verliep een sessie vanzelf, dan werd het inlogscherm neutraal, en na herladen stond het merk er weer. | Alleen de knop Uitloggen ruimt het geheugen op. |
| 5 | Een teamlid zonder leesrecht op Klanten kreeg "de database-update moet nog draaien". | De app zegt waarom er geen adres is: geen rechten, de migratie, of een storing. |
| 6 | De lees-handeling van Gerrie (*Huisstijl bekijken*) maakte via `ensure_portal_login_key` een adres aan (harde regel 2). | Nieuwe functie `portal_login_key`, die alleen leest. De migratie stond nog niet op staging, dus kon dat in dezelfde migratie. |

Nagelopen en in orde bevonden:

- `getBranding` geeft alleen de vaste lijst van `sanitizeBranding`, nooit `organization_id`.
- De rechten per rol.
- `organization_id` komt overal uit de sessie of een al gefilterde rij.
- De migratie twee keer na elkaar, en de generator over 20.023 namen (0 keer buiten de CHECK).
- `create_child_organization` is gelijk op de vier kolommen na.
- De terugval zonder migratie.
- De richtingen in `loginTheme`, en de standaardweergave zonder eigen kleuren.
- De throttle van `requestLogin` is ongewijzigd, en de mails gebruiken het eigen adres.

## Niet gedaan (bewust, of voor later)

- **Het terugkeeradres van de inloglink** blijft `/portal`. Een ander adres (`/portal/<sleutel>`)
  moet in Supabase bij de toegestane adressen staan, en dat valt vanuit deze sessie niet na te
  gaan. Een fout daar breekt het inloggen. De sleutel op het apparaat vangt hetzelfde op.
- **Een eigen adres kiezen** (een "vanity"-adres) of het adres vernieuwen: niet gevraagd. Een
  gekozen naam is wel te raden.
- **Teksten op het inlogscherm** (een eigen welkomstzin): niet gevraagd.

## Getest

- **Migratie:** de hele keten vanaf nul op een lege database (`supabase db start`, na het herstel
  opnieuw met `supabase db reset --local`), en de migratie daarna nog twee keer opnieuw gedraaid.
  Nagekeken:
  - sleutels voor lastige namen ("Café Élan & Zonen" → `cafe-elan-zonen-…`, leeg, alleen leestekens,
    lang, "voorbeeld");
  - een tweede aanroep geeft dezelfde sleutel; een onbekende organisatie en null geven null;
  - een vreemde krijgt het adres van een andere organisatie niet (42501);
  - authenticated leest de tabel niet en kan de generator niet aanroepen; anon kan niets;
  - de CHECKs (geen `voorbeeld`, alleen hexkleuren);
  - de dochterfunctie neemt de vier kolommen over;
  - de backfill geeft een nieuwe organisatie een adres;
  - `accountant_fence_gaps()` is leeg, en de anon-controle van de rooktest vindt niets;
  - `portal_login_key` leest zonder aan te maken (0 rijen na het lezen), geeft hetzelfde adres als
    `ensure_portal_login_key` en weigert een vreemde.
- **Unit tests:** `npm test` 1052/1052. Nieuw:
  - `loginTheme` over 1.620 combinaties van merk, sfeer, kaart en knop: tekst, gedempte tekst,
    voorbeeldtekst, knoptekst, knop of rand tegen de kaart, en meldingen halen de norm;
  - zonder eigen kleuren identiek aan de kop;
  - effen, de grijze kaart, de witte knop, de compat-laag;
  - de keuring van de schijf;
  - de sleutelregel naast de CHECK en de server;
  - de links in de mails;
  - `loadPortalLoginKey`, en `sanitizeBranding` met de terugval.
- **Typecheck** en **`deno check`** op de geraakte functies (portal-login, portal-notify, mail,
  file-share, contract-public, api, mcp, gerrie-agent en de publieke pagina's): schoon.
  `client-portal` staat niet in de CI-lijst en heeft dezelfde ene oude fout als voorheen.
- **In Chromium**, zeven scenario's: eigen kleuren, effen in het lichte werkvlak, een grijze kaart,
  een witte knop op een witte kaart, standaard licht, standaard donker, en een donkere kaart in het
  lichte werkvlak met Playfair. Per scenario het contrast van de échte, uitgerekende kleuren, ook
  van de melding na het versturen: overal minstens 4,5 : 1, en geen JavaScript-fout.
- **Instellingen in de browser:**
  - het adres en de knop *Openen*;
  - het voorbeeld springt naar *Inloggen* en kleurt mee, met het eigen adres in de adresbalk;
  - *Opslaan* stuurt precies de vier kolommen (geen sleutel);
  - terug op *Automatisch* wordt null;
  - op de telefoon geen zijwaartse overloop.
- **Mobiele lay-outtest**, de volledige ronde (`--theme=both`), met de nieuwe pagina
  `portal-login-brand` (het eigen adres met eigen kleuren): 330 pagina's, 0 met problemen. Daarvoor
  al apart het portaal, het inlogscherm, het voorbeeld, Instellingen → Huisstijl en een klant op
  telefoon, tablet, liggend en desktop: 48 pagina's, 0 met problemen. **Laden per module**: geslaagd.
- **Productiebuild** en de **CSP-hash**: in orde.
- **Na het herstel, in Chromium:**
  - de scenario's van de review opnieuw: uitloggen is neutraal, en op het eigen adres nooit de
    huisstijl van een andere leverancier, ook niet bij een vertraging van 1,5 en 6 s;
  - de echte terugkeer van de inloglink (`/portal?code=…` met de PKCE-verifier): het dossier van
    het adres gaat voor, de sleutel is daarna weg, en na uitloggen is het scherm neutraal;
  - een verlopen link geeft het inlogscherm van de leverancier;
  - `/portal` met een oude sleutel blijft neutraal, en een aanvraag op `/portal` wist hem;
  - een verlopen sessie houdt het merk, net als na herladen;
  - intypen in alle kleurvelden, en een halve code bij weggaan;
  - een half getypte merkkleur bewaart de laatste geldige kleur;
  - de meldingen zonder rechten en zonder migratie.

  Daarna `npm test` 1052/1052, de typecheck, `deno check` en de mobiele lay-outtest op 72
  portaal- en instellingenpagina's: in orde.
