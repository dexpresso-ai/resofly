-- ============================================================
-- ResoFly — Telefoongesprekken loggen (client_calls)
-- Date: 2026-09-18
--
-- WAAROM
-- Mail en tickets staan sinds 17 september samen op Berichten; een
-- telefoongesprek — vaak het belangrijkste klantcontact van de dag — verdween
-- in iemands hoofd of in een losse notitie. Deze migratie geeft een gesprek
-- dezelfde status als een mailwisseling of een ticket: een eigen rij, een plek
-- in de gesprekkenlijst, en dezelfde opname → transcript → samenvatting-keten
-- die de agenda al voor meetings gebruikt.
--
-- WAT
-- 1. normalize_phone_e164() — nummerherkenning. BEWUST NAAST het bestaande
--    normalize_client_phone_value(), niet in plaats daarvan (zie hieronder).
-- 2. client_calls — één rij per gesprek, in het spoor van client_emails.
-- 3. find_contacts_by_phone() — wie hoort er bij dit nummer? Geeft ALLE
--    treffers terug (klant, contactpersoon, leverancier), nooit alleen de
--    eerste: één kantoornummer hoort vaak bij meerdere mensen.
-- 4. meeting_recordings.call_id — een opname mag aan een gesprek hangen in
--    plaats van aan een agenda-item. Zo draait de hele bestaande pijplijn
--    (ElevenLabs Scribe → Claude-notulen) ongewijzigd door voor een gesprek.
-- 5. client_calls in de realtime-publicatie, zodat een gesprek dat een collega
--    logt meteen in jouw lijst staat (zelfde patroon als client_emails).
--
-- VALKUIL DIE HIER BEWUST IS AFGEVANGEN
-- normalize_client_phone_value() gooit álle niet-cijfers weg. Voor de
-- klant-deduplicatie waarvoor hij in mei gebouwd is, is dat prima, maar voor
-- herkenning niet: '+31 6 12345678' wordt '31612345678' en '06-12345678'
-- wordt '0612345678' — twee schrijfwijzen van hetzelfde nummer die elkaar
-- nooit vinden. Die functie is hier NIET aangepast: hij is `immutable` en zit
-- in het predicaat van idx_clients_org_phone_lookup én in de dedupe-trigger
-- op clients. Hem herschrijven zou die index stilzwijgend ongeldig maken.
-- De nieuwe functie komt er dus naast, met een eigen index.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Nummer-normalisatie (E.164, standaard Nederland)
-- ------------------------------------------------------------
-- Zet elke schrijfwijze om naar '+<land><abonnee>', zodat twee notaties van
-- hetzelfde nummer op één waarde uitkomen:
--   '06-12345678'      -> '+31612345678'
--   '+31 6 12345678'   -> '+31612345678'
--   '0031 6 12345678'  -> '+31612345678'
--   '612345678'        -> '+31612345678'   (kaal abonneenummer)
--   '+31 (0)20 1234567' -> '+31201234567'   (trunk-0 tussen haakjes vervalt)
--   '+49 30 123456'    -> '+4930123456'    (buitenlands nummer blijft heel)
-- Afgeschermde en onbruikbare nummers geven NULL: die mogen nooit tot een
-- match leiden.
--
-- Let op de aanname bij een kaal nummer zonder 0 en zonder +: dat wordt als
-- Nederlands abonneenummer gelezen. In Nederland begint elk nationaal nummer
-- met een 0, dus dat is veilig; het is wél de reden dat een buitenlands
-- nummer altijd mét + of 00 ingevoerd moet worden.
create or replace function public.normalize_phone_e164(p_value text, p_default_country text default '31')
returns text
language plpgsql
immutable
as $$
declare
  v_raw     text := btrim(coalesce(p_value, ''));
  v_digits  text;
  v_country text := nullif(regexp_replace(coalesce(p_default_country, ''), '[^0-9]+', '', 'g'), '');
begin
  if v_raw = '' then return null; end if;

  -- Afgeschermd nummer: de centrale levert dit als tekst aan.
  if lower(v_raw) in ('anonymous', 'unknown', 'private', 'restricted', 'unavailable', 'onbekend', 'anoniem', 'geheim') then
    return null;
  end if;

  v_digits := regexp_replace(v_raw, '[^0-9]+', '', 'g');
  if v_digits = '' then return null; end if;

  if left(v_raw, 1) = '+' then
    -- Al internationaal genoteerd: de cijfers zijn land + abonnee.
    null;
  elsif left(v_digits, 2) = '00' then
    -- Internationale toegangscode.
    v_digits := substr(v_digits, 3);
  elsif left(v_digits, 1) = '0' then
    -- Nationale notatie: de trunk-0 vervangen door het landnummer.
    v_digits := coalesce(v_country, '') || substr(v_digits, 2);
  elsif v_country is not null and left(v_digits, length(v_country)) <> v_country then
    -- Kaal abonneenummer zonder 0 en zonder landnummer.
    v_digits := v_country || v_digits;
  end if;

  -- '+31 (0)20 123 45 67' — een veelgebruikte Nederlandse notatie waarin de
  -- trunk-0 tussen haakjes blijft staan. Die 0 hoort niet in E.164. Bewust
  -- alleen voor het eigen landnummer: er zijn landen (Italië) waar de 0 juist
  -- wél bij het nummer hoort, en die regel kennen we hier niet.
  if v_country is not null and left(v_digits, length(v_country) + 1) = v_country || '0' then
    v_digits := v_country || substr(v_digits, length(v_country) + 2);
  end if;

  -- E.164 staat maximaal 15 cijfers toe; korter dan 8 is geen volledig
  -- telefoonnummer maar een doorkiesnummer of een typefout.
  if length(v_digits) < 8 or length(v_digits) > 15 then return null; end if;

  return '+' || v_digits;
end;
$$;

comment on function public.normalize_phone_e164(text, text) is
  'Telefoonnummer naar E.164 voor herkenning. Staat los van normalize_client_phone_value (klant-deduplicatie); die is immutable en zit in een index-predicaat.';

grant execute on function public.normalize_phone_e164(text, text) to authenticated, service_role;

-- Zoekindexen voor de herkenning. Partieel: alleen rijen met een bruikbaar nummer.
-- Het landnummer staat er BEWUST expliciet bij, ook al is het de standaard.
-- Een index-expressie moet letterlijk overeenkomen met de expressie in de
-- zoekopdracht, anders wordt de index niet gebruikt; en een index die op een
-- default-waarde leunt, verandert stilzwijgend mee als die default ooit
-- wijzigt. find_contacts_by_phone hieronder schrijft dezelfde expressie.
create index if not exists idx_clients_org_phone_e164
  on public.clients (organization_id, public.normalize_phone_e164(phone, '31'))
  where public.normalize_phone_e164(phone, '31') is not null;

create index if not exists idx_client_contacts_org_phone_e164
  on public.client_contacts (organization_id, public.normalize_phone_e164(phone, '31'))
  where public.normalize_phone_e164(phone, '31') is not null;

create index if not exists idx_suppliers_org_phone_e164
  on public.suppliers (organization_id, public.normalize_phone_e164(phone, '31'))
  where public.normalize_phone_e164(phone, '31') is not null;

-- ------------------------------------------------------------
-- 2. De gesprekken zelf
-- ------------------------------------------------------------
create table if not exists public.client_calls (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),

  -- ── Met wie ──────────────────────────────────────────────────────────────
  -- Alles optioneel: een gesprek met een onbekend nummer mag bestaan en later
  -- alsnog aan een klant gehangen worden (zelfde gedachte als de opvangbak
  -- voor niet-gekoppelde post).
  client_id  uuid references public.clients(id) on delete set null,
  contact_id uuid references public.client_contacts(id) on delete set null,
  supplier_id uuid references public.suppliers(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  ticket_id  uuid references public.tickets(id) on delete set null,

  -- Naam zoals hij tijdens het gesprek gold. Snapshot, net als bij offertes en
  -- tickets: verandert de contactpersoon later van naam, dan blijft het
  -- gesprekslog kloppen met wat er toen gebeurde.
  counterpart_name text,

  -- ── Het nummer ───────────────────────────────────────────────────────────
  phone_raw  text,                         -- zoals ingevoerd of aangeleverd
  phone_e164 text,                         -- genormaliseerd; hierop wordt gezocht

  -- ── Het gesprek ──────────────────────────────────────────────────────────
  direction text not null default 'outbound' check (direction in ('inbound', 'outbound')),
  outcome   text not null default 'answered'
    check (outcome in ('answered', 'missed', 'voicemail', 'busy', 'no_answer', 'failed')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),

  -- De regel die in de gesprekkenlijst komt te staan (waar ging het over).
  subject text not null default '',
  -- Vrije aantekening; bij een opname landt de AI-samenvatting hier ook in.
  notes text,

  -- ── Herkomst ─────────────────────────────────────────────────────────────
  -- 'manual'         = met de hand gelogd
  -- 'click_to_call'  = na een tik op een telefoonlink voorgesteld en bevestigd
  -- 'pbx'            = automatisch van de telefooncentrale (nog niet gebouwd;
  --                    de kolommen staan er zodat die koppeling later geen
  --                    migratie van bestaande rijen vraagt)
  source text not null default 'manual' check (source in ('manual', 'click_to_call', 'pbx')),
  provider text,
  provider_call_id text,
  -- Idempotentie voor een toekomstige centrale-webhook, zelfde gedachte als
  -- inbound_messages.dedup_key.
  dedup_key text,

  -- Volgt een terugbelactie? Puur informatief; de taak zelf is een gewone taak.
  follow_up_task_id uuid references public.tasks(id) on delete set null,

  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.client_calls is
  'Gelogde telefoongesprekken. Verschijnen tussen de mail en de tickets op Berichten en in het klantdossier.';

-- Lijst per organisatie (Berichten) en per klant (klantdossier).
create index if not exists idx_client_calls_org
  on public.client_calls (organization_id, started_at desc);
create index if not exists idx_client_calls_client
  on public.client_calls (client_id, started_at desc) where client_id is not null;
create index if not exists idx_client_calls_project
  on public.client_calls (project_id) where project_id is not null;
create index if not exists idx_client_calls_ticket
  on public.client_calls (ticket_id) where ticket_id is not null;
create index if not exists idx_client_calls_phone
  on public.client_calls (organization_id, phone_e164) where phone_e164 is not null;

-- Eén gesprek van de centrale mag maar één keer landen.
create unique index if not exists idx_client_calls_dedup
  on public.client_calls (organization_id, dedup_key) where dedup_key is not null;

-- ── Normalisatie + afgeleide waarden ────────────────────────────────────────
create or replace function public.enforce_client_calls_guard()
returns trigger
language plpgsql
as $$
begin
  new.phone_raw := nullif(btrim(coalesce(new.phone_raw, '')), '');
  new.phone_e164 := public.normalize_phone_e164(new.phone_raw);
  new.counterpart_name := nullif(btrim(coalesce(new.counterpart_name, '')), '');
  new.subject := btrim(coalesce(new.subject, ''));
  new.notes := nullif(btrim(coalesce(new.notes, '')), '');

  -- Duur uit begin/eind afleiden als hij niet is meegegeven, en andersom het
  -- eindtijdstip invullen. Zo heeft elke rij een bruikbare duur, ongeacht of
  -- de centrale, de timer of de gebruiker hem aanleverde.
  if new.duration_seconds is null and new.ended_at is not null then
    new.duration_seconds := greatest(0, floor(extract(epoch from (new.ended_at - new.started_at)))::integer);
  elsif new.ended_at is null and new.duration_seconds is not null then
    new.ended_at := new.started_at + make_interval(secs => new.duration_seconds);
  end if;

  -- Een gemist of onbeantwoord gesprek heeft per definitie geen gespreksduur.
  -- (Voicemail wél: het inspreken kost tijd.)
  if new.outcome in ('missed', 'busy', 'no_answer', 'failed') then
    new.duration_seconds := 0;
    new.ended_at := new.started_at;
  end if;

  -- Een contactpersoon hoort bij de klant van dit gesprek; een losse
  -- combinatie zou in het klantdossier een vreemde naam opleveren.
  if new.contact_id is not null and new.client_id is not null then
    if not exists (
      select 1 from public.client_contacts cc
       where cc.id = new.contact_id and cc.client_id = new.client_id
    ) then
      raise exception 'Deze contactpersoon hoort niet bij de gekozen klant.' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists client_calls_guard on public.client_calls;
create trigger client_calls_guard
  before insert or update of phone_raw, counterpart_name, subject, notes, started_at, ended_at, duration_seconds, outcome, client_id, contact_id
  on public.client_calls
  for each row execute function public.enforce_client_calls_guard();

-- Org-integriteit: elke koppeling moet bij dezelfde organisatie horen.
create or replace function public.enforce_client_calls_org_integrity()
returns trigger
language plpgsql
as $$
begin
  if new.client_id is not null then
    perform public.assert_same_org_reference('public.clients', new.client_id, new.organization_id, 'client_calls.client_id');
  end if;
  if new.contact_id is not null then
    perform public.assert_same_org_reference('public.client_contacts', new.contact_id, new.organization_id, 'client_calls.contact_id');
  end if;
  if new.supplier_id is not null then
    perform public.assert_same_org_reference('public.suppliers', new.supplier_id, new.organization_id, 'client_calls.supplier_id');
  end if;
  if new.project_id is not null then
    perform public.assert_same_org_reference('public.projects', new.project_id, new.organization_id, 'client_calls.project_id');
  end if;
  if new.ticket_id is not null then
    perform public.assert_same_org_reference('public.tickets', new.ticket_id, new.organization_id, 'client_calls.ticket_id');
  end if;
  return new;
end;
$$;

drop trigger if exists client_calls_org_integrity on public.client_calls;
create trigger client_calls_org_integrity
  before insert or update of organization_id, client_id, contact_id, supplier_id, project_id, ticket_id
  on public.client_calls
  for each row execute function public.enforce_client_calls_org_integrity();

drop trigger if exists client_calls_touch_updated_at on public.client_calls;
create trigger client_calls_touch_updated_at
  before update on public.client_calls
  for each row execute function public.set_updated_at();

drop trigger if exists client_calls_prevent_org_change on public.client_calls;
create trigger client_calls_prevent_org_change
  before update of organization_id on public.client_calls
  for each row execute function public.prevent_organization_id_change();

drop trigger if exists client_calls_audit on public.client_calls;
create trigger client_calls_audit
  after insert or update or delete on public.client_calls
  for each row execute function public.audit_row_change('client_call', 'subject');

-- ── RLS — zelfde vorm als client_contacts, plus de modulepoort 'clients' ────
alter table public.client_calls enable row level security;

drop policy if exists "client_calls read" on public.client_calls;
create policy "client_calls read" on public.client_calls for select using (
  public.can_read_org(organization_id)
);

drop policy if exists "client_calls insert" on public.client_calls;
create policy "client_calls insert" on public.client_calls for insert with check (
  public.can_write_org(organization_id)
);

drop policy if exists "client_calls update" on public.client_calls;
create policy "client_calls update" on public.client_calls for update using (
  public.can_write_org(organization_id)
) with check (
  public.can_write_org(organization_id)
);

drop policy if exists "client_calls delete" on public.client_calls;
create policy "client_calls delete" on public.client_calls for delete using (
  public.can_write_org(organization_id)
);

-- Gesprekken horen bij Klanten: wie die module dicht heeft, ziet ze niet.
do $$ begin perform public.apply_module_gate('client_calls', 'clients', 'write'); end $$;

-- ------------------------------------------------------------
-- 3. Wie hoort er bij dit nummer?
-- ------------------------------------------------------------
-- security invoker: de RLS van clients, client_contacts en suppliers geldt
-- gewoon, dus iemand krijgt alleen treffers uit zijn eigen organisatie en
-- alleen uit modules die voor hem openstaan (leveranciers vallen onder
-- Financiën; staat die dicht, dan blijven ze vanzelf weg).
--
-- Geeft ALLE treffers terug, niet de eerste: een kantoornummer hoort vaak bij
-- de klant én bij drie contactpersonen. De app laat kiezen en gokt niet.
create or replace function public.find_contacts_by_phone(
  p_organization_id uuid,
  p_phone text
)
returns table (
  match_kind text,
  client_id uuid,
  contact_id uuid,
  supplier_id uuid,
  display_name text,
  client_name text,
  role text,
  phone text
)
language sql
stable
security invoker
set search_path = public
as $$
  with target as (select public.normalize_phone_e164(p_phone, '31') as e164)
  select 'client'::text, c.id, null::uuid, null::uuid, c.name, c.name, c.contact_name, c.phone
    from public.clients c, target t
   where t.e164 is not null
     and c.organization_id = p_organization_id
     and public.normalize_phone_e164(c.phone, '31') = t.e164
  union all
  select 'client_contact'::text, cc.client_id, cc.id, null::uuid, cc.name, c.name, cc.role, cc.phone
    from public.client_contacts cc
    join public.clients c on c.id = cc.client_id
       , target t
   where t.e164 is not null
     and cc.organization_id = p_organization_id
     and cc.is_active
     and public.normalize_phone_e164(cc.phone, '31') = t.e164
  union all
  select 'supplier'::text, null::uuid, null::uuid, s.id, s.name, null::text, s.contact_name, s.phone
    from public.suppliers s, target t
   where t.e164 is not null
     and s.organization_id = p_organization_id
     and public.normalize_phone_e164(s.phone, '31') = t.e164
  limit 25;
$$;

comment on function public.find_contacts_by_phone(uuid, text) is
  'Alle contacten bij een telefoonnummer (klant, contactpersoon, leverancier). Geeft bewust meerdere rijen: één nummer hoort vaak bij meer dan één iemand.';

revoke all on function public.find_contacts_by_phone(uuid, text) from public, anon;
grant execute on function public.find_contacts_by_phone(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 4. Een opname mag aan een gesprek hangen
-- ------------------------------------------------------------
-- meeting_recordings hing tot nu toe aan een agenda-item (provider/event_ref,
-- allemaal nullable). Met call_id erbij draait exact dezelfde pijplijn —
-- upload naar R2, ElevenLabs Scribe, Claude-samenvatting, het bewerken van
-- het transcript, het mailen van de samenvatting — ook voor een gesprek.
-- Niets aan die keten hoeft te veranderen.
alter table public.meeting_recordings
  add column if not exists call_id uuid references public.client_calls(id) on delete cascade;

create index if not exists idx_meeting_recordings_call
  on public.meeting_recordings(call_id) where call_id is not null;

comment on column public.meeting_recordings.call_id is
  'Gevuld als deze opname bij een telefoongesprek hoort in plaats van bij een agenda-item.';

-- ------------------------------------------------------------
-- 5. Live in de lijst
-- ------------------------------------------------------------
-- Zelfde patroon als client_emails: RLS geldt per abonnee, dus een lid ziet
-- alleen gesprekken van zijn eigen organisatie en alleen met de module open.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'client_calls'
     )
  then
    alter publication supabase_realtime add table public.client_calls;
  end if;
end $$;

commit;
