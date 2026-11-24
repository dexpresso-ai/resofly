# Plan — Een kopie van Inhoud in OneDrive (2026-11-24)

> **Status: akkoord op 24 november; fase 1 gebouwd op de werkbranch, nog niet
> uitgerold.** De antwoorden op de open punten staan in §3, in de kolom
> "Besloten". Wat er gebouwd is: `docs/changelog/CHANGELOG_ONEDRIVE_KOPIE_2026-11-24.md`.

Vraag: *de bestanden van ResoFly ook in de cloudopslag van Microsoft OneDrive,
met ResoFly als leidend systeem. Verwijder je iets in ResoFly, dan gaat het in
OneDrive ook weg.*

Kort antwoord: **ResoFly blijft de bestanden zelf bewaren (R2). Zet de eigenaar
de koppeling aan, dan houdt ResoFly een kopie bij in één map in OneDrive.** Die
kopie loopt mee met alles wat er in ResoFly gebeurt: uploaden, hernoemen,
verplaatsen, bewerken en verwijderen. Wat er in OneDrive zelf gebeurt, neemt
ResoFly niet over. Het is een keuze per organisatie; wie hem niet aanzet, merkt
er niets van.

---

## 1 · Wat er vastligt (keuzes van 24 november)

| Vraag | Keuze |
| --- | --- |
| Opslag van ResoFly vervangen of een kopie? | **Een kopie** (optie B). R2 blijft de bron; alles werkt zoals nu. |
| Wiens OneDrive? | **Eén plek voor de hele organisatie, gekoppeld door de eigenaar.** |
| Welke bestanden? | **Inhoud en het klantdossier → Bestanden.** |
| Wat blijft alleen in R2? | **Financiële stukken** (facturen, offertes, contracten, inkoopfacturen, jaarrekeningen), **de galerij** en **zendingen** (Bestanden versturen). |
| Verwijderen in ResoFly | **Ook weg in OneDrive** (naar de prullenbak daar). |
| Aan of uit | **Een keuze**: de eigenaar zet het aan in Instellingen. |

## 2 · Wat de gebruiker ziet

**De eigenaar, in Instellingen → AI & koppelingen → OneDrive:**
1. *OneDrive koppelen*: inloggen bij Microsoft en toestemming geven.
2. Kiezen waar de kopie komt (standaard een map `ResoFly` in zijn OneDrive).
3. *Kopie aanzetten*. Vanaf dan komt elke wijziging in OneDrive. Wat er al
   stond, gaat pas mee met *Alles opnieuw kopiëren* (§3, punt A).
4. Daarna een statusregel: "Bijgewerkt om 14:32", of wat er misging, met
   *Opnieuw proberen*. Is de koppeling verlopen (wachtwoord gewijzigd,
   toestemming ingetrokken), dan ziet de eigenaar dat hier en in een melding;
   de wijzigingen wachten tot hij opnieuw koppelt.
5. *Kopie uitzetten*: ResoFly stopt met bijhouden. Wat er in OneDrive staat,
   blijft staan.

**Iedereen in de verkenner:** niets nieuws om te leren. Een klein OneDrive-icoon
in de kop van Inhoud zegt "Er staat een kopie in OneDrive". Een
verwijderbevestiging zegt erbij: "…gaat ook in OneDrive naar de prullenbak".

**In OneDrive:**

```
ResoFly/
  Bakkerij De Korenaar/
    Aangeleverd materiaal/
      logo.png
      teksten-website.docx
    Website 2026/            ← projectmap
      Concepten/
        moodboard.jpg
  Studio Noord/
    …
```

Dezelfde mappen als in Inhoud: klant, project, dossiermap, submap. Wordt een
klant hernoemd, dan wordt zijn map in OneDrive mee hernoemd.

## 3 · Nog te beslissen (met mijn advies)

| # | Vraag | Advies | Besloten (24 november) |
| --- | --- | --- | --- |
| A | Bestanden die er al zijn: meekopiëren bij het aanzetten, of alleen nieuwe? | Meekopiëren. | **Niet meekopiëren**: er zijn alleen bestanden op staging. Wie het toch wil, kiest *Alles opnieuw kopiëren* (punt E). |
| B | Notities en tekstdocumenten (die staan als tekst in ResoFly, niet als bestand): ook in OneDrive? | Eerst niet; later als PDF. | **Niet.** Word/Excel/PowerPoint-documenten in Inhoud gaan wel mee. |
| C | Waar in Microsoft: alleen de OneDrive van de eigenaar, of ook een SharePoint-bibliotheek? | Eerst de OneDrive van de eigenaar. | **Eerst alleen OneDrive.** |
| D | Bewerkt iemand de kopie in OneDrive en daarna het origineel in ResoFly? | ResoFly overschrijft; OneDrive bewaart de vorige versie. | **ResoFly is leidend.** |
| E | Verwijdert iemand een bestand in OneDrive zelf? | Niet vanzelf terugzetten; *Alles opnieuw kopiëren* maakt de kopie compleet. | **Volgens advies.** |
| F | De eerste versie op de werkbranch (losse bestanden koppelen als verwijzing)? | Weghalen, onderdelen hergebruiken. | **Volgens advies.** Teruggedraaid in commit 7dc6928. |

## 4 · Hoe het werkt

### 4.1 De koppeling

- **Eén koppeling per organisatie**, alleen door de eigenaar te maken en te
  verwijderen. Een nieuwe tabel naast de persoonlijke agendakoppelingen.
- Microsoft-recht: `Files.ReadWrite` (de eigen OneDrive van de eigenaar) en
  `offline_access`. Geen betaalde beoordeling, geen kosten bij Microsoft.
- De tokens staan versleuteld in de database, net als bij de agenda, en komen
  nooit in de browser.
- Vertrekt de eigenaar of verandert de eigenaar, dan gaat de koppeling uit en
  ziet de nieuwe eigenaar *OneDrive koppelen*.

### 4.2 Wat er een kopie krijgt

| In ResoFly | In OneDrive |
| --- | --- |
| Klant | map met de klantnaam |
| Project | map onder de klant |
| Dossiermap en submap (`content_folders`) | map |
| Geüpload bestand in een dossiermap (`attachments`, soort `folder`) | het bestand |
| Word/Excel/PowerPoint-document in Inhoud (`documents` met een bestand) | het `.docx`/`.xlsx`/`.pptx` |

Niet: notities en tekstdocumenten (zie §3 B), bijlagen bij taken, tickets en
chat (andere modules), en alles uit §1 dat in R2 blijft.

### 4.3 Bijhouden: een wachtrij in de database

Hetzelfde patroon als het opruimen van de galerij (20261112170000) en de
verwijderwachtrij uit de eerste versie:

1. **Triggers** op `attachments`, `content_folders`, `documents`, `clients` en
   `projects` zetten een taak in `onedrive_sync_jobs`: *kopieer*, *hernoem*,
   *verplaats* of *verwijder*. Alleen als de kopie voor die organisatie aanstaat.
   Ook een cascade (een verwijderde klant) komt er zo in, zonder dat er een
   scherm langskomt.
2. **De edge function** werkt de wachtrij af: meteen na een wijziging (de app
   zegt het), en elke paar minuten via een geplande taak voor wat bleef liggen.
3. **Kopiëren**: de edge function vraagt bij Microsoft een uploadadres aan. Dat
   adres geldt kort en bevat al de toegang. De media-worker stuurt het bestand
   daar rechtstreeks uit R2 naartoe, in stukken. Zo gaat er geen bestand door
   de edge function, en heeft de worker geen sleutel van Microsoft nodig.
4. **Een koppeltabel** (`onedrive_sync_items`) onthoudt bij elk item van ResoFly
   het id in OneDrive. Hernoemen en verplaatsen werken daardoor op het id, ook
   als de naam in OneDrive anders is geworden.
5. **Bewerkt in ResoFly** (de editor slaat een Office-bestand op): opnieuw
   uploaden naar hetzelfde bestand in OneDrive.

### 4.4 Lastige gevallen

- **Namen**: OneDrive kent tekens niet (`" * : < > ? / \ |`) en namen als
  `CON`. ResoFly maakt daar een geldige naam van. Twee bestanden met dezelfde
  naam in één map: de tweede krijgt " (2)".
- **Limieten van Microsoft** (te veel verzoeken): de wachtrij wacht wat Microsoft
  vraagt en gaat dan verder. De eerste kopie van een grote organisatie kan
  daardoor uren duren; de voortgang staat in Instellingen.
- **Opslag vol in OneDrive**: de wachtrij stopt met een melding aan de eigenaar.
  Een gratis Microsoft-account heeft 5 GB; Microsoft 365 meestal 1 TB per
  gebruiker.
- **Storing of verlopen koppeling**: niets gaat verloren; de taken wachten.

## 5 · De regels

- **Harde regel 1 (elke organisatie een eigen wereld)**: de organisatie komt
  uit de rij en de sessie, nooit uit invoer. De koppeling en de wachtrij zijn
  per organisatie, met RLS, en de edge function filtert zelf.
- **Harde regel 3 (modulerechten)**: **in OneDrive gelden die niet.** Wie
  toegang heeft tot de map in OneDrive, ziet alle klantbestanden die erin staan,
  ook als hij in ResoFly de module Inhoud niet mag openen. Daarom alleen de
  OneDrive van de eigenaar, en zegt het scherm bij het aanzetten: "Iedereen die
  bij deze map in OneDrive kan, ziet alle bestanden van je klanten."
- **Harde regel 6 (bewaarplicht)**: financiële stukken gaan niet mee. In
  OneDrive kan iemand ze wissen, en dan kan ResoFly niet meer aantonen wat er
  verstuurd is. In ResoFly blijven ze vastliggen, zoals nu.
- **Harde regel 2 (de AI voert niets uit)**: verandert niet. Verwijdert Gerrie
  iets na goedkeuring, dan gaat het via dezelfde weg, en dus ook uit OneDrive.
- **AVG**: de kopie staat bij Microsoft, onder het account en de
  voorwaarden van de klant zelf. Dat staat in de uitleg bij het aanzetten.

## 6 · Wat er met de werkbranch gebeurt

De eerste versie (losse bestanden koppelen, commit `d8bd958`) is niet
uitgerold. Volgens §3 F:

- **Blijft, aangepast**: koppelen met Microsoft (state, terugkeer, afronden in
  de app), de versleutelde tokens, de verwijderwachtrij en de geplande taak.
- **Gaat weg**: de verwijzingen in `attachments` (`cloud_*`-kolommen), het
  venster *Uit Google Drive / Uit OneDrive*, de kiezer van Google en de pagina
  `/drive-kiezer`.
- **Uit de review, meegenomen**: alleen de ingestelde app-adressen als
  terugkeeradres (geen previews), striktere id-controle, mislukte taken na een
  tijd opruimen, en de agenda die bij loskoppelen geen andere koppeling meer
  mag breken.

De migratie `20261123150000` staat nog niet op staging. Die vervang ik door een
nieuwe, zodat er geen tabellen en kolommen blijven hangen die niemand gebruikt.

## 7 · Fasering

**Fase 1 (dit plan)**
- Koppeling van de eigenaar, met Instellingen → OneDrive (status, voortgang,
  opnieuw proberen, uitzetten).
- Kopie van klanten, projecten, dossiermappen, geüploade bestanden en
  Office-documenten. Hernoemen, verplaatsen, bewerken en verwijderen lopen mee.
- *Alles opnieuw kopiëren*: controleert elk bestand in OneDrive en zet terug
  wat ontbreekt of daar is veranderd (§3 A en E).

**Fase 2 (later, apart te beslissen)**
- Notities en tekstdocumenten als PDF.
- Een SharePoint-bibliotheek als plek.
- Google Drive als tweede bestemming. Kan gratis met het recht `drive.file`,
  omdat ResoFly de bestanden daar zelf aanmaakt.

## 8 · Waar het in de code komt

| Laag | Nieuw | Aangepast |
| --- | --- | --- |
| Database | migratie: koppeling van de organisatie, `onedrive_sync_items`, `onedrive_sync_jobs`, triggers, RLS (alleen de eigenaar leest de koppeling; wie Inhoud leest, ziet de status) | migratie `20261123150000` vervangen |
| Edge function | `onedrive-sync`: koppelen, instellingen, de wachtrij afwerken, de eerste kopie, geplande taak | `cloud-files` gaat op in `onedrive-sync` |
| Media-worker | interne route: een R2-object naar een uploadadres van Microsoft sturen (alleen adressen van Microsoft, met het geheim van de functie) | |
| App | Instellingen → OneDrive (alleen de eigenaar), statusicoon in Inhoud, teksten bij verwijderen | `ContentLibrary.tsx`, `settingsMenu.ts`, `main.tsx` (terugkeer na koppelen), weghalen wat §6 noemt |
| Inrichten | `docs/setup/ONEDRIVE_SETUP.md`, stap in `scripts/supabase-setup-webhooks.sh` | `.env.example`, rooktest |

## 9 · Testen

- Regeltests (namen opschonen, mappaden, wat er een taak wordt, foutcodes van
  Microsoft) in `_shared` en `src/lib`.
- Databasetests: triggers zetten de juiste taken klaar (ook bij een cascade),
  niets uit de financiën of de galerij komt in de wachtrij, een teamlid kan de
  koppeling niet lezen of wijzigen, een andere organisatie ziet niets.
- De mobiele schermtest met Instellingen → OneDrive in beide thema's.
- **Tegen het echte Microsoft** pas als de koppeling in Entra is ingericht:
  het terugkeeradres van de nieuwe functie en het recht `Files.ReadWrite`.

## 10 · Inrichten bij Microsoft (eenmalig)

In de app-registratie van de agenda:

1. *Authentication → Web*: het terugkeeradres van de nieuwe functie.
2. *API permissions → Microsoft Graph → Delegated*: `Files.ReadWrite`.
3. Laat een bedrijf gebruikers zelf geen toestemming geven, dan *Grant admin
   consent* door de beheerder van dat bedrijf.
