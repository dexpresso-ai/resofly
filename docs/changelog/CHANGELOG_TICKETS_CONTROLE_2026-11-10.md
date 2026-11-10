# Controle: tickets, het klantportaal en de mailmeldingen — 10 november 2026

Vraag: *"Controleer de functionele werking van het ticketsysteem inclusief de veiligheid daarvan.
Controleer ook de werking en veiligheid op de klantenpagina. Check of de updates van de mail ook
aankomen."*

## Hoe er gecontroleerd is

- **Staging, alleen lezen** (Management API): de mailronde, de wachtrij en wat er verstuurd is.
- **Twee controles van de code, los van elkaar.**
  - De teamkant: database, app, Gerrie, MCP en API.
  - Het klantportaal: `client-portal`, het scherm, de berichten.
- **Een nieuwe stromentest** `tickets` (35 stappen). Het team in de app (PostgREST met RLS), de
  klant in het portaal en de mailronde, met de echte functies en de echte database. Resend is nep:
  elke mail wordt vastgelegd.
- **Een nieuwe browsertest** `tickets` (`tests/stromen/ui.mjs`). Een medewerker klikt in het
  ticketvenster; de klant opent de knop uit de mail in een eigen browser.

## De mailmeldingen op staging

- De taak `portal-notify-drain` draait elke minuut. Van de laatste zes uur kregen alle 360 rondes
  antwoord 200 ("niets te doen"). De secrets en de koppeling met Resend staan er dus.
- Op staging is sinds de invoering één ticketmelding geweest: op 5 november, "Ticket afgehandeld"
  aan het hoofdadres van de klant Brand New Creators. De ronde gaf hem af bij Resend (status
  `done`, één ontvanger). Er is geen bounce of klacht op teruggekomen. Die mailbox is vanuit de
  controle niet te zien, dus of hij in de inbox stond, is niet vast te stellen.
- Sinds 5 november is er op staging geen ticket aangemaakt of beantwoord. Daarom ging er ook niets.
- In de stromentest komt elke soort melding aan, met de juiste link en zonder interne tekst:
  - nieuw ticket;
  - ontvangstbevestiging;
  - antwoord en status in één mail;
  - afgehandeld;
  - een interne notitie die zichtbaar wordt;
  - een reactie van een collega van de klant.
- De eigen keuzes in het portaal, de schakelaar van de organisatie en een harde bounce doen wat ze
  moeten doen.

## Wat niet goed was, en is gerepareerd

### Veiligheid

1. **Pushmeldingen negeerden het recht op Tickets (middel).** Elk lid kreeg "Nieuw ticket –
   klant: titel" en elke klantreactie op zijn telefoon, ook met Tickets op *geen toegang*. Nu
   alleen wie Tickets mag lezen, zoals bij Financiën.

2. **Een teamlid kon namens de klant schrijven (middel).** De app doet het niet, maar via de
   database (zonder de app) lukte het:
   - een bericht plaatsen als de klant. Het portaal toonde het als bericht van de klant, de
     collega's van de klant kregen er een mail over, en een afgehandeld ticket ging weer open;
   - de tekst van een echt klantbericht herschrijven, of het omzetten naar een interne notitie;
   - een ticket maken met een klantadres als indiener. Die klant kreeg dan "We hebben je ticket
     ontvangen" voor iets wat hij nooit indiende.

   Nu ligt in de database vast wie wat schreef. Een notitie verandert daarna alleen nog van
   zichtbaarheid.

3. **Een teamlid met zijn eigen adres als klant kreeg de klantmails (middel).** Sinds 6 november
   is een teamlid in de eigen organisatie geen portaalklant, maar de mailronde wist dat niet.
   - Een lid zonder recht op Tickets las zo de antwoorden van het team per mail mee.
   - Wie zijn eigen adres als testklant gebruikte, kreeg een link naar een dossier dat het portaal
     hem niet toont.

   Nu slaat de mailronde actieve teamleden over.

4. **Een contactpersoon las de mail van het team aan het hoofdadres mee (middel).**
   - Wie ooit in een gesprek meedeed, zag daarna élke mail van het team in dat gesprek.
   - Inkomende mail komt vaak in het laatst actieve gesprek van de klant terecht. Zo las een
     collega het antwoord op een vertrouwelijke mail van het hoofdadres mee, met het citaat eronder.

   Nu zie je een mail van het team aan het hoofdadres alleen als die op jouw bericht antwoordt. Mail
   van het team aan een collega zie je nooit.

5. **Eén klant kon het mailquotum van de leverancier opmaken (middel–laag).**
   - Tien tickets en dertig reacties per tien minuten geven elk een mail, en die telden in hetzelfde
     quotum als de facturen.
   - De rem telde eerst en schreef daarna: tientallen verzoeken tegelijk kwamen er allemaal door
     (getoetst: 15 van 15).

   Nu:
   - de rem telt en beslist in één keer (getoetst: hooguit 10 van 15);
   - mail die een klant zelf veroorzaakt, heeft een eigen rem: 100 per uur per organisatie,
     buiten het quotum. Het team mailt gewoon door.

6. **Het inlogadres van een teamlid ging mee naar de browser van de klant (laag).** Bij een
   teamnotitie stond het in het antwoord van het portaal; het scherm toonde de bedrijfsnaam. Nu
   staat het er niet meer in.

7. **Gerrie en de MCP lazen klantnamen voor wie Klanten niet mag lezen (laag–middel).** Ze konden
   een ticket ook aan zo'n klant koppelen. Nu niet meer, net als in de API.

8. **Kleiner:**
   - de indiener van een ticket wordt op organisatie gecontroleerd;
   - een leesmarker hoort bij een ticket van dezelfde organisatie;
   - op de view `ticket_unread` kan niet meer geschreven worden;
   - een lege body gaf een 500 (nu 400);
   - een foutmelding van de galerij noemde de namen van secrets.

### Werking

9. **Een melding die op het mailquotum wachtte, kwam nooit meer aan.** Elke ronde telde als
   mislukte poging; na vijf minuten was hij `dead`. Nu wacht hij zonder dat het telt, tot het
   quotum weer ruimte heeft (hooguit 48 uur).

10. **Een open ticketvenster zette een heropend ticket terug op Afgehandeld.** Het venster stuurde
    bij Opslaan alle velden mee, ook de status van toen het openging.
    - Reageerde de klant intussen, dan verdween zijn reactie in het archief.
    - Hij kreeg meteen de mail "afgehandeld".

    Nu gaat alleen mee wat je in het venster veranderde. Dat geldt ook tussen twee collega's.

11. **Het schrijfvak sprong na elk bericht terug op "Zichtbaar voor klant".** Twee interne
    notities achter elkaar betekende dat de tweede naar het portaal en per mail naar de klant ging.
    - De keuze blijft nu staan.
    - Bij een ticket zonder klant staat hij standaard op intern.

12. **Een ticket aan een andere klant hangen gaf geen waarschuwing.** De nieuwe klant ziet in het
    portaal de omschrijving en het hele zichtbare gesprek, ook wat de vorige klant schreef. Nu
    vraagt het venster eerst of dat de bedoeling is, en het voorstel van Gerrie zegt het ook.

13. **Ververs telde de ongelezen tickets niet opnieuw.** Miste realtime een gebeurtenis, dan bleef
    "Nieuw" weg tot je het ticket opende of de pagina herlaadde. Nu tellen Ververs en naar Tickets
    gaan opnieuw. Openen vanuit de weekplanner of het zoeken telt ook als gelezen.

14. **Na reageren in het portaal verdween een nieuw antwoord van het team.** Reageren telt als
    gelezen. Een antwoord dat binnenkwam terwijl de klant typte, kreeg geen stip en stond niet in
    beeld. Nu laadt het portaal het gesprek na versturen opnieuw.

15. **Gerrie's "onbeantwoord" klopte niet.** Een interne notitie telde als antwoord, en het filter
    kwam ná de limiet. Nu: wacht het op het team, dan is het onbeantwoord, ook als de klant na het
    laatste antwoord nog iets schreef.

16. **Kleiner:**
    - een ticket zonder titel werd opgeslagen;
    - `ticket.list_unread` maakte bij veel tickets een te lange URL.

## Wat goed werkte

- Geen weg naar de gegevens van een andere organisatie, en geen klant die met een ander id bij een
  ander dossier komt. Dat is getoetst voor tickets, notities, berichten, bestanden, instellingen en
  meldingen.
- Interne notities en de interne memo komen nergens bij de klant: niet in het portaal, niet in het
  overzicht en niet in de mail.
- Modulerechten in de database:
  - wie Tickets niet mag lezen, krijgt niets;
  - met alleen leesrecht schrijf je niets;
  - kijker, boekhouder en anon komen er niet bij.
- De status: een omgezet ticket blijft omgezet, de datum van afhandelen zet de database zelf, en een
  reactie van de klant zet een afgehandeld ticket weer open.
- Tekst van mensen staat overal als tekst (geen HTML), ook in de mail.

## Wat bewust blijft, of later

- **Bestanden bij een ticketantwoord** volgen de rechten van Inhoud, niet van Tickets. Een lid
  zonder Tickets ziet bij Bestanden versturen de titel van het ticket in het onderwerp.
- **Een klant die op "inactief" staat**, kan nog in het portaal: tickets en berichten indienen,
  facturen terugzien. Of dat zo moet blijven, is een keuze voor de eigenaar; het is niet
  veranderd.
- **Berichten van langer geleden:** het portaal laadt de nieuwste 2000 berichten van een klant;
  oudere gesprekken vallen weg.
- **Afbeeldingen van buiten** in een mail van het team worden in het portaal geladen. De app zelf
  blokkeert die bij binnenkomende mail.
- **Supabase-inlogmail van teamleden:** de afzender is "Gerjan van Lopik" `<ne-reply@resofly.com>`
  (*ne*-reply), met de Engelse standaardtekst. Dat staat in het dashboard van Supabase, niet in de
  code; zie ook `docs/plannen/EIGEN_SUBDOMEIN_PLAN_2026-11-08.md` §2.2.

## Gevolgen bij de uitrol

- Teamleden zonder Tickets krijgen geen pushmeldingen over tickets meer.
- Een klantadres dat ook van een actief teamlid is, krijgt geen ticketmail meer. Op staging geldt
  dat voor de testklant "Gerjan": dat adres is de eigenaar van de organisatie.
- Wie via de database (niet via de app) notities herschreef of namens een ander plaatste, krijgt nu
  een foutmelding.
- Een contactpersoon ziet in Berichten minder: alleen wat aan hem ging en de antwoorden op zijn
  eigen vragen.

## Techniek

- **Migratie** `20261110100000_tickets_controle.sql`:
  - `push_on_ticket_insert` en `push_on_ticket_note_insert` sturen naar
    `push_module_member_ids(org, 'tickets')`;
  - de triggers `tickets_05_authorship` en `ticket_notes_05_authorship`, alleen voor
    `authenticated`;
  - `enforce_tickets_org_integrity` controleert ook `created_by_contact_id`;
  - de policies van `ticket_reads` controleren het ticket;
  - op `ticket_unread` gaan de schrijfrechten eraf.
- **`portal-notify`:**
  - geen mail naar actieve teamleden (`portal_email_is_member`);
  - een eigen rem voor mail die klanten veroorzaken (`PORTAL_NOTIFY_CLIENT_MAILS_PER_HOUR`,
    standaard 100, via `portal_login_hit`);
  - wachten op het quotum telt niet als poging.
- **`client-portal`:**
  - `assertPortalBurst` voor tickets, reacties en berichten;
  - geen `author_name` bij teamnotities;
  - 400 bij een body die geen object is;
  - geen namen van secrets in een foutmelding.
- **`_shared/portalMessages.ts`:** `portalThreadsFor` kent het hoofdadres en toont een teammail
  aan een ander alleen als antwoord op jou.
- **`_shared/actions/tickets.ts`:**
  - klantnamen en koppelen alleen met leesrecht op Klanten;
  - een waarschuwing bij koppelen;
  - id-lijsten in stukken van honderd.
- **`_shared/gerrieCore.ts`:** `list_tickets unanswered_only`.
- **De app:**
  - `src/lib/tickets.ts`: `changedTicketValues` en `ticketClientChangeWarning`;
  - `src/main.tsx`: baseline in het ticketvenster, de vraag bij een andere klant, een titel
    verplicht, Ververs en naar Tickets tellen ongelezen, gelezen vanuit planner en zoeken;
  - `TicketTimeline.tsx`: de keuze intern/zichtbaar blijft staan; zonder klant standaard intern,
    met uitleg;
  - `ClientPortal.tsx`: na reageren het gesprek opnieuw laden.
- **Tests:**
  - `tests/stromen/tickets.mjs` (nieuw) en het scenario `tickets` in `tests/stromen/ui.mjs`;
  - `portalMessages.test.ts` en `tickets.test.ts` uitgebreid.

## Getest

Op de stand die naar staging gaat:

| Controle | Uitslag |
| --- | --- |
| `npm run typecheck` | schoon |
| `npm test` | 1484 tests groen. Nieuw of uitgebreid: `tickets.test.ts` (2), `portalMessages.test.ts` (1), `actionFieldAccess.test.ts` (1). |
| Stromentest `tickets` (nieuw) | 35 stappen, 0 fout |
| De hele stromentest | 976 stappen, waarvan 1 fout. Dat was een 500 van de lokale gateway ("invalid response from the upstream server") bij 15 gelijktijdige tickets, terwijl de mobiele test tegelijk draaide. De stap toetst nu wat telt: hooguit tien in de database, de rest geremd. Daarna `tickets`, `beveiliging` en `klantdomein` op een verse database: 301 stappen, 0 fout. |
| Browsertest `tickets` (nieuw) | 11 stappen, 0 fout. Tegenproef zonder de wijzigingen in `main.tsx`: precies de drie stappen daarover falen (Nieuw na een reactie, het open venster, de vraag bij een andere klant). |
| Tegenproeven | Zonder de fix in `portal-notify` kreeg het teamlid de klantmail. Zonder de rem in één keer kwamen 15 van 15 gelijktijdige tickets door. |
| `deno check` | De 35 functies uit `frontend-checks.yml`, de vijf losse controles en `client-portal`: schoon. Een bewust ingevoegde typefout werd gevonden. |
| `supabase db reset` | 264 van 264 migraties (Postgres 17.11), de nieuwe als laatste. Die draait ook een tweede keer schoon. |
| `npm run build` en `scripts/check-csp-hash.mjs` | geslaagd |
| `npm run test:loading` | alle controles groen |
| `npm run test:mobile -- --theme=both` | 440 pagina's gemeten, 0 met problemen |

## Uitrol op staging (10 november, 09:28)

Merge `14fcd89` naar `staging`:

- **Deploy Supabase (staging), run 207: geslaagd.**
  - `db push` paste `20261110100000_tickets_controle` toe.
  - Alle 40 edge functions zijn uitgerold.
  - De rooktest was geslaagd, ook "portal-notify draait met het secret uit de cron-taak (200)"
    en "anon heeft geen rechten in public".
- **Nacontrole op de database** (alleen lezen):
  - de migratie staat er als laatste;
  - de triggers `tickets_05_authorship` en `ticket_notes_05_authorship` staan er;
  - de pushfuncties sturen naar wie Tickets mag lezen;
  - `authenticated` kan niet meer schrijven op `ticket_unread`;
  - de policy van `ticket_reads` controleert het ticket.
- **De mailronde na de uitrol:** `portal-notify` antwoordt elke minuut met 200, nu ook met het
  aantal wachtende meldingen (`deferred`).
- **De vingerafdruk van het schema** is gelijk aan die van een database vanaf nul, op de bekende
  verschillen na (`pg_cron`, `pg_net`, `public._migrations`, de schrijfwijze van
  `galleries_cover_focus_check`), plus één nieuw gevonden verschil.
  - Op staging zijn `ai_agent_run_push` en `is_own_org_address` lid van een extensie (`supabase_vault`
    en `citext`). Ze bestaan en werken, maar de vingerafdruk slaat ze daarom over. Een `pg_dump`
    neemt ze ook niet mee.
  - Dat staat los van deze wijziging.
- **Cloudflare Pages:** de build van `staging` (14fcd89) is uitgerold op
  `staging.resofly.pages.dev`. Gezien via de API van Cloudflare; de site zelf is vanuit deze sessie
  niet te bereiken.
- **Frontend checks op `staging`, run 181: geslaagd.** Daarin zitten de migraties vanaf nul, de
  echte `deno check` (met `esm.sh` en `deno.land`), typecheck, de CSP-hash, de unittests, de
  mobiele test in beide thema's, laden per module en de inrichtingsstappen.
- **Een echte proef met de mail** staat klaar in de goedkeurwachtrij van de eigenaar in ResoFly.
  Na goedkeuring:
  1. testklant "Gerjan" krijgt het adres `gerjanvanlopik+klant@gmail.com`. Het oude adres is dat
     van de eigenaar, en een teamlid krijgt geen klantmail;
  2. er komt een zichtbaar antwoord op het testticket "App offline". Dat antwoord hoort dan als
     mail "Nieuw antwoord: App offline" in Gmail aan te komen.

  Eerst het adres goedkeuren, dan het antwoord. Anders gaat het antwoord naar het oude adres, en
  dat slaat de mailronde nu over.

**Noot bij `deno check`:** `esm.sh` en `deno.land` zijn vanuit deze sessie niet bereikbaar. De
check draaide met Deno 2.9.6 uit npm en een tijdelijke import map. De zes `esm.sh`-pakketten gingen
via `npm:`, in dezelfde versies. `serve` uit std 0.224.0 ging via een vervanger met dezelfde
handtekening. De echte check draait in CI bij de push naar staging.
