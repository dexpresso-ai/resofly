-- ============================================================
-- ResoFly — Vof, maatschap en cv: privé via de bank en de inkoop
-- Date: 2026-11-22
--
-- Aanleiding: de controle van 22 november 2026 speelde bij een vof met twee
-- vennoten drie gaten na waar privé toch als kosten of voorbelasting in de
-- boeken kwam, of op geen enkele vennoot terechtkwam:
--
--   1. BTW OP PRIVÉ VIA DE INKOOP. Een concept-inkoopfactuur met de regel
--      "Privédeel Bram", € 50 op 0552 met 21%, werd geboekt met € 10,50
--      voorbelasting op 1500, en rubriek 5b telde die mee. De bank weigerde
--      btw op privé of kapitaal al (20261118090000, 20261118130000); de inkoop
--      niet. Gerrie kwam er ook (purchase_invoice.update, en supplier.update
--      met 0552 en 21% als standaard, waarna de inbox zo boekte). Nu weigeren
--      opslaan (enforce_purchase_invoice_lines) en boeken
--      (book_purchase_invoice) een regel met btw op een rekening van het type
--      equity, en heeft een leverancier met een privérekening als standaard
--      geen standaard-btw-code. De handelingen in
--      supabase/functions/_shared/actions/bookkeeping.ts weigeren het vooraf.
--   2. EEN PRIVÉ BETAALDE FACTUUR NOG EENS VIA DE BANK. Anna betaalde een
--      inkoop van € 968 met haar eigen pas (pay_purchase_invoice_privately).
--      De incasso van dezelfde leverancier op de zakelijke rekening werd
--      daarna door de bankregel "Drukkerij → 4500, 21%, vanzelf" als nieuwe
--      kosten geboekt: oktober € 1.600 kosten en € 336 voorbelasting in plaats
--      van € 800 en € 168. De matcher keek alleen naar openstaande facturen.
--      Nu boekt bank_match_run zo'n betaling niet vanzelf, past geen bankregel
--      toe en zegt hoe je het rechtzet.
--   3. INKOMSTENBELASTING NAAR 0550 BIJ EEN VOF. Een betaling aan de
--      Belastingdienst zonder aangifte wees naar "0550 Privé-opnamen". Bij een
--      vof met vennoten heet die "(geen vennoot)": wat erop staat, gaat bij de
--      jaarafsluiting naar 0500 en staat bij geen enkele vennoot op de
--      aangifte. Nu noemt de reden de privé-opnamen van de vennoten.
--
-- De drie vervangen functies zijn letterlijk overgenomen van wat op staging
-- draait (20261119180000 voor bank_match_run en book_purchase_invoice,
-- 20261106110000 voor enforce_purchase_invoice_lines); elke wijziging heeft een
-- regel "GEWIJZIGD/TOEGEVOEGD (20261122110000)". Getoetst door
-- tests/stromen/vof-bank-inkoop.mjs.
--
-- Veilig om opnieuw te draaien: create or replace, drop trigger if exists, en
-- een update die alleen raakt wat nog niet klopt. Geboekte stukken veranderen
-- niet.
-- ============================================================

begin;

-- ── 1. Opslaan: geen btw op privé of kapitaal in een inkoopregel ──────────

CREATE OR REPLACE FUNCTION public.enforce_purchase_invoice_lines()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_bad text;
  v_rate numeric;
  v_code text;
  v_name text;
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
  -- TOEGEVOEGD (20261122110000): geen btw op privé of kapitaal. Een regel
  -- "Privédeel Bram" van € 50 op 0552 met 21% werd opgeslagen en geboekt met
  -- € 10,50 voorbelasting op 1500, en rubriek 5b telde die mee. De bank weigerde
  -- dat al (book_bank_transaction, refuse_vat_on_equity_allocation); de inkoop
  -- niet, en via Gerrie en de factuur-inbox kwam het er ook in. Alleen bij een
  -- concept: een geboekte factuur ligt vast, en een oude geboekte regel herstel
  -- je met een tegenboeking (daarna is hij weer een concept, en geldt dit).
  -- "Met btw" is zoals bij het boeken: het tarief van de regel, anders dat van
  -- de code, of een btw-bedrag dat op de regel staat. Een code van 0% mag.
  if coalesce(new.status, 'draft') = 'draft' then
    select coalesce(nullif(btrim(l->>'description'), ''), '(zonder omschrijving)'), la.code, la.name
      into v_bad, v_code, v_name
      from jsonb_array_elements(new.lines) l
      join public.ledger_accounts la
        on la.organization_id = new.organization_id
       -- Als tekst: een kapot rekening-id hoort het boeken te weigeren, zoals
       -- het altijd deed, niet het opslaan met een onleesbare castfout.
       and la.id::text = lower(nullif(btrim(coalesce(l->>'account_id', '')), ''))
       and la.type = 'equity'
      left join public.vat_codes vc
        on vc.organization_id = new.organization_id
       and vc.code = nullif(btrim(coalesce(l->>'vat_code', '')), '')
     where coalesce(nullif(l->>'vat_rate', '')::numeric, vc.rate, 0) <> 0
        or (coalesce(l->>'vat_cents', '') ~ '^-?[0-9]+$' and (l->>'vat_cents')::bigint <> 0)
     limit 1;
    if v_code is not null then
      raise exception 'Inkoopregel "%": op % · % (eigen vermogen) hoort geen btw. Op een privé-uitgave trek je geen voorbelasting af: zet het bedrag inclusief btw op deze regel, met een btw-code van 0%%.', left(v_bad, 80), v_code, v_name
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$function$;

-- ── 2. Boeken: hetzelfde voor concepten die al bestonden ──────────────────

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
  v_equity_code text;
  v_equity_name text;
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
  -- TOEGEVOEGD (20261122110000): geen btw op privé of kapitaal. Een regel
  -- "Privédeel Bram" van € 50 op 0552 met 21% boekte € 10,50 voorbelasting op
  -- 1500, en rubriek 5b telde die mee. Opslaan weigert dat nu
  -- (enforce_purchase_invoice_lines); dit vangt de concepten die al bestonden.
  -- Het tarief zoals hieronder: dat van de regel, anders dat van de code.
  select coalesce(nullif(btrim(l->>'description'), ''), '(zonder omschrijving)'), la.code, la.name
    into v_bad_line, v_equity_code, v_equity_name
  from jsonb_array_elements(v_pi.lines) as l
  join public.ledger_accounts la
    on la.organization_id = p_organization_id
   and la.id = nullif(l->>'account_id','')::uuid
   and la.type = 'equity'
  left join public.vat_codes vc
    on vc.organization_id = p_organization_id and vc.code = nullif(btrim(coalesce(l->>'vat_code', '')), '')
  where coalesce(nullif(l->>'vat_rate','')::numeric, vc.rate, 0) <> 0
     or (coalesce(l->>'vat_cents', '') ~ '^-?[0-9]+$' and (l->>'vat_cents')::bigint <> 0)
  limit 1;
  if v_equity_code is not null then
    raise exception 'Inkoopregel "%": op % · % (eigen vermogen) hoort geen btw. Op een privé-uitgave trek je geen voorbelasting af: zet het bedrag inclusief btw op deze regel, met een btw-code van 0%%.',
      left(v_bad_line, 80), v_equity_code, v_equity_name using errcode = '23514';
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

-- ── 3. Een leverancier met een privérekening als standaard: geen btw-code ──
--
-- TOEGEVOEGD (20261122110000): de factuur-inbox en het scherm nemen de standaard
-- kostenrekening en btw-code van een leverancier over in een nieuwe regel, en
-- de bank stelt ze voor bij een betaling. Stond daar 0552 met 21%, dan kwam elke
-- factuur van die leverancier met voorbelasting op privé binnen. Een
-- privérekening als standaard mag (iemand betaalt er privézaken mee), maar dan
-- zonder btw-code. Net als bij een bankregel (refuse_vat_on_equity_bank_rule).
create or replace function public.refuse_vat_on_equity_supplier_default()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_name text;
begin
  if nullif(btrim(coalesce(new.default_vat_code, '')), '') is null or new.default_expense_account_id is null then
    return new;
  end if;
  select la.code, la.name into v_code, v_name
  from public.ledger_accounts la
  where la.id = new.default_expense_account_id
    and la.organization_id = new.organization_id
    and la.type = 'equity';
  if v_code is not null then
    raise exception 'Leverancier "%": % · % is privé of kapitaal (eigen vermogen), en daarop zit geen btw. Met deze standaardrekening krijgt de leverancier geen standaard-btw-code: laat die leeg.',
      left(new.name, 80), v_code, v_name using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists suppliers_no_vat_on_equity on public.suppliers;
create trigger suppliers_no_vat_on_equity
  before insert or update of default_expense_account_id, default_vat_code on public.suppliers
  for each row execute function public.refuse_vat_on_equity_supplier_default();

-- Bestaande leveranciers met zo'n combinatie: de btw-code eraf, zoals in
-- 20261118130000 bij de bankregels. Anders stelde elke nieuwe factuur en elke
-- betaling van die leverancier weer voorbelasting op privé voor. Wat al geboekt
-- is, blijft staan.
update public.suppliers s
set default_vat_code = null
where nullif(btrim(coalesce(s.default_vat_code, '')), '') is not null
  and exists (
    select 1 from public.ledger_accounts la
    where la.id = s.default_expense_account_id
      and la.organization_id = s.organization_id
      and la.type = 'equity'
  );

-- ── 4. De bank: een privé betaalde factuur, en de aanslag van een vennoot ──

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
  -- TOEGEVOEGD (20261122110000): zie stap 2b en 4b in de lus.
  v_private jsonb;
  v_priv jsonb;
  v_iban_norm text;
  v_iban_sup text;
  v_ib_hint text;
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
  -- TOEGEVOEGD (20261122110000): inkoopfacturen die de ondernemer of een vennoot privé
  -- betaalde (pay_purchase_invoice_privately), met een betaling die niet is
  -- tegengeboekt. Ze staan op betaald en zitten dus niet in v_open; zie stap 2b.
  -- Meestal zijn het er geen, en dan kost stap 2b niets.
  v_private := coalesce((
    select jsonb_agg(jsonb_build_object(
             'supplier_id', x.supplier_id::text,
             'name_norm', public.bank_name_norm(x.supplier_name),
             'label', x.label,
             'total_cents', x.total_cents,
             'private_cents', x.private_cents,
             'from', x.date - 60,
             'until', greatest(x.due, x.paid_on) + 90,
             'paid_on', x.paid_on,
             'who', x.who))
    from (
      select pi.supplier_id, s.name as supplier_name, pi.date, coalesce(pi.due_date, pi.date) as due,
             coalesce(nullif(btrim(pi.internal_number), ''), nullif(btrim(pi.supplier_invoice_number), ''), 'zonder nummer') as label,
             (select coalesce(sum(jl.credit_cents - jl.debit_cents), 0)
              from public.journal_lines jl
              join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_payable'
              where jl.entry_id = pi.journal_entry_id)::bigint as total_cents,
             p.private_cents, p.paid_on, p.who
      from (
        select je.source_id as purchase_invoice_id,
               sum(jl.debit_cents - jl.credit_cents)::bigint as private_cents,
               max(je.date) as paid_on,
               -- Wie betaalde: de vennoot van de privérekening, anders zoals het
               -- boekstuk het zegt ("Privé betaald door …: …").
               (array_agg(coalesce(
                  (select pp.name
                   from public.journal_lines jl2
                   join public.partnership_partners pp
                     on pp.organization_id = p_organization_id
                    and jl2.account_id in (pp.contributions_account_id, pp.withdrawals_account_id)
                   where jl2.entry_id = je.id
                   limit 1),
                  substring(je.description from '^Privé betaald door (.+?): '),
                  'de ondernemer') order by je.date desc, je.created_at desc))[1] as who
        from public.journal_entries je
        join public.journal_lines jl on jl.entry_id = je.id
        join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_payable'
        where je.organization_id = p_organization_id
          and je.source_type = 'purchase_private_payment'
          and je.status = 'posted'
          and je.reversed_by_entry_id is null and je.reverses_entry_id is null
        group by je.source_id
      ) p
      join public.purchase_invoices pi on pi.id = p.purchase_invoice_id and pi.organization_id = p_organization_id
      join public.suppliers s on s.id = pi.supplier_id and s.organization_id = p_organization_id
      where pi.status <> 'cancelled'
        and p.private_cents > 0
    ) x
  ), '[]'::jsonb);

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

    -- 2b. TOEGEVOEGD (20261122110000): een factuur die privé is betaald. Anna betaalde
    --     een factuur van € 968 per vergissing met haar eigen pas; daarna kwam
    --     de incasso van dezelfde drukkerij op de zakelijke rekening. Stap 2
    --     kijkt alleen naar wat openstaat, dus de bankregel "Drukkerij → 4500,
    --     21%, vanzelf" boekte de incasso als nieuwe kosten: oktober € 1.600
    --     kosten en € 336 voorbelasting in plaats van € 800 en € 168. Zonder
    --     bankregel werd het een voorstel 4500 met 21%, zonder waarschuwing.
    --     Nu: is het een betaling aan die leverancier (op IBAN, of op naam als
    --     het IBAN niet bij een andere leverancier hoort) van precies het bedrag
    --     van zo'n factuur, dan boekt ResoFly niets vanzelf, past geen bankregel
    --     toe en zegt wat er aan de hand is. Rond de factuur: van twee maanden
    --     ervoor tot drie maanden na de vervaldag of de privébetaling. Zonder die
    --     grens kreeg een maandelijkse incasso van hetzelfde bedrag na één
    --     privébetaling nooit meer zijn bankregel.
    if not v_done and v_txn.amount_cents < 0 and jsonb_array_length(v_private) > 0 then
      v_iban_norm := public.bank_norm_iban(v_txn.counterparty_iban);
      v_iban_sup := case when v_iban_norm is not null then nullif(v_ibans ->> v_iban_norm, '') end;
      v_priv := null;
      select e into v_priv
      from jsonb_array_elements(v_private) e
      where -v_txn.amount_cents in ((e ->> 'total_cents')::bigint, (e ->> 'private_cents')::bigint)
        and v_txn.booking_date between (e ->> 'from')::date and (e ->> 'until')::date
        and (e ->> 'supplier_id' = v_iban_sup
             or (v_iban_sup is null
                 and public.bank_name_matches(public.bank_name_norm(v_txn.counterparty_name), e ->> 'name_norm', false)))
      order by (e ->> 'paid_on')::date desc
      limit 1;
      if v_priv is not null then
        o_reason := format('Deze factuur (%s) staat als privé betaald door %s op %s. Betaalde de zaak hem, draai dan eerst de privébetaling terug (Grootboek → Journaal: tegenboeken) en boek deze betaling op de factuur.',
                           v_priv ->> 'label', v_priv ->> 'who', to_char((v_priv ->> 'paid_on')::date, 'DD-MM-YYYY'));
        v_done := true;
      end if;
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

    -- 4b. TOEGEVOEGD (20261119180000): de Belastingdienst, maar geen aangifte met dit
    --     bedrag en geen woord over btw. Geen voorstel (het kan btw zijn, of
    --     inkomstenbelasting), wel de weg. Wie de btw betaalde vóór hij het
    --     tijdvak in ResoFly afsloot, koos anders 1510 en hield 1510 en 1530
    --     met tegengestelde saldi; en inkomstenbelasting van de zakelijke
    --     rekening is bij een eenmanszaak of vof een privé-opname, geen kosten.
    if not v_done
       and (v_iban = 'NL86INGB0002445588' or coalesce(v_txn.counterparty_name,'') ilike '%belastingdienst%') then
      -- GEWIJZIGD (20261122110000): bij een vof, maatschap of cv met vennoten de
      -- privé-opnamen van de vennoot wiens aanslag het is, niet 0550. Daar heet
      -- 0550 "Privé-opnamen (geen vennoot)": wat erop staat, gaat bij de
      -- jaarafsluiting naar 0500 en staat bij geen enkele vennoot op de aangifte.
      -- Eén keer per ronde uitgezocht, pas als er zo'n betaling is.
      if v_ib_hint is null then
        v_ib_hint := case
          when public.org_fiscal_regime(p_organization_id) <> 'ib' then ''
          else coalesce((
            select ' Is dit inkomstenbelasting of de Zvw-bijdrage? Dat is privé: boek op de privé-opnamen van de vennoot wiens aanslag het is ('
                   || string_agg(la.code || ' ' || pp.name, ', ' order by la.code)
                   || '), niet op 0550: die staat op geen enkele vennoot.'
            from public.partnership_partners pp
            join public.ledger_accounts la on la.id = pp.withdrawals_account_id and la.organization_id = p_organization_id
            where pp.organization_id = p_organization_id
              and pp.is_active
              and public.org_legal_form(p_organization_id) in ('vof', 'maatschap', 'cv')
            having count(*) > 0
          ), ' Is dit inkomstenbelasting of de Zvw-bijdrage? Dat is privé: boek op 0550 Privé-opnamen.')
        end;
      end if;
      o_reason := 'Belastingdienst, maar er is in ResoFly geen aangifte met dit bedrag. Is dit btw? Sluit dan eerst het tijdvak af bij Omzetbelasting en klik op Opnieuw matchen, of boek op 1530 Te betalen omzetbelasting (niet op 1500 of 1510).'
        || v_ib_hint;
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

-- ── 5. Rechten ──────────────────────────────────────────────────────────────
-- create or replace laat de rechten staan. Ze staan er toch bij, zoals ze nu
-- zijn: de publieke sleutel (anon) mag nergens bij, en een verse database mag
-- niet afhangen van wat een eerdere migratie toevallig deed.
revoke all on function public.bank_match_run(uuid, uuid, uuid, uuid[], boolean, integer, text) from public, anon, authenticated;
grant execute on function public.bank_match_run(uuid, uuid, uuid, uuid[], boolean, integer, text) to service_role;
revoke all on function public.book_purchase_invoice(uuid, uuid, uuid) from public, anon;
grant execute on function public.book_purchase_invoice(uuid, uuid, uuid) to authenticated, service_role;
-- Triggerfuncties vuren ook zonder EXECUTE.
revoke all on function public.enforce_purchase_invoice_lines() from public, anon, authenticated;
grant execute on function public.enforce_purchase_invoice_lines() to service_role;
revoke all on function public.refuse_vat_on_equity_supplier_default() from public, anon, authenticated;
grant execute on function public.refuse_vat_on_equity_supplier_default() to service_role;

commit;
