# Documenten: een eigen plek in het menu, en een eigen app

**23 november 2026**

Documenten staat nu los in het menu, net als Agenda. En je kunt Documenten als
eigen app installeren, net als Agenda, Financiën en Communicatie.

## In het menu

Tot vandaag stond Inhoud als één regel onder *Inzicht* (Baken, Zenit, Stroom)
of *Kennis & inzicht* (Cockpit), naast de rapportages. Notities en documenten
vond je pas na een filter (*Weergeven*) in de verkenner.

Nu:

- **Baken, Zenit en Stroom**: een eigen module *Documenten* op de rail, tussen
  Werk en Geld, met het teken van een stapel bladen. In het paneel:
  *Alle inhoud*, *Notities* en *Documenten*. Onder *Inzicht* staan alleen nog
  de rapportages.
- **Cockpit**: een eigen groep *Documenten* in de zijbalk met dezelfde drie
  regels. De groep *Kennis & inzicht* heet nu *Inzicht*.
- **Kruimelpad**: *Dashboard › Documenten › Notities*. Notities en Documenten
  hangen niet meer onder Inhoud; het zijn eigen regels in het menu.

*Alle inhoud* is de verkenner zoals je hem kent, met notities, documenten en
geüploade bestanden in de mappen per klant en project. *Notities* en
*Documenten* openen dezelfde verkenner met alleen die soort (de bestanden
blijven erbij, die horen bij documenten).

Rechten veranderen niet: staat de module Inhoud voor je dicht, dan staat
Documenten niet in het menu.

## De app Documenten

| App | Adres | Opent op | In het menu en de duimbalk |
| --- | --- | --- | --- |
| ResoFly Documenten | `/app/documenten/` | Alle inhoud | Alles, Notities, Documenten |

Installeren gaat zoals bij de andere apps: **Instellingen → Apps**, dan
*Openen*, en daarna *Installeren* in Chrome of Edge, of *Zet op beginscherm* in
Safari. Wie Inhoud niet mag lezen, ziet de app daar niet.

Een klant of project openen vanuit een notitie kan gewoon, in hetzelfde
venster, net als in de andere apps.

## Hoe het werkt

- `src/lib/standaloneApps.ts`: de vierde losse app, met de pagina's van de
  module Inhoud (`content`, `notes`, `documents`).
- `public/apps/documenten.webmanifest`: eigen `id`, `scope` en `start_url`
  (`/app/documenten/`). Geen van de vijf adressen valt onder een ander; dat
  bewaakt `standaloneApps.test.ts`.
- `public/icons/app-documenten-{192,512}.png`: getekend met
  `scripts/app-iconen.mjs`, de oranje tegel met het teken *Files* uit lucide,
  hetzelfde als op de rail. De andere iconen zijn byte voor byte gelijk
  gebleven.
- `public/sw.js`: `/app/documenten/` staat in de lijst met losse apps. Een
  melding over chat, mail, een boeking of een factuur opent dus niet in de app
  Documenten.
- `src/components/ZenitNav.tsx` en `src/components/Sidebar.tsx`: de module en
  de groep. `src/lib/breadcrumbs.ts`: de kopjes *Documenten* en *Inzicht*.

## Getest

- `npm run typecheck` en `npm test`: 2232 geslaagd, waarvan nieuw in
  `standaloneApps.test.ts`: de app Documenten bevat precies de pagina's van
  Inhoud, opent op de verkenner, ontbreekt zonder Inhoud, en het kruimelpad
  begint bij de app.
- `npm run test:mobile -- --theme=both`: 890 pagina's gemeten, 0 met
  problemen, met de nieuwe pagina `app-documenten` op telefoon, tablet en
  liggend, licht en donker.
- `npm run test:loading` en `npm run test:terugknop`: alles geslaagd.
- Met de hand in Chromium (nagebootste backend): de rail met het paneel
  Documenten in Baken, de zijbalk in Cockpit, de app op een telefoon met de
  duimbalk Alles · Notities · Documenten. Geen fouten op de pagina.
