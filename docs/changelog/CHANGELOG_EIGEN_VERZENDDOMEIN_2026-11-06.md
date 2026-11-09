# Eigen verzenddomein: werkt, en veilig in het gedeelde Resend-account

Datum: 2026-11-06 · branch `ccr-fe1033d2-3mvv3i`

## Aanleiding

De vraag was of het koppelen van een eigen domein (Instellingen → E-mail →
Eigen verzenddomein) echt werkt, veilig is, en goed op Resend aansluit. Op
staging stond `gerjanvanlopik.nl` sinds 18 september op "Verificatie in
afwachting" en was daarna nooit meer gecontroleerd. De code is nagelopen tegen
de actuele Resend-API (OpenAPI-specificatie en de officiële Node-SDK) en alle
verzendpaden.

## Wat er misging

1. **Antwoorden gingen naar ResoFly.** Met een geverifieerd domein vertrok een
   factuur als `info@bedrijf.nl`, maar de Reply-To bleef het algemene
   ResoFly-adres (`RESEND_REPLY_TO`). Een klant die antwoordde, mailde zonder
   het te zien naar ResoFly in plaats van naar het bedrijf.
2. **Een domein zonder afzenderadres deed niets.** Het adres was optioneel,
   maar zonder adres sloeg `resolveSenderIdentity` het domein over. Het scherm
   kon het adres daarna niet meer invullen: alleen verwijderen en opnieuw
   koppelen (met nieuwe DNS-records) hielp.
3. **Nieuwe statussen van Resend.** Resend kent sinds de ontvangstfunctie
   `partially_verified` en `partially_failed`; `temporary_failure` is een
   status per record geworden. Die kwamen als "in afwachting" binnen, ook als
   het domein al kon versturen. Bij het aanmaken stond ontvangen niet
   expliciet uit; met ontvangen aan vraagt Resend een MX op het domein zelf,
   en wie die plaatst, stuurt al zijn gewone mail naar Resend.
4. **De status liep niet mee.** Resend controleert na "Verifieer" op de
   achtergrond, maar de functie las de stand direct na het starten: bijna
   altijd nog "in afwachting". Daarna veranderde er niets meer tot iemand
   opnieuw klikte. De webhook kende geen domein-events, dus ook een domein
   waarvan later een record verdween, bleef "geverifieerd" terwijl Resend
   weigerde te versturen.
5. **Verwijderen liet het domein bij Resend staan** als die aanroep mislukte
   (best-effort). Het bleef dan geverifieerd in het gedeelde account, zonder
   rij die erbij hoorde: niemand kon het daarna nog koppelen of opruimen.
   Hetzelfde als het opslaan na het aanmaken mislukte.
6. **Bezetten zonder bewijs.** Een domein is uniek over alle organisaties.
   Wie het domein van een ander als eerste invoerde, hield de echte eigenaar
   voorgoed buiten, ook zonder ooit te verifiëren. Een nooit geverifieerd
   `co.uk` blokkeerde zelfs elk `*.co.uk`.
7. **Headers.** De afzendernaam werd bij het opslaan niet opgeschoond en in de
   agenda-uitnodigingen ongefilterd in de From-header gezet. Het afzenderadres
   mocht tekens als `>` en `,` bevatten.
8. **Op staging** heette het webhook-secret
   `RESEND_WEBHOOK_SIGNING_SECRET="jouw_resend_webhook_secret"` (naam en
   voorbeeldwaarde samen in het naamveld). `RESEND_WEBHOOK_SIGNING_SECRET`
   zelf bestond niet, dus `resend-webhook` weigerde elk bericht van Resend.
   Dat is een instelling, geen code: zie "Nog te doen".

## Wat er nu kan en klopt

- Mail vanaf het eigen domein heeft het eigen adres als Reply-To (of het
  persoonlijke adres van het teamlid). Zonder geverifieerd domein blijft alles
  zoals het was.
- Het afzenderadres is verplicht en moet kaal op `@domein` staan. Het scherm
  stelt `info@<domein>` voor. Naam en adres zijn achteraf te wijzigen
  ("Afzender wijzigen"); een oud domein zonder adres krijgt een waarschuwing.
- `_shared/resendDomains.ts` vertaalt de Resend-status: alleen `verified`
  verstuurt, of een gedeeltelijke status waarbij SPF én DKIM gevonden zijn.
  Domeinen worden aangemaakt met `capabilities: { sending: 'enabled',
  receiving: 'disabled' }`.
- Na "Verifieer" vraagt het scherm een minuut lang elke tien seconden de stand
  op (nieuwe actie `refreshSendingDomain`), en toont het per DNS-record of
  Resend hem gevonden heeft. Naam en waarde zijn te kopiëren; de uitleg zegt
  dat de MX alleen bij `send.<domein>` hoort en geeft een DMARC-tip.
- `resend-webhook` verwerkt `domain.created`, `domain.updated` en
  `domain.deleted`. Het event is alleen een seintje: de stand haalt de functie
  zelf bij Resend op, zodat een laat of vals event niets ongedaan maakt.
- Is een domein bij Resend verdwenen, dan zegt "Verifieer" dat en zet het op
  mislukt, in plaats van een providerfout bij elke klik.
- Verwijderen gaat eerst bij Resend; lukt dat niet, dan blijft het domein
  gekoppeld met een duidelijke melding. Mislukt het opslaan na het aanmaken,
  dan gaat het domein bij Resend weer weg.
- Een domein dat ooit geverifieerd is, blijft van die organisatie (met de
  domeinen erboven en eronder). Een koppeling die na zeven dagen nog nooit
  geverifieerd is, mag een andere organisatie overnemen; de oude verdwijnt dan
  ook bij Resend. Een nooit geverifieerd bovenliggend domein blokkeert niemand.
  `verified_at` blijft daarvoor staan als een domein later hapert.
- Afzendernamen worden overal opgeschoond (geen `" < > , @`, regeleinden of
  tekens die de leesrichting omdraaien); adressen moeten kaal zijn
  (RFC 5322 dot-atom). Ook de agenda-uitnodigingen gebruiken dat.
- Een domein met accenten wordt punycode (`bücher.nl` → `xn--bcher-kva.nl`);
  wie een URL of e-mailadres in het domeinveld plakt, krijgt het domein.

## Bestanden

- `supabase/functions/_shared/resendDomains.ts` (nieuw, puur) en
  `resendDomains.test.ts`
- `supabase/functions/_shared/sendingDomain.ts` en `sendingDomain.test.ts`
  (nieuw)
- `supabase/functions/mail/index.ts`: toevoegen, verifiëren, verversen,
  wijzigen en verwijderen
- `supabase/functions/resend-webhook/index.ts`: domein-events
- `supabase/functions/_shared/calendarEventWrite.ts`: afzender van
  uitnodigingen
- `src/features/SimplePages.tsx`, `src/services/mailService.ts`,
  `src/styles/globals.css`: de kaart Eigen verzenddomein
- `tests/stromen/verzenddomein.mjs` (nieuw), `nepdiensten.mjs` (nep-Resend
  Domains-API; versturen alleen vanaf geverifieerde domeinen, zoals Resend),
  `omgeving.mjs`, `run.mjs`
- `tests/mobile/mock/seed.mjs`: twee verzenddomeinen voor de lay-outtest
- `docs/setup/RESEND_SETUP.md`: domein-events, het secret, hoofdstuk 8

Geen migratie: de tabel heeft alles al.

## Getest

- `npm run typecheck`, `npm test` (alle unittests, waaronder 14 nieuwe).
- `deno check` op alle 36 bestanden uit `frontend-checks.yml`.
- `npm run test:stromen`: alle scenario's op een verse lokale stack (de hele
  migratieketen vanaf nul), met het nieuwe scenario `verzenddomein`
  (26 stappen: rechten per rol en organisatie, opschonen van invoer, geen
  status zetten via REST, terugvallen zolang niet geverifieerd, verifiëren
  via verversen, versturen met eigen From en Reply-To, de grenzen tussen
  organisaties, persoonlijke afzender op andermans domein, de webhook met en
  zonder geldige handtekening, verwijderen met en zonder storing, overnemen
  na zeven dagen, maximaal vijf domeinen, een domein dat bij Resend
  verdween). Tegen de oude code faalt het scenario al bij het koppelen zonder
  afzenderadres, en vier van de zes unittests van `sendingDomain.test.ts`.
  Uitkomst: 601 stappen, 5 fout, alle vijf in herinneringen en aanmaningen
  ("dagen te laat" en rente één dag verschoven). Die vijf falen precies zo
  op de code zonder deze wijziging: de run viel tussen 00:00 en 01:00
  Nederlandse tijd, toen de datum in UTC nog 6 november was. Los van dit
  werk; wel het nakijken waard.
- `npm run test:mobile -- --theme=both` op Instellingen (en het tabblad
  E-mail): 12 metingen, geen problemen. De mock heeft nu twee
  verzenddomeinen; de lange DKIM-waarde blijft op de telefoon binnen de kaart
  (licht en donker bekeken).

## Nog te doen (buiten de code)

Bewust uitgesteld tot de overstap naar productie (besloten op 9 november). De
stappen, in volgorde, staan op één plek:
`docs/plannen/ACTIEPUNTEN_BEVEILIGING_SAAS_2026-11-01.md`, punt 26. Daar staat
ook wat hier nog ontbrak: dat een domein maar in één Resend-account tegelijk
geverifieerd kan zijn (één account per omgeving, en wat dat betekent voor het
afzenderdomein van staging), en dat domeinen die nooit geverifieerd worden
blijven meetellen.

Tot dan op staging: het webhook-secret heeft nog de verkeerde naam (punt 4),
dus afleverstatussen en domeinstatus komen niet via de webhook binnen. Een
domein verifieer je met de knop "Verifieer"; het scherm vraagt daarna een
minuut lang zelf de stand op.
