-- ============================================================
-- ResoFly — Financiën: tweede controle op werking en veiligheid
-- Date: 2026-11-05
--
-- Na 20261105000000 nog een ronde over de hele module, met vier
-- onafhankelijke reviews (verkoop in de app, de edge functions voor verkoop,
-- boekhouding en exports, bank en inkoop). Wat de controle van contract,
-- offerte en factuur (20261105230000) al oploste, staat hier niet nog eens.
-- Wat hier in de database zit:
--
--   1. bankmatching: een factuurnummer telt alleen als los kenmerk, en alleen
--      bij een factuur die nog openstaat; de Belastingdienst gaat niet meer
--      standaard naar 1530;
--   2. inkoopfacturen krijgen een betaalstatus als ze via de bank betaald zijn;
--   3. een banktransactie in een andere valuta boekt niet als euro's;
--   4. "Betaald" op een geboekte factuur alleen als er niets meer openstaat;
--   5. leveranciers die de inbox aanmaakt, moet eerst een mens bevestigen
--      voordat de inbox er automatisch op boekt;
--   6. een btw-periode sluit op het saldo dat de gebruiker bevestigde;
--   7. tegenboeken: niet bij een verkoopfactuur, creditnota of betaling (die
--      hebben een eigen terugweg); een inkoopfactuur gaat mee terug naar
--      concept;
--   8. verkoopboeking: bij de KOR niet meer stil btw op nul;
--   9. de aangifte telt een btw-regel met eigen grondslag mee (rubriek 1a/1b);
--  10. verkoop van een bedrijfsmiddel met btw.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Hulpfuncties voor de bankmatching en de inkoopkant ──────────────────

-- Staat een factuurnummer als los kenmerk in de banktekst? De tekst is al
-- klein en zonder spaties (zoals match_bank_transactions hem opbouwt). Een
-- kenmerk telt niet als het midden in een getal staat ("42" in "4211"), en
-- korte of kale getallen ("42", "2026") zeggen te weinig.
create or replace function public.bank_text_mentions_reference(p_haystack text, p_reference text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare
  v_ref text := lower(regexp_replace(coalesce(p_reference, ''), '\s', '', 'g'));
  v_hay text := coalesce(p_haystack, '');
  v_from integer := 1;
  v_pos integer;
  v_before text;
  v_after text;
begin
  if length(v_ref) < 3 or (v_ref ~ '^[0-9]+$' and length(v_ref) < 5) then
    return false;
  end if;
  loop
    v_pos := strpos(substr(v_hay, v_from), v_ref);
    exit when v_pos = 0;
    v_pos := v_from + v_pos - 1;
    v_before := case when v_pos > 1 then substr(v_hay, v_pos - 1, 1) else '' end;
    v_after := substr(v_hay, v_pos + length(v_ref), 1);
    if not (left(v_ref, 1) ~ '[0-9]' and v_before ~ '[0-9]')
       and not (right(v_ref, 1) ~ '[0-9]' and v_after ~ '[0-9]') then
      return true;
    end if;
    v_from := v_pos + 1;
  end loop;
  return false;
end;
$$;

-- Wat staat er nog open op een geboekte inkoopfactuur? Zelfde rekensom als
-- book_bank_transaction: wat de boeking op 1600 zette, min wat geboekte
-- betalingen eraf haalden. Alleen voor functies van de server.
create or replace function public.purchase_invoice_open_payable_cents(p_organization_id uuid, p_purchase_invoice_id uuid)
returns bigint
language sql
stable
set search_path = public
as $$
  select coalesce((
    select sum(jl.credit_cents - jl.debit_cents)
    from public.purchase_invoices pi
    join public.journal_entries je on je.id = pi.journal_entry_id and je.reversed_by_entry_id is null
    join public.journal_lines jl on jl.entry_id = je.id
    join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_payable'
    where pi.id = p_purchase_invoice_id and pi.organization_id = p_organization_id
  ), 0)::bigint - coalesce((
    select sum(jl.debit_cents - jl.credit_cents)
    from public.bank_transactions bt
    join public.journal_entries je2 on je2.id = bt.journal_entry_id and je2.reversed_by_entry_id is null
    join public.journal_lines jl on jl.entry_id = je2.id
    join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_payable'
    where bt.organization_id = p_organization_id
      and bt.matched_purchase_invoice_id = p_purchase_invoice_id
      and bt.status = 'booked'
  ), 0)::bigint;
$$;

-- ── 2. Betaalstatus van inkoopfacturen ─────────────────────────────────────
-- Tot nu toe zette niets de betaalstatus van een inkoopfactuur: die bleef op
-- 'unpaid', ook na een volledige betaling via de bank. Gerrie leidt "wat moet
-- ik nog betalen?" en "te laat" daarvan af, dus een betaalde factuur stond als
-- open of achterstallig, met het risico van dubbel betalen.
create or replace function public.refresh_purchase_invoice_payment_status(p_organization_id uuid, p_purchase_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pi public.purchase_invoices;
  v_total bigint;
  v_open bigint;
  v_status text;
  v_paid_at timestamptz;
begin
  select * into v_pi from public.purchase_invoices
  where id = p_purchase_invoice_id and organization_id = p_organization_id;
  if not found or v_pi.journal_entry_id is null then
    return;
  end if;

  select coalesce(sum(jl.credit_cents - jl.debit_cents), 0) into v_total
  from public.journal_lines jl
  join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_payable'
  where jl.entry_id = v_pi.journal_entry_id;

  v_open := public.purchase_invoice_open_payable_cents(p_organization_id, p_purchase_invoice_id);
  v_status := case
    when v_total > 0 and v_open <= 0 then 'paid'
    when v_open < v_total then 'partially_paid'
    else 'unpaid'
  end;
  if v_status = 'paid' then
    select max(bt.booking_date)::timestamptz into v_paid_at
    from public.bank_transactions bt
    where bt.organization_id = p_organization_id
      and bt.matched_purchase_invoice_id = p_purchase_invoice_id
      and bt.status = 'booked';
    v_paid_at := coalesce(v_paid_at, now());
  end if;

  update public.purchase_invoices
  set payment_status = v_status, paid_at = v_paid_at
  where id = p_purchase_invoice_id
    and (payment_status is distinct from v_status or paid_at is distinct from v_paid_at);
end;
$$;

create or replace function public.sync_purchase_invoice_payment_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  for v_id in
    select distinct x from unnest(array[
      case when tg_op = 'UPDATE' then old.matched_purchase_invoice_id end,
      new.matched_purchase_invoice_id
    ]) as x
    where x is not null
  loop
    perform public.refresh_purchase_invoice_payment_status(new.organization_id, v_id);
  end loop;
  return null;
end;
$$;

drop trigger if exists bank_transactions_purchase_payment_status on public.bank_transactions;
create trigger bank_transactions_purchase_payment_status
  after insert or update of status, journal_entry_id, matched_purchase_invoice_id on public.bank_transactions
  for each row execute function public.sync_purchase_invoice_payment_status();

-- Bestaande inkoopfacturen meteen goed zetten.
do $$
declare r record;
begin
  for r in select organization_id, id from public.purchase_invoices where journal_entry_id is not null loop
    perform public.refresh_purchase_invoice_payment_status(r.organization_id, r.id);
  end loop;
end $$;

-- ── 3. Een banktransactie in een andere valuta boekt niet als euro's ───────
-- MT940, CSV en de bankkoppeling kunnen een andere valuta aanleveren; het
-- grootboek boekt in euro's zonder omrekening. Een USD-bedrag werd zo als
-- euro's geboekt.
create or replace function public.enforce_bank_transaction_eur_booking()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'booked' and old.status is distinct from 'booked'
     and upper(coalesce(nullif(btrim(new.currency), ''), 'EUR')) <> 'EUR' then
    raise exception 'Deze banktransactie is in %. Het grootboek boekt in euro''s: reken het bedrag om en boek het met een memoriaalpost.', upper(new.currency)
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists bank_transactions_eur_booking on public.bank_transactions;
create trigger bank_transactions_eur_booking
  before update of status on public.bank_transactions
  for each row execute function public.enforce_bank_transaction_eur_booking();

-- ── 4. "Betaald" op een geboekte factuur alleen als er niets meer openstaat ─
-- Het scherm bood "Betaald" ook bij een geboekte factuur met een openstaand
-- saldo. De status zei dan betaald terwijl 1300 open bleef. Gerrie en de API
-- weigerden dat al (20261105230000, open punt 1 van die controle); nu de
-- database ook, voor elke gebruiker. De betaalboekingen zelf (bank, Mollie)
-- lopen als server en vallen hierbuiten.
create or replace function public.enforce_invoice_paid_needs_payment()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_open bigint;
begin
  if current_user not in ('anon', 'authenticated', 'authenticator') then
    return new;
  end if;
  if new.status = 'paid' and old.status is distinct from 'paid' and new.journal_entry_id is not null then
    v_open := public.invoice_open_receivable_checked(new.id);
    if coalesce(v_open, 0) > 0 then
      raise exception 'Factuur % staat in het grootboek en er staat nog € % open. Boek de ontvangst bij de bank (of met een memoriaalpost); dan gaat de factuur vanzelf op betaald.',
        coalesce(new.number, ''), replace(to_char(v_open / 100.0, 'FM999999990.00'), '.', ',')
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists invoices_paid_needs_payment on public.invoices;
create trigger invoices_paid_needs_payment
  before update of status on public.invoices
  for each row execute function public.enforce_invoice_paid_needs_payment();

-- ── 5. Leveranciers uit de inbox eerst laten bevestigen ────────────────────
-- De inbox maakt bij een onbekende afzender een leverancier aan, met het IBAN
-- en btw-nummer uit dat document. Bij de volgende factuur gold die
-- leverancier als "bekend" en het IBAN als "gecontroleerd": het vergeleek het
-- IBAN met zichzelf. Met Direct boeken aan boekte iemand met het inboxadres zo
-- kosten en voorbelasting, zonder dat een mens de leverancier ooit zag.
alter table public.suppliers add column if not exists inbox_unverified boolean not null default false;
comment on column public.suppliers.inbox_unverified is
  'Aangemaakt door de factuur-inbox en nog niet door een mens bevestigd. Zolang dit aan staat, boekt de inbox niets automatisch op deze leverancier.';

update public.suppliers s
set inbox_unverified = true
where not s.inbox_unverified
  and exists (
    select 1 from public.purchase_invoice_inbox pii
    where pii.supplier_id = s.id and pii.organization_id = s.organization_id and pii.supplier_created
  );

-- ── 6. Btw-periode afsluiten op het bedrag dat de gebruiker bevestigde ─────
-- De kaart en het scherm tonen het saldo van het moment van bekijken;
-- afsluiten rekende opnieuw. Kwam er intussen een boeking bij, dan ging de
-- periode voorgoed dicht op een ander bedrag dan bevestigd, met de oude tekst
-- in de melding. Nu geeft de aanroeper het bevestigde saldo mee; wijkt het af,
-- dan sluit er niets.
drop function if exists public.close_vat_period(uuid, text, integer, integer, date, date);
create or replace function public.close_vat_period(
  p_organization_id uuid,
  p_period_type text,
  p_year integer,
  p_period_index integer,
  p_from date,
  p_to date,
  p_expected_saldo_cents bigint default null
)
returns public.vat_returns
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_ret public.vat_returns;
  v_saldo bigint;
begin
  if auth.role() <> 'service_role'
     and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_ret from public.finalize_vat_return(
    p_organization_id, p_period_type, p_year, p_period_index, p_from, p_to
  );

  v_saldo := coalesce((v_ret.rubrieken->>'saldo_afgerond')::bigint, 0);
  if p_expected_saldo_cents is not null and v_saldo <> p_expected_saldo_cents then
    raise exception 'Het saldo van deze periode is veranderd sinds je het bekeek: nu € %, bevestigd was € %. Er is niets afgesloten; bekijk de aangifte opnieuw.',
      replace(to_char(v_saldo / 100.0, 'FM999999990.00'), '.', ','),
      replace(to_char(p_expected_saldo_cents / 100.0, 'FM999999990.00'), '.', ',')
      using errcode = '23514';
  end if;

  update public.vat_returns
    set status = 'filed', filed_at = now(), filed_by = auth.uid()
    where id = v_ret.id
    returning * into v_ret;

  return v_ret;
end;
$function$;

-- ── 7. Bankmatching (zie 1) ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.match_bank_transactions(p_organization_id uuid, p_bank_account_id uuid DEFAULT NULL::uuid, p_created_by uuid DEFAULT auth.uid())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_txn public.bank_transactions;
  v_inv_id uuid;
  v_pi_id uuid;
  v_rule public.bank_rules;
  v_sup public.suppliers;
  v_suggested integer := 0;
  v_auto integer := 0;
  v_haystack text;
  v_iban text;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  for v_txn in
    select * from public.bank_transactions
    where organization_id = p_organization_id
      and status = 'unmatched'
      and (p_bank_account_id is null or bank_account_id = p_bank_account_id)
    order by booking_date
  loop
    v_inv_id := null; v_pi_id := null; v_rule := null; v_sup := null;
    v_haystack := lower(replace(coalesce(v_txn.description,'') || ' ' || coalesce(v_txn.structured_reference,''), ' ', ''));
    v_iban := upper(replace(coalesce(v_txn.counterparty_iban,''), ' ', ''));

    if v_txn.amount_cents > 0 then
      -- Ontvangst: zoek verkoopfactuur op factuurnummer in omschrijving/kenmerk.
      -- FIX 2: alleen facturen die in het grootboek staan (afletterbaar).
      select i.id into v_inv_id
      from public.invoices i
      where i.organization_id = p_organization_id
        and i.status not in ('cancelled','void')
        and i.journal_entry_id is not null
        and i.number is not null and length(btrim(i.number)) > 0
        -- GEWIJZIGD (20261105233000): als los kenmerk (niet "42" binnen
        -- "4211"), en alleen een factuur waarop nog iets openstaat.
        and public.bank_text_mentions_reference(v_haystack, i.number)
        and public.invoice_open_receivable_cents(p_organization_id, i.id) > 0
      order by (case when round(coalesce(i.total_amount,0) * 100) = abs(v_txn.amount_cents) then 0 else 1 end), i.date desc
      limit 1;
    elsif v_txn.amount_cents < 0 then
      -- Betaling: zoek inkoopfactuur op intern/leveranciers-nummer.
      -- FIX 2: alleen geboekte inkoopfacturen (afletterbaar).
      select pi.id into v_pi_id
      from public.purchase_invoices pi
      where pi.organization_id = p_organization_id
        and pi.status <> 'cancelled'
        and pi.journal_entry_id is not null
        -- GEWIJZIGD (20261105233000): een los kenmerk van minstens drie tekens
        -- (cijfers alleen vanaf vijf), en alleen wat nog openstaat. Een geboekte
        -- inkoopfactuur "42" werd anders bij elke pinbetaling "BEA Shell 4211"
        -- voorgesteld, en de bankregel voor Shell kwam nooit aan de beurt.
        and (
          (pi.internal_number is not null and public.bank_text_mentions_reference(v_haystack, pi.internal_number))
          or (pi.supplier_invoice_number is not null and public.bank_text_mentions_reference(v_haystack, pi.supplier_invoice_number))
        )
        and public.purchase_invoice_open_payable_cents(p_organization_id, pi.id) > 0
      order by (case when pi.total_cents = abs(v_txn.amount_cents) then 0 else 1 end), pi.date desc
      limit 1;
    end if;

    if v_inv_id is not null then
      update public.bank_transactions
      set status = 'suggested', matched_invoice_id = v_inv_id, match_confidence = 'invoice', updated_at = now()
      where id = v_txn.id;
      v_suggested := v_suggested + 1;
      continue;
    end if;
    if v_pi_id is not null then
      update public.bank_transactions
      set status = 'suggested', matched_purchase_invoice_id = v_pi_id, match_confidence = 'purchase_invoice', updated_at = now()
      where id = v_txn.id;
      v_suggested := v_suggested + 1;
      continue;
    end if;

    -- Regels op prioriteit; eerste match wint.
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
      if v_rule.auto_book and v_rule.target_account_id is not null then
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
          v_auto := v_auto + 1;
        exception when others then
          -- Automatisch boeken mislukt (bv. afgesloten periode): zet als voorstel klaar
          -- i.p.v. de hele import/match terug te draaien.
          update public.bank_transactions
          set status = 'suggested',
              suggested_account_id = v_rule.target_account_id,
              suggested_vat_code = v_rule.target_vat_code,
              matched_rule_id = v_rule.id,
              match_confidence = 'rule',
              updated_at = now()
          where id = v_txn.id;
          v_suggested := v_suggested + 1;
        end;
      else
        update public.bank_transactions
        set status = 'suggested',
            suggested_account_id = v_rule.target_account_id,
            suggested_vat_code = v_rule.target_vat_code,
            matched_rule_id = v_rule.id,
            match_confidence = 'rule',
            updated_at = now()
        where id = v_txn.id;
        v_suggested := v_suggested + 1;
      end if;
      continue;
    end if;

    -- Belastingdienst herkennen (betaling én teruggave): stel 1530 Te betalen
    -- omzetbelasting voor. NL86INGB0002445588 is de inningsrekening; teruggaven komen
    -- binnen onder tegenpartijnaam "Belastingdienst".
    -- GEWIJZIGD (20261105233000): op die rekening betaal je ook loonheffing,
    -- Vpb en inkomstenbelasting. Alleen 1530 voorstellen als het bedrag past op
    -- een ingediende, nog niet betaalde btw-aangifte, of als de omschrijving
    -- over btw gaat. Anders kiest de gebruiker zelf.
    if (v_iban = 'NL86INGB0002445588'
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
      update public.bank_transactions
      set status = 'suggested',
          suggested_account_id = public.bookkeeping_account_id(p_organization_id, '1530'),
          suggested_vat_code = null,
          match_confidence = 'tax_authority',
          updated_at = now()
      where id = v_txn.id;
      v_suggested := v_suggested + 1;
      continue;
    end if;

    -- Geen regel: bij een betaling de leverancier op IBAN voorstellen.
    if v_txn.amount_cents < 0 and v_txn.counterparty_iban is not null then
      select * into v_sup from public.suppliers s
      where s.organization_id = p_organization_id
        and s.iban is not null
        and upper(replace(s.iban,' ','')) = v_iban
      limit 1;
      if v_sup.id is not null then
        update public.bank_transactions
        set status = 'suggested',
            suggested_account_id = v_sup.default_expense_account_id,
            suggested_vat_code = v_sup.default_vat_code,
            match_confidence = 'supplier_iban',
            updated_at = now()
        where id = v_txn.id;
        v_suggested := v_suggested + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object('suggested', v_suggested, 'auto_booked', v_auto);
end;
$function$;


-- ── 8. Tegenboeken ──────────────────────────────────────────────────────────
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
  v_context text;
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
  if v_src.source_type = 'purchase_invoice' and exists (
    select 1 from public.bank_transactions bt
    where bt.organization_id = v_src.organization_id
      and bt.matched_purchase_invoice_id = v_src.source_id
      and bt.status = 'booked'
  ) then
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


-- ── 9. Verkoopfactuur boeken (basis: 20261105230000) ────────────────────────
CREATE OR REPLACE FUNCTION public.post_sales_invoice_to_ledger(p_organization_id uuid, p_invoice_id uuid, p_created_by uuid DEFAULT auth.uid())
 RETURNS journal_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_inv public.invoices;
  v_start date;
  v_lines jsonb := '[]'::jsonb;
  v_output_vat bigint := 0;
  v_receivable bigint := 0;
  v_entry public.journal_entries;
  v_book_date date;
  v_desc text;
  r record;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_inv from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Factuur niet gevonden.' using errcode = '02000';
  end if;
  if v_inv.journal_entry_id is not null then
    raise exception 'Deze factuur is al naar het grootboek geboekt.' using errcode = '23514';
  end if;
  -- Statusguard: alleen een uitgegeven factuur boekt omzet. Concept/geannuleerd niet.
  if v_inv.status in ('draft', 'cancelled') then
    raise exception 'Een % factuur kan niet naar het grootboek worden geboekt.', v_inv.status using errcode = '23514';
  end if;

  select bookkeeping_start_date into v_start
  from public.company_settings where organization_id = p_organization_id;

  if v_start is not null and v_inv.date < v_start then
    raise exception 'Factuurdatum ligt vóór de boekhoud-startdatum (%); deze omzet zit al in de beginbalans.', v_start
      using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);

  -- Omzet per (btw-code, tarief); btw per groep afgerond. Het TARIEF komt van
  -- de factuurregel (dat is wat gefactureerd is); de CODE bepaalt de rubriek
  -- (via vat_codes.sales_box in de aangifte) en de omzetrekening: buitenland/
  -- verlegd (3a/3b/3c of verlegd-verkoop) → 8030, anders op tarief.
  -- GEWIJZIGD (20261105230000): (1) aantal, prijs en tarief worden gelezen zoals
  -- invoice_calculated_totals ze leest (een onleesbare waarde telt als 0); een
  -- harde ::numeric liet het boeken mislukken of boekte iets anders dan het
  -- factuurtotaal ("1e3" gaf totaal € 0 en een vordering van € 121.000).
  -- (2) De btw wordt per TARIEF afgerond, zoals op de factuur, de PDF, de UBL en
  -- bij Mollie; per (code, tarief) afronden gaf bij twee regels van € 1,02 tegen
  -- 21% (één zonder code, één met HOOG) een vordering van € 2,46 tegen een
  -- factuur van € 2,47 — en daarna kon de factuur niet meer worden gecrediteerd.
  -- Het afrondingsverschil binnen een tarief gaat naar de grootste groep.
  for r in
    with regels as (
      select
        nullif(btrim(coalesce(line->>'vat_code', '')), '') as vat_code,
        case when coalesce(line->>'vat', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (line->>'vat')::numeric else 0 end as rate,
        round(
          (case when coalesce(line->>'quantity', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (line->>'quantity')::numeric else 0 end)
          * (case when coalesce(line->>'unit_price', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (line->>'unit_price')::numeric else 0 end)
          * 100) as base_cents
      from jsonb_array_elements(v_inv.lines) as line
    ),
    groepen as (
      select g.vat_code, (vc.id is not null) as has_code, vc.kind, vc.sales_box, g.rate, sum(g.base_cents) as base_cents
        from regels g
        left join public.vat_codes vc
          on vc.organization_id = p_organization_id
         and vc.code = g.vat_code
       group by 1, 2, 3, 4, 5
    ),
    per_tarief as (
      select rate, round(sum(base_cents) * rate / 100.0) as rate_vat_cents
        from groepen
       group by rate
    ),
    gerangschikt as (
      select gr.*, round(gr.base_cents * gr.rate / 100.0) as group_vat_cents, pt.rate_vat_cents,
             row_number() over (partition by gr.rate order by abs(gr.base_cents) desc, gr.vat_code nulls last) as rn
        from groepen gr
        join per_tarief pt on pt.rate = gr.rate
    )
    select x.vat_code, x.has_code, x.kind, x.sales_box, x.rate, x.base_cents,
           x.group_vat_cents + case when x.rn = 1
             then x.rate_vat_cents - sum(x.group_vat_cents) over (partition by x.rate)
             else 0 end as vat_cents
      from gerangschikt x
  loop
    declare
      -- GEWIJZIGD (20261105233000): bij de KOR werd de btw hier stil op 0 gezet,
      -- ook als de factuur btw noemde. Btw die op een factuur staat, is
      -- verschuldigd (art. 37 Wet OB 1968), en 1300 week dan af van het
      -- factuurbedrag. Sinds 20261105230000 gaat een KOR-factuur met btw niet
      -- de deur uit (invoices_kor_no_vat); wat hier nog met btw aankomt, is
      -- uitgegeven vóór de KOR aanging. Die btw hoort in het grootboek.
      v_vat bigint := r.vat_cents;
      v_revenue_account text := case
        when r.has_code and (r.sales_box in ('3a','3b','3c') or r.kind = 'reverse_charge_sales') then '8030'
        when r.rate >= 21 then '8000'
        when r.rate > 0 then '8010'
        else '8020'
      end;
    begin
      -- GEWIJZIGD (20261104020000): een negatieve groep (korting, correctie)
      -- komt aan de debetzijde; een negatieve credit bestaat niet en liet het
      -- boeken stil mislukken. Grondslag en btw houden hun teken.
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, v_revenue_account),
        'description', 'Omzet',
        'debit_cents', greatest(-r.base_cents, 0), 'credit_cents', greatest(r.base_cents, 0),
        'vat_code', r.vat_code,
        'vat_rate', r.rate, 'vat_base_cents', r.base_cents, 'vat_amount_cents', v_vat,
        'client_id', v_inv.client_id, 'project_id', v_inv.project_id
      ));
      v_output_vat := v_output_vat + v_vat;
      v_receivable := v_receivable + r.base_cents + v_vat;
    end;
  end loop;

  if v_output_vat <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1510'),
      'description', 'Af te dragen BTW',
      'debit_cents', greatest(-v_output_vat, 0), 'credit_cents', greatest(v_output_vat, 0),
      'client_id', v_inv.client_id
    ));
  end if;

  if v_receivable <> 0 then
    v_lines := jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1300'),
      'description', 'Debiteuren',
      'debit_cents', greatest(v_receivable, 0), 'credit_cents', greatest(-v_receivable, 0),
      'client_id', v_inv.client_id
    )) || v_lines;
  end if;

  -- Nagekomen factuur in een al ingediende periode: boek op de eerstvolgende
  -- open datum (documentdatum blijft leidend op de factuur zelf). De btw komt
  -- dan in de eerstvolgende aangifte (kleine correctie) of via een suppletie.
  v_book_date := public.first_open_booking_date(p_organization_id, v_inv.date);
  v_desc := 'Verkoopfactuur ' || coalesce(v_inv.number, '');
  if v_book_date <> v_inv.date then
    v_desc := v_desc || ' (factuurdatum ' || to_char(v_inv.date, 'DD-MM-YYYY') || ', geboekt in eerstvolgende open periode)';
  end if;

  v_entry := public.post_journal_entry(
    p_organization_id, v_book_date, v_desc,
    'sales_invoice', v_inv.id, v_lines, p_created_by
  );

  update public.invoices set journal_entry_id = v_entry.id where id = v_inv.id;
  return v_entry;
end;
$function$;


-- ── 10. Btw-rubrieken ───────────────────────────────────────────────────────
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
          else '1e'
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


-- ── 11. Desinvestering met btw ──────────────────────────────────────────────
-- Nieuwe parameter p_vat_code: eerst de oude handtekening weg, anders
-- bestaan er twee functies en kiest PostgREST er geen.
drop function if exists public.book_asset_disposal(uuid, uuid, uuid, bigint, date, uuid);
CREATE OR REPLACE FUNCTION public.book_asset_disposal(p_organization_id uuid, p_asset_id uuid, p_counter_account_id uuid, p_proceeds_cents bigint DEFAULT 0, p_disposal_date date DEFAULT NULL::date, p_created_by uuid DEFAULT auth.uid(), p_vat_code text DEFAULT NULL::text)
 RETURNS fixed_assets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_asset public.fixed_assets;
  v_accumulated bigint;
  v_book_value bigint;
  v_proceeds bigint := greatest(coalesce(p_proceeds_cents, 0), 0);
  v_result bigint;                 -- opbrengst − boekwaarde (winst > 0, verlies < 0)
  v_result_account uuid;
  v_lines jsonb := '[]'::jsonb;
  v_entry public.journal_entries;
  v_disposal_date date;
  v_book_date date;
  v_vc public.vat_codes;
  v_vat bigint := 0;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_asset from public.fixed_assets
  where id = p_asset_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Activum niet gevonden.' using errcode = '02000';
  end if;
  if v_asset.status = 'disposed' then
    raise exception 'Dit activum is al afgestoten.' using errcode = '23514';
  end if;
  if v_asset.acquisition_journal_entry_id is null then
    raise exception 'De aanschaf van dit activum staat nog niet in het grootboek; boek die eerst.' using errcode = '23514';
  end if;
  if p_counter_account_id is null then
    raise exception 'Kies een tegenrekening voor de opbrengst (bank/debiteuren, of dezelfde als geen opbrengst).' using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);
  -- Zelfvoorzienend: zorg dat het boekresultaat-rekeningnummer bestaat.
  insert into public.ledger_accounts (organization_id, code, name, type, subtype, is_system)
  values (p_organization_id, '4950', 'Boekresultaat vaste activa', 'expense', 'asset_disposal_result', true)
  on conflict (organization_id, code) do nothing;

  v_disposal_date := coalesce(p_disposal_date, current_date);

  -- Opgebouwde afschrijving = som van de GEBOEKTE afschrijvingen van dit activum.
  select coalesce(sum(amount_cents), 0) into v_accumulated
  from public.asset_depreciations
  where asset_id = p_asset_id and status = 'posted';

  v_book_value := v_asset.acquisition_cost_cents - v_accumulated;
  v_result := v_proceeds - v_book_value;

  -- TOEGEVOEGD (20261105233000): de verkoop van een bedrijfsmiddel is een
  -- belaste levering (art. 1 onderdeel a Wet OB 1968). De opbrengst is
  -- exclusief btw; de btw gaat naar 1510 en, met code en grondslag op die
  -- regel, naar rubriek 1a/1b. Eerder bestond er geen btw bij een verkoop: wie
  -- het brutobedrag invulde, boekte de btw als boekwinst.
  if p_vat_code is not null and btrim(p_vat_code) <> '' and v_proceeds > 0 then
    select * into v_vc from public.vat_codes
    where organization_id = p_organization_id and code = btrim(p_vat_code);
    if not found then
      raise exception 'Btw-code % bestaat niet in deze administratie.', p_vat_code using errcode = '23514';
    end if;
    if v_vc.sales_box in ('1a', '1b', '1c', '1d') then
      v_vat := round(v_proceeds * coalesce(v_vc.rate, 0) / 100.0)::bigint;
    elsif v_vc.sales_box is distinct from '1e' and v_vc.kind not in ('exempt', 'zero', 'kor') then
      raise exception 'Btw-code % is geen code voor een verkoop in Nederland; kies bijvoorbeeld HOOG, LAAG of VRIJ.', p_vat_code using errcode = '23514';
    end if;
  end if;

  -- a) Aanschafwaarde van de balans halen (credit activarekening).
  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account_id', v_asset.asset_account_id, 'description', 'Afboeken aanschaf ' || v_asset.name,
    'debit_cents', 0, 'credit_cents', v_asset.acquisition_cost_cents));

  -- b) Opgebouwde afschrijving terugnemen (debet cumulatieve-afschrijvingrekening).
  if v_accumulated <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_asset.accumulated_depreciation_account_id, 'description', 'Afboeken cum. afschrijving ' || v_asset.name,
      'debit_cents', v_accumulated, 'credit_cents', 0));
  end if;

  -- c) Opbrengst (debet tegenrekening: bank/debiteuren), inclusief btw.
  if v_proceeds > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', p_counter_account_id, 'description', 'Opbrengst verkoop ' || v_asset.name,
      'debit_cents', v_proceeds + v_vat, 'credit_cents', 0));
  end if;

  -- c2) Btw over de opbrengst, met code en grondslag (zie compute_vat_boxes).
  if v_vat <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1510'),
      'description', 'Btw verkoop ' || v_asset.name,
      'debit_cents', 0, 'credit_cents', v_vat,
      'vat_code', v_vc.code, 'vat_rate', v_vc.rate,
      'vat_base_cents', v_proceeds, 'vat_amount_cents', v_vat));
  end if;

  -- d) Boekwinst (credit) of boekverlies (debet) als sluitpost op 4950.
  if v_result <> 0 then
    v_result_account := public.bookkeeping_account_id(p_organization_id, '4950');
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_result_account,
      'description', case when v_result > 0 then 'Boekwinst' else 'Boekverlies' end || ' verkoop ' || v_asset.name,
      'debit_cents', case when v_result < 0 then -v_result else 0 end,
      'credit_cents', case when v_result > 0 then v_result else 0 end));
  end if;

  v_book_date := public.first_open_booking_date_for(p_organization_id, v_disposal_date, public.journal_lines_touch_vat(p_organization_id, v_lines));
  v_entry := public.post_journal_entry(
    p_organization_id, v_book_date,
    'Desinvestering ' || coalesce(v_asset.asset_number, v_asset.name),
    'asset_disposal', p_asset_id, v_lines, p_created_by);

  -- Resterende geplande afschrijvingen vervallen; activum op 'disposed'.
  delete from public.asset_depreciations where asset_id = p_asset_id and status = 'scheduled';
  update public.fixed_assets
  set status = 'disposed', disposal_date = v_disposal_date, disposal_proceeds_cents = v_proceeds
  where id = p_asset_id;

  select * into v_asset from public.fixed_assets where id = p_asset_id;
  return v_asset;
end;
$function$;


-- ── 12. Rechten ────────────────────────────────────────────────────────────
-- Hulpfuncties en triggers: alleen de server. De RPC's houden de rechten die
-- ze hadden (authenticated en service_role), nooit anon.
revoke all on function public.bank_text_mentions_reference(text, text) from public, anon, authenticated;
revoke all on function public.purchase_invoice_open_payable_cents(uuid, uuid) from public, anon, authenticated;
revoke all on function public.refresh_purchase_invoice_payment_status(uuid, uuid) from public, anon, authenticated;
grant execute on function public.refresh_purchase_invoice_payment_status(uuid, uuid) to service_role;
revoke all on function public.sync_purchase_invoice_payment_status() from public, anon, authenticated;
revoke all on function public.enforce_bank_transaction_eur_booking() from public, anon, authenticated;
revoke all on function public.enforce_invoice_paid_needs_payment() from public, anon, authenticated;

revoke all on function public.close_vat_period(uuid, text, integer, integer, date, date, bigint) from public, anon;
grant execute on function public.close_vat_period(uuid, text, integer, integer, date, date, bigint) to authenticated, service_role;
revoke all on function public.match_bank_transactions(uuid, uuid, uuid) from public, anon;
grant execute on function public.match_bank_transactions(uuid, uuid, uuid) to authenticated, service_role;
revoke all on function public.reverse_journal_entry(uuid, date, uuid) from public, anon;
grant execute on function public.reverse_journal_entry(uuid, date, uuid) to authenticated, service_role;
revoke all on function public.post_sales_invoice_to_ledger(uuid, uuid, uuid) from public, anon;
grant execute on function public.post_sales_invoice_to_ledger(uuid, uuid, uuid) to authenticated, service_role;
revoke all on function public.compute_vat_boxes(uuid, date, date, uuid[]) from public, anon;
grant execute on function public.compute_vat_boxes(uuid, date, date, uuid[]) to authenticated, service_role;
revoke all on function public.book_asset_disposal(uuid, uuid, uuid, bigint, date, uuid, text) from public, anon;
grant execute on function public.book_asset_disposal(uuid, uuid, uuid, bigint, date, uuid, text) to authenticated, service_role;

commit;
