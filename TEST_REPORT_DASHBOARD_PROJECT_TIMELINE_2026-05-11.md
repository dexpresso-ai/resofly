# Testreport — Dashboard Project Timeline (2026-05-11)

## Uitgevoerde controles

- `npm run typecheck` uitgevoerd.
- `npm run build` uitgevoerd.

## Resultaat

- TypeScript-check geslaagd.
- Productiebuild geslaagd.
- Vite build geeft alleen de reeds bekende chunk-size waarschuwing omdat de hoofd JavaScript-bundle groter is dan 500 kB. Dit is geen build error.

## Functionele smoke-test checklist

Controleer na deploy:

1. Login op de applicatie.
2. Open het dashboard.
3. Controleer of de projecttimeline zichtbaar is onder de KPI-kaarten.
4. Controleer of projecten met start- en einddatum over de juiste weken worden getoond.
5. Controleer of de overlaprij per week aantallen toont wanneer projectplanningen elkaar overlappen.
6. Zet fasefilters aan/uit en controleer of projecten direct verdwijnen/verschijnen.
7. Klik op een projectbalk en controleer of de projectdetailpagina opent.
8. Controleer projecten zonder volledige planning: deze moeten zichtbaar blijven met label “Planning geschat”.
9. Controleer mobiele/tabletweergave: de timeline moet horizontaal scrollbaar blijven zonder de rest van het dashboard te breken.

## Opmerking over dependencies

Tijdens lokale validatie is `npm ci --ignore-scripts` gebruikt om dependencies te installeren, omdat de Supabase CLI postinstall in deze sandbox geen GitHub-download kon uitvoeren. De applicatie zelf is daarna succesvol getypecheckt en gebouwd.
