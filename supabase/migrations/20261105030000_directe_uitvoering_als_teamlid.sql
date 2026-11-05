-- ============================================================
-- ResoFly — Directe uitvoering via API en MCP: overal als het teamlid
-- Date: 2026-11-05
--
-- 20261105000000 liet de directe uitvoerders (supabase/functions/_shared/
-- actions/apply.ts) voor de tabellen van Financiën schrijven als het teamlid,
-- via action_member_write. De rest schreef nog op de service-role: klanten,
-- contactpersonen, klantvelden, mappen, notities en documenten, tickets en
-- hun notities, projecten, weekacties, uren, rapportages en galerijen. Daar
-- golden RLS en de bewakers voor "authenticated" niet. Wat dat betekende:
--
--   - de modulepoort (enforce_module_write_access) en de creatieve module
--     (enforce_creative_module_access) keken niet, want die leunen op
--     auth.uid(), en dat is op de service-role leeg. De handelingen
--     controleren de modulerechten zelf (in plan()), maar de database keek
--     op deze weg niet mee;
--   - de bewakers op contactpersonen, klanten, galerijen en categorieën
--     (verplichte velden, dubbele adressen, deellinks, vaste velden) deden
--     niet mee;
--   - een bericht uit het postvak koppelen of negeren liep langs de controle
--     op schrijfrecht in Klanten heen, en legde niet vast wie het deed
--     (handled_by = auth.uid() bleef leeg).
--
-- Nu:
--   1. action_member_write kent alle tabellen waar de directe uitvoerders in
--      schrijven. Dezelfde wissel naar het teamlid als api_rest_write, dus
--      RLS, de modulepoort en elke bewaker doen mee — precies als de knop in
--      het scherm (CLAUDE.md, harde regel 2: "met de rechten van die mens").
--   2. action_member_call roept de twee postvak-functies aan als het teamlid.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Schrijven als het teamlid: alle tabellen van de directe uitvoerders ──
create or replace function public.action_member_write(
  p_user_id uuid,
  p_organization_id uuid,
  p_table text,
  p_values jsonb,
  p_row_id uuid default null,
  p_unchanged jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_values jsonb := coalesce(p_values, '{}'::jsonb);
  v_cols text;
  v_where text := '';
  v_key text;
  v_exists boolean;
  v_row jsonb;
begin
  -- Alleen de server; de wissel naar het teamlid komt hieronder, dus deze
  -- controle hoort ervoor.
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de server kan dit aanroepen.' using errcode = '42501';
  end if;
  -- Precies de tabellen uit apply.ts (actionMemberWrite.test.ts legt ze naast
  -- elkaar). Een tabel die hier niet staat, schrijft een uitvoerder niet.
  if p_table is null or p_table not in (
    -- Financiën (20261105000000)
    'invoices', 'quotes', 'ledger_accounts', 'suppliers', 'bank_accounts', 'bank_rules', 'vat_returns', 'fixed_assets',
    -- Klanten
    'clients', 'client_contacts', 'client_field_definitions',
    -- Inhoud
    'content_folders', 'notes', 'documents',
    -- Tickets
    'tickets', 'ticket_notes',
    -- Projecten, planning en uren
    'projects', 'planner_notes', 'time_entries',
    -- Rapportages
    'saved_reports',
    -- Galerijen
    'galleries', 'gallery_categories'
  ) then
    raise exception 'Tabel "%" gaat niet via deze weg.', p_table using errcode = '22023';
  end if;
  -- Aanmaken alleen waar een uitvoerder ook echt aanmaakt (insertOne in
  -- apply.ts). Een klant aanmaken bijvoorbeeld gaat in de app langs
  -- create_client_with_next_code (klantnummer, dubbelcontrole); een kale insert
  -- hier zou daar omheen lopen.
  if p_row_id is null and p_table not in (
    'ledger_accounts', 'bank_accounts', 'client_field_definitions', 'content_folders', 'galleries', 'gallery_categories'
  ) then
    raise exception 'Aanmaken in "%" gaat niet via deze weg.', p_table using errcode = '22023';
  end if;
  if jsonb_typeof(v_values) <> 'object' then
    raise exception 'De waarden moeten een object zijn.' using errcode = '22023';
  end if;
  -- Wat een wijziging nooit raakt (zelfde lijst als PROTECTED_FIELDS in apply.ts).
  v_values := v_values - 'id' - 'organization_id' - 'created_by' - 'created_at' - 'updated_at';

  if p_user_id is null or not exists (
    select 1 from public.organization_members m
     where m.organization_id = p_organization_id and m.user_id = p_user_id and m.status = 'active') then
    raise exception 'Deze gebruiker is geen actief lid van de organisatie.' using errcode = '42501';
  end if;

  if p_row_id is not null then
    execute format('select exists(select 1 from public.%I where id = $1 and organization_id = $2)', p_table)
      into v_exists using p_row_id, p_organization_id;
    if not v_exists then
      raise exception 'Niet gevonden in deze organisatie.' using errcode = 'P0002';
    end if;
  end if;

  -- Vanaf hier als het teamlid, tot het einde van deze transactie.
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user_id, 'role', 'authenticated', 'aud', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  v_cols := (select string_agg(format('%I', k), ', ' order by k) from jsonb_object_keys(v_values) as k);

  if p_row_id is null then
    execute format(
      'insert into public.%1$I as t (organization_id, created_by%2$s) '
      || 'select $1, $2%2$s from jsonb_populate_record(null::public.%1$I, $3) '
      || 'returning to_jsonb(t.*)',
      p_table, case when v_cols is null then '' else ', ' || v_cols end)
      into v_row using p_organization_id, p_user_id, v_values;
    return v_row;
  end if;

  if v_cols is null then
    raise exception 'Er is niets om te wijzigen.' using errcode = '22023';
  end if;
  -- "Moet nog zo zijn" (bijv. de status op de goedgekeurde kaart, of dat een
  -- actiepunt van deze gebruiker is): anders verandert er niets.
  for v_key in select jsonb_object_keys(coalesce(p_unchanged, '{}'::jsonb)) loop
    v_where := v_where || format(' and t.%I::text is not distinct from ($4->>%L)', v_key, v_key);
  end loop;
  execute format(
    'update public.%1$I as t set (%2$s, updated_at) = '
    || '(select %2$s, now() from jsonb_populate_record(null::public.%1$I, $1)) '
    || 'where t.id = $2 and t.organization_id = $3%3$s '
    || 'returning to_jsonb(t.*)',
    p_table, v_cols, v_where)
    into v_row using v_values, p_row_id, p_organization_id, coalesce(p_unchanged, '{}'::jsonb);
  if v_row is null then
    raise exception 'Niet bijgewerkt: de gegevens zijn intussen veranderd, of het teamlid mag dit niet wijzigen.' using errcode = '42501';
  end if;
  return v_row;
end;
$$;

revoke all on function public.action_member_write(uuid, uuid, text, jsonb, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.action_member_write(uuid, uuid, text, jsonb, uuid, jsonb) to service_role;

-- ── 2. Een functie aanroepen als het teamlid ────────────────────────────────
-- Voor de uitvoerders die een databasefunctie aanroepen in plaats van een rij
-- te schrijven. Die functies controleren zelf de rechten van de aanroeper,
-- maar slaan dat over voor de service-role; en ze leggen auth.uid() vast als
-- wie het deed. Alleen de functies die de uitvoerders gebruiken, en de
-- organisatie komt altijd uit de koppeling, niet uit de argumenten.
create or replace function public.action_member_call(
  p_user_id uuid,
  p_organization_id uuid,
  p_function text,
  p_args jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_args jsonb;
  v_list text;
  v_result jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de server kan dit aanroepen.' using errcode = '42501';
  end if;
  if p_function is null or p_function not in ('link_inbound_message', 'set_inbound_message_status') then
    raise exception 'Functie "%" gaat niet via deze weg.', p_function using errcode = '22023';
  end if;
  if p_args is not null and jsonb_typeof(p_args) <> 'object' then
    raise exception 'De argumenten moeten een object zijn.' using errcode = '22023';
  end if;
  if p_user_id is null or not exists (
    select 1 from public.organization_members m
     where m.organization_id = p_organization_id and m.user_id = p_user_id and m.status = 'active') then
    raise exception 'Deze gebruiker is geen actief lid van de organisatie.' using errcode = '42501';
  end if;

  -- De organisatie van de koppeling, niet die uit de argumenten.
  v_args := (coalesce(p_args, '{}'::jsonb) - 'p_organization_id')
            || jsonb_build_object('p_organization_id', p_organization_id);
  -- Benoemde argumenten; de waarden als letterlijke tekst, die Postgres naar
  -- het type van de parameter omzet (uuid, boolean, text).
  select string_agg(format('%I => %L', a.key, a.value), ', ' order by a.key)
    into v_list
    from jsonb_each_text(v_args) as a;

  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user_id, 'role', 'authenticated', 'aud', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  execute format('select to_jsonb(x) from public.%I(%s) as x', p_function, v_list) into v_result;
  return v_result;
end;
$$;

revoke all on function public.action_member_call(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.action_member_call(uuid, uuid, text, jsonb) to service_role;

commit;
