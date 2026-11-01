-- ============================================================
-- ResoFly — Een klant uit het portaal krijgt geen eigen werkruimte
-- Date: 2026-11-01
--
-- Aanleiding: open punt uit de beveiligingsronde van 26 september, opgepakt in
-- de beveiligingsronde SaaS (CHANGELOG_BEVEILIGING_SAAS_2026-11-01.md).
--
-- Zelf registreren staat uit: een account ontstaat alleen via een uitnodiging
-- (mail-functie) of via de portal-login, voor een bekend klantadres. Maar wie
-- als klant in het portaal inlogde en daarna de werkruimte opende, kreeg
-- vanzelf een eigen organisatie als owner (ensure_user_default_organization).
-- create_organization kon hij ook rechtstreeks aanroepen, zo vaak als hij
-- wilde. Elke klant van elke organisatie had zo een gratis werkruimte, met de
-- platform-afzender voor mail, Gerrie en opslag erbij.
--
-- Nu:
--   - is_portal_only_account(): een account dat nooit lid was van een
--     organisatie, geen openstaande uitnodiging heeft, en ofwel door de
--     portal-login is aangemaakt (app_metadata.resofly_portal, alleen door de
--     server te zetten) ofwel bij een klant of portaalcontact hoort. Dat
--     laatste dekt de portaalaccounts van vóór deze migratie;
--   - ensure_user_default_organization maakt voor zo'n account niets aan;
--   - create_organization weigert zo'n account.
--
-- Wie lid is of een uitnodiging heeft, merkt niets. Een teamlid dat ook klant
-- is van een andere organisatie, kan gewoon een organisatie maken: hij is (of
-- was) lid. Moet een klant toch een eigen werkruimte krijgen, dan nodigt
-- iemand hem uit, of maakt de beheerder van het platform de organisatie aan.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

create or replace function public.is_portal_only_account(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select
      not exists (select 1 from public.organization_members m where m.user_id = u.id)
      and not exists (
        select 1 from public.organization_invitations oi
        where oi.email = lower(u.email)::citext
          and oi.status = 'pending'
          and (oi.expires_at is null or oi.expires_at > now())
      )
      and (
        coalesce(u.raw_app_meta_data ->> 'resofly_portal', '') = 'true'
        or exists (select 1 from public.portal_clients_for_email(u.email))
      )
    from auth.users u
    where u.id = p_user_id
  ), false);
$$;

revoke all on function public.is_portal_only_account(uuid) from public, anon, authenticated;
grant execute on function public.is_portal_only_account(uuid) to service_role;

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

  -- Een klant uit het portaal is klant van een organisatie, niet van ResoFly:
  -- geen eigen werkruimte. De app toont dan de weg naar het klantportaal.
  if public.is_portal_only_account(v_user_id) then
    return;
  end if;

  v_name := coalesce(nullif(split_part(v_email::text, '@', 1), ''), 'Mijn organisatie');
  perform public.create_organization(initcap(v_name));
end;
$$;

create or replace function public.create_organization(p_name text)
returns public.organizations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_email citext := public.current_user_email();
  v_base_slug text := public.slugify(p_name);
  v_slug text := v_base_slug;
  v_counter int := 1;
  v_org public.organizations;
begin
  if v_user_id is null then
    raise exception 'Niet ingelogd' using errcode = '28000';
  end if;
  if nullif(trim(p_name), '') is null then
    raise exception 'Organisatienaam ontbreekt' using errcode = '23514';
  end if;
  if public.is_portal_only_account(v_user_id) then
    raise exception 'Dit account hoort bij het klantportaal van een organisatie. Een eigen werkruimte krijg je via een uitnodiging.'
      using errcode = '42501';
  end if;

  while exists (select 1 from public.organizations where slug = v_slug) loop
    v_counter := v_counter + 1;
    v_slug := left(v_base_slug, 52) || '-' || v_counter::text;
  end loop;

  insert into public.organizations(name, slug, created_by)
  values (trim(p_name), v_slug, v_user_id)
  returning * into v_org;

  insert into public.organization_members(organization_id, user_id, email, role, status, invited_by)
  values (v_org.id, v_user_id, v_email, 'owner', 'active', v_user_id);

  insert into public.organization_license_events(organization_id, delta_seats, seats_after, reason, provider, created_by, metadata)
  values (v_org.id, 1, 1, 'initial', 'system', v_user_id, jsonb_build_object('source', 'create_organization'));

  return v_org;
end;
$$;

-- create or replace houdt de bestaande grants, maar zet ze voor de zekerheid
-- expliciet: aanroepbaar door ingelogde gebruikers, niet door anon.
revoke all on function public.ensure_user_default_organization() from public, anon;
grant execute on function public.ensure_user_default_organization() to authenticated, service_role;
revoke all on function public.create_organization(text) from public, anon;
grant execute on function public.create_organization(text) to authenticated, service_role;

commit;
