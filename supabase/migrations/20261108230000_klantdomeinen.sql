-- ============================================================
-- ResoFly — Een eigen adres voor alles wat de klant ziet
-- Date: 2026-11-08
--
-- Vraag: "Gebruikers (klanten van resofly) moeten gebruik kunnen maken van
-- een eigen subdomein om te communiceren naar klanten, opleveren albums,
-- mails, klantportalen, etc." En daarna: bij het inrichten van de
-- organisatie kies je meteen een adres, en de app zegt of een naam al
-- bestaat. Het plan staat in docs/plannen/EIGEN_SUBDOMEIN_PLAN_2026-11-08.md.
--
-- Tot nu toe kwam elke klant van elke organisatie op hetzelfde adres van
-- ResoFly uit (/portal, /gallerij/…, /invoice/…). Alleen de huisstijl
-- verschilde; het adres in de balk en in elke mail was dat van ResoFly.
--
-- Nu:
--   1. client_subdomains: per organisatie een naam, het webadres
--      <naam>.<basisdomein> (bijvoorbeeld jansen.resofly.com). Een naam is
--      uniek over alle organisaties. Na een wijziging stuurt de oude naam nog
--      twaalf maanden door (status 'redirect'). Anders werken links in al
--      verstuurde mails niet meer, en kan een ander de oude naam nemen en
--      zo die klanten opvangen.
--   2. client_subdomain_check(): bestaat een naam al? Voor het scherm, terwijl
--      iemand typt. client_subdomain_claim(): een naam vastleggen of wijzigen,
--      alleen door de eigenaar of een beheerder van díe organisatie. De
--      organisatie komt uit de aanroep, de rol uit de sessie (auth.uid()).
--   3. client_domains: een eigen domein (portaal.jansen.nl) via Cloudflare for
--      SaaS. Alleen de edge function client-domains schrijft hier: die praat
--      met Cloudflare en weet of het record er echt staat.
--   4. portal_login_requests: de inlogmail van het klantportaal komt voortaan
--      van ResoFly zelf (portal-login), met een link naar het adres van de
--      organisatie. Nu stuurt Supabase een Engelse standaardmail ("Your Magic
--      Link") die alleen op het adres van ResoFly werkt. Alleen de server
--      leest en schrijft hier.
--   5. complete_organization_onboarding() rondt pas af als de organisatie een
--      webadres heeft. Zelfde functie als in 20261107190000, met die eis erbij.
--   6. Het logboek: een gekozen of gewijzigd webadres komt erin, en de edge
--      function schrijft regels voor een eigen domein. Beide bij Beheer: alleen
--      owners en admins lezen ze.
--
-- Veilig om opnieuw te draaien.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Welke naam mag
-- ------------------------------------------------------------
-- Eén plek voor de regels: de controle tijdens het typen en het vastleggen
-- gebruiken allebei deze functie, en de app toont de zin bij de code. Een
-- naam wordt een DNS-label: kleine letters, cijfers en streepjes. Geen twee
-- streepjes achter elkaar: zo kan niemand een punycode-naam (xn--…) maken
-- die er in de adresbalk als een andere naam uitziet.
--
-- Gereserveerd: namen die ResoFly zelf gebruikt of nodig kan hebben, en
-- namen van banken, betaaldiensten en de overheid. Een klantpagina op
-- rabobank.resofly.com is een cadeau voor wie wil oplichten.
create or replace function public.client_subdomain_problem(p_name text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v text := coalesce(p_name, '');
begin
  if length(v) < 3 then return 'te_kort'; end if;
  if length(v) > 40 then return 'te_lang'; end if;
  if v !~ '^[a-z0-9-]+$' then return 'tekens'; end if;
  if left(v, 1) = '-' or right(v, 1) = '-' or position('--' in v) > 0 then return 'streepje'; end if;
  if v ~ '^[0-9-]+$' then return 'alleen_cijfers'; end if;
  if v = any (array[
    'www', 'app', 'apps', 'api', 'admin', 'beheer', 'beheerder', 'staging', 'test', 'tests', 'demo', 'dev', 'develop',
    'development', 'prod', 'production', 'preview', 'beta', 'alpha', 'sandbox', 'localhost', 'mail', 'email', 'e-mail',
    'smtp', 'imap', 'pop', 'pop3', 'mx', 'ns', 'ns1', 'ns2', 'ns3', 'dns', 'ftp', 'sftp', 'ssh', 'vpn', 'webmail', 'send',
    'bounce', 'reply', 'antwoord', 'inbound', 'caldav', 'carddav', 'media', 'cdn', 'static', 'assets', 'img', 'images',
    'files', 'download', 'downloads', 'upload', 'uploads', 'status', 'docs', 'help', 'support', 'hulp', 'blog', 'login',
    'inloggen', 'logout', 'auth', 'sso', 'oauth', 'account', 'accounts', 'register', 'signup', 'aanmelden', 'billing',
    'betalen', 'pay', 'payment', 'payments', 'factuur', 'facturen', 'invoice', 'invoices', 'offerte', 'offertes', 'quote',
    'portal', 'portaal', 'klant', 'klanten', 'klantportaal', 'domein', 'domeinen', 'dashboard', 'werkruimte', 'workspace',
    'gerrie', 'mcp', 'office', 'collabora', 'wopi', 'voorbeeld', 'example', 'root', 'system', 'systeem', 'security',
    'abuse', 'postmaster', 'hostmaster', 'webmaster', 'noreply', 'no-reply', 'info', 'contact', 'privacy', 'terms', 'legal',
    'ing', 'sns', 'asn', 'regiobank', 'bunq', 'knab', 'triodos', 'mollie', 'ideal', 'stripe', 'adyen', 'klarna', 'kvk',
    'mijnoverheid', 'overheid', 'politie', 'postnl', 'dhl', 'microsoft', 'google', 'apple', 'outlook', 'office365',
    'gmail', 'icloud', 'whatsapp', 'facebook', 'instagram', 'zendflix'
  ]) then
    return 'gereserveerd';
  end if;
  if v ~ '(resofly|brandcore|rabobank|abnamro|abn-amro|belastingdienst|digid|paypal)' then
    return 'gereserveerd';
  end if;
  return null;
end;
$$;

revoke all on function public.client_subdomain_problem(text) from public, anon;
grant execute on function public.client_subdomain_problem(text) to authenticated, service_role;

-- De zin bij een code, voor een foutmelding uit de database. De app heeft
-- dezelfde zinnen (src/lib/clientDomains.ts).
create or replace function public.client_subdomain_problem_text(p_code text)
returns text
language sql
immutable
set search_path = public
as $$
  select case p_code
    when 'te_kort' then 'Kies een naam van minstens 3 tekens.'
    when 'te_lang' then 'Kies een naam van hooguit 40 tekens.'
    when 'tekens' then 'Gebruik alleen kleine letters, cijfers en streepjes.'
    when 'streepje' then 'Een streepje mag niet aan het begin of eind staan, en niet twee keer achter elkaar.'
    when 'alleen_cijfers' then 'Gebruik ook letters, niet alleen cijfers.'
    when 'gereserveerd' then 'Deze naam is niet beschikbaar. Kies een andere.'
    else 'Deze naam kan niet.'
  end;
$$;

revoke all on function public.client_subdomain_problem_text(text) from public, anon;
grant execute on function public.client_subdomain_problem_text(text) to authenticated, service_role;

-- ------------------------------------------------------------
-- 2. De naam per organisatie
-- ------------------------------------------------------------
create table if not exists public.client_subdomains (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  -- active   = het adres van de organisatie;
  -- redirect = een oude naam, die tot redirect_until naar de nieuwe stuurt;
  -- blocked  = uitgezet door ResoFly (misbruik). Alleen de server zet dit.
  status text not null default 'active',
  redirect_until timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Alleen de vorm, niet de lijst met gereserveerde namen: die lijst kan
  -- later groeien, en dan mag een bestaande rij nog steeds van status wisselen.
  constraint client_subdomains_name_check check (name ~ '^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$' and position('--' in name) = 0),
  constraint client_subdomains_status_check check (status in ('active', 'redirect', 'blocked')),
  constraint client_subdomains_redirect_check check ((status = 'redirect') = (redirect_until is not null))
);

comment on table public.client_subdomains is
  'Het webadres van een organisatie: <name>.<basisdomein>. Eén actieve naam per organisatie; oude namen sturen twaalf maanden door. Schrijven alleen via client_subdomain_claim() of de server.';

create unique index if not exists client_subdomains_name_key on public.client_subdomains (name);
create unique index if not exists client_subdomains_one_active on public.client_subdomains (organization_id) where status = 'active';
create index if not exists client_subdomains_org_idx on public.client_subdomains (organization_id);

drop trigger if exists set_client_subdomains_updated_at on public.client_subdomains;
create trigger set_client_subdomains_updated_at before update on public.client_subdomains
  for each row execute function public.set_updated_at();

alter table public.client_subdomains enable row level security;
revoke all on table public.client_subdomains from public, anon, authenticated;
grant select on table public.client_subdomains to authenticated;
grant all on table public.client_subdomains to service_role;

drop policy if exists "client subdomains read by org members" on public.client_subdomains;
create policy "client subdomains read by org members" on public.client_subdomains
  for select to authenticated using (public.can_read_org(organization_id));

-- Het boekhouder-hek (20261011000000): elke organisatietabel heeft een module
-- gate of dit hek, anders slaat de rooktest na de uitrol alarm.
select public.apply_accountant_fence('client_subdomains');

-- Bestaat een naam al? Voor het scherm, tijdens het typen. Elke ingelogde
-- gebruiker mag het vragen: een naam is een openbaar adres, en wie een
-- organisatie inricht, moet kunnen zien of zijn naam nog vrij is.
-- Alleen de eigen organisatie hoort "own"; van een andere organisatie zie je
-- alleen dat de naam bezet is, niet van wie.
create or replace function public.client_subdomain_check(p_name text, p_organization_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_name text := lower(btrim(coalesce(p_name, '')));
  v_problem text;
  v_row public.client_subdomains;
begin
  if auth.uid() is null and auth.role() is distinct from 'service_role' then
    raise exception 'Niet ingelogd' using errcode = '28000';
  end if;
  v_problem := public.client_subdomain_problem(v_name);
  if v_problem is not null then
    return jsonb_build_object(
      'name', v_name,
      'status', case when v_problem = 'gereserveerd' then 'reserved' else 'invalid' end,
      'reason', v_problem,
      'message', public.client_subdomain_problem_text(v_problem));
  end if;

  select * into v_row from public.client_subdomains where name = v_name;
  -- Een oude naam waarvan de doorstuurtijd voorbij is, is weer vrij.
  if not found or (v_row.status = 'redirect' and v_row.redirect_until <= now()) then
    return jsonb_build_object('name', v_name, 'status', 'available');
  end if;
  if p_organization_id is not null and v_row.organization_id = p_organization_id
     and v_row.status <> 'blocked' and public.can_read_org(p_organization_id) then
    return jsonb_build_object('name', v_name, 'status', case when v_row.status = 'active' then 'own' else 'own_previous' end);
  end if;
  return jsonb_build_object('name', v_name, 'status', 'taken', 'message', 'Dit adres bestaat al. Kies een andere naam.');
end;
$$;

revoke all on function public.client_subdomain_check(text, uuid) from public, anon;
grant execute on function public.client_subdomain_check(text, uuid) to authenticated, service_role;

-- Een naam vastleggen of wijzigen. Alleen de eigenaar of een beheerder van
-- die organisatie. De huidige naam stuurt daarna twaalf maanden door. Een
-- eigen oude naam die nog doorstuurt, kun je terugnemen.
create or replace function public.client_subdomain_claim(p_organization_id uuid, p_name text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_name text := lower(btrim(coalesce(p_name, '')));
  v_problem text;
  v_current public.client_subdomains;
  v_existing public.client_subdomains;
  v_redirects integer;
begin
  if v_user is null then
    raise exception 'Niet ingelogd' using errcode = '28000';
  end if;
  if p_organization_id is null then
    raise exception 'Organisatie ontbreekt' using errcode = '22023';
  end if;
  -- Wie geen lid is, krijgt dezelfde melding als wie de verkeerde rol heeft:
  -- zo is dit geen manier om na te gaan welke organisaties er bestaan.
  if not public.user_has_org_role(p_organization_id, array['owner', 'admin']) then
    raise exception 'Alleen de eigenaar of een beheerder kan het webadres kiezen.' using errcode = '42501';
  end if;
  -- Door ResoFly uitgezet (misbruik): dan ook geen nieuwe naam. Anders zet je
  -- het adres met één klik weer aan onder een andere naam.
  if exists (select 1 from public.client_subdomains
              where organization_id = p_organization_id and status = 'blocked') then
    raise exception 'Je webadres is door ResoFly uitgezet. Neem contact op met ResoFly.' using errcode = '42501';
  end if;
  v_problem := public.client_subdomain_problem(v_name);
  if v_problem is not null then
    raise exception '%', public.client_subdomain_problem_text(v_problem) using errcode = '22023';
  end if;

  -- Twee tabbladen die tegelijk kiezen: na elkaar.
  perform pg_advisory_xact_lock(hashtextextended('client_subdomains:' || p_organization_id::text, 0));

  select * into v_current from public.client_subdomains
   where organization_id = p_organization_id and status = 'active';
  if v_current.id is not null and v_current.name = v_name then
    return jsonb_build_object('name', v_name, 'previous', null, 'changed', false);
  end if;

  -- Een oude naam waarvan de doorstuurtijd voorbij is: weer vrij.
  delete from public.client_subdomains
   where name = v_name and status = 'redirect' and redirect_until <= now();

  select * into v_existing from public.client_subdomains where name = v_name;
  if v_existing.id is not null and (v_existing.organization_id <> p_organization_id or v_existing.status = 'blocked') then
    raise exception 'Het adres % bestaat al. Kies een andere naam.', v_name using errcode = '23505';
  end if;

  -- Niet onbeperkt namen vasthouden door steeds te wisselen: elke oude naam
  -- blijft een jaar van deze organisatie.
  if v_current.id is not null and v_existing.id is null then
    select count(*) into v_redirects from public.client_subdomains
     where organization_id = p_organization_id and status = 'redirect' and redirect_until > now();
    if v_redirects >= 5 then
      -- P0001: PostgREST maakt er een 400 van. Met 54000 werd het een 500,
      -- alsof de server stuk was.
      raise exception 'Je hebt je webadres het afgelopen jaar al vaak gewijzigd. Neem contact op met ResoFly als het toch anders moet.'
        using errcode = 'P0001';
    end if;
  end if;

  if v_current.id is not null then
    update public.client_subdomains
       set status = 'redirect', redirect_until = now() + interval '12 months'
     where id = v_current.id;
  end if;

  if v_existing.id is not null then
    update public.client_subdomains set status = 'active', redirect_until = null where id = v_existing.id;
  else
    begin
      insert into public.client_subdomains (organization_id, name, status, created_by)
      values (p_organization_id, v_name, 'active', v_user);
    exception when unique_violation then
      raise exception 'Het adres % bestaat al. Kies een andere naam.', v_name using errcode = '23505';
    end;
  end if;

  -- Het eigen inlogadres van het portaal hoort erbij: de Worker toont op het
  -- webadres meteen het inlogscherm in de huisstijl (zie portal-login).
  perform public.ensure_portal_login_key(p_organization_id);

  return jsonb_build_object('name', v_name, 'previous', v_current.name, 'changed', true);
end;
$$;

revoke all on function public.client_subdomain_claim(uuid, text) from public, anon;
grant execute on function public.client_subdomain_claim(uuid, text) to authenticated, service_role;

-- In het logboek, bij Beheer (audit_entity_module hieronder).
drop trigger if exists client_subdomains_audit on public.client_subdomains;
create trigger client_subdomains_audit after insert or update or delete on public.client_subdomains
  for each row execute function public.audit_row_change('client_subdomain', 'name');

-- ------------------------------------------------------------
-- 3. Een eigen domein (Cloudflare for SaaS)
-- ------------------------------------------------------------
create table if not exists public.client_domains (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Kleine letters, punycode, zonder punt aan het eind. Altijd een subdomein:
  -- op een hoofddomein mag geen CNAME staan.
  hostname text not null,
  -- pending_dns         = het record staat er nog niet;
  -- pending_certificate = het record staat er, het certificaat komt;
  -- active              = klaar, links gaan hierheen;
  -- failing             = was actief, maar het record of certificaat hapert;
  -- moved               = verwijderd, oude links sturen door tot redirect_until;
  -- removed             = weg (ook bij Cloudflare);
  -- blocked             = uitgezet door ResoFly.
  status text not null default 'pending_dns',
  cf_custom_hostname_id text,
  cf_state jsonb not null default '{}'::jsonb,
  -- Ooit actief geweest: dan blijft hij van deze organisatie, ook als hij hapert.
  verified_at timestamptz,
  last_checked_at timestamptz,
  redirect_until timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_domains_hostname_check check (
    length(hostname) <= 253
    and hostname ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
  ),
  constraint client_domains_status_check check (status in ('pending_dns', 'pending_certificate', 'active', 'failing', 'moved', 'removed', 'blocked')),
  constraint client_domains_redirect_check check ((status = 'moved') = (redirect_until is not null))
);

comment on table public.client_domains is
  'Een eigen domein van een organisatie (portaal.jansen.nl), via Cloudflare for SaaS. Alleen de edge function client-domains schrijft hier.';

-- Eén levende rij per hostnaam over alle organisaties, en per organisatie één
-- eigen domein tegelijk (plus oude die nog doorsturen).
create unique index if not exists client_domains_hostname_live on public.client_domains (hostname) where status not in ('removed');
create unique index if not exists client_domains_one_live on public.client_domains (organization_id)
  where status in ('pending_dns', 'pending_certificate', 'active', 'failing', 'blocked');
create index if not exists client_domains_org_idx on public.client_domains (organization_id);
create index if not exists client_domains_check_idx on public.client_domains (status, last_checked_at);

drop trigger if exists set_client_domains_updated_at on public.client_domains;
create trigger set_client_domains_updated_at before update on public.client_domains
  for each row execute function public.set_updated_at();

alter table public.client_domains enable row level security;
revoke all on table public.client_domains from public, anon, authenticated;
grant select on table public.client_domains to authenticated;
grant all on table public.client_domains to service_role;

drop policy if exists "client domains read by org members" on public.client_domains;
create policy "client domains read by org members" on public.client_domains
  for select to authenticated using (public.can_read_org(organization_id));

select public.apply_accountant_fence('client_domains');

-- ------------------------------------------------------------
-- 4. Inloggen in het klantportaal
-- ------------------------------------------------------------
-- Eén rij per aangevraagde inlogmail. De mail bevat alleen een willekeurig
-- aanvraagnummer (hier als sha256), nooit het token zelf. Het token geeft de
-- server pas aan de browser die met zijn eigen geheim (verifier_hash) bewijst
-- dat hij de aanvraag deed: zo werkt de link, net als met PKCE, alleen in de
-- browser die hem aanvroeg. token_hash is de waarde die Supabase Auth zelf
-- ook bewaart (auth.users); hier staat hij een kwartier.
create table if not exists public.portal_login_requests (
  id uuid primary key default gen_random_uuid(),
  request_hash text not null,
  -- Null = het algemene portaal van ResoFly (geen organisatie bekend).
  organization_id uuid references public.organizations(id) on delete cascade,
  email text not null,
  token_hash text not null,
  verifier_hash text not null,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint portal_login_requests_hash_check check (request_hash ~ '^[0-9a-f]{64}$' and verifier_hash ~ '^[0-9a-f]{64}$')
);

comment on table public.portal_login_requests is
  'Aangevraagde inlogmails van het klantportaal (portal-login). Alleen de server leest en schrijft hier; een kwartier geldig, één keer te gebruiken.';

create unique index if not exists portal_login_requests_hash_key on public.portal_login_requests (request_hash);
create index if not exists portal_login_requests_expires_idx on public.portal_login_requests (expires_at);

alter table public.portal_login_requests enable row level security;
revoke all on table public.portal_login_requests from public, anon, authenticated;
grant all on table public.portal_login_requests to service_role;
select public.apply_accountant_fence('portal_login_requests');

-- ------------------------------------------------------------
-- 5. Afronden van de inrichting: ook een webadres
--    (zelfde functie als in 20261107190000, met de eis van het webadres)
-- ------------------------------------------------------------
create or replace function public.complete_organization_onboarding(
  p_organization_id uuid,
  p_display_name text default null
)
returns public.organizations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_org public.organizations;
  v_company_name text;
  v_trade_name text;
  v_name text;
begin
  if v_user_id is null then
    raise exception 'Niet ingelogd' using errcode = '28000';
  end if;
  if p_organization_id is null then
    raise exception 'Organisatie ontbreekt' using errcode = '22023';
  end if;
  -- De organisatie komt uit de aanroep, de rol uit de sessie (auth.uid()).
  -- Wie geen lid is, krijgt dezelfde melding als wie de verkeerde rol heeft:
  -- zo is dit geen manier om na te gaan welke organisaties er bestaan.
  if not public.user_has_org_role(p_organization_id, array['owner', 'admin']) then
    raise exception 'Alleen de eigenaar of een beheerder kan de organisatie inrichten.'
      using errcode = '42501';
  end if;

  select * into v_org from public.organizations where id = p_organization_id for update;
  if not found then
    raise exception 'Organisatie niet gevonden' using errcode = 'P0002';
  end if;
  -- Al afgerond, in een ander tabblad of met een dubbele klik: niets te doen.
  if v_org.onboarding_completed_at is not null then
    return v_org;
  end if;

  select nullif(btrim(cs.company_name), ''), nullif(btrim(cs.trade_name), '')
    into v_company_name, v_trade_name
  from public.company_settings cs
  where cs.organization_id = p_organization_id;
  if v_company_name is null then
    raise exception 'Vul eerst de naam van je bedrijf in.' using errcode = '23514';
  end if;

  -- Het webadres voor de klanten (klantportaal, albums, offertes, facturen)
  -- kies je bij het inrichten, niet later: elke mail aan een klant linkt
  -- ernaar.
  if not exists (
    select 1 from public.client_subdomains s
     where s.organization_id = p_organization_id and s.status = 'active'
  ) then
    raise exception 'Kies eerst het webadres voor je klanten.' using errcode = '23514';
  end if;

  -- De naam in ResoFly: wat de app meegeeft (de handelsnaam of de
  -- bedrijfsnaam), anders die uit de bedrijfsgegevens. Op één regel en
  -- hooguit 120 tekens, net als in de organisatiekiezer.
  v_name := left(btrim(regexp_replace(
    coalesce(nullif(btrim(p_display_name), ''), v_trade_name, v_company_name),
    '[[:cntrl:]]+', ' ', 'g')), 120);

  update public.organizations
     set onboarding_completed_at = now(),
         onboarding_completed_by = v_user_id,
         name = coalesce(nullif(v_name, ''), name)
   where id = p_organization_id
  returning * into v_org;

  return v_org;
end;
$$;

revoke all on function public.complete_organization_onboarding(uuid, text) from public, anon;
grant execute on function public.complete_organization_onboarding(uuid, text) to authenticated, service_role;

-- ------------------------------------------------------------
-- 6. Bij welke module hoort een regel in het logboek
--    Gelijk aan 20261108100000, plus client_subdomain en client_domain bij
--    Beheer. Dezelfde lijst staat als AUDIT_ENTITY_MODULE in
--    _shared/actions/admin.ts en src/lib/auditLog.ts (auditVisibility.test.ts
--    en auditLog.test.ts houden ze gelijk).
-- ------------------------------------------------------------
create or replace function public.audit_entity_module(p_entity_type text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_entity_type in ('member', 'organization') then null
    when p_entity_type in ('api_key', 'webhook_endpoint', 'invitation', 'calendar_connection', 'mollie_connection', 'subscription',
                           'billing_profile', 'billing_event', 'payment', 'license_change', 'license_event', 'email_template',
                           'client_subdomain', 'client_domain') then 'admin'
    when p_entity_type in ('annual_account', 'annual_account_filing', 'annual_account_signature', 'bank_account', 'bank_rule',
                           'bank_transaction', 'company_settings', 'contract', 'contract_note', 'contract_project', 'contract_template',
                           'corporate_tax_return', 'credit_note', 'dividend_distribution', 'fiscal_year', 'fiscal_year_size_input',
                           'fixed_asset', 'invoice', 'journal_entry', 'ledger_account', 'partnership_partner', 'purchase_invoice', 'quote',
                           'result_appropriation', 'share_transaction', 'shareholder', 'supplier', 'vat_return') then 'finance'
    when p_entity_type in ('calendar_event', 'calendar_event_link', 'calendar_source', 'note_calendar_link') then 'calendar'
    when p_entity_type in ('client', 'client_call', 'client_contact', 'client_field') then 'clients'
    when p_entity_type in ('project', 'project_member', 'project_template', 'project_template_task', 'task', 'task_assignee', 'gallery') then 'projects'
    when p_entity_type in ('ticket', 'ticket_note') then 'tickets'
    when p_entity_type in ('time_entry') then 'time'
    when p_entity_type in ('attachment', 'content_folder', 'document', 'drive_share', 'file_transfer', 'note', 'note_handwriting') then 'content'
    when p_entity_type in ('saved_report') then 'stats'
    when p_entity_type in ('email_campaign', 'email_flow') then 'marketing'
    else 'admin'
  end;
$$;

-- Zoals in 20261108100000: de leesregel op audit_logs roept hem aan namens
-- de ingelogde gebruiker.
revoke all on function public.audit_entity_module(text) from public, anon;
grant execute on function public.audit_entity_module(text) to authenticated, service_role;

commit;
