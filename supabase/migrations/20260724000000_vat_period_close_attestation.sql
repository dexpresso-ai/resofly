-- ============================================================
-- OB-periode afsluiten met bevestiging (attestatie)
-- ------------------------------------------------------------
-- ResoFly verstuurt de aangifte NIET elektronisch. De gebruiker dient de
-- OB-aangifte zelf bij de Belastingdienst in en sluit daarna de periode af.
-- Bij het afsluiten bevestigt hij dat de aangifte is ingediend; daarop wordt
-- in één transactie doorgeboekt naar 1530 (finalize_vat_return), de periode
-- vergrendeld en de aangifte op 'filed' gezet. De bevestiging (wie + wanneer)
-- wordt vastgelegd zodat het grootboek aantoonbaar gelijk blijft met de
-- werkelijk ingediende aangifte.
-- ============================================================

-- 1. Audit-velden voor de attestatie
alter table public.vat_returns
  add column if not exists filed_at timestamptz;
alter table public.vat_returns
  add column if not exists filed_by uuid references auth.users(id) on delete set null;

comment on column public.vat_returns.filed_at is
  'Moment waarop de gebruiker bij het afsluiten bevestigde de OB-aangifte zelf bij de Belastingdienst te hebben ingediend.';
comment on column public.vat_returns.filed_by is
  'Gebruiker die de indiening bevestigde bij het afsluiten van de periode.';

-- 2. close_vat_period: dunne, atomaire wrapper om finalize_vat_return.
--    finalize_vat_return doet de schrijfrechtencontrole, de doorboeking naar
--    1530, de bevroren rubrieken-snapshot en de periode-lock (closed_periods,
--    gooit een fout als de periode al is afgesloten). Daarna zetten we dezelfde
--    rij meteen op 'filed' met de attestatie-velden. Eén plpgsql-functie = één
--    transactie: doorboeking en statuswijziging slagen of falen samen.
create or replace function public.close_vat_period(
  p_organization_id uuid,
  p_period_type text,
  p_year integer,
  p_period_index integer,
  p_from date,
  p_to date
)
returns public.vat_returns
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ret public.vat_returns;
begin
  select * into v_ret from public.finalize_vat_return(
    p_organization_id, p_period_type, p_year, p_period_index, p_from, p_to
  );

  update public.vat_returns
    set status = 'filed', filed_at = now(), filed_by = auth.uid()
    where id = v_ret.id
    returning * into v_ret;

  return v_ret;
end;
$$;
