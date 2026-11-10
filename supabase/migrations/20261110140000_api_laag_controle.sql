-- ============================================================
-- ResoFly — Controle van de API-laag
-- Date: 2026-11-10
--
-- Zie docs/rapporten/CONTROLE_API_LAAG_2026-11-10.md en
-- docs/changelog/CHANGELOG_API_LAAG_2026-11-10.md.
--
-- 1. Een rem op het registreren van AI-clients (mcp-oauth /register).
--    Registreren kan zonder login; zo werkt het koppelen van Claude en
--    ChatGPT. De grootte van één registratie was al begrensd, en registraties
--    zonder koppeling gaan na twee dagen weg (20261101070000). Het AANTAL was
--    niet begrensd: een lus over /register zette in die twee dagen zoveel rijen
--    van een paar kB neer als de functie aankon, in de database die alle
--    organisaties delen. Nu: per afzender en voor iedereen samen een plafond per
--    uur. Daarboven volgt een pauze (429).
--
--    edge_note_attempt is algemeen: een emmer (p_bucket) per soort verzoek,
--    met dezelfde tabel en dezelfde opruiming (api_purge_expired) als de
--    teller van mislukte API-sleutels. De sleutels krijgen de naam van de emmer
--    ervoor, zodat ze nooit samenvallen met die teller ('*' en de hashes van
--    de API).
--
-- 2. Delen (drive_shares) alleen voor bestanden uit Inhoud.
--    file-share en een rechtstreekse insert in drive_shares vroegen alleen
--    schrijfrecht op Inhoud. drive_item_client kent ook bijlagen van een klant,
--    project, taak of ticket, en de deellink (file-share-public) levert elke
--    bijlage uit. Een teamlid met Inhoud maar zonder Tickets of Projecten kon
--    zo een bijlage van een intern ticket of project via een deellink naar
--    zijn eigen mailadres sturen. De modulerechten gelden overal (CLAUDE.md,
--    regel 3). Het scherm, Gerrie (drive.share) en file-transfer delen al
--    alleen bestanden in een map; de database dwingt dat nu ook af. Op staging
--    bestond geen enkele deling van een andere soort bijlage.
--
-- 3. De opruimwachtrij (storage_purge_queue) wist geen bewijsstukken meer.
--    queue_office_file_purge zette elke sleutel van de eigen organisatie in de
--    wachtrij zodra een document of contract er niet meer naar wees. De
--    sleutel zelf controleerde de database alleen op het voorvoegsel van de
--    organisatie. Een teamlid met schrijfrecht op Inhoud kon dus een document
--    laten wijzen naar '<org>/invoice-pdfs/…' (een verstuurde factuur-PDF), dat
--    document verwijderen, en de nachtelijke opruimronde (file-transfer
--    ?cron=purge, via de interne DELETE van de media-worker) wiste het
--    bewijsstuk. Dat breekt de bewaarplicht (CLAUDE.md, regel 6), en R2 kent
--    geen prullenbak. Nu laat een bewaker op de wachtrij zelf alleen sleutels
--    toe die bij de bron passen: een document of map wist alleen
--    'document'/'folder', een contract alleen 'contract', een zending alleen
--    'transfer'. Een bewijsstuk of een origineel uit de factuur-inbox komt er
--    nooit in, wie of wat het ook probeert. De opruimtaak en de media-worker
--    weigeren ze voortaan ook zelf.
--
-- 4. Berichten in het portaal: het antwoord aan het hoofdadres blijft van het
--    hoofdadres. client-portal laat een contactpersoon een antwoord aan het
--    hoofdadres zien als het laatste inkomende bericht ervóór van hém was
--    (_shared/portalMessages.ts, answersMe). Die regel heeft ALLE inkomende
--    berichten van het gesprek nodig, maar deze functie gaf alleen die van een
--    portaalgebruiker zelf terug. Stuurde een teamlid een vertrouwelijke mail
--    van het hoofdadres door naar het dossier (forward_block,
--    rfc822_attachment), of koppelde het team post van een derde, dan telde
--    die niet mee: de contactpersoon zag het antwoord aan het hoofdadres, met
--    het citaat eronder. Nu komt elk inkomend bericht van de klant mee. Van
--    wat niet van een portaalgebruiker zelf is, alleen tijd en gesprek:
--    afzender, onderwerp en tekst blijven leeg, zodat er niets van kan
--    uitlekken, ook niet als de code erboven ooit een filter vergeet.
--
-- 5. Databasefuncties die elke ingelogde gebruiker kan aanroepen
--    (PostgREST /rpc). Alle 139 SECURITY DEFINER-functies voor 'authenticated'
--    zijn nagelopen; vier deden meer dan mocht:
--    a. post_journal_entry nam elke boekingssoort aan. Een teamlid met
--       schrijfrecht op Financiën boekte rechtstreeks een post met soort
--       'asset_disposal' en het id van een verkocht activum, en draaide die
--       terug: reverse_journal_entry zette het activum weer op actief, terwijl
--       de echte desinvestering geboekt bleef (ook in een afgesloten jaar).
--       Nu maakt alleen de bijbehorende functie een andere soort dan 'manual'.
--    b. organization_reserved_license_count gaf aan iedereen met een login, ook
--       een klant in het portaal, het aantal leden en openstaande uitnodigingen
--       van elke organisatie. Nu SECURITY INVOKER: de RLS geldt, en de
--       triggers en functies die hem gebruiken (owner/admin, of zelf definer)
--       tellen zoals voorheen.
--    c. org_has_creative zei aan iedereen met een login of een organisatie de
--       creatieve module heeft. Nu alleen aan wie lid is van die organisatie of
--       van een organisatie met dezelfde facturatie (moeder en dochters).
--    d. preview_next_client_code vroeg alleen lidmaatschap; een boekhouder,
--       kijker of lid zonder Klanten kreeg het volgende klantnummer. Nu
--       schrijfrecht op Klanten, net als het formulier dat hem gebruikt.
--
-- 6. Indexen voor de rem op inkomende mail. mail-inbound telt per gesprek en
--    per organisatie hoeveel mail er het afgelopen uur binnenkwam; daarboven
--    parkeert hij een bericht als 'rate_limited' (geen pushmelding, geen
--    signaal). Zonder deze indexen las dat tellen alle mail van de organisatie.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 2. Delen alleen voor bestanden uit Inhoud ──────────────────────────────

create or replace function public.drive_share_attachment_in_content()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entity text;
begin
  -- Intrekken moet altijd lukken (20260823010000), en alleen een bijlage kan
  -- uit een andere module komen: een map, notitie of document is Inhoud.
  if new.item_type is distinct from 'attachment' or new.revoked_at is not null then
    return new;
  end if;
  select a.entity_type into v_entity
    from public.attachments a
   where a.id = new.item_id and a.organization_id = new.organization_id;
  -- Bestaat hij niet, dan zegt enforce_drive_share_rules dat al.
  if found and v_entity is distinct from 'folder' then
    raise exception 'Alleen bestanden die in een map van Inhoud staan, kun je delen. Verplaats het bestand eerst naar een map.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.drive_share_attachment_in_content() from public, anon, authenticated;

drop trigger if exists drive_shares_attachment_in_content on public.drive_shares;
create trigger drive_shares_attachment_in_content
  before insert or update on public.drive_shares
  for each row execute function public.drive_share_attachment_in_content();

-- ── 3. De opruimwachtrij wist alleen wat bij de bron hoort ─────────────────

create or replace function public.storage_purge_queue_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  -- '<organisatie>/<soort>/…': het tweede stuk zegt wat het voor bestand is.
  v_segment text := split_part(coalesce(new.storage_key, ''), '/', 2);
  v_allowed text[];
begin
  v_allowed := case new.reason
    when 'document' then array['document', 'folder']
    when 'contract' then array['contract']
    when 'folder' then array['folder']
    when 'file_transfer' then array['transfer']
    when 'file_transfer_pending' then array['transfer']
    else null
  end;
  -- Bewijsstukken en inbox-originelen nooit, ook niet bij een onbekende reden.
  if v_segment in ('invoice-pdfs', 'quote-pdfs', 'contract-pdfs', 'annual-account-pdfs', 'purchase_invoice_inbox')
     or (v_allowed is not null and not (v_segment = any (v_allowed))) then
    -- Niet in de wachtrij, en geen fout: het verwijderen van het document of
    -- contract zelf moet gewoon doorgaan. Het bestand blijft staan.
    raise warning 'Opslagsleutel van soort "%" hoort niet bij opruimreden "%": niet in de wachtrij gezet.', v_segment, new.reason;
    return null;
  end if;
  return new;
end;
$$;

revoke all on function public.storage_purge_queue_guard() from public, anon, authenticated;

drop trigger if exists storage_purge_queue_guard on public.storage_purge_queue;
create trigger storage_purge_queue_guard
  before insert or update of storage_key, reason on public.storage_purge_queue
  for each row execute function public.storage_purge_queue_guard();

-- Wat er al in de wachtrij stond en niet bij zijn bron past, gaat eruit
-- (alleen de regel; het bestand blijft staan).
delete from public.storage_purge_queue q
 where split_part(q.storage_key, '/', 2) in ('invoice-pdfs', 'quote-pdfs', 'contract-pdfs', 'annual-account-pdfs', 'purchase_invoice_inbox')
    or (q.reason = 'document' and split_part(q.storage_key, '/', 2) not in ('document', 'folder'))
    or (q.reason = 'contract' and split_part(q.storage_key, '/', 2) <> 'contract')
    or (q.reason = 'folder' and split_part(q.storage_key, '/', 2) <> 'folder')
    or (q.reason in ('file_transfer', 'file_transfer_pending') and split_part(q.storage_key, '/', 2) <> 'transfer');

-- ── 1. Een rem op het registreren van AI-clients (edge_note_attempt) ───────

create or replace function public.edge_note_attempt(
  p_bucket text,
  p_client text,
  p_window_seconds integer,
  p_max integer,
  p_block_seconds integer,
  p_global_max integer
)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_row public.api_auth_failures%rowtype;
  v_all public.api_auth_failures%rowtype;
  v_window interval := make_interval(secs => greatest(coalesce(p_window_seconds, 3600), 1));
  v_block interval := make_interval(secs => greatest(coalesce(p_block_seconds, 900), 1));
  v_key text;
  v_global text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de server telt verzoeken.' using errcode = '42501';
  end if;
  -- Een emmer is een vaste naam uit de code, geen invoer van een bezoeker.
  if p_bucket is null or p_bucket !~ '^[a-z][a-z0-9-]{1,40}$' then
    raise exception 'Ongeldige emmer.' using errcode = '22023';
  end if;
  v_key := p_bucket || ':' || left(coalesce(p_client, 'onbekend'), 128);
  v_global := p_bucket || ':*';

  -- Per afzender.
  insert into public.api_auth_failures as f (client_hash, window_start, failures)
  values (v_key, now(), 1)
  on conflict (client_hash) do update
     set window_start = case when f.window_start < now() - v_window then now() else f.window_start end,
         failures = case when f.window_start < now() - v_window then 1 else f.failures + 1 end
  returning * into v_row;
  if v_row.failures > greatest(coalesce(p_max, 1), 1)
     and (v_row.blocked_until is null or v_row.blocked_until <= now()) then
    update public.api_auth_failures
       set blocked_until = now() + v_block, failures = 0, window_start = now()
     where client_hash = v_key
    returning * into v_row;
  end if;

  -- Alle afzenders samen: de telling per afzender leunt op een header die
  -- buiten Cloudflare te vervalsen is; deze niet.
  insert into public.api_auth_failures as f (client_hash, window_start, failures)
  values (v_global, now(), 1)
  on conflict (client_hash) do update
     set window_start = case when f.window_start < now() - v_window then now() else f.window_start end,
         failures = case when f.window_start < now() - v_window then 1 else f.failures + 1 end
  returning * into v_all;
  if v_all.failures > greatest(coalesce(p_global_max, 1), 1)
     and (v_all.blocked_until is null or v_all.blocked_until <= now()) then
    update public.api_auth_failures
       set blocked_until = now() + v_block, failures = 0, window_start = now()
     where client_hash = v_global
    returning * into v_all;
  end if;

  return greatest(
    case when v_row.blocked_until > now() then greatest(1, ceil(extract(epoch from (v_row.blocked_until - now()))))::integer else 0 end,
    case when v_all.blocked_until > now() then greatest(1, ceil(extract(epoch from (v_all.blocked_until - now()))))::integer else 0 end
  );
end;
$$;

revoke all on function public.edge_note_attempt(text, text, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.edge_note_attempt(text, text, integer, integer, integer, integer) to service_role;

-- ── 4. Berichten in het portaal ────────────────────────────────────────────

create or replace function public.portal_client_message_overview(
  p_organization_id uuid,
  p_client_id uuid,
  p_emails text[]
)
returns table (
  id uuid,
  thread_id uuid,
  subject text,
  direction text,
  status text,
  from_email text,
  from_name text,
  to_email text,
  source text,
  sender_source text,
  preview text,
  occurred_at timestamptz,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with mail as (
    select e.*,
           -- Inkomend en écht van een portaalgebruiker zelf (zie
           -- OWN_SENDER_SOURCES in _shared/portalMessages.ts).
           (e.direction = 'inbound'
            and coalesce(e.metadata ->> 'sender_source', '') in ('', 'header_from')
            and lower(btrim(coalesce(e.from_email, ''))) = any(coalesce(p_emails, '{}'::text[]))) as own_inbound
      from public.client_emails e
      join public.client_email_threads t
        on t.id = e.thread_id and t.organization_id = e.organization_id
     where e.organization_id = p_organization_id
       and e.client_id = p_client_id
       and e.deleted_at is null
  )
  select m.id,
         m.thread_id,
         case when m.direction = 'outbound' or m.own_inbound then m.subject end,
         m.direction,
         m.status,
         case when m.direction = 'outbound' or m.own_inbound then m.from_email end,
         case when m.direction = 'outbound' or m.own_inbound then m.from_name end,
         m.to_email,
         coalesce(m.metadata ->> 'source', ''),
         coalesce(m.metadata ->> 'sender_source', ''),
         -- Het portaal toont hooguit 160 tekens (na het samenvouwen van witruimte).
         case when m.direction = 'outbound' or m.own_inbound
              then left(coalesce(nullif(btrim(m.body_text), ''), ''), 320)
              else '' end,
         coalesce(m.received_at, m.sent_at, m.created_at),
         m.created_at
    from mail m
   where (
       (m.direction = 'outbound'
        and coalesce(m.status, '') not in ('queued', 'failed')
        and lower(btrim(coalesce(m.to_email, ''))) = any(coalesce(p_emails, '{}'::text[])))
       or
       -- Elk inkomend bericht telt mee voor "op wie antwoordt het team?";
       -- alleen dat van een portaalgebruiker zelf komt met inhoud mee.
       m.direction = 'inbound'
     )
     and not exists (
       select 1 from public.client_emails x
        where x.organization_id = m.organization_id and x.thread_id = m.thread_id
          and coalesce(x.metadata ->> 'source', '') in ('campaign', 'flow'))
     and not exists (select 1 from public.email_campaign_recipients r where r.thread_id = m.thread_id)
     and not exists (select 1 from public.email_flow_enrollments f where f.thread_id = m.thread_id)
     and not exists (select 1 from public.email_flow_sends fs where fs.thread_id = m.thread_id)
   order by m.created_at desc
   limit 2000;
$$;

revoke all on function public.portal_client_message_overview(uuid, uuid, text[]) from public, anon, authenticated;
grant execute on function public.portal_client_message_overview(uuid, uuid, text[]) to service_role;

-- ── 5. Databasefuncties voor elke ingelogde gebruiker ──────────────────────

-- a. post_journal_entry: gelijk aan 20261106110000 (zoals op staging), plus de
--    controle op de boekingssoort (zie TOEGEVOEGD (20261110140000)).
CREATE OR REPLACE FUNCTION public.post_journal_entry(p_organization_id uuid, p_date date, p_description text, p_source_type text, p_source_id uuid, p_lines jsonb, p_created_by uuid DEFAULT auth.uid())
 RETURNS journal_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_entry public.journal_entries;
  v_year integer := extract(year from p_date)::int;
  v_quarter smallint := extract(quarter from p_date)::smallint;
  v_month smallint := extract(month from p_date)::smallint;
  v_seq bigint;
  v_number text;
  v_line jsonb;
  v_idx integer := 0;
  v_account uuid;
  v_debit bigint;
  v_credit bigint;
  v_total_debit bigint := 0;
  v_total_credit bigint := 0;
  v_diff bigint;
  v_count integer;
  v_tolerance bigint;
  v_alien_code text;
  v_locked_through date;
  v_start_date date;
  v_context text;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Een journaalpost heeft minimaal één boekingsregel nodig.' using errcode = '23514';
  end if;

  -- De vrijgestelde soorten (jaarafsluiting, Vpb, dga-rente) mogen in een
  -- afgesloten periode boeken. Alleen de functies die ze maken, zetten de vlag
  -- resofly.trusted_journal_source (voor de rest van de transactie); een
  -- rechtstreekse aanroep met p_source_type => 'dga_interest' boekte anders
  -- in elke gesloten btw-periode of elk afgesloten boekjaar.
  if coalesce(p_source_type, 'manual') in ('year_close', 'corporate_tax', 'dga_interest')
     and auth.role() <> 'service_role'
     and coalesce(current_setting('resofly.trusted_journal_source', true), '') <> p_source_type then
    raise exception 'Dit soort boeking maakt alleen de jaarafsluiting, de Vpb-aangifte of de dga-renteboeking zelf.'
      using errcode = '42501';
  end if;

  -- TOEGEVOEGD (20261110140000): elke andere soort dan 'manual' (aanschaf,
  -- afschrijving, desinvestering, factuur, bank, beginbalans, …) maakt alleen
  -- de boekingsfunctie die bij die soort hoort, nooit een rechtstreekse
  -- aanroep. Tot nu toe kon een teamlid met schrijfrecht op Financiën via
  -- PostgREST een post met source_type 'asset_disposal' en het id van een
  -- verkocht activum boeken, en die daarna tegenboeken: reverse_journal_entry
  -- zette het activum dan terug op actief (disposal_date leeg, nieuw
  -- afschrijvingsschema), terwijl de echte desinvestering geboekt bleef, ook in
  -- een afgesloten jaar. Met 'asset_depreciation' kon een volledig
  -- afgeschreven activum terug naar actief. Ook de controles op de boekdatum
  -- hieronder gelden alleen voor 'manual'. De app boekt rechtstreeks alleen
  -- 'manual' (postManualJournalEntry). Een directe aanroep heeft geen functie
  -- boven zich: dan bestaat pg_context uit één regel.
  if coalesce(p_source_type, 'manual') <> 'manual' and auth.role() <> 'service_role' then
    get diagnostics v_context = pg_context;
    if position(E'\n' in coalesce(v_context, '')) = 0 then
      raise exception 'Een boeking van deze soort (%) maakt alleen de bijbehorende functie in ResoFly. Een losse journaalpost is altijd een memoriaalpost (manual).', p_source_type
        using errcode = '42501';
    end if;
  end if;

  -- TOEGEVOEGD (20261106110000): een boekdatum die niet kan. Zonder datum
  -- strandde de post op een technische fout; een handmatige boeking met een
  -- tikfout (2205 in plaats van 2025) belandde ongemerkt ver in de toekomst,
  -- buiten elk overzicht, en een datum vóór de start van de boekhouding in
  -- ResoFly schoof onder de beginbalans door.
  if p_date is null then
    raise exception 'Een journaalpost heeft een boekdatum nodig.' using errcode = '23514';
  end if;
  if coalesce(p_source_type, 'manual') = 'manual' and auth.role() <> 'service_role' then
    select cs.bookkeeping_start_date into v_start_date
    from public.company_settings cs where cs.organization_id = p_organization_id;
    if v_start_date is not null and p_date < v_start_date then
      raise exception 'Je boekhouding in ResoFly begint op %. Wat daarvoor gebeurde, zit in de beginbalans; kies een boekdatum vanaf die dag.', to_char(v_start_date, 'DD-MM-YYYY')
        using errcode = '23514';
    end if;
    if p_date > (current_date + interval '1 year')::date then
      raise exception 'Een boekdatum meer dan een jaar vooruit (%) is vast een tikfout. Kies een datum binnen een jaar.', to_char(p_date, 'DD-MM-YYYY')
        using errcode = '23514';
    end if;
  end if;

  -- Periodeslot: weiger boeken in een afgesloten aangifteperiode (maand/kwartaal/jaar).
  -- Uitzondering: het jaarafsluit-boekstuk ('year_close') zelf, dat op de laatste dag
  -- van het boekjaar valt en dus vaak binnen een reeds gesloten Q4/december-slot.
  -- GEWIJZIGD (20260807050000): 'corporate_tax' krijgt dezelfde vrijstelling.
  -- De Vpb-reservering valt per definitie op de balansdatum, en die ligt altijd
  -- in de laatste btw-periode van het boekjaar. Zonder deze uitzondering zou de
  -- reservering nooit geboekt kunnen worden zodra die aangifte is gefinaliseerd —
  -- een slot dat nooit meer opengaat. De post raakt alleen 9900 en 1540 en komt
  -- in geen enkele btw-rubriek voor, dus er valt niets te beschermen.
  -- GEWIJZIGD (20260807090000): 'dga_interest' erbij. De renteboeking valt per
  -- definitie op 31 december, en die dag ligt altijd in de laatste btw-periode
  -- van het jaar — een slot dat nooit meer opengaat. Zonder deze uitzondering
  -- kon de rente nooit geboekt worden zodra die aangifte definitief was.
  -- 'payroll' juist NIET: een loonjournaalpost in een afgesloten maand hoort
  -- wél te stuiten, want die raakt de btw-aangifte wel degelijk.
  -- GEWIJZIGD (20261104000000): één grendel per organisatie. Boekingen nemen
  -- hem gedeeld, de jaarafsluiting en het afsluiten van een btw-periode
  -- exclusief: zo glipt er geen boeking tussen het optellen en het vergrendelen.
  perform pg_advisory_xact_lock_shared(hashtext(p_organization_id::text || ':periodegrendel'));

  if coalesce(p_source_type, 'manual') not in ('year_close', 'corporate_tax', 'dga_interest') then
    -- GEWIJZIGD (20261104000000): het boekjaarslot geldt voor alles tot en met
    -- het einde van het laatst afgesloten boekjaar, ook voor datums vóór het
    -- eerste boekjaar. Afsluiten gaat op volgorde, dus de jaarsloten vormen één
    -- aaneengesloten blok.
    select max(cp.period_end) into v_locked_through
    from public.closed_periods cp
    where cp.organization_id = p_organization_id and cp.period_type = 'year';
    if v_locked_through is not null and p_date <= v_locked_through then
      raise exception 'Het boekjaar tot en met % is afgesloten; kies een boekdatum daarna.', to_char(v_locked_through, 'DD-MM-YYYY')
        using errcode = '23514';
    end if;

    -- GEWIJZIGD (20261104000000): een btw-slot houdt alleen boekingen tegen die
    -- de aangifte raken. Afschrijvingen, lonen, overlopende posten, de winst-
    -- bestemming en dividend komen in geen rubriek en horen op hun eigen datum.
    if exists (
      select 1 from public.closed_periods cp
      where cp.organization_id = p_organization_id
        and cp.period_type in ('month', 'quarter')
        and cp.period_start is not null and cp.period_end is not null
        and p_date between cp.period_start and cp.period_end
    ) and public.journal_lines_touch_vat(p_organization_id, p_lines) then
      raise exception 'De btw-aangifteperiode rond % is afgesloten; kies een boekdatum in de eerstvolgende open periode.', p_date
        using errcode = '23514';
    end if;
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':' || v_year::text));
  select count(*) + 1 into v_seq from public.journal_entries
  where organization_id = p_organization_id and year = v_year;
  v_number := 'JP-' || v_year || '-' || lpad(v_seq::text, greatest(5, length(v_seq::text)), '0');

  insert into public.journal_entries(
    organization_id, created_by, entry_number, date, year, quarter, month,
    description, source_type, source_id, status
  ) values (
    p_organization_id, p_created_by, v_number, p_date, v_year, v_quarter, v_month,
    p_description, coalesce(p_source_type, 'manual'), p_source_id, 'draft'
  ) returning * into v_entry;

  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    if (v_line ? 'account_id') and nullif(v_line->>'account_id','') is not null then
      v_account := (v_line->>'account_id')::uuid;
    else
      v_account := public.bookkeeping_account_id(p_organization_id, v_line->>'account_code');
    end if;

    v_debit := coalesce((v_line->>'debit_cents')::bigint, 0);
    v_credit := coalesce((v_line->>'credit_cents')::bigint, 0);
    v_total_debit := v_total_debit + v_debit;
    v_total_credit := v_total_credit + v_credit;

    insert into public.journal_lines(
      organization_id, entry_id, account_id, line_index, description,
      debit_cents, credit_cents, vat_code, vat_rate, vat_base_cents, vat_amount_cents,
      client_id, supplier_id, project_id
    ) values (
      p_organization_id, v_entry.id, v_account, v_idx, nullif(v_line->>'description',''),
      v_debit, v_credit,
      nullif(v_line->>'vat_code',''),
      nullif(v_line->>'vat_rate','')::numeric,
      nullif(v_line->>'vat_base_cents','')::bigint,
      nullif(v_line->>'vat_amount_cents','')::bigint,
      nullif(v_line->>'client_id','')::uuid,
      nullif(v_line->>'supplier_id','')::uuid,
      nullif(v_line->>'project_id','')::uuid
    );
    v_idx := v_idx + 1;
  end loop;

  -- Org-integriteit (FIX 6): elke regel moet op een grootboekrekening van
  -- déze organisatie boeken. Een account_id van een andere org zou de balans
  -- vervuilen met andermans rekening (cross-tenant lek in de rapportages).
  select la.code into v_alien_code
  from public.journal_lines jl
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.entry_id = v_entry.id
    and la.organization_id <> p_organization_id
  limit 1;
  if v_alien_code is not null then
    raise exception 'Grootboekrekening % hoort niet bij deze organisatie.', v_alien_code
      using errcode = '42501';
  end if;

  v_diff := v_total_debit - v_total_credit;
  v_count := v_idx;
  v_tolerance := greatest(2 * v_count, 2);

  if v_diff <> 0 then
    if abs(v_diff) <= v_tolerance then
      v_account := public.bookkeeping_account_id(p_organization_id, '4900');
      insert into public.journal_lines(
        organization_id, entry_id, account_id, line_index, description, debit_cents, credit_cents
      ) values (
        p_organization_id, v_entry.id, v_account, v_idx, 'Afrondingsverschil',
        case when v_diff < 0 then -v_diff else 0 end,
        case when v_diff > 0 then v_diff else 0 end
      );
    else
      raise exception 'Journaalpost niet in balans: debet % ≠ credit % (verschil % cent).',
        v_total_debit, v_total_credit, v_diff using errcode = '23514';
    end if;
  end if;

  update public.journal_entries
  set status = 'posted', posted_at = now(), posted_by = p_created_by
  where id = v_entry.id
  returning * into v_entry;

  return v_entry;
end;
$function$;

-- Zelfde rechten als voorheen, met zoveel woorden (migrationGrants.test.ts).
revoke all on function public.post_journal_entry(uuid, date, text, text, uuid, jsonb, uuid) from public, anon;
grant execute on function public.post_journal_entry(uuid, date, text, text, uuid, jsonb, uuid) to authenticated, service_role;

-- b. Tellen met de rechten van de aanroeper.
alter function public.organization_reserved_license_count(uuid, uuid, uuid) security invoker;

-- c.
CREATE OR REPLACE FUNCTION public.org_has_creative(p_organization_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- GEWIJZIGD (20261110140000): alleen voor wie erbij hoort. Een ingelogde
  -- gebruiker die geen lid is van deze organisatie of van een organisatie met
  -- dezelfde facturatie, krijgt false. De server (geen auth.uid()) en de
  -- policies en triggers op de galerijen (altijd een lid) zien niets anders.
  select case
    when auth.uid() is not null and not exists (
      select 1 from public.organization_members m
       where m.user_id = auth.uid() and m.status = 'active'
         and public.billing_root_organization(m.organization_id) = public.billing_root_organization(p_organization_id)
    ) then false
    else coalesce((
      select p.billing_exempt
          or bp.limits -> 'creative_included' = 'true'::jsonb
          or p.creative_enabled
      from public.organization_billing_profiles p
      join public.billing_plans bp on bp.plan_key = p.plan_key
      where p.organization_id = public.billing_root_organization(p_organization_id)
    ), false)
  end;
$function$;

-- Blijft voor authenticated: de policies en triggers op de galerijen roepen
-- hem aan met de rechten van de gebruiker.
revoke all on function public.org_has_creative(uuid) from public, anon;
grant execute on function public.org_has_creative(uuid) to authenticated, service_role;

-- d.
CREATE OR REPLACE FUNCTION public.preview_next_client_code(p_organization_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_sequence public.organization_client_number_sequences;
  v_number integer;
  v_code text;
begin
  -- GEWIJZIGD (20261110140000): schrijfrecht op Klanten, niet alleen
  -- lidmaatschap. Het nummer is alleen nodig om een klant aan te maken, en
  -- het opzoeken raakt de nummerreeks (reconcile_client_number_sequence).
  if not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'clients')) then
    raise exception 'Geen toegang tot deze organisatie.' using errcode = '42501';
  end if;

  perform public.reconcile_client_number_sequence(p_organization_id);

  select *
    into v_sequence
  from public.organization_client_number_sequences
  where organization_id = p_organization_id;

  if not found then
    return 'KL-001';
  end if;

  v_number := greatest(v_sequence.next_number, 1);
  v_code := public.format_client_code(v_sequence.prefix, v_number, v_sequence.padding);

  while exists (
    select 1
    from public.clients c
    where c.organization_id = p_organization_id
      and public.normalize_client_lookup_value(c.client_code) = public.normalize_client_lookup_value(v_code)
  ) loop
    v_number := v_number + 1;
    v_code := public.format_client_code(v_sequence.prefix, v_number, v_sequence.padding);
  end loop;

  return v_code;
end;
$function$;

revoke all on function public.preview_next_client_code(uuid) from public, anon;
grant execute on function public.preview_next_client_code(uuid) to authenticated, service_role;

-- ── 6. Indexen voor de rem op inkomende mail ───────────────────────────────

create index if not exists idx_inbound_messages_org_created
  on public.inbound_messages (organization_id, created_at desc);
create index if not exists idx_inbound_messages_origin_created
  on public.inbound_messages (origin_client_email_id, created_at desc)
  where origin_client_email_id is not null;

commit;
