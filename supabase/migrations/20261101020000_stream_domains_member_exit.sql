-- ============================================================
-- ResoFly — Video's, verzenddomeinen en vertrekkende teamleden
-- Date: 2026-11-01
--
-- Beveiligingsronde SaaS (CHANGELOG_BEVEILIGING_SAAS_2026-11-01.md), drie
-- gaten die over de grens van een organisatie of een lidmaatschap heen gingen:
--
--   1. VIDEO'S VAN EEN ANDERE ORGANISATIE. gallery_items.stream_uid schrijft de
--      browser zelf, en de media-worker tekent voor elk stream_uid in een
--      galerij een afspeel- en downloadtoken met de sleutel van het gedeelde
--      Stream-account. Wie het id van een video van een andere organisatie
--      kende (het staat in elke deellink van die galerij), zette dat id in een
--      eigen galerij en kreeg een downloadtoken, ook als daar "downloaden uit"
--      stond of de link al was ingetrokken. Nu hoort een stream_uid bij één
--      organisatie; de worker controleert het ook zelf (media-api).
--   2. VERZENDDOMEINEN. Alle organisaties delen één Resend-account, maar een
--      domein was alleen per organisatie uniek. Zo kon de ene klant het domein
--      van de andere bezetten. Nu is een domein uniek over alle organisaties
--      heen; de mail-functie weigert ook sub- en bovenliggende domeinen en het
--      domein van de platform-afzender.
--   3. EEN TEAMLID VERTREKT. Zijn API-sleutels en app-wachtwoorden vervielen al,
--      maar webhooks die hij aanmaakte bleven alle gebeurtenissen naar zijn
--      adres sturen, en zijn gekoppelde Google- of Microsoft-agenda bleef met
--      zijn token lees- en schrijfbaar voor het team. Nu gaan bij vertrek zijn
--      webhooks uit (met reden; een owner of admin kan ze weer aanzetten), en
--      vervallen zijn agendakoppelingen en de tokens daarvan.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Een video hoort bij één organisatie ─────────────────────────────────

create or replace function public.enforce_gallery_stream_uid_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.stream_uid is null then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.stream_uid is not distinct from old.stream_uid
     and new.organization_id = old.organization_id then
    return new;
  end if;
  if exists (
    select 1 from public.gallery_items gi
    where gi.stream_uid = new.stream_uid
      and gi.organization_id <> new.organization_id
  ) then
    raise exception 'Deze video hoort bij een andere organisatie.' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_gallery_stream_uid_owner() from public, anon, authenticated;

create index if not exists gallery_items_stream_uid_idx
  on public.gallery_items (stream_uid) where stream_uid is not null;

drop trigger if exists gallery_items_stream_uid_owner on public.gallery_items;
create trigger gallery_items_stream_uid_owner
  before insert or update of stream_uid, organization_id on public.gallery_items
  for each row execute function public.enforce_gallery_stream_uid_owner();

-- ── 2. Een verzenddomein hoort bij één organisatie ─────────────────────────

create unique index if not exists organization_email_domains_domain_global_key
  on public.organization_email_domains (lower(domain));

-- ── 3. Integraties stoppen als hun maker vertrekt ─────────────────────────

create or replace function public.disable_integrations_on_member_exit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_user uuid;
begin
  if tg_op = 'DELETE' then
    v_org := old.organization_id;
    v_user := old.user_id;
  elsif old.status = 'active' and new.status is distinct from 'active' then
    v_org := new.organization_id;
    v_user := new.user_id;
  else
    return new;
  end if;

  -- De bewaking van webhook_endpoints laat de reden alleen staan met deze vlag
  -- (alleen voor de rest van deze transactie).
  perform set_config('resofly.member_exit', 'on', true);
  update public.webhook_endpoints
     set active = false,
         disabled_reason = 'Uitgezet: wie dit eindpunt aanmaakte, is geen actief teamlid meer. Een owner of admin kan het weer aanzetten.'
   where organization_id = v_org
     and created_by = v_user
     and active;
  perform set_config('resofly.member_exit', '', true);

  update public.calendar_connections
     set status = 'revoked',
         last_error = 'Ingetrokken: het teamlid is uit de organisatie.'
   where organization_id = v_org
     and user_id = v_user
     and status <> 'revoked';

  delete from public.calendar_connection_tokens
   where organization_id = v_org
     and user_id = v_user;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.disable_integrations_on_member_exit() from public, anon, authenticated;

drop trigger if exists organization_members_disable_integrations on public.organization_members;
create trigger organization_members_disable_integrations
  after delete or update of status on public.organization_members
  for each row execute function public.disable_integrations_on_member_exit();

-- De bewaking van webhook_endpoints: ongewijzigd, op één uitzondering na (de
-- reden bij vertrek van de maker blijft staan).
create or replace function public.webhook_endpoints_guard_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  -- Weer aanzetten is een nieuwe start: de foutreeks en de reden van het
  -- uitzetten horen er dan niet meer bij. Geldt voor elke weg.
  if new.active and not old.active then
    new.consecutive_failures := 0;
    new.failing_since := null;
    new.disabled_reason := null;
  end if;
  new.updated_at := now();

  if auth.uid() is null then return new; end if;

  if new.organization_id is distinct from old.organization_id
     or new.url is distinct from old.url
     or new.events is distinct from old.events
     or new.created_by is distinct from old.created_by
     or new.api_key_id is distinct from old.api_key_id
     or new.created_at is distinct from old.created_at
     or new.last_success_at is distinct from old.last_success_at
     or new.last_failure_at is distinct from old.last_failure_at
     or (new.active = old.active and (
          new.consecutive_failures is distinct from old.consecutive_failures
          or new.failing_since is distinct from old.failing_since
          or new.disabled_reason is distinct from old.disabled_reason)) then
    raise exception 'Vanuit de app kun je een webhook alleen aan- of uitzetten, de omschrijving wijzigen of verwijderen. Adres en gebeurtenissen wijzig je in Instellingen → API & webhooks.'
      using errcode = '42501';
  end if;

  -- Uitzetten in de app: de teller en de reden blijven wat ze waren. Wat er in
  -- hetzelfde verzoek voor werd meegestuurd, telt niet — anders stond er zo
  -- "Automatisch uitgezet: …" bij een eindpunt dat iemand met de hand uitzette.
  -- Uitzondering: het vertrek van de maker (disable_integrations_on_member_exit)
  -- zet een eigen reden, zodat de owner ziet waarom het eindpunt uit staat.
  if old.active and not new.active then
    new.consecutive_failures := old.consecutive_failures;
    new.failing_since := old.failing_since;
    if coalesce(current_setting('resofly.member_exit', true), '') <> 'on' then
      new.disabled_reason := old.disabled_reason;
    end if;
  end if;
  return new;
end;
$function$;

revoke all on function public.webhook_endpoints_guard_update() from public, anon;

commit;
