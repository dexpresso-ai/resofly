# Test report — Klanten kaart/tabelweergave + automatisch klantnummer

Datum: 2026-05-20

## Uitgevoerde checks

### Dependency install

- `npm ci` geprobeerd.
- Deze faalde in deze sandbox op de Supabase CLI postinstall, omdat de omgeving geen GitHub-download kon bereiken.
- Daarna succesvol uitgevoerd met:

```bash
npm ci --ignore-scripts
```

Dit is voldoende voor frontend typecheck/build in deze omgeving. In normale Cloudflare/GitHub CI mag `npm ci` blijven werken zolang de Supabase CLI-download bereikbaar is.

### TypeScript

```bash
npm run typecheck
```

Resultaat: geslaagd.

### Productie-build

```bash
npm run build
```

Resultaat: geslaagd.

Vite gaf alleen de bestaande waarschuwing dat de hoofdchunk groter is dan 500 kB. Dit is geen blocker voor deze wijziging, maar blijft een toekomstige optimalisatie voor code-splitting.

## Functionele smoke-test checklist

- Open **Klanten**.
- Controleer dat standaard de kaartweergave zichtbaar blijft.
- Klik op **Tabel** en controleer dat klanten compact in tabelvorm verschijnen.
- Klik op een tabelrij en controleer dat de klantdetailpagina opent.
- Wissel terug naar **Kaarten** en refresh de pagina; controleer dat de laatst gekozen weergave behouden blijft.
- Klik op **+ Nieuwe klant**.
- Controleer dat de modal op desktop breder opent.
- Controleer dat **Klantnummer** automatisch gevuld is, bijvoorbeeld `KL-002`.
- Sla een nieuwe klant op en controleer dat de klantcode zichtbaar is op de kaart en in de tabel.

## Database-impact

Geen databasewijzigingen uitgevoerd of nodig.
