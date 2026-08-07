-- ============================================================
-- ResoFly — Zakelijke module fase 3c: de loonjournaalpost
-- Date: 2026-08-07
--
-- ResoFly voert GEEN salarisadministratie. Loonaangifte, loonheffingstabellen en
-- correctieberichten zijn een eigen product en een aansprakelijkheidsrisico; dat
-- staat zo in de roadmap en dat blijft zo. Wat een BV wél nodig heeft is de
-- journaalpost die de salarisverwerker elke maand oplevert, in het grootboek.
--
-- Vandaar deze ene RPC: een kant-en-klare journaalpost innemen, controleren, en
-- als één boekstuk boeken. Alles wat de verwerker heeft uitgerekend nemen we
-- over; wij rekenen niets na, want wij kennen de loonheffingstabellen niet.
--
-- Wat we WEL controleren, want dat kunnen we:
--   * de post moet sluiten (debet = credit) — post_journal_entry heeft een
--     afrondingsvangnet van een paar cent, en dat is voor een loonjournaalpost
--     te ruim: een verkeerd overgenomen bedrag hoort te stuiten, niet stilletjes
--     op Afrondingsverschillen te belanden;
--   * elke rekening moet bestaan in dit rekeningschema;
--   * per regel mag maar één kant gevuld zijn.
--
-- Er is bewust GEEN dubbele-import-blokkade op maand: een correctiebericht van
-- de verwerker is een tweede, legitieme post over dezelfde periode. Wel krijgt
-- elk boekstuk een herkenbare omschrijving mee, zodat een dubbele import
-- zichtbaar is in het journaal.
-- ============================================================

begin;

alter table public.journal_entries drop constraint if exists journal_entries_source_type_check;
alter table public.journal_entries
  add constraint journal_entries_source_type_check check (source_type in (
    'sales_invoice','purchase_invoice','asset_depreciation','asset_acquisition','asset_disposal',
    'vat_return','payment','opening_balance','manual','year_close','credit_note',
    'result_appropriation','corporate_tax','dga_interest','payroll'
  ));

create or replace function public.post_payroll_journal(
  p_organization_id uuid,
  p_date date,
  p_description text,
  p_lines jsonb,
  p_created_by uuid default auth.uid()
)
returns public.journal_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_line jsonb;
  v_code text;
  v_debit bigint;
  v_credit bigint;
  v_total_debit bigint := 0;
  v_total_credit bigint := 0;
  v_lines jsonb := '[]'::jsonb;
  v_idx integer := 0;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if not public.org_has_business(p_organization_id) then
    raise exception 'De loonjournaalpost hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'De loonjournaalpost heeft geen regels.' using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);

  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    v_idx := v_idx + 1;
    v_code := nullif(btrim(v_line->>'account_code'), '');
    v_debit := coalesce((v_line->>'debit_cents')::bigint, 0);
    v_credit := coalesce((v_line->>'credit_cents')::bigint, 0);

    if v_code is null then
      raise exception 'Regel %: er staat geen rekeningnummer bij.', v_idx using errcode = '23514';
    end if;
    if v_debit < 0 or v_credit < 0 then
      raise exception 'Regel % (%): een negatief bedrag kan niet. Zet het aan de andere kant.', v_idx, v_code
        using errcode = '23514';
    end if;
    if v_debit > 0 and v_credit > 0 then
      raise exception 'Regel % (%): er staat zowel een debet- als een creditbedrag.', v_idx, v_code
        using errcode = '23514';
    end if;
    if v_debit = 0 and v_credit = 0 then
      raise exception 'Regel % (%): er staat geen bedrag.', v_idx, v_code using errcode = '23514';
    end if;
    if not exists (
      select 1 from public.ledger_accounts la
      where la.organization_id = p_organization_id and la.code = v_code
    ) then
      raise exception 'Regel %: grootboekrekening % bestaat niet in dit rekeningschema. Maak hem aan of pas de kolomkoppeling aan.', v_idx, v_code
        using errcode = '02000';
    end if;

    v_total_debit := v_total_debit + v_debit;
    v_total_credit := v_total_credit + v_credit;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_code', v_code,
      'description', coalesce(nullif(btrim(v_line->>'description'), ''), 'Loonjournaalpost'),
      'debit_cents', v_debit,
      'credit_cents', v_credit
    ));
  end loop;

  -- Strenger dan post_journal_entry: geen tolerantie. Een loonjournaalpost komt
  -- kant-en-klaar binnen en hoort exact te sluiten; wijkt hij af, dan is er iets
  -- misgegaan bij het overnemen en moet de gebruiker dat zien.
  if v_total_debit <> v_total_credit then
    raise exception 'De loonjournaalpost sluit niet: debet % cent tegen credit % cent (verschil % cent). Controleer de kolomkoppeling en of alle regels zijn meegekomen.',
      v_total_debit, v_total_credit, v_total_debit - v_total_credit using errcode = '23514';
  end if;

  return public.post_journal_entry(
    p_organization_id, p_date,
    coalesce(nullif(btrim(p_description), ''), 'Loonjournaalpost ' || to_char(p_date, 'MM-YYYY')),
    'payroll', null, v_lines, p_created_by
  );
end;
$$;

revoke all on function public.post_payroll_journal(uuid, date, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.post_payroll_journal(uuid, date, text, jsonb, uuid) to authenticated, service_role;

commit;
