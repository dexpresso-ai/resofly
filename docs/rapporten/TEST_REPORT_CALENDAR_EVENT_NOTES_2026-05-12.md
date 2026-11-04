# Test Report — Calendar Event Notes (2026-05-12)

## Uitgevoerde checks

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

Vite geeft alleen de bestaande chunk-size waarschuwing:

```txt
Some chunks are larger than 500 kB after minification.
```

Dit blokkeert de build niet.

## Installatie-opmerking

`npm ci` faalde in deze omgeving doordat de Supabase CLI postinstall een download vanaf GitHub probeerde te doen en DNS/network tijdelijk faalde:

```txt
getaddrinfo EAI_AGAIN github.com
```

Daarom is voor de validatie gebruikt:

```bash
npm install --ignore-scripts
```

Daarmee zijn de frontend-dependencies geïnstalleerd en konden typecheck en build succesvol draaien.

## Functionele rooktest checklist

Na database-migratie in Supabase:

1. Open de kalenderpagina.
2. Klik op een organisatiegedeeld agenda-item.
3. Controleer of het detailpaneel opent.
4. Controleer of de sectie **Notities bij dit agenda-item** zichtbaar is.
5. Klik op **+ Notitie**.
6. Controleer of de bestaande rich-text notitie-editor opent.
7. Sla de notitie op.
8. Open hetzelfde agenda-item opnieuw.
9. Controleer of de notitie onder het agenda-item zichtbaar is.
10. Open de notitie vanuit het agenda-item.
11. Koppel een bestaande notitie via de dropdown.
12. Ontkoppel een notitie en controleer dat de notitie zelf blijft bestaan.
13. Open een privé- of masked agenda-item en controleer dat koppelen geblokkeerd is.

## Niet gewijzigd

- Google/Microsoft eventdata wordt niet teruggeschreven.
- Bestaande notitie-editor is hergebruikt.
- Bestaande klant/project-notities blijven werken.
- Bestaande calendar edge function is niet aangepast.
