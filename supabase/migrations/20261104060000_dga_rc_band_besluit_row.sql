-- ============================================================
-- ResoFly — Rekening-courant DGA: de grens van € 17.500 en waar die vandaan komt
-- Date: 2026-11-04
--
-- DE GRONDSLAG
-- ────────────
-- De € 17.500 staat in geen enkel wetsartikel. Het is een GOEDKEURING van de
-- staatssecretaris van Financiën in het besluit over resultaat uit overige
-- werkzaamheden, bij de terbeschikkingstellingsregeling (art. 3.92 Wet IB
-- 2001). Geldend: Besluit ROW 2026, besluit van 15 januari 2026, nr. 2026-436
-- (Stcrt. 2026, 1724), onderdeel 3.9:
--
--   "Gelet hierop, en ter vermindering van de administratieve lasten, keur ik
--    goed dat belanghebbende geen rente als resultaat in aanmerking hoeft te
--    nemen als aan de volgende voorwaarden is voldaan.
--    - Het saldo van de rekening-courantverhouding is gedurende het gehele
--      kalenderjaar niet hoger dan € 17.500 positief en niet lager dan
--      € 17.500 negatief.
--    - Bij de vennootschap wordt geen rente in aanmerking genomen.
--    - In het geval van een rekening-courantschuld wordt deze niet in box 3
--      als schuld in aanmerking genomen."
--
-- Daarvóór: Verzamelbesluit resultaat overige werkzaamheden, besluit van
-- 29 november 2021, nr. 2021-15229 (Stcrt. 2021, 48048), § 8.4; en het besluit
-- van 24 mei 2006, nr. CPP2006/76M, dat de grens van € 10.000 naar € 17.500
-- bracht. De Belastingdienst past dezelfde grens toe als de DGA geld leent van
-- de BV ("Verschil tussen lening en rekening-courant"): boven € 17.500 rente
-- over het hele bedrag, en de regel geldt niet voor een echte lening.
--
-- WAT ER MIS WAS
-- ──────────────
--   1. De bron stond er onnauwkeurig bij (een webpagina, geldig "vanaf 2023").
--      Nu de besluiten zelf, met de datum waarop ze gingen gelden.
--   2. De toets keek alleen naar de schuld van de DGA aan de BV. De
--      goedkeuring is een BANDBREEDTE: het saldo moet het hele kalenderjaar
--      tussen −€ 17.500 en +€ 17.500 blijven, in beide richtingen. Een BV die
--      haar DGA tijdelijk € 25.000 schuldig was, viel er dus buiten zonder dat
--      het scherm iets zei.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. De grens, met de besluiten waar hij in staat ─────────────────────────
alter table public.dga_current_account_limits
  add column if not exists legal_basis text;

comment on table public.dga_current_account_limits is
  'Bandbreedte rekening-courant DGA zonder rente (± het bedrag, het hele kalenderjaar). Goedkeuring in het besluit resultaat overige werkzaamheden (nu Besluit ROW 2026, onderdeel 3.9), geen wetsartikel. Alleen via migraties te wijzigen.';
comment on column public.dga_current_account_limits.legal_basis is
  'Korte bronvermelding voor het scherm, bijvoorbeeld "Besluit ROW 2026, onderdeel 3.9".';

-- De oude rij noemde een webpagina en een ingangsdatum (2023) die nergens op
-- berust. Vervangen door de besluiten zelf.
delete from public.dga_current_account_limits
where valid_from = '2023-01-01'
  and interest_free_limit_cents = 1750000
  and source_note like 'Belastingdienst, "Voorwaarden bij de rekening-courant"%';

insert into public.dga_current_account_limits (valid_from, interest_free_limit_cents, legal_basis, source_note)
values
  ('2006-05-24', 1750000,
   'Besluit van 24 mei 2006, nr. CPP2006/76M',
   'Goedkeuring bij terbeschikkingstelling (art. 3.92 Wet IB 2001): geen rente als resultaat als het saldo van de rekening-courant het gehele kalenderjaar binnen € 17.500 blijft (voorheen € 10.000). Besluit van 24 mei 2006, nr. CPP2006/76M (Stcrt. 2006, 107); overgenomen in het besluit van 2008, nr. CPP2008/520M. Beleid van de staatssecretaris, geen wetsartikel.'),
  ('2021-12-17', 1750000,
   'Verzamelbesluit ROW 2021, § 8.4',
   'Verzamelbesluit resultaat overige werkzaamheden, besluit van 29 november 2021, nr. 2021-15229 (Stcrt. 2021, 48048), § 8.4: geen rente als resultaat als het saldo van de rekening-courantverhouding het gehele kalenderjaar niet hoger is dan € 17.500 positief en niet lager dan € 17.500 negatief. Beleid van de staatssecretaris, geen wetsartikel.'),
  ('2026-01-29', 1750000,
   'Besluit ROW 2026, onderdeel 3.9',
   'Besluit ROW 2026, besluit van 15 januari 2026, nr. 2026-436 (Stcrt. 2026, 1724), onderdeel 3.9: geen rente als resultaat als (1) het saldo van de rekening-courantverhouding gedurende het gehele kalenderjaar niet hoger is dan € 17.500 positief en niet lager dan € 17.500 negatief, (2) bij de vennootschap geen rente in aanmerking wordt genomen en (3) een rekening-courantschuld niet als schuld in box 3 wordt opgenomen. Beleid van de staatssecretaris, geen wetsartikel.')
on conflict (valid_from) do update
  set interest_free_limit_cents = excluded.interest_free_limit_cents,
      legal_basis = excluded.legal_basis,
      source_note = excluded.source_note;

-- ── 2. De toets in beide richtingen ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.dga_signals(p_organization_id uuid, p_year integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_norm public.dga_norms;
  v_limit bigint;
  v_year_start date := make_date(p_year, 1, 1);
  v_year_end date := make_date(p_year, 12, 31);
  v_rc_year_end bigint := 0;
  v_rc_opening bigint := 0;
  v_rc_peak bigint := 0;
  v_rc_low bigint := 0;
  v_limit_basis text;
  v_limit_note text;
  v_wages bigint := 0;
  v_has_rc boolean;
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_norm from public.dga_norms where year = p_year;

  select l.interest_free_limit_cents, l.legal_basis, l.source_note
  into v_limit, v_limit_basis, v_limit_note
  from public.dga_current_account_limits l
  where l.valid_from <= v_year_end
  order by l.valid_from desc
  limit 1;

  select exists (
    select 1 from public.ledger_accounts la
    where la.organization_id = p_organization_id and la.subtype = 'dga_current_account'
  ) into v_has_rc;

  if v_has_rc then
    select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::bigint
    into v_rc_year_end
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.date <= v_year_end
      and la.subtype = 'dga_current_account';

    -- Beginstand van het jaar: alles vóór 1 januari.
    select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::bigint
    into v_rc_opening
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.date < v_year_start
      and la.subtype = 'dga_current_account';

    -- De piek is het maximum van de beginstand en elke stand ín het jaar. De
    -- beginstand telt mee omdat die op 1 januari daadwerkelijk op de rekening
    -- staat; alleen naar de mutaties kijken zou een rekening die het hele jaar
    -- onaangeroerd hoog stond als "nooit boven de grens" tellen.
    -- GEWIJZIGD (20261104060000): ook de laagste stand. De goedkeuring is een
    -- bandbreedte (Besluit ROW 2026, onderdeel 3.9): het saldo mag het hele
    -- kalenderjaar niet hoger zijn dan € 17.500 positief en niet lager dan
    -- € 17.500 negatief. Een positief saldo is hier een schuld van de DGA aan
    -- de BV (debet), een negatief saldo een schuld van de BV aan de DGA.
    select greatest(
      v_rc_opening,
      coalesce(max(v_rc_opening + running), v_rc_opening)
    )::bigint,
    least(
      v_rc_opening,
      coalesce(min(v_rc_opening + running), v_rc_opening)
    )::bigint
    into v_rc_peak, v_rc_low
    from (
      select sum(sum(jl.debit_cents - jl.credit_cents)) over (order by je.date) as running
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.entry_id
      join public.ledger_accounts la on la.id = jl.account_id
      where jl.organization_id = p_organization_id
        and je.status = 'posted'
        and je.date between v_year_start and v_year_end
        and la.subtype = 'dga_current_account'
      group by je.date
    ) s;
  end if;

  -- Het filter op 'year_close' is wat hier eerder ontbrak: de jaarafsluiting
  -- nulstelt alle W&V-rekeningen, dus zonder dit filter heft zij de loonboekingen
  -- van een afgesloten jaar precies op.
  select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::bigint
  into v_wages
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.entry_id
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.organization_id = p_organization_id
    and je.status = 'posted'
    and je.source_type <> 'year_close'
    and extract(year from je.date)::int = p_year
    and la.subtype = 'wages';

  return jsonb_build_object(
    'year', p_year,
    'normsKnown', v_norm.year is not null,
    'usualSalaryNormCents', v_norm.usual_salary_norm_cents,
    'deMinimisCents', v_norm.de_minimis_cents,
    'comparableSalaryBasisPoints', v_norm.comparable_salary_basis_points,
    'excessiveLoanThresholdCents', v_norm.excessive_loan_threshold_cents,
    'interestFreeLimitCents', v_limit,
    'interestFreeLimitBasis', v_limit_basis,
    'interestFreeLimitSourceNote', v_limit_note,
    'hasCurrentAccount', v_has_rc,
    'currentAccountYearEndCents', v_rc_year_end,
    'currentAccountPeakCents', v_rc_peak,
    'currentAccountLowestCents', v_rc_low,
    'wagesBookedCents', v_wages,
    'noWagesBooked', v_wages = 0,
    -- De DGA was de BV ergens in het jaar meer dan de grens schuldig.
    'dgaDebtAboveInterestFreeLimit', v_limit is not null and v_rc_peak > v_limit,
    -- De BV was de DGA ergens in het jaar meer dan de grens schuldig.
    'dgaClaimAboveInterestFreeLimit', v_limit is not null and -v_rc_low > v_limit,
    -- Buiten de bandbreedte, aan welke kant ook: de goedkeuring geldt niet.
    'aboveInterestFreeLimit', v_limit is not null and (v_rc_peak > v_limit or -v_rc_low > v_limit),
    'aboveExcessiveLoanThreshold',
      v_norm.excessive_loan_threshold_cents is not null
      and v_rc_year_end > v_norm.excessive_loan_threshold_cents
  );
end;
$function$;
revoke all on function public.dga_signals(uuid, integer) from public, anon, authenticated;
grant execute on function public.dga_signals(uuid, integer) to authenticated, service_role;

commit;
