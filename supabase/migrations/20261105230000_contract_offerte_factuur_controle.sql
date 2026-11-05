-- ============================================================
-- ResoFly — Contracten, offertes en facturen: controle van de hele stroom
-- Date: 2026-11-05
--
-- Uitkomst van een volledige controle van de contract-, offerte- en
-- factuurstroom (schermen, publieke pagina's, edge functions, database,
-- Gerrie/API/MCP en het klantportaal). Zie
-- docs/rapporten/REVIEW_CONTRACT_OFFERTE_FACTUUR_2026-11-05.md.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── A. Eén aanroep met de publieke sleutel liet de database crashen ────────
--
-- Op supabase/postgres 17.6.1.111 (de versie van staging) crasht Postgres
-- (signal 11) bij elke "permission denied for function" voor anon,
-- authenticated of service_role: supautils voegt een hint aan de foutmelding
-- toe en loopt daarbij vast. De postmaster herstart dan de hele database; alle
-- verbindingen van alle organisaties vallen weg. Met de publieke sleutel, die
-- in elke browser staat, was dat één verzoek naar /rest/v1/rpc/<functie> en
-- willekeurig te herhalen. Lokaal nagespeeld; 17.6.1.178 en 17.11.0.018
-- crashen niet.
--
-- Een weigering op het schema crasht niet. anon heeft in public niets meer
-- nodig (20261101000000: geen tabellen, geen functies; de prijsplannen leest
-- de app pas na het inloggen), dus anon verliest ook het gebruiksrecht op het
-- schema. Dat recht kwam niet alleen uit een eigen grant maar ook via PUBLIC
-- (=U op schema public); alleen "from anon" intrekken deed daarom niets. Elke
-- bestaande rol behalve anon krijgt het recht nu expliciet (de interne rollen
-- van Supabase leunden op PUBLIC), daarna gaat PUBLIC eraf. Voor ingelogde
-- gebruikers helpt alleen een nieuwere Postgres-versie; dat is een actie voor
-- de eigenaar (zie het rapport).

do $$
declare
  r record;
begin
  for r in select rolname from pg_roles where rolname !~ '^pg_' and rolname <> 'anon' loop
    execute format('grant usage on schema public to %I', r.rolname);
  end loop;
end $$;
revoke usage on schema public from public;
revoke usage on schema public from anon;

-- ── C1. Contract: status en werkvelden alleen via de server ────────────────
--
-- De status van een contract kon vanuit de browser (REST, elk lid met
-- schrijfrecht op Financiën) direct worden gezet. Zo kon een verstuurd
-- contract via expired → draft worden verwijderd, met de versies, events en
-- verzendingen erbij; en een geweigerd contract kon terug naar concept, met
-- een nieuwe tekst en een ander bedrag, en dan direct op 'sent': de oude link
-- tekende daarna het gewijzigde contract. Ook interne goedkeuring (met een
-- zelfgekozen goedkeurder), sent_at en de intrekvelden waren vrij te zetten.
-- Net als bij offertes zet nu alleen de server die velden: versturen
-- (contract-workflow), ondertekenen en weigeren (contract-public), intrekken
-- (void_contract) en terug naar concept (reopen_contract, hieronder).

create or replace function public.enforce_contract_workflow_fields_server_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user not in ('anon', 'authenticated', 'authenticator') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.sent_at is not null
       or new.voided_at is not null or new.voided_by is not null or new.void_reason is not null
       or new.internal_approval_requested_at is not null or new.internal_approval_requested_by is not null
       or new.internal_approved_at is not null or new.internal_approved_by is not null
       or new.internal_rejected_at is not null or new.internal_rejected_by is not null
       or new.internal_rejection_note is not null
       or new.resend_last_email_id is not null or new.last_email_delivery_status is not null
       or new.last_email_delivery_at is not null or new.last_email_failed_at is not null then
      raise exception 'Versturen, intrekken en interne goedkeuring van een contract legt alleen de server vast.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.status is distinct from old.status
     or (new.internal_approval_status, new.internal_approval_requested_at, new.internal_approval_requested_by,
         new.internal_approved_at, new.internal_approved_by, new.internal_rejected_at,
         new.internal_rejected_by, new.internal_rejection_note)
        is distinct from
        (old.internal_approval_status, old.internal_approval_requested_at, old.internal_approval_requested_by,
         old.internal_approved_at, old.internal_approved_by, old.internal_rejected_at,
         old.internal_rejected_by, old.internal_rejection_note)
     or (new.sent_at, new.voided_at, new.voided_by, new.void_reason,
         new.resend_last_email_id, new.last_email_delivery_status, new.last_email_delivery_at, new.last_email_failed_at)
        is distinct from
        (old.sent_at, old.voided_at, old.voided_by, old.void_reason,
         old.resend_last_email_id, old.last_email_delivery_status, old.last_email_delivery_at, old.last_email_failed_at)
     or new.created_by is distinct from old.created_by then
    raise exception 'De status van een contract verandert alleen via versturen, ondertekenen, weigeren, intrekken of "Terug naar concept".'
      using errcode = '42501';
  end if;

  -- Na versturen ook de koppelingen (zie C2 voor inhoud, klant en nummer). Alleen
  -- voor de browser: een verwijzing die door het verwijderen van een offerte of
  -- sjabloon leeg wordt (on delete set null), draait als eigenaar van de tabel.
  if old.status <> 'draft'
     and (new.quote_id is distinct from old.quote_id
          or new.template_id is distinct from old.template_id
          or new.supersedes_contract_id is distinct from old.supersedes_contract_id) then
    raise exception 'Contract % is al verstuurd: de koppelingen liggen vast. Kies "Terug naar concept" om iets aan te passen.', old.number
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists contracts_workflow_fields_server_only on public.contracts;
create trigger contracts_workflow_fields_server_only
  before insert or update on public.contracts
  for each row execute function public.enforce_contract_workflow_fields_server_only();

-- ── C2. Contract: na versturen liggen inhoud, klant en nummer vast ─────────
--
-- Alleen de inhoud van een getekend of ingetrokken contract lag vast. Na
-- ondertekening konden klant, nummer en de interne velden nog wijzigen; het
-- klantportaal toont en levert contracten op client_id, dus een andere klant
-- kon dan het getekende PDF van de eerste downloaden (naam, e-mail, IP en
-- handtekening). Nu ligt alles vast zodra het contract geen concept meer is;
-- wie iets wil aanpassen aan een verstuurd, geweigerd of verlopen contract,
-- zet het eerst "Terug naar concept" (de link vervalt) en verstuurt opnieuw.
-- Dat geldt ook voor de service-role: geen serverpad wijzigt deze velden na
-- het versturen. Een klant met verstuurde contracten verwijderen wordt dus
-- geweigerd (de verwijzing zou leeg worden), zoals bij offertes en facturen.

create or replace function public.enforce_contract_signed_immutability()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if TG_OP <> 'UPDATE' then return new; end if;

  -- (a) Anti-forge: op 'signed'/'declined' zetten mag UITSLUITEND vanuit de
  --     service-role (de publieke sign_/decline_contract_public-RPC's).
  if new.status is distinct from old.status
     and new.status in ('signed','declined')
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Een contract kan alleen via de publieke ondertekenflow op "%" worden gezet.', new.status
      using errcode = '42501';
  end if;

  -- (b) Ondertekenbewijs is uitsluitend door de service-role te zetten.
  if coalesce(auth.role(), '') <> 'service_role' then
    if new.signed_document_sha256 is distinct from old.signed_document_sha256
       or new.signed_storage_provider is distinct from old.signed_storage_provider
       or new.signed_storage_key is distinct from old.signed_storage_key
       or new.signed_pdf_file_name is distinct from old.signed_pdf_file_name
       or new.signed_pdf_size_bytes is distinct from old.signed_pdf_size_bytes
       or new.signed_pdf_data_base64 is distinct from old.signed_pdf_data_base64
       or new.signed_at is distinct from old.signed_at then
      raise exception 'Het ondertekenbewijs van een contract kan niet worden gewijzigd.'
        using errcode = '42501';
    end if;
  end if;

  -- (c) GEWIJZIGD: inhoud, klant en nummer zijn definitief zodra het contract
  --     geen concept meer is (was: alleen getekend of ingetrokken), voor
  --     iedereen, óók de service-role. Bij office-contracten hoort het .docx
  --     daar net zo goed bij als de HTML: dit houdt ook een WOPI-PutFile uit
  --     een nog openstaande editorsessie tegen.
  if old.status <> 'draft' then
    if new.title is distinct from old.title
       or new.body is distinct from old.body
       or new.amount_cents is distinct from old.amount_cents
       or new.currency is distinct from old.currency
       or new.date is distinct from old.date
       or new.valid_until is distinct from old.valid_until
       or new.editor_mode is distinct from old.editor_mode
       or new.body_storage_key is distinct from old.body_storage_key
       or new.body_mime_type is distinct from old.body_mime_type
       or new.body_size_bytes is distinct from old.body_size_bytes
       or new.edit_version is distinct from old.edit_version then
      raise exception 'Dit contract is al verstuurd: de inhoud ligt vast. Kies "Terug naar concept" om het aan te passen en opnieuw te versturen.'
        using errcode = '42501';
    end if;
    if new.client_id is distinct from old.client_id or new.number is distinct from old.number then
      raise exception 'Contract % is al verstuurd: klant en nummer liggen vast.', old.number
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

-- ── C3. Contract: statusovergangen ──────────────────────────────────────────
--
-- (1) 'Verstuur' op een verlopen contract: begin_contract_signature_send stond
--     'expired' toe en de mail ging de deur uit, maar complete_ liep vast op
--     expired → sent (500, verzending bleef 'queued', de klant had een link
--     die niet kon tekenen). Nu toegestaan.
-- (2) Terug naar concept vanuit 'sent' (reopen_contract). Een verstuurd
--     contract waarvan de termijn verstreek, kon niet meer worden getekend,
--     niet opnieuw worden verstuurd ("pas de datum aan") en de datum kon niet
--     worden aangepast: alleen intrekken en opnieuw beginnen bleef over.

create or replace function public.enforce_contract_status_transition()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if TG_OP <> 'UPDATE' then return new; end if;
  if old.status is not distinct from new.status then return new; end if;

  if old.status = 'draft' and new.status in ('pending_internal_approval','internally_approved','sent','voided') then return new; end if;
  if old.status = 'pending_internal_approval' and new.status in ('internally_approved','draft','voided') then return new; end if;
  if old.status = 'internally_approved' and new.status in ('sent','draft','voided') then return new; end if;
  if old.status = 'sent' and new.status in ('signed','declined','expired','voided','draft') then return new; end if;
  if old.status = 'expired' and new.status in ('sent','draft','voided') then return new; end if;
  if old.status = 'declined' and new.status in ('draft','voided') then return new; end if;

  raise exception 'Ongeldige contract-statusovergang van % naar %. Gebruik de contract-workflow acties.', old.status, new.status using errcode = '23514';
end;
$$;

-- ── C4. Contract: terug naar concept ───────────────────────────────────────
--
-- Een verstuurd, geweigerd of verlopen contract kan terug naar concept: de
-- ondertekenlink vervalt meteen, de ondertekenaar staat weer open, en het
-- contract is weer te bewerken en opnieuw te versturen (met een nieuwe
-- bevroren versie). Een getekend of ingetrokken contract niet.

alter table public.contract_events drop constraint if exists contract_events_event_type_check;
alter table public.contract_events add constraint contract_events_event_type_check check (event_type = any (array[
  'created', 'updated', 'submitted_for_internal_approval', 'internal_approval_granted',
  'internal_approval_rejected', 'public_token_created', 'sent_to_client', 'email_sent',
  'email_delivered', 'email_opened', 'email_failed', 'client_viewed', 'client_signed',
  'client_declined', 'question_asked', 'reminded', 'voided', 'expired',
  'reopened', 'signed_pdf_regenerated'
]::text[]));

create or replace function public.reopen_contract(p_contract_id uuid, p_organization_id uuid)
returns public.contracts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contract public.contracts;
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'Niet ingelogd.' using errcode = '28000'; end if;
  if not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_contract from public.contracts
   where id = p_contract_id and organization_id = p_organization_id
   for update;
  if not found then raise exception 'Contract niet gevonden.' using errcode = '02000'; end if;
  if v_contract.status not in ('sent', 'declined', 'expired') then
    raise exception 'Alleen een verstuurd, geweigerd of verlopen contract kan terug naar concept (nu: %).', v_contract.status
      using errcode = '23514';
  end if;

  update public.contracts
     set status = 'draft',
         public_token_hash = null,
         public_token_created_at = null,
         public_token_expires_at = null,
         updated_at = now()
   where id = p_contract_id
  returning * into v_contract;

  update public.contract_signers
     set status = 'pending', decline_reason = null, updated_at = now()
   where contract_id = p_contract_id and role = 'client' and status <> 'signed';

  perform public.insert_contract_event(
    p_organization_id, p_contract_id, 'reopened', 'Terug naar concept',
    'De ondertekenlink werkt niet meer. Pas het contract aan en verstuur het opnieuw.',
    '{}'::jsonb, v_user_id);
  return v_contract;
end;
$$;

revoke all on function public.reopen_contract(uuid, uuid) from public, anon;
grant execute on function public.reopen_contract(uuid, uuid) to authenticated, service_role;

-- ── C5. Contract: een verstuurd contract is niet meer te verwijderen ───────
--
-- De verwijderpolicy keek alleen naar status 'draft'. Via expired → draft (nu
-- dicht) of na "Terug naar concept" kon een contract dat naar de klant ging
-- worden gewist, met versies, events en verzendingen erbij. Net als bij
-- offertes en facturen: wat naar de klant ging, valt onder de bewaarplicht.

create or replace function public.contract_block_delete_when_sent()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user not in ('anon', 'authenticated', 'authenticator') then
    return old;
  end if;
  if old.status <> 'draft'
     or old.sent_at is not null
     or exists (select 1 from public.contract_versions v
                 where v.contract_id = old.id and v.snapshot_reason = 'sent_to_client') then
    raise exception 'Contract % is naar de klant gestuurd en valt onder de bewaarplicht. Trek het in in plaats van het te verwijderen.',
      coalesce(old.number, old.id::text) using errcode = '23514';
  end if;
  return old;
end;
$$;

drop trigger if exists contracts_block_delete_when_sent on public.contracts;
create trigger contracts_block_delete_when_sent
  before delete on public.contracts
  for each row execute function public.contract_block_delete_when_sent();

-- ── C6. Contract: projecten van een andere klant vallen weg bij klantwissel ─
--
-- De controle "project hoort bij de klant van het contract" liep alleen bij
-- het koppelen. Werd daarna de klant van een concept gewijzigd (Gerrie, REST),
-- dan bleven de projecten van de vorige klant gekoppeld en kwam
-- {{projectnaam}} van klant A in het contract voor klant B.

create or replace function public.contract_drop_projects_of_other_client()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.client_id is distinct from old.client_id and new.client_id is not null then
    delete from public.contract_projects cp
     using public.projects p
     where cp.contract_id = new.id
       and p.id = cp.project_id
       and p.client_id is not null
       and p.client_id <> new.client_id;
  end if;
  return new;
end;
$$;

drop trigger if exists contracts_drop_projects_of_other_client on public.contracts;
create trigger contracts_drop_projects_of_other_client
  after update of client_id on public.contracts
  for each row execute function public.contract_drop_projects_of_other_client();

-- ── C7. Contract: één Word-bestand hoort bij één contract ──────────────────
--
-- body_storage_key was niet uniek. Een nieuw concept dat naar het .docx van
-- een getekend contract wees, kon in Collabora worden bewerkt; dat
-- overschreef het bestand dat "Bekijken in Word" en de download voor het
-- getekende contract tonen.

create or replace function public.enforce_contract_storage_key_unique()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.body_storage_key is not null
     and (tg_op = 'INSERT' or new.body_storage_key is distinct from old.body_storage_key)
     and exists (select 1 from public.contracts c
                  where c.body_storage_key = new.body_storage_key and c.id <> new.id) then
    raise exception 'Dit Word-bestand hoort al bij een ander contract.' using errcode = '23505';
  end if;
  return new;
end;
$$;

drop trigger if exists contracts_storage_key_unique on public.contracts;
create trigger contracts_storage_key_unique
  before insert or update of body_storage_key on public.contracts
  for each row execute function public.enforce_contract_storage_key_unique();

-- Triggerfuncties: niet voor anon. Bewust níet ingetrokken voor authenticated:
-- op 17.6.1.111 laat juist een geweigerde aanroep de database crashen (zie A),
-- terwijl een toegestane aanroep van een triggerfunctie gewoon "trigger
-- functions can only be called as triggers" geeft.
revoke all on function public.enforce_contract_workflow_fields_server_only() from public, anon;
revoke all on function public.enforce_contract_signed_immutability() from public, anon;
revoke all on function public.enforce_contract_status_transition() from public, anon;
revoke all on function public.contract_block_delete_when_sent() from public, anon;
revoke all on function public.contract_drop_projects_of_other_client() from public, anon;
revoke all on function public.enforce_contract_storage_key_unique() from public, anon;
grant execute on function public.enforce_contract_workflow_fields_server_only() to authenticated, service_role;
grant execute on function public.contract_block_delete_when_sent() to authenticated, service_role;
grant execute on function public.contract_drop_projects_of_other_client() to authenticated, service_role;
grant execute on function public.enforce_contract_storage_key_unique() to authenticated, service_role;


-- ── D1. Offerte: de link met token staat nergens meer leesbaar ─────────────
--
-- begin_quote_email_send bewaarde de volledige link (met token) in de
-- verzendregel, en create_quote_version_snapshot kopieerde die regel naar
-- elke offerteversie. Elke lezer van Financiën, ook de boekhouder (gast), kon
-- de link zo uitlezen en "namens de klant" akkoord geven. Nu: de link zonder
-- token, en de bestaande regels en versies zijn geschoond. Daarnaast rekent
-- de versie de totalen nu per btw-tarief, zoals de factuur (zie hieronder), en
-- vergelijkt begin_ de geldigheidsdatum met de datum in Nederland.

CREATE OR REPLACE FUNCTION public.begin_quote_email_send(p_quote_id uuid, p_organization_id uuid, p_actor_user_id uuid, p_token_hash text, p_token_expires_at timestamp with time zone, p_recipient_email text, p_recipient_name text, p_subject text, p_public_url text, p_attachment_file_name text DEFAULT NULL::text, p_attachment_mime_type text DEFAULT 'application/pdf'::text, p_attachment_size_bytes integer DEFAULT NULL::integer, p_attachment_sha256 text DEFAULT NULL::text, p_attachment_data_base64 text DEFAULT NULL::text, p_attachment_storage_provider text DEFAULT NULL::text, p_attachment_storage_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_quote public.quotes;
  v_delivery public.quote_email_deliveries;
  v_storage_provider text := nullif(btrim(coalesce(p_attachment_storage_provider, '')), '');
  v_storage_key text := nullif(btrim(coalesce(p_attachment_storage_key, '')), '');
  v_data_base64 text := nullif(btrim(coalesce(p_attachment_data_base64, '')), '');
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de server mag een offerte-e-mail voorbereiden' using errcode = '42501';
  end if;

  select * into v_quote
  from public.quotes
  where id = p_quote_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Offerte niet gevonden' using errcode = '02000'; end if;
  if v_quote.status <> 'internally_approved' or v_quote.internal_approval_status <> 'approved' then
    raise exception 'Alleen intern goedgekeurde offertes kunnen worden verstuurd' using errcode = '23514';
  end if;
  if v_quote.valid_until is not null and v_quote.valid_until < (now() at time zone 'Europe/Amsterdam')::date then
    raise exception 'Deze offerte is verlopen en kan niet meer worden verstuurd' using errcode = '23514';
  end if;

  -- A real PDF snapshot is mandatory: either stored in private R2 or as a
  -- base64 database fallback. This guarantees the sent PDF can always be
  -- re-downloaded afterwards.
  if v_storage_provider = 'r2' and v_storage_key is null then
    raise exception 'R2 PDF storage provider vereist een storage key.' using errcode = '23514';
  end if;
  if v_storage_provider is null and v_data_base64 is null then
    raise exception 'PDF-snapshot moet in private storage of als database-fallback worden vastgelegd.' using errcode = '23514';
  end if;

  if exists (
    select 1 from public.quote_email_deliveries d
    where d.quote_id = p_quote_id
      and d.organization_id = p_organization_id
      and d.status = 'queued'
      and d.created_at > now() - interval '15 minutes'
  ) then
    raise exception 'Er loopt al een recente Resend-verzendpoging voor deze offerte' using errcode = '23505';
  end if;

  update public.quotes
  set public_token_hash = p_token_hash,
      public_token_created_at = now(),
      public_token_expires_at = p_token_expires_at,
      last_email_delivery_status = 'queued',
      last_pdf_file_name = coalesce(nullif(trim(coalesce(p_attachment_file_name, '')), ''), last_pdf_file_name),
      last_pdf_mime_type = coalesce(nullif(trim(coalesce(p_attachment_mime_type, '')), ''), last_pdf_mime_type),
      last_pdf_size_bytes = coalesce(p_attachment_size_bytes, last_pdf_size_bytes),
      last_pdf_sha256 = coalesce(nullif(trim(coalesce(p_attachment_sha256, '')), ''), last_pdf_sha256),
      updated_at = now()
  where id = p_quote_id
  returning * into v_quote;

  insert into public.quote_email_deliveries(
    organization_id,
    quote_id,
    provider,
    provider_email_id,
    recipient_email,
    recipient_name,
    subject,
    status,
    last_event_at,
    attachment_file_name,
    attachment_mime_type,
    attachment_size_bytes,
    attachment_sha256,
    metadata
  ) values (
    p_organization_id,
    p_quote_id,
    'resend',
    null,
    lower(trim(p_recipient_email)),
    nullif(trim(coalesce(p_recipient_name, '')), ''),
    p_subject,
    'queued',
    now(),
    nullif(trim(coalesce(p_attachment_file_name, '')), ''),
    coalesce(nullif(trim(coalesce(p_attachment_mime_type, '')), ''), 'application/pdf'),
    p_attachment_size_bytes,
    nullif(trim(coalesce(p_attachment_sha256, '')), ''),
    jsonb_strip_nulls(jsonb_build_object(
      'publicUrl', regexp_replace(coalesce(p_public_url, ''), '(/quote/)[^/?#]+', '\1(verborgen)'),
      'expiresAt', p_token_expires_at,
      'attachmentDataBase64', v_data_base64,
      'attachmentStorageProvider', v_storage_provider,
      'attachmentStorageKey', v_storage_key,
      'attachment', jsonb_build_object(
        'fileName', nullif(trim(coalesce(p_attachment_file_name, '')), ''),
        'mimeType', coalesce(nullif(trim(coalesce(p_attachment_mime_type, '')), ''), 'application/pdf'),
        'sizeBytes', p_attachment_size_bytes,
        'sha256', nullif(trim(coalesce(p_attachment_sha256, '')), '')
      )
    ))
  ) returning * into v_delivery;

  perform public.insert_quote_workflow_event(p_organization_id, p_quote_id, 'public_token_created', 'Publieke offertelink aangemaakt', 'Link voorbereid voor verzending via Resend.', jsonb_build_object('expiresAt', p_token_expires_at), p_actor_user_id);

  return jsonb_build_object('deliveryId', v_delivery.id, 'quoteId', v_quote.id);
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_quote_version_snapshot(p_quote_id uuid, p_organization_id uuid, p_snapshot_reason text, p_actor_user_id uuid DEFAULT NULL::uuid, p_delivery_id uuid DEFAULT NULL::uuid, p_pdf_file_name text DEFAULT NULL::text, p_pdf_mime_type text DEFAULT NULL::text, p_pdf_size_bytes integer DEFAULT NULL::integer, p_pdf_sha256 text DEFAULT NULL::text, p_quote_version_pdf_url text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS quote_versions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_quote public.quotes;
  v_delivery public.quote_email_deliveries;
  v_version public.quote_versions;
  v_sent_version public.quote_versions;
  v_version_number integer;
  v_line jsonb;
  v_lines jsonb;
  v_index integer := 0;
  v_quantity numeric := 0;
  v_unit_price numeric := 0;
  v_vat_percentage numeric := 0;
  v_line_subtotal numeric := 0;
  v_line_vat numeric := 0;
  v_line_total numeric := 0;
  v_subtotal numeric := 0;
  v_vat_total numeric := 0;
  v_total numeric := 0;
  v_pdf_file_name text := nullif(trim(coalesce(p_pdf_file_name, '')), '');
  v_pdf_sha256 text := lower(nullif(trim(coalesce(p_pdf_sha256, '')), ''));
  v_pdf_url text := nullif(trim(coalesce(p_quote_version_pdf_url, '')), '');
  v_has_pdf boolean;
  v_pdf_mime_type text;
  v_client_snapshot jsonb := 'null'::jsonb;
  v_project_snapshot jsonb := 'null'::jsonb;
  v_company_snapshot jsonb := 'null'::jsonb;
  v_delivery_snapshot jsonb := 'null'::jsonb;
  v_sent_version_snapshot jsonb := 'null'::jsonb;
  v_accepted_sent_version_id uuid := null;
begin
  if p_snapshot_reason not in ('internal_approval','sent_to_client','client_accepted','manual') then
    raise exception 'Ongeldige offerte snapshot reason: %', p_snapshot_reason using errcode = '23514';
  end if;

  if auth.role() = 'authenticated' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie' using errcode = '42501';
  end if;

  select * into v_quote
  from public.quotes
  where id = p_quote_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Offerte niet gevonden' using errcode = '02000'; end if;

  if p_delivery_id is not null then
    select * into v_delivery
    from public.quote_email_deliveries
    where id = p_delivery_id
      and quote_id = p_quote_id
      and organization_id = p_organization_id
    for update;

    if not found then raise exception 'E-maildelivery hoort niet bij deze offerte' using errcode = '23514'; end if;
    -- Zonder de link (met token) en zonder de PDF-bytes: die stonden zo leesbaar
    -- voor elke lezer van Financiën, ook de boekhouder (gast).
    v_delivery_snapshot := (to_jsonb(v_delivery) #- '{metadata,publicUrl}') #- '{metadata,attachmentDataBase64}';
  end if;

  if v_quote.client_id is not null then
    select to_jsonb(c) into v_client_snapshot
    from public.clients c
    where c.id = v_quote.client_id
      and c.organization_id = p_organization_id;
    v_client_snapshot := coalesce(v_client_snapshot, 'null'::jsonb);
  end if;

  if v_quote.project_id is not null then
    select to_jsonb(p) into v_project_snapshot
    from public.projects p
    where p.id = v_quote.project_id
      and p.organization_id = p_organization_id;
    v_project_snapshot := coalesce(v_project_snapshot, 'null'::jsonb);
  end if;

  select to_jsonb(cs) into v_company_snapshot
  from public.company_settings cs
  where cs.organization_id = p_organization_id;
  v_company_snapshot := coalesce(v_company_snapshot, 'null'::jsonb);

  v_has_pdf := v_pdf_file_name is not null or v_pdf_sha256 is not null or p_pdf_size_bytes is not null or v_pdf_url is not null;
  v_pdf_mime_type := case
    when v_has_pdf then coalesce(nullif(trim(coalesce(p_pdf_mime_type, '')), ''), 'application/pdf')
    else null
  end;

  if p_snapshot_reason = 'sent_to_client' then
    if not v_has_pdf or v_pdf_file_name is null or p_pdf_size_bytes is null or p_pdf_size_bytes <= 0 or v_pdf_sha256 is null then
      raise exception 'Een verzonden offerteversie vereist een echte PDF-bijlage met bestandsnaam, grootte en SHA-256 hash' using errcode = '23514';
    end if;
  end if;

  if v_pdf_sha256 is not null and v_pdf_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'PDF SHA-256 hash is ongeldig' using errcode = '23514';
  end if;

  if p_pdf_size_bytes is not null and p_pdf_size_bytes <= 0 then
    raise exception 'PDF-bestandsgrootte moet groter zijn dan 0 bytes' using errcode = '23514';
  end if;

  if v_has_pdf and v_pdf_mime_type <> 'application/pdf' then
    raise exception 'Alleen application/pdf is toegestaan als offertebijlage' using errcode = '23514';
  end if;

  if p_snapshot_reason = 'client_accepted' then
    v_accepted_sent_version_id := v_quote.sent_version_id;

    if v_accepted_sent_version_id is null then
      raise exception 'Acceptatie kan niet worden vastgelegd zonder gekoppelde verzonden offerteversie' using errcode = '23514';
    end if;

    select * into v_sent_version
    from public.quote_versions
    where id = v_accepted_sent_version_id
      and organization_id = p_organization_id
      and quote_id = p_quote_id
      and snapshot_reason = 'sent_to_client';

    if not found then
      raise exception 'Gekoppelde verzonden offerteversie is niet gevonden' using errcode = '23514';
    end if;

    if v_quote.last_pdf_sha256 is not null and v_sent_version.pdf_sha256 is not null and v_quote.last_pdf_sha256 <> v_sent_version.pdf_sha256 then
      raise exception 'Acceptatie-PDF hash komt niet overeen met de verzonden offerteversie' using errcode = '23514';
    end if;

    v_sent_version_snapshot := jsonb_build_object(
      'id', v_sent_version.id,
      'versionNumber', v_sent_version.version_number,
      'snapshotReason', v_sent_version.snapshot_reason,
      'pdfSha256', v_sent_version.pdf_sha256,
      'pdfFileName', v_sent_version.pdf_file_name,
      'pdfSizeBytes', v_sent_version.pdf_size_bytes,
      'createdAt', v_sent_version.created_at
    );
  end if;

  v_lines := coalesce(v_quote.lines, '[]'::jsonb);
  if jsonb_typeof(v_lines) <> 'array' then
    v_lines := '[]'::jsonb;
  end if;

  for v_line in select * from jsonb_array_elements(v_lines) loop
    v_quantity := case when coalesce(v_line->>'quantity', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v_line->>'quantity')::numeric else 0 end;
    v_unit_price := case when coalesce(v_line->>'unit_price', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v_line->>'unit_price')::numeric else 0 end;
    v_vat_percentage := case when coalesce(v_line->>'vat', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v_line->>'vat')::numeric else 0 end;
    v_line_subtotal := round(v_quantity * v_unit_price, 2);
    v_line_vat := round(v_line_subtotal * (v_vat_percentage / 100), 2);
    v_line_total := round(v_line_subtotal + v_line_vat, 2);
    v_subtotal := v_subtotal + v_line_subtotal;
    v_vat_total := v_vat_total + v_line_vat;
    v_total := v_total + v_line_total;
  end loop;

  -- GEWIJZIGD (20261105230000): de totalen van de versie zoals de factuur ze
  -- rekent, btw per tarief (invoice_calculated_totals). Per regel afronden gaf
  -- bij 2 × € 1,02 en 2 × 0,25 × € 95,50 tegen 21% € 60,24 in de versie en
  -- € 60,26 op de factuur die uit deze offerte kwam. De regels hieronder
  -- (quote_version_items) tonen per regel, zoals op het scherm.
  select t.subtotal, t.vat, t.total
    into v_subtotal, v_vat_total, v_total
    from public.invoice_calculated_totals(v_lines) t;

  select coalesce(max(version_number), 0) + 1
  into v_version_number
  from public.quote_versions
  where organization_id = p_organization_id
    and quote_id = p_quote_id;

  insert into public.quote_versions(
    organization_id,
    quote_id,
    delivery_id,
    accepted_sent_version_id,
    version_number,
    snapshot_reason,
    status_at_snapshot,
    internal_approval_status_at_snapshot,
    quote_number,
    client_id,
    project_id,
    quote_date,
    valid_until,
    notes,
    subtotal_amount,
    vat_amount,
    total_amount,
    quote_version_pdf_url,
    pdf_file_name,
    pdf_mime_type,
    pdf_size_bytes,
    pdf_sha256,
    snapshot_data,
    created_by
  ) values (
    p_organization_id,
    p_quote_id,
    p_delivery_id,
    v_accepted_sent_version_id,
    v_version_number,
    p_snapshot_reason,
    v_quote.status,
    v_quote.internal_approval_status,
    v_quote.number,
    v_quote.client_id,
    v_quote.project_id,
    v_quote.date,
    v_quote.valid_until,
    v_quote.notes,
    round(v_subtotal, 2),
    round(v_vat_total, 2),
    round(v_total, 2),
    v_pdf_url,
    v_pdf_file_name,
    v_pdf_mime_type,
    case when v_has_pdf then p_pdf_size_bytes else null end,
    v_pdf_sha256,
    jsonb_build_object(
      'quote', to_jsonb(v_quote) - 'public_token_hash',
      'quoteLines', v_lines,
      'clientSnapshot', v_client_snapshot,
      'projectSnapshot', v_project_snapshot,
      'companySnapshot', v_company_snapshot,
      'deliverySnapshot', v_delivery_snapshot,
      'sentVersionSnapshot', v_sent_version_snapshot,
      'acceptedSentVersionId', v_accepted_sent_version_id,
      'totals', jsonb_build_object('subtotal', round(v_subtotal, 2), 'vat', round(v_vat_total, 2), 'total', round(v_total, 2)),
      'reason', p_snapshot_reason,
      'deliveryId', p_delivery_id,
      'pdf', case when v_has_pdf then jsonb_build_object(
        'fileName', v_pdf_file_name,
        'mimeType', v_pdf_mime_type,
        'sizeBytes', p_pdf_size_bytes,
        'sha256', v_pdf_sha256,
        'url', v_pdf_url
      ) else '{}'::jsonb end,
      'metadata', coalesce(p_metadata, '{}'::jsonb)
    ),
    p_actor_user_id
  ) returning * into v_version;

  v_index := 0;
  for v_line in select * from jsonb_array_elements(v_lines) loop
    v_quantity := case when coalesce(v_line->>'quantity', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v_line->>'quantity')::numeric else 0 end;
    v_unit_price := case when coalesce(v_line->>'unit_price', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v_line->>'unit_price')::numeric else 0 end;
    v_vat_percentage := case when coalesce(v_line->>'vat', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v_line->>'vat')::numeric else 0 end;
    v_line_subtotal := round(v_quantity * v_unit_price, 2);
    v_line_vat := round(v_line_subtotal * (v_vat_percentage / 100), 2);
    v_line_total := round(v_line_subtotal + v_line_vat, 2);

    insert into public.quote_version_items(
      organization_id,
      quote_id,
      quote_version_id,
      source_line_id,
      line_index,
      description,
      quantity,
      unit_price,
      vat_percentage,
      line_subtotal,
      line_vat,
      line_total
    ) values (
      p_organization_id,
      p_quote_id,
      v_version.id,
      nullif(v_line->>'id', ''),
      v_index,
      coalesce(nullif(trim(coalesce(v_line->>'description', '')), ''), '-'),
      v_quantity,
      v_unit_price,
      v_vat_percentage,
      v_line_subtotal,
      v_line_vat,
      v_line_total
    );

    v_index := v_index + 1;
  end loop;

  update public.quotes
  set latest_version_id = v_version.id,
      internal_approved_version_id = case when p_snapshot_reason = 'internal_approval' then v_version.id else internal_approved_version_id end,
      sent_version_id = case when p_snapshot_reason = 'sent_to_client' then v_version.id else sent_version_id end,
      accepted_version_id = case when p_snapshot_reason = 'client_accepted' then v_version.id else accepted_version_id end,
      accepted_sent_version_id = case when p_snapshot_reason = 'client_accepted' then v_accepted_sent_version_id else accepted_sent_version_id end,
      last_pdf_file_name = case when v_has_pdf then coalesce(v_pdf_file_name, last_pdf_file_name) else last_pdf_file_name end,
      last_pdf_mime_type = case when v_has_pdf then coalesce(v_pdf_mime_type, last_pdf_mime_type) else last_pdf_mime_type end,
      last_pdf_size_bytes = case when v_has_pdf then coalesce(p_pdf_size_bytes, last_pdf_size_bytes) else last_pdf_size_bytes end,
      last_pdf_sha256 = case when v_has_pdf then coalesce(v_pdf_sha256, last_pdf_sha256) else last_pdf_sha256 end,
      updated_at = now()
  where id = p_quote_id
    and organization_id = p_organization_id;

  if p_delivery_id is not null then
    update public.quote_email_deliveries
    set quote_version_id = v_version.id,
        attachment_file_name = case when v_has_pdf then coalesce(v_pdf_file_name, attachment_file_name) else attachment_file_name end,
        attachment_mime_type = case when v_has_pdf then coalesce(v_pdf_mime_type, attachment_mime_type) else attachment_mime_type end,
        attachment_size_bytes = case when v_has_pdf then coalesce(p_pdf_size_bytes, attachment_size_bytes) else attachment_size_bytes end,
        attachment_sha256 = case when v_has_pdf then coalesce(v_pdf_sha256, attachment_sha256) else attachment_sha256 end,
        updated_at = now()
    where id = p_delivery_id;
  end if;

  perform public.insert_quote_workflow_event(
    p_organization_id,
    p_quote_id,
    'quote_version_created',
    'Offerteversie vastgelegd',
    'Versie ' || v_version.version_number || ' opgeslagen voor ' || p_snapshot_reason || '.',
    jsonb_build_object('versionId', v_version.id, 'versionNumber', v_version.version_number, 'reason', p_snapshot_reason, 'pdfSha256', v_pdf_sha256, 'acceptedSentVersionId', v_accepted_sent_version_id),
    p_actor_user_id
  );

  if v_has_pdf and v_pdf_sha256 is not null then
    perform public.insert_quote_workflow_event(
      p_organization_id,
      p_quote_id,
      'quote_pdf_attached',
      'PDF-bijlage vastgelegd',
      coalesce(v_pdf_file_name, 'Offerte PDF') || ' is als verzonden PDF-snapshot geregistreerd.',
      jsonb_build_object('versionId', v_version.id, 'fileName', v_pdf_file_name, 'sizeBytes', p_pdf_size_bytes, 'sha256', v_pdf_sha256, 'acceptedSentVersionId', v_accepted_sent_version_id),
      p_actor_user_id
    );
    perform public.insert_quote_audit_event(
      p_organization_id,
      p_quote_id,
      'quote_pdf_attached',
      v_quote.number,
      jsonb_build_object('versionId', v_version.id, 'fileName', v_pdf_file_name, 'sizeBytes', p_pdf_size_bytes, 'sha256', v_pdf_sha256, 'acceptedSentVersionId', v_accepted_sent_version_id),
      p_actor_user_id
    );
  end if;

  perform public.insert_quote_audit_event(
    p_organization_id,
    p_quote_id,
    'quote_version_created',
    v_quote.number,
    jsonb_build_object('versionId', v_version.id, 'versionNumber', v_version.version_number, 'reason', p_snapshot_reason, 'acceptedSentVersionId', v_accepted_sent_version_id),
    p_actor_user_id
  );

  return v_version;
end;
$function$;

CREATE OR REPLACE FUNCTION public.decide_quote_portal(p_quote_id uuid, p_organization_id uuid, p_kind text, p_name text, p_email text, p_note text DEFAULT NULL::text, p_contact_id uuid DEFAULT NULL::uuid)
 RETURNS quotes
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_quote public.quotes;
  v_version public.quote_versions;
  v_sent_version_id uuid;
  v_kind text := lower(btrim(coalesce(p_kind, '')));
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de klantportaal-service mag portaalbeslissingen verwerken' using errcode = '42501';
  end if;
  if v_kind not in ('accept', 'reject') then
    raise exception 'Ongeldige beslissing: %', p_kind using errcode = '22023';
  end if;

  select * into v_quote
  from public.quotes
  where id = p_quote_id
    and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Offerte niet gevonden' using errcode = '02000';
  end if;

  -- GEWIJZIGD (20261105230000): alleen over een offerte van de eigen klant.
  -- Het portaal liet een klant ook offertes zien en accepteren via een project
  -- dat later naar hem verhuisde (de offerte bleef van de vorige klant). De
  -- edge function kijkt nu naar de klant van de offerte zelf; hier nog eens,
  -- zodat geen enkele aanroeper namens een ander kan beslissen. Een offerte
  -- zonder eigen klant telt via het project, zoals in het portaal.
  if not exists (
    select 1
    from public.portal_clients_for_email(p_email) pc
    where pc.organization_id = v_quote.organization_id
      and (pc.id = v_quote.client_id
           or (v_quote.client_id is null and v_quote.project_id is not null
               and exists (select 1 from public.projects pr
                           where pr.id = v_quote.project_id
                             and pr.organization_id = v_quote.organization_id
                             and pr.client_id = pc.id)))
  ) then
    raise exception 'Offerte niet gevonden' using errcode = '02000';
  end if;

  if v_quote.status <> 'sent' then
    raise exception 'Deze offerte kan niet meer worden %',
      case when v_kind = 'accept' then 'geaccepteerd' else 'geweigerd' end
      using errcode = '23514';
  end if;

  if nullif(trim(coalesce(p_name, '')), '') is null then
    raise exception 'Naam is verplicht om de offerte te beslissen' using errcode = '23514';
  end if;
  if nullif(lower(trim(coalesce(p_email, ''))), '') is null
     or lower(trim(coalesce(p_email, ''))) !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'Geldig e-mailadres is verplicht om de offerte te beslissen' using errcode = '23514';
  end if;

  -- Als een contact_id is meegegeven, moet die contactpersoon daadwerkelijk bij
  -- déze klant horen — anders NULL negeren i.p.v. blind vertrouwen.
  if p_contact_id is not null and not exists (
    select 1 from public.client_contacts cc
    where cc.id = p_contact_id and cc.client_id = v_quote.client_id
  ) then
    p_contact_id := null;
  end if;

  if v_kind = 'accept' then
    if v_quote.sent_version_id is null then
      raise exception 'Deze offerte mist een verzonden versie en kan niet worden geaccepteerd' using errcode = '23514';
    end if;
    if v_quote.valid_until is not null and v_quote.valid_until < (now() at time zone 'Europe/Amsterdam')::date then
      raise exception 'Deze offerte is verlopen en kan niet meer worden geaccepteerd' using errcode = '23514';
    end if;

    v_sent_version_id := v_quote.sent_version_id;

    update public.quotes
    set status = 'accepted',
        accepted_at = now(),
        client_decision_at = now(),
        client_decision_by_name = nullif(trim(coalesce(p_name, '')), ''),
        client_decision_by_email = nullif(lower(trim(coalesce(p_email, ''))), ''),
        client_decision_by_contact_id = p_contact_id,
        client_decision_note = nullif(trim(coalesce(p_note, '')), ''),
        accepted_sent_version_id = v_sent_version_id,
        updated_at = now()
    where id = v_quote.id
    returning * into v_quote;

    v_version := public.create_quote_version_snapshot(
      v_quote.id,
      v_quote.organization_id,
      'client_accepted',
      null,
      null,
      v_quote.last_pdf_file_name,
      v_quote.last_pdf_mime_type,
      v_quote.last_pdf_size_bytes,
      v_quote.last_pdf_sha256,
      null,
      jsonb_build_object('clientDecisionName', p_name, 'clientDecisionEmail', p_email, 'clientDecisionContactId', p_contact_id, 'acceptedSentVersionId', v_sent_version_id, 'source', 'client_portal')
    );

    perform public.insert_quote_workflow_event(
      v_quote.organization_id, v_quote.id, 'client_accepted',
      'Klant heeft de offerte geaccepteerd', nullif(trim(coalesce(p_note, '')), ''),
      jsonb_build_object('name', p_name, 'email', p_email, 'contactId', p_contact_id, 'acceptedVersionId', v_version.id, 'acceptedSentVersionId', v_sent_version_id, 'source', 'client_portal'), null);
    perform public.insert_quote_audit_event(
      v_quote.organization_id, v_quote.id, 'quote_client_accepted', v_quote.number,
      jsonb_build_object('name', p_name, 'email', p_email, 'contactId', p_contact_id, 'acceptedVersionId', v_version.id, 'acceptedSentVersionId', v_sent_version_id, 'source', 'client_portal'), null);
  else
    update public.quotes
    set status = 'rejected',
        client_decision_at = now(),
        client_decision_by_name = nullif(trim(coalesce(p_name, '')), ''),
        client_decision_by_email = nullif(lower(trim(coalesce(p_email, ''))), ''),
        client_decision_by_contact_id = p_contact_id,
        client_decision_note = nullif(trim(coalesce(p_note, '')), ''),
        updated_at = now()
    where id = v_quote.id
    returning * into v_quote;

    perform public.insert_quote_workflow_event(
      v_quote.organization_id, v_quote.id, 'client_rejected',
      'Klant heeft de offerte geweigerd', nullif(trim(coalesce(p_note, '')), ''),
      jsonb_build_object('name', p_name, 'email', p_email, 'contactId', p_contact_id, 'source', 'client_portal'), null);
    perform public.insert_quote_audit_event(
      v_quote.organization_id, v_quote.id, 'quote_client_rejected', v_quote.number,
      jsonb_build_object('name', p_name, 'email', p_email, 'contactId', p_contact_id, 'source', 'client_portal'), null);
  end if;

  select * into v_quote
  from public.quotes
  where id = p_quote_id and organization_id = p_organization_id;

  return v_quote;
end;
$function$;

-- Rechten ongewijzigd: alleen de server (zoals ervoor).
revoke all on function public.begin_quote_email_send(uuid, uuid, uuid, text, timestamptz, text, text, text, text, text, text, integer, text, text, text, text) from public, anon, authenticated;
grant execute on function public.begin_quote_email_send(uuid, uuid, uuid, text, timestamptz, text, text, text, text, text, text, integer, text, text, text, text) to service_role;
revoke all on function public.create_quote_version_snapshot(uuid, uuid, text, uuid, uuid, text, text, integer, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.create_quote_version_snapshot(uuid, uuid, text, uuid, uuid, text, text, integer, text, text, jsonb) to service_role;
revoke all on function public.decide_quote_portal(uuid, uuid, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.decide_quote_portal(uuid, uuid, text, text, text, text, uuid) to service_role;

update public.quote_email_deliveries
   set metadata = jsonb_set(metadata, '{publicUrl}',
         to_jsonb(regexp_replace(metadata->>'publicUrl', '(/quote/)[^/?#]+', '\1(verborgen)')))
 where metadata ? 'publicUrl'
   and metadata->>'publicUrl' ~ '/quote/[^/?#]+'
   and metadata->>'publicUrl' !~ '/quote/\(verborgen\)';

update public.quote_versions
   set snapshot_data = snapshot_data #- '{deliverySnapshot,metadata,publicUrl}'
 where snapshot_data #> '{deliverySnapshot,metadata,publicUrl}' is not null;

-- ── D2. Offerte: bewijs bij akkoord of afwijzing ───────────────────────────

-- Bewijs bij een klantbeslissing: wie besliste en waarvandaan. Alleen een
-- ingetypte naam en een willekeurig e-mailadres telden; een collega met de link
-- (of met alleen leesrecht: de link stond in de verzendregel en de PDF) kon
-- "namens de klant" akkoord geven, en dat zag er niet anders uit dan echt.
-- Nu ook het IP-adres en de browser (zoals bij een contract), en of het
-- ingetypte adres het adres is waar de offerte heen ging.
drop function if exists public.accept_quote_public(text, text, text, text);
create or replace function public.accept_quote_public(
  p_token_hash text,
  p_name text,
  p_email text,
  p_note text default null,
  p_ip text default null,
  p_user_agent text default null
)
returns public.quotes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
  v_version public.quote_versions;
  v_sent_version_id uuid;
  v_typed_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_invited_email text;
  v_evidence jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de publieke offerte-service mag klantbeslissingen verwerken' using errcode = '42501';
  end if;
  if length(coalesce(p_name, '')) > 200 or length(coalesce(p_email, '')) > 254 or length(coalesce(p_note, '')) > 4000 then
    raise exception 'Naam, e-mailadres of opmerking is te lang (opmerking: maximaal 4000 tekens)' using errcode = '22001';
  end if;

  select * into v_quote
  from public.quotes
  where public_token_hash = p_token_hash
    and public_token_expires_at is not null
    and public_token_expires_at > now()
  for update;

  if not found then raise exception 'Offertelink is ongeldig of verlopen' using errcode = '28000'; end if;
  if v_quote.status <> 'sent' then raise exception 'Deze offerte kan niet meer worden geaccepteerd' using errcode = '23514'; end if;
  if v_quote.sent_version_id is null then raise exception 'Deze offerte mist een verzonden versie en kan niet worden geaccepteerd' using errcode = '23514'; end if;
  -- GEWIJZIGD: de datum in Nederland (was UTC: tot 01:00/02:00 de volgende dag).
  if v_quote.valid_until is not null and v_quote.valid_until < (now() at time zone 'Europe/Amsterdam')::date then
    raise exception 'Deze offerte is verlopen en kan niet meer worden geaccepteerd' using errcode = '23514';
  end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then
    raise exception 'Naam is verplicht om de offerte te accepteren' using errcode = '23514';
  end if;
  if v_typed_email is null or v_typed_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'Geldig e-mailadres is verplicht om de offerte te accepteren' using errcode = '23514';
  end if;

  select lower(btrim(d.recipient_email)) into v_invited_email
    from public.quote_email_deliveries d
   where d.quote_id = v_quote.id
     and d.organization_id = v_quote.organization_id
     and d.status in ('sent', 'delivered', 'opened', 'clicked')
   order by d.created_at desc
   limit 1;

  v_evidence := jsonb_strip_nulls(jsonb_build_object(
    'ip', nullif(btrim(coalesce(p_ip, '')), ''),
    'userAgent', left(nullif(btrim(coalesce(p_user_agent, '')), ''), 500),
    'invitedEmail', v_invited_email,
    'emailMatchesInvitation', case when v_invited_email is null then null else v_typed_email = v_invited_email end
  ));

  v_sent_version_id := v_quote.sent_version_id;

  update public.quotes
  set status = 'accepted',
      accepted_at = now(),
      client_decision_at = now(),
      client_decision_by_name = nullif(trim(coalesce(p_name, '')), ''),
      client_decision_by_email = v_typed_email,
      client_decision_note = nullif(trim(coalesce(p_note, '')), ''),
      accepted_sent_version_id = v_sent_version_id,
      updated_at = now()
  where id = v_quote.id
  returning * into v_quote;

  v_version := public.create_quote_version_snapshot(
    v_quote.id,
    v_quote.organization_id,
    'client_accepted',
    null,
    null,
    v_quote.last_pdf_file_name,
    v_quote.last_pdf_mime_type,
    v_quote.last_pdf_size_bytes,
    v_quote.last_pdf_sha256,
    null,
    jsonb_build_object('clientDecisionName', p_name, 'clientDecisionEmail', p_email, 'acceptedSentVersionId', v_sent_version_id) || v_evidence
  );

  perform public.insert_quote_workflow_event(v_quote.organization_id, v_quote.id, 'client_accepted', 'Klant heeft de offerte geaccepteerd', nullif(trim(coalesce(p_note, '')), ''),
    jsonb_build_object('name', p_name, 'email', p_email, 'acceptedVersionId', v_version.id, 'acceptedSentVersionId', v_sent_version_id) || v_evidence, null);
  perform public.insert_quote_audit_event(v_quote.organization_id, v_quote.id, 'quote_client_accepted', v_quote.number,
    jsonb_build_object('name', p_name, 'email', p_email, 'acceptedVersionId', v_version.id, 'acceptedSentVersionId', v_sent_version_id) || v_evidence, null);

  select * into v_quote
  from public.quotes
  where id = v_quote.id and organization_id = v_quote.organization_id;

  return v_quote;
end;
$$;

drop function if exists public.reject_quote_public(text, text, text, text);
create or replace function public.reject_quote_public(
  p_token_hash text,
  p_name text,
  p_email text,
  p_note text default null,
  p_ip text default null,
  p_user_agent text default null
)
returns public.quotes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
  v_typed_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_invited_email text;
  v_evidence jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de publieke offerte-service mag klantbeslissingen verwerken' using errcode = '42501';
  end if;
  if length(coalesce(p_name, '')) > 200 or length(coalesce(p_email, '')) > 254 or length(coalesce(p_note, '')) > 4000 then
    raise exception 'Naam, e-mailadres of opmerking is te lang (opmerking: maximaal 4000 tekens)' using errcode = '22001';
  end if;

  select * into v_quote
  from public.quotes
  where public_token_hash = p_token_hash
    and public_token_expires_at is not null
    and public_token_expires_at > now()
  for update;

  if not found then raise exception 'Offertelink is ongeldig of verlopen' using errcode = '28000'; end if;
  if v_quote.status <> 'sent' then raise exception 'Deze offerte kan niet meer worden geweigerd' using errcode = '23514'; end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then
    raise exception 'Naam is verplicht om de offerte te weigeren' using errcode = '23514';
  end if;
  if v_typed_email is null or v_typed_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'Geldig e-mailadres is verplicht om de offerte te weigeren' using errcode = '23514';
  end if;

  select lower(btrim(d.recipient_email)) into v_invited_email
    from public.quote_email_deliveries d
   where d.quote_id = v_quote.id
     and d.organization_id = v_quote.organization_id
     and d.status in ('sent', 'delivered', 'opened', 'clicked')
   order by d.created_at desc
   limit 1;

  v_evidence := jsonb_strip_nulls(jsonb_build_object(
    'ip', nullif(btrim(coalesce(p_ip, '')), ''),
    'userAgent', left(nullif(btrim(coalesce(p_user_agent, '')), ''), 500),
    'invitedEmail', v_invited_email,
    'emailMatchesInvitation', case when v_invited_email is null then null else v_typed_email = v_invited_email end
  ));

  update public.quotes
  set status = 'rejected',
      client_decision_at = now(),
      client_decision_by_name = nullif(trim(coalesce(p_name, '')), ''),
      client_decision_by_email = v_typed_email,
      client_decision_note = nullif(trim(coalesce(p_note, '')), ''),
      updated_at = now()
  where id = v_quote.id
  returning * into v_quote;

  perform public.insert_quote_workflow_event(v_quote.organization_id, v_quote.id, 'client_rejected', 'Klant heeft de offerte geweigerd', nullif(trim(coalesce(p_note, '')), ''),
    jsonb_build_object('name', p_name, 'email', p_email) || v_evidence, null);
  perform public.insert_quote_audit_event(v_quote.organization_id, v_quote.id, 'quote_client_rejected', v_quote.number,
    jsonb_build_object('name', p_name, 'email', p_email) || v_evidence, null);
  return v_quote;
end;
$$;

revoke all on function public.accept_quote_public(text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.reject_quote_public(text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.accept_quote_public(text, text, text, text, text, text) to service_role;
grant execute on function public.reject_quote_public(text, text, text, text, text, text) to service_role;



-- ── G. Offerte intrekken ───────────────────────────────────────────────────
--
-- Een verstuurde offerte kon niet worden ingetrokken. De statusregel stond
-- sent → cancelled toe, de publieke tijdlijn kende "Offerte ingetrokken" en de
-- app zei "Trek hem in…", maar geen functie of knop zette die status (de
-- browser mag de status niet zelf zetten). Een offerte met een prijsfout bleef
-- zo tot "geldig tot" te accepteren, via de link en via het portaal.
-- Nu: withdraw_quote, voor wie in Financiën mag schrijven. De link blijft
-- hooguit 30 dagen werken, zodat de klant ziet dat de offerte is ingetrokken;
-- akkoord geven kan niet meer (accept_ en decide_ eisen 'sent').

-- Het auditlog kent 'quote_cancelled' nog niet: de lijst toegestane acties
-- uitbreiden zonder er iets uit te laten (uit de huidige definitie gelezen).
do $$
declare
  v_def text;
  v_actions text[];
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint
   where conrelid = 'public.audit_logs'::regclass and conname = 'audit_logs_action_check';
  if v_def is null then return; end if;
  -- Elke actie is een woord van kleine letters, cijfers en lage streepjes. Zo
  -- werkt het voor beide vormen die Postgres teruggeeft (ARRAY['a'::text, …] en
  -- '{a,b}'::text[]), dus ook als deze migratie nog eens draait.
  select array_agg(distinct t[1] order by t[1]) into v_actions
    from regexp_matches(v_def, '([a-z][a-z0-9_]*)', 'g') as t
   where t[1] not in ('check', 'action', 'any', 'array', 'text');
  if v_actions is null or array_length(v_actions, 1) < 10 then
    raise exception 'audit_logs_action_check niet te lezen: %', left(v_def, 200);
  end if;
  if 'quote_cancelled' = any(v_actions)
     and v_def ~ '^CHECK \(\(action = ANY \(''\{[a-z0-9_,]+\}''::text\[\]\)\)\)$' then
    return;
  end if;
  if not ('quote_cancelled' = any(v_actions)) then
    v_actions := v_actions || array['quote_cancelled'];
  end if;
  alter table public.audit_logs drop constraint audit_logs_action_check;
  execute format('alter table public.audit_logs add constraint audit_logs_action_check check (action = any (%L::text[]))', v_actions);
end $$;

create or replace function public.withdraw_quote(p_quote_id uuid, p_organization_id uuid, p_reason text default null)
returns public.quotes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
  v_user_id uuid := auth.uid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_user_id is null then raise exception 'Niet ingelogd' using errcode = '28000'; end if;
  if not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie' using errcode = '42501';
  end if;
  if length(coalesce(v_reason, '')) > 2000 then
    raise exception 'De reden mag maximaal 2000 tekens zijn' using errcode = '22001';
  end if;

  select * into v_quote
    from public.quotes
   where id = p_quote_id and organization_id = p_organization_id
   for update;
  if not found then raise exception 'Offerte niet gevonden' using errcode = '02000'; end if;
  if v_quote.status not in ('sent', 'internally_approved', 'pending_internal_approval') then
    raise exception 'Deze offerte kan niet worden ingetrokken vanuit status %', v_quote.status using errcode = '23514';
  end if;

  update public.quotes
     set status = 'cancelled',
         public_token_expires_at = case when public_token_expires_at is null then null
                                        else least(public_token_expires_at, now() + interval '30 days') end,
         updated_at = now()
   where id = p_quote_id
  returning * into v_quote;

  perform public.insert_quote_workflow_event(p_organization_id, p_quote_id, 'cancelled', 'Offerte ingetrokken', v_reason, '{}'::jsonb, v_user_id);
  perform public.insert_quote_audit_event(p_organization_id, p_quote_id, 'quote_cancelled', v_quote.number, jsonb_build_object('reason', v_reason), v_user_id);
  return v_quote;
end;
$$;

revoke all on function public.withdraw_quote(uuid, uuid, text) from public, anon;
grant execute on function public.withdraw_quote(uuid, uuid, text) to authenticated, service_role;


-- ── H1. Grootboek: btw per tarief, regels gelezen zoals de factuur ─────────

CREATE OR REPLACE FUNCTION public.post_sales_invoice_to_ledger(p_organization_id uuid, p_invoice_id uuid, p_created_by uuid DEFAULT auth.uid())
 RETURNS journal_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_inv public.invoices;
  v_start date;
  v_kor boolean;
  v_lines jsonb := '[]'::jsonb;
  v_output_vat bigint := 0;
  v_receivable bigint := 0;
  v_entry public.journal_entries;
  v_book_date date;
  v_desc text;
  r record;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_inv from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Factuur niet gevonden.' using errcode = '02000';
  end if;
  if v_inv.journal_entry_id is not null then
    raise exception 'Deze factuur is al naar het grootboek geboekt.' using errcode = '23514';
  end if;
  -- Statusguard: alleen een uitgegeven factuur boekt omzet. Concept/geannuleerd niet.
  if v_inv.status in ('draft', 'cancelled') then
    raise exception 'Een % factuur kan niet naar het grootboek worden geboekt.', v_inv.status using errcode = '23514';
  end if;

  select bookkeeping_start_date, coalesce(kor_enabled, false)
    into v_start, v_kor
  from public.company_settings where organization_id = p_organization_id;
  v_kor := coalesce(v_kor, false);

  if v_start is not null and v_inv.date < v_start then
    raise exception 'Factuurdatum ligt vóór de boekhoud-startdatum (%); deze omzet zit al in de beginbalans.', v_start
      using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);

  -- Omzet per (btw-code, tarief); btw per groep afgerond. Het TARIEF komt van
  -- de factuurregel (dat is wat gefactureerd is); de CODE bepaalt de rubriek
  -- (via vat_codes.sales_box in de aangifte) en de omzetrekening: buitenland/
  -- verlegd (3a/3b/3c of verlegd-verkoop) → 8030, anders op tarief.
  -- GEWIJZIGD (20261105230000): (1) aantal, prijs en tarief worden gelezen zoals
  -- invoice_calculated_totals ze leest (een onleesbare waarde telt als 0); een
  -- harde ::numeric liet het boeken mislukken of boekte iets anders dan het
  -- factuurtotaal ("1e3" gaf totaal € 0 en een vordering van € 121.000).
  -- (2) De btw wordt per TARIEF afgerond, zoals op de factuur, de PDF, de UBL en
  -- bij Mollie; per (code, tarief) afronden gaf bij twee regels van € 1,02 tegen
  -- 21% (één zonder code, één met HOOG) een vordering van € 2,46 tegen een
  -- factuur van € 2,47 — en daarna kon de factuur niet meer worden gecrediteerd.
  -- Het afrondingsverschil binnen een tarief gaat naar de grootste groep.
  for r in
    with regels as (
      select
        nullif(btrim(coalesce(line->>'vat_code', '')), '') as vat_code,
        case when coalesce(line->>'vat', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (line->>'vat')::numeric else 0 end as rate,
        round(
          (case when coalesce(line->>'quantity', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (line->>'quantity')::numeric else 0 end)
          * (case when coalesce(line->>'unit_price', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (line->>'unit_price')::numeric else 0 end)
          * 100) as base_cents
      from jsonb_array_elements(v_inv.lines) as line
    ),
    groepen as (
      select g.vat_code, (vc.id is not null) as has_code, vc.kind, vc.sales_box, g.rate, sum(g.base_cents) as base_cents
        from regels g
        left join public.vat_codes vc
          on vc.organization_id = p_organization_id
         and vc.code = g.vat_code
       group by 1, 2, 3, 4, 5
    ),
    per_tarief as (
      select rate, round(sum(base_cents) * rate / 100.0) as rate_vat_cents
        from groepen
       group by rate
    ),
    gerangschikt as (
      select gr.*, round(gr.base_cents * gr.rate / 100.0) as group_vat_cents, pt.rate_vat_cents,
             row_number() over (partition by gr.rate order by abs(gr.base_cents) desc, gr.vat_code nulls last) as rn
        from groepen gr
        join per_tarief pt on pt.rate = gr.rate
    )
    select x.vat_code, x.has_code, x.kind, x.sales_box, x.rate, x.base_cents,
           x.group_vat_cents + case when x.rn = 1
             then x.rate_vat_cents - sum(x.group_vat_cents) over (partition by x.rate)
             else 0 end as vat_cents
      from gerangschikt x
  loop
    declare
      v_vat bigint := case when v_kor then 0 else r.vat_cents end;
      v_revenue_account text := case
        when r.has_code and (r.sales_box in ('3a','3b','3c') or r.kind = 'reverse_charge_sales') then '8030'
        when r.rate >= 21 then '8000'
        when r.rate > 0 then '8010'
        else '8020'
      end;
    begin
      -- GEWIJZIGD (20261104020000): een negatieve groep (korting, correctie)
      -- komt aan de debetzijde; een negatieve credit bestaat niet en liet het
      -- boeken stil mislukken. Grondslag en btw houden hun teken.
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, v_revenue_account),
        'description', 'Omzet',
        'debit_cents', greatest(-r.base_cents, 0), 'credit_cents', greatest(r.base_cents, 0),
        'vat_code', r.vat_code,
        'vat_rate', r.rate, 'vat_base_cents', r.base_cents, 'vat_amount_cents', v_vat,
        'client_id', v_inv.client_id, 'project_id', v_inv.project_id
      ));
      v_output_vat := v_output_vat + v_vat;
      v_receivable := v_receivable + r.base_cents + v_vat;
    end;
  end loop;

  if v_output_vat <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1510'),
      'description', 'Af te dragen BTW',
      'debit_cents', greatest(-v_output_vat, 0), 'credit_cents', greatest(v_output_vat, 0),
      'client_id', v_inv.client_id
    ));
  end if;

  if v_receivable <> 0 then
    v_lines := jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1300'),
      'description', 'Debiteuren',
      'debit_cents', greatest(v_receivable, 0), 'credit_cents', greatest(-v_receivable, 0),
      'client_id', v_inv.client_id
    )) || v_lines;
  end if;

  -- Nagekomen factuur in een al ingediende periode: boek op de eerstvolgende
  -- open datum (documentdatum blijft leidend op de factuur zelf). De btw komt
  -- dan in de eerstvolgende aangifte (kleine correctie) of via een suppletie.
  v_book_date := public.first_open_booking_date(p_organization_id, v_inv.date);
  v_desc := 'Verkoopfactuur ' || coalesce(v_inv.number, '');
  if v_book_date <> v_inv.date then
    v_desc := v_desc || ' (factuurdatum ' || to_char(v_inv.date, 'DD-MM-YYYY') || ', geboekt in eerstvolgende open periode)';
  end if;

  v_entry := public.post_journal_entry(
    p_organization_id, v_book_date, v_desc,
    'sales_invoice', v_inv.id, v_lines, p_created_by
  );

  update public.invoices set journal_entry_id = v_entry.id where id = v_inv.id;
  return v_entry;
end;
$function$;

-- ── H2. KOR: geen factuur met btw ──────────────────────────────────────────
--
-- Met de kleineondernemersregeling boekt het grootboek geen btw, maar de editor
-- zette een nieuwe regel op 21% en het versturen controleerde niets. De klant
-- kreeg dan € 121 gefactureerd (PDF, UBL, Mollie), het grootboek boekte € 100
-- omzet en geen btw, de betaallink vroeg € 100, en "Crediteren" weigerde omdat
-- open en totaal niet gelijk waren. Btw die op een factuur staat is verschuldigd
-- (art. 37 Wet OB). Nu: een factuur met btw kan onder de KOR niet worden
-- uitgegeven; zet de regels op 0% (code KOR).

create or replace function public.enforce_invoice_kor_no_vat()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_kor boolean;
begin
  if new.status in ('draft', 'cancelled', 'void') then return new; end if;
  -- Alleen bij uitgeven (nieuw of vanuit concept); een uitgegeven factuur ligt al vast.
  if tg_op = 'UPDATE' and old.status <> 'draft' then return new; end if;
  select coalesce(kor_enabled, false) into v_kor
    from public.company_settings where organization_id = new.organization_id;
  if coalesce(v_kor, false) and exists (
       select 1 from jsonb_array_elements(case when jsonb_typeof(new.lines) = 'array' then new.lines else '[]'::jsonb end) l
        where case when coalesce(l->>'vat', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (l->>'vat')::numeric else 0 end <> 0) then
    raise exception 'Je gebruikt de kleineondernemersregeling (KOR): een factuur rekent dan geen btw. Zet de btw van elke regel op 0%% (code KOR) en verstuur opnieuw.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists invoices_kor_no_vat on public.invoices;
create trigger invoices_kor_no_vat
  before insert or update of status, lines on public.invoices
  for each row execute function public.enforce_invoice_kor_no_vat();

-- ── H3. Herinnering en aanmaning: niet voor een concept ────────────────────
--
-- Een concept met een vervaldatum in het verleden toonde "Stuur herinnering"
-- en "Stel aanmaning op", en de database liet het toe: de klant kreeg "Uw
-- onderneming is van rechtswege in verzuim … incassokosten" voor een factuur
-- die hij nooit had ontvangen. Een aanmaning kan nu ook pas na de vervaldatum.

CREATE OR REPLACE FUNCTION public.begin_invoice_reminder_send(p_invoice_id uuid, p_organization_id uuid, p_actor_user_id uuid, p_level smallint, p_token_hash text, p_token_expires_at timestamp with time zone, p_recipient_email text, p_recipient_name text, p_subject text, p_public_url text, p_attachment_file_name text DEFAULT NULL::text, p_attachment_mime_type text DEFAULT 'application/pdf'::text, p_attachment_size_bytes integer DEFAULT NULL::integer, p_attachment_sha256 text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_invoice public.invoices;
  v_delivery public.invoice_email_deliveries;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  if p_level not between 1 and 3 then
    raise exception 'Ongeldig herinneringsniveau.' using errcode = '22023';
  end if;

  select * into v_invoice
  from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Factuur niet gevonden.' using errcode = '02000'; end if;
  -- GEWIJZIGD (20261105230000): een concept is nooit verstuurd; de klant kreeg
  -- anders een herinnering voor een factuur die hij nooit ontving.
  if v_invoice.status = 'draft' then
    raise exception 'Deze factuur is nog een concept en is niet verstuurd: daar hoort geen herinnering bij.' using errcode = '23514';
  end if;
  if v_invoice.status in ('paid','cancelled','void','written_off','refunded') then
    raise exception 'Voor een betaalde, geannuleerde of afgeboekte factuur kan geen herinnering worden verstuurd.' using errcode = '23514';
  end if;

  update public.invoices
     set public_token_hash = p_token_hash,
         public_token_created_at = now(),
         public_token_expires_at = p_token_expires_at,
         updated_at = now()
   where id = v_invoice.id;

  insert into public.invoice_email_deliveries(
    organization_id, invoice_id, recipient_email, recipient_name, subject, status,
    delivery_kind, reminder_level,
    attachment_file_name, attachment_mime_type, attachment_size_bytes, attachment_sha256,
    metadata
  ) values (
    p_organization_id, p_invoice_id, lower(btrim(p_recipient_email)), nullif(btrim(coalesce(p_recipient_name, '')), ''), p_subject, 'queued',
    'reminder', p_level,
    nullif(btrim(coalesce(p_attachment_file_name, '')), ''), coalesce(nullif(btrim(coalesce(p_attachment_mime_type, '')), ''), 'application/pdf'), p_attachment_size_bytes, nullif(btrim(coalesce(p_attachment_sha256, '')), ''),
    jsonb_build_object('publicUrl', p_public_url, 'reminderLevel', p_level)
  ) returning * into v_delivery;

  insert into public.invoice_public_links(
    organization_id, invoice_id, token_hash, purpose, status, delivery_id, expires_at, created_by, metadata
  ) values (
    p_organization_id, p_invoice_id, p_token_hash, 'email', 'active', v_delivery.id, p_token_expires_at, p_actor_user_id,
    jsonb_build_object('publicUrl', p_public_url, 'kind', 'reminder', 'reminderLevel', p_level)
  )
  on conflict (token_hash) do nothing;

  return jsonb_build_object('deliveryId', v_delivery.id, 'invoiceId', p_invoice_id);
end;
$function$;

CREATE OR REPLACE FUNCTION public.begin_dunning_notice(p_organization_id uuid, p_invoice_id uuid, p_actor_user_id uuid, p_client_kind text, p_interest_kind text, p_principal_cents bigint, p_interest_cents bigint, p_interest_days integer, p_daily_interest_cents bigint, p_collection_costs_cents bigint, p_collection_costs_vat_cents bigint, p_total_claim_cents bigint, p_calculation_date date, p_due_date date, p_rate_snapshot jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_invoice public.invoices;
  v_notice public.invoice_dunning_notices;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_invoice
  from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id
  for update;
  if not found then raise exception 'Factuur niet gevonden.' using errcode = '02000'; end if;
  -- GEWIJZIGD (20261105230000): een formele aanmaning ("van rechtswege in
  -- verzuim", incassokosten) alleen voor een verstuurde factuur waarvan de
  -- vervaldatum voorbij is. Eerder kon dat ook voor een concept.
  if v_invoice.status = 'draft' then
    raise exception 'Deze factuur is nog een concept en is niet verstuurd: daar hoort geen aanmaning bij.' using errcode = '23514';
  end if;
  if v_invoice.due_date is null or v_invoice.due_date >= (now() at time zone 'Europe/Amsterdam')::date then
    raise exception 'Een aanmaning kan pas na de vervaldatum van de factuur.' using errcode = '23514';
  end if;
  if v_invoice.status in ('paid','cancelled','void','written_off','refunded') then
    raise exception 'Voor een betaalde, geannuleerde of afgeboekte factuur kan geen aanmaning worden gemaakt.' using errcode = '23514';
  end if;

  insert into public.invoice_dunning_notices(
    organization_id, invoice_id, client_kind, interest_kind,
    principal_cents, interest_cents, interest_days, daily_interest_cents,
    collection_costs_cents, collection_costs_vat_cents, total_claim_cents,
    calculation_date, due_date, rate_snapshot, status, created_by
  ) values (
    p_organization_id, p_invoice_id, p_client_kind, p_interest_kind,
    p_principal_cents, p_interest_cents, coalesce(p_interest_days, 0), coalesce(p_daily_interest_cents, 0),
    p_collection_costs_cents, p_collection_costs_vat_cents, p_total_claim_cents,
    p_calculation_date, p_due_date, coalesce(p_rate_snapshot, '{}'::jsonb), 'proposed', p_actor_user_id
  )
  returning * into v_notice;

  perform public.insert_invoice_workflow_event(
    p_organization_id, p_invoice_id, 'dunning_proposed',
    'Aanmaning voorgesteld',
    'Er is een aanmaning (WIK-14-dagenbrief) voorgesteld voor factuur ' || coalesce(v_invoice.number, '') ||
      ': hoofdsom + rente + incassokosten = ' || to_char((p_total_claim_cents::numeric / 100), 'FM999G999G990D00') || ' EUR. Wacht op bevestiging.',
    jsonb_build_object('notice_id', v_notice.id, 'total_claim_cents', p_total_claim_cents),
    p_actor_user_id
  );

  return jsonb_build_object('noticeId', v_notice.id);
end;
$function$;

CREATE OR REPLACE FUNCTION public.begin_dunning_send(p_notice_id uuid, p_organization_id uuid, p_actor_user_id uuid, p_interest_cents bigint, p_interest_days integer, p_daily_interest_cents bigint, p_collection_costs_cents bigint, p_collection_costs_vat_cents bigint, p_total_claim_cents bigint, p_calculation_date date, p_deadline_date date, p_rate_snapshot jsonb, p_token_hash text, p_token_expires_at timestamp with time zone, p_recipient_email text, p_recipient_name text, p_subject text, p_public_url text, p_attachment_file_name text DEFAULT NULL::text, p_attachment_mime_type text DEFAULT 'application/pdf'::text, p_attachment_size_bytes integer DEFAULT NULL::integer, p_attachment_sha256 text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_notice public.invoice_dunning_notices;
  v_invoice public.invoices;
  v_delivery public.invoice_email_deliveries;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_notice
  from public.invoice_dunning_notices
  where id = p_notice_id and organization_id = p_organization_id
  for update;
  if not found then raise exception 'Aanmaning niet gevonden.' using errcode = '02000'; end if;
  if v_notice.status = 'sent' then
    raise exception 'Deze aanmaning is al verstuurd.' using errcode = '23514';
  end if;
  if v_notice.status = 'cancelled' then
    raise exception 'Deze aanmaning is geannuleerd.' using errcode = '23514';
  end if;
  -- Alleen een voorgestelde of eerder mislukte aanmaning mag (opnieuw) verstuurd worden.
  -- Weiger o.a. de tussenstatus 'confirmed' (verzending al in gang), zodat een dubbelklik
  -- of retry niet een TWEEDE formele aanmaning verstuurt (de FOR UPDATE-lock serialiseert
  -- de twee verzoeken, maar zonder deze guard zou de tweede alsnog doorgaan).
  if v_notice.status not in ('proposed', 'failed') then
    raise exception 'Deze aanmaning wordt al verstuurd.' using errcode = '23514';
  end if;

  select * into v_invoice
  from public.invoices
  where id = v_notice.invoice_id and organization_id = p_organization_id
  for update;
  if not found then raise exception 'Factuur niet gevonden.' using errcode = '02000'; end if;
  -- GEWIJZIGD (20261105230000): een formele aanmaning ("van rechtswege in
  -- verzuim", incassokosten) alleen voor een verstuurde factuur waarvan de
  -- vervaldatum voorbij is. Eerder kon dat ook voor een concept.
  if v_invoice.status = 'draft' then
    raise exception 'Deze factuur is nog een concept en is niet verstuurd: daar hoort geen aanmaning bij.' using errcode = '23514';
  end if;
  if v_invoice.due_date is null or v_invoice.due_date >= (now() at time zone 'Europe/Amsterdam')::date then
    raise exception 'Een aanmaning kan pas na de vervaldatum van de factuur.' using errcode = '23514';
  end if;
  if v_invoice.status in ('paid','cancelled','void','written_off','refunded') then
    raise exception 'Voor een betaalde, geannuleerde of afgeboekte factuur kan geen aanmaning worden verstuurd.' using errcode = '23514';
  end if;

  update public.invoices
     set public_token_hash = p_token_hash,
         public_token_created_at = now(),
         public_token_expires_at = p_token_expires_at,
         updated_at = now()
   where id = v_invoice.id;

  insert into public.invoice_email_deliveries(
    organization_id, invoice_id, recipient_email, recipient_name, subject, status,
    delivery_kind,
    attachment_file_name, attachment_mime_type, attachment_size_bytes, attachment_sha256,
    metadata
  ) values (
    p_organization_id, v_notice.invoice_id, lower(btrim(p_recipient_email)), nullif(btrim(coalesce(p_recipient_name, '')), ''), p_subject, 'queued',
    'dunning',
    nullif(btrim(coalesce(p_attachment_file_name, '')), ''), coalesce(nullif(btrim(coalesce(p_attachment_mime_type, '')), ''), 'application/pdf'), p_attachment_size_bytes, nullif(btrim(coalesce(p_attachment_sha256, '')), ''),
    jsonb_build_object('publicUrl', p_public_url, 'dunningNoticeId', v_notice.id)
  ) returning * into v_delivery;

  insert into public.invoice_public_links(
    organization_id, invoice_id, token_hash, purpose, status, delivery_id, expires_at, created_by, metadata
  ) values (
    p_organization_id, v_notice.invoice_id, p_token_hash, 'email', 'active', v_delivery.id, p_token_expires_at, p_actor_user_id,
    jsonb_build_object('publicUrl', p_public_url, 'kind', 'dunning', 'dunningNoticeId', v_notice.id)
  )
  on conflict (token_hash) do nothing;

  update public.invoice_dunning_notices
     set status = 'confirmed',
         interest_cents = p_interest_cents,
         interest_days = coalesce(p_interest_days, 0),
         daily_interest_cents = coalesce(p_daily_interest_cents, 0),
         collection_costs_cents = p_collection_costs_cents,
         collection_costs_vat_cents = p_collection_costs_vat_cents,
         total_claim_cents = p_total_claim_cents,
         calculation_date = p_calculation_date,
         deadline_date = p_deadline_date,
         rate_snapshot = coalesce(p_rate_snapshot, rate_snapshot),
         public_url = p_public_url,
         delivery_id = v_delivery.id,
         confirmed_by = p_actor_user_id,
         confirmed_at = now(),
         updated_at = now()
   where id = v_notice.id;

  return jsonb_build_object('deliveryId', v_delivery.id, 'noticeId', v_notice.id);
end;
$function$;

revoke all on function public.begin_invoice_reminder_send(uuid, uuid, uuid, smallint, text, timestamptz, text, text, text, text, text, text, integer, text) from public, anon, authenticated;
grant execute on function public.begin_invoice_reminder_send(uuid, uuid, uuid, smallint, text, timestamptz, text, text, text, text, text, text, integer, text) to service_role;
revoke all on function public.begin_dunning_notice(uuid, uuid, uuid, text, text, bigint, bigint, integer, bigint, bigint, bigint, bigint, date, date, jsonb) from public, anon, authenticated;
grant execute on function public.begin_dunning_notice(uuid, uuid, uuid, text, text, bigint, bigint, integer, bigint, bigint, bigint, bigint, date, date, jsonb) to service_role;
revoke all on function public.begin_dunning_send(uuid, uuid, uuid, bigint, integer, bigint, bigint, bigint, bigint, date, date, jsonb, text, timestamptz, text, text, text, text, text, text, integer, text) from public, anon, authenticated;
grant execute on function public.begin_dunning_send(uuid, uuid, uuid, bigint, integer, bigint, bigint, bigint, bigint, date, date, jsonb, text, timestamptz, text, text, text, text, text, text, integer, text) to service_role;

-- ── H4. Een gecrediteerde of terugbetaalde factuur blijft dat ──────────────
--
-- De statuskeuze in de editor liet een volledig gecrediteerde factuur
-- ("geannuleerd") terug op "verzonden" zetten, en een terugbetaalde factuur
-- ook. Die kon daarna opnieuw worden verstuurd, met betaallink, terwijl de
-- creditnota bleef staan. Vanuit de browser kan dat nu niet meer: een
-- terugbetaalde factuur verandert alleen via de terugbetaling, een geboekte of
-- gecrediteerde geannuleerde factuur blijft geannuleerd. Een geannuleerde
-- factuur die nooit geboekt of gecrediteerd is, mag terug (een vergissing).

create or replace function public.enforce_invoice_terminal_status()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user not in ('anon', 'authenticated', 'authenticator') then return new; end if;
  if new.status is not distinct from old.status then return new; end if;
  if old.status = 'refunded' then
    raise exception 'Een terugbetaalde factuur verandert alleen via een terugbetaling of creditnota, niet via de status.'
      using errcode = '23514';
  end if;
  if old.status in ('cancelled', 'void')
     and (old.journal_entry_id is not null
          or exists (select 1 from public.credit_notes c where c.invoice_id = old.id and c.status <> 'void')) then
    raise exception 'Factuur % is geboekt of gecrediteerd en blijft %. Moet er toch iets worden gefactureerd, maak dan een nieuwe factuur.',
      old.number, case old.status when 'void' then 'ongeldig' else 'geannuleerd' end
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists invoices_terminal_status on public.invoices;
create trigger invoices_terminal_status
  before update of status on public.invoices
  for each row execute function public.enforce_invoice_terminal_status();

-- ── H5. Factuurregels: getallen zijn getallen ──────────────────────────────
--
-- invoice_calculated_totals las een onleesbare waarde als 0, het grootboek
-- castte hard. Via REST kwam zo "quantity": "1e3" binnen: totaal € 0, maar een
-- vordering van € 121.000; "1,5" liet het boeken mislukken (alleen een
-- waarschuwing), waarna de factuur ongeboekt verstuurd bleef. De app schrijft
-- altijd getallen; een nieuwe of gewijzigde regel met iets anders weigert nu.

create or replace function public.enforce_invoice_lines_numeric()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_bad text;
begin
  if tg_op = 'UPDATE' and new.lines is not distinct from old.lines then return new; end if;
  if new.lines is null then return new; end if;
  if jsonb_typeof(new.lines) <> 'array' then
    raise exception 'Factuurregels moeten een lijst zijn.' using errcode = '22023';
  end if;
  select coalesce(nullif(btrim(l->>'description'), ''), '(zonder omschrijving)') into v_bad
    from jsonb_array_elements(new.lines) l
   where exists (
     select 1
       from (values (l->'quantity'), (l->'unit_price'), (l->'vat')) as v(x)
      where x is not null
        and jsonb_typeof(x) not in ('null', 'number')
        and not (jsonb_typeof(x) = 'string' and (x #>> '{}' = '' or x #>> '{}' ~ '^-?[0-9]+(\.[0-9]+)?$'))
   )
   limit 1;
  if v_bad is not null then
    raise exception 'Regel "%" heeft een aantal, prijs of btw-tarief dat geen getal is. Gebruik cijfers, met een punt als decimaalteken.', left(v_bad, 80)
      using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists invoices_lines_numeric on public.invoices;
create trigger invoices_lines_numeric
  before insert or update of lines on public.invoices
  for each row execute function public.enforce_invoice_lines_numeric();

revoke all on function public.enforce_invoice_kor_no_vat() from public, anon;
revoke all on function public.enforce_invoice_terminal_status() from public, anon;
revoke all on function public.enforce_invoice_lines_numeric() from public, anon;
grant execute on function public.enforce_invoice_kor_no_vat() to authenticated, service_role;
grant execute on function public.enforce_invoice_terminal_status() to authenticated, service_role;
grant execute on function public.enforce_invoice_lines_numeric() to authenticated, service_role;

-- ── H6. Factuurversie: totalen per tarief ──────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_invoice_version_snapshot(p_invoice_id uuid, p_organization_id uuid, p_snapshot_reason text, p_actor_user_id uuid DEFAULT NULL::uuid, p_delivery_id uuid DEFAULT NULL::uuid, p_payment_record_id uuid DEFAULT NULL::uuid, p_pdf_file_name text DEFAULT NULL::text, p_pdf_mime_type text DEFAULT NULL::text, p_pdf_size_bytes integer DEFAULT NULL::integer, p_pdf_sha256 text DEFAULT NULL::text, p_invoice_version_pdf_url text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS invoice_versions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_invoice public.invoices;
  v_version public.invoice_versions;
  v_version_number integer;
  v_line jsonb;
  v_index integer := 0;
  v_quantity numeric := 0;
  v_unit_price numeric := 0;
  v_vat_percentage numeric := 0;
  v_line_subtotal numeric := 0;
  v_line_vat numeric := 0;
  v_line_total numeric := 0;
  v_subtotal numeric := 0;
  v_vat_total numeric := 0;
  v_total numeric := 0;
  v_pdf_mime_type text := coalesce(nullif(trim(coalesce(p_pdf_mime_type, '')), ''), 'application/pdf');
begin
  if p_snapshot_reason not in ('sent_to_client','payment_created','paid','manual') then
    raise exception 'Ongeldige factuur snapshot reason: %', p_snapshot_reason using errcode = '23514';
  end if;

  if auth.role() = 'authenticated' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie' using errcode = '42501';
  end if;

  select * into v_invoice
  from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Factuur niet gevonden' using errcode = '02000'; end if;

  for v_line in select * from jsonb_array_elements(coalesce(v_invoice.lines, '[]'::jsonb)) loop
    v_quantity := coalesce(nullif(v_line->>'quantity', '')::numeric, 0);
    v_unit_price := coalesce(nullif(v_line->>'unit_price', '')::numeric, 0);
    v_vat_percentage := coalesce(nullif(v_line->>'vat', '')::numeric, 0);
    v_line_subtotal := round(v_quantity * v_unit_price, 2);
    v_line_vat := round(v_line_subtotal * (v_vat_percentage / 100), 2);
    v_line_total := round(v_line_subtotal + v_line_vat, 2);
    v_subtotal := v_subtotal + v_line_subtotal;
    v_vat_total := v_vat_total + v_line_vat;
    v_total := v_total + v_line_total;
  end loop;

  -- GEWIJZIGD (20261105230000): de totalen van de versie zoals de factuur ze
  -- rekent (btw per tarief); per regel afronden gaf € 2,46 bij een factuur van
  -- € 2,47. De versielijst, de publieke factuurpagina en invoice.history tonen
  -- dit bedrag.
  select t.subtotal, t.vat, t.total
    into v_subtotal, v_vat_total, v_total
    from public.invoice_calculated_totals(v_invoice.lines) t;

  select coalesce(max(version_number), 0) + 1
    into v_version_number
  from public.invoice_versions
  where organization_id = p_organization_id
    and invoice_id = p_invoice_id;

  insert into public.invoice_versions(
    organization_id, invoice_id, delivery_id, payment_record_id, version_number, snapshot_reason,
    status_at_snapshot, invoice_number, client_id, project_id, quote_id, invoice_date, due_date, notes,
    subtotal_amount, vat_amount, total_amount, invoice_version_pdf_url, pdf_file_name, pdf_mime_type,
    pdf_size_bytes, pdf_sha256, snapshot_data, created_by
  ) values (
    p_organization_id, p_invoice_id, p_delivery_id, p_payment_record_id, v_version_number, p_snapshot_reason,
    v_invoice.status, v_invoice.number, v_invoice.client_id, v_invoice.project_id, v_invoice.quote_id, v_invoice.date, v_invoice.due_date, v_invoice.notes,
    round(v_subtotal, 2), round(v_vat_total, 2), round(v_total, 2), nullif(trim(coalesce(p_invoice_version_pdf_url, '')), ''),
    nullif(trim(coalesce(p_pdf_file_name, '')), ''), v_pdf_mime_type, p_pdf_size_bytes, nullif(trim(coalesce(p_pdf_sha256, '')), ''),
    jsonb_build_object(
      'invoice', to_jsonb(v_invoice) - 'public_token_hash',
      'totals', jsonb_build_object('subtotal', round(v_subtotal, 2), 'vat', round(v_vat_total, 2), 'total', round(v_total, 2)),
      'reason', p_snapshot_reason,
      'deliveryId', p_delivery_id,
      'paymentRecordId', p_payment_record_id,
      'pdf', jsonb_build_object('fileName', nullif(trim(coalesce(p_pdf_file_name, '')), ''), 'mimeType', v_pdf_mime_type, 'sizeBytes', p_pdf_size_bytes, 'sha256', nullif(trim(coalesce(p_pdf_sha256, '')), ''), 'url', nullif(trim(coalesce(p_invoice_version_pdf_url, '')), '')),
      'metadata', coalesce(p_metadata, '{}'::jsonb)
    ),
    p_actor_user_id
  ) returning * into v_version;

  v_index := 0;
  for v_line in select * from jsonb_array_elements(coalesce(v_invoice.lines, '[]'::jsonb)) loop
    v_quantity := coalesce(nullif(v_line->>'quantity', '')::numeric, 0);
    v_unit_price := coalesce(nullif(v_line->>'unit_price', '')::numeric, 0);
    v_vat_percentage := coalesce(nullif(v_line->>'vat', '')::numeric, 0);
    v_line_subtotal := round(v_quantity * v_unit_price, 2);
    v_line_vat := round(v_line_subtotal * (v_vat_percentage / 100), 2);
    v_line_total := round(v_line_subtotal + v_line_vat, 2);

    insert into public.invoice_version_items(
      organization_id, invoice_id, invoice_version_id, source_line_id, line_index,
      description, quantity, unit_price, vat_percentage, line_subtotal, line_vat, line_total
    ) values (
      p_organization_id, p_invoice_id, v_version.id, nullif(v_line->>'id', ''), v_index,
      coalesce(nullif(btrim(v_line->>'description'), ''), 'Regel ' || (v_index + 1)::text),
      v_quantity, v_unit_price, v_vat_percentage, v_line_subtotal, v_line_vat, v_line_total
    );
    v_index := v_index + 1;
  end loop;

  update public.invoices
     set latest_version_id = v_version.id,
         sent_version_id = case when p_snapshot_reason = 'sent_to_client' then v_version.id else sent_version_id end,
         paid_version_id = case when p_snapshot_reason = 'paid' then v_version.id else paid_version_id end,
         last_pdf_file_name = coalesce(nullif(trim(coalesce(p_pdf_file_name, '')), ''), last_pdf_file_name),
         last_pdf_mime_type = coalesce(v_pdf_mime_type, last_pdf_mime_type),
         last_pdf_size_bytes = coalesce(p_pdf_size_bytes, last_pdf_size_bytes),
         last_pdf_sha256 = coalesce(nullif(trim(coalesce(p_pdf_sha256, '')), ''), last_pdf_sha256),
         updated_at = now()
   where id = p_invoice_id and organization_id = p_organization_id;

  perform public.insert_invoice_workflow_event(
    p_organization_id,
    p_invoice_id,
    'invoice_version_created',
    'Factuurversie vastgelegd',
    'Snapshot gemaakt: ' || p_snapshot_reason,
    jsonb_build_object('version_id', v_version.id, 'version_number', v_version.version_number, 'reason', p_snapshot_reason),
    p_actor_user_id
  );

  if p_pdf_file_name is not null then
    perform public.insert_invoice_workflow_event(
      p_organization_id,
      p_invoice_id,
      'invoice_pdf_attached',
      'PDF-snapshot gekoppeld',
      p_pdf_file_name,
      jsonb_build_object('version_id', v_version.id, 'sha256', p_pdf_sha256, 'size_bytes', p_pdf_size_bytes),
      p_actor_user_id
    );
  end if;

  return v_version;
end;
$function$;

revoke all on function public.create_invoice_version_snapshot(uuid, uuid, text, uuid, uuid, uuid, text, text, integer, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.create_invoice_version_snapshot(uuid, uuid, text, uuid, uuid, uuid, text, text, integer, text, text, jsonb) to service_role;
revoke all on function public.post_sales_invoice_to_ledger(uuid, uuid, uuid) from public, anon;
grant execute on function public.post_sales_invoice_to_ledger(uuid, uuid, uuid) to authenticated, service_role;


-- ── I. Terugbetalingen ─────────────────────────────────────────────────────
--
-- (1) Het terug te betalen bedrag telde alleen Mollie-geld zodra er één
--     Mollie-betaling was (gemengd betaald: bank + Mollie). Nu minstens het
--     factuurbedrag.
-- (2) Een terugbetaling in het Mollie-dashboard van te veel betaald geld gaf
--     altijd een creditnota; nu alleen voor het deel boven het teveel.
-- (3) Een terugbetaling die 'refunded' is, gaat niet meer terug naar
--     'pending' door een late webhook.

CREATE OR REPLACE FUNCTION public.begin_invoice_refund(p_invoice_id uuid, p_organization_id uuid, p_actor_user_id uuid, p_amount_cents integer, p_reason text DEFAULT NULL::text, p_kind text DEFAULT 'manual'::text, p_payment_record_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS invoice_refunds
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_invoice public.invoices;
  v_paid_cents bigint;
  v_already_cents bigint;
  v_kind text := case when p_kind in ('manual','mollie') then p_kind else 'manual' end;
  v_refund public.invoice_refunds;
  v_amount_eur text;
begin
  if p_organization_id is null or p_invoice_id is null then
    raise exception 'Organisatie en factuur zijn verplicht.' using errcode = '23514';
  end if;
  if coalesce(p_amount_cents, 0) <= 0 then
    raise exception 'Het terugbetaalbedrag moet groter zijn dan 0.' using errcode = '23514';
  end if;

  select * into v_invoice
  from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id
  for update;
  if not found then raise exception 'Factuur niet gevonden.' using errcode = '02000'; end if;

  if v_invoice.status not in ('paid','refunded') then
    raise exception 'Alleen betaalde facturen kunnen worden terugbetaald.' using errcode = '23514';
  end if;

  -- Idempotency: dezelfde sleutel mag nooit twee terugbetalingen maken.
  if p_idempotency_key is not null then
    select * into v_refund from public.invoice_refunds
     where organization_id = p_organization_id
       and invoice_id = p_invoice_id
       and idempotency_key = p_idempotency_key;
    if found then return v_refund; end if;
  end if;

  -- Betaald bedrag bepalen (zelfde logica als recompute).
  -- GEWIJZIGD (20261105230000): een betaalde factuur is minstens het
  -- factuurbedrag betaald, ook als een deel per bank kwam. Eerder telde zodra
  -- er één Mollie-betaling was alleen het Mollie-deel: bij € 290 per bank en
  -- € 710 via Mollie weigerde een terugbetaling van € 1.000, en na € 710 stond
  -- de factuur op "terugbetaald" terwijl € 290 nooit terug was.
  select greatest(
           coalesce(sum(amount_cents) filter (where status in ('paid','refunded','charged_back')), 0),
           public.invoice_total_cents(v_invoice)
         )
    into v_paid_cents
  from public.invoice_payment_records
  where invoice_id = p_invoice_id and organization_id = p_organization_id;

  -- TOEGEVOEGD (20261104020000): geld dat via een chargeback al terug is bij
  -- de klant, kan niet nog eens worden terugbetaald.
  v_paid_cents := v_paid_cents - coalesce((
    select sum(cb.amount_cents) from public.invoice_chargebacks cb
    where cb.invoice_id = p_invoice_id and cb.organization_id = p_organization_id
      and cb.status = 'charged_back'
  ), 0);

  -- Reeds terugbetaald of in behandeling (voorkomt dubbel/over-terugbetalen).
  select coalesce(sum(amount_cents), 0) into v_already_cents
  from public.invoice_refunds
  where invoice_id = p_invoice_id and organization_id = p_organization_id
    and status in ('queued','pending','processing','refunded');

  if p_amount_cents::bigint + v_already_cents > v_paid_cents then
    raise exception 'Terugbetaalbedrag (% cent) overschrijdt het resterende betaalde bedrag (% cent).',
      p_amount_cents, greatest(v_paid_cents - v_already_cents, 0)
      using errcode = '23514';
  end if;

  insert into public.invoice_refunds(
    organization_id, invoice_id, payment_record_id, kind, provider, status,
    amount_cents, currency, reason, idempotency_key, initiated_by, metadata, refunded_at
  ) values (
    p_organization_id, p_invoice_id, p_payment_record_id, v_kind, 'mollie',
    case when v_kind = 'manual' then 'refunded' else 'queued' end,
    p_amount_cents, coalesce(nullif(v_invoice.currency, ''), 'EUR'),
    nullif(btrim(coalesce(p_reason, '')), ''), p_idempotency_key, p_actor_user_id,
    coalesce(p_metadata, '{}'::jsonb),
    case when v_kind = 'manual' then now() else null end
  ) returning * into v_refund;

  -- Voor een handmatige terugbetaling is het geld direct verwerkt.
  if v_kind = 'manual' then
    perform public.recompute_invoice_refund_state(p_invoice_id, p_organization_id);

    v_amount_eur := to_char(p_amount_cents::numeric / 100, 'FM999999990.00');
    perform public.insert_invoice_workflow_event(
      p_organization_id,
      p_invoice_id,
      'payment_refunded',
      'Terugbetaling geregistreerd',
      'Handmatige terugbetaling van ' || coalesce(nullif(v_invoice.currency, ''), 'EUR') || ' ' || v_amount_eur,
      jsonb_build_object('refund_id', v_refund.id, 'amount_cents', p_amount_cents, 'kind', v_kind),
      p_actor_user_id
    );

    insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
    values (p_organization_id, p_actor_user_id, 'invoice_refunded', 'invoice', p_invoice_id, v_invoice.number,
            jsonb_build_object('refund_id', v_refund.id, 'amount_cents', p_amount_cents, 'kind', v_kind));
  end if;

  return v_refund;
end;
$function$;

CREATE OR REPLACE FUNCTION public.recompute_invoice_refund_state(p_invoice_id uuid, p_organization_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_invoice public.invoices;
  v_refunded_cents bigint;
  v_paid_cents bigint;
  v_rf record;
  v_lines jsonb;
  v_entry public.journal_entries;
begin
  select * into v_invoice
  from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id
  for update;
  if not found then return; end if;

  -- Totaal daadwerkelijk terugbetaald (alleen settled refunds).
  select coalesce(sum(amount_cents), 0) into v_refunded_cents
  from public.invoice_refunds
  where invoice_id = p_invoice_id and organization_id = p_organization_id
    and status = 'refunded';

  -- Per Mollie-betaalrecord het terugbetaalde deel bijwerken.
  update public.invoice_payment_records p
     set amount_refunded_cents = coalesce((
           select sum(r.amount_cents) from public.invoice_refunds r
           where r.payment_record_id = p.id and r.status = 'refunded'
         ), 0),
         updated_at = now()
   where p.invoice_id = p_invoice_id and p.organization_id = p_organization_id;

  -- Betaald bedrag: voorkeur voor de som van betaalde/terugbetaalde Mollie-records,
  -- val terug op het factuurtotaal (offline betaald zonder Mollie-record).
  -- GEWIJZIGD (20261105230000): een betaalde factuur is minstens het
  -- factuurbedrag betaald, ook als een deel per bank kwam. Eerder telde zodra
  -- er één Mollie-betaling was alleen het Mollie-deel: bij € 290 per bank en
  -- € 710 via Mollie weigerde een terugbetaling van € 1.000, en na € 710 stond
  -- de factuur op "terugbetaald" terwijl € 290 nooit terug was.
  select greatest(
           coalesce(sum(amount_cents) filter (where status in ('paid','refunded','charged_back')), 0),
           public.invoice_total_cents(v_invoice)
         )
    into v_paid_cents
  from public.invoice_payment_records
  where invoice_id = p_invoice_id and organization_id = p_organization_id;

  update public.invoices
     set refunded_amount = round(v_refunded_cents::numeric / 100, 2),
         refunded_at = case when v_refunded_cents > 0 then coalesce(refunded_at, now()) else null end,
         status = case
                    when v_refunded_cents > 0 and v_refunded_cents >= v_paid_cents then 'refunded'
                    when status = 'refunded' and v_refunded_cents < v_paid_cents then 'paid'
                    else status
                  end,
         locked_at = case when v_refunded_cents > 0 then coalesce(locked_at, now()) else locked_at end,
         locked_reason = case when v_refunded_cents > 0 then coalesce(locked_reason, 'refunded') else locked_reason end,
         updated_at = now()
   where id = p_invoice_id and organization_id = p_organization_id;

  -- Een volledig terugbetaald Mollie-record naar 'refunded' tillen.
  update public.invoice_payment_records p
     set status = 'refunded',
         updated_at = now()
   where p.invoice_id = p_invoice_id and p.organization_id = p_organization_id
     and p.status = 'paid'
     and p.amount_refunded_cents >= p.amount_cents
     and p.amount_cents > 0;

  -- TOEGEVOEGD (20261104020000): het geld van een Mollie-terugbetaling gaat van
  -- het Mollie-saldo (1102) af, en de vordering die de creditnota wegboekte komt
  -- terug: debet 1300, credit 1102. Zonder deze boeking bleef 1300 negatief en
  -- 1102 te hoog. Alleen als de Mollie-betaling zelf geboekt is; een handmatige
  -- terugbetaling loopt via de bank en boek je daar.
  for v_rf in
    select rf.id, rf.amount_cents, rf.refunded_at
    from public.invoice_refunds rf
    join public.invoice_payment_records pr
      on pr.id = rf.payment_record_id and pr.organization_id = rf.organization_id and pr.journal_entry_id is not null
    where rf.invoice_id = p_invoice_id and rf.organization_id = p_organization_id
      and rf.kind = 'mollie' and rf.status = 'refunded'
      and rf.journal_entry_id is null and rf.amount_cents > 0
    order by rf.created_at
  loop
    perform public.ensure_default_ledger_accounts(p_organization_id);
    v_lines := jsonb_build_array(
      jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, '1300'),
        'description', 'Terugbetaling via Mollie', 'debit_cents', v_rf.amount_cents, 'credit_cents', 0,
        'client_id', v_invoice.client_id),
      jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, '1102'),
        'description', 'Terugbetaling via Mollie (van het Mollie-saldo)', 'debit_cents', 0, 'credit_cents', v_rf.amount_cents)
    );
    v_entry := public.post_journal_entry(
      p_organization_id,
      public.first_open_booking_date_for(p_organization_id, coalesce(v_rf.refunded_at::date, current_date), false),
      'Terugbetaling factuur ' || coalesce(v_invoice.number, ''),
      'payment', p_invoice_id, v_lines, null
    );
    update public.invoice_refunds set journal_entry_id = v_entry.id where id = v_rf.id;
  end loop;
end;
$function$;

CREATE OR REPLACE FUNCTION public.complete_invoice_refund(p_refund_id uuid, p_organization_id uuid, p_provider_refund_id text DEFAULT NULL::text, p_status text DEFAULT 'refunded'::text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS invoice_refunds
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_refund public.invoice_refunds;
  v_invoice public.invoices;
  v_prev_status text;
  v_status text := case when p_status in ('queued','pending','processing','refunded','failed','canceled') then p_status else 'refunded' end;
  v_amount_eur text;
begin
  select * into v_refund
  from public.invoice_refunds
  where id = p_refund_id and organization_id = p_organization_id
  for update;
  if not found then raise exception 'Terugbetaling niet gevonden.' using errcode = '02000'; end if;

  v_prev_status := v_refund.status;

  -- GEWIJZIGD (20261105230000): een terugbetaling die bij Mollie 'refunded' is,
  -- is definitief. Een late webhook met een oudere status zette hem terug op
  -- 'pending': de factuur ging dan terug naar betaald met terugbetaald € 0,
  -- terwijl de boeking en de creditnota bleven staan.
  if v_prev_status = 'refunded' and v_status <> 'refunded' then
    return v_refund;
  end if;

  update public.invoice_refunds
     set provider_refund_id = coalesce(nullif(btrim(coalesce(p_provider_refund_id, '')), ''), provider_refund_id),
         status = v_status,
         refunded_at = case when v_status = 'refunded' then coalesce(refunded_at, now()) else refunded_at end,
         failed_at = case when v_status in ('failed','canceled') then coalesce(failed_at, now()) else failed_at end,
         metadata = coalesce(metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb),
         updated_at = now()
   where id = v_refund.id
   returning * into v_refund;

  perform public.recompute_invoice_refund_state(v_refund.invoice_id, v_refund.organization_id);

  if v_status = 'refunded' and v_prev_status is distinct from 'refunded' then
    select * into v_invoice from public.invoices
     where id = v_refund.invoice_id and organization_id = v_refund.organization_id;

    v_amount_eur := to_char(v_refund.amount_cents::numeric / 100, 'FM999999990.00');
    perform public.insert_invoice_workflow_event(
      v_refund.organization_id,
      v_refund.invoice_id,
      'payment_refunded',
      'Terugbetaling verwerkt',
      'Mollie-terugbetaling van ' || coalesce(nullif(v_refund.currency, ''), 'EUR') || ' ' || v_amount_eur,
      jsonb_build_object('refund_id', v_refund.id, 'provider_refund_id', v_refund.provider_refund_id, 'amount_cents', v_refund.amount_cents),
      null
    );

    insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
    values (v_refund.organization_id, null, 'invoice_refunded', 'invoice', v_refund.invoice_id, coalesce(v_invoice.number, ''),
            jsonb_build_object('refund_id', v_refund.id, 'provider_refund_id', v_refund.provider_refund_id, 'amount_cents', v_refund.amount_cents));
  end if;

  return v_refund;
end;
$function$;

CREATE OR REPLACE FUNCTION public.ingest_external_refund(p_organization_id uuid, p_invoice_id uuid, p_payment_record_id uuid, p_provider_refund_id text, p_amount_cents integer, p_status text DEFAULT 'pending'::text, p_currency text DEFAULT 'EUR'::text, p_reason text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS invoice_refunds
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_refund public.invoice_refunds;
  v_status text := case when p_status in ('queued','pending','processing','refunded','failed','canceled') then p_status else 'pending' end;
  v_invoice public.invoices;
  v_paid_cents bigint;
  v_refunded_cents bigint;
  v_overpaid_cents bigint;
  v_credit_cents bigint;
begin
  if p_organization_id is null or p_invoice_id is null then
    raise exception 'Organisatie en factuur zijn verplicht.' using errcode = '23514';
  end if;
  if p_provider_refund_id is null or btrim(p_provider_refund_id) = '' then
    raise exception 'Refund-id is verplicht.' using errcode = '23514';
  end if;
  if coalesce(p_amount_cents, 0) <= 0 then
    raise exception 'Het terugbetaalbedrag moet groter zijn dan 0.' using errcode = '23514';
  end if;

  -- Bestaat al (race/herhaalde webhook)? Geef de bestaande terug; de gewone
  -- reconcile-flow (complete/fail_invoice_refund) werkt de status verder bij.
  select * into v_refund from public.invoice_refunds
   where organization_id = p_organization_id and provider_refund_id = p_provider_refund_id;
  if found then return v_refund; end if;

  -- GEWIJZIGD (20261105230000): een terugbetaling in het Mollie-dashboard van
  -- wat de klant te veel betaalde (dubbel betaald, een oude link), is geen
  -- correctie op de verkoop. Eerder kwam er altijd een creditnota (en een mail
  -- naar de klant): omzet en btw gingen terug voor een verkoop die bleef staan,
  -- en de vordering eindigde negatief. Nu alleen voor het deel boven wat er te
  -- veel betaald was.
  select * into v_invoice from public.invoices
   where id = p_invoice_id and organization_id = p_organization_id;
  select coalesce(sum(amount_cents) filter (where status in ('paid','refunded','charged_back')), 0)
    into v_paid_cents
    from public.invoice_payment_records
   where invoice_id = p_invoice_id and organization_id = p_organization_id;
  select coalesce(sum(amount_cents), 0) into v_refunded_cents
    from public.invoice_refunds
   where invoice_id = p_invoice_id and organization_id = p_organization_id
     and status in ('queued','pending','processing','refunded');
  v_overpaid_cents := greatest(v_paid_cents - coalesce(public.invoice_total_cents(v_invoice), 0) - v_refunded_cents, 0);
  -- Staat de factuur in het grootboek, dan telt ook wat per bank binnenkwam:
  -- een negatieve vordering is het teveel betaalde.
  if v_invoice.journal_entry_id is not null then
    v_overpaid_cents := greatest(v_overpaid_cents,
      -coalesce(public.invoice_open_receivable_cents(p_organization_id, p_invoice_id), 0));
  end if;
  v_credit_cents := greatest(p_amount_cents - v_overpaid_cents, 0);

  insert into public.invoice_refunds(
    organization_id, invoice_id, payment_record_id, kind, provider, provider_refund_id,
    status, amount_cents, currency, reason, idempotency_key, initiated_by, metadata, refunded_at
  ) values (
    p_organization_id, p_invoice_id, p_payment_record_id, 'mollie', 'mollie', p_provider_refund_id,
    v_status, p_amount_cents, coalesce(nullif(p_currency, ''), 'EUR'),
    nullif(btrim(coalesce(p_reason, '')), ''),
    'external-' || p_provider_refund_id,
    null,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('source', 'mollie_dashboard',
      'create_credit_note', v_credit_cents > 0, 'credit_note_cents', v_credit_cents, 'overpaid_cents', v_overpaid_cents),
    case when v_status = 'refunded' then now() else null end
  ) returning * into v_refund;

  perform public.recompute_invoice_refund_state(p_invoice_id, p_organization_id);

  perform public.insert_invoice_workflow_event(
    p_organization_id,
    p_invoice_id,
    'payment_refunded',
    'Externe terugbetaling gedetecteerd',
    'Een in Mollie aangemaakte terugbetaling is automatisch in de administratie opgenomen.',
    jsonb_build_object('refund_id', v_refund.id, 'provider_refund_id', p_provider_refund_id, 'amount_cents', p_amount_cents, 'status', v_status, 'external', true),
    null
  );

  insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
  values (p_organization_id, null, 'invoice_refunded', 'invoice', p_invoice_id,
          (select coalesce(number, '') from public.invoices where id = p_invoice_id and organization_id = p_organization_id),
          jsonb_build_object('refund_id', v_refund.id, 'amount_cents', p_amount_cents, 'external', true));

  return v_refund;
end;
$function$;

revoke all on function public.begin_invoice_refund(uuid, uuid, uuid, integer, text, text, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.begin_invoice_refund(uuid, uuid, uuid, integer, text, text, uuid, text, jsonb) to service_role;
revoke all on function public.recompute_invoice_refund_state(uuid, uuid) from public, anon, authenticated;
grant execute on function public.recompute_invoice_refund_state(uuid, uuid) to service_role;
revoke all on function public.complete_invoice_refund(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.complete_invoice_refund(uuid, uuid, text, text, jsonb) to service_role;
revoke all on function public.ingest_external_refund(uuid, uuid, uuid, text, integer, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_external_refund(uuid, uuid, uuid, text, integer, text, text, text, jsonb) to service_role;


-- ── I4. De pagina na het betalen blijft werken ──────────────────────────────

CREATE OR REPLACE FUNCTION public.begin_invoice_payment_checkout(p_invoice_id uuid, p_organization_id uuid, p_actor_user_id uuid, p_amount_cents integer, p_public_token_hash text DEFAULT NULL::text, p_public_token_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_currency text DEFAULT 'EUR'::text, p_idempotency_key text DEFAULT NULL::text, p_checkout_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS invoice_payment_records
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_invoice public.invoices;
  v_open bigint;
  v_amount integer := p_amount_cents;
  v_existing public.invoice_payment_records;
  v_payment public.invoice_payment_records;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_public_token text;
  v_link public.invoice_public_links;
begin
  if p_actor_user_id is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;

  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_invoice
  from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Factuur niet gevonden.' using errcode = '02000'; end if;
  if v_invoice.status in ('paid','cancelled','void','written_off','refunded') then
    raise exception 'Voor deze factuur kan geen betaallink worden aangemaakt.' using errcode = '23514';
  end if;
  -- Nooit meer vragen dan er openstaat: na een deelbetaling (bank of Mollie) of
  -- een creditnota betaalde de klant anders te veel. Staat de factuur niet in
  -- het grootboek, dan geldt het gevraagde bedrag (het factuurtotaal).
  if v_invoice.journal_entry_id is not null then
    v_open := public.invoice_open_receivable_cents(p_organization_id, p_invoice_id);
    if v_open is not null then
      if v_open <= 0 then
        raise exception 'Op deze factuur staat niets meer open.' using errcode = '23514';
      end if;
      v_amount := least(p_amount_cents::bigint, v_open)::integer;
    end if;
  end if;
  if v_amount <= 0 then raise exception 'Factuurbedrag moet groter zijn dan 0.' using errcode = '23514'; end if;

  select * into v_existing
  from public.invoice_payment_records p
  where p.organization_id = p_organization_id
    and p.invoice_id = p_invoice_id
    and p.provider = 'mollie'
    and p.status in ('creating','open','pending','authorized')
    and (p.checkout_expires_at is null or p.checkout_expires_at > now())
  order by p.created_at desc
  limit 1
  for update;

  if found then
    -- Zelfde bedrag, of de klant is al aan het betalen (pending/authorized):
    -- die betaling teruggeven, geen tweede ernaast.
    if v_existing.amount_cents = v_amount or v_existing.status in ('pending','authorized') then
      return v_existing;
    end if;
    -- De open link vraagt een ander bedrag (er is intussen deels betaald of
    -- gecrediteerd): laat hem vervallen en maak er een voor het juiste bedrag.
    -- Betaalt de klant de oude toch, dan komt die betaling via de webhook
    -- gewoon binnen (expired → paid mag) en wordt hij geboekt.
    update public.invoice_payment_records
       set status = 'expired',
           checkout_expires_at = least(coalesce(checkout_expires_at, now()), now()),
           metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('superseded', 'open_amount_changed', 'superseded_at', now()),
           updated_at = now()
     where id = v_existing.id;
  end if;

  -- Een verlopen, nooit geopende link (creating/open, de webhook kwam niet)
  -- houdt de unieke index op één actieve betaling bezet; die vervalt ook.
  update public.invoice_payment_records p
     set status = 'expired',
         metadata = coalesce(p.metadata, '{}'::jsonb) || jsonb_build_object('superseded', 'checkout_expired', 'superseded_at', now()),
         updated_at = now()
   where p.organization_id = p_organization_id
     and p.invoice_id = p_invoice_id
     and p.provider = 'mollie'
     and p.status in ('creating','open')
     and p.checkout_expires_at is not null
     and p.checkout_expires_at <= now();

  insert into public.invoice_payment_records(
    organization_id, invoice_id, created_by, amount_cents, currency, status,
    idempotency_key, checkout_expires_at, metadata
  ) values (
    p_organization_id, p_invoice_id, p_actor_user_id, v_amount,
    upper(coalesce(nullif(btrim(p_currency), ''), 'EUR')), 'creating', v_key,
    p_checkout_expires_at, coalesce(p_metadata, '{}'::jsonb)
  ) returning * into v_payment;

  update public.invoices
     set locked_at = coalesce(locked_at, now()),
         locked_reason = coalesce(locked_reason, 'payment_checkout_created'),
         updated_at = now()
   where id = p_invoice_id and organization_id = p_organization_id;

  v_public_token := substring(coalesce(p_metadata->>'publicUrl', '') from '/invoice/([^?/#]+)');
  if v_public_token is not null and btrim(v_public_token) <> '' then
    v_link := public.create_invoice_public_link(
      p_invoice_id,
      p_organization_id,
      v_public_token,
      'payment',
      -- GEWIJZIGD (20261105230000): deze link is de pagina waar Mollie de klant
      -- na het betalen naartoe stuurt. Hij verliep met de checkout (30 minuten):
      -- wie later betaalde (een bankoverschrijving via Mollie, een open tabblad)
      -- kwam uit op "deze link werkt niet meer". Nu zo lang als een factuurlink.
      greatest(coalesce(p_public_token_expires_at, now() + interval '60 days'), coalesce(p_checkout_expires_at, now())),
      null,
      v_payment.id,
      p_actor_user_id,
      jsonb_build_object('publicUrl', p_metadata->>'publicUrl')
    );
  end if;

  insert into public.finance_provider_jobs(organization_id, entity_type, entity_id, provider, job_type, status, idempotency_key, request_payload)
  values (p_organization_id, 'payment', v_payment.id, 'mollie', 'create_invoice_payment', 'queued', coalesce(v_key, 'invoice-payment-' || v_payment.id::text), jsonb_build_object('invoice_id', p_invoice_id, 'amount_cents', v_amount))
  on conflict (provider, job_type, idempotency_key) where idempotency_key is not null do update
    set updated_at = now();

  return v_payment;
exception when unique_violation then
  select * into v_payment
  from public.invoice_payment_records
  where organization_id = p_organization_id
    and invoice_id = p_invoice_id
    and provider = 'mollie'
    and status in ('creating','open','pending','authorized')
  order by created_at desc
  limit 1;

  if found then return v_payment; end if;
  raise;
end;
$function$;

revoke all on function public.begin_invoice_payment_checkout(uuid, uuid, uuid, integer, text, timestamptz, text, text, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.begin_invoice_payment_checkout(uuid, uuid, uuid, integer, text, timestamptz, text, text, timestamptz, jsonb) to service_role;


-- ── I5. Een betaling die eerder kwam dan de boeking van de factuur ─────────
--
-- Een concept met een betaallink (de link wordt vóór het versturen gemaakt) dat
-- toch betaald werd: de betaling kwam binnen terwijl de factuur nog niet te
-- boeken was (book_invoice_payment slaat hem dan over), daarna boekte de
-- statuswissel naar 'paid' de factuur. Gevolg: factuur betaald, omzet en btw
-- geboekt, maar 1300 Debiteuren bleef het volle bedrag tonen, zonder signaal en
-- zonder knop om het recht te zetten. Nu boekt het boeken van de factuur ook de
-- betalingen die al binnen waren.

create or replace function public.trg_autobook_sales_invoice()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment record;
begin
  if new.journal_entry_id is null
     and new.status in ('sent', 'accepted', 'paid', 'overdue') then
    begin
      perform public.ensure_sales_invoice_booked(new.organization_id, new.id, new.created_by);
    exception when others then
      raise warning 'Automatisch boeken van factuur % mislukt: %', new.id, sqlerrm;
    end;
    -- GEWIJZIGD (20261105230000): betalingen die al binnen waren, alsnog boeken.
    -- book_invoice_payment is idempotent en boekt niets zolang de factuur zelf
    -- niet geboekt is (vóór de startdatum: beginbalans).
    for v_payment in
      select p.id
      from public.invoice_payment_records p
      where p.organization_id = new.organization_id
        and p.invoice_id = new.id
        and p.status = 'paid'
        and p.journal_entry_id is null
        and coalesce(p.amount_cents, 0) > 0
      order by p.paid_at nulls last, p.created_at
    loop
      begin
        perform public.book_invoice_payment(new.organization_id, v_payment.id, new.created_by);
      exception when others then
        raise warning 'Automatisch boeken van betaling % mislukt: %', v_payment.id, sqlerrm;
      end;
    end loop;
  end if;
  return null;   -- AFTER-trigger
end;
$$;

revoke all on function public.trg_autobook_sales_invoice() from public, anon;
grant execute on function public.trg_autobook_sales_invoice() to authenticated, service_role;


-- ── J1. Pushmelding "Factuur betaald" alleen voor wie Financiën ziet ───────

CREATE OR REPLACE FUNCTION public.push_on_invoice_paid()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_client_name text;
  v_body text;
begin
  begin
    if new.status is distinct from 'paid' then return null; end if;
    if old.status is not distinct from 'paid' then return null; end if;

    select c.name into v_client_name from public.clients c where c.id = new.client_id;
    v_body := 'Factuur ' || coalesce(nullif(btrim(new.number), ''), '')
              || coalesce(' — ' || nullif(btrim(v_client_name), ''), '');

    perform public.push_enqueue(
      new.organization_id, 'invoice_paid',
      -- GEWIJZIGD (20261105230000): alleen wie Financiën kan zien. Een lid met
      -- Financiën op 'geen' kreeg factuurnummer, klantnaam en "betaald" op zijn
      -- telefoon, terwijl het scherm hem 0 facturen toont.
      public.push_module_member_ids(new.organization_id, 'finance'),
      jsonb_build_object('title', 'Factuur betaald', 'body', btrim(v_body), 'url', '/', 'tag', 'invoice:' || new.id::text)
    );
  exception when others then
    raise warning 'push_on_invoice_paid: %', sqlerrm;
  end;
  return null;
end;
$function$;

revoke all on function public.push_on_invoice_paid() from public, anon;
grant execute on function public.push_on_invoice_paid() to authenticated, service_role;

-- ── J2. Herinnering- en aanmaningsinstellingen alleen voor beheerders ──────
--
-- Het scherm zegt "Alleen owners en admins", maar de policies vroegen alleen
-- schrijfrecht: elk lid met Financiën op schrijven kon automatische
-- herinneringen naar alle klanten met een vervallen factuur, en de
-- aanmaningsvoorstellen, aan- of uitzetten.

drop policy if exists "invoice reminder settings insert" on public.invoice_reminder_settings;
create policy "invoice reminder settings insert" on public.invoice_reminder_settings
  for insert with check (public.can_admin_org(organization_id));
drop policy if exists "invoice reminder settings update" on public.invoice_reminder_settings;
create policy "invoice reminder settings update" on public.invoice_reminder_settings
  for update using (public.can_admin_org(organization_id)) with check (public.can_admin_org(organization_id));

-- ── J3. Nummers: niet afkappen, niet laten vastlopen ───────────────────────
--
-- lpad(n, 4) kapt af: nummer 10000 werd FAC-2026-1000, een bestaand nummer.
-- Dat geldt voor facturen, creditnota's (dezelfde functie) en contracten. En
-- een concept met FAC-2026-2147483646 zette de reeks op het maximum van een
-- integer; daarna liep elke nieuwe factuur uit een offerte vast.

CREATE OR REPLACE FUNCTION public.format_invoice_number(p_prefix text, p_year integer, p_number integer, p_padding integer)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select upper(btrim(coalesce(p_prefix, 'FAC'))) || '-' || coalesce(p_year, extract(year from current_date)::integer)::text || '-' || case when length(greatest(coalesce(p_number, 1), 1)::text) >= greatest(coalesce(p_padding, 4), 1)
         then greatest(coalesce(p_number, 1), 1)::text
         else lpad(greatest(coalesce(p_number, 1), 1)::text, greatest(coalesce(p_padding, 4), 1), '0') end;
$function$;

CREATE OR REPLACE FUNCTION public.extract_invoice_sequence_number(p_invoice_number text, p_prefix text DEFAULT 'FAC'::text, p_year integer DEFAULT (EXTRACT(year FROM CURRENT_DATE))::integer)
 RETURNS integer
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare
  v_value text := upper(btrim(coalesce(p_invoice_number, '')));
  v_prefix text := regexp_replace(upper(btrim(coalesce(p_prefix, 'FAC'))), '[^A-Z0-9]+', '', 'g');
  v_match text[];
begin
  v_match := regexp_match(v_value, '^' || v_prefix || '-' || p_year::text || '-([0-9]+)$');
  if v_match is null then
    return null;
  end if;
  -- GEWIJZIGD (20261105230000): een absurd hoog nummer (een concept met
  -- FAC-2026-2147483646) telt niet mee; anders sprong de reeks naar het maximum
  -- van een integer en liep het uitgeven van nummers vast.
  if length(v_match[1]) > 8 then
    return null;
  end if;
  return v_match[1]::integer;
exception when others then
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.allocate_next_contract_number(p_organization_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_seq public.organization_contract_number_sequences;
  v_number integer;
  v_code text;
begin
  if p_organization_id is null then
    raise exception 'Organisatie ontbreekt voor contractnummerreeks.' using errcode = '23514';
  end if;

  insert into public.organization_contract_number_sequences(organization_id)
  values (p_organization_id)
  on conflict (organization_id) do nothing;

  select * into v_seq
  from public.organization_contract_number_sequences
  where organization_id = p_organization_id
  for update;

  v_number := greatest(v_seq.next_number, 1);
  v_code := v_seq.prefix || '-' || to_char(now(), 'YYYY') || '-' || case when length(v_number::text) >= v_seq.padding then v_number::text else lpad(v_number::text, v_seq.padding, '0') end;

  while exists (
    select 1 from public.contracts c
    where c.organization_id = p_organization_id and c.number = v_code
  ) loop
    v_number := v_number + 1;
    v_code := v_seq.prefix || '-' || to_char(now(), 'YYYY') || '-' || case when length(v_number::text) >= v_seq.padding then v_number::text else lpad(v_number::text, v_seq.padding, '0') end;
  end loop;

  update public.organization_contract_number_sequences
    set next_number = v_number + 1, updated_at = now()
  where organization_id = p_organization_id;

  return v_code;
end;
$function$;

revoke all on function public.format_invoice_number(text, integer, integer, integer) from public, anon;
grant execute on function public.format_invoice_number(text, integer, integer, integer) to authenticated, service_role;
revoke all on function public.extract_invoice_sequence_number(text, text, integer) from public, anon;
grant execute on function public.extract_invoice_sequence_number(text, text, integer) to authenticated, service_role;
revoke all on function public.allocate_next_contract_number(uuid) from public, anon, authenticated;
grant execute on function public.allocate_next_contract_number(uuid) to service_role;

-- ── J4. Offertenummers uniek, factuurnummers ook zonder hoofdletters/spaties ─
--
-- Offertes hadden geen unieke nummers: twee collega's (of een oud tabblad)
-- maakten allebei OFF-2026-0008. En de unieke index op facturen is exact:
-- ' fac-2026-0002' kon naast FAC-2026-0002 bestaan. Bestaande dubbelen
-- blijven staan; een nieuw of gewijzigd nummer wordt nu gecontroleerd.

create or replace function public.enforce_finance_number_unique()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_norm text := upper(btrim(coalesce(new.number, '')));
  v_exists boolean;
begin
  if v_norm = '' then return new; end if;
  if tg_op = 'UPDATE' and upper(btrim(coalesce(old.number, ''))) = v_norm then return new; end if;
  -- Twee gelijktijdige inserts met hetzelfde nummer: na elkaar.
  perform pg_advisory_xact_lock(hashtext(new.organization_id::text), hashtext(tg_table_name || ':' || v_norm));
  if tg_table_name = 'quotes' then
    select exists (select 1 from public.quotes q where q.organization_id = new.organization_id
                    and upper(btrim(q.number)) = v_norm and q.id <> new.id) into v_exists;
  else
    select exists (select 1 from public.invoices i where i.organization_id = new.organization_id
                    and upper(btrim(i.number)) = v_norm and i.id <> new.id) into v_exists;
  end if;
  if v_exists then
    raise exception 'Nummer % is al in gebruik in deze organisatie. Kies het volgende nummer.', btrim(new.number)
      using errcode = '23505';
  end if;
  return new;
end;
$$;

drop trigger if exists quotes_number_unique on public.quotes;
create trigger quotes_number_unique
  before insert or update of number on public.quotes
  for each row execute function public.enforce_finance_number_unique();
drop trigger if exists invoices_number_unique on public.invoices;
create trigger invoices_number_unique
  before insert or update of number on public.invoices
  for each row execute function public.enforce_finance_number_unique();

revoke all on function public.enforce_finance_number_unique() from public, anon;
grant execute on function public.enforce_finance_number_unique() to authenticated, service_role;

-- ── J5. Offerte → factuur: datum en nummerjaar in Nederland ────────────────

CREATE OR REPLACE FUNCTION public.convert_accepted_quote_to_invoice(p_quote_id uuid, p_organization_id uuid)
 RETURNS invoices
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_quote public.quotes;
  v_quote_version public.quote_versions;
  v_existing public.invoices;
  v_invoice public.invoices;
  v_user_id uuid := auth.uid();
  v_invoice_number text;
  -- GEWIJZIGD (20261105230000): de datum in Nederland. Om 00:30 op 1 januari
  -- kreeg de factuur de datum en het nummer van het vorige jaar (UTC).
  v_today date := (now() at time zone 'Europe/Amsterdam')::date;
  v_due_date date := (now() at time zone 'Europe/Amsterdam')::date + 14;
  v_lines jsonb;
  v_notes text;
  v_quote_date date;
  v_valid_until date;
begin
  if v_user_id is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;

  if not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text), hashtext('quote_to_invoice'));

  select * into v_quote
  from public.quotes
  where id = p_quote_id and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Offerte niet gevonden.' using errcode = '02000';
  end if;

  if v_quote.status <> 'accepted' then
    raise exception 'Alleen geaccepteerde offertes kunnen worden omgezet naar een factuur.' using errcode = '23514';
  end if;

  select * into v_existing
  from public.invoices
  where organization_id = p_organization_id
    and quote_id = p_quote_id
  order by created_at asc
  limit 1
  for update;

  if found then
    return v_existing;
  end if;

  select * into v_quote_version
  from public.quote_versions qv
  where qv.organization_id = p_organization_id
    and qv.quote_id = p_quote_id
    and qv.id = coalesce(v_quote.accepted_sent_version_id, v_quote.accepted_version_id, v_quote.sent_version_id)
  limit 1;

  if not found then
    select * into v_quote_version
    from public.quote_versions qv
    where qv.organization_id = p_organization_id
      and qv.quote_id = p_quote_id
      and qv.snapshot_reason in ('client_accepted','sent_to_client')
    order by case qv.snapshot_reason when 'client_accepted' then 0 else 1 end, qv.created_at desc
    limit 1;
  end if;

  if not found or v_quote_version.id is null then
    raise exception 'Deze offerte heeft geen geaccepteerde/verzonden versie-snapshot. Maak of herstel eerst een offerteversie voordat je factureert.' using errcode = '23514';
  end if;

  -- GEWIJZIGD (20261104020000): de regels komen uit de bevroren offerte zelf
  -- (snapshot_data), mét btw-code en ongeronde prijs. quote_version_items kent
  -- geen btw-code en rondt aantal en prijs af op twee decimalen; daardoor kwam
  -- een ICP-, export- of verlegde regel als 0% binnenland op de factuur en werd
  -- 1000 × € 0,125 gefactureerd als € 130.
  select jsonb_agg(
    jsonb_strip_nulls(jsonb_build_object(
      'id', coalesce(nullif(l->>'id', ''), gen_random_uuid()::text),
      'description', coalesce(l->>'description', ''),
      'quantity', case when coalesce(l->>'quantity', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (l->>'quantity')::numeric else 0 end,
      'unit_price', case when coalesce(l->>'unit_price', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (l->>'unit_price')::numeric else 0 end,
      'vat', case when coalesce(l->>'vat', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (l->>'vat')::numeric else 0 end,
      'vat_code', nullif(btrim(coalesce(l->>'vat_code', '')), '')
    )) order by t.ord
  ) into v_lines
  from jsonb_array_elements(
    case when jsonb_typeof(v_quote_version.snapshot_data #> '{quote,lines}') = 'array'
      then v_quote_version.snapshot_data #> '{quote,lines}' else '[]'::jsonb end
  ) with ordinality as t(l, ord);

  if v_lines is null then
    select jsonb_agg(
      jsonb_build_object(
        'id', coalesce(qvi.source_line_id, qvi.id::text),
        'description', qvi.description,
        'quantity', qvi.quantity,
        'unit_price', qvi.unit_price,
        'vat', qvi.vat_percentage
      ) order by qvi.line_index
    ) into v_lines
    from public.quote_version_items qvi
    where qvi.quote_version_id = v_quote_version.id
      and qvi.organization_id = p_organization_id
      and qvi.quote_id = p_quote_id;
  end if;

  v_lines := coalesce(v_lines, v_quote_version.snapshot_data #> '{quote,lines}');
  v_notes := v_quote_version.notes;
  v_quote_date := v_quote_version.quote_date;
  v_valid_until := v_quote_version.valid_until;

  if v_lines is null or jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) = 0 then
    raise exception 'De geaccepteerde offerteversie bevat geen geldige regels.' using errcode = '23514';
  end if;

  v_invoice_number := public.allocate_next_invoice_number(p_organization_id, v_today);

  insert into public.invoices(
    organization_id, created_by, client_id, project_id, quote_id, source_quote_version_id,
    number, date, due_date, lines, status, notes
  ) values (
    p_organization_id, v_user_id, v_quote_version.client_id, v_quote_version.project_id, v_quote.id, v_quote_version.id,
    v_invoice_number, v_today, v_due_date, v_lines, 'draft', v_notes
  ) returning * into v_invoice;

  perform public.insert_invoice_workflow_event(
    p_organization_id,
    v_invoice.id,
    'created_from_quote',
    'Factuur aangemaakt uit offerte',
    'Factuur ' || v_invoice.number || ' is server-side aangemaakt uit de geaccepteerde offerteversie van ' || v_quote.number || '.',
    jsonb_build_object('quote_id', v_quote.id, 'quote_number', v_quote.number, 'quote_version_id', v_quote_version.id, 'quote_date', v_quote_date, 'quote_valid_until', v_valid_until),
    v_user_id
  );

  insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
  values (
    p_organization_id,
    v_user_id,
    'invoice_created_from_quote',
    'invoice',
    v_invoice.id,
    v_invoice.number,
    jsonb_build_object('title', 'Factuur aangemaakt uit offerte', 'quote_id', v_quote.id, 'quote_number', v_quote.number, 'quote_version_id', v_quote_version.id)
  );

  return v_invoice;
end;
$function$;

revoke all on function public.convert_accepted_quote_to_invoice(uuid, uuid) from public, anon;
grant execute on function public.convert_accepted_quote_to_invoice(uuid, uuid) to authenticated, service_role;

commit;
