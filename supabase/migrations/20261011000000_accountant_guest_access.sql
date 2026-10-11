-- ============================================================
-- ResoFly — Boekhouder-toegang: een gastaccount dat alleen de financiën inziet
-- Date: 2026-10-11
--
-- Een owner of admin kan per administratie één boekhouder uitnodigen. Die
-- krijgt de nieuwe rol 'accountant' ("Boekhouder") en daarmee, vast:
--
--   Financiën      → alleen lezen: offertes, contracten, facturen, inkoop,
--                    grootboek, bank, activa, W&V, btw, Vpb, DGA,
--                    aandeelhouders, boekjaren en jaarrekening;
--   al het andere  → dicht: klanten, projecten, uren, agenda, tickets,
--                    inhoud, statistieken, marketing, teamchat en Gerrie.
--
-- De boekhouder verbruikt GEEN gebruikerslicentie: het is een gast.
--
-- Waarom een eigen rol en niet 'viewer' met modulerechten? Omdat het niet mag
-- kunnen verschuiven. Bij een viewer is één verkeerde keuze in het
-- rechtenraster genoeg om Klanten open te zetten; bij de boekhouder bepaalt de
-- rol het en wordt module_access genegeerd. En alleen een eigen rol houdt de
-- boekhouder buiten de licentietelling zonder dat elk teamlid zo gratis te maken is.
--
-- Handhaving in lagen; de UI is ook hier niet de beveiliging:
--
--   1. member_module_level(): één regel voor het niveau per module. Gebruikt
--      door org_module_level (en daarmee alle module gates, schrijf-triggers en
--      my_module_access), de ontvangers van pushmeldingen en de CalDAV-lookup.
--      Een rol die de regel niet kent, krijgt voortaan 'none' in plaats van
--      'write': liever een lege pagina dan een open deur.
--   2. Schrijven kan de boekhouder nergens. Elke schrijfpolicy vraagt
--      can_write_org (owner/admin/member) of can_write_module, en Financiën
--      staat voor de boekhouder op 'read'. Eén lek gedicht dat een lezer wél liet schrijven:
--      next_purchase_invoice_number.
--   3. Een hek op elke organisatietabel die NIET onder een module valt — de
--      teamlijst, e-mailsjablonen, verzenddomeinen, portaalinstellingen,
--      pushabonnementen, Gerrie-instellingen en wat er verder voor elk lid
--      leesbaar is. Voor de boekhouder staat alles daar dicht, behalve:
--        - organization_members: de eigen rij;
--        - company_settings: lezen (bedrijfsgegevens, btw-periode, KOR — die
--          horen bij de boekhouding en staan op elke factuur);
--        - audit_logs: alleen regels over financiën;
--        - attachments: alleen bijlagen van financiële records.
--      accountant_fence_gaps() somt op welke organisatietabel geen module gate
--      én geen hek heeft; de rooktest na elke deploy faalt dan.
--   4. Een rolwissel naar of van 'accountant' kan niet. Een boekhouder komt
--      alleen binnen via een eigen uitnodiging; anders werd een betaald teamlid
--      met één klik een gratis gast, of een gast een teamlid zonder licentie.
--
-- Van klanten ziet de boekhouder alleen wat er op de financiële stukken staat (naam,
-- adres, btw-nummer, …), via finance_client_directory(). De klantenkaart zelf —
-- notities, tags, mail, tickets — blijft dicht.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. De rol ────────────────────────────────────────────────────────────────

alter table public.organization_members drop constraint if exists organization_members_role_check;
alter table public.organization_members add constraint organization_members_role_check
  check (role in ('owner', 'admin', 'member', 'viewer', 'accountant'));

alter table public.organization_invitations drop constraint if exists organization_invitations_role_check;
alter table public.organization_invitations add constraint organization_invitations_role_check
  check (role in ('admin', 'member', 'viewer', 'accountant'));

-- Eén boekhouder per administratie: één actief, en één openstaande uitnodiging.
create unique index if not exists organization_members_one_accountant
  on public.organization_members (organization_id)
  where role = 'accountant' and status = 'active';

create unique index if not exists organization_invitations_one_accountant
  on public.organization_invitations (organization_id)
  where role = 'accountant' and status = 'pending';

-- ── 2. Eén regel voor het niveau per module ─────────────────────────────────
--
-- Puur, zonder tabel: zo is het dezelfde regel voor de ingelogde gebruiker
-- (org_module_level) en voor een lijst leden (pushmeldingen, CalDAV). Exacte
-- spiegel in de code: memberModuleLevel in supabase/functions/_shared/roles.ts
-- en resolveModuleLevel in src/lib/permissions.ts.

create or replace function public.member_module_level(p_role text, p_module_access jsonb, p_module text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    -- Owners/admins stellen de rechten in en zijn daarom zelf nooit beperkt.
    when p_role in ('owner', 'admin') then 'write'
    -- De boekhouder: Financiën alleen lezen, de rest dicht. Vast; module_access telt niet.
    when p_role = 'accountant' then case when p_module = 'finance' then 'read' else 'none' end
    -- Een viewer mag nooit meer dan lezen, ongeacht wat er is ingesteld.
    when p_role = 'viewer' then
      case when coalesce(nullif(p_module_access ->> p_module, ''), 'write') = 'none' then 'none' else 'read' end
    -- Ontbrekende sleutel = volledig (achterwaarts compatibel).
    when p_role = 'member' then coalesce(nullif(p_module_access ->> p_module, ''), 'write')
    -- Een rol die deze regel niet kent: dicht.
    else 'none'
  end;
$$;

revoke all on function public.member_module_level(text, jsonb, text) from public, anon;
grant execute on function public.member_module_level(text, jsonb, text) to authenticated, service_role;

create or replace function public.org_module_level(p_organization_id uuid, p_module text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select public.member_module_level(m.role, m.module_access, p_module)
  from public.organization_members m
  where m.organization_id = p_organization_id
    and m.user_id = auth.uid()
    and m.status = 'active'
  limit 1;
$$;

revoke all on function public.org_module_level(uuid, text) from public, anon;
grant execute on function public.org_module_level(uuid, text) to authenticated, service_role;

-- Pushmeldingen per module: dezelfde regel. De boekhouder krijgt nooit een
-- pushmelding van een klant, ook niet over Financiën: abonnementen worden per
-- gebruiker opgezocht, niet per organisatie (push_enqueue), dus een abonnement
-- uit de eigen kantoor-werkruimte zou anders hier meeluisteren.
create or replace function public.push_module_member_ids(p_org uuid, p_module text)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(m.user_id), '{}'::uuid[])
    from public.organization_members m
   where m.organization_id = p_org
     and m.status = 'active'
     and m.role <> 'accountant'
     and public.member_module_level(m.role, m.module_access, p_module) <> 'none';
$$;

revoke all on function public.push_module_member_ids(uuid, text) from public, anon, authenticated;
grant execute on function public.push_module_member_ids(uuid, text) to service_role;

-- Pushmeldingen aan "iedereen" (nieuw ticket, klantmail, betaalde factuur,
-- Gerries dagoverzicht): de boekhouder hoort daar niet bij, om dezelfde reden.
create or replace function public.push_org_member_ids(p_org uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(m.user_id), '{}'::uuid[])
  from public.organization_members m
  where m.organization_id = p_org and m.status = 'active' and m.role <> 'accountant';
$$;

revoke all on function public.push_org_member_ids(uuid) from public, anon, authenticated;
grant execute on function public.push_org_member_ids(uuid) to service_role;

-- CalDAV (agenda op de telefoon): het niveau op Agenda volgt dezelfde regel.
-- De boekhouder heeft geen agenda, dus ook geen app-wachtwoord dat werkt.
drop function if exists public.caldav_lookup_app_passwords(text);

create function public.caldav_lookup_app_passwords(p_email text)
returns table (id uuid, user_id uuid, organization_id uuid, salt text, password_hash text, role text, calendar_level text)
language sql
security definer
set search_path = public, auth
as $$
  select ap.id, ap.user_id, ap.organization_id, ap.salt, ap.password_hash,
         case when lvl.cal_level = 'write' then m.role else 'viewer' end as role,
         lvl.cal_level as calendar_level
  from public.calendar_app_passwords ap
  join auth.users u on u.id = ap.user_id
  join public.organization_members m
    on m.organization_id = ap.organization_id
    and m.user_id = ap.user_id
    and m.status = 'active'
  cross join lateral (
    select public.member_module_level(m.role, m.module_access, 'calendar') as cal_level
  ) lvl
  where ap.revoked_at is null
    and lvl.cal_level <> 'none'
    and lower(u.email) = lower(trim(coalesce(p_email, '')))
    and coalesce(trim(p_email), '') <> '';
$$;

revoke all on function public.caldav_lookup_app_passwords(text) from public, anon, authenticated;
grant execute on function public.caldav_lookup_app_passwords(text) to service_role;

-- ── 3. Licenties: de boekhouder is gratis ───────────────────────────────────
--
-- Overal waar seats geteld worden, telt een actieve boekhouder niet mee. Een
-- openstaande uitnodiging voor een boekhouder reserveert geen seat
-- (consumes_license = false, afgedwongen door de trigger hieronder).

create or replace function public.organization_reserved_license_count(
  p_organization_id uuid,
  p_exclude_member_id uuid default null,
  p_exclude_invitation_id uuid default null
)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select (
    select count(*)::integer
    from public.organization_members om
    where om.organization_id = p_organization_id
      and om.status = 'active'
      and om.role <> 'accountant'
      and (p_exclude_member_id is null or om.id <> p_exclude_member_id)
  ) + (
    select count(*)::integer
    from public.organization_invitations oi
    where oi.organization_id = p_organization_id
      and oi.status = 'pending'
      and oi.consumes_license = true
      and (oi.expires_at is null or oi.expires_at > now())
      and (p_exclude_invitation_id is null or oi.id <> p_exclude_invitation_id)
  );
$$;

revoke all on function public.organization_reserved_license_count(uuid, uuid, uuid) from public, anon;
grant execute on function public.organization_reserved_license_count(uuid, uuid, uuid) to authenticated, service_role;

create or replace function public.enforce_member_license_capacity()
returns trigger
language plpgsql
as $$
declare
  v_licensed integer;
  v_reserved integer;
begin
  -- De boekhouder is een gast en neemt geen licentie in.
  if new.status = 'active' and new.role <> 'accountant' then
    -- Interne/gratis organisaties hebben geen seat-limiet.
    if public.organization_is_billing_exempt(new.organization_id) then
      return new;
    end if;

    select licensed_seats into v_licensed
    from public.organizations
    where id = new.organization_id
    for update;

    if v_licensed is null then
      raise exception 'Organisatie niet gevonden.' using errcode = 'P0002';
    end if;

    v_reserved := public.organization_reserved_license_count(new.organization_id, case when TG_OP = 'UPDATE' then new.id else null end, null);
    if v_reserved + 1 > v_licensed then
      raise exception 'Geen vrije gebruikerslicentie beschikbaar. Koop eerst een extra licentie voordat je dit teamlid activeert.' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.enforce_invitation_license_capacity()
returns trigger
language plpgsql
as $$
declare
  v_licensed integer;
  v_reserved integer;
begin
  -- Alleen geldige pending uitnodigingen reserveren een seat. Zodra een
  -- uitnodiging wordt geaccepteerd, ingetrokken of verlopen is, komt de
  -- gereserveerde seat direct vrij.
  if new.status <> 'pending' or (new.expires_at is not null and new.expires_at <= now()) then
    new.consumes_license := false;
    return new;
  end if;

  -- Een uitnodiging voor de boekhouder reserveert niets: het is een gast.
  if new.role = 'accountant' then
    new.consumes_license := false;
    return new;
  end if;

  new.consumes_license := true;

  -- Interne/gratis organisaties hebben geen seat-limiet.
  if public.organization_is_billing_exempt(new.organization_id) then
    return new;
  end if;

  select licensed_seats into v_licensed
  from public.organizations
  where id = new.organization_id
  for update;

  if v_licensed is null then
    raise exception 'Organisatie niet gevonden.' using errcode = 'P0002';
  end if;

  v_reserved := public.organization_reserved_license_count(new.organization_id, null, case when TG_OP = 'UPDATE' then new.id else null end);
  if v_reserved + 1 > v_licensed then
    raise exception 'Geen vrije gebruikerslicentie beschikbaar. Koop eerst een extra gebruikerslicentie voordat je iemand uitnodigt.' using errcode = '23514';
  end if;

  return new;
end;
$$;

-- De trigger luisterde alleen naar status/consumes_license/expires_at. Een
-- openstaande uitnodiging die van boekhouder naar teamlid wordt omgezet (de
-- upsert in invite_organization_member) moet opnieuw tegen de seats gewogen
-- worden, dus de rol hoort erbij.
drop trigger if exists organization_invitations_license_capacity on public.organization_invitations;
create trigger organization_invitations_license_capacity
  before insert or update of status, consumes_license, expires_at, role on public.organization_invitations
  for each row execute function public.enforce_invitation_license_capacity();

-- Zoals in 20261003060000, met de boekhouder buiten de telling — ook bij de
-- vraag "is deze uitgenodigde al ergens in de boom lid?": een gratis
-- boekhouder mag een betaalde uitnodiging elders niet gratis maken.
create or replace function public.organization_license_usage(p_organization_id uuid)
returns table (
  organization_id uuid,
  licensed_seats integer,
  active_members integer,
  pending_invitations integer,
  used_seats integer,
  available_seats integer,
  license_status text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_root uuid;
  v_family uuid[];
begin
  if auth.role() is distinct from 'service_role' and not public.can_read_org(p_organization_id) then
    raise exception 'Geen toegang tot deze organisatie.' using errcode = '42501';
  end if;

  v_root := public.billing_root_organization(p_organization_id);
  select array(select public.org_family(p_organization_id)) into v_family;

  return query
  select
    o.id,
    o.licensed_seats,
    coalesce(active_counts.active_members, 0)::integer,
    coalesce(pending_counts.pending_invitations, 0)::integer,
    (coalesce(active_counts.active_members, 0) + coalesce(pending_counts.pending_invitations, 0))::integer,
    greatest(o.licensed_seats - (coalesce(active_counts.active_members, 0) + coalesce(pending_counts.pending_invitations, 0)), 0)::integer,
    o.license_status
  from public.organizations o
  left join lateral (
    -- distinct: dezelfde persoon in twee administraties is één seat
    select count(distinct om.user_id)::integer as active_members
    from public.organization_members om
    where om.organization_id = any(v_family) and om.status = 'active' and om.role <> 'accountant'
  ) active_counts on true
  left join lateral (
    -- idem voor openstaande uitnodigingen, op e-mailadres
    select count(distinct oi.email)::integer as pending_invitations
    from public.organization_invitations oi
    where oi.organization_id = any(v_family)
      and oi.status = 'pending'
      and oi.consumes_license = true
      and (oi.expires_at is null or oi.expires_at > now())
      and not exists (
        -- al (betaald) lid ergens in de boom? dan verbruikt de uitnodiging geen extra seat
        select 1 from public.organization_members om2
        where om2.organization_id = any(v_family)
          and om2.status = 'active'
          and om2.role <> 'accountant'
          and om2.email = oi.email
      )
  ) pending_counts on true
  where o.id = v_root;
end;
$$;

revoke all on function public.organization_license_usage(uuid) from public, anon;
grant execute on function public.organization_license_usage(uuid) to authenticated, service_role;

-- Zoals in 20260807000000; alleen de twee tellingen sluiten de boekhouder uit.
create or replace function public.organization_billing_overview(p_organization_id uuid)
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
  v_root uuid;
  v_family uuid[];
  v_org uuid;
begin
  if not public.can_admin_org(p_organization_id) then
    raise exception 'Alleen owners/admins mogen billing bekijken.' using errcode = '42501';
  end if;

  v_root := public.billing_root_organization(p_organization_id);
  select array(select public.org_family(p_organization_id)) into v_family;

  foreach v_org in array v_family loop
    perform public.expire_stale_organization_invitations(v_org);
  end loop;

  v_profile := public.ensure_organization_billing_profile(v_root);

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
    select count(distinct om.user_id)::integer as active_members
    from public.organization_members om
    where om.organization_id = any(v_family) and om.status = 'active' and om.role <> 'accountant'
  ) active_counts on true
  left join lateral (
    select count(distinct oi.email)::integer as pending_invitations
    from public.organization_invitations oi
    where oi.organization_id = any(v_family)
      and oi.status = 'pending'
      and oi.consumes_license = true
      and (oi.expires_at is null or oi.expires_at > now())
      and not exists (
        select 1 from public.organization_members om2
        where om2.organization_id = any(v_family)
          and om2.status = 'active'
          and om2.role <> 'accountant'
          and om2.email = oi.email
      )
  ) pending_counts on true
  left join lateral (
    select s.used_bytes from public.organization_storage_status(p.organization_id) s
  ) storage_counts on true
  where p.organization_id = v_root;
end;
$$;

revoke all on function public.organization_billing_overview(uuid) from public, anon;
grant execute on function public.organization_billing_overview(uuid) to authenticated;

-- ── 4. Uitnodigen en accepteren ─────────────────────────────────────────────

create or replace function public.invite_organization_member(
  p_organization_id uuid,
  p_email citext,
  p_role text,
  p_module_access jsonb default '{}'::jsonb
)
returns public.organization_invitations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id     uuid := auth.uid();
  v_clean_email citext := lower(trim(p_email::text))::citext;
  v_access      jsonb := coalesce(p_module_access, '{}'::jsonb);
  v_other       citext;
  v_invitation  public.organization_invitations;
begin
  if v_user_id is null then raise exception 'Niet ingelogd' using errcode = '28000'; end if;
  if not public.user_has_org_role(p_organization_id, array['owner','admin']) then
    raise exception 'Alleen owners/admins mogen teamleden uitnodigen' using errcode = '42501';
  end if;
  if p_role not in ('admin','member','viewer','accountant') then
    raise exception 'Ongeldige organisatierol' using errcode = '23514';
  end if;
  if nullif(trim(p_email::text), '') is null then
    raise exception 'E-mailadres ontbreekt' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.organization_members
    where organization_id = p_organization_id
      and email = v_clean_email
      and status = 'active'
  ) then
    raise exception 'Dit e-mailadres is al actief lid van deze organisatie.' using errcode = '23505';
  end if;

  if p_role = 'accountant' then
    -- De rechten liggen vast in de rol; wat er meekomt, telt niet.
    v_access := '{}'::jsonb;

    -- Eén boekhouder per administratie. Twee owners die tegelijk iemand
    -- uitnodigen, wachten hier op elkaar.
    perform pg_advisory_xact_lock(hashtextextended('accountant-invite:' || p_organization_id::text, 0));
    -- Een verlopen uitnodiging staat nog op 'pending' tot iets hem opruimt; die
    -- mag een nieuwe uitnodiging niet blokkeren.
    perform public.expire_stale_organization_invitations(p_organization_id);

    select email into v_other
      from public.organization_members
     where organization_id = p_organization_id and role = 'accountant' and status = 'active'
     limit 1;
    if found then
      raise exception 'Er is al een boekhouder actief (%). Zet die toegang eerst uit voordat je een andere boekhouder uitnodigt.', coalesce(v_other::text, 'onbekend')
        using errcode = '23505';
    end if;

    select email into v_other
      from public.organization_invitations
     where organization_id = p_organization_id and role = 'accountant' and status = 'pending'
       and email <> v_clean_email
     limit 1;
    if found then
      raise exception 'Er staat al een uitnodiging open voor boekhouder %. Trek die eerst in.', v_other
        using errcode = '23505';
    end if;
  end if;

  insert into public.organization_invitations(organization_id, email, role, module_access, consumes_license, invited_by, status, expires_at)
  values (p_organization_id, v_clean_email, p_role, v_access, p_role <> 'accountant', v_user_id, 'pending', now() + interval '14 days')
  on conflict (organization_id, email) where status = 'pending'
  do update set
    role = excluded.role,
    module_access = excluded.module_access,
    consumes_license = excluded.consumes_license,
    invited_by = excluded.invited_by,
    expires_at = excluded.expires_at,
    updated_at = now()
  returning * into v_invitation;

  return v_invitation;
end;
$$;

revoke all on function public.invite_organization_member(uuid, citext, text, jsonb) from public, anon;
grant execute on function public.invite_organization_member(uuid, citext, text, jsonb) to authenticated;

-- Accepteren neemt de rol uit de uitnodiging over. Het zet een vlag voor de duur
-- van deze transactie: de rolbewaking hieronder laat een overgang naar of van
-- 'accountant' alleen hier toe — een nieuwe boekhouder, of een oud-boekhouder
-- die nu als teamlid terugkomt (en dan via de seat-trigger een licentie neemt).
create or replace function public.accept_organization_invitation(p_invitation_id uuid)
returns public.organization_members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id    uuid := auth.uid();
  v_email      citext := public.current_user_email();
  v_invitation public.organization_invitations;
  v_member     public.organization_members;
begin
  if v_user_id is null then raise exception 'Niet ingelogd' using errcode = '28000'; end if;
  if v_email is null then raise exception 'Geen e-mail bekend in sessie' using errcode = '23514'; end if;

  select * into v_invitation
  from public.organization_invitations
  where id = p_invitation_id
    and status = 'pending'
    and email = v_email
    and (expires_at is null or expires_at > now())
  for update;

  if not found then
    raise exception 'Uitnodiging niet gevonden of verlopen' using errcode = 'P0002';
  end if;

  if v_invitation.role = 'accountant' and exists (
    select 1 from public.organization_members
    where organization_id = v_invitation.organization_id
      and role = 'accountant' and status = 'active' and user_id <> v_user_id
  ) then
    raise exception 'Deze administratie heeft al een actieve boekhouder. Vraag de owner om die eerst uit te zetten.'
      using errcode = '23505';
  end if;

  perform set_config('resofly.accepting_invitation', 'on', true);

  update public.organization_invitations
  set status = 'accepted', consumes_license = false, accepted_by = v_user_id, accepted_at = now(), updated_at = now()
  where id = v_invitation.id;

  insert into public.organization_members(organization_id, user_id, email, role, module_access, status, invited_by, joined_at)
  values (
    v_invitation.organization_id, v_user_id, v_email, v_invitation.role,
    case when v_invitation.role = 'accountant' then '{}'::jsonb else coalesce(v_invitation.module_access, '{}'::jsonb) end,
    'active', v_invitation.invited_by, now()
  )
  on conflict (organization_id, user_id)
  do update set
    role = excluded.role,
    module_access = excluded.module_access,
    status = 'active',
    email = excluded.email,
    updated_at = now()
  returning * into v_member;

  perform set_config('resofly.accepting_invitation', '', true);

  return v_member;
end;
$$;

revoke all on function public.accept_organization_invitation(uuid) from public, anon;
grant execute on function public.accept_organization_invitation(uuid) to authenticated;

-- Rolbewaking: een rol wisselt niet naar of van 'accountant'. Dat zou de
-- licentietelling omzeilen (de seat-trigger kijkt naar de status, niet naar de
-- rol) en de afspraak breken dat een boekhouder alleen via een eigen
-- uitnodiging binnenkomt. Servicecontext (geen auth.uid(): support, migraties)
-- valt erbuiten, net als bij de owner-bewaking.
create or replace function public.prevent_accountant_role_change()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if (old.role = 'accountant') is distinct from (new.role = 'accountant')
     and coalesce(current_setting('resofly.accepting_invitation', true), '') <> 'on' then
    raise exception 'De rol boekhouder wissel je niet om: zet de toegang uit en nodig opnieuw uit (als boekhouder of als teamlid).'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists organization_members_accountant_role_guard on public.organization_members;
create trigger organization_members_accountant_role_guard
  before update of role on public.organization_members
  for each row execute function public.prevent_accountant_role_change();

-- De rechten van de boekhouder liggen vast; het rechtenraster geldt daar niet.
create or replace function public.set_member_module_access(p_member_id uuid, p_module_access jsonb)
returns public.organization_members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member public.organization_members;
begin
  if auth.uid() is null then
    raise exception 'Niet ingelogd' using errcode = '28000';
  end if;

  select * into v_member from public.organization_members where id = p_member_id for update;
  if not found then
    raise exception 'Teamlid niet gevonden' using errcode = 'P0002';
  end if;

  if not public.user_has_org_role(v_member.organization_id, array['owner', 'admin']) then
    raise exception 'Alleen owners en admins mogen modulerechten aanpassen' using errcode = '42501';
  end if;

  if v_member.role = 'owner' then
    raise exception 'Een owner heeft altijd toegang tot alle modules' using errcode = '42501';
  end if;

  if v_member.role = 'accountant' then
    raise exception 'De boekhouder heeft vaste rechten: alleen lezen in Financiën.' using errcode = '42501';
  end if;

  -- Een admin mag geen andere admin beperken; dat blijft aan de owner.
  if v_member.role = 'admin' and not public.user_has_org_role(v_member.organization_id, array['owner']) then
    raise exception 'Alleen een owner kan de rechten van een admin aanpassen' using errcode = '42501';
  end if;

  update public.organization_members
  set module_access = coalesce(p_module_access, '{}'::jsonb),
      updated_at = now()
  where id = p_member_id
  returning * into v_member;

  return v_member;
end;
$$;

revoke all on function public.set_member_module_access(uuid, jsonb) from public, anon;
grant execute on function public.set_member_module_access(uuid, jsonb) to authenticated;

-- Een uitgenodigde boekhouder krijgt bij de eerste login géén eigen werkruimte.
-- Anders ontstond er een lege organisatie op eigen naam, met de boekhouder als
-- owner en de hele app in beeld, en stond de uitnodiging ergens onder
-- Instellingen. Nu volgt het scherm "Je bent uitgenodigd", met Accepteren.
create or replace function public.ensure_user_default_organization()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_email citext := public.current_user_email();
  v_name text;
begin
  if v_user_id is null then
    raise exception 'Niet ingelogd' using errcode = '28000';
  end if;

  update public.organization_members
  set email = coalesce(email, v_email), updated_at = now()
  where user_id = v_user_id and email is null;

  if exists (select 1 from public.organization_members where user_id = v_user_id and status = 'active') then
    return;
  end if;

  if v_email is not null and exists (
    select 1 from public.organization_invitations oi
    where oi.email = v_email
      and oi.role = 'accountant'
      and oi.status = 'pending'
      and (oi.expires_at is null or oi.expires_at > now())
  ) then
    return;
  end if;

  v_name := coalesce(nullif(split_part(v_email::text, '@', 1), ''), 'Mijn organisatie');
  perform public.create_organization(initcap(v_name));
end;
$$;

revoke all on function public.ensure_user_default_organization() from public, anon;
grant execute on function public.ensure_user_default_organization() to authenticated;

-- ── 5. Een lezer schrijft niet ──────────────────────────────────────────────
--
-- next_purchase_invoice_number trekt een nummer uit de reeks (insert + update)
-- en vroeg daarvoor alleen leesrecht. Alleen de factuur-inbox gebruikt hem, op
-- de service-role; een ingelogde gebruiker hoort er schrijfrecht op Financiën
-- voor te hebben. Verder gelijk aan 20260918030000.
create or replace function public.next_purchase_invoice_number(p_organization_id uuid, p_date date default current_date)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_year    integer := extract(year from coalesce(p_date, current_date))::integer;
  v_prefix  text    := 'INK-' || v_year::text || '-';
  v_seen    integer;
  v_number  integer;
  v_code    text;
begin
  if auth.role() is distinct from 'service_role' and not public.can_write_module(p_organization_id, 'finance') then
    raise exception 'Geen schrijfrechten in de module Financiën van deze organisatie.' using errcode = '42501';
  end if;

  -- Reeks aanmaken als hij nog niet bestaat, en meteen bijtrekken tot voorbij
  -- wat er al aan facturen ligt. Dat laatste is nodig voor bestaande
  -- administraties én voor nummers die met de hand zijn ingevoerd.
  insert into public.organization_purchase_invoice_number_sequences (organization_id, year, next_number)
  values (p_organization_id, v_year, 1)
  on conflict (organization_id, year) do nothing;

  -- FOR UPDATE: vanaf hier wacht een gelijktijdige tweede aanvrager tot deze
  -- transactie klaar is. Dát is wat de botsing onmogelijk maakt.
  select next_number into v_number
    from public.organization_purchase_invoice_number_sequences
   where organization_id = p_organization_id and year = v_year
   for update;

  select coalesce(max((regexp_match(substr(pi.internal_number, length(v_prefix) + 1), '^\d+'))[1]::integer), 0)
    into v_seen
    from public.purchase_invoices pi
   where pi.organization_id = p_organization_id
     and pi.internal_number like v_prefix || '%';

  v_number := greatest(coalesce(v_number, 1), coalesce(v_seen, 0) + 1);
  v_code := v_prefix || lpad(v_number::text, 4, '0');

  -- Vangnet voor een nummer dat toch al bezet is (handmatig ingevoerd met een
  -- afwijkend patroon, of een hersteloperatie): doorschuiven tot het vrij is.
  -- Zelfde lus als in de klantnummergenerator.
  while exists (
    select 1 from public.purchase_invoices pi
     where pi.organization_id = p_organization_id
       and pi.internal_number = v_code
  ) loop
    v_number := v_number + 1;
    v_code := v_prefix || lpad(v_number::text, 4, '0');
  end loop;

  update public.organization_purchase_invoice_number_sequences
     set next_number = v_number + 1
   where organization_id = p_organization_id and year = v_year;

  return v_code;
end;
$$;

revoke all on function public.next_purchase_invoice_number(uuid, date) from public, anon;
grant execute on function public.next_purchase_invoice_number(uuid, date) to authenticated, service_role;

-- ── 6. De debiteuren op de financiële stukken ───────────────────────────────
--
-- Facturen, offertes en contracten verwijzen naar een klant, maar de
-- klantenkaart valt onder Klanten — en die is voor de boekhouder dicht. Zonder
-- klantnaam is een facturenlijst onleesbaar en heeft de XAF-auditfile geen
-- debiteuren. Deze functie geeft precies wat er op de stukken staat: naam,
-- klantnummer, soort (zakelijk/particulier), contactpersoon, adres, e-mail,
-- telefoon, btw- en KvK-nummer en de e-factuurinstelling — alleen van klanten
-- die op een factuur, offerte, contract of boeking staan. Geen notities, tags,
-- opvolgdatum, waarde of eigen velden, en geen klanten zonder financieel stuk.
--
-- Voor iedereen met leesrecht op Financiën: ook een teamlid met Financiën open
-- en Klanten dicht zag tot nu toe facturen zonder naam.
create or replace function public.finance_client_directory(p_organization_id uuid)
returns table (
  id uuid,
  organization_id uuid,
  name text,
  client_code text,
  client_kind text,
  contact_name text,
  email text,
  phone text,
  vat_number text,
  kvk_number text,
  address_line1 text,
  address_line2 text,
  postal_code text,
  city text,
  country text,
  e_invoicing_enabled boolean,
  e_invoice_email text,
  e_invoice_channel text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.can_read_module(p_organization_id, 'finance') then
    raise exception 'Geen toegang tot de module Financiën in deze organisatie.' using errcode = '42501';
  end if;

  return query
  select c.id, c.organization_id, c.name, c.client_code, c.client_kind, c.contact_name, c.email, c.phone,
         c.vat_number, c.kvk_number, c.address_line1, c.address_line2, c.postal_code, c.city, c.country,
         c.e_invoicing_enabled, c.e_invoice_email, c.e_invoice_channel
  from public.clients c
  where c.organization_id = p_organization_id
    and (
      exists (select 1 from public.invoices i where i.organization_id = c.organization_id and i.client_id = c.id)
      or exists (select 1 from public.quotes q where q.organization_id = c.organization_id and q.client_id = c.id)
      or exists (select 1 from public.contracts k where k.organization_id = c.organization_id and k.client_id = c.id)
      or exists (select 1 from public.journal_lines jl where jl.organization_id = c.organization_id and jl.client_id = c.id)
    )
  order by c.name;
end;
$$;

revoke all on function public.finance_client_directory(uuid) from public, anon;
grant execute on function public.finance_client_directory(uuid) to authenticated, service_role;

-- ── 7. Het hek ───────────────────────────────────────────────────────────────

-- De administraties waar de ingelogde gebruiker boekhouder is. In een policy als
-- `(select public.my_accountant_organization_ids())::uuid[]`: dan draait hij één
-- keer per query (InitPlan), niet per rij. Voor iedereen die geen boekhouder is, is de
-- lijst leeg en kost het hek niets.
create or replace function public.my_accountant_organization_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(m.organization_id), '{}'::uuid[])
  from public.organization_members m
  where m.user_id = auth.uid()
    and m.status = 'active'
    and m.role = 'accountant';
$$;

revoke all on function public.my_accountant_organization_ids() from public, anon;
grant execute on function public.my_accountant_organization_ids() to authenticated, service_role;

-- Zet het hek op één tabel. Zonder p_select_using staat alles dicht voor de
-- boekhouder; met p_select_using mag de boekhouder de rijen lezen waarvoor die
-- expressie waar is, en schrijven nooit. Alleen voor migraties, net als apply_module_gate.
create or replace function public.apply_accountant_fence(p_table text, p_select_using text default null)
returns void
language plpgsql
as $$
declare
  -- De cast maakt er een array-expressie van; zonder cast leest Postgres
  -- `= any ((select …))` als een subquery en vergelijkt hij uuid met uuid[].
  v_not_accountant constant text :=
    'not (organization_id = any ((select public.my_accountant_organization_ids())::uuid[]))';
begin
  if to_regclass('public.' || quote_ident(p_table)) is null then
    raise exception 'Boekhouder-hek: tabel public.% bestaat niet', p_table;
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = p_table and column_name = 'organization_id'
  ) then
    raise exception 'Boekhouder-hek: public.% heeft geen kolom organization_id', p_table;
  end if;
  -- Zonder ingeschakelde RLS doet een restrictive policy niets. Liever falen
  -- dan schijnveiligheid.
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = p_table and c.relrowsecurity
  ) then
    raise exception 'Boekhouder-hek: public.% heeft row level security uit staan', p_table;
  end if;

  execute format('drop policy if exists %I on public.%I', 'accountant fence', p_table);
  execute format('drop policy if exists %I on public.%I', 'accountant fence select', p_table);
  execute format('drop policy if exists %I on public.%I', 'accountant fence insert', p_table);
  execute format('drop policy if exists %I on public.%I', 'accountant fence update', p_table);
  execute format('drop policy if exists %I on public.%I', 'accountant fence delete', p_table);

  if p_select_using is null then
    execute format(
      'create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)',
      'accountant fence', p_table, v_not_accountant, v_not_accountant);
    return;
  end if;

  execute format(
    'create policy %I on public.%I as restrictive for select to authenticated using (%s or (%s))',
    'accountant fence select', p_table, v_not_accountant, p_select_using);
  execute format(
    'create policy %I on public.%I as restrictive for insert to authenticated with check (%s)',
    'accountant fence insert', p_table, v_not_accountant);
  execute format(
    'create policy %I on public.%I as restrictive for update to authenticated using (%s) with check (%s)',
    'accountant fence update', p_table, v_not_accountant, v_not_accountant);
  execute format(
    'create policy %I on public.%I as restrictive for delete to authenticated using (%s)',
    'accountant fence delete', p_table, v_not_accountant);
end;
$$;

revoke all on function public.apply_accountant_fence(text, text) from public, anon, authenticated;

-- Welke organisatietabel heeft geen module gate en geen hek? Leeg = in orde.
-- De rooktest na elke deploy (scripts/supabase-smoke-test.sh) vraagt dit op:
-- een nieuwe tabel die het vergeet, valt dan meteen op.
create or replace function public.accountant_fence_gaps()
returns setof text
language sql
stable
set search_path = public
as $$
  select c.relname::text
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')
    and exists (
      select 1 from information_schema.columns ic
      where ic.table_schema = 'public' and ic.table_name = c.relname and ic.column_name = 'organization_id'
    )
    and not exists (
      select 1 from pg_policies p
      where p.schemaname = 'public' and p.tablename = c.relname
        and p.policyname in ('module gate select', 'accountant fence', 'accountant fence select')
    )
  order by 1;
$$;

revoke all on function public.accountant_fence_gaps() from public, anon, authenticated;
grant execute on function public.accountant_fence_gaps() to service_role;

-- Elke organisatietabel zonder module gate krijgt het hek; vier met een eigen
-- regel. Tabellen mét module gate hebben het niet nodig: daar geeft
-- member_module_level de boekhouder 'none' — behalve Financiën, en daar mag de
-- boekhouder juist lezen.
do $$
declare
  v_table  text;
  v_fenced text[] := array[]::text[];
begin
  for v_table in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and exists (
        select 1 from information_schema.columns ic
        where ic.table_schema = 'public' and ic.table_name = c.relname and ic.column_name = 'organization_id'
      )
      and not exists (
        select 1 from pg_policies p
        where p.schemaname = 'public' and p.tablename = c.relname and p.policyname = 'module gate select'
      )
      and c.relname not in ('organization_members', 'company_settings', 'audit_logs', 'attachments')
    order by c.relname
  loop
    perform public.apply_accountant_fence(v_table);
    v_fenced := v_fenced || v_table;
  end loop;

  raise notice 'Boekhouder-hek op % tabellen: %', coalesce(array_length(v_fenced, 1), 0), array_to_string(v_fenced, ', ');
end;
$$;

-- De teamlijst: alleen de eigen rij (de app leest daar de rol uit).
select public.apply_accountant_fence('organization_members', 'user_id = (select auth.uid())');
-- Bedrijfsgegevens, btw-periode, KOR: lezen.
select public.apply_accountant_fence('company_settings', 'true');
-- Het auditlog: alleen wat over financiën gaat.
select public.apply_accountant_fence('audit_logs', 'public.audit_entity_module(entity_type) = ''finance''');
-- Bijlagen: alleen die van een financieel record (inkoopfactuur, factuur, …).
-- attachments heeft al een module gate; een bijlage van een ONBEKEND type valt
-- daar bewust buiten (attachment_module = null). Voor de boekhouder niet.
select public.apply_accountant_fence('attachments', 'public.attachment_module(entity_type) = ''finance''');

do $$
begin
  if exists (select 1 from public.accountant_fence_gaps()) then
    raise exception 'Boekhouder-hek onvolledig: %', (select string_agg(g, ', ') from public.accountant_fence_gaps() g);
  end if;
end;
$$;

commit;
