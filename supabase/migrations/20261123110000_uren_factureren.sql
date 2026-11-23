-- Uren factureren: van geregistreerde uren naar een conceptfactuur
-- =============================================================================
-- Aanleiding (controle "van werk naar geld", 22 november 2026, bevinding 1):
-- een zzp'er die per uur werkt kon zijn uren niet factureren. Hij las op de
-- pagina Uren "Declarabel" af en typte dat bedrag in een lege factuur. Een
-- urenregistratie wist niets van een factuur: dezelfde uren konden twee keer
-- op een factuur komen of juist vergeten worden, en na het factureren bleven
-- ze gewoon te wijzigen en te verwijderen.
--
-- Wat er nu is:
--   1. `time_entry_invoices`: per urenregistratie hooguit één factuur. De
--      primaire sleutel is de urenregistratie zelf, dus dubbel factureren kan
--      de database niet eens opslaan.
--   2. `time_invoice_preview`: wat er voor een klant of project in een periode
--      nog te factureren is, als factuurregels. Dezelfde berekening als bij
--      het aanmaken, zodat het scherm, Gerrie en de factuur hetzelfde zeggen.
--   3. `create_invoice_from_time_entries`: maakt in één transactie het concept
--      en legt de uren eraan vast.
--   4. Gefactureerde uren liggen vast (minuten, datum, tarief, declarabel,
--      omschrijving, project en klant) en zijn niet te verwijderen.
--   5. De uren komen weer vrij als de factuur vervalt: het concept wordt
--      verwijderd, de urenregel gaat uit het concept, of de factuur wordt
--      geannuleerd of ongeldig gemaakt (dat gebeurt ook na een volledige
--      creditnota). Een deelcreditnota is een prijscorrectie: de factuur
--      blijft staan, dus de uren blijven gefactureerd.
--
-- Waarom een eigen tabel en geen kolom op time_entries: een kolom wijzigen
-- loopt langs de schrijfpoort van de module Uren. Wie alleen Financiën mag
-- schrijven, kon dan een factuur met uren niet meer annuleren of verwijderen.
-- De koppeling hoort bij de factuur; de functies hieronder beheren hem.
--
-- Veilig om opnieuw te draaien. Bestaande gegevens: niets verandert. Uren die
-- al met de hand zijn gefactureerd, staan na deze migratie als "nog te
-- factureren"; zet ze op niet-declarabel of kies een periode die erna begint.

begin;

-- ── 1. De koppeling ─────────────────────────────────────────────────────────
create table if not exists public.time_entry_invoices (
  time_entry_id uuid primary key references public.time_entries(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  -- Het id van de factuurregel (invoices.lines[].id) waar dit uur in zit. Gaat
  -- die regel uit het concept, dan komt het uur weer vrij.
  line_id text,
  -- Wat er gefactureerd is, zoals het op dat moment stond.
  minutes integer not null check (minutes > 0),
  hourly_rate_cents integer not null check (hourly_rate_cents > 0),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

comment on table public.time_entry_invoices is
  'Welke urenregistratie op welke verkoopfactuur staat (hooguit één). Schrijven alleen via create_invoice_from_time_entries en de triggers op invoices.';

create index if not exists idx_time_entry_invoices_invoice on public.time_entry_invoices (invoice_id);
create index if not exists idx_time_entry_invoices_org on public.time_entry_invoices (organization_id);

alter table public.time_entry_invoices enable row level security;

-- Lezen hoort bij de uren: wie de module Uren niet mag lezen, ziet ook niet
-- welke uren gefactureerd zijn.
drop policy if exists "time entry invoices read" on public.time_entry_invoices;
create policy "time entry invoices read" on public.time_entry_invoices
  for select using (public.can_read_org(organization_id));
drop policy if exists "module gate select" on public.time_entry_invoices;
create policy "module gate select" on public.time_entry_invoices
  as restrictive for select to authenticated
  using (public.can_read_module(organization_id, 'time'));

-- Geen schrijfpolicy en geen schrijfrecht: anders kon iemand met de REST-API
-- een uur losmaken van zijn factuur en het nog eens factureren.
revoke all on public.time_entry_invoices from public, anon, authenticated;
grant select on public.time_entry_invoices to authenticated;
grant all on public.time_entry_invoices to service_role;

-- De boekhouder ziet de facturen, niet de uren: ook deze koppeling niet. Het
-- hek is alleen een policy; de modulepoort (apply_module_gate) zet ook een
-- schrijftrigger, en dan kon wie alleen Financiën mag schrijven een factuur
-- met uren niet meer annuleren of verwijderen.
select public.apply_accountant_fence('time_entry_invoices');

drop trigger if exists time_entry_invoices_prevent_org_change on public.time_entry_invoices;
create trigger time_entry_invoices_prevent_org_change before update of organization_id on public.time_entry_invoices
  for each row execute function public.prevent_organization_id_change();

-- ── 2. De berekening: uren → factuurregels ──────────────────────────────────
-- Eén functie voor het voorbeeld en voor het aanmaken. Rekende het scherm zelf
-- en de database apart, dan kon het concept iets anders bevatten dan het
-- voorbeeld liet zien.
--
-- Keuzes:
--   * alleen declarabele uren met een eigen uurtarief, net als "Declarabele
--     waarde" op de pagina Uren. Uren zonder tarief komen apart terug
--     (`without_rate`), zodat ze niet stil buiten de factuur vallen;
--   * 'project': één regel per project en tarief, met de periode erin;
--     'entry': één regel per registratie (datum en omschrijving), dat is
--     meteen de urenspecificatie voor de klant;
--   * afronden gebeurt per factuurregel en altijd naar boven; het aantal uren
--     krijgt twee decimalen, want dat is wat er op de factuur staat.
create or replace function public.time_invoice_build(
  p_organization_id uuid,
  p_client_id uuid,
  p_project_id uuid,
  p_from date,
  p_to date,
  p_grouping text,
  p_rounding_minutes integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grouping text := coalesce(nullif(btrim(p_grouping), ''), 'project');
  v_round integer := coalesce(p_rounding_minutes, 0);
  v_client_id uuid := p_client_id;
  v_project_client uuid;
  v_project_found boolean := false;
  v_kor boolean;
  v_vat numeric := 21;
  v_vat_code text;
  v_result jsonb;
  v_without jsonb;
begin
  if v_grouping not in ('project', 'entry') then
    raise exception 'Kies hoe de uren op de factuur komen: samengevoegd per project of per registratie.' using errcode = '22023';
  end if;
  if v_round not in (0, 6, 15, 30, 60) then
    raise exception 'Afronden kan op 6, 15, 30 of 60 minuten, of niet.' using errcode = '22023';
  end if;
  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'De periode begint na het einde.' using errcode = '22023';
  end if;

  if p_project_id is not null then
    select true, client_id into v_project_found, v_project_client
      from public.projects where id = p_project_id and organization_id = p_organization_id;
    if not coalesce(v_project_found, false) then
      raise exception 'Project niet gevonden.' using errcode = '02000';
    end if;
    v_client_id := coalesce(v_client_id, v_project_client);
  end if;
  if v_client_id is null then
    raise exception 'Kies een klant. Uren zonder klant kun je niet factureren.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.clients where id = v_client_id and organization_id = p_organization_id) then
    raise exception 'Klant niet gevonden.' using errcode = '02000';
  end if;

  -- De btw van een nieuwe regel, zoals het factuurformulier hem kiest: met de
  -- KOR 0% (code KOR), anders het hoge tarief.
  select coalesce(kor_enabled, false) into v_kor
    from public.company_settings where organization_id = p_organization_id;
  if coalesce(v_kor, false) then
    v_vat := 0;
    select code into v_vat_code from public.vat_codes
     where organization_id = p_organization_id and kind = 'kor' and is_active is not false
     order by code limit 1;
  else
    select code, rate into v_vat_code, v_vat from public.vat_codes
     where organization_id = p_organization_id and kind = 'standard' and is_active is not false
     order by rate desc, code limit 1;
    v_vat := coalesce(v_vat, 21);
  end if;

  with cand as (
    select te.id, te.entry_date, te.minutes, te.hourly_rate_cents as rate, te.project_id,
           p.name as project_name, nullif(btrim(te.description), '') as description
      from public.time_entries te
      left join public.projects p on p.id = te.project_id
     where te.organization_id = p_organization_id
       and te.client_id = v_client_id
       and (p_project_id is null or te.project_id = p_project_id)
       and te.billable
       and te.minutes > 0
       and (p_from is null or te.entry_date >= p_from)
       and (p_to is null or te.entry_date <= p_to)
       and not exists (select 1 from public.time_entry_invoices x where x.time_entry_id = te.id)
  ),
  grp as (
    select case when v_grouping = 'entry' then c.id::text else coalesce(c.project_id::text, '') end as k,
           c.rate,
           (min(c.project_id::text))::uuid as project_id,
           min(c.project_name) as project_name,
           sum(c.minutes)::integer as minutes,
           count(*)::integer as entry_count,
           min(c.entry_date) as d1,
           max(c.entry_date) as d2,
           min(c.description) as description,
           array_agg(c.id order by c.entry_date, c.id) as entry_ids
      from cand c
     where coalesce(c.rate, 0) > 0
     group by 1, c.rate
  ),
  priced as (
    select g.*,
           case when v_round > 0 then (ceil(g.minutes::numeric / v_round) * v_round)::integer else g.minutes end as billed_minutes
      from grp g
  ),
  line as (
    select p.*,
           round(p.billed_minutes / 60.0, 2) as quantity,
           gen_random_uuid()::text as line_id,
           case
             when v_grouping = 'entry' then
               to_char(p.d1, 'FMDD-FMMM-YYYY')
               || case when p_project_id is null and p.project_name is not null then ' · ' || p.project_name else '' end
               || ' · ' || coalesce(p.description, 'Uren')
             else
               'Uren' || coalesce(' ' || p.project_name, '') || ' ('
               || case when p.d1 = p.d2 then to_char(p.d1, 'FMDD-FMMM-YYYY')
                       else to_char(p.d1, 'FMDD-FMMM-YYYY') || ' t/m ' || to_char(p.d2, 'FMDD-FMMM-YYYY') end
               || ')'
           end as line_description
      from priced p
  )
  select jsonb_build_object(
    'client_id', v_client_id,
    'project_id', p_project_id,
    'from', p_from,
    'to', p_to,
    'grouping', v_grouping,
    'rounding_minutes', v_round,
    'entry_count', coalesce(sum(l.entry_count), 0),
    'minutes', coalesce(sum(l.minutes), 0),
    'billed_minutes', coalesce(sum(l.billed_minutes), 0),
    'subtotal_cents', coalesce(sum(round(l.quantity * l.rate)), 0),
    'first_date', min(l.d1),
    'last_date', max(l.d2),
    'project_ids', coalesce(jsonb_agg(distinct l.project_id) filter (where l.project_id is not null), '[]'::jsonb),
    'lines', coalesce(jsonb_agg(
      jsonb_strip_nulls(jsonb_build_object(
        'id', l.line_id,
        'description', left(l.line_description, 500),
        'quantity', l.quantity,
        'unit_price', round(l.rate / 100.0, 2),
        'vat', v_vat,
        'vat_code', v_vat_code,
        'minutes', l.minutes,
        'entry_count', l.entry_count,
        'project_id', l.project_id,
        'entry_ids', to_jsonb(l.entry_ids)
      ))
      order by case when v_grouping = 'entry' then l.d1 end, l.project_name nulls last, l.rate, l.k
    ), '[]'::jsonb)
  ) into v_result
  from line l;

  select jsonb_build_object('entry_count', count(*), 'minutes', coalesce(sum(te.minutes), 0)) into v_without
    from public.time_entries te
   where te.organization_id = p_organization_id
     and te.client_id = v_client_id
     and (p_project_id is null or te.project_id = p_project_id)
     and te.billable
     and te.minutes > 0
     and coalesce(te.hourly_rate_cents, 0) <= 0
     and (p_from is null or te.entry_date >= p_from)
     and (p_to is null or te.entry_date <= p_to)
     and not exists (select 1 from public.time_entry_invoices x where x.time_entry_id = te.id);

  return v_result || jsonb_build_object('without_rate', v_without);
end;
$$;

-- Alleen voor de twee functies hieronder: hij controleert zelf geen rechten.
revoke all on function public.time_invoice_build(uuid, uuid, uuid, date, date, text, integer) from public, anon, authenticated;
grant execute on function public.time_invoice_build(uuid, uuid, uuid, date, date, text, integer) to service_role;

-- ── 3. Het voorbeeld ────────────────────────────────────────────────────────
-- Voor het venster "Uren factureren" en voor Gerrie (service-role, die filtert
-- zelf op de organisatie uit de sessie). Bedragen horen bij Financiën, uren bij
-- Uren: je hebt beide leesrechten nodig.
create or replace function public.time_invoice_preview(
  p_organization_id uuid,
  p_client_id uuid default null,
  p_project_id uuid default null,
  p_from date default null,
  p_to date default null,
  p_grouping text default 'project',
  p_rounding_minutes integer default 0
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id)
              and public.can_read_module(p_organization_id, 'time')
              and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor de uren en facturen van deze organisatie.' using errcode = '42501';
  end if;
  v_result := public.time_invoice_build(p_organization_id, p_client_id, p_project_id, p_from, p_to, p_grouping, p_rounding_minutes);
  -- De losse id's van de uren zijn alleen bij het aanmaken nodig; bij een jaar
  -- aan registraties zijn dat duizenden id's.
  return jsonb_set(v_result, '{lines}', coalesce((
    select jsonb_agg(l - 'entry_ids' order by ord)
      from jsonb_array_elements(v_result->'lines') with ordinality as t(l, ord)
  ), '[]'::jsonb));
end;
$$;

revoke all on function public.time_invoice_preview(uuid, uuid, uuid, date, date, text, integer) from public, anon;
grant execute on function public.time_invoice_preview(uuid, uuid, uuid, date, date, text, integer) to authenticated, service_role;

-- ── 4. Het concept maken ────────────────────────────────────────────────────
-- Factuur en koppeling in één transactie: mislukt het een, dan is er ook het
-- ander niet. `p_expected_minutes` en `p_expected_subtotal_cents` zijn wat de
-- gebruiker (of de goedkeurkaart van Gerrie) zag; zijn er intussen uren
-- bijgekomen of veranderd, dan weigert de functie in plaats van iets anders te
-- factureren dan is goedgekeurd. Alleen de minuten was niet genoeg: kreeg een
-- uur intussen een ander tarief, dan kwam er een ander bedrag op de factuur
-- dan op de kaart stond.
--
-- Een eerdere opzet van deze migratie had de functie zonder het bedrag. Die
-- versie ruimen we op, anders heeft PostgREST twee functies met dezelfde naam.
drop function if exists public.create_invoice_from_time_entries(uuid, uuid, uuid, date, date, text, integer, integer);

create or replace function public.create_invoice_from_time_entries(
  p_organization_id uuid,
  p_client_id uuid default null,
  p_project_id uuid default null,
  p_from date default null,
  p_to date default null,
  p_grouping text default 'project',
  p_rounding_minutes integer default 0,
  p_expected_minutes integer default null,
  p_expected_subtotal_cents bigint default null
) returns public.invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_build jsonb;
  v_lines jsonb;
  v_invoice public.invoices;
  v_today date := (now() at time zone 'Europe/Amsterdam')::date;
  v_terms text;
  v_days integer := 14;
  v_project_id uuid := p_project_id;
  v_line_count integer;
begin
  if v_user_id is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;
  if not (public.can_write_org(p_organization_id)
          and public.can_write_module(p_organization_id, 'finance')
          and public.can_read_module(p_organization_id, 'time')) then
    raise exception 'Uren factureren kan alleen als je facturen mag maken en de uren mag zien.' using errcode = '42501';
  end if;

  -- Twee tabbladen die tegelijk op de knop drukken: de tweede wacht, en vindt
  -- daarna geen vrije uren meer.
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text), hashtext('time_to_invoice'));

  v_build := public.time_invoice_build(p_organization_id, p_client_id, p_project_id, p_from, p_to, p_grouping, p_rounding_minutes);
  v_line_count := jsonb_array_length(v_build->'lines');

  if v_line_count = 0 then
    if (v_build #>> '{without_rate,entry_count}')::integer > 0 then
      raise exception 'De declarabele uren in deze periode hebben geen uurtarief. Vul bij die uren een tarief in en probeer het opnieuw.' using errcode = '23514';
    end if;
    raise exception 'Er zijn in deze periode geen declarabele uren die nog gefactureerd moeten worden.' using errcode = '23514';
  end if;
  if v_line_count > 250 then
    raise exception 'Dat worden % factuurregels. Kies "samengevoegd per project" of een kortere periode.', v_line_count using errcode = '23514';
  end if;
  if p_expected_minutes is not null and p_expected_minutes <> (v_build->>'minutes')::integer then
    raise exception 'De uren zijn veranderd sinds dit is klaargezet: het waren % minuten, nu zijn het er %. Bekijk de uren opnieuw en factureer daarna.',
      p_expected_minutes, (v_build->>'minutes')::integer using errcode = '23514';
  end if;
  if p_expected_subtotal_cents is not null and p_expected_subtotal_cents <> (v_build->>'subtotal_cents')::bigint then
    raise exception 'Het bedrag is veranderd sinds dit is klaargezet: het was %, nu is het % excl. btw (een ander uurtarief?). Bekijk de uren opnieuw en factureer daarna.',
      public.euro_label_nl(p_expected_subtotal_cents), public.euro_label_nl((v_build->>'subtotal_cents')::bigint)
      using errcode = '23514';
  end if;

  -- Zit alles op één project, dan hangt de factuur aan dat project: anders
  -- staat er op de projectpagina niets bij "Gefactureerd".
  if v_project_id is null and jsonb_array_length(v_build->'project_ids') = 1
     and not exists (
       select 1 from jsonb_array_elements(v_build->'lines') l where l->>'project_id' is null
     ) then
    v_project_id := (v_build->'project_ids'->>0)::uuid;
  end if;

  -- De betaaltermijn uit de bedrijfsgegevens, met dezelfde regel als het
  -- factuurformulier (paymentTermDays in src/lib/financeRules.ts).
  select invoice_payment_terms into v_terms from public.company_settings where organization_id = p_organization_id;
  if v_terms ~* '\d{1,3}\s*(dagen|dag|days)\M' then
    v_days := least(120, greatest(1, (substring(v_terms from '(?i)(\d{1,3})\s*(?:dagen|dag|days)\M'))::integer));
  end if;

  -- Op de factuur horen alleen de velden van een factuurregel.
  select jsonb_agg(l - 'entry_ids' - 'minutes' - 'entry_count' - 'project_id' order by ord) into v_lines
    from jsonb_array_elements(v_build->'lines') with ordinality as t(l, ord);

  insert into public.invoices(
    organization_id, created_by, client_id, project_id, number, date, due_date, lines, status
  ) values (
    p_organization_id, v_user_id, (v_build->>'client_id')::uuid, v_project_id,
    public.allocate_next_invoice_number(p_organization_id, v_today), v_today, v_today + v_days, v_lines, 'draft'
  ) returning * into v_invoice;

  insert into public.time_entry_invoices(time_entry_id, organization_id, invoice_id, line_id, minutes, hourly_rate_cents, created_by)
  select te.id, p_organization_id, v_invoice.id, l->>'id', te.minutes, te.hourly_rate_cents, v_user_id
    from jsonb_array_elements(v_build->'lines') l
    cross join lateral jsonb_array_elements_text(l->'entry_ids') e(entry_id)
    join public.time_entries te on te.id = e.entry_id::uuid and te.organization_id = p_organization_id;

  return v_invoice;
end;
$$;

revoke all on function public.create_invoice_from_time_entries(uuid, uuid, uuid, date, date, text, integer, integer, bigint) from public, anon;
grant execute on function public.create_invoice_from_time_entries(uuid, uuid, uuid, date, date, text, integer, integer, bigint) to authenticated, service_role;

-- ── 5. Gefactureerde uren liggen vast ───────────────────────────────────────
-- Zonder dit kon je na het factureren de minuten of het tarief aanpassen: de
-- urenstaat en de factuur zeiden dan iets anders, zonder dat iemand het zag.
-- Wat mag: velden die de factuur niet raken (soort uur, taak, begin- en
-- eindtijd, de agendakoppeling), en een project of klant die wegvalt omdat het
-- project of de klant zelf wordt verwijderd.
create or replace function public.guard_invoiced_time_entry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_number text;
begin
  select i.number into v_number
    from public.time_entry_invoices x
    join public.invoices i on i.id = x.invoice_id
   where x.time_entry_id = old.id;
  if not found then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    -- Een verwijderde organisatie, gebruiker of agenda neemt zijn uren mee
    -- (cascade); alleen wie zelf op verwijderen drukt, houden we tegen.
    if pg_trigger_depth() > 1 then return old; end if;
    raise exception 'Deze uren staan op factuur %. Verwijder eerst het concept of de urenregel, of crediteer de factuur; daarna kun je de uren verwijderen.', v_number
      using errcode = '23514';
  end if;

  if new.minutes is distinct from old.minutes
     or new.entry_date is distinct from old.entry_date
     or new.billable is distinct from old.billable
     or new.hourly_rate_cents is distinct from old.hourly_rate_cents
     or new.description is distinct from old.description
     or new.user_id is distinct from old.user_id
     or (new.project_id is distinct from old.project_id and new.project_id is not null)
     or (new.client_id is distinct from old.client_id and new.client_id is not null) then
    raise exception 'Deze uren staan op factuur % en liggen vast. Verwijder eerst het concept of de urenregel, of crediteer de factuur; daarna kun je de uren wijzigen.', v_number
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_invoiced_time_entry() from public, anon, authenticated;

-- Na time_entries_validate (die project en klant uit de taak afleidt), vóór de
-- modulepoort.
drop trigger if exists time_entries_zz_invoiced_guard on public.time_entries;
create trigger time_entries_zz_invoiced_guard before update or delete on public.time_entries
  for each row execute function public.guard_invoiced_time_entry();

-- ── 6. Uren komen vrij als de factuur vervalt ───────────────────────────────
-- Een verwijderd concept ruimt de koppeling zelf op (on delete cascade). Hier:
--   * geannuleerd of ongeldig gemaakt (ook na een volledige creditnota): de
--     factuur telt niet meer, dus de uren zijn niet gefactureerd;
--   * een urenregel die uit het concept is gehaald: die uren staan niet meer
--     op de factuur. Bleef de koppeling dan staan, dan waren ze voor altijd
--     "gefactureerd" zonder dat de klant er ooit voor betaalt.
create or replace function public.release_time_entries_on_invoice_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('cancelled', 'void') then
    if old.status is distinct from new.status then
      delete from public.time_entry_invoices where invoice_id = new.id;
    end if;
  elsif new.status = 'draft' and new.lines is distinct from old.lines then
    delete from public.time_entry_invoices x
     where x.invoice_id = new.id
       and x.line_id is not null
       and not exists (
         select 1
           from jsonb_array_elements(case when jsonb_typeof(new.lines) = 'array' then new.lines else '[]'::jsonb end) l
          where l->>'id' = x.line_id
       );
  end if;
  return null;
end;
$$;

revoke all on function public.release_time_entries_on_invoice_change() from public, anon, authenticated;

drop trigger if exists invoices_release_time_entries on public.invoices;
create trigger invoices_release_time_entries after update of status, lines on public.invoices
  for each row execute function public.release_time_entries_on_invoice_change();

-- ── 7. De agenda blijft van gefactureerde uren af ───────────────────────────
-- Uren uit een agenda-afspraak volgen die afspraak (sync_time_entry_from_link).
-- Verschuift de afspraak na het factureren, dan zou de sync de minuten willen
-- aanpassen en op de vergrendeling hierboven stuklopen: de afspraak was dan
-- niet meer op te slaan. Gefactureerde uren laat de sync daarom met rust.
--
-- Security definer, omdat de sync draait met de rechten van wie de afspraak
-- opslaat: wie de module Uren niet mag lezen, zag de koppeling anders niet, en
-- liep dan alsnog op de vergrendeling stuk. Daarom wel alleen binnen de eigen
-- organisatie (of zonder ingelogde gebruiker: de agendasync van de server):
-- anders kon iedereen met een willekeurig id vragen of een afspraak van een
-- andere organisatie gefactureerde uren heeft.
create or replace function public.calendar_link_hours_invoiced(p_link_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.time_entries te
      join public.time_entry_invoices x on x.time_entry_id = te.id
     where te.calendar_event_link_id = p_link_id
       and (auth.uid() is null or public.can_read_org(te.organization_id))
  );
$$;

revoke all on function public.calendar_link_hours_invoiced(uuid) from public, anon;
grant execute on function public.calendar_link_hours_invoiced(uuid) to authenticated, service_role;

-- Laatste versie uit 20260907000000, met alleen de eerste controle erbij.
create or replace function public.sync_time_entry_from_link()
returns trigger language plpgsql as $$
declare
  v_minutes integer;
  v_rate integer;
  v_billable boolean := true;
begin
  -- NIEUW (20261123110000): staan de uren van deze afspraak op een factuur,
  -- dan liggen ze vast.
  if public.calendar_link_hours_invoiced(new.id) then
    return new;
  end if;
  if new.track_time
     and (new.task_id is not null or new.project_id is not null or new.client_id is not null)
     and new.event_ends_at is not null
     and not new.event_all_day
  then
    v_minutes := floor(extract(epoch from (new.event_ends_at - new.event_starts_at)) / 60)::int;
    if v_minutes is null or v_minutes <= 0 then
      delete from public.time_entries where calendar_event_link_id = new.id;
      return new;
    end if;
    v_rate := public.resolve_hourly_rate(new.organization_id, new.project_id);
    if new.project_id is not null then
      select (billing_type <> 'fixed_price') into v_billable from public.projects where id = new.project_id;
      v_billable := coalesce(v_billable, true);
    end if;
    insert into public.time_entries (
      organization_id, created_by, user_id, project_id, client_id, task_id, source,
      calendar_event_link_id, description, entry_date, started_at, ended_at, minutes, billable, hourly_rate_cents
    ) values (
      new.organization_id, coalesce(auth.uid(), new.created_by), coalesce(new.created_by, auth.uid()),
      new.project_id, new.client_id, new.task_id, 'calendar', new.id,
      new.event_title_snapshot, (new.event_starts_at)::date, new.event_starts_at, new.event_ends_at,
      v_minutes, v_billable, v_rate
    )
    on conflict (calendar_event_link_id) do update set
      project_id = excluded.project_id,
      client_id = excluded.client_id,
      task_id = excluded.task_id,
      description = excluded.description,
      entry_date = excluded.entry_date,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      minutes = excluded.minutes,
      hourly_rate_cents = excluded.hourly_rate_cents,
      updated_at = now();
    -- billable en user_id bewust niet overschreven bij update: handmatige
    -- declarabel-wijziging blijft behouden als de afspraak verschuift.
  else
    delete from public.time_entries where calendar_event_link_id = new.id;
  end if;
  return new;
end; $$;

-- Een triggerfunctie hoeft niemand zelf aan te roepen; de trigger vuurt toch.
revoke all on function public.sync_time_entry_from_link() from public, anon, authenticated;

-- Wordt de afspraak (de koppeling) verwijderd, dan zou de cascade de
-- gefactureerde uren meenemen. Ze blijven staan als gewone, handmatige uren,
-- zoals bij een verwijderde agenda (keep_time_entries_on_calendar_source_delete).
create or replace function public.keep_invoiced_time_entries_on_link_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.time_entries te
     set calendar_event_link_id = null,
         source = 'manual'
   where te.calendar_event_link_id = old.id
     and exists (select 1 from public.time_entry_invoices x where x.time_entry_id = te.id);
  return old;
end;
$$;

revoke all on function public.keep_invoiced_time_entries_on_link_delete() from public, anon, authenticated;

drop trigger if exists calendar_event_links_keep_invoiced_hours on public.calendar_event_links;
create trigger calendar_event_links_keep_invoiced_hours before delete on public.calendar_event_links
  for each row execute function public.keep_invoiced_time_entries_on_link_delete();

notify pgrst, 'reload schema';

commit;
