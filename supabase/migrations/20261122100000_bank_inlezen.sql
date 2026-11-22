-- ============================================================================
-- Bank inlezen en koppelen (controle bank, 22 november 2026)
--
-- 1. bank_accounts.sync_gap_from / sync_gap_to: een periode die de
--    bankkoppeling niet meer kon ophalen. Na een verlopen toestemming en
--    maanden later opnieuw koppelen gaf de bank maar ongeveer 90 dagen terug;
--    bank-sync vroeg dan opnieuw met "longest" en meldde de sync als
--    geslaagd. Wat ertussen zat, ontbrak stil (een premie van € 99,99 kwam
--    nooit binnen). bank-sync legt het gat nu vast; de Bankpagina toont het
--    tot je het wegklikt of een afschrift over die periode inleest.
--
-- 2. bank_purchase_match: de reden bij een voorstel noemt het nummer dat
--    echt in de omschrijving staat. Eerder stond er het eigen nummer van de
--    inkoopfactuur ("Factuurnummer INK-2026-0001 staat in de omschrijving")
--    terwijl de omschrijving het nummer van de leverancier had
--    ("TIP-2026-883421"). De koppeling klopte, maar de uitleg niet, en die
--    uitleg is waarop je een voorstel beoordeelt.
--
-- Veilig om opnieuw te draaien: kolommen met "if not exists", de functie met
-- "create or replace".
-- ============================================================================

alter table public.bank_accounts add column if not exists sync_gap_from date;
alter table public.bank_accounts add column if not exists sync_gap_to date;

comment on column public.bank_accounts.sync_gap_from is
  'Eerste dag van een periode die de bankkoppeling niet meer kon ophalen (bank-sync, syncGap). Leeg = geen gat bekend.';
comment on column public.bank_accounts.sync_gap_to is
  'Laatste dag van die periode.';

-- ── bank_purchase_match ─────────────────────────────────────────────────────
-- Basis: 20261119180000_financien_herstelwegen.sql. Gewijzigd: het blok
-- "Het nummer in de omschrijving" (genoemd, en de redenen daaronder).

CREATE OR REPLACE FUNCTION public.bank_purchase_match(p_txn bank_transactions, p_haystack text, p_open bank_open_purchase_invoice[], p_ibans jsonb, p_claimed uuid[], p_mode text, p_name_tokens jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  v_need bigint := abs(p_txn.amount_cents);
  -- Wat een stuk "van nature" krijgt in de richting van de transactie: bij een
  -- betaling het openstaande bedrag (een creditnota is dan negatief), bij een
  -- ontvangst het omgekeerde.
  v_flip integer := case when p_txn.amount_cents < 0 then 1 else -1 end;
  v_iban text := public.bank_norm_iban(p_txn.counterparty_iban);
  -- GEWIJZIGD (20261118200000): pas uitgerekend als het nodig is (niet bij
  -- 'amount'); twee keer regex per bankregel telde op.
  v_cp text;
  v_desc text;
  v_names uuid[];
  v_descs uuid[];
  v_cp_pad text;
  v_desc_pad text;
  v_rows jsonb;
  v_n integer;
  v_sum bigint;
  v_left bigint;
  v_take bigint;
  v_allocs jsonb;
  v_labels text;
  r record;
  v_sup_iban uuid;
  v_sup_name uuid;
  v_sup_desc uuid;
  v_ref_sup uuid;
  v_ref_ok boolean;
  v_try record;
  v_cands jsonb;
  v_exact integer;
  v_pick record;
  v_running bigint;
  v_k integer;
  v_other_ref boolean := false;
  v_sure boolean;
begin
  if v_need = 0 or p_open is null or cardinality(p_open) = 0 then
    return null;
  end if;

  -- ── Alleen het bedrag ─────────────────────────────────────────────────────
  if p_mode = 'amount' then
    select count(*) into v_n
    from unnest(p_open) c
    where c.open_cents * v_flip = v_need
      and p_txn.booking_date between c.date - 30 and c.date + 365;
    if v_n <> 1 then
      return null;
    end if;
    select c.id, c.supplier_id, c.supplier_name, c.label into r
    from unnest(p_open) c
    where c.open_cents * v_flip = v_need
      and p_txn.booking_date between c.date - 30 and c.date + 365;
    -- Hing die ene factuur in deze ronde al aan een andere betaling, dan niet
    -- nog eens: twee betalingen van € 50 en één factuur van € 50 is twijfel.
    if r.id = any(coalesce(p_claimed, '{}'::uuid[])) then
      return null;
    end if;
    return jsonb_build_object(
      'allocations', jsonb_build_array(jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', r.id, 'amount_cents', v_need)),
      'certain', false,
      'confidence', 'purchase_amount',
      'supplier_id', r.supplier_id,
      'reason', format('Alleen het bedrag past: inkoopfactuur %s%s staat precies zo open. Controleer het voordat je boekt.',
                       r.label, coalesce(' van ' || r.supplier_name, ''))
    );
  end if;

  -- Wie is de tegenpartij? Op IBAN (alleen als dat IBAN bij precies één
  -- leverancier hoort), op de naam van de tegenpartij, en op de naam in de
  -- omschrijving. Voor de naam tellen alleen leveranciers met iets openstaand
  -- in deze richting. Een naam telt als hele woorden: "kpn" in "kpn mobile",
  -- niet "ns" in "nsinternational"; in een omschrijving pas vanaf vier tekens.
  if v_iban is not null and coalesce(p_ibans ->> v_iban, '') <> '' then
    v_sup_iban := (p_ibans ->> v_iban)::uuid;
  end if;
  -- GEWIJZIGD (20261118200000): naam als tegenpartij en naam in de
  -- omschrijving in één doorloop over de facturen in plaats van twee.
  v_cp := public.bank_name_norm(p_txn.counterparty_name);
  v_desc := public.bank_name_norm(coalesce(p_txn.description, '') || ' ' || coalesce(p_txn.structured_reference, ''));
  if (v_cp is not null or v_desc is not null)
     and (p_name_tokens is null
          or exists (select 1 from unnest(string_to_array(coalesce(v_cp, '') || ' ' || coalesce(v_desc, ''), ' ')) as w
                     where w <> '' and p_name_tokens ? w)) then
    v_cp_pad := ' ' || coalesce(v_cp, '') || ' ';
    v_desc_pad := ' ' || coalesce(v_desc, '') || ' ';
    select array_agg(distinct c.supplier_id) filter (where
             v_cp is not null
             and ((length(c.name_norm) >= 2 and c.name_norm = v_cp)
                  or (length(c.name_norm) >= 3 and strpos(v_cp_pad, ' ' || c.name_norm || ' ') > 0)
                  or (length(v_cp) >= 4 and strpos(' ' || c.name_norm || ' ', v_cp_pad) > 0))),
           array_agg(distinct c.supplier_id) filter (where
             v_desc is not null
             and length(c.name_norm) >= 4 and strpos(v_desc_pad, ' ' || c.name_norm || ' ') > 0)
    into v_names, v_descs
    from unnest(p_open) c
    where c.supplier_id is not null and c.open_cents * v_flip > 0 and c.name_norm is not null
      and ((v_cp is not null
            and ((length(c.name_norm) >= 2 and c.name_norm = v_cp)
                 or (length(c.name_norm) >= 3 and strpos(v_cp_pad, ' ' || c.name_norm || ' ') > 0)
                 or (length(v_cp) >= 4 and strpos(' ' || c.name_norm || ' ', v_cp_pad) > 0)))
           or (v_desc is not null
               and length(c.name_norm) >= 4 and strpos(v_desc_pad, ' ' || c.name_norm || ' ') > 0));
    v_sup_name := case when cardinality(v_names) = 1 then v_names[1] end;
    v_sup_desc := case when cardinality(v_descs) = 1 then v_descs[1] end;
  end if;
  v_ref_sup := coalesce(v_sup_iban, v_sup_name);

  -- ── Het nummer in de omschrijving ────────────────────────────────────────
  -- Op volgorde van noemen. Een factuur en een creditnota van de leverancier
  -- in één betaling mogen samen: dan is de creditnota negatief. Twee
  -- leveranciers kunnen hetzelfde factuurnummer gebruiken: is de tegenpartij
  -- bekend en noemt de omschrijving een factuur van hem, dan alleen die van hem.
  if length(coalesce(p_haystack, '')) >= 3 then
    with genoemd as (
      -- GEWIJZIGD (20261122100000): ook wélk nummer er staat. De reden noemde
      -- het label (het eigen nummer, INK-2026-0001) terwijl de omschrijving het
      -- nummer van de leverancier had (TIP-2026-883421). Nu: "Factuurnummer
      -- TIP-2026-883421 (inkoopfactuur INK-2026-0001)", en bij het kenmerk uit
      -- een e-factuur "Betalingskenmerk …".
      select y.id, y.label, y.supplier_id, y.natural, y.pos,
             y.found || case when lower(regexp_replace(y.found, '\s', '', 'g')) <> lower(regexp_replace(coalesce(y.label, ''), '\s', '', 'g'))
                             then ' (inkoopfactuur ' || y.label || ')' else '' end as named,
             y.noun
      from (
        select x.id, x.label, x.supplier_id, x.natural, least(x.p1, x.p2, x.p3) as pos,
               case least(x.p1, x.p2, x.p3) when x.p1 then x.ref1 when x.p2 then x.ref2 else x.ref3 end as found,
               case least(x.p1, x.p2, x.p3) when x.p1 then 'Factuurnummer' when x.p2 then 'Factuurnummer' else 'Betalingskenmerk' end as noun
        from (
          -- Eerst goedkoop: staat de tekst er letterlijk in? Pas dan de
          -- strengere controle (los kenmerk, niet "42" in "4211").
          select c.id, c.label, c.supplier_id, c.open_cents * v_flip as natural, c.ref1, c.ref2, c.ref3,
                 case when strpos(p_haystack, c.ref1_norm) > 0 and public.bank_text_mentions_reference(p_haystack, c.ref1) then strpos(p_haystack, c.ref1_norm) end as p1,
                 case when strpos(p_haystack, c.ref2_norm) > 0 and public.bank_text_mentions_reference(p_haystack, c.ref2) then strpos(p_haystack, c.ref2_norm) end as p2,
                 case when strpos(p_haystack, c.ref3_norm) > 0 and public.bank_text_mentions_reference(p_haystack, c.ref3) then strpos(p_haystack, c.ref3_norm) end as p3
          from unnest(p_open) c
          where strpos(p_haystack, c.ref1_norm) > 0
             or strpos(p_haystack, c.ref2_norm) > 0
             or strpos(p_haystack, c.ref3_norm) > 0
        ) x
      ) y
      where y.pos is not null
    )
    select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'label', m.label, 'natural', m.natural, 'supplier_id', m.supplier_id,
                                                 'named', m.named, 'mention', m.noun || ' ' || m.named) order by m.pos), '[]'::jsonb),
           count(*), coalesce(sum(m.natural), 0),
           -- Zeker alleen als het geld naar het IBAN van die leverancier ging,
           -- of als het IBAN niemand van ons zegt.
           v_sup_iban is null or bool_and(m.supplier_id is not distinct from v_sup_iban)
    into v_rows, v_n, v_sum, v_ref_ok
    from genoemd m
    where v_ref_sup is null
       or m.supplier_id = v_ref_sup
       or not exists (select 1 from genoemd g where g.supplier_id = v_ref_sup);
  else
    v_n := 0;
  end if;

  if v_n = 1 and (v_rows -> 0 ->> 'natural')::bigint > 0 then
    v_take := (v_rows -> 0 ->> 'natural')::bigint;
    if v_take = v_need then
      return jsonb_build_object(
        'allocations', jsonb_build_array(jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', v_rows -> 0 ->> 'id', 'amount_cents', v_need)),
        'certain', coalesce(v_ref_ok, false), 'confidence', 'purchase_invoice', 'supplier_id', v_rows -> 0 -> 'supplier_id',
        'reason', format('%s staat in de omschrijving en het bedrag klopt.', v_rows -> 0 ->> 'mention')
          || case when coalesce(v_ref_ok, false) then '' else ' Het rekeningnummer hoort bij een andere leverancier; controleer het voordat je boekt.' end);
    elsif v_take > v_need then
      return jsonb_build_object(
        'allocations', jsonb_build_array(jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', v_rows -> 0 ->> 'id', 'amount_cents', v_need)),
        'certain', false, 'confidence', 'purchase_invoice', 'supplier_id', v_rows -> 0 -> 'supplier_id',
        'reason', format('%s staat in de omschrijving. Er staat %s open, dus dit lijkt een deelbetaling.',
                         v_rows -> 0 ->> 'mention', public.bank_eur(v_take)));
    else
      return jsonb_build_object(
        'allocations', jsonb_build_array(
          jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', v_rows -> 0 ->> 'id', 'amount_cents', v_take),
          jsonb_build_object('kind', 'ledger', 'amount_cents', v_need - v_take)),
        'certain', false, 'confidence', 'purchase_invoice', 'supplier_id', v_rows -> 0 -> 'supplier_id',
        'reason', format('%s staat in de omschrijving, maar de betaling is %s hoger dan wat er openstaat (%s). Kies een rekening voor de rest.',
                         v_rows -> 0 ->> 'mention', public.bank_eur(v_need - v_take), public.bank_eur(v_take)));
    end if;
  elsif v_n >= 2 then
    select string_agg(e ->> 'named', ', ') into v_labels from jsonb_array_elements(v_rows) e;
    if v_sum = v_need and exists (select 1 from jsonb_array_elements(v_rows) e where (e ->> 'natural')::bigint > 0) then
      select jsonb_agg(jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', e ->> 'id', 'amount_cents', (e ->> 'natural')::bigint))
      into v_allocs from jsonb_array_elements(v_rows) e;
      return jsonb_build_object(
        'allocations', v_allocs, 'certain', coalesce(v_ref_ok, false), 'confidence', 'purchase_invoice',
        'supplier_id', case when (select count(distinct e ->> 'supplier_id') from jsonb_array_elements(v_rows) e) = 1 then v_rows -> 0 -> 'supplier_id' end,
        'reason', format('De omschrijving noemt %s, en samen klopt het bedrag precies.', v_labels)
          || case when coalesce(v_ref_ok, false) then '' else ' Het rekeningnummer hoort bij een andere leverancier; controleer het voordat je boekt.' end);
    end if;
    -- Klopt het niet precies: op volgorde van noemen tot het bedrag op is, de
    -- rest op een eigen regel. Hetzelfde als het verdeelscherm voorstelt.
    v_allocs := '[]'::jsonb;
    v_left := v_need;
    for r in select e ->> 'id' as id, (e ->> 'natural')::bigint as natural from jsonb_array_elements(v_rows) e loop
      if r.natural > 0 then
        v_take := least(r.natural, v_left);
        continue when v_take <= 0;
      else
        v_take := r.natural;
      end if;
      v_allocs := v_allocs || jsonb_build_array(jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', r.id, 'amount_cents', v_take));
      v_left := v_left - v_take;
    end loop;
    if jsonb_array_length(v_allocs) > 0 then
      if v_left > 0 then
        v_allocs := v_allocs || jsonb_build_array(jsonb_build_object('kind', 'ledger', 'amount_cents', v_left));
      end if;
      return jsonb_build_object(
        'allocations', v_allocs, 'certain', false, 'confidence', 'purchase_invoice', 'supplier_id', null,
        'reason', format('De omschrijving noemt %s, maar samen komt dat niet precies op het bedrag. Controleer de verdeling.', v_labels));
    end if;
  end if;

  -- ── De leverancier ───────────────────────────────────────────────────────
  -- Hoort het IBAN bij een andere leverancier dan de naam, dan is de naam
  -- hooguit een voorstel: het geld ging naar dat IBAN.
  for v_try in
    select * from (values
      (1, v_sup_iban, 'iban', true),
      (2, v_sup_name, 'name', v_sup_iban is null),
      (3, v_sup_desc, 'description', false)
    ) as t(ord, supplier_id, how, may_be_certain)
    where t.supplier_id is not null
    order by t.ord
  loop
    -- De openstaande facturen van deze leverancier, oudste eerst. Een
    -- betaling ruim vóór de factuurdatum hoort er niet bij.
    select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'label', c.label, 'name', c.supplier_name, 'date', c.date,
                                                 'natural', c.open_cents * v_flip) order by c.due, c.date, c.id), '[]'::jsonb)
    into v_cands
    from unnest(p_open) c
    where c.supplier_id = v_try.supplier_id
      and c.open_cents * v_flip > 0
      and p_txn.booking_date >= c.date - 60;
    continue when jsonb_array_length(v_cands) = 0;

    select count(*) into v_exact from jsonb_array_elements(v_cands) e where (e ->> 'natural')::bigint = v_need;

    if v_exact = 1 then
      select e ->> 'id' as id, e ->> 'label' as label, e ->> 'name' as name, (e ->> 'date')::date as date into v_pick
      from jsonb_array_elements(v_cands) e where (e ->> 'natural')::bigint = v_need;
      -- GEWIJZIGD (20261119180000): leverancier en bedrag zijn niet altijd genoeg om vanzelf
      -- te boeken. Niet zeker (dus een voorstel) als:
      --  - de betaling ruim vóór de factuurdatum ligt: van drie open incasso's
      --    werd die van 25 september gekoppeld aan de factuur van 5 november;
      --  - de omschrijving een factuurnummer noemt dat ResoFly niet kent:
      --    "Factuur HN-2026-11" (nog niet ingevoerd) werd geboekt op HN-2026-10
      --    omdat rekeningnummer en bedrag pasten.
      -- Een week speling: wie vooruit betaalt, krijgt de factuur vaak een paar
      -- dagen later.
      v_other_ref := coalesce(v_n, 0) = 0
        and coalesce(p_haystack, '') ~ '(factuur|faktuur|invoice|factnr|nota)[a-z.:#]{0,6}[-/]?[a-z]{0,4}[-/]?[0-9]{2,}';
      v_sure := v_try.may_be_certain and v_try.how in ('iban', 'name')
        and p_txn.booking_date >= v_pick.date - 7
        and not v_other_ref;
      return jsonb_build_object(
        'allocations', jsonb_build_array(jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', v_pick.id, 'amount_cents', v_need)),
        'certain', v_sure, 'confidence', 'purchase_supplier', 'supplier_id', v_try.supplier_id,
        'reason', case v_try.how
          when 'iban' then format('Rekeningnummer van %s en het bedrag van inkoopfactuur %s.', v_pick.name, v_pick.label)
          when 'name' then format('Naam %s en het bedrag van inkoopfactuur %s.', v_pick.name, v_pick.label)
            || case when v_try.may_be_certain then '' else ' Het rekeningnummer hoort bij een andere leverancier; controleer het voordat je boekt.' end
          else format('%s staat in de omschrijving en het bedrag past op inkoopfactuur %s. Controleer het voordat je boekt.', v_pick.name, v_pick.label)
        end
        || case when v_try.may_be_certain and v_try.how in ('iban', 'name') and p_txn.booking_date < v_pick.date - 7
                then format(' De betaling is van vóór de factuurdatum (%s); controleer of hij bij deze factuur hoort.', to_char(v_pick.date, 'DD-MM-YYYY'))
                when v_try.may_be_certain and v_try.how in ('iban', 'name') and v_other_ref
                then ' De omschrijving noemt een factuurnummer dat hier niet bij een openstaande factuur staat; controleer of het deze factuur is.'
                else '' end);
    elsif v_exact > 1 then
      -- Meer facturen van deze leverancier met dit bedrag (een abonnement):
      -- de oudste die in deze ronde nog niet aan een andere betaling hing.
      select e ->> 'id' as id, e ->> 'label' as label, e ->> 'name' as name into v_pick
      from jsonb_array_elements(v_cands) with ordinality as t(e, ord)
      where (e ->> 'natural')::bigint = v_need
      order by ((e ->> 'id')::uuid = any(coalesce(p_claimed, '{}'::uuid[]))), ord
      limit 1;
      return jsonb_build_object(
        'allocations', jsonb_build_array(jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', v_pick.id, 'amount_cents', v_need)),
        'certain', false, 'confidence', 'purchase_supplier', 'supplier_id', v_try.supplier_id,
        'reason', format('%s openstaande facturen van %s hebben dit bedrag; de oudste (%s) is voorgesteld. Kies een andere als dat niet klopt.',
                         v_exact, v_pick.name, v_pick.label));
    end if;

    -- Een verzamelbetaling: precies de oudste k facturen samen (k ≥ 2).
    v_running := 0; v_k := 0; v_allocs := '[]'::jsonb; v_labels := null;
    for r in select e ->> 'id' as id, e ->> 'label' as label, e ->> 'name' as name, (e ->> 'natural')::bigint as natural
             from jsonb_array_elements(v_cands) with ordinality as t(e, ord) order by ord
    loop
      v_running := v_running + r.natural;
      v_k := v_k + 1;
      v_allocs := v_allocs || jsonb_build_array(jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', r.id, 'amount_cents', r.natural));
      v_labels := coalesce(v_labels || ', ', '') || r.label;
      exit when v_running >= v_need;
    end loop;
    if v_k >= 2 and v_running = v_need then
      return jsonb_build_object(
        'allocations', v_allocs,
        -- GEWIJZIGD (20261119180000): een verzamelbetaling op alleen bedragen is een
        -- vermoeden, geen zekerheid: € 181,50 voor een nieuwe bestelling was
        -- toevallig precies de twee oudste facturen samen en werd zo geboekt.
        -- Noemt de omschrijving de facturen, dan vangt de tak hierboven hem.
        'certain', false, 'confidence', 'purchase_supplier', 'supplier_id', v_try.supplier_id,
        'reason', format('Verzamelbetaling aan %s: samen precies de %s oudste openstaande facturen (%s).', r.name, v_k, v_labels)
          || ' Controleer het voordat je boekt.');
    end if;
  end loop;

  return null;
end;
$function$;

-- Alleen de matcher roept hem aan (met de service-role); net als in
-- 20261119180000.
revoke all on function public.bank_purchase_match(bank_transactions, text, bank_open_purchase_invoice[], jsonb, uuid[], text, jsonb) from public, anon, authenticated;
grant execute on function public.bank_purchase_match(bank_transactions, text, bank_open_purchase_invoice[], jsonb, uuid[], text, jsonb) to service_role;
