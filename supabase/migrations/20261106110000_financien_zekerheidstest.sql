-- ============================================================
-- Zekerheidstest financiën (6 november 2026): wat een gebruiker (met opzet of
-- per ongeluk, ook via de API) in de boeken kon krijgen en niet hoort.
--
-- De test (aanvallen op tabellen en geldfuncties, als eigenaar en als
-- buitenstaander) liet bijna alles netjes weigeren. Vier gaten:
--
-- 1. Btw-tarief zonder grens. Een factuurregel met 150% of -21% btw werd
--    geboekt (1510 en de aangifte), een inkoopregel met 150% gaf 150%
--    voorbelasting terug, en een eigen btw-code mocht elk tarief hebben.
--    Nu: tussen 0 en 30% (het hoogste tarief in de EU is 27%).
-- 2. Een boekjaar van vijf jaar (een tikfout in het jaartal) kon. Nu hooguit
--    36 maanden: meer verwerkt de auditfile-export (XAF) van ResoFly niet.
-- 3. Een handmatige journaalpost op een onmogelijke datum: ver in de toekomst
--    (2205 in plaats van 2025) of vóór de start van de boekhouding in
--    ResoFly. Nu geweigerd, met uitleg. Automatische boekingen (facturen,
--    bank, afschrijvingen) gaan zoals altijd.
-- 4. Een inkoopregel met een bedrag dat geen hele centen is (of geen getal)
--    werd opgeslagen en liep pas bij het boeken vast. Nu meteen een melding.
-- 5. Gelijktijdig: create_opening_balance en open_fiscal_year controleerden
--    eerst en boekten dan, zonder grendel. Twee klikken (of tabbladen) tegelijk
--    konden zo twee beginbalansen of overlappende boekjaren maken. Nu eerst een
--    grendel per organisatie. De andere boekfuncties vergrendelen de rij al.
--
-- Bestaande gegevens op staging vallen hier ruim binnen (btw 0, 9, 20,99 en
-- 21; boekjaren van 12 maanden; geen boekingen vóór de start of ver vooruit).
-- Veilig opnieuw te draaien: create or replace, en de check wordt vervangen.
-- ============================================================

begin;

-- 1a. Factuurregels: het btw-tarief tussen 0 en 30%.
CREATE OR REPLACE FUNCTION public.enforce_invoice_lines_numeric()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_bad text;
  v_rate numeric;
begin
  if tg_op = 'UPDATE' and new.lines is not distinct from old.lines then return new; end if;
  if new.lines is null then return new; end if;
  if jsonb_typeof(new.lines) <> 'array' then
    raise exception 'Factuurregels moeten een lijst zijn.' using errcode = '22023';
  end if;
  select coalesce(nullif(btrim(l->>'description'), ''), '(zonder omschrijving)') into v_bad
    from jsonb_array_elements(new.lines) l
   where exists (
     select 1
       from (values (l->'quantity'), (l->'unit_price'), (l->'vat')) as v(x)
      where x is not null
        and jsonb_typeof(x) not in ('null', 'number')
        and not (jsonb_typeof(x) = 'string' and (x #>> '{}' = '' or x #>> '{}' ~ '^-?[0-9]+(\.[0-9]+)?$'))
   )
   limit 1;
  if v_bad is not null then
    raise exception 'Regel "%" heeft een aantal, prijs of btw-tarief dat geen getal is. Gebruik cijfers, met een punt als decimaalteken.', left(v_bad, 80)
      using errcode = '22023';
  end if;
  -- TOEGEVOEGD (20261106110000): een btw-tarief van 150% of -21% ging zo het
  -- grootboek in (1510 en de aangifte). Het hoogste tarief in de EU is 27%.
  select coalesce(nullif(btrim(l->>'description'), ''), '(zonder omschrijving)'), (l->>'vat')::numeric
    into v_bad, v_rate
    from jsonb_array_elements(new.lines) l
   where nullif(l->>'vat', '') is not null
     and ((l->>'vat')::numeric < 0 or (l->>'vat')::numeric > 30)
   limit 1;
  if v_bad is not null then
    -- Het procentteken gaat mee in de waarde: in een RAISE-tekst is %% een
    -- letterlijk procentteken en % de plek voor een waarde.
    raise exception 'Regel "%" heeft een btw-tarief van %. Een btw-tarief ligt tussen 0 en 30%% (het hoogste in de EU is 27%%).', left(v_bad, 80), trim_scale(v_rate)::text || '%'
      using errcode = '22023';
  end if;
  return new;
end;
$function$;

-- 1b en 4. Inkoopregels: bedrag in hele centen, tarief een getal tussen 0 en 30%.
-- book_purchase_invoice neemt het tarief van de regel vóór dat van de btw-code.
create or replace function public.enforce_purchase_invoice_lines()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_bad text;
  v_rate numeric;
begin
  if tg_op = 'UPDATE' and new.lines is not distinct from old.lines then return new; end if;
  if new.lines is null then return new; end if;
  if jsonb_typeof(new.lines) <> 'array' then
    raise exception 'De regels van een inkoopfactuur moeten een lijst zijn.' using errcode = '22023';
  end if;
  select coalesce(nullif(btrim(l->>'description'), ''), '(zonder omschrijving)') into v_bad
    from jsonb_array_elements(new.lines) l
   where jsonb_typeof(l) <> 'object'
      or (jsonb_typeof(l->'amount_cents') not in ('null', 'number')
          and not (jsonb_typeof(l->'amount_cents') = 'string' and l->>'amount_cents' ~ '^-?[0-9]+$'))
      or (jsonb_typeof(l->'amount_cents') = 'number' and (l->>'amount_cents')::numeric <> trunc((l->>'amount_cents')::numeric))
      or (jsonb_typeof(l->'vat_rate') not in ('null', 'number')
          and not (jsonb_typeof(l->'vat_rate') = 'string' and (l->>'vat_rate' = '' or l->>'vat_rate' ~ '^-?[0-9]+(\.[0-9]+)?$')))
   limit 1;
  if v_bad is not null then
    raise exception 'Inkoopregel "%" heeft een bedrag dat geen heel aantal centen is, of een btw-tarief dat geen getal is.', left(v_bad, 80)
      using errcode = '22023';
  end if;
  select coalesce(nullif(btrim(l->>'description'), ''), '(zonder omschrijving)'), (l->>'vat_rate')::numeric
    into v_bad, v_rate
    from jsonb_array_elements(new.lines) l
   where nullif(l->>'vat_rate', '') is not null
     and ((l->>'vat_rate')::numeric < 0 or (l->>'vat_rate')::numeric > 30)
   limit 1;
  if v_bad is not null then
    raise exception 'Inkoopregel "%" heeft een btw-tarief van %. Een btw-tarief ligt tussen 0 en 30%% (het hoogste in de EU is 27%%).', left(v_bad, 80), trim_scale(v_rate)::text || '%'
      using errcode = '22023';
  end if;
  return new;
end;
$function$;

drop trigger if exists purchase_invoices_lines_valid on public.purchase_invoices;
create trigger purchase_invoices_lines_valid
  before insert or update of lines on public.purchase_invoices
  for each row execute function public.enforce_purchase_invoice_lines();

-- 1c. Btw-codes: het tarief tussen 0 en 30%.
alter table public.vat_codes drop constraint if exists vat_codes_rate_range;
alter table public.vat_codes add constraint vat_codes_rate_range check (rate >= 0 and rate <= 30);

-- 2. open_fiscal_year — gebaseerd op de versie van staging; nieuw: hooguit 36 maanden.
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

-- 3. post_journal_entry — gebaseerd op de versie van 20261104000000 (zoals op
-- staging); nieuw: een boekdatum is verplicht, en een handmatige boeking door
-- een gebruiker valt niet vóór de start van de boekhouding en niet meer dan
-- een jaar vooruit.
CREATE OR REPLACE FUNCTION public.post_journal_entry(p_organization_id uuid, p_date date, p_description text, p_source_type text, p_source_id uuid, p_lines jsonb, p_created_by uuid DEFAULT auth.uid())
 RETURNS journal_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_entry public.journal_entries;
  v_year integer := extract(year from p_date)::int;
  v_quarter smallint := extract(quarter from p_date)::smallint;
  v_month smallint := extract(month from p_date)::smallint;
  v_seq bigint;
  v_number text;
  v_line jsonb;
  v_idx integer := 0;
  v_account uuid;
  v_debit bigint;
  v_credit bigint;
  v_total_debit bigint := 0;
  v_total_credit bigint := 0;
  v_diff bigint;
  v_count integer;
  v_tolerance bigint;
  v_alien_code text;
  v_locked_through date;
  v_start_date date;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Een journaalpost heeft minimaal één boekingsregel nodig.' using errcode = '23514';
  end if;

  -- De vrijgestelde soorten (jaarafsluiting, Vpb, dga-rente) mogen in een
  -- afgesloten periode boeken. Alleen de functies die ze maken, zetten de vlag
  -- resofly.trusted_journal_source (voor de rest van de transactie); een
  -- rechtstreekse aanroep met p_source_type => 'dga_interest' boekte anders
  -- in elke gesloten btw-periode of elk afgesloten boekjaar.
  if coalesce(p_source_type, 'manual') in ('year_close', 'corporate_tax', 'dga_interest')
     and auth.role() <> 'service_role'
     and coalesce(current_setting('resofly.trusted_journal_source', true), '') <> p_source_type then
    raise exception 'Dit soort boeking maakt alleen de jaarafsluiting, de Vpb-aangifte of de dga-renteboeking zelf.'
      using errcode = '42501';
  end if;

  -- TOEGEVOEGD (20261106110000): een boekdatum die niet kan. Zonder datum
  -- strandde de post op een technische fout; een handmatige boeking met een
  -- tikfout (2205 in plaats van 2025) belandde ongemerkt ver in de toekomst,
  -- buiten elk overzicht, en een datum vóór de start van de boekhouding in
  -- ResoFly schoof onder de beginbalans door.
  if p_date is null then
    raise exception 'Een journaalpost heeft een boekdatum nodig.' using errcode = '23514';
  end if;
  if coalesce(p_source_type, 'manual') = 'manual' and auth.role() <> 'service_role' then
    select cs.bookkeeping_start_date into v_start_date
    from public.company_settings cs where cs.organization_id = p_organization_id;
    if v_start_date is not null and p_date < v_start_date then
      raise exception 'Je boekhouding in ResoFly begint op %. Wat daarvoor gebeurde, zit in de beginbalans; kies een boekdatum vanaf die dag.', to_char(v_start_date, 'DD-MM-YYYY')
        using errcode = '23514';
    end if;
    if p_date > (current_date + interval '1 year')::date then
      raise exception 'Een boekdatum meer dan een jaar vooruit (%) is vast een tikfout. Kies een datum binnen een jaar.', to_char(p_date, 'DD-MM-YYYY')
        using errcode = '23514';
    end if;
  end if;

  -- Periodeslot: weiger boeken in een afgesloten aangifteperiode (maand/kwartaal/jaar).
  -- Uitzondering: het jaarafsluit-boekstuk ('year_close') zelf, dat op de laatste dag
  -- van het boekjaar valt en dus vaak binnen een reeds gesloten Q4/december-slot.
  -- GEWIJZIGD (20260807050000): 'corporate_tax' krijgt dezelfde vrijstelling.
  -- De Vpb-reservering valt per definitie op de balansdatum, en die ligt altijd
  -- in de laatste btw-periode van het boekjaar. Zonder deze uitzondering zou de
  -- reservering nooit geboekt kunnen worden zodra die aangifte is gefinaliseerd —
  -- een slot dat nooit meer opengaat. De post raakt alleen 9900 en 1540 en komt
  -- in geen enkele btw-rubriek voor, dus er valt niets te beschermen.
  -- GEWIJZIGD (20260807090000): 'dga_interest' erbij. De renteboeking valt per
  -- definitie op 31 december, en die dag ligt altijd in de laatste btw-periode
  -- van het jaar — een slot dat nooit meer opengaat. Zonder deze uitzondering
  -- kon de rente nooit geboekt worden zodra die aangifte definitief was.
  -- 'payroll' juist NIET: een loonjournaalpost in een afgesloten maand hoort
  -- wél te stuiten, want die raakt de btw-aangifte wel degelijk.
  -- GEWIJZIGD (20261104000000): één grendel per organisatie. Boekingen nemen
  -- hem gedeeld, de jaarafsluiting en het afsluiten van een btw-periode
  -- exclusief: zo glipt er geen boeking tussen het optellen en het vergrendelen.
  perform pg_advisory_xact_lock_shared(hashtext(p_organization_id::text || ':periodegrendel'));

  if coalesce(p_source_type, 'manual') not in ('year_close', 'corporate_tax', 'dga_interest') then
    -- GEWIJZIGD (20261104000000): het boekjaarslot geldt voor alles tot en met
    -- het einde van het laatst afgesloten boekjaar, ook voor datums vóór het
    -- eerste boekjaar. Afsluiten gaat op volgorde, dus de jaarsloten vormen één
    -- aaneengesloten blok.
    select max(cp.period_end) into v_locked_through
    from public.closed_periods cp
    where cp.organization_id = p_organization_id and cp.period_type = 'year';
    if v_locked_through is not null and p_date <= v_locked_through then
      raise exception 'Het boekjaar tot en met % is afgesloten; kies een boekdatum daarna.', to_char(v_locked_through, 'DD-MM-YYYY')
        using errcode = '23514';
    end if;

    -- GEWIJZIGD (20261104000000): een btw-slot houdt alleen boekingen tegen die
    -- de aangifte raken. Afschrijvingen, lonen, overlopende posten, de winst-
    -- bestemming en dividend komen in geen rubriek en horen op hun eigen datum.
    if exists (
      select 1 from public.closed_periods cp
      where cp.organization_id = p_organization_id
        and cp.period_type in ('month', 'quarter')
        and cp.period_start is not null and cp.period_end is not null
        and p_date between cp.period_start and cp.period_end
    ) and public.journal_lines_touch_vat(p_organization_id, p_lines) then
      raise exception 'De btw-aangifteperiode rond % is afgesloten; kies een boekdatum in de eerstvolgende open periode.', p_date
        using errcode = '23514';
    end if;
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':' || v_year::text));
  select count(*) + 1 into v_seq from public.journal_entries
  where organization_id = p_organization_id and year = v_year;
  v_number := 'JP-' || v_year || '-' || lpad(v_seq::text, greatest(5, length(v_seq::text)), '0');

  insert into public.journal_entries(
    organization_id, created_by, entry_number, date, year, quarter, month,
    description, source_type, source_id, status
  ) values (
    p_organization_id, p_created_by, v_number, p_date, v_year, v_quarter, v_month,
    p_description, coalesce(p_source_type, 'manual'), p_source_id, 'draft'
  ) returning * into v_entry;

  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    if (v_line ? 'account_id') and nullif(v_line->>'account_id','') is not null then
      v_account := (v_line->>'account_id')::uuid;
    else
      v_account := public.bookkeeping_account_id(p_organization_id, v_line->>'account_code');
    end if;

    v_debit := coalesce((v_line->>'debit_cents')::bigint, 0);
    v_credit := coalesce((v_line->>'credit_cents')::bigint, 0);
    v_total_debit := v_total_debit + v_debit;
    v_total_credit := v_total_credit + v_credit;

    insert into public.journal_lines(
      organization_id, entry_id, account_id, line_index, description,
      debit_cents, credit_cents, vat_code, vat_rate, vat_base_cents, vat_amount_cents,
      client_id, supplier_id, project_id
    ) values (
      p_organization_id, v_entry.id, v_account, v_idx, nullif(v_line->>'description',''),
      v_debit, v_credit,
      nullif(v_line->>'vat_code',''),
      nullif(v_line->>'vat_rate','')::numeric,
      nullif(v_line->>'vat_base_cents','')::bigint,
      nullif(v_line->>'vat_amount_cents','')::bigint,
      nullif(v_line->>'client_id','')::uuid,
      nullif(v_line->>'supplier_id','')::uuid,
      nullif(v_line->>'project_id','')::uuid
    );
    v_idx := v_idx + 1;
  end loop;

  -- Org-integriteit (FIX 6): elke regel moet op een grootboekrekening van
  -- déze organisatie boeken. Een account_id van een andere org zou de balans
  -- vervuilen met andermans rekening (cross-tenant lek in de rapportages).
  select la.code into v_alien_code
  from public.journal_lines jl
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.entry_id = v_entry.id
    and la.organization_id <> p_organization_id
  limit 1;
  if v_alien_code is not null then
    raise exception 'Grootboekrekening % hoort niet bij deze organisatie.', v_alien_code
      using errcode = '42501';
  end if;

  v_diff := v_total_debit - v_total_credit;
  v_count := v_idx;
  v_tolerance := greatest(2 * v_count, 2);

  if v_diff <> 0 then
    if abs(v_diff) <= v_tolerance then
      v_account := public.bookkeeping_account_id(p_organization_id, '4900');
      insert into public.journal_lines(
        organization_id, entry_id, account_id, line_index, description, debit_cents, credit_cents
      ) values (
        p_organization_id, v_entry.id, v_account, v_idx, 'Afrondingsverschil',
        case when v_diff < 0 then -v_diff else 0 end,
        case when v_diff > 0 then v_diff else 0 end
      );
    else
      raise exception 'Journaalpost niet in balans: debet % ≠ credit % (verschil % cent).',
        v_total_debit, v_total_credit, v_diff using errcode = '23514';
    end if;
  end if;

  update public.journal_entries
  set status = 'posted', posted_at = now(), posted_by = p_created_by
  where id = v_entry.id
  returning * into v_entry;

  return v_entry;
end;
$function$;

-- 5. create_opening_balance — de versie van staging; nieuw: een grendel per
-- organisatie vóór de controle op een bestaande beginbalans.
CREATE OR REPLACE FUNCTION public.create_opening_balance(p_organization_id uuid, p_as_of_date date, p_lines jsonb, p_created_by uuid DEFAULT auth.uid())
 RETURNS journal_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_lines jsonb;
  v_debit bigint;
  v_credit bigint;
  v_equity bigint;
  v_existing text;
  v_plug_code text;
  v_plug_label text;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Beginbalans heeft minimaal één regel nodig.' using errcode = '23514';
  end if;

  -- TOEGEVOEGD (20261106110000): eerst de grendel, dan kijken of er al een
  -- beginbalans is. Twee klikken tegelijk zagen elkaars beginbalans nog niet
  -- (die was nog niet vastgelegd) en boekten er zo twee.
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':beginbalans'));

  select coalesce(je.entry_number, je.id::text) into v_existing
  from public.journal_entries je
  where je.organization_id = p_organization_id
    and je.source_type = 'opening_balance'
    and je.status = 'posted'
    and je.reversed_by_entry_id is null
    -- GEWIJZIGD (20261104000000): de tegenboeking van een beginbalans is zelf
    -- geen beginbalans; anders kon er nooit een nieuwe komen.
    and je.reverses_entry_id is null
  limit 1;
  if v_existing is not null then
    raise exception 'Er is al een beginbalans geboekt (boekstuk %). Boek die eerst tegen voordat je een nieuwe vastlegt.', v_existing
      using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);

  -- Sluit het verschil op eigen vermogen zodat de openingsbalans in balans is.
  select coalesce(sum(coalesce((l->>'debit_cents')::bigint,0)),0),
         coalesce(sum(coalesce((l->>'credit_cents')::bigint,0)),0)
    into v_debit, v_credit
  from jsonb_array_elements(p_lines) l;

  v_lines := p_lines;
  v_equity := v_debit - v_credit;
  if v_equity <> 0 then
    -- Welke rekening de sluitpost draagt, hangt aan de rechtsvorm. Bij een
    -- kapitaalvennootschap is het meegebrachte vermogen géén gestort kapitaal —
    -- dat is precies het bedrag dat de aandeelhouder ooit heeft volgestort en
    -- dat legt de gebruiker zelf op 0500. Alles wat de onderneming daarna heeft
    -- opgebouwd hoort bij de reserves.
    -- Een ketting en geen vaste keuze: 0520 bestaat alleen ná het BV-schema, en
    -- bookkeeping_account_id werpt een fout in plaats van terug te vallen.
    if public.org_fiscal_regime(p_organization_id) = 'vpb' then
      select code into v_plug_code
      from public.ledger_accounts
      where organization_id = p_organization_id and code in ('0520', '0510', '0500')
      order by array_position(array['0520','0510','0500'], code)
      limit 1;
      v_plug_label := 'Meegebracht eigen vermogen (sluitpost beginbalans)';
    else
      v_plug_code := '0500';
      v_plug_label := 'Eigen vermogen (sluitpost beginbalans)';
    end if;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, coalesce(v_plug_code, '0500')),
      'description', v_plug_label,
      'debit_cents', case when v_equity < 0 then -v_equity else 0 end,
      'credit_cents', case when v_equity > 0 then v_equity else 0 end
    ));
  end if;

  return public.post_journal_entry(
    p_organization_id, p_as_of_date, 'Beginbalans per ' || p_as_of_date,
    'opening_balance', null, v_lines, p_created_by
  );
end;
$function$;

-- Rechten: zoals op staging, en elke functie expliciet dicht voor anon
-- (migrationGrants.test.ts). Een triggerfunctie vuurt ook zonder EXECUTE.
revoke all on function public.enforce_purchase_invoice_lines() from public, anon, authenticated;
revoke all on function public.enforce_invoice_lines_numeric() from public, anon, authenticated;
revoke all on function public.open_fiscal_year(uuid, date, date, text, uuid) from public, anon;
grant execute on function public.open_fiscal_year(uuid, date, date, text, uuid) to authenticated, service_role;
revoke all on function public.post_journal_entry(uuid, date, text, text, uuid, jsonb, uuid) from public, anon;
grant execute on function public.post_journal_entry(uuid, date, text, text, uuid, jsonb, uuid) to authenticated, service_role;
revoke all on function public.create_opening_balance(uuid, date, jsonb, uuid) from public, anon;
grant execute on function public.create_opening_balance(uuid, date, jsonb, uuid) to authenticated, service_role;

commit;
