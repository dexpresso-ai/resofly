-- ============================================================
-- ResoFly — Creatieve module als betaalde abonnementsoptie
-- Date: 2026-08-06
--
-- Aanleiding:
-- - De galerij-oplevering (foto/video) is niet voor iedere klant relevant en
--   kost ons wél opslag en Stream-minuten. Vanaf nu is het een aan te vinken
--   optie bij de aanschaf van een abonnement: de "creatieve module".
--
-- Scope van de module (bewust breder dan alleen de galerij, zodat de
-- toekomstige licentie-/gebruiksrechten-functionaliteit en model-releases er
-- straks onder kunnen vallen zonder een tweede vlag):
--   entitlement-sleutel = 'creative'
--   vandaag afgedekt: galleries, gallery_items, gallery_favorites,
--                     gallery_categories, gallery_category_presets
--
-- Ontwerp:
-- 1. Prijs staat per plan én per interval op billing_plans
--    (creative_addon_price_cents / _yearly_), precies zoals de opslagbundel.
--    Plannen kunnen de module ook inbegrepen hebben via limits.creative_included
--    (gebruikt voor 'custom'-contracten).
-- 2. De organisatie zet 'm aan/uit op het billingprofiel (creative_enabled).
--    De edge function past het Mollie-abonnementsbedrag aan en roept daarna de
--    service-role RPC apply_organization_creative_change aan.
-- 3. UIT ZETTEN = BEVRIEZEN MET RESPIJT. creative_grace_until krijgt
--    now() + 30 dagen. In die periode:
--      - org-leden kunnen niets meer toevoegen of wijzigen (write-gate),
--      - lezen en opruimen blijft gewoon werken (je moet bij je eigen werk
--        kunnen en het moeten kunnen verwijderen),
--      - reeds gedeelde links en het klantportaal blijven leven tot de
--        respijtperiode voorbij is (afgedwongen in gallery-public en
--        client-portal; die draaien service-role en zien deze kolommen).
-- 4. Bestaande klanten met een galerij worden gegrandfatherd: die krijgen de
--    module aan zonder dat er iets breekt of stilzwijgend in rekening gaat.
--    (creative_enabled zetten kost niets zolang het Mollie-bedrag niet wordt
--    gepatcht; dat gebeurt hier bewust niet.)
--
-- Beveiliging:
-- - Restrictive RLS-policies (insert/update) + een schrijf-trigger op elke
--   galerijtabel, in dezelfde vorm als de module-gate uit 20260730100000.
--   De trigger dicht het security definer-gat; de policy dekt het gewone pad.
-- - De mutatie-RPC is service_role-only; de edge function controleert
--   owner/admin vóórdat hij hem aanroept.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Plancatalogus: prijs van de creatieve module per interval
-- ------------------------------------------------------------
alter table public.billing_plans
  add column if not exists creative_addon_price_cents integer not null default 0 check (creative_addon_price_cents >= 0),
  add column if not exists creative_addon_yearly_price_cents integer not null default 0 check (creative_addon_yearly_price_cents >= 0);

-- Standaardprijs: €9,00 per maand / €90,00 per jaar (twee maanden gratis bij
-- jaarbetaling, gelijk aan de rest van de catalogus). Alleen invullen waar nog
-- 0 staat, zodat een prijswijziging in de database blijft staan bij een re-run.
update public.billing_plans
  set creative_addon_price_cents = 900
  where plan_key in ('starter','team','pro') and creative_addon_price_cents = 0;
update public.billing_plans
  set creative_addon_yearly_price_cents = 9000
  where plan_key in ('starter','team','pro') and creative_addon_yearly_price_cents = 0;

-- Custom-contracten worden handmatig afgestemd; daar hoort de module bij het
-- plan (net zoals custom geen opslaglimiet kent).
update public.billing_plans
  set limits = limits || jsonb_build_object('creative_included', true)
  where plan_key = 'custom' and not (limits ? 'creative_included');

-- ------------------------------------------------------------
-- 2. Het billingprofiel: aan/uit + respijt
-- ------------------------------------------------------------
alter table public.organization_billing_profiles
  add column if not exists creative_enabled boolean not null default false,
  add column if not exists creative_grace_until timestamptz;

comment on column public.organization_billing_profiles.creative_enabled is
  'Creatieve module (galerij-oplevering) als betaalde optie op het abonnement.';
comment on column public.organization_billing_profiles.creative_grace_until is
  'Tot wanneer reeds gedeelde galerijen na het uitzetten nog bereikbaar blijven.';

-- Elke organisatie moet een billingprofiel hebben, anders valt de entitlement
-- terug op "niet gekocht" voor een organisatie die nooit een billing-scherm
-- heeft geopend. ensure_organization_billing_profile is idempotent.
do $$
declare
  v_org uuid;
begin
  for v_org in select id from public.organizations loop
    perform public.ensure_organization_billing_profile(v_org);
  end loop;
end $$;

-- Grandfathering: wie vandaag al een galerij heeft, houdt de module.
update public.organization_billing_profiles p
  set creative_enabled = true,
      creative_grace_until = null,
      metadata = coalesce(p.metadata, '{}'::jsonb) || jsonb_build_object('creative_grandfathered', true),
      updated_at = now()
  where p.creative_enabled = false
    and exists (select 1 from public.galleries g where g.organization_id = p.organization_id);

-- ------------------------------------------------------------
-- 3. Entitlement-functies
-- ------------------------------------------------------------

-- Mag er in deze organisatie met de creatieve module gewerkt worden?
-- Vrijgestelde (interne) organisaties altijd; verder het plan of de add-on.
-- jsonb-vergelijking i.p.v. ::boolean-cast: een rare waarde in limits mag geen
-- exception geven midden in een RLS-check.
create or replace function public.org_has_creative(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select p.billing_exempt
        or bp.limits -> 'creative_included' = 'true'::jsonb
        or p.creative_enabled
    from public.organization_billing_profiles p
    join public.billing_plans bp on bp.plan_key = p.plan_key
    where p.organization_id = p_organization_id
  ), false);
$$;

-- Loopt de respijtperiode nog? (module uit, maar gedeelde links leven nog)
create or replace function public.org_creative_in_grace(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select not public.org_has_creative(p_organization_id)
       and p.creative_grace_until is not null
       and p.creative_grace_until > now()
    from public.organization_billing_profiles p
    where p.organization_id = p_organization_id
  ), false);
$$;

revoke all on function public.org_has_creative(uuid) from public;
grant execute on function public.org_has_creative(uuid) to authenticated, service_role;
revoke all on function public.org_creative_in_grace(uuid) from public;
grant execute on function public.org_creative_in_grace(uuid) to authenticated, service_role;

-- Statusfunctie voor de app: leesbaar voor ELK org-lid (niet alleen
-- owners/admins zoals organization_billing_overview), want ieder teamlid moet
-- weten of het galerij-tabblad er hoort te zijn. En voor de service-role, want
-- de worker en de portaal-functies bepalen er hun antwoord mee.
create or replace function public.organization_creative_status(p_organization_id uuid)
returns table (
  active boolean,
  enabled boolean,
  included_in_plan boolean,
  in_grace boolean,
  grace_until timestamptz,
  addon_price_cents integer,
  addon_yearly_price_cents integer,
  billing_interval text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_profile public.organization_billing_profiles;
  v_plan public.billing_plans;
begin
  if auth.role() <> 'service_role' and not public.can_read_org(p_organization_id) then
    raise exception 'Geen toegang tot deze organisatie.' using errcode = '42501';
  end if;

  select * into v_profile
  from public.organization_billing_profiles p
  where p.organization_id = p_organization_id;

  if not found then
    return query select false, false, false, false, null::timestamptz, 0, 0, 'month'::text;
    return;
  end if;

  select * into v_plan from public.billing_plans bp where bp.plan_key = v_profile.plan_key;

  return query select
    public.org_has_creative(p_organization_id),
    v_profile.creative_enabled,
    coalesce(v_plan.limits -> 'creative_included' = 'true'::jsonb, false) or v_profile.billing_exempt,
    public.org_creative_in_grace(p_organization_id),
    v_profile.creative_grace_until,
    coalesce(v_plan.creative_addon_price_cents, 0),
    coalesce(v_plan.creative_addon_yearly_price_cents, 0),
    coalesce(v_profile.billing_interval, 'month');
end;
$$;

revoke all on function public.organization_creative_status(uuid) from public;
grant execute on function public.organization_creative_status(uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 4. Schrijf-gate op de galerijtabellen
--    Zelfde vorm als apply_module_gate: restrictive policies voor het gewone
--    pad + een trigger die ook security definer-functies raakt.
--    SELECT en DELETE blijven vrij: bevriezen betekent "niets meer toevoegen
--    of wijzigen", niet "je komt niet meer bij je eigen werk".
-- ------------------------------------------------------------
create or replace function public.enforce_creative_module_access()
returns trigger
language plpgsql
as $$
begin
  -- service_role, pg_cron en de workers draaien zonder JWT en hebben hun eigen
  -- autorisatie (media-api, gallery-public, client-portal controleren de
  -- entitlement expliciet). Hier niet blokkeren.
  if auth.uid() is null then
    return new;
  end if;

  if not public.org_has_creative(new.organization_id) then
    raise exception 'De creatieve module staat niet aan voor deze organisatie. Zet hem aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create or replace function public.apply_creative_gate(p_table text)
returns void
language plpgsql
as $$
begin
  execute format('drop policy if exists %I on public.%I', 'creative gate insert', p_table);
  execute format('drop policy if exists %I on public.%I', 'creative gate update', p_table);

  execute format(
    'create policy %I on public.%I as restrictive for insert to authenticated with check (public.org_has_creative(organization_id))',
    'creative gate insert', p_table);
  execute format(
    'create policy %I on public.%I as restrictive for update to authenticated using (public.org_has_creative(organization_id)) with check (public.org_has_creative(organization_id))',
    'creative gate update', p_table);

  -- De trigger dekt bewust ALLEEN INSERT. Twee redenen:
  --  1. Een UPDATE-trigger zou het opruimen breken: een galerij-item weggooien
  --     laat de FK galleries.cover_item_id op null zetten, en die interne
  --     UPDATE draait nog onder de JWT van de gebruiker. Met de module uit zou
  --     verwijderen dan afketsen — precies wat bevriezen niet mag doen.
  --     Referentiële acties passeren RLS wél altijd, dus de policy hieronder
  --     heeft dat probleem niet.
  --  2. De trigger bestaat om het security definer-gat te dichten (functies met
  --     verhoogde rechten omzeilen RLS). Alle security definer-functies die een
  --     galerij bijwerken zijn service_role-only en komen hier dus niet langs.
  -- zzzz_ zodat de gate ná de andere BEFORE-triggers draait; organization_id is
  -- dan zeker gevuld.
  execute format('drop trigger if exists zzzz_creative_write_gate on public.%I', p_table);
  execute format(
    'create trigger zzzz_creative_write_gate before insert on public.%I for each row execute function public.enforce_creative_module_access()',
    p_table);
end;
$$;

revoke all on function public.apply_creative_gate(text) from public, anon, authenticated;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'galleries', 'gallery_items', 'gallery_favorites',
    'gallery_categories', 'gallery_category_presets'
  ] loop
    if exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = v_table
    ) then
      perform public.apply_creative_gate(v_table);
    end if;
  end loop;
end $$;

-- ------------------------------------------------------------
-- 5. Mutatietypes voor de administratie
-- ------------------------------------------------------------
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
    check (change_type in ('initial','plan_change','seat_purchase','seat_downgrade_request','manual_correction','billing_sync','subscription_cancelled','storage_purchase','creative_change'));
end $$;

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
      'storage_purchased',
      'creative_module_enabled','creative_module_disabled'
    ));
end $$;

-- ------------------------------------------------------------
-- 6. RPC: de creatieve module aan- of uitzetten
--    (kloon van apply_organization_storage_change; de edge function PATcht het
--    Mollie-abonnementsbedrag en legt de mutatie hier vast.)
-- ------------------------------------------------------------
create or replace function public.apply_organization_creative_change(
  p_organization_id uuid,
  p_enabled boolean,
  p_grace_days integer default 30,
  p_metadata jsonb default '{}'::jsonb
)
returns public.organization_billing_profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.organization_billing_profiles;
  v_enabled boolean := coalesce(p_enabled, false);
  v_grace_days integer := greatest(coalesce(p_grace_days, 30), 0);
begin
  v_profile := public.ensure_organization_billing_profile(p_organization_id);

  update public.organization_billing_profiles
  set creative_enabled = v_enabled,
      -- Aanzetten wist de respijt; uitzetten start hem. Een tweede keer
      -- uitzetten verlengt de respijt bewust NIET (anders is hij oneindig te
      -- rekken door te blijven schakelen).
      creative_grace_until = case
        when v_enabled then null
        when creative_grace_until is not null and creative_grace_until > now() then creative_grace_until
        else now() + make_interval(days => v_grace_days)
      end,
      metadata = metadata || coalesce(p_metadata, '{}'::jsonb),
      updated_at = now()
  where organization_id = p_organization_id
  returning * into v_profile;

  insert into public.organization_license_changes(
    organization_id, billing_profile_id, change_type, status,
    old_plan_key, new_plan_key, old_licensed_seats, new_licensed_seats, delta_seats,
    reason, applied_at, metadata
  ) values (
    p_organization_id, v_profile.id, 'creative_change', 'applied',
    v_profile.plan_key, v_profile.plan_key, v_profile.licensed_seats, v_profile.licensed_seats, 0,
    case when v_enabled then 'Creatieve module aangezet.' else 'Creatieve module uitgezet.' end,
    now(), coalesce(p_metadata, '{}'::jsonb)
  );

  perform public.log_billing_audit(
    p_organization_id,
    case when v_enabled then 'creative_module_enabled' else 'creative_module_disabled' end,
    'billing_profile', v_profile.id, v_profile.plan_key,
    jsonb_build_object(
      'source', 'apply_organization_creative_change',
      'creative_enabled', v_enabled,
      'grace_until', v_profile.creative_grace_until
    ) || coalesce(p_metadata, '{}'::jsonb),
    null
  );

  return v_profile;
end;
$$;

revoke all on function public.apply_organization_creative_change(uuid, boolean, integer, jsonb) from public;
grant execute on function public.apply_organization_creative_change(uuid, boolean, integer, jsonb) to service_role;

-- ------------------------------------------------------------
-- 7. organization_billing_overview uitbreiden met de creatieve module
--    (drop + recreate: de return-tabel wijzigt.)
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
  storage_used_bytes bigint,
  creative_enabled boolean,
  creative_included_in_plan boolean,
  creative_active boolean,
  creative_grace_until timestamptz,
  creative_addon_price_cents integer,
  creative_addon_yearly_price_cents integer
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
    coalesce(storage_counts.used_bytes, 0)::bigint,
    p.creative_enabled,
    (coalesce(bp.limits -> 'creative_included' = 'true'::jsonb, false) or p.billing_exempt),
    public.org_has_creative(p.organization_id),
    p.creative_grace_until,
    coalesce(bp.creative_addon_price_cents, 0),
    coalesce(bp.creative_addon_yearly_price_cents, 0)
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
  left join lateral (
    select s.used_bytes from public.organization_storage_status(p.organization_id) s
  ) storage_counts on true
  where p.organization_id = p_organization_id;
end;
$$;

revoke all on function public.organization_billing_overview(uuid) from public;
grant execute on function public.organization_billing_overview(uuid) to authenticated;

commit;
