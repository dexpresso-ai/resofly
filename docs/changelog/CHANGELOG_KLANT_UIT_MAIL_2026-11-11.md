# Nieuwe klant uit een mail — 11 november 2026

Vraag: *"Bouw een functionaliteit waaruit de applicatie vanuit een mail een nieuwe klant aan te
maken met de informatie die beschikbaar is."*

Mail van iemand die nog geen klant is, komt in de opvangbak (Berichten → *Niet gekoppeld*, en
het tabblad *Niet gekoppeld* op de klantenlijst). Tot nu toe kon je zo'n mail alleen aan een
**bestaande** klant koppelen. Voor een nieuwe klant ging je naar Klanten, typte je naam, adres
en telefoonnummer over uit de handtekening, en ging je terug om de mail te koppelen.

## Wat er nu kan

- **Knop "Nieuwe klant"** bij elke mail in de opvangbak, naast *Koppelen*. Hij staat er alleen
  als je Klanten mag wijzigen.
- **Het klantformulier opent ingevuld** met wat er in de mail staat:
  - *klantnaam*: de bedrijfsnaam uit de handtekening ("Nieuw Bedrijf B.V."), een formulierveld
    ("Bedrijfsnaam: …"), of anders het domein van het mailadres ("bakker-fotografie.nl" →
    "Bakker Fotografie"). Bij een Gmail- of Hotmail-adres zonder bedrijf: de naam van de persoon;
  - *contactpersoon*: de naam van de afzender, of "Naam: …" / "Voornaam: … Achternaam: …" uit
    een contactformulier;
  - *e-mail, telefoon, adres, postcode, plaats, KvK-nummer en btw-nummer* uit de handtekening
    of de formuliervelden, ook als die op één regel staan ("T: 06 … | E: … | W: …");
  - *status* Prospect, *type klant* Zakelijk of Particulier;
  - een *notitie* met de datum en het onderwerp van de mail, en de website als die erin stond.
- **Boven het formulier staat waar het vandaan komt**: "Uit de mail van Peter de Vries
  (peter@…). Uit de tekst van de mail ingevuld: bedrijfsnaam, telefoon, adres en KvK-nummer.
  Kijk het even na." Er wordt niets opgeslagen voordat jij op *Opslaan* klikt.
- **Na opslaan staat de mail in het dossier** van de nieuwe klant en verdwijnt hij uit de
  opvangbak. Kreeg de klant een ander e-mailadres dan de afzender (bijvoorbeeld info@ in plaats
  van jan@), dan onthoudt ResoFly de afzender als contactpersoon. Zo komt volgende mail van
  dat adres vanzelf goed.
- **De welkomstmail met portaaltoegang staat uit** bij een klant uit een mail. Wie net een vraag
  stelde, heeft nog geen portaal nodig. Aanvinken kan altijd.

## Waar hij op let

- **Geciteerde eerdere mail telt niet mee.** Onder een antwoord staat de vorige mail van het
  bureau, mét zijn eigen handtekening. Alles vanaf "Op … schreef …", een Outlook-kopblok
  ("Van: / Verzonden:") of regels die met `>` beginnen, valt weg.
- **De gegevens van de eigen organisatie neemt hij nooit over.** E-mailadressen en het domein
  van de organisatie en het team, het telefoonnummer, KvK, btw, de postcode en de naam
  (Instellingen → Bedrijfsgegevens) tellen niet. Heeft het bureau zelf een Gmail-adres, dan
  filtert hij niet alle Gmail-klanten weg.
- **Een contactformulier van de website.** De afzender is dan de website (vaak een no-reply-adres
  of het eigen domein), niet de klant. De klant komt uit de velden, en het afzenderadres wordt
  níet aan de klant gehangen; anders kwam elk volgend formulier bij deze ene klant terecht.
- **Een mail die een collega doorstuurde ("Fwd:").** De klant komt uit het kopblok van het
  origineel ("Van: Karim <karim@…>"), niet de collega. Ook hier wordt het adres van de collega
  niet aan de klant gehangen.
- **Geen valse treffers.** "Wij zijn een bv" is geen bedrijfsnaam (een naam schrijf je met
  hoofdletters), een datum of IBAN is geen telefoonnummer, "1500 of meer" is geen postcode.
- **Een dubbele klant** houdt het formulier tegen zoals altijd (zelfde e-mailadres, zelfde naam
  en telefoon). Dan koppel je de mail met *Koppelen* aan de klant die er al is.

## Bewust zo

- **Geen AI.** Het uitlezen gebeurt in de browser, met vaste regels: direct, gratis, en elke keer
  hetzelfde. De mail gaat nergens heen. Tekst in een mail die zich voordoet als opdracht, kan
  hooguit een verkeerde naam in het formulier zetten, en dat formulier controleer je zelf.
- **Geen migratie.** Aanmaken gaat via `create_client_with_next_code`, koppelen via
  `link_inbound_message`, precies zoals de knoppen die er al waren. Daarmee gelden dezelfde
  rechten (module Klanten, schrijven) en dezelfde controles in de database.
- **Lukt het koppelen niet** (bijvoorbeeld omdat een collega de mail net koppelde), dan bestaat
  de klant wel. Je krijgt een melding en de mail blijft in de opvangbak staan.

## Onder de motorkap

- `src/lib/clientFromEmail.ts` (nieuw, puur): `clientDraftFromEmail`, `readMailBody`,
  `describeFoundFields`, `normalizePhone`. 17 tests in `clientFromEmail.test.ts`.
- `components/InboundInbox.tsx`: knop *Nieuwe klant* (`onCreateClient`) en `refreshKey`. Het
  opnieuw laden daarna gebeurt stil, zonder "Opvangbak laden…".
- `features/Clients.tsx` en `features/Communication.tsx` geven beide door.
- `main.tsx`: `openClientFromMail`, `linkMailToNewClient`, `EditMode.client.fromMail`, de
  beginwaarden voor adres, KvK, btw en type klant, en de melding `ClientFromMailNote`.

## Getest

- `npm run typecheck`; `npm test` (1611 tests, 0 fout).
- `npm run test:mobile -- --theme=both`: 506 pagina's gemeten, 0 met problemen.
- In Chromium tegen de nagebootste backend: klantenlijst (laptop) en Berichten (telefoon).
  Opvangbak → *Nieuwe klant* → formulier ingevuld uit een mail met handtekening en een
  geciteerd antwoord van het bureau. Het telefoonnummer en de KvK van het bureau worden niet
  overgenomen. Na *Opslaan*: klant aangemaakt als prospect, mail gekoppeld aan die klant, geen
  welkomstmail, rij weg uit de opvangbak, geen fouten. Ook de foutroute: koppelen mislukt →
  duidelijke melding, mail blijft staan.
