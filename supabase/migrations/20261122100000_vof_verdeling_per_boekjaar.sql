-- Vof, maatschap en cv: de verdeling over de vennoten en de rechtsvorm horen
-- bij een boekjaar, niet bij vandaag.
--
-- Waarom: de jaarafsluiting, de kapitaalvergelijking en de raming van de
-- inkomstenbelasting lazen alle drie de vennoten, hun percentages en de
-- rechtsvorm van het moment van kijken. De controle van 22 november 2026
-- (docs/changelog/CHANGELOG_VOF_HERSTELWEGEN_2026-11-22.md) speelde na:
--   - 2025 met Anna en Bram 50/50, Bram treedt in februari 2026 uit, 2025
--     wordt in april afgesloten: de melding stuurde naar "pas de verdeling
--     aan", en wie dat deed gaf Anna de hele winst en Bram niets;
--   - Chris treedt in januari toe: hij kreeg winst over 2025;
--   - 2025 netjes afgesloten op 60/40, per 2026 70/30: het overzicht van 2025
--     toonde daarna 70/30, de raming ook, en heropenen en opnieuw afsluiten
--     boekte 70/30. Het eind van 2025 was niet meer het begin van 2026;
--   - na de overstap van vof naar eenmanszaak sloot het vof-jaar 2025 af als
--     eenmanszaak (alles naar 0500, Bram niets), en de raming van 2025 rekende
--     met één ondernemer;
--   - een arbeidsbeloning vóór de verdeling kon alleen als memoriaal, en dat
--     kwam in de kapitaalvergelijking onder "overig" en nergens in het
--     winstaandeel dat elke vennoot aangeeft.
--
-- Nu:
--   - fiscal_years.legal_form: de rechtsvorm van dat boekjaar. Een nieuw
--     boekjaar krijgt die van de organisatie; wisselt de rechtsvorm, dan
--     volgen alleen de open boekjaren die nog niet voorbij zijn.
--   - fiscal_year_partner_shares: de verdeling van een boekjaar, per vennoot
--     een percentage en een voorafgaand bedrag (arbeidsbeloning, rente over
--     het kapitaal). Zonder vastgelegde verdeling geldt die van de actieve
--     vennoten, zoals altijd; bij het afsluiten wordt die vastgelegd, met het
--     geboekte bedrag. Heropenen en opnieuw afsluiten gebruikt hem dus weer.
--   - De jaarafsluiting weigert zolang de vennoten of hun verdeling ná het
--     einde van het boekjaar zijn gewijzigd en er voor dat jaar nog niets is
--     vastgelegd.
--   - Het overzicht en de raming lezen voor een afgesloten jaar het geboekte
--     bedrag per vennoot.
--
-- Veilig om opnieuw te draaien.

-- ── 1. De rechtsvorm per boekjaar ───────────────────────────────────────

alter table public.fiscal_years add column if not exists legal_form text;
alter table public.fiscal_years drop constraint if exists fiscal_years_legal_form_check;
alter table public.fiscal_years add constraint fiscal_years_legal_form_check
  check (legal_form is null or legal_form in
    ('eenmanszaak', 'vof', 'maatschap', 'cv', 'bv', 'nv', 'cooperatie', 'stichting', 'vereniging'));

-- Voor de samengestelde sleutel van de verdeling: een verdeling hoort altijd
-- bij een boekjaar van dezelfde organisatie (harde regel 1).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'fiscal_years_org_id_key' and conrelid = 'public.fiscal_years'::regclass
  ) then
    alter table public.fiscal_years add constraint fiscal_years_org_id_key unique (organization_id, id);
  end if;
end $$;

-- Een nieuw boekjaar krijgt de rechtsvorm van de organisatie.
create or replace function public.fiscal_years_default_legal_form()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.legal_form is null then
    new.legal_form := public.org_legal_form(new.organization_id);
  end if;
  return new;
end;
$$;
revoke all on function public.fiscal_years_default_legal_form() from public, anon, authenticated;

drop trigger if exists fiscal_years_default_legal_form on public.fiscal_years;
create trigger fiscal_years_default_legal_form
  before insert on public.fiscal_years
  for each row execute function public.fiscal_years_default_legal_form();

-- Wisselt de rechtsvorm, dan volgen de open boekjaren die nog niet voorbij
-- zijn. Een vorig jaar dat nog open staat (de aangifte doe je in het
-- voorjaar), houdt de rechtsvorm die het had: wie per 1 januari van vof naar
-- eenmanszaak ging, sloot 2025 anders af als eenmanszaak, en Bram kreeg niets.
-- Was de oude instelling gewoon fout, dan zet je het jaar zelf om
-- (set_fiscal_year_legal_form, in het afsluitvenster).
create or replace function public.company_settings_legal_form_to_years()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.legal_form is distinct from old.legal_form then
    -- Een jaar waarvoor de verdeling over de vennoten al is vastgelegd, gaat
    -- niet stil mee naar een rechtsvorm zonder vennoten: wie in december
    -- "per 1 januari" overstapt, sloot het lopende jaar anders af als
    -- eenmanszaak. Dat jaar zet je zelf om (set_fiscal_year_legal_form).
    update public.fiscal_years fy
    set legal_form = new.legal_form
    where fy.organization_id = new.organization_id
      and fy.status = 'open'
      and fy.period_end >= (now() at time zone 'Europe/Amsterdam')::date
      and fy.legal_form is distinct from new.legal_form
      and not (new.legal_form not in ('vof', 'maatschap', 'cv')
               and exists (select 1 from public.fiscal_year_partner_shares s
                           where s.organization_id = fy.organization_id and s.fiscal_year_id = fy.id));
  end if;
  return new;
end;
$$;
revoke all on function public.company_settings_legal_form_to_years() from public, anon, authenticated;

drop trigger if exists company_settings_legal_form_to_years on public.company_settings;
create trigger company_settings_legal_form_to_years
  after update of legal_form on public.company_settings
  for each row execute function public.company_settings_legal_form_to_years();

-- Bestaande boekjaren: de rechtsvorm van nu. Een afgesloten jaar waarvan de
-- winst naar de vennoten ging, was een vof, maatschap of cv; staat de
-- organisatie nu anders, dan "vof".
alter table public.fiscal_years disable trigger fiscal_years_audit;
update public.fiscal_years fy
set legal_form = case
    when fy.status = 'closed' and fy.result_account_code = 'vennoten'
         and public.org_legal_form(fy.organization_id) not in ('vof', 'maatschap', 'cv') then 'vof'
    else public.org_legal_form(fy.organization_id)
  end
where fy.legal_form is null;
alter table public.fiscal_years enable trigger fiscal_years_audit;

/** De rechtsvorm van een boekjaar (intern). */
create or replace function public.fiscal_year_legal_form(p_organization_id uuid, p_fiscal_year_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select fy.legal_form from public.fiscal_years fy
     where fy.id = p_fiscal_year_id and fy.organization_id = p_organization_id),
    public.org_legal_form(p_organization_id)
  );
$$;
revoke all on function public.fiscal_year_legal_form(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fiscal_year_legal_form(uuid, uuid) to service_role;

-- ── 2. Wanneer de verdeling van een vennoot veranderde ──────────────────

-- Om te zien of de vennoten na het einde van een boekjaar zijn gewijzigd:
-- percentage, actief/uitgetreden of soort. Een naam of een gekoppeld teamlid
-- telt niet.
alter table public.partnership_partners add column if not exists share_changed_at timestamptz;

create or replace function public.partnership_partners_track_share_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.share_changed_at := coalesce(new.share_changed_at, now());
  elsif new.profit_share_basis_points is distinct from old.profit_share_basis_points
     or new.is_active is distinct from old.is_active
     or new.kind is distinct from old.kind then
    new.share_changed_at := now();
  else
    new.share_changed_at := old.share_changed_at;
  end if;
  return new;
end;
$$;
revoke all on function public.partnership_partners_track_share_change() from public, anon, authenticated;

-- Eerst de bestaande vennoten (hieronder), dan de trigger: hij zet een
-- update zonder echte wijziging terug op de oude waarde, en die was hier nog
-- leeg. Zo deed de backfill eerst niets, en sloot een vorig jaar met een
-- vennoot die al was uitgetreden toch zonder weigering af.
drop trigger if exists partnership_partners_track_share_change on public.partnership_partners;

-- Bestaande vennoten: de laatste wijziging van percentage, actief of soort
-- uit het auditlog, anders het moment van vastleggen. Zonder auditregel per
-- vennoot: dit is geen wijziging door iemand.
alter table public.partnership_partners disable trigger partnership_partners_audit;
update public.partnership_partners pp
set share_changed_at = coalesce((
    select max(al.created_at)
    from public.audit_logs al
    where al.organization_id = pp.organization_id
      and al.entity_type = 'partnership_partner'
      and al.entity_id = pp.id
      and al.action = 'updated'
      and (al.metadata -> 'changed_columns') ?| array['profit_share_basis_points', 'is_active', 'kind']
  ), pp.created_at)
where pp.share_changed_at is null;
alter table public.partnership_partners enable trigger partnership_partners_audit;

create trigger partnership_partners_track_share_change
  before insert or update on public.partnership_partners
  for each row execute function public.partnership_partners_track_share_change();

-- ── 3. De verdeling per boekjaar ────────────────────────────────────────

create table if not exists public.fiscal_year_partner_shares (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  fiscal_year_id uuid not null,
  partner_id uuid not null,
  share_basis_points integer not null check (share_basis_points between 0 and 10000),
  -- Vóór de verdeling naar rato: arbeidsbeloning en rente over het kapitaal.
  -- Geen kosten maar winstverdeling: het telt in het winstaandeel van de
  -- vennoot. Het restant (resultaat min alle voorafgaande bedragen) gaat naar
  -- rato.
  prior_share_cents bigint not null default 0
    check (prior_share_cents between -100000000000 and 100000000000),
  kind text not null default 'beherend' check (kind in ('beherend', 'commanditair')),
  -- Het bedrag dat bij de jaarafsluiting op zijn kapitaal is geboekt. Leeg
  -- zolang het jaar open is.
  share_cents bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid() references auth.users(id) on delete set null,
  constraint fiscal_year_partner_shares_year_fkey
    foreign key (organization_id, fiscal_year_id) references public.fiscal_years(organization_id, id) on delete cascade,
  constraint fiscal_year_partner_shares_partner_fkey
    foreign key (organization_id, partner_id) references public.partnership_partners(organization_id, id) on delete cascade,
  constraint fiscal_year_partner_shares_year_partner_key unique (fiscal_year_id, partner_id)
);
create index if not exists idx_fiscal_year_partner_shares_org
  on public.fiscal_year_partner_shares (organization_id, fiscal_year_id);
create index if not exists idx_fiscal_year_partner_shares_partner
  on public.fiscal_year_partner_shares (organization_id, partner_id);

alter table public.fiscal_year_partner_shares enable row level security;
-- Lezen met leesrecht op Financiën; schrijven alleen via de functies hieronder.
revoke all on table public.fiscal_year_partner_shares from public, anon, authenticated;
grant select on table public.fiscal_year_partner_shares to authenticated;
grant all on table public.fiscal_year_partner_shares to service_role;

drop policy if exists "fiscal year partner shares read" on public.fiscal_year_partner_shares;
create policy "fiscal year partner shares read" on public.fiscal_year_partner_shares
  for select using (public.can_read_org(organization_id));
-- Modulerechten (harde regel 3): lezen met Financiën, schrijven alleen met
-- schrijfrecht op Financiën, en het boekhouder-hek, zoals elke financiële tabel.
select public.apply_module_gate('fiscal_year_partner_shares', 'finance');

drop trigger if exists fiscal_year_partner_shares_touch_updated_at on public.fiscal_year_partner_shares;
create trigger fiscal_year_partner_shares_touch_updated_at
  before update on public.fiscal_year_partner_shares
  for each row execute function public.bookkeeping_touch_updated_at();
drop trigger if exists fiscal_year_partner_shares_audit on public.fiscal_year_partner_shares;
create trigger fiscal_year_partner_shares_audit
  after insert or delete or update on public.fiscal_year_partner_shares
  for each row execute function public.audit_row_change('fiscal_year_partner_share', 'partner_id');

-- Het auditlog zet de verdeling onder Financiën.
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
    -- GEWIJZIGD (20261122100000): fiscal_year_partner_share erbij.
    when p_entity_type in ('annual_account', 'annual_account_filing', 'annual_account_signature', 'bank_account', 'bank_rule',
                           'bank_transaction', 'company_settings', 'contract', 'contract_note', 'contract_project', 'contract_template',
                           'corporate_tax_return', 'credit_note', 'dividend_distribution', 'fiscal_year', 'fiscal_year_partner_share',
                           'fiscal_year_size_input', 'fixed_asset', 'income_tax_correction', 'income_tax_profile', 'invoice',
                           'journal_entry', 'ledger_account', 'partnership_partner', 'prepaid_expense', 'purchase_invoice', 'quote',
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
revoke all on function public.audit_entity_module(text) from public, anon;
grant execute on function public.audit_entity_module(text) to authenticated, service_role;

-- Afgesloten jaren waarvan de winst naar de vennoten ging: de verdeling uit
-- het afsluitboekstuk (de regels Winstaandeel/Verliesaandeel op het kapitaal).
-- Het percentage volgt uit het bedrag; de restcent komt bij de grootste.
with booked as (
  select fy.organization_id, fy.id as fiscal_year_id, pp.id as partner_id, pp.kind, fy.result_cents,
         sum(jl.credit_cents - jl.debit_cents)::bigint as share_cents
  from public.fiscal_years fy
  join public.journal_lines jl on jl.entry_id = fy.close_journal_entry_id
  join public.partnership_partners pp
    on pp.organization_id = fy.organization_id and pp.capital_account_id = jl.account_id
  where fy.status = 'closed'
    and fy.result_account_code = 'vennoten'
    and coalesce(fy.result_cents, 0) <> 0
    and (jl.description like 'Winstaandeel %' or jl.description like 'Verliesaandeel %')
  group by fy.organization_id, fy.id, pp.id, pp.kind, fy.result_cents
), now_matches as (
  -- Geven de percentages van nu precies dezelfde bedragen (dezelfde
  -- vennoten, dezelfde centen), dan waren dat de percentages. Bij een klein
  -- resultaat is het percentage uit het bedrag niet terug te rekenen: € 1,01
  -- op 60/40 (€ 0,61 en € 0,40) gaf 60,40/39,60.
  select b.fiscal_year_id
  from booked b
  group by b.fiscal_year_id, b.organization_id, b.result_cents
  having count(*) = (
      select count(*) from public.partnership_result_shares(b.organization_id, b.result_cents) x where x.share_cents <> 0)
    and bool_and(exists (
      select 1 from public.partnership_result_shares(b.organization_id, b.result_cents) x
      where x.partner_id = b.partner_id and x.share_cents = b.share_cents))
), raw as (
  select b.*,
         round(b.share_cents * 10000.0 / b.result_cents)::int as bp_raw,
         row_number() over (partition by b.fiscal_year_id order by abs(b.share_cents) desc, b.partner_id) as rn
  from booked b
), fixed as (
  select r.*,
         case when r.fiscal_year_id in (select m.fiscal_year_id from now_matches m)
              then (select pp.profit_share_basis_points from public.partnership_partners pp where pp.id = r.partner_id)
              else r.bp_raw + case when r.rn = 1 then 10000 - sum(r.bp_raw) over (partition by r.fiscal_year_id) else 0 end
         end as bp
  from raw r
)
insert into public.fiscal_year_partner_shares
  (organization_id, fiscal_year_id, partner_id, share_basis_points, prior_share_cents, kind, share_cents, updated_by)
select f.organization_id, f.fiscal_year_id, f.partner_id, least(greatest(f.bp, 0), 10000), 0,
       case when (select fy.legal_form from public.fiscal_years fy where fy.id = f.fiscal_year_id) = 'cv' then f.kind else 'beherend' end,
       f.share_cents, null
from fixed f
on conflict (fiscal_year_id, partner_id) do nothing;

-- ── 4. De verdeling lezen en rekenen (intern) ───────────────────────────

-- De verdeling van een boekjaar: wat er voor dat jaar is vastgelegd, en
-- anders de actieve vennoten met hun percentage van nu (zoals het altijd
-- ging). Een commanditaire vennoot is dat alleen in een cv-jaar.
create or replace function public.fiscal_year_partner_split(p_organization_id uuid, p_fiscal_year_id uuid)
returns table(partner_id uuid, capital_account_id uuid, name text, partner_number smallint, kind text,
              share_basis_points integer, prior_share_cents bigint, booked_share_cents bigint,
              is_active boolean, from_year boolean)
language sql
stable
security definer
set search_path = public
as $$
  with y as (
    select s.* from public.fiscal_year_partner_shares s
    where s.organization_id = p_organization_id and s.fiscal_year_id = p_fiscal_year_id
  )
  select pp.id, pp.capital_account_id, pp.name, pp.partner_number, y.kind,
         y.share_basis_points, y.prior_share_cents, y.share_cents, pp.is_active, true
  from y
  join public.partnership_partners pp on pp.organization_id = p_organization_id and pp.id = y.partner_id
  union all
  select pp.id, pp.capital_account_id, pp.name, pp.partner_number,
         case when public.fiscal_year_legal_form(p_organization_id, p_fiscal_year_id) = 'cv' then pp.kind else 'beherend' end,
         pp.profit_share_basis_points, 0::bigint, null::bigint, pp.is_active, false
  from public.partnership_partners pp
  where pp.organization_id = p_organization_id
    and pp.is_active
    and not exists (select 1 from y)
  order by 4;
$$;
revoke all on function public.fiscal_year_partner_split(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fiscal_year_partner_split(uuid, uuid) to service_role;

-- Het winstaandeel per vennoot: eerst ieders voorafgaande bedrag, het restant
-- naar rato, tot op de cent sluitend. Dezelfde afronding als
-- partnership_result_shares (eerst ieder naar beneden, de resterende centen
-- naar de grootste resten, bij gelijke rest het laagste vennootnummer), en
-- als splitByShares in src/lib/inkomstenbelasting.ts.
create or replace function public.fiscal_year_result_shares(p_organization_id uuid, p_fiscal_year_id uuid, p_result_cents bigint)
returns table(partner_id uuid, capital_account_id uuid, name text, partner_number smallint, kind text,
              share_basis_points integer, prior_share_cents bigint, share_cents bigint)
language sql
stable
security definer
set search_path = public
as $$
  with sp as (
    select * from public.fiscal_year_partner_split(p_organization_id, p_fiscal_year_id)
  ), t as (
    select coalesce(sum(sp.prior_share_cents), 0)::bigint as prior_total,
           coalesce(sum(sp.share_basis_points), 0)::int as total_bp
    from sp
  ), s as (
    select sp.*, (p_result_cents - t.prior_total)::bigint as rest, t.total_bp,
           (abs(p_result_cents - t.prior_total) * sp.share_basis_points) / 10000 as base,
           (abs(p_result_cents - t.prior_total) * sp.share_basis_points) % 10000 as rem
    from sp cross join t
  ), r as (
    select s.*,
           row_number() over (order by s.rem desc, s.partner_number) as rn,
           abs(s.rest) - sum(s.base) over () as leftover
    from s
  )
  select r.partner_id, r.capital_account_id, r.name, r.partner_number, r.kind, r.share_basis_points, r.prior_share_cents,
         (r.prior_share_cents
           + (case when r.rest < 0 then -1 else 1 end)::bigint
             * (r.base + case when r.total_bp = 10000 and r.rn <= r.leftover then 1 else 0 end))::bigint
  from r
  order by r.partner_number;
$$;
revoke all on function public.fiscal_year_result_shares(uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.fiscal_year_result_shares(uuid, uuid, bigint) to service_role;

-- Welke vennoten zijn gewijzigd sinds de verdeling van dit boekjaar gold,
-- terwijl er voor dit jaar nog niets is vastgelegd. Dan weet ResoFly niet
-- welke verdeling gold, en weigert de jaarafsluiting.
--   - Bestonden er vennoten vóór het einde van het jaar: wie daarna is
--     toegevoegd, uittrad of een ander percentage of soort kreeg.
--   - Zijn ze allemaal pas daarna vastgelegd (je stapte over uit een ander
--     pakket): wie op een latere dag dan de eerste is toegevoegd of
--     gewijzigd. Alles op die eerste dag is het inrichten.
-- Ook als er daardoor niemand meer in de verdeling zit (iedereen
-- uitgetreden): dat sloot eerst stil af naar 0510.
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
    select pp.name, pp.partner_number,
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
      where s.organization_id = p_organization_id and s.fiscal_year_id = p_fiscal_year_id)
    and case when k.existed
             then p.made > k.period_end or p.changed > k.period_end
             else p.made > k.first_made or p.changed > k.first_made end;
$$;
revoke all on function public.fiscal_year_partner_changes(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fiscal_year_partner_changes(uuid, uuid) to service_role;

-- ── 5. De verdeling en de rechtsvorm van een boekjaar vastleggen ────────

-- p_shares: [{ "partner_id": …, "share_basis_points": 6000, "prior_share_cents": 0 }, …].
-- Een lege lijst haalt de vastgelegde verdeling weg: dan geldt weer die van
-- de actieve vennoten. Alleen voor een open boekjaar; een afgesloten jaar
-- heropen je eerst, zodat de boeking en de verdeling bij elkaar blijven.
create or replace function public.set_fiscal_year_partner_shares(p_organization_id uuid, p_fiscal_year_id uuid, p_shares jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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

  delete from public.fiscal_year_partner_shares s
  where s.organization_id = p_organization_id
    and s.fiscal_year_id = p_fiscal_year_id
    and not (s.partner_id = any (v_ids));

  for e in select * from jsonb_array_elements(p_shares) loop
    v_id := (e ->> 'partner_id')::uuid;
    select * into v_partner from public.partnership_partners pp
    where pp.id = v_id and pp.organization_id = p_organization_id;
    insert into public.fiscal_year_partner_shares
      (organization_id, fiscal_year_id, partner_id, share_basis_points, prior_share_cents, kind, share_cents, updated_by)
    values (
      p_organization_id, p_fiscal_year_id, v_id,
      (e ->> 'share_basis_points')::integer,
      coalesce((e ->> 'prior_share_cents')::bigint, 0),
      case when v_form = 'cv' then v_partner.kind else 'beherend' end,
      null, auth.uid())
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
$$;
revoke all on function public.set_fiscal_year_partner_shares(uuid, uuid, jsonb) from public, anon;
grant execute on function public.set_fiscal_year_partner_shares(uuid, uuid, jsonb) to authenticated, service_role;

-- De rechtsvorm van één open boekjaar, binnen de IB-rechtsvormen. Voor wie
-- de rechtsvorm bij Instellingen corrigeerde terwijl een vorig jaar nog open
-- stond: dat jaar volgt niet vanzelf (zie company_settings_legal_form_to_years).
create or replace function public.set_fiscal_year_legal_form(p_organization_id uuid, p_fiscal_year_id uuid, p_legal_form text)
returns public.fiscal_years
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fy public.fiscal_years;
begin
  if auth.role() <> 'service_role'
     and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor de financiën van deze organisatie.' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':fyclose'));

  select * into v_fy from public.fiscal_years
  where id = p_fiscal_year_id and organization_id = p_organization_id
  for update;
  if not found then
    raise exception 'Boekjaar niet gevonden.' using errcode = '02000';
  end if;
  if v_fy.status = 'closed' then
    raise exception 'Boekjaar % is afgesloten. Heropen het eerst als de rechtsvorm anders moet.', v_fy.label using errcode = '23514';
  end if;
  -- Tussen een IB-onderneming en een BV wisselt meer dan de verdeling
  -- (vennootschapsbelasting, aandeelhouders); dat kan hier niet.
  if public.org_fiscal_regime(p_organization_id) <> 'ib'
     or coalesce(p_legal_form, '') not in ('eenmanszaak', 'vof', 'maatschap', 'cv') then
    raise exception 'Per boekjaar kies je tussen eenmanszaak, vof, maatschap en cv.' using errcode = '23514';
  end if;

  update public.fiscal_years set legal_form = p_legal_form
  where id = v_fy.id
  returning * into v_fy;
  return v_fy;
end;
$$;
revoke all on function public.set_fiscal_year_legal_form(uuid, uuid, text) from public, anon;
grant execute on function public.set_fiscal_year_legal_form(uuid, uuid, text) to authenticated, service_role;

-- ── 6. Een vennoot verwijderen die er nooit had moeten zijn ─────────────

-- Een per ongeluk vastgelegde vennoot bleef voorgoed in elke
-- kapitaalvergelijking en keuzelijst staan, en telde mee voor het maximum van
-- negen. Alleen zonder boekingen: met boekingen zet je hem op uitgetreden.
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
  v_accounts := array[v_partner.capital_account_id, v_partner.withdrawals_account_id, v_partner.contributions_account_id];

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

-- ── 7. De jaarafsluiting: de rechtsvorm en de verdeling van dit boekjaar ──

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
  if v_fy.period_end >= current_date then
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
    select coalesce(sum(sp.share_basis_points), 0)::int into v_share_total
    from public.fiscal_year_partner_split(p_organization_id, p_fiscal_year_id) sp;
    if v_share_total <> 10000 then
      raise exception 'De winstverdeling voor boekjaar % telt op tot % procent; dat moet precies 100 procent zijn. Pas de verdeling voor dit boekjaar aan: Boekjaren → Afsluiten → Verdeling.',
        v_fy.label, replace(rtrim(to_char(v_share_total / 100.0, 'FM990.99'), '.'), '.', ',') using errcode = '23514';
    end if;

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
  if v_partnership then
    insert into public.fiscal_year_partner_shares
      (organization_id, fiscal_year_id, partner_id, share_basis_points, prior_share_cents, kind, share_cents, updated_by)
    select p_organization_id, p_fiscal_year_id, rs.partner_id, rs.share_basis_points, rs.prior_share_cents, rs.kind,
           rs.share_cents, p_created_by
    from public.fiscal_year_result_shares(p_organization_id, p_fiscal_year_id, v_result_cents) rs
    on conflict (fiscal_year_id, partner_id) do update
      set share_cents = excluded.share_cents;
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

-- ── 8. De kapitaalvergelijking: per vennoot wat er in dat jaar gold ──

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
  v_split_fixed := exists (
    select 1 from public.fiscal_year_partner_shares s
    where s.organization_id = p_organization_id and s.fiscal_year_id = p_fiscal_year_id);
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
    select coalesce(sum(sp.share_basis_points), 0)::int into v_share_total
    from public.fiscal_year_partner_split(p_organization_id, p_fiscal_year_id) sp;

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
             pp.capital_account_id, pp.withdrawals_account_id, pp.contributions_account_id,
             v_partnership and sp.partner_id is not null as in_split,
             case when v_partnership then coalesce(sp.share_basis_points, 0) else 0 end as year_bp,
             case when v_partnership then coalesce(sp.prior_share_cents, 0) else 0 end::bigint as prior_cents,
             coalesce(sp.kind, pp.kind) as year_kind,
             case when v_partnership then coalesce(
               case when v_fy.status = 'closed' then sp.booked_share_cents end,
               sh.share_cents, 0) else 0 end::bigint as share_cents
      from public.partnership_partners pp
      left join public.fiscal_year_partner_split(p_organization_id, p_fiscal_year_id) sp on sp.partner_id = pp.id
      left join public.fiscal_year_result_shares(p_organization_id, p_fiscal_year_id, v_result) sh on sh.partner_id = pp.id
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
      v_shown := r.in_split or v_begin <> 0 or v_contrib <> 0 or v_withdraw <> 0 or v_other <> 0 or r.share_cents <> 0;
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
          'beginCents', v_begin,
          'resultShareCents', r.share_cents,
          'contributionsCents', v_contrib,
          'withdrawalsCents', v_withdraw,
          'otherMovementsCents', v_other,
          'endCents', v_begin + r.share_cents + v_contrib - v_withdraw + v_other
        ));
      end if;
    end loop;

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

-- ── 9. De raming inkomstenbelasting: de verdeling van het boekjaar ──

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
        select x.* from public.fiscal_year_partner_split(p_organization_id, v_fy.id) x
        where v_fy.id is not null
          and (v_fy.status <> 'closed' or x.from_year)
        union all
        -- Zonder boekjaar in dit kalenderjaar: de actieve vennoten van nu.
        select pp2.id, pp2.capital_account_id, pp2.name, pp2.partner_number, pp2.kind,
               pp2.profit_share_basis_points, 0::bigint, null::bigint, pp2.is_active, false
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
    'partnerFirstHourDates', v_partner_first
  );
end;
$function$;

revoke all on function public.get_income_tax_inputs(uuid, integer, boolean) from public, anon;
grant execute on function public.get_income_tax_inputs(uuid, integer, boolean) to authenticated, service_role;

-- ── 10. Privé ontvangen: een creditnota terug op de rekening van een vennoot ──

CREATE OR REPLACE FUNCTION public.pay_purchase_invoice_privately(p_organization_id uuid, p_purchase_invoice_id uuid, p_partner_id uuid DEFAULT NULL::uuid, p_date date DEFAULT NULL::date, p_created_by uuid DEFAULT auth.uid())
 RETURNS journal_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_pi public.purchase_invoices;
  v_partner public.partnership_partners;
  v_open bigint;
  v_private uuid;
  v_payable uuid;
  v_who text;
  v_ref text;
  v_date date;
  v_start date;
  v_entry public.journal_entries;
begin
  if auth.role() <> 'service_role'
     and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor de financiën van deze organisatie.' using errcode = '42501';
  end if;
  -- Privé bestaat alleen bij een IB-onderneming. Betaalt bij een BV de dga een
  -- factuur, dan loopt dat via zijn rekening-courant.
  if public.org_fiscal_regime(p_organization_id) <> 'ib' then
    raise exception 'Privé betalen kan bij een eenmanszaak, vof, maatschap of cv. Bij een BV boek je een betaling door de dga op zijn rekening-courant.'
      using errcode = '23514';
  end if;

  select * into v_pi from public.purchase_invoices
  where id = p_purchase_invoice_id and organization_id = p_organization_id
  for update;
  if not found then
    raise exception 'Inkoopfactuur niet gevonden.' using errcode = '02000';
  end if;
  if v_pi.journal_entry_id is null or v_pi.status = 'cancelled' then
    raise exception 'Boek de inkoopfactuur eerst; daarna kun je hem als privé betaald vastleggen.' using errcode = '23514';
  end if;
  v_open := public.purchase_invoice_open_payable_cents(p_organization_id, p_purchase_invoice_id);
  -- GEWIJZIGD (20261122100000): ook een creditnota die de leverancier op de
  -- eigen rekening van een vennoot terugstortte (open is dan negatief). Dat
  -- kon nergens: de creditnota bleef voorgoed open, Openstaand → Crediteuren
  -- hield een bedrag dat bij geen factuur hoorde, en de creditnota bleef
  -- kandidaat bij elke bankmutatie. Het geld kwam bij de vennoot, niet bij de
  -- zaak: dat is een privé-opname van hem.
  if v_open = 0 then
    raise exception 'Op deze inkoopfactuur staat niets meer open.' using errcode = '23514';
  end if;

  if p_partner_id is not null then
    select * into v_partner from public.partnership_partners pp
    where pp.id = p_partner_id and pp.organization_id = p_organization_id;
    if not found then
      raise exception 'Vennoot niet gevonden.' using errcode = '02000';
    end if;
    v_private := case when v_open > 0 then v_partner.contributions_account_id else v_partner.withdrawals_account_id end;
    v_who := v_partner.name;
  else
    -- Bij een vof met vennoten hoort de betaling bij één vennoot: op 0560
    -- stond hij op niemand.
    if public.org_legal_form(p_organization_id) in ('vof', 'maatschap', 'cv')
       and exists (select 1 from public.partnership_partners pp where pp.organization_id = p_organization_id and pp.is_active) then
      raise exception '%', case when v_open > 0
        then 'Kies de vennoot die de factuur betaalde: het bedrag komt op zijn privé-stortingen.'
        else 'Kies de vennoot die het geld terugkreeg: het bedrag komt op zijn privé-opnamen.' end
        using errcode = '23514';
    end if;
    perform public.ensure_default_ledger_accounts(p_organization_id);
    select la.id into v_private from public.ledger_accounts la
    where la.organization_id = p_organization_id
      and la.subtype = case when v_open > 0 then 'private_contributions' else 'private_withdrawals' end
    order by la.code limit 1;
    if v_private is null then
      raise exception 'Er is geen rekening voor privé-%.', case when v_open > 0 then 'stortingen (0560)' else 'opnamen (0550)' end
        using errcode = '23514';
    end if;
    v_who := 'de ondernemer';
  end if;

  v_date := coalesce(p_date, v_pi.date);
  select cs.bookkeeping_start_date into v_start
  from public.company_settings cs where cs.organization_id = p_organization_id;
  if v_start is not null and v_date < v_start then
    raise exception 'Je boekhouding in ResoFly begint op %. Kies een betaaldatum vanaf die dag.', to_char(v_start, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;
  if v_date > (now() at time zone 'Europe/Amsterdam')::date then
    raise exception 'Een betaling ligt niet in de toekomst. Kies de dag waarop er betaald is.' using errcode = '23514';
  end if;

  select jl.account_id into v_payable
  from public.journal_lines jl
  join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_payable'
  where jl.entry_id = v_pi.journal_entry_id
  limit 1;
  v_payable := coalesce(v_payable, public.bookkeeping_account_id(p_organization_id, '1600'));

  v_ref := coalesce(nullif(btrim(v_pi.internal_number), ''), nullif(btrim(v_pi.supplier_invoice_number), ''), 'inkoopfactuur');
  -- GEWIJZIGD (20261122100000): bij een creditnota de andere kant op
  -- ("privé ontvangen"); purchase_invoice_open_payable_cents en de status
  -- tellen dit boekstuk dan als terugbetaling, net als een bankontvangst.
  if v_open > 0 then
    v_entry := public.post_journal_entry(
      p_organization_id, v_date,
      'Privé betaald door ' || v_who || ': ' || v_ref,
      'purchase_private_payment', p_purchase_invoice_id,
      jsonb_build_array(
        jsonb_build_object('account_id', v_payable, 'description', 'Privé betaald: ' || v_ref,
          'debit_cents', v_open, 'credit_cents', 0, 'supplier_id', v_pi.supplier_id),
        jsonb_build_object('account_id', v_private, 'description', 'Privé betaald: ' || v_ref,
          'debit_cents', 0, 'credit_cents', v_open)
      ),
      p_created_by
    );
  else
    v_entry := public.post_journal_entry(
      p_organization_id, v_date,
      'Privé ontvangen door ' || v_who || ': ' || v_ref,
      'purchase_private_payment', p_purchase_invoice_id,
      jsonb_build_array(
        jsonb_build_object('account_id', v_payable, 'description', 'Privé ontvangen: ' || v_ref,
          'debit_cents', 0, 'credit_cents', -v_open, 'supplier_id', v_pi.supplier_id),
        jsonb_build_object('account_id', v_private, 'description', 'Privé ontvangen: ' || v_ref,
          'debit_cents', -v_open, 'credit_cents', 0)
      ),
      p_created_by
    );
  end if;

  perform public.refresh_purchase_invoice_payment_status(p_organization_id, p_purchase_invoice_id);
  return v_entry;
end;
$function$;

revoke all on function public.pay_purchase_invoice_privately(uuid, uuid, uuid, date, uuid) from public, anon;
grant execute on function public.pay_purchase_invoice_privately(uuid, uuid, uuid, date, uuid) to authenticated, service_role;

-- ── 11. Een gebroken boekjaar: wat ResoFly niet ondersteunt, niet wat niet mag ──

CREATE OR REPLACE FUNCTION public.open_fiscal_year(p_organization_id uuid, p_period_start date, p_period_end date, p_label text DEFAULT NULL::text, p_created_by uuid DEFAULT auth.uid())
 RETURNS fiscal_years
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_fy public.fiscal_years;
  v_label text;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if p_period_end <= p_period_start then
    raise exception 'De einddatum van het boekjaar moet na de begindatum liggen.' using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261106110000): een boekjaar van vijf jaar (een tikfout in
  -- het jaartal) kon gewoon. De auditfile-export (XAF) van ResoFly verwerkt
  -- hooguit 36 maanden; een langer boekjaar is vrijwel zeker een vergissing.
  if p_period_end >= (p_period_start + interval '36 months')::date then
    raise exception 'Een boekjaar duurt in ResoFly hooguit 36 maanden. Kijk de begin- en einddatum na.' using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261118130000): bij een eenmanszaak, vof, maatschap of cv
  -- valt een boekjaar in één kalenderjaar.
  if public.org_fiscal_regime(p_organization_id) = 'ib'
     and extract(year from p_period_start) <> extract(year from p_period_end) then
    -- GEWIJZIGD (20261122100000): alleen de tekst. "Kan alleen bij een BV"
    -- klopte niet: de wet laat een gebroken boekjaar bij een IB-onderneming
    -- toe (art. 3.66 Wet IB 2001; de winst telt dan in het kalenderjaar waarin
    -- het boekjaar eindigt). ResoFly ondersteunt het bij deze rechtsvormen
    -- niet, en dat zegt de melding nu.
    raise exception 'Bij een eenmanszaak, vof, maatschap of cv valt een boekjaar in ResoFly in één kalenderjaar: het begint en eindigt in hetzelfde jaar, meestal 1 januari t/m 31 december. De inkomstenbelasting rekent per kalenderjaar; een gebroken boekjaar ondersteunt ResoFly bij deze rechtsvormen niet. Een eerste of laatste boekjaar dat korter is, kan wel.'
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261106110000): eerst de grendel, dan de overlapcontrole.
  -- Twee verzoeken tegelijk (twee tabbladen) zagen elkaars boekjaar nog niet
  -- en konden zo twee overlappende boekjaren maken.
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':boekjaren'));
  if exists (
    select 1 from public.fiscal_years f
    where f.organization_id = p_organization_id
      and daterange(f.period_start, f.period_end, '[]') && daterange(p_period_start, p_period_end, '[]')
  ) then
    raise exception 'Dit boekjaar overlapt met een bestaand boekjaar.' using errcode = '23514';
  end if;

  v_label := coalesce(nullif(btrim(p_label), ''),
    case when extract(year from p_period_start) = extract(year from p_period_end)
         then extract(year from p_period_start)::text
         else extract(year from p_period_start)::text || '/' || extract(year from p_period_end)::text end);

  insert into public.fiscal_years(organization_id, created_by, label, period_start, period_end, status)
  values (p_organization_id, p_created_by, v_label, p_period_start, p_period_end, 'open')
  returning * into v_fy;

  return v_fy;
end;
$function$;
revoke all on function public.open_fiscal_year(uuid, date, date, text, uuid) from public, anon;
grant execute on function public.open_fiscal_year(uuid, date, date, text, uuid) to authenticated, service_role;
