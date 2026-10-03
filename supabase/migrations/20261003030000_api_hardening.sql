-- ============================================================
-- ResoFly — Openbare API: bevindingen uit de veiligheidstest
-- Date: 2026-10-03
--
-- Aanleiding:
-- Een aanvalsronde tegen de API en drie code-reviews (sleutels en rechten,
-- webhooks, vaste adressen) leverden geen kritieke bevindingen op, wel een
-- handvol dat hier wordt dichtgezet:
--
--   1. api_rest_write — wijzigingen die het KLANTPORTAAL raken, vragen
--      toegangsniveau `execute_high` (p_allow_outward): het e-mailadres van een
--      klant (dat bepaalt wie in het portaal kan), e-mail of "actief" van een
--      contactpersoon met portaaltoegang, een project of ticket naar een andere
--      klant verhuizen, en een reactie die de klant ziet. Met alleen `execute`
--      kon een sleutel met "geen financiën" zich anders via het portaal
--      toegang tot facturen verschaffen.
--   2. api_rest_write — uren: het project van de taak gaat voor (zoals de
--      trigger validate_time_entry het ook doet), een project of klant die er
--      niet bij hoort is een fout in plaats van een stille correctie, en de
--      eindtijd ligt niet vóór de begintijd — ook bij een PATCH van één veld.
--   3. Geen voorstel meer van een ingetrokken of verlopen sleutel, ook niet in
--      de race met het intrekken zelf.
--   4. Wie uit de organisatie gaat (verwijderd of uitgeschakeld), verliest zijn
--      API-sleutels — net als zijn app-wachtwoorden. Weer actief worden geeft ze
--      niet terug.
--   5. Een reactie op een ticket verwijst naar een ticket van dezelfde
--      organisatie (die controle bestond alleen in de API, niet in de database).
--   6. De aanroeplimiet ruimt niet meer op terwijl hij de sleutel vergrendeld
--      houdt; opruimen gebeurt los (zie PUBLIC_API_SETUP.md).
--   7. De wacht van api_keys bewaakt ook het id; idempotente antwoorden bewaren
--      hun Location-header.
--
-- En bij de webhooks:
--
--   8. Het adres van een webhook stond als label in audit_logs, en dat log
--      leest elk teamlid. Zo'n adres is vaak zelf een geheim (Zapier, Make,
--      Pipedream zetten er een token in). Het label is nu de omschrijving.
--   9. De wacht van webhook_endpoints: wie in de app aan- of uitzet, kan niet
--      tegelijk de foutteller of de reden van uitzetten invullen.
--  10. Claimen is eerlijk per eindpunt: één eindpunt met een grote achterstand
--      vulde de hele kandidatenlijst, zodat de rest nooit aan de beurt kwam.
--      En twee rondes tegelijk tellen niet allebei "nog niets onderweg".
--  11. Een bericht bevat per onderwerp een vaste lijst velden (die van de API),
--      in plaats van "alles behalve geheimen". Een nieuwe kolom gaat dus niet
--      vanzelf mee naar buiten, en interne velden (taakreacties, interne
--      notities bij een ticket, de contracttekst) gaan niet mee.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 7a. De wacht van api_keys: ook het id ───────────────────────────────────
create or replace function public.api_keys_guard_client_update()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is null then return new; end if;

  if new.id is distinct from old.id
     or new.organization_id is distinct from old.organization_id
     or new.user_id is distinct from old.user_id
     or new.key_hint is distinct from old.key_hint
     or new.scope is distinct from old.scope
     or new.module_access is distinct from old.module_access
     or new.expires_at is distinct from old.expires_at
     or new.created_at is distinct from old.created_at
     -- De boekhouding van de API hoort niet aan de gebruiker: zonder deze regels
     -- poetst een PATCH met {"calls_in_window": 0} de aanroeplimiet weg.
     or new.last_used_at is distinct from old.last_used_at
     or new.calls_window_start is distinct from old.calls_window_start
     or new.calls_in_window is distinct from old.calls_in_window then
    raise exception 'Vanuit de app is aan een API-sleutel alleen hernoemen en intrekken toegestaan. Moet hij meer of minder mogen, maak dan een nieuwe sleutel en trek deze in.'
      using errcode = '42501';
  end if;

  -- Intrekken is definitief: een gelekte sleutel die iemand per ongeluk weer
  -- "aanzet", is precies het lek dat het intrekken moest dichten.
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'Een ingetrokken API-sleutel blijft ingetrokken. Maak een nieuwe sleutel aan.'
      using errcode = '42501';
  end if;

  if new.revoked_at is not null and old.revoked_at is null then
    -- Het moment en de persoon schrijft de database, niet de browser.
    new.revoked_at := now();
    new.revoked_by := auth.uid();
  else
    new.revoked_by := old.revoked_by;
  end if;
  return new;
end;
$$;

-- ── 7b. Idempotente antwoorden: ook de Location-header ──────────────────────
alter table public.api_idempotency_keys add column if not exists response_headers jsonb;

-- ── 6. De aanroeplimiet: alleen tellen ──────────────────────────────────────
--
-- Opruimen (api_purge_expired) gebeurde hier bij één op de honderd aanroepen,
-- terwijl de rij van de sleutel vergrendeld was: al die tijd wachtten de andere
-- aanroepen van die sleutel. De functie `api` ruimt nu zelf af en toe op,
-- buiten elke vergrendeling, en een dagelijkse cron-job is aanbevolen.
create or replace function public.api_consume_rate_limit(
  p_key_id uuid,
  p_cost integer default 1,
  p_window_seconds integer default 60,
  p_max_calls integer default 300
)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_start timestamptz;
  v_used  integer;
  v_cost  integer := greatest(coalesce(p_cost, 1), 0);
  v_fresh boolean;
begin
  -- Alleen de API-functie (service-role) boekt af. Zou een gewone gebruiker
  -- dit mogen aanroepen, dan kon hij zijn eigen venster leegdraaien.
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de API kan de aanroeplimiet bijwerken.' using errcode = '42501';
  end if;

  if v_cost = 0 then return 0; end if;

  select calls_window_start, calls_in_window
    into v_start, v_used
    from public.api_keys
   where id = p_key_id
   for update;

  if not found then
    raise exception 'Deze API-sleutel bestaat niet meer.' using errcode = 'P0002';
  end if;

  v_fresh := v_start is null or (now() - v_start) > make_interval(secs => greatest(p_window_seconds, 1));
  if v_fresh then v_used := 0; end if;

  if coalesce(v_used, 0) + v_cost > greatest(p_max_calls, 1) then
    return -1;
  end if;

  update public.api_keys
     set calls_window_start = case when v_fresh then now() else calls_window_start end,
         calls_in_window = coalesce(v_used, 0) + v_cost,
         last_used_at = now()
   where id = p_key_id;

  return coalesce(v_used, 0) + v_cost;
end;
$$;

revoke all on function public.api_consume_rate_limit(uuid, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.api_consume_rate_limit(uuid, integer, integer, integer) to service_role;

-- ── 3. Geen voorstel van een ingetrokken of verlopen sleutel ────────────────
--
-- api_keys_on_revoke annuleert wat er openstaat. Een verzoek dat net vóór het
-- intrekken door de sleutelcontrole kwam, kon daarna nog een voorstel
-- neerzetten dat goed te keuren bleef. De FOR SHARE-vergrendeling sluit die
-- race: loopt het intrekken, dan wacht dit tot het klaar is en ziet het de
-- ingetrokken sleutel; loopt dit eerst, dan wacht het intrekken en annuleert
-- het ook dit voorstel.
create or replace function public.ai_action_audit_api_key_valid()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_revoked timestamptz;
  v_expires timestamptz;
begin
  if new.api_key_id is null or new.status is distinct from 'proposed' then
    return new;
  end if;
  select k.revoked_at, k.expires_at into v_revoked, v_expires
    from public.api_keys k where k.id = new.api_key_id
   for share;
  if v_revoked is not null or (v_expires is not null and v_expires < now()) then
    raise exception 'Deze API-sleutel is ingetrokken of verlopen; er kan niets meer worden klaargezet.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.ai_action_audit_api_key_valid() from public, anon, authenticated;

drop trigger if exists ai_action_audit_api_key_valid on public.ai_action_audit;
create trigger ai_action_audit_api_key_valid
  before insert on public.ai_action_audit
  for each row execute function public.ai_action_audit_api_key_valid();

-- ── 4. Uit de organisatie = sleutels ingetrokken ────────────────────────────
create or replace function public.revoke_api_keys_on_member_exit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    update public.api_keys
       set revoked_at = now()
     where user_id = old.user_id and organization_id = old.organization_id and revoked_at is null;
    return old;
  end if;
  if old.status = 'active' and new.status is distinct from 'active' then
    update public.api_keys
       set revoked_at = now()
     where user_id = new.user_id and organization_id = new.organization_id and revoked_at is null;
  end if;
  return new;
end;
$$;

revoke all on function public.revoke_api_keys_on_member_exit() from public, anon, authenticated;

drop trigger if exists organization_members_revoke_api_keys on public.organization_members;
create trigger organization_members_revoke_api_keys
  after update of status or delete on public.organization_members
  for each row execute function public.revoke_api_keys_on_member_exit();

-- ── 5. Een reactie hoort bij een ticket van dezelfde organisatie ────────────
create or replace function public.enforce_ticket_notes_org_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_same_org_reference('public.tickets'::regclass, new.ticket_id, new.organization_id, 'Ticket');
  perform public.assert_same_org_reference('public.client_contacts'::regclass, new.author_client_contact_id, new.organization_id, 'Contactpersoon');
  return new;
end;
$$;

revoke all on function public.enforce_ticket_notes_org_integrity() from public, anon, authenticated;

drop trigger if exists ticket_notes_org_integrity on public.ticket_notes;
create trigger ticket_notes_org_integrity
  before insert or update of organization_id, ticket_id, author_client_contact_id on public.ticket_notes
  for each row execute function public.enforce_ticket_notes_org_integrity();

-- ── 1 + 2. api_rest_write: het portaal en de uren ───────────────────────────
--
-- Dezelfde functie als in 20261003020000, met één parameter erbij
-- (p_allow_outward: de sleutel heeft `execute_high`) en de regels hierboven.
-- De oude vijf-parameterversie gaat eerst weg: naast elkaar zouden ze een
-- dubbelzinnige aanroep geven.
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

  -- ── Wat het klantportaal raakt: alleen met `execute_high` ────────────────
  --
  -- Wie in het portaal kan, volgt uit het e-mailadres van de klant en uit
  -- contactpersonen met portaaltoegang; wat ze daar zien, uit de klant waaraan
  -- projecten, tickets en facturen hangen. Een wijziging daarin is net zo goed
  -- "naar buiten" als een bericht aan de klant.
  if not coalesce(p_allow_outward, false) then
    if p_row_id is not null and p_resource = 'clients' and p_values ? 'email'
       and lower(coalesce(p_values ->> 'email', '')) is distinct from lower(coalesce(v_existing ->> 'email', '')) then
      raise exception 'Het e-mailadres van een klant bepaalt wie in het klantportaal kan. Wijzigen via de API vraagt toegangsniveau "execute_high".'
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
    if p_row_id is null and p_resource = 'ticket_notes'
       and not coalesce((p_values ->> 'is_internal')::boolean, true) then
      raise exception 'Een reactie die de klant in het portaal ziet, is een bericht naar buiten. Dat vraagt toegangsniveau "execute_high"; zonder blijft hij intern.'
        using errcode = 'RS403';
    end if;
  end if;

  -- ── Per resource: wat de app er bij aanmaken of wijzigen zelf bij doet ────

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

-- ── 8. Webhooks in het auditlog: zonder het adres ──────────────────────────
--
-- audit_row_change zet de waarde van een kolom als label neer, en dat was hier
-- de URL. Deze eigen versie doet hetzelfde met de omschrijving (of "Webhook").
create or replace function public.webhook_endpoint_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb := case when TG_OP in ('UPDATE', 'DELETE') then to_jsonb(old) else '{}'::jsonb end;
  v_new jsonb := case when TG_OP in ('INSERT', 'UPDATE') then to_jsonb(new) else '{}'::jsonb end;
  v_row jsonb := case when TG_OP = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_changed text[] := array[]::text[];
begin
  if TG_OP = 'UPDATE' then
    select coalesce(array_agg(key order by key), array[]::text[])
      into v_changed
      from jsonb_object_keys(v_new || v_old) as changed(key)
     where (v_old -> key) is distinct from (v_new -> key)
       and key not in ('updated_at');
    if coalesce(array_length(v_changed, 1), 0) = 0 then return new; end if;
  end if;

  insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
  values (
    nullif(v_row ->> 'organization_id', '')::uuid,
    auth.uid(),
    case TG_OP when 'INSERT' then 'created' when 'DELETE' then 'deleted' else 'updated' end,
    'webhook_endpoint',
    nullif(v_row ->> 'id', '')::uuid,
    coalesce(nullif(btrim(v_row ->> 'description'), ''), 'Webhook'),
    jsonb_build_object('table', TG_TABLE_NAME, 'operation', TG_OP, 'changed_columns', to_jsonb(v_changed))
  );
  if TG_OP = 'DELETE' then return old; end if;
  return new;
exception when others then
  raise warning 'audit logging failed for webhook_endpoints: %', sqlerrm;
  if TG_OP = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists webhook_endpoints_audit_write on public.webhook_endpoints;
create trigger webhook_endpoints_audit_write
  after insert or delete on public.webhook_endpoints
  for each row execute function public.webhook_endpoint_audit();

drop trigger if exists webhook_endpoints_audit_update on public.webhook_endpoints;
create trigger webhook_endpoints_audit_update
  after update on public.webhook_endpoints
  for each row
  when (old.url is distinct from new.url or old.events is distinct from new.events
        or old.active is distinct from new.active or old.description is distinct from new.description)
  execute function public.webhook_endpoint_audit();

-- Wat er al in het log stond: het adres eruit.
update public.audit_logs
   set entity_label = 'Webhook'
 where entity_type = 'webhook_endpoint'
   and entity_label ~* '^https?://';

-- ── 9. De wacht van webhook_endpoints: aan/uit zonder teller ───────────────
create or replace function public.webhook_endpoints_guard_update()
returns trigger
language plpgsql
as $$
begin
  -- Weer aanzetten is een nieuwe start: de foutreeks en de reden van het
  -- uitzetten horen er dan niet meer bij. Geldt voor elke weg.
  if new.active and not old.active then
    new.consecutive_failures := 0;
    new.failing_since := null;
    new.disabled_reason := null;
  end if;
  new.updated_at := now();

  if auth.uid() is null then return new; end if;

  if new.organization_id is distinct from old.organization_id
     or new.url is distinct from old.url
     or new.events is distinct from old.events
     or new.created_by is distinct from old.created_by
     or new.api_key_id is distinct from old.api_key_id
     or new.created_at is distinct from old.created_at
     or new.last_success_at is distinct from old.last_success_at
     or new.last_failure_at is distinct from old.last_failure_at
     or (new.active = old.active and (
          new.consecutive_failures is distinct from old.consecutive_failures
          or new.failing_since is distinct from old.failing_since
          or new.disabled_reason is distinct from old.disabled_reason)) then
    raise exception 'Vanuit de app kun je een webhook alleen aan- of uitzetten, de omschrijving wijzigen of verwijderen. Adres en gebeurtenissen wijzig je in Instellingen → API & webhooks.'
      using errcode = '42501';
  end if;

  -- Uitzetten in de app: de teller en de reden blijven wat ze waren. Wat er in
  -- hetzelfde verzoek voor werd meegestuurd, telt niet — anders stond er zo
  -- "Automatisch uitgezet: …" bij een eindpunt dat iemand met de hand uitzette.
  if old.active and not new.active then
    new.consecutive_failures := old.consecutive_failures;
    new.failing_since := old.failing_since;
    new.disabled_reason := old.disabled_reason;
  end if;
  return new;
end;
$$;

-- ── 10. Claimen: eerlijk per eindpunt, één ronde tegelijk ──────────────────
create index if not exists idx_webhook_deliveries_endpoint_due
  on public.webhook_deliveries(endpoint_id, next_attempt_at) where status in ('pending', 'sending');

create or replace function public.claim_webhook_deliveries(
  p_limit integer default 16,
  p_max_attempts integer default 9,
  p_per_endpoint integer default 4
)
returns table (
  delivery_id uuid,
  endpoint_id uuid,
  organization_id uuid,
  attempts integer,
  url text,
  api_key_id uuid,
  secret_encrypted text,
  event_id uuid,
  event_type text,
  event_module text,
  event_payload jsonb,
  event_created_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = public
as $$
-- De uitvoerkolommen (attempts, url, …) zijn in plpgsql ook variabelen; zonder
-- deze regel botst een kolomnaam in een query met een variabele van dezelfde naam.
#variable_conflict use_column
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de webhook-dispatcher kan bezorgingen claimen.' using errcode = '42501';
  end if;

  -- Eén ronde tegelijk claimt. Twee rondes die op hetzelfde moment begonnen,
  -- telden anders allebei "nog niets onderweg" en stuurden samen het dubbele
  -- naar één eindpunt. Claimen duurt milliseconden; de tweede wacht even en
  -- ziet daarna wat de eerste pakte.
  perform pg_advisory_xact_lock(hashtext('public.claim_webhook_deliveries'));

  -- Een eindpunt dat uit staat, krijgt niets meer — ook niet wat er nog klaarstond.
  update public.webhook_deliveries d
     set status = 'skipped', error = 'Het eindpunt staat uit.'
    from public.webhook_endpoints e
   where e.id = d.endpoint_id and not e.active and d.status in ('pending', 'sending');

  -- Een bezorging die al het maximum aan pogingen had en daarna bleef hangen.
  update public.webhook_deliveries d
     set status = 'failed', error = coalesce(d.error, 'Geen antwoord na de laatste poging.')
   where d.status = 'sending' and d.last_attempt_at < now() - interval '5 minutes' and d.attempts >= p_max_attempts;

  if random() < 0.01 then
    perform public.webhook_purge_expired();
  end if;

  return query
  with in_flight as (
    -- Wat er per eindpunt nu al onderweg is, ook vanuit een andere ronde.
    select d.endpoint_id as ep, count(*)::integer as n
      from public.webhook_deliveries d
     where d.status = 'sending' and d.last_attempt_at >= now() - interval '5 minutes'
     group by d.endpoint_id
  ), due as (
    -- Per eindpunt zijn EIGEN vroegste bezorgingen, hooguit zoveel als er bij
    -- hem nog onderweg mogen. Vroeger kwamen eerst de duizend vroegste van
    -- iedereen: één eindpunt met een flinke achterstand vulde die lijst
    -- helemaal, en de rest kwam nooit aan de beurt.
    select x.id, x.due_at
      from public.webhook_endpoints e
      left join in_flight f on f.ep = e.id
      cross join lateral (
        select d.id, d.next_attempt_at as due_at
          from public.webhook_deliveries d
         where d.endpoint_id = e.id
           and ((d.status = 'pending' and d.next_attempt_at <= now())
             or (d.status = 'sending' and d.last_attempt_at < now() - interval '5 minutes'))
         order by d.next_attempt_at, d.id
         limit greatest(0, greatest(1, coalesce(p_per_endpoint, 4)) - coalesce(f.n, 0))
      ) x
     where e.active
  ), picked as (
    -- De status nog eens, op de vergrendelde rij zelf.
    select d.id
      from public.webhook_deliveries d
      join due on due.id = d.id
     where ((d.status = 'pending' and d.next_attempt_at <= now())
         or (d.status = 'sending' and d.last_attempt_at < now() - interval '5 minutes'))
     order by d.next_attempt_at, d.id
     for update of d skip locked
     limit greatest(1, least(coalesce(p_limit, 16), 200))
  ), claimed as (
    update public.webhook_deliveries d
       set status = 'sending', attempts = d.attempts + 1, last_attempt_at = now()
      from picked
     where d.id = picked.id
    returning d.id, d.endpoint_id, d.organization_id, d.attempts, d.event_id
  )
  select c.id, c.endpoint_id, c.organization_id, c.attempts,
         e.url, e.api_key_id, s.secret_encrypted,
         ev.id, ev.type, ev.module, ev.payload, ev.created_at
    from claimed c
    join public.webhook_endpoints e on e.id = c.endpoint_id
    left join public.webhook_endpoint_secrets s on s.endpoint_id = e.id
    join public.webhook_events ev on ev.id = c.event_id;
end;
$$;

revoke all on function public.claim_webhook_deliveries(integer, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_webhook_deliveries(integer, integer, integer) to service_role;

-- ── 11. Wat er in een bericht staat: een vaste lijst per onderwerp ─────────
--
-- Voor klanten, contactpersonen, projecten, taken, tickets, reacties en uren
-- precies de velden van de API (apiResourceSpecs.ts; webhooksServer.test.ts
-- legt de twee lijsten naast elkaar). Voor offertes, facturen, contracten en
-- boekingen wat een koppeling nodig heeft, zonder interne workflow, tokens,
-- bestandsverwijzingen en de contracttekst zelf.
create or replace function public.webhook_payload_columns(p_entity text)
returns text[]
language sql
immutable
as $$
  select case p_entity
    when 'client' then array[
      'id', 'name', 'client_code', 'client_kind', 'status', 'contact_name', 'email', 'phone', 'vat_number',
      'kvk_number', 'address_line1', 'address_line2', 'postal_code', 'city', 'country', 'notes', 'tags', 'color',
      'value_eur', 'follow_up', 'custom_fields', 'created_by', 'created_at', 'updated_at']
    when 'contact' then array[
      'id', 'client_id', 'name', 'email', 'phone', 'role', 'is_active', 'gives_portal_access', 'origin',
      'created_by', 'created_at', 'updated_at']
    when 'project' then array[
      'id', 'name', 'client_id', 'description', 'archived', 'start_date', 'end_date', 'billing_type',
      'hourly_rate_cents', 'budgeted_minutes', 'color', 'contract_id', 'created_by', 'created_at', 'updated_at']
    when 'task' then array[
      'id', 'title', 'description', 'status', 'priority', 'project_id', 'client_id', 'ticket_id', 'tags',
      'start_date', 'end_date', 'planned_date', 'planned_end_date', 'planned_start_minute', 'estimated_minutes',
      'created_by', 'created_at', 'updated_at']
    when 'ticket' then array[
      'id', 'title', 'description', 'status', 'priority', 'client_id', 'notes', 'converted_to_project_id',
      'created_by_name', 'created_by_email', 'created_by', 'created_at', 'updated_at']
    when 'ticket_note' then array[
      'id', 'ticket_id', 'body', 'is_internal', 'author_type', 'author_user_id', 'author_name',
      'created_at', 'updated_at']
    when 'time_entry' then array[
      'id', 'user_id', 'entry_date', 'minutes', 'started_at', 'ended_at', 'description', 'project_id',
      'client_id', 'task_id', 'billable', 'hourly_rate_cents', 'entry_type', 'indirect_category', 'source',
      'created_by', 'created_at', 'updated_at']
    when 'quote' then array[
      'id', 'number', 'client_id', 'project_id', 'date', 'valid_until', 'status', 'lines', 'notes', 'sent_at',
      'accepted_at', 'internal_approval_status', 'client_decision_at', 'client_decision_by_name',
      'created_by', 'created_at', 'updated_at']
    when 'invoice' then array[
      'id', 'number', 'client_id', 'project_id', 'quote_id', 'contract_id', 'date', 'due_date', 'status',
      'currency', 'subtotal_amount', 'vat_amount', 'total_amount', 'lines', 'notes', 'sent_at', 'paid_at',
      'refunded_amount', 'refunded_at', 'charged_back_amount', 'charged_back_at', 'reminder_level',
      'last_reminder_at', 'created_by', 'created_at', 'updated_at']
    when 'contract' then array[
      'id', 'number', 'title', 'client_id', 'quote_id', 'date', 'valid_until', 'status', 'amount_cents',
      'currency', 'sent_at', 'signed_at', 'voided_at', 'supersedes_contract_id', 'created_by', 'created_at',
      'updated_at']
    when 'booking' then array[
      'id', 'booking_link_id', 'client_id', 'status', 'booked_name', 'booked_email', 'created_at',
      'confirmed_at', 'cancelled_at']
    else array['id']
  end;
$$;

-- De rij zoals hij naar buiten gaat: alleen de velden van de lijst, en daarvan
-- nog steeds niets wat op een geheim lijkt of te groot is (webhook_public_row).
create or replace function public.webhook_public_row(p_entity text, p_row jsonb)
returns jsonb
language sql
immutable
as $$
  select public.webhook_public_row(coalesce(
    (select jsonb_object_agg(e.key, e.value)
       from jsonb_each(coalesce(p_row, '{}'::jsonb)) as e
      where e.key = any(public.webhook_payload_columns(p_entity))),
    '{}'::jsonb));
$$;

create or replace function public.webhook_capture()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entity  text := TG_ARGV[0];
  v_module  text := TG_ARGV[1];
  v_allowed text[] := public.webhook_payload_columns(TG_ARGV[0]);
  v_row     jsonb;
  v_old     jsonb;
  v_org     uuid;
  v_types   text[];
  v_type    text;
  v_changed text[];
  v_status  text;
  v_payload jsonb;
  v_event   uuid;
begin
  v_row := case when TG_OP = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_org := nullif(v_row ->> 'organization_id', '')::uuid;
  if v_org is null then return null; end if;

  -- De snelste uitweg eerst. Bijna geen organisatie heeft webhooks; die mogen
  -- hier niet meer kosten dan één indexopzoeking.
  if not exists (select 1 from public.webhook_endpoints e where e.organization_id = v_org and e.active) then
    return null;
  end if;

  begin
    if TG_OP = 'INSERT' then
      v_types := array[v_entity || '.created'];
    elsif TG_OP = 'DELETE' then
      v_types := array[v_entity || '.deleted'];
    else
      v_old := to_jsonb(old);
      -- Alleen wat ook in het bericht staat, telt als wijziging: een reactie
      -- onder een taak of een interne workflowkolom is geen "task.updated".
      select coalesce(array_agg(k order by k), array[]::text[])
        into v_changed
        from jsonb_object_keys(v_row) as k
       where (v_row -> k) is distinct from (v_old -> k)
         and k = any(v_allowed)
         and not public.webhook_is_noise_column(k);
      if coalesce(array_length(v_changed, 1), 0) = 0 then return null; end if;
      v_types := array[v_entity || '.updated'];
    end if;

    -- Een statusovergang die ertoe doet, krijgt een eigen gebeurtenis naast de
    -- gewone: "invoice.paid" is waar een koppeling op wacht, niet op
    -- "invoice.updated" met ergens een veld dat anders is.
    if TG_OP <> 'DELETE' then
      v_status := v_row ->> 'status';
      if v_status is not null and (TG_OP = 'INSERT' or v_status is distinct from (v_old ->> 'status')) then
        v_type := public.webhook_status_event(v_entity, v_status);
        if v_type is not null then v_types := v_types || v_type; end if;
      end if;
    end if;

    v_payload := jsonb_build_object('object', public.webhook_public_row(v_entity, v_row));
    if TG_OP = 'UPDATE' then
      v_payload := v_payload || jsonb_build_object(
        'changed', to_jsonb(array(select c from unnest(v_changed) as c where not public.webhook_is_secret_column(c))),
        'previous', public.webhook_public_row(v_entity, (select jsonb_object_agg(c, v_old -> c) from unnest(v_changed) as c))
      );
    end if;

    foreach v_type in array v_types loop
      if exists (
        select 1 from public.webhook_endpoints e
         where e.organization_id = v_org and e.active and public.webhook_event_matches(e.events, v_type)
      ) then
        insert into public.webhook_events(organization_id, type, entity, entity_id, module, payload)
        values (v_org, v_type, v_entity, nullif(v_row ->> 'id', '')::uuid, v_module, v_payload)
        returning id into v_event;

        insert into public.webhook_deliveries(organization_id, endpoint_id, event_id)
        select v_org, e.id, v_event
          from public.webhook_endpoints e
         where e.organization_id = v_org and e.active and public.webhook_event_matches(e.events, v_type);
      end if;
    end loop;
  exception when others then
    -- Een webhook mag NOOIT het opslaan van een klant, factuur of ticket laten
    -- mislukken. Liever een gemist bericht (zichtbaar in de logs) dan een
    -- gebruiker die zijn werk kwijt is.
    raise warning 'webhook_capture op %: %', TG_TABLE_NAME, sqlerrm;
  end;
  return null;
end;
$$;

commit;
