-- ============================================================
-- ResoFly — Openbare API: andere software koppelen met een API-sleutel
-- Date: 2026-10-03
--
-- Aanleiding:
-- De MCP-connector laat een klant zijn eigen AI koppelen. Maar "alles kunnen
-- koppelen" gaat verder dan een AI: een webshop die klanten aanmaakt, een
-- urenapp die uren boekt, een koppelplatform (Zapier, Make, n8n) dat bij een
-- betaalde factuur iets in gang zet. Die hebben geen mens die op Connect
-- klikt; ze hebben een SLEUTEL nodig die een owner of admin bewust uitgeeft.
--
-- DE KERN VAN HET ONTWERP (zelfde lijn als de MCP-connector):
-- Een sleutel krijgt NOOIT een Supabase-sessie. Hij hangt aan één teamlid in
-- één organisatie, en werkt met de rechten die dat teamlid NU heeft — vers uit
-- organization_members bij elke aanroep. Daarbovenop kan de sleutel modules
-- dichter zetten (een webshop hoeft niet in de boekhouding), maar nooit ruimer.
-- Er komt geen tweede weg naar de gegevens bij: de API draait dezelfde
-- handelingen uit de registry als Gerrie en de MCP, met dezelfde org-scoping.
--
-- Tabellen:
--   api_keys              — de sleutel zoals de owner hem ziet: naam, wat hij
--                           mag, wie hem maakte, wanneer hij laatst werd
--                           gebruikt. Leesbaar voor owners/admins.
--   api_key_secrets       — selector + gesalte hash. Geen policies: alleen de
--                           API-functie (service-role) komt erbij.
--   api_request_log       — elke aanroep: wanneer, welk pad, welke handeling,
--                           welke uitkomst. Dit is een deur naar buiten, dus
--                           een organisatie hoort te kunnen terugzien wat er
--                           langs is gegaan. 30 dagen bewaard.
--   api_idempotency_keys  — maakt een herhaald verzoek veilig (24 uur).
-- Plus `ai_action_audit.api_key_id`: een voorstel van een sleutel staat in
-- dezelfde goedkeurwachtrij als dat van een agent of een AI-koppeling.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Wat een sleutel mag ──────────────────────────────────────────────────
--
-- Dezelfde vier treden als een AI-koppeling, en dezelfde trap: zonder `read`
-- is een sleutel zinloos, `execute` valt terug op klaarzetten (dus `propose`
-- hoort erbij) en `execute_high` bestaat niet zonder `execute`. De API-functie
-- bouwt de scope altijd zo op (scopeForLevel in publicApi.ts); deze controle is
-- er voor elke andere weg naar de tabel.
create or replace function public.api_scope_is_valid(p_scope text)
returns boolean
language sql
immutable
as $$
  select coalesce(array_length(s.v, 1), 0) > 0
     and not exists (select 1 from unnest(s.v) as x where x not in ('read', 'propose', 'execute', 'execute_high'))
     and 'read' = any(s.v)
     and (not ('execute' = any(s.v)) or 'propose' = any(s.v))
     and (not ('execute_high' = any(s.v)) or 'execute' = any(s.v))
  from (
    select array(
      select x from regexp_split_to_table(btrim(coalesce(p_scope, '')), '\s+') as x where x <> ''
    ) as v
  ) as s;
$$;

-- Een modulebeperking kan alleen afknijpen: 'none' of 'read'. 'write' is
-- "geen beperking" en wordt niet opgeslagen. Een onbekende module is een fout,
-- geen stil genegeerde regel.
create or replace function public.api_module_access_is_valid(p_access jsonb)
returns boolean
language sql
immutable
as $$
  select jsonb_typeof(p_access) = 'object'
     and not exists (
       select 1 from jsonb_each(p_access) as e
        where e.key not in ('clients', 'projects', 'time', 'calendar', 'tickets', 'content', 'stats',
                            'marketing', 'finance', 'chat', 'gerrie')
           or jsonb_typeof(e.value) <> 'string'
           or (e.value #>> '{}') not in ('none', 'read')
     );
$$;

-- ── 2. De sleutels ──────────────────────────────────────────────────────────
create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Namens wie de sleutel werkt. Zijn rol en modulerechten gelden per aanroep;
  -- is hij geen actief lid meer, dan werkt de sleutel niet meer.
  user_id uuid not null references auth.users(id) on delete cascade,
  -- "Webshop", "Urenkoppeling Toggl" — wat de owner in zijn lijst leest.
  name text not null,
  -- Herkenbaar stukje ("rsfapi.Ab12Cd…"). Geen geheim: de selector opent niets.
  key_hint text not null,
  scope text not null default 'read',
  module_access jsonb not null default '{}'::jsonb,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null,
  -- Verzoeksnelheid per sleutel, net als bij mcp_grants: één teller per rij, en
  -- afgeboekt in één statement met een rijvergrendeling (api_consume_rate_limit).
  calls_window_start timestamptz not null default now(),
  calls_in_window integer not null default 0,
  constraint api_keys_name_check check (char_length(btrim(name)) between 1 and 80),
  constraint api_keys_scope_check check (public.api_scope_is_valid(scope)),
  constraint api_keys_module_access_check check (public.api_module_access_is_valid(module_access))
);

create index if not exists idx_api_keys_org
  on public.api_keys(organization_id, created_at desc);
create index if not exists idx_api_keys_user_active
  on public.api_keys(user_id) where revoked_at is null;

drop trigger if exists api_keys_prevent_org_change on public.api_keys;
create trigger api_keys_prevent_org_change
  before update of organization_id on public.api_keys
  for each row execute function public.prevent_organization_id_change();

-- Het geheime deel, apart van wat het scherm leest. Een selector plat (om de
-- rij op te zoeken) en van de verifier alleen een gesalte SHA-256 — dezelfde
-- opzet als mcp_tokens. De platte sleutel zien we één keer, bij het aanmaken.
create table if not exists public.api_key_secrets (
  api_key_id uuid primary key references public.api_keys(id) on delete cascade,
  selector text not null unique,
  verifier_hash text not null,
  salt text not null,
  created_at timestamptz not null default now()
);

-- ── 3. Vanuit de app: alleen hernoemen en intrekken ─────────────────────────
--
-- Wat een sleutel mag, ligt vast bij het aanmaken. Verruimen achteraf zou een
-- sleutel die al ergens in een webshop staat ineens méér laten doen, zonder
-- dat iemand die webshop opnieuw bekijkt. Wie meer wil, maakt een nieuwe
-- sleutel en trekt de oude in.
--
-- De service-role (de API-functie zelf) houdt de teller en `last_used_at` bij;
-- die heeft geen auth.uid() en valt hier dus buiten.
create or replace function public.api_keys_guard_client_update()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is null then return new; end if;

  if new.organization_id is distinct from old.organization_id
     or new.user_id is distinct from old.user_id
     or new.key_hint is distinct from old.key_hint
     or new.scope is distinct from old.scope
     or new.module_access is distinct from old.module_access
     or new.expires_at is distinct from old.expires_at
     or new.created_at is distinct from old.created_at
     -- De boekhouding van de API hoort niet aan de gebruiker: zonder deze regels
     -- poetst een PATCH met {"calls_in_window": 0} de aanroeplimiet weg.
     or new.last_used_at is distinct from old.last_used_at
     or new.calls_window_start is distinct from old.calls_window_start
     or new.calls_in_window is distinct from old.calls_in_window then
    raise exception 'Vanuit de app is aan een API-sleutel alleen hernoemen en intrekken toegestaan. Moet hij meer of minder mogen, maak dan een nieuwe sleutel en trek deze in.'
      using errcode = '42501';
  end if;

  -- Intrekken is definitief: een gelekte sleutel die iemand per ongeluk weer
  -- "aanzet", is precies het lek dat het intrekken moest dichten.
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'Een ingetrokken API-sleutel blijft ingetrokken. Maak een nieuwe sleutel aan.'
      using errcode = '42501';
  end if;

  if new.revoked_at is not null and old.revoked_at is null then
    -- Het moment en de persoon schrijft de database, niet de browser.
    new.revoked_at := now();
    new.revoked_by := auth.uid();
  else
    new.revoked_by := old.revoked_by;
  end if;
  return new;
end;
$$;

drop trigger if exists api_keys_guard_client_update on public.api_keys;
create trigger api_keys_guard_client_update
  before update on public.api_keys
  for each row execute function public.api_keys_guard_client_update();

-- ── 4. Een voorstel van een sleutel ─────────────────────────────────────────
--
-- Mag een sleutel iets niet rechtstreeks uitvoeren, dan zet hij het KLAAR, in
-- dezelfde wachtrij als een geplande agent of een AI-koppeling. Deze kolom
-- vertelt de wachtrij waar het vandaan kwam — en de API welke voorstellen van
-- welke sleutel zijn.
alter table public.ai_action_audit
  add column if not exists api_key_id uuid references public.api_keys(id) on delete set null;

comment on column public.ai_action_audit.api_key_id is
  'Gezet wanneer dit voorstel of deze uitvoering van een API-sleutel komt. Wijst naar de sleutel, en daarmee naar de organisatie en het teamlid namens wie hij werkt.';

create index if not exists idx_ai_action_audit_api_pending
  on public.ai_action_audit(organization_id, created_at desc)
  where api_key_id is not null and status = 'proposed';
create index if not exists idx_ai_action_audit_api_key
  on public.ai_action_audit(api_key_id, created_at desc)
  where api_key_id is not null;

-- Een ingetrokken sleutel laat niets achter dat nog uitgevoerd kan worden. Wie
-- op "intrekken" drukt omdat er iets mis is, hoort daarna geen rij van die
-- sleutel meer in zijn wachtrij te vinden.
create or replace function public.api_keys_on_revoke()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.revoked_at is not null and old.revoked_at is null then
    update public.ai_action_audit
       set status = 'cancelled',
           result = coalesce(result, '{}'::jsonb) || jsonb_build_object('detail', 'De API-sleutel is ingetrokken.')
     where api_key_id = new.id and status = 'proposed';
  end if;
  return new;
end;
$$;

drop trigger if exists api_keys_on_revoke on public.api_keys;
create trigger api_keys_on_revoke
  after update of revoked_at on public.api_keys
  for each row execute function public.api_keys_on_revoke();

-- ── 5. Het auditlog van de organisatie ──────────────────────────────────────
--
-- Aanmaken, hernoemen en intrekken horen in audit_logs, net als een nieuw
-- teamlid. De teller en `last_used_at` veranderen bij elke aanroep; die horen
-- er niet in, anders staat het auditlog vol met "sleutel bijgewerkt".
drop trigger if exists api_keys_audit on public.api_keys;
drop trigger if exists api_keys_audit_write on public.api_keys;
create trigger api_keys_audit_write
  after insert or delete on public.api_keys
  for each row execute function public.audit_row_change('api_key', 'name');

drop trigger if exists api_keys_audit_update on public.api_keys;
create trigger api_keys_audit_update
  after update on public.api_keys
  for each row
  when (old.name is distinct from new.name or old.revoked_at is distinct from new.revoked_at)
  execute function public.audit_row_change('api_key', 'name');

-- ── 6. Het verzoeklog ───────────────────────────────────────────────────────
create table if not exists public.api_request_log (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  api_key_id uuid references public.api_keys(id) on delete set null,
  request_id text not null,
  method text not null,
  path text not null,
  -- Bij POST /v1/actions/{id}: welke handeling. Zo is terug te zien wat er
  -- gelezen of gewijzigd is zonder de invoer zelf te bewaren.
  action_id text,
  status integer not null,
  error_code text,
  duration_ms integer,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists idx_api_request_log_org
  on public.api_request_log(organization_id, created_at desc);
create index if not exists idx_api_request_log_key
  on public.api_request_log(api_key_id, created_at desc) where api_key_id is not null;

-- ── 7. Idempotentie ─────────────────────────────────────────────────────────
--
-- Eén rij per (sleutel, Idempotency-Key). `status` null = de eerste poging is
-- nog bezig; dan krijgt een tweede een 409 in plaats van een dubbele uitvoering.
create table if not exists public.api_idempotency_keys (
  api_key_id uuid not null references public.api_keys(id) on delete cascade,
  idempotency_key text not null,
  request_hash text not null,
  status integer,
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (api_key_id, idempotency_key)
);

create index if not exists idx_api_idempotency_keys_created
  on public.api_idempotency_keys(created_at);

-- ── 8. Opruimen ─────────────────────────────────────────────────────────────
create or replace function public.api_purge_expired()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.api_request_log where created_at < now() - interval '30 days';
  delete from public.api_idempotency_keys where created_at < now() - interval '24 hours';
end;
$$;

revoke all on function public.api_purge_expired() from public, anon, authenticated;
grant execute on function public.api_purge_expired() to service_role;

-- ── 9. De aanroeplimiet ─────────────────────────────────────────────────────
--
-- Zelfde opzet als mcp_consume_rate_limit (20260918040000): één statement met
-- een rijvergrendeling, zodat honderd parallelle verzoeken niet allemaal
-- dezelfde lege teller lezen. Geeft het nieuwe aantal in het venster terug, of
-- -1 als het plafond bereikt is (dan is er niets afgeboekt).
create or replace function public.api_consume_rate_limit(
  p_key_id uuid,
  p_cost integer default 1,
  p_window_seconds integer default 60,
  p_max_calls integer default 300
)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_start timestamptz;
  v_used  integer;
  v_cost  integer := greatest(coalesce(p_cost, 1), 0);
  v_fresh boolean;
begin
  -- Alleen de API-functie (service-role) boekt af. Zou een gewone gebruiker
  -- dit mogen aanroepen, dan kon hij zijn eigen venster leegdraaien.
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de API kan de aanroeplimiet bijwerken.' using errcode = '42501';
  end if;

  if v_cost = 0 then return 0; end if;

  select calls_window_start, calls_in_window
    into v_start, v_used
    from public.api_keys
   where id = p_key_id
   for update;

  if not found then
    raise exception 'Deze API-sleutel bestaat niet meer.' using errcode = 'P0002';
  end if;

  v_fresh := v_start is null or (now() - v_start) > make_interval(secs => greatest(p_window_seconds, 1));
  if v_fresh then v_used := 0; end if;

  if coalesce(v_used, 0) + v_cost > greatest(p_max_calls, 1) then
    return -1;
  end if;

  update public.api_keys
     set calls_window_start = case when v_fresh then now() else calls_window_start end,
         calls_in_window = coalesce(v_used, 0) + v_cost,
         last_used_at = now()
   where id = p_key_id;

  -- Eén op de honderd aanroepen ruimt het log en de idempotentiesleutels op.
  -- Vaak genoeg om bij te blijven, zeldzaam genoeg om niets te vertragen.
  if random() < 0.01 then
    perform public.api_purge_expired();
  end if;

  return coalesce(v_used, 0) + v_cost;
end;
$$;

comment on function public.api_consume_rate_limit(uuid, integer, integer, integer) is
  'Boekt aanroepen af op een API-sleutel en geeft het nieuwe aantal terug, of -1 als het plafond bereikt is. Serialiseert op de sleutelrij.';

revoke all on function public.api_consume_rate_limit(uuid, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.api_consume_rate_limit(uuid, integer, integer, integer) to service_role;

-- ── 10. RLS ─────────────────────────────────────────────────────────────────
--
-- api_key_secrets en api_idempotency_keys: RLS aan en bewust GEEN policies.
-- Uitsluitend bereikbaar via de API-functies met de service-role — zelfde keuze
-- als mcp_tokens en calendar_app_passwords.
alter table public.api_key_secrets enable row level security;
alter table public.api_idempotency_keys enable row level security;
revoke all on public.api_key_secrets from anon, authenticated;
revoke all on public.api_idempotency_keys from anon, authenticated;

-- api_keys: een sleutel is van de ORGANISATIE, niet van één persoon. Owners en
-- admins zien ze allemaal en kunnen elke sleutel intrekken — ook die van een
-- collega die uit dienst ging. Aanmaken gebeurt nooit vanuit de browser, alleen
-- door api-admin (die genereert het geheim); verwijderen bestaat niet, intrekken
-- wel. Wat er bij een update mag veranderen, bewaakt de guard hierboven.
alter table public.api_keys enable row level security;
revoke insert, delete, truncate on public.api_keys from anon, authenticated;

drop policy if exists "api_keys admin read" on public.api_keys;
create policy "api_keys admin read" on public.api_keys for select using (
  public.can_admin_org(organization_id)
);

drop policy if exists "api_keys admin update" on public.api_keys;
create policy "api_keys admin update" on public.api_keys for update using (
  public.can_admin_org(organization_id)
) with check (
  public.can_admin_org(organization_id)
);

-- Het verzoeklog: alleen lezen, alleen owners/admins. Schrijven doet de API.
alter table public.api_request_log enable row level security;
revoke insert, update, delete, truncate on public.api_request_log from anon, authenticated;

drop policy if exists "api_request_log admin read" on public.api_request_log;
create policy "api_request_log admin read" on public.api_request_log for select using (
  public.can_admin_org(organization_id)
);

commit;
