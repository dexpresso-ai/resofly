-- ============================================================
-- ResoFly — Zakelijke module fase 5, brok A:
--   groottecriteria (micro/klein/middelgroot/groot) en vergelijkende rapportage
-- Date: 2026-08-08 (genummerd als 20260812000000 — op staging stonden al
--       migraties met datum 10 en 11 augustus uit de weekplanner, en een lager
--       nummer zou db push tot --include-all dwingen)
--
-- Aanleiding:
-- Fase 5 bouwt de jaarrekening, de publicatiestukken en de deponeerdeadlines.
-- Alles daarin hangt aan twee dingen die vandaag nog niet bestaan:
--
--   1. DE GROOTTEKLASSE. Wat een BV moet opmaken, laten controleren en
--      deponeren volgt uit haar grootteklasse (art. 2:395a, 2:396, 2:397 BW).
--      Die klasse is geen instelling maar een REKENSOM over drie criteria op
--      TWEE OPEENVOLGENDE BALANSDATA. Zonder deze functies zou het scherm de
--      gebruiker zijn eigen klasse laten kiezen — en dat is precies de plek
--      waar een BV per ongeluk te weinig deponeert.
--   2. VERGELIJKENDE CIJFERS. Een jaarrekening toont elk cijfer met het cijfer
--      van het voorgaande boekjaar ernaast, en de balans staat er ná
--      resultaatbestemming in. Beide bestaan nu alleen client-side (de merge in
--      ProfitLoss.tsx) of helemaal niet. De PDF-generator in Deno zou daar een
--      derde implementatie van moeten maken; vandaar dat het één keer naar de
--      database gaat.
--
-- Roadmap: BV_VPB_MODULE_ROADMAP_2026-08-06.md; implementatieplan fase 5 §1.1,
-- §1.2, §2 en §3.
--
-- ── KERNBESLISSINGEN ─────────────────────────────────────────────────────────
--
-- A. DE DREMPELS ZIJN NATIONALE WETGEVING EN STAAN PERIODEGEDATEERD IN EEN
--    EIGEN TABEL. Zelfde opzet als corporate_tax_rates en
--    statutory_interest_rates: geen organization_id, leesbaar voor elke
--    ingelogde gebruiker, alleen via een migratie te wijzigen. Een grensbedrag
--    hardcoderen in een functie betekent dat een wetswijziging met terugwerkende
--    kracht ook oude boekjaren herclassificeert — en dan wijkt de app af van de
--    jaarrekening die al gedeponeerd is.
--
-- B. TWEE REEKSEN GESEED, ALLEBEI MET BRON: boekjaar 2016 (Uitvoeringswet
--    richtlijn jaarrekening, Stb. 2015, 349) en boekjaar 2024 (Implementatie-
--    besluit richtlijn verhoging grensbedragen, Stb. 2024, 52). Zie het
--    seedblok hieronder voor wat er BEWUST NIET is geseed en waarom.
--
-- C. HET WERKNEMERSCRITERIUM IS STRIKT KLEINER DAN. De onderdelen a en b van
--    art. 2:395a/396/397 lid 1 luiden "bedraagt NIET MEER DAN € X" (dus <=,
--    inclusief de grens), onderdeel c luidt "het gemiddeld aantal werknemers
--    over het boekjaar bedraagt MINDER DAN N" (dus strikt <). Een BV met precies
--    50 werknemers is dus NIET klein. Dat verschil van één operator scheelt een
--    hele publicatieset.
--
-- D. DE TWEEJAARSTOETS IS STICKY, NIET "DE ZWAARSTE VAN TWEE JAREN" EN OOK NIET
--    "rauw(k) = rauw(k-1)".
--    Art. 2:395a lid 1 / 2:396 lid 1 / 2:397 lid 1 BW eisen dat de rechtspersoon
--    "op twee opeenvolgende balansdata, zonder onderbreking nadien op twee
--    opeenvolgende balansdata" aan twee of drie van de vereisten heeft voldaan.
--    Die eis werkt SYMMETRISCH: ook een OVERSCHRIJDING telt pas als zij zich op
--    twee opeenvolgende balansdata voordoet (Richtlijn 2013/34/EU art. 3 lid 10).
--
--    De klasse blijft dus staan tot de rechtspersoon er TWEE OPEENVOLGENDE
--    BALANSDATA niet meer in valt; dan springt hij naar de rauwe klasse van het
--    huidige jaar. De regel, exact:
--
--        klasse(eerste schakel) = rauw(eerste schakel)
--
--        klasse(k) = rauw(k)      als rauw(k) <> klasse(k-1)
--                                 EN  rauw(k-1) <> klasse(k-1)
--        klasse(k) = klasse(k-1)  in alle andere gevallen
--
--    TWEE EERDERE VERSIES WAREN FOUT, allebei op hun eigen manier:
--      * `greatest(rank(nu), rank(vorig))` verzwaarde naar boven één jaar te
--        vroeg en liet één uitschieterjaar twéé jaren controleplicht opleveren;
--      * `klasse(k) = rauw(k) als rauw(k) = rauw(k-1)` vergelijkt de twee rauwe
--        jaren met elkáár in plaats van met de geldende klasse. Bij rauw =
--        klein, klein, middelgroot, groot houdt die regel de klasse op klein,
--        terwijl de BV dan twee opeenvolgende balansdata boven de kleingrens
--        zit. Zie testvector 1 bij de functie.
--
--    Let op het RECURSIEVE karakter: de rechterkant gebruikt de EFFECTIEVE
--    klasse van vorig jaar, niet alleen de rauwe. determine_company_size loopt
--    daarom chronologisch over de boekjarenreeks t/m het gevraagde jaar en
--    draagt de klasse door. Dat kost per boekjaar ÉÉN doorloop van
--    report_balance_sheet en ÉÉN van report_profit_and_loss — bewust, want een
--    kortere weg bestaat niet: je kunt de klasse van jaar N niet kennen zonder
--    de effectieve klasse van jaar N-1. De keten loopt hooguit 12 boekjaren
--    terug; verder terug voegt niets toe en kost alleen tijd.
--
--    De zes verplichte testvectoren staan als tabel bij de functie zelf.
--
-- E. DE DREMPELREEKS IS PER BOEKJAAR, MET ÉÉN UITZONDERING VOOR HET
--    VERGELIJKINGSPAAR. rauw(k) wordt getoetst aan de reeks die geldt voor
--    boekjaar k ZELF: boekjaar 2018 wordt niet aan de bedragen van 2026
--    getoetst. Het lookup-jaar volgt uit de AANVANG van dat boekjaar (art. III
--    lid 2 Stb. 2015, 349 en art. 4 Stb. 2024, 52), inclusief de
--    early-adopt-keuze van dát boekjaar.
--
--    Uitzondering, en alleen voor het paar dat de klassewissel bij het GEVRAAGDE
--    boekjaar N bepaalt: daar worden rauw(N) én rauw(N-1) beide aan de reeks van
--    N getoetst (transitieregel Stb. 2024, 52 — het artikel zoals dat voor
--    boekjaar N luidt bevat zowel de verhoogde bedragen als de toets over twee
--    opeenvolgende balansdata). rauw(N-1) wordt dus twee keer berekend: één keer
--    onder de reeks van N-1 voor de eigen klasse van dat jaar, en één keer onder
--    de reeks van N voor de vergelijking. Dat kost géén extra rapportaanroep —
--    de bedragen van N-1 zijn al opgehaald, alleen de drempelvergelijking wordt
--    herhaald.
--
--    Een eerdere versie legde de reeks van het gevraagde jaar over de HELE
--    historie; de versie daarvóór toetste balansdatum N-1 alleen aan de oude
--    reeks. Allebei fout. Welke reeks per boekjaar is gebruikt staat in de
--    uitkomst (chain[].lookupYear en thresholdsUsed.seriesPerFiscalYear).
--
-- F. DE KETEN HEEFT EEN STARTPUNT NODIG, MAAR MAG NIET VOORGOED BLOKKEREN.
--    De lichtere regelingen van art. 2:395a/396/397 lid 1 BW gelden uitsluitend
--    als op TWEE opeenvolgende balansdata aan de vereisten is voldaan. Is de
--    tweede balansdatum onbekend, dan is "klein" niet gedragen — en dat is de
--    gevaarlijke richting: te weinig deponeren en geen accountantscontrole, met
--    art. 2:394 → art. 2:248 lid 2 BW (bewijsvermoeden bestuurdersaansprakelijk-
--    heid) als staart. Tegelijk mag een ontbrekend historisch werknemersaantal
--    niet betekenen dat een bestaande administratie voorgoed geen klasse meer
--    krijgt. Daarom start de keten bij het OUDSTE boekjaar (binnen het venster
--    van 12) dat óf:
--      * is bevestigd als het EERSTE BOEKJAAR VAN DE RECHTSPERSOON
--        (fiscal_year_size_inputs.is_first_fiscal_year_of_entity) — dan is
--        klasse = rauw van dat jaar; de database weet namelijk alleen wat het
--        eerste boekjaar in ResoFly is, en een overstapper heeft daarvóór gewoon
--        boekjaren gehad; óf:
--      * een OPGEGEVEN BEGINKLASSE heeft (fiscal_year_size_inputs
--        .opening_size_class): "op deze balansdatum was de rechtspersoon
--        <klasse>". Die uitspraak van de gebruiker wint van de rauwe toets en
--        maakt oudere boekjaren onnodig.
--    Breekt de keten daarna alsnog (geen werknemersaantal, geen drempelreeks,
--    of een GAT in de boekjarenreeks — zie kernbeslissing I), dan draagt zij
--    niet verder, maar een later boekjaar mét beginklasse start haar opnieuw.
--    Levert het gevraagde boekjaar zo geen klasse op, dan volgt een
--    blockingReason die letterlijk vertelt wát er waar moet worden ingevuld —
--    sizeClass en auditRequired blijven null. De uitweg is geen gok maar de
--    beginklasse, of annual_accounts.size_class_override met een verplichte
--    onderbouwing (brok B).
--
-- I. TWEE BALANSDATA ZIJN ALLEEN "OPEENVOLGEND" ALS DE BOEKJAREN AANSLUITEN.
--    Is period_start(k) <> period_end(k-1) + 1 dag, dan zit er een gat in de
--    reeks en is de premisse van de tweejaarstoets weg. Dat levert een
--    waarschuwing én een ketenonderbreking op: de klasse wordt niet over het gat
--    heen doorgedragen. Heeft het boekjaar ná het gat een opgegeven beginklasse,
--    dan begint de keten daar gewoon opnieuw.
--
-- G. HET GEMIDDELD AANTAL WERKNEMERS IS HANDMATIGE INVOER. ResoFly voert geen
--    salarisadministratie; de loonjournaalpost is een boeking, geen
--    personeelsbestand. Het criterium zelf staat in art. 2:395a/396/397 lid 1
--    onder c BW; art. 2:382 BW regelt de VERMELDING ervan in de toelichting.
--    Ontbreekt het getal, dan is er GEEN klasse — niet een gegokte.
--
-- H. EEN BOEKJAAR DAT MATERIEEL AFWIJKT VAN TWAALF MAANDEN WORDT NIET
--    HERREKEND. De omzetgrens van onderdeel b is een JAARgrens, maar de
--    herrekeningsbepaling (pro rata? en zo ja op welke grondslag?) is in het
--    juridische onderzoek niet geverifieerd. Zelf normaliseren zou een niet
--    geverifieerde regel stilzwijgend tot norm maken. Daarom: geen normalisatie,
--    wél een expliciete waarschuwing mét het aantal dagen erbij, en de verwijzing
--    naar de override-route (fiscal_year_size_inputs.net_turnover_cents /
--    total_assets_cents). Richting van de fout die de gebruiker dan zelf moet
--    corrigeren: een KORT boekjaar meet te weinig omzet tegen een jaargrens en
--    classificeert te LICHT; een LANG eerste boekjaar doet het omgekeerde.
--
-- ── VALKUILEN DIE HIER BEWUST ZIJN AFGEVANGEN ────────────────────────────────
--
-- 1. `having sum(...) <> 0` IN DE BESTAANDE RAPPORT-RPC'S. Zowel
--    report_balance_sheet als report_profit_and_loss laat rekeningen met saldo
--    nul wég. Een "0520 Overige reserves" die vóór de bestemming op nul stond,
--    zit dus NIET in de basisbalans — en met een left join zou de hele
--    resultaatbestemming stilzwijgend uit het beeld verdwijnen. Overal een
--    FULL OUTER JOIN, en de rekeninggegevens komen uit ledger_accounts en niet
--    uit de rapportregel. Dit is de meest waarschijnlijke stille fout in dit
--    blok; wie hier iets wijzigt, controleert dit eerst.
--
-- 2. DE VERGELIJKENDE KOLOM STAAT ÓÓK NÁ BESTEMMING. Het besluit over boekjaar
--    N-1 wordt geboekt in boekjaar N (de besluitdatum ligt ná de balansdatum),
--    dus op balansdatum N-1 zit het er nog niet in. De vergelijkende kolom
--    zonder die mutatie zou een onverdeeld resultaat tonen dat allang bestemd
--    is. Daarom krijgt ook de vorige kolom zijn eigen delta.
--
-- 3. DE VIRTUELE REGEL "Resultaat lopend boekjaar" uit report_balance_sheet.
--    Die hoort er bij een afgesloten boekjaar op nul te staan (het
--    year_close-boekstuk valt óp period_end). Staat er tóch een bedrag, dan
--    klopt closed_periods niet en is de balans niet te vertrouwen — dan een
--    duidelijke fout in plaats van een balans die niet sluit.
--
-- 4. DE BESTEMMINGSMUTATIE KOMT UIT DE BOEKING, NIET UIT GROOTBOEKCODES.
--    result_appropriations bewaart weliswaar reserves_account_code /
--    dividend_account_code, maar ledger_accounts.code is via RLS vrij te
--    wijzigen. Een hernoemde of hergebruikte code zou de reservetoevoeging STIL
--    op een andere eigen-vermogensrekening laten landen — en omdat de som over
--    de passiva dan nog steeds nul is, gaat de sluitcontrole niet af. Daarom
--    leidt result_appropriation_delta de mutatie af uit journal_lines van
--    result_appropriations.journal_entry_id; de code-herleiding is alleen nog
--    de terugval voor een bestemming zonder boekstuk.
--
-- 5. AMBIGUÏTEIT TUSSEN OUT-PARAMETERS EN KOLOMNAMEN. Deze functies heten hun
--    OUT-kolommen account_id, code, name, section, amount_cents — precies zoals
--    de kolommen van de aangeroepen rapport-RPC's. In plpgsql wint dan de
--    variabele en dat geeft een runtime-fout. Elke kolomverwijzing in dit
--    bestand is daarom gekwalificeerd met een alias.
--
-- 6. BEDRAGEN IN HELE CENTEN (bigint), zoals de rest van de boekhouding. De
--    wet spreekt in euro's; € 450.000 is hier 45000000.
--
-- Dit is een hulpmiddel, geen advies. De grootteklasse wordt PER ADMINISTRATIE
-- bepaald. Groepsmaatschappijen die in een consolidatie zouden moeten worden
-- betrokken tellen mee op grond van art. 2:395a lid 2 / 2:396 lid 2 / 2:397
-- lid 2 BW — tenzij de rechtspersoon art. 2:408 BW toepast — en dat optellen
-- doet ResoFly niet (fase 6). Maakt deze administratie deel uit van een groep
-- (organizations.parent_organization_id gevuld of child-organisaties aanwezig),
-- dan komt daar een aparte, scherpere waarschuwing bij en blijft auditRequired
-- bewust onbeslist (null). De uitkomst is altijd met de hand te overrulen.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. company_size_thresholds — de grensbedragen per boekjaar (nationaal)
-- ------------------------------------------------------------
create table if not exists public.company_size_thresholds (
  id uuid primary key default gen_random_uuid(),
  size_class text not null check (size_class in ('micro','klein','middelgroot')),
  -- Geldt voor boekjaren die AANVANGEN op of na 1 januari van dit jaar. De
  -- overgangsbepalingen van beide wetswijzigingen knopen aan bij de aanvang van
  -- het boekjaar, niet bij de balansdatum; een gebroken boekjaar 1-7-2023 /
  -- 30-6-2024 valt dus nog onder de reeks van 2016.
  valid_from_year integer not null,
  -- Onderdeel a: "de waarde van de activa ... bedraagt NIET MEER DAN" → <=.
  max_assets_cents bigint not null check (max_assets_cents > 0),
  -- Onderdeel b: "de netto-omzet ... bedraagt NIET MEER DAN" → <=.
  max_turnover_cents bigint not null check (max_turnover_cents > 0),
  -- Onderdeel c: "het gemiddeld aantal werknemers bedraagt MINDER DAN" → strikt
  -- kleiner dan. EXCLUSIEF deze waarde dus: 10 werknemers is niet micro,
  -- 50 is niet klein, 250 is niet middelgroot.
  max_employees integer not null check (max_employees > 0),
  article text not null,
  source_note text,
  created_at timestamptz not null default now(),
  unique (size_class, valid_from_year)
);

comment on table public.company_size_thresholds is
  'Grensbedragen van art. 2:395a, 2:396 en 2:397 lid 1 BW per boekjaar. Onderdelen a en b zijn "niet meer dan" (<=), onderdeel c is "minder dan" (strikt <). Nationale wetgeving; alleen via migraties te wijzigen. "Groot" staat er niet in: dat is de restcategorie.';

alter table public.company_size_thresholds enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'company_size_thresholds'
      and policyname = 'company size thresholds read'
  ) then
    -- Nationale wetgeving, geen org-data: leesbaar voor elke ingelogde
    -- gebruiker. Geen apply_module_gate — die vraagt om een organization_id
    -- en die heeft deze tabel bewust niet.
    create policy "company size thresholds read" on public.company_size_thresholds
      for select using (auth.role() = 'authenticated');
  end if;
end $$;

-- ── De seed ──────────────────────────────────────────────────────────────────
--
-- WAT ER WÉL IN GAAT EN WAAROM
--
-- * valid_from_year = 2016 — Uitvoeringswet richtlijn jaarrekening,
--   Stb. 2015, 349. Die wet voegde art. 2:395a in (micro: € 350.000 /
--   € 700.000 / minder dan 10) en verhoogde in art. 2:396 lid 1 "€ 4.400.000"
--   naar "€ 6.000.000" en "€ 8.800.000" naar "€ 12.000.000", en in art. 2:397
--   lid 1 "€ 17.500.000" naar "€ 20.000.000" en "€ 35.000.000" naar
--   "€ 40.000.000". Toepassing: boekjaren die aanvangen op of na 1-1-2016
--   (art. III lid 2). Bevestigd aan de achterkant door de Nota van toelichting
--   bij Stb. 2024, 52, die exact déze bedragen noemt als de bedragen die
--   werden verhoogd — ze golden dus nog onmiddellijk vóór boekjaar 2024.
--
-- * valid_from_year = 2024 — Implementatiebesluit richtlijn verhoging
--   grensbedragen, Stb. 2024, 52 (in werking 13-3-2024), ter uitvoering van
--   Gedelegeerde Richtlijn (EU) 2023/2775: alle bedragen 25% omhoog. Het
--   werknemerscriterium is NIET gewijzigd en blijft "minder dan 10 / 50 / 250".
--
-- WAT ER BEWUST NIET IN GAAT
--
-- * Boekjaren vóór 2016. Micro bestond toen nog niet (art. 2:395a is bij
--   Stb. 2015, 349 ingevoegd) en de klein/middelgroot-bedragen van vóór die wet
--   (€ 4,4 mln / € 8,8 mln resp. € 17,5 mln / € 35 mln) zijn in het onderzoek
--   alleen zijdelings tegengekomen, niet als eigen reeks geverifieerd. Een
--   boekjaar vóór 2016 levert daarom sizeClass null met een nette melding —
--   geen gegokte klasse. Dat is in de praktijk geen beperking: de jaarrekening
--   over zo'n boekjaar is allang gedeponeerd.
--
-- * Een aparte rij voor boekjaar 2023. Art. 4 van Stb. 2024, 52 laat de nieuwe
--   bedragen OPTIONEEL al toepassen op boekjaren die aanvangen op of na
--   1-1-2023. Dat is een KEUZE van de rechtspersoon, geen wetswijziging per
--   2023, en hij hoort dus niet in een nationale tabel maar bij de
--   administratie: fiscal_year_size_inputs.early_adopt_new_thresholds (blok 2).
--
-- RESTERENDE ONZEKERHEID, eerlijk vastgelegd in source_note: de geldende
-- geconsolideerde artikelteksten op wetten.overheid.nl waren niet op te halen
-- (het document wordt afgekapt en de datumvarianten gaven 404). De bedragen
-- staan daarom op twee Staatsbladen in plaats van op een schermafdruk van de
-- historische wettekst, en een tussentijdse wijziging tussen 2016 en 2023 is
-- niet exhaustief uitgesloten. Het indirecte bewijs is sterk (de toelichting bij
-- Stb. 2024, 52 verhoogt vanaf exact de bedragen uit Stb. 2015, 349), maar wie
-- 100% zekerheid op artikelniveau wil, laat de wettekst één keer handmatig
-- verifiëren en corrigeert dan met een NIEUWE migratie.
insert into public.company_size_thresholds
  (size_class, valid_from_year, max_assets_cents, max_turnover_cents, max_employees, article, source_note)
values
  ('micro',        2016,    35000000,    70000000,  10, 'art. 2:395a lid 1 BW',
   'Uitvoeringswet richtlijn jaarrekening, Stb. 2015, 349: art. 2:395a ingevoegd met € 350.000 / € 700.000 / minder dan 10 werknemers. Van toepassing op boekjaren die aanvangen op of na 1-1-2016 (art. III lid 2). Bevestigd door de Nota van toelichting bij Stb. 2024, 52, die deze bedragen noemt als de bedragen die per boekjaar 2024 werden verhoogd.'),
  ('klein',        2016,   600000000,  1200000000,  50, 'art. 2:396 lid 1 BW',
   'Stb. 2015, 349: in art. 2:396 lid 1 werd "€ 4.400.000" vervangen door "€ 6.000.000" en "€ 8.800.000" door "€ 12.000.000". Werknemerscriterium ongewijzigd: minder dan 50. Van toepassing op boekjaren aangevangen op of na 1-1-2016.'),
  ('middelgroot',  2016,  2000000000,  4000000000, 250, 'art. 2:397 lid 1 BW',
   'Stb. 2015, 349: in art. 2:397 lid 1 werd "€ 17.500.000" vervangen door "€ 20.000.000" en "€ 35.000.000" door "€ 40.000.000". Werknemerscriterium ongewijzigd: minder dan 250. Van toepassing op boekjaren aangevangen op of na 1-1-2016.'),

  ('micro',        2024,    45000000,    90000000,  10, 'art. 2:395a lid 1 BW',
   'Bedragen met 25% verhoogd bij het Implementatiebesluit richtlijn verhoging grensbedragen, Stb. 2024, 52 (in werking 13-3-2024), ter uitvoering van Gedelegeerde Richtlijn (EU) 2023/2775. Geldt voor boekjaren die aanvangen op of na 1-1-2024; optioneel al vanaf boekjaar 2023 (art. 4). Werknemersaantal ongewijzigd.'),
  ('klein',        2024,   750000000,  1500000000,  50, 'art. 2:396 lid 1 BW',
   'Bedragen met 25% verhoogd bij Stb. 2024, 52. Geldt voor boekjaren die aanvangen op of na 1-1-2024; optioneel al vanaf boekjaar 2023 (art. 4). Werknemersaantal ongewijzigd.'),
  ('middelgroot',  2024,  2500000000,  5000000000, 250, 'art. 2:397 lid 1 BW',
   'Bedragen met 25% verhoogd bij Stb. 2024, 52. Geldt voor boekjaren die aanvangen op of na 1-1-2024; optioneel al vanaf boekjaar 2023 (art. 4). Werknemersaantal ongewijzigd. Alles boven deze grenzen is "groot" (restcategorie, art. 2:398 e.v. BW).')
on conflict (size_class, valid_from_year) do nothing;

-- ------------------------------------------------------------
-- 2. fiscal_year_size_inputs — de invoer die niet af te leiden is
-- ------------------------------------------------------------
create table if not exists public.fiscal_year_size_inputs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  fiscal_year_id uuid not null references public.fiscal_years(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  -- Het gemiddeld aantal gedurende het boekjaar bij de rechtspersoon werkzame
  -- werknemers. Het CRITERIUM staat in art. 2:395a/396/397 lid 1 onder c BW;
  -- art. 2:382 BW regelt de vermelding ervan in de toelichting. Nergens uit af
  -- te leiden: de loonjournaalpost is een boeking, geen personeelsadministratie.
  -- Numeric, want een gemiddelde over een boekjaar is zelden een rond getal.
  average_employees numeric(8,2) not null check (average_employees >= 0),
  -- Overrides. Leeg = afleiden uit de rapport-RPC's. Ingevuld = de gebruiker
  -- corrigeert, bijvoorbeeld omdat het balanstotaal op verkrijgings- of
  -- vervaardigingsprijs moet (art. 2:395a/396 lid 1 onder a) terwijl het
  -- grootboek boekwaarde geeft, omdat de cijfers van groepsmaatschappijen
  -- meetellen (art. 2:395a lid 2 / 2:396 lid 2 / 2:397 lid 2 BW, tenzij de
  -- rechtspersoon art. 2:408 BW toepast), of omdat het boekjaar korter of
  -- langer is dan twaalf maanden en de omzet daarom niet één-op-één tegen een
  -- jaargrens gelegd kan worden.
  total_assets_cents bigint check (total_assets_cents >= 0),
  net_turnover_cents bigint check (net_turnover_cents >= 0),
  override_reason text,
  -- Art. 4 Stb. 2024, 52: de verhoogde bedragen MOGEN al worden toegepast op
  -- boekjaren die aanvangen op of na 1-1-2023. Dat is een keuze van deze
  -- rechtspersoon, dus hij staat hier en niet in de nationale tabel.
  early_adopt_new_thresholds boolean not null default false,
  -- De tweejaarstoets van art. 2:395a/396/397 lid 1 BW heeft een startpunt
  -- nodig. De database weet alleen wat het oudste boekjaar in ResoFly is; of
  -- dat óók het eerste boekjaar van de RECHTSPERSOON is, weet alleen de
  -- gebruiker. Zonder deze bevestiging op het oudste boekjaar draagt de keten
  -- niet en geeft determine_company_size een blokkerende reden in plaats van
  -- een klasse. Zie kernbeslissing F in de kop.
  is_first_fiscal_year_of_entity boolean not null default false,
  -- De ontsnappingsroute voor een overstapper. Wie met een lopende BV naar
  -- ResoFly komt heeft de historie niet in de administratie staan; zonder deze
  -- kolom zou zo iemand voorgoed een blokkerende reden krijgen omdat de keten
  -- nergens kan beginnen. Hier legt hij vast welke grootteklasse gold op de
  -- balansdatum VÓÓR dit boekjaar; de plakkerige regel draait daar meteen op
  -- door. Ook het startpunt na een gat in de boekjarenreeks.
  opening_size_class text check (opening_size_class in ('micro','klein','middelgroot','groot')),
  -- Art. 2:396 lid 5 BW: naam en woonplaats van de maatschappij die de
  -- geconsolideerde jaarrekening opstelt waarin deze gegevens zijn opgenomen.
  consolidating_parent_name text,
  consolidating_parent_city text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, fiscal_year_id)
);

-- Herhaalbaarheid: kolommen die ná de eerste toepassing zijn bijgekomen staan
-- óók als losse alter, want "create table if not exists" slaat een bestaande
-- tabel volledig over en zou ze dan stilzwijgend missen.
alter table public.fiscal_year_size_inputs
  add column if not exists is_first_fiscal_year_of_entity boolean not null default false,
  add column if not exists opening_size_class text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.fiscal_year_size_inputs'::regclass
      and conname = 'fiscal_year_size_inputs_opening_size_class_check'
  ) then
    alter table public.fiscal_year_size_inputs
      add constraint fiscal_year_size_inputs_opening_size_class_check
      check (opening_size_class in ('micro','klein','middelgroot','groot'));
  end if;
end $$;

comment on column public.fiscal_year_size_inputs.opening_size_class is
  'De grootteklasse die gold op de balansdatum VÓÓR dit boekjaar. Startpunt van de tweejaarstoets voor een rechtspersoon waarvan de historie niet in ResoFly staat, en na een gat in de boekjarenreeks.';

comment on table public.fiscal_year_size_inputs is
  'Per boekjaar de gegevens voor de groottetoets die niet uit het grootboek volgen: het gemiddeld aantal werknemers (art. 2:395a/396/397 lid 1 onder c BW), eventuele correcties op balanstotaal en netto-omzet, de bevestiging dat dit het eerste boekjaar van de rechtspersoon is (startpunt van de tweejaarstoets) en de keuze om de verhoogde grensbedragen al op boekjaar 2023 toe te passen (art. 4 Stb. 2024, 52).';

comment on column public.fiscal_year_size_inputs.is_first_fiscal_year_of_entity is
  'Bevestiging dat dit het eerste boekjaar van de RECHTSPERSOON is, niet slechts het eerste boekjaar in ResoFly. Zonder die bevestiging op het oudste boekjaar van de administratie kan de tweejaarstoets van art. 2:395a/396/397 lid 1 BW niet worden gestart en geeft determine_company_size geen klasse.';

-- Bewust GEEN losse index op (organization_id, fiscal_year_id): de
-- unique-constraint hierboven maakt al een btree-index op precies die twee
-- kolommen in precies die volgorde. Een tweede zou nooit gekozen worden en
-- alleen schrijfwerk kosten.

alter table public.fiscal_year_size_inputs enable row level security;
-- Alleen lezen; schrijven loopt via save_fiscal_year_size_inputs hieronder,
-- zoals overal in de boekhoudmodule.
drop policy if exists "fiscal_year_size_inputs read" on public.fiscal_year_size_inputs;
create policy "fiscal_year_size_inputs read" on public.fiscal_year_size_inputs
  for select using (public.can_read_org(organization_id));

-- Modulerechten: het gemiddeld aantal werknemers en het balanstotaal zijn
-- financiële kerngegevens. can_read_org kijkt alleen naar lidmaatschap, dus
-- zonder deze restrictieve policies zou de tabel voor iedereen in de
-- organisatie open staan.
select public.apply_module_gate('fiscal_year_size_inputs', 'finance');

drop trigger if exists fiscal_year_size_inputs_touch_updated_at on public.fiscal_year_size_inputs;
create trigger fiscal_year_size_inputs_touch_updated_at before update on public.fiscal_year_size_inputs
  for each row execute function public.bookkeeping_touch_updated_at();
drop trigger if exists fiscal_year_size_inputs_prevent_org_change on public.fiscal_year_size_inputs;
create trigger fiscal_year_size_inputs_prevent_org_change before update of organization_id on public.fiscal_year_size_inputs
  for each row execute function public.prevent_organization_id_change();
drop trigger if exists fiscal_year_size_inputs_audit on public.fiscal_year_size_inputs;
create trigger fiscal_year_size_inputs_audit after insert or update or delete on public.fiscal_year_size_inputs
  -- Tweede argument is de kolom waaruit het LABEL in de activiteitenlijst komt.
  -- De tabel heeft geen naam; het werknemersgemiddelde is het herkenbaarste dat
  -- er is (en tevens het enige verplichte veld).
  for each row execute function public.audit_row_change('fiscal_year_size_input', 'average_employees');

-- ------------------------------------------------------------
-- 3. save_fiscal_year_size_inputs
--    Eén rij per boekjaar; opnieuw opslaan overschrijft. Bewust géén losse
--    "verwijder"-RPC: leeglaten van de overrides doe je door ze op null te
--    zetten, en het werknemersaantal moet er hoe dan ook zijn.
-- ------------------------------------------------------------
create or replace function public.save_fiscal_year_size_inputs(
  p_organization_id uuid,
  p_fiscal_year_id uuid,
  p_average_employees numeric,
  p_total_assets_cents bigint default null,
  p_net_turnover_cents bigint default null,
  p_override_reason text default null,
  p_early_adopt_new_thresholds boolean default false,
  p_consolidating_parent_name text default null,
  p_consolidating_parent_city text default null,
  p_note text default null,
  -- Achteraan toegevoegd zodat de positionele volgorde van de al gedocumenteerde
  -- parameters niet verschuift.
  p_is_first_fiscal_year_of_entity boolean default false,
  -- De grootteklasse op de balansdatum vóór dit boekjaar, voor een rechtspersoon
  -- waarvan de historie niet in ResoFly staat.
  p_opening_size_class text default null
)
returns public.fiscal_year_size_inputs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fy public.fiscal_years;
  v_row public.fiscal_year_size_inputs;
  v_start_year integer;
  v_earlier_label text;
begin
  -- Schrijfrechten op de organisatie ÉN op de module. De modulecheck staat er
  -- apart bij omdat een SECURITY DEFINER-functie langs RLS heen loopt: de
  -- restrictieve policies op de tabel doen hier niets.
  if auth.role() <> 'service_role'
     and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  if not public.org_has_business(p_organization_id) then
    raise exception 'De groottebepaling hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;
  if public.org_fiscal_regime(p_organization_id) <> 'vpb' then
    raise exception 'De groottecriteria van art. 2:395a, 2:396 en 2:397 BW gelden voor een BV, NV of coöperatie. Pas eerst de rechtsvorm aan bij Instellingen → Bedrijfsgegevens.'
      using errcode = '23514';
  end if;

  select * into v_fy from public.fiscal_years
  where id = p_fiscal_year_id and organization_id = p_organization_id;
  if not found then
    raise exception 'Boekjaar niet gevonden.' using errcode = '02000';
  end if;

  if p_average_employees is null then
    raise exception 'Vul het gemiddeld aantal werknemers over dit boekjaar in (art. 2:396 lid 1 onder c BW; te vermelden op grond van art. 2:382 BW). Zonder dat getal is de grootteklasse niet te bepalen.'
      using errcode = '23514';
  end if;
  if p_average_employees < 0 then
    raise exception 'Het gemiddeld aantal werknemers kan niet negatief zijn.' using errcode = '23514';
  end if;
  if p_total_assets_cents is not null and p_total_assets_cents < 0 then
    raise exception 'Een negatief balanstotaal kan niet.' using errcode = '23514';
  end if;
  if p_net_turnover_cents is not null and p_net_turnover_cents < 0 then
    raise exception 'Een negatieve netto-omzet kan niet.' using errcode = '23514';
  end if;

  -- De vervroegde toepassing van de verhoogde grensbedragen is bij art. 4 van
  -- Stb. 2024, 52 uitsluitend opengesteld voor boekjaren die aanvangen op of na
  -- 1-1-2023. Voor elk ander boekjaar zou de vlag stilzwijgend niets doen (2024
  -- en later) of ronduit de verkeerde bedragen pakken (2022 en eerder); dus
  -- meteen hier weigeren in plaats van later een onverklaarbare klasse tonen.
  v_start_year := extract(year from v_fy.period_start)::int;
  if coalesce(p_early_adopt_new_thresholds, false) and v_start_year <> 2023 then
    raise exception 'De verhoogde grensbedragen mogen alleen vervroegd worden toegepast op een boekjaar dat aanvangt in 2023 (art. 4 Stb. 2024, 52). Dit boekjaar vangt aan in %.', v_start_year
      using errcode = '23514';
  end if;

  -- "Eerste boekjaar van de rechtspersoon" is alleen te bevestigen als er in
  -- deze administratie geen ouder boekjaar staat. Anders spreekt de bevestiging
  -- de eigen boekhouding tegen en zou de tweejaarstoets op het verkeerde jaar
  -- starten.
  if coalesce(p_is_first_fiscal_year_of_entity, false) then
    select fy.label into v_earlier_label
    from public.fiscal_years fy
    where fy.organization_id = p_organization_id
      and fy.period_start < v_fy.period_start
    order by fy.period_start desc
    limit 1;
    if v_earlier_label is not null then
      raise exception 'Dit kan niet het eerste boekjaar van de rechtspersoon zijn: in deze administratie staat boekjaar % er nog vóór. Zet de bevestiging op het oudste boekjaar.', v_earlier_label
        using errcode = '23514';
    end if;
  end if;

  insert into public.fiscal_year_size_inputs (
    organization_id, fiscal_year_id, created_by,
    average_employees, total_assets_cents, net_turnover_cents, override_reason,
    early_adopt_new_thresholds, is_first_fiscal_year_of_entity, opening_size_class,
    consolidating_parent_name, consolidating_parent_city, note
  ) values (
    p_organization_id, p_fiscal_year_id, auth.uid(),
    p_average_employees, p_total_assets_cents, p_net_turnover_cents,
    nullif(btrim(p_override_reason), ''),
    coalesce(p_early_adopt_new_thresholds, false),
    coalesce(p_is_first_fiscal_year_of_entity, false),
    nullif(btrim(p_opening_size_class), ''),
    nullif(btrim(p_consolidating_parent_name), ''),
    nullif(btrim(p_consolidating_parent_city), ''),
    nullif(btrim(p_note), '')
  )
  on conflict (organization_id, fiscal_year_id) do update set
    average_employees              = excluded.average_employees,
    total_assets_cents             = excluded.total_assets_cents,
    net_turnover_cents             = excluded.net_turnover_cents,
    override_reason                = excluded.override_reason,
    early_adopt_new_thresholds     = excluded.early_adopt_new_thresholds,
    is_first_fiscal_year_of_entity = excluded.is_first_fiscal_year_of_entity,
    opening_size_class             = excluded.opening_size_class,
    consolidating_parent_name      = excluded.consolidating_parent_name,
    consolidating_parent_city      = excluded.consolidating_parent_city,
    note                           = excluded.note
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.save_fiscal_year_size_inputs(uuid, uuid, numeric, bigint, bigint, text, boolean, text, text, text, boolean, text) is
  'Legt per boekjaar het gemiddeld aantal werknemers (art. 2:395a/396/397 lid 1 onder c BW) en eventuele correcties op balanstotaal en netto-omzet vast, plus de keuze om de verhoogde grensbedragen al op boekjaar 2023 toe te passen (art. 4 Stb. 2024, 52) en de bevestiging dat dit het eerste boekjaar van de rechtspersoon is.';

revoke all on function public.save_fiscal_year_size_inputs(uuid, uuid, numeric, bigint, bigint, text, boolean, text, text, text, boolean, text) from public, anon;
grant execute on function public.save_fiscal_year_size_inputs(uuid, uuid, numeric, bigint, bigint, text, boolean, text, text, text, boolean, text) to authenticated, service_role;

-- ------------------------------------------------------------
-- 4. De toets per boekjaar
--    company_size_evaluate_year doet het rekenwerk en geeft alles terug wat het
--    scherm nodig heeft om de uitkomst te verantwoorden;
--    company_size_class_for_year is de kale variant voor wie alleen de klasse
--    wil. Eén implementatie, twee ingangen — zodat de "minstens twee van de
--    drie"-regel en de <=/<-operatoren maar op één plek staan.
--
--    LET OP: dit is de RAUWE toets van één balansdatum. De tweejaarsregel van
--    art. 2:395a/396/397 lid 1 BW zit hier NIET in; die zit in
--    determine_company_size.
--
--    p_year is het jaar waarmee de drempelreeks wordt opgezocht. Voor een losse
--    aanroep is dat het aanvangsjaar van het boekjaar en doet p_early_adopt de
--    verschuiving 2023 → 2024. determine_company_size bepaalt dat lookup-jaar
--    zélf, PER BOEKJAAR in de keten (kernbeslissing E), en geeft het hier al
--    opgelost binnen met p_early_adopt = false. Het vergelijkingsjaar wordt
--    daar een tweede keer doorheen gehaald onder de reeks van het jongste jaar
--    van het paar; dat kost alleen een extra drempelvergelijking, geen extra
--    rapportaanroep.
--
--    Beide functies zijn security definer met een vast search_path, maar hebben
--    GEEN org-guard: ze krijgen alleen kale getallen mee en lezen uitsluitend
--    de nationale drempeltabel, die elke ingelogde gebruiker sowieso mag lezen.
--    Er is hier dus niets organisatiegebonden om te bewaken.
-- ------------------------------------------------------------
create or replace function public.company_size_evaluate_year(
  p_year integer,
  p_assets_cents bigint,
  p_turnover_cents bigint,
  p_employees numeric,
  p_early_adopt boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_lookup_year integer;
  v_class text;
  v_t public.company_size_thresholds%rowtype;
  v_classes_found integer := 0;
  v_met text[];
  v_criteria jsonb := '{}'::jsonb;
  v_result text := null;
  v_used jsonb := null;
begin
  -- Ontbreekt één van de drie criteria, dan is er geen klasse. Niet gokken:
  -- een ontbrekend werknemersaantal is de normale situatie zolang de gebruiker
  -- het nog niet heeft ingevuld.
  if p_year is null or p_assets_cents is null or p_turnover_cents is null or p_employees is null then
    return jsonb_build_object(
      'class', null::text,
      'lookupYear', null::integer,
      'inputsMissing', true,
      'thresholdsMissing', false,
      'criteriaMet', '{}'::jsonb,
      'thresholdsUsed', null::jsonb
    );
  end if;

  -- Art. 4 Stb. 2024, 52: alleen boekjaar 2023 mag vervroegd de reeks van 2024
  -- gebruiken. Voor elk ander jaar doet de vlag niets.
  v_lookup_year := case
    when coalesce(p_early_adopt, false) and p_year = 2023 then 2024
    else p_year
  end;

  -- Cascaderend, en die volgorde is de wettekst zelf: art. 2:396 lid 1 opent met
  -- "Onverminderd artikel 395a" en art. 2:397 lid 1 met "Behoudens artikel 396".
  -- De eerste klasse waarvoor minstens twee van de drie vereisten opgaan, wint.
  foreach v_class in array array['micro','klein','middelgroot']::text[] loop
    select t.* into v_t
    from public.company_size_thresholds t
    where t.size_class = v_class
      and t.valid_from_year <= v_lookup_year
    order by t.valid_from_year desc
    limit 1;

    if not found then
      continue;
    end if;
    v_classes_found := v_classes_found + 1;

    v_met := array[]::text[];
    -- Onderdeel a en b: "niet meer dan" → de grens telt mee.
    if p_assets_cents <= v_t.max_assets_cents then
      v_met := array_append(v_met, 'assets');
    end if;
    if p_turnover_cents <= v_t.max_turnover_cents then
      v_met := array_append(v_met, 'turnover');
    end if;
    -- Onderdeel c: "minder dan" → STRIKT kleiner. Precies 50 werknemers is niet
    -- klein. Wie hier <= van maakt, laat BV's een publicatieset te licht doen.
    if p_employees < v_t.max_employees then
      v_met := array_append(v_met, 'employees');
    end if;

    v_criteria := v_criteria || jsonb_build_object(v_class, to_jsonb(v_met));

    if v_result is null and coalesce(array_length(v_met, 1), 0) >= 2 then
      v_result := v_class;
      v_used := jsonb_build_object(
        'sizeClass', v_t.size_class,
        'validFromYear', v_t.valid_from_year,
        'maxAssetsCents', v_t.max_assets_cents,
        'maxTurnoverCents', v_t.max_turnover_cents,
        'maxEmployees', v_t.max_employees,
        'article', v_t.article,
        'sourceNote', v_t.source_note
      );
    end if;
  end loop;

  -- Alle drie de klassen moeten bekend zijn. Ontbreekt bijvoorbeeld alleen de
  -- middelgroot-rij, dan is "groot" niet van "middelgroot" te onderscheiden en
  -- zou de uitkomst een gok zijn.
  if v_classes_found < 3 then
    return jsonb_build_object(
      'class', null::text,
      'lookupYear', v_lookup_year,
      'inputsMissing', false,
      'thresholdsMissing', true,
      'criteriaMet', v_criteria,
      'thresholdsUsed', null::jsonb
    );
  end if;

  if v_result is null then
    -- Restcategorie: er is geen "groot"-artikel, groot is wat niet onder
    -- art. 2:395a, 2:396 of 2:397 lid 1 valt.
    v_result := 'groot';
    v_used := jsonb_build_object(
      'sizeClass', 'groot',
      'validFromYear', v_lookup_year,
      'article', 'restcategorie — voldoet niet aan art. 2:397 lid 1 BW',
      'sourceNote', null::text
    );
  end if;

  return jsonb_build_object(
    'class', v_result,
    'lookupYear', v_lookup_year,
    'inputsMissing', false,
    'thresholdsMissing', false,
    'criteriaMet', v_criteria,
    'thresholdsUsed', v_used
  );
end;
$$;

comment on function public.company_size_evaluate_year(integer, bigint, bigint, numeric, boolean) is
  'Toetst ÉÉN balansdatum aan de grensbedragen van art. 2:395a/396/397 lid 1 BW: minstens twee van de drie vereisten, activa en omzet inclusief de grens (<=), werknemers strikt eronder (<). Geeft de rauwe klasse, welke criteria per klasse zijn gehaald en welke drempelrij is gebruikt. De tweejaarsregel zit hier niet in — die staat in determine_company_size.';

revoke all on function public.company_size_evaluate_year(integer, bigint, bigint, numeric, boolean) from public, anon;
grant execute on function public.company_size_evaluate_year(integer, bigint, bigint, numeric, boolean) to authenticated, service_role;

create or replace function public.company_size_class_for_year(
  p_year integer,
  p_assets_cents bigint,
  p_turnover_cents bigint,
  p_employees numeric,
  p_early_adopt boolean default false
)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select nullif(
    public.company_size_evaluate_year(
      p_year, p_assets_cents, p_turnover_cents, p_employees, p_early_adopt
    ) ->> 'class', ''
  );
$$;

comment on function public.company_size_class_for_year(integer, bigint, bigint, numeric, boolean) is
  'Rauwe grootteklasse van één balansdatum: micro, klein, middelgroot of groot. Null als de drempels voor dat boekjaar niet zijn vastgelegd of als een van de drie criteria ontbreekt. Zonder tweejaarsregel.';

revoke all on function public.company_size_class_for_year(integer, bigint, bigint, numeric, boolean) from public, anon;
grant execute on function public.company_size_class_for_year(integer, bigint, bigint, numeric, boolean) to authenticated, service_role;

-- De rangorde van de klassen: micro is het lichtste regime, groot het zwaarste.
-- De tweejaarstoets gebruikt deze rang NIET meer (die is sticky, geen maximum —
-- zie kernbeslissing D), maar het scherm en de publicatielogica hebben een
-- stabiele volgorde nodig, en die hoort op één plek te staan.
create or replace function public.company_size_rank(p_class text)
returns integer
language sql
immutable
set search_path = public
as $$
  select case p_class
    when 'micro'       then 1
    when 'klein'       then 2
    when 'middelgroot' then 3
    when 'groot'       then 4
    else null
  end;
$$;

comment on function public.company_size_rank(text) is
  'Zwaarte van een grootteklasse (micro 1 t/m groot 4), voor sortering en vergelijking op het scherm. Niet de tweejaarstoets: die is sticky en neemt bewust niet de zwaarste van twee jaren.';

revoke all on function public.company_size_rank(text) from public, anon;
grant execute on function public.company_size_rank(text) to authenticated, service_role;

-- ------------------------------------------------------------
-- 5. determine_company_size — de tweejaarstoets over een echte boekjarenreeks
--
--    Bronnen per criterium (per boekjaar in de keten):
--      * Balanstotaal — som van de activa uit report_balance_sheet op de
--        balansdatum, tenzij de gebruiker het heeft overschreven. Dat is
--        BOEKWAARDE; de wet gaat uit van verkrijgings- of vervaardigingsprijs
--        (art. 2:395a/396 lid 1 onder a). Wie op actuele waarde waardeert, moet
--        overschrijven — vandaar een vaste waarschuwing in de uitkomst.
--      * Netto-omzet — som van de rubriek 'netto_omzet' uit
--        report_profit_and_loss over het boekjaar, tenzij overschreven. De
--        rubriek is een presentatiekolom die de gebruiker vrij mag zetten;
--        daarom staat er in de uitkomst bij welke bron is gebruikt.
--      * Gemiddeld aantal werknemers — uitsluitend uit fiscal_year_size_inputs.
--
--    De klasse wordt PLAKKEREND doorgedragen (kernbeslissing D) over álle
--    boekjaren van de administratie t/m het gevraagde jaar. Elk boekjaar gaat
--    door de drempelreeks van zijn eigen aanvangsjaar; alleen het paar dat de
--    wissel bepaalt wordt aan één en dezelfde reeks getoetst (kernbeslissing E).
--    Breekt de keten — een ontbrekend werknemersaantal, een gat in de reeks of
--    een onbekend startpunt — dan volgt een blokkerende reden en géén klasse
--    (kernbeslissing F); opening_size_class is daarvoor de uitweg.
--
--    Uitkomst is jsonb en niet een tabel: het scherm, de PDF en
--    prepare_annual_accounts (brok B) hebben alle drie een ander stuk nodig, en
--    de hele redenering moet bevroren kunnen worden in annual_accounts.size_basis.
--    Sleutels die daarbij horen:
--      rawClass           — de rauwe toets van dít boekjaar, zonder tweejaarsregel
--      currentClass       — de EFFECTIEVE klasse van dit boekjaar (= sizeClass)
--      previousClass      — de effectieve klasse van het voorgaande boekjaar
--      previousRawClass   — de rauwe toets van het voorgaande boekjaar
--      carriedForwardFrom — gevuld als de klasse is doorgedragen omdat de rauwe
--                           klasse zich (nog) niet herhaalde; dan legt het
--                           scherm uit waarom de klasse niet meebeweegt
--      chain              — per boekjaar rauw én effectief, de audittrail
-- ------------------------------------------------------------
create or replace function public.determine_company_size(
  p_organization_id uuid,
  p_fiscal_year_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_fy public.fiscal_years;
  v_in public.fiscal_year_size_inputs;
  v_has_in boolean := false;
  v_row public.fiscal_year_size_inputs;
  r record;

  v_year integer;
  v_lookup_year integer;

  v_index integer := 0;
  v_chain_broken boolean := false;
  v_first_confirmed boolean := false;

  -- Het boekjaar dat op dít moment in de lus wordt behandeld; na de lus is dat
  -- per definitie het gevraagde boekjaar.
  v_cur_fy_id uuid;
  v_cur_label text;
  v_cur_year integer;
  v_cur_start date;
  v_cur_end date;
  v_cur_days integer;
  v_cur_assets bigint;
  v_cur_turnover bigint;
  v_cur_employees numeric;
  v_cur_src_assets text;
  v_cur_src_turnover text;
  v_cur_src_employees text;
  v_cur_has_in boolean := false;
  v_cur_early boolean := false;
  v_cur_override_reason text;
  v_cur_eval jsonb;
  v_cur_raw text;
  v_cur_class text;
  v_cur_carried jsonb := null;
  -- De drempelreeks die BIJ DIT BOEKJAAR hoort (aanvangsjaar, met early-adopt).
  v_cur_lookup_year integer;
  -- De rauwe klasse van het VORIGE boekjaar, opnieuw getoetst aan de reeks van
  -- dit boekjaar. De tweejaarstoets van lid 1 kent geen gemengde maatstaf.
  v_prev_raw_at_cur text;
  -- Sluit dit boekjaar aan op het vorige? Zit er een gat, dan zijn het geen
  -- "twee opeenvolgende balansdata" en begint de keten opnieuw.
  v_cur_gap boolean := false;
  -- Door de gebruiker vastgelegde klasse op de balansdatum vóór dit boekjaar.
  v_cur_opening text;

  -- Het boekjaar dat er direct aan voorafging (doorgeschoven aan het begin van
  -- elke ronde); na de lus het vergelijkende boekjaar.
  v_prev_fy_id uuid;
  v_prev_label text;
  v_prev_year integer;
  v_prev_end date;
  v_prev_days integer;
  v_prev_assets bigint;
  v_prev_turnover bigint;
  v_prev_employees numeric;
  v_prev_src_assets text;
  v_prev_src_turnover text;
  v_prev_src_employees text;
  v_prev_eval jsonb;
  v_prev_raw text;
  v_prev_class text;
  v_prev_early boolean := false;

  -- Het boekjaar waarin de uiteindelijke klasse is ontstaan (dus waar de rauwe
  -- klasse zich voor het tweede jaar herhaalde, of de keten begon). Daar hoort
  -- de drempelrij bij die de uitkomst verantwoordt.
  v_source_eval jsonb := null;
  v_source_year integer := null;
  v_source_label text := null;

  v_chain jsonb := '[]'::jsonb;
  v_tested_years jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_blocking text := null;
  v_thresholds jsonb := null;
  v_in_group boolean := false;
  v_has_prev boolean := false;
  v_first_year boolean := false;
  v_prev_unknown boolean := false;
  v_class text := null;
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  if not public.org_has_business(p_organization_id) then
    raise exception 'De groottebepaling hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;
  if public.org_fiscal_regime(p_organization_id) <> 'vpb' then
    raise exception 'De groottecriteria van art. 2:395a, 2:396 en 2:397 BW gelden voor een BV, NV of coöperatie. Pas eerst de rechtsvorm aan bij Instellingen → Bedrijfsgegevens.'
      using errcode = '23514';
  end if;

  select * into v_fy from public.fiscal_years fy
  where fy.id = p_fiscal_year_id and fy.organization_id = p_organization_id;
  if not found then
    raise exception 'Boekjaar niet gevonden.' using errcode = '02000';
  end if;

  select * into v_in from public.fiscal_year_size_inputs si
  where si.organization_id = p_organization_id and si.fiscal_year_id = v_fy.id;
  v_has_in := found;

  -- De drempelreeks knoopt aan bij de AANVANG van het boekjaar (art. III lid 2
  -- Stb. 2015, 349 en art. 4 Stb. 2024, 52), niet bij de balansdatum. Dit is de
  -- reeks van het GEVRAAGDE boekjaar; elk boekjaar in de keten bepaalt verderop
  -- zijn eigen reeks, en alleen het paar dat de wissel bepaalt gaat door één en
  -- dezelfde reeks — zie kernbeslissing E in de kop. Deze waarde dient hier dus
  -- alleen nog voor de verantwoording in de uitkomst.
  v_year := extract(year from v_fy.period_start)::int;
  v_lookup_year := case
    when coalesce(v_has_in and v_in.early_adopt_new_thresholds, false) and v_year = 2023 then 2024
    else v_year
  end;

  -- Maakt deze administratie deel uit van een groep? Dan geldt de meetelregel
  -- van art. 2:395a lid 2 / 2:396 lid 2 / 2:397 lid 2 BW en telt ResoFly de
  -- boom niet op — dat mag geen generieke voetnoot blijven.
  select (o.parent_organization_id is not null)
         or exists (select 1 from public.organizations c where c.parent_organization_id = o.id)
    into v_in_group
  from public.organizations o
  where o.id = p_organization_id;
  v_in_group := coalesce(v_in_group, false);

  -- ── De keten ────────────────────────────────────────────────────────────
  -- Chronologisch over alle boekjaren t/m het gevraagde jaar. De sticky regel
  -- heeft de EFFECTIEVE klasse van het vorige jaar nodig, en die heeft op haar
  -- beurt het jaar daarvóór nodig; er is geen kortere weg. Per boekjaar kost dat
  -- één doorloop van report_balance_sheet en één van report_profit_and_loss,
  -- tenzij de gebruiker beide heeft overschreven.
  -- Begrensd op twaalf boekjaren terug. Verder terug voegt niets toe — de
  -- klasse van 2011 zegt niets meer over vandaag — en het scheelt evenveel
  -- rapportdoorlopen. Valt het startpunt van de keten daardoor buiten beeld, dan
  -- vraagt de functie om een opening_size_class; ze gokt niet.
  for r in
    select fy.*
    from public.fiscal_years fy
    where fy.organization_id = p_organization_id
      and fy.period_start <= v_fy.period_start
      and fy.period_end <= v_fy.period_end
      and fy.period_start > (v_fy.period_start - interval '12 years')
    order by fy.period_start asc, fy.period_end asc
  loop
    v_index := v_index + 1;

    -- Schuif het vorige jaar door voordat we de huidige velden overschrijven.
    if v_index > 1 then
      v_prev_fy_id        := v_cur_fy_id;
      v_prev_label        := v_cur_label;
      v_prev_year         := v_cur_year;
      v_prev_end          := v_cur_end;
      v_prev_days         := v_cur_days;
      v_prev_assets       := v_cur_assets;
      v_prev_turnover     := v_cur_turnover;
      v_prev_employees    := v_cur_employees;
      v_prev_src_assets   := v_cur_src_assets;
      v_prev_src_turnover := v_cur_src_turnover;
      v_prev_src_employees:= v_cur_src_employees;
      v_prev_eval         := v_cur_eval;
      v_prev_raw          := v_cur_raw;
      v_prev_class        := v_cur_class;
      v_prev_early        := v_cur_early;
    end if;

    select * into v_row from public.fiscal_year_size_inputs si
    where si.organization_id = p_organization_id and si.fiscal_year_id = r.id;
    v_cur_has_in := found;

    v_cur_fy_id          := r.id;
    v_cur_label          := r.label;
    v_cur_year           := extract(year from r.period_start)::int;
    v_cur_start          := r.period_start;
    v_cur_end            := r.period_end;
    v_cur_days           := (r.period_end - r.period_start) + 1;
    v_cur_early          := coalesce(v_cur_has_in and v_row.early_adopt_new_thresholds, false);
    v_cur_override_reason:= case when v_cur_has_in then v_row.override_reason else null end;
    v_cur_employees      := case when v_cur_has_in then v_row.average_employees else null end;
    v_cur_src_employees  := case when v_cur_has_in then 'input' else null end;
    v_cur_opening        := case when v_cur_has_in then v_row.opening_size_class else null end;
    v_cur_carried        := null;

    if v_cur_has_in and v_row.total_assets_cents is not null then
      v_cur_assets := v_row.total_assets_cents;
      v_cur_src_assets := 'override';
    else
      select coalesce(sum(rb.amount_cents), 0)::bigint into v_cur_assets
      from public.report_balance_sheet(p_organization_id, r.period_end) rb
      where rb.section = 'asset';
      v_cur_src_assets := 'derived';
    end if;

    if v_cur_has_in and v_row.net_turnover_cents is not null then
      v_cur_turnover := v_row.net_turnover_cents;
      v_cur_src_turnover := 'override';
    else
      select coalesce(sum(pl.amount_cents), 0)::bigint into v_cur_turnover
      from public.report_profit_and_loss(p_organization_id, r.period_start, r.period_end) pl
      where pl.report_group = 'netto_omzet';
      v_cur_src_turnover := 'derived';

      -- Nul afgeleide omzet terwijl er wél opbrengst is geboekt betekent bijna
      -- altijd dat de omzetrekeningen niet in de rubriek netto_omzet staan. Stil
      -- nul teruggeven zou het omzetcriterium gratis laten slagen en de klasse
      -- te licht maken; daarom hier een expliciet signaal.
      if v_cur_turnover = 0 and r.id = v_fy.id then
        if exists (
          select 1 from public.report_profit_and_loss(p_organization_id, r.period_start, r.period_end) pl2
          where pl2.account_type = 'revenue' and pl2.amount_cents <> 0
        ) then
          v_warnings := v_warnings || to_jsonb(array[
            'Er is wél omzet geboekt, maar geen enkele rekening valt in de rubriek "netto_omzet"; het omzetcriterium van art. 2:395a/396/397 lid 1 onder b BW is daardoor op nul uitgekomen. Controleer de rubriekindeling van het rekeningschema, of leg de netto-omzet handmatig vast bij de groottegegevens van dit boekjaar.']);
        end if;
      end if;
    end if;

    if v_index = 1 then
      v_first_confirmed := coalesce(v_cur_has_in and v_row.is_first_fiscal_year_of_entity, false);
    end if;

    -- ── De drempelreeks van DIT boekjaar ──────────────────────────────────
    -- Elk boekjaar wordt getoetst aan de reeks die vóór dat boekjaar geldt; de
    -- reeks knoopt aan bij de AANVANG van het boekjaar (art. III lid 2 Stb.
    -- 2015, 349 en art. 4 Stb. 2024, 52). Boekjaar 2018 gaat dus niet door de
    -- bedragen van 2026 — een eerdere ronde legde de reeks van het gevraagde
    -- jaar over de hele historie en dat is onjuist.
    --
    -- Voor het PAAR dat de klassewissel bepaalt gaan beide balansdata wél door
    -- dezelfde reeks, namelijk die van het jongste jaar van het paar: de
    -- tweejaarstoets van lid 1 kent geen gemengde maatstaf. Daarom wordt het
    -- vorige boekjaar hier een tweede keer getoetst, nu onder de reeks van dit
    -- jaar. Dat kost géén extra rapportaanroep — de bedragen van vorig jaar
    -- staan al in de variabelen; alleen de drempelvergelijking wordt herhaald.
    v_cur_lookup_year := case
      when v_cur_early and v_cur_year = 2023 then 2024
      else v_cur_year
    end;

    v_cur_eval := public.company_size_evaluate_year(
      v_cur_lookup_year, v_cur_assets, v_cur_turnover, v_cur_employees, false
    );
    v_cur_raw := nullif(v_cur_eval ->> 'class', '');

    if v_index > 1 then
      v_prev_raw_at_cur := nullif(public.company_size_evaluate_year(
        v_cur_lookup_year, v_prev_assets, v_prev_turnover, v_prev_employees, false
      ) ->> 'class', '');
    else
      v_prev_raw_at_cur := null;
    end if;

    -- Sluiten de boekjaren op elkaar aan? open_fiscal_year verbiedt overlap maar
    -- niet een gat; zonder deze controle zouden balansdata die jaren uit elkaar
    -- liggen als "opeenvolgend" gelden.
    v_cur_gap := v_index > 1 and v_cur_start <> (v_prev_end + 1);

    -- ── De sticky tweejaarsregel ──────────────────────────────────────────
    if v_chain_broken then
      v_cur_class := null;

    elsif v_cur_raw is null then
      v_chain_broken := true;
      v_cur_class := null;
      if v_blocking is null then
        if coalesce((v_cur_eval ->> 'inputsMissing')::boolean, false) then
          v_blocking := format(
            'Voor boekjaar %s ontbreekt het gemiddeld aantal werknemers (art. 2:396 lid 1 onder c BW; te vermelden op grond van art. 2:382 BW). De toets van art. 2:395a/396/397 lid 1 BW loopt over twee opeenvolgende balansdata en draagt de klasse door; zonder dat getal breekt die keten en is de grootteklasse niet te bepalen. Vul het aan bij dat boekjaar, of leg de klasse handmatig vast met een onderbouwing.',
            coalesce(v_cur_label, v_cur_year::text));
        else
          v_blocking := format(
            'Voor boekjaren die aanvangen in %s zijn geen groottedrempels vastgelegd. De reeksen in ResoFly beginnen bij boekjaar 2016; oudere boekjaren zijn niet geverifieerd en worden bewust niet geraden. Dit raakt boekjaar %s in de keten.',
            v_cur_lookup_year, coalesce(v_cur_label, v_cur_year::text));
        end if;
      end if;

    elsif v_index = 1 or v_cur_gap then
      -- Startpunt van de keten: het oudste boekjaar, of het eerste boekjaar ná
      -- een gat. Een klasse die op één balansdatum rust is alleen verdedigbaar
      -- als dit óók het eerste boekjaar van de rechtspersoon is, of als de
      -- gebruiker zelf heeft vastgelegd welke klasse op de vórige balansdatum
      -- gold. Anders zou lid 1 op één meetpunt worden toegepast.
      if v_cur_gap then
        v_warnings := v_warnings || to_jsonb(array[format(
          'Boekjaar %s sluit niet aan op het voorgaande boekjaar (dat eindigde op %s). De toets van art. 2:395a/396/397 lid 1 BW gaat over twee OPEENVOLGENDE balansdata; door het gat begint de keten hier opnieuw.',
          coalesce(v_cur_label, v_cur_year::text), to_char(v_prev_end, 'DD-MM-YYYY'))]);
      end if;

      if v_cur_opening is not null then
        -- De vastgelegde openingsklasse geldt als de klasse op de balansdatum
        -- vóór dit boekjaar; de plakkerige regel draait daar meteen op door.
        if v_cur_raw = v_cur_opening then
          v_cur_class   := v_cur_raw;
          v_source_eval := v_cur_eval;
          v_source_year := v_cur_year;
          v_source_label:= v_cur_label;
        else
          v_cur_class   := v_cur_opening;
          v_cur_carried := jsonb_build_object(
            'source', 'opening_size_class',
            'class', v_cur_opening,
            'fiscalYearId', v_cur_fy_id,
            'fiscalYearLabel', v_cur_label
          );
        end if;

      elsif v_index = 1 and v_first_confirmed then
        v_cur_class   := v_cur_raw;
        v_source_eval := v_cur_eval;
        v_source_year := v_cur_year;
        v_source_label:= v_cur_label;

      else
        v_chain_broken := true;
        v_cur_class := null;
        if v_blocking is null then
          v_blocking := format(
            'De keten van de groottetoets begint bij boekjaar %s, maar daarvóór is niets bekend. De regimes van art. 2:395a lid 1 / 2:396 lid 1 / 2:397 lid 1 BW gelden pas als op TWEE opeenvolgende balansdata aan de vereisten is voldaan. Kies één van drie: bevestig bij dat boekjaar dat het het eerste boekjaar van de rechtspersoon is, leg vast welke grootteklasse op de vorige balansdatum gold, of voer het voorgaande boekjaar alsnog in.',
            coalesce(v_cur_label, v_cur_year::text));
        end if;
      end if;

    -- ── De plakkerige tweejaarsregel ──────────────────────────────────────
    -- De klasse blijft staan tot de rechtspersoon er TWEE OPEENVOLGENDE
    -- balansdata niet meer in valt; dan springt hij naar de rauwe klasse van
    -- dit boekjaar. Symmetrisch, dus even goed bij groeien als bij krimpen
    -- (art. 2:395a/396/397 lid 1 BW; richtlijn 2013/34/EU art. 3 lid 10).
    --
    -- LET OP — dit is bewust NIET de regel "rauw(k) = rauw(k-1)". Die stond
    -- hier eerder en is fout: bij rauw klein, klein, middelgroot, groot houdt
    -- zij de klasse op klein, terwijl de BV dan al twee opeenvolgende
    -- balansdata boven de kleingrens zit.
    --
    -- Verplichte testvectoren (rauw per boekjaar → effectieve klasse):
    --   1. klein, klein, middelgroot, groot        → klein, klein, klein, GROOT
    --   2. middelgroot, klein, klein               → mg, mg, KLEIN
    --   3. klein, middelgroot, klein               → klein, klein, klein
    --   4. middelgroot (enig boekjaar)             → middelgroot
    --   5. klein, mg, mg, klein, klein             → klein, klein, MG, mg, KLEIN
    --   6. groot, groot, klein, middelgroot        → groot, groot, groot, MIDDELGROOT
    elsif v_cur_raw <> v_prev_class
          and v_prev_raw_at_cur is not null
          and v_prev_raw_at_cur <> v_prev_class then
      v_cur_class   := v_cur_raw;
      v_source_eval := v_cur_eval;
      v_source_year := v_cur_year;
      v_source_label:= v_cur_label;

    else
      -- Hooguit één van de twee balansdata valt buiten de geldende klasse: die
      -- beweegt dus niet mee. De effectieve klasse van vorig jaar blijft staan,
      -- en daarmee ook de drempelrij waarop die klasse berust.
      v_cur_class := v_prev_class;
      v_cur_carried := jsonb_build_object(
        'fiscalYearId', v_prev_fy_id,
        'fiscalYearLabel', v_prev_label,
        'year', v_prev_year,
        'class', v_prev_class,
        'rawClass', v_prev_raw,
        'rawClassAtCurrentThresholds', v_prev_raw_at_cur
      );
    end if;

    -- ── Boekjaarlengte ────────────────────────────────────────────────────
    -- Niet normaliseren (kernbeslissing H), wel benoemen. Een echt boekjaar van
    -- twaalf maanden telt 365 of 366 dagen; alles daarbuiten is materieel anders.
    -- Alleen melden voor de twee boekjaren die de klasse bepalen. Een afwijkende
    -- lengte in 2019 zegt niets meer over de jaarrekening die nu wordt opgemaakt
    -- en zou de waarschuwingenlijst vullen met ruis.
    if (v_cur_days < 355 or v_cur_days > 376) and v_cur_fy_id = v_fy.id then
      v_warnings := v_warnings || to_jsonb(array[format(
        'Boekjaar %s telt %s dagen en wijkt daarmee materieel af van twaalf maanden. De omzetgrens van art. 2:395a/396/397 lid 1 onder b BW is een JAARgrens; de netto-omzet over dit boekjaar is hier ongecorrigeerd tegen die jaargrens gelegd. Een kort boekjaar valt daardoor te licht uit, een lang boekjaar te zwaar. ResoFly rekent bewust niet zelf om — de herrekeningsregel is niet geverifieerd. Corrigeer zo nodig met de hand via het balanstotaal en de netto-omzet bij de groottegegevens van dat boekjaar, en leg de reden vast.',
        coalesce(v_cur_label, v_cur_year::text), v_cur_days)]);
    end if;

    v_chain := v_chain || jsonb_build_array(jsonb_build_object(
      'fiscalYearId', v_cur_fy_id,
      'fiscalYearLabel', v_cur_label,
      'year', v_cur_year,
      'periodStart', v_cur_start,
      'periodEnd', v_cur_end,
      'days', v_cur_days,
      'assetsCents', v_cur_assets,
      'turnoverCents', v_cur_turnover,
      'employees', v_cur_employees,
      'assetsSource', v_cur_src_assets,
      'turnoverSource', v_cur_src_turnover,
      'employeesSource', v_cur_src_employees,
      'rawClass', v_cur_raw,
      'effectiveClass', v_cur_class,
      'thresholdLookupYear', v_cur_lookup_year,
      'previousRawAtTheseThresholds', v_prev_raw_at_cur,
      'followsPreviousFiscalYear', not v_cur_gap,
      'carriedForwardFrom', v_cur_carried
    ));
    v_tested_years := v_tested_years || jsonb_build_array(to_jsonb(v_cur_year));
  end loop;

  v_has_prev   := v_index > 1;
  v_first_year := not v_has_prev;
  v_prev_unknown := v_has_prev and v_prev_class is null;
  v_class := v_cur_class;

  -- Het vergelijkingsjaar telt even zwaar mee in de tweejaarstoets, dus een
  -- afwijkende lengte dáár is net zo goed een reden tot voorzichtigheid.
  if v_has_prev and v_prev_days is not null and (v_prev_days < 355 or v_prev_days > 376) then
    v_warnings := v_warnings || to_jsonb(array[format(
      'Het vergelijkende boekjaar %s telt %s dagen en wijkt daarmee materieel af van twaalf maanden. De omzetgrens van art. 2:395a/396/397 lid 1 onder b BW is een jaargrens; de netto-omzet van dat jaar is hier ongecorrigeerd getoetst en weegt wél mee in de tweejaarstoets. Corrigeer zo nodig met de hand bij de groottegegevens van dat boekjaar.',
      coalesce(v_prev_label, v_prev_year::text), v_prev_days)]);
  end if;

  -- Vangnet: een klasse die om een niet voorziene reden leeg bleef mag nooit
  -- stilzwijgend als "geen bijzonderheden" doorgaan.
  if v_class is null and v_blocking is null then
    v_blocking := 'De grootteklasse kon niet worden bepaald. Controleer de groottegegevens van dit en de voorgaande boekjaren, of leg de klasse handmatig vast met een onderbouwing.';
  end if;
  if v_blocking is not null then
    v_class := null;
  end if;

  -- ── Vaste waarschuwingen; deze uitkomst is een hulpmiddel ───────────────
  v_warnings := v_warnings || to_jsonb(array[
    'De grootteklasse is per administratie bepaald. De cijfers van groepsmaatschappijen die in een consolidatie zouden moeten worden betrokken tellen mee op grond van art. 2:395a lid 2 / 2:396 lid 2 / 2:397 lid 2 BW, tenzij de rechtspersoon art. 2:408 BW toepast; ResoFly telt de administratie-boom niet op.',
    'Het balanstotaal is afgeleid uit het grootboek en dus op boekwaarde; art. 2:395a/396 lid 1 onder a gaat uit van de verkrijgings- of vervaardigingsprijs. Waardeer je op actuele waarde, corrigeer het balanstotaal dan met de hand.'
  ]);

  if v_in_group then
    v_warnings := v_warnings || to_jsonb(array[
      'Deze administratie maakt deel uit van een groep (er is een moeder- of een dochter-administratie gekoppeld). De waarde van de activa, de netto-omzet en het aantal werknemers van groepsmaatschappijen die in de consolidatie zouden moeten worden betrokken, moeten worden meegeteld (art. 2:395a lid 2 / 2:396 lid 2 / 2:397 lid 2 BW), tenzij de rechtspersoon art. 2:408 BW toepast. ResoFly telt die cijfers NIET op: twee entiteiten die apart onder de kleingrens blijven en samen erboven, komen hier ten onrechte als klein uit. Tel de groepscijfers met de hand op via het balanstotaal en de netto-omzet, of leg de klasse handmatig vast. Zolang dat niet is gebeurd, doet ResoFly bewust geen uitspraak over de controleplicht van art. 2:393 lid 1 BW.'
    ]);
  end if;

  if v_cur_src_turnover = 'derived' then
    v_warnings := v_warnings || to_jsonb(array[
      'De netto-omzet is de som van de rekeningen met rubriek "Netto-omzet". Die rubriek mag je zelf per rekening aanpassen; controleer of de indeling klopt voordat je de klasse vastlegt.'
    ]);
  end if;
  if (v_cur_src_assets = 'override' or v_cur_src_turnover = 'override')
     and nullif(btrim(coalesce(v_cur_override_reason, '')), '') is null then
    v_warnings := v_warnings || to_jsonb(array[
      'Balanstotaal of netto-omzet is met de hand overschreven zonder toelichting. Leg de reden vast; bij een controle moet navolgbaar zijn waarop de klasse berust.'
    ]);
  end if;

  -- De vlag hangt aan de opgeslagen rij, het effect aan het aanvangsjaar. Wordt
  -- period_start later verplaatst (of zet de service-role de rij rechtstreeks),
  -- dan doet de vlag niets meer — dan mag de onderbouwing niet blijven beweren
  -- dat de verhoogde bedragen zijn toegepast.
  if coalesce(v_has_in and v_in.early_adopt_new_thresholds, false) then
    if v_year = 2023 then
      v_warnings := v_warnings || to_jsonb(array[format(
        'Voor dit boekjaar (aanvang %s) zijn de verhoogde grensbedragen van Stb. 2024, 52 vervroegd toegepast (art. 4). Dat mag, maar het is een keuze: zonder die keuze gelden de bedragen uit Stb. 2015, 349. De gekozen reeks is op alle getoetste balansdata toegepast.',
        v_year)]);
    else
      v_warnings := v_warnings || to_jsonb(array[format(
        'Bij dit boekjaar staat de keuze aan om de verhoogde grensbedragen van Stb. 2024, 52 vervroegd toe te passen, maar het boekjaar vangt aan in %s. Art. 4 van dat besluit staat dat alleen toe voor boekjaren die aanvangen in 2023, dus de keuze doet hier niets. Zet hem uit, of controleer de aanvangsdatum van het boekjaar.',
        v_year)]);
    end if;
  end if;

  if v_first_year and v_class is not null then
    v_warnings := v_warnings || to_jsonb(array[
      'Dit is het eerste boekjaar van de rechtspersoon, zoals bij de groottegegevens is bevestigd. Er is dus maar één balansdatum om aan te toetsen; de klasse rust op dat ene jaar en beweegt vanaf volgend jaar pas mee volgens de tweejaarsregel van art. 2:395a lid 1 / 2:396 lid 1 / 2:397 lid 1 BW.'
    ]);
  end if;

  if v_cur_carried is not null and v_class is not null then
    v_warnings := v_warnings || to_jsonb(array[format(
      'De rauwe toets van dit boekjaar komt uit op "%s", maar de klasse blijft "%s". Dat is de regel van art. 2:395a lid 1 / 2:396 lid 1 / 2:397 lid 1 BW: een over- of onderschrijding telt pas als zij zich op twee opeenvolgende balansdata voordoet. Herhaalt de rauwe uitkomst zich volgend boekjaar, dan wisselt de klasse alsnog.',
      v_cur_raw, v_class)]);
  end if;

  -- ── Welke drempelrij verantwoordt de uiteindelijke klasse ───────────────
  -- Uit de evaluatie van het boekjaar waarin die klasse is ontstaan, niet uit
  -- een tweede lookup: anders toont de onderbouwing een andere rij dan waarop de
  -- klasse berust. Elk boekjaar in de keten is aan de reeks van ZIJN EIGEN
  -- aanvangsjaar getoetst; alleen het paar dat de wissel bepaalt ging door één
  -- en dezelfde reeks (kernbeslissing E). De hier getoonde rij is dus die van
  -- het boekjaar waarin de klasse ontstond, en `chain` laat per jaar zien welke
  -- reeks daar is gebruikt.
  if v_class is not null and v_source_eval is not null
     and v_source_eval -> 'thresholdsUsed' is not null
     and jsonb_typeof(v_source_eval -> 'thresholdsUsed') = 'object' then
    v_thresholds := (v_source_eval -> 'thresholdsUsed') || jsonb_build_object(
      'requestedYearLookupYear', v_lookup_year,
      'testedFiscalYears', v_tested_years,
      'basedOnYear', v_source_year,
      'basedOnFiscalYearLabel', v_source_label
    );
  end if;

  return jsonb_build_object(
    'fiscalYearId', v_fy.id,
    'fiscalYearLabel', v_fy.label,
    'year', v_year,
    'periodStart', v_fy.period_start,
    'periodEnd', v_fy.period_end,
    'periodDays', v_cur_days,
    'current', jsonb_build_object(
      'assetsCents', v_cur_assets,
      'turnoverCents', v_cur_turnover,
      'employees', v_cur_employees,
      'assetsSource', v_cur_src_assets,
      'turnoverSource', v_cur_src_turnover,
      'employeesSource', v_cur_src_employees,
      'days', v_cur_days,
      'earlyAdoptNewThresholds', coalesce(v_has_in and v_in.early_adopt_new_thresholds, false)
    ),
    'previous', case when v_has_prev then jsonb_build_object(
      'fiscalYearId', v_prev_fy_id,
      'fiscalYearLabel', v_prev_label,
      'year', v_prev_year,
      'periodEnd', v_prev_end,
      'days', v_prev_days,
      'assetsCents', v_prev_assets,
      'turnoverCents', v_prev_turnover,
      'employees', v_prev_employees,
      'assetsSource', v_prev_src_assets,
      'turnoverSource', v_prev_src_turnover,
      'employeesSource', v_prev_src_employees,
      'earlyAdoptNewThresholds', v_prev_early
    ) end,
    -- rawClass = zonder tweejaarsregel; currentClass = mét, en dus gelijk aan
    -- sizeClass. Staan er allebei in zodat het scherm het verschil kan uitleggen.
    'rawClass', v_cur_raw,
    'currentClass', v_class,
    'previousClass', v_prev_class,
    'previousRawClass', v_prev_raw,
    'carriedForwardFrom', v_cur_carried,
    'sizeClass', v_class,
    'criteriaMet', coalesce(v_cur_eval -> 'criteriaMet', '{}'::jsonb),
    'previousCriteriaMet', case when v_prev_eval is not null then v_prev_eval -> 'criteriaMet' end,
    'thresholdsUsed', v_thresholds,
    'thresholdsLookupYear', v_lookup_year,
    'chain', v_chain,
    'firstYear', v_first_year,
    'firstFiscalYearConfirmed', v_first_confirmed,
    'previousUnknown', v_prev_unknown,
    'inGroup', v_in_group,
    'publicationSet', v_class,
    -- Art. 2:393 lid 1 BW: controleplicht. De vrijstelling van art. 2:396 lid 7
    -- geldt alleen voor klein (en daarmee ook voor micro); middelgroot en groot
    -- moeten de jaarrekening laten controleren. Null = ResoFly doet er bewust
    -- geen uitspraak over: geen klasse, of een groepsstructuur waarvan de
    -- cijfers niet zijn opgeteld.
    'auditRequired', case
      when v_class is null or v_in_group then null
      else v_class in ('middelgroot','groot')
    end,
    'blockingReason', v_blocking,
    'warnings', v_warnings
  );
end;
$$;

comment on function public.determine_company_size(uuid, uuid) is
  'Bepaalt de grootteklasse van een boekjaar volgens art. 2:395a, 2:396 en 2:397 BW: drie criteria, minstens twee ervan, en een PLAKKERIGE tweejaarstoets — de klasse blijft staan tot de rechtspersoon er twee opeenvolgende balansdata niet meer in valt en springt dan naar de rauwe klasse van dat jaar, chronologisch doorgedragen over alle boekjaren van de administratie. Elk boekjaar wordt getoetst aan de drempelreeks van zijn eigen aanvangsjaar; alleen het paar dat de wissel bepaalt gaat door één en dezelfde reeks. Geeft de volledige onderbouwing terug (rauwe en effectieve klasse per jaar, gebruikte drempelrij, waarschuwingen) en een blokkerende reden zodra de keten niet draagt.';

revoke all on function public.determine_company_size(uuid, uuid) from public, anon;
grant execute on function public.determine_company_size(uuid, uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 6. result_appropriation_delta — wat de resultaatbestemming met de balans doet
--
--    appropriate_result boekt op een datum ná de balansdatum, dus die boeking
--    zit NIET in de balans per period_end. Voor de jaarrekening moet zij er wél
--    in: die toont de balans ná resultaatbestemming. Deze functie levert per
--    rekening het bedrag dat erbij moet.
--
--    UIT DE BOEKING, NIET UIT DE CODES. result_appropriations bewaart
--    reserves_account_code en dividend_account_code, en fiscal_years bewaart
--    result_account_code — maar ledger_accounts.code is via RLS gewoon te
--    wijzigen, ook ná een geboekte bestemming. Een verdwenen code laat een regel
--    uit de optelling vallen (luide, maar misleidende sluitfout), en een
--    HERGEBRUIKTE code laat de reservetoevoeging STIL op een andere
--    eigen-vermogensrekening landen — waarbij de som over de passiva nul blijft
--    en de sluitcontrole dus niet afgaat. Daarom is journal_lines van
--    result_appropriations.journal_entry_id de bron.
--
--    TEKENS. report_balance_sheet rekent activa als debet−credit en passiva
--    (schulden én eigen vermogen) als credit−debet. Dezelfde omzetting staat
--    hieronder, zodat de mutatie per definitie in dezelfde tekenconventie staat
--    als de balans waarop zij wordt gelegd. Omdat een geboekte journaalpost in
--    balans is (post_journal_entry laat niets anders toe), telt de mutatie over
--    alle rekeningen naar nul en blijft de balans sluiten — bij winst én verlies,
--    zonder apart geval.
--
--    TERUGVAL. Alleen als journal_entry_id leeg is (een bestemming zonder
--    boekstuk) wordt de mutatie alsnog uit de codes herleid. Die weg is
--    behouden omdat er anders helemaal geen mutatie zou zijn, maar hij is niet
--    bestand tegen hernoemde rekeningen.
-- ------------------------------------------------------------
create or replace function public.result_appropriation_delta(
  p_organization_id uuid,
  p_fiscal_year_id uuid
)
returns table(
  account_id uuid,
  delta_cents bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_fy public.fiscal_years;
  v_ra public.result_appropriations;
  v_result_code text;
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  -- Entitlement: de jaarrekeningrapportage hoort bij de betaalde zakelijke
  -- module, net als determine_company_size en save_fiscal_year_size_inputs.
  -- Bewust GEEN org_fiscal_regime-check: vergelijkende cijfers en een balans ná
  -- resultaatbestemming zijn niet BV-specifiek, en de rechtsvorm-gate zit al op
  -- de groottebepaling en (in brok B) op prepare_annual_accounts.
  if not public.org_has_business(p_organization_id) then
    raise exception 'De jaarrekeningrapportage hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;

  -- Een null-boekjaar levert géén fout maar nul rijen. Dat is bewust: de
  -- vergelijkende kolom van report_balance_sheet_after_appropriation roept deze
  -- functie ook aan als er geen voorgaand boekjaar is, en een set-returning
  -- functie in een FROM-clausule wordt óók uitgevoerd als een WHERE hem later
  -- zou wegfilteren.
  if p_fiscal_year_id is null then
    return;
  end if;

  select * into v_fy from public.fiscal_years fy
  where fy.id = p_fiscal_year_id and fy.organization_id = p_organization_id;
  if not found then
    raise exception 'Boekjaar niet gevonden.' using errcode = '02000';
  end if;

  select * into v_ra from public.result_appropriations ra
  where ra.fiscal_year_id = p_fiscal_year_id
    and ra.organization_id = p_organization_id
    and ra.status = 'posted';
  -- Geen bestemming: geen mutatie. Bewust geen fout — een boekjaar mag nog
  -- onbestemd zijn; prepare_annual_accounts (brok B) weigert daar wél op.
  if not found then
    return;
  end if;

  if v_ra.journal_entry_id is not null then
    return query
    select jl.account_id,
           sum(case when la.type = 'asset'
                    then jl.debit_cents - jl.credit_cents
                    else jl.credit_cents - jl.debit_cents end)::bigint
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.entry_id = v_ra.journal_entry_id
      and jl.organization_id = p_organization_id
      and je.organization_id = p_organization_id
      and je.status = 'posted'
    -- la.type staat in de group by omdat PostgreSQL de functionele afhankelijk-
    -- heid met jl.account_id niet zelf afleidt (de primaire sleutel la.id staat
    -- er niet in). Per rekening is het type constant, dus dit splitst niets.
    group by jl.account_id, la.type
    having sum(case when la.type = 'asset'
                    then jl.debit_cents - jl.credit_cents
                    else jl.credit_cents - jl.debit_cents end) <> 0;
    return;
  end if;

  -- ── Terugval: een bestemming zonder boekstuk ────────────────────────────
  -- Dezelfde herleiding als in appropriate_result: het boekjaar heeft de
  -- gebruikte resultaatrekening zelf vastgelegd, zodat een latere wijziging van
  -- de instelling deze bestemming niet op een andere rekening laat aangrijpen.
  v_result_code := coalesce(
    v_fy.result_account_code,
    (select nullif(cs.year_result_account_code, '') from public.company_settings cs
      where cs.organization_id = p_organization_id),
    '0510'
  );

  return query
  select la.id, sum(m.delta)::bigint
  from (
    values
      (v_result_code,               -v_ra.result_cents),
      (v_ra.reserves_account_code,   v_ra.reserves_cents),
      (v_ra.dividend_account_code,   v_ra.dividend_cents)
  ) as m(acct_code, delta)
  join public.ledger_accounts la
    on la.organization_id = p_organization_id
   and la.code = m.acct_code
  where m.acct_code is not null
    and m.delta <> 0
  group by la.id;
end;
$$;

comment on function public.result_appropriation_delta(uuid, uuid) is
  'Mutatie per grootboekrekening die de vastgestelde resultaatbestemming van een boekjaar op de balans per balansdatum aanbrengt, afgeleid uit de journaalregels van het bestemmingsboekstuk (en alleen bij een ontbrekend boekstuk uit de vastgelegde grootboekcodes). Leeg als er geen geldige bestemming is.';

revoke all on function public.result_appropriation_delta(uuid, uuid) from public, anon;
grant execute on function public.result_appropriation_delta(uuid, uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 7. report_profit_and_loss_comparative
--    Winst- en verliesrekening met de vergelijkende cijfers van het voorgaande
--    boekjaar ernaast. De bestaande report_profit_and_loss blijft ONGEMOEID:
--    hem droppen om er kolommen aan toe te voegen kost de grants en breekt
--    ProfitLoss.tsx zonder dat daar iets aan verbetert.
--
--    FULL OUTER JOIN, geen left join. report_profit_and_loss laat rekeningen
--    met saldo nul weg (`having sum(...) <> 0`), dus een rekening die dit jaar
--    niets deed maar vorig jaar wél, zou met een left join uit de vergelijkende
--    kolom verdwijnen. Precies wat groupRows() in ProfitLoss.tsx client-side
--    doet, maar dan één keer en op de goede plek.
--
--    Subtotalen (Som der bedrijfsopbrengsten, Bedrijfsresultaat, Resultaat voor
--    belastingen) maakt deze functie bewust NIET: die volgen uit de rubrieken en
--    horen bij de renderer. "Bedrijfsresultaat" is bovendien praktijk/RJ en geen
--    wettelijke modelregel; dat label hoort niet uit de database te komen.
-- ------------------------------------------------------------
create or replace function public.report_profit_and_loss_comparative(
  p_organization_id uuid,
  p_fiscal_year_id uuid
)
returns table(
  account_id uuid,
  code text,
  name text,
  account_type text,
  report_group text,
  group_rank integer,
  amount_cents bigint,
  amount_prev_cents bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_fy public.fiscal_years;
  v_prev public.fiscal_years;
  v_prev_start date := null;
  v_prev_end date := null;
begin
  -- Ook de modulecontrole: een SECURITY DEFINER-RPC loopt langs RLS heen, dus de
  -- restrictieve policies op journal_lines en ledger_accounts doen hier niets.
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  -- Entitlement, zelfde afweging als bij result_appropriation_delta: wel
  -- org_has_business, bewust geen rechtsvorm-gate (vergelijkende cijfers zijn
  -- niet BV-specifiek).
  if not public.org_has_business(p_organization_id) then
    raise exception 'De jaarrekeningrapportage hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;

  select * into v_fy from public.fiscal_years fy
  where fy.id = p_fiscal_year_id and fy.organization_id = p_organization_id;
  if not found then
    raise exception 'Boekjaar niet gevonden.' using errcode = '02000';
  end if;

  select * into v_prev from public.fiscal_years fy
  where fy.organization_id = p_organization_id
    and fy.period_end < v_fy.period_start
  order by fy.period_end desc
  limit 1;
  if found then
    v_prev_start := v_prev.period_start;
    v_prev_end := v_prev.period_end;
  end if;

  -- Zonder voorgaand boekjaar blijven de datums null; `date between null and
  -- null` levert geen rijen op, dus de vergelijkende kolom staat dan overal op
  -- nul. Geen apart geval nodig.
  return query
  with cur as (
    select pl.account_id, pl.code, pl.name, pl.account_type,
           pl.report_group, pl.group_rank, pl.amount_cents
    from public.report_profit_and_loss(p_organization_id, v_fy.period_start, v_fy.period_end) pl
  ),
  prv as (
    select pl.account_id, pl.code, pl.name, pl.account_type,
           pl.report_group, pl.group_rank, pl.amount_cents
    from public.report_profit_and_loss(p_organization_id, v_prev_start, v_prev_end) pl
  )
  select
    coalesce(c.account_id, p.account_id),
    coalesce(c.code, p.code),
    coalesce(c.name, p.name),
    coalesce(c.account_type, p.account_type),
    coalesce(c.report_group, p.report_group),
    coalesce(c.group_rank, p.group_rank),
    coalesce(c.amount_cents, 0)::bigint,
    coalesce(p.amount_cents, 0)::bigint
  from cur c
  full outer join prv p on p.account_id = c.account_id
  order by coalesce(c.group_rank, p.group_rank), coalesce(c.code, p.code);
end;
$$;

comment on function public.report_profit_and_loss_comparative(uuid, uuid) is
  'Winst- en verliesrekening van een boekjaar met de vergelijkende cijfers van het direct voorgaande boekjaar, gerubriceerd volgens Model E (art. 2:377 BW). Rekeningen die maar in één van beide jaren een saldo hadden blijven zichtbaar (full outer join).';

revoke all on function public.report_profit_and_loss_comparative(uuid, uuid) from public, anon;
grant execute on function public.report_profit_and_loss_comparative(uuid, uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 8. report_balance_sheet_after_appropriation
--    De balans per balansdatum ZOALS ZIJ IN DE JAARREKENING STAAT: ná
--    resultaatbestemming, met de vergelijkende kolom van het voorgaande
--    boekjaar — en die kolom óók ná de bestemming van dát jaar, want anders
--    toont de vergelijking een onverdeeld resultaat dat allang bestemd is.
--
--    Waarom niet report_balance_sheet op de besluitdatum: die peildatum sleept
--    het hele nieuwe boekjaar mee. De bestemming wordt daarom als losse mutatie
--    op de balans per balansdatum gelegd (blok 6).
--
--    DRIE VALKUILEN, alle drie hier afgevangen:
--      * `having sum(...) <> 0` — een 0520 die vóór de bestemming op nul stond,
--        zit niet in de basisbalans. Vandaar full outer join met de mutatie én
--        met de vergelijkende kolom, en de rekeninggegevens uit ledger_accounts.
--      * De virtuele regel "Resultaat lopend boekjaar" (section = 'result') mag
--        er bij een afgesloten boekjaar niet met een bedrag in staan.
--      * Een balans die niet sluit mag niet naar de jaarrekening.
--
--    KOSTEN, eerlijk geteld: report_balance_sheet draait TWEE keer op de
--    balansdatum (één gecombineerde doorloop voor beide controles, één voor het
--    resultaat) en één keer op de vergelijkende balansdatum;
--    result_appropriation_delta draait twee keer op dit boekjaar en één keer op
--    het vorige. Elke doorloop is een volledige scan over journal_lines tot die
--    datum. De twee controles delen bewust één doorloop — een eerdere versie
--    deed er drie en het commentaar telde er twee.
--
--    Beide controles zijn defensief en bij een gave administratie onbereikbaar
--    (close_fiscal_year/reopen_fiscal_year sluiten een resultaatregel uit,
--    post_journal_entry laat geen ongelijke boeking toe). Ze blijven staan omdat
--    de fout hier oneindig veel goedkoper is dan een gedeponeerd stuk dat niet
--    klopt.
-- ------------------------------------------------------------
create or replace function public.report_balance_sheet_after_appropriation(
  p_organization_id uuid,
  p_fiscal_year_id uuid
)
returns table(
  account_id uuid,
  code text,
  name text,
  section text,
  report_group text,
  group_rank integer,
  amount_cents bigint,
  amount_prev_cents bigint,
  appropriation_delta_cents bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_fy public.fiscal_years;
  v_prev public.fiscal_years;
  v_prev_id uuid := null;
  v_prev_end date := null;
  v_running bigint;
  v_diff bigint;
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  -- Entitlement, zelfde afweging als bij result_appropriation_delta: wel
  -- org_has_business, bewust geen rechtsvorm-gate.
  if not public.org_has_business(p_organization_id) then
    raise exception 'De jaarrekeningrapportage hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;

  select * into v_fy from public.fiscal_years fy
  where fy.id = p_fiscal_year_id and fy.organization_id = p_organization_id;
  if not found then
    raise exception 'Boekjaar niet gevonden.' using errcode = '02000';
  end if;

  -- Ná resultaatbestemming bestaat alleen voor een afgesloten boekjaar: pas de
  -- jaarafsluiting zet het resultaat op 0510, en pas dan valt er iets te
  -- bestemmen.
  if v_fy.status <> 'closed' then
    raise exception 'Sluit boekjaar % eerst af; de balans ná resultaatbestemming bestaat pas als het resultaat op de resultaatrekening staat.', v_fy.label
      using errcode = '23514';
  end if;

  select * into v_prev from public.fiscal_years fy
  where fy.organization_id = p_organization_id
    and fy.period_end < v_fy.period_start
  order by fy.period_end desc
  limit 1;
  if found then
    v_prev_id := v_prev.id;
    v_prev_end := v_prev.period_end;
  end if;

  -- Beide controles uit ÉÉN doorloop van report_balance_sheet:
  --   * v_running — de virtuele regel "Resultaat lopend boekjaar" hoort bij een
  --     afgesloten jaar op nul te staan; het year_close-boekstuk valt óp
  --     period_end en het jaar-slot in closed_periods haalt hem uit de optelling.
  --     Staat er tóch een bedrag, dan klopt closed_periods niet.
  --   * v_diff — activa moeten na de mutatie gelijk zijn aan passiva.
  -- `base` wordt twee keer aangehaald en daarom door PostgreSQL gematerialiseerd:
  -- de rapport-RPC draait hier dus één keer, niet twee.
  with base as (
    select rb.account_id, rb.section, rb.amount_cents
    from public.report_balance_sheet(p_organization_id, v_fy.period_end) rb
  ),
  delta as (
    select d.account_id, d.delta_cents
    from public.result_appropriation_delta(p_organization_id, p_fiscal_year_id) d
  ),
  merged as (
    select coalesce(b.account_id, d.account_id) as acct_id,
           coalesce(b.amount_cents, 0) + coalesce(d.delta_cents, 0) as amt
    from (select bb.account_id, bb.amount_cents from base bb where bb.section <> 'result') b
    full outer join delta d on d.account_id = b.account_id
  )
  select
    (select coalesce(sum(bb.amount_cents), 0)::bigint from base bb where bb.section = 'result'),
    (select coalesce(sum(case when la.type = 'asset' then m.amt else -m.amt end), 0)::bigint
       from merged m
       join public.ledger_accounts la on la.id = m.acct_id)
  into v_running, v_diff;

  if v_running <> 0 then
    raise exception 'De balans van boekjaar % toont nog een resultaat van % cent als losse regel "Resultaat lopend boekjaar", terwijl het jaar is afgesloten. Dat wijst op een ontbrekend jaar-slot; sluit het boekjaar opnieuw af voordat je de jaarrekening opmaakt.',
      v_fy.label, v_running using errcode = '23514';
  end if;

  if v_diff <> 0 then
    raise exception 'De balans van boekjaar % sluit niet: activa en passiva verschillen % cent ná resultaatbestemming. Controleer het grootboek en het bestemmingsboekstuk voordat je de jaarrekening opmaakt.',
      v_fy.label, v_diff using errcode = '23514';
  end if;

  -- LET OP bij de vergelijkende kolom: is het voorgaande boekjaar nog niet
  -- afgesloten, dan staat het resultaat daarvan nog op de opbrengst- en
  -- kostenrekeningen en dus niet op de balans. De vergelijkende kolom sluit dan
  -- niet. Dat blokkeren we niet — de jaarrekening van dít jaar klopt gewoon —
  -- maar het scherm hoort het te melden.
  return query
  with cur_base as (
    select rb.account_id, rb.amount_cents
    from public.report_balance_sheet(p_organization_id, v_fy.period_end) rb
    where rb.section <> 'result'
  ),
  cur_delta as (
    select d.account_id, d.delta_cents
    from public.result_appropriation_delta(p_organization_id, p_fiscal_year_id) d
  ),
  cur as (
    select coalesce(b.account_id, d.account_id) as acct_id,
           coalesce(b.amount_cents, 0) + coalesce(d.delta_cents, 0) as amt,
           coalesce(d.delta_cents, 0) as delta
    from cur_base b
    full outer join cur_delta d on d.account_id = b.account_id
  ),
  prev_base as (
    select rb.account_id, rb.amount_cents
    from public.report_balance_sheet(p_organization_id, v_prev_end) rb
    where v_prev_end is not null and rb.section <> 'result'
  ),
  prev_delta as (
    select d.account_id, d.delta_cents
    from public.result_appropriation_delta(p_organization_id, v_prev_id) d
    where v_prev_id is not null
  ),
  prv as (
    select coalesce(b.account_id, d.account_id) as acct_id,
           coalesce(b.amount_cents, 0) + coalesce(d.delta_cents, 0) as amt
    from prev_base b
    full outer join prev_delta d on d.account_id = b.account_id
  ),
  merged as (
    select coalesce(c.acct_id, p.acct_id) as acct_id,
           coalesce(c.amt, 0) as amt,
           coalesce(p.amt, 0) as amt_prev,
           coalesce(c.delta, 0) as delta
    from cur c
    full outer join prv p on p.acct_id = c.acct_id
  )
  select
    m.acct_id,
    la.code,
    la.name,
    la.type::text,
    -- Zelfde restgroep-logica als report_balance_sheet: een rekening zonder
    -- rubriek valt nooit buiten de balans, anders klopt het balanstotaal niet.
    coalesce(la.report_group, case la.type
      when 'asset'  then 'vorderingen'
      when 'equity' then 'eigen_vermogen'
      else 'kortlopende_schulden' end),
    public.ledger_report_group_rank(coalesce(la.report_group, case la.type
      when 'asset'  then 'vorderingen'
      when 'equity' then 'eigen_vermogen'
      else 'kortlopende_schulden' end)),
    m.amt::bigint,
    m.amt_prev::bigint,
    m.delta::bigint
  from merged m
  join public.ledger_accounts la on la.id = m.acct_id
  -- Een rekening die in beide jaren én in de mutatie op nul uitkomt hoort niet
  -- in de balans. Was zij vorig jaar wél gevuld, dan blijft de regel staan —
  -- dat is precies waar de full outer join voor is.
  where m.amt <> 0 or m.amt_prev <> 0 or m.delta <> 0
  order by
    public.ledger_report_group_rank(coalesce(la.report_group, case la.type
      when 'asset'  then 'vorderingen'
      when 'equity' then 'eigen_vermogen'
      else 'kortlopende_schulden' end)),
    la.code;
end;
$$;

comment on function public.report_balance_sheet_after_appropriation(uuid, uuid) is
  'Balans per balansdatum ná resultaatbestemming, met de vergelijkende kolom van het voorgaande boekjaar (eveneens ná bestemming) en per rekening de mutatie die de bestemming aanbracht. Weigert bij een niet-afgesloten boekjaar of een balans die niet sluit.';

revoke all on function public.report_balance_sheet_after_appropriation(uuid, uuid) from public, anon;
grant execute on function public.report_balance_sheet_after_appropriation(uuid, uuid) to authenticated, service_role;

commit;
