-- ============================================================================
-- Het boekjaar van een nieuw kalenderjaar opent vanzelf bij de eerste boeking
-- ============================================================================
-- Een eenmanszaak die in 2026 is ingericht, heeft alleen boekjaar 2026:
-- `open_initial_fiscal_years` is er voor de eerste keer. In januari 2027 boekte
-- alles gewoon door (geen boekingsfunctie eist een boekjaar), maar Eigen
-- vermogen kende 2027 niet: geen kapitaalvergelijking en geen blok "voor je
-- aangifte", en nergens stond dat je een boekjaar moest openen. Gezien bij de
-- controle van de jaarwissel op 22 november 2026.
--
-- Bij een eenmanszaak, vof, maatschap of cv valt er niets te kiezen: het
-- boekjaar is het kalenderjaar (`open_fiscal_year` weigert iets anders). Dus
-- opent de database het zelf, op het moment dat het nodig is: bij de eerste
-- geboekte journaalpost in dat jaar. Dat werkt voor elke weg naar het
-- grootboek (scherm, Mollie, bank, Gerrie na goedkeuring, de API) en vraagt
-- niemand om eraan te denken.
--
-- Bewust smal gehouden:
-- - alleen als het boekjaar van het jaar ervóór bestaat en op 31 december
--   eindigt. Een organisatie zonder boekjaren krijgt er zo geen, en een
--   boeking van vóór het eerste boekjaar opent niets;
-- - alleen tot en met het lopende jaar (Nederlandse datum). Een tikfout in
--   het jaartal van een boeking opent geen boekjaar 2062;
-- - niet bij een BV, NV, stichting of vereniging: die kan een gebroken
--   boekjaar hebben, dus daar kiest een mens;
-- - lukt het openen niet, dan gaat de boeking gewoon door. Een boekjaar dat
--   ontbreekt is een ongemak; een Mollie-betaling die niet boekt een fout.
--
-- De app toont daarnaast op Eigen vermogen een knop voor wie in het nieuwe
-- jaar nog niets geboekt heeft.
--
-- Veilig om opnieuw te draaien.

create or replace function public.open_fiscal_year_on_first_entry()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_year integer;
  v_today date := (now() at time zone 'Europe/Amsterdam')::date;
begin
  if new.status is distinct from 'posted' or new.date is null then
    return new;
  end if;
  v_year := extract(year from new.date)::int;
  if v_year > extract(year from v_today)::int then
    return new;
  end if;
  -- De gewone boeking: het jaar heeft al een boekjaar. Eén indexzoekactie.
  if exists (
    select 1 from public.fiscal_years f
    where f.organization_id = new.organization_id
      and new.date between f.period_start and f.period_end
  ) then
    return new;
  end if;

  begin
    if public.org_fiscal_regime(new.organization_id) <> 'ib' then
      return new;
    end if;
    -- Dezelfde grendel als open_fiscal_year: twee boekingen tegelijk mogen
    -- niet allebei het boekjaar aanmaken.
    perform pg_advisory_xact_lock(hashtext(new.organization_id::text || ':boekjaren'));
    if exists (
         select 1 from public.fiscal_years f
         where f.organization_id = new.organization_id
           and f.period_end = make_date(v_year - 1, 12, 31)
       )
       and not exists (
         select 1 from public.fiscal_years f
         where f.organization_id = new.organization_id
           and daterange(f.period_start, f.period_end, '[]') && daterange(make_date(v_year, 1, 1), make_date(v_year, 12, 31), '[]')
       ) then
      insert into public.fiscal_years(organization_id, created_by, label, period_start, period_end, status)
      values (new.organization_id, new.created_by, v_year::text, make_date(v_year, 1, 1), make_date(v_year, 12, 31), 'open');
    end if;
  exception when others then
    -- De boeking gaat voor. Het boekjaar kan daarna met de knop.
    raise warning 'Boekjaar % voor organisatie % kon niet vanzelf openen: %', v_year, new.organization_id, sqlerrm;
  end;
  return new;
end;
$function$;

revoke all on function public.open_fiscal_year_on_first_entry() from public, anon, authenticated;

drop trigger if exists journal_entries_open_fiscal_year on public.journal_entries;
create trigger journal_entries_open_fiscal_year
  after insert or update of status, date on public.journal_entries
  for each row
  when (new.status = 'posted')
  execute function public.open_fiscal_year_on_first_entry();

-- Wat er al staat: een organisatie die nu al boekingen heeft in een jaar na
-- haar laatste boekjaar, krijgt dat boekjaar alsnog. Zelfde voorwaarden als de
-- trigger, jaar voor jaar (2025 → 2026, en daarna pas 2027). Een tweede keer
-- draaien vindt niets meer.
do $$
declare
  r record;
  v_this_year integer := extract(year from (now() at time zone 'Europe/Amsterdam')::date)::int;
  v_round integer := 0;
  v_found boolean;
begin
  loop
    v_found := false;
    v_round := v_round + 1;
    for r in
      select distinct f.organization_id, extract(year from f.period_end)::int + 1 as jaar
      from public.fiscal_years f
      where f.period_end = make_date(extract(year from f.period_end)::int, 12, 31)
        and extract(year from f.period_end)::int + 1 <= v_this_year
        and public.org_fiscal_regime(f.organization_id) = 'ib'
        and not exists (
          select 1 from public.fiscal_years g
          where g.organization_id = f.organization_id
            and daterange(g.period_start, g.period_end, '[]')
                && daterange(make_date(extract(year from f.period_end)::int + 1, 1, 1), make_date(extract(year from f.period_end)::int + 1, 12, 31), '[]')
        )
        and exists (
          select 1 from public.journal_entries je
          where je.organization_id = f.organization_id
            and je.status = 'posted'
            and je.date between make_date(extract(year from f.period_end)::int + 1, 1, 1) and make_date(extract(year from f.period_end)::int + 1, 12, 31)
        )
    loop
      insert into public.fiscal_years(organization_id, created_by, label, period_start, period_end, status)
      values (r.organization_id, null, r.jaar::text, make_date(r.jaar, 1, 1), make_date(r.jaar, 12, 31), 'open');
      v_found := true;
    end loop;
    exit when not v_found or v_round >= 5;
  end loop;
end;
$$;
