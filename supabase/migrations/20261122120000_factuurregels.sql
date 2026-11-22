-- Factuurregels: wat er op een factuur staat, en langs welke weg hij uitgaat
--
-- Uit de controle "van werk naar geld" van 22 november 2026:
--
--   1. Uitgeven gaat alleen nog via de server (bevinding 12). "Verzonden" of
--      "Te laat" in het statusveld, of via Gerrie (invoice.set_status), boekte
--      een concept zonder de controles van het versturen: het btw-nummer bij
--      ICP of verlegd, de KOR, een factuurdatum in een afgesloten tijdvak.
--      Een ICP-factuur aan een Belgische klant zonder btw-nummer kwam zo in
--      rubriek 3b en in de ICP-opgaaf met een leeg btw-nummer, en er was geen
--      pdf vastgelegd van wat de klant kreeg. Nu weigert de database dat
--      rechtstreeks; de server geeft uit (per mail, of met de nieuwe weg
--      "uitgeven zonder mail") en controleert eerst.
--   2. issue_invoice_without_email: die nieuwe weg. Wie de pdf zelf mailt of
--      op papier geeft, krijgt dezelfde controles, en de pdf die de klant krijgt
--      wordt vastgelegd als verzonden versie.
--   3. convert_accepted_quote_to_invoice: de vervaldatum volgt de betaaltermijn
--      uit de bedrijfsgegevens (bevinding 9). Het was altijd 14 dagen, ook als
--      op dezelfde factuur "Betaling binnen 30 dagen." stond; de herinneringen
--      begonnen zo 16 dagen te vroeg.
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


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Een concept geeft alleen de server uit
-- ═══════════════════════════════════════════════════════════════════════════
-- Rechtstreeks (de app, Gerrie, de API: allemaal als het teamlid) mag een
-- concept niet meer op verzonden, te laat of betaald. Dat liep langs alle
-- controles van het versturen heen, en de database boekte het concept toch
-- (invoices_autobook). Uitgeven gaat via invoice-workflow (de service-role):
-- versturen per mail, via Mollie, of zonder mail. Een functie met security
-- definer (zoals afletteren bij de bank) draait als eigenaar en valt hier ook
-- buiten.
--
-- Eén uitzondering: een factuur van vóór de startdatum van de boekhouding.
-- Die wordt niet geboekt (de vordering zit in de beginbalans), en wie
-- overstapt uit een ander pakket zet zijn oude openstaande en betaalde
-- facturen zo zelf op verzonden of betaald.
--
-- Ook een geannuleerd concept dat nooit is uitgegeven, gaat niet zo
-- alsnog de deur uit.
create or replace function public.enforce_invoice_issue_via_server()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_start date;
begin
  if current_user not in ('anon', 'authenticated', 'authenticator') then return new; end if;
  if new.status not in ('sent', 'overdue', 'paid') then return new; end if;
  if tg_op = 'UPDATE' and (old.status not in ('draft', 'cancelled', 'void') or old.journal_entry_id is not null) then
    return new;
  end if;
  select bookkeeping_start_date into v_start
    from public.company_settings where organization_id = new.organization_id;
  if v_start is not null and new.date is not null and new.date < v_start then
    return new;
  end if;
  if new.status = 'paid' then
    raise exception 'Factuur % is nog niet uitgegeven. Geef hem eerst uit met "Verstuur per e-mail" of "Uitgeven zonder mail" bij de factuur. Leg de betaling daarna vast bij Bank; dan gaat hij vanzelf op betaald.',
      coalesce(new.number, '') using errcode = '23514';
  end if;
  raise exception 'Factuur % is nog niet uitgegeven. Dat doe je met "Verstuur per e-mail" bij de factuur, of met "Uitgeven zonder mail" als je hem zelf mailt of print. Dan controleert ResoFly eerst de btw (zoals het btw-nummer van je klant bij ICP of verlegd) en bewaart het de pdf die je klant krijgt.',
    coalesce(new.number, '') using errcode = '23514';
end;
$function$;

revoke all on function public.enforce_invoice_issue_via_server() from public, anon, authenticated;

drop trigger if exists invoices_issue_via_server on public.invoices;
create trigger invoices_issue_via_server
  before insert or update of status on public.invoices
  for each row execute function public.enforce_invoice_issue_via_server();


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Uitgeven zonder mail
-- ═══════════════════════════════════════════════════════════════════════════
-- Voor wie de pdf zelf mailt, print of in een portaal zet. invoice-workflow
-- controleert eerst wat het versturen ook controleert, maakt de pdf, bewaart
-- hem (in private opslag of hier als base64) en roept dan deze functie aan.
-- Die zet de factuur op verzonden en vast, en legt de pdf vast als de
-- verzonden versie: "Download verzonden PDF" geeft daarna precies die.
-- Alleen de server roept hem aan.
create or replace function public.issue_invoice_without_email(
  p_invoice_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_pdf_file_name text,
  p_pdf_mime_type text,
  p_pdf_size_bytes integer,
  p_pdf_sha256 text,
  p_pdf_data_base64 text default null,
  p_pdf_storage_provider text default null,
  p_pdf_storage_key text default null
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_invoice public.invoices;
  v_version public.invoice_versions;
  v_provider text := nullif(btrim(coalesce(p_pdf_storage_provider, '')), '');
  v_key text := nullif(btrim(coalesce(p_pdf_storage_key, '')), '');
  v_base64 text := nullif(btrim(coalesce(p_pdf_data_base64, '')), '');
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de server geeft een factuur uit.' using errcode = '42501';
  end if;
  if p_actor_user_id is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;
  if p_pdf_file_name is null or coalesce(p_pdf_size_bytes, 0) <= 0 or p_pdf_sha256 is null then
    raise exception 'Uitgeven vraagt een echte pdf met bestandsnaam, grootte en SHA-256.' using errcode = '23514';
  end if;
  if v_provider = 'r2' and v_key is null then
    raise exception 'Een pdf in private opslag heeft een sleutel nodig.' using errcode = '23514';
  end if;
  if v_provider is null and v_base64 is null then
    raise exception 'De pdf moet in private opslag of in de database worden bewaard.' using errcode = '23514';
  end if;

  select * into v_invoice
    from public.invoices
   where id = p_invoice_id and organization_id = p_organization_id
   for update;
  if not found then raise exception 'Factuur niet gevonden.' using errcode = '02000'; end if;
  if v_invoice.status <> 'draft' then
    raise exception 'Factuur % is al uitgegeven.', coalesce(v_invoice.number, '') using errcode = '23514';
  end if;
  -- Een verzending per mail die nog loopt: niet ook nog zonder mail.
  if exists (
    select 1 from public.invoice_email_deliveries d
     where d.invoice_id = p_invoice_id and d.organization_id = p_organization_id
       and d.delivery_kind = 'invoice' and d.status = 'queued'
       and d.created_at > now() - interval '3 minutes'
  ) then
    raise exception 'Factuur % wordt op dit moment per mail verstuurd. Wacht even en kijk bij de factuur of hij is verzonden.',
      coalesce(v_invoice.number, '') using errcode = '23514';
  end if;

  -- Hetzelfde als na een verzonden mail (complete_invoice_email_send): de
  -- database boekt hem (invoices_autobook) en zet hem vast.
  update public.invoices
     set status = 'sent',
         sent_at = coalesce(sent_at, now()),
         locked_at = coalesce(locked_at, now()),
         locked_reason = coalesce(locked_reason, 'sent_to_client'),
         updated_at = now()
   where id = p_invoice_id and organization_id = p_organization_id
   returning * into v_invoice;

  v_version := public.create_invoice_version_snapshot(
    p_invoice_id, p_organization_id, 'sent_to_client', p_actor_user_id, null, null,
    p_pdf_file_name, coalesce(nullif(btrim(coalesce(p_pdf_mime_type, '')), ''), 'application/pdf'), p_pdf_size_bytes, lower(p_pdf_sha256), null,
    jsonb_build_object('channel', 'without_email', 'pdfStoredInDatabase', v_base64 is not null, 'pdfStorageProvider', v_provider, 'pdfStorageKeyPresent', v_key is not null)
  );

  update public.invoice_versions
     set pdf_data_base64 = coalesce(v_base64, pdf_data_base64),
         pdf_storage_provider = coalesce(v_provider, case when v_base64 is not null then 'database' else pdf_storage_provider end),
         pdf_storage_key = coalesce(v_key, case when v_base64 is not null then 'invoice_versions/' || v_version.id::text || '.pdf.base64' else pdf_storage_key end)
   where id = v_version.id
   returning * into v_version;

  perform public.insert_invoice_workflow_event(
    p_organization_id, p_invoice_id, 'sent_to_client',
    'Factuur uitgegeven zonder mail',
    'De factuur is uitgegeven zonder mail vanuit ResoFly (zelf gemaild, geprint of anders bezorgd). De pdf is vastgelegd en de factuur is vergrendeld.',
    jsonb_build_object('channel', 'without_email', 'version_id', v_version.id, 'storage_provider', v_version.pdf_storage_provider),
    p_actor_user_id
  );

  insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
  values (p_organization_id, p_actor_user_id, 'invoice_sent_to_client', 'invoice', v_invoice.id, v_invoice.number,
          jsonb_build_object('channel', 'without_email', 'version_id', v_version.id));

  return jsonb_build_object('invoice', to_jsonb(v_invoice) - 'public_token_hash', 'version', to_jsonb(v_version) - 'pdf_data_base64');
end;
$function$;

revoke all on function public.issue_invoice_without_email(uuid, uuid, uuid, text, text, integer, text, text, text, text) from public, anon, authenticated;
grant execute on function public.issue_invoice_without_email(uuid, uuid, uuid, text, text, integer, text, text, text, text) to service_role;

commit;
