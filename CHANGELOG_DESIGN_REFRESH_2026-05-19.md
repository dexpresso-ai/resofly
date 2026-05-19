# Changelog — Design Refresh 2026-05-19

## Doel
De bestaande ResoFly/BrandCore-app visueel laten aansluiten op `Nieuw design.html` zonder bestaande functionaliteit, routing, database- of Edge Function-logica te wijzigen.

## Gewijzigd
- App-brede dark premium visual layer toegevoegd in `src/styles/globals.css`.
- Kleurensysteem verschoven naar Dexpresso-stijl: diep zwart, amber accent `#ffbd59`, zachte glow, glass panels en grotere radius.
- Sidebar vernieuwd met premium branding, organisatiekaart, actieve menu-state, submenu-styling en mobiele fallback.
- Topbar vernieuwd met compacte workspace-eyebrow en aparte actiegroep.
- Dashboard hero, statistiekkaarten, timeline, onboardingkaart en activity-card visueel opgewaardeerd.
- Generieke cards, buttons, inputs, modals, notities, finance-items, kanban, kalenderpanelen en quote-flow visueel geharmoniseerd.
- Login-scherm vernieuwd naar dezelfde premium stijl.
- Zichtbare app-branding aangepast van BrandCore naar ResoFly in sidebar/login en documenttitel.

## Niet gewijzigd
- Geen database-migratie nodig.
- Geen Supabase-schema gewijzigd.
- Geen businesslogica gewijzigd.
- Geen Resend/Mollie/R2/Calendar/Quote-flow endpoints gewijzigd.
