# Pagina's als HTML voor de klant (stap 1C-1)

28 november 2026. Zie `docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`, §7 en §18.

De eerste stap van 1C, pagina's delen. Hij verandert nog niets aan wat een klant ziet: delen
blijft voor een pagina geweigerd tot de vrijgave er is (stap 1C-2).

## Wat er nu is

- **Een module die een pagina omzet naar HTML:** `supabase/functions/_shared/pageHtml.ts`.
  - `renderPageHtml(body, context)` geeft een fragment in `<div class="rf-page">`.
  - Het portaal en de geheime link gaan de vrijgegeven versie hiermee tonen.
  - De module heeft geen browser of pakketten nodig. Zo draait hij in een edge function, in
    de tests en later in de Worker van de klantadressen (§17).
- **De context bepaalt wat er van buiten de pagina in komt.** De aanroeper zoekt het op:
  - welke subpagina's de lezer ook mag zien, met hun titel;
  - de namen van bestanden;
  - een getekend https-adres per afbeelding.

  Wat niet in de context staat, komt er niet in. Een titel, naam of adres in een blok zelf
  telt nooit: die kan via de API in de pagina zijn gezet.
- **`pageReferences` staat nu in `_shared`** (`_shared/pageReferences.ts`). De Word-export
  in de app gebruikt hem al. Het portaal heeft hem nodig om alleen de afbeeldingen uit de
  gedeelde versie te tekenen. De app leest hem via `src/lib/pageExportParts.ts`, en de code
  is niet veranderd, alleen een grens aan de diepte kwam erbij.
- **De CI controleert de modules van pagina's met `deno check`**, in een eigen stap
  ("Deno-typecheck pagina's"):
  - `pageDocx.ts`, `woff.ts`, `zipWriter.ts` en `pageExportFonts.ts`;
  - `pageHtml.ts` en `pageReferences.ts`.

  Geen edge function importeert ze nog. Zonder deze stap zou een fout in Deno pas blijken
  als een functie ze laadt.

## Wat de klant ziet, per blok

| Blok | In de HTML |
| --- | --- |
| Alinea, kop 1 tot 3 | `p`, en `h2` tot `h4`: de titel van de pagina is de bovenste kop |
| Opmaak | vet, cursief, onderstreept, doorgehaald, code, markeren |
| Link | Alleen http(s), mailto en tel, in een nieuw tabblad. Een link binnen de app (`/…`, `#…`) wordt gewone tekst: bij de klant wijst hij nergens heen. |
| Lijsten | Opsomming, nummering (met het startnummer), en de takenlijst met afgevinkt of niet |
| Tabel | Kopcellen, samengevoegde cellen en uitlijning. Geen kolombreedtes: op een telefoon moet de tabel kunnen krimpen. |
| Kader | In de kleur van de soort; een onbekende soort wordt "info" |
| Uitklapper | Dicht, zoals in de app |
| Inhoudsopgave | De koppen, zonder sprong ernaartoe (zie hieronder) |
| Subpagina | "→ titel", alleen als die subpagina ook gedeeld is |
| Bestand | "Bijlage: naam", zonder link |
| Afbeelding | Met het getekende adres van de server, anders "[Afbeelding: alt-tekst]" |
| Onbekend blok | Alleen de tekst |

## Waarom zo

- **Alleen tags en attributen uit een vaste lijst** (`PAGE_HTML_TAGS`, `PAGE_HTML_ATTRIBUTES`).
  - Tekst wordt altijd ge-escaped.
  - Wat in een attribuut of klasse komt, komt uit een vaste lijst of is een getal dat de
    module zelf berekent: de soort kader, uitlijning, colspan, startnummer.
- **Opmaak via klassen (`rf-…`), niet via `id`, `style` of `data-*`.**
  - Het portaal haalt `sanitizeRichContentHtml` er nog eens overheen, en die laat die drie
    niet staan.
  - Daarom springt de inhoudsopgave ook nog niet naar de koppen: dat vraagt een `id`.
- **Een heel diep geneste pagina stopt bij 64 lagen**, in plaats van de server te laten
  vastlopen. Uit de editor komt zo'n pagina niet, maar via de API kan het.

## Bewust nog niet

- De opmaak (CSS) van de `rf-`klassen in het portaal. Die komt met de weergave (1C-4).
- Een sprong vanuit de inhoudsopgave.

## Getest

- **`pageHtml.test.ts` (20 tests):**
  - elk bloktype uit de database komt erin (een nieuw blok zonder omzetting laat de test
    falen);
  - de lijst overleeft de sanitizer van het portaal;
  - de soorten kader zijn die van de editor;
  - vijandige invoer: `javascript:`, `data:`, aanhalingstekens in een adres, HTML als tekst,
    verzonnen soorten en getallen, blokken op de verkeerde plek, 20.000 lagen diep;
  - een subpagina die niet gedeeld is, staat er niet in, ook haar titel niet, en een id als
    `__proto__` geeft niets terug;
  - afbeeldingen alleen met een https-adres van de aanroeper;
  - tabellen, lijsten, uitklappers, de inhoudsopgave.

  Elke uitkomst wordt nagelopen: elke tag en elk attribuut moet op de lijst staan, en alles
  moet sluiten.
- **`npm test`:** 2399 gelukt.
- **`npm run typecheck`.**
- **`deno check`** op de zes modules uit de nieuwe CI-stap.
