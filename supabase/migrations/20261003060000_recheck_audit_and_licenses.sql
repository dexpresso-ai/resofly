-- ============================================================
-- ResoFly — Herkontrole: het auditlog en de licentietelling
-- Date: 2026-10-03
--
-- Uit de herkontrole van de volledige API-controle:
--
--   1. HET AUDITLOG LIET TE VEEL ZIEN. Elk lid van de organisatie las elke
--      regel (`can_read_org`), en het label van een regel is de naam, titel of
--      het e-mailadres uit de rij die veranderde. Zo zag een teamlid zonder
--      Financiën de nummers van facturen en de omschrijving van boekingen,
--      zag iedereen de e-mailadressen van uitnodigingen (die de app juist voor
--      owners en admins houdt — en die team.list_invitations nu ook weigert),
--      de namen van API-sleutels en de titels van afspraken in andermans
--      privé-agenda. Nu:
--        - een regel hoort bij een module (audit_entity_module); een teamlid
--          leest hem alleen met leesrecht in die module;
--        - uitnodigingen, sleutels, webhooks, agendakoppelingen, abonnement en
--          betalingen zijn voor owners en admins — net als de rijen zelf;
--        - een afspraak, koppeling of agenda in een PRIVÉ-agenda krijgt een
--          neutraal label ("Privé-afspraak", "Privé-agenda"); bestaande regels
--          worden net zo opgeschoond.
--   2. DE LICENTIETELLING faalde altijd vanuit de server (team.license_usage,
--      en de plan-stap van team.invite): organization_license_usage controleerde
--      het lidmaatschap via auth.uid(), die er voor de service-role niet is.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1a. Bij welke module hoort een regel? ──────────────────────────────────
--
-- 'admin' = alleen owners/admins; null = iedereen in de organisatie. Wat hier
-- (nog) niet staat, is voor owners/admins — tot het een plek krijgt. Dezelfde
-- lijst staat als AUDIT_ENTITY_MODULE in _shared/actions/admin.ts
-- (auditVisibility.test.ts houdt ze gelijk).
create or replace function public.audit_entity_module(p_entity_type text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_entity_type in ('member', 'organization') then null
    when p_entity_type in ('api_key', 'webhook_endpoint', 'invitation', 'calendar_connection', 'subscription',
                           'billing_profile', 'billing_event', 'payment', 'license_change', 'license_event') then 'admin'
    when p_entity_type in ('annual_account', 'annual_account_filing', 'annual_account_signature', 'bank_account', 'bank_rule',
                           'company_settings', 'contract', 'contract_note', 'contract_project', 'contract_template',
                           'corporate_tax_return', 'credit_note', 'dividend_distribution', 'fiscal_year', 'fiscal_year_size_input',
                           'fixed_asset', 'invoice', 'journal_entry', 'ledger_account', 'purchase_invoice', 'quote',
                           'result_appropriation', 'share_transaction', 'shareholder', 'supplier', 'vat_return') then 'finance'
    when p_entity_type in ('calendar_event', 'calendar_event_link', 'calendar_source', 'note_calendar_link') then 'calendar'
    when p_entity_type in ('client', 'client_call', 'client_contact') then 'clients'
    when p_entity_type in ('project', 'project_member', 'project_template', 'project_template_task', 'task', 'task_assignee') then 'projects'
    when p_entity_type in ('ticket', 'ticket_note') then 'tickets'
    when p_entity_type in ('time_entry') then 'time'
    when p_entity_type in ('attachment', 'content_folder', 'document', 'drive_share', 'note', 'note_handwriting') then 'content'
    when p_entity_type in ('saved_report') then 'stats'
    else 'admin'
  end;
$$;

-- ── 1b. Wie leest welke regel ───────────────────────────────────────────────
drop policy if exists "audit logs read by org members" on public.audit_logs;
create policy "audit logs read by org members" on public.audit_logs for select using (
  public.can_read_org(organization_id)
  and (
    public.can_admin_org(organization_id)
    or public.audit_entity_module(entity_type) is null
    or (public.audit_entity_module(entity_type) <> 'admin'
        and public.can_read_module(organization_id, public.audit_entity_module(entity_type)))
  )
);

-- ── 1c. Een privé-agenda geeft geen titel prijs ─────────────────────────────
--
-- Vóór het wegschrijven: is de agenda (nu) gedeeld met de organisatie? Zo niet
-- — of is de rij al weg, zoals bij verwijderen — dan een neutraal label. Bij
-- twijfel dus maskeren. Het label is het enige wat er van de rij in de regel
-- staat (metadata: alleen kolomnamen).
create or replace function public.audit_logs_mask_private_calendar()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shared boolean;
begin
  if new.entity_type = 'calendar_event' then
    select s.visibility = 'organization' into v_shared
      from public.calendar_events e join public.calendar_sources s on s.id = e.source_id
     where e.id = new.entity_id;
    if not coalesce(v_shared, false) then new.entity_label := 'Privé-afspraak'; end if;
  elsif new.entity_type = 'calendar_event_link' then
    select s.visibility = 'organization' into v_shared
      from public.calendar_event_links l join public.calendar_sources s on s.id = l.calendar_source_id
     where l.id = new.entity_id;
    if not coalesce(v_shared, false) then new.entity_label := 'Privé-afspraak'; end if;
  elsif new.entity_type = 'note_calendar_link' then
    select l.visibility_snapshot = 'organization' and not l.is_private_masked_snapshot and s.visibility = 'organization' into v_shared
      from public.note_calendar_links l join public.calendar_sources s on s.id = l.calendar_source_id
     where l.id = new.entity_id;
    if not coalesce(v_shared, false) then new.entity_label := 'Privé-afspraak'; end if;
  elsif new.entity_type = 'calendar_source' then
    select s.visibility = 'organization' into v_shared from public.calendar_sources s where s.id = new.entity_id;
    if not coalesce(v_shared, false) then new.entity_label := 'Privé-agenda'; end if;
  end if;
  return new;
exception when others then
  -- Nooit het loggen (en daarmee de wijziging zelf) laten stranden; dan liever geen titel.
  if new.entity_type in ('calendar_event', 'calendar_event_link', 'note_calendar_link') then new.entity_label := 'Privé-afspraak';
  elsif new.entity_type = 'calendar_source' then new.entity_label := 'Privé-agenda';
  end if;
  return new;
end;
$$;

revoke all on function public.audit_logs_mask_private_calendar() from public, anon, authenticated;

drop trigger if exists audit_logs_mask_private_calendar on public.audit_logs;
create trigger audit_logs_mask_private_calendar
  before insert on public.audit_logs
  for each row execute function public.audit_logs_mask_private_calendar();

-- Wat er al stond, net zo: alleen een titel als de agenda nu gedeeld is.
update public.audit_logs a set entity_label = 'Privé-afspraak'
 where a.entity_type = 'calendar_event' and a.entity_label is distinct from 'Privé-afspraak'
   and not exists (select 1 from public.calendar_events e join public.calendar_sources s on s.id = e.source_id
                    where e.id = a.entity_id and s.visibility = 'organization');
update public.audit_logs a set entity_label = 'Privé-afspraak'
 where a.entity_type = 'calendar_event_link' and a.entity_label is distinct from 'Privé-afspraak'
   and not exists (select 1 from public.calendar_event_links l join public.calendar_sources s on s.id = l.calendar_source_id
                    where l.id = a.entity_id and s.visibility = 'organization');
update public.audit_logs a set entity_label = 'Privé-afspraak'
 where a.entity_type = 'note_calendar_link' and a.entity_label is distinct from 'Privé-afspraak'
   and not exists (select 1 from public.note_calendar_links l join public.calendar_sources s on s.id = l.calendar_source_id
                    where l.id = a.entity_id and l.visibility_snapshot = 'organization' and not l.is_private_masked_snapshot
                      and s.visibility = 'organization');
update public.audit_logs a set entity_label = 'Privé-agenda'
 where a.entity_type = 'calendar_source' and a.entity_label is distinct from 'Privé-agenda'
   and not exists (select 1 from public.calendar_sources s where s.id = a.entity_id and s.visibility = 'organization');

-- ── 2. De licentietelling, ook voor de server ───────────────────────────────
--
-- Zoals in 20260807000000, met één verschil: de service-role (de handelingen,
-- met de organisatie uit de sessie of de sleutel) hoeft geen lid te zijn.
drop function if exists public.organization_license_usage(uuid);
create function public.organization_license_usage(p_organization_id uuid)
returns table (
  organization_id uuid,
  licensed_seats integer,
  active_members integer,
  pending_invitations integer,
  used_seats integer,
  available_seats integer,
  license_status text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_root uuid;
  v_family uuid[];
begin
  if auth.role() is distinct from 'service_role' and not public.can_read_org(p_organization_id) then
    raise exception 'Geen toegang tot deze organisatie.' using errcode = '42501';
  end if;

  v_root := public.billing_root_organization(p_organization_id);
  select array(select public.org_family(p_organization_id)) into v_family;

  return query
  select
    o.id,
    o.licensed_seats,
    coalesce(active_counts.active_members, 0)::integer,
    coalesce(pending_counts.pending_invitations, 0)::integer,
    (coalesce(active_counts.active_members, 0) + coalesce(pending_counts.pending_invitations, 0))::integer,
    greatest(o.licensed_seats - (coalesce(active_counts.active_members, 0) + coalesce(pending_counts.pending_invitations, 0)), 0)::integer,
    o.license_status
  from public.organizations o
  left join lateral (
    -- distinct: dezelfde persoon in twee administraties is één seat
    select count(distinct om.user_id)::integer as active_members
    from public.organization_members om
    where om.organization_id = any(v_family) and om.status = 'active'
  ) active_counts on true
  left join lateral (
    -- idem voor openstaande uitnodigingen, op e-mailadres
    select count(distinct oi.email)::integer as pending_invitations
    from public.organization_invitations oi
    where oi.organization_id = any(v_family)
      and oi.status = 'pending'
      and oi.consumes_license = true
      and (oi.expires_at is null or oi.expires_at > now())
      and not exists (
        -- al lid ergens in de boom? dan verbruikt de uitnodiging geen extra seat
        select 1 from public.organization_members om2
        where om2.organization_id = any(v_family)
          and om2.status = 'active'
          and om2.email = oi.email
      )
  ) pending_counts on true
  where o.id = v_root;
end;
$$;

-- anon expliciet: de standaardrechten van het schema geven nieuwe functies ook aan anon.
revoke all on function public.organization_license_usage(uuid) from public, anon;
grant execute on function public.organization_license_usage(uuid) to authenticated, service_role;

commit;
