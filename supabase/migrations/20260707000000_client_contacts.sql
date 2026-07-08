-- ============================================================
-- ResoFly — Meerdere contactpersonen per klant (client_contacts)
-- Date: 2026-07-07
--
-- Scope:
-- - Een klant kan meerdere contactpersonen hebben (naam, e-mail, telefoon, rol).
-- - Per contactpersoon een aan/uit-schakelaar `gives_portal_access`: alleen
--   contactpersonen met deze schakelaar AAN (en `is_active`) krijgen toegang
--   tot het klantportaal — met dezelfde rechten als het hoofd-e-mailadres van
--   de klant (offertes goedkeuren/weigeren, facturen betalen, tickets indienen).
-- - Het bestaande losse veld clients.contact_name + clients.email blijft
--   ONGEWIJZIGD werken (inclusief bestaande portaaltoegang via dat hoofd-
--   e-mailadres) — deze lijst komt er alleen naast, voor extra mensen.
--
-- Ontwerp:
-- - portal_clients_for_email (service-role only) wordt uitgebreid met een
--   UNION: klantdossiers die bereikbaar zijn via een actieve, portaal-
--   gemachtigde contactpersoon. Hiermee hergebruikt de client-portal edge
--   function het bestaande multi-account-mechanisme (accountwisselaar)
--   zonder wijziging.
-- - "Wie heeft dit gedaan" wordt, net als bij offertes/tickets al het geval
--   is, vastgelegd als tekst-snapshot (naam/e-mail) plus een optionele FK naar
--   de specifieke contactpersoon-rij, voor traceerbaarheid zonder de
--   bestaande audit-structuur te breken.
-- - RLS op client_contacts: alleen organisatieleden (zelfde patroon als
--   clients/tickets). Het portaal leest/schrijft uitsluitend via de
--   service-role `client-portal`-edge function.
-- ============================================================

begin;

create table if not exists public.client_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  name text not null,
  email text not null,
  phone text,
  role text,
  gives_portal_access boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Validatie + normalisatie (spiegelt clients_duplicate_guard) ─────────
create or replace function public.enforce_client_contacts_guard()
returns trigger
language plpgsql
as $$
declare
  v_email_norm text;
  v_duplicate_name text;
begin
  new.name := btrim(coalesce(new.name, ''));
  if new.name = '' then
    raise exception 'Naam van de contactpersoon is verplicht.' using errcode = '23514';
  end if;

  new.email := public.normalize_client_lookup_value(new.email);
  if new.email is null then
    raise exception 'E-mailadres van de contactpersoon is verplicht.' using errcode = '23514';
  end if;
  if new.email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'Geldig e-mailadres is verplicht voor een contactpersoon.' using errcode = '23514';
  end if;

  new.phone := nullif(btrim(coalesce(new.phone, '')), '');
  new.role := nullif(btrim(coalesce(new.role, '')), '');

  v_email_norm := new.email;

  -- Serialiseer per klant, net als de klant-deduplicatie, om een race tussen
  -- twee gelijktijdige inserts met hetzelfde e-mailadres te voorkomen.
  perform pg_advisory_xact_lock(hashtext(new.client_id::text), hashtext('client_contacts_guard'));

  select cc.name into v_duplicate_name
  from public.client_contacts cc
  where cc.client_id = new.client_id
    and cc.id is distinct from new.id
    and cc.email = v_email_norm
  limit 1;

  if found then
    raise exception 'Er bestaat al een contactpersoon met dit e-mailadres bij deze klant: %.', v_duplicate_name using errcode = '23505';
  end if;

  return new;
end;
$$;

drop trigger if exists client_contacts_guard on public.client_contacts;
create trigger client_contacts_guard
  before insert or update of client_id, name, email, phone, role
  on public.client_contacts
  for each row execute function public.enforce_client_contacts_guard();

-- Org-integriteit: client_id MOET bij dezelfde organisatie horen als
-- organization_id. Zonder deze check (het bestaande patroon van o.a.
-- enforce_projects_org_integrity/enforce_tickets_org_integrity, allebei via
-- assert_same_org_reference) zou een lid van organisatie A een contactpersoon
-- kunnen registreren op een client_id van organisatie B — met
-- gives_portal_access = true zou dat portaaltoegang tot andermans klantdossier
-- opleveren via portal_clients_for_email hieronder.
create or replace function public.enforce_client_contacts_org_integrity()
returns trigger
language plpgsql
as $$
begin
  perform public.assert_same_org_reference('public.clients', new.client_id, new.organization_id, 'client_contacts.client_id');
  return new;
end;
$$;

drop trigger if exists client_contacts_org_integrity on public.client_contacts;
create trigger client_contacts_org_integrity
  before insert or update of organization_id, client_id
  on public.client_contacts
  for each row execute function public.enforce_client_contacts_org_integrity();

-- Verdedigingslaag naast de trigger hierboven (dekt ook eventuele bulk-writes
-- die de trigger-kolomlijst omzeilen).
create unique index if not exists idx_client_contacts_client_email_unique
  on public.client_contacts (client_id, email);

create index if not exists idx_client_contacts_org
  on public.client_contacts (organization_id, client_id);

-- Org-overstijgende zoekindex voor het portaal-e-mailpad, zelfde vorm als
-- idx_clients_email_portal_lookup. Alleen actieve, portaal-gemachtigde rijen.
create index if not exists idx_client_contacts_email_portal_lookup
  on public.client_contacts (public.normalize_client_lookup_value(email))
  where gives_portal_access = true and is_active = true;

drop trigger if exists client_contacts_touch_updated_at on public.client_contacts;
create trigger client_contacts_touch_updated_at
  before update on public.client_contacts
  for each row execute function public.set_updated_at();

drop trigger if exists client_contacts_prevent_org_change on public.client_contacts;
create trigger client_contacts_prevent_org_change
  before update of organization_id on public.client_contacts
  for each row execute function public.prevent_organization_id_change();

drop trigger if exists client_contacts_audit on public.client_contacts;
create trigger client_contacts_audit
  after insert or update or delete on public.client_contacts
  for each row execute function public.audit_row_change('client_contact', 'name');

alter table public.client_contacts enable row level security;

drop policy if exists "client_contacts read" on public.client_contacts;
create policy "client_contacts read" on public.client_contacts for select using (
  public.can_read_org(organization_id)
);

drop policy if exists "client_contacts insert" on public.client_contacts;
create policy "client_contacts insert" on public.client_contacts for insert with check (
  public.can_write_org(organization_id)
);

drop policy if exists "client_contacts update" on public.client_contacts;
create policy "client_contacts update" on public.client_contacts for update using (
  public.can_write_org(organization_id)
) with check (
  public.can_write_org(organization_id)
);

drop policy if exists "client_contacts delete" on public.client_contacts;
create policy "client_contacts delete" on public.client_contacts for delete using (
  public.can_write_org(organization_id)
);

-- ── Portaaltoegang: contactpersonen meetellen in portal_clients_for_email ──
-- UNION i.p.v. wijziging van de bestaande query zodat de bestaande
-- clients.email-match (en de index erop) ongewijzigd blijft. Alleen
-- contactpersonen met gives_portal_access = true én is_active = true tellen
-- mee — de aan/uit-schakelaar is hier de enige poort.
create or replace function public.portal_clients_for_email(p_email text)
returns setof public.clients
language sql
stable
security definer
set search_path = public
as $$
  select c.*
  from public.clients c
  where c.email is not null
    and public.normalize_client_lookup_value(p_email) is not null
    and public.normalize_client_lookup_value(c.email)
        = public.normalize_client_lookup_value(p_email)
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
    and public.normalize_client_lookup_value(cc.email) = public.normalize_client_lookup_value(p_email);
$$;

revoke all on function public.portal_clients_for_email(text) from public;
revoke all on function public.portal_clients_for_email(text) from anon;
revoke all on function public.portal_clients_for_email(text) from authenticated;
grant execute on function public.portal_clients_for_email(text) to service_role;

-- ── Traceerbaarheid: welke specifieke contactpersoon voerde de actie uit ──

alter table public.quotes
  add column if not exists client_decision_by_contact_id uuid references public.client_contacts(id) on delete set null;

alter table public.ticket_notes
  add column if not exists author_client_contact_id uuid references public.client_contacts(id) on delete set null;

alter table public.tickets
  add column if not exists created_by_contact_id uuid references public.client_contacts(id) on delete set null,
  add column if not exists created_by_name text,
  add column if not exists created_by_email text;

-- decide_quote_portal krijgt een extra, optionele p_contact_id-parameter. Dit
-- wijzigt de functiehandtekening (nieuwe parameter), dus eerst de oude variant
-- droppen om een dubbele overload te voorkomen.
drop function if exists public.decide_quote_portal(uuid, uuid, text, text, text, text);

create or replace function public.decide_quote_portal(
  p_quote_id uuid,
  p_organization_id uuid,
  p_kind text,
  p_name text,
  p_email text,
  p_note text default null,
  p_contact_id uuid default null
)
returns public.quotes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
  v_version public.quote_versions;
  v_sent_version_id uuid;
  v_kind text := lower(btrim(coalesce(p_kind, '')));
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de klantportaal-service mag portaalbeslissingen verwerken' using errcode = '42501';
  end if;
  if v_kind not in ('accept', 'reject') then
    raise exception 'Ongeldige beslissing: %', p_kind using errcode = '22023';
  end if;

  select * into v_quote
  from public.quotes
  where id = p_quote_id
    and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Offerte niet gevonden' using errcode = '02000';
  end if;

  if v_quote.status <> 'sent' then
    raise exception 'Deze offerte kan niet meer worden %',
      case when v_kind = 'accept' then 'geaccepteerd' else 'geweigerd' end
      using errcode = '23514';
  end if;

  if nullif(trim(coalesce(p_name, '')), '') is null then
    raise exception 'Naam is verplicht om de offerte te beslissen' using errcode = '23514';
  end if;
  if nullif(lower(trim(coalesce(p_email, ''))), '') is null
     or lower(trim(coalesce(p_email, ''))) !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'Geldig e-mailadres is verplicht om de offerte te beslissen' using errcode = '23514';
  end if;

  -- Als een contact_id is meegegeven, moet die contactpersoon daadwerkelijk bij
  -- déze klant horen — anders NULL negeren i.p.v. blind vertrouwen.
  if p_contact_id is not null and not exists (
    select 1 from public.client_contacts cc
    where cc.id = p_contact_id and cc.client_id = v_quote.client_id
  ) then
    p_contact_id := null;
  end if;

  if v_kind = 'accept' then
    if v_quote.sent_version_id is null then
      raise exception 'Deze offerte mist een verzonden versie en kan niet worden geaccepteerd' using errcode = '23514';
    end if;
    if v_quote.valid_until is not null and v_quote.valid_until < current_date then
      raise exception 'Deze offerte is verlopen en kan niet meer worden geaccepteerd' using errcode = '23514';
    end if;

    v_sent_version_id := v_quote.sent_version_id;

    update public.quotes
    set status = 'accepted',
        accepted_at = now(),
        client_decision_at = now(),
        client_decision_by_name = nullif(trim(coalesce(p_name, '')), ''),
        client_decision_by_email = nullif(lower(trim(coalesce(p_email, ''))), ''),
        client_decision_by_contact_id = p_contact_id,
        client_decision_note = nullif(trim(coalesce(p_note, '')), ''),
        accepted_sent_version_id = v_sent_version_id,
        updated_at = now()
    where id = v_quote.id
    returning * into v_quote;

    v_version := public.create_quote_version_snapshot(
      v_quote.id,
      v_quote.organization_id,
      'client_accepted',
      null,
      null,
      v_quote.last_pdf_file_name,
      v_quote.last_pdf_mime_type,
      v_quote.last_pdf_size_bytes,
      v_quote.last_pdf_sha256,
      null,
      jsonb_build_object('clientDecisionName', p_name, 'clientDecisionEmail', p_email, 'clientDecisionContactId', p_contact_id, 'acceptedSentVersionId', v_sent_version_id, 'source', 'client_portal')
    );

    perform public.insert_quote_workflow_event(
      v_quote.organization_id, v_quote.id, 'client_accepted',
      'Klant heeft de offerte geaccepteerd', nullif(trim(coalesce(p_note, '')), ''),
      jsonb_build_object('name', p_name, 'email', p_email, 'contactId', p_contact_id, 'acceptedVersionId', v_version.id, 'acceptedSentVersionId', v_sent_version_id, 'source', 'client_portal'), null);
    perform public.insert_quote_audit_event(
      v_quote.organization_id, v_quote.id, 'quote_client_accepted', v_quote.number,
      jsonb_build_object('name', p_name, 'email', p_email, 'contactId', p_contact_id, 'acceptedVersionId', v_version.id, 'acceptedSentVersionId', v_sent_version_id, 'source', 'client_portal'), null);
  else
    update public.quotes
    set status = 'rejected',
        client_decision_at = now(),
        client_decision_by_name = nullif(trim(coalesce(p_name, '')), ''),
        client_decision_by_email = nullif(lower(trim(coalesce(p_email, ''))), ''),
        client_decision_by_contact_id = p_contact_id,
        client_decision_note = nullif(trim(coalesce(p_note, '')), ''),
        updated_at = now()
    where id = v_quote.id
    returning * into v_quote;

    perform public.insert_quote_workflow_event(
      v_quote.organization_id, v_quote.id, 'client_rejected',
      'Klant heeft de offerte geweigerd', nullif(trim(coalesce(p_note, '')), ''),
      jsonb_build_object('name', p_name, 'email', p_email, 'contactId', p_contact_id, 'source', 'client_portal'), null);
    perform public.insert_quote_audit_event(
      v_quote.organization_id, v_quote.id, 'quote_client_rejected', v_quote.number,
      jsonb_build_object('name', p_name, 'email', p_email, 'contactId', p_contact_id, 'source', 'client_portal'), null);
  end if;

  select * into v_quote
  from public.quotes
  where id = p_quote_id and organization_id = p_organization_id;

  return v_quote;
end;
$$;

revoke execute on function public.decide_quote_portal(uuid, uuid, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.decide_quote_portal(uuid, uuid, text, text, text, text, uuid) to service_role;

commit;
