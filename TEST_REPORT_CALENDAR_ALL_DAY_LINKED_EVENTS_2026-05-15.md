# Test report — Calendar all-day linked events — 2026-05-15

## Uitgevoerde checks

### TypeScript
```bash
npm run typecheck
```
Resultaat: succesvol.

### Production build
```bash
npm run build
```
Resultaat: succesvol.

Vite gaf alleen de bestaande chunk-size warning voor de grote applicatiebundle. Geen build-fout.

## Functionele testscenario's die de wijziging dekt

1. Google all-day event single day
   - Input: start.date `2026-05-14`, end.date `2026-05-15`
   - Verwacht: zichtbaar op 14 mei, niet op 15 mei.

2. Microsoft all-day event single day
   - Input: start.dateTime `2026-05-14T00:00:00`, end.dateTime `2026-05-15T00:00:00`, isAllDay `true`
   - Verwacht: zichtbaar op 14 mei, niet op 15 mei.

3. Multi-day all-day event
   - Input: start `2026-05-14`, exclusive end `2026-05-17`
   - Verwacht: zichtbaar op 14, 15 en 16 mei; niet op 17 mei.

4. Timed event
   - Verwacht: oude overlaplogica blijft intact en gebruikt normale start/eindtijd.
