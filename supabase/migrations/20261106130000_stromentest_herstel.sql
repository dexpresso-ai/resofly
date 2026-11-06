-- Stromentest 6 november: wat een end-to-end test van offertes, facturen,
-- herinneringen, aanmaningen, contracten en het klantportaal vond.
--
-- De test (tests/stromen/) draait de echte edge functions tegen een verse
-- database met alle migraties, met echte gebruikers en rechten. Wat hieronder
-- staat, ging daar mis; per onderdeel staat erbij wat er gebeurde. De
-- functies in de edge functions en de app zijn in dezelfde ronde aangepast.
--
-- Veilig opnieuw te draaien: create or replace, drop … if exists, en de
-- opschoning van oude offerteversies raakt alleen rijen die nog te veel bevatten.

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Auditlog: twee acties die de lijst niet kende
-- ════════════════════════════════════════════════════════════════════════════
--
-- fail_invoice_email_send en fail_invoice_payment_checkout schrijven
-- 'invoice_email_send_failed' en 'invoice_payment_checkout_failed' in het
-- auditlog, maar audit_logs_action_check kende ze niet. De hele functie liep
-- dan stuk en alles werd teruggedraaid:
--   - een mislukte verzending bleef op "in de wachtrij" staan; een e-factuur
--     via Mollie was daarna nooit meer te versturen of te betalen;
--   - een mislukte betaallink bleef op 'creating' staan. Een herinnering zonder
--     gekoppelde Mollie maakt zo'n poging altijd; daarna gaf crediteren voorgoed
--     "er loopt een betaling", en was de factuur nergens meer mee te sluiten.
-- De lijst wordt uit de huidige definitie gelezen en alleen aangevuld.
do $$
declare
  v_def text;
  v_actions text[];
  v_nieuw text[] := array['invoice_email_send_failed', 'invoice_payment_checkout_failed'];
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint
   where conrelid = 'public.audit_logs'::regclass and conname = 'audit_logs_action_check';
  if v_def is null then return; end if;
  select array_agg(distinct t[1] order by t[1]) into v_actions
    from regexp_matches(v_def, '([a-z][a-z0-9_]*)', 'g') as t
   where t[1] not in ('check', 'action', 'any', 'array', 'text');
  if v_actions is null or array_length(v_actions, 1) < 10 then
    raise exception 'audit_logs_action_check niet te lezen: %', left(v_def, 200);
  end if;
  if v_nieuw <@ v_actions then return; end if;
  select array_agg(distinct a order by a) into v_actions from unnest(v_actions || v_nieuw) as a;
  alter table public.audit_logs drop constraint audit_logs_action_check;
  execute format('alter table public.audit_logs add constraint audit_logs_action_check check (action = any (%L::text[]))', v_actions);
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Offerteversies: alleen wat op de offerte staat
-- ════════════════════════════════════════════════════════════════════════════
--
-- create_quote_version_snapshot bewaarde de complete klant-, project- en
-- bedrijfsrij in snapshot_data. Wie Financiën mag lezen (ook de boekhouder, en
-- een teamlid zonder Klanten of Projecten) las zo notities, klantwaarde, tags,
-- eigen velden, uurtarieven en budgetten mee. Het logo en het briefpapier
-- (data-URL's) maakten elke versie megabytes groot. Geen enkele code las deze
-- sleutels; de PDF zelf staat los vastgelegd.

create or replace function public.jsonb_pick(p_value jsonb, p_keys text[])
returns jsonb
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when p_value is null or jsonb_typeof(p_value) <> 'object' then p_value
    else coalesce((select jsonb_object_agg(e.key, e.value) from jsonb_each(p_value) e where e.key = any(p_keys)), '{}'::jsonb)
  end;
$$;

-- De velden die een offerte, factuur of brief nodig heeft (zie ClientRowLike en
-- CompanyRowLike in supabase/functions/_shared/documentLayout.ts).
create or replace function public.document_snapshot_keys(p_kind text)
returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case p_kind
    when 'client' then array['id', 'name', 'client_code', 'contact_name', 'email', 'phone', 'client_kind',
                             'vat_number', 'kvk_number', 'address_line1', 'address_line2', 'postal_code', 'city', 'country']
    when 'project' then array['id', 'name', 'client_id']
    when 'company' then array['company_name', 'trade_name', 'legal_form', 'address_line1', 'address_line2', 'postal_code',
                              'city', 'country', 'email', 'phone', 'website', 'kvk_number', 'vat_number', 'iban',
                              'invoice_payment_terms', 'invoice_footer', 'kor_enabled']
    else array[]::text[]
  end;
$$;

revoke all on function public.jsonb_pick(jsonb, text[]) from public, anon;
grant execute on function public.jsonb_pick(jsonb, text[]) to authenticated, service_role;
revoke all on function public.document_snapshot_keys(text) from public, anon;
grant execute on function public.document_snapshot_keys(text) to authenticated, service_role;

CREATE OR REPLACE FUNCTION public.create_quote_version_snapshot(p_quote_id uuid, p_organization_id uuid, p_snapshot_reason text, p_actor_user_id uuid DEFAULT NULL::uuid, p_delivery_id uuid DEFAULT NULL::uuid, p_pdf_file_name text DEFAULT NULL::text, p_pdf_mime_type text DEFAULT NULL::text, p_pdf_size_bytes integer DEFAULT NULL::integer, p_pdf_sha256 text DEFAULT NULL::text, p_quote_version_pdf_url text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS quote_versions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_quote public.quotes;
  v_delivery public.quote_email_deliveries;
  v_version public.quote_versions;
  v_sent_version public.quote_versions;
  v_version_number integer;
  v_line jsonb;
  v_lines jsonb;
  v_index integer := 0;
  v_quantity numeric := 0;
  v_unit_price numeric := 0;
  v_vat_percentage numeric := 0;
  v_line_subtotal numeric := 0;
  v_line_vat numeric := 0;
  v_line_total numeric := 0;
  v_subtotal numeric := 0;
  v_vat_total numeric := 0;
  v_total numeric := 0;
  v_pdf_file_name text := nullif(trim(coalesce(p_pdf_file_name, '')), '');
  v_pdf_sha256 text := lower(nullif(trim(coalesce(p_pdf_sha256, '')), ''));
  v_pdf_url text := nullif(trim(coalesce(p_quote_version_pdf_url, '')), '');
  v_has_pdf boolean;
  v_pdf_mime_type text;
  v_client_snapshot jsonb := 'null'::jsonb;
  v_project_snapshot jsonb := 'null'::jsonb;
  v_company_snapshot jsonb := 'null'::jsonb;
  v_delivery_snapshot jsonb := 'null'::jsonb;
  v_sent_version_snapshot jsonb := 'null'::jsonb;
  v_accepted_sent_version_id uuid := null;
begin
  if p_snapshot_reason not in ('internal_approval','sent_to_client','client_accepted','manual') then
    raise exception 'Ongeldige offerte snapshot reason: %', p_snapshot_reason using errcode = '23514';
  end if;

  if auth.role() = 'authenticated' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie' using errcode = '42501';
  end if;

  select * into v_quote
  from public.quotes
  where id = p_quote_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Offerte niet gevonden' using errcode = '02000'; end if;

  if p_delivery_id is not null then
    select * into v_delivery
    from public.quote_email_deliveries
    where id = p_delivery_id
      and quote_id = p_quote_id
      and organization_id = p_organization_id
    for update;

    if not found then raise exception 'E-maildelivery hoort niet bij deze offerte' using errcode = '23514'; end if;
    -- Zonder de link (met token) en zonder de PDF-bytes: die stonden zo leesbaar
    -- voor elke lezer van Financiën, ook de boekhouder (gast).
    v_delivery_snapshot := (to_jsonb(v_delivery) #- '{metadata,publicUrl}') #- '{metadata,attachmentDataBase64}';
  end if;

  if v_quote.client_id is not null then
    -- GEWIJZIGD (20261106130000): alleen wat op de offerte staat. Eerder de hele
    -- klantrij (notities, waarde, tags, eigen velden, opvolging): die las elke
    -- lezer van Financiën mee, ook de boekhouder en wie Klanten niet mag zien.
    select public.jsonb_pick(to_jsonb(c), public.document_snapshot_keys('client')) into v_client_snapshot
    from public.clients c
    where c.id = v_quote.client_id
      and c.organization_id = p_organization_id;
    v_client_snapshot := coalesce(v_client_snapshot, 'null'::jsonb);
  end if;

  if v_quote.project_id is not null then
    -- GEWIJZIGD (20261106130000): alleen naam en klant; uurtarief, budget en
    -- omschrijving horen niet bij de offerte.
    select public.jsonb_pick(to_jsonb(p), public.document_snapshot_keys('project')) into v_project_snapshot
    from public.projects p
    where p.id = v_quote.project_id
      and p.organization_id = p_organization_id;
    v_project_snapshot := coalesce(v_project_snapshot, 'null'::jsonb);
  end if;

  -- GEWIJZIGD (20261106130000): de bedrijfsgegevens die op de offerte staan.
  -- Eerder de hele rij, met logo en briefpapier als data-URL: megabytes per
  -- versie, en instellingen die niets met de offerte te maken hebben.
  select public.jsonb_pick(to_jsonb(cs), public.document_snapshot_keys('company')) into v_company_snapshot
  from public.company_settings cs
  where cs.organization_id = p_organization_id;
  v_company_snapshot := coalesce(v_company_snapshot, 'null'::jsonb);

  v_has_pdf := v_pdf_file_name is not null or v_pdf_sha256 is not null or p_pdf_size_bytes is not null or v_pdf_url is not null;
  v_pdf_mime_type := case
    when v_has_pdf then coalesce(nullif(trim(coalesce(p_pdf_mime_type, '')), ''), 'application/pdf')
    else null
  end;

  if p_snapshot_reason = 'sent_to_client' then
    if not v_has_pdf or v_pdf_file_name is null or p_pdf_size_bytes is null or p_pdf_size_bytes <= 0 or v_pdf_sha256 is null then
      raise exception 'Een verzonden offerteversie vereist een echte PDF-bijlage met bestandsnaam, grootte en SHA-256 hash' using errcode = '23514';
    end if;
  end if;

  if v_pdf_sha256 is not null and v_pdf_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'PDF SHA-256 hash is ongeldig' using errcode = '23514';
  end if;

  if p_pdf_size_bytes is not null and p_pdf_size_bytes <= 0 then
    raise exception 'PDF-bestandsgrootte moet groter zijn dan 0 bytes' using errcode = '23514';
  end if;

  if v_has_pdf and v_pdf_mime_type <> 'application/pdf' then
    raise exception 'Alleen application/pdf is toegestaan als offertebijlage' using errcode = '23514';
  end if;

  if p_snapshot_reason = 'client_accepted' then
    v_accepted_sent_version_id := v_quote.sent_version_id;

    if v_accepted_sent_version_id is null then
      raise exception 'Acceptatie kan niet worden vastgelegd zonder gekoppelde verzonden offerteversie' using errcode = '23514';
    end if;

    select * into v_sent_version
    from public.quote_versions
    where id = v_accepted_sent_version_id
      and organization_id = p_organization_id
      and quote_id = p_quote_id
      and snapshot_reason = 'sent_to_client';

    if not found then
      raise exception 'Gekoppelde verzonden offerteversie is niet gevonden' using errcode = '23514';
    end if;

    if v_quote.last_pdf_sha256 is not null and v_sent_version.pdf_sha256 is not null and v_quote.last_pdf_sha256 <> v_sent_version.pdf_sha256 then
      raise exception 'Acceptatie-PDF hash komt niet overeen met de verzonden offerteversie' using errcode = '23514';
    end if;

    v_sent_version_snapshot := jsonb_build_object(
      'id', v_sent_version.id,
      'versionNumber', v_sent_version.version_number,
      'snapshotReason', v_sent_version.snapshot_reason,
      'pdfSha256', v_sent_version.pdf_sha256,
      'pdfFileName', v_sent_version.pdf_file_name,
      'pdfSizeBytes', v_sent_version.pdf_size_bytes,
      'createdAt', v_sent_version.created_at
    );
  end if;

  v_lines := coalesce(v_quote.lines, '[]'::jsonb);
  if jsonb_typeof(v_lines) <> 'array' then
    v_lines := '[]'::jsonb;
  end if;

  for v_line in select * from jsonb_array_elements(v_lines) loop
    v_quantity := case when coalesce(v_line->>'quantity', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v_line->>'quantity')::numeric else 0 end;
    v_unit_price := case when coalesce(v_line->>'unit_price', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v_line->>'unit_price')::numeric else 0 end;
    v_vat_percentage := case when coalesce(v_line->>'vat', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v_line->>'vat')::numeric else 0 end;
    v_line_subtotal := round(v_quantity * v_unit_price, 2);
    v_line_vat := round(v_line_subtotal * (v_vat_percentage / 100), 2);
    v_line_total := round(v_line_subtotal + v_line_vat, 2);
    v_subtotal := v_subtotal + v_line_subtotal;
    v_vat_total := v_vat_total + v_line_vat;
    v_total := v_total + v_line_total;
  end loop;

  -- GEWIJZIGD (20261105230000): de totalen van de versie zoals de factuur ze
  -- rekent, btw per tarief (invoice_calculated_totals). Per regel afronden gaf
  -- bij 2 × € 1,02 en 2 × 0,25 × € 95,50 tegen 21% € 60,24 in de versie en
  -- € 60,26 op de factuur die uit deze offerte kwam. De regels hieronder
  -- (quote_version_items) tonen per regel, zoals op het scherm.
  select t.subtotal, t.vat, t.total
    into v_subtotal, v_vat_total, v_total
    from public.invoice_calculated_totals(v_lines) t;

  select coalesce(max(version_number), 0) + 1
  into v_version_number
  from public.quote_versions
  where organization_id = p_organization_id
    and quote_id = p_quote_id;

  insert into public.quote_versions(
    organization_id,
    quote_id,
    delivery_id,
    accepted_sent_version_id,
    version_number,
    snapshot_reason,
    status_at_snapshot,
    internal_approval_status_at_snapshot,
    quote_number,
    client_id,
    project_id,
    quote_date,
    valid_until,
    notes,
    subtotal_amount,
    vat_amount,
    total_amount,
    quote_version_pdf_url,
    pdf_file_name,
    pdf_mime_type,
    pdf_size_bytes,
    pdf_sha256,
    snapshot_data,
    created_by
  ) values (
    p_organization_id,
    p_quote_id,
    p_delivery_id,
    v_accepted_sent_version_id,
    v_version_number,
    p_snapshot_reason,
    v_quote.status,
    v_quote.internal_approval_status,
    v_quote.number,
    v_quote.client_id,
    v_quote.project_id,
    v_quote.date,
    v_quote.valid_until,
    v_quote.notes,
    round(v_subtotal, 2),
    round(v_vat_total, 2),
    round(v_total, 2),
    v_pdf_url,
    v_pdf_file_name,
    v_pdf_mime_type,
    case when v_has_pdf then p_pdf_size_bytes else null end,
    v_pdf_sha256,
    jsonb_build_object(
      'quote', to_jsonb(v_quote) - 'public_token_hash',
      'quoteLines', v_lines,
      'clientSnapshot', v_client_snapshot,
      'projectSnapshot', v_project_snapshot,
      'companySnapshot', v_company_snapshot,
      'deliverySnapshot', v_delivery_snapshot,
      'sentVersionSnapshot', v_sent_version_snapshot,
      'acceptedSentVersionId', v_accepted_sent_version_id,
      'totals', jsonb_build_object('subtotal', round(v_subtotal, 2), 'vat', round(v_vat_total, 2), 'total', round(v_total, 2)),
      'reason', p_snapshot_reason,
      'deliveryId', p_delivery_id,
      'pdf', case when v_has_pdf then jsonb_build_object(
        'fileName', v_pdf_file_name,
        'mimeType', v_pdf_mime_type,
        'sizeBytes', p_pdf_size_bytes,
        'sha256', v_pdf_sha256,
        'url', v_pdf_url
      ) else '{}'::jsonb end,
      'metadata', coalesce(p_metadata, '{}'::jsonb)
    ),
    p_actor_user_id
  ) returning * into v_version;

  v_index := 0;
  for v_line in select * from jsonb_array_elements(v_lines) loop
    v_quantity := case when coalesce(v_line->>'quantity', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v_line->>'quantity')::numeric else 0 end;
    v_unit_price := case when coalesce(v_line->>'unit_price', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v_line->>'unit_price')::numeric else 0 end;
    v_vat_percentage := case when coalesce(v_line->>'vat', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v_line->>'vat')::numeric else 0 end;
    v_line_subtotal := round(v_quantity * v_unit_price, 2);
    v_line_vat := round(v_line_subtotal * (v_vat_percentage / 100), 2);
    v_line_total := round(v_line_subtotal + v_line_vat, 2);

    insert into public.quote_version_items(
      organization_id,
      quote_id,
      quote_version_id,
      source_line_id,
      line_index,
      description,
      quantity,
      unit_price,
      vat_percentage,
      line_subtotal,
      line_vat,
      line_total
    ) values (
      p_organization_id,
      p_quote_id,
      v_version.id,
      nullif(v_line->>'id', ''),
      v_index,
      coalesce(nullif(trim(coalesce(v_line->>'description', '')), ''), '-'),
      v_quantity,
      v_unit_price,
      v_vat_percentage,
      v_line_subtotal,
      v_line_vat,
      v_line_total
    );

    v_index := v_index + 1;
  end loop;

  update public.quotes
  set latest_version_id = v_version.id,
      internal_approved_version_id = case when p_snapshot_reason = 'internal_approval' then v_version.id else internal_approved_version_id end,
      sent_version_id = case when p_snapshot_reason = 'sent_to_client' then v_version.id else sent_version_id end,
      accepted_version_id = case when p_snapshot_reason = 'client_accepted' then v_version.id else accepted_version_id end,
      accepted_sent_version_id = case when p_snapshot_reason = 'client_accepted' then v_accepted_sent_version_id else accepted_sent_version_id end,
      last_pdf_file_name = case when v_has_pdf then coalesce(v_pdf_file_name, last_pdf_file_name) else last_pdf_file_name end,
      last_pdf_mime_type = case when v_has_pdf then coalesce(v_pdf_mime_type, last_pdf_mime_type) else last_pdf_mime_type end,
      last_pdf_size_bytes = case when v_has_pdf then coalesce(p_pdf_size_bytes, last_pdf_size_bytes) else last_pdf_size_bytes end,
      last_pdf_sha256 = case when v_has_pdf then coalesce(v_pdf_sha256, last_pdf_sha256) else last_pdf_sha256 end,
      updated_at = now()
  where id = p_quote_id
    and organization_id = p_organization_id;

  if p_delivery_id is not null then
    update public.quote_email_deliveries
    set quote_version_id = v_version.id,
        attachment_file_name = case when v_has_pdf then coalesce(v_pdf_file_name, attachment_file_name) else attachment_file_name end,
        attachment_mime_type = case when v_has_pdf then coalesce(v_pdf_mime_type, attachment_mime_type) else attachment_mime_type end,
        attachment_size_bytes = case when v_has_pdf then coalesce(p_pdf_size_bytes, attachment_size_bytes) else attachment_size_bytes end,
        attachment_sha256 = case when v_has_pdf then coalesce(v_pdf_sha256, attachment_sha256) else attachment_sha256 end,
        updated_at = now()
    where id = p_delivery_id;
  end if;

  perform public.insert_quote_workflow_event(
    p_organization_id,
    p_quote_id,
    'quote_version_created',
    'Offerteversie vastgelegd',
    'Versie ' || v_version.version_number || ' opgeslagen voor ' || p_snapshot_reason || '.',
    jsonb_build_object('versionId', v_version.id, 'versionNumber', v_version.version_number, 'reason', p_snapshot_reason, 'pdfSha256', v_pdf_sha256, 'acceptedSentVersionId', v_accepted_sent_version_id),
    p_actor_user_id
  );

  if v_has_pdf and v_pdf_sha256 is not null then
    perform public.insert_quote_workflow_event(
      p_organization_id,
      p_quote_id,
      'quote_pdf_attached',
      'PDF-bijlage vastgelegd',
      coalesce(v_pdf_file_name, 'Offerte PDF') || ' is als verzonden PDF-snapshot geregistreerd.',
      jsonb_build_object('versionId', v_version.id, 'fileName', v_pdf_file_name, 'sizeBytes', p_pdf_size_bytes, 'sha256', v_pdf_sha256, 'acceptedSentVersionId', v_accepted_sent_version_id),
      p_actor_user_id
    );
    perform public.insert_quote_audit_event(
      p_organization_id,
      p_quote_id,
      'quote_pdf_attached',
      v_quote.number,
      jsonb_build_object('versionId', v_version.id, 'fileName', v_pdf_file_name, 'sizeBytes', p_pdf_size_bytes, 'sha256', v_pdf_sha256, 'acceptedSentVersionId', v_accepted_sent_version_id),
      p_actor_user_id
    );
  end if;

  perform public.insert_quote_audit_event(
    p_organization_id,
    p_quote_id,
    'quote_version_created',
    v_quote.number,
    jsonb_build_object('versionId', v_version.id, 'versionNumber', v_version.version_number, 'reason', p_snapshot_reason, 'acceptedSentVersionId', v_accepted_sent_version_id),
    p_actor_user_id
  );

  return v_version;
end;
$function$;

revoke all on function public.create_quote_version_snapshot(uuid, uuid, text, uuid, uuid, text, text, integer, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.create_quote_version_snapshot(uuid, uuid, text, uuid, uuid, text, text, integer, text, text, jsonb) to service_role;

-- De versies die er al zijn: dezelfde velden overhouden. Alleen rijen met meer.
update public.quote_versions v
   set snapshot_data = jsonb_set(v.snapshot_data, '{clientSnapshot}',
         public.jsonb_pick(v.snapshot_data -> 'clientSnapshot', public.document_snapshot_keys('client')))
 where jsonb_typeof(v.snapshot_data -> 'clientSnapshot') = 'object'
   and exists (select 1 from jsonb_object_keys(v.snapshot_data -> 'clientSnapshot') k
               where not (k = any(public.document_snapshot_keys('client'))));
update public.quote_versions v
   set snapshot_data = jsonb_set(v.snapshot_data, '{projectSnapshot}',
         public.jsonb_pick(v.snapshot_data -> 'projectSnapshot', public.document_snapshot_keys('project')))
 where jsonb_typeof(v.snapshot_data -> 'projectSnapshot') = 'object'
   and exists (select 1 from jsonb_object_keys(v.snapshot_data -> 'projectSnapshot') k
               where not (k = any(public.document_snapshot_keys('project'))));
update public.quote_versions v
   set snapshot_data = jsonb_set(v.snapshot_data, '{companySnapshot}',
         public.jsonb_pick(v.snapshot_data -> 'companySnapshot', public.document_snapshot_keys('company')))
 where jsonb_typeof(v.snapshot_data -> 'companySnapshot') = 'object'
   and exists (select 1 from jsonb_object_keys(v.snapshot_data -> 'companySnapshot') k
               where not (k = any(public.document_snapshot_keys('company'))));

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Offerte- en factuurnummers: ook een tab of harde spatie telt als spatie
-- ════════════════════════════════════════════════════════════════════════════
--
-- enforce_finance_number_unique vergeleek upper(btrim(number)). btrim haalt
-- alleen gewone spaties weg: "OFF-2026-001" met een tab of een harde spatie
-- erachter (plakken uit een PDF of spreadsheet) gold als een ander nummer, en
-- zo stonden er twee offertes (of facturen) met hetzelfde nummer.
-- Nu: alle soorten witruimte tellen als één spatie, onzichtbare tekens tellen
-- niet, en het opgeslagen nummer wordt zo ook opgeschoond.

create or replace function public.finance_number_key(p_number text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select nullif(upper(btrim(regexp_replace(
           regexp_replace(coalesce(p_number, ''), '[​‌‍⁠﻿]', '', 'g'),
           '[\s   -     　]+', ' ', 'g'))), '');
$$;

create or replace function public.finance_number_clean(p_number text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select btrim(regexp_replace(
           regexp_replace(p_number, '[​‌‍⁠﻿]', '', 'g'),
           '[\s   -     　]+', ' ', 'g'));
$$;

revoke all on function public.finance_number_key(text) from public, anon;
grant execute on function public.finance_number_key(text) to authenticated, service_role;
revoke all on function public.finance_number_clean(text) from public, anon;
grant execute on function public.finance_number_clean(text) to authenticated, service_role;

create or replace function public.enforce_finance_number_unique()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_norm text;
  v_exists boolean;
begin
  -- Een nieuw of gewijzigd nummer opslaan zoals het eruitziet: zonder tabs,
  -- harde spaties of onzichtbare tekens.
  if new.number is not null and (tg_op = 'INSERT' or new.number is distinct from old.number) then
    new.number := public.finance_number_clean(new.number);
  end if;
  v_norm := public.finance_number_key(new.number);
  if v_norm is null then return new; end if;
  if tg_op = 'UPDATE' and public.finance_number_key(old.number) = v_norm then return new; end if;
  -- Twee gelijktijdige inserts met hetzelfde nummer: na elkaar.
  perform pg_advisory_xact_lock(hashtext(new.organization_id::text), hashtext(tg_table_name || ':' || v_norm));
  if tg_table_name = 'quotes' then
    select exists (select 1 from public.quotes q where q.organization_id = new.organization_id
                    and public.finance_number_key(q.number) = v_norm and q.id <> new.id) into v_exists;
  else
    select exists (select 1 from public.invoices i where i.organization_id = new.organization_id
                    and public.finance_number_key(i.number) = v_norm and i.id <> new.id) into v_exists;
  end if;
  if v_exists then
    raise exception 'Nummer % is al in gebruik in deze organisatie. Kies het volgende nummer.', new.number
      using errcode = '23505';
  end if;
  return new;
end;
$function$;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Offertes: de Nederlandse kalenderdag, en de KOR vóór het versturen
-- ════════════════════════════════════════════════════════════════════════════
--
-- approve_quote_internal rekende "verlopen" met current_date (UTC). Tussen
-- middernacht en 01:00/02:00 kon een offerte die gisteren verliep dus nog
-- worden goedgekeurd en verstuurd, terwijl de klant hem niet meer kon accepteren.
CREATE OR REPLACE FUNCTION public.approve_quote_internal(p_quote_id uuid, p_organization_id uuid)
 RETURNS quotes
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_quote public.quotes;
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'Niet ingelogd' using errcode = '28000'; end if;
  if not public.can_admin_org(p_organization_id) then raise exception 'Alleen owners/admins kunnen offertes intern goedkeuren' using errcode = '42501'; end if;

  select * into v_quote
  from public.quotes
  where id = p_quote_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Offerte niet gevonden' using errcode = '02000'; end if;
  if v_quote.status <> 'pending_internal_approval' or v_quote.internal_approval_status <> 'pending' then
    raise exception 'Deze offerte kan alleen vanuit de status ter interne goedkeuring worden goedgekeurd' using errcode = '23514';
  end if;
  if jsonb_typeof(coalesce(v_quote.lines, '[]'::jsonb)) <> 'array' then
    raise exception 'Offerte-regels hebben een ongeldig formaat' using errcode = '23514';
  end if;
  if jsonb_array_length(coalesce(v_quote.lines, '[]'::jsonb)) = 0 then
    raise exception 'Een offerte zonder regels kan niet intern worden goedgekeurd' using errcode = '23514';
  end if;
  if v_quote.valid_until is not null and v_quote.valid_until < (now() at time zone 'Europe/Amsterdam')::date then
    raise exception 'Deze offerte is verlopen en kan niet intern worden goedgekeurd' using errcode = '23514';
  end if;

  update public.quotes
  set status = 'internally_approved',
      internal_approval_status = 'approved',
      internal_approved_at = now(),
      internal_approved_by = v_user_id,
      internal_rejected_at = null,
      internal_rejected_by = null,
      internal_rejection_note = null,
      updated_at = now()
  where id = p_quote_id
  returning * into v_quote;

  perform public.create_quote_version_snapshot(p_quote_id, p_organization_id, 'internal_approval', v_user_id, null, null, null, null, null, null, jsonb_build_object('source', 'approve_quote_internal'));
  perform public.insert_quote_workflow_event(p_organization_id, p_quote_id, 'internal_approval_granted', 'Intern goedgekeurd', null, '{}'::jsonb, v_user_id);
  perform public.insert_quote_audit_event(p_organization_id, p_quote_id, 'quote_internal_approved', v_quote.number, '{}'::jsonb, v_user_id);

  select * into v_quote
  from public.quotes
  where id = p_quote_id and organization_id = p_organization_id;

  return v_quote;
end;
$function$;

-- Onder de kleineondernemersregeling rekent een factuur geen btw; de database
-- weigert het uitgeven (enforce_invoice_kor_no_vat). Een offerte met btw kon
-- wel worden ingediend, goedgekeurd, verstuurd en geaccepteerd, en de factuur
-- die eruit kwam was daarna niet te versturen. Nu weigert al het indienen en
-- goedkeuren (daarna liggen de regels vast). Het versturen controleert de edge
-- function vóór de mail; op 'sent' zelf controleren zou pas ná de mail vallen.
create or replace function public.enforce_quote_kor_no_vat()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_kor boolean;
begin
  if new.status not in ('pending_internal_approval', 'internally_approved') then return new; end if;
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then return new; end if;
  select coalesce(kor_enabled, false) into v_kor
    from public.company_settings where organization_id = new.organization_id;
  if coalesce(v_kor, false) and exists (
       select 1 from jsonb_array_elements(case when jsonb_typeof(new.lines) = 'array' then new.lines else '[]'::jsonb end) l
        where case when coalesce(l->>'vat', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (l->>'vat')::numeric else 0 end <> 0) then
    raise exception 'Je gebruikt de kleineondernemersregeling (KOR): een offerte rekent dan geen btw. Zet de btw van elke regel op 0%% (code KOR); anders kun je de factuur die eruit komt niet versturen.'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

revoke all on function public.enforce_quote_kor_no_vat() from public, anon;
grant execute on function public.enforce_quote_kor_no_vat() to authenticated, service_role;

drop trigger if exists quotes_kor_no_vat on public.quotes;
create trigger quotes_kor_no_vat
  before insert or update of status on public.quotes
  for each row execute function public.enforce_quote_kor_no_vat();

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Facturen: een chargeback die is goedgemaakt, en annuleren na betaling
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.recompute_invoice_chargeback_state(p_invoice_id uuid, p_organization_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_charged_back_cents bigint;
  v_invoice public.invoices;
  v_cb record;
  v_lines jsonb;
  v_entry public.journal_entries;
  v_today date := (now() at time zone 'Europe/Amsterdam')::date;
  v_covered boolean;
begin
  select * into v_invoice from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id
  for update;
  if not found then return; end if;

  -- Alleen actieve (niet-teruggedraaide) chargebacks tellen mee.
  select coalesce(sum(amount_cents), 0) into v_charged_back_cents
  from public.invoice_chargebacks
  where invoice_id = p_invoice_id and organization_id = p_organization_id
    and status = 'charged_back';

  -- Betaalrecord met een actieve chargeback → status 'charged_back'.
  update public.invoice_payment_records p
     set status = 'charged_back', updated_at = now()
   where p.invoice_id = p_invoice_id and p.organization_id = p_organization_id
     and p.status in ('paid','refunded')
     and exists (
       select 1 from public.invoice_chargebacks c
       where c.payment_record_id = p.id and c.status = 'charged_back'
     );

  -- Teruggedraaide chargeback en geen andere actieve chargeback → terug naar 'paid'.
  update public.invoice_payment_records p
     set status = 'paid', updated_at = now()
   where p.invoice_id = p_invoice_id and p.organization_id = p_organization_id
     and p.status = 'charged_back'
     and not exists (
       select 1 from public.invoice_chargebacks c
       where c.payment_record_id = p.id and c.status = 'charged_back'
     );

  update public.invoices
     set charged_back_amount = round(v_charged_back_cents::numeric / 100, 2),
         charged_back_at = case when v_charged_back_cents > 0 then coalesce(charged_back_at, now()) else null end,
         updated_at = now()
   where id = p_invoice_id and organization_id = p_organization_id;

  -- TOEGEVOEGD (20261104020000): bij een chargeback gaat het geld van het
  -- Mollie-saldo terug naar de klant en staat de factuur weer open: debet 1300,
  -- credit 1102. Wordt de chargeback teruggedraaid, dan deze boeking ook.
  for v_cb in
    select cb.id, cb.amount_cents
    from public.invoice_chargebacks cb
    join public.invoice_payment_records pr
      on pr.id = cb.payment_record_id and pr.organization_id = cb.organization_id and pr.journal_entry_id is not null
    where cb.invoice_id = p_invoice_id and cb.organization_id = p_organization_id
      and cb.status = 'charged_back' and cb.journal_entry_id is null and cb.amount_cents > 0
    order by cb.created_at
  loop
    perform public.ensure_default_ledger_accounts(p_organization_id);
    v_lines := jsonb_build_array(
      jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, '1300'),
        'description', 'Chargeback via Mollie: factuur weer open', 'debit_cents', v_cb.amount_cents, 'credit_cents', 0,
        'client_id', v_invoice.client_id),
      jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, '1102'),
        'description', 'Chargeback via Mollie (van het Mollie-saldo)', 'debit_cents', 0, 'credit_cents', v_cb.amount_cents)
    );
    v_entry := public.post_journal_entry(
      p_organization_id,
      public.first_open_booking_date_for(p_organization_id, v_today, false),
      'Chargeback factuur ' || coalesce(v_invoice.number, ''),
      'payment', p_invoice_id, v_lines, null
    );
    update public.invoice_chargebacks set journal_entry_id = v_entry.id where id = v_cb.id;
  end loop;

  for v_cb in
    select cb.id, cb.journal_entry_id
    from public.invoice_chargebacks cb
    join public.journal_entries je on je.id = cb.journal_entry_id and je.reversed_by_entry_id is null
    where cb.invoice_id = p_invoice_id and cb.organization_id = p_organization_id
      and cb.status <> 'charged_back'
  loop
    perform public.reverse_journal_entry(v_cb.journal_entry_id, null, null);
  end loop;

  -- GEWIJZIGD (20261106130000): is de factuur (weer) voldaan? Na een
  -- chargeback betaalde de klant opnieuw; elke latere melding van Mollie over
  -- de oude, teruggeboekte betaling zette de factuur toch terug op open, met
  -- een herinnering voor geld dat al binnen was (het grootboek: 0 open).
  -- Staan de factuur en de betalingen in het grootboek, dan beslist het
  -- openstaande bedrag; anders, zoals vroeger, een betaling op betaald.
  if v_invoice.journal_entry_id is not null
     and not exists (
       select 1 from public.invoice_payment_records p
       where p.invoice_id = p_invoice_id and p.organization_id = p_organization_id
         and p.status = 'paid' and p.journal_entry_id is null
     ) then
    v_covered := coalesce(public.invoice_open_receivable_cents(p_organization_id, p_invoice_id), 0) <= 0;
  else
    v_covered := exists (
      select 1 from public.invoice_payment_records p
      where p.invoice_id = p_invoice_id and p.organization_id = p_organization_id and p.status = 'paid'
    );
  end if;

  -- De factuur volgt: open bij een actieve chargeback die niet is goedgemaakt,
  -- weer betaald als die is teruggedraaid of de klant opnieuw heeft betaald.
  if v_charged_back_cents > 0 and not v_covered then
    update public.invoices
       set status = case when due_date is not null and due_date < v_today then 'overdue' else 'sent' end,
           paid_at = null,
           updated_at = now()
     where id = p_invoice_id and organization_id = p_organization_id and status = 'paid';
  elsif v_invoice.status in ('sent', 'overdue')
        and v_invoice.charged_back_at is not null
        and v_covered
        and exists (
          select 1 from public.invoice_payment_records p
          where p.invoice_id = p_invoice_id and p.organization_id = p_organization_id and p.status = 'paid'
        ) then
    update public.invoices
       set status = 'paid', paid_at = coalesce(paid_at, now()), updated_at = now()
     where id = p_invoice_id and organization_id = p_organization_id;
  end if;
end;
$function$;

-- Een betaalde, geboekte factuur kon via de status (PostgREST, of Gerrie met
-- invoice.set_status) op geannuleerd, ongeldig of afgeboekt: deze bewaking
-- keek alleen of er nog een bedrag openstond, en bij een betaalde factuur is
-- dat nul. Omzet en btw bleven dan geboekt bij een factuur die "geannuleerd"
-- heette. Een geboekte factuur sluit je met een creditnota; staat die er niet
-- (helemaal), dan weigert de database.
create or replace function public.enforce_invoice_cancel_after_credit()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_open bigint;
  v_booked bigint;
  v_credited bigint;
begin
  if current_user not in ('anon', 'authenticated', 'authenticator') then
    return new;
  end if;
  if new.status is distinct from old.status
     and new.status in ('cancelled', 'void', 'written_off')
     and old.journal_entry_id is not null then
    v_open := public.invoice_open_receivable_checked(old.id);
    if coalesce(v_open, 0) > 0 then
      raise exception 'Deze factuur staat in het grootboek: omzet en btw zijn geboekt. Annuleren of afboeken gaat met een creditnota; kies "Crediteren" bij de factuur.'
        using errcode = '23514';
    end if;
    -- TOEGEVOEGD (20261106130000): niets open door een betaling is iets anders
    -- dan niets open door een creditnota.
    select coalesce(sum(jl.debit_cents - jl.credit_cents), 0) into v_booked
      from public.journal_entries je
      join public.journal_lines jl on jl.entry_id = je.id
      join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_receivable'
     where je.id = old.journal_entry_id and je.status = 'posted'
       and je.reversed_by_entry_id is null and je.reverses_entry_id is null;
    select coalesce(sum(jl.credit_cents - jl.debit_cents), 0) into v_credited
      from public.credit_notes cn
      join public.journal_entries je on je.id = cn.journal_entry_id and je.status = 'posted'
        and je.reversed_by_entry_id is null and je.reverses_entry_id is null
      join public.journal_lines jl on jl.entry_id = je.id
      join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_receivable'
     where cn.organization_id = old.organization_id and cn.invoice_id = old.id;
    if v_booked > 0 and v_credited < v_booked then
      raise exception 'Deze factuur is (deels) betaald en staat in het grootboek: omzet en btw zijn geboekt. Een betaalde factuur annuleer je niet via de status; maak een terugbetaling met creditnota ("Terugbetaling" bij de factuur).'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$function$;

-- Een concept met alleen een ongebruikte betaallink blijft bewerkbaar.
--
-- Bij versturen met betaallink komt de link vóór de mail (begin_invoice_payment_
-- checkout zet dan locked_reason 'payment_checkout_created'). Mislukte de mail,
-- dan bleef het concept een concept, maar zat het voorgoed op slot: de open
-- betaallink telde als betaling. Een tikfout herstellen kon niet meer; alleen
-- precies hetzelfde opnieuw versturen. Nu blijft een concept zonder echte
-- betaling (geen pending, authorized, paid, refunded of charged_back) bewerkbaar.
-- Verandert de inhoud, dan vervalt de oude link (die vroeg het oude bedrag);
-- opnieuw versturen maakt een nieuwe link voor het nieuwe bedrag. locked_at
-- blijft staan (dat veld zet alleen de server); het telt bij een concept met
-- reden 'payment_checkout_created' niet als slot.
create or replace function public.enforce_invoice_immutability()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_has_committed_payment boolean;
  v_has_open_link boolean;
  v_draft_with_link_only boolean;
  v_content_changed boolean;
begin
  if TG_OP <> 'UPDATE' then
    return new;
  end if;

  select
    exists (
      select 1 from public.invoice_payment_records p
      where p.organization_id = old.organization_id and p.invoice_id = old.id
        and p.status in ('pending','authorized','paid','refunded','charged_back')
    ),
    exists (
      select 1 from public.invoice_payment_records p
      where p.organization_id = old.organization_id and p.invoice_id = old.id
        and p.status in ('creating','open')
    )
  into v_has_committed_payment, v_has_open_link;

  v_content_changed := old.number is distinct from new.number
    or old.client_id is distinct from new.client_id
    or old.project_id is distinct from new.project_id
    or old.quote_id is distinct from new.quote_id
    or old.date is distinct from new.date
    or old.due_date is distinct from new.due_date
    or old.lines is distinct from new.lines
    or old.notes is distinct from new.notes
    or old.currency is distinct from new.currency;

  v_draft_with_link_only := old.status = 'draft'
    and new.status = 'draft'
    and not v_has_committed_payment
    and (old.locked_at is null or coalesce(old.locked_reason, '') = 'payment_checkout_created');

  if v_draft_with_link_only then
    if v_content_changed and v_has_open_link then
      update public.invoice_payment_records
         set status = 'expired', updated_at = now()
       where organization_id = old.organization_id and invoice_id = old.id
         and status in ('creating','open');
    end if;
    return new;
  end if;

  if old.locked_at is not null
     or old.status in ('sent','overdue','paid','cancelled','void','written_off','refunded')
     or v_has_committed_payment
     or v_has_open_link then
    if v_content_changed then
      raise exception 'Deze factuur is vergrendeld. Maak een nieuwe/creditfactuur of formele versie in plaats van de verzonden factuur te wijzigen.' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$function$;

-- ════════════════════════════════════════════════════════════════════════════
-- 6. Herinneringen: pas na de vervaldatum, één tegelijk, één per dag
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.begin_invoice_reminder_send(p_invoice_id uuid, p_organization_id uuid, p_actor_user_id uuid, p_level smallint, p_token_hash text, p_token_expires_at timestamp with time zone, p_recipient_email text, p_recipient_name text, p_subject text, p_public_url text, p_attachment_file_name text DEFAULT NULL::text, p_attachment_mime_type text DEFAULT 'application/pdf'::text, p_attachment_size_bytes integer DEFAULT NULL::integer, p_attachment_sha256 text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_invoice public.invoices;
  v_delivery public.invoice_email_deliveries;
  v_today date := (now() at time zone 'Europe/Amsterdam')::date;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  if p_level not between 1 and 3 then
    raise exception 'Ongeldig herinneringsniveau.' using errcode = '22023';
  end if;

  select * into v_invoice
  from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Factuur niet gevonden.' using errcode = '02000'; end if;
  -- GEWIJZIGD (20261105230000): een concept is nooit verstuurd; de klant kreeg
  -- anders een herinnering voor een factuur die hij nooit ontving.
  if v_invoice.status = 'draft' then
    raise exception 'Deze factuur is nog een concept en is niet verstuurd: daar hoort geen herinnering bij.' using errcode = '23514';
  end if;
  if v_invoice.status in ('paid','cancelled','void','written_off','refunded') then
    raise exception 'Voor een betaalde, geannuleerde of afgeboekte factuur kan geen herinnering worden verstuurd.' using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261106130000): pas na de vervaldatum. Eerder kreeg de klant
  -- voor een factuur die nog niet vervallen was een herinnering met "0 dagen
  -- verstreken" (de knop toont dit niet, de functie liet het toe).
  if v_invoice.status <> 'overdue' and (v_invoice.due_date is null or v_invoice.due_date >= v_today) then
    raise exception 'Deze factuur is nog niet vervallen (vervaldatum %). Een herinnering kan vanaf de dag erna.',
      coalesce(to_char(v_invoice.due_date, 'DD-MM-YYYY'), 'onbekend') using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261106130000): twee collega's tegelijk (of een dubbelklik)
  -- stuurden de klant twee keer niveau 1: het slot hierboven zet ze alleen na
  -- elkaar. Nu wacht de tweede niet, maar hoort hij dat er al een onderweg is,
  -- of dat dit niveau al verstuurd is. Een poging die bleef hangen (geen
  -- afronding binnen tien minuten) houdt niets meer tegen.
  if exists (
    select 1 from public.invoice_email_deliveries d
    where d.invoice_id = v_invoice.id and d.organization_id = p_organization_id
      and d.delivery_kind = 'reminder' and d.status = 'queued'
      and d.created_at > now() - interval '10 minutes'
  ) then
    raise exception 'Er wordt op dit moment al een herinnering voor deze factuur verstuurd.' using errcode = '23514';
  end if;
  -- Hetzelfde (of een lager) niveau dat zojuist al ging: een dubbelklik, of een
  -- collega die net eerder was. Later opnieuw sturen (bijvoorbeeld via Gerrie
  -- met een gekozen niveau) blijft kunnen.
  if p_level <= coalesce(v_invoice.reminder_level, 0)
     and v_invoice.last_reminder_at is not null
     and v_invoice.last_reminder_at > now() - interval '10 minutes' then
    raise exception 'Herinnering niveau % is zojuist al verstuurd. Ververs de factuur.', p_level using errcode = '23514';
  end if;

  update public.invoices
     set public_token_hash = p_token_hash,
         public_token_created_at = now(),
         public_token_expires_at = p_token_expires_at,
         updated_at = now()
   where id = v_invoice.id;

  insert into public.invoice_email_deliveries(
    organization_id, invoice_id, recipient_email, recipient_name, subject, status,
    delivery_kind, reminder_level,
    attachment_file_name, attachment_mime_type, attachment_size_bytes, attachment_sha256,
    metadata
  ) values (
    p_organization_id, p_invoice_id, lower(btrim(p_recipient_email)), nullif(btrim(coalesce(p_recipient_name, '')), ''), p_subject, 'queued',
    'reminder', p_level,
    nullif(btrim(coalesce(p_attachment_file_name, '')), ''), coalesce(nullif(btrim(coalesce(p_attachment_mime_type, '')), ''), 'application/pdf'), p_attachment_size_bytes, nullif(btrim(coalesce(p_attachment_sha256, '')), ''),
    jsonb_build_object('publicUrl', p_public_url, 'reminderLevel', p_level)
  ) returning * into v_delivery;

  insert into public.invoice_public_links(
    organization_id, invoice_id, token_hash, purpose, status, delivery_id, expires_at, created_by, metadata
  ) values (
    p_organization_id, p_invoice_id, p_token_hash, 'email', 'active', v_delivery.id, p_token_expires_at, p_actor_user_id,
    jsonb_build_object('publicUrl', p_public_url, 'kind', 'reminder', 'reminderLevel', p_level)
  )
  on conflict (token_hash) do nothing;

  return jsonb_build_object('deliveryId', v_delivery.id, 'invoiceId', p_invoice_id);
end;
$function$;

-- De automatische herinneringen keken niet naar last_reminder_at: een factuur
-- die vandaag met de hand herinnerd was, kreeg van de cron dezelfde dag nog
-- één (het volgende niveau), en een tweede run op een dag stuurde opnieuw.
-- Ook "dagen te laat" telt nu op de Nederlandse kalenderdag.
create or replace function public.find_due_invoice_reminders(p_now timestamp with time zone default now(), p_limit integer default 200)
returns table(organization_id uuid, invoice_id uuid, next_level smallint, days_overdue integer)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_today date := (p_now at time zone 'Europe/Amsterdam')::date;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de service-role mag herinneringskandidaten ophalen.' using errcode = '42501';
  end if;

  return query
  select
    i.organization_id,
    i.id as invoice_id,
    (i.reminder_level + 1)::smallint as next_level,
    (v_today - i.due_date)::integer as days_overdue
  from public.invoices i
  join public.invoice_reminder_settings s on s.organization_id = i.organization_id
  where s.auto_reminders_enabled = true
    and i.status = 'overdue'
    and i.reminders_paused = false
    and i.reminder_level < 3
    and i.due_date is not null
    -- TOEGEVOEGD (20261104020000): niet voor een factuur die (per bank, Mollie
    -- of creditnota) al is voldaan maar nog op achterstallig staat.
    and (i.journal_entry_id is null or public.invoice_open_receivable_cents(i.organization_id, i.id) > 0)
    -- TOEGEVOEGD (20261106130000): hooguit één herinnering per factuur per dag,
    -- en niet terwijl er een onderweg is.
    and (i.last_reminder_at is null or (i.last_reminder_at at time zone 'Europe/Amsterdam')::date < v_today)
    and not exists (
      select 1 from public.invoice_email_deliveries d
      where d.invoice_id = i.id and d.organization_id = i.organization_id
        and d.delivery_kind = 'reminder' and d.status = 'queued'
        and d.created_at > p_now - interval '10 minutes'
    )
    and (v_today - i.due_date) >= case i.reminder_level
          when 0 then s.level1_offset_days
          when 1 then s.level2_offset_days
          when 2 then s.level3_offset_days
          else 2147483647
        end
  order by i.due_date asc
  limit greatest(1, p_limit);
end;
$function$;

-- Op "te laat" zetten volgde UTC: tussen middernacht en 01:00/02:00 gold een
-- factuur die gisteren verviel hier nog als op tijd, en in de app al als te laat.
CREATE OR REPLACE FUNCTION public.mark_invoices_overdue(p_organization_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_count integer := 0;
  v_rec record;
begin
  if auth.role() <> 'service_role'
     and (p_organization_id is null or not public.can_write_org(p_organization_id)) then
    raise exception 'Geen rechten om facturen als te laat te markeren.' using errcode = '42501';
  end if;

  for v_rec in
    update public.invoices i
       set status = 'overdue',
           updated_at = now()
     where i.status = 'sent'
       and i.due_date is not null
       and i.due_date < (now() at time zone 'Europe/Amsterdam')::date
       and (p_organization_id is null or i.organization_id = p_organization_id)
       -- TOEGEVOEGD (20261104020000): al voldaan (bank, Mollie, creditnota) is niet te laat.
       and (i.journal_entry_id is null or public.invoice_open_receivable_cents(i.organization_id, i.id) > 0)
    returning i.id, i.organization_id, i.number, i.due_date
  loop
    v_count := v_count + 1;
    perform public.insert_invoice_workflow_event(
      v_rec.organization_id,
      v_rec.id,
      'marked_overdue',
      'Factuur te laat',
      'Factuur ' || coalesce(v_rec.number, '') || ' is na de vervaldatum (' || to_char(v_rec.due_date, 'DD-MM-YYYY') || ') automatisch op ''te laat'' gezet.',
      jsonb_build_object('due_date', v_rec.due_date),
      null
    );
  end loop;

  return v_count;
end;
$function$;

-- ════════════════════════════════════════════════════════════════════════════
-- 7. Aanmaning: de vastgelegde aanmaning volgt de verstuurde brief
-- ════════════════════════════════════════════════════════════════════════════
--
-- Nieuwe parameters (met standaardwaarde, zodat een oudere edge function nog
-- werkt): de oude vorm gaat weg, anders zijn er twee functies met dezelfde
-- naam en kan PostgREST niet kiezen.
drop function if exists public.begin_dunning_send(uuid, uuid, uuid, bigint, integer, bigint, bigint, bigint, bigint, date, date, jsonb, text, timestamptz, text, text, text, text, text, text, integer, text);

CREATE OR REPLACE FUNCTION public.begin_dunning_send(p_notice_id uuid, p_organization_id uuid, p_actor_user_id uuid, p_interest_cents bigint, p_interest_days integer, p_daily_interest_cents bigint, p_collection_costs_cents bigint, p_collection_costs_vat_cents bigint, p_total_claim_cents bigint, p_calculation_date date, p_deadline_date date, p_rate_snapshot jsonb, p_token_hash text, p_token_expires_at timestamp with time zone, p_recipient_email text, p_recipient_name text, p_subject text, p_public_url text, p_attachment_file_name text DEFAULT NULL::text, p_attachment_mime_type text DEFAULT 'application/pdf'::text, p_attachment_size_bytes integer DEFAULT NULL::integer, p_attachment_sha256 text DEFAULT NULL::text, p_principal_cents bigint DEFAULT NULL::bigint, p_client_kind text DEFAULT NULL::text, p_interest_kind text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_notice public.invoice_dunning_notices;
  v_invoice public.invoices;
  v_delivery public.invoice_email_deliveries;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_notice
  from public.invoice_dunning_notices
  where id = p_notice_id and organization_id = p_organization_id
  for update;
  if not found then raise exception 'Aanmaning niet gevonden.' using errcode = '02000'; end if;
  if v_notice.status = 'sent' then
    raise exception 'Deze aanmaning is al verstuurd.' using errcode = '23514';
  end if;
  if v_notice.status = 'cancelled' then
    raise exception 'Deze aanmaning is geannuleerd.' using errcode = '23514';
  end if;
  -- Alleen een voorgestelde of eerder mislukte aanmaning mag (opnieuw) verstuurd worden.
  -- Weiger o.a. de tussenstatus 'confirmed' (verzending al in gang), zodat een dubbelklik
  -- of retry niet een TWEEDE formele aanmaning verstuurt (de FOR UPDATE-lock serialiseert
  -- de twee verzoeken, maar zonder deze guard zou de tweede alsnog doorgaan).
  if v_notice.status not in ('proposed', 'failed') then
    raise exception 'Deze aanmaning wordt al verstuurd.' using errcode = '23514';
  end if;

  select * into v_invoice
  from public.invoices
  where id = v_notice.invoice_id and organization_id = p_organization_id
  for update;
  if not found then raise exception 'Factuur niet gevonden.' using errcode = '02000'; end if;
  -- GEWIJZIGD (20261105230000): een formele aanmaning ("van rechtswege in
  -- verzuim", incassokosten) alleen voor een verstuurde factuur waarvan de
  -- vervaldatum voorbij is. Eerder kon dat ook voor een concept.
  if v_invoice.status = 'draft' then
    raise exception 'Deze factuur is nog een concept en is niet verstuurd: daar hoort geen aanmaning bij.' using errcode = '23514';
  end if;
  if v_invoice.due_date is null or v_invoice.due_date >= (now() at time zone 'Europe/Amsterdam')::date then
    raise exception 'Een aanmaning kan pas na de vervaldatum van de factuur.' using errcode = '23514';
  end if;
  if v_invoice.status in ('paid','cancelled','void','written_off','refunded') then
    raise exception 'Voor een betaalde, geannuleerde of afgeboekte factuur kan geen aanmaning worden verstuurd.' using errcode = '23514';
  end if;

  update public.invoices
     set public_token_hash = p_token_hash,
         public_token_created_at = now(),
         public_token_expires_at = p_token_expires_at,
         updated_at = now()
   where id = v_invoice.id;

  insert into public.invoice_email_deliveries(
    organization_id, invoice_id, recipient_email, recipient_name, subject, status,
    delivery_kind,
    attachment_file_name, attachment_mime_type, attachment_size_bytes, attachment_sha256,
    metadata
  ) values (
    p_organization_id, v_notice.invoice_id, lower(btrim(p_recipient_email)), nullif(btrim(coalesce(p_recipient_name, '')), ''), p_subject, 'queued',
    'dunning',
    nullif(btrim(coalesce(p_attachment_file_name, '')), ''), coalesce(nullif(btrim(coalesce(p_attachment_mime_type, '')), ''), 'application/pdf'), p_attachment_size_bytes, nullif(btrim(coalesce(p_attachment_sha256, '')), ''),
    jsonb_build_object('publicUrl', p_public_url, 'dunningNoticeId', v_notice.id)
  ) returning * into v_delivery;

  insert into public.invoice_public_links(
    organization_id, invoice_id, token_hash, purpose, status, delivery_id, expires_at, created_by, metadata
  ) values (
    p_organization_id, v_notice.invoice_id, p_token_hash, 'email', 'active', v_delivery.id, p_token_expires_at, p_actor_user_id,
    jsonb_build_object('publicUrl', p_public_url, 'kind', 'dunning', 'dunningNoticeId', v_notice.id)
  )
  on conflict (token_hash) do nothing;

  update public.invoice_dunning_notices
     set status = 'confirmed',
         -- TOEGEVOEGD (20261106130000): de hoofdsom en het soort klant en rente
         -- zoals bij het versturen berekend. Na een deelbetaling tussen voorstel
         -- en versturen noemde de brief het nieuwe openstaande bedrag, maar bleef
         -- de vastgelegde aanmaning (en het scherm) het oude tonen.
         principal_cents = coalesce(p_principal_cents, principal_cents),
         client_kind = coalesce(p_client_kind, client_kind),
         interest_kind = coalesce(p_interest_kind, interest_kind),
         interest_cents = p_interest_cents,
         interest_days = coalesce(p_interest_days, 0),
         daily_interest_cents = coalesce(p_daily_interest_cents, 0),
         collection_costs_cents = p_collection_costs_cents,
         collection_costs_vat_cents = p_collection_costs_vat_cents,
         total_claim_cents = p_total_claim_cents,
         calculation_date = p_calculation_date,
         deadline_date = p_deadline_date,
         rate_snapshot = coalesce(p_rate_snapshot, rate_snapshot),
         public_url = p_public_url,
         delivery_id = v_delivery.id,
         confirmed_by = p_actor_user_id,
         confirmed_at = now(),
         updated_at = now()
   where id = v_notice.id;

  return jsonb_build_object('deliveryId', v_delivery.id, 'noticeId', v_notice.id);
end;
$function$;

revoke all on function public.begin_dunning_send(uuid, uuid, uuid, bigint, integer, bigint, bigint, bigint, bigint, date, date, jsonb, text, timestamptz, text, text, text, text, text, text, integer, text, bigint, text, text) from public, anon, authenticated;
grant execute on function public.begin_dunning_send(uuid, uuid, uuid, bigint, integer, bigint, bigint, bigint, bigint, date, date, jsonb, text, timestamptz, text, text, text, text, text, text, integer, text, bigint, text, text) to service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- 8. Klantportaal: geen zijdeur voor teamleden
-- ════════════════════════════════════════════════════════════════════════════
--
-- Het portaal leidt toegang af uit het e-mailadres van de sessie
-- (portal_clients_for_email): het hoofdadres van een klant, of een
-- contactpersoon met portaaltoegang. Een teamlid zonder Financiën (wel
-- Klanten) zette zijn eigen adres als portaalcontact bij een klant, en las
-- daarna via het portaal alle facturen, offertes en contracten van die klant,
-- downloadde de PDF's en accepteerde een offerte "als klant". Met een tweede,
-- privé-adres ging het net zo.
-- Nu (a) is een actief teamlid in zijn eigen organisatie nooit portaalklant,
-- en (b) vraagt portaaltoegang geven, of het hoofdadres van een klant met
-- documenten wijzigen, schrijfrecht in Financiën: dat adres is de sleutel tot
-- die documenten.

create or replace function public.portal_email_is_member(p_organization_id uuid, p_email text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public.normalize_client_lookup_value(p_email) is not null and (
    exists (
      select 1
      from public.organization_members m
      join auth.users u on u.id = m.user_id
      where m.organization_id = p_organization_id
        and m.status = 'active'
        and public.normalize_client_lookup_value(u.email) = public.normalize_client_lookup_value(p_email)
    )
    or exists (
      select 1
      from public.organization_members m
      where m.organization_id = p_organization_id
        and m.status = 'active'
        and public.normalize_client_lookup_value(m.email::text) = public.normalize_client_lookup_value(p_email)
    )
  );
$$;

revoke all on function public.portal_email_is_member(uuid, text) from public, anon, authenticated;
grant execute on function public.portal_email_is_member(uuid, text) to service_role;

create or replace function public.portal_clients_for_email(p_email text)
returns setof public.clients
language sql
stable
security definer
set search_path to 'public'
as $function$
  select c.*
  from public.clients c
  where c.email is not null
    and public.normalize_client_lookup_value(p_email) is not null
    and public.normalize_client_lookup_value(c.email)
        = public.normalize_client_lookup_value(p_email)
    -- TOEGEVOEGD (20261106130000): een teamlid is in zijn eigen organisatie geen klant.
    and not public.portal_email_is_member(c.organization_id, p_email)
  union
  select c.*
  from public.clients c
  join public.client_contacts cc
    on cc.client_id = c.id
    -- Verdedigingslaag naast de org-integriteitstrigger op client_contacts:
    -- ook al zou een rij ooit met een mismatchende organization_id bestaan,
    -- dan telt hij hier alsnog niet mee voor portaaltoegang.
    and cc.organization_id = c.organization_id
  where cc.gives_portal_access = true
    and cc.is_active = true
    and public.normalize_client_lookup_value(p_email) is not null
    -- cc.email wordt al genormaliseerd opgeslagen (enforce_client_contacts_guard),
    -- maar hier ook expliciet wrappen zodat de query exact de indexexpressie van
    -- idx_client_contacts_email_portal_lookup matcht (anders is die index onbruikbaar).
    and public.normalize_client_lookup_value(cc.email) = public.normalize_client_lookup_value(p_email)
    and not public.portal_email_is_member(c.organization_id, p_email);
$function$;

-- Heeft deze klant iets in het portaal staan (zoals client-portal het toont):
-- een uitgegeven factuur, een verstuurde offerte (ook via een project van de
-- klant) of een verstuurd, getekend of geweigerd contract.
create or replace function public.client_has_portal_documents(p_organization_id uuid, p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
      select 1 from public.invoices i
      where i.organization_id = p_organization_id and i.status <> 'draft'
        and (i.client_id = p_client_id
             or i.project_id in (select p.id from public.projects p where p.organization_id = p_organization_id and p.client_id = p_client_id))
    )
    or exists (
      select 1 from public.quotes q
      where q.organization_id = p_organization_id and q.sent_at is not null
        and (q.client_id = p_client_id
             or q.project_id in (select p.id from public.projects p where p.organization_id = p_organization_id and p.client_id = p_client_id))
    )
    or exists (
      select 1 from public.contracts c
      where c.organization_id = p_organization_id and c.client_id = p_client_id
        and c.status in ('sent', 'signed', 'declined')
    );
$$;

revoke all on function public.client_has_portal_documents(uuid, uuid) from public, anon, authenticated;
grant execute on function public.client_has_portal_documents(uuid, uuid) to service_role;

create or replace function public.enforce_portal_access_finance_write()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_grants boolean := false;
begin
  -- Alleen wie als teamlid schrijft (de app, Gerrie en de API namens een
  -- teamlid). De server en de workers hebben hun eigen controle.
  if auth.uid() is null then return new; end if;
  if public.can_write_module(new.organization_id, 'finance') then return new; end if;

  if tg_table_name = 'client_contacts' then
    v_grants := coalesce(new.gives_portal_access, false) and coalesce(new.is_active, false)
      and (tg_op = 'INSERT'
           or not (coalesce(old.gives_portal_access, false) and coalesce(old.is_active, false))
           or public.normalize_client_lookup_value(new.email) is distinct from public.normalize_client_lookup_value(old.email)
           or new.client_id is distinct from old.client_id);
    if v_grants then
      raise exception 'Portaaltoegang geeft deze persoon inzage in de facturen, offertes en contracten van de klant. Dat mag alleen wie in Financiën mag schrijven; vraag een collega met die rechten.'
        using errcode = '42501';
    end if;
  elsif tg_table_name = 'clients' and tg_op = 'UPDATE' then
    v_grants := public.normalize_client_lookup_value(new.email) is not null
      and public.normalize_client_lookup_value(new.email) is distinct from public.normalize_client_lookup_value(old.email)
      and public.client_has_portal_documents(new.organization_id, new.id);
    if v_grants then
      raise exception 'Het e-mailadres van deze klant is ook zijn inlog voor het klantportaal, met de facturen, offertes en contracten. Alleen wie in Financiën mag schrijven kan het wijzigen; vraag een collega met die rechten.'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$function$;

revoke all on function public.enforce_portal_access_finance_write() from public, anon;
grant execute on function public.enforce_portal_access_finance_write() to authenticated, service_role;

drop trigger if exists client_contacts_portal_access_finance on public.client_contacts;
create trigger client_contacts_portal_access_finance
  before insert or update of gives_portal_access, is_active, email, client_id on public.client_contacts
  for each row execute function public.enforce_portal_access_finance_write();

drop trigger if exists clients_portal_email_finance on public.clients;
create trigger clients_portal_email_finance
  before update of email on public.clients
  for each row execute function public.enforce_portal_access_finance_write();

-- ════════════════════════════════════════════════════════════════════════════
-- 9. Contracten: één verzending tegelijk, versienummers onder slot, "je"
-- ════════════════════════════════════════════════════════════════════════════
--
-- snapshot_contract_version rekende max(version_number) + 1 zonder slot: twee
-- verzendingen tegelijk kregen hetzelfde nummer en de tweede botste op de
-- unieke index. Nu eerst de contractrij vast.
create or replace function public.snapshot_contract_version(p_contract_id uuid, p_organization_id uuid, p_reason text, p_title text, p_body text, p_amount_cents bigint default null::bigint, p_currency text default null::text, p_created_by uuid default null::uuid, p_pdf_storage_key text default null::text, p_pdf_sha256 text default null::text, p_pdf_size_bytes bigint default null::bigint)
returns public.contract_versions
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_next integer;
  v_row public.contract_versions;
begin
  perform 1 from public.contracts
   where id = p_contract_id and organization_id = p_organization_id
   for update;

  select coalesce(max(version_number), 0) + 1 into v_next
  from public.contract_versions
  where organization_id = p_organization_id and contract_id = p_contract_id;

  insert into public.contract_versions(
    organization_id, contract_id, version_number, snapshot_reason, title, body,
    amount_cents, currency, created_by, pdf_storage_key, pdf_sha256, pdf_size_bytes
  ) values (
    p_organization_id, p_contract_id, v_next, p_reason, coalesce(p_title, ''), coalesce(p_body, ''),
    p_amount_cents, p_currency, p_created_by, p_pdf_storage_key, p_pdf_sha256, p_pdf_size_bytes
  ) returning * into v_row;

  return v_row;
end;
$function$;

CREATE OR REPLACE FUNCTION public.begin_contract_signature_send(p_contract_id uuid, p_organization_id uuid, p_actor_user_id uuid, p_token_hash text, p_token_expires_at timestamp with time zone, p_recipient_email text, p_recipient_name text, p_subject text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_contract public.contracts;
  v_delivery_id uuid;
  v_previous_signer jsonb;
begin
  select * into v_contract from public.contracts
  where id = p_contract_id and organization_id = p_organization_id for update;
  if not found then raise exception 'Contract niet gevonden.' using errcode = '02000'; end if;
  if v_contract.status not in ('draft','pending_internal_approval','internally_approved','sent','expired') then
    raise exception 'Dit contract kan niet (opnieuw) ter ondertekening worden verstuurd vanuit status %.', v_contract.status using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261106130000): één verzending tegelijk. Twee collega's (of
  -- twee tabbladen) maakten elk een nieuwe link; mislukte de tweede, dan zette
  -- die de link van vóór beide terug, en werkte de link in de mail van de
  -- eerste niet meer. Een poging die bleef hangen telt na tien minuten niet.
  if exists (
    select 1 from public.contract_email_deliveries d
    where d.contract_id = p_contract_id and d.organization_id = p_organization_id
      and d.status = 'queued' and d.created_at > now() - interval '10 minutes'
  ) then
    raise exception 'Dit contract wordt op dit moment al verstuurd. Wacht even en ververs het contract.' using errcode = '23514';
  end if;
  -- De link en ondertekenaar van vóór deze poging, gelezen onder het slot: mislukt
  -- de mail, dan zet de server precies deze terug (en niet wat hij eerder, buiten
  -- het slot, had gelezen).
  select jsonb_build_object('name', s.name, 'email', s.email) into v_previous_signer
    from public.contract_signers s
   where s.contract_id = p_contract_id and s.role = 'client'
   order by s.signing_order
   limit 1;

  update public.contracts
  set public_token_hash = p_token_hash,
      public_token_created_at = now(),
      public_token_expires_at = p_token_expires_at,
      updated_at = now()
  where id = p_contract_id;

  -- Zorg dat er een klant-ondertekenaar bestaat voor deze ontvanger.
  if not exists (
    select 1 from public.contract_signers
    where contract_id = p_contract_id and role = 'client'
  ) then
    insert into public.contract_signers(organization_id, contract_id, name, email, role, signing_order)
    values (p_organization_id, p_contract_id, coalesce(p_recipient_name, ''), lower(btrim(p_recipient_email)), 'client', 1);
  else
    update public.contract_signers
    set name = coalesce(nullif(btrim(p_recipient_name), ''), name),
        email = lower(btrim(p_recipient_email)),
        status = 'pending',
        signed_at = null,
        updated_at = now()
    where contract_id = p_contract_id and role = 'client';
  end if;

  insert into public.contract_email_deliveries(
    organization_id, contract_id, template_key, recipient_email, recipient_name, subject, status, metadata
  ) values (
    p_organization_id, p_contract_id, 'contract.sent', lower(btrim(p_recipient_email)), p_recipient_name, p_subject, 'queued',
    jsonb_build_object(
      'previousLink', jsonb_build_object(
        'tokenHash', v_contract.public_token_hash,
        'createdAt', v_contract.public_token_created_at,
        'expiresAt', v_contract.public_token_expires_at),
      'previousSigner', v_previous_signer)
  ) returning id into v_delivery_id;

  perform public.insert_contract_event(p_organization_id, p_contract_id, 'public_token_created', 'Ondertekenlink aangemaakt', null, '{}'::jsonb, p_actor_user_id);
  return v_delivery_id;
end;
$function$;

-- De melding bij een gewijzigde versie sprak de klant aan met "u"; overal
-- elders in het scherm is het "je".
CREATE OR REPLACE FUNCTION public.sign_contract_public(p_token_hash text, p_signer_name text, p_signer_email text, p_signature_method text, p_signature_image text, p_consent_text text, p_ip text DEFAULT NULL::text, p_user_agent text DEFAULT NULL::text, p_version_id uuid DEFAULT NULL::uuid)
 RETURNS contracts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_contract public.contracts;
  v_latest_version uuid;
  v_invited_email text;
  v_typed_email text := nullif(lower(btrim(coalesce(p_signer_email, ''))), '');
begin
  select * into v_contract from public.contracts
  where public_token_hash = p_token_hash
    and public_token_expires_at is not null
    and public_token_expires_at > now()
  for update;
  if not found then raise exception 'Ondertekenlink is ongeldig of verlopen.' using errcode = '28000'; end if;
  if v_contract.status <> 'sent' then raise exception 'Dit contract kan niet meer worden ondertekend.' using errcode = '23514'; end if;
  if p_signature_method not in ('typed','drawn') then raise exception 'Ongeldige ondertekenmethode.' using errcode = '23514'; end if;
  if v_contract.valid_until is not null and v_contract.valid_until < (now() at time zone 'Europe/Amsterdam')::date then
    raise exception 'De termijn om dit contract te ondertekenen is verlopen (geldig tot %). Vraag de afzender om een nieuwe versie.',
      to_char(v_contract.valid_until, 'DD-MM-YYYY') using errcode = '23514';
  end if;

  select v.id into v_latest_version
    from public.contract_versions v
   where v.organization_id = v_contract.organization_id
     and v.contract_id = v_contract.id
     and v.snapshot_reason = 'sent_to_client'
   order by v.version_number desc
   limit 1;
  if v_latest_version is not null and p_version_id is distinct from v_latest_version then
    raise exception 'Dit contract is gewijzigd of opnieuw verstuurd sinds je de pagina opende. Laad de pagina opnieuw en lees de actuele versie voordat je ondertekent.'
      using errcode = '23514';
  end if;

  select s.email into v_invited_email
    from public.contract_signers s
   where s.contract_id = v_contract.id and s.role = 'client'
   order by s.signing_order
   limit 1;

  update public.contract_signers
  set status = 'signed',
      name = coalesce(nullif(btrim(p_signer_name), ''), name),
      email = coalesce(email, v_typed_email),
      signed_at = now(),
      signature_method = p_signature_method,
      signature_image = nullif(p_signature_image, ''),
      signed_ip = nullif(btrim(coalesce(p_ip, '')), ''),
      signed_user_agent = nullif(btrim(coalesce(p_user_agent, '')), ''),
      consent_text = nullif(btrim(coalesce(p_consent_text, '')), ''),
      -- De link ging naar het uitgenodigde adres; "geverifieerd" alleen als het
      -- ingetypte adres daarmee overeenkomt.
      email_verified_at = case when v_typed_email is not null and v_typed_email = lower(btrim(coalesce(email, '')))
                               then coalesce(email_verified_at, now()) else email_verified_at end,
      updated_at = now()
  where contract_id = v_contract.id and role = 'client';

  update public.contracts
  set status = 'signed', signed_at = now(), updated_at = now()
  where id = v_contract.id
  returning * into v_contract;

  perform public.insert_contract_event(
    v_contract.organization_id, v_contract.id, 'client_signed',
    'Klant heeft het contract ondertekend', null,
    jsonb_build_object('name', p_signer_name, 'email', p_signer_email, 'invited_email', v_invited_email,
                       'email_matches_invitation', v_typed_email is not distinct from lower(btrim(coalesce(v_invited_email, ''))),
                       'method', p_signature_method, 'ip', p_ip, 'version_id', v_latest_version),
    null
  );
  return v_contract;
end;
$function$;

-- ════════════════════════════════════════════════════════════════════════════
-- 10. Rechten van de vervangen functies: zoals ze waren, maar hier expliciet
-- ════════════════════════════════════════════════════════════════════════════
--
-- create or replace laat de rechten staan; migrationGrants.test.ts eist dat elke
-- functie uit een migratie daarin ook voor anon (en PUBLIC) wordt dichtgezet.
revoke all on function public.approve_quote_internal(uuid,uuid) from public, anon;
grant execute on function public.approve_quote_internal(uuid,uuid) to authenticated, service_role;
revoke all on function public.begin_contract_signature_send(uuid,uuid,uuid,text,timestamptz,text,text,text) from public, anon, authenticated;
grant execute on function public.begin_contract_signature_send(uuid,uuid,uuid,text,timestamptz,text,text,text) to service_role;
revoke all on function public.begin_invoice_reminder_send(uuid,uuid,uuid,smallint,text,timestamptz,text,text,text,text,text,text,integer,text) from public, anon, authenticated;
grant execute on function public.begin_invoice_reminder_send(uuid,uuid,uuid,smallint,text,timestamptz,text,text,text,text,text,text,integer,text) to service_role;
revoke all on function public.enforce_finance_number_unique() from public, anon;
grant execute on function public.enforce_finance_number_unique() to authenticated, service_role;
revoke all on function public.enforce_invoice_cancel_after_credit() from public, anon, authenticated;
grant execute on function public.enforce_invoice_cancel_after_credit() to service_role;
revoke all on function public.enforce_invoice_immutability() from public, anon;
grant execute on function public.enforce_invoice_immutability() to authenticated, service_role;
revoke all on function public.find_due_invoice_reminders(timestamptz,integer) from public, anon, authenticated;
grant execute on function public.find_due_invoice_reminders(timestamptz,integer) to service_role;
revoke all on function public.mark_invoices_overdue(uuid) from public, anon, authenticated;
grant execute on function public.mark_invoices_overdue(uuid) to service_role;
revoke all on function public.portal_clients_for_email(text) from public, anon, authenticated;
grant execute on function public.portal_clients_for_email(text) to service_role;
revoke all on function public.recompute_invoice_chargeback_state(uuid,uuid) from public, anon, authenticated;
grant execute on function public.recompute_invoice_chargeback_state(uuid,uuid) to service_role;
revoke all on function public.sign_contract_public(text,text,text,text,text,text,text,text,uuid) from public, anon, authenticated;
grant execute on function public.sign_contract_public(text,text,text,text,text,text,text,text,uuid) to service_role;
revoke all on function public.snapshot_contract_version(uuid,uuid,text,text,text,bigint,text,uuid,text,text,bigint) from public, anon, authenticated;
grant execute on function public.snapshot_contract_version(uuid,uuid,text,text,text,bigint,text,uuid,text,text,bigint) to service_role;
