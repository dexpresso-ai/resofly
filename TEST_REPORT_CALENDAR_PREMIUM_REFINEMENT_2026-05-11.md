# Test report — Calendar Premium Refinement — 2026-05-11

## Uitgevoerde checks

### TypeScript
Command:

```bash
npm run typecheck
```

Resultaat: geslaagd.

### Production build
Command:

```bash
npm run build
```

Resultaat: geslaagd.

Vite geeft alleen de bestaande chunk-size waarschuwing omdat de gebundelde app groter is dan 500 kB. Dit is geen build error.

## Scopevalidatie
- Kalendercomponent compileert met dag-, week-, maand- en lijstweergave.
- Event-detail sidepanel gebruikt bestaande `CalendarExternalEvent` velden.
- Externe agenda-links blijven beschikbaar via het detailpaneel.
- Event-aanmaak via sleepselectie en floating creation panel blijft behouden.
- Taken blijven open via de bestaande `onEditTask` flow.
- Geen Supabase-schema of backendcontract aangepast.

## Handmatige smoke-test checklist voor acceptatie
1. Open Kalender > Week.
2. Scroll verticaal door de dag; dagheader, hele-dag-rij en tijdkolom moeten zichtbaar/uitgelijnd blijven.
3. Klik een eventblok; detailpaneel moet openen.
4. Klik “Open in agenda”; externe agenda opent in nieuw tabblad indien `html_link` aanwezig is.
5. Sleep over lege tijdslots; nieuw-eventpaneel moet openen met juiste start/eindtijd.
6. Wissel naar Dag; single-day layout moet volledige breedte gebruiken.
7. Wissel naar Maand; dagen en chips moeten zichtbaar zijn en `+ meer` opent dagweergave.
8. Test op mobiel/tabletbreedte; weekweergave moet horizontaal scrollbaar blijven en maandweergave moet onder elkaar vallen.
