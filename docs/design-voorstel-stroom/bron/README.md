# Bron van het Stroom-voorstel

`../index.html` wordt uit deze bestanden gebouwd. Pas hier aan en bouw opnieuw:

```bash
node docs/design-voorstel-stroom/bron/build.mjs
```

| bestand | wat |
|---|---|
| `tokens.mjs` | alle kleuren, het glas, het lichtveld, de stroom, schaduwen, vormen en beweging; per token `[Nacht, Dag]`. De enige plek waar een kleur staat |
| `base.css` | wat app en pagina delen: glas, knoppen, pillen, avatars, het orbje van Gerrie, iconen, minder beweging |
| `app.css` | het prototype: rail, eiland, werkvlak en de schermen; de telefoonopbouw met container queries |
| `page.css` | de voorstelpagina eromheen |
| `data.js` | voorbeeldgegevens van Studio Lopik, uit `tests/mobile/mock/seed.mjs` (dezelfde dag als Zenit) |
| `licht.js` | het lichtveld: een WebGL-shader met zon, poollicht, klantlicht en rimpel, met CSS-terugval |
| `stroom.js` | de stroom: het licht op canvas, de haltes en kralen als knoppen; ook de stroomlijn |
| `eiland.js` | het eiland: zoeken, maken, vragen, de opdracht ontleden, meldingen met ongedaan maken, de timer |
| `app.js` | de schil van het prototype (`createApp`): rail, routering met View Transitions, de stapel, vliegen |
| `schermen.js` | Vandaag, Gerrie, Agenda, Werk, Klant 360, Geld, Inloggen |
| `page.js` | thema's, het prototype in de pagina, de demo's, de telefoons, kleuren en contrast |
| `page.html` | de opbouw van de pagina |
| `sprite.html` | de iconen: Lucide 0.408 (`lucide-static`), dezelfde versie als `lucide-react` in de app |

Met `--inhoud <pad>` schrijft de build ook de versie zonder doctype en `<head>`, zoals een
Artifact hem verwacht.
