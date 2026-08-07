-- ============================================================
-- ResoFly — Zakelijke module fase 4: aandeelhouders, dividend en dividendbelasting
-- Date: 2026-08-07
--
-- Drie dingen die fase 1 open liet staan.
--
--   1. HET AANDEELHOUDERSREGISTER (art. 2:194 BW) is wettelijk verplicht en het
--      bestuur houdt het bij. Er staat meer in dan "wie heeft hoeveel": ook de
--      datum van verkrijging, de datum van erkenning of betekening, de soort van
--      de aandelen, het op ieder aandeel gestorte bedrag, en de pandhouders en
--      vruchtgebruikers met de rechten die hun toekomen (lid 2). Zonder register
--      is een dividendbesluit niet te onderbouwen: je weet niet wie er recht op
--      heeft.
--
--   2. DE UITKERINGSTOETS geldt niet alleen bij de resultaatbestemming. Art.
--      2:216 lid 1 BW spreekt van "bestemming van de winst ... en vaststelling
--      van uitkeringen": een TUSSENTIJDSE uitkering is net zo goed een besluit
--      tot uitkering, met dezelfde balanstest en dezelfde bestuursgoedkeuring.
--      Fase 1 dekte alleen de weg via de vastgestelde jaarrekening; hier komt
--      het interim-dividend erbij.
--
--   3. DIVIDENDBELASTING. De BV is inhoudingsplichtige: zij houdt de belasting
--      in op het tijdstip waarop de opbrengst ter beschikking wordt gesteld
--      (art. 7 lid 3 Wet DB 1965) en draagt die op aangifte af (lid 4). Fase 1
--      maakte al rekening 1560 aan maar boekte er nooit iets op; hier gebeurt
--      dat.
--
-- HOE HET IN DE BOEKHOUDING LOOPT
-- ───────────────────────────────
-- Een dividend kent twee juridische momenten en dus twee boekstukken:
--
--   A. HET BESLUIT — het eigen vermogen wordt een schuld aan de aandeelhouder.
--      Bij een dividend uit de vastgestelde winst is dat al gebeurd:
--      appropriate_result boekte 0510 → 1580 voor het BRUTO bedrag. Bij een
--      interim-dividend gebeurt het hier: 0520 → 1580, ook bruto.
--   B. DE TERBESCHIKKINGSTELLING — op dát moment wordt ingehouden:
--      1580 → 1560 voor de belasting. Wat op 1580 overblijft is precies het
--      netto bedrag dat de aandeelhouder nog krijgt.
--
-- Dat 1580 tussen A en B even bruto staat is geen slordigheid maar de
-- werkelijkheid: tussen het besluit en de uitbetaling is de vennootschap het
-- hele bedrag verschuldigd, alleen niet alles aan dezelfde partij.
--
-- Het uitbetalen zelf staat hier bewust niet in: dat is een gewone
-- bankmutatie tegen 1580, en die loopt al via de bankmodule. Idem voor de
-- afdracht aan de Belastingdienst tegen 1560.
--
-- INHOUDINGSVRIJSTELLING — het geval dat je bij een holdingstructuur meteen
-- tegenkomt. Keert de werk-BV dividend uit aan de holding, dan mag de inhouding
-- achterwege blijven als de deelnemingsvrijstelling van toepassing is
-- (art. 4 Wet DB 1965). Of dat zo is, hangt af van gegevens die niet in een
-- boekhouding staan — belang, vestigingsplaats, misbruiktoets. Daarom is het
-- een bewuste vlag PER AANDEELHOUDER met een verplichte onderbouwing, geen
-- automatisme dat ResoFly zelf afleidt. De vlag wordt op de uitkering
-- vastgeklonken, zodat een latere wijziging de geschiedenis niet herschrijft.
--
-- WAT ER BEWUST NIET IN STAAT
-- ───────────────────────────
-- Geen BSN. Voor de dividendnota (art. 9 Wet DB 1965) zijn naam en adres
-- genoeg, en de aangifte dividendbelasting vraagt totalen, geen personen. Een
-- BSN opslaan zou bijzonder gevoelige gegevens toevoegen zonder dat er iets mee
-- gebeurt; dat doen we niet.
--
-- Geen automatische aangifte. Wij rekenen uit wat er is ingehouden en wanneer
-- het uiterlijk betaald moet zijn (binnen één maand na terbeschikkingstelling,
-- art. 19 lid 3 AWR); indienen doet de klant, net als bij de btw en de Vpb.
--
-- Geen oordeel over de hoogte van het dividend. De balanstest is een harde
-- blokkade omdat de wet die letterlijk voorschrijft; de uitkeringstest is een
-- oordeel over de toekomst en blijft bij het bestuur.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Het tarief — periodegedateerd, zoals elk wettelijk bedrag hier
-- ------------------------------------------------------------
create table if not exists public.dividend_tax_rates (
  id uuid primary key default gen_random_uuid(),
  valid_from date not null unique,
  -- Basispunten: 1500 = 15%.
  rate_basis_points integer not null check (rate_basis_points between 0 and 10000),
  source_note text,
  created_at timestamptz not null default now()
);

comment on table public.dividend_tax_rates is
  'Tarief dividendbelasting (art. 5 Wet DB 1965) per ingangsdatum. Nationale wetgeving; alleen via migraties te wijzigen.';

alter table public.dividend_tax_rates enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='dividend_tax_rates' and policyname='dividend tax rates read') then
    create policy "dividend tax rates read" on public.dividend_tax_rates for select using (auth.role() = 'authenticated');
  end if;
end $$;

insert into public.dividend_tax_rates (valid_from, rate_basis_points, source_note)
values ('2007-01-01', 1500, 'Art. 5 Wet op de dividendbelasting 1965: "De belasting bedraagt 15% van de opbrengst." Verlaagd van 25% naar 15% per 1-1-2007 door de Wet werken aan winst (Stb. 2006, 631). Sindsdien ongewijzigd.')
on conflict (valid_from) do nothing;

-- ------------------------------------------------------------
-- 2. De aandeelhouders zelf
--    Namen en adressen (art. 2:194 lid 1 BW). Eén rij per houder; hoeveel
--    aandelen hij heeft volgt uit de mutaties hieronder, want dat verandert.
-- ------------------------------------------------------------
create table if not exists public.shareholders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  name text not null,
  -- Natuurlijk persoon of rechtspersoon. Bepaalt niets in de berekening, maar
  -- het is het eerste dat een adviseur wil weten bij een dividendbesluit: een
  -- uitkering aan een holding ligt fiscaal totaal anders dan aan een mens.
  kind text not null default 'natural_person',
  address_line text,
  postal_code text,
  city text,
  country_code text not null default 'NL',
  email text,
  -- Is deze aandeelhouder de DGA? Alleen om het DGA-scherm en dit scherm aan
  -- elkaar te kunnen knopen; fiscaal doet de vlag niets.
  is_dga boolean not null default false,
  -- Inhoudingsvrijstelling art. 4 Wet DB 1965. Bewuste keuze van de gebruiker,
  -- met onderbouwing — ResoFly leidt hem nooit zelf af.
  withholding_exempt boolean not null default false,
  withholding_exempt_note text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shareholders_kind_check check (kind in ('natural_person', 'legal_entity')),
  constraint shareholders_name_not_blank check (btrim(name) <> ''),
  -- Een vrijstelling zonder onderbouwing is bij een controle waardeloos, en de
  -- vraag "waarom hoefde hier niet ingehouden te worden?" komt gegarandeerd.
  constraint shareholders_exempt_needs_note check (
    not withholding_exempt or coalesce(btrim(withholding_exempt_note), '') <> ''
  )
);

comment on table public.shareholders is
  'Aandeelhouders van deze vennootschap — de namen en adressen uit het register van art. 2:194 BW. Het aandelenbezit volgt uit share_transactions.';

create index if not exists idx_shareholders_org on public.shareholders(organization_id, name);

alter table public.shareholders enable row level security;
drop policy if exists "shareholders read" on public.shareholders;
create policy "shareholders read" on public.shareholders
  for select using (public.can_read_org(organization_id));
drop policy if exists "shareholders write" on public.shareholders;
create policy "shareholders write" on public.shareholders
  for all using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id));
-- Wie de financiële module niet mag zien, mag het aandeelhoudersregister ook
-- niet zien: er staat in wie hoeveel van de vennootschap bezit.
select public.apply_module_gate('shareholders', 'finance');

drop trigger if exists shareholders_touch_updated_at on public.shareholders;
create trigger shareholders_touch_updated_at before update on public.shareholders
  for each row execute function public.bookkeeping_touch_updated_at();
drop trigger if exists shareholders_prevent_org_change on public.shareholders;
create trigger shareholders_prevent_org_change before update of organization_id on public.shareholders
  for each row execute function public.prevent_organization_id_change();
drop trigger if exists shareholders_audit on public.shareholders;
create trigger shareholders_audit after insert or update or delete on public.shareholders
  for each row execute function public.audit_row_change('shareholder', 'name');

-- ------------------------------------------------------------
-- 3. De mutaties — het eigenlijke register
--
--    Art. 2:194 lid 1 BW vraagt per aandeelhouder de datum van verkrijging, de
--    datum van erkenning of betekening, de soort van de aandelen en het op
--    ieder aandeel gestorte bedrag. Dat zijn allemaal eigenschappen van een
--    GEBEURTENIS, niet van een persoon: wie in 2019 tien aandelen kocht en in
--    2024 vijf verkocht, heeft twee verkrijgingsdata en misschien twee
--    stortingsbedragen. Een kolom "aantal aandelen" op de aandeelhouder zou dat
--    platslaan en het register onbruikbaar maken als bewijs.
--
--    Vier soorten gebeurtenissen:
--      * issue        — uitgifte door de vennootschap (van niemand, naar iemand)
--      * transfer     — overdracht tussen twee houders
--      * repurchase   — inkoop: de vennootschap koopt eigen aandelen terug. Ze
--                       blijven bestaan maar geven geen stemrecht meer
--                       (art. 2:228 lid 6 BW) en tellen dus niet mee in het
--                       stem- en winstbelang van de anderen.
--      * cancellation — intrekking: de aandelen houden op te bestaan. Vanaf een
--                       houder óf vanaf de eigen portefeuille (dan is
--                       from_shareholder_id leeg).
-- ------------------------------------------------------------
create table if not exists public.share_transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  kind text not null,
  -- Datum van verkrijging (art. 2:194 lid 1 BW).
  event_date date not null,
  -- Datum van erkenning door de vennootschap of betekening van de akte
  -- (art. 2:194 lid 1 jo. 2:196a BW). Los van de verkrijgingsdatum, want een
  -- levering en de erkenning ervan vallen niet altijd samen.
  acknowledged_on date,
  -- "De soort of de aanduiding van de aandelen". Vrije tekst: statuten kennen
  -- gewone aandelen, letteraandelen, prioriteitsaandelen, stemrechtloze en
  -- winstrechtloze aandelen — geen lijst die wij kunnen dichttimmeren.
  share_class text not null default 'gewoon',
  quantity integer not null check (quantity > 0),
  -- Nominale waarde en gestort bedrag PER AANDEEL, in centen.
  nominal_value_cents bigint not null default 0 check (nominal_value_cents >= 0),
  paid_up_cents bigint not null default 0 check (paid_up_cents >= 0),
  from_shareholder_id uuid references public.shareholders(id) on delete restrict,
  to_shareholder_id uuid references public.shareholders(id) on delete restrict,
  -- Verwijzing naar de notariële akte; bij een BV is levering van aandelen
  -- alleen bij notariële akte mogelijk (art. 2:196 BW).
  deed_reference text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint share_transactions_kind_check check (kind in ('issue', 'transfer', 'repurchase', 'cancellation')),
  constraint share_transactions_class_not_blank check (btrim(share_class) <> ''),
  -- Elke soort heeft zijn eigen richting; zonder deze check kan een uitgifte
  -- "van" iemand komen en dan klopt geen enkele stand meer.
  constraint share_transactions_direction_check check (
    case kind
      when 'issue'        then from_shareholder_id is null and to_shareholder_id is not null
      when 'transfer'     then from_shareholder_id is not null and to_shareholder_id is not null
                               and from_shareholder_id <> to_shareholder_id
      when 'repurchase'   then from_shareholder_id is not null and to_shareholder_id is null
      when 'cancellation' then to_shareholder_id is null
      else false
    end
  ),
  -- Het gestorte bedrag kan niet hoger zijn dan de nominale waarde; wat daar
  -- bovenop komt is agio en staat op 0505, niet op het aandeel.
  constraint share_transactions_paid_up_check check (paid_up_cents <= nominal_value_cents)
);

comment on table public.share_transactions is
  'Mutaties in het aandelenbezit: uitgifte, overdracht, inkoop en intrekking. Samen met shareholders vormt dit het register van art. 2:194 BW.';

create index if not exists idx_share_transactions_org on public.share_transactions(organization_id, event_date desc);
create index if not exists idx_share_transactions_from on public.share_transactions(from_shareholder_id);
create index if not exists idx_share_transactions_to on public.share_transactions(to_shareholder_id);

alter table public.share_transactions enable row level security;
drop policy if exists "share_transactions read" on public.share_transactions;
create policy "share_transactions read" on public.share_transactions
  for select using (public.can_read_org(organization_id));
drop policy if exists "share_transactions write" on public.share_transactions;
create policy "share_transactions write" on public.share_transactions
  for all using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id));
select public.apply_module_gate('share_transactions', 'finance');

drop trigger if exists share_transactions_touch_updated_at on public.share_transactions;
create trigger share_transactions_touch_updated_at before update on public.share_transactions
  for each row execute function public.bookkeeping_touch_updated_at();
drop trigger if exists share_transactions_prevent_org_change on public.share_transactions;
create trigger share_transactions_prevent_org_change before update of organization_id on public.share_transactions
  for each row execute function public.prevent_organization_id_change();
drop trigger if exists share_transactions_audit on public.share_transactions;
create trigger share_transactions_audit after insert or update or delete on public.share_transactions
  -- De tabel heeft geen naam; de soort mutatie is het herkenbaarste label.
  for each row execute function public.audit_row_change('share_transaction', 'kind');

-- Een aandeelhouder verwijst naar de organisatie, en een mutatie naar twee
-- aandeelhouders. Die drie moeten bij dezelfde organisatie horen, anders staat
-- de aandeelhouder van de holding in het register van de werk-BV.
create or replace function public.share_transactions_check_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  if new.from_shareholder_id is not null then
    select organization_id into v_org from public.shareholders where id = new.from_shareholder_id;
    if v_org is distinct from new.organization_id then
      raise exception 'De vervreemder hoort niet bij deze administratie.' using errcode = '42501';
    end if;
  end if;
  if new.to_shareholder_id is not null then
    select organization_id into v_org from public.shareholders where id = new.to_shareholder_id;
    if v_org is distinct from new.organization_id then
      raise exception 'De verkrijger hoort niet bij deze administratie.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.share_transactions_check_org() from public, anon, authenticated;

drop trigger if exists share_transactions_check_org on public.share_transactions;
create trigger share_transactions_check_org
  before insert or update of organization_id, from_shareholder_id, to_shareholder_id
  on public.share_transactions
  for each row execute function public.share_transactions_check_org();

-- ------------------------------------------------------------
-- 4. Pandrecht en vruchtgebruik (art. 2:194 lid 2 BW)
--    Verplicht onderdeel van het register, en het doet er echt toe: rust er
--    vruchtgebruik op een aandeel, dan kan het dividend aan de vruchtgebruiker
--    toekomen in plaats van aan de aandeelhouder. Wij leggen het vast en tonen
--    het bij een dividendbesluit; wie het geld krijgt bepaalt de gebruiker.
-- ------------------------------------------------------------
create table if not exists public.share_encumbrances (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  shareholder_id uuid not null references public.shareholders(id) on delete cascade,
  kind text not null,
  holder_name text not null,
  holder_address text,
  share_class text not null default 'gewoon',
  quantity integer not null check (quantity > 0),
  established_on date not null,
  acknowledged_on date,
  ended_on date,
  -- Welke aan de aandelen verbonden rechten de pandhouder of vruchtgebruiker
  -- toekomen — art. 2:194 lid 2 BW vraagt dat met zoveel woorden.
  has_voting_rights boolean not null default false,
  has_dividend_rights boolean not null default false,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint share_encumbrances_kind_check check (kind in ('pledge', 'usufruct')),
  constraint share_encumbrances_holder_not_blank check (btrim(holder_name) <> ''),
  constraint share_encumbrances_period_check check (ended_on is null or ended_on >= established_on)
);

comment on table public.share_encumbrances is
  'Pandrechten en vruchtgebruik op aandelen, met de rechten die de houder toekomen (art. 2:194 lid 2 BW).';

create index if not exists idx_share_encumbrances_org on public.share_encumbrances(organization_id, established_on desc);

alter table public.share_encumbrances enable row level security;
drop policy if exists "share_encumbrances read" on public.share_encumbrances;
create policy "share_encumbrances read" on public.share_encumbrances
  for select using (public.can_read_org(organization_id));
drop policy if exists "share_encumbrances write" on public.share_encumbrances;
create policy "share_encumbrances write" on public.share_encumbrances
  for all using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id));
select public.apply_module_gate('share_encumbrances', 'finance');

drop trigger if exists share_encumbrances_touch_updated_at on public.share_encumbrances;
create trigger share_encumbrances_touch_updated_at before update on public.share_encumbrances
  for each row execute function public.bookkeeping_touch_updated_at();
drop trigger if exists share_encumbrances_prevent_org_change on public.share_encumbrances;
create trigger share_encumbrances_prevent_org_change before update of organization_id on public.share_encumbrances
  for each row execute function public.prevent_organization_id_change();

-- Zelfde org-integriteit als bij de mutaties.
create or replace function public.share_encumbrances_check_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.shareholders where id = new.shareholder_id;
  if v_org is distinct from new.organization_id then
    raise exception 'De aandeelhouder hoort niet bij deze administratie.' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.share_encumbrances_check_org() from public, anon, authenticated;

drop trigger if exists share_encumbrances_check_org on public.share_encumbrances;
create trigger share_encumbrances_check_org
  before insert or update of organization_id, shareholder_id
  on public.share_encumbrances
  for each row execute function public.share_encumbrances_check_org();

-- ------------------------------------------------------------
-- 5. De stand van het register op een datum
--    Optellen wat er in- en uitging tot en met de peildatum. Aandelen die de
--    vennootschap zelf houdt (ingekocht) horen bij niemand meer en tellen dus
--    vanzelf niet mee in het belang van de anderen — precies wat art. 2:228
--    lid 6 BW voor het stemrecht voorschrijft.
-- ------------------------------------------------------------
create or replace function public.shareholder_positions(
  p_organization_id uuid,
  p_as_of date default current_date
)
returns table(
  shareholder_id uuid,
  name text,
  kind text,
  is_dga boolean,
  withholding_exempt boolean,
  share_class text,
  shares bigint,
  nominal_cents bigint,
  paid_up_cents bigint,
  first_acquired date,
  share_basis_points integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  return query
  with mutaties as (
    select st.to_shareholder_id as sh, st.share_class as cls,
           st.quantity::bigint as q,
           (st.quantity::bigint * st.nominal_value_cents) as nom,
           (st.quantity::bigint * st.paid_up_cents) as paid,
           st.event_date as d
    from public.share_transactions st
    where st.organization_id = p_organization_id
      and st.event_date <= p_as_of
      and st.to_shareholder_id is not null
    union all
    select st.from_shareholder_id, st.share_class,
           -st.quantity::bigint,
           -(st.quantity::bigint * st.nominal_value_cents),
           -(st.quantity::bigint * st.paid_up_cents),
           st.event_date
    from public.share_transactions st
    where st.organization_id = p_organization_id
      and st.event_date <= p_as_of
      and st.from_shareholder_id is not null
  ),
  standen as (
    -- sum() over bigint levert numeric; expliciet terug naar bigint, anders
    -- botst het met het aangegeven resultaattype van deze functie.
    select m.sh, m.cls,
           sum(m.q)::bigint as shares,
           sum(m.nom)::bigint as nominal_cents,
           sum(m.paid)::bigint as paid_up_cents,
           -- Alleen de verkrijgingen tellen voor "sinds wanneer aandeelhouder";
           -- een verkoop is geen verkrijgingsdatum.
           min(m.d) filter (where m.q > 0) as first_acquired
    from mutaties m
    group by m.sh, m.cls
    having sum(m.q) <> 0
  ),
  totaal as (
    select coalesce(sum(s.shares), 0)::bigint as alles from standen s where s.shares > 0
  )
  select
    sh.id, sh.name, sh.kind, sh.is_dga, sh.withholding_exempt,
    st.cls, st.shares, st.nominal_cents, st.paid_up_cents, st.first_acquired,
    case when t.alles > 0 then round(st.shares * 10000.0 / t.alles)::integer else 0 end
  from standen st
  join public.shareholders sh on sh.id = st.sh
  cross join totaal t
  order by sh.name, st.cls;
end;
$$;

comment on function public.shareholder_positions(uuid, date) is
  'Aandelenbezit per aandeelhouder per soort op een peildatum, met het belang in basispunten. Door de vennootschap ingekochte aandelen horen bij niemand en tellen niet mee in de noemer.';

revoke all on function public.shareholder_positions(uuid, date) from public, anon, authenticated;
grant execute on function public.shareholder_positions(uuid, date) to authenticated, service_role;

-- ------------------------------------------------------------
-- 6. De uitkering zelf
-- ------------------------------------------------------------
create table if not exists public.dividend_distributions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  -- 'final'   — uit de winst die de vaststelling van de jaarrekening bepaalde;
  --             de schuld op 1580 staat er dan al (appropriate_result).
  -- 'interim' — tussentijds, uit de reserves of de lopende winst; die schuld
  --             ontstaat hier.
  kind text not null,
  result_appropriation_id uuid references public.result_appropriations(id) on delete restrict,
  decision_date date not null,
  -- Het tijdstip waarop de opbrengst ter beschikking is gesteld: hét moment
  -- voor de dividendbelasting (art. 7 lid 3 Wet DB 1965) en het startpunt van
  -- de betaaltermijn (art. 19 lid 3 AWR).
  available_date date not null,
  gross_cents bigint not null check (gross_cents > 0),
  tax_cents bigint not null check (tax_cents >= 0),
  net_cents bigint not null check (net_cents >= 0),
  tax_rate_basis_points integer not null,
  source_account_code text,
  payable_account_code text not null default '1580',
  tax_account_code text not null default '1560',
  distributable_cents bigint,
  board_approved boolean not null default false,
  board_approved_by uuid references auth.users(id) on delete set null,
  board_approved_at timestamptz,
  -- Boekstuk A (alleen bij interim): eigen vermogen → 1580.
  declaration_entry_id uuid references public.journal_entries(id) on delete set null,
  -- Boekstuk B: 1580 → 1560. Leeg als er niets in te houden viel.
  withholding_entry_id uuid references public.journal_entries(id) on delete set null,
  status text not null default 'posted',
  reversed_at timestamptz,
  reversed_by uuid references auth.users(id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dividend_distributions_kind_check check (kind in ('final', 'interim')),
  constraint dividend_distributions_status_check check (status in ('posted', 'reversed')),
  constraint dividend_distributions_split_check check (tax_cents + net_cents = gross_cents),
  constraint dividend_distributions_dates_check check (available_date >= decision_date),
  -- Een dividend uit de vastgestelde winst hangt per definitie aan een besluit
  -- van de algemene vergadering; een interim-dividend juist niet.
  constraint dividend_distributions_source_check check (
    case kind
      when 'final'   then result_appropriation_id is not null
      when 'interim' then result_appropriation_id is null and source_account_code is not null
      else false
    end
  )
);

comment on table public.dividend_distributions is
  'Dividenduitkeringen met de uitkeringstoets van art. 2:216 BW en de ingehouden dividendbelasting (Wet DB 1965).';

create index if not exists idx_dividend_distributions_org
  on public.dividend_distributions(organization_id, available_date desc);

-- Eén geldige uitkering per resultaatbestemming: de bestemming boekte precies
-- één bruto bedrag op 1580 en dat kan maar één keer worden ingehouden.
create unique index if not exists uq_dividend_distributions_appropriation
  on public.dividend_distributions(result_appropriation_id)
  where status = 'posted' and result_appropriation_id is not null;

alter table public.dividend_distributions enable row level security;
-- Alleen lezen; alle mutatie via de RPC's hieronder.
drop policy if exists "dividend_distributions read" on public.dividend_distributions;
create policy "dividend_distributions read" on public.dividend_distributions
  for select using (public.can_read_org(organization_id));
select public.apply_module_gate('dividend_distributions', 'finance');

drop trigger if exists dividend_distributions_touch_updated_at on public.dividend_distributions;
create trigger dividend_distributions_touch_updated_at before update on public.dividend_distributions
  for each row execute function public.bookkeeping_touch_updated_at();
drop trigger if exists dividend_distributions_prevent_org_change on public.dividend_distributions;
create trigger dividend_distributions_prevent_org_change before update of organization_id on public.dividend_distributions
  for each row execute function public.prevent_organization_id_change();
drop trigger if exists dividend_distributions_audit on public.dividend_distributions;
create trigger dividend_distributions_audit after insert or update or delete on public.dividend_distributions
  for each row execute function public.audit_row_change('dividend_distribution', 'available_date');

-- ------------------------------------------------------------
-- 7. Per aandeelhouder: wat krijgt hij, en is er ingehouden?
--    Dit is de onderbouwing van de aangifte én de basis voor de dividendnota
--    van art. 9 Wet DB 1965. De vrijstelling wordt hier VASTGEKLONKEN, niet
--    opgezocht bij de aandeelhouder: verandert die vlag volgend jaar, dan mag
--    dat een uitkering van vorig jaar niet met terugwerkende kracht anders
--    laten uitzien.
-- ------------------------------------------------------------
create table if not exists public.dividend_distribution_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  distribution_id uuid not null references public.dividend_distributions(id) on delete cascade,
  shareholder_id uuid not null references public.shareholders(id) on delete restrict,
  -- Aantal aandelen op de besluitdatum, puur ter onderbouwing van de verdeling.
  shares bigint not null default 0,
  gross_cents bigint not null check (gross_cents >= 0),
  withholding_exempt boolean not null default false,
  exempt_note text,
  tax_cents bigint not null check (tax_cents >= 0),
  net_cents bigint not null check (net_cents >= 0),
  created_at timestamptz not null default now(),
  constraint dividend_lines_split_check check (tax_cents + net_cents = gross_cents),
  unique (distribution_id, shareholder_id)
);

create index if not exists idx_dividend_lines_distribution
  on public.dividend_distribution_lines(distribution_id);

alter table public.dividend_distribution_lines enable row level security;
drop policy if exists "dividend_distribution_lines read" on public.dividend_distribution_lines;
create policy "dividend_distribution_lines read" on public.dividend_distribution_lines
  for select using (public.can_read_org(organization_id));
select public.apply_module_gate('dividend_distribution_lines', 'finance');

-- ------------------------------------------------------------
-- 8. Het tarief opzoeken
-- ------------------------------------------------------------
create or replace function public.dividend_tax_rate_on(p_date date)
returns integer
language sql
stable
as $$
  select r.rate_basis_points
  from public.dividend_tax_rates r
  where r.valid_from <= p_date
  order by r.valid_from desc
  limit 1;
$$;

revoke all on function public.dividend_tax_rate_on(date) from public, anon, authenticated;
grant execute on function public.dividend_tax_rate_on(date) to authenticated, service_role;

-- ------------------------------------------------------------
-- 9. declare_dividend — het besluit vastleggen, inhouden en boeken
-- ------------------------------------------------------------
create or replace function public.declare_dividend(
  p_organization_id uuid,
  p_kind text,
  p_decision_date date,
  p_available_date date,
  p_lines jsonb,
  p_result_appropriation_id uuid default null,
  p_board_approved boolean default false,
  p_source_account_code text default '0520',
  p_note text default null,
  p_created_by uuid default auth.uid()
)
returns public.dividend_distributions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.dividend_distributions;
  v_appropriation public.result_appropriations;
  v_kind text := coalesce(nullif(btrim(p_kind), ''), 'interim');
  v_rate integer;
  v_gross bigint := 0;
  v_tax bigint := 0;
  v_line jsonb;
  v_shareholder uuid;
  v_line_gross bigint;
  v_line_tax bigint;
  v_exempt boolean;
  v_exempt_note text;
  v_shares bigint;
  v_seen uuid[] := array[]::uuid[];
  v_distributable bigint;
  v_legal_form text;
  v_source_code text := coalesce(nullif(btrim(p_source_account_code), ''), '0520');
  v_source_account uuid;
  v_payable_account uuid;
  v_tax_account uuid;
  v_account_type text;
  v_restricted boolean;
  v_subtype text;
  -- Bewust losse uuid's en geen rowtype-variabelen: bij een dividend uit de
  -- vastgestelde winst valt boekstuk A weg en bij een volledig vrijgestelde
  -- uitkering boekstuk B, en dan moet het veld gewoon leeg blijven.
  v_declaration_entry uuid;
  v_withholding_entry uuid;
  v_board boolean := coalesce(p_board_approved, false);
  v_closed record;
  v_prepared jsonb := '[]'::jsonb;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  -- Zelfde slot als het afsluiten en de resultaatbestemming: die verplaatsen
  -- hetzelfde eigen vermogen en dezelfde schuld op 1580.
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':fyclose'));

  if not public.org_has_business(p_organization_id) then
    raise exception 'Dividend hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;
  if not public.org_is_corporate(p_organization_id) then
    raise exception 'Dividend op aandelen hoort bij een BV of NV. Bij deze rechtsvorm speelt het niet.'
      using errcode = '23514';
  end if;

  if v_kind not in ('final', 'interim') then
    raise exception 'Onbekende soort uitkering: %.', v_kind using errcode = '23514';
  end if;
  if p_decision_date is null or p_available_date is null then
    raise exception 'Zowel de besluitdatum als de datum van terbeschikkingstelling is verplicht.' using errcode = '23514';
  end if;
  if p_available_date < p_decision_date then
    raise exception 'Het dividend kan niet ter beschikking zijn gesteld vóór het besluit.' using errcode = '23514';
  end if;

  v_rate := public.dividend_tax_rate_on(p_available_date);
  if v_rate is null then
    raise exception 'Voor % is geen tarief dividendbelasting vastgelegd.', to_char(p_available_date, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;

  -- ---- De verdeling over de aandeelhouders --------------------------------
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Een dividendbesluit heeft minstens één aandeelhouder nodig.' using errcode = '23514';
  end if;

  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    v_shareholder := nullif(v_line->>'shareholder_id', '')::uuid;
    v_line_gross := coalesce((v_line->>'gross_cents')::bigint, 0);

    if v_shareholder is null then
      raise exception 'Elke regel moet een aandeelhouder noemen.' using errcode = '23514';
    end if;
    if v_line_gross < 0 then
      raise exception 'Een dividendbedrag kan niet negatief zijn.' using errcode = '23514';
    end if;
    if v_shareholder = any (v_seen) then
      raise exception 'Dezelfde aandeelhouder staat twee keer in het besluit.' using errcode = '23505';
    end if;
    v_seen := v_seen || v_shareholder;

    select sh.withholding_exempt, sh.withholding_exempt_note
    into v_exempt, v_exempt_note
    from public.shareholders sh
    where sh.id = v_shareholder and sh.organization_id = p_organization_id;
    if not found then
      raise exception 'Aandeelhouder niet gevonden in deze administratie.' using errcode = '02000';
    end if;

    -- Aantal aandelen op de besluitdatum, alleen als onderbouwing van de
    -- verdeling. Het bedrag komt van de aanroeper: de statuten kunnen
    -- soorten aandelen kennen die niet gelijk delen, en dan is pro rata fout.
    select coalesce(sum(p.shares), 0) into v_shares
    from public.shareholder_positions(p_organization_id, p_decision_date) p
    where p.shareholder_id = v_shareholder;

    -- Vrijgesteld = niets inhouden (art. 4 Wet DB 1965). Anders het tarief over
    -- het bruto bedrag, per aandeelhouder afgerond — zo telt de som van de
    -- regels altijd op tot het totaal van de uitkering.
    v_line_tax := case when v_exempt then 0
                       else round(v_line_gross::numeric * v_rate / 10000)::bigint end;

    v_gross := v_gross + v_line_gross;
    v_tax := v_tax + v_line_tax;

    v_prepared := v_prepared || jsonb_build_array(jsonb_build_object(
      'shareholder_id', v_shareholder,
      'shares', v_shares,
      'gross_cents', v_line_gross,
      'withholding_exempt', v_exempt,
      'exempt_note', case when v_exempt then v_exempt_note end,
      'tax_cents', v_line_tax,
      'net_cents', v_line_gross - v_line_tax
    ));
  end loop;

  if v_gross <= 0 then
    raise exception 'Er valt niets uit te keren: het totaal is nul.' using errcode = '23514';
  end if;

  -- ---- Waar komt het vandaan? ---------------------------------------------
  v_legal_form := public.org_legal_form(p_organization_id);

  if v_kind = 'final' then
    if p_result_appropriation_id is null then
      raise exception 'Een dividend uit de vastgestelde winst hoort bij een besluit van de algemene vergadering.'
        using errcode = '23514';
    end if;

    select * into v_appropriation from public.result_appropriations
    where id = p_result_appropriation_id and organization_id = p_organization_id for update;
    if not found then
      raise exception 'Resultaatbestemming niet gevonden.' using errcode = '02000';
    end if;
    if v_appropriation.status <> 'posted' then
      raise exception 'Die resultaatbestemming is teruggedraaid.' using errcode = '23514';
    end if;
    if v_appropriation.dividend_cents <= 0 then
      raise exception 'Dat besluit kende geen dividend toe.' using errcode = '23514';
    end if;
    if v_gross <> v_appropriation.dividend_cents then
      raise exception 'De verdeling moet precies het toegekende dividend van % cent bedragen, nu % cent.',
        v_appropriation.dividend_cents, v_gross using errcode = '23514';
    end if;
    if exists (
      select 1 from public.dividend_distributions d
      where d.result_appropriation_id = p_result_appropriation_id and d.status = 'posted'
    ) then
      raise exception 'Dit dividend is al uitgekeerd. Draai die uitkering eerst terug.' using errcode = '23505';
    end if;
    if p_decision_date < v_appropriation.decision_date then
      raise exception 'De uitkering kan niet vóór het besluit van % liggen.',
        to_char(v_appropriation.decision_date, 'DD-MM-YYYY') using errcode = '23514';
    end if;

    -- De balanstest en de bestuursgoedkeuring zijn bij dát besluit al gedaan;
    -- opnieuw toetsen zou onzin opleveren, want het bruto bedrag staat al niet
    -- meer in het eigen vermogen maar op 1580.
    v_distributable := v_appropriation.distributable_cents;
    v_board := v_appropriation.board_approved;
    v_source_code := null;
  else
    -- ---- Interim: hier gelden beide toetsen van art. 2:216 BW wél ----------
    -- Lid 1 spreekt van "vaststelling van uitkeringen" en dekt daarmee ook de
    -- tussentijdse. Peildatum is de besluitdatum: dat is het moment waarop het
    -- bestuur en de vergadering naar het vermogen kijken.
    v_distributable := public.org_distributable_equity(
      p_organization_id, p_decision_date, v_legal_form = 'nv'
    );

    if v_gross > v_distributable then
      if v_legal_form = 'nv' then
        raise exception 'Balanstest (art. 2:105 lid 2 BW): vrij uitkeerbaar is op % nog % cent — het eigen vermogen boven het gestorte kapitaal en de wettelijke en statutaire reserves. Het besluit keert % cent uit.',
          to_char(p_decision_date, 'DD-MM-YYYY'), v_distributable, v_gross using errcode = '23514';
      else
        raise exception 'Balanstest (art. 2:216 lid 1 BW): vrij uitkeerbaar is op % nog % cent — het eigen vermogen boven de wettelijke en statutaire reserves. Het besluit keert % cent uit.',
          to_char(p_decision_date, 'DD-MM-YYYY'), v_distributable, v_gross using errcode = '23514';
      end if;
    end if;

    if not v_board then
      raise exception 'Uitkeringstest (art. 2:216 lid 2 BW): het bestuur moet bevestigen dat de vennootschap haar opeisbare schulden ook ná deze uitkering kan blijven betalen. Zonder die goedkeuring heeft het besluit geen gevolgen.'
        using errcode = '23514';
    end if;
  end if;

  -- ---- Periodesloten, vriendelijk gemeld ----------------------------------
  -- post_journal_entry weigert straks alsnog, maar met een generieke melding.
  -- Een dividend raakt geen btw-rubriek, dus hier is geen vrijstelling nodig
  -- zoals bij de jaarafsluiting: de datum ligt gewoon in een open periode of de
  -- gebruiker kiest een andere.
  select cp.period_start, cp.period_end into v_closed
  from public.closed_periods cp
  where cp.organization_id = p_organization_id
    and (
      (v_kind = 'interim' and p_decision_date between cp.period_start and cp.period_end)
      or (v_tax > 0 and p_available_date between cp.period_start and cp.period_end)
    )
  limit 1;
  if found then
    raise exception 'De periode % t/m % is afgesloten; kies data in een open periode.',
      to_char(v_closed.period_start, 'DD-MM-YYYY'), to_char(v_closed.period_end, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;

  -- ---- Boeken --------------------------------------------------------------
  perform public.ensure_default_ledger_accounts(p_organization_id);

  v_payable_account := public.bookkeeping_account_id(p_organization_id, '1580');
  select la.type into v_account_type from public.ledger_accounts la where la.id = v_payable_account;
  if v_account_type <> 'liability' then
    raise exception 'Rekening 1580 is geen schuldrekening; een dividendbesluit levert een schuld aan de aandeelhouder op.'
      using errcode = '23514';
  end if;

  if v_kind = 'interim' then
    v_source_account := public.bookkeeping_account_id(p_organization_id, v_source_code);
    select la.type, la.is_restricted_reserve, la.subtype
    into v_account_type, v_restricted, v_subtype
    from public.ledger_accounts la where la.id = v_source_account;

    if v_account_type <> 'equity' then
      raise exception 'Rekening % is geen eigen-vermogensrekening; een tussentijdse uitkering gaat ten laste van de reserves.', v_source_code
        using errcode = '23514';
    end if;
    -- Een wettelijke of statutaire reserve is nu juist het deel dat NIET
    -- uitgekeerd mag worden; daar een dividend uit boeken zou de balanstest
    -- via de achterdeur omzeilen.
    if coalesce(v_restricted, false) or coalesce(v_subtype, '') in ('legal_reserve', 'statutory_reserve') then
      raise exception 'Rekening % is een wettelijke of statutaire reserve; die moet worden aangehouden en kan niet worden uitgekeerd (art. 2:216 lid 1 BW).', v_source_code
        using errcode = '23514';
    end if;

    v_declaration_entry := (public.post_journal_entry(
      p_organization_id, p_decision_date,
      'Interim-dividend ' || to_char(p_decision_date, 'DD-MM-YYYY'),
      'dividend', null,
      jsonb_build_array(
        jsonb_build_object('account_id', v_source_account,
          'description', 'Tussentijdse uitkering ten laste van de reserves',
          'debit_cents', v_gross, 'credit_cents', 0),
        jsonb_build_object('account_id', v_payable_account,
          'description', 'Te betalen dividend',
          'debit_cents', 0, 'credit_cents', v_gross)
      ), p_created_by)).id;
  end if;

  if v_tax > 0 then
    v_tax_account := public.bookkeeping_account_id(p_organization_id, '1560');
    select la.type into v_account_type from public.ledger_accounts la where la.id = v_tax_account;
    if v_account_type <> 'liability' then
      raise exception 'Rekening 1560 is geen schuldrekening; ingehouden dividendbelasting is een schuld aan de Belastingdienst.'
        using errcode = '23514';
    end if;

    -- Inhouden verplaatst een deel van de schuld aan de aandeelhouder naar een
    -- schuld aan de Belastingdienst. Het eigen vermogen verandert hier niet
    -- meer: dat gebeurde bij het besluit.
    v_withholding_entry := (public.post_journal_entry(
      p_organization_id, p_available_date,
      'Dividendbelasting ' || to_char(p_available_date, 'DD-MM-YYYY'),
      'dividend', null,
      jsonb_build_array(
        jsonb_build_object('account_id', v_payable_account,
          'description', 'Ingehouden dividendbelasting',
          'debit_cents', v_tax, 'credit_cents', 0),
        jsonb_build_object('account_id', v_tax_account,
          'description', 'Af te dragen dividendbelasting',
          'debit_cents', 0, 'credit_cents', v_tax)
      ), p_created_by)).id;
  end if;

  -- ---- Vastleggen ----------------------------------------------------------
  insert into public.dividend_distributions(
    organization_id, created_by, kind, result_appropriation_id,
    decision_date, available_date,
    gross_cents, tax_cents, net_cents, tax_rate_basis_points,
    source_account_code, payable_account_code, tax_account_code,
    distributable_cents, board_approved, board_approved_by, board_approved_at,
    declaration_entry_id, withholding_entry_id, status, note
  ) values (
    p_organization_id, p_created_by, v_kind, p_result_appropriation_id,
    p_decision_date, p_available_date,
    v_gross, v_tax, v_gross - v_tax, v_rate,
    v_source_code, '1580', '1560',
    v_distributable, v_board,
    case when v_board then p_created_by end,
    case when v_board then now() end,
    v_declaration_entry, v_withholding_entry,
    'posted', nullif(btrim(p_note), '')
  )
  returning * into v_row;

  insert into public.dividend_distribution_lines(
    organization_id, distribution_id, shareholder_id, shares,
    gross_cents, withholding_exempt, exempt_note, tax_cents, net_cents
  )
  select
    p_organization_id, v_row.id,
    (l->>'shareholder_id')::uuid,
    (l->>'shares')::bigint,
    (l->>'gross_cents')::bigint,
    (l->>'withholding_exempt')::boolean,
    nullif(l->>'exempt_note', ''),
    (l->>'tax_cents')::bigint,
    (l->>'net_cents')::bigint
  from jsonb_array_elements(v_prepared) l;

  return v_row;
end;
$$;

comment on function public.declare_dividend(uuid, text, date, date, jsonb, uuid, boolean, text, text, uuid) is
  'Legt een dividendbesluit vast, houdt de dividendbelasting in en boekt beide. Bij een interim-dividend worden de balanstest en de bestuursgoedkeuring van art. 2:216 BW hier getoetst; bij een dividend uit de vastgestelde winst gebeurde dat al bij de resultaatbestemming.';

revoke all on function public.declare_dividend(uuid, text, date, date, jsonb, uuid, boolean, text, text, uuid) from public, anon, authenticated;
grant execute on function public.declare_dividend(uuid, text, date, date, jsonb, uuid, boolean, text, text, uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 10. Terugdraaien — boekstukken op 'reversed', zelfde keuze als elders
--     Geen spiegelpost: die zou op een nieuwe datum vallen die inmiddels in een
--     gefinaliseerde btw-periode kan liggen, en dan was de uitkering voorgoed
--     onomkeerbaar. Zie de toelichting bij reverse_result_appropriation.
-- ------------------------------------------------------------
create or replace function public.reverse_dividend_distribution(
  p_organization_id uuid,
  p_distribution_id uuid,
  p_created_by uuid default auth.uid()
)
returns public.dividend_distributions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.dividend_distributions;
  v_closed record;
begin
  if auth.role() <> 'service_role' and not public.can_admin_org(p_organization_id) then
    raise exception 'Alleen een eigenaar of beheerder mag een dividenduitkering terugdraaien.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':fyclose'));

  select * into v_row from public.dividend_distributions
  where id = p_distribution_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Dividenduitkering niet gevonden.' using errcode = '02000';
  end if;
  if v_row.status <> 'posted' then
    raise exception 'Deze uitkering is al teruggedraaid.' using errcode = '23514';
  end if;

  -- De boekstukken uit de rapporten halen verandert de balans van het boekjaar
  -- waarin ze vallen. Is dát jaar afgesloten, dan zou de vastgestelde balans
  -- ervan met terugwerkende kracht veranderen. Alleen JAAR-sloten tellen: een
  -- gefinaliseerde btw-aangifte gaat nooit meer open en een dividend komt in
  -- geen enkele btw-rubriek voor.
  select cp.period_start, cp.period_end into v_closed
  from public.closed_periods cp
  where cp.organization_id = p_organization_id
    and cp.period_type = 'year'
    and (v_row.decision_date between cp.period_start and cp.period_end
      or v_row.available_date between cp.period_start and cp.period_end)
  limit 1;
  if found then
    raise exception 'Deze uitkering valt in boekjaar % t/m %, en dat is afgesloten. Heropen dat boekjaar eerst.',
      to_char(v_closed.period_start, 'DD-MM-YYYY'), to_char(v_closed.period_end, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;

  update public.journal_entries set status = 'reversed'
  where organization_id = p_organization_id
    and status = 'posted'
    and id in (v_row.declaration_entry_id, v_row.withholding_entry_id);

  update public.dividend_distributions
  set status = 'reversed', reversed_at = now(), reversed_by = p_created_by
  where id = p_distribution_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.reverse_dividend_distribution(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.reverse_dividend_distribution(uuid, uuid, uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 11. list_dividend_distributions — overzicht plus de aangiftegegevens
--
--     De uiterste betaaldatum volgt uit art. 7 lid 4 Wet DB 1965 (afdragen op
--     aangifte) juncto art. 19 lid 3 AWR: belasting die op aangifte moet worden
--     afgedragen en niet over een tijdvak verschuldigd is, moet binnen één
--     maand na het ontstaan van de belastingschuld betaald zijn. Die schuld
--     ontstaat bij de terbeschikkingstelling (art. 7 lid 3).
-- ------------------------------------------------------------
create or replace function public.list_dividend_distributions(p_organization_id uuid)
returns table(
  id uuid,
  kind text,
  result_appropriation_id uuid,
  fiscal_year_label text,
  decision_date date,
  available_date date,
  gross_cents bigint,
  tax_cents bigint,
  net_cents bigint,
  tax_rate_basis_points integer,
  distributable_cents bigint,
  board_approved boolean,
  source_account_code text,
  declaration_entry_id uuid,
  declaration_entry_number text,
  withholding_entry_id uuid,
  withholding_entry_number text,
  filing_deadline date,
  status text,
  note text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  return query
    select
      d.id, d.kind, d.result_appropriation_id, f.label,
      d.decision_date, d.available_date,
      d.gross_cents, d.tax_cents, d.net_cents, d.tax_rate_basis_points,
      d.distributable_cents, d.board_approved, d.source_account_code,
      d.declaration_entry_id, ja.entry_number,
      d.withholding_entry_id, jb.entry_number,
      case when d.tax_cents > 0 then (d.available_date + interval '1 month')::date end,
      d.status, d.note, d.created_at
    from public.dividend_distributions d
    left join public.result_appropriations ra on ra.id = d.result_appropriation_id
    left join public.fiscal_years f on f.id = ra.fiscal_year_id
    left join public.journal_entries ja on ja.id = d.declaration_entry_id
    left join public.journal_entries jb on jb.id = d.withholding_entry_id
    where d.organization_id = p_organization_id
    order by d.available_date desc, d.created_at desc;
end;
$$;

revoke all on function public.list_dividend_distributions(uuid) from public, anon, authenticated;
grant execute on function public.list_dividend_distributions(uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 12. De regels van één uitkering — onderbouwing van de aangifte en de basis
--     voor de dividendnota van art. 9 Wet DB 1965.
-- ------------------------------------------------------------
create or replace function public.dividend_distribution_detail(
  p_organization_id uuid,
  p_distribution_id uuid
)
returns table(
  shareholder_id uuid,
  name text,
  kind text,
  address_line text,
  postal_code text,
  city text,
  country_code text,
  shares bigint,
  gross_cents bigint,
  withholding_exempt boolean,
  exempt_note text,
  tax_cents bigint,
  net_cents bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  return query
    select
      l.shareholder_id, sh.name, sh.kind,
      sh.address_line, sh.postal_code, sh.city, sh.country_code,
      l.shares, l.gross_cents, l.withholding_exempt, l.exempt_note,
      l.tax_cents, l.net_cents
    from public.dividend_distribution_lines l
    join public.shareholders sh on sh.id = l.shareholder_id
    join public.dividend_distributions d on d.id = l.distribution_id
    where d.id = p_distribution_id
      and d.organization_id = p_organization_id
      and l.organization_id = p_organization_id
    order by sh.name;
end;
$$;

revoke all on function public.dividend_distribution_detail(uuid, uuid) from public, anon, authenticated;
grant execute on function public.dividend_distribution_detail(uuid, uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 13. Nieuw boekstuk-brontype + los tegenboeken afschermen
--     reverse_journal_entry is LETTERLIJK overgenomen uit 20260807070000;
--     alleen de guard voor 'dividend' is toegevoegd.
-- ------------------------------------------------------------
alter table public.journal_entries drop constraint if exists journal_entries_source_type_check;
alter table public.journal_entries
  add constraint journal_entries_source_type_check check (source_type in (
    'sales_invoice','purchase_invoice','asset_depreciation','asset_acquisition','asset_disposal',
    'vat_return','payment','opening_balance','manual','year_close','credit_note',
    'result_appropriation','corporate_tax','dga_interest','payroll','dividend'
  ));

create or replace function public.reverse_journal_entry(
  p_entry_id uuid,
  p_date date default null,
  p_created_by uuid default auth.uid()
)
returns public.journal_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_src public.journal_entries;
  v_lines jsonb;
  v_reversal public.journal_entries;
begin
  -- for update: twee gelijktijdige tegenboekingen van hetzelfde boekstuk
  -- zouden anders allebei de reversed_by-check passeren.
  select * into v_src from public.journal_entries where id = p_entry_id for update;
  if not found then
    raise exception 'Boekstuk niet gevonden.' using errcode = '02000';
  end if;
  if auth.role() <> 'service_role' and not public.can_write_org(v_src.organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if v_src.status <> 'posted' then
    raise exception 'Alleen een geboekt (posted) boekstuk kan worden tegengeboekt.' using errcode = '23514';
  end if;
  if v_src.reversed_by_entry_id is not null then
    raise exception 'Boekstuk % is al tegengeboekt.', coalesce(v_src.entry_number, v_src.id::text)
      using errcode = '23514';
  end if;
  if v_src.source_type = 'year_close' then
    raise exception 'Een jaarafsluitboekstuk boek je niet tegen; gebruik "Boekjaar heropenen".'
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20260807030000): een resultaatbestemming is net zo'n
  -- systeemboekstuk. Wie hem hier tegenboekt, laat de rij in
  -- result_appropriations op 'posted' staan; het boekjaar blijft dan
  -- geblokkeerd voor heropenen én de nette weg ("Bestemming terugdraaien")
  -- weigert daarna met "al tegengeboekt". Dus meteen hier afvangen.
  if v_src.source_type = 'result_appropriation' then
    raise exception 'Een resultaatbestemming boek je niet los tegen; gebruik "Bestemming terugdraaien" bij het boekjaar.'
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20260807050000): idem voor de Vpb-reservering. Los tegenboeken
  -- laat corporate_tax_returns op 'final' staan en de verliesadministratie
  -- ongemoeid; daarna weigert "Berekening terugdraaien" met "al tegengeboekt".
  if v_src.source_type = 'corporate_tax' then
    raise exception 'Een Vpb-reservering boek je niet los tegen; gebruik "Berekening terugdraaien" bij het boekjaar.'
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20260807070000): idem voor de renteboeking op de
  -- rekening-courant DGA. Los tegenboeken laat dga_interest_postings op
  -- 'posted' staan, waardoor de rente over dat jaar nooit opnieuw geboekt kan
  -- worden en "Rente terugdraaien" daarna weigert.
  if v_src.source_type = 'dga_interest' then
    raise exception 'Een renteboeking op de rekening-courant boek je niet los tegen; gebruik "Rente terugdraaien".'
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20260807100000): idem voor een dividenduitkering. Die bestaat
  -- bovendien uit twee boekstukken; er één van tegenboeken laat een halve
  -- inhouding achter en zet dividend_distributions op slot.
  if v_src.source_type = 'dividend' then
    raise exception 'Een dividendboeking boek je niet los tegen; gebruik "Uitkering terugdraaien" bij het dividend.'
      using errcode = '23514';
  end if;
  -- Suppletie-integriteit: het origineel is uitgesloten van de reguliere
  -- aangifte, maar de spiegelpost zou er WEL in tellen → scheefstand. Correctie
  -- op een suppletie = nieuwe correctieboeking + desgewenst nieuwe suppletie.
  if exists (select 1 from public.vat_supplement_entries vse where vse.entry_id = v_src.id) then
    raise exception 'Boekstuk % is verrekend in een btw-suppletie en kan niet worden tegengeboekt. Maak een nieuwe correctieboeking (memoriaal) en verreken die in een nieuwe suppletie.',
      coalesce(v_src.entry_number, v_src.id::text) using errcode = '23514';
  end if;

  -- Wissel debet/credit per regel om.
  select jsonb_agg(jsonb_build_object(
    'account_id', jl.account_id,
    'description', coalesce(jl.description, '') || ' (tegenboeking)',
    'debit_cents', jl.credit_cents,
    'credit_cents', jl.debit_cents,
    'vat_code', jl.vat_code,
    'vat_rate', jl.vat_rate,
    'vat_base_cents', case when jl.vat_base_cents is null then null else -jl.vat_base_cents end,
    'vat_amount_cents', case when jl.vat_amount_cents is null then null else -jl.vat_amount_cents end,
    'client_id', jl.client_id,
    'supplier_id', jl.supplier_id,
    'project_id', jl.project_id
  ) order by jl.line_index)
  into v_lines
  from public.journal_lines jl
  where jl.entry_id = p_entry_id;

  v_reversal := public.post_journal_entry(
    v_src.organization_id,
    coalesce(p_date, current_date),
    'Tegenboeking van ' || coalesce(v_src.entry_number, v_src.id::text),
    v_src.source_type,
    v_src.source_id,
    v_lines,
    p_created_by
  );

  update public.journal_entries set reverses_entry_id = v_src.id where id = v_reversal.id;

  -- Het origineel blijft 'posted': het is echt gebeurd en blijft meetellen;
  -- de spiegelpost neutraliseert het saldo (netto 0 i.p.v. −1×). Alleen
  -- reversed_by_entry_id markeert het paar. NB: status='reversed' betekent
  -- "volledig uit de rapporten" en is gereserveerd voor reopen_fiscal_year.
  update public.journal_entries
  set reversed_by_entry_id = v_reversal.id, updated_at = now()
  where id = v_src.id;

  return v_reversal;
end;
$$;

-- ------------------------------------------------------------
-- 14. reverse_result_appropriation: eerst de uitkering terugdraaien
--
--     De bestemming boekte het BRUTO dividend op 1580. Is daarna de
--     dividendbelasting ingehouden (1580 → 1560), dan haalt het terugdraaien
--     van de bestemming de bruto schuld weg terwijl de inhouding blijft staan:
--     1580 loopt negatief en er staat een afdrachtschuld zonder dividend.
--     Volledige functie opnieuw (basis: 20260807030000), alleen de guard is nieuw.
-- ------------------------------------------------------------
create or replace function public.reverse_result_appropriation(
  p_organization_id uuid,
  p_appropriation_id uuid,
  p_created_by uuid default auth.uid()
)
returns public.result_appropriations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.result_appropriations;
  v_closed record;
begin
  if auth.role() <> 'service_role' and not public.can_admin_org(p_organization_id) then
    raise exception 'Alleen een eigenaar of beheerder mag een resultaatbestemming terugdraaien.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':fyclose'));

  select * into v_row from public.result_appropriations
  where id = p_appropriation_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Resultaatbestemming niet gevonden.' using errcode = '02000';
  end if;
  if v_row.status <> 'posted' then
    raise exception 'Deze resultaatbestemming is al teruggedraaid.' using errcode = '23514';
  end if;

  -- NIEUW (20260807100000): de uitkering die op deze bestemming steunt.
  if exists (
    select 1 from public.dividend_distributions d
    where d.result_appropriation_id = p_appropriation_id and d.status = 'posted'
  ) then
    raise exception 'Draai eerst de dividenduitkering terug; die houdt belasting in op de schuld die deze bestemming heeft geboekt.'
      using errcode = '23514';
  end if;

  -- Het boekstuk uit de rapporten halen verandert de balans van het boekjaar
  -- waarin het besluit valt. Is dát boekjaar inmiddels zelf afgesloten, dan zou
  -- de vastgestelde balans ervan met terugwerkende kracht veranderen — precies
  -- wat reopen_fiscal_year ook weigert. Eerst dat jaar heropenen dus.
  --
  -- Alleen jaar-sloten tellen hier. Een gefinaliseerde btw-aangifte (maand of
  -- kwartaal) vergrendelt wél het BOEKEN, maar deze post raakt uitsluitend
  -- eigen-vermogensrekeningen en verandert geen enkele rubriek van die
  -- aangifte. Zou een btw-slot hier blokkeren, dan was de bestemming alsnog
  -- voorgoed onomkeerbaar: zo'n slot gaat nooit meer open.
  select cp.period_start, cp.period_end into v_closed
  from public.closed_periods cp
  where cp.organization_id = p_organization_id
    and cp.period_type = 'year'
    and v_row.decision_date between cp.period_start and cp.period_end
  limit 1;
  if found then
    raise exception 'Het besluit van % valt in boekjaar % t/m %, en dat is afgesloten. Heropen dat boekjaar eerst; anders verandert de vastgestelde balans ervan met terugwerkende kracht.',
      to_char(v_row.decision_date, 'DD-MM-YYYY'),
      to_char(v_closed.period_start, 'DD-MM-YYYY'), to_char(v_closed.period_end, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;

  if v_row.journal_entry_id is not null then
    update public.journal_entries
    set status = 'reversed'
    where id = v_row.journal_entry_id
      and organization_id = p_organization_id
      and status = 'posted';
  end if;

  update public.result_appropriations
  set status = 'reversed', reversed_at = now(), reversed_by = p_created_by
  where id = p_appropriation_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.reverse_result_appropriation(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.reverse_result_appropriation(uuid, uuid, uuid) to authenticated, service_role;

commit;
