# Pagina's: de boom van het dossier naast de pagina (stap 1A-5e)

28 november 2026. Zie `docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`, §4 ("het
pagina-scherm") en §18.

## Wat er nu kan

- **Links in de editor staan alle pagina's van het dossier,** dus van de klant of het eigen
  dossier, met de pagina's in de projecten van die klant erbij.
  - Bovenaan staat de naam van de klant, of van het bedrijf bij het eigen dossier.
  - De bovenste pagina's staan per plek bij elkaar, zoals in de drive: eerst los in het
    dossier, dan per map (met het pad, bijvoorbeeld "Handboek / Archief") en per project.
  - De volgorde is die van de drive.
- **Klikken opent een pagina.** De huidige wordt eerst opgeslagen, net als bij een
  subpagina-blok. De terugknop gaat daarna terug naar de vorige pagina.
- **De open pagina is gemarkeerd.**
  - De weg ernaartoe staat open, en haar eigen subpagina's ook.
  - Wat je zelf open- of dichtklapt, blijft zo als je van pagina wisselt.
  - Een titel die je typt, staat meteen in de boom, en een nieuwe subpagina (`/pagina`)
    komt er meteen bij.
- **Verbergen kan met het kruisje.** De knop "Pagina's" in de balk haalt de boom terug. Op een
  breed scherm onthoudt de browser die keuze.
- **Op een smal scherm (tot 1099px) en de telefoon is de boom een lade over de pagina.**
  - De lade gaat open met dezelfde knop.
  - Terug en Escape sluiten hem, zonder de pagina te sluiten.
  - Een pagina kiezen opent haar, en de lade gaat dicht.

## Hoe

- **`listDossierPages` (`src/lib/repository.ts`)** haalt alleen de lichte kolommen op: titel,
  ouder, map, klant, project en positie.
  - RLS bepaalt wat je ziet, en de prullenbak is al buiten beeld.
  - Per verzoek hoogstens 1000 pagina's; anders zegt de boom dat niet alles erin staat.
- **Het dossier volgt één regel:** de klant van het project telt (`dossierClientOf`).
  - Die stond in `listDossierFiles`, en de database volgt hem in `page_attachment_dossier`.
  - Beide gebruiken nu dezelfde functie, zodat de bestandskiezer en de boom hetzelfde dossier
    tonen.
- **`src/lib/pageTree.ts` is puur** en maakt de vorm:
  - groepen en sortering;
  - een pagina waarvan de ouder niet in de lijst staat, komt bovenaan in haar groep in plaats
    van te verdwijnen;
  - een kring loopt niet eindeloos door.
- **De boom bewaart zijn gegevens buiten de editor** (`PageTree.tsx`). `main.tsx` geeft elke
  pagina een eigen editor (`key`), dus elke klik maakt een nieuwe. Zonder die opslag zou de
  boom elke keer leeg beginnen: laden, bovenaan, en alles weer dicht.
- **Niet via `data.documents`.** Zo werkt de boom ook als je een pagina via een link opent,
  zonder dat de zware groep met documenten geladen is.

## Getest

- **Unit tests:**
  - `pageTree.test.ts`, 6 tests: geen pagina valt weg (wees, kring, zichzelf als ouder), de
    groepen en hun volgorde, sorteren zoals de drive, de voorouders, de dossierregel en het
    mappad;
  - `npm test`: 2363 gelukt;
  - `npm run typecheck`: goed.
- **UI, `ui.mjs paginadrive`: 6 stappen, 0 fout.** De nieuwe stap loopt dit na:
  - breed: de klantnaam, de map als groep, de subpagina onder de open pagina, en een
    dichtgeklapte tak;
  - een tak openklappen, naar een andere pagina wisselen (de boom blijft open), en de
    titel die meteen meeloopt;
  - een subpagina via `/pagina` die meteen in de boom komt;
  - de terugknop naar de vorige pagina;
  - verbergen, ook bij de volgende pagina, en terughalen;
  - op de telefoon: geen kolom, de lade, terug sluit alleen de lade, en kiezen opent de
    pagina en sluit de lade.
- **UI, `ui.mjs paginas`: 18 stappen, 0 fout,** ongewijzigd en nu met de kolom open. Het
  blokmenu, de bestandskiezer, de inhoudsopgave en het verbreden van kolommen werken nog,
  ook nu de pagina 260px naar rechts staat.
- **`npm run test:terugknop`:** 18 gelukt.
- **`npm run test:loading`:** alle controles geslaagd.
- **Met het oog nagekeken**, op schermafdrukken van de UI-test: breed in het donkere thema, en
  de lade op een telefoon van 390px.
