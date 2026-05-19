# Test report — Calendar settings relocation (2026-05-19)

## Uitgevoerd
- `npm ci --ignore-scripts`
- `npm run typecheck`
- `npm run build`

## Resultaat
- TypeScript typecheck: geslaagd.
- Productiebuild: geslaagd.
- Vite build waarschuwing: bestaande chunk-size waarschuwing > 500 kB. Dit blokkeert de build niet en is niet veroorzaakt door deze wijziging.

## Smoke-test checklist
- Open **Kalender**: agenda start direct met de agendaweergave, zonder grote koppelbalk erboven.
- Controleer dat **Ververs** zichtbaar blijft in de kalender-toolbar.
- Open onder **Kalender → Agenda-instellingen**: Google/Microsoft koppelen is beschikbaar.
- Open onder **Kalender → Gekoppelde accounts**: bestaande accounts en agenda's zijn beheerbaar.
- Controleer dat tonen/delen/schrijven toggles nog werken voor agenda-bronnen.
