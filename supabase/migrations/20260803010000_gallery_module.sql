-- ============================================================
-- ResoFly — Galerij-oplevering (foto/video) + accountbrede opslagbundels
-- Date: 2026-08-03
--
-- Aanleiding:
-- - Beeldmakers willen na afloop van een project een galerij (foto's en
--   video's) opleveren aan de klant: full-res bestanden in R2, snelle
--   low-res weergave in de app, Netflix-achtige videoweergave, en
--   klanttoegang via het portaal én via een publieke deellink met
--   optionele pincode. De klant kan favorieten markeren.
-- - Opslag wordt accountbreed begrensd per abonnement (GB per plan) met
--   bij te kopen opslagbundels via het bestaande Mollie-mandaatpatroon
--   (zelfde flow als extra seats).
--
-- Scope:
-- 1. Tabellen galleries / gallery_items / gallery_favorites met RLS,
--    org-integriteitstriggers en module-gate onder de module 'projects'.
--    Bewust GEEN hergebruik van attachments (voorkomt de bekende
--    entity_type-driftklasse; galerij-items hebben eigen metadata zoals
--    stream_uid en preview-keys).
-- 2. Opslagbundels: storage_gb/storage_addon_gb in billing_plans.limits,
--    add-on-prijzen per interval op billing_plans, storage_addons op het
--    billingprofiel, RPC apply_organization_storage_change en een
--    uitgebreide organization_billing_overview.
-- 3. RPC organization_storage_status: accountbreed verbruik (attachments +
--    documents + meeting_recordings + galerij-items) tegenover de limiet.
--    De media-api worker roept deze aan vóór elke upload (service-role);
--    de frontend toont er de opslagmeter mee.
--
-- Ontwerp:
-- - De deellink slaat uitsluitend een SHA-256-hash van het token op
--   (share_token_hash); het token zelf bestaat alleen client-side op het
--   moment van genereren. De pincode wordt gehasht met het token als zout
--   (share_pin_hash) en kent een teller + lockout tegen brute force.
-- - Favorieten kennen twee actoren: een portaal-contactpersoon
--   (contact_id) of een anonieme deellink-bezoeker (session_key uit
--   localStorage). Schrijven gebeurt uitsluitend via de service-role edge
--   functions; org-leden lezen ze in de app (realtime).
-- - Video's leven bij voorkeur in Cloudflare Stream (stream_uid); zonder
--   Stream-configuratie valt de upload terug op R2 (storage_key).
--   size_bytes telt in beide gevallen mee in het opslagverbruik.
--
-- Beveiliging:
-- - RLS op alle drie de tabellen via can_read_org/can_write_org, plus de
--   restrictive module-gate op 'projects' (apply_module_gate).
-- - Org-integriteit via assert_same_org_reference (project, gallery, item,
--   contactpersoon) — FK's alleen zijn niet de tenant-grens.
-- - Storage-RPC's: security definer met expliciete rol-check; mutatie-RPC
--   alleen voor service_role (edge function checkt owner/admin).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Galerijen
-- ------------------------------------------------------------
create table if not exists public.galleries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  title text not null,
  description text,
  status text not null default 'draft',
  published_at timestamptz,
  cover_item_id uuid,
  allow_downloads boolean not null default true,
  download_quality text not null default 'original',
  share_enabled boolean not null default false,
  share_token_hash text,
  share_pin_hash text,
  share_pin_failed_count integer not null default 0,
  share_pin_locked_until timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.galleries drop constraint if exists galleries_status_check;
alter table public.galleries
  add constraint galleries_status_check
  check (status in ('draft','published','archived'));

alter table public.galleries drop constraint if exists galleries_download_quality_check;
alter table public.galleries
  add constraint galleries_download_quality_check
  check (download_quality in ('original','web'));

-- ------------------------------------------------------------
-- 2. Galerij-items (foto's en video's)
-- ------------------------------------------------------------
create table if not exists public.gallery_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  gallery_id uuid not null references public.galleries(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  media_type text not null,
  file_name text not null,
  content_type text,
  size_bytes bigint not null default 0,
  derived_bytes bigint not null default 0,
  storage_key text,
  preview_key text,
  thumb_key text,
  width integer,
  height integer,
  duration_seconds numeric(10,2),
  stream_uid text,
  stream_status text,
  stream_playback_base text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.gallery_items drop constraint if exists gallery_items_media_type_check;
alter table public.gallery_items
  add constraint gallery_items_media_type_check
  check (media_type in ('photo','video'));

alter table public.gallery_items drop constraint if exists gallery_items_stream_status_check;
alter table public.gallery_items
  add constraint gallery_items_stream_status_check
  check (stream_status is null or stream_status in ('uploading','processing','ready','error'));

alter table public.gallery_items drop constraint if exists gallery_items_size_check;
alter table public.gallery_items
  add constraint gallery_items_size_check
  check (size_bytes >= 0 and derived_bytes >= 0);

-- Een item moet ergens leven: in R2 (storage_key) en/of in Stream (stream_uid).
-- Bij aanmaak vóór de upload is beide even null toegestaan; de guard-trigger
-- hieronder bewaakt alleen de basisvelden zodat een half mislukte upload geen
-- constraint-deadlock oplevert bij opruimen.

-- Cover-FK pas ná gallery_items (kruisverwijzing).
alter table public.galleries drop constraint if exists galleries_cover_item_fk;
alter table public.galleries
  add constraint galleries_cover_item_fk
  foreign key (cover_item_id) references public.gallery_items(id) on delete set null;

-- ------------------------------------------------------------
-- 3. Favorieten (klantselectie)
-- ------------------------------------------------------------
create table if not exists public.gallery_favorites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  gallery_id uuid not null references public.galleries(id) on delete cascade,
  item_id uuid not null references public.gallery_items(id) on delete cascade,
  actor_kind text not null,
  contact_id uuid references public.client_contacts(id) on delete cascade,
  session_key text,
  actor_label text,
  created_at timestamptz not null default now()
);

alter table public.gallery_favorites drop constraint if exists gallery_favorites_actor_check;
alter table public.gallery_favorites
  add constraint gallery_favorites_actor_check
  check (
    (actor_kind = 'portal_contact' and contact_id is not null)
    or (actor_kind = 'share_link' and session_key is not null)
  );

-- Eén favoriet per contactpersoon resp. per deellink-sessie per item.
create unique index if not exists idx_gallery_favorites_contact_unique
  on public.gallery_favorites (item_id, contact_id)
  where contact_id is not null;

create unique index if not exists idx_gallery_favorites_session_unique
  on public.gallery_favorites (item_id, session_key)
  where session_key is not null;

-- ------------------------------------------------------------
-- 4. Guards + org-integriteit + huisregels-triggers
-- ------------------------------------------------------------
create or replace function public.enforce_galleries_guard()
returns trigger
language plpgsql
as $$
begin
  new.title := btrim(coalesce(new.title, ''));
  if new.title = '' then
    raise exception 'Titel van de galerij is verplicht.' using errcode = '23514';
  end if;
  new.description := nullif(btrim(coalesce(new.description, '')), '');

  -- Publicatiemoment vastleggen bij de overgang naar published.
  -- (OLD niet aanraken op INSERT; kortsluiting is niet gegarandeerd.)
  if new.status = 'published' and new.published_at is null then
    if tg_op = 'INSERT' then
      new.published_at := now();
    elsif old.status is distinct from 'published' then
      new.published_at := now();
    end if;
  end if;

  -- Cover moet een item van deze galerij zijn.
  if new.cover_item_id is not null then
    if not exists (
      select 1 from public.gallery_items gi
      where gi.id = new.cover_item_id and gi.gallery_id = new.id
    ) then
      raise exception 'Coverfoto hoort niet bij deze galerij.' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists galleries_guard on public.galleries;
create trigger galleries_guard
  before insert or update of title, description, status, cover_item_id
  on public.galleries
  for each row execute function public.enforce_galleries_guard();

create or replace function public.enforce_galleries_org_integrity()
returns trigger
language plpgsql
as $$
begin
  perform public.assert_same_org_reference('public.projects', new.project_id, new.organization_id, 'galleries.project_id');
  return new;
end;
$$;

drop trigger if exists galleries_org_integrity on public.galleries;
create trigger galleries_org_integrity
  before insert or update of organization_id, project_id
  on public.galleries
  for each row execute function public.enforce_galleries_org_integrity();

create or replace function public.enforce_gallery_items_guard()
returns trigger
language plpgsql
as $$
begin
  new.file_name := btrim(coalesce(new.file_name, ''));
  if new.file_name = '' then
    raise exception 'Bestandsnaam van het galerij-item is verplicht.' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists gallery_items_guard on public.gallery_items;
create trigger gallery_items_guard
  before insert or update of file_name
  on public.gallery_items
  for each row execute function public.enforce_gallery_items_guard();

create or replace function public.enforce_gallery_items_org_integrity()
returns trigger
language plpgsql
as $$
begin
  perform public.assert_same_org_reference('public.galleries', new.gallery_id, new.organization_id, 'gallery_items.gallery_id');

  -- Een item verhuizen naar een andere galerij is niet toegestaan: de R2-key
  -- bevat het oorspronkelijke galerij-id (kijk-tokens zijn per galerij), en
  -- favorieten + cover_item_id van de oude galerij zouden achterblijven met een
  -- verwijzing naar een item dat er niet meer in zit. De app biedt verplaatsen
  -- niet aan; wie wil verplaatsen, uploadt opnieuw.
  if tg_op = 'UPDATE' and new.gallery_id is distinct from old.gallery_id then
    raise exception 'Een galerij-item kan niet naar een andere galerij worden verplaatst.' using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists gallery_items_org_integrity on public.gallery_items;
create trigger gallery_items_org_integrity
  before insert or update of organization_id, gallery_id
  on public.gallery_items
  for each row execute function public.enforce_gallery_items_org_integrity();

create or replace function public.enforce_gallery_favorites_org_integrity()
returns trigger
language plpgsql
as $$
begin
  perform public.assert_same_org_reference('public.galleries', new.gallery_id, new.organization_id, 'gallery_favorites.gallery_id');
  perform public.assert_same_org_reference('public.gallery_items', new.item_id, new.organization_id, 'gallery_favorites.item_id');
  if new.contact_id is not null then
    perform public.assert_same_org_reference('public.client_contacts', new.contact_id, new.organization_id, 'gallery_favorites.contact_id');
  end if;
  -- Het item moet ook echt bij dezelfde galerij horen (anders kan een
  -- favoriet op galerij A een item van galerij B markeren).
  if not exists (
    select 1 from public.gallery_items gi
    where gi.id = new.item_id and gi.gallery_id = new.gallery_id
  ) then
    raise exception 'Galerij-item hoort niet bij deze galerij.' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists gallery_favorites_org_integrity on public.gallery_favorites;
create trigger gallery_favorites_org_integrity
  before insert or update of organization_id, gallery_id, item_id, contact_id
  on public.gallery_favorites
  for each row execute function public.enforce_gallery_favorites_org_integrity();

-- updated_at + org-change-preventie
drop trigger if exists galleries_touch_updated_at on public.galleries;
create trigger galleries_touch_updated_at
  before update on public.galleries
  for each row execute function public.set_updated_at();

drop trigger if exists gallery_items_touch_updated_at on public.gallery_items;
create trigger gallery_items_touch_updated_at
  before update on public.gallery_items
  for each row execute function public.set_updated_at();

drop trigger if exists galleries_prevent_org_change on public.galleries;
create trigger galleries_prevent_org_change
  before update of organization_id on public.galleries
  for each row execute function public.prevent_organization_id_change();

drop trigger if exists gallery_items_prevent_org_change on public.gallery_items;
create trigger gallery_items_prevent_org_change
  before update of organization_id on public.gallery_items
  for each row execute function public.prevent_organization_id_change();

drop trigger if exists gallery_favorites_prevent_org_change on public.gallery_favorites;
create trigger gallery_favorites_prevent_org_change
  before update of organization_id on public.gallery_favorites
  for each row execute function public.prevent_organization_id_change();

-- ------------------------------------------------------------
-- 5. Indexen
-- ------------------------------------------------------------
create index if not exists idx_galleries_org on public.galleries (organization_id);
create index if not exists idx_galleries_project on public.galleries (project_id);
create unique index if not exists idx_galleries_share_token
  on public.galleries (share_token_hash)
  where share_token_hash is not null;

create index if not exists idx_gallery_items_org on public.gallery_items (organization_id);
create index if not exists idx_gallery_items_gallery on public.gallery_items (gallery_id, sort_order, created_at);

create index if not exists idx_gallery_favorites_org on public.gallery_favorites (organization_id);
create index if not exists idx_gallery_favorites_gallery on public.gallery_favorites (gallery_id);
create index if not exists idx_gallery_favorites_item on public.gallery_favorites (item_id);

-- ------------------------------------------------------------
-- 6. RLS
-- ------------------------------------------------------------
alter table public.galleries enable row level security;
alter table public.gallery_items enable row level security;
alter table public.gallery_favorites enable row level security;

drop policy if exists "galleries read" on public.galleries;
create policy "galleries read" on public.galleries for select using (
  public.can_read_org(organization_id)
);
drop policy if exists "galleries insert" on public.galleries;
create policy "galleries insert" on public.galleries for insert with check (
  public.can_write_org(organization_id)
);
drop policy if exists "galleries update" on public.galleries;
create policy "galleries update" on public.galleries for update using (
  public.can_write_org(organization_id)
) with check (
  public.can_write_org(organization_id)
);
drop policy if exists "galleries delete" on public.galleries;
create policy "galleries delete" on public.galleries for delete using (
  public.can_write_org(organization_id)
);

drop policy if exists "gallery_items read" on public.gallery_items;
create policy "gallery_items read" on public.gallery_items for select using (
  public.can_read_org(organization_id)
);
drop policy if exists "gallery_items insert" on public.gallery_items;
create policy "gallery_items insert" on public.gallery_items for insert with check (
  public.can_write_org(organization_id)
);
drop policy if exists "gallery_items update" on public.gallery_items;
create policy "gallery_items update" on public.gallery_items for update using (
  public.can_write_org(organization_id)
) with check (
  public.can_write_org(organization_id)
);
drop policy if exists "gallery_items delete" on public.gallery_items;
create policy "gallery_items delete" on public.gallery_items for delete using (
  public.can_write_org(organization_id)
);

-- Favorieten: org-leden lezen (en mogen opschonen); portaal/deellink
-- schrijft uitsluitend via de service-role edge functions (bypasst RLS).
drop policy if exists "gallery_favorites read" on public.gallery_favorites;
create policy "gallery_favorites read" on public.gallery_favorites for select using (
  public.can_read_org(organization_id)
);
drop policy if exists "gallery_favorites insert" on public.gallery_favorites;
create policy "gallery_favorites insert" on public.gallery_favorites for insert with check (
  public.can_write_org(organization_id)
);
drop policy if exists "gallery_favorites update" on public.gallery_favorites;
create policy "gallery_favorites update" on public.gallery_favorites for update using (
  public.can_write_org(organization_id)
) with check (
  public.can_write_org(organization_id)
);
drop policy if exists "gallery_favorites delete" on public.gallery_favorites;
create policy "gallery_favorites delete" on public.gallery_favorites for delete using (
  public.can_write_org(organization_id)
);

-- Module-gate: galerijen vallen onder de Projecten-module.
do $$
begin
  perform public.apply_module_gate('galleries', 'projects');
  perform public.apply_module_gate('gallery_items', 'projects');
  perform public.apply_module_gate('gallery_favorites', 'projects');
end $$;

-- ------------------------------------------------------------
-- 7. Realtime: live favorieten-updates in de app.
--    replica identity full zodat DELETE-events (favoriet weghalen) het
--    organization_id-filter en RLS overleven (zie team_chat-migratie).
-- ------------------------------------------------------------
alter table public.gallery_favorites replica identity full;
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'gallery_favorites'
  ) then
    alter publication supabase_realtime add table public.gallery_favorites;
  end if;
end $$;

-- ------------------------------------------------------------
-- 8. Opslagbundels op de plancatalogus + het billingprofiel
-- ------------------------------------------------------------
alter table public.billing_plans
  add column if not exists storage_addon_price_cents integer not null default 0 check (storage_addon_price_cents >= 0),
  add column if not exists storage_addon_yearly_price_cents integer not null default 0 check (storage_addon_yearly_price_cents >= 0);

-- Basislimiet per plan (GB) + bundelgrootte (GB per add-on) in limits.
-- Alleen zetten als de sleutel nog ontbreekt zodat handmatige aanpassingen
-- in de database niet worden overschreven bij een re-run.
update public.billing_plans
  set limits = limits || jsonb_build_object('storage_gb', 50, 'storage_addon_gb', 100)
  where plan_key = 'starter' and not (limits ? 'storage_gb');
update public.billing_plans
  set limits = limits || jsonb_build_object('storage_gb', 250, 'storage_addon_gb', 100)
  where plan_key = 'team' and not (limits ? 'storage_gb');
update public.billing_plans
  set limits = limits || jsonb_build_object('storage_gb', 1000, 'storage_addon_gb', 100)
  where plan_key = 'pro' and not (limits ? 'storage_gb');
-- 'custom' bewust zonder storage_gb: geen limiet (handmatige afspraken).

-- Standaard bundelprijs: €5,00 per 100 GB per maand / €50,00 per jaar.
-- Alleen invullen waar nog 0 staat (prijswijzigingen in de DB blijven staan).
update public.billing_plans
  set storage_addon_price_cents = 500
  where plan_key in ('starter','team','pro') and storage_addon_price_cents = 0;
update public.billing_plans
  set storage_addon_yearly_price_cents = 5000
  where plan_key in ('starter','team','pro') and storage_addon_yearly_price_cents = 0;

-- Eigen kolom op het profiel: NIET aan de seat-wiskunde hangen
-- (constraint organization_billing_profiles_seat_math blijft ongemoeid).
alter table public.organization_billing_profiles
  add column if not exists storage_addons integer not null default 0;
alter table public.organization_billing_profiles drop constraint if exists organization_billing_profiles_storage_addons_check;
alter table public.organization_billing_profiles
  add constraint organization_billing_profiles_storage_addons_check
  check (storage_addons >= 0 and storage_addons <= 100);

-- Nieuw mutatietype voor de licentie-historie.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.organization_license_changes'::regclass
      and conname = 'organization_license_changes_change_type_check'
  ) then
    alter table public.organization_license_changes drop constraint organization_license_changes_change_type_check;
  end if;
  alter table public.organization_license_changes
    add constraint organization_license_changes_change_type_check
    check (change_type in ('initial','plan_change','seat_purchase','seat_downgrade_request','manual_correction','billing_sync','subscription_cancelled','storage_purchase'));
end $$;

-- Nieuwe audit-actie voor de opslagbundel (volledige actuele lijst herbouwen).
do $$
begin
  if exists (
    select 1 from pg_constraint where conrelid = 'public.audit_logs'::regclass and conname = 'audit_logs_action_check'
  ) then
    alter table public.audit_logs drop constraint audit_logs_action_check;
  end if;
  alter table public.audit_logs
    add constraint audit_logs_action_check
    check (action in (
      'created','updated','deleted','invited','accepted','revoked','role_changed','disabled','expired',
      'mollie_connected','plan_changed','seat_purchased','seat_downgrade_requested',
      'payment_succeeded','payment_failed','payment_expired','subscription_cancelled',
      'licensed_seats_changed','invitation_blocked_insufficient_seats','billing_synced',
      'quote_submitted_for_approval','quote_internal_approved','quote_internal_rejected',
      'quote_sent_to_client','quote_client_accepted','quote_client_rejected',
      'quote_email_delivered','quote_email_failed','quote_version_created','quote_pdf_attached',
      'invoice_created_from_quote','invoice_sent_to_client','invoice_payment_link_created','invoice_paid',
      'invoice_refunded','credit_note_issued',
      'invoice_charged_back','chargeback_reversed','credit_note_emailed',
      'invoice_reminder_sent',
      'dunning_notice_sent',
      'storage_purchased'
    ));
end $$;

-- ------------------------------------------------------------
-- 8b. RPC: pincode van een deellink verifiëren (atomair)
--     De edge function berekent de hash (die kent het token als zout) en laat
--     de vergelijking + tellerbijwerking hier in één vergrendelde transactie
--     doen. Zonder deze serialisatie zouden parallelle pogingen allemaal
--     dezelfde teller lezen en terugschrijven, waardoor de lockout nooit in
--     werking treedt en een 4-cijferige pincode in minuten te raden is.
-- ------------------------------------------------------------
create or replace function public.gallery_verify_share_pin(
  p_gallery_id uuid,
  p_pin_hash text
)
returns table (
  ok boolean,
  locked boolean,
  locked_until timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.galleries;
  v_failed integer;
  v_locked_until timestamptz;
begin
  -- FOR UPDATE serialiseert gelijktijdige pogingen op dezelfde galerij.
  select * into v_row from public.galleries where id = p_gallery_id for update;
  if not found then
    raise exception 'Galerij niet gevonden.' using errcode = 'P0002';
  end if;

  if v_row.share_pin_locked_until is not null and v_row.share_pin_locked_until > now() then
    return query select false, true, v_row.share_pin_locked_until;
    return;
  end if;

  if v_row.share_pin_hash is not null and p_pin_hash is not null and v_row.share_pin_hash = p_pin_hash then
    update public.galleries
    set share_pin_failed_count = 0,
        share_pin_locked_until = null
    where id = p_gallery_id;
    return query select true, false, null::timestamptz;
    return;
  end if;

  -- Mislukte poging: teller ophogen en bij 8 pogingen een kwartier op slot.
  -- De teller wordt bewust NIET gereset bij de lockout: na afloop is één
  -- foute poging genoeg om opnieuw op slot te gaan.
  update public.galleries
  set share_pin_failed_count = share_pin_failed_count + 1,
      share_pin_locked_until = case
        when share_pin_failed_count + 1 >= 8 then now() + interval '15 minutes'
        else share_pin_locked_until
      end
  where id = p_gallery_id
  returning share_pin_failed_count, share_pin_locked_until into v_failed, v_locked_until;

  return query select false, (v_locked_until is not null and v_locked_until > now()), v_locked_until;
end;
$$;

revoke all on function public.gallery_verify_share_pin(uuid, text) from public, anon, authenticated;
grant execute on function public.gallery_verify_share_pin(uuid, text) to service_role;

-- ------------------------------------------------------------
-- 9. RPC: opslagbundel toepassen op een lopend mandaat
--    (kloon van apply_organization_seat_change; de edge function PATcht
--    het Mollie-abonnementsbedrag en legt de mutatie hier vast.)
-- ------------------------------------------------------------
create or replace function public.apply_organization_storage_change(
  p_organization_id uuid,
  p_storage_addons integer,
  p_metadata jsonb default '{}'::jsonb
)
returns public.organization_billing_profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.organization_billing_profiles;
begin
  if p_storage_addons is null or p_storage_addons < 0 then
    raise exception 'Aantal opslagbundels kan niet negatief zijn.' using errcode = '23514';
  end if;
  -- Bovengrens hier expliciet (zelfde waarde als de CHECK-constraint), met een
  -- leesbare melding. De edge function controleert dit óók vóór de Mollie-PATCH,
  -- zodat het abonnementsbedrag en de administratie niet uiteen kunnen lopen.
  if p_storage_addons > 100 then
    raise exception 'Maximaal 100 opslagbundels per organisatie. Neem contact op voor een maatwerkafspraak.' using errcode = '23514';
  end if;

  v_profile := public.ensure_organization_billing_profile(p_organization_id);

  update public.organization_billing_profiles
  set storage_addons = p_storage_addons,
      metadata = metadata || coalesce(p_metadata, '{}'::jsonb),
      updated_at = now()
  where organization_id = p_organization_id
  returning * into v_profile;

  insert into public.organization_license_changes(
    organization_id, billing_profile_id, change_type, status,
    old_plan_key, new_plan_key, old_licensed_seats, new_licensed_seats, delta_seats,
    reason, applied_at, metadata
  ) values (
    p_organization_id, v_profile.id, 'storage_purchase', 'applied',
    v_profile.plan_key, v_profile.plan_key, v_profile.licensed_seats, v_profile.licensed_seats, 0,
    'Opslagbundel-wijziging op lopend Mollie-abonnement.', now(), coalesce(p_metadata, '{}'::jsonb)
  );

  perform public.log_billing_audit(
    p_organization_id, 'storage_purchased', 'billing_profile', v_profile.id, v_profile.plan_key,
    jsonb_build_object('source', 'apply_organization_storage_change', 'storage_addons', p_storage_addons) || coalesce(p_metadata, '{}'::jsonb),
    null
  );

  return v_profile;
end;
$$;

revoke all on function public.apply_organization_storage_change(uuid, integer, jsonb) from public;
grant execute on function public.apply_organization_storage_change(uuid, integer, jsonb) to service_role;

-- ------------------------------------------------------------
-- 10. RPC: accountbreed opslagverbruik + limiet
--     Gebruikt door de media-api worker (service-role, vóór elke upload)
--     en door de frontend-opslagmeter (authenticated, can_read_org).
--     limit_bytes = null betekent: geen limiet (billing_exempt, custom
--     plan zonder storage_gb, of geen billingprofiel).
-- ------------------------------------------------------------
create or replace function public.organization_storage_status(p_organization_id uuid)
returns table (
  used_bytes bigint,
  attachments_bytes bigint,
  documents_bytes bigint,
  recordings_bytes bigint,
  gallery_bytes bigint,
  contracts_bytes bigint,
  limit_bytes bigint,
  plan_storage_gb integer,
  storage_addons integer,
  storage_addon_gb integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_attachments bigint := 0;
  v_documents bigint := 0;
  v_recordings bigint := 0;
  v_gallery bigint := 0;
  v_contracts bigint := 0;
  v_contract_expr text;
  v_profile public.organization_billing_profiles;
  v_plan public.billing_plans;
  v_plan_gb integer;
  v_addon_gb integer;
  v_addons integer := 0;
  v_limit bigint;
begin
  if auth.role() <> 'service_role' and not public.can_read_org(p_organization_id) then
    raise exception 'Geen toegang tot het opslagverbruik van deze organisatie.' using errcode = '42501';
  end if;

  select coalesce(sum(a.size_bytes), 0) into v_attachments
  from public.attachments a where a.organization_id = p_organization_id;

  select coalesce(sum(coalesce(d.size_bytes, 0)), 0) into v_documents
  from public.documents d where d.organization_id = p_organization_id;

  select coalesce(sum(coalesce(mr.size_bytes, 0)), 0) into v_recordings
  from public.meeting_recordings mr where mr.organization_id = p_organization_id;

  select coalesce(sum(gi.size_bytes + gi.derived_bytes), 0) into v_gallery
  from public.gallery_items gi where gi.organization_id = p_organization_id;

  -- Contracten staan óók in R2 (office-.docx + getekende PDF) maar hebben geen
  -- attachments-rij. De kolommen komen uit andere migraties en kunnen per
  -- omgeving nog ontbreken, dus dynamisch samenstellen i.p.v. hard verwijzen —
  -- anders faalt deze functie pas bij aanroep op een onbekende kolom.
  select nullif(concat_ws(' + ',
    case when exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'contracts' and column_name = 'body_size_bytes')
      then 'coalesce(c.body_size_bytes, 0)' end,
    case when exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'contracts' and column_name = 'signed_pdf_size_bytes')
      then 'coalesce(c.signed_pdf_size_bytes, 0)' end
  ), '') into v_contract_expr;

  if v_contract_expr is not null then
    execute format('select coalesce(sum(%s), 0)::bigint from public.contracts c where c.organization_id = $1', v_contract_expr)
      into v_contracts using p_organization_id;
  end if;

  select * into v_profile
  from public.organization_billing_profiles p
  where p.organization_id = p_organization_id;

  if found and not v_profile.billing_exempt then
    select * into v_plan from public.billing_plans bp where bp.plan_key = v_profile.plan_key;
    if found and (v_plan.limits ? 'storage_gb') then
      v_plan_gb := nullif(v_plan.limits->>'storage_gb', '')::integer;
      v_addon_gb := coalesce(nullif(v_plan.limits->>'storage_addon_gb', '')::integer, 100);
      v_addons := coalesce(v_profile.storage_addons, 0);
      if v_plan_gb is not null then
        v_limit := (v_plan_gb::bigint + v_addons::bigint * v_addon_gb::bigint) * 1073741824;
      end if;
    end if;
  end if;

  return query select
    (v_attachments + v_documents + v_recordings + v_gallery + v_contracts),
    v_attachments,
    v_documents,
    v_recordings,
    v_gallery,
    v_contracts,
    v_limit,
    v_plan_gb,
    v_addons,
    v_addon_gb;
end;
$$;

revoke all on function public.organization_storage_status(uuid) from public;
grant execute on function public.organization_storage_status(uuid) to authenticated;
grant execute on function public.organization_storage_status(uuid) to service_role;

-- ------------------------------------------------------------
-- 11. organization_billing_overview uitbreiden met opslagvelden
--     (drop + recreate: de return-tabel wijzigt.)
-- ------------------------------------------------------------
drop function if exists public.organization_billing_overview(uuid);
create function public.organization_billing_overview(p_organization_id uuid)
returns table (
  organization_id uuid,
  plan_key text,
  plan_name text,
  included_seats integer,
  purchased_seats integer,
  licensed_seats integer,
  active_members integer,
  pending_invitations integer,
  used_seats integer,
  available_seats integer,
  subscription_status text,
  payment_status text,
  mollie_connect_status text,
  mollie_customer_id text,
  mollie_mandate_id text,
  mollie_subscription_id text,
  last_payment_status text,
  next_invoice_date date,
  trial_ends_at timestamptz,
  current_period_ends_at timestamptz,
  monthly_price_cents integer,
  extra_seat_price_cents integer,
  currency text,
  billing_exempt boolean,
  billing_interval text,
  yearly_price_cents integer,
  extra_seat_yearly_price_cents integer,
  storage_addons integer,
  plan_storage_gb integer,
  storage_addon_gb integer,
  storage_addon_price_cents integer,
  storage_addon_yearly_price_cents integer,
  storage_limit_gb integer,
  storage_used_bytes bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.organization_billing_profiles;
begin
  if not public.can_admin_org(p_organization_id) then
    raise exception 'Alleen owners/admins mogen billing bekijken.' using errcode = '42501';
  end if;

  perform public.expire_stale_organization_invitations(p_organization_id);
  v_profile := public.ensure_organization_billing_profile(p_organization_id);

  return query
  select
    p.organization_id,
    p.plan_key,
    bp.name,
    p.included_seats,
    p.purchased_seats,
    p.licensed_seats,
    coalesce(active_counts.active_members, 0)::integer,
    coalesce(pending_counts.pending_invitations, 0)::integer,
    (coalesce(active_counts.active_members, 0) + coalesce(pending_counts.pending_invitations, 0))::integer,
    greatest(p.licensed_seats - (coalesce(active_counts.active_members, 0) + coalesce(pending_counts.pending_invitations, 0)), 0)::integer,
    p.subscription_status,
    p.payment_status,
    p.mollie_connect_status,
    p.mollie_customer_id,
    p.mollie_mandate_id,
    p.mollie_subscription_id,
    p.last_payment_status,
    p.next_invoice_date,
    p.trial_ends_at,
    p.current_period_ends_at,
    bp.monthly_price_cents,
    bp.extra_seat_price_cents,
    bp.currency,
    p.billing_exempt,
    p.billing_interval,
    bp.yearly_price_cents,
    bp.extra_seat_yearly_price_cents,
    coalesce(p.storage_addons, 0),
    nullif(bp.limits->>'storage_gb', '')::integer,
    coalesce(nullif(bp.limits->>'storage_addon_gb', '')::integer, 100),
    bp.storage_addon_price_cents,
    bp.storage_addon_yearly_price_cents,
    case
      when p.billing_exempt then null
      when nullif(bp.limits->>'storage_gb', '') is null then null
      else (nullif(bp.limits->>'storage_gb', '')::integer
            + coalesce(p.storage_addons, 0) * coalesce(nullif(bp.limits->>'storage_addon_gb', '')::integer, 100))
    end,
    coalesce(storage_counts.used_bytes, 0)::bigint
  from public.organization_billing_profiles p
  join public.billing_plans bp on bp.plan_key = p.plan_key
  left join lateral (
    select count(*)::integer as active_members
    from public.organization_members om
    where om.organization_id = p.organization_id and om.status = 'active'
  ) active_counts on true
  left join lateral (
    select count(*)::integer as pending_invitations
    from public.organization_invitations oi
    where oi.organization_id = p.organization_id
      and oi.status = 'pending'
      and oi.consumes_license = true
      and (oi.expires_at is null or oi.expires_at > now())
  ) pending_counts on true
  -- Verbruik uit dezelfde bron als de worker-handhaving en de opslagmeter:
  -- één definitie voorkomt dat de telling hier en daar uiteen gaat lopen.
  left join lateral (
    select s.used_bytes from public.organization_storage_status(p.organization_id) s
  ) storage_counts on true
  where p.organization_id = p_organization_id;
end;
$$;

revoke all on function public.organization_billing_overview(uuid) from public;
grant execute on function public.organization_billing_overview(uuid) to authenticated;

commit;
