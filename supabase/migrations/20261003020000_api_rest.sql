-- ============================================================
-- ResoFly — Openbare API fase 3: vaste adressen voor klanten, contactpersonen,
-- projecten, taken, tickets, reacties en uren
-- Date: 2026-10-03
--
-- Aanleiding:
-- Met /v1/actions (20261003000000) kan een koppeling alles wat de app kan. Met
-- /v1/clients, /v1/projects, /v1/tasks enzovoort krijgt ze daarnaast vaste
-- adressen met een vaste vorm — wat een webshop of een stap "Create client" in
-- Zapier verwacht. Lezen doet de functie `api` met de service-role en de
-- organisatie uit de sleutel als filter (dat is precies wat RLS voor deze
-- tabellen vraagt: lid zijn + de module mogen lezen). Voor SCHRIJVEN staat hier
-- één functie: api_rest_write.
--
-- WAAROM IN DE DATABASE, EN WAAROM ALS HET TEAMLID
-- De app schrijft deze tabellen onder de sessie van een teamlid. RLS beslist of
-- het mag (schrijfrecht in de organisatie én in de module, via de "module
-- gate"-policies), triggers vullen en bewaken (klantnummers, dezelfde-
-- organisatie-controles), en audit_logs zet de wijziging op naam van dat
-- teamlid. Met de service-role valt dat allemaal weg, of moet het worden
-- nagebouwd — en nagebouwde regels lopen stil uit de pas.
--
-- Daarom wisselt api_rest_write binnen de transactie naar het teamlid achter de
-- API-sleutel — dezelfde wissel die PostgREST maakt voor een ingelogde
-- gebruiker (rol `authenticated`, met diens id in de claims) — en schrijft dan.
-- De regels zijn daarmee niet "dezelfde als die van de app": het zijn die van de
-- app.
--
-- WIE HEM MAG AANROEPEN
-- Alleen de service role, dus de functie `api`. Die controleert eerst de
-- sleutel, het toegangsniveau (`execute`), de modulerechten van sleutel en
-- teamlid, en de invoer (apiResourceSpecs.ts). Hier wordt bovendien nagekeken
-- dat het teamlid nu actief lid is, dat de resource bestaat, en dat de invoer
-- geen kolom raakt die nooit van buiten mag komen.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

create or replace function public.api_rest_write(
  p_user_id uuid,
  p_organization_id uuid,
  p_resource text,
  p_values jsonb,
  p_row_id uuid default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_table text;
  v_server_only text[];
  v_create_only text[];
  v_keys text[];
  v_bad text[];
  v_cols text;
  v_exists boolean;
  v_project uuid;
  v_row jsonb;
begin
  -- 1. Alleen de API. Straks wisselen we naar het teamlid; deze controle hoort
  --    dus vóór die wissel.
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de API kan dit aanroepen.' using errcode = '42501';
  end if;

  v_table := case p_resource
    when 'clients'      then 'clients'
    when 'contacts'     then 'client_contacts'
    when 'projects'     then 'projects'
    when 'tasks'        then 'tasks'
    when 'tickets'      then 'tickets'
    when 'ticket_notes' then 'ticket_notes'
    when 'time_entries' then 'time_entries'
  end;
  if v_table is null then
    raise exception 'Onbekende resource "%".', p_resource using errcode = '22023';
  end if;

  -- Kolommen die de app zelf beheert, per resource — gelijk aan de velden die
  -- in apiResourceSpecs.ts alleen-lezen zijn (apiResourceSpecs.test.ts legt ze
  -- naast elkaar). Klantnummers kent de app toe, portaaltoegang geef je in de
  -- app, de schrijver van een reactie en de eigenaar van uren is het teamlid.
  v_server_only := case p_resource
    when 'clients'      then array['client_code']
    when 'contacts'     then array['gives_portal_access', 'origin']
    when 'projects'     then array['contract_id']
    when 'tasks'        then array['ticket_id', 'planned_order', 'subtasks', 'comments']
    when 'tickets'      then array['converted_to_project_id', 'created_by_contact_id', 'created_by_name', 'created_by_email']
    when 'ticket_notes' then array['author_type', 'author_user_id', 'author_name', 'author_client_contact_id']
    when 'time_entries' then array['user_id', 'source', 'calendar_event_link_id']
  end;
  -- Alleen bij aanmaken: een contactpersoon verhuist niet naar een andere klant.
  v_create_only := case p_resource
    when 'contacts' then array['client_id']
    else array[]::text[]
  end;

  -- Een reactie wijzig je in de app (zichtbaar maken voor de klant is daar een
  -- bewuste stap); via de API komt er alleen een nieuwe bij.
  if p_row_id is not null and p_resource = 'ticket_notes' then
    raise exception 'Een reactie wijzig je in de app; via de API kun je er alleen een toevoegen.' using errcode = '22023';
  end if;
  if p_values is null or jsonb_typeof(p_values) <> 'object' then
    raise exception 'De invoer moet een object zijn.' using errcode = '22023';
  end if;

  select coalesce(array_agg(k order by k), array[]::text[]) into v_keys
    from jsonb_object_keys(p_values) as k;

  -- 2. Wat nooit van buiten komt: de grens van de organisatie, wie en wanneer,
  --    alles wat op een geheim lijkt, en kolommen die niet bestaan.
  select coalesce(array_agg(k order by k), array[]::text[]) into v_bad
    from unnest(v_keys) as k
   where k in ('id', 'organization_id', 'created_by', 'created_at', 'updated_at')
      or k = any(v_server_only)
      or (p_row_id is not null and k = any(v_create_only))
      or public.webhook_is_secret_column(k)
      or not exists (
        select 1 from pg_attribute a
         where a.attrelid = format('public.%I', v_table)::regclass
           and a.attname = k and a.attnum > 0 and not a.attisdropped
      );
  if cardinality(v_bad) > 0 then
    raise exception 'Deze velden kunnen niet via de API: %.', array_to_string(v_bad, ', ') using errcode = '22023';
  end if;
  if p_row_id is not null and cardinality(v_keys) = 0 then
    raise exception 'Er valt niets te wijzigen.' using errcode = '22023';
  end if;

  -- 3. Het teamlid achter de sleutel is NU actief lid van deze organisatie.
  if not exists (
    select 1 from public.organization_members m
     where m.organization_id = p_organization_id and m.user_id = p_user_id and m.status = 'active'
  ) then
    raise exception 'Het teamlid achter deze sleutel is geen actief lid van de organisatie.' using errcode = '42501';
  end if;

  -- Bij wijzigen: bestaat de rij in deze organisatie? Nu nog als service role
  -- gevraagd, zodat "bestaat niet" (404) en "mag niet" (403) uit elkaar blijven.
  if p_row_id is not null then
    execute format('select exists (select 1 from public.%I where id = $1 and organization_id = $2)', v_table)
      into v_exists using p_row_id, p_organization_id;
    if not v_exists then
      raise exception 'Niet gevonden in deze organisatie.' using errcode = 'P0002';
    end if;
  end if;

  -- ── Per resource: wat de app er bij aanmaken of wijzigen zelf bij doet ────

  -- Uren uit de agenda volgen hun afspraak (sync_time_entry_from_link); de app
  -- laat ze niet los bewerken, de API dus ook niet.
  if p_row_id is not null and p_resource = 'time_entries' and exists (
    select 1 from public.time_entries te
     where te.id = p_row_id and te.organization_id = p_organization_id and te.source = 'calendar'
  ) then
    raise exception 'Deze uren komen uit de agenda en volgen die afspraak. Wijzig de afspraak in de agenda.' using errcode = '22023';
  end if;

  -- Nieuwe uren: wat de app invult als je het niet zelf kiest (TimeTracking en
  -- Gerrie): vandaag in Nederlandse tijd, declarabel tenzij het project een vaste
  -- prijs heeft of de uren indirect zijn, en het tarief van het project of
  -- anders het standaardtarief van de organisatie — als momentopname.
  if p_row_id is null and p_resource = 'time_entries' then
    v_project := nullif(p_values ->> 'project_id', '')::uuid;
    if v_project is null and nullif(p_values ->> 'task_id', '') is not null then
      select t.project_id into v_project from public.tasks t
       where t.id = (p_values ->> 'task_id')::uuid and t.organization_id = p_organization_id;
    end if;
    if not (p_values ? 'entry_date') then
      p_values := p_values || jsonb_build_object('entry_date', (now() at time zone 'Europe/Amsterdam')::date);
    end if;
    if not (p_values ? 'billable') then
      p_values := p_values || jsonb_build_object('billable',
        coalesce(p_values ->> 'entry_type', 'direct') <> 'indirect'
        and not exists (
          select 1 from public.projects pr
           where pr.id = v_project and pr.organization_id = p_organization_id and pr.billing_type = 'fixed_price'
        ));
    end if;
    if not (p_values ? 'hourly_rate_cents') then
      p_values := p_values || jsonb_build_object('hourly_rate_cents', coalesce(
        (select pr.hourly_rate_cents from public.projects pr where pr.id = v_project and pr.organization_id = p_organization_id),
        (select cs.default_hourly_rate_cents from public.company_settings cs where cs.organization_id = p_organization_id)));
    end if;
    p_values := p_values || jsonb_build_object('user_id', p_user_id, 'source', 'manual');
  end if;

  -- Een nieuwe reactie: het ticket hoort bij deze organisatie (daar is geen
  -- databasecontrole voor), en de schrijver is het teamlid — met zijn
  -- e-mailadres als momentopname, net als createTicketNote in de app.
  if p_row_id is null and p_resource = 'ticket_notes' then
    if not exists (
      select 1 from public.tickets tk
       where tk.id = nullif(p_values ->> 'ticket_id', '')::uuid and tk.organization_id = p_organization_id
    ) then
      raise exception 'Ticket niet gevonden in deze organisatie.' using errcode = 'P0002';
    end if;
    p_values := p_values || jsonb_build_object(
      'author_type', 'user',
      'author_user_id', p_user_id,
      'author_name', (
        select m.email from public.organization_members m
         where m.organization_id = p_organization_id and m.user_id = p_user_id
      ));
  end if;

  -- 4. Vanaf hier: als het teamlid. Dezelfde wissel als PostgREST voor een
  --    ingelogde gebruiker; hij geldt tot het einde van deze transactie.
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user_id, 'role', 'authenticated', 'aud', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  -- Een nieuwe klant gaat langs dezelfde weg als in de app: het klantnummer,
  -- de dubbelcontrole en de normalisatie zitten in create_client_with_next_code.
  if p_row_id is null and p_resource = 'clients' then
    select to_jsonb(c) into v_row from public.create_client_with_next_code(p_organization_id, p_values) as c;
    return v_row;
  end if;

  v_cols := (select string_agg(format('%I', k), ', ' order by k) from jsonb_object_keys(p_values) as k);

  if p_row_id is null then
    execute format(
      'insert into public.%1$I as t (organization_id, created_by%2$s) '
      || 'select $1, $2%2$s from jsonb_populate_record(null::public.%1$I, $3) '
      || 'returning to_jsonb(t.*)',
      v_table, case when v_cols is null then '' else ', ' || v_cols end)
      into v_row using p_organization_id, p_user_id, p_values;
  else
    execute format(
      'update public.%1$I as t set (%2$s, updated_at) = '
      || '(select %2$s, now() from jsonb_populate_record(null::public.%1$I, $1)) '
      || 'where t.id = $2 and t.organization_id = $3 '
      || 'returning to_jsonb(t.*)',
      v_table, v_cols)
      into v_row using p_values, p_row_id, p_organization_id;
    -- De rij bestaat (zie boven), maar RLS liet hem niet bijwerken.
    if v_row is null then
      raise exception 'Het teamlid achter deze sleutel mag dit niet wijzigen.' using errcode = '42501';
    end if;
  end if;

  return v_row;
end;
$$;

revoke all on function public.api_rest_write(uuid, uuid, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.api_rest_write(uuid, uuid, text, jsonb, uuid) to service_role;

commit;
