-- ============================================================
-- ResoFly — Volledige API-controle: wat er nog openstond
-- Date: 2026-10-03
--
-- Uit de volledige controle van functies en veiligheid van de openbare API:
--
--   1. HET KLANTPORTAAL. Een voorwerp naar een andere klant verhuizen vroeg al
--      `execute_high`, maar iets NIEUWS voor een klant aanmaken niet. Een
--      sleutel met gewoon uitvoerrecht kon zo een ticket met een vals
--      rekeningnummer in het portaal van een klant zetten. Nu vraagt alles wat
--      tekst in het portaal van een klant zet of verandert `execute_high`:
--      een ticket of project mét klant aanmaken, de titel of omschrijving
--      daarvan wijzigen, een taak in (of uit) een project van een klant zetten
--      of hernoemen, en een klant aanmaken met het adres van iemand die al op
--      het portaal inlogt.
--   2. BESLISSEN. ai_action_decide is de weg die een voorstel afhandelt mét de
--      regels: wie beslist, eerst vastzetten, en een naam erbij. De
--      Beslissingen-feed (ai_decision_resolve, ai_decision_mute) zette de
--      auditregel nog zelf om. Nu:
--        - een kaart uit de feed volgt in ai_action_decide dezelfde regel als de
--          feed zelf: wie de module van de kaart mag schrijven, beslist;
--        - de feed beslist niet over een lopende uitvoering van een ander heen,
--          en legt vast wie besliste;
--        - wie een voorstel vastzet waarvan een eerdere uitvoering nooit een
--          uitkomst meldde, hoort dat (`stale_claim`): misschien is het al gebeurd.
--   3. INGETROKKEN SLEUTELS. Intrekken annuleerde alleen wat nog op 'proposed'
--      stond; een mislukte uitvoering die opnieuw mocht, bleef open. Nu gaat ook
--      die dicht, en zet niemand een voorstel van een ingetrokken sleutel nog
--      vast. Wie het op dat moment uitvoert, maakt het af.
--   4. Een auditregel hoort bij de organisatie van zijn sleutel — ook een
--      rechtstreekse uitvoering.
--   5. Eén bovengrens voor ALLE mislukte sleutels samen. De telling per afzender
--      leunt op headers; wie die vervalst, ontloopt hem. Een tweede teller over
--      alle afzenders begrenst wat dat kost. Een geldige sleutel merkt er niets van.
--   6. Kleinere dingen: een reactie zonder `is_internal` is intern (zoals de
--      controle al aannam), en een taak met een klant die niet bij het project
--      hoort, geeft een fout in plaats van een stille correctie.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1 + 6. api_rest_write ───────────────────────────────────────────────────
--
-- Dezelfde functie als in 20261003030000, met de regels hierboven erbij. De
-- oude vijf-parameterversie (zonder portaalregels) blijft weg.
drop function if exists public.api_rest_write(uuid, uuid, text, jsonb, uuid);

create or replace function public.api_rest_write(
  p_user_id uuid,
  p_organization_id uuid,
  p_resource text,
  p_values jsonb,
  p_row_id uuid default null,
  p_allow_outward boolean default false
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
  v_existing jsonb;
  v_project uuid;
  v_task uuid;
  v_client uuid;
  v_task_project uuid;
  v_project_client uuid;
  v_old_portal_client uuid;
  v_new_portal_client uuid;
  v_start timestamptz;
  v_end timestamptz;
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

  -- Bij wijzigen: de rij zoals hij nu is, in deze organisatie. Nu nog als
  -- service role gelezen, zodat "bestaat niet" (404) en "mag niet" (403) uit
  -- elkaar blijven, en de regels hieronder het verschil kunnen zien.
  if p_row_id is not null then
    execute format('select to_jsonb(t) from public.%I t where t.id = $1 and t.organization_id = $2', v_table)
      into v_existing using p_row_id, p_organization_id;
    if v_existing is null then
      raise exception 'Niet gevonden in deze organisatie.' using errcode = 'P0002';
    end if;
  end if;

  -- Een nieuwe reactie zonder `is_internal` is intern: de kolom zelf staat op
  -- "zichtbaar", en de regel hieronder neemt aan dat weglaten intern betekent.
  if p_row_id is null and p_resource = 'ticket_notes' then
    p_values := jsonb_build_object('is_internal', true) || p_values;
  end if;

  -- ── Wat het klantportaal raakt: alleen met `execute_high` ────────────────
  --
  -- Wie in het portaal kan, volgt uit het e-mailadres van de klant en uit
  -- contactpersonen met portaaltoegang; wat ze daar zien, uit de klant waaraan
  -- projecten (met hun taken), tickets en facturen hangen — met titel en
  -- omschrijving (client-portal: sanitizeProject/Ticket/Task). Iets daarin
  -- zetten of veranderen is net zo goed "naar buiten" als een bericht aan de klant.
  if not coalesce(p_allow_outward, false) then
    if p_row_id is not null and p_resource = 'clients' and p_values ? 'email'
       and lower(coalesce(p_values ->> 'email', '')) is distinct from lower(coalesce(v_existing ->> 'email', '')) then
      raise exception 'Het e-mailadres van een klant bepaalt wie in het klantportaal kan. Wijzigen via de API vraagt toegangsniveau "execute_high".'
        using errcode = 'RS403';
    end if;
    -- Een nieuwe klant met het adres van iemand die al op het portaal inlogt,
    -- verschijnt in diens portaal. (Hetzelfde adres als een andere KLANT houdt
    -- create_client_with_next_code al tegen.)
    if p_row_id is null and p_resource = 'clients' and nullif(btrim(coalesce(p_values ->> 'email', '')), '') is not null
       and exists (
         select 1 from public.client_contacts cc
          where cc.organization_id = p_organization_id and cc.gives_portal_access and cc.is_active
            and public.normalize_client_lookup_value(cc.email) = public.normalize_client_lookup_value(p_values ->> 'email')
       ) then
      raise exception 'Met dit e-mailadres logt al iemand in op het klantportaal; een nieuwe klant ermee verschijnt in diens portaal. Dat vraagt toegangsniveau "execute_high".'
        using errcode = 'RS403';
    end if;
    if p_row_id is not null and p_resource = 'contacts' and coalesce((v_existing ->> 'gives_portal_access')::boolean, false)
       and ((p_values ? 'email' and lower(coalesce(p_values ->> 'email', '')) is distinct from lower(coalesce(v_existing ->> 'email', '')))
         or (coalesce((p_values ->> 'is_active')::boolean, false) and not coalesce((v_existing ->> 'is_active')::boolean, false))) then
      raise exception 'Deze contactpersoon heeft toegang tot het klantportaal. Zijn e-mailadres wijzigen of hem weer actief maken vraagt toegangsniveau "execute_high".'
        using errcode = 'RS403';
    end if;
    if p_row_id is not null and p_resource in ('projects', 'tickets') and p_values ? 'client_id'
       and nullif(p_values ->> 'client_id', '') is distinct from nullif(v_existing ->> 'client_id', '') then
      raise exception 'Een % naar een andere klant verhuizen verandert wat die klant in het portaal ziet. Dat vraagt toegangsniveau "execute_high".',
        case p_resource when 'projects' then 'project' else 'ticket' end
        using errcode = 'RS403';
    end if;
    if p_row_id is null and p_resource in ('projects', 'tickets') and nullif(p_values ->> 'client_id', '') is not null then
      raise exception 'Een % voor een klant staat meteen in diens klantportaal. Aanmaken mét klant vraagt toegangsniveau "execute_high"; zonder klant kan het wel.',
        case p_resource when 'projects' then 'project' else 'ticket' end
        using errcode = 'RS403';
    end if;
    if p_row_id is not null and p_resource = 'tickets' and nullif(v_existing ->> 'client_id', '') is not null
       and ((p_values ? 'title' and p_values ->> 'title' is distinct from v_existing ->> 'title')
         or (p_values ? 'description' and p_values ->> 'description' is distinct from v_existing ->> 'description')) then
      raise exception 'De klant ziet dit ticket in het portaal. De titel of omschrijving wijzigen vraagt toegangsniveau "execute_high".'
        using errcode = 'RS403';
    end if;
    if p_row_id is not null and p_resource = 'projects' and nullif(v_existing ->> 'client_id', '') is not null
       and ((p_values ? 'name' and p_values ->> 'name' is distinct from v_existing ->> 'name')
         or (p_values ? 'description' and p_values ->> 'description' is distinct from v_existing ->> 'description')) then
      raise exception 'De klant ziet dit project in het portaal. De naam of omschrijving wijzigen vraagt toegangsniveau "execute_high".'
        using errcode = 'RS403';
    end if;
    if p_resource = 'tasks' then
      -- Het project van de taak vóór en ná dit verzoek, en of daar een klant aan hangt.
      select pr.client_id into v_old_portal_client from public.projects pr
       where pr.id = nullif(v_existing ->> 'project_id', '')::uuid and pr.organization_id = p_organization_id;
      select pr.client_id into v_new_portal_client from public.projects pr
       where pr.id = case when p_values ? 'project_id' then nullif(p_values ->> 'project_id', '')::uuid
                          else nullif(v_existing ->> 'project_id', '')::uuid end
         and pr.organization_id = p_organization_id;
      if (p_row_id is null and v_new_portal_client is not null)
         or (p_row_id is not null and p_values ? 'project_id'
             and nullif(p_values ->> 'project_id', '') is distinct from nullif(v_existing ->> 'project_id', '')
             and (v_old_portal_client is not null or v_new_portal_client is not null))
         or (p_row_id is not null and v_new_portal_client is not null
             and p_values ? 'title' and p_values ->> 'title' is distinct from v_existing ->> 'title') then
        raise exception 'Taken in een project met een klant staan in diens klantportaal. Zo''n taak aanmaken, verplaatsen of hernoemen vraagt toegangsniveau "execute_high".'
          using errcode = 'RS403';
      end if;
    end if;
    if p_row_id is null and p_resource = 'ticket_notes'
       and not coalesce((p_values ->> 'is_internal')::boolean, true) then
      raise exception 'Een reactie die de klant in het portaal ziet, is een bericht naar buiten. Dat vraagt toegangsniveau "execute_high"; zonder blijft hij intern.'
        using errcode = 'RS403';
    end if;
  end if;

  -- ── Per resource: wat de app er bij aanmaken of wijzigen zelf bij doet ────

  -- Een taak met een klant die niet bij zijn project hoort: de app (trigger)
  -- zou de klant stil vervangen door die van het project. Liever een fout,
  -- net als bij uren.
  if p_resource = 'tasks' and nullif(p_values ->> 'client_id', '') is not null then
    select pr.client_id into v_project_client from public.projects pr
     where pr.id = case when p_values ? 'project_id' then nullif(p_values ->> 'project_id', '')::uuid
                        else nullif(v_existing ->> 'project_id', '')::uuid end
       and pr.organization_id = p_organization_id;
    if v_project_client is not null and v_project_client <> (p_values ->> 'client_id')::uuid then
      raise exception '"client_id" hoort niet bij het project: dat is van een andere klant. Laat client_id weg; de klant volgt het project.'
        using errcode = '22023';
    end if;
    v_project_client := null;
  end if;

  -- Uren uit de agenda volgen hun afspraak (sync_time_entry_from_link); de app
  -- laat ze niet los bewerken, de API dus ook niet.
  if p_row_id is not null and p_resource = 'time_entries' and v_existing ->> 'source' = 'calendar' then
    raise exception 'Deze uren komen uit de agenda en volgen die afspraak. Wijzig de afspraak in de agenda.' using errcode = '22023';
  end if;

  if p_resource = 'time_entries' then
    -- Taak, project en klant zoals ze na deze wijziging zijn.
    v_task := case when p_values ? 'task_id' then nullif(p_values ->> 'task_id', '')::uuid else nullif(v_existing ->> 'task_id', '')::uuid end;
    v_project := case when p_values ? 'project_id' then nullif(p_values ->> 'project_id', '')::uuid else nullif(v_existing ->> 'project_id', '')::uuid end;
    v_client := case when p_values ? 'client_id' then nullif(p_values ->> 'client_id', '')::uuid else nullif(v_existing ->> 'client_id', '')::uuid end;

    -- Het project van de taak gaat voor — zo zet validate_time_entry het ook.
    -- Wie in hetzelfde verzoek een ánder project noemt, hoort dat, in plaats
    -- van een stille correctie (met het tarief van het verkeerde project).
    if v_task is not null then
      select t.project_id into v_task_project from public.tasks t
       where t.id = v_task and t.organization_id = p_organization_id;
      if p_values ? 'project_id' and v_project is distinct from v_task_project then
        raise exception '"project_id" hoort niet bij de taak: die valt onder een ander project. Laat project_id weg of kies het project van de taak.'
          using errcode = '22023';
      end if;
      v_project := v_task_project;
    end if;

    if v_project is not null and v_client is not null and (p_values ? 'client_id' or p_values ? 'project_id' or p_values ? 'task_id') then
      select pr.client_id into v_project_client from public.projects pr
       where pr.id = v_project and pr.organization_id = p_organization_id;
      if v_project_client is not null and v_project_client <> v_client then
        raise exception '"client_id" hoort niet bij het project: dat is van een andere klant. Laat client_id weg; de klant volgt het project.'
          using errcode = '22023';
      end if;
    end if;

    -- De eindtijd ligt niet vóór de begintijd — ook als maar één van de twee
    -- in dit verzoek staat.
    v_start := case when p_values ? 'started_at' then nullif(p_values ->> 'started_at', '')::timestamptz else nullif(v_existing ->> 'started_at', '')::timestamptz end;
    v_end := case when p_values ? 'ended_at' then nullif(p_values ->> 'ended_at', '')::timestamptz else nullif(v_existing ->> 'ended_at', '')::timestamptz end;
    if v_start is not null and v_end is not null and v_end < v_start then
      raise exception '"ended_at" ligt op of na "started_at".' using errcode = '22023';
    end if;
  end if;

  -- Nieuwe uren: wat de app invult als je het niet zelf kiest (TimeTracking en
  -- Gerrie): vandaag in Nederlandse tijd, declarabel tenzij het project een vaste
  -- prijs heeft of de uren indirect zijn, en het tarief van het project of
  -- anders het standaardtarief van de organisatie — als momentopname. Het
  -- project is hier dat van de taak, als er een taak is.
  if p_row_id is null and p_resource = 'time_entries' then
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

  -- Een nieuwe reactie: het ticket hoort bij deze organisatie, en de schrijver
  -- is het teamlid — met zijn e-mailadres als momentopname, net als
  -- createTicketNote in de app.
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

revoke all on function public.api_rest_write(uuid, uuid, text, jsonb, uuid, boolean) from public, anon, authenticated;
grant execute on function public.api_rest_write(uuid, uuid, text, jsonb, uuid, boolean) to service_role;

-- ── 2a. ai_action_decide ────────────────────────────────────────────────────
--
-- Zoals in 20261003040000, met:
--   - een kaart uit de Beslissingen-feed (een voorstel van een signaal): een
--     teamlid beslist als hij Gerrie mag gebruiken en de module van de kaart mag
--     schrijven — dezelfde regel als ai_decision_resolve;
--   - geen nieuwe claim op een voorstel van een ingetrokken API-sleutel;
--   - `stale_claim` bij het vastzetten als een eerdere claim afliep zonder
--     uitkomst: misschien is het al uitgevoerd, en de app vraagt dat eerst na.
create or replace function public.ai_action_decide(
  p_audit_id uuid,
  p_organization_id uuid,
  p_user_id uuid,
  p_outcome text,
  p_detail text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_row      public.ai_action_audit%rowtype;
  v_role     text;
  v_access   jsonb;
  v_module   text;
  v_outcome  text := p_outcome;
  v_claimer  uuid;
  v_until    timestamptz;
  v_detail   text;
  v_status   text;
  v_revoked  timestamptz;
  v_rejected constant text := 'Afgewezen door gebruiker.';
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de server legt een beslissing vast.' using errcode = '42501';
  end if;
  if v_outcome is null or v_outcome not in ('claim', 'executed', 'failed', 'rejected') then
    raise exception 'Onbekende uitkomst: %.', coalesce(v_outcome, 'leeg') using errcode = '22023';
  end if;

  v_detail := nullif(btrim(left(regexp_replace(coalesce(p_detail, ''), '[[:cntrl:]]', ' ', 'g'), 500)), '');
  -- Een oudere app meldt een afwijzing als "mislukt" met deze zin.
  if v_outcome = 'failed' and v_detail = v_rejected then v_outcome := 'rejected'; end if;

  select m.role, coalesce(m.module_access, '{}'::jsonb) into v_role, v_access
    from public.organization_members m
   where m.organization_id = p_organization_id and m.user_id = p_user_id and m.status = 'active';
  if v_role is null or v_role not in ('owner', 'admin', 'member') then
    raise exception 'Je hebt geen schrijfrechten in deze organisatie.' using errcode = '42501';
  end if;

  select * into v_row
    from public.ai_action_audit
   where id = p_audit_id and organization_id = p_organization_id
   for update;
  if not found then
    raise exception 'Dit voorstel bestaat niet in deze organisatie.' using errcode = 'P0002';
  end if;

  if v_role not in ('owner', 'admin') then
    if v_row.signal_id is not null and v_row.agent_id is null and v_row.agent_run_id is null
       and v_row.mcp_grant_id is null and v_row.api_key_id is null then
      -- Een kaart uit de Beslissingen-feed: dezelfde regel als de feed zelf.
      select d.module into v_module
        from public.ai_decisions d
       where d.audit_id = v_row.id and d.organization_id = p_organization_id
       order by d.created_at desc
       limit 1;
      if v_module is null
         or coalesce(nullif(v_access ->> 'gerrie', ''), 'write') = 'none'
         or coalesce(nullif(v_access ->> v_module, ''), 'write') <> 'write' then
        raise exception 'Over dit voorstel beslist wie de module van de kaart mag wijzigen, of een owner of admin.'
          using errcode = '42501';
      end if;
    elsif v_row.agent_id is not null or v_row.agent_run_id is not null or v_row.mcp_grant_id is not null
          or v_row.api_key_id is not null or v_row.signal_id is not null
          or v_row.user_id is distinct from p_user_id then
      raise exception 'Over dit voorstel beslist een owner of admin.' using errcode = '42501';
    end if;
  end if;

  if not (v_row.status = 'proposed'
          or (v_row.status = 'failed' and coalesce(v_row.result ->> 'decision', '') = 'failed')) then
    raise exception 'Dit voorstel is al afgehandeld.' using errcode = 'RS409';
  end if;

  v_claimer := nullif(v_row.result ->> 'claimed_by', '')::uuid;
  v_until := nullif(v_row.result ->> 'claimed_until', '')::timestamptz;
  if v_claimer is not null and v_claimer <> p_user_id and v_until > now() then
    raise exception 'Iemand anders voert dit voorstel op dit moment uit. Probeer het over een paar minuten opnieuw.'
      using errcode = 'RS409';
  end if;

  if v_outcome = 'claim' then
    -- Een voorstel van een ingetrokken sleutel voert niemand meer uit. Afwijzen
    -- mag wel, en wie het al uitvoerde, meldt zijn uitkomst gewoon.
    if v_row.api_key_id is not null then
      select k.revoked_at into v_revoked from public.api_keys k where k.id = v_row.api_key_id;
      if v_revoked is not null then
        raise exception 'De API-sleutel achter dit voorstel is ingetrokken; het wordt niet meer uitgevoerd.'
          using errcode = 'RS409';
      end if;
    end if;
    update public.ai_action_audit
       set result = coalesce(result, '{}'::jsonb)
                 || jsonb_build_object('claimed_by', p_user_id, 'claimed_until', now() + interval '10 minutes')
     where id = v_row.id;
    return jsonb_build_object('status', v_row.status, 'claimed_until', now() + interval '10 minutes')
      || case when v_claimer is not null and v_until <= now()
              then jsonb_build_object('stale_claim', jsonb_build_object('by', v_claimer, 'until', v_until))
              else '{}'::jsonb end;
  end if;

  v_status := case when v_outcome = 'executed' then 'executed' else 'failed' end;
  update public.ai_action_audit
     set status = v_status,
         result = (coalesce(result, '{}'::jsonb) - 'claimed_by' - 'claimed_until' - 'detail' - 'ok')
               || jsonb_build_object('ok', v_outcome = 'executed', 'decision', v_outcome,
                                     'decided_by', p_user_id, 'decided_at', now())
               || case
                    when v_outcome = 'rejected' then jsonb_build_object('detail', v_rejected)
                    when v_detail is not null then jsonb_build_object('detail', v_detail)
                    else '{}'::jsonb
                  end
   where id = v_row.id;
  return jsonb_build_object('status', v_status, 'decision', v_outcome);
end;
$$;

revoke all on function public.ai_action_decide(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.ai_action_decide(uuid, uuid, uuid, text, text) to service_role;

-- ── 2b. De Beslissingen-feed: niet over een lopende uitvoering heen ─────────
--
-- Zoals in 20260914000000, maar het voorstel achter de kaart gaat alleen dicht
-- als niemand anders het op dit moment uitvoert, en met wie besliste erbij.
-- Ook een mislukte uitvoering die opnieuw mocht, telt als open.
create or replace function public.ai_decision_resolve(
  p_id uuid, p_status text, p_snoozed_until timestamptz default null, p_resolution text default null
) returns public.ai_decisions
language plpgsql
security definer
set search_path = public
as $$
declare
  d public.ai_decisions%rowtype;
  a public.ai_action_audit%rowtype;
  v_claimer uuid;
  v_until timestamptz;
begin
  if auth.uid() is null then raise exception 'Niet ingelogd.' using errcode = '42501'; end if;
  select * into d from public.ai_decisions where id = p_id for update;
  if not found then raise exception 'Kaart niet gevonden.' using errcode = 'P0002'; end if;
  if not (public.can_read_org(d.organization_id) and public.can_read_module(d.organization_id, 'gerrie')
          and public.can_write_module(d.organization_id, d.module)) then
    raise exception 'Je hebt geen schrijfrechten voor deze kaart.' using errcode = '42501';
  end if;
  if p_status not in ('open','snoozed','done','dismissed') then
    raise exception 'Onbekende status: %', p_status using errcode = '22023';
  end if;
  if p_status = 'snoozed' and p_snoozed_until is null then
    raise exception 'Geef een moment waarop de kaart terugkomt.' using errcode = '22023';
  end if;

  if d.audit_id is not null and p_status in ('done', 'dismissed') then
    select * into a from public.ai_action_audit where id = d.audit_id and organization_id = d.organization_id for update;
    if found and (a.status = 'proposed'
                  or (a.status = 'failed' and coalesce(a.result ->> 'decision', '') = 'failed')) then
      v_claimer := nullif(a.result ->> 'claimed_by', '')::uuid;
      v_until := nullif(a.result ->> 'claimed_until', '')::timestamptz;
      if v_claimer is not null and v_claimer <> auth.uid() and v_until > now() then
        raise exception 'Iemand anders voert dit voorstel op dit moment uit. Probeer het over een paar minuten opnieuw.'
          using errcode = 'RS409';
      end if;
      update public.ai_action_audit
         set status = case when p_status = 'done' then 'executed' else 'cancelled' end,
             result = (coalesce(result, '{}'::jsonb) - 'claimed_by' - 'claimed_until')
                   || jsonb_build_object('decision', case when p_status = 'done' then 'executed' else 'rejected' end,
                                         'decided_by', auth.uid(), 'decided_at', now())
       where id = a.id;
    end if;
  end if;

  update public.ai_decisions
     set status = p_status,
         snoozed_until = case when p_status = 'snoozed' then p_snoozed_until else null end,
         resolved_by = case when p_status in ('done','dismissed') then auth.uid() else null end,
         resolved_at = case when p_status in ('done','dismissed') then now() else null end,
         resolution = left(p_resolution, 200)
   where id = p_id
   returning * into d;
  return d;
end;
$$;
revoke execute on function public.ai_decision_resolve(uuid, text, timestamptz, text) from public, anon;
grant execute on function public.ai_decision_resolve(uuid, text, timestamptz, text) to authenticated, service_role;

create or replace function public.ai_decision_mute(p_decision_id uuid, p_scope text, p_until timestamptz default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare d public.ai_decisions%rowtype;
begin
  if auth.uid() is null then raise exception 'Niet ingelogd.' using errcode = '42501'; end if;
  select * into d from public.ai_decisions where id = p_decision_id;
  if not found then raise exception 'Kaart niet gevonden.' using errcode = 'P0002'; end if;
  if not (public.can_read_org(d.organization_id) and public.can_read_module(d.organization_id, 'gerrie')
          and public.can_write_module(d.organization_id, d.module)) then
    raise exception 'Je hebt geen schrijfrechten voor deze kaart.' using errcode = '42501';
  end if;
  if p_scope = 'kind' then
    insert into public.ai_decision_mutes (organization_id, scope, kind, until, created_by)
    values (d.organization_id, 'kind', d.kind, p_until, auth.uid())
    on conflict (organization_id, scope, coalesce(kind, ''), coalesce(entity_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid))
    do update set until = excluded.until, created_by = excluded.created_by, created_at = now();
    update public.ai_decisions set status = 'dismissed', resolved_by = auth.uid(), resolved_at = now(), resolution = 'muted:kind'
     where organization_id = d.organization_id and kind = d.kind and status in ('open','snoozed');
  elsif p_scope = 'client' then
    if d.client_id is null then raise exception 'Deze kaart hoort niet bij een klant.' using errcode = '22023'; end if;
    insert into public.ai_decision_mutes (organization_id, scope, client_id, until, created_by)
    values (d.organization_id, 'client', d.client_id, p_until, auth.uid())
    on conflict (organization_id, scope, coalesce(kind, ''), coalesce(entity_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid))
    do update set until = excluded.until, created_by = excluded.created_by, created_at = now();
    update public.ai_decisions set status = 'dismissed', resolved_by = auth.uid(), resolved_at = now(), resolution = 'muted:client'
     where organization_id = d.organization_id and client_id = d.client_id and status in ('open','snoozed');
  elsif p_scope = 'entity' then
    if d.entity_id is null then raise exception 'Deze kaart hoort niet bij een item.' using errcode = '22023'; end if;
    insert into public.ai_decision_mutes (organization_id, scope, entity_type, entity_id, until, created_by)
    values (d.organization_id, 'entity', d.entity_type, d.entity_id, p_until, auth.uid())
    on conflict (organization_id, scope, coalesce(kind, ''), coalesce(entity_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid))
    do update set until = excluded.until, created_by = excluded.created_by, created_at = now();
    update public.ai_decisions set status = 'dismissed', resolved_by = auth.uid(), resolved_at = now(), resolution = 'muted:entity'
     where organization_id = d.organization_id and entity_id = d.entity_id and status in ('open','snoozed');
  else
    raise exception 'Onbekend bereik: %', p_scope using errcode = '22023';
  end if;
  -- De voorstellen achter de gedempte kaarten gaan dicht — behalve wat iemand
  -- op dit moment uitvoert; die meldt zelf zijn uitkomst.
  update public.ai_action_audit a
     set status = 'cancelled',
         result = (coalesce(a.result, '{}'::jsonb) - 'claimed_by' - 'claimed_until')
               || jsonb_build_object('decision', 'rejected', 'decided_by', auth.uid(), 'decided_at', now())
   where (a.status = 'proposed' or (a.status = 'failed' and coalesce(a.result ->> 'decision', '') = 'failed'))
     and coalesce(nullif(a.result ->> 'claimed_until', '')::timestamptz, '-infinity'::timestamptz) <= now()
     and a.id in (
       select x.audit_id from public.ai_decisions x
        where x.organization_id = d.organization_id and x.status = 'dismissed' and x.resolution like 'muted:%' and x.audit_id is not null
     );
end;
$$;
revoke execute on function public.ai_decision_mute(uuid, text, timestamptz) from public, anon;
grant execute on function public.ai_decision_mute(uuid, text, timestamptz) to authenticated, service_role;

-- ── 3. Intrekken: ook wat opnieuw mocht, gaat dicht ─────────────────────────
create or replace function public.api_keys_on_revoke()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.revoked_at is not null and old.revoked_at is null then
    update public.ai_action_audit
       set status = 'cancelled',
           result = (coalesce(result, '{}'::jsonb) - 'claimed_by' - 'claimed_until')
                 || jsonb_build_object('detail', 'De API-sleutel is ingetrokken.')
     where api_key_id = new.id
       and (status = 'proposed' or (status = 'failed' and coalesce(result ->> 'decision', '') = 'failed'))
       -- Wat iemand nu uitvoert, maakt hij af; ai_action_decide legt die uitkomst vast.
       and coalesce(nullif(result ->> 'claimed_until', '')::timestamptz, '-infinity'::timestamptz) <= now();
    delete from public.webhook_endpoints where api_key_id = new.id;
  end if;
  return new;
end;
$$;

-- ── 4. Een auditregel hoort bij de organisatie van zijn sleutel ─────────────
create or replace function public.ai_action_audit_api_key_valid()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_revoked timestamptz;
  v_expires timestamptz;
  v_org     uuid;
begin
  if new.api_key_id is null then
    return new;
  end if;
  if new.status is distinct from 'proposed' then
    -- Een rechtstreekse uitvoering: alleen de organisatie. Intrekken tijdens het
    -- verzoek maakt het gebeurde niet ongedaan, en dat hoort dan ook in het log.
    if not exists (
      select 1 from public.api_keys k where k.id = new.api_key_id and k.organization_id = new.organization_id
    ) then
      raise exception 'Deze API-sleutel hoort niet bij deze organisatie.' using errcode = '42501';
    end if;
    return new;
  end if;
  -- Zie 20261003030000: FOR SHARE sluit de race met het intrekken.
  select k.revoked_at, k.expires_at, k.organization_id into v_revoked, v_expires, v_org
    from public.api_keys k where k.id = new.api_key_id
   for share;
  if v_org is distinct from new.organization_id then
    raise exception 'Deze API-sleutel hoort niet bij deze organisatie.' using errcode = '42501';
  end if;
  if v_revoked is not null or (v_expires is not null and v_expires < now()) then
    raise exception 'Deze API-sleutel is ingetrokken of verlopen; er kan niets meer worden klaargezet.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.ai_action_audit_api_key_valid() from public, anon, authenticated;

-- ── 5. Mislukte sleutels: ook een grens voor alle afzenders samen ──────────
--
-- De rij '*' telt alle mislukte pogingen. Een client_hash is altijd 64 hex-
-- tekens, dus botsen kan niet. Boven p_global_max is ELKE ongeldige sleutel
-- even een 429 in plaats van een 401 — een geldige sleutel werkt door.
create or replace function public.api_key_lookup(p_selector text, p_client text)
returns table (api_key_id uuid, verifier_hash text, salt text, retry_after integer)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de API zoekt sleutels op.' using errcode = '42501';
  end if;
  return query
    select s.api_key_id, s.verifier_hash, s.salt,
           coalesce((
             select max(greatest(1, ceil(extract(epoch from (f.blocked_until - now())))))::integer
               from public.api_auth_failures f
              where f.client_hash in (p_client, '*') and f.blocked_until > now()
           ), 0)
      from (select 1) as one
      left join public.api_key_secrets s on s.selector = p_selector;
end;
$$;

revoke all on function public.api_key_lookup(text, text) from public, anon, authenticated;
grant execute on function public.api_key_lookup(text, text) to service_role;

-- Een parameter erbij: de oude versie gaat weg, anders zijn er twee die op een
-- aanroep met vier namen passen.
drop function if exists public.api_note_auth_failure(text, integer, integer, integer);

create or replace function public.api_note_auth_failure(
  p_client text,
  p_window_seconds integer default 600,
  p_max_failures integer default 60,
  p_block_seconds integer default 900,
  p_global_max integer default 1000
)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_row public.api_auth_failures%rowtype;
  v_all public.api_auth_failures%rowtype;
  v_window interval := make_interval(secs => greatest(coalesce(p_window_seconds, 600), 1));
  v_block interval := make_interval(secs => greatest(coalesce(p_block_seconds, 900), 1));
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de API telt mislukte pogingen.' using errcode = '42501';
  end if;

  -- Per afzender.
  insert into public.api_auth_failures as f (client_hash, window_start, failures)
  values (p_client, now(), 1)
  on conflict (client_hash) do update
     set window_start = case when f.window_start < now() - v_window then now() else f.window_start end,
         failures = case when f.window_start < now() - v_window then 1 else f.failures + 1 end
  returning * into v_row;
  if v_row.failures >= greatest(coalesce(p_max_failures, 60), 1)
     and (v_row.blocked_until is null or v_row.blocked_until <= now()) then
    update public.api_auth_failures
       set blocked_until = now() + v_block, failures = 0, window_start = now()
     where client_hash = p_client
    returning * into v_row;
  end if;

  -- Alle afzenders samen.
  insert into public.api_auth_failures as f (client_hash, window_start, failures)
  values ('*', now(), 1)
  on conflict (client_hash) do update
     set window_start = case when f.window_start < now() - v_window then now() else f.window_start end,
         failures = case when f.window_start < now() - v_window then 1 else f.failures + 1 end
  returning * into v_all;
  if v_all.failures >= greatest(coalesce(p_global_max, 1000), 1)
     and (v_all.blocked_until is null or v_all.blocked_until <= now()) then
    update public.api_auth_failures
       set blocked_until = now() + v_block, failures = 0, window_start = now()
     where client_hash = '*'
    returning * into v_all;
  end if;

  return greatest(
    case when v_row.blocked_until > now() then greatest(1, ceil(extract(epoch from (v_row.blocked_until - now()))))::integer else 0 end,
    case when v_all.blocked_until > now() then greatest(1, ceil(extract(epoch from (v_all.blocked_until - now()))))::integer else 0 end
  );
end;
$$;

revoke all on function public.api_note_auth_failure(text, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.api_note_auth_failure(text, integer, integer, integer, integer) to service_role;

commit;
