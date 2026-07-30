-- ============================================================
-- ResoFly — Modulerechten per teamlid
-- Date: 2026-07-30
--
-- Tot nu toe was toegang organisatiebreed: wie 'member' was, zag álles —
-- klanten, projecten, uren én de volledige financiële module. Owners/admins
-- kunnen vanaf nu per teamlid en per module instellen wat diegene mag:
--
--     geen  → module is onzichtbaar (geen enkele rij leesbaar)
--     read  → alleen lezen
--     write → volledig (lezen + wijzigen)
--
-- Opslag: organization_members.module_access (jsonb), bijv.
--     {"finance":"none","time":"read"}
-- Een ONTBREKENDE sleutel betekent bewust "volledig". Zo houden alle
-- bestaande teamleden na deze migratie precies de toegang die ze nu hebben en
-- zet de owner gericht modules dicht, in plaats van andersom.
--
-- Handhaving in drie lagen — de UI is nadrukkelijk NIET de beveiliging:
--   1. RESTRICTIVE RLS-policies per moduletabel. Restrictive policies worden
--      ge-AND met de bestaande permissive policies, dus geen enkele bestaande
--      policy hoeft herschreven te worden. Ze staan op `to authenticated`,
--      zodat de publieke portaal-/anon-paden (die via security definer-RPC's
--      lopen) ongemoeid blijven.
--   2. Een BEFORE-trigger per moduletabel. RLS wordt namelijk omzeild door
--      `security definer`-RPC's; een trigger niet. Draait auth.uid() leeg
--      (service_role, pg_cron, workers), dan laat de trigger door — die paden
--      hebben hun eigen autorisatie.
--   3. Frontend-gating (zijbalk, pagina's, knoppen) voor de beleving.
--
-- Owners en admins zijn per definitie niet te beperken: zij stellen de rechten
-- juist in. Een 'viewer' kan door module_access nooit méér dan lezen krijgen.
-- ============================================================

begin;

-- ── 1. Opslag ────────────────────────────────────────────────────────────────

alter table public.organization_members
  add column if not exists module_access jsonb not null default '{}'::jsonb;

alter table public.organization_invitations
  add column if not exists module_access jsonb not null default '{}'::jsonb;

comment on column public.organization_members.module_access is
  'Per module het rechtenniveau (none/read/write). Ontbrekende sleutel = volledig. Genegeerd voor owner/admin.';
comment on column public.organization_invitations.module_access is
  'Modulerechten die het teamlid krijgt zodra de uitnodiging wordt geaccepteerd.';

-- ── 2. Modulesleutels + validatie ────────────────────────────────────────────

create or replace function public.module_keys()
returns text[]
language sql
immutable
as $$
  select array[
    'clients',    -- Klanten, contactpersonen, klant-mail
    'projects',   -- Projecten, taken, weekplanner, archief, projectsjablonen
    'time',       -- Urenregistratie
    'calendar',   -- Agenda, gekoppelde agenda's, boekingslinks, meetings
    'tickets',    -- Tickets
    'content',    -- Inhoud: notities, documenten, mappen
    'stats',      -- Statistieken / rapportages
    'marketing',  -- Campagnes en e-mailstromen
    'finance',    -- Offertes, contracten, facturen, inkoop, boekhouding, bank
    'chat',       -- Teamchat
    'gerrie'      -- Gerrie (AI-assistent)
  ];
$$;

create or replace function public.validate_module_access()
returns trigger
language plpgsql
as $$
declare
  v_key   text;
  v_value text;
begin
  if new.module_access is null then
    new.module_access := '{}'::jsonb;
  end if;

  if jsonb_typeof(new.module_access) <> 'object' then
    raise exception 'module_access moet een JSON-object zijn' using errcode = '22023';
  end if;

  for v_key, v_value in
    select key, value #>> '{}' from jsonb_each(new.module_access)
  loop
    if not (v_key = any(public.module_keys())) then
      raise exception 'Onbekende module in module_access: %', v_key using errcode = '22023';
    end if;
    if v_value is null or v_value not in ('none', 'read', 'write') then
      raise exception 'Ongeldig rechtenniveau voor module %: % (verwacht none/read/write)', v_key, coalesce(v_value, 'null')
        using errcode = '22023';
    end if;
  end loop;

  return new;
end;
$$;

drop trigger if exists organization_members_validate_module_access on public.organization_members;
create trigger organization_members_validate_module_access
  before insert or update of module_access on public.organization_members
  for each row execute function public.validate_module_access();

drop trigger if exists organization_invitations_validate_module_access on public.organization_invitations;
create trigger organization_invitations_validate_module_access
  before insert or update of module_access on public.organization_invitations
  for each row execute function public.validate_module_access();

-- ── 3. Toegangshelpers ───────────────────────────────────────────────────────

-- Het effectieve niveau van de INGELOGDE gebruiker voor één module.
-- NULL = geen (actief) lid van deze organisatie.
create or replace function public.org_module_level(p_organization_id uuid, p_module text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    -- Owners/admins beheren de rechten en zijn daarom zelf nooit beperkt.
    when m.role in ('owner', 'admin') then 'write'
    -- Een viewer mag nooit meer dan lezen, ongeacht wat er is ingesteld.
    when m.role = 'viewer' then
      case when coalesce(nullif(m.module_access ->> p_module, ''), 'write') = 'none' then 'none' else 'read' end
    -- Ontbrekende sleutel = volledig (achterwaarts compatibel).
    else coalesce(nullif(m.module_access ->> p_module, ''), 'write')
  end
  from public.organization_members m
  where m.organization_id = p_organization_id
    and m.user_id = auth.uid()
    and m.status = 'active'
  limit 1;
$$;

create or replace function public.can_read_module(p_organization_id uuid, p_module text)
returns boolean
language sql
stable
as $$
  select coalesce(public.org_module_level(p_organization_id, p_module), 'none') in ('read', 'write');
$$;

create or replace function public.can_write_module(p_organization_id uuid, p_module text)
returns boolean
language sql
stable
as $$
  select coalesce(public.org_module_level(p_organization_id, p_module), 'none') = 'write';
$$;

-- Alle modulerechten van de ingelogde gebruiker in één keer — de frontend haalt
-- hiermee in één call op wat er in de zijbalk mag verschijnen.
create or replace function public.my_module_access(p_organization_id uuid)
returns jsonb
language sql
stable
as $$
  select coalesce(
    jsonb_object_agg(k, public.org_module_level(p_organization_id, k)),
    '{}'::jsonb
  )
  from unnest(public.module_keys()) as k
  where public.org_module_level(p_organization_id, k) is not null;
$$;

-- ── 4. Schrijf-trigger (dicht het security definer-gat) ──────────────────────

create or replace function public.enforce_module_write_access()
returns trigger
language plpgsql
as $$
declare
  v_org     uuid;
  v_module  text := TG_ARGV[0];
  -- 'write' = alleen volledige rechten mogen schrijven (standaard).
  -- 'read'  = lezers mogen ook schrijven; voor persoonlijke bijhoud-tabellen
  --           zoals "gelezen"-markeringen, die niets over de module zeggen.
  v_level   text := coalesce(TG_ARGV[1], 'write');
  v_allowed boolean;
begin
  -- service_role, pg_cron en de workers draaien zonder JWT. Die paden hebben
  -- hun eigen autorisatie; hier niet blokkeren (anders breekt elke cron-taak).
  if auth.uid() is null then
    if TG_OP = 'DELETE' then return old; end if;
    return new;
  end if;

  if TG_OP = 'DELETE' then
    v_org := old.organization_id;
  else
    v_org := new.organization_id;
  end if;

  if v_level = 'read' then
    v_allowed := public.can_read_module(v_org, v_module);
  else
    v_allowed := public.can_write_module(v_org, v_module);
  end if;

  if not v_allowed then
    raise exception 'Geen toegang tot de module % in deze organisatie.', v_module
      using errcode = '42501';
  end if;

  if TG_OP = 'DELETE' then return old; end if;
  return new;
end;
$$;

-- ── 5. Generator: policies + trigger per (tabel, module) ─────────────────────

create or replace function public.apply_module_gate(
  p_table text,
  p_module text,
  p_write_level text default 'write'
)
returns void
language plpgsql
as $$
declare
  -- Voor de meeste tabellen mag alleen 'write' schrijven. Persoonlijke
  -- bijhoud-tabellen (gelezen-markeringen) mogen ook door lezers geschreven
  -- worden — anders krijgt een lees-only teamlid een foutmelding zodra hij
  -- een ticket of chatbericht opent.
  v_write_fn text := case when p_write_level = 'read' then 'can_read_module' else 'can_write_module' end;
begin
  if p_write_level not in ('read', 'write') then
    raise exception 'Ongeldig schrijfniveau: %', p_write_level;
  end if;

  execute format('drop policy if exists %I on public.%I', 'module gate select', p_table);
  execute format('drop policy if exists %I on public.%I', 'module gate insert', p_table);
  execute format('drop policy if exists %I on public.%I', 'module gate update', p_table);
  execute format('drop policy if exists %I on public.%I', 'module gate delete', p_table);

  execute format(
    'create policy %I on public.%I as restrictive for select to authenticated using (public.can_read_module(organization_id, %L))',
    'module gate select', p_table, p_module);
  execute format(
    'create policy %I on public.%I as restrictive for insert to authenticated with check (public.%I(organization_id, %L))',
    'module gate insert', p_table, v_write_fn, p_module);
  execute format(
    'create policy %I on public.%I as restrictive for update to authenticated using (public.%I(organization_id, %L)) with check (public.%I(organization_id, %L))',
    'module gate update', p_table, v_write_fn, p_module, v_write_fn, p_module);
  execute format(
    'create policy %I on public.%I as restrictive for delete to authenticated using (public.%I(organization_id, %L))',
    'module gate delete', p_table, v_write_fn, p_module);

  -- Naam met zzz_ zodat de gate ná eventuele andere BEFORE-triggers draait en
  -- organization_id dus zeker gevuld is.
  execute format('drop trigger if exists zzz_module_write_gate on public.%I', p_table);
  execute format(
    'create trigger zzz_module_write_gate before insert or update or delete on public.%I for each row execute function public.enforce_module_write_access(%L, %L)',
    p_table, p_module, p_write_level);
end;
$$;

revoke all on function public.apply_module_gate(text, text, text) from public, anon, authenticated;

-- ── 6. De koppeling tabel → module ───────────────────────────────────────────

do $$
declare
  v_map     text[][] := array[
    -- Klanten
    ['clients',                      'clients'],
    ['client_contacts',              'clients'],
    ['client_email_threads',         'clients'],
    ['client_emails',                'clients'],
    ['client_email_reads',           'clients'],
    ['client_email_events',          'clients'],
    -- Projecten (incl. taken, weekplanner, archief, sjablonen)
    ['projects',                     'projects'],
    ['tasks',                        'projects'],
    ['project_members',              'projects'],
    ['task_assignees',               'projects'],
    ['project_templates',            'projects'],
    ['project_template_tasks',       'projects'],
    -- Uren
    ['time_entries',                 'time'],
    -- Agenda en meetings
    ['calendar_events',              'calendar'],
    ['calendar_connections',         'calendar'],
    ['calendar_sources',             'calendar'],
    ['calendar_event_attendees',     'calendar'],
    ['calendar_event_links',         'calendar'],
    ['calendar_app_passwords',       'calendar'],
    ['note_calendar_links',          'calendar'],
    ['meeting_booking_links',        'calendar'],
    ['meeting_booking_slots',        'calendar'],
    ['meeting_bookings',             'calendar'],
    ['meeting_recordings',           'calendar'],
    -- Tickets
    ['tickets',                      'tickets'],
    ['ticket_notes',                 'tickets'],
    ['ticket_reads',                 'tickets'],
    -- Inhoud
    ['notes',                        'content'],
    ['documents',                    'content'],
    ['content_folders',              'content'],
    -- Statistieken
    ['saved_reports',                'stats'],
    -- Marketing
    ['email_campaigns',              'marketing'],
    ['email_campaign_recipients',    'marketing'],
    ['email_flows',                  'marketing'],
    ['email_flow_steps',             'marketing'],
    ['email_flow_enrollments',       'marketing'],
    ['email_flow_sends',             'marketing'],
    ['email_suppressions',           'marketing'],
    -- Financiën: offertes
    ['quotes',                       'finance'],
    ['quote_versions',               'finance'],
    ['quote_version_items',          'finance'],
    ['quote_approval_events',        'finance'],
    ['quote_email_deliveries',       'finance'],
    ['quote_email_events',           'finance'],
    -- Financiën: facturen
    ['invoices',                     'finance'],
    ['invoice_versions',             'finance'],
    ['invoice_version_items',        'finance'],
    ['invoice_workflow_events',      'finance'],
    ['invoice_email_deliveries',     'finance'],
    ['invoice_email_events',         'finance'],
    ['invoice_payment_records',      'finance'],
    ['invoice_public_links',         'finance'],
    ['invoice_refunds',              'finance'],
    ['invoice_chargebacks',          'finance'],
    ['invoice_dunning_notices',      'finance'],
    ['invoice_reminder_settings',    'finance'],
    ['credit_notes',                 'finance'],
    -- Financiën: contracten
    ['contracts',                    'finance'],
    ['contract_versions',            'finance'],
    ['contract_events',              'finance'],
    ['contract_signers',             'finance'],
    ['contract_templates',           'finance'],
    ['contract_internal_notes',      'finance'],
    ['contract_email_deliveries',    'finance'],
    ['contract_email_events',        'finance'],
    -- Financiën: inkoop en boekhouding
    ['suppliers',                    'finance'],
    ['purchase_invoices',            'finance'],
    ['ledger_accounts',              'finance'],
    ['vat_codes',                    'finance'],
    ['journal_entries',              'finance'],
    ['journal_lines',                'finance'],
    ['closed_periods',               'finance'],
    ['fiscal_years',                 'finance'],
    ['fixed_assets',                 'finance'],
    ['asset_depreciations',          'finance'],
    ['vat_returns',                  'finance'],
    ['vat_supplement_entries',       'finance'],
    ['finance_provider_jobs',        'finance'],
    -- Financiën: bank
    ['bank_accounts',                'finance'],
    ['bank_statements',              'finance'],
    ['bank_transactions',            'finance'],
    ['bank_rules',                   'finance'],
    ['bank_requisitions',            'finance'],
    -- Teamchat
    ['chat_conversations',           'chat'],
    ['chat_participants',            'chat'],
    ['chat_messages',                'chat'],
    ['chat_message_reactions',       'chat'],
    -- Gerrie (AI)
    ['ai_conversations',             'gerrie'],
    ['ai_messages',                  'gerrie'],
    ['ai_usage',                     'gerrie'],
    ['ai_agents',                    'gerrie'],
    ['ai_agent_runs',                'gerrie'],
    ['ai_action_audit',              'gerrie']
  ];
  -- Persoonlijke bijhoud-tabellen: ook een lees-only teamlid moet zijn eigen
  -- "gelezen"-markering kunnen wegschrijven. Ze bevatten geen module-inhoud.
  v_read_level text[] := array['ticket_reads', 'client_email_reads', 'chat_participants'];
  v_table      text;
  v_module     text;
  v_problems   text[] := array[]::text[];
  i            int;
begin
  for i in 1 .. array_length(v_map, 1) loop
    v_table  := v_map[i][1];
    v_module := v_map[i][2];

    if to_regclass('public.' || quote_ident(v_table)) is null then
      v_problems := v_problems || format('tabel public.%s bestaat niet', v_table);
      continue;
    end if;

    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = v_table and column_name = 'organization_id'
    ) then
      v_problems := v_problems || format('public.%s heeft geen kolom organization_id', v_table);
      continue;
    end if;

    -- Zonder ingeschakelde RLS doet een restrictive policy niets: dat zou een
    -- stil gat zijn. Liever de migratie laten falen dan schijnveiligheid.
    if not exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = v_table and c.relrowsecurity
    ) then
      v_problems := v_problems || format('public.%s heeft row level security uit staan', v_table);
      continue;
    end if;

    perform public.apply_module_gate(
      v_table,
      v_module,
      case when v_table = any(v_read_level) then 'read' else 'write' end
    );
  end loop;

  if array_length(v_problems, 1) > 0 then
    raise exception 'Modulerechten niet toegepast: %', array_to_string(v_problems, '; ');
  end if;
end;
$$;

-- ── 7. Bijlagen: module volgt het type entiteit ──────────────────────────────
--
-- attachments hangt aan van alles (klant, taak, factuur, chatbericht, …), dus
-- één vaste module klopt niet. We leiden hem af uit entity_type. Een ONBEKEND
-- type geeft bewust `null` = niet afgeschermd: een nieuw entity_type mag nooit
-- stilletjes alle uploads breken (dat is eerder misgegaan bij de
-- org-integriteitstrigger).

create or replace function public.attachment_module(p_entity_type text)
returns text
language sql
immutable
as $$
  select case p_entity_type
    when 'client'           then 'clients'
    when 'project'          then 'projects'
    when 'task'             then 'projects'
    when 'subtask'          then 'projects'
    when 'ticket'           then 'tickets'
    when 'note'             then 'content'
    when 'document'         then 'content'
    when 'folder'           then 'content'
    when 'quote'            then 'finance'
    when 'invoice'          then 'finance'
    when 'supplier'         then 'finance'
    when 'purchase_invoice' then 'finance'
    when 'fixed_asset'      then 'finance'
    when 'chat_message'     then 'chat'
    else null
  end;
$$;

drop policy if exists "module gate select" on public.attachments;
drop policy if exists "module gate insert" on public.attachments;
drop policy if exists "module gate update" on public.attachments;
drop policy if exists "module gate delete" on public.attachments;

create policy "module gate select" on public.attachments as restrictive for select to authenticated
  using (
    public.attachment_module(entity_type) is null
    or public.can_read_module(organization_id, public.attachment_module(entity_type))
  );
create policy "module gate insert" on public.attachments as restrictive for insert to authenticated
  with check (
    public.attachment_module(entity_type) is null
    or public.can_write_module(organization_id, public.attachment_module(entity_type))
  );
create policy "module gate update" on public.attachments as restrictive for update to authenticated
  using (
    public.attachment_module(entity_type) is null
    or public.can_write_module(organization_id, public.attachment_module(entity_type))
  )
  with check (
    public.attachment_module(entity_type) is null
    or public.can_write_module(organization_id, public.attachment_module(entity_type))
  );
create policy "module gate delete" on public.attachments as restrictive for delete to authenticated
  using (
    public.attachment_module(entity_type) is null
    or public.can_write_module(organization_id, public.attachment_module(entity_type))
  );

create or replace function public.enforce_attachment_module_write_access()
returns trigger
language plpgsql
as $$
declare
  v_org    uuid;
  v_module text;
begin
  if auth.uid() is null then
    if TG_OP = 'DELETE' then return old; end if;
    return new;
  end if;

  if TG_OP = 'DELETE' then
    v_org := old.organization_id;
    v_module := public.attachment_module(old.entity_type);
  else
    v_org := new.organization_id;
    v_module := public.attachment_module(new.entity_type);
  end if;

  if v_module is not null and not public.can_write_module(v_org, v_module) then
    raise exception 'Geen schrijfrechten voor bijlagen in de module % van deze organisatie.', v_module
      using errcode = '42501';
  end if;

  if TG_OP = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists zzz_module_write_gate on public.attachments;
create trigger zzz_module_write_gate
  before insert or update or delete on public.attachments
  for each row execute function public.enforce_attachment_module_write_access();

-- ── 8. Beheer-RPC: modulerechten van een teamlid zetten ──────────────────────

create or replace function public.set_member_module_access(p_member_id uuid, p_module_access jsonb)
returns public.organization_members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member public.organization_members;
begin
  if auth.uid() is null then
    raise exception 'Niet ingelogd' using errcode = '28000';
  end if;

  select * into v_member from public.organization_members where id = p_member_id for update;
  if not found then
    raise exception 'Teamlid niet gevonden' using errcode = 'P0002';
  end if;

  if not public.user_has_org_role(v_member.organization_id, array['owner', 'admin']) then
    raise exception 'Alleen owners en admins mogen modulerechten aanpassen' using errcode = '42501';
  end if;

  if v_member.role = 'owner' then
    raise exception 'Een owner heeft altijd toegang tot alle modules' using errcode = '42501';
  end if;

  -- Een admin mag geen andere admin beperken; dat blijft aan de owner.
  if v_member.role = 'admin' and not public.user_has_org_role(v_member.organization_id, array['owner']) then
    raise exception 'Alleen een owner kan de rechten van een admin aanpassen' using errcode = '42501';
  end if;

  update public.organization_members
  set module_access = coalesce(p_module_access, '{}'::jsonb),
      updated_at = now()
  where id = p_member_id
  returning * into v_member;

  return v_member;
end;
$$;

-- ── 9. Uitnodigen mét modulerechten ──────────────────────────────────────────

drop function if exists public.invite_organization_member(uuid, citext, text);

create or replace function public.invite_organization_member(
  p_organization_id uuid,
  p_email citext,
  p_role text,
  p_module_access jsonb default '{}'::jsonb
)
returns public.organization_invitations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id     uuid := auth.uid();
  v_clean_email citext := lower(trim(p_email::text))::citext;
  v_access      jsonb := coalesce(p_module_access, '{}'::jsonb);
  v_invitation  public.organization_invitations;
begin
  if v_user_id is null then raise exception 'Niet ingelogd' using errcode = '28000'; end if;
  if not public.user_has_org_role(p_organization_id, array['owner','admin']) then
    raise exception 'Alleen owners/admins mogen teamleden uitnodigen' using errcode = '42501';
  end if;
  if p_role not in ('admin','member','viewer') then
    raise exception 'Ongeldige organisatierol' using errcode = '23514';
  end if;
  if nullif(trim(p_email::text), '') is null then
    raise exception 'E-mailadres ontbreekt' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.organization_members
    where organization_id = p_organization_id
      and email = v_clean_email
      and status = 'active'
  ) then
    raise exception 'Dit e-mailadres is al actief lid van deze organisatie.' using errcode = '23505';
  end if;

  insert into public.organization_invitations(organization_id, email, role, module_access, consumes_license, invited_by, status, expires_at)
  values (p_organization_id, v_clean_email, p_role, v_access, true, v_user_id, 'pending', now() + interval '14 days')
  on conflict (organization_id, email) where status = 'pending'
  do update set
    role = excluded.role,
    module_access = excluded.module_access,
    consumes_license = true,
    invited_by = excluded.invited_by,
    expires_at = excluded.expires_at,
    updated_at = now()
  returning * into v_invitation;

  return v_invitation;
end;
$$;

-- Accepteren neemt de bij de uitnodiging vastgelegde modulerechten over.
create or replace function public.accept_organization_invitation(p_invitation_id uuid)
returns public.organization_members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id    uuid := auth.uid();
  v_email      citext := public.current_user_email();
  v_invitation public.organization_invitations;
  v_member     public.organization_members;
begin
  if v_user_id is null then raise exception 'Niet ingelogd' using errcode = '28000'; end if;
  if v_email is null then raise exception 'Geen e-mail bekend in sessie' using errcode = '23514'; end if;

  select * into v_invitation
  from public.organization_invitations
  where id = p_invitation_id
    and status = 'pending'
    and email = v_email
    and (expires_at is null or expires_at > now())
  for update;

  if not found then
    raise exception 'Uitnodiging niet gevonden of verlopen' using errcode = 'P0002';
  end if;

  update public.organization_invitations
  set status = 'accepted', consumes_license = false, accepted_by = v_user_id, accepted_at = now(), updated_at = now()
  where id = v_invitation.id;

  insert into public.organization_members(organization_id, user_id, email, role, module_access, status, invited_by, joined_at)
  values (v_invitation.organization_id, v_user_id, v_email, v_invitation.role, coalesce(v_invitation.module_access, '{}'::jsonb), 'active', v_invitation.invited_by, now())
  on conflict (organization_id, user_id)
  do update set
    role = excluded.role,
    module_access = excluded.module_access,
    status = 'active',
    email = excluded.email,
    updated_at = now()
  returning * into v_member;

  return v_member;
end;
$$;

-- ── 10. Rechten ──────────────────────────────────────────────────────────────

grant execute on function public.module_keys() to authenticated, service_role;
grant execute on function public.org_module_level(uuid, text) to authenticated, service_role;
grant execute on function public.can_read_module(uuid, text) to authenticated, service_role;
grant execute on function public.can_write_module(uuid, text) to authenticated, service_role;
grant execute on function public.my_module_access(uuid) to authenticated, service_role;
grant execute on function public.attachment_module(text) to authenticated, service_role;
grant execute on function public.set_member_module_access(uuid, jsonb) to authenticated;
grant execute on function public.invite_organization_member(uuid, citext, text, jsonb) to authenticated;
grant execute on function public.accept_organization_invitation(uuid) to authenticated;

commit;
