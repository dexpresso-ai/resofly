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
-- schema. Voor ingelogde gebruikers helpt alleen een nieuwere Postgres-versie;
-- dat is een actie voor de eigenaar (zie het rapport).

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

  -- GEWIJZIGD (20261105030000): de totalen van de versie zoals de factuur ze
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
  select array_agg(m[1]) into v_actions from regexp_matches(v_def, '''([^'']+)''', 'g') as m;
  if 'quote_cancelled' = any(v_actions) then return; end if;
  v_actions := v_actions || array['quote_cancelled'];
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

commit;
