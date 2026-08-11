-- ============================================================
-- ResoFly — Zakelijke module fase 5, brok B:
--   de jaarrekening als bevroren stuk, met haar levenscyclus
--   opmaken → ondertekenen → vaststellen → deponeren (→ intrekken)
-- Date: 2026-08-11 (genummerd als 20260812010000, direct ná brok A
--       20260812000000 — de nummering van brok A is daar toegelicht)
--
-- Aanleiding:
-- Brok A leverde de grootteklasse (determine_company_size) en de twee
-- rapport-RPC's die een jaarrekening nodig heeft: de balans ná
-- resultaatbestemming met vergelijkende kolom, en de W&V vergelijkend. Wat
-- ontbrak is het stuk zélf: het moment waarop het bestuur die cijfers OPMAAKT
-- en ze daarmee bevriest, de handtekeningen eronder, de vaststelling door de
-- algemene vergadering en de deponering bij het handelsregister.
--
-- Dat zijn vier juridisch verschillende gebeurtenissen met vier verschillende
-- beslissers en vier verschillende termijnen, en ze mogen niet als vier
-- vinkjes op één rij worden gemodelleerd:
--
--   1. OPMAKEN — het bestuur, binnen vijf maanden na afloop van het boekjaar
--      (art. 2:210 lid 1 BW). Hier ontstaat de rij, hier wordt de snapshot
--      gehasht en hier klinkt de opmaaktermijn vast.
--   2. ONDERTEKENEN — alle bestuurders én alle commissarissen (art. 2:210
--      lid 2). Ontbreekt er een, dan wordt daarvan melding gemaakt ONDER
--      OPGAVE VAN REDEN. Geen termijn.
--   3. VASTSTELLEN — de algemene vergadering (art. 2:210 lid 3), of, als alle
--      aandeelhouders bestuurder zijn, de ondertekening zelf (lid 5).
--   4. DEPONEREN — binnen acht dagen na de vaststelling (art. 2:394 lid 1),
--      uiterlijk twaalf maanden na afloop van het boekjaar (lid 3).
--
-- Roadmap: BV_VPB_MODULE_ROADMAP_2026-08-06.md; implementatieplan fase 5 §1.3,
-- §1.4, §1.6 en §1.7. Juridische onderbouwing: het onderzoeksrapport met 40
-- bevindingen (fase5_legal.json), artikelverwijzingen staan hieronder per regel.
--
-- ── KERNBESLISSINGEN ─────────────────────────────────────────────────────────
--
-- A. DE JAARREKENING IS EEN BEVROREN SNAPSHOT, GEEN LIVE QUERY. Zodra er is
--    opgemaakt, komen balans, W&V, grootte-uitkomst, resultaatbestemming en
--    Vpb-berekening uit annual_accounts.snapshot en NOOIT meer uit de
--    rapport-RPC's. Reden: het stuk dat de algemene vergadering vaststelt en
--    dat bij het handelsregister ligt, moet over vijf jaar nog letterlijk
--    hetzelfde zijn. Zelfde model als de verzonden offerte-PDF. De hash
--    (sha256 over de canonieke jsonb-tekst) maakt achteraf aantoonbaar dat er
--    niets is veranderd; hij staat klein in de voet van de PDF.
--
-- B. STATUSSEN prepared → adopted → filed, plus reversed als zijspoor. Er is
--    bewust GEEN 'draft': een concept is gewoon de live-RPC zonder rij. En
--    fiscal_years.status blijft 'open'/'closed' — die CHECK wordt niet
--    uitgebreid, de levenscyclus hoort in een eigen tabel.
--
--    'filed' IS GEEN EINDTOESTAND. Deponeren is een GEBEURTENIS die zich kan
--    herhalen: wie op grond van art. 2:394 lid 2 BW de nog niet vastgestelde
--    jaarrekening openbaar maakt, moet daarna alsnog laten vaststellen en het
--    vastgestelde stuk binnen acht dagen opnieuw openbaar maken (lid 1). Elke
--    deponering krijgt daarom een eigen rij in annual_account_filings. De
--    kolommen filing_date, filing_reference en filed_unadopted op
--    annual_accounts zijn niet meer dan de SAMENVATTING VAN DE LAATSTE
--    deponering (handig voor lijsten); de waarheid staat in de kindertabel.
--
--    De toegestane overgangen, volledig:
--      prepared  --adopt-->           adopted
--      prepared  --file(unadopted)--> filed    (art. 2:394 lid 2, alleen ná de
--                                               vaststellingstermijn)
--      adopted   --file-->            filed
--      filed     --adopt-->           filed    (alleen als ÁLLE bestaande
--                                               deponeringen onvastgesteld zijn;
--                                               daarna is een tweede deponering
--                                               verplicht binnen acht dagen)
--      filed     --file-->            filed    (die tweede deponering)
--      prepared/adopted --reverse-->  reversed
--      filed     --reverse-->         GEWEIGERD (zie G)
--
-- C. DE OPMAAKTERMIJN WORDT VASTGEKLONKEN, DE VERLENGING STAAT ERNAAST.
--    prepare_deadline = period_end + 5 maanden (art. 2:210 lid 1) wordt bij het
--    opmaken uitgerekend en daarna nooit meer aangeraakt; extension_months
--    (0 t/m 5) staat er als aparte kolom naast. Zo blijft zichtbaar wat de
--    wettelijke termijn was én wat de algemene vergadering daaraan heeft
--    toegevoegd. Verlengen is GEEN automatisme: art. 2:210 lid 1 eist
--    BIJZONDERE OMSTANDIGHEDEN, dus reden en besluitdatum zijn verplicht en
--    de RPC weigert zonder allebei. (Let op: vóór boekjaar 2016 was de basis-
--    termijn zes maanden; oude teksten noemen nog 6+5=11. Nu 5+5=10.)
--
-- D. TWEE VASTSTELLINGSROUTES, EN DE TWEEDE DECHARGEERT AUTOMATISCH.
--    * 'ava' — besluit van de algemene vergadering (art. 2:210 lid 3). De
--      vaststelling strekt dan NIET tot kwijting; décharge is een apart
--      besluit en dus een apart vinkje.
--    * 'signature_210_5' — zijn alle aandeelhouders tevens bestuurder, dan
--      GELDT de ondertekening door alle bestuurders en commissarissen als
--      vaststelling. In afwijking van lid 3 strekt zij dán TEVENS tot kwijting.
--      Daarom dwingt adopt_annual_accounts discharge_granted af op true (ook
--      als de aanroeper false meestuurt) en eist zij dat de drie voorwaarden
--      van lid 5 expliciet zijn bevestigd: alle aandeelhouders zijn bestuurder,
--      de overige vergadergerechtigden zijn in de gelegenheid gesteld kennis te
--      nemen en hebben ingestemd (art. 2:238 lid 1), en de statuten sluiten
--      deze wijze van vaststellen niet uit. Bovendien moeten dan ÁLLE
--      handtekeningen er staan — een ontbrekende handtekening mét reden is bij
--      route 'ava' toegestaan, maar bij lid 5 is er dan simpelweg geen
--      vaststelling. Een CHECK-constraint bewaakt dit óók op tabelniveau.
--      En de vaststellingsdatum is bij lid 5 GEEN keuze: de ondertekening ís de
--      vaststelling, dus adoption_date wordt dwingend gelijk aan de dag van de
--      laatste handtekening. Wie een andere datum meestuurt, krijgt een fout die
--      de juiste datum noemt. Dat telt door in de acht dagen van art. 2:394
--      lid 1 BW.
--
-- E. DE BETWISTE DEPONEERDATUM WORDT NOOIT ALS "DE" DEADLINE GETOOND, EN
--    ALLEEN ZOLANG ER NOG NIET IS VASTGESTELD.
--    KVK houdt aan dat bij een BV waarvan alle aandeelhouders bestuurder zijn
--    binnen tien maanden en acht dagen na afloop van het boekjaar moet worden
--    gedeponeerd (bij een kalenderboekjaar: 8 november). Hof 's-Hertogenbosch
--    13-9-2022, ECLI:NL:GHSHE:2022:3141 oordeelde echter dat ondertekening geen
--    onderdeel is van het opmaken en dat de twaalfmaandstermijn van art. 2:394
--    lid 3 BW leidend blijft. Een Hoge Raad-uitspraak ontbreekt. Daarom geeft
--    list_annual_accounts BEIDE terug: file_deadline_safe (met
--    file_deadline_safe_disputed = true) en file_deadline_hard. Het scherm
--    toont ze naast elkaar met de bron erbij; ResoFly kiest niet.
--    Rekenwijze van de veilige datum: period_end + 10 maanden + 8 dagen — de
--    KVK-lijn zelf, dus LOS van een geregistreerde verlenging. Bij een
--    kalenderboekjaar komt daar exact de 8 november van KVK uit.
--    Twee voorwaarden voor het tonen:
--      * de gebruiker heeft bevestigd dat alle aandeelhouders bestuurder zijn —
--        dat kan al bij het OPMAKEN (parameter op prepare_annual_accounts),
--        want juist in die fase stuurt de datum;
--      * er is nog niet vastgesteld. Zodra de vaststelling er is, geldt de
--        werkelijke plicht van art. 2:394 lid 1 BW: acht dagen ná die
--        vaststelling. Een datum die later valt dan de strengste toepasselijke
--        termijn mag niet "veilig" heten, dus dan komt file_deadline_safe als
--        null terug en is file_deadline_after_adoption leidend.
--
-- F. NIET VASTGESTELD BINNEN TWEE MAANDEN NA DE OPMAAKTERMIJN → DEPONEREN
--    ZOALS OPGEMAAKT. Art. 2:394 lid 2 BW: dan maakt het bestuur ONVERWIJLD de
--    opgemaakte jaarrekening openbaar, met de vermelding dat zij nog niet is
--    vastgesteld. Daar is filed_unadopted voor; file_annual_accounts kan dus
--    rechtstreeks van 'prepared' naar 'filed' springen, maar alleen met die
--    vlag expliciet aan én pas op of ná de tweemaandsgrens — vóór die dag is
--    art. 2:394 lid 2 BW niet aan de orde en is vaststellen de weg. De
--    vermelding hoort in de PDF (brok C).
--    Die route is een BEGIN, geen einde: de vaststelling moet alsnog komen
--    (adopt_annual_accounts werkt gewoon door op een zo gedeponeerd stuk) en
--    daarna moet het vastgestelde stuk binnen acht dagen opnieuw openbaar
--    worden gemaakt (art. 2:394 lid 1 BW) — een tweede rij in
--    annual_account_filings.
--
-- G. DEPONEREN IS EEN FEIT, GEEN MUUR. reverse_annual_accounts weigert bij
--    status 'filed': het stuk ligt bij het handelsregister en dat poets je niet
--    weg. Maar het boekjaar zit daarmee niet op slot. Een fout in een
--    gedeponeerde jaarrekening herstel je met een OPVOLGEND STUK: een nieuwe
--    rij die via supersedes_annual_account_id naar de gedeponeerde wijst, mét
--    een verplichte reden. Zolang er een gedeponeerde jaarrekening voor dat
--    boekjaar ligt, EIST prepare_annual_accounts allebei. Het oude stuk blijft
--    ongemoeid op 'filed' staan — het IS gedeponeerd.
--    De partiële unique index bewaakt daarom nog maar één ding: ten hoogste één
--    rij per boekjaar met status 'prepared' of 'adopted'. Een gedeponeerd of
--    ingetrokken stuk blokkeert niets meer.
--
--    EN DAN HET BOEKJAAR ZELF. Een opvolgend stuk heeft alleen zin als de
--    CIJFERS mogen wijzigen — anders herhaalt het woordelijk de fout die het
--    moest herstellen. Daarom blokkeren reopen_fiscal_year en
--    reverse_result_appropriation niet op een GEDEPONEERDE jaarrekening, maar
--    uitsluitend op een jaarrekening die nog IN BEHANDELING is (status
--    'prepared' of 'adopted'). Die moet eerst worden ingetrokken; een
--    gedeponeerd of ingetrokken stuk staat niets in de weg. De herstelroute is
--    dus volledig: boekjaar heropenen → corrigeren → afsluiten → resultaat
--    opnieuw bestemmen → een opvolgend stuk opmaken dat de gedeponeerde
--    jaarrekening vervangt → vaststellen → opnieuw deponeren. Het gedeponeerde
--    stuk blijft daarbij staan; dát is wat de weigeringen ook zeggen. Dat het
--    boekjaar van een gedeponeerde jaarrekening is heropend, blijft zichtbaar:
--    fiscal_years.reopened_at/reopened_by leggen het vast, de audit-trigger
--    schrijft de wijziging weg, en annual_account_snapshot_stale laat het
--    gedeponeerde stuk vanaf dat moment als "loopt uit de pas" oplichten.
--
-- H. DE ROUTE TERUG IS VIJF LAGEN DIEP EN ELKE WEIGERING NOEMT DE VOLGENDE
--    STAP. De ketting is: boekjaar afsluiten → resultaat bestemmen →
--    jaarrekening opmaken → vaststellen → deponeren. Terugdraaien loopt precies
--    andersom en elke laag blokkeert de laag eronder. Een klant die dat niet
--    overziet komt klem te zitten, dus staat in ELKE foutmelding welke knop hij
--    éérst moet indrukken — hetzelfde patroon als in reverse_journal_entry.
--    En óók WIE die knop mag indrukken: opmaken, ondertekenen, vaststellen en
--    deponeren mogen met schrijfrechten op de financiële module, maar
--    intrekken, boekjaar heropenen en een resultaatbestemming terugdraaien zijn
--    beheerdershandelingen (can_admin_org). Een weigering die naar "Jaarrekening
--    intrekken" verwijst, noemt daarom de eigenaar of beheerder erbij; anders
--    stuurt zij een teamlid naar een knop die het niet mag indrukken.
--
-- I. FASE 5 BOEKT GEEN ENKELE JOURNAALPOST. Opmaken, vaststellen en deponeren
--    zijn geen boekingen. journal_entries.source_type wordt dus niet uitgebreid
--    en reverse_journal_entry hoeft hier niets van te weten.
--
-- J. DE HANDELENDE GEBRUIKER KOMT UIT auth.uid(), NIET UIT EEN PARAMETER.
--    created_by, prepared_by, adopted_by, filed_by en reversed_by dragen hier
--    juridisch gewicht ("opgemaakt door het bestuur", "vastgesteld",
--    "gedeponeerd"). p_created_by blijft bestaan voor de edge functions, maar
--    telt alleen als de aanroeper service_role is; voor een ingelogde gebruiker
--    wordt hij genegeerd. Zo kan niemand een collega — of iemand uit een andere
--    organisatie — als ondertekenend bestuur laten opdraven.
--
-- ── AFWIJKINGEN VAN HET IMPLEMENTATIEPLAN, BEWUST ────────────────────────────
--
-- 1. auditor_missing_ground (nieuwe kolom, niet in §1.3). Art. 2:393 lid 7 BW:
--    de jaarrekening KAN NIET WORDEN VASTGESTELD als het bevoegde orgaan geen
--    kennis heeft kunnen nemen van de accountantsverklaring — "tenzij onder de
--    overige gegevens een wettige grond wordt medegedeeld waarom de verklaring
--    ontbreekt". Zonder die tenzij-route zou een controleplichtige BV bij ons
--    voorgoed vastlopen op de vaststelstap. Vandaar de kolom, plus drie
--    parameters achteraan adopt_annual_accounts (auditor-gegevens hadden in het
--    plan helemaal geen setter) — en dezelfde drie achteraan
--    file_annual_accounts, omdat de toets van lid 7 óók vóór een deponering op
--    grond van art. 2:394 lid 2 BW geldt en adopt op die route nooit langskomt.
-- 2. list_annual_accounts geeft meer kolommen terug dan §1.6 opsomt (beide
--    deponeerdeadlines, de afgeleide opmaaktermijn, de handtekeningtellers, het
--    aantal ontbrekende handtekeningen zónder reden, snapshot_stale,
--    refiling_required en het aantal deponeringen). Het scherm heeft ze alle
--    nodig en een tweede rondje naar de database per rij is zonde.
-- 3. size_class_override is óók de ontsnapping als determine_company_size een
--    blokkerende reden geeft. Brok A belooft die uitweg met zoveel woorden
--    (kernbeslissing F daar). prepare_annual_accounts weigert dus bij een
--    blockingReason, maar noemt in dezelfde adem de overrideroute mét
--    verplichte onderbouwing. Zonder override: geen jaarrekening.
--    Die overrideroute wordt NIET genoemd in de weigering over fiscale
--    waarderingsgrondslagen: art. 2:396 lid 6 en 2:395a lid 7 BW beperken die
--    grondslagen tot klein en micro, en de grootteklasse is geen knop om zo'n
--    beperking mee te omzeilen — zij is de uitkomst van de tweejaarstoets.
-- 4. annual_account_filings (nieuwe tabel, niet in §1.3). Zie kernbeslissing B:
--    deponeren kan zich herhalen, dus één rij per deponering.
-- 5. supersedes_annual_account_id + supersede_reason (nieuwe kolommen, niet in
--    §1.3). Zie kernbeslissing G: herstel na deponering gaat met een opvolgend
--    stuk.
-- 6. extend_preparation_term werkt op een OPGEMAAKTE jaarrekening, want de rij
--    ontstaat pas bij het opmaken. Een verlenging die wordt besloten vóórdat er
--    is opgemaakt, is hier dus (nog) niet vast te leggen; die hoort bij het
--    boekjaar zelf en staat op de lijst voor brok D/E. Wat de functie wél doet:
--    weigeren als het besluit is genomen ná afloop van de wettelijke
--    opmaaktermijn, want een verstreken termijn laat zich niet met
--    terugwerkende kracht verlengen en zou anders alle deadlines op het scherm
--    naar achteren schuiven.
--
-- ── VALKUILEN DIE HIER BEWUST ZIJN AFGEVANGEN ────────────────────────────────
--
-- 1. attachments.entity_type staat op DRIE plekken, niet op één. 'annual_account'
--    moet in de CHECK-constraint, in de trigger enforce_attachments_org_integrity()
--    ÉN in public.attachment_module() (20260730100000). Wie alleen de CHECK
--    bijwerkt, laat de INSERT falen ná de R2-upload, met een verweesd bestand
--    tot gevolg — precies de fout die de teamchat-bijlagen brak (20260714000000).
--    En wie attachment_module() vergeet, laat iets ergers gebeuren: die functie
--    geeft voor een onbekend type NULL terug, en de vier restrictieve policies op
--    attachments lezen "module is null" als NIET AFGESCHERMD. De modulepoort valt
--    dan OPEN in plaats van dicht en een teamlid met finance = 'none' kan de
--    jaarrekening-PDF, het publicatiestuk, het bestuursverslag en de
--    accountantsverklaring lezen, wijzigen en verwijderen — terwijl de tabellen
--    zelf keurig achter apply_module_gate(..., 'finance') zitten. Alle drie de
--    lijsten staan hieronder autoritair opnieuw, mét alle bestaande takken.
-- 2. GUARDS OP BESTAANDE FUNCTIES = VOLLEDIGE FUNCTIE OPNIEUW. reopen_fiscal_year
--    en reverse_result_appropriation worden hieronder integraal overgenomen uit
--    de migratie waarin ze het laatst zijn gedefinieerd (respectievelijk
--    20260807030000 en 20260807100000) met alléén de nieuwe weigering erbij.
--    Wie hier alleen de guard zou schrijven, verliest stil het bestaande gedrag.
-- 3. AMBIGUÏTEIT TUSSEN OUT-PARAMETERS EN KOLOMNAMEN. list_annual_accounts heeft
--    OUT-kolommen die status, note en created_at heten — precies zoals de
--    tabelkolommen. In plpgsql wint dan de variabele. Elke kolomverwijzing in
--    dit bestand is daarom gekwalificeerd met een alias.
-- 4. ÉÉN JAARREKENING PER BOEKJAAR IN BEHANDELING via een partiële unique index
--    op status in ('prepared','adopted'). Een ingetrokken exemplaar blijft staan
--    als spoor, en een gedeponeerd exemplaar blijft staan als feit; geen van
--    beide blokkeert nog een opvolgend stuk (kernbeslissing G). De index is bij
--    het wijzigen eerst gedropt: een partiële unique index verandert zijn
--    predicaat niet vanzelf onder "create ... if not exists".
-- 5. SNAPSHOT-DRIFT WORDT GEMETEN, NIET GEHOOPT. Na reverse_annual_accounts mag
--    het boekjaar weer open en kan er nageboekt worden; en onder een GEDEPONEERD
--    stuk mag dat óók (kernbeslissing G) — dat is juist de herstelroute. Precies
--    dan lopen de bevroren cijfers uit de pas met de administratie.
--    Daarom: (a) annual_account_snapshot_stale() vergelijkt de bevroren
--    resultaatbestemming met de geboekte, kijkt of het boekjaar nog 'closed' is
--    en of het ná het opmaken is heropend; (b) list_annual_accounts en
--    get_annual_account geven die uitkomst terug als snapshot_stale, zodat het
--    scherm het kán markeren; en (c) adopt_annual_accounts en
--    file_annual_accounts WEIGEREN bij drift — een stuk dat niet meer bij de
--    administratie past, mag niet worden vastgesteld of gedeponeerd.
--    Die functie is security definer en staat als RPC op PostgREST, dus zij
--    controleert zélf can_read_org + can_read_module; zonder die guard zou zij
--    een cross-tenant orakel zijn ("bestaat er een jaarrekening met dit id, en
--    is haar boekjaar heropend?").
-- 6. BEDRAGEN IN HELE CENTEN (bigint), zoals de rest van de boekhouding.
-- 7. HERHAALBAARHEID. "create table if not exists" slaat een bestaande tabel
--    VOLLEDIG over — inclusief elke CHECK en elke unique die alleen daarbinnen
--    staat. Op een database waar de tabel ooit met de hand is aangemaakt, of na
--    een half teruggedraaide run, draait de migratie dan groen en staat de
--    jaarrekening zónder statusbewaking in de database. Alle constraints van
--    annual_accounts en annual_account_signatures staan daarom óók als los
--    do-blok, met dezelfde namen als in de create table.
-- 8. BACKFILL VAN annual_account_filings. De kindertabel is nieuw, maar de
--    kolommen filing_date/filing_reference/filed_unadopted bestonden al. Zonder
--    backfill heeft een eerder gedeponeerde rij nul kindrijen — en dan denkt de
--    app dat het VASTGESTELDE stuk nog moet worden gedeponeerd
--    (refiling_required) en laat file_annual_accounts een tweede, dubbele
--    openbaarmaking toe. De insert-select staat vóór de RPC's.
--
-- Dit is een hulpmiddel, geen accountantsproduct en geen fiscaal of juridisch
-- advies. ResoFly rekent en legt vast; het bestuur maakt op, de algemene
-- vergadering stelt vast, de rechtspersoon deponeert. De gegenereerde PDF is
-- bovendien GEEN deponeerbestand: micro, kleine en middelgrote rechtspersonen
-- deponeren digitaal in SBR/XBRL, en dat levert ResoFly niet (zie §8 van het
-- plan). file_annual_accounts legt alleen vast DÁT en WANNEER er is gedeponeerd.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. attachments: het nieuwe entity_type 'annual_account'
--    De CHECK, de trigger én de modulepoort, in één blok, want ze horen bij
--    elkaar (zie valkuil 1 in de kop).
--    De PDF van de jaarrekening en die van het publicatiestuk (brok C) worden
--    als attachments-rij geregistreerd; ook het bestuursverslag, de
--    accountantsverklaring en de overige gegevens die de gebruiker voor een
--    middelgrote of grote rechtspersoon zelf uploadt hangen hieraan.
--
--    Dit blok staat vóór de tabel annual_accounts, en dat mag: de parameter
--    p_ref_table van assert_same_org_reference is van het type regclass, dus
--    'public.annual_accounts' wordt pas bij het uitvoeren van de trigger
--    omgezet — niet bij het aanmaken van de functie.
-- ------------------------------------------------------------
alter table public.attachments drop constraint if exists attachments_entity_type_check;
alter table public.attachments
  add constraint attachments_entity_type_check
  check (entity_type in (
    'client','project','task','subtask','ticket','note','document','quote','invoice',
    'folder','supplier','purchase_invoice','fixed_asset','chat_message',
    'annual_account'
  ));

-- Volledige lijst opnieuw (basis: 20260714000000), alleen de tak
-- 'annual_account' is nieuw. De `else raise` blijft als vangnet.
create or replace function public.enforce_attachments_org_integrity()
returns trigger language plpgsql as $$
begin
  perform public.assert_same_org_reference('public.tasks', new.parent_task_id, new.organization_id, 'attachments.parent_task_id');

  case new.entity_type
    when 'client' then perform public.assert_same_org_reference('public.clients', new.entity_id, new.organization_id, 'attachments.entity_id(client)');
    when 'project' then perform public.assert_same_org_reference('public.projects', new.entity_id, new.organization_id, 'attachments.entity_id(project)');
    when 'task' then perform public.assert_same_org_reference('public.tasks', new.entity_id, new.organization_id, 'attachments.entity_id(task)');
    when 'subtask' then
      if new.parent_task_id is null then
        raise exception 'attachments.parent_task_id is verplicht voor subtask attachments' using errcode = '23514';
      end if;
      perform public.assert_same_org_reference('public.tasks', new.parent_task_id, new.organization_id, 'attachments.parent_task_id');
      if not exists (
        select 1 from public.tasks t
        where t.id = new.parent_task_id
          and t.organization_id = new.organization_id
          and t.subtasks @> jsonb_build_array(jsonb_build_object('id', new.entity_id::text))
      ) then
        raise exception 'attachments.entity_id(subtask) verwijst niet naar een bestaande subtaak op parent_task_id' using errcode = '23514';
      end if;
    when 'ticket' then perform public.assert_same_org_reference('public.tickets', new.entity_id, new.organization_id, 'attachments.entity_id(ticket)');
    when 'note' then perform public.assert_same_org_reference('public.notes', new.entity_id, new.organization_id, 'attachments.entity_id(note)');
    when 'document' then perform public.assert_same_org_reference('public.documents', new.entity_id, new.organization_id, 'attachments.entity_id(document)');
    when 'quote' then perform public.assert_same_org_reference('public.quotes', new.entity_id, new.organization_id, 'attachments.entity_id(quote)');
    when 'invoice' then perform public.assert_same_org_reference('public.invoices', new.entity_id, new.organization_id, 'attachments.entity_id(invoice)');
    when 'folder' then perform public.assert_same_org_reference('public.content_folders', new.entity_id, new.organization_id, 'attachments.entity_id(folder)');
    when 'supplier' then perform public.assert_same_org_reference('public.suppliers', new.entity_id, new.organization_id, 'attachments.entity_id(supplier)');
    when 'purchase_invoice' then perform public.assert_same_org_reference('public.purchase_invoices', new.entity_id, new.organization_id, 'attachments.entity_id(purchase_invoice)');
    when 'fixed_asset' then perform public.assert_same_org_reference('public.fixed_assets', new.entity_id, new.organization_id, 'attachments.entity_id(fixed_asset)');
    when 'chat_message' then perform public.assert_same_org_reference('public.chat_messages', new.entity_id, new.organization_id, 'attachments.entity_id(chat_message)');
    -- NIEUW (20260812010000): de jaarrekening-PDF, het publicatiestuk en de
    -- geüploade stukken die ResoFly niet genereert (bestuursverslag,
    -- accountantsverklaring, overige gegevens).
    when 'annual_account' then perform public.assert_same_org_reference('public.annual_accounts', new.entity_id, new.organization_id, 'attachments.entity_id(annual_account)');
    else raise exception 'Onbekend attachments.entity_type: %', new.entity_type using errcode = '23514';
  end case;
  return new;
end; $$;

-- DE DERDE LIJST: de modulepoort. public.attachment_module() (20260730100000)
-- leidt uit entity_type af achter welke module een bijlage hoort. Een ONBEKEND
-- type geeft daar bewust null terug, en de vier restrictieve policies op
-- public.attachments plus de trigger enforce_attachment_module_write_access()
-- lezen null als "niet afgeschermd":
--     public.attachment_module(entity_type) is null OR public.can_read_module(...)
-- Zonder de tak hieronder valt de poort op de jaarrekening-bijlagen dus OPEN in
-- plaats van dicht: een teamlid met module_access finance = 'none' zou de
-- jaarrekening-PDF, het publicatiestuk, het bestuursverslag, de
-- accountantsverklaring en de overige gegevens kunnen lezen, wijzigen en
-- verwijderen, terwijl annual_accounts, annual_account_filings en
-- annual_account_signatures zelf wél achter apply_module_gate(..., 'finance')
-- zitten. De volledige lijst staat opnieuw (basis: 20260730100000), alleen de tak
-- 'annual_account' is nieuw — zelfde discipline als bij de trigger hierboven.
create or replace function public.attachment_module(p_entity_type text)
returns text
language sql
immutable
as $$
  select case p_entity_type
    when 'client'           then 'clients'
    when 'project'          then 'projects'
    when 'task'             then 'projects'
    when 'subtask'          then 'projects'
    when 'ticket'           then 'tickets'
    when 'note'             then 'content'
    when 'document'         then 'content'
    when 'folder'           then 'content'
    when 'quote'            then 'finance'
    when 'invoice'          then 'finance'
    when 'supplier'         then 'finance'
    when 'purchase_invoice' then 'finance'
    when 'fixed_asset'      then 'finance'
    when 'chat_message'     then 'chat'
    -- NIEUW (20260812010000): de jaarrekening is financiële kerninformatie.
    when 'annual_account'   then 'finance'
    else null
  end;
$$;

-- create or replace behoudt de bestaande rechten; deze grant staat er als
-- vangnet voor een database waar de functie om wat voor reden ook opnieuw is
-- aangemaakt (basis: 20260730100000).
grant execute on function public.attachment_module(text) to authenticated, service_role;

-- ------------------------------------------------------------
-- 2. annual_accounts — de bevroren jaarrekening
-- ------------------------------------------------------------
create table if not exists public.annual_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- on delete NO ACTION en bewust géén restrict: bij het verwijderen van een
  -- organisatie vuren het cascade-pad (organizations → annual_accounts) en het
  -- boekjaarpad tegelijk, in een volgorde die Postgres niet garandeert. RESTRICT
  -- stelt zijn controle niet uit tot het einde van de transactie en zou de
  -- verwijdering dan met een rauwe FK-fout afbreken; NO ACTION doet dat wél en
  -- ziet de rijen aan het eind netjes verdwenen. De bescherming die hier was
  -- bedoeld — een boekjaar mag niet onder een opgemaakt stuk vandaan — komt
  -- sowieso uit reopen_fiscal_year en de guards hieronder, niet uit deze FK.
  -- (De zustertabellen result_appropriations en corporate_tax_returns staan om
  -- dezelfde reden op cascade.)
  fiscal_year_id uuid not null references public.fiscal_years(id) on delete no action,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),

  -- 'prepared' — opgemaakt door het bestuur (art. 2:210 lid 1 BW). De rij ONTSTAAT
  --              hier; er is geen 'draft', want een concept is gewoon de live-RPC
  --              zonder rij.
  -- 'adopted'  — vastgesteld door de algemene vergadering (art. 2:210 lid 3) of
  --              via ondertekening (lid 5).
  -- 'filed'    — gedeponeerd bij het handelsregister (art. 2:394 lid 1).
  -- 'reversed' — ingetrokken; blijft staan als spoor, blokkeert niets meer.
  status text not null default 'prepared',

  -- ── Opmaken ────────────────────────────────────────────────
  prepared_on date not null,
  prepared_by uuid references auth.users(id) on delete set null,
  -- period_end + 5 maanden (art. 2:210 lid 1 BW). Vastgeklonken bij het opmaken:
  -- de gebruiker mag period_end daarna niet meer verschuiven zonder dat de
  -- termijn van dit stuk meeschuift.
  prepare_deadline date not null,
  -- Verlenging door de algemene vergadering: ten hoogste 5 maanden, en alleen op
  -- grond van BIJZONDERE OMSTANDIGHEDEN (art. 2:210 lid 1 BW). Geen automatisme —
  -- reden en besluitdatum zijn verplicht zodra dit getal boven nul komt.
  -- Expliciet benoemd, net als alle andere CHECKs hier: het do-blok hieronder
  -- zet dezelfde constraint neer op een database waar de tabel al bestond, en
  -- dat kan alleen op naam (valkuil 7).
  extension_months integer not null default 0
    constraint annual_accounts_extension_months_check check (extension_months between 0 and 5),
  extension_reason text,
  extension_decided_on date,

  -- ── Vaststellen ────────────────────────────────────────────
  adoption_date date,
  adopted_by uuid references auth.users(id) on delete set null,
  -- 'ava'             — besluit van de algemene vergadering (art. 2:210 lid 3 BW).
  -- 'signature_210_5' — alle aandeelhouders zijn bestuurder: ondertekening
  --                     GELDT als vaststelling ÉN als kwijting (lid 5).
  adoption_method text,
  -- Art. 2:210 lid 3: vaststelling strekt NIET tot kwijting — dat is een apart
  -- besluit. Bij lid 5 wordt dit door de RPC afgedwongen op true.
  discharge_granted boolean not null default false,
  -- De drie voorwaarden van art. 2:210 lid 5, expliciet bevestigd door de
  -- gebruiker. Niet af te leiden uit de administratie: of alle overige
  -- vergadergerechtigden (certificaathouders, vruchtgebruikers en pandhouders
  -- met vergaderrecht) zijn geïnformeerd en hebben ingestemd (art. 2:238 lid 1),
  -- en of de statuten deze wijze van vaststellen toelaten, weet alleen zij.
  all_shareholders_are_directors boolean not null default false,
  other_meeting_rights_informed boolean not null default false,
  articles_allow_210_5 boolean not null default false,

  -- ── Deponeren ──────────────────────────────────────────────
  filing_date date,
  filed_by uuid references auth.users(id) on delete set null,
  -- Wat het handelsregister teruggaf; vrije tekst, want de vorm van de
  -- bevestiging verschilt per deponeerkanaal.
  filing_reference text,
  -- Art. 2:394 lid 2 BW: niet vastgesteld binnen 2 maanden na afloop van de
  -- opmaaktermijn → onverwijld de OPGEMAAKTE jaarrekening deponeren, met de
  -- vermelding dat zij nog niet is vastgesteld. Die vermelding moet in het stuk.
  filed_unadopted boolean not null default false,

  -- ── Grootte en grondslagen ─────────────────────────────────
  size_class text not null
    constraint annual_accounts_size_class_check
    check (size_class in ('micro','klein','middelgroot','groot')),
  size_class_override text
    constraint annual_accounts_size_class_override_check
    check (size_class_override is null or size_class_override in ('micro','klein','middelgroot','groot')),
  size_override_reason text,
  -- De volledige uitkomst van determine_company_size(): rauwe en effectieve
  -- klasse per boekjaar, gebruikte drempelrij, waarschuwingen en een eventuele
  -- blokkerende reden. Bevroren, want de klasse van een gedeponeerd stuk mag
  -- niet meebewegen met later ingevoerde werknemersaantallen.
  size_basis jsonb not null,
  -- Art. 2:396 lid 6 BW (klein) en art. 2:395a lid 7 (micro): de fiscale
  -- waarderingsgrondslagen mogen worden toegepast, maar alles-of-niets en met
  -- vermelding. Voor middelgroot en groot bestaat die route niet.
  accounting_basis text not null default 'commercieel'
    constraint annual_accounts_accounting_basis_check
    check (accounting_basis in ('commercieel','fiscaal')),
  -- Art. 2:384 lid 6 BW: een stelselwijziging mag alleen wegens gegronde redenen
  -- en moet worden toegelicht met de betekenis voor vermogen en resultaat.
  policy_change_note text,
  -- Art. 2:381 lid 1 BW: de belangrijke NIET in de balans opgenomen financiële
  -- verplichtingen (huur, lease, meerjarige contracten). Blijft ook voor de
  -- kleine rechtspersoon gelden en wordt in de praktijk het vaakst vergeten.
  off_balance_commitments text,
  -- Art. 2:393 lid 1 BW: middelgroot en groot moeten laten controleren. De
  -- vrijstelling van art. 2:396 lid 7 geldt alleen klein (en daarmee micro).
  audit_required boolean not null default false,
  auditor_opinion_received boolean not null default false,
  auditor_name text,

  -- ── De bevriezing ──────────────────────────────────────────
  snapshot jsonb not null,
  snapshot_hash text not null,
  snapshot_version integer not null default 1,

  pdf_attachment_id uuid references public.attachments(id) on delete set null,
  publication_attachment_id uuid references public.attachments(id) on delete set null,

  reversed_at timestamptz,
  reversed_by uuid references auth.users(id) on delete set null,
  reverse_reason text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint annual_accounts_status_check
    check (status in ('prepared','adopted','filed','reversed')),
  -- Vastgesteld betekent: een datum én een route. Uitzondering: een stuk dat op
  -- grond van art. 2:394 lid 2 BW ONVASTGESTELD is gedeponeerd.
  constraint annual_accounts_adoption_check check (
    (status in ('prepared','reversed'))
    or (adoption_date is not null and adoption_method in ('ava','signature_210_5'))
    or (status = 'filed' and filed_unadopted)
  ),
  constraint annual_accounts_filing_check
    check (status <> 'filed' or filing_date is not null),
  -- Verlengen kan alleen mét grond en besluitdatum (art. 2:210 lid 1 BW).
  constraint annual_accounts_extension_check
    check (extension_months = 0 or (extension_reason is not null and extension_decided_on is not null)),
  -- Een handmatige klasse zonder onderbouwing is bij een controle waardeloos.
  constraint annual_accounts_override_check
    check (size_class_override is null or size_override_reason is not null),
  constraint annual_accounts_hash_check
    check (snapshot_hash ~ '^[0-9a-f]{64}$')
);

-- Kolommen die ná de eerste toepassing zijn bijgekomen staan óók als losse
-- alter: "create table if not exists" slaat een bestaande tabel volledig over en
-- zou ze anders stilzwijgend missen.
alter table public.annual_accounts
  -- Art. 2:393 lid 7 BW: de jaarrekening kan niet worden vastgesteld zonder dat
  -- het bevoegde orgaan kennis heeft kunnen nemen van de accountantsverklaring,
  -- TENZIJ onder de overige gegevens een wettige grond wordt medegedeeld waarom
  -- die verklaring ontbreekt. Hier staat die grond.
  add column if not exists auditor_missing_ground text;

alter table public.annual_accounts
  -- Kernbeslissing G: het opvolgende stuk. Wijst naar de GEDEPONEERDE
  -- jaarrekening die dit stuk vervangt (art. 2:394 BW — die deponering blijft
  -- een feit en wordt niet gewist). on delete set null: de verwijzing is een
  -- spoor, geen bestaansvoorwaarde.
  add column if not exists supersedes_annual_account_id uuid
    references public.annual_accounts(id) on delete set null;

alter table public.annual_accounts
  -- Waaróm er een tweede stuk over hetzelfde boekjaar bestaat. Verplicht zodra
  -- supersedes_annual_account_id is gevuld; zonder die reden is achteraf niet na
  -- te gaan waarom het handelsregister twee jaarrekeningen van dit boekjaar kent.
  add column if not exists supersede_reason text;

-- ALLE constraints van annual_accounts nog een keer, nu als los do-blok
-- (valkuil 7). "create table if not exists" slaat een bestaande tabel volledig
-- over; wat alleen dáárin staat, ontbreekt dan stilzwijgend en de migratie
-- draait toch groen. De namen zijn exact dezelfde als hierboven, dus op een
-- verse database doet dit blok niets. Vier constraints (210_5, reversed,
-- supersede, supersede_self) hebben nooit in de create table gestaan en komen
-- uitsluitend hier vandaan.
do $$
declare
  v record;
begin
  for v in
    select * from (values
      ('annual_accounts_status_check',
       $c$check (status in ('prepared','adopted','filed','reversed'))$c$),
      -- Vastgesteld betekent: een datum én een route. Uitzondering: een stuk dat
      -- op grond van art. 2:394 lid 2 BW ONVASTGESTELD is gedeponeerd.
      ('annual_accounts_adoption_check',
       $c$check ((status in ('prepared','reversed'))
                 or (adoption_date is not null and adoption_method in ('ava','signature_210_5'))
                 or (status = 'filed' and filed_unadopted))$c$),
      ('annual_accounts_filing_check',
       $c$check (status <> 'filed' or filing_date is not null)$c$),
      -- Verlengen kan alleen mét grond en besluitdatum (art. 2:210 lid 1 BW).
      ('annual_accounts_extension_check',
       $c$check (extension_months = 0
                 or (extension_reason is not null and extension_decided_on is not null))$c$),
      ('annual_accounts_extension_months_check',
       $c$check (extension_months between 0 and 5)$c$),
      ('annual_accounts_size_class_check',
       $c$check (size_class in ('micro','klein','middelgroot','groot'))$c$),
      ('annual_accounts_size_class_override_check',
       $c$check (size_class_override is null
                 or size_class_override in ('micro','klein','middelgroot','groot'))$c$),
      ('annual_accounts_accounting_basis_check',
       $c$check (accounting_basis in ('commercieel','fiscaal'))$c$),
      -- Een handmatige klasse zonder onderbouwing is bij een controle waardeloos.
      ('annual_accounts_override_check',
       $c$check (size_class_override is null or size_override_reason is not null)$c$),
      ('annual_accounts_hash_check',
       $c$check (snapshot_hash ~ '^[0-9a-f]{64}$')$c$),
      -- Art. 2:210 lid 5 BW op tabelniveau: wie via ondertekening vaststelt, moet
      -- de drie voorwaarden hebben bevestigd én dechargeert automatisch.
      ('annual_accounts_210_5_check',
       $c$check (adoption_method is distinct from 'signature_210_5'
                 or (all_shareholders_are_directors
                     and other_meeting_rights_informed
                     and articles_allow_210_5
                     and discharge_granted))$c$),
      ('annual_accounts_reversed_check',
       $c$check (status <> 'reversed'
                 or (reversed_at is not null and coalesce(btrim(reverse_reason), '') <> ''))$c$),
      -- Een opvolgend stuk zonder opgaaf van reden is bij een controle waardeloos:
      -- er liggen dan twee jaarrekeningen over hetzelfde boekjaar zonder dat
      -- iemand kan nagaan waarom.
      ('annual_accounts_supersede_check',
       $c$check (supersedes_annual_account_id is null
                 or coalesce(btrim(supersede_reason), '') <> '')$c$),
      -- Een stuk kan zichzelf niet vervangen.
      ('annual_accounts_supersede_self_check',
       $c$check (supersedes_annual_account_id is null
                 or supersedes_annual_account_id <> id)$c$)
    ) as t(conname, condef)
  loop
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.annual_accounts'::regclass
        and conname = v.conname
    ) then
      execute format('alter table public.annual_accounts add constraint %I %s', v.conname, v.condef);
    end if;
  end loop;
end $$;

comment on table public.annual_accounts is
  'De opgemaakte jaarrekening van één boekjaar, met bevroren cijfers (snapshot + sha256-hash) en haar levenscyclus: opgemaakt door het bestuur (art. 2:210 lid 1 BW), vastgesteld door de algemene vergadering (lid 3) of via ondertekening (lid 5), en gedeponeerd bij het handelsregister (art. 2:394 BW). Na het opmaken worden de rapporten nooit meer live bevraagd.';

comment on column public.annual_accounts.prepare_deadline is
  'period_end + 5 maanden (art. 2:210 lid 1 BW), vastgeklonken bij het opmaken. Een verlenging staat apart in extension_months; de effectieve termijn is prepare_deadline + extension_months.';

comment on column public.annual_accounts.filed_unadopted is
  'SAMENVATTING VAN DE LAATSTE DEPONERING, geen eigenschap van het stuk: droeg de laatste deponering de vermelding van art. 2:394 lid 2 BW dat de jaarrekening nog niet was vastgesteld? Let op de tussenstand op de lid-2-route: na een onvastgestelde deponering en een daaropvolgende vaststelling staat deze kolom nog steeds op true terwijl adoption_date gevuld is — dat is geen tegenspraak maar de stand van zaken (het openbaar gemaakte exemplaar vermeldt nog "niet vastgesteld"), en zij wordt pas false bij de tweede deponering. Lees deze kolom daarom NOOIT los van adoption_date en refiling_required; wie de werkelijke geschiedenis nodig heeft, leest annual_account_filings.';

comment on column public.annual_accounts.snapshot_hash is
  'sha256 over de canonieke tekstweergave van snapshot. Maakt achteraf aantoonbaar dat het vastgestelde en gedeponeerde stuk niet is gewijzigd.';

comment on column public.annual_accounts.supersedes_annual_account_id is
  'De gedeponeerde jaarrekening die dit stuk vervangt (kernbeslissing G). Een deponering is een feit dat blijft staan; herstel gaat met een opvolgend stuk, niet met het uitwissen van het oude. Verplicht — samen met supersede_reason — zodra er voor het boekjaar al een gedeponeerde jaarrekening ligt.';

comment on column public.annual_accounts.filing_date is
  'De datum van de LAATSTE deponering; samenvatting van annual_account_filings. Idem filing_reference en filed_unadopted. Wie de volledige deponeringsgeschiedenis nodig heeft — en die is er, zie art. 2:394 lid 2 jo. lid 1 BW — leest de kindertabel.';

-- Ten hoogste één jaarrekening per boekjaar IN BEHANDELING (opgemaakt of
-- vastgesteld). Een ingetrokken exemplaar blijft staan als spoor en een
-- gedeponeerd exemplaar als feit; allebei blokkeren ze een opvolgend stuk niet
-- meer (kernbeslissing G). Eerst droppen: een bestaande partiële unique index
-- neemt onder "create ... if not exists" haar oude predicaat mee.
drop index if exists public.uq_annual_accounts_active;
create unique index if not exists uq_annual_accounts_active
  on public.annual_accounts(fiscal_year_id) where status in ('prepared','adopted');

create index if not exists idx_annual_accounts_supersedes
  on public.annual_accounts(supersedes_annual_account_id)
  where supersedes_annual_account_id is not null;

create index if not exists idx_annual_accounts_org
  on public.annual_accounts(organization_id, prepared_on desc);

alter table public.annual_accounts enable row level security;
-- Alleen lezen; alle mutatie loopt via de security-definer RPC's hieronder.
drop policy if exists "annual_accounts read" on public.annual_accounts;
create policy "annual_accounts read" on public.annual_accounts
  for select using (public.can_read_org(organization_id));

-- Modulerechten: een jaarrekening is financiële kerninformatie. can_read_org
-- kijkt alleen naar lidmaatschap, dus zonder deze restrictieve policies zou de
-- tabel voor iedereen in de organisatie open staan.
select public.apply_module_gate('annual_accounts', 'finance');

drop trigger if exists annual_accounts_touch_updated_at on public.annual_accounts;
create trigger annual_accounts_touch_updated_at before update on public.annual_accounts
  for each row execute function public.bookkeeping_touch_updated_at();
drop trigger if exists annual_accounts_prevent_org_change on public.annual_accounts;
create trigger annual_accounts_prevent_org_change before update of organization_id on public.annual_accounts
  for each row execute function public.prevent_organization_id_change();
drop trigger if exists annual_accounts_audit on public.annual_accounts;
create trigger annual_accounts_audit after insert or update or delete on public.annual_accounts
  -- Tweede argument is de kolom waaruit het LABEL in de activiteitenlijst komt.
  -- De status is hier het herkenbaarste: opgemaakt, vastgesteld, gedeponeerd.
  for each row execute function public.audit_row_change('annual_account', 'status');

-- Organisatie-integriteit op de verwijzingen die deze tabel zelf legt. De
-- omgekeerde richting (attachments.entity_id → annual_accounts) staat hierboven
-- in enforce_attachments_org_integrity; deze kant was open. Dat is niet
-- theoretisch: brok C zet pdf_attachment_id en publication_attachment_id vanuit
-- een edge function die met service_role draait, en dan worden ÁLLE org-checks
-- in de RPC's overgeslagen. Zonder deze trigger zou een door de client
-- meegestuurd attachment-id een jaarrekening van organisatie A naar een
-- R2-bestand van organisatie B kunnen laten wijzen — dezelfde klasse fout die
-- het klantcontacten-lek opleverde. assert_same_org_reference doet niets bij
-- null, dus de trigger is gratis zolang de kolommen leeg zijn.
create or replace function public.enforce_annual_accounts_org_integrity()
returns trigger language plpgsql as $$
begin
  perform public.assert_same_org_reference('public.attachments', new.pdf_attachment_id, new.organization_id, 'annual_accounts.pdf_attachment_id');
  perform public.assert_same_org_reference('public.attachments', new.publication_attachment_id, new.organization_id, 'annual_accounts.publication_attachment_id');
  perform public.assert_same_org_reference('public.annual_accounts', new.supersedes_annual_account_id, new.organization_id, 'annual_accounts.supersedes_annual_account_id');
  return new;
end; $$;

drop trigger if exists annual_accounts_org_integrity on public.annual_accounts;
create trigger annual_accounts_org_integrity before insert or update on public.annual_accounts
  for each row execute function public.enforce_annual_accounts_org_integrity();

-- ------------------------------------------------------------
-- 2b. annual_account_filings — één rij per DEPONERING
--
--     Deponeren is een gebeurtenis, geen eindtoestand (kernbeslissing B). Art.
--     2:394 lid 2 BW dwingt dat zelfs af: is er twee maanden na afloop van de
--     opmaaktermijn niet vastgesteld, dan wordt de OPGEMAAKTE jaarrekening
--     onverwijld openbaar gemaakt met die vermelding — en daarna moet de
--     vaststelling alsnog plaatsvinden, gevolgd door openbaarmaking binnen acht
--     dagen (lid 1). Dat zijn twee deponeringen van hetzelfde stuk, met twee
--     verschillende data en twee verschillende registerbevestigingen.
--
--     De kolommen filing_date, filing_reference en filed_unadopted op
--     annual_accounts blijven bestaan als samenvatting van de LAATSTE rij hier.
-- ------------------------------------------------------------
create table if not exists public.annual_account_filings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  annual_account_id uuid not null references public.annual_accounts(id) on delete cascade,
  filing_date date not null,
  -- Wat het handelsregister teruggaf; vrije tekst, want de vorm van de
  -- bevestiging verschilt per deponeerkanaal.
  filing_reference text,
  -- Art. 2:394 lid 2 BW: gedeponeerd terwijl nog niet vastgesteld.
  unadopted boolean not null default false,
  note text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

comment on table public.annual_account_filings is
  'Eén rij per deponering van een jaarrekening bij het handelsregister (art. 2:394 BW). Een jaarrekening kan meer dan één keer worden gedeponeerd: eerst als nog niet vastgesteld stuk (lid 2) en daarna, ná de vaststelling, opnieuw binnen acht dagen (lid 1).';

create index if not exists idx_annual_account_filings_account
  on public.annual_account_filings(annual_account_id, filing_date);

alter table public.annual_account_filings enable row level security;
-- Alleen lezen; alle mutatie loopt via file_annual_accounts.
drop policy if exists "annual_account_filings read" on public.annual_account_filings;
create policy "annual_account_filings read" on public.annual_account_filings
  for select using (public.can_read_org(organization_id));

select public.apply_module_gate('annual_account_filings', 'finance');

drop trigger if exists annual_account_filings_prevent_org_change on public.annual_account_filings;
create trigger annual_account_filings_prevent_org_change before update of organization_id on public.annual_account_filings
  for each row execute function public.prevent_organization_id_change();
drop trigger if exists annual_account_filings_audit on public.annual_account_filings;
create trigger annual_account_filings_audit after insert or update or delete on public.annual_account_filings
  for each row execute function public.audit_row_change('annual_account_filing', 'filing_date');

-- Een deponering hoort bij een jaarrekening van dezelfde organisatie. De RPC
-- zet dat goed, maar zij draait voor de edge functions met service_role en dan
-- vervalt elke org-check in de functie zelf.
create or replace function public.enforce_annual_account_filings_org_integrity()
returns trigger language plpgsql as $$
begin
  perform public.assert_same_org_reference('public.annual_accounts', new.annual_account_id, new.organization_id, 'annual_account_filings.annual_account_id');
  return new;
end; $$;

drop trigger if exists annual_account_filings_org_integrity on public.annual_account_filings;
create trigger annual_account_filings_org_integrity before insert or update on public.annual_account_filings
  for each row execute function public.enforce_annual_account_filings_org_integrity();

-- ── Backfill (valkuil 8) ─────────────────────────────────────────────────────
-- Deze migratie is bewust herbruikbaar over een eerdere toepassing heen: zij
-- dropt de oude signaturen van prepare_annual_accounts en file_annual_accounts
-- en voegt kolommen los toe. Een rij die onder die eerdere versie is gedeponeerd
-- heeft dus status='filed' met een filing_date, maar NUL kindrijen. Zonder
-- backfill telt file_annual_accounts nul vastgestelde deponeringen, waardoor
--   * refiling_required in list_annual_accounts en get_annual_account ten
--     onrechte true wordt (het scherm eist dan een herdeponering binnen acht
--     dagen die er wettelijk niet is), en
--   * file_annual_accounts een tweede, dubbele openbaarmaking toestaat van een
--     stuk dat al als vastgestelde jaarrekening is gedeponeerd.
-- Eén rij per bestaande deponering dus, mét de vlag uit filed_unadopted. Staat
-- bewust vóór de RPC's. De `not exists` maakt het blok herhaalbaar.
insert into public.annual_account_filings (
  organization_id, annual_account_id, filing_date, filing_reference, unadopted, note, created_by
)
select
  aa.organization_id,
  aa.id,
  aa.filing_date,
  aa.filing_reference,
  aa.filed_unadopted,
  'Aangevuld bij migratie 20260812010000 uit de samenvattingskolommen op annual_accounts: deze deponering dateert van vóór de deponeringsgeschiedenis.',
  aa.filed_by
from public.annual_accounts aa
where aa.status = 'filed'
  and aa.filing_date is not null
  and not exists (
    select 1 from public.annual_account_filings f
    where f.annual_account_id = aa.id
  );

-- ------------------------------------------------------------
-- 3. annual_account_signatures — art. 2:210 lid 2 BW
--    "De jaarrekening wordt ondertekend door de bestuurders en door de
--    commissarissen; ontbreekt de ondertekening van een of meer hunner, dan
--    wordt daarvan onder opgave van reden melding gemaakt."
--
--    Dat is dus geen enkel 'getekend'-vinkje maar een rij per persoon, en de
--    reden van een ontbrekende handtekening moet in het gedrukte stuk terecht
--    komen. Ondertekening kent overigens GEEN eigen wettelijke termijn (Hof
--    's-Hertogenbosch 13-9-2022): een in oktober opgemaakte jaarrekening mag
--    later worden getekend. Daarom staat er geen deadline op.
-- ------------------------------------------------------------
create table if not exists public.annual_account_signatures (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  annual_account_id uuid not null references public.annual_accounts(id) on delete cascade,
  person_name text not null
    constraint annual_account_signatures_person_name_check check (length(btrim(person_name)) > 0),
  role text not null
    constraint annual_account_signatures_role_check check (role in ('bestuurder','commissaris')),
  -- Optioneel: dezelfde persoon als in het aandeelhoudersregister (fase 4). Een
  -- bestuurder hoeft geen aandeelhouder te zijn, dus nullable en on delete set null.
  shareholder_id uuid references public.shareholders(id) on delete set null,
  signed boolean not null default false,
  signed_on date,
  signed_by uuid references auth.users(id) on delete set null,
  -- Verplicht zodra de jaarrekening wordt vastgesteld óf gedeponeerd terwijl deze
  -- persoon niet heeft getekend. Bewust GEEN CHECK: bij het opmaken bestaat de
  -- rij al voordat er getekend is, en dan is er nog niets te melden. De eis zit
  -- in adopt_annual_accounts én in file_annual_accounts.
  missing_reason text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint annual_account_signatures_signed_check
    check ((signed and signed_on is not null) or not signed),
  -- Benoemd, niet anoniem: de automatisch gegenereerde naam zou over de 63 tekens
  -- heen gaan en afgekapt worden, en dan is hij in het do-blok hieronder niet
  -- meer terug te vinden. Op deze unique leunt bovendien de dubbeldetectie in
  -- prepare_annual_accounts als tweede net.
  constraint annual_account_signatures_person_unique
    unique (annual_account_id, person_name, role)
);

-- Dezelfde discipline als bij annual_accounts (valkuil 7): de constraints ook
-- als los blok, voor een database waar deze tabel al bestond. De unique wordt op
-- KOLOMMEN gezocht en niet op naam — een eerdere toepassing kan haar onder een
-- automatisch gegenereerde (en afgekapte) naam hebben aangemaakt, en dan zou een
-- tweede identieke unique erbij komen.
do $$
declare
  v record;
begin
  for v in
    select * from (values
      ('annual_account_signatures_person_name_check',
       $c$check (length(btrim(person_name)) > 0)$c$),
      ('annual_account_signatures_role_check',
       $c$check (role in ('bestuurder','commissaris'))$c$),
      ('annual_account_signatures_signed_check',
       $c$check ((signed and signed_on is not null) or not signed)$c$)
    ) as t(conname, condef)
  loop
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.annual_account_signatures'::regclass
        and conname = v.conname
    ) then
      execute format('alter table public.annual_account_signatures add constraint %I %s', v.conname, v.condef);
    end if;
  end loop;

  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.annual_account_signatures'::regclass
      and c.contype = 'u'
      and (
        select array_agg(a.attname::text order by a.attname)
        from unnest(c.conkey) k
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k
      ) = array['annual_account_id','person_name','role']
  ) then
    alter table public.annual_account_signatures
      add constraint annual_account_signatures_person_unique
      unique (annual_account_id, person_name, role);
  end if;
end $$;

comment on table public.annual_account_signatures is
  'Eén rij per bestuurder en commissaris die de jaarrekening ondertekent (art. 2:210 lid 2 BW). Ontbreekt een handtekening, dan wordt daarvan melding gemaakt onder opgave van reden; die reden staat in missing_reason en wordt in het stuk afgedrukt.';

create index if not exists idx_annual_account_signatures_account
  on public.annual_account_signatures(annual_account_id, sort_order);

alter table public.annual_account_signatures enable row level security;
drop policy if exists "annual_account_signatures read" on public.annual_account_signatures;
create policy "annual_account_signatures read" on public.annual_account_signatures
  for select using (public.can_read_org(organization_id));

select public.apply_module_gate('annual_account_signatures', 'finance');

drop trigger if exists annual_account_signatures_touch_updated_at on public.annual_account_signatures;
create trigger annual_account_signatures_touch_updated_at before update on public.annual_account_signatures
  for each row execute function public.bookkeeping_touch_updated_at();
drop trigger if exists annual_account_signatures_prevent_org_change on public.annual_account_signatures;
create trigger annual_account_signatures_prevent_org_change before update of organization_id on public.annual_account_signatures
  for each row execute function public.prevent_organization_id_change();
drop trigger if exists annual_account_signatures_audit on public.annual_account_signatures;
create trigger annual_account_signatures_audit after insert or update or delete on public.annual_account_signatures
  for each row execute function public.audit_row_change('annual_account_signature', 'person_name');

-- ------------------------------------------------------------
-- 4. annual_account_statutory_deadlines — de termijnen op één plek
--
--    Alle wettelijke data van hoofdstuk 2 Titel 9 in één pure functie, zodat
--    list_annual_accounts, get_annual_account, het scherm en straks de
--    deadline-cron (brok E) exact dezelfde datums gebruiken. Geen org-guard:
--    de functie krijgt alleen kale datums mee en leest geen enkele tabel.
--
--      prepareDeadline          period_end + 5 maanden          art. 2:210 lid 1
--      prepareDeadlineExtended  + extension_months (max 5)      art. 2:210 lid 1
--      adoptDeadline            prepareDeadlineExtended + 2 mnd art. 2:394 lid 2
--      fileDeadlineAfterAdoption adoption_date + 8 dagen        art. 2:394 lid 1
--      fileDeadlineSafe         period_end + 10 mnd + 8 dagen   art. 2:394 lid 1
--                                                               jo. 2:210 lid 5
--                                                               — BETWIST
--      fileDeadlineHard         period_end + 12 maanden         art. 2:394 lid 3
--
--    Over fileDeadlineSafe: dit is de lijn van KVK voor een BV waarvan alle
--    aandeelhouders tevens bestuurder zijn — ondertekening is dan vaststelling,
--    dus de twee maanden van art. 2:394 lid 2 vervallen en er resteren acht
--    dagen na de opmaaktermijn. KVK noemt daarbij één datum: tien maanden en
--    acht dagen na afloop van het boekjaar, bij een kalenderboekjaar dus
--    8 november. Die lijn wordt hier LETTERLIJK gevolgd en dus NIET met
--    extension_months meegerekend — KVK rekent al met de maximale verlenging.
--    Hof 's-Hertogenbosch 13-9-2022 (ECLI:NL:GHSHE:2022:3141) oordeelde echter
--    dat ondertekening geen onderdeel is van het opmaken en dat de
--    twaalfmaandstermijn leidend blijft. Er is geen uitspraak van de Hoge Raad.
--    Vandaar de vlag isDisputed en de regel dat beide datums altijd samen worden
--    getoond.
--
--    En: de veilige datum verschijnt ALLEEN zolang er nog niet is vastgesteld.
--    Is de vaststelling er wel, dan geldt art. 2:394 lid 1 BW gewoon — acht
--    dagen ná die vaststelling — en dat is vrijwel altijd eerder. Een datum die
--    later valt dan de strengste toepasselijke termijn "veilig" noemen zou de
--    gebruiker precies het verkeerde vertellen: hij deponeert dan te laat in het
--    vertrouwen op het scherm, met art. 2:394 lid 3 jo. 2:248 lid 2 BW als
--    staart.
-- ------------------------------------------------------------
create or replace function public.annual_account_statutory_deadlines(
  p_period_end date,
  p_extension_months integer default 0,
  p_adoption_date date default null,
  p_all_shareholders_are_directors boolean default false
)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select case when p_period_end is null then '{}'::jsonb else jsonb_build_object(
    'prepareDeadline', (p_period_end + interval '5 months')::date,
    'prepareDeadlineExtended',
      (p_period_end + interval '5 months'
        + (least(greatest(coalesce(p_extension_months, 0), 0), 5) || ' months')::interval)::date,
    -- Art. 2:394 lid 2 BW: TWEE MAANDEN ná de opmaaktermijn — dus gerekend vanaf
    -- prepareDeadlineExtended, niet vanaf period_end + 7 maanden. Dat is geen
    -- cosmetisch verschil: maandrekenen in Postgres is niet associatief, want
    -- date + interval 'N months' houdt de dag-van-de-maand vast en KLEMT naar de
    -- laatste dag van de maand als die dag niet bestaat. Bij boekjaareinde
    -- 30-09-2025 geeft (d+5m)+2m = 28-02-2026 + 2m = 28-04-2026, terwijl d+7m
    -- op 30-04-2026 uitkomt: twee dagen ruimte die de wet niet geeft, met art.
    -- 2:394 lid 3 jo. 2:248 lid 2 BW als staart. Daarom eerst klemmen, dan pas
    -- de twee maanden erbij.
    'adoptDeadline',
      ((p_period_end + interval '5 months'
        + (least(greatest(coalesce(p_extension_months, 0), 0), 5) || ' months')::interval)::date
        + interval '2 months')::date,
    'fileDeadlineAfterAdoption',
      case when p_adoption_date is null then null else (p_adoption_date + 8) end,
    -- Alleen vóór de vaststelling, en dan de KVK-lijn zelf: tien maanden en acht
    -- dagen na afloop van het boekjaar, ongeacht een geregistreerde verlenging.
    'fileDeadlineSafe',
      case when coalesce(p_all_shareholders_are_directors, false) and p_adoption_date is null
        then (p_period_end + interval '10 months')::date + 8
        else null end,
    'fileDeadlineSafeDisputed',
      coalesce(p_all_shareholders_are_directors, false) and p_adoption_date is null,
    'fileDeadlineHard', (p_period_end + interval '12 months')::date,
    'disputeNote',
      'KVK houdt aan dat een BV waarvan alle aandeelhouders tevens bestuurder zijn binnen tien maanden en acht dagen na afloop van het boekjaar deponeert (art. 2:394 lid 1 jo. 2:210 lid 5 BW). Hof ''s-Hertogenbosch 13-9-2022 (ECLI:NL:GHSHE:2022:3141) oordeelde dat ondertekening geen onderdeel is van het opmaken en dat de termijn van twaalf maanden (art. 2:394 lid 3 BW) leidend blijft. Een uitspraak van de Hoge Raad ontbreekt; ResoFly toont beide datums en kiest niet.'
  ) end;
$$;

comment on function public.annual_account_statutory_deadlines(date, integer, date, boolean) is
  'De wettelijke termijnen rond een jaarrekening als jsonb: opmaken (art. 2:210 lid 1 BW), het moment waarop een niet vastgestelde jaarrekening alsnog moet worden gedeponeerd (art. 2:394 lid 2), acht dagen na vaststelling (lid 1), de betwiste DGA-datum en de harde buitengrens van twaalf maanden (lid 3). De betwiste datum (KVK: tien maanden en acht dagen na afloop van het boekjaar) komt alleen terug zolang er nog niet is vastgesteld; daarna is fileDeadlineAfterAdoption de strengste toepasselijke termijn.';

revoke all on function public.annual_account_statutory_deadlines(date, integer, date, boolean) from public, anon;
grant execute on function public.annual_account_statutory_deadlines(date, integer, date, boolean) to authenticated, service_role;

-- ------------------------------------------------------------
-- 5. build_annual_accounts_snapshot — de volledige onderbouwing, in één jsonb
--
--    Alles wat het stuk nodig heeft om zichzelf te kunnen verantwoorden:
--      * de rechtspersoon (naam, rechtsvorm, KvK, statutaire zetel)
--      * het boekjaar en het vergelijkende boekjaar
--      * de balans ná resultaatbestemming, vergelijkend, mét de mutatie die de
--        bestemming aanbracht, plus de sluitcontrole
--      * het verloop van het eigen vermogen (begin, mutatie, eind) met de
--        wettelijke en statutaire reserves apart
--      * de winst-en-verliesrekening, vergelijkend
--      * de uitkomst van de groottetoets, inclusief waarschuwingen
--      * het resultaatbestemmingsbesluit
--      * de Vpb-berekening, als die er is
--      * de aansluitcontrole op de proefbalans (Σ debet = Σ credit)
--      * het vrij uitkeerbaar vermogen en de aandeelhoudersposities
--
--    Deze functie is de ENIGE plek waar de rapport-RPC's voor een jaarrekening
--    worden aangeroepen. Ná het opmaken wordt zij niet meer gebruikt: dan komt
--    alles uit annual_accounts.snapshot. Zij mag wél los worden aangeroepen als
--    voorbeeld/concept — dat is precies hetzelfde beeld, maar dan ongehashed.
--
--    KOSTEN: report_balance_sheet_after_appropriation en
--    report_profit_and_loss_comparative worden elk ÉÉN keer aangeroepen, met
--    meerdere aggregaten over dezelfde doorloop. Wie hier een tweede aanroep
--    toevoegt, verdubbelt een volledige scan over journal_lines.
-- ------------------------------------------------------------
create or replace function public.build_annual_accounts_snapshot(
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
  v_prev public.fiscal_years;
  v_has_prev boolean := false;
  -- Bewust losse variabelen en geen record: een SELECT INTO die niets oplevert
  -- laat een record-variabele zonder tuple-structuur achter, en dan valt de
  -- functie om op "record is not assigned yet" in plaats van netjes null te
  -- geven. Een organisatie zónder company_settings komt hier niet eens: dan is
  -- org_fiscal_regime niet 'vpb' en is er hierboven al geweigerd.
  v_org_name text;
  v_company_name text;
  v_trade_name text;
  v_legal_form text;
  v_kvk text;
  v_vat text;
  v_addr1 text;
  v_addr2 text;
  v_postal text;
  v_city text;
  v_country text;

  v_balance jsonb := '[]'::jsonb;
  v_equity jsonb := '[]'::jsonb;
  v_assets bigint := 0;
  v_liab_equity bigint := 0;

  v_pl jsonb := '[]'::jsonb;

  v_tb_debit bigint := 0;
  v_tb_credit bigint := 0;

  v_size jsonb;
  v_ra public.result_appropriations;
  v_has_ra boolean := false;
  v_ct public.corporate_tax_returns;
  v_has_ct boolean := false;

  v_distributable bigint;
  v_shareholders jsonb := '[]'::jsonb;
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  if not public.org_has_business(p_organization_id) then
    raise exception 'De jaarrekening hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;
  if public.org_fiscal_regime(p_organization_id) <> 'vpb' then
    raise exception 'Een jaarrekening volgens Titel 9 Boek 2 BW hoort bij een BV, NV of coöperatie. Pas eerst de rechtsvorm aan bij Instellingen → Bedrijfsgegevens.'
      using errcode = '23514';
  end if;

  select * into v_fy from public.fiscal_years fy
  where fy.id = p_fiscal_year_id and fy.organization_id = p_organization_id;
  if not found then
    raise exception 'Boekjaar niet gevonden.' using errcode = '02000';
  end if;

  -- De balans ná resultaatbestemming bestaat alleen voor een afgesloten
  -- boekjaar. Die controle staat óók in report_balance_sheet_after_appropriation,
  -- maar hier komt hij mét de knop erbij die de gebruiker moet indrukken.
  if v_fy.status <> 'closed' then
    raise exception 'Sluit boekjaar % eerst af (Boekjaren → Boekjaar afsluiten). Een jaarrekening wordt opgemaakt op de afgesloten cijfers; zolang het jaar open staat, staat het resultaat nog op de opbrengst- en kostenrekeningen.', v_fy.label
      using errcode = '23514';
  end if;

  select * into v_prev from public.fiscal_years fy
  where fy.organization_id = p_organization_id
    and fy.period_end < v_fy.period_start
  order by fy.period_end desc
  limit 1;
  v_has_prev := found;

  select o.name into v_org_name from public.organizations o where o.id = p_organization_id;
  select cs.company_name, cs.trade_name, cs.legal_form, cs.kvk_number, cs.vat_number,
         cs.address_line1, cs.address_line2, cs.postal_code, cs.city, cs.country
    into v_company_name, v_trade_name, v_legal_form, v_kvk, v_vat,
         v_addr1, v_addr2, v_postal, v_city, v_country
  from public.company_settings cs
  where cs.organization_id = p_organization_id;

  -- ── Balans ná resultaatbestemming ─────────────────────────────────────────
  -- Eén doorloop, drie uitkomsten: de regels, het verloop van het eigen
  -- vermogen, en de twee balanstotalen voor de sluitcontrole. De join op
  -- ledger_accounts is een LEFT join: de RPC levert alleen bestaande rekeningen,
  -- maar een inner join zou bij een onverwachte rij stil een regel laten vallen
  -- en dan klopt het balanstotaal niet meer.
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'accountId', b.account_id,
      'code', b.code,
      'name', b.name,
      'section', b.section,
      'reportGroup', b.report_group,
      'groupRank', b.group_rank,
      'amountCents', b.amount_cents,
      'amountPrevCents', b.amount_prev_cents,
      'appropriationDeltaCents', b.appropriation_delta_cents,
      'isRestrictedReserve', coalesce(la.is_restricted_reserve, false),
      'subtype', la.subtype
    ) order by b.group_rank, b.code), '[]'::jsonb),
    coalesce(jsonb_agg(jsonb_build_object(
      'accountId', b.account_id,
      'code', b.code,
      'name', b.name,
      'openingCents', b.amount_prev_cents,
      'movementCents', b.amount_cents - b.amount_prev_cents,
      'closingCents', b.amount_cents,
      'appropriationDeltaCents', b.appropriation_delta_cents,
      -- Wettelijke en statutaire reserves horen in de toelichting APART te
      -- staan; ze bepalen bovendien de uitkeerbare ruimte (art. 2:216 lid 1 BW).
      'isRestrictedReserve', coalesce(la.is_restricted_reserve, false),
      'subtype', la.subtype
    ) order by b.code) filter (where b.section = 'equity'), '[]'::jsonb),
    coalesce(sum(case when b.section = 'asset' then b.amount_cents else 0 end), 0)::bigint,
    coalesce(sum(case when b.section <> 'asset' then b.amount_cents else 0 end), 0)::bigint
  into v_balance, v_equity, v_assets, v_liab_equity
  from public.report_balance_sheet_after_appropriation(p_organization_id, p_fiscal_year_id) b
  left join public.ledger_accounts la on la.id = b.account_id;

  -- ── Winst-en-verliesrekening, vergelijkend ────────────────────────────────
  -- Subtotalen worden hier bewust NIET gemaakt: die volgen uit de rubrieken en
  -- horen bij de renderer. "Bedrijfsresultaat" is bovendien praktijk/RJ en geen
  -- wettelijke modelregel; zo'n label hoort niet uit de database te komen.
  select coalesce(jsonb_agg(jsonb_build_object(
    'accountId', pl.account_id,
    'code', pl.code,
    'name', pl.name,
    'accountType', pl.account_type,
    'reportGroup', pl.report_group,
    'groupRank', pl.group_rank,
    'amountCents', pl.amount_cents,
    'amountPrevCents', pl.amount_prev_cents
  ) order by pl.group_rank, pl.code), '[]'::jsonb)
  into v_pl
  from public.report_profit_and_loss_comparative(p_organization_id, p_fiscal_year_id) pl;

  -- ── Aansluitcontrole op de proefbalans ────────────────────────────────────
  -- De proefbalans telt het year_close-boekstuk mee, dus Σ debet moet gelijk
  -- zijn aan Σ credit. Een verschil betekent dat er iets grondig mis is met het
  -- grootboek en dan mag er niets bevroren worden.
  select coalesce(sum(tb.debit_cents), 0)::bigint, coalesce(sum(tb.credit_cents), 0)::bigint
  into v_tb_debit, v_tb_credit
  from public.report_trial_balance(p_organization_id, v_fy.period_end) tb;

  v_size := public.determine_company_size(p_organization_id, p_fiscal_year_id);

  select * into v_ra from public.result_appropriations ra
  where ra.organization_id = p_organization_id
    and ra.fiscal_year_id = p_fiscal_year_id
    and ra.status = 'posted';
  v_has_ra := found;

  select * into v_ct from public.corporate_tax_returns ct
  where ct.organization_id = p_organization_id
    and ct.fiscal_year_id = p_fiscal_year_id
    and ct.status <> 'reversed';
  v_has_ct := found;

  v_distributable := public.org_distributable_equity(p_organization_id, v_fy.period_end);

  select coalesce(jsonb_agg(jsonb_build_object(
    'shareholderId', sp.shareholder_id,
    'name', sp.name,
    'kind', sp.kind,
    'shareClass', sp.share_class,
    'shares', sp.shares,
    'nominalCents', sp.nominal_cents,
    'paidUpCents', sp.paid_up_cents,
    'shareBasisPoints', sp.share_basis_points
  ) order by sp.name, sp.share_class), '[]'::jsonb)
  into v_shareholders
  from public.shareholder_positions(p_organization_id, v_fy.period_end) sp;

  return jsonb_build_object(
    'version', 1,
    'generatedAt', now(),
    'entity', jsonb_build_object(
      'organizationId', p_organization_id,
      'organizationName', v_org_name,
      'companyName', coalesce(nullif(btrim(coalesce(v_company_name, '')), ''), v_org_name),
      'tradeName', v_trade_name,
      'legalForm', coalesce(v_legal_form, public.org_legal_form(p_organization_id)),
      'kvkNumber', v_kvk,
      'vatNumber', v_vat,
      'addressLine1', v_addr1,
      'addressLine2', v_addr2,
      'postalCode', v_postal,
      'city', v_city,
      'country', v_country
    ),
    'fiscalYear', jsonb_build_object(
      'id', v_fy.id,
      'label', v_fy.label,
      'periodStart', v_fy.period_start,
      'periodEnd', v_fy.period_end,
      'status', v_fy.status,
      'resultCents', v_fy.result_cents,
      'resultAccountCode', v_fy.result_account_code
    ),
    'previousFiscalYear', case when v_has_prev then jsonb_build_object(
      'id', v_prev.id,
      'label', v_prev.label,
      'periodStart', v_prev.period_start,
      'periodEnd', v_prev.period_end,
      'status', v_prev.status
    ) end,
    'balanceSheetAfterAppropriation', jsonb_build_object(
      'rows', v_balance,
      'totalAssetsCents', v_assets,
      'totalEquityAndLiabilitiesCents', v_liab_equity,
      'differenceCents', v_assets - v_liab_equity,
      'balances', (v_assets - v_liab_equity) = 0
    ),
    'equityMovement', v_equity,
    'profitAndLossComparative', jsonb_build_object('rows', v_pl),
    -- De RAUWE uitkomst van de groottetoets. prepare_annual_accounts vult hier
    -- vóór het bevriezen appliedSizeClass, manualOverride en
    -- manualOverrideReason bij: de klasse waarop het stuk werkelijk berust kan
    -- afwijken van de berekende (handmatige klasse bij een groepsstructuur), en
    -- de PDF haalt álles uit de snapshot. Wie hier alleen 'sizeClass' leest,
    -- drukt bij de overrideroute de verkeerde klasse af — of null.
    'size', v_size,
    'resultAppropriation', case when v_has_ra then jsonb_build_object(
      'id', v_ra.id,
      'decisionDate', v_ra.decision_date,
      'resultCents', v_ra.result_cents,
      'reservesCents', v_ra.reserves_cents,
      'dividendCents', v_ra.dividend_cents,
      'reservesAccountCode', v_ra.reserves_account_code,
      'dividendAccountCode', v_ra.dividend_account_code,
      'distributableCents', v_ra.distributable_cents,
      'boardApproved', v_ra.board_approved,
      'journalEntryId', v_ra.journal_entry_id,
      'note', v_ra.note
    ) end,
    'corporateTax', case when v_has_ct then jsonb_build_object(
      'id', v_ct.id,
      'year', v_ct.year,
      'status', v_ct.status,
      'commercialResultCents', v_ct.commercial_result_cents,
      'correctionsCents', v_ct.corrections_cents,
      'fiscalProfitCents', v_ct.fiscal_profit_cents,
      'lossUsedCents', v_ct.loss_used_cents,
      'taxableAmountCents', v_ct.taxable_amount_cents,
      'taxCents', v_ct.tax_cents,
      'computation', v_ct.computation
    ) end,
    'reconciliation', jsonb_build_object(
      'trialBalanceDebitCents', v_tb_debit,
      'trialBalanceCreditCents', v_tb_credit,
      'trialBalanceDifferenceCents', v_tb_debit - v_tb_credit,
      'trialBalanceBalances', (v_tb_debit - v_tb_credit) = 0,
      'balanceSheetDifferenceCents', v_assets - v_liab_equity,
      'balanceSheetBalances', (v_assets - v_liab_equity) = 0,
      'balances', (v_tb_debit - v_tb_credit) = 0 and (v_assets - v_liab_equity) = 0
    ),
    -- Let op bij het gebruik in de toelichting: org_distributable_equity telt
    -- uitsluitend EQUITY-rekeningen op de balansdatum. Het is dus NIET "het
    -- volledige vrij uitkeerbare vermogen" — het resultaat van een lopend
    -- boekjaar zit er niet in. Nooit anders presenteren.
    'distributableEquityCents', v_distributable,
    'shareholders', v_shareholders,
    'disclaimer', 'Opgesteld met ResoFly als hulpmiddel. Geen accountantsproduct en geen fiscaal of juridisch advies; de rechtspersoon blijft verantwoordelijk voor de inhoud van de jaarrekening.'
  );
end;
$$;

comment on function public.build_annual_accounts_snapshot(uuid, uuid) is
  'De volledige onderbouwing van een jaarrekening als jsonb: rechtspersoon, boekjaar, balans ná resultaatbestemming met vergelijkende kolom en sluitcontrole, verloop eigen vermogen, W&V vergelijkend, groottetoets, resultaatbestemming, Vpb-berekening en de aansluitcontrole op de proefbalans. Wordt door prepare_annual_accounts bevroren en gehasht; daarna nooit meer live bevraagd.';

revoke all on function public.build_annual_accounts_snapshot(uuid, uuid) from public, anon;
grant execute on function public.build_annual_accounts_snapshot(uuid, uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 5b. annual_account_snapshot_stale — is de bevroren onderbouwing nog waar?
--
--     De cijfers in snapshot zijn bevroren, de administratie niet. Drie dingen
--     kunnen ze uit elkaar laten lopen:
--       * het boekjaar staat niet meer op 'closed' (heropend);
--       * het boekjaar is ná het opmaken heropend en opnieuw afgesloten, dus met
--         andere cijfers;
--       * de geboekte resultaatbestemming is niet meer dezelfde rij als die in
--         de snapshot. Dat kan: boven een GEDEPONEERDE jaarrekening mogen het
--         boekjaar en de resultaatbestemming weer open (kernbeslissing G), want
--         anders zou het opvolgende stuk dezelfde cijfers moeten herhalen.
--         Precies dan loopt het gedeponeerde stuk zichtbaar uit de pas — en dat
--         is de bedoeling: het scherm markeert het en het opvolgende stuk
--         verwerkt de correctie.
--
--     Deze functie is de enige plek waar dat wordt gemeten. list_annual_accounts
--     en get_annual_account geven de uitkomst terug zodat het scherm kan
--     markeren; adopt_annual_accounts en file_annual_accounts weigeren erop —
--     een stuk dat niet meer bij de administratie past, mag niet worden
--     vastgesteld of gedeponeerd.
--
--     MÉT org-guard, ook al roepen alleen functies met eigen rechtencontrole haar
--     aan. Zij is security definer en staat met `grant execute to authenticated`
--     rechtstreeks als RPC op PostgREST: zonder guard kan elke ingelogde
--     gebruiker met een willekeurige uuid vragen of er ergens — in wélke
--     organisatie dan ook — een jaarrekening bestaat waarvan het boekjaar is
--     heropend of de bestemming vervangen. Klein lek, maar wel het enige pad in
--     dit bestand dat het huispatroon doorbreekt, en dezelfde klasse als het
--     klantcontacten-lek. De organisatie wordt uit de rij zelf gehaald, dus de
--     aanroepende functies hoeven niets extra's mee te geven; een onbekend id
--     geeft gewoon false terug en verraadt daarmee niets.
-- ------------------------------------------------------------
create or replace function public.annual_account_snapshot_stale(
  p_annual_account_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_stale boolean;
begin
  select aa.organization_id into v_org
  from public.annual_accounts aa
  where aa.id = p_annual_account_id;
  if v_org is null then
    return false;
  end if;

  if auth.role() <> 'service_role'
     and not (public.can_read_org(v_org) and public.can_read_module(v_org, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select exists (
    select 1
    from public.annual_accounts aa
    join public.fiscal_years fy on fy.id = aa.fiscal_year_id
    where aa.id = p_annual_account_id
      and (
        fy.status <> 'closed'
        or (fy.reopened_at is not null and fy.reopened_at > aa.created_at)
        or coalesce((
              select ra.id::text
              from public.result_appropriations ra
              where ra.organization_id = aa.organization_id
                and ra.fiscal_year_id = aa.fiscal_year_id
                and ra.status = 'posted'
              limit 1
            ), '')
           is distinct from coalesce(aa.snapshot -> 'resultAppropriation' ->> 'id', '')
      )
  ) into v_stale;

  return v_stale;
end;
$$;

comment on function public.annual_account_snapshot_stale(uuid) is
  'True zodra de bevroren onderbouwing van een jaarrekening niet meer bij de administratie past: het boekjaar staat niet meer op closed, het is ná het opmaken heropend, of de geboekte resultaatbestemming is een andere rij dan die in de snapshot. Het scherm markeert dit; vaststellen en deponeren weigeren erop.';

revoke all on function public.annual_account_snapshot_stale(uuid) from public, anon;
grant execute on function public.annual_account_snapshot_stale(uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 6. prepare_annual_accounts — het bestuur maakt op (art. 2:210 lid 1 BW)
--
--    Hier ontstaat de rij, hier worden de cijfers bevroren en hier klinkt de
--    opmaaktermijn vast. De functie weigert als:
--      * het boekjaar niet is afgesloten
--      * er geen resultaatbestemming is geboekt
--      * determine_company_size een blokkerende reden geeft (en er geen
--        onderbouwde handmatige klasse is meegegeven)
--      * de balans ná bestemming niet sluit, of de proefbalans niet aansluit
--      * er al een jaarrekening voor dit boekjaar in behandeling is (opgemaakt
--        of vastgesteld)
--      * er voor dit boekjaar al een GEDEPONEERDE jaarrekening ligt en niet is
--        meegegeven welke dit stuk vervangt, mét reden (kernbeslissing G)
--    Elke weigering noemt de knop die de gebruiker éérst moet indrukken.
--
--    p_all_shareholders_are_directors staat hier en niet alleen op
--    adopt_annual_accounts: het is een FEITELIJKE bevestiging over de
--    aandeelhoudersstructuur, geen vaststellingsbesluit. De betwiste veilige
--    deponeerdatum (kernbeslissing E) stuurt juist in de fase waarin er nog niet
--    is vastgesteld, en zou anders nooit op tijd in beeld komen. De drie
--    voorwaarden van art. 2:210 lid 5 BW blijven wél bij het vaststellen — die
--    hangen aan het besluit, niet aan de structuur.
-- ------------------------------------------------------------
-- De oude signatuur eerst weg: er komen drie parameters bij en "create or
-- replace" zou daar een tweede overload van maken, met grants op alleen de ene.
drop function if exists public.prepare_annual_accounts(uuid, uuid, date, text, jsonb, text, text, text, text, text, uuid);

create or replace function public.prepare_annual_accounts(
  p_organization_id uuid,
  p_fiscal_year_id uuid,
  p_prepared_on date default current_date,
  p_accounting_basis text default 'commercieel',
  -- [{ "name": "...", "role": "bestuurder"|"commissaris", "shareholderId": "uuid"|null }]
  p_signatories jsonb default '[]'::jsonb,
  p_off_balance_commitments text default null,
  p_policy_change_note text default null,
  p_size_class_override text default null,
  p_size_override_reason text default null,
  p_note text default null,
  p_created_by uuid default auth.uid(),
  -- Feitelijke bevestiging (art. 2:210 lid 5 BW jo. de KVK-lijn): zijn alle
  -- aandeelhouders tevens bestuurder? Zo ja, dan verschijnt de betwiste veilige
  -- deponeerdatum vanaf nu — dus in de fase waarin zij ertoe doet.
  p_all_shareholders_are_directors boolean default false,
  -- Kernbeslissing G: welke GEDEPONEERDE jaarrekening dit stuk vervangt, en
  -- waarom. Verplicht zodra er voor dit boekjaar al is gedeponeerd.
  p_supersedes_annual_account_id uuid default null,
  p_supersede_reason text default null
)
returns public.annual_accounts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fy public.fiscal_years;
  v_existing public.annual_accounts;
  v_filed public.annual_accounts;
  v_has_filed boolean := false;
  v_supersedes public.annual_accounts;
  v_supersede_reason text := nullif(btrim(coalesce(p_supersede_reason, '')), '');
  v_row public.annual_accounts;
  v_size jsonb;
  v_size_class text;
  v_blocking text;
  v_override text := nullif(btrim(coalesce(p_size_class_override, '')), '');
  v_override_reason text := nullif(btrim(coalesce(p_size_override_reason, '')), '');
  v_effective text;
  v_basis text := coalesce(nullif(btrim(coalesce(p_accounting_basis, '')), ''), 'commercieel');
  v_snapshot jsonb;
  v_prepared_on date := coalesce(p_prepared_on, current_date);
  -- Kernbeslissing J: de handelende gebruiker komt uit auth.uid(). p_created_by
  -- telt alleen voor service_role (de edge functions); een ingelogde gebruiker
  -- kan dus niet iemand anders als opmaker in het stuk zetten.
  v_actor uuid := case
    when auth.role() = 'service_role' then coalesce(p_created_by, auth.uid())
    else auth.uid() end;
  v_line jsonb;
  v_name text;
  v_role text;
  v_shareholder uuid;
  v_index integer := 0;
  v_directors integer := 0;
begin
  if auth.role() <> 'service_role'
     and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  if not public.org_has_business(p_organization_id) then
    raise exception 'De jaarrekening hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;
  if public.org_fiscal_regime(p_organization_id) <> 'vpb' then
    raise exception 'Een jaarrekening volgens Titel 9 Boek 2 BW hoort bij een BV, NV of coöperatie. Pas eerst de rechtsvorm aan bij Instellingen → Bedrijfsgegevens.'
      using errcode = '23514';
  end if;

  -- Dezelfde lock als de jaarafsluiting en de resultaatbestemming: opmaken,
  -- afsluiten, heropenen en bestemmen mogen elkaar niet kruisen.
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':fyclose'));

  select * into v_fy from public.fiscal_years fy
  where fy.id = p_fiscal_year_id and fy.organization_id = p_organization_id
  for update;
  if not found then
    raise exception 'Boekjaar niet gevonden.' using errcode = '02000';
  end if;

  if v_fy.status <> 'closed' then
    raise exception 'Sluit boekjaar % eerst af (Boekjaren → Boekjaar afsluiten) voordat je de jaarrekening opmaakt. Zolang het jaar open staat, staat het resultaat nog op de opbrengst- en kostenrekeningen en is er niets te bestemmen.', v_fy.label
      using errcode = '23514';
  end if;

  -- Al een stuk IN BEHANDELING? De partiële unique index vangt dit ook, maar dan
  -- met een onbegrijpelijke foutmelding.
  select * into v_existing from public.annual_accounts aa
  where aa.fiscal_year_id = p_fiscal_year_id
    and aa.organization_id = p_organization_id
    and aa.status in ('prepared','adopted')
  limit 1;
  if found then
    raise exception 'Voor boekjaar % ligt al een jaarrekening (status: %). Laat een eigenaar of beheerder haar eerst intrekken ("Jaarrekening intrekken") voordat je opnieuw opmaakt.',
      v_fy.label,
      case v_existing.status
        when 'prepared' then 'opgemaakt'
        when 'adopted' then 'vastgesteld'
        else v_existing.status end
      using errcode = '23505';
  end if;

  -- ── Het opvolgende stuk (kernbeslissing G) ────────────────────────────────
  -- Ligt er voor dit boekjaar al een GEDEPONEERDE jaarrekening, dan is dit stuk
  -- per definitie een vervanging. Dat moet expliciet: welk stuk wordt vervangen,
  -- en waarom. De deponering zelf blijft staan — die is een feit.
  select * into v_filed from public.annual_accounts aa
  where aa.fiscal_year_id = p_fiscal_year_id
    and aa.organization_id = p_organization_id
    and aa.status = 'filed'
  order by aa.filing_date desc nulls last, aa.created_at desc
  limit 1;
  v_has_filed := found;

  if v_has_filed and p_supersedes_annual_account_id is null then
    raise exception 'Voor boekjaar % is op % al een jaarrekening gedeponeerd. Die deponering blijft staan (art. 2:394 BW); een nieuw stuk vervangt haar. Geef bij "Jaarrekening opmaken" aan dat dit stuk de gedeponeerde jaarrekening van % vervangt, en leg vast waarom.',
      v_fy.label, to_char(v_filed.filing_date, 'DD-MM-YYYY'), to_char(v_filed.filing_date, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;

  if p_supersedes_annual_account_id is not null then
    if not v_has_filed then
      raise exception 'Er is voor boekjaar % geen gedeponeerde jaarrekening die dit stuk kan vervangen. Maak gewoon op zonder vervanging.', v_fy.label
        using errcode = '23514';
    end if;

    select * into v_supersedes from public.annual_accounts aa
    where aa.id = p_supersedes_annual_account_id
      and aa.organization_id = p_organization_id;
    if not found then
      raise exception 'De jaarrekening die dit stuk zou vervangen, bestaat niet in deze administratie.' using errcode = '02000';
    end if;
    if v_supersedes.fiscal_year_id <> p_fiscal_year_id then
      raise exception 'De jaarrekening die dit stuk vervangt, hoort bij een ander boekjaar. Een jaarrekening vervangt alleen een stuk over hetzelfde boekjaar.'
        using errcode = '23514';
    end if;
    if v_supersedes.status <> 'filed' then
      raise exception 'Alleen een GEDEPONEERDE jaarrekening wordt vervangen; een stuk dat nog niet is gedeponeerd wordt ingetrokken. Laat een eigenaar of beheerder dat doen met "Jaarrekening intrekken".'
        using errcode = '23514';
    end if;
    if v_supersede_reason is null then
      raise exception 'Leg vast waarom de op % gedeponeerde jaarrekening van boekjaar % wordt vervangen. Zonder die reden is later niet na te gaan waarom er twee jaarrekeningen over hetzelfde boekjaar bij het handelsregister liggen.',
        to_char(v_supersedes.filing_date, 'DD-MM-YYYY'), v_fy.label
        using errcode = '23514';
    end if;
  end if;

  -- Art. 2:210 lid 3 jo. de resultaatbestemming: de balans in de jaarrekening
  -- staat ná bestemming. Zonder besluit zou het onverdeeld resultaat blijven
  -- staan en zou het stuk iets anders tonen dan wat wordt vastgesteld.
  if not exists (
    select 1 from public.result_appropriations ra
    where ra.organization_id = p_organization_id
      and ra.fiscal_year_id = p_fiscal_year_id
      and ra.status = 'posted'
  ) then
    raise exception 'Leg eerst de resultaatbestemming van boekjaar % vast (Boekjaren → Resultaat bestemmen). De balans in de jaarrekening staat ná bestemming; zonder dat besluit zou het onverdeeld resultaat op de balans blijven staan.', v_fy.label
      using errcode = '23514';
  end if;

  if v_prepared_on < v_fy.period_end then
    raise exception 'De jaarrekening kan niet zijn opgemaakt op %, vóór de balansdatum %. Corrigeer de datum van opmaken.',
      to_char(v_prepared_on, 'DD-MM-YYYY'), to_char(v_fy.period_end, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;
  if v_prepared_on > current_date then
    raise exception 'De datum van opmaken kan niet in de toekomst liggen.' using errcode = '23514';
  end if;

  if v_basis not in ('commercieel','fiscaal') then
    raise exception 'Onbekende waarderingsgrondslag: %. Kies "commercieel" of "fiscaal".', v_basis
      using errcode = '23514';
  end if;

  if v_override is not null and v_override not in ('micro','klein','middelgroot','groot') then
    raise exception 'Onbekende grootteklasse: %. Kies micro, klein, middelgroot of groot.', v_override
      using errcode = '23514';
  end if;
  if v_override is not null and v_override_reason is null then
    raise exception 'Leg vast waaróm de grootteklasse handmatig op "%" wordt gezet. Zonder onderbouwing is de klasse bij een controle niet te verdedigen (art. 2:395a/396/397 lid 1 BW).', v_override
      using errcode = '23514';
  end if;

  -- ── De grootteklasse ──────────────────────────────────────────────────────
  v_size := public.determine_company_size(p_organization_id, p_fiscal_year_id);
  v_size_class := nullif(v_size ->> 'sizeClass', '');
  v_blocking := nullif(v_size ->> 'blockingReason', '');

  if v_blocking is not null and v_override is null then
    raise exception 'De grootteklasse van boekjaar % kan niet worden bepaald, en die bepaalt wat er moet worden opgemaakt, gecontroleerd en gedeponeerd. %  Los dit op bij de groottegegevens van het betreffende boekjaar, of leg de klasse hier handmatig vast met een onderbouwing.',
      v_fy.label, v_blocking
      using errcode = '23514';
  end if;

  -- Zonder berekende klasse maar mét onderbouwde handmatige klasse: die wint.
  -- De blokkerende reden blijft in size_basis staan, zodat achteraf zichtbaar is
  -- dat de klasse op een uitspraak van de gebruiker berust en niet op een
  -- berekening.
  v_effective := coalesce(v_override, v_size_class);
  if v_effective is null then
    raise exception 'De grootteklasse van boekjaar % is niet bepaald. Vul de groottegegevens aan of leg de klasse handmatig vast met een onderbouwing.', v_fy.label
      using errcode = '23514';
  end if;

  -- Art. 2:396 lid 6 BW (klein) en art. 2:395a lid 7 BW (micro): fiscale
  -- waarderingsgrondslagen zijn alleen voor die twee klassen opengesteld, en dan
  -- nog alles-of-niets. Voor middelgroot en groot bestaat de route niet.
  --
  -- Deze melding noemt de overrideroute BEWUST NIET. De grootteklasse is geen
  -- keuze maar de uitkomst van de tweejaarstoets (art. 2:395a/396/397 lid 1 BW);
  -- size_class_override bestaat voor het geval de BEREKENING vastloopt, niet als
  -- knop om een wettelijke beperking mee te omzeilen. De overrideroute staat in
  -- de weigering hierboven, over de niet te bepalen klasse — daar hoort zij.
  if v_basis = 'fiscaal' and v_effective not in ('micro','klein') then
    raise exception 'Waarderen op fiscale grondslagen is voorbehouden aan een kleine (art. 2:396 lid 6 BW) of micro-rechtspersoon (art. 2:395a lid 7 BW); deze rechtspersoon is %. Kies "commercieel".', v_effective
      using errcode = '23514';
  end if;

  -- ── De cijfers ────────────────────────────────────────────────────────────
  -- build_annual_accounts_snapshot roept report_balance_sheet_after_appropriation
  -- aan, en die weigert al bij een niet-sluitende balans of een resterend
  -- "Resultaat lopend boekjaar". De controle hieronder is het vangnet: bevriezen
  -- van cijfers die niet aansluiten mag onder geen beding.
  v_snapshot := public.build_annual_accounts_snapshot(p_organization_id, p_fiscal_year_id);

  -- De TOEGEPASTE grootteklasse hoort ín de bevroren onderbouwing, niet alleen
  -- ernaast in size_basis. De PDF haalt alles uit snapshot en nooit uit een live
  -- query; een renderer die snapshot -> 'size' ->> 'sizeClass' leest, zou bij de
  -- overrideroute null of juist de afgewezen berekening afdrukken. Vandaar dat
  -- 'size' hier wordt verrijkt VÓÓRDAT de hash wordt gezet, zodat de hash ook
  -- over de toegepaste klasse gaat. size_basis krijgt daarna exact hetzelfde
  -- object, zodat er maar één waarheid is.
  v_snapshot := jsonb_set(
    v_snapshot,
    '{size}',
    coalesce(v_snapshot -> 'size', '{}'::jsonb) || jsonb_build_object(
      'appliedSizeClass', v_effective,
      'manualOverride', v_override,
      'manualOverrideReason', v_override_reason
    )
  );

  if not coalesce((v_snapshot -> 'reconciliation' ->> 'balances')::boolean, false) then
    raise exception 'De cijfers van boekjaar % sluiten niet aan (balansverschil % cent, proefbalansverschil % cent). Controleer het grootboek en het bestemmingsboekstuk; een jaarrekening met een niet-sluitende balans mag niet worden opgemaakt.',
      v_fy.label,
      coalesce(v_snapshot -> 'reconciliation' ->> 'balanceSheetDifferenceCents', '?'),
      coalesce(v_snapshot -> 'reconciliation' ->> 'trialBalanceDifferenceCents', '?')
      using errcode = '23514';
  end if;

  insert into public.annual_accounts (
    organization_id, fiscal_year_id, created_by, status,
    prepared_on, prepared_by, prepare_deadline,
    all_shareholders_are_directors,
    supersedes_annual_account_id, supersede_reason,
    size_class, size_class_override, size_override_reason, size_basis,
    accounting_basis, policy_change_note, off_balance_commitments,
    audit_required,
    snapshot, snapshot_hash, snapshot_version, note
  ) values (
    p_organization_id, p_fiscal_year_id, v_actor, 'prepared',
    v_prepared_on, v_actor,
    -- Art. 2:210 lid 1 BW: vijf maanden na afloop van het boekjaar. Een
    -- verlenging komt er apart bij (extend_preparation_term).
    (v_fy.period_end + interval '5 months')::date,
    coalesce(p_all_shareholders_are_directors, false),
    p_supersedes_annual_account_id, v_supersede_reason,
    -- size_class houdt de klasse vast waarop dít stuk berust; de berekende én de
    -- handmatige route staan allebei in size_basis — en in snapshot -> 'size',
    -- want dat is hetzelfde object.
    v_effective, v_override, v_override_reason,
    v_snapshot -> 'size',
    v_basis,
    nullif(btrim(coalesce(p_policy_change_note, '')), ''),
    nullif(btrim(coalesce(p_off_balance_commitments, '')), ''),
    -- Art. 2:393 lid 1 BW: middelgroot en groot moeten laten controleren. Als
    -- determine_company_size bewust geen uitspraak deed (groepsstructuur), dan
    -- volgt de plicht hier uit de klasse waarop dit stuk berust — inclusief een
    -- eventuele handmatige klasse, want die is nu de klasse van de jaarrekening.
    v_effective in ('middelgroot','groot'),
    v_snapshot,
    encode(sha256(convert_to(v_snapshot::text, 'UTF8')), 'hex'),
    1,
    nullif(btrim(coalesce(p_note, '')), '')
  )
  returning * into v_row;

  -- ── De ondertekenaars ─────────────────────────────────────────────────────
  -- Art. 2:210 lid 2 BW: alle bestuurders en alle commissarissen. De rijen
  -- ontstaan hier ongetekend; sign_annual_accounts zet ze om.
  if p_signatories is null or jsonb_typeof(p_signatories) <> 'array' or jsonb_array_length(p_signatories) = 0 then
    raise exception 'Geef de bestuurders (en eventuele commissarissen) op die de jaarrekening ondertekenen. De jaarrekening wordt ondertekend door de bestuurders en door de commissarissen (art. 2:210 lid 2 BW).'
      using errcode = '23514';
  end if;

  for v_line in select value from jsonb_array_elements(p_signatories)
  loop
    v_index := v_index + 1;
    v_name := nullif(btrim(coalesce(v_line ->> 'name', '')), '');
    v_role := lower(nullif(btrim(coalesce(v_line ->> 'role', '')), ''));
    v_shareholder := nullif(v_line ->> 'shareholderId', '')::uuid;

    if v_name is null then
      raise exception 'Elke ondertekenaar heeft een naam nodig (regel %).', v_index using errcode = '23514';
    end if;
    if v_role is null or v_role not in ('bestuurder','commissaris') then
      raise exception 'De rol van % moet "bestuurder" of "commissaris" zijn (art. 2:210 lid 2 BW).', v_name
        using errcode = '23514';
    end if;
    if v_role = 'bestuurder' then
      v_directors := v_directors + 1;
    end if;

    if v_shareholder is not null and not exists (
      select 1 from public.shareholders sh
      where sh.id = v_shareholder and sh.organization_id = p_organization_id
    ) then
      raise exception 'De aandeelhouder die aan % is gekoppeld, bestaat niet in deze administratie.', v_name
        using errcode = '02000';
    end if;

    if exists (
      select 1 from public.annual_account_signatures s
      where s.annual_account_id = v_row.id and s.person_name = v_name and s.role = v_role
    ) then
      raise exception '% staat twee keer in de lijst met ondertekenaars (rol: %).', v_name, v_role
        using errcode = '23505';
    end if;

    insert into public.annual_account_signatures (
      organization_id, annual_account_id, person_name, role, shareholder_id, sort_order
    ) values (
      p_organization_id, v_row.id, v_name, v_role, v_shareholder, v_index
    );
  end loop;

  if v_directors = 0 then
    raise exception 'Geef minstens één bestuurder op: de jaarrekening wordt ondertekend door de bestuurders en door de commissarissen (art. 2:210 lid 2 BW).'
      using errcode = '23514';
  end if;

  return v_row;
end;
$$;

comment on function public.prepare_annual_accounts(uuid, uuid, date, text, jsonb, text, text, text, text, text, uuid, boolean, uuid, text) is
  'Maakt de jaarrekening van een boekjaar op (art. 2:210 lid 1 BW): bevriest de cijfers met een sha256-hash, legt de toegepaste grootteklasse en de waarderingsgrondslagen vast, klinkt de opmaaktermijn van vijf maanden vast en maakt een ondertekenrij per bestuurder en commissaris. Weigert als het boekjaar niet is afgesloten, er geen resultaatbestemming is, de grootteklasse niet is te bepalen of de cijfers niet aansluiten. Ligt er voor dat boekjaar al een gedeponeerde jaarrekening, dan is dit stuk een vervanging: het id van de gedeponeerde jaarrekening en een reden zijn dan verplicht (art. 2:394 BW — de deponering zelf blijft staan).';

revoke all on function public.prepare_annual_accounts(uuid, uuid, date, text, jsonb, text, text, text, text, text, uuid, boolean, uuid, text) from public, anon;
grant execute on function public.prepare_annual_accounts(uuid, uuid, date, text, jsonb, text, text, text, text, text, uuid, boolean, uuid, text) to authenticated, service_role;

-- ------------------------------------------------------------
-- 7. extend_preparation_term — verlenging door de algemene vergadering
--
--    Art. 2:210 lid 1 BW: de algemene vergadering kan de opmaaktermijn verlengen
--    met TEN HOOGSTE VIJF MAANDEN, en alleen op grond van BIJZONDERE
--    OMSTANDIGHEDEN. Dat is geen schuifje maar een besluit: grond én
--    besluitdatum zijn verplicht.
--
--    prepare_deadline zelf blijft ongemoeid — de wettelijke termijn was wat hij
--    was. De effectieve termijn is prepare_deadline + extension_months, en die
--    schuift óók de tweemaandsgrens van art. 2:394 lid 2 BW en de betwiste
--    deponeerdatum op.
--
--    Alleen zolang de jaarrekening nog niet is vastgesteld: daarna zegt de
--    opmaaktermijn niets meer en zou een verlenging alleen de deadlines op het
--    scherm vervalsen.
--
--    En alleen met een besluitdatum die BINNEN de wettelijke opmaaktermijn valt.
--    Een termijn die al is verstreken laat zich niet alsnog verlengen; wie dat
--    toch vastlegt, schuift adoptDeadline naar achteren en ziet op het scherm
--    ruimte die er niet is.
--
--    BEKENDE BEPERKING (zie "afwijkingen" 6 in de kop): deze functie werkt op
--    een bestaande annual_accounts-rij, en die ontstaat pas bij het OPMAKEN. Een
--    verlenging die wordt besloten vóórdat er is opgemaakt — de gewone
--    volgorde — is hier dus nog niet vast te leggen. Dat hoort bij het boekjaar
--    zelf en staat op de lijst voor brok D/E; tot dan rekent het systeem tot het
--    opmaken onverkort met period_end + 5 maanden.
-- ------------------------------------------------------------
create or replace function public.extend_preparation_term(
  p_organization_id uuid,
  p_annual_account_id uuid,
  p_months integer,
  p_reason text,
  p_decided_on date
)
returns public.annual_accounts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.annual_accounts;
  v_fy public.fiscal_years;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_months integer := coalesce(p_months, 0);
begin
  if auth.role() <> 'service_role'
     and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if not public.org_has_business(p_organization_id) then
    raise exception 'De jaarrekening hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;
  if public.org_fiscal_regime(p_organization_id) <> 'vpb' then
    raise exception 'De opmaaktermijn van art. 2:210 lid 1 BW geldt voor een BV, NV of coöperatie. Pas eerst de rechtsvorm aan bij Instellingen → Bedrijfsgegevens.'
      using errcode = '23514';
  end if;

  select * into v_row from public.annual_accounts aa
  where aa.id = p_annual_account_id and aa.organization_id = p_organization_id
  for update;
  if not found then
    raise exception 'Jaarrekening niet gevonden.' using errcode = '02000';
  end if;
  if v_row.status <> 'prepared' then
    raise exception 'De opmaaktermijn kan alleen worden verlengd zolang de jaarrekening nog niet is vastgesteld (huidige status: %). Een verlenging achteraf verandert alleen de getoonde termijnen en niet wat er is gebeurd.',
      case v_row.status
        when 'adopted' then 'vastgesteld'
        when 'filed' then 'gedeponeerd'
        when 'reversed' then 'ingetrokken'
        else v_row.status end
      using errcode = '23514';
  end if;

  if v_months < 0 or v_months > 5 then
    raise exception 'De algemene vergadering kan de opmaaktermijn met ten hoogste vijf maanden verlengen (art. 2:210 lid 1 BW).'
      using errcode = '23514';
  end if;

  select * into v_fy from public.fiscal_years fy where fy.id = v_row.fiscal_year_id;

  if v_months = 0 then
    -- Verlenging intrekken of corrigeren: grond en besluitdatum gaan mee weg,
    -- anders blijft er een grond staan zonder verlenging.
    update public.annual_accounts
    set extension_months = 0, extension_reason = null, extension_decided_on = null
    where id = p_annual_account_id
    returning * into v_row;
    return v_row;
  end if;

  if v_reason is null then
    raise exception 'Leg de bijzondere omstandigheden vast waarop de verlenging berust. Art. 2:210 lid 1 BW staat verlenging alleen toe "op grond van bijzondere omstandigheden"; zonder grond is het besluit niet te verdedigen.'
      using errcode = '23514';
  end if;
  if p_decided_on is null then
    raise exception 'Leg de datum vast waarop de algemene vergadering tot verlenging heeft besloten (art. 2:210 lid 1 BW).'
      using errcode = '23514';
  end if;
  if v_fy.id is not null and p_decided_on < v_fy.period_start then
    raise exception 'Het verlengingsbesluit van % ligt vóór de aanvang van boekjaar % (%). Controleer de besluitdatum.',
      to_char(p_decided_on, 'DD-MM-YYYY'), v_fy.label, to_char(v_fy.period_start, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;
  if p_decided_on > current_date then
    raise exception 'De besluitdatum van de verlenging kan niet in de toekomst liggen.' using errcode = '23514';
  end if;
  -- Art. 2:210 lid 1 BW verlengt een LOPENDE termijn. Is de vijfmaandstermijn op
  -- de besluitdatum al verstreken, dan valt er niets meer te verlengen — en zou
  -- het besluit hier alleen de getoonde deadlines naar achteren schuiven.
  if p_decided_on > v_row.prepare_deadline then
    raise exception 'Het verlengingsbesluit van % valt ná afloop van de opmaaktermijn (%). Een verstreken opmaaktermijn kan niet met terugwerkende kracht worden verlengd (art. 2:210 lid 1 BW). Controleer de besluitdatum; klopt die, laat de verlenging dan staan op nul.',
      to_char(p_decided_on, 'DD-MM-YYYY'), to_char(v_row.prepare_deadline, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;

  update public.annual_accounts
  set extension_months = v_months,
      extension_reason = v_reason,
      extension_decided_on = p_decided_on
  where id = p_annual_account_id
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.extend_preparation_term(uuid, uuid, integer, text, date) is
  'Legt vast dat de algemene vergadering de opmaaktermijn heeft verlengd met ten hoogste vijf maanden op grond van bijzondere omstandigheden (art. 2:210 lid 1 BW). Grond en besluitdatum zijn verplicht; prepare_deadline zelf blijft de wettelijke vijfmaandstermijn.';

revoke all on function public.extend_preparation_term(uuid, uuid, integer, text, date) from public, anon;
grant execute on function public.extend_preparation_term(uuid, uuid, integer, text, date) to authenticated, service_role;

-- ------------------------------------------------------------
-- 8. sign_annual_accounts — één handtekening zetten of terugnemen
--
--    Art. 2:210 lid 2 BW. Er staat geen wettelijke termijn op (Hof
--    's-Hertogenbosch 13-9-2022), dus een handtekening mag later komen. Wel
--    geldt: een handtekening kan niet zijn gezet vóór het opmaken.
-- ------------------------------------------------------------
create or replace function public.sign_annual_accounts(
  p_organization_id uuid,
  p_signature_id uuid,
  p_signed boolean,
  p_signed_on date default current_date,
  p_missing_reason text default null
)
returns public.annual_account_signatures
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sig public.annual_account_signatures;
  v_aa public.annual_accounts;
  v_signed boolean := coalesce(p_signed, false);
  v_on date := coalesce(p_signed_on, current_date);
  v_reason text := nullif(btrim(coalesce(p_missing_reason, '')), '');
  v_adopted_filings integer;
begin
  if auth.role() <> 'service_role'
     and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if not public.org_has_business(p_organization_id) then
    raise exception 'De jaarrekening hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;
  if public.org_fiscal_regime(p_organization_id) <> 'vpb' then
    raise exception 'De ondertekening van art. 2:210 lid 2 BW hoort bij een BV, NV of coöperatie. Pas eerst de rechtsvorm aan bij Instellingen → Bedrijfsgegevens.'
      using errcode = '23514';
  end if;

  -- Dezelfde lock als adopt/file. Zonder deze kan een handtekening worden gezet
  -- of teruggenomen terwijl adopt_annual_accounts net de handtekeningen heeft
  -- geteld: de vaststelling zou dan op een stand berusten die op het moment van
  -- committen niet meer bestaat.
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':fyclose'));

  select * into v_sig from public.annual_account_signatures s
  where s.id = p_signature_id and s.organization_id = p_organization_id
  for update;
  if not found then
    raise exception 'Ondertekenaar niet gevonden.' using errcode = '02000';
  end if;

  -- Rijlock erbij: adopt en file lezen de jaarrekening ook met for update, dus
  -- hiermee kan de status niet onder deze wijziging vandaan schuiven.
  select * into v_aa from public.annual_accounts aa
  where aa.id = v_sig.annual_account_id and aa.organization_id = p_organization_id
  for update;
  if not found then
    raise exception 'Jaarrekening niet gevonden.' using errcode = '02000';
  end if;

  if v_aa.status = 'reversed' then
    raise exception 'Deze jaarrekening is ingetrokken; maak een nieuwe op ("Jaarrekening opmaken") voordat je ondertekent.' using errcode = '23514';
  end if;

  -- Een ONVASTGESTELD gedeponeerd stuk blokkeert het TEKENEN niet: op de route
  -- van art. 2:394 lid 2 BW is de jaarrekening openbaar gemaakt terwijl de
  -- vaststelling nog moet komen. Wie dan alsnog tekent, brengt het stuk juist
  -- verder. Twee dingen liggen wél vast, en die staan hieronder: een via art.
  -- 2:210 lid 5 BW vastgesteld stuk (de ondertekening ís daar de vaststelling)
  -- en een stuk waarvan de VASTGESTELDE versie al is gedeponeerd. Daarnaast
  -- blijft het terugnemen van een handtekening gebonden aan een opgave van reden.

  -- Bij vaststelling via art. 2:210 lid 5 BW IS de ondertekening de vaststelling:
  -- adopt_annual_accounts maakt adoption_date dwingend gelijk aan de dag van de
  -- laatste handtekening, en die dag bepaalt de acht dagen van art. 2:394 lid 1
  -- BW. Daarna mag er aan de handtekeningen NIETS meer veranderen — niet
  -- terugnemen (dan valt de vaststelling onder het besluit vandaan) en ook niet
  -- bijtekenen of een datum verschuiven (dan loopt max(signed_on) voorbij
  -- adoption_date en wijst de deponeerdeadline op het scherm naar de verkeerde
  -- dag). Let op de voorwaarde: adoption_date, NIET de status — op de route van
  -- art. 2:394 lid 2 BW blijft de status na de vaststelling gewoon 'filed'.
  if v_aa.adoption_method = 'signature_210_5' and v_aa.adoption_date is not null then
    raise exception 'Deze jaarrekening is op % vastgesteld doordat alle bestuurders en commissarissen hebben getekend (art. 2:210 lid 5 BW); die dag ís de vaststelling en bepaalt de acht dagen van art. 2:394 lid 1 BW. Aan de handtekeningen kan daarna niets meer worden gewijzigd. %',
      to_char(v_aa.adoption_date, 'DD-MM-YYYY'),
      case when v_aa.status = 'filed'
        then 'Zij is bovendien al gedeponeerd (art. 2:394 BW): herstel gaat met een opvolgend stuk ("Jaarrekening opmaken", met vermelding welk stuk zij vervangt en waarom).'
        else 'Moet er toch iets veranderen, laat een eigenaar of beheerder haar dan eerst intrekken ("Jaarrekening intrekken").' end
      using errcode = '23514';
  end if;

  -- Is het VASTGESTELDE stuk eenmaal openbaar gemaakt (een deponering zónder de
  -- vermelding van art. 2:394 lid 2 BW), dan ligt de handtekeningenlijst vast.
  -- Die lijst zit bewust NIET in de bevroren snapshot en dus ook niet in de
  -- hash: een wijziging zou stil een herdruk opleveren die afwijkt van wat bij
  -- het handelsregister ligt, terwijl snapshot_hash blijft kloppen.
  select (count(*) filter (where not f.unadopted))::integer
  into v_adopted_filings
  from public.annual_account_filings f
  where f.annual_account_id = v_sig.annual_account_id;

  if coalesce(v_adopted_filings, 0) > 0 then
    raise exception 'Deze jaarrekening is op % als VASTGESTELDE jaarrekening gedeponeerd (art. 2:394 lid 1 BW); de handtekeningen eronder — en de reden van een ontbrekende handtekening (art. 2:210 lid 2 BW) — horen bij het openbaar gemaakte stuk en liggen daarmee vast. Moet er iets worden hersteld, maak dan een nieuwe jaarrekening op die deze vervangt ("Jaarrekening opmaken", met vermelding welk stuk zij vervangt en waarom).',
      to_char(v_aa.filing_date, 'DD-MM-YYYY') using errcode = '23514';
  end if;

  -- Art. 2:210 lid 2 BW: van een ontbrekende handtekening wordt melding gemaakt
  -- ONDER OPGAVE VAN REDEN. Zolang de jaarrekening nog niet is vastgesteld mag
  -- die reden ontbreken — er is dan nog niets te melden en adopt weigert straks
  -- alsnog. Ís er vastgesteld of gedeponeerd, dan zou een handtekening zonder
  -- reden terugnemen precies de toestand opleveren die adopt_annual_accounts
  -- weigert: een vastgesteld, openbaar gemaakt stuk met een gat zonder uitleg.
  -- En het gedrukte stuk verandert daarmee met terugwerkende kracht, want de
  -- handtekeningen zitten NIET in de bevroren snapshot.
  if not v_signed and v_aa.status in ('adopted','filed') and v_reason is null then
    raise exception 'Deze jaarrekening is al %. Neem een handtekening alleen terug mét de reden waarom zij ontbreekt; art. 2:210 lid 2 BW eist dat daarvan melding wordt gemaakt onder opgave van reden, en die reden wordt in het stuk afgedrukt.',
      case v_aa.status
        when 'adopted' then 'vastgesteld op ' || to_char(v_aa.adoption_date, 'DD-MM-YYYY')
        else 'gedeponeerd op ' || to_char(v_aa.filing_date, 'DD-MM-YYYY') end
      using errcode = '23514';
  end if;

  if v_signed then
    if v_on < v_aa.prepared_on then
      raise exception 'De jaarrekening is opgemaakt op %; zij kan niet eerder zijn ondertekend.',
        to_char(v_aa.prepared_on, 'DD-MM-YYYY') using errcode = '23514';
    end if;
    if v_on > current_date then
      raise exception 'Een handtekeningdatum kan niet in de toekomst liggen.' using errcode = '23514';
    end if;

    update public.annual_account_signatures
    set signed = true,
        signed_on = v_on,
        signed_by = auth.uid(),
        -- Wie tekent, heeft geen reden van ontbreken meer — BEHALVE op een
        -- gedeponeerd stuk. Op de route van art. 2:394 lid 2 BW is het stuk
        -- openbaar gemaakt mét de melding waarom deze handtekening ontbrak (art.
        -- 2:210 lid 2 BW). Die melding staat in het exemplaar dat bij het
        -- handelsregister ligt; haar hier wissen zou een herdruk opleveren die
        -- daarvan afwijkt, zonder enig spoor. Zij blijft dus staan als
        -- vastlegging van wat er is gedeponeerd; dat de handtekening er
        -- inmiddels wél is, blijkt uit signed en signed_on.
        -- Zodra er is vastgesteld, is de melding van art. 2:210 lid 2 onderdeel
        -- van een stuk dat de algemene vergadering heeft goedgekeurd — en straks
        -- van wat er bij het handelsregister ligt. Handtekeningen zitten bewust
        -- niet in de bevroren snapshot, dus het wissen van die reden zou het stuk
        -- met terugwerkende kracht veranderen zonder spoor in snapshot_hash.
        -- Daarom vanaf de vaststelling laten staan, niet pas vanaf de deponering.
        missing_reason = case when v_aa.adoption_date is not null then missing_reason else null end
    where id = p_signature_id
    returning * into v_sig;
  else
    update public.annual_account_signatures
    set signed = false,
        signed_on = null,
        signed_by = null,
        -- Art. 2:210 lid 2 BW: van een ontbrekende handtekening wordt melding
        -- gemaakt ONDER OPGAVE VAN REDEN. Vóór de vaststelling mag de reden nog
        -- leeg zijn (er is dan nog niets te melden) en weigert
        -- adopt_annual_accounts later alsnog. coalesce en niet v_reason kaal:
        -- wie de parameter weglaat, wist anders stil een eerder vastgelegde
        -- reden — precies de tekst die in het stuk hoort te staan.
        missing_reason = coalesce(v_reason, missing_reason)
    where id = p_signature_id
    returning * into v_sig;
  end if;

  return v_sig;
end;
$$;

comment on function public.sign_annual_accounts(uuid, uuid, boolean, date, text) is
  'Zet of neemt de handtekening van één bestuurder of commissaris onder de jaarrekening terug (art. 2:210 lid 2 BW). Bij een ontbrekende handtekening kan de reden worden vastgelegd; die is verplicht op het moment van vaststellen én zodra de jaarrekening is vastgesteld of gedeponeerd. Tekenen kan ook nog op een op grond van art. 2:394 lid 2 BW onvastgesteld gedeponeerd stuk: daar moet de vaststelling juist nog komen — en de eerder gemelde reden van ontbreken blijft dan staan, want zij staat in het openbaar gemaakte exemplaar. Weigert elke wijziging zodra de jaarrekening via art. 2:210 lid 5 BW is vastgesteld (de ondertekening ís dan de vaststelling) of zodra het vastgestelde stuk is gedeponeerd.';

revoke all on function public.sign_annual_accounts(uuid, uuid, boolean, date, text) from public, anon;
grant execute on function public.sign_annual_accounts(uuid, uuid, boolean, date, text) to authenticated, service_role;

-- ------------------------------------------------------------
-- 9. adopt_annual_accounts — vaststellen
--
--    Twee routes, en ze verschillen juridisch wezenlijk:
--
--    'ava'             Art. 2:210 lid 3 BW: de algemene vergadering stelt vast.
--                      De vaststelling strekt NIET tot kwijting; décharge is een
--                      apart besluit en dus een apart vinkje. De statuten mogen
--                      het vaststellingsbesluit overigens niet aan goedkeuring
--                      van een ander orgaan onderwerpen (lid 4) — een
--                      goedkeuringsstap in de app is dus administratief, nooit
--                      een juridische voorwaarde.
--
--    'signature_210_5' Art. 2:210 lid 5 BW: zijn alle aandeelhouders tevens
--                      bestuurder, dan geldt de ondertekening door alle
--                      bestuurders én commissarissen als vaststelling — en in
--                      afwijking van lid 3 TEVENS als kwijting. Voorwaarden:
--                      alle overige vergadergerechtigden zijn in de gelegenheid
--                      gesteld kennis te nemen van de opgemaakte jaarrekening en
--                      hebben ingestemd met deze wijze van vaststellen (art.
--                      2:238 lid 1), en de statuten sluiten haar niet uit.
--                      Bekende valkuil: wie zo vaststelt, dechargeert daarmee
--                      ook zijn mede-bestuurder. Dat mag niet per ongeluk.
--
--    In beide routes geldt art. 2:210 lid 2: ontbreekt een handtekening, dan
--    moet daarvan melding zijn gemaakt onder opgave van reden. Zonder reden
--    weigert deze functie. Bij route lid 5 helpt een reden niet: dan moet
--    iedereen hebben getekend, anders is er domweg geen vaststelling.
--
--    VASTSTELLEN KAN OOK NÁ EEN DEPONERING. Wie op grond van art. 2:394 lid 2 BW
--    de nog niet vastgestelde jaarrekening openbaar heeft gemaakt, moet haar
--    daarna alsnog laten vaststellen. Deze functie werkt dus door op een rij met
--    status 'filed', zolang ÁLLE deponeringen van dat stuk onvastgesteld waren;
--    de status blijft dan 'filed' (het stuk ligt immers bij het register) en er
--    volgt een tweede deponering binnen acht dagen (art. 2:394 lid 1 BW).
-- ------------------------------------------------------------
create or replace function public.adopt_annual_accounts(
  p_organization_id uuid,
  p_annual_account_id uuid,
  p_adoption_date date,
  p_method text,
  p_discharge_granted boolean default false,
  -- Default NULL en niet false, net als de auditor-parameters hieronder: deze
  -- drie bevestigingen kunnen al bij het opmaken zijn vastgelegd
  -- (all_shareholders_are_directors staat op prepare_annual_accounts), en het
  -- weglaten van de parameter mag zo'n bevestiging niet stil terugzetten. Een
  -- coalesce met de kolomwaarde erachter zou bij `default false` nooit iets
  -- bewaren, want de parameter is dan nooit null.
  p_all_shareholders_are_directors boolean default null,
  p_other_meeting_rights_informed boolean default null,
  p_articles_allow_210_5 boolean default null,
  p_created_by uuid default auth.uid(),
  -- Achteraan toegevoegd (zie "afwijkingen" in de kop): art. 2:393 lid 7 BW.
  -- Default null en niet false: dan laat het weglaten van de parameter een
  -- eerder vastgelegde bevestiging staan in plaats van hem stil terug te zetten.
  p_auditor_opinion_received boolean default null,
  p_auditor_name text default null,
  p_auditor_missing_ground text default null
)
returns public.annual_accounts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.annual_accounts;
  v_method text := lower(nullif(btrim(coalesce(p_method, '')), ''));
  -- Kernbeslissing J: de vaststeller komt uit auth.uid(); p_created_by telt
  -- alleen voor service_role.
  v_actor uuid := case
    when auth.role() = 'service_role' then coalesce(p_created_by, auth.uid())
    else auth.uid() end;
  v_missing text;
  v_unsigned text;
  v_last_signature date;
  v_total integer;
  v_discharge boolean;
  v_ground text := nullif(btrim(coalesce(p_auditor_missing_ground, '')), '');
  -- De drie bevestigingen van art. 2:210 lid 5 BW zoals ze ná deze aanroep in de
  -- rij komen te staan: de meegegeven waarde, en anders wat er al stond.
  v_all_directors boolean;
  v_meeting_rights boolean;
  v_articles boolean;
  v_adoption_date date;
  v_status text;
  -- De datum van de laatste deponering van dit stuk. Alleen nodig voor de
  -- volgordecontrole hieronder; tellers per soort deponering waren hier dode
  -- code (adoption_date vangt die gevallen al af).
  v_last_filing date;
begin
  if auth.role() <> 'service_role'
     and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if not public.org_has_business(p_organization_id) then
    raise exception 'De jaarrekening hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;
  if public.org_fiscal_regime(p_organization_id) <> 'vpb' then
    raise exception 'Vaststelling volgens art. 2:210 BW hoort bij een BV, NV of coöperatie. Pas eerst de rechtsvorm aan bij Instellingen → Bedrijfsgegevens.'
      using errcode = '23514';
  end if;

  -- Dezelfde lock als afsluiten, bestemmen, opmaken en intrekken. Zonder deze
  -- lock kan reverse_result_appropriation onder READ COMMITTED nét naast deze
  -- transactie langs: die ziet de jaarrekening nog als 'prepared' en draait de
  -- bestemming terug terwijl hier op 'adopted' wordt gezet. Beide committen en
  -- er staat een vastgestelde jaarrekening waarvan de bestemming is verdwenen.
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':fyclose'));

  select * into v_row from public.annual_accounts aa
  where aa.id = p_annual_account_id and aa.organization_id = p_organization_id
  for update;
  if not found then
    raise exception 'Jaarrekening niet gevonden.' using errcode = '02000';
  end if;

  if v_row.status = 'reversed' then
    raise exception 'Deze jaarrekening is ingetrokken. Maak eerst opnieuw op ("Jaarrekening opmaken").' using errcode = '23514';
  end if;
  if v_row.adoption_date is not null then
    raise exception 'Deze jaarrekening is al vastgesteld op %.', to_char(v_row.adoption_date, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;

  -- Vaststellen ná een deponering kan — maar alleen op de route van art. 2:394
  -- lid 2 BW, waarbij het stuk juist ONVASTGESTELD openbaar is gemaakt en de
  -- vaststelling nog moet komen. Een stuk dat al mét vaststelling is gedeponeerd
  -- heeft per definitie een adoption_date en is hierboven al afgevangen; een
  -- aparte teller daarvoor zou een controle suggereren die er niet is.
  select max(f.filing_date) into v_last_filing
  from public.annual_account_filings f
  where f.annual_account_id = p_annual_account_id;

  -- De bevroren onderbouwing moet nog steeds bij de administratie passen; wie
  -- vaststelt, stelt die cijfers vast.
  if public.annual_account_snapshot_stale(p_annual_account_id) then
    if v_row.status = 'filed' then
      raise exception 'De cijfers onder deze jaarrekening zijn niet meer dezelfde als in de administratie: het boekjaar is heropend of de resultaatbestemming is vervangen. Zij is al gedeponeerd en kan niet worden ingetrokken (art. 2:394 BW). Verwerk de correctie in een opvolgend stuk: sluit het boekjaar opnieuw af, bestem het resultaat en maak een nieuwe jaarrekening op die deze vervangt ("Jaarrekening opmaken"). De gedeponeerde jaarrekening blijft staan.'
        using errcode = '23514';
    end if;
    raise exception 'De cijfers onder deze jaarrekening zijn niet meer dezelfde als in de administratie: het boekjaar is heropend of de resultaatbestemming is vervangen. Laat een eigenaar of beheerder de jaarrekening intrekken ("Jaarrekening intrekken") en maak haar daarna opnieuw op; vaststellen van bevroren cijfers die niet meer kloppen kan niet.'
      using errcode = '23514';
  end if;

  if v_method is null or v_method not in ('ava','signature_210_5') then
    raise exception 'Kies hoe de jaarrekening is vastgesteld: "ava" (besluit van de algemene vergadering, art. 2:210 lid 3 BW) of "signature_210_5" (ondertekening door alle bestuurders terwijl alle aandeelhouders bestuurder zijn, art. 2:210 lid 5 BW).'
      using errcode = '23514';
  end if;

  if p_adoption_date is null then
    raise exception 'Leg de dag van vaststelling vast; die moet op het gedeponeerde stuk worden vermeld (art. 2:394 lid 1 BW).'
      using errcode = '23514';
  end if;
  if p_adoption_date < v_row.prepared_on then
    raise exception 'De jaarrekening is opgemaakt op %; zij kan niet eerder zijn vastgesteld.',
      to_char(v_row.prepared_on, 'DD-MM-YYYY') using errcode = '23514';
  end if;
  if p_adoption_date > current_date then
    raise exception 'De vaststellingsdatum kan niet in de toekomst liggen.' using errcode = '23514';
  end if;
  -- Volgorde: op de route van art. 2:394 lid 2 BW is het stuk openbaar gemaakt
  -- MÉT de wettelijke vermelding dat het nog niet was vastgesteld. Een
  -- vaststelling die vóór die dag ligt, spreekt het openbaar gemaakte stuk tegen
  -- — en de acht dagen van art. 2:394 lid 1 BW zouden dan al verstreken zijn op
  -- het moment waarop er werd gedeponeerd, zodat het scherm een deadline in het
  -- verleden toont.
  if v_last_filing is not null and p_adoption_date < v_last_filing then
    raise exception 'Deze jaarrekening is op % gedeponeerd met de vermelding dat zij nog niet was vastgesteld (art. 2:394 lid 2 BW); de vaststelling kan dan niet op % — vóór die dag — hebben plaatsgevonden. Controleer de vaststellingsdatum, en bij vaststelling door ondertekening ook de handtekeningdata.',
      to_char(v_last_filing, 'DD-MM-YYYY'), to_char(p_adoption_date, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;

  select count(*)::integer into v_total
  from public.annual_account_signatures s
  where s.annual_account_id = p_annual_account_id;
  if coalesce(v_total, 0) = 0 then
    raise exception 'Er staan geen ondertekenaars bij deze jaarrekening. De jaarrekening wordt ondertekend door de bestuurders en door de commissarissen (art. 2:210 lid 2 BW); laat een eigenaar of beheerder haar intrekken ("Jaarrekening intrekken") en maak opnieuw op met de juiste namen — is zij al gedeponeerd, dan gaat dat met een vervangend stuk.'
      using errcode = '23514';
  end if;

  -- Art. 2:210 lid 2 BW: van elke ontbrekende handtekening moet melding worden
  -- gemaakt ONDER OPGAVE VAN REDEN — en die reden wordt in het stuk afgedrukt.
  select string_agg(s.person_name || ' (' || s.role || ')', ', ' order by s.sort_order, s.person_name)
  into v_missing
  from public.annual_account_signatures s
  where s.annual_account_id = p_annual_account_id
    and not s.signed
    and coalesce(btrim(s.missing_reason), '') = '';
  if v_missing is not null then
    raise exception 'Voor % ontbreekt de handtekening zonder opgave van reden. Art. 2:210 lid 2 BW eist dat van een ontbrekende ondertekening melding wordt gemaakt onder opgave van reden; leg die reden vast bij de ondertekenaar, of laat alsnog tekenen.', v_missing
      using errcode = '23514';
  end if;

  -- Art. 2:393 lid 1 en lid 7 BW: is de jaarrekening controleplichtig, dan kan
  -- zij niet worden vastgesteld zonder dat het bevoegde orgaan kennis heeft
  -- kunnen nemen van de accountantsverklaring — tenzij onder de overige gegevens
  -- een wettige grond wordt medegedeeld waarom die verklaring ontbreekt.
  if v_row.audit_required
     and not coalesce(p_auditor_opinion_received, v_row.auditor_opinion_received, false)
     and coalesce(v_ground, nullif(btrim(coalesce(v_row.auditor_missing_ground, '')), '')) is null then
    raise exception 'Deze jaarrekening is controleplichtig (%; art. 2:393 lid 1 BW) en kan niet worden vastgesteld zolang het bevoegde orgaan geen kennis heeft kunnen nemen van de verklaring van de accountant (art. 2:393 lid 7 BW). Bevestig dat de verklaring er is en vul de naam van de accountant in, óf leg de wettige grond vast waarom zij ontbreekt — die grond hoort dan in de overige gegevens.',
      coalesce(v_row.size_class_override, v_row.size_class)
      using errcode = '23514';
  end if;

  -- De bevestigingen zoals ze ná deze aanroep in de rij staan: meegegeven waarde
  -- wint, anders blijft staan wat er al stond (bijvoorbeeld de bevestiging over
  -- de aandeelhoudersstructuur die bij het opmaken is gegeven).
  v_all_directors := coalesce(p_all_shareholders_are_directors, v_row.all_shareholders_are_directors, false);
  v_meeting_rights := coalesce(p_other_meeting_rights_informed, v_row.other_meeting_rights_informed, false);
  v_articles := coalesce(p_articles_allow_210_5, v_row.articles_allow_210_5, false);
  v_adoption_date := p_adoption_date;

  if v_method = 'signature_210_5' then
    -- De drie voorwaarden, stuk voor stuk benoemd: een verzamelfout laat de
    -- gebruiker raden welke bevestiging ontbreekt.
    if not v_all_directors then
      raise exception 'Vaststelling door ondertekening kan alleen als ALLE aandeelhouders tevens bestuurder van de vennootschap zijn (art. 2:210 lid 5 BW). Is dat niet zo, kies dan vaststelling door de algemene vergadering.'
        using errcode = '23514';
    end if;
    if not v_meeting_rights then
      raise exception 'Bevestig dat alle overige vergadergerechtigden — bijvoorbeeld certificaathouders en vruchtgebruikers of pandhouders met vergaderrecht — in de gelegenheid zijn gesteld kennis te nemen van de opgemaakte jaarrekening en hebben ingestemd met deze wijze van vaststellen (art. 2:210 lid 5 jo. 2:238 lid 1 BW).'
        using errcode = '23514';
    end if;
    if not v_articles then
      raise exception 'Bevestig dat de statuten deze wijze van vaststellen niet uitsluiten (art. 2:210 lid 5 BW). Sluiten zij haar wél uit, dan moet de algemene vergadering een besluit nemen.'
        using errcode = '23514';
    end if;

    -- Ondertekening IS de vaststelling: dan moet iedereen hebben getekend. Een
    -- ontbrekende handtekening mét reden is bij route lid 5 niet genoeg.
    select string_agg(s.person_name || ' (' || s.role || ')', ', ' order by s.sort_order, s.person_name)
    into v_unsigned
    from public.annual_account_signatures s
    where s.annual_account_id = p_annual_account_id and not s.signed;
    if v_unsigned is not null then
      raise exception 'Bij vaststelling via ondertekening (art. 2:210 lid 5 BW) moeten álle bestuurders en commissarissen hebben getekend; voor % ontbreekt de handtekening. Laat alsnog tekenen, of stel vast met een besluit van de algemene vergadering.', v_unsigned
        using errcode = '23514';
    end if;

    -- Art. 2:210 lid 5 BW: de ondertekening ÍS de vaststelling. De
    -- vaststellingsdatum is dus geen keuze van de gebruiker maar een feit: de
    -- dag waarop de laatste bestuurder of commissaris tekende. Dat is niet
    -- vrijblijvend — die dag moet op het gedeponeerde stuk staan (art. 2:394
    -- lid 1 BW) en bepaalt de acht dagen waarbinnen moet worden gedeponeerd.
    -- Een latere datum accepteren zou de deponeerdeadline even ver meeschuiven
    -- en de gebruiker in het vertrouwen op het scherm te laat laten deponeren.
    select max(s.signed_on) into v_last_signature
    from public.annual_account_signatures s
    where s.annual_account_id = p_annual_account_id;
    if v_last_signature is null then
      raise exception 'Er is geen handtekeningdatum bekend, terwijl de vaststelling bij art. 2:210 lid 5 BW juist aan de ondertekening hangt. Leg per ondertekenaar de datum vast bij "Ondertekenen".'
        using errcode = '23514';
    end if;
    if p_adoption_date is distinct from v_last_signature then
      raise exception 'Bij vaststelling door ondertekening valt de vaststelling van rechtswege op de dag van de laatste handtekening: %. Vul die datum in (art. 2:210 lid 5 BW); zij wordt op het gedeponeerde stuk vermeld en bepaalt de acht dagen van art. 2:394 lid 1 BW.',
        to_char(v_last_signature, 'DD-MM-YYYY') using errcode = '23514';
    end if;
    v_adoption_date := v_last_signature;

    -- Art. 2:210 lid 5 BW strekt de vaststelling in afwijking van lid 3 TEVENS
    -- tot kwijting. Dat is geen keuze van de gebruiker, dus hier afgedwongen —
    -- ook als de aanroeper false meestuurde. Het scherm waarschuwt hiervoor
    -- vóórdat de knop wordt ingedrukt.
    v_discharge := true;
  else
    -- Art. 2:210 lid 3 BW: vaststelling strekt NIET tot kwijting. Décharge is
    -- een apart besluit van de algemene vergadering en dus een aparte keuze.
    v_discharge := coalesce(p_discharge_granted, false);
  end if;

  -- Een op grond van art. 2:394 lid 2 BW gedeponeerd stuk blijft 'filed': het
  -- ligt bij het handelsregister, daar verandert de vaststelling niets aan. Wat
  -- er wél verandert: er moet nu binnen acht dagen opnieuw worden gedeponeerd
  -- (art. 2:394 lid 1 BW). list_annual_accounts geeft dat terug als
  -- refiling_required, met file_deadline_after_adoption ernaast.
  v_status := case when v_row.status = 'filed' then 'filed' else 'adopted' end;

  update public.annual_accounts
  set status = v_status,
      adoption_date = v_adoption_date,
      adoption_method = v_method,
      adopted_by = v_actor,
      discharge_granted = v_discharge,
      all_shareholders_are_directors = v_all_directors,
      other_meeting_rights_informed = v_meeting_rights,
      articles_allow_210_5 = v_articles,
      auditor_opinion_received = coalesce(p_auditor_opinion_received, auditor_opinion_received),
      auditor_name = coalesce(nullif(btrim(coalesce(p_auditor_name, '')), ''), auditor_name),
      auditor_missing_ground = coalesce(v_ground, auditor_missing_ground)
  where id = p_annual_account_id
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.adopt_annual_accounts(uuid, uuid, date, text, boolean, boolean, boolean, boolean, uuid, boolean, text, text) is
  'Stelt de jaarrekening vast: door de algemene vergadering (art. 2:210 lid 3 BW, geen kwijting) of door ondertekening als alle aandeelhouders bestuurder zijn (lid 5, mét automatische kwijting, drie te bevestigen voorwaarden en een vaststellingsdatum die dwingend gelijk is aan de dag van de laatste handtekening). Weigert zolang een ontbrekende handtekening geen reden heeft (lid 2), bij controleplicht zolang de accountantsverklaring ontbreekt zonder wettige grond (art. 2:393 lid 7), en zodra de bevroren cijfers niet meer bij de administratie passen. Werkt ook op een op grond van art. 2:394 lid 2 BW onvastgesteld gedeponeerd stuk: de status blijft dan filed en er volgt een tweede deponering binnen acht dagen.';

revoke all on function public.adopt_annual_accounts(uuid, uuid, date, text, boolean, boolean, boolean, boolean, uuid, boolean, text, text) from public, anon;
grant execute on function public.adopt_annual_accounts(uuid, uuid, date, text, boolean, boolean, boolean, boolean, uuid, boolean, text, text) to authenticated, service_role;

-- ------------------------------------------------------------
-- 10. file_annual_accounts — deponeren bij het handelsregister
--
--     Art. 2:394 lid 1 BW: openbaarmaking binnen acht dagen na de vaststelling,
--     met vermelding van de dag van vaststelling. Lid 3: uiterlijk twaalf
--     maanden na afloop van het boekjaar. Lid 2: is er twee maanden na afloop
--     van de opmaaktermijn nog niet vastgesteld, dan wordt de OPGEMAAKTE
--     jaarrekening onverwijld openbaar gemaakt met de vermelding dat zij nog
--     niet is vastgesteld — dat is de route p_unadopted.
--
--     ResoFly deponeert NIET. Micro, kleine en middelgrote rechtspersonen
--     moeten digitaal in SBR/XBRL deponeren en dat bestand levert ResoFly niet
--     (zie §8 van het plan). Deze functie legt uitsluitend vast DÁT en WANNÉÉR
--     er is gedeponeerd, met een referentie.
--
--     ELKE DEPONERING IS EEN RIJ in annual_account_filings. Een jaarrekening kan
--     meer dan één keer worden gedeponeerd: eerst onvastgesteld op grond van lid
--     2, daarna — ná de vaststelling — opnieuw binnen acht dagen op grond van
--     lid 1. De kolommen op annual_accounts vatten de LAATSTE deponering samen.
--
--     DE DREMPELS VÓÓR EEN DEPONERING:
--       1. De route van lid 2 mag pas op of ná de tweemaandsgrens. Vóór die dag
--          is art. 2:394 lid 2 BW niet aan de orde en is vaststellen de weg; een
--          onvastgestelde deponering is geen keuzeknop om de algemene
--          vergadering mee over te slaan.
--       2. En zij mag helemaal niet als de jaarrekening al VAN RECHTSWEGE is
--          vastgesteld: zijn alle aandeelhouders bestuurder en heeft iedereen
--          getekend, dan is zij op de dag van de laatste handtekening vastgesteld
--          (art. 2:210 lid 5 BW). Haar dan openbaar maken met de mededeling dat
--          zij niet is vastgesteld, is onjuist en slaat de automatische kwijting
--          over.
--       3. Art. 2:210 lid 2 BW: van elke ontbrekende handtekening moet melding
--          zijn gemaakt ONDER OPGAVE VAN REDEN. Die controle stond alleen in
--          adopt_annual_accounts, en juist op de lid-2-route komt adopt nooit
--          langs — terwijl dát het stuk is dat openbaar wordt.
--       4. Om precies dezelfde reden geldt op de lid-2-route ook de toets van
--          art. 2:393 lid 7 BW: een controleplichtig stuk gaat niet naar buiten
--          zonder accountantsverklaring of zonder de wettige grond waarom zij
--          ontbreekt — de verklaring wordt immers mee openbaar gemaakt (art.
--          2:392 lid 1 jo. 2:394 lid 1 BW). Daarom staan de drie
--          auditor-parameters ook op deze functie: anders zou die weigering naar
--          een setter verwijzen die alleen op adopt bestaat.
--       5. De bevroren cijfers moeten nog bij de administratie passen.
--       6. Een volgende deponering ligt nooit vóór de vorige.
--
--     TE LAAT DEPONEREN WORDT NIET GEWEIGERD. Een datum ná de twaalfmaandsgrens
--     is een feit dat moet kunnen worden vastgelegd; weigeren zou de
--     administratie laten liegen over wat er werkelijk is gebeurd. Het scherm
--     toont de overschrijding, met art. 2:394 lid 3 jo. 2:248 lid 2 BW erbij.
-- ------------------------------------------------------------
-- Oude signaturen weg: er kwam een notitie bij de deponering bij, en daarna de
-- drie auditor-parameters. "create or replace" zou daar overloads van maken, met
-- grants op alleen de ene.
drop function if exists public.file_annual_accounts(uuid, uuid, date, text, boolean, uuid);
drop function if exists public.file_annual_accounts(uuid, uuid, date, text, boolean, uuid, text);

create or replace function public.file_annual_accounts(
  p_organization_id uuid,
  p_annual_account_id uuid,
  p_filing_date date,
  p_filing_reference text default null,
  p_unadopted boolean default false,
  p_created_by uuid default auth.uid(),
  -- Vrije aantekening bij déze deponering (bijvoorbeeld het kanaal, of dat het
  -- de herdeponering ná de vaststelling betreft).
  p_note text default null,
  -- Art. 2:393 lid 7 BW, dezelfde drie als op adopt_annual_accounts en met
  -- dezelfde betekenis: null = laat staan wat er al stond. Ze staan hier omdat de
  -- controleplichttoets hieronder óók op de route van art. 2:394 lid 2 BW geldt,
  -- en op díe route komt adopt_annual_accounts — de enige andere setter — nooit
  -- langs. Zonder deze parameters zou die weigering naar een knop verwijzen die
  -- er niet is (kernbeslissing H).
  p_auditor_opinion_received boolean default null,
  p_auditor_name text default null,
  p_auditor_missing_ground text default null
)
returns public.annual_accounts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.annual_accounts;
  v_fy public.fiscal_years;
  v_unadopted boolean := coalesce(p_unadopted, false);
  -- Kernbeslissing J: de deponeerder komt uit auth.uid(); p_created_by telt
  -- alleen voor service_role.
  v_actor uuid := case
    when auth.role() = 'service_role' then coalesce(p_created_by, auth.uid())
    else auth.uid() end;
  v_deadlines jsonb;
  v_adopt_deadline date;
  v_missing text;
  -- Alleen het aantal VASTGESTELDE deponeringen doet er hier toe; een teller
  -- voor de onvastgestelde was dode code.
  v_adopted_filings integer;
  v_last_filing date;
  v_unsigned_count integer;
  v_last_signature date;
  v_ground text := nullif(btrim(coalesce(p_auditor_missing_ground, '')), '');
begin
  if auth.role() <> 'service_role'
     and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if not public.org_has_business(p_organization_id) then
    raise exception 'De jaarrekening hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;
  if public.org_fiscal_regime(p_organization_id) <> 'vpb' then
    raise exception 'De deponeringsplicht van art. 2:394 BW geldt hier voor een BV, NV of coöperatie. Pas eerst de rechtsvorm aan bij Instellingen → Bedrijfsgegevens.'
      using errcode = '23514';
  end if;

  -- Dezelfde lock als afsluiten, bestemmen, opmaken, vaststellen en intrekken:
  -- anders kan reverse_result_appropriation naast deze transactie langs en de
  -- bestemming onder een gedeponeerd stuk vandaan halen.
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':fyclose'));

  select * into v_row from public.annual_accounts aa
  where aa.id = p_annual_account_id and aa.organization_id = p_organization_id
  for update;
  if not found then
    raise exception 'Jaarrekening niet gevonden.' using errcode = '02000';
  end if;

  if v_row.status = 'reversed' then
    raise exception 'Deze jaarrekening is ingetrokken. Maak eerst opnieuw op ("Jaarrekening opmaken").' using errcode = '23514';
  end if;

  if p_filing_date is null then
    raise exception 'Leg de datum van deponering vast.' using errcode = '23514';
  end if;
  if p_filing_date > current_date then
    raise exception 'De deponeerdatum kan niet in de toekomst liggen; leg vast wanneer er werkelijk is gedeponeerd.'
      using errcode = '23514';
  end if;
  if p_filing_date < v_row.prepared_on then
    raise exception 'De jaarrekening is opgemaakt op %; zij kan niet eerder zijn gedeponeerd.',
      to_char(v_row.prepared_on, 'DD-MM-YYYY') using errcode = '23514';
  end if;

  select * into v_fy from public.fiscal_years fy where fy.id = v_row.fiscal_year_id;
  v_deadlines := public.annual_account_statutory_deadlines(
    v_fy.period_end, v_row.extension_months, v_row.adoption_date, v_row.all_shareholders_are_directors);
  v_adopt_deadline := nullif(v_deadlines ->> 'adoptDeadline', '')::date;

  select
    (count(*) filter (where not f.unadopted))::integer,
    max(f.filing_date)
  into v_adopted_filings, v_last_filing
  from public.annual_account_filings f
  where f.annual_account_id = p_annual_account_id;

  -- Volgorde tussen opeenvolgende deponeringen. annual_accounts.filing_date is
  -- de SAMENVATTING van de laatste deponering en wordt hieronder klakkeloos
  -- overschreven; zonder deze controle kan die kolom achteruit lopen en kiest
  -- prepare_annual_accounts (order by filing_date desc) straks het verkeerde te
  -- vervangen stuk.
  if v_last_filing is not null and p_filing_date < v_last_filing then
    raise exception 'Deze jaarrekening is al op % gedeponeerd; een volgende deponering kan niet eerder zijn geweest. Controleer de deponeerdatum.',
      to_char(v_last_filing, 'DD-MM-YYYY') using errcode = '23514';
  end if;

  -- ── Welke deponering is dit? ──────────────────────────────────────────────
  if v_row.status = 'filed' then
    -- Al gedeponeerd. De enige toegestane herhaling is de tweede deponering van
    -- art. 2:394 lid 1 BW: het stuk was onvastgesteld openbaar gemaakt (lid 2),
    -- is inmiddels vastgesteld en moet nu binnen acht dagen opnieuw openbaar.
    if coalesce(v_adopted_filings, 0) > 0 then
      raise exception 'Deze jaarrekening is op % als vastgestelde jaarrekening gedeponeerd; daarmee is zij openbaar gemaakt (art. 2:394 lid 1 BW). Moet er iets worden hersteld, maak dan een nieuwe jaarrekening op die deze vervangt ("Jaarrekening opmaken", met vermelding welk stuk zij vervangt en waarom).',
        to_char(v_row.filing_date, 'DD-MM-YYYY') using errcode = '23514';
    end if;
    if v_row.adoption_date is null then
      raise exception 'Deze jaarrekening is op % gedeponeerd als nog niet vastgestelde jaarrekening (art. 2:394 lid 2 BW). Leg nu eerst de vaststelling vast ("Jaarrekening vaststellen"); daarna deponeer je haar binnen acht dagen opnieuw (art. 2:394 lid 1 BW).',
        to_char(v_row.filing_date, 'DD-MM-YYYY') using errcode = '23514';
    end if;
    if v_unadopted then
      raise exception 'Deze jaarrekening is op % vastgesteld; deze tweede deponering is juist de openbaarmaking van het VASTGESTELDE stuk (art. 2:394 lid 1 BW). Zet de vermelding "nog niet vastgesteld" dus uit.',
        to_char(v_row.adoption_date, 'DD-MM-YYYY') using errcode = '23514';
    end if;
    if p_filing_date < v_row.adoption_date then
      raise exception 'De jaarrekening is vastgesteld op %; zij kan niet eerder opnieuw zijn gedeponeerd.',
        to_char(v_row.adoption_date, 'DD-MM-YYYY') using errcode = '23514';
    end if;

  elsif v_row.status = 'prepared' then
    if not v_unadopted then
      raise exception 'Deze jaarrekening is nog niet vastgesteld. Stel haar eerst vast ("Jaarrekening vaststellen", art. 2:210 lid 3 BW). Is zij op % nog steeds niet vastgesteld, dan moet de OPGEMAAKTE jaarrekening onverwijld worden gedeponeerd met de vermelding dat zij nog niet is vastgesteld (art. 2:394 lid 2 BW); kies dan de optie "deponeren als nog niet vastgesteld".',
        coalesce(to_char(v_adopt_deadline, 'DD-MM-YYYY'), 'de daarvoor geldende datum')
        using errcode = '23514';
    end if;
    -- Art. 2:394 lid 2 BW komt pas in beeld ná afloop van de tweemaandstermijn
    -- ("onverwijld" ziet op het moment dáárna). Vóór die dag is dit geen
    -- wettelijke plicht maar het overslaan van de algemene vergadering, en dat
    -- is bovendien de enige route die de vaststelling nog niet vastlegt.
    if v_adopt_deadline is not null and p_filing_date < v_adopt_deadline then
      raise exception 'Deponeren met de vermelding "nog niet vastgesteld" hoort bij art. 2:394 lid 2 BW, en dat artikel is pas aan de orde als de jaarrekening op % nog steeds niet is vastgesteld. Stel haar tot die dag vast ("Jaarrekening vaststellen", art. 2:210 lid 3 BW) en deponeer daarna binnen acht dagen.',
        to_char(v_adopt_deadline, 'DD-MM-YYYY') using errcode = '23514';
    end if;

    -- Art. 2:210 lid 5 BW: zijn alle aandeelhouders tevens bestuurder én hebben
    -- álle bestuurders en commissarissen getekend, dan IS de jaarrekening van
    -- rechtswege vastgesteld — op de dag van de laatste handtekening. Haar dan
    -- openbaar maken met de mededeling dat zij niet is vastgesteld, is feitelijk
    -- onjuist, en het slaat de automatische kwijting van lid 5 over. Voor
    -- diezelfde combinatie dwingt adopt_annual_accounts alles wél af.
    if v_row.all_shareholders_are_directors then
      select
        (count(*) filter (where not s.signed))::integer,
        max(s.signed_on)
      into v_unsigned_count, v_last_signature
      from public.annual_account_signatures s
      where s.annual_account_id = p_annual_account_id;

      if coalesce(v_unsigned_count, 0) = 0 and v_last_signature is not null then
        raise exception 'Alle aandeelhouders zijn bestuurder en alle bestuurders en commissarissen hebben getekend; daarmee is deze jaarrekening van rechtswege vastgesteld op % (art. 2:210 lid 5 BW). Zij kan dus niet openbaar worden gemaakt met de vermelding dat zij nog niet is vastgesteld. Leg die vaststelling eerst vast ("Jaarrekening vaststellen", route ondertekening) en deponeer haar daarna binnen acht dagen (art. 2:394 lid 1 BW).',
          to_char(v_last_signature, 'DD-MM-YYYY') using errcode = '23514';
      end if;
    end if;

    -- Art. 2:393 lid 1 en lid 7 BW, óók op deze route. adopt_annual_accounts
    -- toetst dit al, maar op de route van art. 2:394 lid 2 BW komt adopt nooit
    -- langs — terwijl juist dít stuk bij het handelsregister voor iedereen
    -- zichtbaar wordt en art. 2:392 lid 1 jo. 2:394 lid 1 BW eist dat de
    -- accountantsverklaring dan mee openbaar wordt gemaakt. Zonder verklaring en
    -- zonder wettige grond mag een controleplichtig stuk dus niet naar buiten.
    if v_row.audit_required
       and not coalesce(p_auditor_opinion_received, v_row.auditor_opinion_received, false)
       and coalesce(v_ground, nullif(btrim(coalesce(v_row.auditor_missing_ground, '')), '')) is null then
      raise exception 'Deze jaarrekening is controleplichtig (%; art. 2:393 lid 1 BW). Wordt zij openbaar gemaakt, dan hoort de verklaring van de accountant daarbij (art. 2:392 lid 1 jo. 2:394 lid 1 BW); ontbreekt die, dan moet onder de overige gegevens de wettige grond daarvan worden medegedeeld (art. 2:393 lid 7 BW). Bevestig dat de verklaring er is en vul de naam van de accountant in, óf leg die wettige grond vast, voordat je deponeert.',
        coalesce(v_row.size_class_override, v_row.size_class)
        using errcode = '23514';
    end if;

  else
    -- status 'adopted'
    if v_unadopted then
      raise exception 'Deze jaarrekening is op % vastgesteld; deponeer haar dan niet als "nog niet vastgesteld". De vermelding van art. 2:394 lid 2 BW hoort alleen op een stuk dat werkelijk nog niet is vastgesteld.',
        to_char(v_row.adoption_date, 'DD-MM-YYYY') using errcode = '23514';
    end if;
    if p_filing_date < v_row.adoption_date then
      raise exception 'De jaarrekening is vastgesteld op %; zij kan niet eerder zijn gedeponeerd.',
        to_char(v_row.adoption_date, 'DD-MM-YYYY') using errcode = '23514';
    end if;
  end if;

  -- ── Art. 2:210 lid 2 BW, vóór ELKE deponering ─────────────────────────────
  -- Van een ontbrekende handtekening wordt melding gemaakt ONDER OPGAVE VAN
  -- REDEN, en die melding staat in het stuk dat bij het handelsregister voor
  -- iedereen zichtbaar wordt. Deze controle staat óók in adopt_annual_accounts,
  -- maar op de route van art. 2:394 lid 2 BW komt adopt nooit langs.
  select string_agg(s.person_name || ' (' || s.role || ')', ', ' order by s.sort_order, s.person_name)
  into v_missing
  from public.annual_account_signatures s
  where s.annual_account_id = p_annual_account_id
    and not s.signed
    and coalesce(btrim(s.missing_reason), '') = '';
  if v_missing is not null then
    raise exception 'Voor % ontbreekt de handtekening zonder opgave van reden. Art. 2:210 lid 2 BW eist dat van een ontbrekende ondertekening melding wordt gemaakt onder opgave van reden, en het gedeponeerde stuk wordt openbaar; leg die reden vast bij de ondertekenaar ("Ondertekenen"), of laat alsnog tekenen.', v_missing
      using errcode = '23514';
  end if;

  -- ── De bevroren cijfers moeten nog kloppen ────────────────────────────────
  if public.annual_account_snapshot_stale(p_annual_account_id) then
    if v_row.status = 'filed' then
      raise exception 'De cijfers onder deze jaarrekening zijn niet meer dezelfde als in de administratie: het boekjaar is heropend of de resultaatbestemming is vervangen. Zij is al gedeponeerd (art. 2:394 BW) en blijft staan; verwerk de correctie in een opvolgend stuk — sluit het boekjaar opnieuw af, bestem het resultaat en maak een nieuwe jaarrekening op die deze vervangt ("Jaarrekening opmaken").'
        using errcode = '23514';
    end if;
    raise exception 'De cijfers onder deze jaarrekening zijn niet meer dezelfde als in de administratie: het boekjaar is heropend of de resultaatbestemming is vervangen. Laat een eigenaar of beheerder de jaarrekening intrekken ("Jaarrekening intrekken") en maak haar daarna opnieuw op; wat openbaar wordt gemaakt moet bij de administratie passen.'
      using errcode = '23514';
  end if;

  -- ── Vastleggen ────────────────────────────────────────────────────────────
  -- Eerst de gebeurtenis zelf, dan de samenvatting op de jaarrekening.
  insert into public.annual_account_filings (
    organization_id, annual_account_id, filing_date, filing_reference, unadopted, note, created_by
  ) values (
    p_organization_id, p_annual_account_id, p_filing_date,
    nullif(btrim(coalesce(p_filing_reference, '')), ''),
    v_unadopted,
    nullif(btrim(coalesce(p_note, '')), ''),
    v_actor
  );

  update public.annual_accounts
  set status = 'filed',
      filing_date = p_filing_date,
      filed_by = v_actor,
      filing_reference = nullif(btrim(coalesce(p_filing_reference, '')), ''),
      filed_unadopted = v_unadopted,
      -- Art. 2:393 lid 7 BW; zelfde coalesce-patroon als in adopt: null laat
      -- staan wat er al stond en zet een eerdere bevestiging niet stil terug.
      auditor_opinion_received = coalesce(p_auditor_opinion_received, auditor_opinion_received),
      auditor_name = coalesce(nullif(btrim(coalesce(p_auditor_name, '')), ''), auditor_name),
      auditor_missing_ground = coalesce(v_ground, auditor_missing_ground)
  where id = p_annual_account_id
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.file_annual_accounts(uuid, uuid, date, text, boolean, uuid, text, boolean, text, text) is
  'Legt vast dat en wanneer de jaarrekening bij het handelsregister is gedeponeerd (art. 2:394 BW), eventueel als nog niet vastgestelde jaarrekening op grond van lid 2 — en dan pas op of ná de tweemaandsgrens. Elke deponering is een rij in annual_account_filings; een stuk dat onvastgesteld is gedeponeerd, wordt ná de vaststelling opnieuw gedeponeerd (lid 1), nooit met een eerdere datum dan de vorige deponering. Weigert bij een ontbrekende handtekening zonder opgave van reden (art. 2:210 lid 2), bij een controleplichtig stuk zonder accountantsverklaring en zonder wettige grond (art. 2:393 lid 7 jo. 2:392 lid 1), bij een jaarrekening die op grond van art. 2:210 lid 5 BW al van rechtswege is vastgesteld, en zodra de bevroren cijfers niet meer bij de administratie passen. ResoFly deponeert niet zelf: micro, kleine en middelgrote rechtspersonen deponeren digitaal in SBR/XBRL. Te laat deponeren wordt vastgelegd, niet geweigerd.';

revoke all on function public.file_annual_accounts(uuid, uuid, date, text, boolean, uuid, text, boolean, text, text) from public, anon;
grant execute on function public.file_annual_accounts(uuid, uuid, date, text, boolean, uuid, text, boolean, text, text) to authenticated, service_role;

-- ------------------------------------------------------------
-- 11. reverse_annual_accounts — intrekken
--
--     Zolang het stuk niet is gedeponeerd, mag het worden ingetrokken: de rij
--     blijft staan als spoor (status 'reversed') en blokkeert niets meer, zodat
--     er opnieuw kan worden opgemaakt. Ná deponering kan dat niet: het stuk ligt
--     bij het handelsregister en dat is openbaar. Herstel gaat dan met een
--     opvolgend stuk (kernbeslissing G) — prepare_annual_accounts met het id van
--     de gedeponeerde jaarrekening en een reden. Het oude stuk blijft op 'filed'
--     staan; die deponering is een feit.
-- ------------------------------------------------------------
create or replace function public.reverse_annual_accounts(
  p_organization_id uuid,
  p_annual_account_id uuid,
  p_reason text,
  p_created_by uuid default auth.uid()
)
returns public.annual_accounts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.annual_accounts;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  -- Intrekken is een beheerdershandeling, net als het heropenen van een boekjaar
  -- en het terugdraaien van een resultaatbestemming.
  if auth.role() <> 'service_role'
     and not (public.can_admin_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Alleen een eigenaar of beheerder mag een jaarrekening intrekken.' using errcode = '42501';
  end if;
  if not public.org_has_business(p_organization_id) then
    raise exception 'De jaarrekening hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;
  if public.org_fiscal_regime(p_organization_id) <> 'vpb' then
    raise exception 'De jaarrekeningmodule hoort bij een BV, NV of coöperatie. Pas eerst de rechtsvorm aan bij Instellingen → Bedrijfsgegevens.'
      using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':fyclose'));

  select * into v_row from public.annual_accounts aa
  where aa.id = p_annual_account_id and aa.organization_id = p_organization_id
  for update;
  if not found then
    raise exception 'Jaarrekening niet gevonden.' using errcode = '02000';
  end if;

  if v_row.status = 'reversed' then
    raise exception 'Deze jaarrekening is al ingetrokken.' using errcode = '23514';
  end if;
  if v_row.status = 'filed' then
    raise exception 'Een gedeponeerde jaarrekening kan niet worden ingetrokken: zij is op % openbaar gemaakt bij het handelsregister (art. 2:394 BW). Herstel een fout met een opvolgend stuk. Zitten de cijfers zelf fout, heropen dan eerst het boekjaar ("Boekjaren → Boekjaar heropenen" — dat mag onder een gedeponeerde jaarrekening), corrigeer, sluit opnieuw af en bestem het resultaat. Maak daarna een nieuwe jaarrekening op ("Jaarrekening opmaken") en geef aan dat zij deze gedeponeerde jaarrekening vervangt, met de reden. De oude deponering blijft zichtbaar.',
      to_char(v_row.filing_date, 'DD-MM-YYYY') using errcode = '23514';
  end if;

  if v_reason is null then
    raise exception 'Leg vast waarom de jaarrekening wordt ingetrokken. Zonder reden is later niet na te gaan waarom er twee stukken over hetzelfde boekjaar bestaan.'
      using errcode = '23514';
  end if;

  update public.annual_accounts
  set status = 'reversed',
      reversed_at = now(),
      -- Kernbeslissing J: wie intrekt komt uit auth.uid(); p_created_by telt
      -- alleen voor service_role.
      reversed_by = case
        when auth.role() = 'service_role' then coalesce(p_created_by, auth.uid())
        else auth.uid() end,
      reverse_reason = v_reason
  where id = p_annual_account_id
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.reverse_annual_accounts(uuid, uuid, text, uuid) is
  'Trekt een opgemaakte of vastgestelde jaarrekening in; de rij blijft staan als spoor en blokkeert een nieuwe niet. Weigert bij een gedeponeerde jaarrekening: openbaarmaking bij het handelsregister is onomkeerbaar (art. 2:394 BW). Herstel gaat daar met een opvolgend stuk, via prepare_annual_accounts met supersedes_annual_account_id en een reden.';

revoke all on function public.reverse_annual_accounts(uuid, uuid, text, uuid) from public, anon;
grant execute on function public.reverse_annual_accounts(uuid, uuid, text, uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 12. list_annual_accounts en get_annual_account
--
--     LET OP: de OUT-kolommen heten status, note, created_at — precies zoals de
--     tabelkolommen. In plpgsql wint dan de variabele; elke kolomverwijzing is
--     daarom gekwalificeerd met een alias.
--
--     De deponeerdeadlines komen uit annual_account_statutory_deadlines, via één
--     lateral aanroep per rij. BEIDE datums staan erin — de betwiste veilige
--     datum met haar vlag, en de harde buitengrens. Het scherm toont ze samen.
--
--     snapshot_stale markeert dat de bevroren cijfers niet meer bij de
--     administratie passen; refiling_required dat er ná een deponering op grond
--     van art. 2:394 lid 2 BW is vastgesteld en het stuk dus binnen acht dagen
--     opnieuw openbaar moet (lid 1). Zonder die twee zou het scherm moeten raden.
-- ------------------------------------------------------------
-- De returns-table verandert (drie kolommen erbij); "create or replace" kan een
-- returntype niet wijzigen, dus eerst weg.
drop function if exists public.list_annual_accounts(uuid);

create or replace function public.list_annual_accounts(
  p_organization_id uuid
)
returns table(
  id uuid,
  fiscal_year_id uuid,
  fiscal_year_label text,
  period_start date,
  period_end date,
  status text,
  size_class text,
  size_class_override text,
  effective_size_class text,
  accounting_basis text,
  audit_required boolean,
  auditor_opinion_received boolean,
  prepared_on date,
  prepare_deadline date,
  extension_months integer,
  prepare_deadline_effective date,
  adopt_deadline date,
  adoption_date date,
  adoption_method text,
  discharge_granted boolean,
  filing_date date,
  filing_reference text,
  filed_unadopted boolean,
  filings_count integer,
  refiling_required boolean,
  file_deadline_after_adoption date,
  file_deadline_safe date,
  file_deadline_safe_disputed boolean,
  file_deadline_hard date,
  signatures_total integer,
  signatures_signed integer,
  signatures_missing_without_reason integer,
  snapshot_hash text,
  snapshot_version integer,
  snapshot_stale boolean,
  supersedes_annual_account_id uuid,
  supersede_reason text,
  pdf_attachment_id uuid,
  publication_attachment_id uuid,
  note text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if not public.org_has_business(p_organization_id) then
    raise exception 'De jaarrekening hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;
  if public.org_fiscal_regime(p_organization_id) <> 'vpb' then
    raise exception 'De jaarrekeningmodule hoort bij een BV, NV of coöperatie. Pas eerst de rechtsvorm aan bij Instellingen → Bedrijfsgegevens.'
      using errcode = '23514';
  end if;

  return query
  select
    aa.id,
    aa.fiscal_year_id,
    fy.label,
    fy.period_start,
    fy.period_end,
    aa.status,
    aa.size_class,
    aa.size_class_override,
    coalesce(aa.size_class_override, aa.size_class),
    aa.accounting_basis,
    aa.audit_required,
    aa.auditor_opinion_received,
    aa.prepared_on,
    aa.prepare_deadline,
    aa.extension_months,
    (dl.d ->> 'prepareDeadlineExtended')::date,
    (dl.d ->> 'adoptDeadline')::date,
    aa.adoption_date,
    aa.adoption_method,
    aa.discharge_granted,
    aa.filing_date,
    aa.filing_reference,
    aa.filed_unadopted,
    coalesce(fl.total, 0),
    -- Art. 2:394 lid 1 BW: is er onvastgesteld gedeponeerd (lid 2) en daarna
    -- alsnog vastgesteld, dan moet het vastgestelde stuk binnen acht dagen
    -- opnieuw openbaar. file_deadline_after_adoption staat ernaast.
    (aa.status = 'filed' and aa.adoption_date is not null and coalesce(fl.adopted, 0) = 0),
    (dl.d ->> 'fileDeadlineAfterAdoption')::date,
    (dl.d ->> 'fileDeadlineSafe')::date,
    coalesce((dl.d ->> 'fileDeadlineSafeDisputed')::boolean, false),
    (dl.d ->> 'fileDeadlineHard')::date,
    coalesce(sg.total, 0),
    coalesce(sg.signed, 0),
    coalesce(sg.missing_without_reason, 0),
    aa.snapshot_hash,
    aa.snapshot_version,
    public.annual_account_snapshot_stale(aa.id),
    aa.supersedes_annual_account_id,
    aa.supersede_reason,
    aa.pdf_attachment_id,
    aa.publication_attachment_id,
    aa.note,
    aa.created_at
  from public.annual_accounts aa
  join public.fiscal_years fy on fy.id = aa.fiscal_year_id
  cross join lateral (
    select public.annual_account_statutory_deadlines(
      fy.period_end, aa.extension_months, aa.adoption_date, aa.all_shareholders_are_directors
    ) as d
  ) dl
  left join lateral (
    select
      count(*)::integer as total,
      (count(*) filter (where not f.unadopted))::integer as adopted
    from public.annual_account_filings f
    where f.annual_account_id = aa.id
  ) fl on true
  left join lateral (
    select
      count(*)::integer as total,
      (count(*) filter (where s.signed))::integer as signed,
      (count(*) filter (where not s.signed and coalesce(btrim(s.missing_reason), '') = ''))::integer as missing_without_reason
    from public.annual_account_signatures s
    where s.annual_account_id = aa.id
  ) sg on true
  where aa.organization_id = p_organization_id
  order by fy.period_end desc, aa.created_at desc;
end;
$$;

comment on function public.list_annual_accounts(uuid) is
  'Alle jaarrekeningen van een organisatie met hun stand en termijnen. Geeft BEIDE deponeerdeadlines terug: file_deadline_safe (de betwiste KVK-lijn voor een BV waarvan alle aandeelhouders bestuurder zijn, met de vlag file_deadline_safe_disputed, en alleen zolang er nog niet is vastgesteld) en file_deadline_hard (art. 2:394 lid 3 BW). Toon ze altijd samen; ResoFly kiest niet tussen beide interpretaties. snapshot_stale markeert dat de bevroren cijfers niet meer bij de administratie passen, refiling_required dat een onvastgesteld gedeponeerd stuk inmiddels is vastgesteld en binnen acht dagen opnieuw moet worden gedeponeerd (art. 2:394 lid 1 BW).';

revoke all on function public.list_annual_accounts(uuid) from public, anon;
grant execute on function public.list_annual_accounts(uuid) to authenticated, service_role;

create or replace function public.get_annual_account(
  p_organization_id uuid,
  p_annual_account_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_row public.annual_accounts;
  v_fy public.fiscal_years;
  v_signatures jsonb := '[]'::jsonb;
  v_filings jsonb := '[]'::jsonb;
  v_adopted_filings integer := 0;
  v_deadlines jsonb;
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if not public.org_has_business(p_organization_id) then
    raise exception 'De jaarrekening hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;
  if public.org_fiscal_regime(p_organization_id) <> 'vpb' then
    raise exception 'De jaarrekeningmodule hoort bij een BV, NV of coöperatie. Pas eerst de rechtsvorm aan bij Instellingen → Bedrijfsgegevens.'
      using errcode = '23514';
  end if;

  select * into v_row from public.annual_accounts aa
  where aa.id = p_annual_account_id and aa.organization_id = p_organization_id;
  if not found then
    raise exception 'Jaarrekening niet gevonden.' using errcode = '02000';
  end if;

  select * into v_fy from public.fiscal_years fy where fy.id = v_row.fiscal_year_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id,
    'personName', s.person_name,
    'role', s.role,
    'shareholderId', s.shareholder_id,
    'signed', s.signed,
    'signedOn', s.signed_on,
    'missingReason', s.missing_reason,
    'sortOrder', s.sort_order
  ) order by s.sort_order, s.person_name), '[]'::jsonb)
  into v_signatures
  from public.annual_account_signatures s
  where s.annual_account_id = p_annual_account_id;

  -- De volledige deponeringsgeschiedenis; de kolommen op annual_accounts zijn
  -- niet meer dan de samenvatting van de laatste rij hieruit.
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'id', f.id,
      'filingDate', f.filing_date,
      'filingReference', f.filing_reference,
      'unadopted', f.unadopted,
      'note', f.note,
      'createdAt', f.created_at
    ) order by f.filing_date, f.created_at), '[]'::jsonb),
    (count(*) filter (where not f.unadopted))::integer
  into v_filings, v_adopted_filings
  from public.annual_account_filings f
  where f.annual_account_id = p_annual_account_id;

  v_deadlines := public.annual_account_statutory_deadlines(
    v_fy.period_end, v_row.extension_months, v_row.adoption_date, v_row.all_shareholders_are_directors);

  return jsonb_build_object(
    'id', v_row.id,
    'fiscalYearId', v_row.fiscal_year_id,
    'fiscalYearLabel', v_fy.label,
    'periodStart', v_fy.period_start,
    'periodEnd', v_fy.period_end,
    'status', v_row.status,
    'preparedOn', v_row.prepared_on,
    'prepareDeadline', v_row.prepare_deadline,
    'extensionMonths', v_row.extension_months,
    'extensionReason', v_row.extension_reason,
    'extensionDecidedOn', v_row.extension_decided_on,
    'adoptionDate', v_row.adoption_date,
    'adoptionMethod', v_row.adoption_method,
    'dischargeGranted', v_row.discharge_granted,
    'allShareholdersAreDirectors', v_row.all_shareholders_are_directors,
    'otherMeetingRightsInformed', v_row.other_meeting_rights_informed,
    'articlesAllow2105', v_row.articles_allow_210_5,
    'filingDate', v_row.filing_date,
    'filingReference', v_row.filing_reference,
    'filedUnadopted', v_row.filed_unadopted,
    'filings', v_filings,
    -- Art. 2:394 lid 1 BW: onvastgesteld gedeponeerd (lid 2) en daarna alsnog
    -- vastgesteld → binnen acht dagen opnieuw deponeren.
    'refilingRequired',
      (v_row.status = 'filed' and v_row.adoption_date is not null and coalesce(v_adopted_filings, 0) = 0),
    'supersedesAnnualAccountId', v_row.supersedes_annual_account_id,
    'supersedeReason', v_row.supersede_reason,
    'sizeClass', v_row.size_class,
    'sizeClassOverride', v_row.size_class_override,
    'effectiveSizeClass', coalesce(v_row.size_class_override, v_row.size_class),
    'sizeOverrideReason', v_row.size_override_reason,
    'sizeBasis', v_row.size_basis,
    'accountingBasis', v_row.accounting_basis,
    'policyChangeNote', v_row.policy_change_note,
    'offBalanceCommitments', v_row.off_balance_commitments,
    'auditRequired', v_row.audit_required,
    'auditorOpinionReceived', v_row.auditor_opinion_received,
    'auditorName', v_row.auditor_name,
    'auditorMissingGround', v_row.auditor_missing_ground,
    'snapshot', v_row.snapshot,
    'snapshotHash', v_row.snapshot_hash,
    'snapshotVersion', v_row.snapshot_version,
    -- Valkuil 5: de bevroren cijfers kunnen uit de pas lopen met de
    -- administratie. Markeer dat in het scherm; toon nooit twee cijferbeelden
    -- naast elkaar alsof er niets aan de hand is.
    'snapshotStale', public.annual_account_snapshot_stale(v_row.id),
    'pdfAttachmentId', v_row.pdf_attachment_id,
    'publicationAttachmentId', v_row.publication_attachment_id,
    'reversedAt', v_row.reversed_at,
    'reverseReason', v_row.reverse_reason,
    'note', v_row.note,
    'createdAt', v_row.created_at,
    'signatures', v_signatures,
    'deadlines', v_deadlines
  );
end;
$$;

comment on function public.get_annual_account(uuid, uuid) is
  'Eén jaarrekening met haar bevroren snapshot, de ondertekenaars, de volledige deponeringsgeschiedenis en alle wettelijke termijnen. Dit is de bron voor de PDF-generator: de cijfers komen uit snapshot — inclusief de toegepaste grootteklasse in snapshot -> size -> appliedSizeClass — en worden nooit opnieuw uit het grootboek gehaald. snapshotStale markeert dat die bevroren cijfers niet meer bij de administratie passen.';

revoke all on function public.get_annual_account(uuid, uuid) from public, anon;
grant execute on function public.get_annual_account(uuid, uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 13. Guards op bestaande functies
--
--     De ketting is: boekjaar afsluiten → resultaat bestemmen → jaarrekening
--     opmaken → vaststellen → deponeren. Terugdraaien loopt precies andersom, en
--     elke laag blokkeert de laag eronder. Beide functies zijn hieronder
--     VOLLEDIG overgenomen uit de migratie waarin ze het laatst zijn
--     gedefinieerd; alleen de nieuwe weigering is toegevoegd. Wie hier alleen
--     een guard zou schrijven, verliest stil het bestaande gedrag.
-- ------------------------------------------------------------

-- 13a. reopen_fiscal_year: eerst de jaarrekening IN BEHANDELING intrekken
--      Heropenen zet het afsluitboekstuk op 'reversed' en haalt daarmee het
--      resultaat van 0510 af. Een opgemaakte of vastgestelde jaarrekening rust op
--      precies die cijfers en is nog niet openbaar; laten staan zou een bevroren
--      stuk opleveren dat niet meer bij de administratie past, terwijl het met
--      één handeling is in te trekken. Daarom weigert deze functie bij status
--      'prepared' en 'adopted'.
--
--      MAAR NIET BIJ 'filed'. Een gedeponeerde jaarrekening houdt het boekjaar
--      NIET op slot (kernbeslissing G). Zou zij dat wel doen, dan kan het
--      opvolgende stuk waar alle andere weigeringen naar verwijzen alleen
--      dezelfde cijfers herhalen — build_annual_accounts_snapshot leest immers
--      hetzelfde afgesloten grootboek — en is de hele herstelroute leeg. Een
--      materiële fout (vergeten voorziening, verkeerde afschrijving) moet
--      herstelbaar zijn: heropenen, corrigeren, opnieuw afsluiten en bestemmen,
--      een opvolgend stuk opmaken dat de gedeponeerde jaarrekening vervangt,
--      vaststellen en opnieuw deponeren. De deponering zelf blijft staan — die is
--      een feit (art. 2:394 BW) — en dat het boekjaar eronder is opengetrokken
--      blijft zichtbaar: fiscal_years.reopened_at/reopened_by, de audit-trigger,
--      en annual_account_snapshot_stale die het gedeponeerde stuk vanaf dat
--      moment als "loopt uit de pas" markeert in list_annual_accounts en
--      get_annual_account.
--      Volledige functie opnieuw (basis: 20260807030000), alleen de guard is nieuw.
create or replace function public.reopen_fiscal_year(
  p_organization_id uuid,
  p_fiscal_year_id uuid,
  p_created_by uuid default auth.uid()
)
returns public.fiscal_years
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fy public.fiscal_years;
  v_aa public.annual_accounts;
begin
  if auth.role() <> 'service_role' and not public.can_admin_org(p_organization_id) then
    raise exception 'Alleen een eigenaar of beheerder mag een boekjaar heropenen.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':fyclose'));

  select * into v_fy from public.fiscal_years
  where id = p_fiscal_year_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Boekjaar niet gevonden.' using errcode = '02000';
  end if;
  if v_fy.status <> 'closed' then
    raise exception 'Alleen een afgesloten boekjaar kan worden heropend.' using errcode = '23514';
  end if;

  -- Alleen het meest recent afgesloten jaar mag open: een later afgesloten jaar
  -- bouwt voort op het eindvermogen van dit jaar.
  if exists (
    select 1 from public.fiscal_years f
    where f.organization_id = p_organization_id
      and f.status = 'closed'
      and f.period_start > v_fy.period_start
  ) then
    raise exception 'Heropen eerst de latere afgesloten boekjaren (in omgekeerde volgorde).' using errcode = '23514';
  end if;

  -- NIEUW (20260812010000): een jaarrekening die nog IN BEHANDELING is, staat
  -- bovenop de bestemming en bovenop de afsluiting; zij moet er als eerste af.
  -- Bewust alleen 'prepared' en 'adopted': een GEDEPONEERD stuk blokkeert het
  -- heropenen niet, want anders is de herstelroute die alle andere weigeringen
  -- aanwijzen — een opvolgend stuk met gecorrigeerde cijfers — niet te lopen.
  -- Een 'reversed' stuk telt sowieso niet mee. De rijlock hoort erbij: zonder
  -- for update kan adopt_annual_accounts of file_annual_accounts onder READ
  -- COMMITTED naast deze transactie langs.
  select * into v_aa from public.annual_accounts aa
  where aa.fiscal_year_id = p_fiscal_year_id
    and aa.organization_id = p_organization_id
    and aa.status in ('prepared','adopted')
  order by case when aa.status = 'adopted' then 0 else 1 end, aa.created_at
  limit 1
  for update;
  if found then
    raise exception 'Voor dit boekjaar ligt een jaarrekening die nog in behandeling is (%). Trek die eerst in ("Jaarrekening intrekken"); zij is opgemaakt op de cijfers die het heropenen ongedaan maakt. Een AL GEDEPONEERDE jaarrekening houdt het heropenen niet tegen: die deponering blijft staan (art. 2:394 BW) en wordt niet gewist, maar vervangen door een opvolgend stuk dat je ná de correctie opmaakt ("Jaarrekening opmaken", met vermelding welk stuk zij vervangt en waarom).',
      case v_aa.status
        when 'prepared' then 'opgemaakt op ' || to_char(v_aa.prepared_on, 'DD-MM-YYYY')
        else 'vastgesteld op ' || to_char(v_aa.adoption_date, 'DD-MM-YYYY') end
      using errcode = '23514';
  end if;

  -- Een geldige resultaatbestemming steunt op het resultaat dat de afsluiting op
  -- 0510 zette. Dat resultaat verdwijnt hier, dus de bestemming moet eerst weg.
  if exists (
    select 1 from public.result_appropriations ra
    where ra.fiscal_year_id = p_fiscal_year_id and ra.status = 'posted'
  ) then
    raise exception 'Draai eerst de resultaatbestemming van dit boekjaar terug; die boekt vanaf dezelfde resultaatrekening.'
      using errcode = '23514';
  end if;

  -- Hef de jaar-lock op (anders blijft de balans van dit jaar vergrendeld).
  delete from public.closed_periods
  where organization_id = p_organization_id
    and period_type = 'year'
    and period_start = v_fy.period_start
    and period_end = v_fy.period_end;

  -- Void het afsluitboekstuk (blijft bewaard als 'reversed' voor audit).
  if v_fy.close_journal_entry_id is not null then
    update public.journal_entries
    set status = 'reversed'
    where id = v_fy.close_journal_entry_id
      and organization_id = p_organization_id
      and status = 'posted';
  end if;

  update public.fiscal_years
  set status = 'open', close_journal_entry_id = null,
      result_account_code = null, result_cents = null,
      reopened_at = now(), reopened_by = p_created_by
  where id = p_fiscal_year_id
  returning * into v_fy;

  return v_fy;
end;
$$;

-- Bewust GEEN revoke/grant hieronder: reopen_fiscal_year had die in
-- 20260706120000 en 20260807030000 ook niet, en "create or replace" behoudt de
-- bestaande rechten. Een rechteninperking hoort niet stilzwijgend mee te liften
-- in een blok dat zich als gedragsneutraal presenteert — hier mocht alléén de
-- weigering hierboven bij. Wil iemand de rechten aanscherpen, dan is dat een
-- eigen, aangekondigde wijziging.

-- 13b. reverse_result_appropriation: eerst de jaarrekening IN BEHANDELING intrekken
--      Precies dezelfde lijn als bij reopen_fiscal_year hierboven, en met opzet:
--      wie het boekjaar mag heropenen, moet ook de bestemming kunnen terugdraaien,
--      anders staat de herstelroute alsnog stil op stap twee.
--      * WEIGEREN bij 'prepared' en 'adopted'. Bij 'adopted' spreekt dat vanzelf:
--        het vastgestelde stuk toont de balans ná déze bestemming. Bij 'prepared'
--        is het nieuw — daar werd bewust niet geblokkeerd, met snapshot_stale als
--        vangnet. Dat vangnet blijft, maar het is geen reden om de bevroren
--        cijfers stil te laten scheefgroeien terwijl het stuk met één handeling
--        is in te trekken.
--      * TOESTAAN als er alleen een gedeponeerd of ingetrokken stuk ligt. De
--        gedeponeerde jaarrekening blijft staan en gaat uit de pas lopen
--        (snapshot_stale) — dat is zichtbaar en juist de bedoeling: de correctie
--        landt in het opvolgende stuk.
--      Volledige functie opnieuw (basis: 20260807100000), alleen de guard is nieuw.
create or replace function public.reverse_result_appropriation(
  p_organization_id uuid,
  p_appropriation_id uuid,
  p_created_by uuid default auth.uid()
)
returns public.result_appropriations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.result_appropriations;
  v_closed record;
  v_aa public.annual_accounts;
begin
  if auth.role() <> 'service_role' and not public.can_admin_org(p_organization_id) then
    raise exception 'Alleen een eigenaar of beheerder mag een resultaatbestemming terugdraaien.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':fyclose'));

  select * into v_row from public.result_appropriations
  where id = p_appropriation_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Resultaatbestemming niet gevonden.' using errcode = '02000';
  end if;
  if v_row.status <> 'posted' then
    raise exception 'Deze resultaatbestemming is al teruggedraaid.' using errcode = '23514';
  end if;

  -- De uitkering die op deze bestemming steunt (20260807100000).
  if exists (
    select 1 from public.dividend_distributions d
    where d.result_appropriation_id = p_appropriation_id and d.status = 'posted'
  ) then
    raise exception 'Draai eerst de dividenduitkering terug; die houdt belasting in op de schuld die deze bestemming heeft geboekt.'
      using errcode = '23514';
  end if;

  -- NIEUW (20260812010000): een jaarrekening die nog IN BEHANDELING is, bevriest
  -- de balans ná déze bestemming. Die mutatie mag niet onder zo'n stuk vandaan
  -- verdwijnen zolang het met één handeling is in te trekken. Een GEDEPONEERD
  -- stuk blokkeert bewust niet: zie 13b hierboven en kernbeslissing G.
  -- for update: adopt_annual_accounts en file_annual_accounts nemen inmiddels
  -- dezelfde ':fyclose'-lock, maar een rijlock erbij kost niets en sluit de
  -- laatste kier onder READ COMMITTED.
  select * into v_aa from public.annual_accounts aa
  where aa.fiscal_year_id = v_row.fiscal_year_id
    and aa.organization_id = p_organization_id
    and aa.status in ('prepared','adopted')
  order by case when aa.status = 'adopted' then 0 else 1 end, aa.created_at
  limit 1
  for update;
  if found then
    if v_aa.status = 'adopted' then
      raise exception 'De jaarrekening van dit boekjaar is op % vastgesteld en toont de balans ná deze resultaatbestemming. Trek die jaarrekening eerst in ("Jaarrekening intrekken"). Een al GEDEPONEERDE jaarrekening zou hier overigens niet in de weg staan: die blijft staan en wordt vervangen door een opvolgend stuk.',
        to_char(v_aa.adoption_date, 'DD-MM-YYYY') using errcode = '23514';
    end if;
    raise exception 'Voor dit boekjaar ligt een op % opgemaakte jaarrekening die de balans ná deze resultaatbestemming heeft bevroren. Trek die jaarrekening eerst in ("Jaarrekening intrekken") en maak haar ná de nieuwe bestemming opnieuw op. Een al GEDEPONEERDE jaarrekening zou hier niet in de weg staan: die blijft staan en wordt vervangen door een opvolgend stuk.',
      to_char(v_aa.prepared_on, 'DD-MM-YYYY') using errcode = '23514';
  end if;

  -- Het boekstuk uit de rapporten halen verandert de balans van het boekjaar
  -- waarin het besluit valt. Is dát boekjaar inmiddels zelf afgesloten, dan zou
  -- de vastgestelde balans ervan met terugwerkende kracht veranderen — precies
  -- wat reopen_fiscal_year ook weigert. Eerst dat jaar heropenen dus.
  --
  -- Alleen jaar-sloten tellen hier. Een gefinaliseerde btw-aangifte (maand of
  -- kwartaal) vergrendelt wél het BOEKEN, maar deze post raakt uitsluitend
  -- eigen-vermogensrekeningen en verandert geen enkele rubriek van die
  -- aangifte. Zou een btw-slot hier blokkeren, dan was de bestemming alsnog
  -- voorgoed onomkeerbaar: zo'n slot gaat nooit meer open.
  select cp.period_start, cp.period_end into v_closed
  from public.closed_periods cp
  where cp.organization_id = p_organization_id
    and cp.period_type = 'year'
    and v_row.decision_date between cp.period_start and cp.period_end
  limit 1;
  if found then
    raise exception 'Het besluit van % valt in boekjaar % t/m %, en dat is afgesloten. Heropen dat boekjaar eerst; anders verandert de vastgestelde balans ervan met terugwerkende kracht.',
      to_char(v_row.decision_date, 'DD-MM-YYYY'),
      to_char(v_closed.period_start, 'DD-MM-YYYY'), to_char(v_closed.period_end, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;

  if v_row.journal_entry_id is not null then
    update public.journal_entries
    set status = 'reversed'
    where id = v_row.journal_entry_id
      and organization_id = p_organization_id
      and status = 'posted';
  end if;

  update public.result_appropriations
  set status = 'reversed', reversed_at = now(), reversed_by = p_created_by
  where id = p_appropriation_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.reverse_result_appropriation(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.reverse_result_appropriation(uuid, uuid, uuid) to authenticated, service_role;

commit;
