-- ============================================================
-- ResoFly — Inloggen in het klantportaal: geen code van Supabase meer in de
-- mail, en een sleutel van een eigen domein geldt alleen zolang dat domein
-- echt van ons is.
--
-- Gevonden bij de hertest van 9 november (docs/changelog/
-- CHANGELOG_PORTAAL_HERTEST_2026-11-09.md):
--
-- 1. Een leverancier met een eigen domein vraagt daar, net als het portaal,
--    om "de code uit de mail". Vanaf zijn eigen server kon hij voor een klant
--    een inlog op het algemene portaal aanvragen (of op het adres van een
--    andere leverancier: de herkomst van een verzoek is na te maken). De
--    klant kreeg dan een code van Supabase, vulde die op de pagina van de
--    leverancier in, en de leverancier legde de inlog vast met zijn eigen
--    geheim: een inlog bij Supabase voor alles wat de klant bij iedereen
--    heeft. Ook als er niemand een code invult: het token van Supabase
--    bestond vanaf het aanvragen, een uur lang, klaar om te raden. Nu maakt
--    portal-login het token van Supabase
--    pas als de link uit de mail wordt geopend in de browser die hem
--    aanvroeg (redeemLogin), en staat er nooit een code van Supabase in een
--    mail. Een aanvraag op de naam bij ResoFly of het algemene portaal heeft
--    dus eerst geen token_hash en geen code_hash; de constraint laat dat toe,
--    en token_sent_at vult de database ook bij het later zetten van het
--    token. Op een eigen domein blijft de code van ResoFly: die geeft alleen
--    een sleutel voor het portaal van die ene leverancier.
--
-- 2. portal_session_bind nam ook een inlog zonder aanvraagnummer aan (de code
--    uit de mail). Die route bestaat niet meer: een inlog hoort bij de link,
--    dus bij precies één aanvraag.
--
-- 3. Een eigen domein dat 'failing' werd (het record wijst niet meer naar
--    ons, of het domein is van een ander), bleef gelden voor het portaal: de
--    sleutels in de browsers bleven werken, en wie daar nu de pagina's
--    beheert, kon ze uitlezen. Nu alleen 'active'. En de sleutels van een
--    domein verdwijnen zodra het portaal er uitgaat of het domein niet meer
--    actief is: eerst bleven ze in de database staan en werkten ze weer als
--    het portaal later weer aanging.
--
-- portal_email_has_workspace (20261109020000) gebruikt portal-login niet meer:
-- zonder code van Supabase is er niets meer om voor een teamlid weg te laten.
-- Hij blijft staan (alleen voor de server), zodat een oudere functie niet
-- stukloopt.
--
-- Veilig om opnieuw te draaien.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Een aanvraag zonder token of code (nog niet ingewisseld)
-- ------------------------------------------------------------
alter table public.portal_login_requests drop constraint if exists portal_login_requests_secret_check;
alter table public.portal_login_requests add constraint portal_login_requests_secret_check
  check ((token_hash is null or code_hash is null) and (code_hash is null or code_hash ~ '^[0-9a-f]{64}$'));

comment on column public.portal_login_requests.token_hash is
  'Het token van Supabase Auth, pas gemaakt als de link in de browser van de aanvraag werd geopend (portal-login, redeemLogin). Leeg tot dan, en altijd leeg op een eigen domein.';
comment on column public.portal_login_requests.token_sent_at is
  'Wanneer Supabase Auth het token van deze aanvraag uitgaf (auth.users.recovery_sent_at, gezet bij het opslaan van het token). Bij het vastleggen moet dat nog zo zijn: anders kwam er sindsdien een ander token.';

-- Dezelfde functie als in 20261109020000, nu ook bij het later zetten van het token.
drop trigger if exists portal_login_requests_token_sent_at on public.portal_login_requests;
create trigger portal_login_requests_token_sent_at before insert or update of token_hash on public.portal_login_requests
  for each row execute function public.portal_login_requests_token_sent_at();

-- ------------------------------------------------------------
-- 2. Vastleggen alleen met het aanvraagnummer
-- ------------------------------------------------------------
-- Zie 20261109020000 voor de rest van de regels. Nieuw: zonder aanvraagnummer
-- geen inlog (na de controle op een al vastgelegde inlog, zodat een herhaalde
-- aanroep na een haperende verbinding blijft werken).
create or replace function public.portal_session_bind(
  p_session_id uuid,
  p_user_id uuid,
  p_request_hash text,
  p_verifier_hashes text[],
  p_origin_organization_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, auth
as $$
declare
  v_hashes text[] := coalesce(p_verifier_hashes, array[]::text[]);
  v_existing public.portal_sessions;
  v_email text;
  v_sent timestamptz;
  v_session_created timestamptz;
  v_request public.portal_login_requests;
begin
  if p_session_id is null or p_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'session');
  end if;

  select s.created_at into v_session_created
    from auth.sessions s
   where s.id = p_session_id and s.user_id = p_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'session');
  end if;

  -- Al vastgelegd: nog een keer dezelfde aanroep (bijvoorbeeld na een
  -- haperende verbinding) is goed; een andere aanvraag niet.
  select * into v_existing from public.portal_sessions where session_id = p_session_id;
  if found then
    if v_existing.user_id = p_user_id and exists (
      select 1 from public.portal_login_requests r
       where r.bound_session_id = p_session_id
         and r.verifier_hash = any(v_hashes)
         and (p_request_hash is null or r.request_hash = p_request_hash)
    ) then
      return jsonb_build_object('ok', true, 'organizationId', v_existing.organization_id);
    end if;
    return jsonb_build_object('ok', false, 'reason', 'bound');
  end if;

  -- Een inlog komt alleen nog uit de link, dus bij één aanvraag.
  if p_request_hash is null then
    return jsonb_build_object('ok', false, 'reason', 'request');
  end if;

  select lower(u.email), u.recovery_sent_at into v_email, v_sent
    from auth.users u where u.id = p_user_id;
  if coalesce(v_email, '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'session');
  end if;

  -- De nieuwste aanvraag voor dit adres, vergrendeld: twee keer tegelijk
  -- vastleggen gaat na elkaar.
  select * into v_request
    from public.portal_login_requests r
   where r.email = v_email
   order by r.created_at desc, r.id desc
   limit 1
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'request');
  end if;
  if v_request.request_hash <> p_request_hash then
    return jsonb_build_object('ok', false, 'reason', 'request');
  end if;
  -- Zonder token is de link nog niet in de juiste browser geopend.
  if v_request.token_hash is null or v_request.bound_session_id is not null then
    return jsonb_build_object('ok', false, 'reason', 'request');
  end if;
  if v_request.expires_at <= now() - interval '2 minutes' then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if not (v_request.verifier_hash = any(v_hashes)) then
    return jsonb_build_object('ok', false, 'reason', 'verifier');
  end if;
  if v_request.scope_organization_id is distinct from p_origin_organization_id then
    return jsonb_build_object('ok', false, 'reason', 'origin');
  end if;
  if v_request.token_sent_at is null or v_sent is distinct from v_request.token_sent_at then
    return jsonb_build_object('ok', false, 'reason', 'request');
  end if;
  if v_session_created < v_request.token_sent_at or not exists (
    select 1 from auth.mfa_amr_claims c
     where c.session_id = p_session_id
       and c.authentication_method in ('otp', 'magiclink')
       and c.created_at >= v_request.token_sent_at
  ) then
    return jsonb_build_object('ok', false, 'reason', 'method');
  end if;

  insert into public.portal_sessions (session_id, user_id, organization_id, host)
  values (p_session_id, p_user_id, v_request.scope_organization_id, v_request.host);
  update public.portal_login_requests
     set bound_session_id = p_session_id, used_at = coalesce(used_at, now())
   where id = v_request.id;
  return jsonb_build_object('ok', true, 'organizationId', v_request.scope_organization_id);
end;
$$;

revoke all on function public.portal_session_bind(uuid, uuid, text, text[], uuid) from public, anon, authenticated;
grant execute on function public.portal_session_bind(uuid, uuid, text, text[], uuid) to service_role;

-- ------------------------------------------------------------
-- 3. Een sleutel van een eigen domein: alleen op een actief domein
-- ------------------------------------------------------------
create or replace function public.portal_token_scope(p_token_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_row public.portal_tokens;
begin
  select * into v_row from public.portal_tokens where token_hash = p_token_hash;
  if not found or v_row.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'unbound');
  end if;
  -- Alleen 'active': bij 'failing' wijst het record misschien al naar een
  -- ander, en dan zijn de pagina's op dat domein niet meer van ons.
  if not exists (
    select 1 from public.client_domains d
     where d.organization_id = v_row.organization_id
       and d.hostname = v_row.host
       and d.portal_enabled
       and d.status = 'active'
  ) then
    delete from public.portal_tokens where token_hash = p_token_hash;
    return jsonb_build_object('ok', false, 'reason', 'host');
  end if;
  if v_row.last_used_at < now() - interval '1 hour' then
    update public.portal_tokens
       set last_used_at = now(), expires_at = now() + interval '30 days'
     where token_hash = p_token_hash;
  end if;
  return jsonb_build_object('ok', true, 'userId', v_row.user_id, 'organizationId', v_row.organization_id, 'host', v_row.host);
end;
$$;

revoke all on function public.portal_token_scope(text) from public, anon, authenticated;
grant execute on function public.portal_token_scope(text) to service_role;

-- Gaat het portaal op een domein uit, of is het domein niet meer actief
-- (haperend, verhuisd, verwijderd, overgenomen, uitgezet), dan zijn de
-- sleutels van dat domein meteen weg. Langs welke weg dat ook gebeurt: de
-- schakelaar, de ronde van client-domains, of de database zelf.
create or replace function public.client_domains_end_portal_tokens()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.portal_tokens where organization_id = old.organization_id and host = old.hostname;
    return old;
  end if;
  if (old.portal_enabled and not new.portal_enabled)
     or (old.status = 'active' and new.status <> 'active')
     or old.hostname <> new.hostname
     or old.organization_id <> new.organization_id then
    delete from public.portal_tokens where organization_id = old.organization_id and host = old.hostname;
  end if;
  return new;
end;
$$;

revoke all on function public.client_domains_end_portal_tokens() from public, anon, authenticated;

drop trigger if exists client_domains_end_portal_tokens on public.client_domains;
create trigger client_domains_end_portal_tokens
  after update of status, portal_enabled, hostname, organization_id or delete on public.client_domains
  for each row execute function public.client_domains_end_portal_tokens();

-- Wat er nu al staat bij een domein dat niet (meer) actief is of zonder portaal.
delete from public.portal_tokens t
 where not exists (
   select 1 from public.client_domains d
    where d.organization_id = t.organization_id
      and d.hostname = t.host
      and d.portal_enabled
      and d.status = 'active'
 );

-- ------------------------------------------------------------
-- 4. Opruimen: ook sleutels zonder actief domein met portaal
-- ------------------------------------------------------------
create or replace function public.portal_sessions_cleanup()
returns integer
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_sessions integer;
  v_tokens integer;
begin
  delete from public.portal_sessions ps
   where ps.created_at < now() - interval '1 day'
     and not exists (select 1 from auth.sessions s where s.id = ps.session_id);
  get diagnostics v_sessions = row_count;
  delete from public.portal_tokens t
   where t.expires_at < now() - interval '1 day'
      or not exists (
        select 1 from public.client_domains d
         where d.organization_id = t.organization_id
           and d.hostname = t.host
           and d.portal_enabled
           and d.status = 'active'
      );
  get diagnostics v_tokens = row_count;
  return v_sessions + v_tokens;
end;
$$;

revoke all on function public.portal_sessions_cleanup() from public, anon, authenticated;
grant execute on function public.portal_sessions_cleanup() to service_role;

commit;
