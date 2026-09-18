-- ============================================================
-- ResoFly — Inkoopfacturen per e-mail: doorstuuradres, inbox en automatisch klaarzetten
-- Date: 2026-09-18
--
-- WAAROM
-- Leveranciersfacturen komen per mail binnen. Tot nu toe moest de gebruiker
-- elke factuur zelf opslaan en via "Factuur scannen" uploaden. Nu krijgt elke
-- organisatie een TWEEDE doorstuuradres, speciaal voor inkoopfacturen
-- (facturen-<slug>-<random>@inbound.resofly.com). Wat daar binnenkomt wordt
-- vastgelegd, de bijlagen gaan naar R2, de factuur wordt uitgelezen (UBL exact,
-- PDF/foto met AI), de leverancier wordt herkend of aangemaakt, dubbele
-- facturen worden tegengehouden en er wordt een concept-inkoopfactuur
-- klaargezet — desgewenst meteen geboekt.
--
-- ONTWERPKEUZES
-- 1. Hetzelfde aliasmechanisme als de klantmail (organization_inbound_aliases),
--    met een `purpose`. Eén tabel, één generator, één resolver, één set
--    rate-limits en blokkeerlijsten. De organization_id komt óók hier
--    uitsluitend uit het ontvangeradres.
-- 2. purchase_invoice_inbox is het register én de werklijst. Elke mail wordt
--    eerst vastgelegd (status 'received') en pas daarna verwerkt; "mislukt",
--    "dubbel" en "genegeerd" zijn statussen op een bewaarde rij, nooit /dev/null.
-- 3. Verwerken gebeurt in de edge functions (AI + R2), niet in SQL. SQL bewaakt
--    alleen wat transactioneel moet: dedup, tellers, statusovergangen, rechten.
-- 4. Er wordt uitsluitend automatisch GEBOEKT als de organisatie dat expliciet
--    aanzet, én alleen bij een bekende leverancier, hoge zekerheid, kloppende
--    totalen en volledig ingevulde grootboekrekeningen. Anders blijft het een
--    concept dat een mens boekt — precies zoals na "Factuur scannen".
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Doel van een doorstuuradres: klantmail of inkoopfacturen
-- ------------------------------------------------------------
alter table public.organization_inbound_aliases
  add column if not exists purpose text not null default 'mail';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'organization_inbound_aliases_purpose_check') then
    alter table public.organization_inbound_aliases
      add constraint organization_inbound_aliases_purpose_check check (purpose in ('mail', 'invoices'));
  end if;
end $$;

comment on column public.organization_inbound_aliases.purpose is
  'mail = doorgestuurde klantmail (klantdossier); invoices = inkoopfacturen (purchase_invoice_inbox).';

create index if not exists idx_org_inbound_alias_org_purpose
  on public.organization_inbound_aliases (organization_id, purpose, status, created_at desc);

-- ------------------------------------------------------------
-- 2. Aliasgenerator met optioneel voorvoegsel
--    Het factuuradres begint altijd met "facturen-": zo kan de Email Worker
--    zonder databaseraadpleging beslissen dat hij de bijlagen mee moet sturen.
--    De organisatie-slug mag daarom zelf nooit "facturen" zijn.
-- ------------------------------------------------------------
drop function if exists public.generate_inbound_alias_local_part(uuid);

create or replace function public.generate_inbound_alias_local_part(p_organization_id uuid, p_prefix text default null)
returns text language plpgsql volatile set search_path = public, extensions as $$
declare
  v_alphabet constant text := 'abcdefghijklmnopqrstuvwxyz234567';
  v_reserved constant text[] := array['reply','organizer','postmaster','abuse','noreply','mailer-daemon','in','facturen'];
  v_prefix text := nullif(lower(regexp_replace(coalesce(p_prefix, ''), '[^a-zA-Z0-9]+', '', 'g')), '');
  -- Het deel vóór het willekeurige stuk mag hooguit 24 tekens zijn (zie de
  -- CHECK op local_part); het voorvoegsel plus streepje gaat van de slug af.
  v_max_slug integer := 23 - coalesce(length(v_prefix) + 1, 0);
  v_slug text;
  v_rand text := '';
  v_bytes bytea;
  i integer;
begin
  select lower(regexp_replace(coalesce(o.slug, ''), '[^a-zA-Z0-9]+', '-', 'g'))
    into v_slug
    from public.organizations o
   where o.id = p_organization_id;

  v_slug := btrim(coalesce(nullif(v_slug, ''), 'resofly'), '-');
  v_slug := btrim(left(v_slug, v_max_slug), '-');
  if v_slug = '' or v_slug = any(v_reserved) then v_slug := left('resofly', v_max_slug); end if;

  v_bytes := gen_random_bytes(16);
  for i in 0..15 loop
    v_rand := v_rand || substr(v_alphabet, (get_byte(v_bytes, i) % 32) + 1, 1);
  end loop;

  return coalesce(v_prefix || '-', '') || v_slug || '-' || v_rand;
end; $$;

-- ------------------------------------------------------------
-- 3. Aanmaken / vernieuwen per doel
--    De oude één-argument-varianten moeten weg: mét een default-parameter
--    ernaast zou een aanroep met één argument dubbelzinnig zijn.
-- ------------------------------------------------------------
drop function if exists public.ensure_organization_inbound_alias(uuid);

create or replace function public.ensure_organization_inbound_alias(p_organization_id uuid, p_purpose text default 'mail')
returns public.organization_inbound_aliases
language plpgsql security definer set search_path = public as $$
declare
  v_row public.organization_inbound_aliases;
  v_purpose text := coalesce(nullif(btrim(p_purpose), ''), 'mail');
begin
  if v_purpose not in ('mail', 'invoices') then
    raise exception 'Onbekend doel voor een doorstuuradres.' using errcode = '22023';
  end if;
  if auth.role() is distinct from 'service_role'
     and not public.can_admin_org(p_organization_id) then
    raise exception 'Alleen owners en admins beheren het doorstuuradres.' using errcode = '42501';
  end if;

  select * into v_row from public.organization_inbound_aliases
   where organization_id = p_organization_id and purpose = v_purpose and status = 'active'
   order by created_at desc limit 1;
  if found then return v_row; end if;

  insert into public.organization_inbound_aliases (organization_id, local_part, purpose, label)
  values (
    p_organization_id,
    public.generate_inbound_alias_local_part(p_organization_id, case when v_purpose = 'invoices' then 'facturen' else null end),
    v_purpose,
    case when v_purpose = 'invoices' then 'Inkoopfacturen' else 'Doorstuuradres' end)
  returning * into v_row;
  return v_row;
end; $$;

drop function if exists public.rotate_organization_inbound_alias(uuid);

create or replace function public.rotate_organization_inbound_alias(p_organization_id uuid, p_purpose text default 'mail')
returns public.organization_inbound_aliases
language plpgsql security definer set search_path = public as $$
declare
  v_row public.organization_inbound_aliases;
  v_purpose text := coalesce(nullif(btrim(p_purpose), ''), 'mail');
begin
  if v_purpose not in ('mail', 'invoices') then
    raise exception 'Onbekend doel voor een doorstuuradres.' using errcode = '22023';
  end if;
  if not public.can_admin_org(p_organization_id) then
    raise exception 'Alleen owners en admins vernieuwen het doorstuuradres.' using errcode = '42501';
  end if;

  -- Het oude adres blijft 30 dagen resolven: mail die al onderweg is, komt
  -- gewoon nog binnen in plaats van te verdwijnen.
  update public.organization_inbound_aliases
     set status = 'retiring', retires_at = now() + interval '30 days'
   where organization_id = p_organization_id and purpose = v_purpose and status = 'active';

  insert into public.organization_inbound_aliases
    (organization_id, local_part, purpose, label, forward_from_email)
  select p_organization_id,
         public.generate_inbound_alias_local_part(p_organization_id, case when v_purpose = 'invoices' then 'facturen' else null end),
         v_purpose,
         case when v_purpose = 'invoices' then 'Inkoopfacturen' else 'Doorstuuradres' end,
         (select a.forward_from_email from public.organization_inbound_aliases a
           where a.organization_id = p_organization_id and a.purpose = v_purpose
           order by a.created_at desc limit 1)
  returning * into v_row;
  return v_row;
end; $$;

-- De resolver levert nu ook het doel en de aanmaker (die draagt het AI-tegoed
-- van de automatische verwerking). Het retourtype wijzigt, dus drop + create.
drop function if exists public.resolve_inbound_alias(text);

create or replace function public.resolve_inbound_alias(p_local_part text)
returns table (
  alias_id uuid, organization_id uuid, alias_status text,
  forward_from_email text, blocked_senders text[], purpose text, created_by uuid
)
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de service-role mag een doorstuuradres opzoeken.' using errcode = '42501';
  end if;
  return query
    select a.id, a.organization_id, a.status, a.forward_from_email, a.blocked_senders, a.purpose, a.created_by
      from public.organization_inbound_aliases a
     where a.local_part = lower(btrim(coalesce(p_local_part, '')))
       and (a.status = 'active'
            or (a.status = 'retiring' and (a.retires_at is null or a.retires_at > now())));
end; $$;

revoke execute on function public.resolve_inbound_alias(text) from public, anon, authenticated;
grant  execute on function public.resolve_inbound_alias(text) to service_role;

-- ------------------------------------------------------------
-- 4. Instellingen van de factuur-inbox (per organisatie)
-- ------------------------------------------------------------
create table if not exists public.purchase_invoice_inbox_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  -- PDF's en foto's met AI uitlezen (UBL-e-facturen gaan altijd, zonder AI).
  ai_enabled boolean not null default true,
  -- Onbekende leverancier met voldoende gegevens automatisch aanmaken.
  auto_create_suppliers boolean not null default true,
  -- Direct boeken als álle voorwaarden kloppen (bekende leverancier, hoge
  -- zekerheid, geen waarschuwingen, alle regels met grootboekrekening).
  auto_book boolean not null default false,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.purchase_invoice_inbox_settings is
  'Automatiseringskeuzes voor inkoopfacturen die per e-mail binnenkomen. Ontbrekende rij = de defaults.';

drop trigger if exists purchase_invoice_inbox_settings_updated on public.purchase_invoice_inbox_settings;
create trigger purchase_invoice_inbox_settings_updated
  before update on public.purchase_invoice_inbox_settings
  for each row execute function public.set_updated_at();

alter table public.purchase_invoice_inbox_settings enable row level security;

drop policy if exists "purchase invoice inbox settings read" on public.purchase_invoice_inbox_settings;
create policy "purchase invoice inbox settings read" on public.purchase_invoice_inbox_settings
  for select using (public.can_read_module(organization_id, 'finance'));

-- Schrijven uitsluitend via de RPC hieronder (owners/admins).
do $$ begin perform public.apply_module_gate('purchase_invoice_inbox_settings', 'finance', 'write'); end $$;

create or replace function public.set_purchase_invoice_inbox_settings(p_organization_id uuid, p_patch jsonb)
returns public.purchase_invoice_inbox_settings
language plpgsql security definer set search_path = public as $$
declare v_row public.purchase_invoice_inbox_settings;
begin
  if not public.can_admin_org(p_organization_id) then
    raise exception 'Alleen owners en admins wijzigen de instellingen van de factuur-inbox.' using errcode = '42501';
  end if;
  insert into public.purchase_invoice_inbox_settings
    (organization_id, ai_enabled, auto_create_suppliers, auto_book, updated_by)
  values (
    p_organization_id,
    coalesce((p_patch->>'ai_enabled')::boolean, true),
    coalesce((p_patch->>'auto_create_suppliers')::boolean, true),
    coalesce((p_patch->>'auto_book')::boolean, false),
    auth.uid())
  on conflict (organization_id) do update set
    ai_enabled = coalesce((p_patch->>'ai_enabled')::boolean, purchase_invoice_inbox_settings.ai_enabled),
    auto_create_suppliers = coalesce((p_patch->>'auto_create_suppliers')::boolean, purchase_invoice_inbox_settings.auto_create_suppliers),
    auto_book = coalesce((p_patch->>'auto_book')::boolean, purchase_invoice_inbox_settings.auto_book),
    updated_by = auth.uid()
  returning * into v_row;
  return v_row;
end; $$;

-- ------------------------------------------------------------
-- 5. De inbox: register + werklijst
-- ------------------------------------------------------------
create table if not exists public.purchase_invoice_inbox (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  alias_id uuid references public.organization_inbound_aliases(id) on delete set null,
  -- Een mail met meerdere facturen: de tweede en volgende krijgen een eigen rij
  -- die naar de eerste verwijst.
  parent_id uuid references public.purchase_invoice_inbox(id) on delete set null,

  -- Transport-idempotentie: ontvanger|message-id|inhoudshash (zie mail-inbound).
  dedup_key text not null,
  recipient text not null default '',
  rfc_message_id text,
  sender_email text,
  sender_name text,
  subject text not null default '',
  body_excerpt text,
  -- Volledige platte tekst (max 64k): voor facturen die in de mail zelf staan.
  body_text text,
  received_at timestamptz not null default now(),

  -- [{ name, mime_type, size_bytes, storage_key, sha256, kind: document|copy|body|other|oversized|unsupported|skipped }]
  attachments jsonb not null default '[]'::jsonb,

  status text not null default 'received' check (status in
    ('received','processing','ready','booked','needs_review','duplicate','rejected','failed','dropped')),
  reason text,
  error_message text,

  method text check (method in ('ai','ubl')),
  confidence text check (confidence in ('high','medium','low')),
  warnings text[] not null default '{}',
  -- Het voorstel in hetzelfde formaat als de handmatige factuurscan; blijft
  -- bewaard zodat "Klaarzetten" na een correctie geen tweede AI-call kost.
  proposal jsonb,
  extraction_meta jsonb,

  supplier_id uuid references public.suppliers(id) on delete set null,
  supplier_match text,
  supplier_created boolean not null default false,
  purchase_invoice_id uuid references public.purchase_invoices(id) on delete set null,
  duplicate_of_purchase_invoice_id uuid references public.purchase_invoices(id) on delete set null,
  duplicate_of_inbox_id uuid references public.purchase_invoice_inbox(id) on delete set null,
  auto_booked boolean not null default false,

  attempts integer not null default 0,
  processing_started_at timestamptz,
  processed_at timestamptz,
  notified_at timestamptz,
  handled_by uuid references auth.users(id) on delete set null,
  handled_at timestamptz,
  -- Wanneer de bijlagen van een genegeerd/dubbel item van R2 zijn opgeruimd.
  purged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.purchase_invoice_inbox is
  'Inkoopfacturen die per e-mail binnenkwamen op het factuur-doorstuuradres: register, verwerkingsstatus, voorstel en de koppeling naar het klaargezette concept.';

create unique index if not exists uidx_purchase_invoice_inbox_dedup
  on public.purchase_invoice_inbox (dedup_key);
create index if not exists idx_purchase_invoice_inbox_org_status
  on public.purchase_invoice_inbox (organization_id, status, received_at desc);
create index if not exists idx_purchase_invoice_inbox_org_rfc
  on public.purchase_invoice_inbox (organization_id, rfc_message_id)
  where rfc_message_id is not null;
create index if not exists idx_purchase_invoice_inbox_invoice
  on public.purchase_invoice_inbox (purchase_invoice_id)
  where purchase_invoice_id is not null;
-- De periodieke opruimronde (invoice-inbox?cron=sweep): vastgelopen of tijdelijk
-- mislukte items opnieuw oppakken, en bijlagen van afgedane items opruimen.
create index if not exists idx_purchase_invoice_inbox_sweep
  on public.purchase_invoice_inbox (status, updated_at)
  where status in ('received', 'processing', 'failed', 'needs_review');
create index if not exists idx_purchase_invoice_inbox_purge
  on public.purchase_invoice_inbox (status, updated_at)
  where purged_at is null and status in ('rejected', 'dropped', 'duplicate');

drop trigger if exists purchase_invoice_inbox_updated on public.purchase_invoice_inbox;
create trigger purchase_invoice_inbox_updated
  before update on public.purchase_invoice_inbox
  for each row execute function public.set_updated_at();

drop trigger if exists purchase_invoice_inbox_prevent_org_change on public.purchase_invoice_inbox;
create trigger purchase_invoice_inbox_prevent_org_change
  before update of organization_id on public.purchase_invoice_inbox
  for each row execute function public.prevent_organization_id_change();

-- Verwijzingen mogen nooit over een organisatiegrens heen.
create or replace function public.purchase_invoice_inbox_validate_refs()
returns trigger language plpgsql as $$
begin
  perform public.assert_same_org_reference('public.suppliers', new.supplier_id, new.organization_id, 'Leverancier');
  perform public.assert_same_org_reference('public.purchase_invoices', new.purchase_invoice_id, new.organization_id, 'Inkoopfactuur');
  perform public.assert_same_org_reference('public.purchase_invoices', new.duplicate_of_purchase_invoice_id, new.organization_id, 'Inkoopfactuur');
  perform public.assert_same_org_reference('public.purchase_invoice_inbox', new.duplicate_of_inbox_id, new.organization_id, 'Inbox-item');
  perform public.assert_same_org_reference('public.purchase_invoice_inbox', new.parent_id, new.organization_id, 'Inbox-item');
  perform public.assert_same_org_reference('public.organization_inbound_aliases', new.alias_id, new.organization_id, 'Doorstuuradres');
  return new;
end; $$;

drop trigger if exists purchase_invoice_inbox_validate_refs on public.purchase_invoice_inbox;
create trigger purchase_invoice_inbox_validate_refs
  before insert or update on public.purchase_invoice_inbox
  for each row execute function public.purchase_invoice_inbox_validate_refs();

alter table public.purchase_invoice_inbox enable row level security;

drop policy if exists "purchase invoice inbox read" on public.purchase_invoice_inbox;
create policy "purchase invoice inbox read" on public.purchase_invoice_inbox
  for select using (public.can_read_module(organization_id, 'finance'));

-- Geen insert/update-policy: schrijven loopt via de service-role (mail-inbound,
-- invoice-inbox) en de RPC's hieronder.
do $$ begin perform public.apply_module_gate('purchase_invoice_inbox', 'finance', 'write'); end $$;

-- ------------------------------------------------------------
-- 6. Registreren (service-role): vastleggen + dedupliceren + tellers
--    De bijlagen worden pas ná registratie opgeslagen (de opslagsleutel bevat
--    het id); de edge function vult ze daarna in met een update.
-- ------------------------------------------------------------
create or replace function public.register_purchase_invoice_inbox(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m public.purchase_invoice_inbox;
  v_org uuid := (p_payload->>'organization_id')::uuid;
  v_dedup text := p_payload->>'dedup_key';
  v_drop text := nullif(p_payload->>'drop_reason', '');
  v_throttled boolean := false;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de service-role mag inkomende facturen registreren.' using errcode = '42501';
  end if;
  if v_org is null or v_dedup is null then
    raise exception 'Onvolledige inbox-payload.' using errcode = '22023';
  end if;

  insert into public.purchase_invoice_inbox (
    organization_id, alias_id, dedup_key, recipient, rfc_message_id,
    sender_email, sender_name, subject, body_excerpt, body_text, received_at, status
  ) values (
    v_org, (p_payload->>'alias_id')::uuid, v_dedup, coalesce(p_payload->>'recipient', ''),
    nullif(p_payload->>'rfc_message_id', ''),
    nullif(p_payload->>'sender_email', ''), nullif(p_payload->>'sender_name', ''),
    left(coalesce(p_payload->>'subject', ''), 998),
    left(coalesce(p_payload->>'body_excerpt', ''), 4000),
    nullif(left(coalesce(p_payload->>'body_text', ''), 65536), ''),
    coalesce((p_payload->>'received_at')::timestamptz, now()),
    'received'
  )
  on conflict (dedup_key) do nothing
  returning * into m;

  if m.id is null then
    select * into m from public.purchase_invoice_inbox where dedup_key = v_dedup;
    -- Alleen een rij die nog nooit verder kwam dan de registratie (vorige
    -- poging strandde vóór de bijlagen) mag opnieuw gevuld worden.
    if m.status = 'received' and jsonb_array_length(coalesce(m.attachments, '[]'::jsonb)) = 0 then
      return jsonb_build_object('outcome', 'retry', 'inbox_id', m.id);
    end if;
    return jsonb_build_object('outcome', 'duplicate', 'inbox_id', m.id);
  end if;

  -- Tellers + rate limit op het alias, pas ná dedup (retries tellen niet).
  if m.alias_id is not null then
    update public.organization_inbound_aliases a
       set rate_window_started_at = case
             when a.rate_window_started_at is null or a.rate_window_started_at < now() - interval '1 hour'
             then now() else a.rate_window_started_at end,
           rate_window_count = case
             when a.rate_window_started_at is null or a.rate_window_started_at < now() - interval '1 hour'
             then 1 else a.rate_window_count + 1 end,
           last_received_at = now(),
           received_total = a.received_total + 1
     where a.id = m.alias_id
    returning (a.rate_window_count > 120) into v_throttled;
  end if;

  if v_drop is not null then
    update public.purchase_invoice_inbox
       set status = 'dropped', reason = v_drop, processed_at = now()
     where id = m.id;
    return jsonb_build_object('outcome', 'dropped', 'reason', v_drop, 'inbox_id', m.id);
  end if;

  -- Een stortvloed verwerken we niet automatisch: dat is het versterkingspad
  -- van een spamgolf naar de AI-kosten. De rijen blijven zichtbaar.
  if v_throttled then
    update public.purchase_invoice_inbox
       set status = 'needs_review', reason = 'rate_limited'
     where id = m.id;
    return jsonb_build_object('outcome', 'parked', 'reason', 'rate_limited', 'inbox_id', m.id);
  end if;

  return jsonb_build_object('outcome', 'registered', 'inbox_id', m.id);
end; $$;

revoke execute on function public.register_purchase_invoice_inbox(jsonb) from public, anon, authenticated;
grant  execute on function public.register_purchase_invoice_inbox(jsonb) to service_role;

-- ------------------------------------------------------------
-- 7. Volgend intern inkoopfactuurnummer (spiegel van nextPurchaseNumber in
--    de frontend: INK-<jaar>-<volgnummer>, per jaar het hoogste + 1)
-- ------------------------------------------------------------
create or replace function public.next_purchase_invoice_number(p_organization_id uuid, p_date date default current_date)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  v_prefix text := 'INK-' || to_char(coalesce(p_date, current_date), 'YYYY') || '-';
  v_max integer;
begin
  if auth.role() is distinct from 'service_role' and not public.can_read_org(p_organization_id) then
    raise exception 'Geen toegang tot deze organisatie.' using errcode = '42501';
  end if;
  select coalesce(max((regexp_match(substr(pi.internal_number, length(v_prefix) + 1), '^\d+'))[1]::integer), 0)
    into v_max
    from public.purchase_invoices pi
   where pi.organization_id = p_organization_id
     and pi.internal_number like v_prefix || '%';
  return v_prefix || lpad((coalesce(v_max, 0) + 1)::text, 4, '0');
end; $$;

-- ------------------------------------------------------------
-- 8. Status van de inbox volgt het concept
--    Boekt een mens het klaargezette concept, dan is het inbox-item klaar.
--    Verwijdert hij het concept, dan komt het item terug op de werklijst in
--    plaats van stil te wijzen naar niets.
--    BEFORE-trigger, bewust: de FK purchase_invoice_id ... on delete set null
--    is een AFTER-trigger die alfabetisch vóór de onze vuurt (RI_… < p…) en
--    de verwijzing dan al heeft leeggemaakt voordat wij hem kunnen vinden.
-- ------------------------------------------------------------
create or replace function public.purchase_invoice_inbox_sync_from_invoice()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    if TG_OP = 'DELETE' then
      update public.purchase_invoice_inbox
         set status = 'needs_review', reason = 'draft_deleted', purchase_invoice_id = null
       where purchase_invoice_id = old.id and status in ('ready', 'booked');
      return old;
    end if;
    if new.status in ('booked', 'paid') and old.status is distinct from new.status then
      update public.purchase_invoice_inbox
         set status = 'booked'
       where purchase_invoice_id = new.id and status = 'ready';
    elsif new.status = 'cancelled' and old.status is distinct from new.status then
      update public.purchase_invoice_inbox
         set status = 'needs_review', reason = 'draft_cancelled'
       where purchase_invoice_id = new.id and status in ('ready', 'booked');
    end if;
  exception when others then
    raise warning 'purchase_invoice_inbox_sync_from_invoice: %', sqlerrm;
  end;
  return coalesce(new, old);
end; $$;

drop trigger if exists purchase_invoices_inbox_sync on public.purchase_invoices;
create trigger purchase_invoices_inbox_sync
  before update of status or delete on public.purchase_invoices
  for each row execute function public.purchase_invoice_inbox_sync_from_invoice();

-- ------------------------------------------------------------
-- 9. Meldingen
-- ------------------------------------------------------------
-- 9a. Nieuw gebeurtenistype in de push-tabellen. De CHECK-constraints zijn
--     in eerdere migraties al enkele keren vervangen; we zoeken ze op inhoud.
do $$
declare c record;
begin
  for c in
    select conname, conrelid::regclass as tbl
      from pg_constraint
     where contype = 'c'
       and conrelid in ('public.notification_outbox'::regclass, 'public.notification_preferences'::regclass)
       and pg_get_constraintdef(oid) like '%event_type%'
  loop
    execute format('alter table %s drop constraint %I', c.tbl, c.conname);
  end loop;
end $$;
alter table public.notification_outbox add constraint notification_outbox_event_type_check
  check (event_type in ('ticket_new','ticket_note_client','chat_message','client_email_inbound','booking_new','invoice_paid','decision_digest','mcp_proposal','purchase_invoice_inbox'));
alter table public.notification_preferences add constraint notification_preferences_event_type_check
  check (event_type in ('ticket_new','ticket_note_client','chat_message','client_email_inbound','booking_new','invoice_paid','decision_digest','mcp_proposal','purchase_invoice_inbox'));

-- 9b. Ontvangers: alleen teamleden die de module Financiën mogen zien.
--     (org_module_level kijkt naar auth.uid() en is hier dus niet bruikbaar.)
create or replace function public.push_module_member_ids(p_org uuid, p_module text)
returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(m.user_id), '{}'::uuid[])
    from public.organization_members m
   where m.organization_id = p_org
     and m.status = 'active'
     and (m.role in ('owner', 'admin')
          or coalesce(nullif(m.module_access ->> p_module, ''), 'write') <> 'none');
$$;

revoke execute on function public.push_module_member_ids(uuid, text) from public, anon, authenticated;

-- 9c. Eén melding per inbox-item, bij de eerste toestand die aandacht of
--     bevestiging waard is. BEFORE-trigger zodat notified_at meegaat.
create or replace function public.push_on_purchase_invoice_inbox()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_title text;
  v_body text;
  v_supplier text;
  v_total bigint;
  v_reason text;
begin
  begin
    if new.status not in ('ready', 'booked', 'needs_review', 'duplicate') then return new; end if;
    if new.notified_at is not null then return new; end if;
    new.notified_at := now();

    v_supplier := coalesce(
      nullif(new.proposal->'supplier'->>'name', ''),
      nullif(new.sender_name, ''), nullif(new.sender_email, ''), 'Onbekende afzender');
    v_total := nullif(new.proposal->'totals'->>'total_cents', '')::bigint;
    v_reason := case new.reason
      when 'supplier_unknown' then 'leverancier onbekend'
      when 'no_attachment' then 'geen bijlage gevonden'
      when 'nothing_extracted' then 'geen factuur herkend'
      when 'ai_unavailable' then 'AI niet beschikbaar'
      when 'budget_exhausted' then 'AI-tegoed op'
      when 'rate_limited' then 'ongewoon veel post tegelijk'
      when 'extraction_failed' then 'uitlezen mislukt'
      else coalesce(new.reason, '') end;

    v_title := case new.status
      when 'ready' then 'Inkoopfactuur klaargezet'
      when 'booked' then 'Inkoopfactuur geboekt'
      when 'duplicate' then 'Dubbele inkoopfactuur'
      else 'Inkoopfactuur vraagt aandacht' end;
    v_body := v_supplier
      || case when v_total is not null
           then ' · € ' || regexp_replace((v_total / 100)::text, '(\d)(?=(\d{3})+$)', '\1.', 'g')
                || ',' || lpad((abs(v_total) % 100)::text, 2, '0')
           else '' end
      || case when new.status = 'needs_review' and v_reason <> '' then ' — ' || v_reason else '' end;

    perform public.push_enqueue(
      new.organization_id, 'purchase_invoice_inbox',
      public.push_module_member_ids(new.organization_id, 'finance'),
      jsonb_build_object('title', v_title, 'body', v_body, 'url', '/',
                         'tag', 'purchase-inbox:' || new.id::text));
  exception when others then
    raise warning 'push_on_purchase_invoice_inbox: %', sqlerrm;
  end;
  return new;
end; $$;

drop trigger if exists purchase_invoice_inbox_push on public.purchase_invoice_inbox;
create trigger purchase_invoice_inbox_push
  before insert or update of status on public.purchase_invoice_inbox
  for each row execute function public.push_on_purchase_invoice_inbox();

-- ------------------------------------------------------------
-- 10. Realtime: de inbox-lijst werkt live bij terwijl er verwerkt wordt.
-- ------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public'
         and tablename = 'purchase_invoice_inbox') then
      alter publication supabase_realtime add table public.purchase_invoice_inbox;
    end if;
  end if;
end $$;

commit;
