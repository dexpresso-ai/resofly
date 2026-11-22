-- Factuurregels: wat er op een factuur staat, en langs welke weg hij uitgaat
--
-- Uit de controle "van werk naar geld" van 22 november 2026 (bevinding 9):
-- convert_accepted_quote_to_invoice gaf een factuur uit een offerte altijd
-- 14 dagen, ook als op dezelfde factuur "Betaling binnen 30 dagen." stond; de
-- herinneringen begonnen zo 16 dagen te vroeg. Nu volgt de vervaldatum de
-- betaaltermijn uit de bedrijfsgegevens, met dezelfde regel als het
-- factuurformulier.
--
-- Veilig om opnieuw te draaien: create or replace, drop trigger if exists.
-- Bestaande facturen veranderen niet.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. De betaaltermijn in dagen
-- ═══════════════════════════════════════════════════════════════════════════
-- Spiegel van paymentTermDays in src/lib/financeRules.ts: het getal vóór
-- "dag", "dagen" of "days" in de betaaltekst; zonder getal 14; nooit minder
-- dan 1 of meer dan 120. Een nieuwe factuur in het formulier rekent zo al
-- sinds 18 november; een factuur uit een offerte niet.
create or replace function public.payment_term_days(p_terms text)
 returns integer
 language sql
 immutable
 set search_path to 'public'
as $function$
  select least(120, greatest(1, coalesce(
    (substring(coalesce(p_terms, '') from '(?i)(\d{1,3})\s*(?:dagen|dag|days)\M'))::integer,
    14)));
$function$;

revoke all on function public.payment_term_days(text) from public, anon;
grant execute on function public.payment_term_days(text) to authenticated, service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Offerte → factuur: de vervaldatum volgt de betaaltermijn
-- ═══════════════════════════════════════════════════════════════════════════
-- (actuele definitie uit 20261105230000, met de vervaldatum aangepast)

CREATE OR REPLACE FUNCTION public.convert_accepted_quote_to_invoice(p_quote_id uuid, p_organization_id uuid)
 RETURNS invoices
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_quote public.quotes;
  v_quote_version public.quote_versions;
  v_existing public.invoices;
  v_invoice public.invoices;
  v_user_id uuid := auth.uid();
  v_invoice_number text;
  -- GEWIJZIGD (20261105230000): de datum in Nederland. Om 00:30 op 1 januari
  -- kreeg de factuur de datum en het nummer van het vorige jaar (UTC).
  v_today date := (now() at time zone 'Europe/Amsterdam')::date;
  -- GEWIJZIGD (20261122120000): de vervaldatum volgt de betaaltermijn (hieronder).
  v_due_date date;
  v_lines jsonb;
  v_notes text;
  v_quote_date date;
  v_valid_until date;
begin
  if v_user_id is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;

  if not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text), hashtext('quote_to_invoice'));

  select * into v_quote
  from public.quotes
  where id = p_quote_id and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Offerte niet gevonden.' using errcode = '02000';
  end if;

  if v_quote.status <> 'accepted' then
    raise exception 'Alleen geaccepteerde offertes kunnen worden omgezet naar een factuur.' using errcode = '23514';
  end if;

  select * into v_existing
  from public.invoices
  where organization_id = p_organization_id
    and quote_id = p_quote_id
  order by created_at asc
  limit 1
  for update;

  if found then
    return v_existing;
  end if;

  select * into v_quote_version
  from public.quote_versions qv
  where qv.organization_id = p_organization_id
    and qv.quote_id = p_quote_id
    and qv.id = coalesce(v_quote.accepted_sent_version_id, v_quote.accepted_version_id, v_quote.sent_version_id)
  limit 1;

  if not found then
    select * into v_quote_version
    from public.quote_versions qv
    where qv.organization_id = p_organization_id
      and qv.quote_id = p_quote_id
      and qv.snapshot_reason in ('client_accepted','sent_to_client')
    order by case qv.snapshot_reason when 'client_accepted' then 0 else 1 end, qv.created_at desc
    limit 1;
  end if;

  if not found or v_quote_version.id is null then
    raise exception 'Deze offerte heeft geen geaccepteerde/verzonden versie-snapshot. Maak of herstel eerst een offerteversie voordat je factureert.' using errcode = '23514';
  end if;

  -- GEWIJZIGD (20261104020000): de regels komen uit de bevroren offerte zelf
  -- (snapshot_data), mét btw-code en ongeronde prijs. quote_version_items kent
  -- geen btw-code en rondt aantal en prijs af op twee decimalen; daardoor kwam
  -- een ICP-, export- of verlegde regel als 0% binnenland op de factuur en werd
  -- 1000 × € 0,125 gefactureerd als € 130.
  select jsonb_agg(
    jsonb_strip_nulls(jsonb_build_object(
      'id', coalesce(nullif(l->>'id', ''), gen_random_uuid()::text),
      'description', coalesce(l->>'description', ''),
      'quantity', case when coalesce(l->>'quantity', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (l->>'quantity')::numeric else 0 end,
      'unit_price', case when coalesce(l->>'unit_price', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (l->>'unit_price')::numeric else 0 end,
      'vat', case when coalesce(l->>'vat', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (l->>'vat')::numeric else 0 end,
      'vat_code', nullif(btrim(coalesce(l->>'vat_code', '')), '')
    )) order by t.ord
  ) into v_lines
  from jsonb_array_elements(
    case when jsonb_typeof(v_quote_version.snapshot_data #> '{quote,lines}') = 'array'
      then v_quote_version.snapshot_data #> '{quote,lines}' else '[]'::jsonb end
  ) with ordinality as t(l, ord);

  if v_lines is null then
    select jsonb_agg(
      jsonb_build_object(
        'id', coalesce(qvi.source_line_id, qvi.id::text),
        'description', qvi.description,
        'quantity', qvi.quantity,
        'unit_price', qvi.unit_price,
        'vat', qvi.vat_percentage
      ) order by qvi.line_index
    ) into v_lines
    from public.quote_version_items qvi
    where qvi.quote_version_id = v_quote_version.id
      and qvi.organization_id = p_organization_id
      and qvi.quote_id = p_quote_id;
  end if;

  v_lines := coalesce(v_lines, v_quote_version.snapshot_data #> '{quote,lines}');
  v_notes := v_quote_version.notes;
  v_quote_date := v_quote_version.quote_date;
  v_valid_until := v_quote_version.valid_until;

  if v_lines is null or jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) = 0 then
    raise exception 'De geaccepteerde offerteversie bevat geen geldige regels.' using errcode = '23514';
  end if;

  -- TOEGEVOEGD (20261122120000): de betaaltermijn uit de bedrijfsgegevens, met
  -- dezelfde regel als het factuurformulier (payment_term_days). Het was
  -- vandaag + 14, ook als op de factuur "Betaling binnen 30 dagen." stond: de
  -- pdf sprak zichzelf tegen en de herinneringen begonnen 16 dagen te vroeg.
  select v_today + public.payment_term_days(cs.invoice_payment_terms)
    into v_due_date
    from public.company_settings cs
   where cs.organization_id = p_organization_id;
  v_due_date := coalesce(v_due_date, v_today + 14);

  v_invoice_number := public.allocate_next_invoice_number(p_organization_id, v_today);

  insert into public.invoices(
    organization_id, created_by, client_id, project_id, quote_id, source_quote_version_id,
    number, date, due_date, lines, status, notes
  ) values (
    p_organization_id, v_user_id, v_quote_version.client_id, v_quote_version.project_id, v_quote.id, v_quote_version.id,
    v_invoice_number, v_today, v_due_date, v_lines, 'draft', v_notes
  ) returning * into v_invoice;

  perform public.insert_invoice_workflow_event(
    p_organization_id,
    v_invoice.id,
    'created_from_quote',
    'Factuur aangemaakt uit offerte',
    'Factuur ' || v_invoice.number || ' is server-side aangemaakt uit de geaccepteerde offerteversie van ' || v_quote.number || '.',
    jsonb_build_object('quote_id', v_quote.id, 'quote_number', v_quote.number, 'quote_version_id', v_quote_version.id, 'quote_date', v_quote_date, 'quote_valid_until', v_valid_until),
    v_user_id
  );

  insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
  values (
    p_organization_id,
    v_user_id,
    'invoice_created_from_quote',
    'invoice',
    v_invoice.id,
    v_invoice.number,
    jsonb_build_object('title', 'Factuur aangemaakt uit offerte', 'quote_id', v_quote.id, 'quote_number', v_quote.number, 'quote_version_id', v_quote_version.id)
  );

  return v_invoice;
end;
$function$;

revoke all on function public.convert_accepted_quote_to_invoice(uuid, uuid) from public, anon;
grant execute on function public.convert_accepted_quote_to_invoice(uuid, uuid) to authenticated, service_role;


commit;
