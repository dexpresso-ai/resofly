# Bron van het Zenit-voorstel

`../index.html` wordt uit deze bestanden gebouwd. Pas hier aan en bouw opnieuw:

```bash
node docs/design-voorstel-zenit/bron/build.mjs
```

| bestand | wat |
|---|---|
| `tokens.mjs` | alle kleuren, schaduwen, vormen en beweging; per token `[Nacht, Dag]`. De enige plek waar een kleur staat |
| `base.css` | wat app en pagina delen: knoppen, pillen, avatars, het orbje van Gerrie, iconen |
| `app.css` | het prototype: nachtrail, contextpaneel, werktabs, werkvlak en de zes schermen |
| `page.css` | de voorstelpagina eromheen |
| `data.js` | voorbeeldgegevens van Studio Lopik, uit `tests/mobile/mock/seed.mjs` |
| `app.js` | het prototype: Dagboog, vraagbalk, beslissen, bord, spiekpaneel, notities |
| `page.js` | thema's (met de overgang vanuit de zon), schalen, demo's, contrastberekening |
| `page.html` | de opbouw van de pagina |
| `sprite.html` | de Lucide-iconen (0.408, dezelfde versie als `lucide-react` in de app) |

Met `--inhoud <pad>` schrijft de build ook de versie zonder doctype en `<head>`, zoals een
Artifact hem verwacht.
