-- ============================================================
-- ResoFly — MCP-connector: klanten koppelen hun eigen AI aan hun werkruimte
-- Date: 2026-09-16
--
-- Aanleiding:
-- Gerrie is onze AI, met ons model en ons maandtegoed. Een klant die zelf al
-- met Claude of ChatGPT werkt, wil diezelfde assistent op ZIJN eigen gegevens
-- kunnen laten kijken — en dan op zijn eigen abonnement, niet op het onze.
-- Daarvoor bieden we een MCP-server aan: een koppeling waarmee een AI-client
-- van buiten de handelingenregistry mag gebruiken.
--
-- DE KERN VAN HET ONTWERP:
-- Een AI-client van buiten krijgt NOOIT een Supabase-sessie. Hij krijgt een
-- eigen toegangstoken, dat hangt aan één GRANT: één gebruiker, in één
-- organisatie, voor één client. Daarmee blijven alle grenzen die de app al
-- kent gewoon staan — de rol van dat teamlid, zijn modulerechten, en de
-- org-scoping van elke query. De connector voegt geen nieuwe rechten toe; hij
-- geeft een bestaande gebruiker een tweede deur naar wat hij toch al mocht.
--
-- Vier tabellen:
--   mcp_clients     — welke AI-clients zich hebben geregistreerd (Claude.ai,
--                     ChatGPT, Claude Desktop). Registratie is open (dynamic
--                     client registration, verplicht voor deze clients); een
--                     registratie op zich geeft NUL toegang tot gegevens.
--   mcp_grants      — de goedgekeurde koppeling. Ontstaat pas nadat een mens
--                     op het toestemmingsscherm akkoord gaf.
--   mcp_auth_codes  — de kortlevende autorisatiecode tussen toestemming en
--                     token. Eenmalig, tien minuten geldig, met PKCE.
--   mcp_tokens      — access- en refreshtokens.
--
-- Bewaren van geheimen (zelfde lijn als calendar_app_passwords en deellinks):
-- een token bestaat uit een openbare `selector` en een geheime `verifier`. Wij
-- bewaren de selector plat (daarmee zoeken we de rij op) en van de verifier
-- alleen een gesalte SHA-256. De platte tekst zien we één keer, bij uitgifte.
-- Een autorisatiecode leeft tien minuten en wordt daarom onversleuteld gehasht
-- (sha256hex), net als een deellink.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Geregistreerde AI-clients ────────────────────────────────────────────
--
-- Claude.ai en ChatGPT registreren zichzelf bij het toevoegen van een connector
-- (RFC 7591). Dat MOET open staan, anders kan niemand koppelen. Dat is niet
-- gevaarlijk: registreren levert alleen een client_id op. Zonder dat een mens
-- daarna op het toestemmingsscherm akkoord geeft, hoort daar geen enkele grant
-- en dus geen enkel gegeven bij.
create table if not exists public.mcp_clients (
  id uuid primary key default gen_random_uuid(),
  -- Openbaar, staat in de autorisatie-URL. Geen geheim.
  client_id text not null unique,
  client_name text not null default 'Onbekende AI-client',
  -- Waar we ná toestemming naartoe mogen sturen. Exacte match bij /authorize:
  -- een open redirect is hier het verschil tussen een koppeling en een lek.
  redirect_uris text[] not null,
  logo_uri text,
  client_uri text,
  software_id text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create index if not exists idx_mcp_clients_created
  on public.mcp_clients(created_at desc);

-- ── 2. De goedgekeurde koppeling ────────────────────────────────────────────
--
-- Eén rij = "deze gebruiker heeft deze AI toegang gegeven tot deze organisatie".
-- Per gebruiker en niet per organisatie, omdat de rechten van het teamlid de
-- grens zijn: een member met Financiën op 'none' hoort die ook via zijn eigen
-- AI niet te zien. Een admin koppelt dus niet namens het hele team.
create table if not exists public.mcp_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  client_id text not null references public.mcp_clients(client_id) on delete cascade,
  -- Ruimte voor later: fase A geeft alleen 'read' uit. 'propose' (een handeling
  -- klaarzetten op de beslislijst) komt in fase B; de tokencontrole leest deze
  -- kolom nu al, zodat een oud token straks niet ineens meer mag.
  scope text not null default 'read',
  -- Wat de gebruiker in zijn koppelingenlijst leest: "Claude op mijn laptop".
  label text not null default '',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  -- Verzoeksnelheid per koppeling. Bewust hier en niet in een aparte tabel: het
  -- is één teller per koppeling, en zo kost hij geen extra query per aanroep.
  calls_window_start timestamptz not null default now(),
  calls_in_window int not null default 0
);

create index if not exists idx_mcp_grants_user
  on public.mcp_grants(user_id, organization_id) where revoked_at is null;
create index if not exists idx_mcp_grants_client
  on public.mcp_grants(client_id) where revoked_at is null;

-- Eén actieve koppeling per gebruiker/organisatie/client. Koppelt de gebruiker
-- dezelfde AI nog eens, dan hergebruiken we die rij in plaats van er een tweede
-- naast te zetten die hij nooit meer terugvindt om in te trekken.
create unique index if not exists idx_mcp_grants_unique_active
  on public.mcp_grants(user_id, organization_id, client_id) where revoked_at is null;

drop trigger if exists mcp_grants_prevent_org_change on public.mcp_grants;
create trigger mcp_grants_prevent_org_change
  before update of organization_id on public.mcp_grants
  for each row execute function public.prevent_organization_id_change();

-- ── 3. Autorisatiecodes (PKCE) ──────────────────────────────────────────────
create table if not exists public.mcp_auth_codes (
  id uuid primary key default gen_random_uuid(),
  -- sha256hex(code). De code zelf bestaat alleen in de redirect naar de client.
  code_hash text not null unique,
  grant_id uuid not null references public.mcp_grants(id) on delete cascade,
  -- PKCE: de client bewijst bij /token dat hij dezelfde is die /authorize deed.
  code_challenge text not null,
  code_challenge_method text not null default 'S256'
    check (code_challenge_method = 'S256'),
  redirect_uri text not null,
  -- RFC 8707: voor welke MCP-server dit token bedoeld is. Terug te geven bij
  -- /token, zodat een token voor server A niet bij server B werkt.
  resource text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_mcp_auth_codes_expiry
  on public.mcp_auth_codes(expires_at);

-- ── 4. Access- en refreshtokens ─────────────────────────────────────────────
create table if not exists public.mcp_tokens (
  id uuid primary key default gen_random_uuid(),
  grant_id uuid not null references public.mcp_grants(id) on delete cascade,
  kind text not null check (kind in ('access', 'refresh')),
  -- Openbaar deel van het token; hiermee zoeken we de rij op.
  selector text not null unique,
  -- Gesalte SHA-256 van het geheime deel. Nooit de platte tekst.
  verifier_hash text not null,
  salt text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_mcp_tokens_grant
  on public.mcp_tokens(grant_id) where revoked_at is null;
create index if not exists idx_mcp_tokens_expiry
  on public.mcp_tokens(expires_at) where revoked_at is null;

-- ── 5. Intrekken werkt meteen, overal ───────────────────────────────────────
--
-- De knop "koppeling intrekken" zet alleen `revoked_at` op de grant. Zou het
-- daarbij blijven, dan bleef een access token nog tot een uur na het intrekken
-- werken — precies het uur waarin iemand op die knop drukt omdat er iets mis
-- is. Daarom trekt de database de tokens zelf mee in.
create or replace function public.mcp_revoke_grant_tokens()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.revoked_at is not null and old.revoked_at is null then
    update public.mcp_tokens
       set revoked_at = new.revoked_at
     where grant_id = new.id and revoked_at is null;
    delete from public.mcp_auth_codes where grant_id = new.id and used_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists mcp_grants_revoke_tokens on public.mcp_grants;
create trigger mcp_grants_revoke_tokens
  after update of revoked_at on public.mcp_grants
  for each row execute function public.mcp_revoke_grant_tokens();

-- ── 6. Opruimen van verlopen rommel ─────────────────────────────────────────
--
-- Codes leven tien minuten en tokens hooguit een paar maanden; zonder opruimen
-- groeien die tabellen eeuwig door. Aangeroepen door de connector zelf (één op
-- de zoveel aanroepen), zodat er geen aparte cron voor nodig is.
create or replace function public.mcp_purge_expired()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.mcp_auth_codes where expires_at < now() - interval '1 day';
  delete from public.mcp_tokens where expires_at < now() - interval '30 days';
end;
$$;

revoke all on function public.mcp_purge_expired() from public, anon, authenticated;

-- ── 7. RLS ──────────────────────────────────────────────────────────────────
--
-- mcp_clients, mcp_auth_codes en mcp_tokens: RLS aan en bewust GEEN policies.
-- Daar staan de geheimen in; ze zijn uitsluitend benaderbaar via de Edge
-- Functions met de service-role. Zelfde keuze als calendar_app_passwords.
alter table public.mcp_clients enable row level security;
alter table public.mcp_auth_codes enable row level security;
alter table public.mcp_tokens enable row level security;

-- mcp_grants is wél iets dat de gebruiker moet kunnen zien en intrekken: het is
-- zijn eigen koppeling. Lezen mag hij alleen die van zichzelf (niet die van een
-- collega), en wijzigen doet hij via de intrek-knop — die zet `revoked_at`.
-- Aanmaken gebeurt nooit vanuit de browser, alleen door de autorisatieserver.
alter table public.mcp_grants enable row level security;

drop policy if exists "mcp_grants read own" on public.mcp_grants;
create policy "mcp_grants read own" on public.mcp_grants for select using (
  user_id = auth.uid() and public.can_read_org(organization_id)
);

drop policy if exists "mcp_grants revoke own" on public.mcp_grants;
create policy "mcp_grants revoke own" on public.mcp_grants for update using (
  user_id = auth.uid() and public.can_read_org(organization_id)
) with check (
  user_id = auth.uid() and public.can_read_org(organization_id)
);

-- De modulepoort van Gerrie geldt ook hier: wie de module Gerrie niet mag zien,
-- ziet zijn MCP-koppelingen niet. Dat is een RESTRICTIVE policy bovenop de twee
-- hierboven, plus de schrijf-trigger.
do $$
begin
  if to_regprocedure('public.apply_module_gate(text, text, text)') is not null then
    perform public.apply_module_gate('mcp_grants', 'gerrie', 'read');
  end if;
end $$;

commit;
