-- ============================================================
-- ResoFly — post_credit_note_to_ledger: twee gerichte fixes
-- Date: 2026-07-26
--
-- Bron: nalezing van Blok C (migratie 20260723200000). De functie zelf blijft
-- ongewijzigd op één na twee punten; de rest is 1-op-1 overgenomen zodat er
-- geen ander gedrag mee verandert.
--
--  FIX 1  Creditnota op een NIET-geboekte factuur maakte Debiteuren negatief.
--         De functie crediteert 1300 met het volledige creditnotabedrag, maar
--         controleerde niet of de oorspronkelijke factuur die vordering ooit
--         heeft gedebiteerd. Staat de factuur niet in het grootboek, dan komt
--         er een creditering zonder tegenpost te staan: 1300 wordt negatief én
--         de omzet-terugname staat tegenover omzet die er nooit was.
--         Dit is exact dezelfde bewaking die book_bank_transaction sinds
--         Blok A (20260721000000, FIX 2) wél heeft voor de bankaflettering —
--         de creditnota-route had hem niet.
--         NB: de auto-boekketen (20260724100000) boekt facturen automatisch
--         bij verzenden en vangt fouten af met `raise warning`. Faalt dat
--         automatische boeken, dan bleef de creditnota tóch doorboeken; die
--         stille route is nu dicht.
--
--  FIX 2  De restcent-correctie koos de "grootste" groep met een teller die op
--         -1 begon en op de RAUWE grondslag vergeleek. Bij een creditnota met
--         uitsluitend negatieve regels (een correctie op een eerdere
--         creditnota) is geen enkele grondslag > -1, waardoor v_biggest_idx op
--         -1 bleef staan. jsonb_set telt een negatieve index vanaf het einde,
--         dus de restcent belandde stil op de LAATSTE groep in plaats van op de
--         grootste. Geen crash, wel een cent op de verkeerde grootboekrekening
--         (en dus in de verkeerde btw-rubriek). Nu op absolute grondslag, met
--         een expliciete "nog niets gekozen"-check.
-- ============================================================

begin;

create or replace function public.post_credit_note_to_ledger(
  p_organization_id uuid,
  p_credit_note_id uuid,
  p_created_by uuid default auth.uid()
)
returns public.journal_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cn public.credit_notes;
  v_inv public.invoices;
  v_start date;
  v_lines jsonb := '[]'::jsonb;
  v_groups jsonb := '[]'::jsonb;
  v_entry public.journal_entries;
  v_book_date date;
  v_desc text;
  v_doc_subtotal bigint;
  v_doc_vat bigint;
  v_doc_total bigint;
  v_sum_base bigint := 0;
  v_sum_vat bigint := 0;
  v_base_diff bigint;
  v_vat_diff bigint;
  v_n_groups integer := 0;
  v_biggest_idx integer := -1;
  -- FIX 2: geen kunstmatige startwaarde meer; v_biggest_idx < 0 is de
  -- "nog niets gekozen"-check.
  v_biggest_base bigint;
  v_g jsonb;
  v_i integer;
  r record;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_cn from public.credit_notes
  where id = p_credit_note_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Creditnota niet gevonden.' using errcode = '02000';
  end if;
  if v_cn.journal_entry_id is not null then
    raise exception 'Creditnota % is al naar het grootboek geboekt.', v_cn.number using errcode = '23514';
  end if;
  if v_cn.status <> 'issued' then
    raise exception 'Alleen een uitgegeven creditnota kan worden geboekt (status: %).', v_cn.status using errcode = '23514';
  end if;

  select * into v_inv from public.invoices
  where id = v_cn.invoice_id and organization_id = p_organization_id;
  if not found then
    raise exception 'De factuur bij deze creditnota is niet gevonden.' using errcode = '02000';
  end if;

  -- FIX 1: zonder de oorspronkelijke debitering van 1300 zou de creditering
  -- hieronder Debiteuren negatief maken. Zelfde bewaking als in
  -- book_bank_transaction (Blok A, FIX 2).
  if v_inv.journal_entry_id is null then
    raise exception 'Factuur % staat nog niet in het grootboek. Boek de factuur eerst ("Boek naar grootboek") en boek daarna de creditnota.',
      coalesce(v_inv.number, '') using errcode = '23514';
  end if;

  select bookkeeping_start_date into v_start
  from public.company_settings where organization_id = p_organization_id;
  if v_start is not null and v_cn.date < v_start then
    raise exception 'Creditnotadatum ligt vóór de boekhoud-startdatum (%); deze correctie zit al in de beginbalans.', v_start
      using errcode = '23514';
  end if;

  v_doc_subtotal := round(v_cn.subtotal_amount * 100);
  v_doc_vat := round(v_cn.vat_amount * 100);
  v_doc_total := round(v_cn.total_amount * 100);
  if v_doc_total <= 0 then
    raise exception 'Creditnota % heeft geen bedrag.', v_cn.number using errcode = '23514';
  end if;
  if v_doc_subtotal + v_doc_vat <> v_doc_total then
    raise exception 'Creditnota % is niet consistent (netto + btw ≠ totaal).', v_cn.number using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);

  -- Groepen per (btw-code, tarief), zoals bij de verkoopfactuur.
  for r in
    select
      nullif(btrim(coalesce(line->>'vat_code', '')), '') as vat_code,
      (vc.id is not null) as has_code,
      vc.kind, vc.sales_box,
      coalesce((line->>'vat')::numeric, 0) as rate,
      sum(round(coalesce((line->>'quantity')::numeric, 0) * coalesce((line->>'unit_price')::numeric, 0) * 100)) as base_cents
    from jsonb_array_elements(v_cn.lines) as line
    left join public.vat_codes vc
      on vc.organization_id = p_organization_id
     and vc.code = nullif(btrim(coalesce(line->>'vat_code', '')), '')
    group by 1, 2, 3, 4, 5
  loop
    declare
      v_vat bigint := round(r.base_cents * r.rate / 100.0);
      v_revenue_account text := case
        when r.has_code and (r.sales_box in ('3a','3b','3c') or r.kind = 'reverse_charge_sales') then '8030'
        when r.rate >= 21 then '8000'
        when r.rate > 0 then '8010'
        else '8020'
      end;
    begin
      v_groups := v_groups || jsonb_build_array(jsonb_build_object(
        'account', v_revenue_account, 'vat_code', r.vat_code, 'rate', r.rate,
        'base', r.base_cents, 'vat', v_vat));
      v_sum_base := v_sum_base + r.base_cents;
      v_sum_vat := v_sum_vat + v_vat;
      v_n_groups := v_n_groups + 1;
      -- FIX 2: grootste groep op ABSOLUTE grondslag, met expliciete
      -- "nog niets gekozen"-check.
      if v_biggest_idx < 0 or abs(r.base_cents) > v_biggest_base then
        v_biggest_base := abs(r.base_cents); v_biggest_idx := v_n_groups - 1;
      end if;
    end;
  end loop;

  if v_n_groups = 0 then
    -- Creditnota zonder regels (hoort niet voor te komen): boek als één groep
    -- op 8000/8010/8020 valt niet te bepalen → weiger expliciet.
    raise exception 'Creditnota % heeft geen regels en kan niet worden geboekt.', v_cn.number using errcode = '23514';
  end if;

  -- Aansluiting op het document: restcenten in de grootste groep rechttrekken.
  -- Pro-rata-creditnota's dragen een "blended" tarief dat op 2 decimalen is
  -- afgerond; bij grote bedragen wijkt de herberekende btw daardoor tot
  -- ~0,005% van de grondslag af. De tolerantie schaalt daarom mee (0,01% van
  -- het totaal, minimaal 4 cent); grotere afwijkingen betekenen een echt
  -- inconsistent document → weigeren.
  v_base_diff := v_doc_subtotal - v_sum_base;
  v_vat_diff := v_doc_vat - v_sum_vat;
  if abs(v_base_diff) > greatest(4, 2 * v_n_groups, ceil(v_doc_total * 0.0001)::bigint)
     or abs(v_vat_diff) > greatest(4, 2 * v_n_groups, ceil(v_doc_total * 0.0001)::bigint) then
    raise exception 'Creditnota % sluit niet aan op zijn regels (verschil netto % cent, btw % cent).',
      v_cn.number, v_base_diff, v_vat_diff using errcode = '23514';
  end if;
  if v_base_diff <> 0 or v_vat_diff <> 0 then
    v_g := v_groups->v_biggest_idx;
    v_groups := jsonb_set(v_groups, array[v_biggest_idx::text], v_g
      || jsonb_build_object(
        'base', (v_g->>'base')::bigint + v_base_diff,
        'vat', (v_g->>'vat')::bigint + v_vat_diff));
  end if;

  -- Journaalregels: debet omzet (negatieve rubriek-metadata zodat de aangifte
  -- de grondslag en btw netjes terugtelt), debet 1510, credit 1300.
  for v_i in 0 .. v_n_groups - 1 loop
    v_g := v_groups->v_i;
    declare
      v_base bigint := (v_g->>'base')::bigint;
    begin
      if v_base <> 0 then
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
          'account_id', public.bookkeeping_account_id(p_organization_id, v_g->>'account'),
          'description', 'Creditering omzet',
          'debit_cents', case when v_base > 0 then v_base else 0 end,
          'credit_cents', case when v_base < 0 then -v_base else 0 end,
          'vat_code', nullif(v_g->>'vat_code', ''),
          'vat_rate', (v_g->>'rate')::numeric,
          'vat_base_cents', -v_base,
          'vat_amount_cents', -((v_g->>'vat')::bigint),
          'client_id', v_inv.client_id, 'project_id', v_inv.project_id
        ));
      end if;
    end;
  end loop;

  if v_doc_vat <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1510'),
      'description', 'Af te dragen BTW (creditering)',
      'debit_cents', case when v_doc_vat > 0 then v_doc_vat else 0 end,
      'credit_cents', case when v_doc_vat < 0 then -v_doc_vat else 0 end,
      'client_id', v_inv.client_id
    ));
  end if;

  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account_id', public.bookkeeping_account_id(p_organization_id, '1300'),
    'description', 'Debiteuren — creditnota ' || v_cn.number || ' op factuur ' || coalesce(v_inv.number, ''),
    'debit_cents', case when v_doc_total < 0 then -v_doc_total else 0 end,
    'credit_cents', case when v_doc_total > 0 then v_doc_total else 0 end,
    'client_id', v_inv.client_id
  ));

  v_book_date := public.first_open_booking_date(p_organization_id, v_cn.date);
  v_desc := 'Creditnota ' || v_cn.number || ' (factuur ' || coalesce(v_inv.number, '') || ')';
  if v_book_date <> v_cn.date then
    v_desc := v_desc || ' (creditnotadatum ' || to_char(v_cn.date, 'DD-MM-YYYY') || ', geboekt in eerstvolgende open periode)';
  end if;

  v_entry := public.post_journal_entry(
    p_organization_id, v_book_date, v_desc,
    'credit_note', v_cn.id, v_lines, p_created_by
  );

  update public.credit_notes set journal_entry_id = v_entry.id, updated_at = now() where id = v_cn.id;
  return v_entry;
end;
$$;

commit;
