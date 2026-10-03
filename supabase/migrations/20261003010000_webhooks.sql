-- ============================================================
-- ResoFly — Uitgaande webhooks: ResoFly geeft zelf een seintje
-- Date: 2026-10-03
--
-- Aanleiding:
-- Met de openbare API (20261003000000) kan andere software IETS VRAGEN aan
-- ResoFly. Maar een koppeling wil ook horen dát er iets gebeurd is — een
-- factuur betaald, een nieuwe klant, een ticket van het portaal — zonder elke
-- minuut alles opnieuw op te vragen. Daarvoor zijn webhooks: ResoFly stuurt
-- zelf een ondertekend bericht naar een adres dat de klant opgeeft.
--
-- HOE HET LOOPT
--   1. webhook_capture() hangt als trigger aan elf kerntabellen. Verandert er
--      een rij, en is er in die organisatie een actief eindpunt dat deze
--      gebeurtenis wil horen, dan komt er één webhook_events-rij bij en één
--      webhook_deliveries-rij per eindpunt. Geen eindpunt, geen rij: een
--      organisatie zonder webhooks merkt hier niets van.
--   2. De functie `webhooks` (cron, elke minuut) claimt bezorgingen
--      (claim_webhook_deliveries), ondertekent en verstuurt ze, en legt de
--      uitkomst vast (finish_webhook_delivery) — met een nieuwe poging volgens
--      een vast schema als het eindpunt niet antwoordt.
--   3. Een eindpunt dat een hele dag niets dan fouten geeft, zet zichzelf uit.
--
-- WAT ER IN EEN BERICHT STAAT
-- De rij zoals hij nu is (`object`), en bij een wijziging welke velden er
-- veranderden en wat ze waren. Zonder geheimen: alles wat op token, hash,
-- secret, password of pin lijkt valt eruit, net als opslagsleutels en
-- base64-bestanden (webhook_public_row).
--
-- DE GRENS
-- Een eindpunt hoort bij één organisatie en krijgt alleen gebeurtenissen van
-- die organisatie — de trigger leest organization_id uit de rij zelf. Een
-- eindpunt dat via een API-sleutel is aangemaakt, krijgt bovendien alleen
-- gebeurtenissen uit modules die die sleutel mag lezen; dat weegt de dispatcher
-- bij elke bezorging opnieuw.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Hulpfuncties: wat er wel en niet in een bericht hoort ────────────────

-- Kolommen die nooit naar buiten gaan. Een patroon en geen lijst: een nieuwe
-- kolom `share_token` op een van deze tabellen hoort er vanzelf buiten te
-- blijven, ook als niemand aan deze migratie denkt.
create or replace function public.webhook_is_secret_column(p_column text)
returns boolean
language sql
immutable
as $$
  select p_column ~ '(^|_)(token|tokens|hash|secret|secrets|password|pin)(_|$)'
      or p_column ~ '(_base64|_storage_key)$'
      or p_column in ('resend_last_email_id', 'icalendar_raw');
$$;

-- Kolommen waarvan een wijziging geen gebeurtenis is: de boekhouding van de app
-- zelf (wanneer bijgewerkt, volgorde op het bord, bezorgstatus van een mail).
-- Zou een taak verslepen op het bord "task.updated" geven, dan krijgt een
-- koppeling tientallen berichten waar niets in veranderd is.
create or replace function public.webhook_is_noise_column(p_column text)
returns boolean
language sql
immutable
as $$
  select p_column in (
           'updated_at', 'planned_order', 'position', 'edit_version', 'last_edited_at', 'last_edited_by',
           'last_email_delivery_status', 'last_email_delivery_at', 'last_email_opened_at',
           'last_email_clicked_at', 'last_email_failed_at'
         )
      or public.webhook_is_secret_column(p_column);
$$;

-- De rij zoals hij naar buiten gaat: zonder geheimen, en zonder waarden die
-- groter zijn dan een bericht hoort te zijn (een contracttekst, een bijlage).
-- Wat er om die tweede reden uit viel, staat in `_omitted`; de koppeling kan
-- het dan via de API ophalen.
create or replace function public.webhook_public_row(p_row jsonb)
returns jsonb
language sql
immutable
as $$
  select coalesce(jsonb_object_agg(e.key, e.value) filter (where octet_length(e.value::text) <= 32768), '{}'::jsonb)
         || case
              when count(*) filter (where octet_length(e.value::text) > 32768) > 0
              then jsonb_build_object('_omitted', jsonb_agg(e.key) filter (where octet_length(e.value::text) > 32768))
              else '{}'::jsonb
            end
    from jsonb_each(coalesce(p_row, '{}'::jsonb)) as e
   where not public.webhook_is_secret_column(e.key);
$$;

-- Een statusovergang die een eigen gebeurtenis waard is. De rest van de
-- statussen gaat gewoon mee in `<onderwerp>.updated`.
create or replace function public.webhook_status_event(p_entity text, p_status text)
returns text
language sql
immutable
as $$
  select case
    when p_entity = 'invoice' and p_status = 'sent' then 'invoice.sent'
    when p_entity = 'invoice' and p_status = 'paid' then 'invoice.paid'
    when p_entity = 'quote' and p_status = 'sent' then 'quote.sent'
    when p_entity = 'quote' and p_status = 'accepted' then 'quote.accepted'
    when p_entity = 'quote' and p_status = 'rejected' then 'quote.rejected'
    when p_entity = 'task' and p_status = 'done' then 'task.completed'
    when p_entity = 'contract' and p_status = 'signed' then 'contract.signed'
    when p_entity = 'contract' and p_status = 'declined' then 'contract.declined'
    when p_entity = 'booking' and p_status = 'cancelled' then 'booking.cancelled'
    else null
  end;
$$;

-- Valt dit type onder dit abonnement? Exact, `onderwerp.*` of `*` — dezelfde
-- drie vormen als eventMatches() in _shared/webhooks.ts.
create or replace function public.webhook_event_matches(p_events text[], p_type text)
returns boolean
language sql
immutable
as $$
  select exists (
    select 1 from unnest(coalesce(p_events, array[]::text[])) as ev
     where ev = '*'
        or ev = p_type
        or (right(ev, 2) = '.*' and split_part(p_type, '.', 1) = left(ev, length(ev) - 2))
  );
$$;

-- ── 2. De eindpunten ────────────────────────────────────────────────────────
create table if not exists public.webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  url text not null,
  description text not null default '',
  -- Exacte types, `onderwerp.*` of `*`. Gecontroleerd door de functies die een
  -- eindpunt aanmaken (normalizeEventList), want die kennen de catalogus.
  events text[] not null,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  -- Aangemaakt via de API? Dan hoort het eindpunt bij die sleutel: het krijgt
  -- alleen wat de sleutel mag lezen, en gaat weg als de sleutel wordt
  -- ingetrokken. Aangemaakt in het instellingenscherm: null, van de organisatie.
  api_key_id uuid references public.api_keys(id) on delete cascade,
  disabled_reason text,
  consecutive_failures integer not null default 0,
  failing_since timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint webhook_endpoints_url_check check (url ~ '^https://' and char_length(url) <= 2000),
  constraint webhook_endpoints_description_check check (char_length(description) <= 200),
  constraint webhook_endpoints_events_check check (cardinality(events) between 1 and 100)
);

create index if not exists idx_webhook_endpoints_org_active
  on public.webhook_endpoints(organization_id) where active;
create index if not exists idx_webhook_endpoints_key
  on public.webhook_endpoints(api_key_id) where api_key_id is not null;

drop trigger if exists webhook_endpoints_prevent_org_change on public.webhook_endpoints;
create trigger webhook_endpoints_prevent_org_change
  before update of organization_id on public.webhook_endpoints
  for each row execute function public.prevent_organization_id_change();

-- Het ondertekengeheim, versleuteld met WEBHOOK_SECRET_ENCRYPTION_KEY (dat
-- alleen in de Edge Function secrets staat). Apart van wat het scherm leest,
-- en zonder policies: alleen de functies komen erbij.
create table if not exists public.webhook_endpoint_secrets (
  endpoint_id uuid primary key references public.webhook_endpoints(id) on delete cascade,
  secret_encrypted text not null,
  created_at timestamptz not null default now()
);

-- ── 3. Gebeurtenissen en bezorgingen ────────────────────────────────────────
create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  type text not null,
  entity text not null,
  entity_id uuid,
  -- Uit welke module: daarop weegt de dispatcher of een eindpunt van een
  -- API-sleutel dit mag horen.
  module text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_webhook_events_org
  on public.webhook_events(organization_id, created_at desc);
create index if not exists idx_webhook_events_created
  on public.webhook_events(created_at);

create table if not exists public.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  endpoint_id uuid not null references public.webhook_endpoints(id) on delete cascade,
  event_id uuid not null references public.webhook_events(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'delivered', 'failed', 'skipped')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  response_status integer,
  response_body text,
  error text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);

create index if not exists idx_webhook_deliveries_due
  on public.webhook_deliveries(next_attempt_at) where status in ('pending', 'sending');
-- Wat er per eindpunt onderweg is; klein, want alleen wat nu verstuurd wordt.
create index if not exists idx_webhook_deliveries_sending
  on public.webhook_deliveries(endpoint_id) where status = 'sending';
create index if not exists idx_webhook_deliveries_endpoint
  on public.webhook_deliveries(endpoint_id, created_at desc);
create index if not exists idx_webhook_deliveries_event
  on public.webhook_deliveries(event_id);

-- ── 4. Vastleggen wat er gebeurt ────────────────────────────────────────────
create or replace function public.webhook_capture()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entity  text := TG_ARGV[0];
  v_module  text := TG_ARGV[1];
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
      select coalesce(array_agg(k order by k), array[]::text[])
        into v_changed
        from jsonb_object_keys(v_row) as k
       where (v_row -> k) is distinct from (v_old -> k)
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

    v_payload := jsonb_build_object('object', public.webhook_public_row(v_row));
    if TG_OP = 'UPDATE' then
      v_payload := v_payload || jsonb_build_object(
        'changed', to_jsonb(array(select c from unnest(v_changed) as c where not public.webhook_is_secret_column(c))),
        'previous', public.webhook_public_row((select jsonb_object_agg(c, v_old -> c) from unnest(v_changed) as c))
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

-- Elf tabellen, elk met zijn onderwerp en zijn module. Deze lijst en de
-- catalogus in _shared/webhooks.ts horen bij elkaar; webhooks.test.ts legt ze
-- naast elkaar.
do $$
declare
  v_spec record;
begin
  for v_spec in
    select * from (values
      ('clients',          'client',      'clients',  'insert or update or delete'),
      ('client_contacts',  'contact',     'clients',  'insert or update or delete'),
      ('projects',         'project',     'projects', 'insert or update or delete'),
      ('tasks',            'task',        'projects', 'insert or update or delete'),
      ('tickets',          'ticket',      'tickets',  'insert or update or delete'),
      ('ticket_notes',     'ticket_note', 'tickets',  'insert'),
      ('time_entries',     'time_entry',  'time',     'insert or update or delete'),
      ('quotes',           'quote',       'finance',  'insert or update or delete'),
      ('invoices',         'invoice',     'finance',  'insert or update or delete'),
      ('contracts',        'contract',    'finance',  'insert or update or delete'),
      ('meeting_bookings', 'booking',     'calendar', 'insert or update')
    ) as t(table_name, entity, module, ops)
  loop
    if to_regclass('public.' || v_spec.table_name) is null then continue; end if;
    execute format('drop trigger if exists zz_webhook_capture on public.%I', v_spec.table_name);
    execute format(
      'create trigger zz_webhook_capture after %s on public.%I for each row execute function public.webhook_capture(%L, %L)',
      v_spec.ops, v_spec.table_name, v_spec.entity, v_spec.module
    );
  end loop;
end $$;

-- ── 5. Bezorgen: claimen en afronden ────────────────────────────────────────
--
-- Zelfde patroon als claim_push_outbox: `for update skip locked`, zodat twee
-- gelijktijdige dispatchers nooit dezelfde bezorging pakken. Een bezorging die
-- vijf minuten op 'sending' staat (de functie viel om), komt terug — dat maakt
-- het "minstens één keer": een ontvanger herkent een herhaling aan het
-- gebeurtenis-id.
--
-- Per eindpunt is er een plafond op wat er tegelijk onderweg is
-- (p_per_endpoint, ook over gelijktijdige rondes heen). Zonder dat plafond houdt
-- één eindpunt dat niet antwoordt, met een flinke achterstand, alle bezorgers
-- tien seconden per bericht bezig — en lopen de webhooks van alle andere
-- organisaties uren achter.
create or replace function public.webhook_purge_expired()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.webhook_events where created_at < now() - interval '30 days';
end;
$$;

revoke all on function public.webhook_purge_expired() from public, anon, authenticated;
grant execute on function public.webhook_purge_expired() to service_role;

-- Een eerdere versie van deze migratie (in ontwikkeling) had twee parameters;
-- naast de nieuwe zou die een dubbelzinnige overload geven.
drop function if exists public.claim_webhook_deliveries(integer, integer);

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
    -- De vroegste bezorgingen die aan de beurt zijn. Een eindpunt heeft hierin
    -- altijd zijn eigen vroegste, dus de rangorde hieronder klopt ook met de grens.
    select d.id, d.endpoint_id as ep, d.next_attempt_at as due_at
      from public.webhook_deliveries d
     where (d.status = 'pending' and d.next_attempt_at <= now())
        or (d.status = 'sending' and d.last_attempt_at < now() - interval '5 minutes')
     order by d.next_attempt_at
     limit 1000
  ), ranked as (
    select due.id,
           row_number() over (partition by due.ep order by due.due_at, due.id) + coalesce(f.n, 0) as slot
      from due
      left join in_flight f on f.ep = due.ep
  ), picked as (
    -- De status nog eens, op de vergrendelde rij zelf: een rij die een andere
    -- ronde net claimde, valt hier alsnog af.
    select d.id
      from public.webhook_deliveries d
      join ranked r on r.id = d.id
     where r.slot <= greatest(1, coalesce(p_per_endpoint, 4))
       and ((d.status = 'pending' and d.next_attempt_at <= now())
         or (d.status = 'sending' and d.last_attempt_at < now() - interval '5 minutes'))
     order by d.next_attempt_at
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

-- De uitkomst van één poging. `p_retry_in_seconds` null bij een mislukking =
-- dit was de laatste. `p_disable_reason` zet het eindpunt meteen uit (een 410:
-- "dit adres bestaat niet meer").
--
-- Daarnaast de stand van het eindpunt: bij succes is alles weer goed; bij een
-- mislukking telt de reeks op, en een eindpunt dat een hele dag lang bij elk
-- bericht faalde (en minstens 25 keer) gaat uit, met de reden erbij.
create or replace function public.finish_webhook_delivery(
  p_delivery_id uuid,
  p_ok boolean,
  p_response_status integer default null,
  p_response_body text default null,
  p_error text default null,
  p_retry_in_seconds integer default null,
  p_disable_reason text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_endpoint uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de webhook-dispatcher kan bezorgingen afronden.' using errcode = '42501';
  end if;

  update public.webhook_deliveries
     set status = case
                    when p_ok then 'delivered'
                    when p_retry_in_seconds is null then 'failed'
                    else 'pending'
                  end,
         next_attempt_at = case
                             when not p_ok and p_retry_in_seconds is not null
                               then now() + make_interval(secs => greatest(p_retry_in_seconds, 1))
                             else next_attempt_at
                           end,
         response_status = p_response_status,
         response_body = left(p_response_body, 1000),
         error = left(p_error, 500),
         delivered_at = case when p_ok then now() else delivered_at end
   where id = p_delivery_id
  returning endpoint_id into v_endpoint;

  if v_endpoint is null then return; end if;

  if p_ok then
    update public.webhook_endpoints
       set consecutive_failures = 0, failing_since = null, last_success_at = now()
     where id = v_endpoint;
    return;
  end if;

  update public.webhook_endpoints
     set consecutive_failures = consecutive_failures + 1,
         failing_since = coalesce(failing_since, now()),
         last_failure_at = now()
   where id = v_endpoint;

  update public.webhook_endpoints
     set active = false,
         disabled_reason = coalesce(
           p_disable_reason,
           format('Automatisch uitgezet: sinds %s mislukte elke bezorging (%s keer). Controleer het adres en zet het eindpunt weer aan.',
                  to_char(failing_since at time zone 'Europe/Amsterdam', 'DD-MM-YYYY HH24:MI'), consecutive_failures)
         )
   where id = v_endpoint
     and active
     and (p_disable_reason is not null
          or (consecutive_failures >= 25 and failing_since < now() - interval '24 hours'));
end;
$$;

revoke all on function public.finish_webhook_delivery(uuid, boolean, integer, text, text, integer, text) from public, anon, authenticated;
grant execute on function public.finish_webhook_delivery(uuid, boolean, integer, text, text, integer, text) to service_role;

-- ── 6. Vanuit de app: aan/uit, omschrijving, verwijderen ────────────────────
--
-- Adres en gebeurtenissen wijzigen gaat via api-admin, want daar wordt het
-- adres gecontroleerd (geen intern netwerk) en de lijst tegen de catalogus
-- gelegd. Aan- en uitzetten en verwijderen kan rechtstreeks: "stop hiermee"
-- hoort het ook te doen als er verderop iets stuk is.
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
  return new;
end;
$$;

drop trigger if exists webhook_endpoints_guard_update on public.webhook_endpoints;
create trigger webhook_endpoints_guard_update
  before update on public.webhook_endpoints
  for each row execute function public.webhook_endpoints_guard_update();

-- Het auditlog: aanmaken, verwijderen, en een ander adres, andere gebeurtenissen
-- of aan/uit. Niet de teller van mislukte bezorgingen.
drop trigger if exists webhook_endpoints_audit_write on public.webhook_endpoints;
create trigger webhook_endpoints_audit_write
  after insert or delete on public.webhook_endpoints
  for each row execute function public.audit_row_change('webhook_endpoint', 'url');

drop trigger if exists webhook_endpoints_audit_update on public.webhook_endpoints;
create trigger webhook_endpoints_audit_update
  after update on public.webhook_endpoints
  for each row
  when (old.url is distinct from new.url or old.events is distinct from new.events
        or old.active is distinct from new.active or old.description is distinct from new.description)
  execute function public.audit_row_change('webhook_endpoint', 'url');

-- ── 7. Een ingetrokken sleutel neemt zijn eindpunten mee ────────────────────
--
-- Een eindpunt dat een koppeling via de API aanmaakte, hoort bij die sleutel.
-- Wordt hij ingetrokken, dan stopt ook de stroom berichten — anders blijft een
-- koppeling die je juist wilde afsluiten gewoon gegevens ontvangen.
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
           result = coalesce(result, '{}'::jsonb) || jsonb_build_object('detail', 'De API-sleutel is ingetrokken.')
     where api_key_id = new.id and status = 'proposed';
    delete from public.webhook_endpoints where api_key_id = new.id;
  end if;
  return new;
end;
$$;

-- ── 8. RLS ──────────────────────────────────────────────────────────────────
alter table public.webhook_endpoint_secrets enable row level security;
revoke all on public.webhook_endpoint_secrets from anon, authenticated;

alter table public.webhook_endpoints enable row level security;
revoke insert, truncate on public.webhook_endpoints from anon, authenticated;

drop policy if exists "webhook_endpoints admin read" on public.webhook_endpoints;
create policy "webhook_endpoints admin read" on public.webhook_endpoints for select using (
  public.can_admin_org(organization_id)
);

drop policy if exists "webhook_endpoints admin update" on public.webhook_endpoints;
create policy "webhook_endpoints admin update" on public.webhook_endpoints for update using (
  public.can_admin_org(organization_id)
) with check (
  public.can_admin_org(organization_id)
);

drop policy if exists "webhook_endpoints admin delete" on public.webhook_endpoints;
create policy "webhook_endpoints admin delete" on public.webhook_endpoints for delete using (
  public.can_admin_org(organization_id)
);

-- Gebeurtenissen en bezorgingen: alleen lezen, voor het overzicht van wat er
-- verstuurd is en hoe het afliep. Schrijven doen alleen de trigger en de
-- dispatcher.
alter table public.webhook_events enable row level security;
revoke insert, update, delete, truncate on public.webhook_events from anon, authenticated;

drop policy if exists "webhook_events admin read" on public.webhook_events;
create policy "webhook_events admin read" on public.webhook_events for select using (
  public.can_admin_org(organization_id)
);

alter table public.webhook_deliveries enable row level security;
revoke insert, update, delete, truncate on public.webhook_deliveries from anon, authenticated;

drop policy if exists "webhook_deliveries admin read" on public.webhook_deliveries;
create policy "webhook_deliveries admin read" on public.webhook_deliveries for select using (
  public.can_admin_org(organization_id)
);

commit;
