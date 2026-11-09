-- ============================================================
-- ResoFly — Het klantportaal op het eigen domein van de gebruiker
-- (portaal.fotostudiojansen.nl), met een inlog per gebruiker.
--
-- Waarom een inlog per gebruiker: een klant heeft één inlog voor het portaal
-- (zijn e-mailadres), en die geldt bij elke gebruiker van ResoFly bij wie hij
-- klant is. Na het inloggen staat die inlog in zijn browser, bij het adres
-- waar hij inlogde. De DNS van een eigen domein beheert de gebruiker zelf.
-- Wijst Fotostudio Jansen portaal.fotostudiojansen.nl later naar een eigen
-- server, dan leest een pagina daar die inlog uit, en ziet Jansen wat de klant
-- bij Drukkerij Pietersen heeft (harde regel 1). Daarom bleef het portaal tot
-- nu toe op de naam bij ResoFly (migratie 20261108230000).
--
-- Een inlog bij Supabase geldt voor het hele account. Is de klant ook
-- teamlid bij een andere gebruiker (hetzelfde e-mailadres), dan opent hij ook
-- die werkruimte. Zo'n inlog hoort dus nooit op een adres dat een gebruiker
-- zelf beheert. Daarom:
--   1. Op een eigen domein logt de klant in met een code van ResoFly zelf, en
--      krijgt hij een sleutel (portal_tokens) die alleen het portaal van die
--      ene gebruiker opent, en alleen op dat domein. Supabase Auth maakt daar
--      geen inlog: wie de DNS omlegt, leest hooguit een sleutel voor het
--      portaal van zijn eigen klanten uit.
--   2. Op de naam bij ResoFly en het algemene portaal blijft het een inlog
--      bij Supabase, maar ook die legt de server nu vast (portal_sessions),
--      met wat hij mag zien: op de naam bij ResoFly alleen die gebruiker, op
--      het algemene portaal alles. client-portal weigert een inlog die er
--      niet staat. Zo helpt ook een wachtwoord niets dat iemand met een
--      uitgelekt token instelt: daarmee ontstaat een inlog die hier nooit komt.
--   3. portal_login_requests krijgt het bereik van de aanvraag (naar het
--      adres waar hij gedaan werd), de code van ResoFly (op een eigen domein),
--      het moment van het token van Supabase (de rest), en de inlog die eruit
--      kwam: één aanvraag, één inlog.
--   4. client_domains.portal_enabled: het portaal ook op het eigen domein
--      (Instellingen → Domein). Standaard uit.
--
-- Alleen de server leest en schrijft in de nieuwe tabel. Veilig om opnieuw te
-- draaien.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Het portaal op het eigen domein: een keuze van de gebruiker
-- ------------------------------------------------------------
alter table public.client_domains
  add column if not exists portal_enabled boolean not null default false;

comment on column public.client_domains.portal_enabled is
  'Ook het klantportaal op dit domein (Instellingen → Domein). Inloggen gaat daar met een code van ResoFly en een sleutel voor alleen deze organisatie (portal_tokens), nooit met een inlog bij Supabase.';

-- ------------------------------------------------------------
-- 2. Een aanvraag weet voor welk adres hij was, en welke inlog eruit kwam
-- ------------------------------------------------------------
alter table public.portal_login_requests
  add column if not exists scope_organization_id uuid references public.organizations(id) on delete cascade,
  add column if not exists host text,
  add column if not exists bound_session_id uuid,
  add column if not exists code_hash text,
  add column if not exists token_sent_at timestamptz;

-- Op een eigen domein geen token van Supabase maar een code van ResoFly: dan
-- is token_hash leeg en code_hash gevuld. Precies één van de twee.
alter table public.portal_login_requests alter column token_hash drop not null;
alter table public.portal_login_requests drop constraint if exists portal_login_requests_secret_check;
alter table public.portal_login_requests add constraint portal_login_requests_secret_check
  check ((token_hash is null) <> (code_hash is null) and (code_hash is null or code_hash ~ '^[0-9a-f]{64}$'));

comment on column public.portal_login_requests.scope_organization_id is
  'Wat de inlog uit deze aanvraag mag zien: alleen deze organisatie (aangevraagd op haar adres), of alles (null: het algemene portaal).';
comment on column public.portal_login_requests.host is
  'Het adres waarop de klant de inlog aanvroeg. De link in de mail gaat daarheen: daar staat het geheim van zijn browser.';
comment on column public.portal_login_requests.bound_session_id is
  'De inlog (auth.sessions.id) die uit deze aanvraag kwam. Eén aanvraag, één inlog.';
comment on column public.portal_login_requests.code_hash is
  'Op een eigen domein: sha256(request_hash:code) van de code van ResoFly. Daar maakt Supabase Auth geen inlog.';
comment on column public.portal_login_requests.token_sent_at is
  'Wanneer Supabase Auth het token van deze aanvraag uitgaf (auth.users.recovery_sent_at, gezet bij het opslaan). Bij het vastleggen moet dat nog zo zijn: anders kwam er sindsdien een ander token.';

-- Het moment van het token komt uit de database, niet uit het antwoord van
-- Supabase Auth: dan is het precies dezelfde waarde als in auth.users, en kan
-- portal_session_bind ze vergelijken zonder klokken naast elkaar te leggen.
create or replace function public.portal_login_requests_token_sent_at()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if new.token_hash is not null then
    select u.recovery_sent_at into new.token_sent_at
      from auth.users u
     where lower(u.email) = lower(new.email)
     order by u.created_at
     limit 1;
  else
    new.token_sent_at := null;
  end if;
  return new;
end;
$$;

revoke all on function public.portal_login_requests_token_sent_at() from public, anon, authenticated;

drop trigger if exists portal_login_requests_token_sent_at on public.portal_login_requests;
create trigger portal_login_requests_token_sent_at before insert on public.portal_login_requests
  for each row execute function public.portal_login_requests_token_sent_at();

create unique index if not exists portal_login_requests_bound_session_key
  on public.portal_login_requests (bound_session_id) where bound_session_id is not null;
-- De nieuwste aanvraag per adres (portal_session_bind).
create index if not exists portal_login_requests_email_idx
  on public.portal_login_requests (email, created_at desc);

-- ------------------------------------------------------------
-- 3. De inloggen in het portaal, met wat ze mogen zien
-- ------------------------------------------------------------
create table if not exists public.portal_sessions (
  -- De sessie bij Supabase Auth (de claim session_id in het token). Blijft
  -- gelijk bij het verversen van het token.
  session_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Null = alles (het algemene portaal); anders alleen deze organisatie.
  organization_id uuid references public.organizations(id) on delete cascade,
  -- Waar de klant inlogde: de naam bij ResoFly van die organisatie (die moet
  -- van haar blijven, portal_session_scope), of het algemene portaal.
  host text,
  created_at timestamptz not null default now()
);

comment on table public.portal_sessions is
  'Elke inlog in het klantportaal, met wat hij mag zien (één organisatie of alles). client-portal weigert een inlog die hier niet staat. Alleen de server leest en schrijft hier.';

create index if not exists portal_sessions_user_idx on public.portal_sessions (user_id);
create index if not exists portal_sessions_org_idx on public.portal_sessions (organization_id) where organization_id is not null;

alter table public.portal_sessions enable row level security;
revoke all on table public.portal_sessions from public, anon, authenticated;
grant all on table public.portal_sessions to service_role;
select public.apply_accountant_fence('portal_sessions');

-- De sleutels van het portaal op een eigen domein. Geen inlog bij Supabase:
-- een willekeurige waarde (hier als sha256) die client-portal alleen voor
-- deze organisatie en alleen vanaf dit domein aanneemt.
create table if not exists public.portal_tokens (
  token_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Het eigen domein: het portaal moet daar aan blijven staan (portal_token_scope).
  host text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  -- Een maand na het laatste gebruik.
  expires_at timestamptz not null,
  constraint portal_tokens_hash_check check (token_hash ~ '^[0-9a-f]{64}$')
);

comment on table public.portal_tokens is
  'De sleutels van het klantportaal op een eigen domein (portal-login, met de code van ResoFly). Alleen voor die ene organisatie, alleen op dat domein. Alleen de server leest en schrijft hier.';

create index if not exists portal_tokens_user_idx on public.portal_tokens (user_id);
create index if not exists portal_tokens_org_idx on public.portal_tokens (organization_id);
create index if not exists portal_tokens_expires_idx on public.portal_tokens (expires_at);

alter table public.portal_tokens enable row level security;
revoke all on table public.portal_tokens from public, anon, authenticated;
grant all on table public.portal_tokens to service_role;
select public.apply_accountant_fence('portal_tokens');

-- Het account bij een e-mailadres: de sleutel hoort bij een gebruiker (tickets
-- en berichten noemen hem). portal-login maakte het account al aan.
create or replace function public.portal_user_id(p_email text)
returns uuid
language sql
stable
security definer
set search_path = public, auth
as $$
  select u.id from auth.users u
   where lower(u.email) = lower(btrim(coalesce(p_email, '')))
   order by u.created_at
   limit 1;
$$;

revoke all on function public.portal_user_id(text) from public, anon, authenticated;
grant execute on function public.portal_user_id(text) to service_role;

-- De code van ResoFly inwisselen (portal-login, actie redeemCode). In één
-- keer, met de aanvraag vergrendeld: eerst las de functie het aantal pogingen
-- en schreef ze het daarna terug, en wie veel pogingen tegelijk afvuurde, kreeg
-- er zo meer dan vijf per code. Nu telt elke poging, ook tegelijk. Alleen de
-- nieuwste aanvraag met een code voor dit adres op dit domein telt; vijf keer
-- mis (net als LOGIN_REQUEST_MAX_ATTEMPTS in portal-login) en hij is op.
create or replace function public.portal_code_redeem(p_email text, p_organization_id uuid, p_host text, p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_row public.portal_login_requests;
begin
  select * into v_row
    from public.portal_login_requests r
   where r.email = lower(btrim(coalesce(p_email, '')))
     and r.scope_organization_id = p_organization_id
     and r.host = p_host
     and r.code_hash is not null
   order by r.created_at desc, r.id desc
   limit 1
   for update;
  if not found or v_row.used_at is not null or v_row.expires_at <= now() then
    return jsonb_build_object('ok', false);
  end if;
  if coalesce(p_code, '') !~ '^[0-9]{8}$'
     or encode(sha256(convert_to(v_row.request_hash || ':' || p_code, 'UTF8')), 'hex') <> v_row.code_hash then
    update public.portal_login_requests
       set attempts = attempts + 1,
           used_at = case when attempts + 1 >= 5 then now() else used_at end
     where id = v_row.id;
    return jsonb_build_object('ok', false);
  end if;
  update public.portal_login_requests set used_at = now() where id = v_row.id;
  return jsonb_build_object(
    'ok', true,
    'email', v_row.email,
    'organizationId', v_row.scope_organization_id,
    'host', v_row.host,
    'brandOrganizationId', v_row.organization_id
  );
end;
$$;

revoke all on function public.portal_code_redeem(text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.portal_code_redeem(text, uuid, text, text) to service_role;

-- Heeft dit adres ook een werkruimte (teamlid, of uitgenodigd)? Dan zet
-- portal-login geen code van Supabase in de inlogmail, alleen de link: die
-- werkt alleen in de browser die hem aanvroeg. Een code kan elke website
-- vragen, en een inlog bij Supabase opent voor hem ook de werkruimte.
create or replace function public.portal_email_has_workspace(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select public.normalize_client_lookup_value(p_email) is not null and (
    exists (
      select 1 from public.organization_members m
        join auth.users u on u.id = m.user_id
       where m.status = 'active'
         and public.normalize_client_lookup_value(u.email) = public.normalize_client_lookup_value(p_email)
    )
    or exists (
      select 1 from public.organization_members m
       where m.status = 'active'
         and public.normalize_client_lookup_value(m.email::text) = public.normalize_client_lookup_value(p_email)
    )
    or exists (
      select 1 from public.organization_invitations i
       where i.status = 'pending'
         and (i.expires_at is null or i.expires_at > now())
         and public.normalize_client_lookup_value(i.email::text) = public.normalize_client_lookup_value(p_email)
    )
  );
$$;

revoke all on function public.portal_email_has_workspace(text) from public, anon, authenticated;
grant execute on function public.portal_email_has_workspace(text) to service_role;

-- ------------------------------------------------------------
-- 4. Een verse inlog vastleggen (portal-login, actie bindSession)
-- ------------------------------------------------------------
-- Op de naam bij ResoFly en het algemene portaal wisselt de browser de link
-- of de code uit de mail zelf in bij Supabase (de remmen daar tellen per
-- klant, niet per server). Daarna legt hij de inlog hier vast. Wat bewijst
-- dat deze inlog uit déze aanvraag kwam:
--   - Supabase bewaart per account één inlogtoken: elke nieuwe aanvraag maakt
--     de vorige ongeldig (getest: "otp_expired"). Daarom alleen de nieuwste
--     aanvraag voor dat adres. Eerst mocht ook een oudere aanvraag van
--     dezelfde browser; dan kon iemand een eigen aanvraag op het algemene
--     portaal klaarzetten en daar een inlog van zijn eigen adres aan hangen.
--   - sinds die aanvraag gaf Supabase geen nieuw token uit:
--     auth.users.recovery_sent_at is nog precies wat het bij het opslaan was;
--   - de sessie, en de inlog via de mail (methode otp), begonnen ná dat token.
--     Dat zijn tijden van dezelfde klok (Supabase Auth). Eerst stond hier een
--     minuut speling ten opzichte van de aanvraag; dan kon wie een verse inlog
--     onderschepte, snel daarna een eigen aanvraag doen en de inlog daaraan
--     hangen;
--   - de browser kent het geheim van die aanvraag (verifier_hash).
-- Een sessie met een wachtwoord of een oudere sessie telt niet. Het bereik
-- komt uit de aanvraag, nooit uit deze aanroep. Een aanvraag op een eigen
-- domein (een code van ResoFly) maakt geen inlog bij Supabase en wordt hier
-- dus nooit vastgelegd.
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
  if p_request_hash is not null and v_request.request_hash <> p_request_hash then
    return jsonb_build_object('ok', false, 'reason', 'request');
  end if;
  if v_request.token_hash is null or v_request.bound_session_id is not null then
    return jsonb_build_object('ok', false, 'reason', 'request');
  end if;
  -- Twee minuten speling: wie de code op het laatste moment invult, is nog
  -- onderweg naar hier.
  if v_request.expires_at <= now() - interval '2 minutes' then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if not (v_request.verifier_hash = any(v_hashes)) then
    return jsonb_build_object('ok', false, 'reason', 'verifier');
  end if;
  -- Aangevraagd op het ene adres, vastgelegd vanaf een ander: voor een
  -- gewone browser kan dat niet (het geheim staat bij het adres).
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
-- 5. Wat mag deze inlog zien? (client-portal, bij elke aanroep)
-- ------------------------------------------------------------
-- Een inlog bij Supabase voor één organisatie geldt zolang de naam bij
-- ResoFly waarop hij ontstond, van die organisatie is. Een oude naam is een
-- jaar na een naamswissel weer vrij; wie hem dan kiest, toont daar het
-- portaal, en dat leest de inloggen die daar nog in een browser staan. Die
-- geven dan niets meer.
create or replace function public.portal_session_scope(p_session_id uuid, p_user_id uuid, p_base text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_row public.portal_sessions;
  v_base text := lower(btrim(coalesce(p_base, '')));
begin
  select * into v_row from public.portal_sessions where session_id = p_session_id;
  if not found or v_row.user_id is distinct from p_user_id then
    return jsonb_build_object('ok', false, 'reason', 'unbound');
  end if;
  if v_row.organization_id is null then
    return jsonb_build_object('ok', true, 'organizationId', null);
  end if;
  if v_row.host is not null and v_base <> '' and exists (
    select 1 from public.client_subdomains s
     where s.organization_id = v_row.organization_id
       and s.status = 'active'
       and v_row.host = s.name || '.' || v_base
  ) then
    return jsonb_build_object('ok', true, 'organizationId', v_row.organization_id);
  end if;
  return jsonb_build_object('ok', false, 'reason', 'host');
end;
$$;

revoke all on function public.portal_session_scope(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.portal_session_scope(uuid, uuid, text) to service_role;

-- Een sleutel van het portaal op een eigen domein: geldig zolang het domein
-- van die organisatie is en het portaal er aan staat. Anders weg ermee. Bij
-- gebruik schuift de geldigheid op (hooguit eens per uur een schrijfactie).
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
  if not exists (
    select 1 from public.client_domains d
     where d.organization_id = v_row.organization_id
       and d.hostname = v_row.host
       and d.portal_enabled
       and d.status in ('active', 'failing')
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

-- ------------------------------------------------------------
-- 6. Opruimen
-- ------------------------------------------------------------
-- Een inlog die Supabase Auth niet meer kent (uitgelogd of verlopen), na een
-- dag, en verlopen sleutels van een eigen domein. De ronde van client-domains
-- (elk kwartier) roept dit aan.
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
  delete from public.portal_tokens where expires_at < now() - interval '1 day';
  get diagnostics v_tokens = row_count;
  return v_sessions + v_tokens;
end;
$$;

revoke all on function public.portal_sessions_cleanup() from public, anon, authenticated;
grant execute on function public.portal_sessions_cleanup() to service_role;

commit;
