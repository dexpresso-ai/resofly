-- Vof, maatschap en cv: een tijdlijn per vennoot, automatisch splitsen bij in-
-- of uittreden, een rekening-courant per vennoot, het kapitaal van een
-- uittreder als schuld aan hem, en een verliesgrens voor de commanditaire
-- vennoot.
--
-- Waarom: na 20261122100000 hoorde de verdeling bij het boekjaar, maar wie
-- halverwege het jaar in- of uittrad, moest dat zelf uitrekenen en als
-- "bedrag vooraf" vastleggen. Een vennoot had geen datum van toe- of
-- uittreden en geen percentage met een ingangsdatum. Het kapitaal van een
-- uittreder bleef eigen vermogen, terwijl de vof het hem schuldig is. Een
-- commanditaire vennoot droeg verlies tot ver onder nul, terwijl hij niet
-- verder draagt dan zijn inbreng (art. 20 lid 3 WvK). En een lening van of aan
-- een vennoot kon alleen op zijn privé, waar ze bij de jaarafsluiting in het
-- kapitaal verdween. Zie docs/changelog/CHANGELOG_VOF_TIJDLIJN_2026-11-24.md.
--
-- Nu:
--   - partnership_partner_timeline: per vennoot de stand (percentage, soort,
--     vennoot of niet) met een ingangsdatum. Een wijziging met een datum is
--     een nieuwe regel; een wijziging van het percentage zonder datum
--     corrigeert de stand die nu geldt, maar nooit in een afgesloten jaar
--     (dan geldt hij vanaf de dag erna). Uittreden heeft altijd een datum.
--   - Zonder vastgelegde verdeling valt een boekjaar uiteen in perioden op die
--     datums. Per periode telt het resultaat van de boekingen in die periode
--     (een tussentijdse resultaatbepaling), verdeeld over de vennoten van dat
--     moment.
--   - Elke vennoot krijgt een rekening-courant (141n, kortlopende schuld). Bij
--     de jaarafsluiting gaat het kapitaal van wie dan is uitgetreden, na zijn
--     winstaandeel, naar zijn rekening-courant: een schuld aan hem.
--   - Een commanditaire vennoot draagt verlies tot zijn eigen vermogen bij het
--     begin van de verdeling; het meerdere gaat naar rato naar de beherende
--     vennoten.
--
-- Veilig om opnieuw te draaien.

-- ── 1. De rekening-courant per vennoot ──────────────────────────────────

alter table public.partnership_partners add column if not exists current_account_id uuid references public.ledger_accounts(id);
-- Vanaf wanneer de wijzigingen van deze vennoot een ingangsdatum hebben. Wat
-- daarvóór veranderde (zonder datum), kent ResoFly alleen als "gewijzigd op".
alter table public.partnership_partners add column if not exists timeline_since timestamptz;

-- 141n is van de vennoten: een eigen rekening met die code zou er stil tussen
-- komen te staan.
create or replace function public.ledger_reserved_code_purpose(p_code text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_code in ('0100','0150','0500','0510','0550','0560','1100','1102','1300','1500','1510','1520','1530','1600','4000','4900')
      then 'het standaard rekeningschema'
    when p_code in ('0020','0025','0300','0505','0520','0530','1400','1540','1545','1550','1560','1580','9900')
      then 'de BV-administratie (vennootschapsbelasting, eigen vermogen, DGA, loonheffing en dividend)'
    when p_code ~ '^05[056][1-9]$'
      then 'de kapitaal- en privérekeningen van vennoten'
    -- TOEGEVOEGD (20261124120000)
    when p_code ~ '^141[1-9]$'
      then 'de rekening-courant van vennoten'
  end;
$$;
revoke all on function public.ledger_reserved_code_purpose(text) from public, anon;
grant execute on function public.ledger_reserved_code_purpose(text) to authenticated, service_role;

-- De rekening-courant van een vennoot (intern). 141n naar zijn vennootnummer;
-- is die code al voor iets anders in gebruik, dan 142n of 143n.
create or replace function public.ensure_partner_current_account(p_organization_id uuid, p_partner_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_partner public.partnership_partners;
  v_code text;
  v_id uuid;
begin
  select * into v_partner from public.partnership_partners pp
  where pp.id = p_partner_id and pp.organization_id = p_organization_id;
  if not found then return null; end if;
  if v_partner.current_account_id is not null then return v_partner.current_account_id; end if;

  select c into v_code
  from unnest(array['141' || v_partner.partner_number, '142' || v_partner.partner_number, '143' || v_partner.partner_number]) as c
  where not exists (select 1 from public.ledger_accounts la where la.organization_id = p_organization_id and la.code = c)
  limit 1;
  if v_code is null then return null; end if;

  insert into public.ledger_accounts (organization_id, code, name, type, subtype, default_vat_code, is_system, report_group)
  values (p_organization_id, v_code, 'Rekening-courant ' || v_partner.name, 'liability', 'partner_current_account', null, true, 'kortlopende_schulden')
  returning id into v_id;
  update public.partnership_partners set current_account_id = v_id where id = v_partner.id;
  return v_id;
end;
$$;
revoke all on function public.ensure_partner_current_account(uuid, uuid) from public, anon, authenticated;
grant execute on function public.ensure_partner_current_account(uuid, uuid) to service_role;

-- ── 2. De tijdlijn per vennoot ──────────────────────────────────────────

create table if not exists public.partnership_partner_timeline (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  partner_id uuid not null,
  -- De eerste dag waarop deze stand geldt: "toegetreden per 1 juli",
  -- "uitgetreden per 1 februari" (vanaf die dag geen vennoot meer).
  valid_from date not null,
  share_basis_points integer not null check (share_basis_points between 0 and 10000),
  kind text not null default 'beherend' check (kind in ('beherend', 'commanditair')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  constraint partnership_partner_timeline_partner_fkey
    foreign key (organization_id, partner_id) references public.partnership_partners(organization_id, id) on delete cascade,
  constraint partnership_partner_timeline_partner_day_key unique (partner_id, valid_from)
);
create index if not exists idx_partnership_partner_timeline_org
  on public.partnership_partner_timeline (organization_id, partner_id, valid_from);

alter table public.partnership_partner_timeline enable row level security;
revoke all on table public.partnership_partner_timeline from public, anon, authenticated;
grant select on table public.partnership_partner_timeline to authenticated;
grant all on table public.partnership_partner_timeline to service_role;
drop policy if exists "partnership partner timeline read" on public.partnership_partner_timeline;
-- Eén keer per query, niet per rij (zie tests/database/rls_een_keer_per_query.sql).
create policy "partnership partner timeline read" on public.partnership_partner_timeline
  for select using (organization_id = any ((select public.my_organization_ids())::uuid[]));
select public.apply_module_gate('partnership_partner_timeline', 'finance');

drop trigger if exists partnership_partner_timeline_audit on public.partnership_partner_timeline;
create trigger partnership_partner_timeline_audit
  after insert or delete or update on public.partnership_partner_timeline
  for each row execute function public.audit_row_change('partnership_partner_timeline', 'valid_from');

-- Het auditlog zet de tijdlijn onder Financiën.
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
    -- GEWIJZIGD (20261124120000): partnership_partner_timeline erbij.
    when p_entity_type in ('annual_account', 'annual_account_filing', 'annual_account_signature', 'bank_account', 'bank_rule',
                           'bank_transaction', 'company_settings', 'contract', 'contract_note', 'contract_project', 'contract_template',
                           'corporate_tax_return', 'credit_note', 'dividend_distribution', 'fiscal_year', 'fiscal_year_partner_share',
                           'fiscal_year_size_input', 'fixed_asset', 'income_tax_correction', 'income_tax_profile', 'invoice',
                           'journal_entry', 'ledger_account', 'partnership_partner', 'partnership_partner_timeline', 'prepaid_expense',
                           'purchase_invoice', 'quote', 'result_appropriation', 'share_transaction', 'shareholder', 'supplier',
                           'vat_return') then 'finance'
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
revoke all on function public.audit_entity_module(text) from public, anon;
grant execute on function public.audit_entity_module(text) to authenticated, service_role;

-- De vastgelegde verdeling van een jaar (door de gebruiker) tegenover de
-- momentopname die de jaarafsluiting maakt van een automatische verdeling.
-- Alleen de eerste geldt bij opnieuw afsluiten; de tweede houdt vast wat er
-- geboekt is. Rijen van vóór deze migratie gedroegen zich als vastgelegd.
alter table public.fiscal_year_partner_shares add column if not exists source text not null default 'vastgelegd';
alter table public.fiscal_year_partner_shares drop constraint if exists fiscal_year_partner_shares_source_check;
alter table public.fiscal_year_partner_shares add constraint fiscal_year_partner_shares_source_check
  check (source in ('vastgelegd', 'afsluiting'));

-- Bestaande vennoten: een rekening-courant, en een tijdlijn.
--   - De eerste stand geldt vanaf het begin van de boekhouding (of het eerste
--     boekjaar), niet vanaf het moment van vastleggen: zo rekende de
--     verdeling al, en wie in november overstapte en de vennoten toen
--     vastlegde, had ze ook in de maanden ervoor.
--   - Wie op uitgetreden staat, is dat sinds de dag dat dat werd vastgelegd.
--     Wanneer hij echt uittrad, weet ResoFly niet; daarvoor blijft de
--     weigering bij het afsluiten (fiscal_year_partner_changes) gelden.
alter table public.partnership_partners disable trigger partnership_partners_audit;
do $$
declare
  r record;
begin
  for r in select pp.organization_id, pp.id from public.partnership_partners pp where pp.current_account_id is null loop
    perform public.ensure_partner_current_account(r.organization_id, r.id);
  end loop;
end $$;

insert into public.partnership_partner_timeline (organization_id, partner_id, valid_from, share_basis_points, kind, is_active, created_by)
select pp.organization_id, pp.id,
       least((pp.created_at at time zone 'Europe/Amsterdam')::date,
             coalesce(cs.bookkeeping_start_date, (pp.created_at at time zone 'Europe/Amsterdam')::date),
             coalesce((select min(f.period_start) from public.fiscal_years f where f.organization_id = pp.organization_id),
                      (pp.created_at at time zone 'Europe/Amsterdam')::date)),
       pp.profit_share_basis_points, pp.kind,
       pp.is_active or (coalesce(pp.share_changed_at, pp.created_at) at time zone 'Europe/Amsterdam')::date
                        > (pp.created_at at time zone 'Europe/Amsterdam')::date,
       null
from public.partnership_partners pp
left join public.company_settings cs on cs.organization_id = pp.organization_id
where not exists (select 1 from public.partnership_partner_timeline t where t.partner_id = pp.id);

insert into public.partnership_partner_timeline (organization_id, partner_id, valid_from, share_basis_points, kind, is_active, created_by)
select pp.organization_id, pp.id, (coalesce(pp.share_changed_at, pp.created_at) at time zone 'Europe/Amsterdam')::date,
       pp.profit_share_basis_points, pp.kind, false, null
from public.partnership_partners pp
where not pp.is_active
  and (coalesce(pp.share_changed_at, pp.created_at) at time zone 'Europe/Amsterdam')::date
      > (select min(t.valid_from) from public.partnership_partner_timeline t where t.partner_id = pp.id)
  and not exists (select 1 from public.partnership_partner_timeline t where t.partner_id = pp.id and not t.is_active);

update public.partnership_partners set timeline_since = now() where timeline_since is null;
alter table public.partnership_partners enable trigger partnership_partners_audit;

-- ── 3. De perioden van een boekjaar en wie erin meedoet (intern) ────────

-- Het begin van het jaar plus elke ingangsdatum die erin valt. Met een
-- vastgelegde verdeling is het één periode: die geldt voor het hele jaar.
create or replace function public.fiscal_year_period_bounds(p_organization_id uuid, p_fiscal_year_id uuid)
returns table(period_no integer, period_start date, period_end date)
language sql
stable
security definer
set search_path = public
as $$
  with fy as (
    select f.period_start, f.period_end from public.fiscal_years f
    where f.id = p_fiscal_year_id and f.organization_id = p_organization_id
  ), b as (
    select fy.period_start as d from fy
    union
    select t.valid_from from public.partnership_partner_timeline t cross join fy
    where t.organization_id = p_organization_id
      and t.valid_from > fy.period_start and t.valid_from <= fy.period_end
      and not exists (
        select 1 from public.fiscal_year_partner_shares s
        where s.organization_id = p_organization_id and s.fiscal_year_id = p_fiscal_year_id and s.source = 'vastgelegd')
  )
  select (row_number() over (order by b.d))::integer,
         b.d,
         coalesce((lead(b.d) over (order by b.d)) - 1, (select fy.period_end from fy))
  from b
  order by b.d;
$$;
revoke all on function public.fiscal_year_period_bounds(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fiscal_year_period_bounds(uuid, uuid) to service_role;

-- Wie er meedoet in de periode die op p_date begint: de vastgelegde verdeling
-- van het jaar, of anders de vennoten die op die dag vennoot zijn, met hun
-- percentage van die dag. Een commanditaire vennoot is dat alleen in een cv-jaar.
create or replace function public.fiscal_year_partners_on(p_organization_id uuid, p_fiscal_year_id uuid, p_date date)
returns table(partner_id uuid, capital_account_id uuid, name text, partner_number smallint, kind text,
              share_basis_points integer, prior_share_cents bigint, from_year boolean)
language sql
stable
security definer
set search_path = public
as $$
  with fixed as (
    select s.* from public.fiscal_year_partner_shares s
    where s.organization_id = p_organization_id and s.fiscal_year_id = p_fiscal_year_id and s.source = 'vastgelegd'
  )
  select pp.id, pp.capital_account_id, pp.name, pp.partner_number, f.kind, f.share_basis_points, f.prior_share_cents, true
  from fixed f
  join public.partnership_partners pp on pp.organization_id = p_organization_id and pp.id = f.partner_id
  union all
  select pp.id, pp.capital_account_id, pp.name, pp.partner_number,
         case when public.fiscal_year_legal_form(p_organization_id, p_fiscal_year_id) = 'cv' then st.kind else 'beherend' end,
         st.share_basis_points, 0::bigint, false
  from public.partnership_partners pp
  cross join lateral (
    select t.share_basis_points, t.kind, t.is_active
    from public.partnership_partner_timeline t
    where t.partner_id = pp.id and t.organization_id = p_organization_id and t.valid_from <= p_date
    order by t.valid_from desc
    limit 1
  ) st
  where pp.organization_id = p_organization_id
    and st.is_active
    and not exists (select 1 from fixed)
  order by 4;
$$;
revoke all on function public.fiscal_year_partners_on(uuid, uuid, date) from public, anon, authenticated;
grant execute on function public.fiscal_year_partners_on(uuid, uuid, date) to service_role;

create or replace function public.fiscal_year_partner_periods(p_organization_id uuid, p_fiscal_year_id uuid)
returns table(period_no integer, period_start date, period_end date, partner_id uuid, capital_account_id uuid, name text,
              partner_number smallint, kind text, share_basis_points integer, prior_share_cents bigint, from_year boolean)
language sql
stable
security definer
set search_path = public
as $$
  select b.period_no, b.period_start, b.period_end, p.partner_id, p.capital_account_id, p.name, p.partner_number,
         p.kind, p.share_basis_points, p.prior_share_cents, p.from_year
  from public.fiscal_year_period_bounds(p_organization_id, p_fiscal_year_id) b
  cross join lateral public.fiscal_year_partners_on(p_organization_id, p_fiscal_year_id, b.period_start) p
  order by b.period_no, p.partner_number;
$$;
revoke all on function public.fiscal_year_partner_periods(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fiscal_year_partner_periods(uuid, uuid) to service_role;

-- De verdeling per vennoot voor het jaar (zoals 20261122100000 hem kende):
-- wie in een periode meedoet, met het percentage van zijn laatste periode, het
-- bedrag vooraf, en wat er bij het afsluiten is geboekt.
create or replace function public.fiscal_year_partner_split(p_organization_id uuid, p_fiscal_year_id uuid)
returns table(partner_id uuid, capital_account_id uuid, name text, partner_number smallint, kind text,
              share_basis_points integer, prior_share_cents bigint, booked_share_cents bigint,
              is_active boolean, from_year boolean)
language sql
stable
security definer
set search_path = public
as $$
  with per as (
    select * from public.fiscal_year_partner_periods(p_organization_id, p_fiscal_year_id)
  ), lastp as (
    select distinct on (per.partner_id) per.* from per order by per.partner_id, per.period_no desc
  )
  select l.partner_id, l.capital_account_id, l.name, l.partner_number, l.kind, l.share_basis_points, l.prior_share_cents,
         (select s.share_cents from public.fiscal_year_partner_shares s
          where s.organization_id = p_organization_id and s.fiscal_year_id = p_fiscal_year_id and s.partner_id = l.partner_id),
         pp.is_active, l.from_year
  from lastp l
  join public.partnership_partners pp on pp.organization_id = p_organization_id and pp.id = l.partner_id
  order by l.partner_number;
$$;
revoke all on function public.fiscal_year_partner_split(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fiscal_year_partner_split(uuid, uuid) to service_role;

-- ── 4. De verdeling: per periode, met de verliesgrens (intern) ──────────

-- Per periode het resultaat van de boekingen in die periode, verdeeld over
-- wie toen vennoot was (eerst ieders bedrag vooraf, alleen bij een
-- vastgelegde verdeling). Wijkt p_result_cents af van wat er geboekt is (een
-- prognose), dan komt het verschil in de periode van vandaag.
--
-- Daarna de verliesgrens: een commanditaire vennoot draagt niet meer verlies
-- dan zijn eigen vermogen vóór deze verdeling (kapitaal en privé tot en met
-- het einde van het jaar). Het meerdere gaat naar de beherende vennoten, naar
-- de som van hun percentages over de perioden.
--
-- Rijen met period_no 0 zijn de totalen per vennoot; period_no >= 1 de
-- perioden. Een periode zonder vennoot komt terug met partner_id null: dat
-- resultaat is niet verdeeld.
--
-- Afronding zoals overal: eerst ieder naar beneden, de resterende centen naar
-- de grootste resten, bij een gelijke rest het laagste vennootnummer. Gelijk
-- aan splitYearResult in src/lib/inkomstenbelasting.ts.
create or replace function public.fiscal_year_result_detail(p_organization_id uuid, p_fiscal_year_id uuid, p_result_cents bigint)
returns table(period_no integer, period_start date, period_end date, period_result_cents bigint,
              partner_id uuid, capital_account_id uuid, name text, partner_number smallint, kind text,
              share_basis_points integer, prior_share_cents bigint, share_cents bigint, loss_shift_cents bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_fy public.fiscal_years;
  v_today date := (now() at time zone 'Europe/Amsterdam')::date;
  v_starts date[] := '{}';
  v_ends date[] := '{}';
  v_results bigint[] := '{}';
  v_n integer := 0;
  v_i integer;
  v_target integer := 1;
  v_booked bigint := 0;
  v_prior_total bigint;
  v_rest bigint;
  v_has boolean;
  v_totals jsonb := '{}'::jsonb;
  v_shift jsonb := '{}'::jsonb;
  v_weights jsonb := '{}'::jsonb;
  v_kinds jsonb := '{}'::jsonb;
  v_bps jsonb := '{}'::jsonb;
  v_priors jsonb := '{}'::jsonb;
  v_cap bigint;
  v_total bigint;
  v_excess bigint;
  v_wsum bigint;
  b record;
  x record;
  c record;
begin
  select * into v_fy from public.fiscal_years f
  where f.id = p_fiscal_year_id and f.organization_id = p_organization_id;
  if not found then return; end if;

  for b in select * from public.fiscal_year_period_bounds(p_organization_id, p_fiscal_year_id) loop
    v_n := v_n + 1;
    v_starts := v_starts || b.period_start;
    v_ends := v_ends || b.period_end;
    v_results := v_results || (
      select coalesce(sum(jl.credit_cents - jl.debit_cents), 0)::bigint
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.entry_id
      join public.ledger_accounts la on la.id = jl.account_id
      where jl.organization_id = p_organization_id
        and je.status = 'posted'
        and je.source_type <> 'year_close'
        and je.date between b.period_start and b.period_end
        and la.type in ('revenue', 'expense'));
    v_booked := v_booked + v_results[v_n];
    if least(greatest(v_today, v_fy.period_start), v_fy.period_end) >= b.period_start then
      v_target := v_n;
    end if;
  end loop;
  if v_n = 0 then return; end if;
  v_results[v_target] := v_results[v_target] + (coalesce(p_result_cents, v_booked) - v_booked);

  for v_i in 1 .. v_n loop
    select coalesce(sum(p.prior_share_cents), 0)::bigint into v_prior_total
    from public.fiscal_year_partners_on(p_organization_id, p_fiscal_year_id, v_starts[v_i]) p;
    v_rest := v_results[v_i] - v_prior_total;
    v_has := false;
    for x in
      with s as (
        select p.*,
               (abs(v_rest) * p.share_basis_points) / 10000 as base,
               (abs(v_rest) * p.share_basis_points) % 10000 as rem
        from public.fiscal_year_partners_on(p_organization_id, p_fiscal_year_id, v_starts[v_i]) p
      ), r as (
        select s.*,
               row_number() over (order by s.rem desc, s.partner_number) as rn,
               abs(v_rest) - sum(s.base) over () as leftover,
               sum(s.share_basis_points) over () as total_bp
        from s
      )
      select r.*,
             (r.prior_share_cents + (case when v_rest < 0 then -1 else 1 end)::bigint
               * (r.base + case when r.total_bp = 10000 and r.rn <= r.leftover then 1 else 0 end))::bigint as cents
      from r
      order by r.partner_number
    loop
      v_has := true;
      period_no := v_i; period_start := v_starts[v_i]; period_end := v_ends[v_i]; period_result_cents := v_results[v_i];
      partner_id := x.partner_id; capital_account_id := x.capital_account_id; name := x.name; partner_number := x.partner_number;
      kind := x.kind; share_basis_points := x.share_basis_points; prior_share_cents := x.prior_share_cents;
      share_cents := x.cents; loss_shift_cents := 0;
      return next;
      v_totals := jsonb_set(v_totals, array[x.partner_id::text], to_jsonb(coalesce((v_totals ->> x.partner_id::text)::bigint, 0) + x.cents));
      v_kinds := jsonb_set(v_kinds, array[x.partner_id::text], to_jsonb(x.kind));
      v_bps := jsonb_set(v_bps, array[x.partner_id::text], to_jsonb(x.share_basis_points));
      v_priors := jsonb_set(v_priors, array[x.partner_id::text], to_jsonb(coalesce((v_priors ->> x.partner_id::text)::bigint, 0) + x.prior_share_cents));
      if x.kind = 'beherend' then
        v_weights := jsonb_set(v_weights, array[x.partner_id::text], to_jsonb(coalesce((v_weights ->> x.partner_id::text)::bigint, 0) + x.share_basis_points));
      end if;
    end loop;
    if not v_has then
      period_no := v_i; period_start := v_starts[v_i]; period_end := v_ends[v_i]; period_result_cents := v_results[v_i];
      partner_id := null; capital_account_id := null; name := null; partner_number := null; kind := null;
      share_basis_points := null; prior_share_cents := null; share_cents := v_results[v_i]; loss_shift_cents := 0;
      return next;
    end if;
  end loop;

  -- De verliesgrens van de commanditaire vennoot.
  select coalesce(sum(value::bigint), 0) into v_wsum from jsonb_each_text(v_weights);
  for c in
    select pp.id, pp.capital_account_id, pp.withdrawals_account_id, pp.contributions_account_id
    from public.partnership_partners pp
    where pp.organization_id = p_organization_id
      and (v_kinds ->> pp.id::text) = 'commanditair'
      and coalesce((v_totals ->> pp.id::text)::bigint, 0) < 0
    order by pp.partner_number
  loop
    select coalesce(sum(jl.credit_cents - jl.debit_cents), 0)::bigint into v_cap
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.date <= v_fy.period_end
      and not (je.source_type = 'year_close' and je.source_id = p_fiscal_year_id)
      and jl.account_id in (c.capital_account_id, c.withdrawals_account_id, c.contributions_account_id);
    v_cap := greatest(v_cap, 0);
    v_total := (v_totals ->> c.id::text)::bigint;
    if -v_total > v_cap and v_wsum > 0 then
      v_excess := -v_total - v_cap;
      v_totals := jsonb_set(v_totals, array[c.id::text], to_jsonb(-v_cap));
      v_shift := jsonb_set(v_shift, array[c.id::text], to_jsonb(coalesce((v_shift ->> c.id::text)::bigint, 0) + v_excess));
      for x in
        with w as (
          select e.key::uuid as pid, e.value::bigint as wt from jsonb_each_text(v_weights) e where e.value::bigint > 0
        ), s as (
          select w.pid, pp.partner_number, (v_excess * w.wt) / v_wsum as base, (v_excess * w.wt) % v_wsum as rem
          from w join public.partnership_partners pp on pp.id = w.pid
        ), r as (
          select s.*, row_number() over (order by s.rem desc, s.partner_number) as rn,
                 v_excess - sum(s.base) over () as leftover
          from s
        )
        select r.pid, (r.base + case when r.rn <= r.leftover then 1 else 0 end)::bigint as part from r
      loop
        v_totals := jsonb_set(v_totals, array[x.pid::text], to_jsonb((v_totals ->> x.pid::text)::bigint - x.part));
        v_shift := jsonb_set(v_shift, array[x.pid::text], to_jsonb(coalesce((v_shift ->> x.pid::text)::bigint, 0) - x.part));
      end loop;
    end if;
  end loop;

  for x in
    select pp.id, pp.capital_account_id, pp.name, pp.partner_number
    from public.partnership_partners pp
    where pp.organization_id = p_organization_id and v_totals ? pp.id::text
    order by pp.partner_number
  loop
    period_no := 0; period_start := v_fy.period_start; period_end := v_fy.period_end;
    period_result_cents := coalesce(p_result_cents, v_booked);
    partner_id := x.id; capital_account_id := x.capital_account_id; name := x.name; partner_number := x.partner_number;
    kind := v_kinds ->> x.id::text; share_basis_points := (v_bps ->> x.id::text)::integer;
    prior_share_cents := (v_priors ->> x.id::text)::bigint;
    share_cents := (v_totals ->> x.id::text)::bigint;
    loss_shift_cents := coalesce((v_shift ->> x.id::text)::bigint, 0);
    return next;
  end loop;
end;
$$;
revoke all on function public.fiscal_year_result_detail(uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.fiscal_year_result_detail(uuid, uuid, bigint) to service_role;

-- De totalen per vennoot (zoals 20261122100000 ze kende), nu met de perioden
-- en de verliesgrens erin, en hoeveel verlies er is verschoven.
drop function if exists public.fiscal_year_result_shares(uuid, uuid, bigint);
create function public.fiscal_year_result_shares(p_organization_id uuid, p_fiscal_year_id uuid, p_result_cents bigint)
returns table(partner_id uuid, capital_account_id uuid, name text, partner_number smallint, kind text,
              share_basis_points integer, prior_share_cents bigint, share_cents bigint, loss_shift_cents bigint)
language sql
stable
security definer
set search_path = public
as $$
  select d.partner_id, d.capital_account_id, d.name, d.partner_number, d.kind, d.share_basis_points,
         d.prior_share_cents, d.share_cents, d.loss_shift_cents
  from public.fiscal_year_result_detail(p_organization_id, p_fiscal_year_id, p_result_cents) d
  where d.period_no = 0
  order by d.partner_number;
$$;
revoke all on function public.fiscal_year_result_shares(uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.fiscal_year_result_shares(uuid, uuid, bigint) to service_role;

-- De weigering bij het afsluiten geldt nu alleen nog voor wijzigingen van
-- vóór de tijdlijn (zonder ingangsdatum). Een wijziging met een datum zit in
-- de perioden; een wijziging na het einde van het jaar raakt dat jaar dus
-- niet meer.
create or replace function public.fiscal_year_partner_changes(p_organization_id uuid, p_fiscal_year_id uuid)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  with fy as (
    select f.period_end, f.status from public.fiscal_years f
    where f.id = p_fiscal_year_id and f.organization_id = p_organization_id
  ), p as (
    select pp.name, pp.partner_number, pp.timeline_since, pp.created_at, pp.share_changed_at,
           (pp.created_at at time zone 'Europe/Amsterdam')::date as made,
           (coalesce(pp.share_changed_at, pp.created_at) at time zone 'Europe/Amsterdam')::date as changed
    from public.partnership_partners pp
    where pp.organization_id = p_organization_id
  ), k as (
    select (select fy.period_end from fy) as period_end,
           min(p.made) as first_made,
           coalesce(bool_or(p.made <= (select fy.period_end from fy)), false) as existed
    from p
  )
  select coalesce(array_agg(p.name order by p.partner_number), '{}'::text[])
  from p cross join k
  where (select fy.status from fy) = 'open'
    and not exists (
      select 1 from public.fiscal_year_partner_shares s
      where s.organization_id = p_organization_id and s.fiscal_year_id = p_fiscal_year_id and s.source = 'vastgelegd')
    -- GEWIJZIGD (20261124120000): alleen wat vóór de tijdlijn veranderde.
    and p.timeline_since is not null
    and p.created_at < p.timeline_since
    and coalesce(p.share_changed_at, p.created_at) < p.timeline_since
    and case when k.existed
             then p.made > k.period_end or p.changed > k.period_end
             else p.made > k.first_made or p.changed > k.first_made end;
$$;
revoke all on function public.fiscal_year_partner_changes(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fiscal_year_partner_changes(uuid, uuid) to service_role;

-- ── 5. Een vennoot vastleggen, met een ingangsdatum ─────────────────────

-- GEWIJZIGD (20261124120000): p_effective_date, de eerste dag waarop de
-- wijziging geldt, en een rekening-courant voor elke vennoot.
--   - Een nieuwe vennoot is vennoot vanaf p_effective_date. Zonder datum: bij
--     de eerste vennoten (allemaal vandaag vastgelegd) vanaf het begin van de
--     boekhouding, zodat wie overstapt ze ook in de maanden ervoor heeft; een
--     latere vennoot vanaf vandaag.
--   - Uittreden of weer vennoot worden geldt vanaf p_effective_date, en
--     zonder datum vanaf vandaag. Eerder werd dat stil teruggerekend tot het
--     begin: een vennoot die uittrad, kreeg ook over de jaren ervoor niets.
--   - Een ander percentage of soort met een datum is een nieuwe stand vanaf
--     die dag. Zonder datum is het een correctie van de stand die nu geldt
--     (een tikfout herstel je zo zonder een nieuwe periode).
--   - Een datum in een afgesloten boekjaar wordt geweigerd: dat jaar is met
--     de verdeling van toen geboekt.
drop function if exists public.save_partnership_partner(uuid, uuid, text, integer, text, boolean);
create or replace function public.save_partnership_partner(
  p_organization_id uuid, p_partner_id uuid, p_name text, p_profit_share_basis_points integer,
  p_kind text default 'beherend', p_is_active boolean default true, p_effective_date date default null)
returns public.partnership_partners
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.partnership_partners;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_kind text := coalesce(nullif(btrim(coalesce(p_kind, '')), ''), 'beherend');
  v_active boolean := coalesce(p_is_active, true);
  v_legal text;
  v_n integer;
  v_cap uuid;
  v_wd uuid;
  v_ct uuid;
  v_today date := (now() at time zone 'Europe/Amsterdam')::date;
  v_from date;
  v_latest public.partnership_partner_timeline;
  v_closed text;
begin
  if auth.role() <> 'service_role'
     and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor de financiën van deze organisatie.' using errcode = '42501';
  end if;

  v_legal := public.org_legal_form(p_organization_id);
  if v_legal not in ('vof', 'maatschap', 'cv') then
    raise exception 'Vennoten horen bij een vof, maatschap of cv; deze administratie staat als % ingesteld.', v_legal
      using errcode = '23514';
  end if;
  if v_name is null then
    raise exception 'Geef de vennoot een naam.' using errcode = '23514';
  end if;
  if length(v_name) > 120 then
    raise exception 'De naam van een vennoot is hooguit 120 tekens.' using errcode = '23514';
  end if;
  if p_profit_share_basis_points is null or p_profit_share_basis_points < 0 or p_profit_share_basis_points > 10000 then
    raise exception 'Het winstaandeel ligt tussen 0 en 100 procent.' using errcode = '23514';
  end if;
  if v_kind not in ('beherend', 'commanditair') then
    raise exception 'Een vennoot is beherend of commanditair.' using errcode = '23514';
  end if;
  if v_kind = 'commanditair' and v_legal <> 'cv' then
    raise exception 'Een commanditaire (stille) vennoot bestaat alleen bij een cv.' using errcode = '23514';
  end if;
  if p_effective_date is not null and p_effective_date > v_today + 366 then
    raise exception 'Een ingangsdatum ligt hooguit een jaar vooruit.' using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':vennoten'));
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':fyclose'));
  perform public.ensure_default_ledger_accounts(p_organization_id);

  if p_partner_id is null then
    select g.n into v_n
    from generate_series(1, 9) as g(n)
    where not exists (
        select 1 from public.partnership_partners pp
        where pp.organization_id = p_organization_id and pp.partner_number = g.n)
      and not exists (
        select 1 from public.ledger_accounts la
        where la.organization_id = p_organization_id
          and la.code in ('050' || g.n, '055' || g.n, '056' || g.n))
    order by g.n
    limit 1;
    if v_n is null then
      raise exception 'Er kunnen hooguit negen vennoten worden vastgelegd (rekeningen 0501 t/m 0509), of de rekeningcodes zijn al voor iets anders in gebruik.'
        using errcode = '23514';
    end if;

    -- Vanaf wanneer: zie boven. "Allemaal vandaag vastgelegd" is het inrichten.
    v_from := coalesce(p_effective_date,
      case when exists (
             select 1 from public.partnership_partners pp
             where pp.organization_id = p_organization_id
               and (pp.created_at at time zone 'Europe/Amsterdam')::date < v_today)
           then v_today
           else least(v_today,
                      coalesce((select cs.bookkeeping_start_date from public.company_settings cs where cs.organization_id = p_organization_id), v_today),
                      coalesce((select min(f.period_start) from public.fiscal_years f where f.organization_id = p_organization_id), v_today))
      end);

    insert into public.ledger_accounts (organization_id, code, name, type, subtype, default_vat_code, is_system, report_group)
    values (p_organization_id, '050' || v_n, 'Kapitaal ' || v_name, 'equity', 'partner_capital', null, true, 'eigen_vermogen')
    returning id into v_cap;
    insert into public.ledger_accounts (organization_id, code, name, type, subtype, default_vat_code, is_system, report_group)
    values (p_organization_id, '055' || v_n, 'Privé-opnamen ' || v_name, 'equity', 'partner_withdrawals', null, true, 'eigen_vermogen')
    returning id into v_wd;
    insert into public.ledger_accounts (organization_id, code, name, type, subtype, default_vat_code, is_system, report_group)
    values (p_organization_id, '056' || v_n, 'Privé-stortingen ' || v_name, 'equity', 'partner_contributions', null, true, 'eigen_vermogen')
    returning id into v_ct;

    insert into public.partnership_partners (
      organization_id, created_by, partner_number, name, profit_share_basis_points, kind, is_active,
      capital_account_id, withdrawals_account_id, contributions_account_id, timeline_since)
    values (
      p_organization_id, auth.uid(), v_n, v_name, p_profit_share_basis_points, v_kind, v_active,
      v_cap, v_wd, v_ct, now())
    returning * into v_row;

    insert into public.partnership_partner_timeline (organization_id, partner_id, valid_from, share_basis_points, kind, is_active)
    values (p_organization_id, v_row.id, v_from, p_profit_share_basis_points, v_kind, v_active);

    perform public.ensure_partner_current_account(p_organization_id, v_row.id);
    select * into v_row from public.partnership_partners where id = v_row.id;
    return v_row;
  end if;

  select * into v_row
  from public.partnership_partners pp
  where pp.id = p_partner_id and pp.organization_id = p_organization_id
  for update;
  if not found then
    raise exception 'Vennoot niet gevonden.' using errcode = '02000';
  end if;

  -- Met een datum: vergelijk met de stand op die dag. Zonder datum: met de
  -- stand van nu. (Wie vandaag al op uitgetreden stond en dat per 1 januari
  -- wil laten ingaan, werd anders overgeslagen: de stand van nu was gelijk.)
  if p_effective_date is not null then
    select * into v_latest from public.partnership_partner_timeline t
    where t.partner_id = v_row.id and t.organization_id = p_organization_id and t.valid_from <= p_effective_date
    order by t.valid_from desc limit 1;
  else
    select * into v_latest from public.partnership_partner_timeline t
    where t.partner_id = v_row.id and t.organization_id = p_organization_id
    order by t.valid_from desc limit 1;
  end if;

  if v_latest.id is null
     or v_latest.share_basis_points is distinct from p_profit_share_basis_points
     or v_latest.kind is distinct from v_kind
     or v_latest.is_active is distinct from v_active then
    -- Uittreden of weer meedoen heeft altijd een datum; een ander percentage
    -- of soort zonder datum is een correctie van de stand van nu.
    v_from := coalesce(p_effective_date,
                       case when v_latest.id is null or v_latest.is_active is distinct from v_active then v_today end);

    if v_from is not null then
      select f.label into v_closed from public.fiscal_years f
      where f.organization_id = p_organization_id and f.status = 'closed'
        and v_from between f.period_start and f.period_end
      limit 1;
      if v_closed is not null then
        raise exception 'Boekjaar % is afgesloten, met de verdeling die toen gold. Kies een ingangsdatum na dat jaar, of heropen het eerst.', v_closed
          using errcode = '23514';
      end if;
      insert into public.partnership_partner_timeline (organization_id, partner_id, valid_from, share_basis_points, kind, is_active)
      values (p_organization_id, v_row.id, v_from, p_profit_share_basis_points, v_kind, v_active)
      on conflict (partner_id, valid_from) do update
        set share_basis_points = excluded.share_basis_points, kind = excluded.kind, is_active = excluded.is_active;
    elsif v_latest.valid_from <= coalesce((select max(f.period_end) from public.fiscal_years f
                                            where f.organization_id = p_organization_id and f.status = 'closed'), '1900-01-01'::date) then
      -- Een correctie raakt geen afgesloten jaar: dan geldt hij vanaf de eerste
      -- dag na het laatste afgesloten boekjaar. Anders verdeelde heropenen en
      -- opnieuw afsluiten dat jaar met de gecorrigeerde percentages.
      insert into public.partnership_partner_timeline (organization_id, partner_id, valid_from, share_basis_points, kind, is_active)
      values (p_organization_id, v_row.id,
              (select max(f.period_end) + 1 from public.fiscal_years f where f.organization_id = p_organization_id and f.status = 'closed'),
              p_profit_share_basis_points, v_kind, v_latest.is_active)
      on conflict (partner_id, valid_from) do update
        set share_basis_points = excluded.share_basis_points, kind = excluded.kind;
    else
      update public.partnership_partner_timeline
      set share_basis_points = p_profit_share_basis_points, kind = v_kind
      where id = v_latest.id;
    end if;
  end if;

  -- De vennoot zelf staat op zijn laatste stand.
  select * into v_latest from public.partnership_partner_timeline t
  where t.partner_id = v_row.id and t.organization_id = p_organization_id
  order by t.valid_from desc limit 1;

  update public.partnership_partners
  set name = v_name,
      profit_share_basis_points = coalesce(v_latest.share_basis_points, p_profit_share_basis_points),
      kind = coalesce(v_latest.kind, v_kind),
      is_active = coalesce(v_latest.is_active, v_active)
  where id = v_row.id
  returning * into v_row;

  -- De rekeningen dragen de naam van de vennoot mee.
  update public.ledger_accounts set name = 'Kapitaal ' || v_name
  where id = v_row.capital_account_id and organization_id = p_organization_id;
  update public.ledger_accounts set name = 'Privé-opnamen ' || v_name
  where id = v_row.withdrawals_account_id and organization_id = p_organization_id;
  update public.ledger_accounts set name = 'Privé-stortingen ' || v_name
  where id = v_row.contributions_account_id and organization_id = p_organization_id;
  perform public.ensure_partner_current_account(p_organization_id, v_row.id);
  update public.ledger_accounts set name = 'Rekening-courant ' || v_name
  where id = (select current_account_id from public.partnership_partners where id = v_row.id) and organization_id = p_organization_id;

  select * into v_row from public.partnership_partners where id = v_row.id;
  return v_row;
end;
$$;
revoke all on function public.save_partnership_partner(uuid, uuid, text, integer, text, boolean, date) from public, anon;
grant execute on function public.save_partnership_partner(uuid, uuid, text, integer, text, boolean, date) to authenticated, service_role;

-- Een regel van de tijdlijn weghalen (een verkeerde ingangsdatum). Niet de
-- eerste stand, en niet in een afgesloten boekjaar.
create or replace function public.delete_partnership_partner_change(p_organization_id uuid, p_change_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.partnership_partner_timeline;
  v_closed text;
  v_latest public.partnership_partner_timeline;
begin
  if auth.role() <> 'service_role'
     and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor de financiën van deze organisatie.' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':vennoten'));
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':fyclose'));

  select * into v_row from public.partnership_partner_timeline t
  where t.id = p_change_id and t.organization_id = p_organization_id
  for update;
  if not found then
    raise exception 'Wijziging niet gevonden.' using errcode = '02000';
  end if;
  if not exists (select 1 from public.partnership_partner_timeline t
                 where t.partner_id = v_row.partner_id and t.valid_from < v_row.valid_from) then
    raise exception 'Dit is de eerste stand van de vennoot. Pas de datum aan, of verwijder de vennoot als hij er nooit had moeten zijn.'
      using errcode = '23514';
  end if;
  select f.label into v_closed from public.fiscal_years f
  where f.organization_id = p_organization_id and f.status = 'closed'
    and v_row.valid_from between f.period_start and f.period_end
  limit 1;
  if v_closed is not null then
    raise exception 'Boekjaar % is afgesloten, met deze wijziging erin. Heropen het eerst.', v_closed using errcode = '23514';
  end if;

  delete from public.partnership_partner_timeline where id = v_row.id;

  select * into v_latest from public.partnership_partner_timeline t
  where t.partner_id = v_row.partner_id order by t.valid_from desc limit 1;
  update public.partnership_partners
  set profit_share_basis_points = v_latest.share_basis_points, kind = v_latest.kind, is_active = v_latest.is_active
  where id = v_row.partner_id and organization_id = p_organization_id;
end;
$$;
revoke all on function public.delete_partnership_partner_change(uuid, uuid) from public, anon;
grant execute on function public.delete_partnership_partner_change(uuid, uuid) to authenticated, service_role;

-- GEWIJZIGD (20261124120000): ook de rekening-courant gaat mee.
create or replace function public.delete_partnership_partner(p_organization_id uuid, p_partner_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_partner public.partnership_partners;
  v_accounts uuid[];
begin
  if auth.role() <> 'service_role'
     and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor de financiën van deze organisatie.' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':vennoten'));
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':fyclose'));

  select * into v_partner from public.partnership_partners pp
  where pp.id = p_partner_id and pp.organization_id = p_organization_id
  for update;
  if not found then
    raise exception 'Vennoot niet gevonden.' using errcode = '02000';
  end if;
  v_accounts := array_remove(array[v_partner.capital_account_id, v_partner.withdrawals_account_id,
                                   v_partner.contributions_account_id, v_partner.current_account_id], null);

  if exists (select 1 from public.journal_lines jl
             where jl.organization_id = p_organization_id and jl.account_id = any (v_accounts))
     or exists (select 1 from public.bank_transaction_allocations a
                where a.organization_id = p_organization_id and a.account_id = any (v_accounts)) then
    raise exception 'Op de rekeningen van % staan boekingen. Een vennoot met boekingen verwijder je niet: zet hem op uitgetreden.', v_partner.name
      using errcode = '23514';
  end if;
  if exists (select 1 from public.fiscal_year_partner_shares s
             join public.fiscal_years fy on fy.id = s.fiscal_year_id
             where s.organization_id = p_organization_id and s.partner_id = p_partner_id
               and fy.status = 'closed' and coalesce(s.share_cents, 0) <> 0) then
    raise exception '% heeft een winstaandeel in een afgesloten boekjaar. Zet hem op uitgetreden.', v_partner.name
      using errcode = '23514';
  end if;

  delete from public.partnership_partners where id = v_partner.id and organization_id = p_organization_id;
  begin
    delete from public.ledger_accounts la
    where la.organization_id = p_organization_id and la.id = any (v_accounts);
  exception when foreign_key_violation then
    raise exception 'De rekeningen van % zijn nog ergens in gebruik (een activum, vooruitbetaalde kosten of een bankrekening). Haal ze daar eerst weg, of zet hem op uitgetreden.', v_partner.name
      using errcode = '23514';
  end;
end;
$$;
revoke all on function public.delete_partnership_partner(uuid, uuid) from public, anon;
grant execute on function public.delete_partnership_partner(uuid, uuid) to authenticated, service_role;

-- ── 9. Een verdeling vastleggen gaat voor een momentopname ──────────────

CREATE OR REPLACE FUNCTION public.set_fiscal_year_partner_shares(p_organization_id uuid, p_fiscal_year_id uuid, p_shares jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_fy public.fiscal_years;
  v_form text;
  v_partner public.partnership_partners;
  e jsonb;
  v_id uuid;
  v_bp integer;
  v_prior bigint;
  v_total integer := 0;
  v_ids uuid[] := '{}';
begin
  if auth.role() <> 'service_role'
     and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor de financiën van deze organisatie.' using errcode = '42501';
  end if;

  -- Zelfde slot als afsluiten en heropenen: de verdeling verandert niet
  -- terwijl het jaar dichtgaat.
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':fyclose'));

  select * into v_fy from public.fiscal_years
  where id = p_fiscal_year_id and organization_id = p_organization_id
  for update;
  if not found then
    raise exception 'Boekjaar niet gevonden.' using errcode = '02000';
  end if;
  if v_fy.status = 'closed' then
    raise exception 'Boekjaar % is afgesloten, met de verdeling die toen gold. Moet die anders, heropen het boekjaar dan eerst; daarna sluit je het af met de nieuwe verdeling.', v_fy.label
      using errcode = '23514';
  end if;
  v_form := coalesce(v_fy.legal_form, public.org_legal_form(p_organization_id));
  if v_form not in ('vof', 'maatschap', 'cv') then
    raise exception 'Een verdeling over vennoten hoort bij een vof, maatschap of cv. Boekjaar % staat als %.', v_fy.label, v_form
      using errcode = '23514';
  end if;
  if p_shares is null or jsonb_typeof(p_shares) <> 'array' then
    raise exception 'Geef de verdeling als lijst van vennoten.' using errcode = '22023';
  end if;

  if jsonb_array_length(p_shares) = 0 then
    delete from public.fiscal_year_partner_shares s
    where s.organization_id = p_organization_id and s.fiscal_year_id = p_fiscal_year_id;
    return '[]'::jsonb;
  end if;

  for e in select * from jsonb_array_elements(p_shares) loop
    begin
      v_id := (e ->> 'partner_id')::uuid;
      v_bp := (e ->> 'share_basis_points')::integer;
      v_prior := coalesce((e ->> 'prior_share_cents')::bigint, 0);
    exception when others then
      raise exception 'Een regel van de verdeling is niet goed: %.', e::text using errcode = '22023';
    end;
    select * into v_partner from public.partnership_partners pp
    where pp.id = v_id and pp.organization_id = p_organization_id;
    if not found then
      raise exception 'Vennoot niet gevonden.' using errcode = '02000';
    end if;
    if v_id = any (v_ids) then
      raise exception '% staat twee keer in de verdeling.', v_partner.name using errcode = '23514';
    end if;
    if v_bp is null or v_bp < 0 or v_bp > 10000 then
      raise exception 'Het winstaandeel van % ligt tussen 0 en 100 procent.', v_partner.name using errcode = '23514';
    end if;
    if abs(v_prior) > 100000000000 then
      raise exception 'Het voorafgaande bedrag van % is te groot.', v_partner.name using errcode = '23514';
    end if;
    v_total := v_total + v_bp;
    v_ids := v_ids || v_id;
  end loop;

  if v_total <> 10000 then
    raise exception 'De verdeling voor boekjaar % telt op tot % procent; dat moet precies 100 procent zijn.',
      v_fy.label, replace(rtrim(to_char(v_total / 100.0, 'FM990.99'), '.'), '.', ',') using errcode = '23514';
  end if;

  -- GEWIJZIGD (20261124120000): ook de momentopname van een eerdere
  -- automatische verdeling gaat weg; wat je nu vastlegt, geldt.
  delete from public.fiscal_year_partner_shares s
  where s.organization_id = p_organization_id
    and s.fiscal_year_id = p_fiscal_year_id
    and (not (s.partner_id = any (v_ids)) or s.source <> 'vastgelegd');

  for e in select * from jsonb_array_elements(p_shares) loop
    v_id := (e ->> 'partner_id')::uuid;
    select * into v_partner from public.partnership_partners pp
    where pp.id = v_id and pp.organization_id = p_organization_id;
    insert into public.fiscal_year_partner_shares
      (organization_id, fiscal_year_id, partner_id, share_basis_points, prior_share_cents, kind, share_cents, updated_by, source)
    values (
      p_organization_id, p_fiscal_year_id, v_id,
      (e ->> 'share_basis_points')::integer,
      coalesce((e ->> 'prior_share_cents')::bigint, 0),
      case when v_form = 'cv' then v_partner.kind else 'beherend' end,
      null, auth.uid(), 'vastgelegd')
    on conflict (fiscal_year_id, partner_id) do update
      set share_basis_points = excluded.share_basis_points,
          prior_share_cents = excluded.prior_share_cents,
          kind = excluded.kind,
          share_cents = null,
          updated_by = excluded.updated_by
      where fiscal_year_partner_shares.share_basis_points is distinct from excluded.share_basis_points
         or fiscal_year_partner_shares.prior_share_cents is distinct from excluded.prior_share_cents
         or fiscal_year_partner_shares.kind is distinct from excluded.kind
         or fiscal_year_partner_shares.share_cents is not null;
  end loop;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'partnerId', s.partner_id, 'shareBasisPoints', s.share_basis_points,
             'priorShareCents', s.prior_share_cents, 'kind', s.kind) order by pp.partner_number)
    from public.fiscal_year_partner_shares s
    join public.partnership_partners pp on pp.id = s.partner_id and pp.organization_id = p_organization_id
    where s.organization_id = p_organization_id and s.fiscal_year_id = p_fiscal_year_id
  ), '[]'::jsonb);
end;
$function$;
revoke all on function public.set_fiscal_year_partner_shares(uuid, uuid, jsonb) from public, anon;
grant execute on function public.set_fiscal_year_partner_shares(uuid, uuid, jsonb) to authenticated, service_role;

-- ── 6. De jaarafsluiting: perioden, rekening-courant bij uittreden ──────

CREATE OR REPLACE FUNCTION public.close_fiscal_year(p_organization_id uuid, p_fiscal_year_id uuid, p_created_by uuid DEFAULT auth.uid())
 RETURNS fiscal_years
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_fy public.fiscal_years;
  v_kor boolean;
  v_vat_period text;
  v_result_code text;
  v_lines jsonb := '[]'::jsonb;
  v_debit_total bigint := 0;   -- som van de debiteringen tegen omzetrekeningen
  v_credit_total bigint := 0;  -- som van de crediteringen tegen kostenrekeningen
  v_result_cents bigint := 0;  -- nettoresultaat (winst > 0, verlies < 0)
  v_entry public.journal_entries;
  v_result_account uuid;
  r record;
  v_cursor date;
  v_p_start date;
  v_p_end date;
  v_regime text;
  v_year_period text;
  v_partnership boolean := false;
  v_share_total integer := 0;
  v_capital uuid;
  s record;
  v_open_dep integer := 0;
  v_open_dep_names text;
  v_open_prepaid integer := 0;
  v_open_prepaid_names text;
  v_before text;
  v_open_bank integer := 0;
  v_start_date date;
  v_vat_left bigint := 0;
  v_year_form text;
  v_changed text;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  -- Serialiseer close/reopen per organisatie (voorkomt dubbele resultaatbestemming).
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':fyclose'));
  -- TOEGEVOEGD (20261104000000): exclusief op de boekingsgrendel, zodat er
  -- geen boeking meer in dit jaar valt tussen het optellen en het slot.
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':periodegrendel'));

  select * into v_fy from public.fiscal_years
  where id = p_fiscal_year_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Boekjaar niet gevonden.' using errcode = '02000';
  end if;
  if v_fy.status = 'closed' then
    raise exception 'Dit boekjaar is al afgesloten.' using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261104000000): een lopend boekjaar sluit je niet af; latere
  -- boekingen zouden anders naar het volgende jaar schuiven.
  -- GEWIJZIGD (20261123140000): "vandaag" is de Nederlandse dag. Deze versie
  -- start van 20261122100000_vof_verdeling_per_boekjaar (de verdeling per
  -- boekjaar), niet van een oudere: anders viel die weer weg.
  if v_fy.period_end >= (now() at time zone 'Europe/Amsterdam')::date then
    raise exception 'Dit boekjaar loopt nog tot en met %; afsluiten kan vanaf de dag daarna.',
      to_char(v_fy.period_end, 'DD-MM-YYYY') using errcode = '23514';
  end if;

  -- Sequentiële volgorde: geen geboekte transacties vóór dit boekjaar die niet in
  -- een afgesloten jaar-slot vallen (dus het voorgaande boekjaar moet dicht zijn).
  -- GEWIJZIGD (20261119180000): een boekstuk en zijn tegenboeking die allebei vóór dit
  -- boekjaar liggen, vallen tegen elkaar weg en tellen niet. En de melding
  -- noemt wat er in de weg staat. Er stond alleen "sluit eerst het voorgaande
  -- boekjaar af", ook als dat jaar niet bestond: wie een boeking vóór zijn
  -- eerste boekjaar had (een activum van vóór de start), kwam er nooit meer
  -- uit, ook niet door alles tegen te boeken.
  select string_agg(x.label, ', ' order by x.date) into v_before
  from (
    select distinct je.id, je.date, coalesce(je.entry_number, 'boekstuk') || ' van ' || to_char(je.date, 'DD-MM-YYYY') as label
    from public.journal_entries je
    left join public.journal_entries rev on rev.id = je.reversed_by_entry_id
    left join public.journal_entries org on org.id = je.reverses_entry_id
    where je.organization_id = p_organization_id
      and je.status = 'posted'
      -- GEWIJZIGD (20261118090000): een beginbalans van vóór het eerste
      -- boekjaar (per 31-12) is geen boekjaar dat nog dicht moet.
      and je.source_type not in ('year_close', 'opening_balance')
      and je.date < v_fy.period_start
      and not (rev.id is not null and rev.status = 'posted' and rev.date < v_fy.period_start)
      and not (org.id is not null and org.status = 'posted' and org.date < v_fy.period_start)
      and exists (select 1 from public.journal_lines jl where jl.entry_id = je.id)
      and not exists (
        select 1 from public.closed_periods cp
        where cp.organization_id = p_organization_id
          and cp.period_type = 'year'
          and je.date between cp.period_start and cp.period_end
      )
    order by je.date
    limit 3
  ) x;
  if v_before is not null then
    raise exception 'Er staan boekingen vóór dit boekjaar die in geen afgesloten boekjaar vallen (%). Sluit eerst het boekjaar af waarin ze vallen. Horen ze er niet (een datum vóór de start van je boekhouding), boek ze dan tegen in het Journaal: de tegenboeking komt op dezelfde datum en dan tellen ze niet meer mee.',
      v_before using errcode = '23514';
  end if;

  -- BTW hard block (tenzij KOR): elke kalender-aangifteperiode die binnen het
  -- boekjaar begint, moet gefinaliseerd (afgesloten) zijn.
  select coalesce(kor_enabled, false), coalesce(vat_return_period, 'quarterly'),
         coalesce(year_result_account_code, '0510')
    into v_kor, v_vat_period, v_result_code
  from public.company_settings where organization_id = p_organization_id;
  v_kor := coalesce(v_kor, false);
  v_vat_period := coalesce(v_vat_period, 'quarterly');
  v_result_code := coalesce(v_result_code, '0510');

  if not v_kor then
    -- GEWIJZIGD (20261118100000): elke maand die het boekjaar overlapt, valt in
    -- een afgesloten aangifte: die van de maand zelf, of die van het hele
    -- kwartaal eromheen. Hier telde alleen de frequentie van nu. Wie per
    -- 1 januari per maand aangifte ging doen en dat bij Instellingen omzette,
    -- kreeg het jaar ervoor (per kwartaal aangegeven) zo nooit meer dicht.
    -- Alleen precies een kalendermaand of -kwartaal telt, zoals
    -- finalize_vat_return ze vastlegt; een maand telt niet voor zijn kwartaal.
    --
    -- De melding noemt het ontbrekende tijdvak zoals dat jaar aangegeven werd:
    -- alleen kwartalen of alleen maanden, en anders de frequentie van nu.
    select case
             when bool_or(cp.period_type = 'quarter') and not bool_or(cp.period_type = 'month') then 'quarterly'
             when bool_or(cp.period_type = 'month') and not bool_or(cp.period_type = 'quarter') then 'monthly'
           end
      into v_year_period
    from public.closed_periods cp
    where cp.organization_id = p_organization_id
      and cp.period_type in ('month', 'quarter')
      and cp.period_end >= v_fy.period_start and cp.period_start <= v_fy.period_end;
    v_year_period := coalesce(v_year_period, v_vat_period);

    v_cursor := date_trunc('month', v_fy.period_start)::date;
    while v_cursor <= v_fy.period_end loop
      if not exists (
        select 1 from public.closed_periods cp
        where cp.organization_id = p_organization_id
          and (
            (cp.period_type = 'month'
              and cp.period_start = v_cursor
              and cp.period_end = (v_cursor + interval '1 month' - interval '1 day')::date)
            or (cp.period_type = 'quarter'
              and cp.period_start = date_trunc('quarter', v_cursor)::date
              and cp.period_end = (date_trunc('quarter', v_cursor) + interval '3 months' - interval '1 day')::date)
          )
      ) then
        v_p_start := date_trunc(case when v_year_period = 'monthly' then 'month' else 'quarter' end, v_cursor)::date;
        v_p_end := (v_p_start + case when v_year_period = 'monthly' then interval '1 month' else interval '3 months' end - interval '1 day')::date;
        raise exception 'Finaliseer eerst alle BTW-aangiften van dit boekjaar (ontbreekt de periode % t/m %).',
          to_char(v_p_start, 'DD-MM-YYYY'), to_char(v_p_end, 'DD-MM-YYYY')
          using errcode = '23514';
      end if;
      v_cursor := (v_cursor + interval '1 month')::date;
    end loop;
  end if;

  -- TOEGEVOEGD (20261118090000): afschrijvingen en termijnen van
  -- vooruitbetaalde kosten die in dit jaar vallen, horen erin vóór het slot.
  -- Daarna boekten ze stil op de eerste open dag van het volgende jaar: een
  -- laptop die t/m september was afgeschreven, kreeg oktober t/m december in
  -- het nieuwe jaar. De winst van beide jaren klopte dan niet.
  select count(*), string_agg(distinct fa.name, ', ')
    into v_open_dep, v_open_dep_names
  from public.asset_depreciations ad
  join public.fixed_assets fa on fa.id = ad.asset_id
  where ad.organization_id = p_organization_id
    and ad.status = 'scheduled'
    and ad.date <= v_fy.period_end
    and fa.acquisition_journal_entry_id is not null
    and fa.status <> 'disposed';
  if coalesce(v_open_dep, 0) > 0 then
    raise exception 'Er staan nog % afschrijvingstermijn(en) tot en met % klaar die niet geboekt zijn (%). Boek ze eerst bij Activa; anders komen ze in het volgende jaar en klopt de winst van beide jaren niet.',
      v_open_dep, to_char(v_fy.period_end, 'DD-MM-YYYY'), v_open_dep_names
      using errcode = '23514';
  end if;
  select count(*), string_agg(distinct pe.description, ', ')
    into v_open_prepaid, v_open_prepaid_names
  from public.prepaid_expense_releases pr
  join public.prepaid_expenses pe on pe.id = pr.prepaid_expense_id
  where pr.organization_id = p_organization_id
    and pr.status = 'scheduled'
    and pr.date <= v_fy.period_end
    and pe.start_journal_entry_id is not null;
  if coalesce(v_open_prepaid, 0) > 0 then
    raise exception 'Er staan nog % termijn(en) van vooruitbetaalde kosten tot en met % klaar die niet geboekt zijn (%). Boek ze eerst bij Vooruitbetaald; anders komen ze in het volgende jaar.',
      v_open_prepaid, to_char(v_fy.period_end, 'DD-MM-YYYY'), v_open_prepaid_names
      using errcode = '23514';
  end if;

  -- TOEGEVOEGD (20261119180000): bankmutaties uit dit jaar die nog niet geboekt zijn. Na
  -- het afsluiten komen ze op de eerste dag van het volgende jaar: de bank
  -- staat dan per 31 december anders dan op het afschrift, en kosten of omzet
  -- vallen in het verkeerde jaar. Afsluiten ging zonder één woord door.
  select cs.bookkeeping_start_date into v_start_date
  from public.company_settings cs where cs.organization_id = p_organization_id;
  select count(*) into v_open_bank
  from public.bank_transactions t
  where t.organization_id = p_organization_id
    and t.status in ('unmatched', 'suggested')
    and t.booking_date between greatest(v_fy.period_start, coalesce(v_start_date, v_fy.period_start)) and v_fy.period_end;
  if coalesce(v_open_bank, 0) > 0 then
    raise exception 'Er staan nog % bankmutatie(s) uit dit boekjaar bij Bank → Af te letteren die niet geboekt zijn. Boek ze eerst, of negeer wat er niet bij hoort; na het afsluiten komen ze in het volgende jaar terecht.',
      v_open_bank using errcode = '23514';
  end if;

  -- TOEGEVOEGD (20261119180000): met de KOR vraagt de jaarafsluiting geen btw-aangiften.
  -- Verlegde btw (een dienst uit het buitenland) geef je ook met de KOR aan en
  -- betaal je. Het jaar ging dicht met die schuld nog op 1520; daarna weigerde
  -- het tijdvak af te sluiten ("het boekjaar is afgesloten").
  if v_kor then
    select coalesce(sum(jl.credit_cents - jl.debit_cents), 0) into v_vat_left
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.date <= v_fy.period_end
      and la.subtype in ('vat_output', 'vat_reverse');
    if v_vat_left <> 0 then
      raise exception 'Er staat nog € % btw die je moet aangeven (verlegde btw geef je ook met de KOR aan). Sluit bij Omzetbelasting eerst de tijdvakken van dit boekjaar af waarin die valt.',
        replace(to_char(v_vat_left / 100.0, 'FM999999990.00'), '.', ',') using errcode = '23514';
    end if;
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);

  -- Sluitregels per W&V-rekening (exclusief eerdere/teruggedraaide year_close).
  for r in
    select jl.account_id, la.type as account_type,
           sum(jl.debit_cents) as d, sum(jl.credit_cents) as c
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.source_type <> 'year_close'
      and je.date between v_fy.period_start and v_fy.period_end
      and la.type in ('revenue', 'expense')
    group by jl.account_id, la.type
    having sum(jl.credit_cents - jl.debit_cents) <> 0
  loop
    if (r.c - r.d) > 0 then
      -- creditsaldo (typisch omzet): debiteer om op nul te zetten.
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', r.account_id, 'description', 'Resultaatbestemming jaarafsluiting',
        'debit_cents', (r.c - r.d), 'credit_cents', 0));
      v_debit_total := v_debit_total + (r.c - r.d);
    else
      -- debetsaldo (typisch kosten): crediteer om op nul te zetten.
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', r.account_id, 'description', 'Resultaatbestemming jaarafsluiting',
        'debit_cents', 0, 'credit_cents', (r.d - r.c)));
      v_credit_total := v_credit_total + (r.d - r.c);
    end if;
  end loop;

  -- Nettoresultaat volgt als restpost → boekstuk sluit exact (geen 4900-vangnet).
  v_result_cents := v_debit_total - v_credit_total;

  -- TOEGEVOEGD (20261104070000): bij een vof, maatschap of cv met vastgelegde
  -- vennoten is de winst van de vennoten. Het resultaat gaat dan naar hun
  -- kapitaalrekeningen, volgens de winstverdeling, tot op de cent sluitend.
  -- GEWIJZIGD (20261122100000): de rechtsvorm en de vennoten van dít boekjaar,
  -- niet die van vandaag. Wie per 1 januari van vof naar eenmanszaak ging,
  -- sloot 2025 anders af als eenmanszaak (alles naar 0500); een vennoot die
  -- vóór het afsluiten uittrad, kreeg niets, en een nieuwe vennoot kreeg winst
  -- over een jaar waarin hij er niet was.
  v_year_form := coalesce(v_fy.legal_form, public.org_legal_form(p_organization_id));
  v_regime := case
    when v_year_form in ('bv', 'nv', 'cooperatie') then 'vpb'
    when v_year_form in ('stichting', 'vereniging') then 'other'
    else 'ib'
  end;
  v_partnership := v_regime = 'ib'
    and v_year_form in ('vof', 'maatschap', 'cv')
    and exists (select 1 from public.fiscal_year_partner_split(p_organization_id, p_fiscal_year_id));

  -- TOEGEVOEGD (20261122100000): zijn de vennoten of hun verdeling ná het
  -- einde van dit boekjaar gewijzigd, en ligt er voor dit jaar nog niets
  -- vast, dan weet ResoFly niet welke verdeling gold. Afsluiten met die van
  -- nu gaf de winst aan de verkeerde vennoot, en de melding stuurde naar
  -- "pas de verdeling aan bij Vennoten": precies de verkeerde weg. Zie
  -- fiscal_year_partner_changes; ook als daardoor niemand meer meedoet.
  if v_regime = 'ib' and v_year_form in ('vof', 'maatschap', 'cv') then
    v_changed := array_to_string(public.fiscal_year_partner_changes(p_organization_id, p_fiscal_year_id), ', ');
    if coalesce(v_changed, '') <> '' then
      raise exception 'De vennoten of hun winstverdeling zijn na % gewijzigd (%). Welke verdeling gold in boekjaar %? Leg die eerst vast: Boekjaren → Afsluiten → Verdeling. De verdeling van nu kan voor dit jaar niet kloppen.',
        to_char(v_fy.period_end, 'DD-MM-YYYY'), v_changed, v_fy.label using errcode = '23514';
    end if;
  end if;

  if v_partnership then
    -- GEWIJZIGD (20261124120000): per periode. Treedt iemand halverwege het
    -- jaar in of uit, dan valt het jaar uiteen in perioden met elk hun eigen
    -- vennoten; elke periode moet op 100 procent uitkomen, en in elke periode
    -- moet iemand meedoen (anders kan het resultaat van die periode nergens heen).
    for s in
      select b.period_no, b.period_start, b.period_end,
             (select coalesce(sum(p.share_basis_points), 0)
              from public.fiscal_year_partners_on(p_organization_id, p_fiscal_year_id, b.period_start) p)::int as bp,
             (select count(*)
              from public.fiscal_year_partners_on(p_organization_id, p_fiscal_year_id, b.period_start) p)::int as n,
             (select count(*) from public.fiscal_year_period_bounds(p_organization_id, p_fiscal_year_id))::int as periods
      from public.fiscal_year_period_bounds(p_organization_id, p_fiscal_year_id) b
      order by b.period_no
    loop
      if s.n = 0 then
        raise exception 'Van % t/m % doet geen vennoot mee, dus het resultaat van die periode kan nergens heen. Kijk de datums van toe- en uittreden na bij Vennoten, of leg de verdeling van boekjaar % vast.',
          to_char(s.period_start, 'DD-MM-YYYY'), to_char(s.period_end, 'DD-MM-YYYY'), v_fy.label using errcode = '23514';
      end if;
      if s.bp <> 10000 then
        if s.periods > 1 then
          raise exception 'De winstverdeling van % t/m % telt op tot % procent; dat moet precies 100 procent zijn. Kijk de percentages en hun ingangsdatum na bij Vennoten, of leg de verdeling van boekjaar % vast.',
            to_char(s.period_start, 'DD-MM-YYYY'), to_char(s.period_end, 'DD-MM-YYYY'),
            replace(rtrim(to_char(s.bp / 100.0, 'FM990.99'), '.'), '.', ','), v_fy.label using errcode = '23514';
        end if;
        raise exception 'De winstverdeling voor boekjaar % telt op tot % procent; dat moet precies 100 procent zijn. Pas de verdeling voor dit boekjaar aan: Boekjaren → Afsluiten → Verdeling.',
          v_fy.label, replace(rtrim(to_char(s.bp / 100.0, 'FM990.99'), '.'), '.', ',') using errcode = '23514';
      end if;
    end loop;

    -- GEWIJZIGD (20261122100000): de verdeling van dit boekjaar, met eerst
    -- ieders voorafgaande bedrag (arbeidsbeloning, rente) en daarna naar rato.
    -- Ook bij een resultaat van € 0: met een bedrag vooraf verschuift er dan
    -- toch iets tussen de vennoten. Eerst stond dat wel in de vastgelegde
    -- verdeling, maar niet in het grootboek.
    for s in select * from public.fiscal_year_result_shares(p_organization_id, p_fiscal_year_id, v_result_cents) loop
      if s.share_cents > 0 then
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
          'account_id', s.capital_account_id,
          'description', 'Winstaandeel ' || s.name || ' boekjaar ' || v_fy.label,
          'debit_cents', 0, 'credit_cents', s.share_cents));
      elsif s.share_cents < 0 then
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
          'account_id', s.capital_account_id,
          'description', 'Verliesaandeel ' || s.name || ' boekjaar ' || v_fy.label,
          'debit_cents', -s.share_cents, 'credit_cents', 0));
      end if;
    end loop;
  elsif v_result_cents <> 0 then
    v_result_account := public.bookkeeping_account_id(p_organization_id, v_result_code);
    if v_result_cents > 0 then
      -- winst → crediteer de resultaatrekening (eigen vermogen stijgt).
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_result_account, 'description', 'Resultaat boekjaar ' || v_fy.label,
        'debit_cents', 0, 'credit_cents', v_result_cents));
    else
      -- verlies → debiteer de resultaatrekening (eigen vermogen daalt).
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_result_account, 'description', 'Resultaat boekjaar ' || v_fy.label,
        'debit_cents', -v_result_cents, 'credit_cents', 0));
    end if;
  end if;

  -- Het privé van elke vennoot (ook een vertrokken vennoot) gaat naar zijn
  -- eigen kapitaal.
  -- GEWIJZIGD (20261118130000): altijd, niet alleen bij een vof, maatschap of
  -- cv met actieve vennoten. Werd de rechtsvorm eenmanszaak, of stond elke
  -- vennoot op uitgetreden, dan bleven 055n en 056n open staan en schoven ze
  -- mee naar het volgende jaar. Het privé hoort bij de vennoot, welke
  -- rechtsvorm de administratie nu ook heeft; het resultaat volgt die wel.
  for s in
    select pp.name, pp.capital_account_id, acc.account_id, acc.label,
           (select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)
            from public.journal_lines jl
            join public.journal_entries je on je.id = jl.entry_id
            where jl.organization_id = p_organization_id
              and je.status = 'posted'
              and je.date <= v_fy.period_end
              and jl.account_id = acc.account_id)::bigint as bal
    from public.partnership_partners pp
    cross join lateral (values
      (pp.withdrawals_account_id, 'Privé-opnamen'),
      (pp.contributions_account_id, 'Privé-stortingen')
    ) as acc(account_id, label)
    where pp.organization_id = p_organization_id
    order by pp.partner_number, acc.label
  loop
    if s.bal <> 0 then
      v_lines := v_lines || jsonb_build_array(
        jsonb_build_object('account_id', s.account_id,
          'description', s.label || ' ' || s.name || ' naar kapitaal',
          'debit_cents', greatest(-s.bal, 0), 'credit_cents', greatest(s.bal, 0)),
        jsonb_build_object('account_id', s.capital_account_id,
          'description', s.label || ' ' || s.name || ' boekjaar ' || v_fy.label,
          'debit_cents', greatest(s.bal, 0), 'credit_cents', greatest(-s.bal, 0)));
    end if;
  end loop;

  -- TOEGEVOEGD (20261124120000): wie aan het einde van dit jaar geen vennoot
  -- meer is, krijgt zijn kapitaal (na zijn winstaandeel en zijn privé) op zijn
  -- rekening-courant: dat is wat de vof hem schuldig is (of hij de vof). Het
  -- bleef eigen vermogen, en een uitbetaling stond als privé-opname bij een
  -- vennoot die er niet meer was.
  for s in
    select pp.id, pp.name, pp.capital_account_id, pp.current_account_id, lv.valid_from as left_on,
           ((select coalesce(sum(jl.credit_cents - jl.debit_cents), 0)
             from public.journal_lines jl
             join public.journal_entries je on je.id = jl.entry_id
             where jl.organization_id = p_organization_id
               and je.status = 'posted'
               and je.date <= v_fy.period_end
               and jl.account_id in (pp.capital_account_id, pp.withdrawals_account_id, pp.contributions_account_id))
            + case when v_partnership then coalesce((
                select rs.share_cents from public.fiscal_year_result_shares(p_organization_id, p_fiscal_year_id, v_result_cents) rs
                where rs.partner_id = pp.id), 0) else 0 end)::bigint as amount
    from public.partnership_partners pp
    cross join lateral (
      select t.valid_from, t.is_active from public.partnership_partner_timeline t
      where t.partner_id = pp.id and t.organization_id = p_organization_id and t.valid_from <= v_fy.period_end
      order by t.valid_from desc limit 1
    ) lv
    where pp.organization_id = p_organization_id
      and not lv.is_active
      and pp.current_account_id is not null
    order by pp.partner_number
  loop
    if s.amount <> 0 then
      v_lines := v_lines || jsonb_build_array(
        jsonb_build_object('account_id', s.capital_account_id,
          'description', 'Naar rekening-courant: kapitaal ' || s.name || ' (uitgetreden per ' || to_char(s.left_on, 'DD-MM-YYYY') || ')',
          'debit_cents', greatest(s.amount, 0), 'credit_cents', greatest(-s.amount, 0)),
        jsonb_build_object('account_id', s.current_account_id,
          'description', 'Kapitaal ' || s.name || ' bij uittreden per ' || to_char(s.left_on, 'DD-MM-YYYY'),
          'debit_cents', greatest(-s.amount, 0), 'credit_cents', greatest(s.amount, 0)));
    end if;
  end loop;

  -- TOEGEVOEGD (20261104070000): privé-opnamen en -stortingen van een
  -- IB-onderneming (0550/0560, herkend aan het subtype) gaan naar het eigen
  -- vermogen. Bij een vof met vennoten staat hier alleen wat niet op de
  -- privérekening van een vennoot is geboekt; dat komt op 0500 en blijft in
  -- het overzicht als "nog niet aan een vennoot toegewezen" zichtbaar.
  if v_regime = 'ib' then
    v_capital := public.bookkeeping_account_id(p_organization_id, '0500');
    for s in
      select la.id as account_id, la.name,
             (select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)
              from public.journal_lines jl
              join public.journal_entries je on je.id = jl.entry_id
              where jl.organization_id = p_organization_id
                and je.status = 'posted'
                and je.date <= v_fy.period_end
                and jl.account_id = la.id)::bigint as bal
      from public.ledger_accounts la
      where la.organization_id = p_organization_id
        and la.subtype in ('private_withdrawals', 'private_contributions')
      order by la.code
    loop
      if s.bal <> 0 then
        v_lines := v_lines || jsonb_build_array(
          jsonb_build_object('account_id', s.account_id,
            'description', s.name || ' naar eigen vermogen',
            'debit_cents', greatest(-s.bal, 0), 'credit_cents', greatest(s.bal, 0)),
          jsonb_build_object('account_id', v_capital,
            'description', s.name || ' boekjaar ' || v_fy.label,
            'debit_cents', greatest(s.bal, 0), 'credit_cents', greatest(-s.bal, 0)));
      end if;
    end loop;
  end if;

  -- Post het afsluitboekstuk (leeg boekjaar → geen boekstuk).
  if jsonb_array_length(v_lines) > 0 then
    perform set_config('resofly.trusted_journal_source', 'year_close', true);
    v_entry := public.post_journal_entry(
      p_organization_id, v_fy.period_end,
      'Jaarafsluiting ' || v_fy.label,
      'year_close', p_fiscal_year_id, v_lines, p_created_by
    );
  end if;

  -- TOEGEVOEGD (20261122100000): de verdeling van dit boekjaar ligt vast, met
  -- wat er per vennoot is geboekt. Het overzicht en de raming lezen dat voor
  -- een afgesloten jaar, en heropenen en opnieuw afsluiten gebruikt dezelfde
  -- verdeling. Eerder rekende alles opnieuw met de vennoten van vandaag.
  -- GEWIJZIGD (20261124120000): een vastgelegde verdeling krijgt het geboekte
  -- bedrag erbij; van een automatische verdeling (de tijdlijn, met perioden)
  -- komt een momentopname, die bij opnieuw afsluiten niet geldt: dan rekent
  -- de tijdlijn opnieuw.
  if v_partnership then
    if exists (select 1 from public.fiscal_year_partner_shares fps
               where fps.organization_id = p_organization_id and fps.fiscal_year_id = p_fiscal_year_id
                 and fps.source = 'vastgelegd') then
      update public.fiscal_year_partner_shares fps
      set share_cents = rs.share_cents
      from public.fiscal_year_result_shares(p_organization_id, p_fiscal_year_id, v_result_cents) rs
      where fps.organization_id = p_organization_id and fps.fiscal_year_id = p_fiscal_year_id
        and fps.partner_id = rs.partner_id;
    else
      delete from public.fiscal_year_partner_shares fps
      where fps.organization_id = p_organization_id and fps.fiscal_year_id = p_fiscal_year_id;
      insert into public.fiscal_year_partner_shares
        (organization_id, fiscal_year_id, partner_id, share_basis_points, prior_share_cents, kind, share_cents, updated_by, source)
      select p_organization_id, p_fiscal_year_id, rs.partner_id, rs.share_basis_points, rs.prior_share_cents, rs.kind,
             rs.share_cents, p_created_by, 'afsluiting'
      from public.fiscal_year_result_shares(p_organization_id, p_fiscal_year_id, v_result_cents) rs;
    end if;
  end if;

  -- Vergrendel het volledige boekjaarbereik.
  insert into public.closed_periods(organization_id, period_type, year, quarter, month, period_start, period_end, closed_by)
  values (
    p_organization_id, 'year', extract(year from v_fy.period_start)::int, null, null,
    v_fy.period_start, v_fy.period_end, p_created_by
  )
  on conflict (organization_id, period_type, period_start, period_end) do nothing;

  update public.fiscal_years
  set status = 'closed', close_journal_entry_id = v_entry.id,
      result_account_code = case when v_partnership then 'vennoten' else v_result_code end,
      result_cents = v_result_cents,
      closed_at = now(), closed_by = p_created_by
  where id = p_fiscal_year_id
  returning * into v_fy;

  return v_fy;
end;
$function$;
revoke all on function public.close_fiscal_year(uuid, uuid, uuid) from public, anon;
grant execute on function public.close_fiscal_year(uuid, uuid, uuid) to authenticated, service_role;

-- ── 7. De kapitaalvergelijking: perioden, rekening-courant, uittreden ───

CREATE OR REPLACE FUNCTION public.owners_equity_overview(p_organization_id uuid, p_fiscal_year_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_fy public.fiscal_years;
  v_legal text;
  v_partnership boolean;
  v_partners_defined boolean;
  v_result bigint := 0;
  v_share_total integer := 0;
  v_owners jsonb := '[]'::jsonb;
  v_unassigned jsonb := null;
  v_partner_accounts uuid[] := '{}';
  v_begin bigint;
  v_contrib bigint;
  v_withdraw bigint;
  v_other bigint;
  v_name text;
  v_open_prior bigint := 0;
  v_open_years jsonb := '[]'::jsonb;
  r record;
  v_current_legal text;
  v_split_fixed boolean := false;
  v_changed jsonb := '[]'::jsonb;
  v_general_private bigint := 0;
  v_shown boolean;
  v_to_rc bigint;
  v_rc bigint;
  v_left date;
  v_joined date;
  v_inactive_at_end boolean;
  v_periods jsonb := '[]'::jsonb;
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_fy from public.fiscal_years
  where id = p_fiscal_year_id and organization_id = p_organization_id;
  if not found then
    raise exception 'Boekjaar niet gevonden.' using errcode = '02000';
  end if;

  -- GEWIJZIGD (20261122100000): de rechtsvorm van dít boekjaar. Na de
  -- overstap van vof naar eenmanszaak toonde 2025 één ondernemer met de hele
  -- winst, en een eenmanszaakjaar na de overstap naar vof winstaandelen voor
  -- vennoten die op hun rekeningen niets kregen.
  v_current_legal := public.org_legal_form(p_organization_id);
  v_legal := coalesce(v_fy.legal_form, v_current_legal);
  if v_legal not in ('eenmanszaak', 'vof', 'maatschap', 'cv') then
    raise exception 'Dit overzicht hoort bij een eenmanszaak, vof, maatschap of cv: daar is de winst van de ondernemer of de vennoten zelf.'
      using errcode = '23514';
  end if;

  v_partners_defined := exists (select 1 from public.partnership_partners pp where pp.organization_id = p_organization_id);
  -- GEWIJZIGD (20261124120000): alleen een verdeling die de gebruiker
  -- vastlegde; de momentopname van een automatische verdeling telt niet.
  v_split_fixed := exists (
    select 1 from public.fiscal_year_partner_shares s
    where s.organization_id = p_organization_id and s.fiscal_year_id = p_fiscal_year_id and s.source = 'vastgelegd');
  -- GEWIJZIGD (20261122100000): een afgesloten jaar is een vennotenjaar als de
  -- winst toen naar de vennoten ging; een open jaar als er een verdeling is.
  v_partnership := v_legal in ('vof', 'maatschap', 'cv')
    and case when v_fy.status = 'closed'
             then coalesce(v_fy.result_account_code, '') = 'vennoten' or v_split_fixed
             else exists (select 1 from public.fiscal_year_partner_split(p_organization_id, p_fiscal_year_id)) end;

  -- Resultaat van het boekjaar: de W&V zonder de jaarafsluiting.
  select coalesce(sum(jl.credit_cents - jl.debit_cents), 0)::bigint
  into v_result
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.entry_id
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.organization_id = p_organization_id
    and je.status = 'posted'
    and je.source_type <> 'year_close'
    and je.date between v_fy.period_start and v_fy.period_end
    and la.type in ('revenue', 'expense');

  -- TOEGEVOEGD (20261118090000): de winst van eerdere jaren die nog niet naar
  -- het eigen vermogen is gegaan (het jaar is niet afgesloten). Mét de
  -- jaarafsluitingen: daarin vallen omzet en kosten van een dicht jaar weg.
  select coalesce(sum(jl.credit_cents - jl.debit_cents), 0)::bigint
  into v_open_prior
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.entry_id
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.organization_id = p_organization_id
    and je.status = 'posted'
    and je.date < v_fy.period_start
    and la.type in ('revenue', 'expense');

  select coalesce(jsonb_agg(f.label order by f.period_start), '[]'::jsonb)
  into v_open_years
  from public.fiscal_years f
  where f.organization_id = p_organization_id
    and f.status <> 'closed'
    and f.period_end < v_fy.period_start;

  -- GEWIJZIGD (20261122100000): ook een vof, maatschap of cv met vennoten
  -- waarvan er dit jaar geen meedoet (allemaal uitgetreden). Die toonde één
  -- "Ondernemer" met de bedrijfsnaam, het kapitaal van alle vennoten en de
  -- teksten van een eenmanszaak. Nu de vennoten, en het resultaat apart als
  -- niet verdeeld.
  if v_partnership or (v_legal in ('vof', 'maatschap', 'cv') and v_partners_defined) then
    -- GEWIJZIGD (20261124120000): per periode; 100 als elke periode klopt,
    -- anders het totaal van de eerste periode die niet klopt.
    select coalesce((
      select x.bp from (
        select b.period_no,
               (select coalesce(sum(p.share_basis_points), 0)
                from public.fiscal_year_partners_on(p_organization_id, p_fiscal_year_id, b.period_start) p)::int as bp
        from public.fiscal_year_period_bounds(p_organization_id, p_fiscal_year_id) b
      ) x where x.bp <> 10000 order by x.period_no limit 1), 10000)
    into v_share_total;

    -- TOEGEVOEGD (20261122100000): wie er na het einde van dit jaar bij kwam,
    -- uittrad of een ander percentage kreeg (fiscal_year_partner_changes). Het
    -- afsluitvenster vraagt dan eerst de verdeling van dit jaar.
    v_changed := to_jsonb(public.fiscal_year_partner_changes(p_organization_id, p_fiscal_year_id));

    -- GEWIJZIGD (20261122100000): het winstaandeel volgens de verdeling van
    -- dit boekjaar; bij een afgesloten jaar wat er toen is geboekt. Hier
    -- rekende het met de vennoten en percentages van vandaag, ook voor een
    -- jaar dat al lang dicht was: het eind van 2025 was dan niet het begin van
    -- 2026, en een uitgetreden vennoot had over zijn laatste jaar niets.
    for r in
      select pp.id, pp.name, pp.partner_number, pp.profit_share_basis_points, pp.kind, pp.is_active,
             pp.capital_account_id, pp.withdrawals_account_id, pp.contributions_account_id, pp.current_account_id,
             case when v_partnership then coalesce(sh.loss_shift_cents, 0) else 0 end::bigint as loss_shift,
             -- GEWIJZIGD (20261124120000): bij een afgesloten jaar wie er toen
             -- meedeed en met welk percentage (zoals vastgelegd bij het
             -- afsluiten), niet de tijdlijn van nu.
             v_partnership and (case when v_fy.status = 'closed' then bk.partner_id is not null else sp.partner_id is not null end) as in_split,
             case when v_partnership then coalesce(case when v_fy.status = 'closed' then bk.share_basis_points end, sp.share_basis_points, 0) else 0 end as year_bp,
             case when v_partnership then coalesce(sp.prior_share_cents, 0) else 0 end::bigint as prior_cents,
             coalesce(sp.kind, pp.kind) as year_kind,
             case when v_partnership then coalesce(
               case when v_fy.status = 'closed' then sp.booked_share_cents end,
               sh.share_cents, 0) else 0 end::bigint as share_cents
      from public.partnership_partners pp
      left join public.fiscal_year_partner_split(p_organization_id, p_fiscal_year_id) sp on sp.partner_id = pp.id
      left join public.fiscal_year_result_shares(p_organization_id, p_fiscal_year_id, v_result) sh on sh.partner_id = pp.id
      left join public.fiscal_year_partner_shares bk
        on bk.organization_id = p_organization_id and bk.fiscal_year_id = p_fiscal_year_id and bk.partner_id = pp.id
      where pp.organization_id = p_organization_id
      order by pp.partner_number
    loop
      v_partner_accounts := v_partner_accounts || array[r.capital_account_id, r.withdrawals_account_id, r.contributions_account_id];

      select coalesce(sum(jl.credit_cents - jl.debit_cents), 0)::bigint into v_begin
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.entry_id
      where jl.organization_id = p_organization_id
        and je.status = 'posted'
        and jl.account_id in (r.capital_account_id, r.withdrawals_account_id, r.contributions_account_id)
        and (je.date < v_fy.period_start
             or (je.source_type = 'opening_balance' and je.date between v_fy.period_start and v_fy.period_end));

      select
        coalesce(sum(jl.credit_cents - jl.debit_cents) filter (where jl.account_id = r.contributions_account_id), 0)::bigint,
        coalesce(sum(jl.debit_cents - jl.credit_cents) filter (where jl.account_id = r.withdrawals_account_id), 0)::bigint,
        coalesce(sum(jl.credit_cents - jl.debit_cents) filter (where jl.account_id = r.capital_account_id), 0)::bigint
      into v_contrib, v_withdraw, v_other
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.entry_id
      where jl.organization_id = p_organization_id
        and je.status = 'posted'
        and je.source_type not in ('year_close', 'opening_balance')
        and je.date between v_fy.period_start and v_fy.period_end
        and jl.account_id in (r.capital_account_id, r.withdrawals_account_id, r.contributions_account_id);

      -- TOEGEVOEGD (20261122100000): een vennoot die in dit jaar niet meedeed en
      -- er niets op zijn rekeningen had (hij kwam later), staat er niet bij.
      -- TOEGEVOEGD (20261124120000): de tijdlijn (sinds, uitgetreden per), de
      -- rekening-courant, en wat er bij uittreden naar de rekening-courant gaat.
      -- Bij een afgesloten jaar wat er geboekt is; bij een open jaar wat er bij
      -- het afsluiten heen gaat, als hij aan het eind van het jaar geen vennoot
      -- meer is.
      select min(t.valid_from) filter (where t.is_active) into v_joined
      from public.partnership_partner_timeline t where t.partner_id = r.id and t.organization_id = p_organization_id;
      select case when not t.is_active then t.valid_from end, not t.is_active into v_left, v_inactive_at_end
      from public.partnership_partner_timeline t
      where t.partner_id = r.id and t.organization_id = p_organization_id and t.valid_from <= v_fy.period_end
      order by t.valid_from desc limit 1;
      v_inactive_at_end := coalesce(v_inactive_at_end, false);
      select coalesce(sum(jl.credit_cents - jl.debit_cents), 0)::bigint into v_rc
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.entry_id
      where jl.organization_id = p_organization_id and je.status = 'posted'
        and je.date <= v_fy.period_end and jl.account_id = r.current_account_id;
      if v_fy.status = 'closed' then
        select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::bigint into v_to_rc
        from public.journal_lines jl
        where jl.entry_id = v_fy.close_journal_entry_id
          and jl.account_id = r.capital_account_id
          and jl.description like 'Naar rekening-courant:%';
      elsif v_inactive_at_end and r.current_account_id is not null then
        v_to_rc := v_begin + r.share_cents + v_contrib - v_withdraw + v_other;
      else
        v_to_rc := 0;
      end if;

      v_shown := r.in_split or v_begin <> 0 or v_contrib <> 0 or v_withdraw <> 0 or v_other <> 0 or r.share_cents <> 0
                 or v_rc <> 0 or v_to_rc <> 0;
      if v_shown then
        v_owners := v_owners || jsonb_build_array(jsonb_build_object(
          'partnerId', r.id,
          'name', r.name,
          'partnerNumber', r.partner_number,
          -- GEWIJZIGD (20261122100000): soort en percentage van dit boekjaar.
          'kind', r.year_kind,
          'isActive', r.is_active,
          'inSplit', r.in_split,
          'shareBasisPoints', r.year_bp,
          'currentShareBasisPoints', r.profit_share_basis_points,
          'priorShareCents', r.prior_cents,
          -- TOEGEVOEGD (20261124120000)
          'joinedOn', v_joined,
          'leftOn', v_left,
          'lossShiftCents', r.loss_shift,
          'currentAccountId', r.current_account_id,
          'currentAccountCents', v_rc,
          'toCurrentAccountCents', v_to_rc,
          'beginCents', v_begin,
          'resultShareCents', r.share_cents,
          'contributionsCents', v_contrib,
          'withdrawalsCents', v_withdraw,
          'otherMovementsCents', v_other,
          -- GEWIJZIGD (20261124120000): min wat er naar de rekening-courant gaat.
          'endCents', v_begin + r.share_cents + v_contrib - v_withdraw + v_other - v_to_rc
        ));
      end if;
    end loop;

    -- TOEGEVOEGD (20261124120000): de perioden van het jaar, met het resultaat
    -- en het deel per vennoot in elke periode (zoals de jaarafsluiting rekent).
    if v_partnership then
      select coalesce(jsonb_agg(jsonb_build_object(
               'periodStart', g.period_start, 'periodEnd', g.period_end, 'resultCents', g.period_result_cents,
               'shares', g.shares) order by g.period_no), '[]'::jsonb)
      into v_periods
      from (
        select d.period_no, d.period_start, d.period_end, d.period_result_cents,
               coalesce(jsonb_agg(jsonb_build_object(
                 'partnerId', d.partner_id, 'name', d.name, 'shareBasisPoints', d.share_basis_points,
                 'shareCents', d.share_cents) order by d.partner_number) filter (where d.partner_id is not null), '[]'::jsonb) as shares
        from public.fiscal_year_result_detail(p_organization_id, p_fiscal_year_id, v_result) d
        where d.period_no >= 1
        group by d.period_no, d.period_start, d.period_end, d.period_result_cents
      ) g;
    end if;

    -- Wat op geen enkele vennoot staat (0500, 0510, 0550/0560, ...).
    select
      coalesce(sum(jl.credit_cents - jl.debit_cents) filter (
        where je.date < v_fy.period_start
           or (je.source_type = 'opening_balance' and je.date between v_fy.period_start and v_fy.period_end)), 0)::bigint,
      coalesce(sum(jl.credit_cents - jl.debit_cents) filter (
        where je.source_type not in ('year_close', 'opening_balance')
          and je.date between v_fy.period_start and v_fy.period_end), 0)::bigint
    into v_begin, v_other
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and la.type = 'equity'
      and not (jl.account_id = any (v_partner_accounts));

    -- TOEGEVOEGD (20261118090000): de winst van een vorig jaar dat nog open
    -- is, is nog niet over de vennoten verdeeld; die staat hier tot dat jaar
    -- dicht is.
    -- GEWIJZIGD (20261122100000): die winst staat apart. Hij zat in het
    -- begin van "nog niet toegewezen", en het scherm raadde aan dat bedrag met
    -- een memoriaal over de vennoten te verdelen. Wie dat deed en daarna het
    -- vorige jaar afsloot, gaf de vennoten die winst twee keer.
    if v_begin <> 0 or v_other <> 0 or v_open_prior <> 0 or not v_partnership then
      v_unassigned := jsonb_build_object(
        'beginCents', v_begin,
        'openPriorResultCents', v_open_prior,
        'movementsCents', v_other,
        -- Het resultaat van dit jaar als er niemand in de verdeling zit: dat
        -- gaat bij het afsluiten naar 0510 (of 0500), op geen vennoot.
        'resultCents', case when v_partnership then 0 else v_result end,
        'endCents', v_begin + v_open_prior + v_other + case when v_partnership then 0 else v_result end
      );
    end if;

    -- TOEGEVOEGD (20261122100000): wat er dit jaar op 0550/0560 (privé, geen
    -- vennoot) is geboekt. Bij het afsluiten gaat dat naar 0500 en staat het
    -- bij geen enkele vennoot op de aangifte; het afsluitvenster noemt het.
    select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::bigint into v_general_private
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.source_type <> 'year_close'
      and je.date between v_fy.period_start and v_fy.period_end
      and la.subtype in ('private_withdrawals', 'private_contributions');
  else
    select coalesce(nullif(btrim(cs.company_name), ''), 'Ondernemer') into v_name
    from public.company_settings cs where cs.organization_id = p_organization_id;

    -- GEWIJZIGD (20261118090000): ook omzet en kosten van vóór de begindatum
    -- (zie de toelichting boven deze functie).
    select coalesce(sum(jl.credit_cents - jl.debit_cents), 0)::bigint into v_begin
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and (
        (je.date < v_fy.period_start and la.type in ('equity', 'revenue', 'expense'))
        or (la.type = 'equity' and je.source_type = 'opening_balance'
            and je.date between v_fy.period_start and v_fy.period_end)
      );

    -- GEWIJZIGD (20261118130000): ook het privé van (vroegere) vennoten telt als
    -- storting of opname. Zonder actieve vennoot, of na de overstap van een vof
    -- naar een eenmanszaak, stond een opname op 0551 hier als "overig".
    select
      coalesce(sum(jl.credit_cents - jl.debit_cents) filter (
        where la.subtype in ('private_contributions', 'partner_contributions')), 0)::bigint,
      coalesce(sum(jl.debit_cents - jl.credit_cents) filter (
        where la.subtype in ('private_withdrawals', 'partner_withdrawals')), 0)::bigint,
      coalesce(sum(jl.credit_cents - jl.debit_cents) filter (
        where coalesce(la.subtype, '') not in ('private_contributions', 'private_withdrawals',
                                               'partner_contributions', 'partner_withdrawals')), 0)::bigint
    into v_contrib, v_withdraw, v_other
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.source_type not in ('year_close', 'opening_balance')
      and je.date between v_fy.period_start and v_fy.period_end
      and la.type = 'equity';

    v_owners := jsonb_build_array(jsonb_build_object(
      'partnerId', null,
      'name', coalesce(v_name, 'Ondernemer'),
      'partnerNumber', null,
      'kind', null,
      'isActive', true,
      'shareBasisPoints', 10000,
      'beginCents', v_begin,
      'resultShareCents', v_result,
      'contributionsCents', v_contrib,
      'withdrawalsCents', v_withdraw,
      'otherMovementsCents', v_other,
      'endCents', v_begin + v_result + v_contrib - v_withdraw + v_other
    ));
  end if;

  return jsonb_build_object(
    'fiscalYear', jsonb_build_object(
      'id', v_fy.id, 'label', v_fy.label, 'periodStart', v_fy.period_start,
      'periodEnd', v_fy.period_end, 'status', v_fy.status),
    'legalForm', v_legal,
    -- TOEGEVOEGD (20261122100000): de rechtsvorm van nu, de herkomst van de
    -- verdeling (vastgelegd voor dit jaar of die van de actieve vennoten), wie
    -- er na het einde van het jaar veranderde, en privé zonder vennoot.
    'currentLegalForm', v_current_legal,
    'splitFixed', v_split_fixed,
    -- TOEGEVOEGD (20261124120000): automatisch (de tijdlijn) of vastgelegd, en de perioden.
    'splitMode', case when v_split_fixed then 'vastgelegd' else 'automatisch' end,
    'periods', v_periods,
    'splitChangedAfterYearEnd', v_changed,
    'generalPrivateCents', v_general_private,
    'isPartnershipForm', v_legal in ('vof', 'maatschap', 'cv'),
    'isPartnership', v_partnership,
    'partnersDefined', v_partners_defined,
    'shareTotalBasisPoints', case when v_partnership then v_share_total else null end,
    'resultCents', v_result,
    -- TOEGEVOEGD (20261118090000): voor de melding "2025 is nog niet afgesloten".
    'openPriorResultCents', v_open_prior,
    'openPriorYears', v_open_years,
    'owners', v_owners,
    'unassigned', v_unassigned
  );
end;
$function$;
revoke all on function public.owners_equity_overview(uuid, uuid) from public, anon;
grant execute on function public.owners_equity_overview(uuid, uuid) to authenticated, service_role;

-- ── 8. De raming: de verdeling zoals de jaarafsluiting hem maakt ────────

CREATE OR REPLACE FUNCTION public.get_income_tax_inputs(p_organization_id uuid, p_year integer, p_hours boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_legal text;
  v_partnership_form boolean;
  v_start date;
  v_end date;
  v_result bigint := 0;
  v_mixed bigint := 0;
  v_minutes bigint := null;
  v_owner uuid;
  v_owner_minutes bigint := null;
  v_partner_minutes jsonb := null;
  v_may_read_hours boolean;
  v_company text;
  v_bookkeeping_start date;
  v_fy public.fiscal_years;
  v_owner_first date := null;
  v_partner_first jsonb := null;
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if p_year is null or p_year < 2000 or p_year > 2100 then
    raise exception 'Kies een kalenderjaar tussen 2000 en 2100.' using errcode = '22023';
  end if;

  v_start := make_date(p_year, 1, 1);
  v_end := make_date(p_year, 12, 31);

  -- GEWIJZIGD (20261122100000): de rechtsvorm en de verdeling van het
  -- boekjaar in dit kalenderjaar (bij een IB-onderneming valt een boekjaar
  -- binnen één kalenderjaar). Na de overstap van vof naar eenmanszaak raamde
  -- 2025 hier één ondernemer met de hele winst van de vof, en een uitgetreden
  -- vennoot kreeg geen raming meer over het jaar waarin hij winst had.
  select * into v_fy from public.fiscal_years fy
  where fy.organization_id = p_organization_id
    and fy.period_start <= v_end and fy.period_end >= v_start
  order by fy.period_end desc
  limit 1;
  v_legal := coalesce(v_fy.legal_form, public.org_legal_form(p_organization_id));
  -- GEWIJZIGD (20261122100000): de rechtsvorm van dat jaar. Na de overstap van
  -- een vof naar een BV bleef de raming van het laatste vof-jaar anders dicht.
  if v_legal not in ('eenmanszaak', 'vof', 'maatschap', 'cv') then
    raise exception 'De raming van de inkomstenbelasting hoort bij een eenmanszaak, vof, maatschap of cv: daar is de winst van de ondernemer of de vennoten zelf.'
      using errcode = '23514';
  end if;
  v_partnership_form := v_legal in ('vof', 'maatschap', 'cv');

  select coalesce(sum(jl.credit_cents - jl.debit_cents), 0)::bigint
  into v_result
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.entry_id
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.organization_id = p_organization_id
    and je.status = 'posted'
    and je.source_type <> 'year_close'
    and je.date between v_start and v_end
    and la.type in ('revenue', 'expense');

  -- Eten, drinken en representatie: beperkt aftrekbaar (art. 3.15 Wet IB).
  select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::bigint
  into v_mixed
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.entry_id
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.organization_id = p_organization_id
    and je.status = 'posted'
    and je.source_type <> 'year_close'
    and je.date between v_start and v_end
    and la.type = 'expense'
    and la.subtype = 'mixed_costs';

  select nullif(btrim(cs.company_name), ''), cs.bookkeeping_start_date
  into v_company, v_bookkeeping_start
  from public.company_settings cs
  where cs.organization_id = p_organization_id;

  -- Je eigen geregistreerde uren, als hint bij het urencriterium. Alleen met
  -- leesrecht op Uren: wie die module niet mag zien, krijgt ook dit getal niet.
  if auth.uid() is not null and public.can_read_module(p_organization_id, 'time') then
    select coalesce(sum(te.minutes), 0)::bigint
    into v_minutes
    from public.time_entries te
    where te.organization_id = p_organization_id
      and te.user_id = auth.uid()
      and te.entry_date between v_start and v_end;
  end if;

  v_may_read_hours := coalesce(p_hours, false)
    and (auth.role() = 'service_role' or (auth.uid() is not null and public.can_read_module(p_organization_id, 'time')));

  -- De uren van de eigenaar: bij een eenmanszaak is hij de ondernemer (zoals
  -- op Eigen vermogen).
  if v_may_read_hours and not v_partnership_form then
    select om.user_id into v_owner
    from public.organization_members om
    where om.organization_id = p_organization_id and om.role = 'owner' and om.status = 'active'
    order by om.created_at, om.user_id
    limit 1;
    if v_owner is not null then
      -- GEWIJZIGD (20261122100000): ook de eerste dag met uren, voor de
      -- prognose zoals de teller op Eigen vermogen en Vennoten.
      select coalesce(sum(te.minutes), 0)::bigint, min(te.entry_date)
      into v_owner_minutes, v_owner_first
      from public.time_entries te
      where te.organization_id = p_organization_id
        and te.user_id = v_owner
        and te.entry_date between v_start and v_end;
    end if;
  end if;

  -- De uren per vennoot, voor wie aan een teamlid hangt; direct en indirect,
  -- declarabel of niet, net als partnership_partner_hours.
  if v_may_read_hours and v_partnership_form then
    -- GEWIJZIGD (20261122100000): ook de eerste dag met uren per vennoot. De
    -- prognose in de raming rekende vanaf 1 januari, de teller op Vennoten
    -- vanaf de eerste uren: een vennoot die in juni toetrad, was op Vennoten
    -- "op koers" en in de raming niet (€ 1.074,92 te veel belasting).
    select coalesce(jsonb_object_agg(x.partner_id, x.minutes), '{}'::jsonb),
           coalesce(jsonb_object_agg(x.partner_id, x.first_date) filter (where x.first_date is not null), '{}'::jsonb)
    into v_partner_minutes, v_partner_first
    from (
      select pp.id as partner_id, coalesce(sum(te.minutes), 0)::bigint as minutes, min(te.entry_date) as first_date
      from public.partnership_partners pp
      left join public.time_entries te
        on te.organization_id = p_organization_id
       and te.user_id = pp.user_id
       and te.entry_date between v_start and v_end
      where pp.organization_id = p_organization_id
        and pp.user_id is not null
      group by pp.id
    ) x;
  end if;

  return jsonb_build_object(
    'year', p_year,
    'legalForm', v_legal,
    'isPartnershipForm', v_partnership_form,
    'companyName', v_company,
    'bookkeepingStartDate', v_bookkeeping_start,
    'resultCents', v_result,
    'mixedCostsCents', v_mixed,
    'overlappingFiscalYears', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', fy.id, 'label', fy.label, 'periodStart', fy.period_start,
               'periodEnd', fy.period_end, 'status', fy.status
             ) order by fy.period_start)
      from public.fiscal_years fy
      where fy.organization_id = p_organization_id
        and fy.period_start <= v_end
        and fy.period_end >= v_start
    ), '[]'::jsonb),
    -- GEWIJZIGD (20261122100000): de vennoten met de verdeling van het
    -- boekjaar. isActive betekent nu "doet mee in de verdeling van dit jaar"
    -- (de raming rekent alleen met hen); currentlyActive is de stand van nu.
    -- Van een afgesloten jaar alleen de verdeling die toen is vastgelegd.
    'fiscalYearId', v_fy.id,
    'fiscalYearClosed', coalesce(v_fy.status = 'closed', false),
    'splitFixed', v_fy.id is not null and exists (
      select 1 from public.fiscal_year_partner_shares s
      where s.organization_id = p_organization_id and s.fiscal_year_id = v_fy.id),
    'partners', case when v_partnership_form then coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', pp.id, 'name', pp.name, 'partnerNumber', pp.partner_number,
               'kind', coalesce(sp.kind, pp.kind),
               'isActive', sp.partner_id is not null,
               'currentlyActive', pp.is_active,
               'shareBasisPoints', coalesce(sp.share_basis_points, pp.profit_share_basis_points),
               'priorShareCents', coalesce(sp.prior_share_cents, 0),
               -- Bij een afgesloten jaar: wat er is geboekt. De raming neemt
               -- dat over in plaats van opnieuw te rekenen.
               'bookedShareCents', case when v_fy.status = 'closed' then sp.booked_share_cents end
             ) order by pp.partner_number)
      from public.partnership_partners pp
      left join (
        -- GEWIJZIGD (20261124120000): een open jaar met zijn perioden; een
        -- afgesloten jaar met wat er toen is geboekt (vastgelegd of als
        -- momentopname van de automatische verdeling).
        select x.partner_id, x.kind, x.share_basis_points, x.prior_share_cents, x.booked_share_cents
        from public.fiscal_year_partner_split(p_organization_id, v_fy.id) x
        where v_fy.id is not null and v_fy.status <> 'closed'
        union all
        select fps.partner_id, fps.kind, fps.share_basis_points, fps.prior_share_cents, fps.share_cents
        from public.fiscal_year_partner_shares fps
        where v_fy.id is not null and v_fy.status = 'closed'
          and fps.organization_id = p_organization_id and fps.fiscal_year_id = v_fy.id
        union all
        -- Zonder boekjaar in dit kalenderjaar: de actieve vennoten van nu.
        select pp2.id, pp2.kind, pp2.profit_share_basis_points, 0::bigint, null::bigint
        from public.partnership_partners pp2
        where v_fy.id is null and pp2.organization_id = p_organization_id and pp2.is_active
      ) sp on sp.partner_id = pp.id
      where pp.organization_id = p_organization_id
    ), '[]'::jsonb) else '[]'::jsonb end,
    'profiles', coalesce((
      select jsonb_agg(jsonb_build_object(
               'partnerId', p.partner_id,
               'meetsHoursCriterion', p.meets_hours_criterion,
               'starter', p.starter,
               'aowStatus', p.aow_status,
               'aowMonth', p.aow_month,
               'lossCarryForwardCents', p.loss_carry_forward_cents,
               'otherEntrepreneurDeductionCents', p.other_entrepreneur_deduction_cents,
               'provisionalIncomeTaxCents', p.provisional_income_tax_cents,
               'provisionalZvwCents', p.provisional_zvw_cents,
               'updatedAt', p.updated_at
             ) order by p.created_at)
      from public.income_tax_profiles p
      where p.organization_id = p_organization_id and p.year = p_year
    ), '[]'::jsonb),
    'corrections', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'partnerId', c.partner_id, 'code', c.code,
               'label', c.label, 'amountCents', c.amount_cents
             ) order by c.created_at, c.id)
      from public.income_tax_corrections c
      where c.organization_id = p_organization_id and c.year = p_year
    ), '[]'::jsonb),
    'investments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'assetId', fa.id, 'name', fa.name, 'assetNumber', fa.asset_number,
               'acquisitionDate', fa.acquisition_date, 'costCents', fa.acquisition_cost_cents,
               'excluded', exists (
                 select 1 from public.income_tax_kia_exclusions x
                 where x.organization_id = p_organization_id and x.asset_id = fa.id)
             ) order by fa.acquisition_date, fa.asset_number, fa.id)
      from public.fixed_assets fa
      where fa.organization_id = p_organization_id
        and fa.acquisition_date between v_start and v_end
    ), '[]'::jsonb),
    'myMinutes', v_minutes,
    'ownerMinutes', v_owner_minutes,
    'partnerMinutes', v_partner_minutes,
    -- TOEGEVOEGD (20261122100000): de eerste dag met uren, voor de prognose.
    'ownerFirstHourDate', v_owner_first,
    'partnerFirstHourDates', v_partner_first,
    -- TOEGEVOEGD (20261124120000): hoe de jaarafsluiting het resultaat verdeelt,
    -- zodat de raming (splitYearResult in src/lib/inkomstenbelasting.ts) precies
    -- hetzelfde rekent: de perioden met hun geboekte resultaat en wie erin
    -- meedoet, de periode waarin een prognose het verschil krijgt (die van
    -- vandaag), en de verliesgrens per commanditaire vennoot.
    'partnerSplit', case when v_partnership_form and v_fy.id is not null and v_fy.status <> 'closed' then jsonb_build_object(
      'mode', case when exists (select 1 from public.fiscal_year_partner_shares fps
                                where fps.organization_id = p_organization_id and fps.fiscal_year_id = v_fy.id
                                  and fps.source = 'vastgelegd') then 'vastgelegd' else 'automatisch' end,
      'targetPeriod', coalesce((
        select count(*) - 1 from public.fiscal_year_period_bounds(p_organization_id, v_fy.id) b
        where b.period_start <= least(greatest((now() at time zone 'Europe/Amsterdam')::date, v_fy.period_start), v_fy.period_end)), 0),
      'periods', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'start', b.period_start, 'end', b.period_end,
                 'resultCents', (
                   select coalesce(sum(jl.credit_cents - jl.debit_cents), 0)::bigint
                   from public.journal_lines jl
                   join public.journal_entries je on je.id = jl.entry_id
                   join public.ledger_accounts la on la.id = jl.account_id
                   where jl.organization_id = p_organization_id and je.status = 'posted' and je.source_type <> 'year_close'
                     and je.date between b.period_start and b.period_end and la.type in ('revenue', 'expense')),
                 'shares', coalesce((
                   select jsonb_agg(jsonb_build_object(
                            'partnerId', p.partner_id, 'partnerNumber', p.partner_number, 'kind', p.kind,
                            'basisPoints', p.share_basis_points, 'priorCents', p.prior_share_cents) order by p.partner_number)
                   from public.fiscal_year_partners_on(p_organization_id, v_fy.id, b.period_start) p), '[]'::jsonb)
               ) order by b.period_no)
        from public.fiscal_year_period_bounds(p_organization_id, v_fy.id) b), '[]'::jsonb),
      'lossCaps', coalesce((
        select jsonb_object_agg(pp.id, greatest(0, (
                 select coalesce(sum(jl.credit_cents - jl.debit_cents), 0)
                 from public.journal_lines jl
                 join public.journal_entries je on je.id = jl.entry_id
                 where jl.organization_id = p_organization_id and je.status = 'posted'
                   and je.date <= v_fy.period_end
                   and not (je.source_type = 'year_close' and je.source_id = v_fy.id)
                   and jl.account_id in (pp.capital_account_id, pp.withdrawals_account_id, pp.contributions_account_id)))::bigint)
        from public.partnership_partners pp
        where pp.organization_id = p_organization_id
          and exists (select 1 from public.fiscal_year_partner_periods(p_organization_id, v_fy.id) x
                      where x.partner_id = pp.id and x.kind = 'commanditair')), '{}'::jsonb)
    ) end
  );
end;
$function$;
revoke all on function public.get_income_tax_inputs(uuid, integer, boolean) from public, anon;
grant execute on function public.get_income_tax_inputs(uuid, integer, boolean) to authenticated, service_role;
