-- Financiën: herstelwegen. Wat een zzp'er fout doet, moet hij zelf kunnen
-- rechtzetten, en de cijfers moeten daarna nog kloppen.
--
-- Aanleiding: de controle van de financiële module voor de eenmanszaak van
-- 19 november 2026 (zes reviews, elk nagespeeld tegen een lokale stack). De
-- gewone stromen klopten; de gebreken zaten in het herstel en in de randen:
--   - "Tegenboeken" en "Boeking ongedaan maken" boekten op de datum van vandaag.
--     Wie een boeking uit een eerdere periode terugdraaide en opnieuw boekte,
--     kreeg kosten en btw dubbel in de oude periode en negatief in de nieuwe;
--     over de jaarwissel verschoof zo winst tussen twee boekjaren.
--   - De bank was de enige die niet doorschoof bij een afgesloten btw-tijdvak
--     of boekjaar: een mutatie met btw in een aangegeven kwartaal was nooit
--     meer te boeken, en terugdraaien was daar eenrichtingsverkeer.
--   - Boekingen vóór de start van de boekhouding (bank, inkoopfactuur, een
--     activum van vóór de start) vielen in een jaar zonder boekjaar; het eerste
--     boekjaar ging dan nooit meer dicht.
--   - Na het afsluiten van Q4 was omzet niet meer in het goede jaar te zetten.
-- Zie docs/changelog/CHANGELOG_FINANCIEN_HERSTELWEGEN_2026-11-19.md.
--
-- Wat hier verandert, per onderdeel: zie de koppen hieronder. Elke gewijzigde
-- plek heeft een regel "GEWIJZIGD/TOEGEVOEGD/VERVALLEN (20261119180000)" met wat er misging.
--
-- Veilig om opnieuw te draaien: create or replace, drop ... if exists, on
-- conflict do nothing. Bestaande boekingen veranderen niet.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Wat raakt de btw-aangifte: een omzetregel zonder code of rubriek niet
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Het btw-slot (post_journal_entry) en het doorschuiven naar de eerste open dag
-- (first_open_booking_date_for) vragen deze functie of een boeking de aangifte
-- raakt.

CREATE OR REPLACE FUNCTION public.journal_lines_touch_vat(p_organization_id uuid, p_lines jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from jsonb_array_elements(case when jsonb_typeof(p_lines) = 'array' then p_lines else '[]'::jsonb end) l
    cross join lateral (
      select
        case when nullif(l->>'account_id', '') is not null then (l->>'account_id')::uuid end as acc_id,
        case when nullif(l->>'account_id', '') is null then l->>'account_code' end as acc_code
    ) k
    join public.ledger_accounts la
      on la.organization_id = p_organization_id
     and (la.id = k.acc_id or la.code = k.acc_code)
    left join public.vat_codes vc
      on vc.organization_id = p_organization_id and vc.code = nullif(l->>'vat_code', '')
    where la.subtype in ('vat_output', 'vat_input', 'vat_reverse')
       or (la.type = 'revenue'
           and not (vc.id is null and la.report_group in ('financiele_baten', 'financiele_lasten', 'resultaat_deelnemingen'))
           -- TOEGEVOEGD (20261119180000): een omzetregel zonder btw-code en zonder tarief
           -- staat in geen rubriek (zie compute_vat_boxes), en een regel met een
           -- code zonder rubriek (vrijgesteld, KOR) en zonder btw ook niet. Tot nu
           -- toe telde élke omzetregel als "raakt de aangifte". Na het afsluiten
           -- van Q4 kon je daardoor geen enkele afgrenzing meer op 31 december
           -- boeken (nog te factureren, vooruitgefactureerd): de omzet van een
           -- decemberfactuur die naar 1 januari was geschoven, kreeg je nooit
           -- meer in het goede jaar.
           and not (vc.id is null and nullif(l->>'vat_rate', '') is null)
           and not (vc.id is not null and vc.sales_box is null and coalesce(vc.vat_box, '') = ''
                    and coalesce(nullif(l->>'vat_amount_cents', '')::numeric, 0) = 0))
       or (la.type in ('expense', 'asset') and vc.id is not null and vc.sales_box in ('2a', '4a', '4b'))
  );
$function$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Btw-rubrieken: een memoriaalregel op omzet zonder code telt niet in 1e
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.compute_vat_boxes(p_organization_id uuid, p_from date, p_to date, p_entry_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r record;
  v_saldo bigint;
  v_saldo_afgerond bigint;
  v_box_vat_total bigint;
  v_consistent boolean;
  v_form_1a bigint; v_form_1b bigint; v_form_1c bigint; v_form_1d bigint;
  v_form_2a bigint; v_form_4a bigint; v_form_4b bigint;
  v_form_5a bigint; v_form_5b bigint; v_form_5c bigint;
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if p_entry_ids is null and (p_from is null or p_to is null) then
    raise exception 'Periode (van/tot) is verplicht.' using errcode = '23514';
  end if;

  with lines as (
    select
      jl.debit_cents, jl.credit_cents, jl.vat_rate, jl.vat_base_cents, jl.vat_amount_cents,
      -- GEWIJZIGD (20260807020000): financiële baten en lasten en het resultaat
      -- uit deelnemingen zijn geen omzet voor de omzetbelasting. Zonder deze
      -- uitzondering valt rente zonder btw-code hieronder in de terugval op het
      -- tarief en belandt hij in rubriek 1e — omzet op de aangifte die er niet
      -- hoort te staan. De sentinelwaarde valt buiten élke acc_type-test
      -- ('revenue' en ('expense','asset')); de grootboektotalen hieronder lopen
      -- over acc_subtype en blijven dus ongemoeid.
      -- Alleen op de TERUGVAL-tak: een regel MÉT btw-code volgt altijd zijn code.
      -- De rubriek is een presentatiekeuze die de gebruiker vrij mag aanpassen;
      -- zonder deze voorwaarde zou zo'n keuze belaste omzet uit rubriek 1a
      -- kunnen halen terwijl de btw wel op 1510 blijft staan.
      case
        when vc.id is null
         and la.report_group in ('financiele_baten', 'financiele_lasten', 'resultaat_deelnemingen')
          then 'non_vat'
        else la.type
      end as acc_type,
      la.subtype as acc_subtype,
      (vc.id is not null) as has_code, vc.sales_box, vc.vat_box
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    left join public.vat_codes vc
      on vc.organization_id = jl.organization_id and vc.code = jl.vat_code
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and (
        case when p_entry_ids is not null
          then je.id = any(p_entry_ids)
          else (
            je.date between p_from and p_to
            -- Het jaarafsluitboekstuk debiteert omzetrekeningen zonder vat_rate;
            -- zonder dit filter lekt dat als negatieve omzet in rubriek 1e.
            and je.source_type <> 'year_close'
            -- In een suppletie verrekende boekstukken zijn al aangegeven.
            and not exists (
              select 1 from public.vat_supplement_entries vse where vse.entry_id = je.id
            )
          )
        end
      )
  ),
  classified as (
    select
      -- Omzetkant: rubriek voor de grondslag. Mét code: sales_box (kan null
      -- zijn — vrijgesteld/KOR telt in geen enkele rubriek). Zonder code:
      -- terugval op het tarief.
      case when acc_type = 'revenue' then
        case
          when has_code then sales_box
          when coalesce(vat_rate, 0) >= 21 then '1a'
          when coalesce(vat_rate, 0) > 0 then '1b'
          -- GEWIJZIGD (20261119180000): alleen een regel met een tarief van 0% telt in
          -- 1e. Een regel zonder code en zonder tarief komt alleen uit het
          -- memoriaal (facturen, creditnota's en de bank zetten altijd een
          -- tarief): een afgrenzing "nog te factureren € 2.000" verhoogde zo
          -- stil rubriek 1e met € 2.000, terwijl daar alleen omzet tegen 0% of
          -- verlegd hoort. Omzet met btw boek je in het memoriaal met een code.
          when vat_rate is not null then '1e'
        end
      -- TOEGEVOEGD (20261105233000): een btw-regel op 1510 met eigen code en
      -- grondslag (de verkoop van een bedrijfsmiddel: de opbrengst is geen omzet,
      -- maar wel een belaste levering). Zonder deze tak stond de btw wel op
      -- 1510 maar niet in rubriek 1a. Gewone 1510-regels hebben geen grondslag
      -- en blijven hierbuiten.
      when (acc_subtype = 'vat_output' and has_code and vat_base_cents is not null and sales_box in ('1a','1b','1c','1d')) then sales_box
      end as rev_box,
      case when acc_type = 'revenue' then credit_cents - debit_cents
           when (acc_subtype = 'vat_output' and has_code and vat_base_cents is not null and sales_box in ('1a','1b','1c','1d')) then (case when credit_cents > 0 then 1 when debit_cents > 0 then -1 else 0 end) * abs(vat_base_cents)
           else 0 end as rev_base,
      -- Omzetkant: rubriek voor de btw (alleen 1a–1d dragen btw).
      case when acc_type = 'revenue' then
        case
          when has_code then (case when coalesce(vat_box, sales_box) in ('1a','1b','1c','1d') then coalesce(vat_box, sales_box) end)
          when coalesce(vat_rate, 0) >= 21 then '1a'
          when coalesce(vat_rate, 0) > 0 then '1b'
        end
      when (acc_subtype = 'vat_output' and has_code and vat_base_cents is not null and sales_box in ('1a','1b','1c','1d')) then (case when coalesce(vat_box, sales_box) in ('1a','1b','1c','1d') then coalesce(vat_box, sales_box) end)
      end as rev_vat_box,
      case when acc_type = 'revenue' then coalesce(vat_amount_cents, 0)
           when (acc_subtype = 'vat_output' and has_code and vat_base_cents is not null and sales_box in ('1a','1b','1c','1d')) then (case when credit_cents > 0 then 1 when debit_cents > 0 then -1 else 0 end) * abs(coalesce(vat_amount_cents, 0))
           else 0 end as rev_vat,
      -- Inkoopkant: 2a (binnenland verlegd) / 4a (invoer) / 4b (EU-verwerving)
      -- van kosten-/activaregels met zo'n code. Richting volgt de boekzijde.
      case when acc_type in ('expense','asset') and has_code and sales_box in ('2a','4a','4b')
        then sales_box end as pur_box,
      -- GEWIJZIGD (20261104010000): de richting komt alleen van de boekzijde.
      -- Grondslag en btw op de regel kunnen al een teken dragen (tegenboeking,
      -- memoriaal, creditnota); met abs() telt dat niet nog eens mee.
      case when acc_type in ('expense','asset') and has_code and sales_box in ('2a','4a','4b')
        then (case when debit_cents > 0 then 1 when credit_cents > 0 then -1 else 0 end)
             * abs(coalesce(vat_base_cents, case when debit_cents > 0 then debit_cents else credit_cents end))
        else 0 end as pur_base,
      case when acc_type in ('expense','asset') and has_code and sales_box in ('2a','4a','4b')
        then (case when debit_cents > 0 then 1 when credit_cents > 0 then -1 else 0 end)
             * abs(coalesce(vat_amount_cents, 0))
        else 0 end as pur_vat,
      -- Grootboek-totalen: gezaghebbend voor doorboeking en saldo.
      case when acc_subtype = 'vat_output' then credit_cents - debit_cents else 0 end as gl_output,
      case when acc_subtype = 'vat_reverse' then credit_cents - debit_cents else 0 end as gl_reverse,
      case when acc_subtype = 'vat_input' then debit_cents - credit_cents else 0 end as gl_input
    from lines
  )
  select
    coalesce(sum(rev_base) filter (where rev_box = '1a'), 0) as b1a_base,
    coalesce(sum(rev_vat) filter (where rev_vat_box = '1a'), 0) as b1a_vat,
    coalesce(sum(rev_base) filter (where rev_box = '1b'), 0) as b1b_base,
    coalesce(sum(rev_vat) filter (where rev_vat_box = '1b'), 0) as b1b_vat,
    coalesce(sum(rev_base) filter (where rev_box = '1c'), 0) as b1c_base,
    coalesce(sum(rev_vat) filter (where rev_vat_box = '1c'), 0) as b1c_vat,
    coalesce(sum(rev_base) filter (where rev_box = '1d'), 0) as b1d_base,
    coalesce(sum(rev_vat) filter (where rev_vat_box = '1d'), 0) as b1d_vat,
    coalesce(sum(rev_base) filter (where rev_box = '1e'), 0) as b1e_base,
    coalesce(sum(rev_base) filter (where rev_box = '3a'), 0) as b3a_base,
    coalesce(sum(rev_base) filter (where rev_box = '3b'), 0) as b3b_base,
    coalesce(sum(rev_base) filter (where rev_box = '3c'), 0) as b3c_base,
    coalesce(sum(pur_base) filter (where pur_box = '2a'), 0) as b2a_base,
    coalesce(sum(pur_vat) filter (where pur_box = '2a'), 0) as b2a_vat,
    coalesce(sum(pur_base) filter (where pur_box = '4a'), 0) as b4a_base,
    coalesce(sum(pur_vat) filter (where pur_box = '4a'), 0) as b4a_vat,
    coalesce(sum(pur_base) filter (where pur_box = '4b'), 0) as b4b_base,
    coalesce(sum(pur_vat) filter (where pur_box = '4b'), 0) as b4b_vat,
    coalesce(sum(gl_output), 0) as clear_output,
    coalesce(sum(gl_reverse), 0) as clear_reverse,
    coalesce(sum(gl_input), 0) as clear_input
  into r
  from classified;

  v_saldo := (r.clear_output + r.clear_reverse) - r.clear_input;

  -- Formulierwaarden: hele euro's PER RUBRIEK (rekenkundig, .50 weg van nul —
  -- zoals round(numeric)); 5a is de som van de afgeronde btw-rubrieken en 5c
  -- volgt uit 5a − 5b, precies zoals de Belastingdienst rekent (review 2.9).
  v_form_1a := round(r.b1a_vat::numeric / 100.0)::bigint;
  v_form_1b := round(r.b1b_vat::numeric / 100.0)::bigint;
  v_form_1c := round(r.b1c_vat::numeric / 100.0)::bigint;
  v_form_1d := round(r.b1d_vat::numeric / 100.0)::bigint;
  v_form_2a := round(r.b2a_vat::numeric / 100.0)::bigint;
  v_form_4a := round(r.b4a_vat::numeric / 100.0)::bigint;
  v_form_4b := round(r.b4b_vat::numeric / 100.0)::bigint;
  v_form_5a := v_form_1a + v_form_1b + v_form_1c + v_form_1d + v_form_2a + v_form_4a + v_form_4b;
  v_form_5b := round(r.clear_input::numeric / 100.0)::bigint;
  v_form_5c := v_form_5a - v_form_5b;

  -- Sluiten de rubrieken op het grootboek aan? De btw per rubriek komt uit
  -- regel-metadata (vat_amount_cents); het grootboek (1510+1520) is de waarheid.
  -- Bij een gaaf geboekte administratie zijn die exact gelijk. Wijken ze meer
  -- dan € 1 af (bijv. handmatig op 1510 geboekt zonder metadata), dan is de
  -- rubriekverdeling onvolledig: saldo_afgerond valt dan terug op het oude
  -- gedrag (saldo in één keer afronden) en de UI toont een waarschuwing.
  v_box_vat_total := r.b1a_vat + r.b1b_vat + r.b1c_vat + r.b1d_vat + r.b2a_vat + r.b4a_vat + r.b4b_vat;
  v_consistent := abs(v_box_vat_total - (r.clear_output + r.clear_reverse)) <= 100;

  if v_consistent then
    v_saldo_afgerond := v_form_5c * 100;
  else
    v_saldo_afgerond := round(v_saldo::numeric / 100.0)::bigint * 100;
  end if;

  return jsonb_build_object(
    'boxes', jsonb_build_object(
      '1a', jsonb_build_object('base', r.b1a_base, 'vat', r.b1a_vat),
      '1b', jsonb_build_object('base', r.b1b_base, 'vat', r.b1b_vat),
      '1c', jsonb_build_object('base', r.b1c_base, 'vat', r.b1c_vat),
      '1d', jsonb_build_object('base', r.b1d_base, 'vat', r.b1d_vat),
      '1e', jsonb_build_object('base', r.b1e_base),
      '2a', jsonb_build_object('base', r.b2a_base, 'vat', r.b2a_vat),
      '3a', jsonb_build_object('base', r.b3a_base),
      '3b', jsonb_build_object('base', r.b3b_base),
      '3c', jsonb_build_object('base', r.b3c_base),
      '4a', jsonb_build_object('base', r.b4a_base, 'vat', r.b4a_vat),
      '4b', jsonb_build_object('base', r.b4b_base, 'vat', r.b4b_vat)
    ),
    'form', jsonb_build_object(
      '1a', jsonb_build_object('base', round(r.b1a_base::numeric / 100.0)::bigint, 'vat', v_form_1a),
      '1b', jsonb_build_object('base', round(r.b1b_base::numeric / 100.0)::bigint, 'vat', v_form_1b),
      '1c', jsonb_build_object('base', round(r.b1c_base::numeric / 100.0)::bigint, 'vat', v_form_1c),
      '1d', jsonb_build_object('base', round(r.b1d_base::numeric / 100.0)::bigint, 'vat', v_form_1d),
      '1e', jsonb_build_object('base', round(r.b1e_base::numeric / 100.0)::bigint),
      '2a', jsonb_build_object('base', round(r.b2a_base::numeric / 100.0)::bigint, 'vat', v_form_2a),
      '3a', jsonb_build_object('base', round(r.b3a_base::numeric / 100.0)::bigint),
      '3b', jsonb_build_object('base', round(r.b3b_base::numeric / 100.0)::bigint),
      '3c', jsonb_build_object('base', round(r.b3c_base::numeric / 100.0)::bigint),
      '4a', jsonb_build_object('base', round(r.b4a_base::numeric / 100.0)::bigint, 'vat', v_form_4a),
      '4b', jsonb_build_object('base', round(r.b4b_base::numeric / 100.0)::bigint, 'vat', v_form_4b),
      '5a', v_form_5a, '5b', v_form_5b, '5c', v_form_5c
    ),
    'boxes_consistent', v_consistent,
    'boxes_vat_diff_cents', v_box_vat_total - (r.clear_output + r.clear_reverse),
    -- Bestaande sleutels (oudere UI-versies, bevroren snapshots, bankmatching):
    'omzet_hoog_base', r.b1a_base, 'omzet_hoog_btw', r.b1a_vat,
    'omzet_laag_base', r.b1b_base, 'omzet_laag_btw', r.b1b_vat,
    'omzet_nul_base', r.b1e_base,
    'verlegd_btw', r.clear_reverse,
    'verschuldigd_total', r.clear_output + r.clear_reverse,
    'voorbelasting', r.clear_input,
    'saldo', v_saldo,
    'saldo_afgerond', v_saldo_afgerond,
    'afronding_cents', v_saldo - v_saldo_afgerond,
    'clear_output', r.clear_output,
    'clear_reverse', r.clear_reverse,
    'clear_input', r.clear_input
  );
end;
$function$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Tegenboeken: op de datum van het boekstuk zelf, niet op vandaag
-- ═══════════════════════════════════════════════════════════════════════════
--
-- unbook_bank_transaction ("Boeking ongedaan maken" bij Bank) roept deze functie
-- zonder datum aan en gaat dus mee.

CREATE OR REPLACE FUNCTION public.reverse_journal_entry(p_entry_id uuid, p_date date DEFAULT NULL::date, p_created_by uuid DEFAULT auth.uid())
 RETURNS journal_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_src public.journal_entries;
  v_lines jsonb;
  v_reversal public.journal_entries;
  v_asset public.fixed_assets;
  v_prepaid public.prepaid_expenses;
  v_context text;
  v_date date;
begin
  -- for update: twee gelijktijdige tegenboekingen van hetzelfde boekstuk
  -- zouden anders allebei de reversed_by-check passeren.
  select * into v_src from public.journal_entries where id = p_entry_id for update;
  if not found then
    raise exception 'Boekstuk niet gevonden.' using errcode = '02000';
  end if;
  if auth.role() <> 'service_role' and not (public.can_write_org(v_src.organization_id) and public.can_write_module(v_src.organization_id, 'finance')) then
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
  -- TOEGEVOEGD (20261104000000): de doorboeking van een btw-aangifte of
  -- suppletie hoort bij een afgesloten aangifte. De spiegelpost viel in een
  -- open periode en telde daar de hele aangifte nog eens mee.
  if v_src.source_type = 'vat_return' then
    raise exception 'De doorboeking van een btw-aangifte boek je niet tegen. Een fout in een afgesloten aangifte corrigeer je met een suppletie.'
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261105233000): een verkoopfactuur en een creditnota zijn
  -- uitgegeven stukken. Los tegenboeken liet de factuur op 'verzonden' staan
  -- met de boeking er nog aan: opnieuw boeken kon niet meer, het openstaande
  -- bedrag werd 0, en daarmee weigerden crediteren, herinneren en de
  -- betaallink. De btw bleef verschuldigd (art. 37 Wet OB 1968), terwijl de
  -- aangifte hem kwijt was. Een betaling heeft een eigen terugweg ("Boeking
  -- ongedaan maken" bij de bank, of een terugbetaling); los tegenboeken liet de
  -- factuur op betaald staan. Die twee interne functies gebruiken deze functie
  -- zelf en mogen dus wel.
  if v_src.source_type in ('sales_invoice', 'credit_note', 'payment') then
    get diagnostics v_context = pg_context;
    if v_context !~* 'function (public\.)?(unbook_bank_transaction|recompute_invoice_chargeback_state)\(' then
      if v_src.source_type = 'sales_invoice' then
        raise exception 'Een verkoopfactuur boek je niet tegen: de factuur is uitgegeven en de btw blijft verschuldigd. Corrigeer met "Crediteren" bij de factuur; dat boekt omzet en btw netjes terug.'
          using errcode = '23514';
      elsif v_src.source_type = 'credit_note' then
        raise exception 'Een creditnota boek je niet tegen: die is uitgegeven. Maak zo nodig een nieuwe factuur.'
          using errcode = '23514';
      else
        raise exception 'Een betaling boek je hier niet tegen. Bij de bank: "Boeking ongedaan maken" bij de transactie. Een Mollie-betaling draai je terug met een terugbetaling.'
          using errcode = '23514';
      end if;
    end if;
  end if;
  -- TOEGEVOEGD (20261105233000): een geboekte inkoopfactuur ligt vast, en de
  -- bewaker verwijst voor een correctie naar tegenboeken. Daarna bleef de
  -- factuur op 'geboekt' staan, met de oude boeking eraan: corrigeren of
  -- opnieuw boeken kon nooit meer. Nu gaat hij mee terug naar concept
  -- (onderaan). Is er al op betaald, dan eerst die betaling: anders blijft de
  -- betaling op 1600 staan zonder factuur ertegenover.
  -- GEWIJZIGD (20261107110000): uit de verdeling, zodat een betaling over
  -- meerdere inkoopfacturen ook telt; de oude kolom blijft als vangnet.
  if v_src.source_type = 'purchase_invoice' and (exists (
    select 1 from public.bank_transaction_allocations a
    join public.journal_entries pje on pje.id = a.journal_entry_id and pje.status = 'posted'
      and pje.reversed_by_entry_id is null and pje.reverses_entry_id is null
    where a.organization_id = v_src.organization_id
      and a.purchase_invoice_id = v_src.source_id
  ) or exists (
    select 1 from public.bank_transactions bt
    where bt.organization_id = v_src.organization_id
      and bt.matched_purchase_invoice_id = v_src.source_id
      and bt.status = 'booked'
  )) then
    raise exception 'Op deze inkoopfactuur is al een betaling afgeletterd. Draai eerst die betaling terug (Bank: "Boeking ongedaan maken"); daarna de inkoopfactuur.'
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261104000000): een tegenboeking tegenboeken maakt een keten
  -- die de rapporten en de beginbalanscontrole niet meer kunnen volgen.
  if v_src.reverses_entry_id is not null then
    raise exception 'Dit boekstuk is zelf een tegenboeking. Boek het oorspronkelijke boekstuk opnieuw in plaats van de tegenboeking tegen te boeken.'
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261104000000): boekingen van activa houden het activaregister
  -- bij. Tegenboeken mag, maar dan gaat het register mee terug (zie onderaan);
  -- eerst wel in de juiste volgorde: desinvestering, afschrijvingen, aanschaf.
  if v_src.source_type = 'asset_acquisition' then
    select * into v_asset from public.fixed_assets
    where id = v_src.source_id and organization_id = v_src.organization_id
    for update;
    if found and v_asset.acquisition_journal_entry_id = v_src.id then
      if v_asset.status = 'disposed'
         or exists (select 1 from public.asset_depreciations ad where ad.asset_id = v_asset.id and ad.status = 'posted') then
        raise exception 'Draai eerst de desinvestering en de geboekte afschrijvingen van "%" terug; daarna de aanschaf.', v_asset.name
          using errcode = '23514';
      end if;
    end if;
  elsif v_src.source_type = 'asset_depreciation' then
    select * into v_asset from public.fixed_assets
    where id = v_src.source_id and organization_id = v_src.organization_id
    for update;
    if found and v_asset.status = 'disposed' then
      raise exception 'Draai eerst de desinvestering van "%" terug; daarna de afschrijving.', v_asset.name
        using errcode = '23514';
    end if;
  elsif v_src.source_type = 'asset_disposal' then
    select * into v_asset from public.fixed_assets
    where id = v_src.source_id and organization_id = v_src.organization_id
    for update;
  end if;
  -- TOEGEVOEGD (20261111220000): vooruitbetaalde kosten, zelfde volgorde:
  -- beëindiging, termijnen, boeking naar de balans.
  if v_src.source_type in ('prepaid_start', 'prepaid_release', 'prepaid_end') then
    select * into v_prepaid from public.prepaid_expenses
    where id = v_src.source_id and organization_id = v_src.organization_id
    for update;
    if found then
      if v_src.source_type = 'prepaid_start' and v_prepaid.start_journal_entry_id = v_src.id
         and (v_prepaid.status = 'ended' or exists (
           select 1 from public.prepaid_expense_releases r
           where r.prepaid_expense_id = v_prepaid.id and r.status = 'posted'
         )) then
        raise exception 'Draai eerst de beëindiging en de geboekte termijnen van "%" terug; daarna de boeking naar de balans.', v_prepaid.description
          using errcode = '23514';
      elsif v_src.source_type = 'prepaid_release' and v_prepaid.status = 'ended'
         and exists (
           select 1 from public.prepaid_expense_releases r
           where r.prepaid_expense_id = v_prepaid.id and r.journal_entry_id = v_src.id
         ) then
        raise exception 'Draai eerst de beëindiging van "%" terug; daarna de termijn.', v_prepaid.description
          using errcode = '23514';
      end if;
    end if;
  end if;

  -- VERVALLEN (20261119180000): een boekstuk dat in een btw-suppletie is verrekend, was
  -- nooit meer tegen te boeken. De aangewezen weg (een memoriaal dat het
  -- spiegelt) deed voor het grootboek en de aangifte precies hetzelfde als een
  -- tegenboeking, maar liet de bron achter: een dubbel ingevoerde inkoopfactuur
  -- bleef voorgoed "geboekt, onbetaald" in de crediteuren en de prognose staan,
  -- en een bankboeking was niet meer ongedaan te maken. De spiegelpost is een
  -- gewoon boekstuk: hij telt in de aangifte van zijn eigen datum, of je
  -- verrekent hem in een nieuwe suppletie.

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

  -- GEWIJZIGD (20261119180000): zonder datum komt de tegenboeking op de datum van het
  -- boekstuk zelf, of op de eerste open dag daarna als dat btw-tijdvak of
  -- boekjaar dicht is. Hier stond de datum van vandaag. Wie in november een
  -- bankboeking of inkoopfactuur uit september terugdraaide en opnieuw boekte,
  -- kreeg de kosten en de btw dubbel in Q3 en negatief in Q4; over de
  -- jaarwissel verschoof zo winst tussen twee boekjaren, en de balans per
  -- 31 december toonde de bank en de debiteuren verkeerd. Op de eigen datum
  -- vallen origineel en tegenboeking in dezelfde periode tegen elkaar weg.
  if p_date is not null then
    v_date := p_date;
  elsif v_src.source_type = 'opening_balance' then
    -- De beginbalans hoort altijd op zijn eigen datum terug: op een andere dag
    -- staat alles dubbel tussen die twee datums.
    v_date := v_src.date;
    if exists (
      select 1 from public.closed_periods cp
      where cp.organization_id = v_src.organization_id and cp.period_type = 'year'
        and v_src.date <= cp.period_end
    ) then
      raise exception 'De beginbalans van % valt in een afgesloten boekjaar. Heropen dat boekjaar eerst bij Boekjaren; daarna kun je de beginbalans corrigeren.',
        to_char(v_src.date, 'DD-MM-YYYY') using errcode = '23514';
    end if;
  else
    v_date := public.first_open_booking_date_for(
      v_src.organization_id, v_src.date, public.journal_lines_touch_vat(v_src.organization_id, v_lines));
  end if;

  v_reversal := public.post_journal_entry(
    v_src.organization_id,
    v_date,
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

  -- TOEGEVOEGD (20261104000000): het activaregister gaat mee terug, zodat
  -- grootboek en register gelijk blijven (anders boekte de desinvestering de
  -- verkeerde cumulatieve afschrijving af, en bleef een tegengeboekte termijn
  -- voorgoed als geboekt staan).
  if v_src.source_type = 'asset_acquisition' then
    update public.fixed_assets
    set acquisition_journal_entry_id = null
    where id = v_src.source_id and organization_id = v_src.organization_id
      and acquisition_journal_entry_id = v_src.id;
  elsif v_src.source_type = 'asset_depreciation' then
    update public.asset_depreciations
    set status = 'scheduled', journal_entry_id = null, posted_at = null
    where journal_entry_id = v_src.id and organization_id = v_src.organization_id;
    update public.fixed_assets
    set status = 'active'
    where id = v_src.source_id and organization_id = v_src.organization_id and status = 'fully_depreciated';
  elsif v_src.source_type = 'asset_disposal' then
    update public.fixed_assets
    set status = 'active', disposal_date = null, disposal_proceeds_cents = null
    where id = v_src.source_id and organization_id = v_src.organization_id and status = 'disposed';
    if found then
      perform public.generate_depreciation_schedule(v_src.organization_id, v_src.source_id);
      if not exists (
        select 1 from public.asset_depreciations ad
        where ad.asset_id = v_src.source_id and ad.status = 'scheduled'
      ) then
        update public.fixed_assets set status = 'fully_depreciated'
        where id = v_src.source_id and organization_id = v_src.organization_id and status = 'active';
      end if;
    end if;
  end if;

  -- TOEGEVOEGD (20261111220000): het register van vooruitbetaalde kosten gaat
  -- mee terug. Een termijn staat weer gepland; na de boeking naar de balans
  -- tegenboeken is de post weer te wijzigen of te verwijderen; na een
  -- beëindiging komt het schema terug vanaf de eerste niet-geboekte maand.
  if v_src.source_type = 'prepaid_start' then
    update public.prepaid_expenses
    set start_journal_entry_id = null
    where id = v_src.source_id and organization_id = v_src.organization_id
      and start_journal_entry_id = v_src.id;
  elsif v_src.source_type = 'prepaid_release' then
    update public.prepaid_expense_releases
    set status = 'scheduled', journal_entry_id = null, posted_at = null
    where journal_entry_id = v_src.id and organization_id = v_src.organization_id;
    if found then
      update public.prepaid_expenses
      set status = 'active'
      where id = v_src.source_id and organization_id = v_src.organization_id and status = 'completed';
    end if;
  elsif v_src.source_type = 'prepaid_end' then
    update public.prepaid_expenses
    set status = 'active', end_date = null, end_amount_cents = null, end_refund_cents = null,
        end_refund_account_id = null, end_journal_entry_id = null
    where id = v_src.source_id and organization_id = v_src.organization_id
      and end_journal_entry_id = v_src.id;
    if found then
      perform public.prepaid_build_schedule(v_src.source_id);
      if not exists (
        select 1 from public.prepaid_expense_releases r
        where r.prepaid_expense_id = v_src.source_id and r.status = 'scheduled'
      ) then
        update public.prepaid_expenses set status = 'completed'
        where id = v_src.source_id and organization_id = v_src.organization_id and status = 'active';
      end if;
    end if;
  end if;

  -- TOEGEVOEGD (20261105233000): de inkoopfactuur gaat terug naar concept, zodat
  -- je hem kunt corrigeren en opnieuw boeken. De inbox volgt.
  if v_src.source_type = 'purchase_invoice' then
    update public.purchase_invoices
    set status = 'draft', journal_entry_id = null, payment_status = 'unpaid', paid_at = null
    where id = v_src.source_id and organization_id = v_src.organization_id
      and journal_entry_id = v_src.id;
    update public.purchase_invoice_inbox
    set status = 'ready'
    where purchase_invoice_id = v_src.source_id and organization_id = v_src.organization_id
      and status = 'booked';
  end if;

  return v_reversal;
end;
$function$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Bank boeken: doorschuiven bij een dicht tijdvak, niets vóór de start, geen btw op geldrekeningen
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.book_bank_transaction(p_organization_id uuid, p_transaction_id uuid, p_lines jsonb DEFAULT NULL::jsonb, p_matched_invoice_id uuid DEFAULT NULL::uuid, p_matched_purchase_invoice_id uuid DEFAULT NULL::uuid, p_created_by uuid DEFAULT auth.uid(), p_allocations jsonb DEFAULT NULL::jsonb, p_description text DEFAULT NULL::text)
 RETURNS journal_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_txn public.bank_transactions;
  v_ba public.bank_accounts;
  v_partner public.bank_transactions;
  v_abs bigint;
  v_dir integer;
  v_items jsonb;
  v_item jsonb;
  v_n integer := 0;
  v_kind text;
  v_amt bigint;        -- in de richting van de transactie (zoals de invoer)
  v_bank_amt bigint;   -- in bankrichting: + geld erbij, − geld eraf
  v_sum bigint := 0;
  v_id uuid;
  v_key text;
  v_seen text[] := '{}';
  v_line_desc text;
  v_desc text;
  v_date date;
  v_lines jsonb;
  v_alloc jsonb := '[]'::jsonb;
  v_entry public.journal_entries;
  v_inv public.invoices;
  v_cn public.credit_notes;
  v_pi public.purchase_invoices;
  v_acc public.ledger_accounts;
  v_vc public.vat_codes;
  v_entry_reversed boolean;
  v_open bigint;
  v_cn_total bigint;
  v_cn_refunded bigint;
  v_room bigint;
  v_used jsonb := '{}'::jsonb;   -- per factuur: tegoed dat deze boeking al terugbetaalt
  v_inv_ids uuid[] := '{}';
  v_pi_ids uuid[] := '{}';
  v_sales_invoice_ids uuid[] := '{}';
  v_vat_payable_id uuid;
  v_vat_payable_booked bigint := 0;
  v_vat_1510 bigint := 0;  -- positief → credit 1510, negatief → debet 1510
  v_vat_1500 bigint := 0;  -- positief → debet 1500, negatief → credit 1500
  v_vat_1520 bigint := 0;  -- positief → credit 1520, negatief → debet 1520
  v_is_credit boolean;
  v_gross bigint;
  v_net bigint;
  v_vat bigint;
  v_rate numeric;
  v_vkind text;
  v_vcode text;
  -- TOEGEVOEGD (20261118090000): de KOR, de code die "geen btw, KOR" vastlegt,
  -- en de grondslag apart van het bedrag op de rekening (verlegd met de KOR).
  v_kor boolean := false;
  v_kor_code text;
  v_base bigint;
  v_client uuid;
  v_supplier uuid;
  v_project uuid;
  v_target_saldo bigint;
  v_match_count integer;
  v_match_id uuid;
  v_bank_date date;
  v_start_date date;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  -- TOEGEVOEGD (20261118090000): met de kleineondernemersregeling rekent deze
  -- administratie geen btw. Een bankboeking splitste toch btw af, met de code
  -- die het scherm bij de rekening voorstelt (HOOG op 4500): € 121 aan kosten
  -- werd € 100 kosten en € 21 voorbelasting, die met de KOR niet bestaat. De
  -- kosten en daarmee de winst klopten dan niet, en 1500 bleef voorgoed op de
  -- balans staan. De inkoopfactuur deed het al goed (book_purchase_invoice).
  select coalesce(cs.kor_enabled, false) into v_kor
  from public.company_settings cs where cs.organization_id = p_organization_id;
  v_kor := coalesce(v_kor, false);
  if v_kor then
    select vc.code into v_kor_code from public.vat_codes vc
    where vc.organization_id = p_organization_id and vc.kind = 'kor'
    order by (vc.code = 'KOR') desc, vc.code
    limit 1;
  end if;

  if p_matched_invoice_id is not null and p_matched_purchase_invoice_id is not null then
    raise exception 'Koppel een transactie aan één factuur: een verkoopfactuur óf een inkoopfactuur. Meer stukken tegelijk gaat met een verdeling.' using errcode = '23514';
  end if;

  select * into v_txn from public.bank_transactions
  where id = p_transaction_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Banktransactie niet gevonden.' using errcode = '02000';
  end if;
  if v_txn.status = 'booked' or v_txn.journal_entry_id is not null then
    raise exception 'Deze transactie is al geboekt.' using errcode = '23514';
  end if;
  if v_txn.status = 'merged' then
    raise exception 'Deze banktransactie is samengevoegd met een handmatige mutatie; die draagt de boeking. Boek de handmatige mutatie, of maak het samenvoegen los.'
      using errcode = '23514';
  end if;
  if upper(coalesce(nullif(btrim(v_txn.currency), ''), 'EUR')) <> 'EUR' then
    raise exception 'Deze banktransactie is in %. Het grootboek boekt in euro''s: reken het bedrag om en boek het met een memoriaalpost.', upper(v_txn.currency)
      using errcode = '23514';
  end if;

  select * into v_ba from public.bank_accounts where id = v_txn.bank_account_id and organization_id = p_organization_id;
  if not found then
    raise exception 'Bankrekening niet gevonden.' using errcode = '02000';
  end if;

  v_abs := abs(v_txn.amount_cents);
  if v_abs = 0 then
    raise exception 'Een transactie van € 0,00 kan niet worden geboekt.' using errcode = '23514';
  end if;
  v_dir := case when v_txn.amount_cents > 0 then 1 else -1 end;

  perform public.ensure_default_ledger_accounts(p_organization_id);
  v_vat_payable_id := public.bookkeeping_account_id(p_organization_id, '1530');

  -- Alles wordt één verdeling. Bedragen in de invoer staan in de richting van
  -- de transactie: positief = mee met het geld (bij een betaling: wat je
  -- betaalt), negatief = de andere kant op (bijvoorbeeld kosten die van een
  -- uitbetaling zijn afgehouden).
  if p_allocations is not null and jsonb_typeof(p_allocations) = 'array' and jsonb_array_length(p_allocations) > 0 then
    if p_lines is not null or p_matched_invoice_id is not null or p_matched_purchase_invoice_id is not null then
      raise exception 'Geef óf een verdeling, óf een factuur, óf regels — niet door elkaar.' using errcode = '23514';
    end if;
    v_items := p_allocations;
  elsif p_matched_invoice_id is not null then
    v_items := jsonb_build_array(jsonb_build_object('kind', 'sales_invoice', 'invoice_id', p_matched_invoice_id, 'amount_cents', v_abs));
  elsif p_matched_purchase_invoice_id is not null then
    v_items := jsonb_build_array(jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', p_matched_purchase_invoice_id, 'amount_cents', v_abs));
  elsif p_lines is not null and jsonb_typeof(p_lines) = 'array' and jsonb_array_length(p_lines) > 0 then
    select jsonb_agg(case when jsonb_typeof(l) = 'object' then l || jsonb_build_object('kind', 'ledger') else l end order by ord)
    into v_items
    from jsonb_array_elements(p_lines) with ordinality as t(l, ord);
  else
    raise exception 'Geen tegenrekening: letter een factuur af of kies een grootboekrekening.' using errcode = '23514';
  end if;
  if jsonb_array_length(v_items) > 100 then
    raise exception 'Een boeking heeft hoogstens 100 regels.' using errcode = '23514';
  end if;

  v_desc := nullif(btrim(coalesce(p_description, '')), '');
  if v_desc is not null and length(v_desc) > 300 then
    raise exception 'De omschrijving van de boeking is te lang (hoogstens 300 tekens).' using errcode = '23514';
  end if;
  v_desc := coalesce(v_desc,
    'Bank ' || coalesce(v_ba.name, '') || ': ' ||
    coalesce(nullif(v_txn.counterparty_name, ''), nullif(v_txn.description, ''), 'transactie'));

  -- Een handmatige mutatie die de bank al bevestigde, boekt op de datum van de bank.
  v_date := v_txn.booking_date;
  if v_txn.is_manual then
    select * into v_partner from public.bank_transactions where merged_into_id = v_txn.id;
    if found then
      v_date := v_partner.booking_date;
    end if;
  end if;
  -- TOEGEVOEGD (20261119180000): de datum van de bank blijft bewaard; de boekdatum kan
  -- verderop naar de eerste open dag schuiven.
  v_bank_date := v_date;

  -- TOEGEVOEGD (20261119180000): wat de bank deed vóór de start van de boekhouding, zit al
  -- in het banksaldo van de beginbalans. De eerste synchronisatie haalt 90
  -- dagen terug en een afschrift begint vaak eerder: een privé-opname van
  -- 10 september bij een start per 1 oktober was gewoon te boeken, en een
  -- incasso van 25 september werd vanzelf afgeletterd tegen de factuur van
  -- oktober. Daarna stond de bank in het grootboek lager dan in het echt en
  -- begon het eigen vermogen € 1.000 te laag. Zelf een mutatie vóór de start
  -- invoeren werd al geweigerd (bank_manual_input_check).
  select cs.bookkeeping_start_date into v_start_date
  from public.company_settings cs where cs.organization_id = p_organization_id;
  if v_start_date is not null and v_bank_date < v_start_date then
    raise exception 'Deze mutatie is van %, vóór de start van je boekhouding in ResoFly (%). Wat er toen op de bank gebeurde, zit al in het banksaldo van je beginbalans. Negeer deze mutatie; boeken zou hem dubbel tellen.',
      to_char(v_bank_date, 'DD-MM-YYYY'), to_char(v_start_date, 'DD-MM-YYYY') using errcode = '23514';
  end if;

  -- Bankregel (debet bij ontvangst, credit bij betaling).
  v_lines := jsonb_build_array(jsonb_build_object(
    'account_id', v_ba.ledger_account_id,
    'description', v_desc,
    'debit_cents', case when v_dir > 0 then v_abs else 0 end,
    'credit_cents', case when v_dir < 0 then v_abs else 0 end
  ));

  for v_item in select value from jsonb_array_elements(v_items)
  loop
    v_n := v_n + 1;
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'Regel % van de verdeling is onleesbaar.', v_n using errcode = '22023';
    end if;
    v_kind := coalesce(nullif(v_item->>'kind', ''), 'ledger');
    if v_kind not in ('sales_invoice', 'sales_credit_note', 'purchase_invoice', 'ledger') then
      raise exception 'Regel %: onbekende soort "%".', v_n, v_kind using errcode = '22023';
    end if;
    if coalesce(v_item->>'amount_cents', '') !~ '^-?[0-9]{1,15}$' then
      raise exception 'Regel %: geef een bedrag (in hele centen).', v_n using errcode = '22023';
    end if;
    v_amt := (v_item->>'amount_cents')::bigint;
    if v_amt = 0 then
      -- Een lege regel sloeg de oude boeking ook over.
      if v_kind = 'ledger' then continue; end if;
      raise exception 'Regel %: geef een bedrag.', v_n using errcode = '22023';
    end if;
    v_bank_amt := v_amt * v_dir;
    v_sum := v_sum + v_amt;
    v_line_desc := nullif(btrim(coalesce(v_item->>'description', '')), '');
    if v_line_desc is not null and length(v_line_desc) > 300 then
      raise exception 'Regel %: de omschrijving is te lang (hoogstens 300 tekens).', v_n using errcode = '23514';
    end if;

    if v_kind = 'sales_invoice' then
      v_id := public.bank_parse_uuid(v_item->>'invoice_id');
      if v_id is null then
        raise exception 'Regel %: kies een verkoopfactuur.', v_n using errcode = '22023';
      end if;
      v_key := 'i:' || v_id::text;
      if v_key = any(v_seen) then
        raise exception 'Regel %: deze factuur staat al op een andere regel.', v_n using errcode = '23514';
      end if;
      v_seen := v_seen || v_key;
      if v_bank_amt <= 0 then
        raise exception 'Regel %: een verkoopfactuur betaalt de klant aan jou; dat gaat alleen met geld dat binnenkomt. Een terugbetaling koppel je aan de creditnota.', v_n
          using errcode = '23514';
      end if;
      -- for update: gelijktijdig twee ontvangsten op dezelfde factuur boeken zou
      -- anders allebei de openstaand-check passeren.
      select * into v_inv from public.invoices
      where id = v_id and organization_id = p_organization_id for update;
      if not found then
        raise exception 'Regel %: verkoopfactuur niet gevonden.', v_n using errcode = '02000';
      end if;
      if v_inv.status in ('cancelled', 'void') then
        raise exception 'Factuur % is geannuleerd; daar letter je niets meer op af.', coalesce(v_inv.number, '') using errcode = '23514';
      end if;
      -- Afletteren kan alleen tegen een factuur die in het grootboek staat. Zonder
      -- debitering van 1300 zou de creditering hier Debiteuren negatief maken.
      if v_inv.journal_entry_id is null then
        raise exception 'Factuur % staat nog niet in het grootboek. Boek de factuur eerst ("Boek naar grootboek") en letter daarna af.', coalesce(v_inv.number, '')
          using errcode = '23514';
      end if;
      select je.reversed_by_entry_id is not null into v_entry_reversed
      from public.journal_entries je where je.id = v_inv.journal_entry_id;
      if coalesce(v_entry_reversed, false) then
        raise exception 'De grootboekboeking van factuur % is tegengeboekt; er valt niets meer af te letteren.', coalesce(v_inv.number, '')
          using errcode = '23514';
      end if;
      v_open := public.invoice_open_receivable_cents(p_organization_id, v_inv.id, v_txn.id);
      if v_open <= 0 then
        raise exception 'Factuur % is al volledig afgeletterd.', coalesce(v_inv.number, '') using errcode = '23514';
      end if;
      if v_bank_amt > v_open then
        raise exception 'Ontvangst (%) is hoger dan het openstaande saldo van factuur % (%). Zet op die regel hoogstens het openstaande bedrag en boek de rest op een eigen regel (bijvoorbeeld een grootboekrekening).',
          public.bank_eur(v_bank_amt), coalesce(v_inv.number, ''), public.bank_eur(v_open)
          using errcode = '23514';
      end if;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, '1300'),
        'description', coalesce(v_line_desc, 'Debiteuren — factuur ' || coalesce(v_inv.number, '')),
        'debit_cents', 0, 'credit_cents', v_bank_amt,
        'client_id', v_inv.client_id
      ));
      v_alloc := v_alloc || jsonb_build_array(jsonb_build_object(
        'kind', 'sales_invoice', 'invoice_id', v_inv.id, 'client_id', v_inv.client_id,
        'amount_cents', v_bank_amt, 'description', v_line_desc));
      v_inv_ids := v_inv_ids || v_inv.id;
      v_sales_invoice_ids := v_sales_invoice_ids || v_inv.id;

    elsif v_kind = 'sales_credit_note' then
      v_id := public.bank_parse_uuid(v_item->>'credit_note_id');
      if v_id is null then
        raise exception 'Regel %: kies een creditnota.', v_n using errcode = '22023';
      end if;
      v_key := 'c:' || v_id::text;
      if v_key = any(v_seen) then
        raise exception 'Regel %: deze creditnota staat al op een andere regel.', v_n using errcode = '23514';
      end if;
      v_seen := v_seen || v_key;
      if v_bank_amt >= 0 then
        raise exception 'Regel %: een creditnota betaal je terug aan de klant; dat gaat alleen met geld dat van je rekening gaat.', v_n
          using errcode = '23514';
      end if;
      select * into v_cn from public.credit_notes
      where id = v_id and organization_id = p_organization_id for update;
      if not found then
        raise exception 'Regel %: creditnota niet gevonden.', v_n using errcode = '02000';
      end if;
      if v_cn.status <> 'issued' then
        raise exception 'Creditnota % is niet uitgegeven (status: %).', v_cn.number, v_cn.status using errcode = '23514';
      end if;
      if v_cn.journal_entry_id is null then
        raise exception 'Creditnota % staat nog niet in het grootboek. Boek hem eerst; daarna koppel je de terugbetaling.', v_cn.number
          using errcode = '23514';
      end if;
      select je.reversed_by_entry_id is not null into v_entry_reversed
      from public.journal_entries je where je.id = v_cn.journal_entry_id;
      if coalesce(v_entry_reversed, false) then
        raise exception 'De grootboekboeking van creditnota % is tegengeboekt; er valt niets terug te betalen.', v_cn.number
          using errcode = '23514';
      end if;
      select * into v_inv from public.invoices
      where id = v_cn.invoice_id and organization_id = p_organization_id for update;
      if not found then
        raise exception 'De factuur bij creditnota % is niet gevonden.', v_cn.number using errcode = '02000';
      end if;
      -- Wat de klant op deze factuur tegoed heeft: een negatief openstaand saldo
      -- (de creditnota kwam na de betaling). Min wat deze boeking op een andere
      -- regel al terugbetaalt.
      v_open := public.invoice_open_receivable_cents(p_organization_id, v_inv.id, v_txn.id)
              + coalesce((v_used->>v_inv.id::text)::bigint, 0);
      if v_open >= 0 then
        raise exception 'Op factuur % staat geen tegoed voor de klant (openstaand %): creditnota % is verrekend met wat er nog openstond. Er valt niets terug te betalen.',
          coalesce(v_inv.number, ''), public.bank_eur(greatest(v_open, 0)), v_cn.number
          using errcode = '23514';
      end if;
      select coalesce(sum(jl.credit_cents - jl.debit_cents), 0) into v_cn_total
      from public.journal_lines jl
      join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_receivable'
      where jl.entry_id = v_cn.journal_entry_id;
      select coalesce(sum(-a.amount_cents), 0) into v_cn_refunded
      from public.bank_transaction_allocations a
      join public.journal_entries je on je.id = a.journal_entry_id and je.status = 'posted'
        and je.reversed_by_entry_id is null and je.reverses_entry_id is null
      where a.organization_id = p_organization_id and a.credit_note_id = v_cn.id
        and a.bank_transaction_id <> v_txn.id;
      v_room := least(v_cn_total - v_cn_refunded, -v_open);
      if -v_bank_amt > v_room then
        raise exception 'Terugbetaling (%) is hoger dan wat er van creditnota % nog terug te betalen is (%).',
          public.bank_eur(-v_bank_amt), v_cn.number, public.bank_eur(greatest(v_room, 0))
          using errcode = '23514';
      end if;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, '1300'),
        'description', coalesce(v_line_desc, 'Terugbetaling creditnota ' || v_cn.number || ' (factuur ' || coalesce(v_inv.number, '') || ')'),
        'debit_cents', -v_bank_amt, 'credit_cents', 0,
        'client_id', v_inv.client_id
      ));
      v_alloc := v_alloc || jsonb_build_array(jsonb_build_object(
        'kind', 'sales_credit_note', 'credit_note_id', v_cn.id, 'invoice_id', v_inv.id, 'client_id', v_inv.client_id,
        'amount_cents', v_bank_amt, 'description', v_line_desc));
      v_used := v_used || jsonb_build_object(v_inv.id::text, coalesce((v_used->>v_inv.id::text)::bigint, 0) - v_bank_amt);
      v_inv_ids := v_inv_ids || v_inv.id;

    elsif v_kind = 'purchase_invoice' then
      v_id := public.bank_parse_uuid(v_item->>'purchase_invoice_id');
      if v_id is null then
        raise exception 'Regel %: kies een inkoopfactuur.', v_n using errcode = '22023';
      end if;
      v_key := 'p:' || v_id::text;
      if v_key = any(v_seen) then
        raise exception 'Regel %: deze inkoopfactuur staat al op een andere regel.', v_n using errcode = '23514';
      end if;
      v_seen := v_seen || v_key;
      select * into v_pi from public.purchase_invoices
      where id = v_id and organization_id = p_organization_id for update;
      if not found then
        raise exception 'Regel %: inkoopfactuur niet gevonden.', v_n using errcode = '02000';
      end if;
      if v_pi.status = 'cancelled' then
        raise exception 'Inkoopfactuur % is geannuleerd.', coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '') using errcode = '23514';
      end if;
      if v_pi.journal_entry_id is null then
        raise exception 'Inkoopfactuur % staat nog niet in het grootboek. Boek de inkoopfactuur eerst en letter daarna af.',
          coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '') using errcode = '23514';
      end if;
      select je.reversed_by_entry_id is not null into v_entry_reversed
      from public.journal_entries je where je.id = v_pi.journal_entry_id;
      if coalesce(v_entry_reversed, false) then
        raise exception 'De grootboekboeking van inkoopfactuur % is tegengeboekt; er valt niets meer af te letteren.',
          coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '') using errcode = '23514';
      end if;
      v_open := public.purchase_invoice_open_payable_cents(p_organization_id, v_pi.id);
      if v_open = 0 then
        raise exception 'Inkoopfactuur % is al volledig afgeletterd.',
          coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '') using errcode = '23514';
      end if;
      if v_open > 0 then
        if v_bank_amt >= 0 then
          raise exception 'Regel %: inkoopfactuur % betaal je aan de leverancier; dat gaat alleen met geld dat van je rekening gaat.',
            v_n, coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '') using errcode = '23514';
        end if;
        if -v_bank_amt > v_open then
          raise exception 'Betaling (%) is hoger dan het openstaande saldo van inkoopfactuur % (%). Zet op die regel hoogstens het openstaande bedrag en boek de rest op een eigen regel.',
            public.bank_eur(-v_bank_amt), coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, ''), public.bank_eur(v_open)
            using errcode = '23514';
        end if;
      else
        -- Een creditnota van de leverancier: hij is jou geld schuldig.
        if v_bank_amt <= 0 then
          raise exception 'Regel %: % is een creditnota van de leverancier; daar hoort geld bij dat binnenkomt.',
            v_n, coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '') using errcode = '23514';
        end if;
        if v_bank_amt > -v_open then
          raise exception 'Ontvangst (%) is hoger dan wat de leverancier op % nog terug moet betalen (%).',
            public.bank_eur(v_bank_amt), coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, ''), public.bank_eur(-v_open)
            using errcode = '23514';
        end if;
      end if;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, '1600'),
        'description', coalesce(v_line_desc, 'Crediteuren — ' || coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '')),
        'debit_cents', case when v_bank_amt < 0 then -v_bank_amt else 0 end,
        'credit_cents', case when v_bank_amt > 0 then v_bank_amt else 0 end,
        'supplier_id', v_pi.supplier_id
      ));
      v_alloc := v_alloc || jsonb_build_array(jsonb_build_object(
        'kind', 'purchase_invoice', 'purchase_invoice_id', v_pi.id, 'supplier_id', v_pi.supplier_id,
        'amount_cents', v_bank_amt, 'description', v_line_desc));
      v_pi_ids := v_pi_ids || v_pi.id;

    else
      -- Rechtstreeks op een grootboekrekening, bruto bedrag met btw-code.
      v_id := public.bank_parse_uuid(v_item->>'account_id');
      if v_id is null and nullif(btrim(coalesce(v_item->>'account_code', '')), '') is not null then
        select la.id into v_id from public.ledger_accounts la
        where la.organization_id = p_organization_id and la.code = btrim(v_item->>'account_code');
      end if;
      if v_id is null then
        raise exception 'Regel %: kies een grootboekrekening.', v_n using errcode = '22023';
      end if;
      select * into v_acc from public.ledger_accounts where id = v_id and organization_id = p_organization_id;
      if not found then
        raise exception 'Regel %: grootboekrekening niet gevonden.', v_n using errcode = '02000';
      end if;
      if not v_acc.is_active then
        raise exception 'Regel %: % · % staat op inactief.', v_n, v_acc.code, v_acc.name using errcode = '23514';
      end if;
      if v_acc.id = v_ba.ledger_account_id then
        raise exception 'Regel %: % is de grootboekrekening van deze bankrekening zelf. Kies de tegenrekening.', v_n, v_acc.code
          using errcode = '23514';
      end if;

      -- TOEGEVOEGD (20261119180000): de btw-rekeningen houdt de aangifte zelf bij. Een
      -- teruggave van € 315 op "1500 Te vorderen BTW" (de naam nodigt ertoe
      -- uit) telde in het volgende kwartaal als −€ 315 voorbelasting: 5g werd
      -- € 525 in plaats van € 210, zonder waarschuwing, en 1530 bleef open.
      if v_acc.subtype in ('vat_input', 'vat_output', 'vat_reverse') then
        raise exception 'Regel %: % · % houdt de btw-aangifte zelf bij; daar boek je niet rechtstreeks op. Een betaling aan of een teruggave van de Belastingdienst boek je op 1530 Te betalen omzetbelasting.',
          v_n, v_acc.code, v_acc.name using errcode = '23514';
      end if;

      v_vcode := nullif(btrim(coalesce(v_item->>'vat_code', '')), '');
      if v_vcode is not null then
        select * into v_vc from public.vat_codes where organization_id = p_organization_id and code = v_vcode;
        if not found then
          raise exception 'Regel %: btw-code % bestaat niet.', v_n, v_vcode using errcode = '22023';
        end if;
        v_rate := v_vc.rate;
        v_vkind := coalesce(v_vc.kind, 'standard');
      else
        -- Zonder code een los tarief, zoals de oude regels het mochten meesturen.
        if coalesce(v_item->>'vat_rate', '') !~ '^([0-9]{1,2}(\.[0-9]{1,2})?)?$' then
          raise exception 'Regel %: ongeldig btw-tarief.', v_n using errcode = '22023';
        end if;
        v_rate := coalesce(nullif(v_item->>'vat_rate', '')::numeric, 0);
        v_vkind := 'standard';
      end if;

      v_client := public.bank_parse_uuid(v_item->>'client_id');
      v_supplier := public.bank_parse_uuid(v_item->>'supplier_id');
      v_project := public.bank_parse_uuid(v_item->>'project_id');
      if (nullif(btrim(coalesce(v_item->>'client_id', '')), '') is not null and v_client is null)
         or (nullif(btrim(coalesce(v_item->>'supplier_id', '')), '') is not null and v_supplier is null)
         or (nullif(btrim(coalesce(v_item->>'project_id', '')), '') is not null and v_project is null) then
        raise exception 'Regel %: ongeldige klant, leverancier of project.', v_n using errcode = '22023';
      end if;
      if v_client is not null then
        if not (v_acc.subtype = 'accounts_receivable' or v_acc.type = 'revenue') then
          raise exception 'Regel %: een klant hoort op een debiteuren- of omzetrekening; % is dat niet.', v_n, v_acc.code using errcode = '23514';
        end if;
        if not exists (select 1 from public.clients c where c.id = v_client and c.organization_id = p_organization_id) then
          raise exception 'Regel %: klant niet gevonden.', v_n using errcode = '02000';
        end if;
      end if;
      if v_supplier is not null then
        if coalesce(v_acc.subtype, '') <> 'accounts_payable' then
          raise exception 'Regel %: een leverancier hoort op een crediteurenrekening; % is dat niet.', v_n, v_acc.code using errcode = '23514';
        end if;
        if not exists (select 1 from public.suppliers s where s.id = v_supplier and s.organization_id = p_organization_id) then
          raise exception 'Regel %: leverancier niet gevonden.', v_n using errcode = '02000';
        end if;
      end if;
      if v_project is not null
         and not exists (select 1 from public.projects p where p.id = v_project and p.organization_id = p_organization_id) then
        raise exception 'Regel %: project niet gevonden.', v_n using errcode = '02000';
      end if;

      -- Onthoud wat er op 1530 Te betalen omzetbelasting valt (voor de
      -- automatische koppeling met de aangifte hieronder).
      if v_acc.id = v_vat_payable_id then
        v_vat_payable_booked := v_vat_payable_booked + v_amt;
      end if;

      -- De kant volgt het geld van DEZE regel: geld erbij → tegenregel credit.
      -- De btw kijkt naar vat_codes.kind én naar de aard van de rekening
      -- (zoals sinds 20261104010000), per regel in plaats van per transactie.
      -- TOEGEVOEGD (20261118090000): op eigen vermogen (privé-opnamen en
      -- -stortingen) hoort geen btw. Wie in het scherm eerst 4500 koos (code
      -- HOOG) en daarna 0550 Privé-opnamen, hield de code; dan boekte een
      -- privé-uitgave van € 121 € 21 voorbelasting, die in rubriek 5b terugkwam.
      -- TOEGEVOEGD (20261119180000): btw hoort bij omzet, kosten en bedrijfsmiddelen, niet
      -- bij geld dat alleen van plek wisselt. Wie eerst een kostenrekening koos
      -- en daarna Kas of Debiteuren, hield de code: een kasopname van € 500 met
      -- 21% boekte € 86,78 voorbelasting, en een oude debiteur van € 121 op
      -- 1300 liet € 21 op 1300 staan en gaf −€ 21 in rubriek 5b.
      if (coalesce(v_rate, 0) <> 0 or v_vkind in ('reverse_charge_purchase', 'eu_acquisition', 'import_non_eu'))
         and (coalesce(v_acc.subtype, '') in ('cash', 'bank', 'psp_clearing', 'accounts_receivable', 'accounts_payable',
                                              'vat_payable', 'accumulated_depreciation')
              or v_acc.type = 'liability') then
        raise exception 'Regel %: op % · % hoort geen btw. Btw kies je bij omzet, kosten of een bedrijfsmiddel; hier wisselt alleen geld van plek. Kies "Geen btw".',
          v_n, v_acc.code, v_acc.name using errcode = '23514';
      end if;
      -- TOEGEVOEGD (20261119180000): een verkoopcode op kosten of een bedrijfsmiddel. Wie
      -- voor Google Ads uit Ierland "ICP diensten" koos, kreeg een boeking in
      -- geen enkele rubriek: 4b bleef leeg, en met de KOR werd de verlegde btw
      -- nooit betaald.
      if v_vcode is not null and v_vkind in ('icp_goods', 'icp_services', 'reverse_charge_sales')
         and v_acc.type in ('expense', 'asset') then
        raise exception 'Regel %: btw-code % is voor verkoop. Voor een inkoop uit de EU kies je "Verwerving EU", voor een dienst van buiten de EU "Invoer buiten EU" en voor verlegde btw binnen Nederland "BTW verlegd (inkoop)".',
          v_n, v_vcode using errcode = '23514';
      end if;
      if v_acc.type = 'equity' and coalesce(v_rate, 0) <> 0 then
        raise exception 'Regel %: op % · % (eigen vermogen) hoort geen btw. Geld voor jezelf of uit eigen zak heeft geen btw, en op privé-uitgaven trek je geen voorbelasting af. Kies "Geen btw".',
          v_n, v_acc.code, v_acc.name using errcode = '23514';
      end if;

      v_is_credit := v_bank_amt > 0;
      v_gross := abs(v_amt);
      v_base := null;
      if v_kor and v_vkind in ('reverse_charge_purchase', 'eu_acquisition', 'import_non_eu') then
        -- TOEGEVOEGD (20261118090000): ook met de KOR geef je verlegde btw aan
        -- (2a/4a/4b) en betaal je hem, maar aftrekken kan niet: de btw komt bij
        -- de kosten, zoals bij een inkoopfactuur. De grondslag blijft het
        -- bedrag dat de leverancier kreeg.
        v_vat := round(v_gross * v_rate / 100.0);
        v_net := v_gross + v_vat;
        v_base := v_gross;
        if v_is_credit then
          v_vat_1520 := v_vat_1520 - v_vat;
        else
          v_vat_1520 := v_vat_1520 + v_vat;
        end if;
      elsif v_kor and v_vkind not in ('reverse_charge_purchase', 'eu_acquisition', 'import_non_eu') and coalesce(v_rate, 0) <> 0 then
        -- TOEGEVOEGD (20261118090000): KOR, geen btw. Het hele bedrag gaat op
        -- de rekening en de regel krijgt de code KOR, die in geen rubriek
        -- telt. Een 0%-code (vrijgesteld, export, ICP) blijft zoals gekozen.
        v_net := v_gross;
        v_vat := 0;
        v_vcode := v_kor_code;
        v_rate := 0;
      elsif v_vkind in ('reverse_charge_purchase', 'eu_acquisition', 'import_non_eu') then
        -- Verlegd/EU-verwerving/invoer: het volle bedrag is de grondslag; btw
        -- zelf aangeven én aftrekken.
        v_net := v_gross;
        v_vat := round(v_gross * v_rate / 100.0);
        if v_is_credit then
          v_vat_1500 := v_vat_1500 - v_vat;
          v_vat_1520 := v_vat_1520 - v_vat;
        else
          v_vat_1500 := v_vat_1500 + v_vat;
          v_vat_1520 := v_vat_1520 + v_vat;
        end if;
      else
        -- Inclusief-btw-splitsing (bruto → netto + btw), centneutraal.
        v_net := round(v_gross / (1 + v_rate / 100.0));
        v_vat := v_gross - v_net;
        if v_acc.type = 'revenue' then
          v_vat_1510 := v_vat_1510 + case when v_is_credit then v_vat else -v_vat end;
        elsif v_acc.type in ('expense', 'asset') then
          v_vat_1500 := v_vat_1500 + case when v_is_credit then -v_vat else v_vat end;
        else
          if v_is_credit then
            v_vat_1510 := v_vat_1510 + v_vat;
          else
            v_vat_1500 := v_vat_1500 + v_vat;
          end if;
        end if;
      end if;

      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_acc.id,
        'description', coalesce(v_line_desc, nullif(v_txn.counterparty_name, ''), nullif(v_txn.description, ''),
                                case when v_is_credit then 'Ontvangst' else 'Betaling' end),
        'debit_cents', case when v_is_credit then 0 else v_net end,
        'credit_cents', case when v_is_credit then v_net else 0 end,
        'vat_code', v_vcode, 'vat_rate', v_rate,
        -- Rubriekconsistentie: op omzetregels telt compute_vat_return
        -- vat_amount_cents op naast credit−debit; een debet-omzetregel
        -- (terugbetaling) moet dus een negatieve grondslag/btw dragen.
        'vat_base_cents', case when v_acc.type = 'revenue' and not v_is_credit then -coalesce(v_base, v_net) else coalesce(v_base, v_net) end,
        'vat_amount_cents', case when v_acc.type = 'revenue' and not v_is_credit then -v_vat else v_vat end,
        'client_id', v_client, 'supplier_id', v_supplier, 'project_id', v_project
      ));
      v_alloc := v_alloc || jsonb_build_array(jsonb_build_object(
        'kind', 'ledger', 'account_id', v_acc.id, 'vat_code', v_vcode,
        'client_id', v_client, 'supplier_id', v_supplier, 'project_id', v_project,
        'amount_cents', v_bank_amt, 'description', v_line_desc));
    end if;
  end loop;

  if jsonb_array_length(v_alloc) = 0 then
    raise exception 'Geen tegenrekening: letter een factuur af of kies een grootboekrekening.' using errcode = '23514';
  end if;
  if v_sum <> v_abs then
    raise exception 'De regels tellen op tot %, maar de transactie is %. Verdeel precies het hele bedrag (verschil %).',
      public.bank_eur(v_sum), public.bank_eur(v_abs), public.bank_eur(abs(v_abs - v_sum))
      using errcode = '23514';
  end if;

  if v_vat_1510 <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1510'),
      'description', 'Af te dragen BTW',
      'debit_cents', case when v_vat_1510 < 0 then -v_vat_1510 else 0 end,
      'credit_cents', case when v_vat_1510 > 0 then v_vat_1510 else 0 end));
  end if;
  if v_vat_1500 <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1500'),
      'description', 'Voorbelasting',
      'debit_cents', case when v_vat_1500 > 0 then v_vat_1500 else 0 end,
      'credit_cents', case when v_vat_1500 < 0 then -v_vat_1500 else 0 end));
  end if;
  if v_vat_1520 <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1520'),
      'description', 'Verschuldigde BTW verlegd/ICP',
      'debit_cents', case when v_vat_1520 < 0 then -v_vat_1520 else 0 end,
      'credit_cents', case when v_vat_1520 > 0 then v_vat_1520 else 0 end));
  end if;

  -- GEWIJZIGD (20261119180000): valt de datum van de bank in een afgesloten btw-tijdvak
  -- (en raakt de boeking de aangifte) of in een afgesloten boekjaar, dan komt
  -- de boeking op de eerste open dag daarna, zoals bij facturen,
  -- inkoopfacturen en activa. De bank was de enige die hier weigerde, met "kies
  -- een boekdatum in de eerstvolgende open periode", terwijl een bankmutatie
  -- geen datum heeft om te kiezen: een pinbetaling van 25 september was na het
  -- afsluiten van Q3 nooit meer met btw te boeken, en wie een boeking in een
  -- dicht tijdvak terugdraaide, kreeg hem er niet meer in. De datum van de bank
  -- blijft op de mutatie staan en komt in de omschrijving.
  v_date := public.first_open_booking_date_for(
    p_organization_id, v_bank_date, public.journal_lines_touch_vat(p_organization_id, v_lines));

  v_entry := public.post_journal_entry(
    p_organization_id, v_date,
    case when v_date <> v_bank_date
         then left(v_desc, 300) || ' (bankdatum ' || to_char(v_bank_date, 'DD-MM-YYYY') || ', geboekt in eerstvolgende open periode)'
         else v_desc end,
    'payment', v_txn.id, v_lines, p_created_by
  );

  -- De verdeling eerst: de trigger op bank_transactions rekent de betaalstatus
  -- van inkoopfacturen hiermee uit.
  insert into public.bank_transaction_allocations(
    organization_id, bank_transaction_id, journal_entry_id, position, kind,
    invoice_id, credit_note_id, purchase_invoice_id, account_id, vat_code,
    client_id, supplier_id, project_id, amount_cents, description, created_by
  )
  select
    p_organization_id, v_txn.id, v_entry.id, (e.ord - 1)::integer, e.a->>'kind',
    public.bank_parse_uuid(e.a->>'invoice_id'), public.bank_parse_uuid(e.a->>'credit_note_id'),
    public.bank_parse_uuid(e.a->>'purchase_invoice_id'), public.bank_parse_uuid(e.a->>'account_id'),
    nullif(e.a->>'vat_code', ''),
    public.bank_parse_uuid(e.a->>'client_id'), public.bank_parse_uuid(e.a->>'supplier_id'), public.bank_parse_uuid(e.a->>'project_id'),
    (e.a->>'amount_cents')::bigint, nullif(e.a->>'description', ''), p_created_by
  from jsonb_array_elements(v_alloc) with ordinality as e(a, ord);

  -- De matchvelden beschrijven wat deze boeking DAADWERKELIJK deed, en alleen
  -- als dat één factuur was (voor wie ze nog leest). Rekenen gaat via de verdeling.
  update public.bank_transactions set
    status = 'booked',
    journal_entry_id = v_entry.id,
    matched_invoice_id = case when cardinality(v_sales_invoice_ids) = 1 then v_sales_invoice_ids[1] end,
    matched_purchase_invoice_id = case when cardinality(v_pi_ids) = 1 then v_pi_ids[1] end,
    booking_date = v_bank_date,
    booked_at = now(),
    booked_by = p_created_by,
    updated_at = now()
  where id = v_txn.id;

  -- Volledig betaald → betaald. Anders liep de factuur naar "achterstallig" en
  -- kreeg de klant herinneringen voor een al betaalde factuur.
  update public.invoices i
  set status = 'paid',
      paid_at = coalesce(i.paid_at, (v_bank_date::timestamp + time '12:00') at time zone 'Europe/Amsterdam'),
      updated_at = now()
  where i.organization_id = p_organization_id
    and i.id = any(v_inv_ids)
    and i.status in ('sent', 'overdue')
    and public.invoice_open_receivable_cents(p_organization_id, i.id) <= 0;

  for v_id in select distinct x from unnest(v_pi_ids) as x
  loop
    perform public.refresh_purchase_invoice_payment_status(p_organization_id, v_id);
  end loop;

  -- Lus sluiten: viel deze boeking op 1530 Te betalen omzetbelasting? Zoek dan de
  -- afgeronde aangifte (finalized/filed) met datzelfde saldo in dezelfde richting.
  -- Altijd op het AFGERONDE saldo (hele euro's); alleen bij één aangifte.
  if v_vat_payable_booked > 0 then
    v_target_saldo := case when v_txn.amount_cents < 0 then v_vat_payable_booked else -v_vat_payable_booked end;
    select count(*) into v_match_count
    from public.vat_returns
    where organization_id = p_organization_id
      and status in ('finalized', 'filed')
      and coalesce(
        (rubrieken->>'saldo_afgerond')::bigint,
        round((rubrieken->>'saldo')::bigint::numeric / 100.0)::bigint * 100
      ) = v_target_saldo;
    if v_match_count = 1 then
      select id into v_match_id
      from public.vat_returns
      where organization_id = p_organization_id
        and status in ('finalized', 'filed')
        and coalesce(
          (rubrieken->>'saldo_afgerond')::bigint,
          round((rubrieken->>'saldo')::bigint::numeric / 100.0)::bigint * 100
        ) = v_target_saldo
      limit 1;
      update public.vat_returns
      set status = 'paid', paid_bank_transaction_id = v_txn.id, updated_at = now()
      where id = v_match_id;
    end if;
  end if;

  return v_entry;
end;
$function$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Aansluiting van de bank: zonder mutaties van vóór de start, met doorgeschoven boekingen
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.report_bank_reconciliation(p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_out jsonb;
  v_start date;
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  -- TOEGEVOEGD (20261119180000): mutaties van vóór de start van de boekhouding zitten al
  -- in het banksaldo van de beginbalans. Ze telden hier als "nog te boeken" of
  -- "genegeerd" mee: wie zo'n mutatie (terecht) negeerde, hield een blijvend
  -- verschil terwijl het grootboek klopte. Het verschil verdween alleen door
  -- de mutatie fout te boeken.
  select cs.bookkeeping_start_date into v_start
  from public.company_settings cs where cs.organization_id = p_organization_id;

  select coalesce(jsonb_agg(s.row_json order by s.acc_name), '[]'::jsonb) into v_out
  from (
    select
      ba.name as acc_name,
      jsonb_build_object(
        'bank_account_id', ba.id,
        'name', ba.name,
        'iban', ba.iban,
        'source', ba.source,
        'ledger_code', la.code,
        'ledger_name', la.name,
        -- Meerdere bankrekeningen op dezelfde grootboekrekening (standaard boekt
        -- alles op 1100): dan is de stand van die rekening de SOM van beide en
        -- kun je niet per rekening aansluiten. De UI waarschuwt daarvoor.
        'shares_ledger_account', shr.shared,
        'as_of', st.period_end,
        'statement_id', st.id,
        'statement_closing_cents', st.closing_balance_cents,
        'ledger_balance_cents', led.balance_cents,
        'has_opening_balance', coalesce(led.has_opening, false),
        'unbooked_count', tx.unbooked_count,
        'unbooked_sum_cents', tx.unbooked_sum,
        'ignored_count', tx.ignored_count,
        'ignored_sum_cents', tx.ignored_sum,
        'booked_count', tx.booked_count,
        'manual_count', tx.manual_count,
        'timing_count', tim.n + shf.n,
        'timing_sum_cents', tim.sum_cents + shf.sum_cents,
        'manual_unconfirmed_count', man.n,
        'manual_unconfirmed_sum_cents', man.sum_cents,
        'expected_cents', led.balance_cents + tx.unbooked_sum + tx.ignored_sum + tim.sum_cents + shf.sum_cents,
        -- Delen meerdere bankrekeningen dezelfde grootboekrekening, dan is die stand
        -- de SOM van al die rekeningen en is een verschil per rekening betekenisloos.
        -- Liever geen getal dan een fout getal: null, en de UI legt uit waarom.
        'difference_cents', case
          when st.closing_balance_cents is null or shr.shared then null
          else st.closing_balance_cents - (led.balance_cents + tx.unbooked_sum + tx.ignored_sum + tim.sum_cents + shf.sum_cents)
        end,
        'duplicate_suspects', dup.n,
        'statement_issues', iss.items
      ) as row_json
    from public.bank_accounts ba
    join public.ledger_accounts la on la.id = ba.ledger_account_id
    cross join lateral (
      select count(*) > 1 as shared
      from public.bank_accounts b2
      where b2.organization_id = p_organization_id
        and b2.ledger_account_id = ba.ledger_account_id
    ) shr
    -- Laatste afschrift mét eindsaldo; dat is de peildatum van de aansluiting.
    left join lateral (
      select s2.id, s2.period_end, s2.closing_balance_cents
      from public.bank_statements s2
      where s2.bank_account_id = ba.id and s2.closing_balance_cents is not null
      order by s2.period_end desc nulls last, s2.imported_at desc
      limit 1
    ) st on true
    cross join lateral (
      select
        coalesce(sum(jl.debit_cents - jl.credit_cents), 0) as balance_cents,
        bool_or(je.source_type = 'opening_balance') as has_opening
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.entry_id and je.status = 'posted'
      where jl.organization_id = p_organization_id
        and jl.account_id = ba.ledger_account_id
        -- Tegenboekingsparen tellen niet mee. Sinds Blok A blijft het origineel
        -- 'posted' en krijgt de spiegelpost de datum van vandáág — die valt dus
        -- buiten de peildatum terwijl het origineel erbinnen valt. Zonder deze
        -- uitsluiting telt elke teruggedraaide bankboeking dubbel: één keer in het
        -- grootboek en nog eens in "nog te boeken". Een paar is netto nul, dus
        -- beide zijden weglaten is datumonafhankelijk correct.
        and je.reversed_by_entry_id is null
        and je.reverses_entry_id is null
        and (st.period_end is null or je.date <= st.period_end)
    ) led
    cross join lateral (
      select
        count(*) filter (where t.status = 'booked') as booked_count,
        count(*) filter (where t.is_manual) as manual_count,
        count(*) filter (where not t.is_manual and (v_start is null or t.booking_date >= v_start)
                           and (t.status in ('unmatched','suggested')
                           or (t.status = 'merged' and m.status in ('unmatched','suggested')))) as unbooked_count,
        coalesce(sum(t.amount_cents) filter (where not t.is_manual and (v_start is null or t.booking_date >= v_start)
                           and (t.status in ('unmatched','suggested')
                           or (t.status = 'merged' and m.status in ('unmatched','suggested')))), 0) as unbooked_sum,
        count(*) filter (where not t.is_manual and (v_start is null or t.booking_date >= v_start) and t.status = 'ignored') as ignored_count,
        coalesce(sum(t.amount_cents) filter (where not t.is_manual and (v_start is null or t.booking_date >= v_start) and t.status = 'ignored'), 0) as ignored_sum
      from public.bank_transactions t
      left join public.bank_transactions m on m.id = t.merged_into_id
      where t.bank_account_id = ba.id
        and (st.period_end is null or t.booking_date <= st.period_end)
    ) tx
    -- Samengevoegde paren waarvan de handmatige boeking aan de andere kant van
    -- de peildatum valt dan de bankregel: op het afschrift maar nog niet in het
    -- grootboek (+), of andersom (−).
    cross join lateral (
      select
        count(*) as n,
        coalesce(sum(case when r.booking_date <= st.period_end then r.amount_cents else -r.amount_cents end), 0) as sum_cents
      from public.bank_transactions r
      join public.bank_transactions m on m.id = r.merged_into_id and m.status = 'booked'
      join public.journal_entries mje on mje.id = m.journal_entry_id
      where r.bank_account_id = ba.id
        and r.status = 'merged'
        and st.period_end is not null
        and (r.booking_date <= st.period_end) <> (mje.date <= st.period_end)
    ) tim
    -- TOEGEVOEGD (20261119180000): een mutatie die in een dicht tijdvak of boekjaar viel,
    -- is geboekt op de eerste open dag daarna (book_bank_transaction). Ligt de
    -- peildatum van het afschrift tussen die twee datums, dan staat de mutatie
    -- wel op het afschrift en nog niet in het grootboek (of andersom): een
    -- tijdsverschil, geen fout. Samengevoegde paren telt `tim` al.
    cross join lateral (
      select
        count(*) as n,
        coalesce(sum(case when t.booking_date <= st.period_end then t.amount_cents else -t.amount_cents end), 0) as sum_cents
      from public.bank_transactions t
      join public.journal_entries tje on tje.id = t.journal_entry_id
      where t.bank_account_id = ba.id
        and t.status = 'booked'
        and not t.is_manual
        and st.period_end is not null
        and (t.booking_date <= st.period_end) <> (tje.date <= st.period_end)
    ) shf
    -- Geboekte handmatige mutaties die de bank (nog) niet bevestigde en vóór de
    -- peildatum vallen: die staan in het grootboek en niet op het afschrift.
    cross join lateral (
      select count(*) as n, coalesce(sum(m.amount_cents), 0) as sum_cents
      from public.bank_transactions m
      join public.journal_entries mje on mje.id = m.journal_entry_id
      where m.bank_account_id = ba.id
        and m.is_manual
        and m.status = 'booked'
        and st.period_end is not null
        and mje.date <= st.period_end
        and not exists (select 1 from public.bank_transactions r where r.merged_into_id = m.id)
    ) man
    -- Transacties die op inhoud identiek zijn (datum, bedrag, tegenrekening,
    -- omschrijving). Meestal een dubbele import; soms echt twee gelijke
    -- betalingen. Daarom melden, niet automatisch opruimen.
    cross join lateral (
      select coalesce(sum(d.c - 1), 0)::int as n
      from (
        select count(*) as c
        from public.bank_transactions t2
        where t2.bank_account_id = ba.id
          and not t2.is_manual
        group by public.bank_canonical_key(t2.booking_date, t2.amount_cents, t2.counterparty_iban, t2.description)
        having count(*) > 1
      ) d
    ) dup
    -- Afschriften die intern niet kloppen: beginsaldo + alle mutaties in de
    -- afschriftperiode ≠ eindsaldo. Op datumbereik (niet op statement_id), zodat
    -- overlappende imports geen vals alarm geven — zie de toelichting bij de
    -- afschriftcontrole in import_bank_transactions.
    cross join lateral (
      select coalesce(jsonb_agg(q.item order by q.period_start desc nulls last), '[]'::jsonb) as items
      from (
        select s3.period_start, jsonb_build_object(
          'statement_id', s3.id,
          'file_name', s3.file_name,
          'period_start', s3.period_start,
          'period_end', s3.period_end,
          'opening_balance_cents', s3.opening_balance_cents,
          'closing_balance_cents', s3.closing_balance_cents,
          'transactions_sum_cents', sums.sum_cents,
          'difference_cents', s3.closing_balance_cents - (s3.opening_balance_cents + sums.sum_cents)
        ) as item
        from public.bank_statements s3
        cross join lateral (
          select coalesce(sum(t3.amount_cents), 0) as sum_cents
          from public.bank_transactions t3
          where t3.bank_account_id = ba.id
            and not t3.is_manual
            and t3.booking_date between s3.period_start and s3.period_end
        ) sums
        where s3.bank_account_id = ba.id
          and s3.opening_balance_cents is not null
          and s3.closing_balance_cents is not null
          and s3.period_start is not null
          and s3.period_end is not null
          and s3.closing_balance_cents <> s3.opening_balance_cents + sums.sum_cents
        order by s3.period_start desc nulls last
        limit 5
      ) q
    ) iss
    where ba.organization_id = p_organization_id
  ) s;

  return v_out;
end;
$function$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Bank matchen: niets van vóór de start, een ontvangst op naam en bedrag als voorstel, en minder snel vanzelf boeken
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.bank_match_run(p_organization_id uuid, p_bank_account_id uuid, p_created_by uuid, p_transaction_ids uuid[], p_auto_book boolean, p_depth integer DEFAULT 0, p_cursor text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_txn public.bank_transactions;
  v_inv record;
  v_rule public.bank_rules;
  v_sup public.suppliers;
  v_suggested integer := 0;
  v_auto integer := 0;
  v_auto_purchase integer := 0;
  v_merged integer := 0;
  v_haystack text;
  v_iban text;
  v_open public.bank_open_purchase_invoice[];
  v_open_amounts bigint[];
  v_name_tokens jsonb;
  v_sales public.bank_sales_invoice_ref[];
  v_has_rules boolean;
  v_ibans jsonb;
  v_auto_accounts jsonb;
  v_claimed uuid[] := '{}';
  v_match jsonb;
  v_ids uuid[];
  v_booked boolean;
  v_done boolean;
  v_sup_open integer;
  v_paid uuid[] := '{}';        -- in deze ronde vanzelf betaald
  v_sugg_txns uuid[] := '{}';   -- in deze ronde een voorstel met een inkoopfactuur
  v_redo uuid[];
  v_inner jsonb;
  -- De grens: PostgREST breekt een aanroep van de app af na statement_timeout
  -- (8 s voor ingelogde gebruikers), de bankkoppeling na 120 s. De ronde stopt
  -- op 70% daarvan, gemeten vanaf het begin van de aanroep (dus ook het
  -- inlezen zelf telt mee), en nooit later dan na 25 s. Wat dan nog niet is
  -- nagelopen, doet de volgende ronde: die begint na next_cursor.
  v_timeout_ms bigint;
  v_budget_ms numeric;
  v_test text;
  v_deadline timestamptz;
  v_cur_date date;
  v_cur_id uuid;
  v_last_date date;
  v_last_id uuid;
  v_processed integer := 0;
  v_stopped boolean := false;
  v_remaining integer := 0;
  -- Het voorstel voor deze transactie; aan het eind één update.
  o_status text;
  o_account uuid;
  o_vat text;
  o_rule uuid;
  o_conf text;
  o_inv uuid;
  o_pi uuid;
  o_reason text;
  o_allocs jsonb;
  v_start_date date;
  v_cand_count integer;
  v_cand_id uuid;
  v_cand_number text;
  v_cand_client text;
  v_dup boolean;
  v_auto_ok boolean;
begin
  if p_cursor is not null then
    if p_cursor !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}\|[0-9a-fA-F-]{36}$' then
      raise exception 'Ongeldige cursor voor het matchen.' using errcode = '22023';
    end if;
    v_cur_date := split_part(p_cursor, '|', 1)::date;
    v_cur_id := split_part(p_cursor, '|', 2)::uuid;
  end if;

  select s.setting::bigint into v_timeout_ms from pg_settings s where s.name = 'statement_timeout';
  v_budget_ms := case when coalesce(v_timeout_ms, 0) <= 0 then 25000 else least(v_timeout_ms * 0.7, 25000) end;
  -- Voor de databasetest: een kleiner budget, zodat de rondes te zien zijn.
  -- Alleen korter, nooit langer.
  v_test := nullif(current_setting('resofly.bank_match_budget_ms', true), '');
  if v_test ~ '^[0-9]{1,9}$' then
    v_budget_ms := least(v_budget_ms, v_test::numeric);
  end if;
  v_deadline := statement_timestamp() + make_interval(secs => v_budget_ms / 1000.0);

  if p_transaction_ids is null and p_cursor is null then
    v_merged := public.merge_manual_bank_transactions(p_organization_id, p_bank_account_id, p_created_by);
  end if;

  -- TOEGEVOEGD (20261119180000): zie stap 0 in de lus.
  select cs.bookkeeping_start_date into v_start_date
  from public.company_settings cs where cs.organization_id = p_organization_id;

  -- Eén keer per ronde: wat er openstaat en wat er aan regels en IBAN's is.
  v_open := public.bank_open_purchase_invoices(p_organization_id);
  v_open_amounts := array(select c.open_cents from unnest(v_open) c);
  -- Alle woorden van de leveranciersnamen (zie bank_purchase_match). Na een
  -- automatische boeking niet opnieuw: te veel woorden kost alleen tijd.
  v_name_tokens := coalesce((
    select jsonb_object_agg(x.w, true)
    from (select distinct w from unnest(v_open) c, unnest(string_to_array(c.name_norm, ' ')) as w
          where c.name_norm is not null and w <> '') x
  ), '{}'::jsonb);
  v_ibans := public.bank_supplier_ibans(p_organization_id);
  select coalesce(jsonb_object_agg(ba.id::text, ba.auto_book_purchase_invoices), '{}'::jsonb)
  into v_auto_accounts
  from public.bank_accounts ba where ba.organization_id = p_organization_id;
  v_has_rules := exists (select 1 from public.bank_rules r where r.organization_id = p_organization_id and r.is_active);
  -- Geboekte verkoopfacturen met een nummer (zoals de matcher ze al zocht).
  -- Of er nog iets openstaat, kijkt hij pas bij een treffer.
  v_sales := array(
    select row(i.id, i.number, lower(regexp_replace(i.number, '\s', '', 'g')),
               round(coalesce(i.total_amount, 0) * 100)::bigint, i.date)::public.bank_sales_invoice_ref
    from public.invoices i
    where i.organization_id = p_organization_id
      and i.status not in ('cancelled', 'void')
      and i.journal_entry_id is not null
      and i.number is not null and length(btrim(i.number)) > 0
  );

  for v_txn in
    select * from public.bank_transactions
    where organization_id = p_organization_id
      -- GEWIJZIGD (20261118190000): ook bestaande voorstellen opnieuw. Kwam de
      -- inkoopfactuur na de betaling, dan bleef "boek op 4500" staan.
      and status in ('unmatched', 'suggested')
      and (p_bank_account_id is null or bank_account_id = p_bank_account_id)
      and (p_transaction_ids is null or id = any(p_transaction_ids))
      and (p_cursor is null or (booking_date, id) > (v_cur_date, v_cur_id))
    order by booking_date, id
  loop
    -- De deadline: minstens één bankregel per ronde, zodat elke ronde opschiet.
    if v_processed > 0 and clock_timestamp() > v_deadline then
      v_stopped := true;
      exit;
    end if;
    v_processed := v_processed + 1;
    v_last_date := v_txn.booking_date;
    v_last_id := v_txn.id;

    o_status := 'unmatched'; o_account := null; o_vat := null; o_rule := null; o_conf := null;
    o_inv := null; o_pi := null; o_reason := null; o_allocs := null;
    v_done := false; v_booked := false; v_match := null; v_rule := null; v_sup := null;
    v_haystack := lower(replace(coalesce(v_txn.description,'') || ' ' || coalesce(v_txn.structured_reference,''), ' ', ''));
    v_iban := upper(replace(coalesce(v_txn.counterparty_iban,''), ' ', ''));

    -- 0. TOEGEVOEGD (20261119180000): een mutatie van vóór de start van de boekhouding
    --    zit al in het banksaldo van de beginbalans. Hij gaat op genegeerd, met
    --    de reden erbij: geen voorstel en niet vanzelf boeken (een incasso van
    --    25 september werd bij een start per 1 oktober afgeletterd tegen de
    --    factuur van oktober, die daardoor op betaald stond).
    if v_start_date is not null and v_txn.booking_date < v_start_date and not v_txn.is_manual then
      update public.bank_transactions set
        status = 'ignored',
        suggested_account_id = null, suggested_vat_code = null, matched_rule_id = null,
        match_confidence = null, matched_invoice_id = null, matched_purchase_invoice_id = null,
        suggested_allocations = null,
        match_reason = format('Van vóór de start van je boekhouding in ResoFly (%s): zit al in het banksaldo van je beginbalans.',
                              to_char(v_start_date, 'DD-MM-YYYY')),
        updated_at = now()
      where id = v_txn.id;
      continue;
    end if;

    -- 0b. TOEGEVOEGD (20261119180000): lijkt deze mutatie dubbel ingelezen? Dezelfde
    --     betalingen via twee wegen (eerst CSV, later CAMT of de koppeling)
    --     hebben vaak een andere omschrijving en worden dan niet als dubbel
    --     herkend. De bankregel "Shell" boekte de dubbele tankbeurt nog eens,
    --     en de dubbele incasso werd "zeker" afgeletterd tegen de factuur van
    --     de maand erna. Staat er op deze rekening nog een bankmutatie met
    --     dezelfde datum, hetzelfde bedrag en dezelfde (of geen) tegenrekening,
    --     dan boekt ResoFly niets vanzelf en zegt het erbij.
    v_dup := not v_txn.is_manual and exists (
      select 1 from public.bank_transactions d
      where d.bank_account_id = v_txn.bank_account_id
        and d.id <> v_txn.id
        and not d.is_manual
        and d.status <> 'merged'
        and d.booking_date = v_txn.booking_date
        and d.amount_cents = v_txn.amount_cents
        and (public.bank_norm_iban(d.counterparty_iban) is not distinct from public.bank_norm_iban(v_txn.counterparty_iban)
             or public.bank_norm_iban(d.counterparty_iban) is null
             or public.bank_norm_iban(v_txn.counterparty_iban) is null)
    );
    v_auto_ok := p_auto_book and not v_dup;

    -- 1. Ontvangst: verkoopfactuur op factuurnummer (zoals voorheen).
    if v_txn.amount_cents > 0 and cardinality(v_sales) > 0 and length(v_haystack) >= 3 then
      select s.id, s.number into v_inv
      from unnest(v_sales) s
      where strpos(v_haystack, s.number_norm) > 0
        and public.bank_text_mentions_reference(v_haystack, s.number)
        and public.invoice_open_receivable_cents(p_organization_id, s.id) > 0
      order by (case when s.total_cents = abs(v_txn.amount_cents) then 0 else 1 end), s.date desc
      limit 1;
      if v_inv.id is not null then
        o_status := 'suggested'; o_inv := v_inv.id; o_conf := 'invoice';
        o_reason := format('Factuurnummer %s staat in de omschrijving.', v_inv.number);
        v_done := true;
      end if;
    end if;

    -- 1b. TOEGEVOEGD (20261119180000): een ontvangst zonder factuurnummer, met precies het
    --     openstaande bedrag van één factuur van een klant met die naam. Een
    --     voorstel, nooit vanzelf geboekt. Vóór de bankregels: een regel
    --     "Jansen → 8000 met 21%, automatisch" boekte de betaling van een
    --     openstaande factuur van € 1.210 anders als € 1.000 nieuwe omzet met
    --     € 210 btw, terwijl de factuur open bleef en de herinneringen
    --     doorliepen. Bij twee facturen die passen: geen voorstel.
    if not v_done and v_txn.amount_cents > 0 and length(btrim(coalesce(v_txn.counterparty_name, ''))) >= 3 then
      select count(*), (array_agg(x.id))[1], (array_agg(x.number))[1], (array_agg(x.client_name))[1]
        into v_cand_count, v_cand_id, v_cand_number, v_cand_client
      from (
        select i.id, i.number, c.name as client_name
        from public.invoices i
        join public.clients c on c.id = i.client_id
        where i.organization_id = p_organization_id
          and i.status in ('sent', 'overdue')
          and i.journal_entry_id is not null
          and round(coalesce(i.total_amount, 0) * 100)::bigint >= v_txn.amount_cents
          and public.bank_name_matches(public.bank_name_norm(v_txn.counterparty_name), public.bank_name_norm(c.name), false)
          and public.invoice_open_receivable_cents(p_organization_id, i.id) = v_txn.amount_cents
        limit 3
      ) x;
      if v_cand_count = 1 then
        o_status := 'suggested'; o_inv := v_cand_id; o_conf := 'invoice';
        o_reason := format('Naam %s en precies het openstaande bedrag van factuur %s.', v_cand_client, v_cand_number);
        v_done := true;
      end if;
    end if;

    -- 2. Inkoopfactuur op nummer of leverancier. Vóór de bankregels: een
    --    regel "KPN → 4500" boekte anders de betaling van een geboekte
    --    KPN-factuur nog eens als kosten.
    if not v_done and cardinality(v_open) > 0 then
      v_match := public.bank_purchase_match(v_txn, v_haystack, v_open, v_ibans, v_claimed, 'strong', v_name_tokens);
    end if;

    if not v_done and v_match is not null then
      select array_agg((a ->> 'purchase_invoice_id')::uuid) into v_ids
      from jsonb_array_elements(v_match -> 'allocations') a
      where a ->> 'kind' = 'purchase_invoice';
      o_reason := v_match ->> 'reason';

      if (v_match ->> 'certain')::boolean then
        if v_txn.auto_book_blocked then
          o_reason := o_reason || ' Je draaide een automatische boeking hiervan terug; ResoFly boekt hem niet meer vanzelf.';
        elsif not coalesce((v_auto_accounts ->> v_txn.bank_account_id::text)::boolean, true) then
          o_reason := o_reason || ' Automatisch boeken staat uit voor deze rekening.';
        elsif v_auto_ok then
          begin
            perform public.book_bank_transaction(
              p_organization_id, v_txn.id, null, null, null, p_created_by, v_match -> 'allocations', null);
            update public.bank_transactions set
              auto_booked = true,
              match_confidence = v_match ->> 'confidence',
              match_reason = v_match ->> 'reason',
              suggested_allocations = null,
              suggested_account_id = null,
              suggested_vat_code = null,
              matched_rule_id = null,
              updated_at = now()
            where id = v_txn.id;
            v_booked := true;
          exception when others then
            -- Afgesloten periode, een andere valuta, net door iemand anders
            -- geboekt: dan blijft het een voorstel, met de reden erbij.
            o_reason := o_reason || ' Automatisch boeken lukte niet: ' || sqlerrm;
          end;
        end if;
      end if;

      if v_booked then
        v_auto := v_auto + 1;
        v_auto_purchase := v_auto_purchase + 1;
        v_paid := v_paid || coalesce(v_ids, '{}'::uuid[]);
        -- Wat er nu nog openstaat; zo krijgt een tweede betaling van hetzelfde
        -- bedrag deze factuur niet ook.
        select coalesce(array_agg(x.c order by (x.c).due, (x.c).date, (x.c).id), '{}') into v_open
        from (
          select case when c.id = any(v_ids)
                      then row(c.id, c.supplier_id, c.supplier_name, c.name_norm, c.label,
                               c.ref1, c.ref2, c.ref3, c.ref1_norm, c.ref2_norm, c.ref3_norm,
                               public.purchase_invoice_open_payable_cents(p_organization_id, c.id), c.date, c.due)::public.bank_open_purchase_invoice
                      else row(c.*)::public.bank_open_purchase_invoice end as c
          from unnest(v_open) c
        ) x
        where (x.c).open_cents <> 0;
        v_open_amounts := array(select c.open_cents from unnest(v_open) c);
        continue;
      end if;

      o_status := 'suggested';
      o_conf := v_match ->> 'confidence';
      if jsonb_array_length(v_match -> 'allocations') = 1 then
        o_pi := v_ids[1];
      else
        o_allocs := v_match -> 'allocations';
      end if;
      v_claimed := v_claimed || coalesce(v_ids, '{}'::uuid[]);
      v_done := true;
    end if;

    -- 3. Bankregels op prioriteit; eerste match wint. Alleen als er regels zijn.
    if not v_done and v_has_rules then
      select * into v_rule
      from public.bank_rules r
      where r.organization_id = p_organization_id
        and r.is_active
        and (r.match_direction = 'both'
             or (r.match_direction = 'in' and v_txn.amount_cents > 0)
             or (r.match_direction = 'out' and v_txn.amount_cents < 0))
        and (r.match_counterparty_iban is null or upper(replace(r.match_counterparty_iban,' ','')) = v_iban)
        and (r.match_counterparty_name_contains is null or coalesce(v_txn.counterparty_name,'') ilike public.like_contains_pattern(r.match_counterparty_name_contains))
        and (r.match_description_contains is null or coalesce(v_txn.description,'') ilike public.like_contains_pattern(r.match_description_contains))
        and (r.match_amount_cents is null or r.match_amount_cents = abs(v_txn.amount_cents))
      order by r.priority, r.created_at
      limit 1;

      if v_rule.id is not null then
        o_reason := format('Bankregel "%s".', v_rule.name);
        if v_auto_ok and v_rule.auto_book and v_rule.target_account_id is not null then
          if v_txn.auto_book_blocked then
            -- GEWIJZIGD (20261118190000): na terugdraaien niet opnieuw vanzelf.
            o_reason := o_reason || ' Je draaide een automatische boeking hiervan terug; ResoFly boekt hem niet meer vanzelf.';
          else
            begin
              perform public.book_bank_transaction(
                p_organization_id, v_txn.id,
                jsonb_build_array(jsonb_build_object(
                  'account_id', v_rule.target_account_id,
                  'amount_cents', abs(v_txn.amount_cents),
                  'vat_code', v_rule.target_vat_code,
                  'description', v_rule.name
                )),
                null, null, p_created_by
              );
              update public.bank_transactions set
                auto_booked = true,
                matched_rule_id = v_rule.id,
                match_confidence = 'rule',
                match_reason = format('Bankregel "%s".', v_rule.name),
                suggested_allocations = null,
                updated_at = now()
              where id = v_txn.id;
              v_booked := true;
            exception when others then
              -- Automatisch boeken mislukt (bv. afgesloten periode): zet als
              -- voorstel klaar i.p.v. de hele import/match terug te draaien.
              o_reason := o_reason || ' Automatisch boeken lukte niet: ' || sqlerrm;
            end;
          end if;
        end if;
        if v_booked then
          v_auto := v_auto + 1;
          continue;
        end if;
        o_status := 'suggested';
        o_account := v_rule.target_account_id;
        o_vat := v_rule.target_vat_code;
        o_rule := v_rule.id;
        o_conf := 'rule';
        v_done := true;
      end if;
    end if;

    -- 4. Belastingdienst herkennen (betaling én teruggave): stel 1530 Te betalen
    --    omzetbelasting voor, alleen als het bedrag past op een ingediende, nog
    --    niet betaalde aangifte of de omschrijving over btw gaat (zoals voorheen).
    if not v_done
       and (v_iban = 'NL86INGB0002445588'
            or coalesce(v_txn.counterparty_name,'') ilike '%belastingdienst%')
       and (
         exists (
           select 1 from public.vat_returns vr
           where vr.organization_id = p_organization_id
             and vr.status = 'filed'
             and vr.paid_bank_transaction_id is null
             and coalesce((vr.rubrieken->>'saldo_afgerond')::bigint, 0) = -v_txn.amount_cents
         )
         or lower(coalesce(v_txn.description, '') || ' ' || coalesce(v_txn.structured_reference, '')) ~ '(omzetbelasting|\mbtw\M|\mob\M)'
       ) then
      o_status := 'suggested';
      o_account := public.bookkeeping_account_id(p_organization_id, '1530');
      o_conf := 'tax_authority';
      o_reason := 'Herkend als Belastingdienst: omzetbelasting (1530).';
      v_done := true;
    end if;

    -- 5. Alleen het bedrag van één openstaande inkoopfactuur. Na de regels en
    --    de Belastingdienst: dit is het zwakste signaal. Eerst kijken of er
    --    überhaupt een factuur met dat bedrag openstaat (open = −bedrag, in
    --    beide richtingen).
    if not v_done and (-v_txn.amount_cents) = any(v_open_amounts) then
      v_match := public.bank_purchase_match(v_txn, v_haystack, v_open, v_ibans, v_claimed, 'amount');
      if v_match is not null then
        o_status := 'suggested';
        o_conf := 'purchase_amount';
        o_pi := (v_match -> 'allocations' -> 0 ->> 'purchase_invoice_id')::uuid;
        o_reason := v_match ->> 'reason';
        v_claimed := v_claimed || o_pi;
        v_done := true;
      end if;
    end if;

    -- 6. Geen regel: bij een betaling de leverancier op IBAN, met zijn
    --    standaard kostenrekening (zoals voorheen). Alleen zoeken als het IBAN
    --    bij een leverancier hoort.
    if not v_done and v_txn.amount_cents < 0 and v_txn.counterparty_iban is not null
       and v_ibans ? coalesce(public.bank_norm_iban(v_txn.counterparty_iban), '') then
      select * into v_sup from public.suppliers s
      where s.organization_id = p_organization_id
        and s.iban is not null
        and upper(replace(s.iban,' ','')) = v_iban
      limit 1;
      if v_sup.id is not null then
        o_status := 'suggested';
        o_account := v_sup.default_expense_account_id;
        o_vat := v_sup.default_vat_code;
        o_conf := 'supplier_iban';
        o_reason := format('Rekeningnummer van %s; de standaard kostenrekening van die leverancier.', v_sup.name);
        -- TOEGEVOEGD (20261118190000): staat er bij deze leverancier nog iets
        -- open, dan telt deze betaling op een kostenrekening de kosten dubbel.
        select count(*) into v_sup_open
        from unnest(v_open) c
        where c.supplier_id = v_sup.id and c.open_cents > 0;
        if v_sup_open > 0 then
          o_reason := o_reason || format(' Let op: %s heeft nog %s openstaande inkoopfactu%s, maar geen met dit bedrag. Hoort de betaling bij een factuur, kies die dan; op een kostenrekening tellen de kosten anders dubbel.',
                                         v_sup.name, v_sup_open, case when v_sup_open = 1 then 'ur' else 'ren' end);
        end if;
        v_done := true;
      end if;
    end if;

    if v_dup then
      o_reason := coalesce(o_reason || ' ', '')
        || 'Let op: er staat nog een bankmutatie met dezelfde datum, hetzelfde bedrag en dezelfde tegenrekening. Is dit dezelfde betaling, dubbel ingelezen (bijvoorbeeld eerst een afschrift en later de bankkoppeling)? Verwijder dan één van de twee; daarom is er niets vanzelf geboekt.';
    end if;

    update public.bank_transactions set
      status = o_status,
      suggested_account_id = o_account,
      suggested_vat_code = o_vat,
      matched_rule_id = o_rule,
      match_confidence = o_conf,
      matched_invoice_id = o_inv,
      matched_purchase_invoice_id = o_pi,
      match_reason = o_reason,
      suggested_allocations = o_allocs,
      updated_at = now()
    where id = v_txn.id
      and (status, suggested_account_id, suggested_vat_code, matched_rule_id, match_confidence,
           matched_invoice_id, matched_purchase_invoice_id, match_reason, suggested_allocations)
          is distinct from
          (o_status, o_account, o_vat, o_rule, o_conf, o_inv, o_pi, o_reason, o_allocs);
    if o_status = 'suggested' then
      v_suggested := v_suggested + 1;
    end if;
    if o_pi is not null or o_allocs is not null then
      v_sugg_txns := v_sugg_txns || v_txn.id;
    end if;
  end loop;

  -- Wat er nog na de laatst nagelopen bankregel ligt (alleen bij een stop).
  if v_stopped then
    select count(*) into v_remaining
    from public.bank_transactions t
    where t.organization_id = p_organization_id
      and t.status in ('unmatched', 'suggested')
      and (p_bank_account_id is null or t.bank_account_id = p_bank_account_id)
      and (p_transaction_ids is null or t.id = any(p_transaction_ids))
      and (t.booking_date, t.id) > (v_last_date, v_last_id);
  end if;

  -- Een voorstel kan in dezelfde ronde zijn ingehaald: een later gedateerde
  -- betaling bleek zeker bij die factuur te horen en is geboekt. Dan wees het
  -- voorstel naar een betaalde factuur. Die transacties nog één keer, nu
  -- tegen wat er werkelijk nog openstaat. Niet als de tijd al op is: dan doet
  -- een volgende ronde het.
  if p_depth < 2 and not v_stopped and cardinality(v_paid) > 0 and cardinality(v_sugg_txns) > 0 then
    select array_agg(t.id) into v_redo
    from public.bank_transactions t
    where t.organization_id = p_organization_id
      and t.id = any(v_sugg_txns)
      and t.status = 'suggested'
      and (t.matched_purchase_invoice_id = any(v_paid)
           or exists (select 1 from jsonb_array_elements(coalesce(t.suggested_allocations, '[]'::jsonb)) a
                      where a ->> 'purchase_invoice_id' is not null
                        and (a ->> 'purchase_invoice_id')::uuid = any(v_paid)));
    if v_redo is not null then
      v_inner := public.bank_match_run(p_organization_id, null, p_created_by, v_redo, p_auto_book, p_depth + 1);
      v_suggested := v_suggested - cardinality(v_redo) + coalesce((v_inner ->> 'suggested')::integer, 0);
      v_auto := v_auto + coalesce((v_inner ->> 'auto_booked')::integer, 0);
      v_auto_purchase := v_auto_purchase + coalesce((v_inner ->> 'auto_booked_purchase')::integer, 0);
    end if;
  end if;

  return jsonb_build_object(
    'suggested', v_suggested,
    'auto_booked', v_auto,
    'auto_booked_purchase', v_auto_purchase,
    'merged', v_merged,
    -- Nagelopen in deze ronde, en wat er nog ligt (> 0: geef next_cursor aan
    -- de volgende ronde).
    'processed', v_processed,
    'remaining', v_remaining,
    -- Vast formaat: date::text volgt DateStyle van de sessie.
    'next_cursor', case when v_remaining > 0 then to_char(v_last_date, 'YYYY-MM-DD') || '|' || v_last_id::text end
  );
end;
$function$;

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
      select x.id, x.label, x.supplier_id, x.natural, x.pos
      from (
        -- Eerst goedkoop: staat de tekst er letterlijk in? Pas dan de
        -- strengere controle (los kenmerk, niet "42" in "4211").
        select c.id, c.label, c.supplier_id, c.open_cents * v_flip as natural,
               least(
                 case when strpos(p_haystack, c.ref1_norm) > 0 and public.bank_text_mentions_reference(p_haystack, c.ref1) then strpos(p_haystack, c.ref1_norm) end,
                 case when strpos(p_haystack, c.ref2_norm) > 0 and public.bank_text_mentions_reference(p_haystack, c.ref2) then strpos(p_haystack, c.ref2_norm) end,
                 case when strpos(p_haystack, c.ref3_norm) > 0 and public.bank_text_mentions_reference(p_haystack, c.ref3) then strpos(p_haystack, c.ref3_norm) end
               ) as pos
        from unnest(p_open) c
        where strpos(p_haystack, c.ref1_norm) > 0
           or strpos(p_haystack, c.ref2_norm) > 0
           or strpos(p_haystack, c.ref3_norm) > 0
      ) x
      where x.pos is not null
    )
    select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'label', m.label, 'natural', m.natural, 'supplier_id', m.supplier_id) order by m.pos), '[]'::jsonb),
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
        'reason', format('Factuurnummer %s staat in de omschrijving en het bedrag klopt.', v_rows -> 0 ->> 'label')
          || case when coalesce(v_ref_ok, false) then '' else ' Het rekeningnummer hoort bij een andere leverancier; controleer het voordat je boekt.' end);
    elsif v_take > v_need then
      return jsonb_build_object(
        'allocations', jsonb_build_array(jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', v_rows -> 0 ->> 'id', 'amount_cents', v_need)),
        'certain', false, 'confidence', 'purchase_invoice', 'supplier_id', v_rows -> 0 -> 'supplier_id',
        'reason', format('Factuurnummer %s staat in de omschrijving. Er staat %s open, dus dit lijkt een deelbetaling.',
                         v_rows -> 0 ->> 'label', public.bank_eur(v_take)));
    else
      return jsonb_build_object(
        'allocations', jsonb_build_array(
          jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', v_rows -> 0 ->> 'id', 'amount_cents', v_take),
          jsonb_build_object('kind', 'ledger', 'amount_cents', v_need - v_take)),
        'certain', false, 'confidence', 'purchase_invoice', 'supplier_id', v_rows -> 0 -> 'supplier_id',
        'reason', format('Factuurnummer %s staat in de omschrijving, maar de betaling is %s hoger dan wat er openstaat (%s). Kies een rekening voor de rest.',
                         v_rows -> 0 ->> 'label', public.bank_eur(v_need - v_take), public.bank_eur(v_take)));
    end if;
  elsif v_n >= 2 then
    select string_agg(e ->> 'label', ', ') into v_labels from jsonb_array_elements(v_rows) e;
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


-- TOEGEVOEGD (20261119180000): een dubbel ingelezen bankmutatie kan weg. Tot nu toe kon je
-- hem alleen negeren, en een genegeerde mutatie telt mee in de aansluiting (hij
-- staat immers op het afschrift): het verschil ging dan nooit meer weg. Alleen
-- als hij nooit geboekt is en er op dezelfde rekening een tweede mutatie staat
-- met dezelfde datum, hetzelfde bedrag en dezelfde (of geen) tegenrekening.
create or replace function public.delete_duplicate_bank_transaction(p_organization_id uuid, p_transaction_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_txn public.bank_transactions;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  select * into v_txn from public.bank_transactions
  where id = p_transaction_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Banktransactie niet gevonden.' using errcode = '02000';
  end if;
  if v_txn.is_manual then
    raise exception 'Een handmatige mutatie verwijder je met "Verwijderen".' using errcode = '23514';
  end if;
  if v_txn.status in ('booked', 'merged') or v_txn.journal_entry_id is not null
     or exists (select 1 from public.journal_entries je where je.source_type = 'payment' and je.source_id = v_txn.id)
     or exists (select 1 from public.bank_transactions r where r.merged_into_id = v_txn.id) then
    raise exception 'Deze mutatie is (ooit) geboekt of samengevoegd en hoort bij je grootboek. Draai de boeking terug; een geboekte mutatie verwijder je niet.'
      using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.bank_transactions d
    where d.bank_account_id = v_txn.bank_account_id
      and d.id <> v_txn.id
      and not d.is_manual
      and d.booking_date = v_txn.booking_date
      and d.amount_cents = v_txn.amount_cents
      and (public.bank_norm_iban(d.counterparty_iban) is not distinct from public.bank_norm_iban(v_txn.counterparty_iban)
           or public.bank_norm_iban(d.counterparty_iban) is null
           or public.bank_norm_iban(v_txn.counterparty_iban) is null)
  ) then
    raise exception 'Er staat geen tweede bankmutatie met dezelfde datum, hetzelfde bedrag en dezelfde tegenrekening: dit is geen dubbele. Een mutatie die echt op je afschrift staat, negeer je; verwijderen kan niet.'
      using errcode = '23514';
  end if;
  delete from public.bank_transactions where id = v_txn.id;
end;
$function$;

revoke all on function public.delete_duplicate_bank_transaction(uuid, uuid) from public, anon;
grant execute on function public.delete_duplicate_bank_transaction(uuid, uuid) to authenticated, service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. Inkoopfactuur boeken: het btw-bedrag van de factuur, niets vóór de start, geen verkoopcode
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.book_purchase_invoice(p_organization_id uuid, p_purchase_invoice_id uuid, p_created_by uuid DEFAULT auth.uid())
 RETURNS journal_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_pi public.purchase_invoices;
  v_kor boolean;
  v_lines jsonb := '[]'::jsonb;
  v_expense jsonb := '[]'::jsonb;
  v_input_vat bigint := 0;
  v_reverse_vat bigint := 0;
  v_creditors bigint := 0;
  v_entry public.journal_entries;
  v_book_date date;
  v_desc text;
  r record;
  v_start_date date;
  v_bad_line text;
  v_bad_code text;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_pi from public.purchase_invoices
  where id = p_purchase_invoice_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Inkoopfactuur niet gevonden.' using errcode = '02000';
  end if;
  if v_pi.status <> 'draft' then
    raise exception 'Inkoopfactuur is al geboekt of geannuleerd.' using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261104010000): het grootboek rekent niet om; een bedrag in
  -- vreemde valuta kwam er anders 1-op-1 als euro's in (kosten, btw, 4a/4b).
  if upper(coalesce(nullif(btrim(v_pi.currency), ''), 'EUR')) <> 'EUR' then
    raise exception 'Deze inkoopfactuur is in % opgesteld. Reken de bedragen om naar euro''s (koers van de factuurdatum) en zet de valuta op EUR voordat je boekt.',
      upper(v_pi.currency) using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);
  select coalesce(kor_enabled, false), bookkeeping_start_date into v_kor, v_start_date
  from public.company_settings where organization_id = p_organization_id;
  v_kor := coalesce(v_kor, false);

  -- TOEGEVOEGD (20261119180000): een datum die niet kan. Las Gerrie op een bon 2062 in
  -- plaats van 2026, dan werd dat zonder vraag boekstuk JP-2062-00001.
  if v_pi.date is null then
    raise exception 'Deze inkoopfactuur heeft nog geen factuurdatum.' using errcode = '23514';
  end if;
  if v_pi.date > (current_date + interval '1 year')::date then
    raise exception 'De factuurdatum % ligt meer dan een jaar in de toekomst; dat is vast een tikfout of verkeerd gelezen. Verbeter de datum en boek opnieuw.',
      to_char(v_pi.date, 'DD-MM-YYYY') using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261119180000): een verkoopcode op een inkoopregel kwam in geen enkele
  -- rubriek ("ICP diensten" voor Google Ads uit Ierland: 4b bleef leeg).
  select coalesce(nullif(btrim(l->>'description'), ''), '(zonder omschrijving)'), vc.code
    into v_bad_line, v_bad_code
  from jsonb_array_elements(v_pi.lines) as l
  join public.vat_codes vc
    on vc.organization_id = p_organization_id and vc.code = nullif(btrim(coalesce(l->>'vat_code', '')), '')
  where vc.kind in ('icp_goods', 'icp_services', 'reverse_charge_sales')
  limit 1;
  if v_bad_code is not null then
    raise exception 'Regel "%": btw-code % is voor verkoop. Voor een inkoop uit de EU kies je "Verwerving EU", voor een dienst van buiten de EU "Invoer buiten EU" en voor verlegde btw binnen Nederland "BTW verlegd (inkoop)".',
      left(v_bad_line, 80), v_bad_code using errcode = '23514';
  end if;

  -- Aggregeer per kostenrekening + btw-code + tarief; rond de BTW per groep.
  -- De code blijft op de regel staan zodat de aangifte 2a/4a/4b kan scheiden.
  for r in
    select
      coalesce(nullif(l->>'account_id','')::uuid, public.bookkeeping_account_id(p_organization_id, '4500')) as account_id,
      nullif(btrim(coalesce(l->>'vat_code', '')), '') as vat_code,
      coalesce(vc.kind, 'standard') as kind,
      coalesce(nullif(l->>'vat_rate','')::numeric, vc.rate, 0) as rate,
      sum(coalesce((l->>'amount_cents')::bigint, 0)) as base_cents,
      -- TOEGEVOEGD (20261119180000): het btw-bedrag zoals het op de factuur staat
      -- (vat_cents op de regel). Zonder dat veld rekenen we zoals altijd.
      sum(case when coalesce(l->>'vat_cents', '') ~ '^-?[0-9]+$' then (l->>'vat_cents')::bigint end) as vat_given_cents,
      sum(case when coalesce(l->>'vat_cents', '') ~ '^-?[0-9]+$' then 0 else coalesce((l->>'amount_cents')::bigint, 0) end) as base_calc_cents
    from jsonb_array_elements(v_pi.lines) as l
    left join public.vat_codes vc
      on vc.organization_id = p_organization_id and vc.code = nullif(btrim(coalesce(l->>'vat_code', '')), '')
    group by 1, 2, 3, 4
  loop
    declare
      v_vat bigint := round(r.base_cents * r.rate / 100.0);
      v_expense_debit bigint := r.base_cents;
    begin
      -- TOEGEVOEGD (20261119180000): een leverancier rekent de btw vaak per regel of over
      -- het totaal, en komt dan een cent anders uit dan grondslag × tarief (bij
      -- 21% ruim één op de zes bontotalen). De factuur kwam dan voor € 24,77 in
      -- de crediteuren terwijl er € 24,78 betaald werd: de betaling liet zich
      -- niet afletteren. Staat het btw-bedrag van de factuur op de regel, dan
      -- telt dat. Alleen bij gewone btw (21%, 9%): verlegde btw reken je zelf
      -- uit, en bij 0% is er geen btw.
      if r.vat_given_cents is not null then
        if r.kind in ('reverse_charge_purchase','eu_acquisition','icp_goods','icp_services','import_non_eu') or r.rate = 0 then
          if r.vat_given_cents <> 0 and r.rate = 0 then
            raise exception 'Er staat een btw-bedrag op een regel met een btw-code van 0%%. Kies een code met btw, of haal het btw-bedrag weg.'
              using errcode = '23514';
          end if;
        else
          v_vat := r.vat_given_cents + round(r.base_calc_cents * r.rate / 100.0);
        end if;
      end if;
      if v_kor and r.kind in ('reverse_charge_purchase','eu_acquisition','icp_goods','icp_services','import_non_eu') then
        -- TOEGEVOEGD (20261104010000): ook met de KOR moet verlegde btw worden
        -- aangegeven en betaald (2a/4a/4b), zonder aftrek. De leverancier krijgt
        -- alleen de grondslag; de btw is een schuld aan de Belastingdienst en
        -- komt bij de kosten.
        v_expense_debit := r.base_cents + v_vat;
        v_reverse_vat := v_reverse_vat + v_vat;
        v_creditors := v_creditors + r.base_cents;
      elsif v_kor then
        -- KOR: geen aftrek; BTW wordt onderdeel van de kosten.
        v_expense_debit := r.base_cents + v_vat;
        v_creditors := v_creditors + r.base_cents + v_vat;
      elsif r.kind in ('reverse_charge_purchase','eu_acquisition','icp_goods','icp_services','import_non_eu') then
        -- Verlegd/EU-verwerving/invoer art. 23: zelf afdragen én aftrekken;
        -- de leverancier factureert exclusief BTW.
        v_input_vat := v_input_vat + v_vat;
        v_reverse_vat := v_reverse_vat + v_vat;
        v_creditors := v_creditors + r.base_cents;
      else
        -- Normaal binnenland (21/9/0/vrijgesteld).
        v_input_vat := v_input_vat + v_vat;
        v_creditors := v_creditors + r.base_cents + v_vat;
      end if;

      -- GEWIJZIGD (20261104010000): een negatieve groep (creditnota van de
      -- leverancier, kortingsregel) komt aan de creditzijde; een negatieve
      -- debet bestaat niet en liet het boeken vastlopen.
      v_expense := v_expense || jsonb_build_array(jsonb_build_object(
        'account_id', r.account_id,
        'description', 'Inkoopkosten',
        'debit_cents', greatest(v_expense_debit, 0),
        'credit_cents', greatest(-v_expense_debit, 0),
        'vat_code', r.vat_code,
        'vat_rate', r.rate,
        'vat_base_cents', r.base_cents,
        'vat_amount_cents', v_vat,
        'supplier_id', v_pi.supplier_id
      ));
    end;
  end loop;

  v_lines := v_expense;

  if v_input_vat <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1500'),
      'description', 'Voorbelasting',
      'debit_cents', greatest(v_input_vat, 0), 'credit_cents', greatest(-v_input_vat, 0),
      'supplier_id', v_pi.supplier_id
    ));
  end if;
  if v_reverse_vat <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1520'),
      'description', 'Verschuldigde BTW verlegd/ICP',
      'debit_cents', greatest(-v_reverse_vat, 0), 'credit_cents', greatest(v_reverse_vat, 0),
      'supplier_id', v_pi.supplier_id
    ));
  end if;

  if v_creditors = 0 and not exists (select 1 from jsonb_array_elements(v_lines) x where coalesce((x->>'debit_cents')::bigint, 0) <> 0 or coalesce((x->>'credit_cents')::bigint, 0) <> 0) then
    raise exception 'Deze inkoopfactuur heeft geen bedragen om te boeken.' using errcode = '23514';
  end if;
  if v_creditors <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1600'),
      'description', case when v_creditors < 0 then 'Crediteuren (creditnota)' else 'Crediteuren' end,
      'debit_cents', greatest(-v_creditors, 0), 'credit_cents', greatest(v_creditors, 0),
      'supplier_id', v_pi.supplier_id
    ));
  end if;

  -- Nagekomen inkoopfactuur (bv. maart-factuur ontdekt in juli terwijl Q1 al
  -- is ingediend): boek op de eerstvolgende open datum i.p.v. hard weigeren.
  -- GEWIJZIGD (20261119180000): een factuur van vóór de start van de boekhouding boekt op
  -- de startdatum, als nagekomen post. Hij werd op zijn eigen datum geboekt, in
  -- een jaar zonder boekjaar: de kosten vielen buiten de winst, de voorbelasting
  -- kwam in geen enkele aangifte en het eigen vermogen begon te laag. (Stond de
  -- factuur al als schuld in je beginbalans, dan boek je hem niet nog eens: de
  -- betaling gaat dan bij Bank op 1600 Crediteuren.)
  -- En: een factuur zonder btw (vrijgesteld, 0%) raakt de aangifte niet en
  -- blijft op zijn eigen datum, ook als dat btw-tijdvak al is aangegeven. Een
  -- verzekeringsfactuur van december schoof na het afsluiten van Q4 naar
  -- 1 januari, in het verkeerde boekjaar.
  v_book_date := public.first_open_booking_date_for(
    p_organization_id,
    greatest(v_pi.date, coalesce(v_start_date, v_pi.date)),
    public.journal_lines_touch_vat(p_organization_id, v_lines));
  v_desc := 'Inkoopfactuur ' || coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '');
  if v_book_date <> v_pi.date then
    v_desc := v_desc || ' (factuurdatum ' || to_char(v_pi.date, 'DD-MM-YYYY') || ', geboekt in eerstvolgende open periode)';
  end if;

  v_entry := public.post_journal_entry(
    p_organization_id, v_book_date, v_desc,
    'purchase_invoice', v_pi.id, v_lines, p_created_by
  );

  update public.purchase_invoices
  set status = 'booked', journal_entry_id = v_entry.id
  where id = v_pi.id;

  return v_entry;
end;
$function$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 8. Activa: een activum van vóór de start hoort bij de beginbalans; afschrijven niet vóór de start en niet jaren vooruit
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.book_asset_acquisition(p_organization_id uuid, p_asset_id uuid, p_credit_account_id uuid, p_date date DEFAULT NULL::date, p_created_by uuid DEFAULT auth.uid())
 RETURNS fixed_assets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_asset public.fixed_assets;
  v_entry public.journal_entries;
  v_lines jsonb;
  v_book_date date;
  v_pi public.purchase_invoices;
  v_on_asset bigint := 0;
  v_linked bigint := 0;
  v_start_date date;
  v_opening public.journal_entries;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_asset from public.fixed_assets
  where id = p_asset_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Activum niet gevonden.' using errcode = '02000';
  end if;
  if v_asset.acquisition_journal_entry_id is not null then
    raise exception 'De aanschaf van dit activum is al geboekt.' using errcode = '23514';
  end if;
  if v_asset.acquisition_cost_cents <= 0 then
    raise exception 'De aanschafwaarde moet groter zijn dan nul.' using errcode = '23514';
  end if;

  -- TOEGEVOEGD (20261118090000): de aanschaf staat al op de balans via de
  -- bron-inkoopfactuur. Dan wordt dat boekstuk de aanschaf.
  if v_asset.source_purchase_invoice_id is not null then
    select * into v_pi from public.purchase_invoices
    where id = v_asset.source_purchase_invoice_id and organization_id = p_organization_id;
    if found and v_pi.journal_entry_id is not null then
      select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::bigint into v_on_asset
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.entry_id
      where jl.entry_id = v_pi.journal_entry_id
        and jl.organization_id = p_organization_id
        and jl.account_id = v_asset.asset_account_id
        and je.status = 'posted'
        and je.reversed_by_entry_id is null;
      if v_on_asset > 0 then
        -- Eén inkoopfactuur kan meer activa dragen (een laptop en een scherm);
        -- samen niet meer dan er op de activarekening staat.
        select coalesce(sum(fa.acquisition_cost_cents), 0)::bigint into v_linked
        from public.fixed_assets fa
        where fa.organization_id = p_organization_id
          and fa.acquisition_journal_entry_id = v_pi.journal_entry_id
          and fa.id <> v_asset.id;
        if v_linked + v_asset.acquisition_cost_cents > v_on_asset then
          raise exception 'Inkoopfactuur % staat voor € % op de activarekening%. De aanschafwaarde van "%" (€ %) past daar niet in. Kijk de aanschafwaarde na (met de KOR: inclusief btw), of kies een andere bron-inkoopfactuur.',
            coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, ''),
            replace(to_char(v_on_asset / 100.0, 'FM999999990.00'), '.', ','),
            case when v_linked > 0 then ', en € ' || replace(to_char(v_linked / 100.0, 'FM999999990.00'), '.', ',') || ' daarvan hoort al bij andere activa' else '' end,
            v_asset.name,
            replace(to_char(v_asset.acquisition_cost_cents / 100.0, 'FM999999990.00'), '.', ',')
            using errcode = '23514';
        end if;
        update public.fixed_assets set acquisition_journal_entry_id = v_pi.journal_entry_id where id = p_asset_id;
        select * into v_asset from public.fixed_assets where id = p_asset_id;
        return v_asset;
      end if;
    end if;
  end if;

  -- TOEGEVOEGD (20261119180000): een activum van vóór de start van de boekhouding staat
  -- al op de beginbalans. De aanschaf nog eens boeken zette hem dubbel op de
  -- activarekening, op de aanschafdatum zelf: een boekstuk JP-2023-00001 in een
  -- jaar zonder boekjaar, met daarna achttien afschrijvingen in 2023 en 2024.
  -- Het eerste boekjaar weigerde dan voorgoed af te sluiten ("sluit eerst het
  -- voorgaande boekjaar af", dat niet bestond), ook na alles tegenboeken. Nu
  -- wordt het boekstuk van de beginbalans de aanschaf, zoals bij een
  -- inkoopfactuur: geen tweede boeking. Wat volgens het schema vóór de start
  -- is afgeschreven, zit in de cumulatieve afschrijving van de beginbalans en
  -- krijgt geen eigen boeking.
  select cs.bookkeeping_start_date into v_start_date
  from public.company_settings cs where cs.organization_id = p_organization_id;
  if v_start_date is not null and coalesce(p_date, v_asset.acquisition_date) < v_start_date then
    select je.* into v_opening
    from public.journal_entries je
    where je.organization_id = p_organization_id
      and je.source_type = 'opening_balance'
      and je.status = 'posted'
      and je.reversed_by_entry_id is null
      and je.reverses_entry_id is null
    order by je.date desc
    limit 1;
    if not found then
      raise exception '"%" is aangeschaft op %, vóór de start van je boekhouding in ResoFly (%). Zet het eerst in de beginbalans (Grootboek → Beginbalans): de aanschafwaarde op de activarekening en wat er al is afgeschreven op de cumulatieve afschrijving. Daarna koppel je het hier.',
        v_asset.name, to_char(coalesce(p_date, v_asset.acquisition_date), 'DD-MM-YYYY'), to_char(v_start_date, 'DD-MM-YYYY')
        using errcode = '23514';
    end if;
    select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::bigint into v_on_asset
    from public.journal_lines jl
    where jl.entry_id = v_opening.id
      and jl.organization_id = p_organization_id
      and jl.account_id = v_asset.asset_account_id;
    select coalesce(sum(fa.acquisition_cost_cents), 0)::bigint into v_linked
    from public.fixed_assets fa
    where fa.organization_id = p_organization_id
      and fa.acquisition_journal_entry_id = v_opening.id
      and fa.id <> v_asset.id;
    if v_linked + v_asset.acquisition_cost_cents > v_on_asset then
      raise exception 'In je beginbalans staat € % op de activarekening%. De aanschafwaarde van "%" (€ %) past daar niet in. Zet het activum met zijn aanschafwaarde in de beginbalans (Grootboek → Beginbalans → corrigeren), of kijk de aanschafwaarde hier na.',
        replace(to_char(v_on_asset / 100.0, 'FM999999990.00'), '.', ','),
        case when v_linked > 0 then ', en € ' || replace(to_char(v_linked / 100.0, 'FM999999990.00'), '.', ',') || ' daarvan hoort al bij andere activa' else '' end,
        v_asset.name,
        replace(to_char(v_asset.acquisition_cost_cents / 100.0, 'FM999999990.00'), '.', ',')
        using errcode = '23514';
    end if;
    update public.fixed_assets set acquisition_journal_entry_id = v_opening.id where id = p_asset_id;
    update public.asset_depreciations
    set status = 'posted', posted_at = now(), journal_entry_id = null
    where asset_id = p_asset_id and status = 'scheduled' and date < v_start_date;
    select * into v_asset from public.fixed_assets where id = p_asset_id;
    return v_asset;
  end if;

  if p_credit_account_id is null then
    raise exception 'Kies een tegenrekening voor de aanschaf (bijvoorbeeld 1600 Crediteuren of de bank).' using errcode = '23514';
  end if;
  if p_credit_account_id = v_asset.asset_account_id then
    raise exception 'De tegenrekening mag niet gelijk zijn aan de activarekening.' using errcode = '23514';
  end if;

  v_lines := jsonb_build_array(
    jsonb_build_object(
      'account_id', v_asset.asset_account_id,
      'description', 'Aanschaf ' || v_asset.name,
      'debit_cents', v_asset.acquisition_cost_cents, 'credit_cents', 0
    ),
    jsonb_build_object(
      'account_id', p_credit_account_id,
      'description', 'Aanschaf ' || v_asset.name,
      'debit_cents', 0, 'credit_cents', v_asset.acquisition_cost_cents
    )
  );

  v_book_date := public.first_open_booking_date_for(p_organization_id, coalesce(p_date, v_asset.acquisition_date), public.journal_lines_touch_vat(p_organization_id, v_lines));
  v_entry := public.post_journal_entry(
    p_organization_id, v_book_date,
    'Aanschaf ' || coalesce(v_asset.asset_number, v_asset.name),
    'asset_acquisition', p_asset_id, v_lines, p_created_by
  );

  update public.fixed_assets set acquisition_journal_entry_id = v_entry.id where id = p_asset_id;
  select * into v_asset from public.fixed_assets where id = p_asset_id;
  return v_asset;
end;
$function$;

CREATE OR REPLACE FUNCTION public.post_asset_depreciation(p_organization_id uuid, p_asset_id uuid, p_through_date date, p_created_by uuid DEFAULT auth.uid())
 RETURNS fixed_assets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_asset public.fixed_assets;
  r record;
  v_lines jsonb;
  v_entry public.journal_entries;
  v_remaining integer;
  v_book_date date;
  v_start_date date;
  v_year_end date;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_asset from public.fixed_assets
  where id = p_asset_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Activum niet gevonden.' using errcode = '02000';
  end if;
  -- De aanschaf moet op de balans staan (debet 0100) voordat er wordt afgeschreven,
  -- anders zou 0150 gecrediteerd worden zonder tegenpost → negatieve netto-activa.
  if v_asset.acquisition_journal_entry_id is null then
    raise exception 'Boek eerst de aanschaf van dit activum naar het grootboek voordat je afschrijft.' using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261104000000): een afgestoten activum staat niet meer op de
  -- balans; afschrijven zou 0150 crediteren zonder activum erachter.
  if v_asset.status = 'disposed' then
    raise exception 'Dit activum is afgestoten; er valt niets meer op af te schrijven.' using errcode = '23514';
  end if;

  -- TOEGEVOEGD (20261119180000): niet jaren vooruit. "Boek t/m 31-10-2062" (een tikfout)
  -- boekte in één keer alle zestig termijnen tot in 2030 en zette het activum
  -- op volledig afgeschreven: zestig losse tegenboekingen om te herstellen.
  v_year_end := make_date(extract(year from current_date)::int, 12, 31);
  if p_through_date is null or p_through_date > v_year_end then
    raise exception 'Afschrijven kan tot en met het einde van dit jaar (%). Latere termijnen boek je als het zover is.',
      to_char(v_year_end, 'DD-MM-YYYY') using errcode = '23514';
  end if;

  -- TOEGEVOEGD (20261119180000): termijnen van vóór de start van de boekhouding zitten in
  -- de cumulatieve afschrijving van de beginbalans. Ze krijgen geen boeking
  -- (die viel in een jaar zonder boekjaar en hield het afsluiten tegen), maar
  -- tellen wel als afgeschreven, zodat de boekwaarde klopt.
  select cs.bookkeeping_start_date into v_start_date
  from public.company_settings cs where cs.organization_id = p_organization_id;
  if v_start_date is not null then
    update public.asset_depreciations
    set status = 'posted', posted_at = now(), journal_entry_id = null
    where asset_id = p_asset_id and status = 'scheduled' and date < v_start_date;
  end if;

  for r in
    select * from public.asset_depreciations
    where asset_id = p_asset_id and status = 'scheduled' and date <= p_through_date
    order by period_index
  loop
    v_lines := jsonb_build_array(
      jsonb_build_object(
        'account_id', v_asset.depreciation_account_id,
        'description', 'Afschrijving ' || v_asset.name,
        'debit_cents', r.amount_cents, 'credit_cents', 0
      ),
      jsonb_build_object(
        'account_id', v_asset.accumulated_depreciation_account_id,
        'description', 'Cumulatieve afschrijving ' || v_asset.name,
        'debit_cents', 0, 'credit_cents', r.amount_cents
      )
    );
    -- Nagekomen afschrijving in een al afgesloten periode → eerstvolgende open datum.
    -- GEWIJZIGD (20261104000000): een afschrijving raakt geen btw-rubriek en
    -- schuift dus alleen over een afgesloten boekjaar heen, niet over een btw-slot.
    v_book_date := public.first_open_booking_date_for(p_organization_id, r.date, public.journal_lines_touch_vat(p_organization_id, v_lines));
    v_entry := public.post_journal_entry(
      p_organization_id, v_book_date,
      'Afschrijving ' || coalesce(v_asset.asset_number, v_asset.name),
      'asset_depreciation', p_asset_id, v_lines, p_created_by
    );
    update public.asset_depreciations
    set status = 'posted', journal_entry_id = v_entry.id, posted_at = now()
    where id = r.id;
  end loop;

  select count(*) into v_remaining from public.asset_depreciations
  where asset_id = p_asset_id and status = 'scheduled';
  if v_remaining = 0 then
    update public.fixed_assets set status = 'fully_depreciated' where id = p_asset_id and status = 'active';
  end if;

  select * into v_asset from public.fixed_assets where id = p_asset_id;
  return v_asset;
end;
$function$;


-- De koppeling van een activum aan een boekstuk dat geen losse aanschaf is (een
-- inkoopfactuur of de beginbalans) gaat mee terug als dat boekstuk wordt
-- tegengeboekt. GEWIJZIGD (20261119180000): termijnen van vóór de start (afgeschreven
-- zonder boeking) houden dat niet tegen en gaan weer op gepland; anders was de
-- beginbalans met een gekoppeld activum nooit meer te corrigeren.
create or replace function public.journal_entry_reversal_releases_asset()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_name text;
begin
  -- Een losse aanschaf (source_type asset_acquisition) regelt
  -- reverse_journal_entry al zelf.
  if new.source_type = 'asset_acquisition' then
    return new;
  end if;
  select fa.name into v_name
  from public.fixed_assets fa
  where fa.organization_id = new.organization_id
    and fa.acquisition_journal_entry_id = new.id
    and (fa.status = 'disposed'
         or exists (select 1 from public.asset_depreciations ad
                    where ad.asset_id = fa.id and ad.status = 'posted' and ad.journal_entry_id is not null))
  limit 1;
  if v_name is not null then
    raise exception 'Dit boekstuk is de aanschaf van activum "%". Draai eerst de desinvestering en de geboekte afschrijvingen terug; daarna dit boekstuk.', v_name
      using errcode = '23514';
  end if;
  update public.asset_depreciations ad
  set status = 'scheduled', posted_at = null
  from public.fixed_assets fa
  where fa.id = ad.asset_id
    and fa.organization_id = new.organization_id
    and fa.acquisition_journal_entry_id = new.id
    and ad.status = 'posted' and ad.journal_entry_id is null;
  update public.fixed_assets
  set acquisition_journal_entry_id = null
  where organization_id = new.organization_id
    and acquisition_journal_entry_id = new.id;
  return new;
end;
$function$;

revoke all on function public.journal_entry_reversal_releases_asset() from public, anon, authenticated;

-- TOEGEVOEGD (20261119180000): een koppeling losmaken. Wie een camera aan de inkoopfactuur
-- van € 2.000 koppelde met € 200 als aanschafwaarde (een tikfout), kon niets
-- meer: wijzigen en verwijderen werden geweigerd ("staat in het grootboek"),
-- hoewel koppelen niets boekte. De enige weg was de inkoopfactuur tegenboeken,
-- en die weigerde tot de bankbetaling ongedaan was. Losmaken kan zolang er niets
-- is afgeschreven; een losse aanschafboeking boek je tegen in het Journaal.
create or replace function public.unlink_asset_acquisition(p_organization_id uuid, p_asset_id uuid)
returns public.fixed_assets
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_asset public.fixed_assets;
  v_source text;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  select * into v_asset from public.fixed_assets
  where id = p_asset_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Activum niet gevonden.' using errcode = '02000';
  end if;
  if v_asset.acquisition_journal_entry_id is null then
    return v_asset;
  end if;
  if v_asset.status = 'disposed' then
    raise exception 'Dit activum is afgestoten. Draai eerst de desinvestering terug.' using errcode = '23514';
  end if;
  select je.source_type into v_source from public.journal_entries je where je.id = v_asset.acquisition_journal_entry_id;
  if v_source = 'asset_acquisition' then
    raise exception 'De aanschaf van dit activum is een eigen boekstuk. Boek dat tegen in het Journaal; dan is het activum weer te wijzigen.'
      using errcode = '23514';
  end if;
  if exists (select 1 from public.asset_depreciations ad
             where ad.asset_id = p_asset_id and ad.status = 'posted' and ad.journal_entry_id is not null) then
    raise exception 'Er is al afgeschreven op dit activum. Draai eerst de geboekte afschrijvingen terug; daarna kun je de koppeling losmaken.'
      using errcode = '23514';
  end if;
  update public.asset_depreciations
  set status = 'scheduled', posted_at = null
  where asset_id = p_asset_id and status = 'posted' and journal_entry_id is null;
  update public.fixed_assets set acquisition_journal_entry_id = null, status = 'active' where id = p_asset_id;
  select * into v_asset from public.fixed_assets where id = p_asset_id;
  return v_asset;
end;
$function$;

revoke all on function public.unlink_asset_acquisition(uuid, uuid) from public, anon;
grant execute on function public.unlink_asset_acquisition(uuid, uuid) to authenticated, service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- 9. Jaarafsluiting: zeggen wat er in de weg staat, en niet afsluiten met losse eindjes
-- ═══════════════════════════════════════════════════════════════════════════

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
  v_regime := public.org_fiscal_regime(p_organization_id);
  v_partnership := v_regime = 'ib'
    and public.org_legal_form(p_organization_id) in ('vof', 'maatschap', 'cv')
    and exists (
      select 1 from public.partnership_partners pp
      where pp.organization_id = p_organization_id and pp.is_active
    );

  if v_partnership then
    select coalesce(sum(pp.profit_share_basis_points), 0)::int into v_share_total
    from public.partnership_partners pp
    where pp.organization_id = p_organization_id and pp.is_active;
    if v_share_total <> 10000 then
      raise exception 'De winstverdeling van de vennoten telt op tot % procent; dat moet precies 100 procent zijn. Pas de verdeling aan bij Financiën → Vennoten.',
        replace(rtrim(to_char(v_share_total / 100.0, 'FM990.99'), '.'), '.', ',') using errcode = '23514';
    end if;

    if v_result_cents <> 0 then
      for s in select * from public.partnership_result_shares(p_organization_id, v_result_cents) loop
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
    end if;
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


-- ═══════════════════════════════════════════════════════════════════════════
-- 10. Btw-aangifte afsluiten: een Nederlandse omschrijving van het boekstuk
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.finalize_vat_return(p_organization_id uuid, p_period_type text, p_year integer, p_period_index integer, p_from date, p_to date, p_created_by uuid DEFAULT auth.uid())
 RETURNS vat_returns
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_ret public.vat_returns;
  v_rubrieken jsonb;
  v_clear_output bigint;
  v_clear_reverse bigint;
  v_clear_input bigint;
  v_saldo_afgerond bigint;
  v_afronding bigint;
  v_lines jsonb := '[]'::jsonb;
  v_entry public.journal_entries;
  v_expected_from date;
  v_expected_to date;
  v_existing_status text;
  v_frequency text;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if p_period_type not in ('month', 'quarter') then
    raise exception 'Ongeldige periodesoort.' using errcode = '23514';
  end if;
  -- GEWIJZIGD (20261104000000): de periode volgt uit soort, jaar en nummer.
  -- Andere datums gaven een tweede, willekeurig slot (tot en met de hele
  -- administratie) en overschreven de aangifte van die periode.
  if p_year is null or p_year < 2000 or p_year > 2100
     or p_period_index is null or p_period_index < 1
     or p_period_index > (case when p_period_type = 'month' then 12 else 4 end) then
    raise exception 'Ongeldige aangifteperiode.' using errcode = '23514';
  end if;
  v_expected_from := make_date(p_year, case when p_period_type = 'month' then p_period_index else (p_period_index - 1) * 3 + 1 end, 1);
  v_expected_to := (v_expected_from
    + case when p_period_type = 'month' then interval '1 month' else interval '3 months' end
    - interval '1 day')::date;
  if p_from is distinct from v_expected_from or p_to is distinct from v_expected_to then
    raise exception 'Deze aangifteperiode loopt van % t/m %; andere datums kunnen niet.',
      to_char(v_expected_from, 'DD-MM-YYYY'), to_char(v_expected_to, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;

  -- TOEGEVOEGD (20261118090000): een tijdvak dat nog loopt, sluit je niet af.
  -- De pagina opent op het lopende kwartaal en de knop stond aan: wie op
  -- 17 november Q4 afsloot, zag een factuur van 15 december op 1 januari
  -- geboekt worden. Die omzet viel zo in het verkeerde jaar (de winst voor de
  -- inkomstenbelasting) en de btw een kwartaal te laat in de aangifte. De
  -- Belastingdienst neemt de aangifte ook pas na afloop van het tijdvak aan.
  if v_expected_to >= current_date then
    raise exception 'Dit tijdvak loopt nog tot en met %. Afsluiten kan vanaf %, net als de aangifte bij de Belastingdienst.',
      to_char(v_expected_to, 'DD-MM-YYYY'), to_char(v_expected_to + 1, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261118090000): alleen in de frequentie die bij Instellingen
  -- staat. Wie per kwartaal aangifte doet en toch januari afsloot, kon Q1 daarna
  -- niet meer afsluiten (overlap).
  -- GEWIJZIGD (20261118100000): of in de soort waarin dat jaar al aangifte is
  -- gedaan. Zet de Belastingdienst je per 1 januari op maandaangifte, dan zet
  -- je dat bij Instellingen om en doe je in januari nog de aangifte over Q4.
  -- Die weigerde 20261118090000: je moest de instelling heen en weer zetten.
  -- Een losse maand in een jaar dat per kwartaal gaat, blijft geweigerd.
  select coalesce(cs.vat_return_period, 'quarterly') into v_frequency
  from public.company_settings cs where cs.organization_id = p_organization_id;
  v_frequency := coalesce(v_frequency, 'quarterly');
  if (v_frequency = 'monthly') <> (p_period_type = 'month')
     and not exists (
       select 1 from public.vat_returns vr
       where vr.organization_id = p_organization_id
         and vr.supplements_return_id is null
         and vr.status <> 'draft'
         and vr.year = p_year
         and vr.period_type = p_period_type
     ) then
    raise exception 'Je doet btw-aangifte per % (Instellingen → Bedrijf), en in % deed je nog geen aangifte per %. Moet dit tijdvak toch per % (bijvoorbeeld het laatste tijdvak vóór een wissel), zet de instelling dan eerst om.',
      case when v_frequency = 'monthly' then 'maand' else 'kwartaal' end,
      p_year,
      case when p_period_type = 'month' then 'maand' else 'kwartaal' end,
      case when p_period_type = 'month' then 'maand' else 'kwartaal' end
      using errcode = '23514';
  end if;
  -- Exclusief: geen boeking tussen het optellen en het vergrendelen.
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':periodegrendel'));

  -- Een afgesloten aangifte blijft staan; een correctie loopt via een suppletie.
  select status into v_existing_status
  from public.vat_returns
  where organization_id = p_organization_id
    and period_type = p_period_type and year = p_year and period_index = p_period_index
    and supplements_return_id is null;
  if v_existing_status is not null and v_existing_status <> 'draft' then
    raise exception 'De aangifte over deze periode is al afgesloten (%). Een correctie loopt via een suppletie.',
      case v_existing_status when 'finalized' then 'doorgeboekt' when 'filed' then 'ingediend' when 'paid' then 'betaald' else v_existing_status end
      using errcode = '23514';
  end if;

  -- Geen overlap met een ander btw-slot (bv. januari terwijl Q1 al dicht is,
  -- of na een wissel van kwartaal- naar maandaangifte).
  if exists (
    select 1 from public.closed_periods cp
    where cp.organization_id = p_organization_id
      and cp.period_type in ('month', 'quarter')
      and cp.period_start <= p_to and cp.period_end >= p_from
  ) then
    raise exception 'Deze periode valt (deels) in een al afgesloten btw-periode.' using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);

  -- Eén aanroep = één statement = één consistente MVCC-momentopname: wat wordt
  -- doorgeboekt is exact wat in de bevroren rubrieken-snapshot komt.
  v_rubrieken := public.compute_vat_boxes(p_organization_id, p_from, p_to, null);
  v_clear_output := (v_rubrieken->>'clear_output')::bigint;
  v_clear_reverse := (v_rubrieken->>'clear_reverse')::bigint;
  v_clear_input := (v_rubrieken->>'clear_input')::bigint;
  v_saldo_afgerond := (v_rubrieken->>'saldo_afgerond')::bigint;
  v_afronding := (v_rubrieken->>'afronding_cents')::bigint;

  -- Doorboeking: BTW-rekeningen exact afsluiten naar 1530 (tekenvast — een
  -- negatief periodesaldo op een rekening wordt aan de andere kant geboekt).
  if v_clear_output <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1510'),
      'description', 'Afsluiten af te dragen BTW',
      'debit_cents', case when v_clear_output > 0 then v_clear_output else 0 end,
      'credit_cents', case when v_clear_output < 0 then -v_clear_output else 0 end));
  end if;
  if v_clear_reverse <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1520'),
      'description', 'Afsluiten verlegde/ICP BTW',
      'debit_cents', case when v_clear_reverse > 0 then v_clear_reverse else 0 end,
      'credit_cents', case when v_clear_reverse < 0 then -v_clear_reverse else 0 end));
  end if;
  if v_clear_input <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1500'),
      'description', 'Afsluiten voorbelasting',
      'debit_cents', case when v_clear_input < 0 then -v_clear_input else 0 end,
      'credit_cents', case when v_clear_input > 0 then v_clear_input else 0 end));
  end if;
  if v_saldo_afgerond <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1530'),
      'description', 'Te betalen omzetbelasting (hele euro''s per rubriek)',
      'debit_cents', case when v_saldo_afgerond < 0 then -v_saldo_afgerond else 0 end,
      'credit_cents', case when v_saldo_afgerond > 0 then v_saldo_afgerond else 0 end
    ));
  end if;
  if v_afronding <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '4900'),
      'description', 'Afrondingsverschil BTW-aangifte (cent → hele euro''s)',
      'debit_cents', case when v_afronding < 0 then -v_afronding else 0 end,
      'credit_cents', case when v_afronding > 0 then v_afronding else 0 end
    ));
  end if;

  if jsonb_array_length(v_lines) > 0 then
    v_entry := public.post_journal_entry(
      p_organization_id, p_to,
      -- GEWIJZIGD (20261119180000): "Btw-aangifte Q2 2026" in plaats van "BTW-aangifte
      -- doorboeken quarter 2-2026" (Engels in het Journaal).
      'Btw-aangifte ' || case when p_period_type = 'month'
                              then (array['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'])[p_period_index]
                              else 'Q' || p_period_index end || ' ' || p_year,
      'vat_return', null, v_lines, p_created_by
    );
  end if;

  insert into public.vat_returns(
    organization_id, created_by, period_type, year, period_index, period_start, period_end,
    status, rubrieken, journal_entry_id, finalized_at
  ) values (
    p_organization_id, p_created_by, p_period_type, p_year, p_period_index, p_from, p_to,
    'finalized', v_rubrieken, v_entry.id, now()
  )
  on conflict (organization_id, period_type, year, period_index) where supplements_return_id is null do update
    set status = 'finalized', rubrieken = excluded.rubrieken, journal_entry_id = excluded.journal_entry_id,
        period_start = excluded.period_start, period_end = excluded.period_end, finalized_at = now(), updated_at = now()
  returning * into v_ret;

  -- Periode vergrendelen (datumbereik).
  insert into public.closed_periods(organization_id, period_type, year, quarter, month, period_start, period_end, closed_by)
  values (
    p_organization_id, p_period_type, p_year,
    case when p_period_type = 'quarter' then p_period_index::smallint else null end,
    case when p_period_type = 'month' then p_period_index::smallint else null end,
    p_from, p_to, p_created_by
  )
  on conflict (organization_id, period_type, period_start, period_end) do nothing;

  return v_ret;
end;
$function$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 11. KOR uit: een factuur met code KOR gaat niet zonder btw de deur uit
-- ═══════════════════════════════════════════════════════════════════════════

-- (actuele definitie, met de toevoeging onderaan de controle)

CREATE OR REPLACE FUNCTION public.enforce_invoice_kor_no_vat()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_kor boolean;
begin
  if new.status in ('cancelled', 'void') then return new; end if;
  -- Alleen bij uitgeven (nieuw of vanuit concept); een uitgegeven factuur ligt al vast.
  if tg_op = 'UPDATE' and old.status <> 'draft' then return new; end if;
  select coalesce(kor_enabled, false) into v_kor
    from public.company_settings where organization_id = new.organization_id;
  if not coalesce(v_kor, false) then
    -- TOEGEVOEGD (20261119180000): zonder de KOR geen regels met de code KOR meer. Wie de
    -- regeling uitzette (grens overschreden, of per 1 januari) en een concept,
    -- kopie of omgezette offerte uit de KOR-tijd verstuurde, stuurde een
    -- factuur zonder btw die in geen rubriek van de aangifte kwam: de omzet
    -- stond wel in de winst, de btw ontbrak.
    if new.status <> 'draft' and exists (
         select 1
         from jsonb_array_elements(case when jsonb_typeof(new.lines) = 'array' then new.lines else '[]'::jsonb end) l
         join public.vat_codes vc
           on vc.organization_id = new.organization_id
          and vc.code = nullif(btrim(coalesce(l->>'vat_code', '')), '')
         where vc.kind = 'kor') then
      raise exception 'Op deze factuur staat een regel met btw-code KOR, maar de kleineondernemersregeling staat uit (Instellingen → Bedrijf). Kies op die regel het btw-tarief dat nu geldt en verstuur opnieuw.'
        using errcode = '23514';
    end if;
    return new;
  end if;
  -- TOEGEVOEGD (20261118090000): 0% zonder code wordt KOR, ook in een concept,
  -- zodat de conceptpdf in de app al de juiste vermelding toont.
  new.lines := public.kor_code_on_zero_lines(new.organization_id, new.lines);
  if new.status = 'draft' then return new; end if;
  if exists (
       select 1 from jsonb_array_elements(case when jsonb_typeof(new.lines) = 'array' then new.lines else '[]'::jsonb end) l
        where case when coalesce(l->>'vat', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (l->>'vat')::numeric else 0 end <> 0) then
    raise exception 'Je gebruikt de kleineondernemersregeling (KOR): een factuur rekent dan geen btw. Zet de btw van elke regel op 0%% (code KOR) en verstuur opnieuw.'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 12. Beginbalans: geen datum in de toekomst
-- ═══════════════════════════════════════════════════════════════════════════

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
  -- TOEGEVOEGD (20261119180000): een beginbalans per 01-01-2052 werd geaccepteerd.
  if p_as_of_date is null then
    raise exception 'Kies de datum van de beginbalans.' using errcode = '23514';
  end if;
  if p_as_of_date > current_date then
    raise exception 'De beginbalans is de stand op de dag dat je boekhouding in ResoFly begint; % ligt in de toekomst. Kijk de datum na.',
      to_char(p_as_of_date, 'DD-MM-YYYY') using errcode = '23514';
  end if;

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

-- ═══════════════════════════════════════════════════════════════════════════
-- 13. Een btw-code waarop geboekt is, verwijder je niet
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Het tarief of de rubriek van een gebruikte code wijzigen werd al geweigerd;
-- verwijderen niet. Daarna verhuisde € 700 in een open tijdvak stil van
-- rubriek 3b naar 1e (de regel had geen code meer die zijn rubriek aanwees).
create or replace function public.vat_codes_block_delete_when_used()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if exists (
    select 1 from public.journal_lines jl
    where jl.organization_id = old.organization_id and jl.vat_code = old.code
  ) then
    raise exception 'Op btw-code % is al geboekt; verwijderen zou die boekingen in een andere rubriek van de aangifte zetten. Zet de code op inactief als je hem niet meer wilt gebruiken.', old.code
      using errcode = '23514';
  end if;
  return old;
end;
$function$;

revoke all on function public.vat_codes_block_delete_when_used() from public, anon, authenticated;

drop trigger if exists vat_codes_block_delete_when_used on public.vat_codes;
create trigger vat_codes_block_delete_when_used
  before delete on public.vat_codes
  for each row execute function public.vat_codes_block_delete_when_used();

-- ═══════════════════════════════════════════════════════════════════════════
-- 14. Bankrekening: de grootboekrekening ligt vast zodra er geboekt is
-- ═══════════════════════════════════════════════════════════════════════════
--
-- De grootboekrekening van een bankrekening was te wijzigen terwijl er
-- boekingen op stonden (1100 → 1000): de aansluiting toonde daarna het hele
-- verleden als verschil, een terugdraaiing boekte terug op 1100 en de nieuwe
-- boeking ging naar 1000. En na alles terugdraaien was de bankrekening te
-- verwijderen: dan waren alle bankmutaties en verdelingen weg terwijl de
-- journaalposten bleven staan.
create or replace function public.bank_accounts_ledger_locked()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.ledger_account_id is distinct from old.ledger_account_id
     and exists (
       select 1
       from public.bank_transactions t
       join public.journal_entries je on je.source_type = 'payment' and je.source_id = t.id
       where t.bank_account_id = old.id
     ) then
    raise exception 'Op deze bankrekening is al geboekt; de grootboekrekening kan niet meer anders. Het saldo zou dan over twee rekeningen verdeeld raken. Maak voor een andere grootboekrekening een nieuwe bankrekening aan.'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

revoke all on function public.bank_accounts_ledger_locked() from public, anon, authenticated;

drop trigger if exists bank_accounts_ledger_locked on public.bank_accounts;
create trigger bank_accounts_ledger_locked
  before update of ledger_account_id on public.bank_accounts
  for each row execute function public.bank_accounts_ledger_locked();

create or replace function public.bank_account_block_delete_with_bookings()
returns trigger
language plpgsql
as $function$
begin
  if exists (select 1 from public.bank_transactions where bank_account_id = old.id and status = 'booked') then
    raise exception 'Deze bankrekening heeft geboekte transacties. Draai die eerst terug voordat je de rekening verwijdert.'
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261119180000): ook als alles is teruggedraaid. De boekstukken en hun
  -- tegenboekingen blijven in het grootboek; de bankmutaties waar ze bij horen
  -- gaan met de rekening mee weg (bewaarplicht).
  if exists (
    select 1
    from public.bank_transactions t
    join public.journal_entries je on je.source_type = 'payment' and je.source_id = t.id
    where t.bank_account_id = old.id
  ) then
    raise exception 'Op deze bankrekening is ooit geboekt. De mutaties horen bij boekstukken in je grootboek en moeten bewaard blijven. Zet de rekening op inactief in plaats van hem te verwijderen.'
      using errcode = '23514';
  end if;
  return old;
end; $function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 15. Een rekening voor bankkosten, zonder btw
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Het schema van een IB-onderneming had geen rekening voor bankkosten. De
-- logische keuze, 4500 Algemene kosten, stelt 21% voor: van € 9,95 bankkosten
-- per maand werd dan € 1,73 voorbelasting afgesplitst, terwijl bankkosten zijn
-- vrijgesteld van btw.
create or replace function public.ensure_ib_ledger_accounts(p_organization_id uuid)
returns void
language sql
security definer
set search_path to 'public'
as $function$
  insert into public.ledger_accounts (organization_id, code, name, type, subtype, default_vat_code, is_system, report_group)
  values
    (p_organization_id, '1000', 'Kas', 'asset', 'cash', null, false, 'liquide_middelen'),
    (p_organization_id, '4100', 'Huisvestingskosten', 'expense', 'housing', null, false, 'overige_bedrijfskosten'),
    (p_organization_id, '4200', 'Auto- en vervoerskosten', 'expense', 'car_transport', null, false, 'overige_bedrijfskosten'),
    (p_organization_id, '4300', 'Kantoor- en communicatiekosten', 'expense', 'office', 'HOOG', false, 'overige_bedrijfskosten'),
    (p_organization_id, '4400', 'Verkoop- en reclamekosten', 'expense', 'selling', 'HOOG', false, 'overige_bedrijfskosten'),
    (p_organization_id, '4600', 'Eten, drinken en representatie (beperkt aftrekbaar)', 'expense', 'mixed_costs', null, false, 'overige_bedrijfskosten'),
    (p_organization_id, '4700', 'Opleiding en vakliteratuur', 'expense', 'education', null, false, 'overige_bedrijfskosten'),
    -- TOEGEVOEGD (20261119180000). Niet 4950: daar boekt de desinvestering van een activum
    -- het boekresultaat op.
    (p_organization_id, '4750', 'Bankkosten en verzekeringen (geen btw)', 'expense', 'bank_costs', null, false, 'overige_bedrijfskosten'),
    (p_organization_id, '7000', 'Inkoopwaarde en uitbesteed werk', 'expense', 'cost_of_sales', 'HOOG', false, 'inkoopwaarde')
  on conflict (organization_id, code) do nothing;
$function$;

revoke all on function public.ensure_ib_ledger_accounts(uuid) from public, anon, authenticated;
grant execute on function public.ensure_ib_ledger_accounts(uuid) to service_role;

-- Bestaande IB-administraties met een rekeningschema krijgen de rekening ook.
do $$
declare
  r record;
begin
  for r in
    select distinct la.organization_id
    from public.ledger_accounts la
    where public.org_fiscal_regime(la.organization_id) = 'ib'
  loop
    perform public.ensure_ib_ledger_accounts(r.organization_id);
  end loop;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 16. Een boekjaar dat per vergissing is geopend, kan weer weg
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Een boekjaar met een tikfout in de datums (1 januari t/m 30 juni 2027) was
-- niet te wijzigen en niet te verwijderen: de tabel is alleen te lezen. Een
-- open boekjaar zonder boekingen en zonder afgesloten btw-tijdvakken mag weg.
create or replace function public.delete_open_fiscal_year(p_organization_id uuid, p_fiscal_year_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_fy public.fiscal_years;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':periodegrendel'));
  select * into v_fy from public.fiscal_years
  where id = p_fiscal_year_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Boekjaar niet gevonden.' using errcode = '02000';
  end if;
  if v_fy.status <> 'open' or v_fy.close_journal_entry_id is not null or v_fy.closed_at is not null then
    raise exception 'Alleen een boekjaar dat nooit is afgesloten kan worden verwijderd.' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.journal_entries je
    where je.organization_id = p_organization_id and je.date between v_fy.period_start and v_fy.period_end
  ) then
    raise exception 'In boekjaar % staan al boekingen; het kan niet meer weg.', v_fy.label using errcode = '23514';
  end if;
  if exists (
    select 1 from public.closed_periods cp
    where cp.organization_id = p_organization_id
      and cp.period_start <= v_fy.period_end and cp.period_end >= v_fy.period_start
  ) then
    raise exception 'In boekjaar % is al een btw-tijdvak afgesloten; het kan niet meer weg.', v_fy.label using errcode = '23514';
  end if;
  if (select count(*) from public.fiscal_years where organization_id = p_organization_id) <= 1 then
    raise exception 'Dit is je enige boekjaar. Open eerst het goede boekjaar; daarna kan dit weg.' using errcode = '23514';
  end if;
  delete from public.fiscal_years where id = v_fy.id;
end;
$function$;

revoke all on function public.delete_open_fiscal_year(uuid, uuid) from public, anon;
grant execute on function public.delete_open_fiscal_year(uuid, uuid) to authenticated, service_role;
