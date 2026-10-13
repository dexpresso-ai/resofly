-- ============================================================
-- ResoFly — Bestanden versturen (zendingen) + het hoofdadres bij Delen
-- Date: 2026-10-13
--
-- WAAROM
-- "Delen…" geeft toegang tot een map of bestand, live en per item. Wie een
-- klant iets wil STUREN — "hierbij de drukproef en de offertebijlage" — had
-- daar geen goede vorm voor: zes bestanden waren zes delingen en zes mails, een
-- contactpersoon kreeg alleen iets met volledige portaaltoegang, het hoofdadres
-- van de klant kon helemaal niets ontvangen, en wat je deelde veranderde mee
-- als het bestand later werd bewerkt. Zie BESTANDEN_VERSTUREN_ONDERZOEK_2026-10-13.md.
--
-- Een ZENDING is een bevroren pakket bestanden met een bericht, aan één of meer
-- mensen. De ontvanger krijgt geen bijlage maar een persoonlijke link; openen
-- vraagt een code die naar het eigen e-mailadres gaat (of een login op het
-- klantportaal). Na de vervaldatum — of na intrekken — verdwijnen de bestanden.
--
-- DE REGELS (in de database, niet in het scherm):
--  1. Een zending hoort bij hoogstens één klant, en die volgt uit de bestanden —
--     nooit uit de browser. Een bestand van klant A kan niet in een zending van
--     klant B, en een klantbestand niet in een zending zonder klant.
--  2. Hoort de zending bij een klant, dan gaat hij uitsluitend naar het
--     hoofdadres van die klant of naar een actieve contactpersoon van die klant.
--     Een los e-mailadres kan alleen bij een zending die bij geen klant hoort.
--  3. Na versturen liggen de bestanden vast: geen toevoegen, weghalen of
--     vervangen. Alleen het opruimen na de vervaldatum raakt ze nog aan.
--  4. Elk bestand is hoogstens 1 GB, en alles telt mee in het opslagquotum.
--  5. Een vervaldatum is verplicht (hoogstens een jaar vooruit). Daarna ruimt
--     de opruimtaak (edge function file-transfer, ?cron=purge) de bestanden op.
--
-- ONDERDELEN
--  0. Delen: ontvangersoort 'client' = het hoofdadres van de klant.
--  1. Tabellen: file_transfers, file_transfer_items, file_transfer_recipients,
--     file_transfer_codes en file_transfer_sessions (geheim, alleen service-role),
--     file_transfer_events (logboek) en storage_purge_queue.
--  2. Triggers die de regels bewaken.
--  3. RLS: teamleden lezen via de module Inhoud; schrijven doet alleen de
--     service-role (edge functions file-transfer, file-transfer-public, mail,
--     client-portal en de media-worker).
--  4. Service-role-functies voor toegang, code, logboek, portaal en opruimen.
--  5. Opslagmeter, auditmodule, pushmelding en e-mailsjabloon.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 0. Delen: het hoofdadres van de klant als ontvanger
-- ════════════════════════════════════════════════════════════════════════════
-- Het hoofdadres (clients.email) kan al op het klantportaal, maar was geen
-- contactpersoon en dus geen ontvanger in het deelvenster. Een eigen soort,
-- zodat de regel "alleen mensen van díe klant" gewoon blijft gelden en de
-- toegang live meebeweegt met het adres van de klant.

do $$
declare
  c record;
begin
  for c in
    select conname
      from pg_constraint
     where conrelid = 'public.drive_shares'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%recipient_kind%'
  loop
    execute format('alter table public.drive_shares drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.drive_shares
  add constraint drive_shares_recipient_kind_check
  check (recipient_kind in ('contact', 'member', 'link', 'client'));

alter table public.drive_shares
  add constraint drive_shares_recipient_shape check (
    (recipient_kind = 'contact' and client_contact_id is not null and member_user_id is null and token_hash is null)
    or (recipient_kind = 'member' and member_user_id is not null and client_contact_id is null and token_hash is null)
    or (recipient_kind = 'link' and client_contact_id is null and member_user_id is null and recipient_email is not null)
    or (recipient_kind = 'client' and client_contact_id is null and member_user_id is null and token_hash is null)
  );

-- Eén lopende deling per (item, klant) voor het hoofdadres.
create unique index if not exists idx_drive_shares_active_client
  on public.drive_shares (item_type, item_id, client_id)
  where revoked_at is null and recipient_kind = 'client';

-- Gelijk aan 20260823010000, met de tak 'client' erbij.
create or replace function public.enforce_drive_share_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx      record;
  v_contact  public.client_contacts;
  v_client   public.clients;
  v_member   record;
  v_email    text;
begin
  if TG_OP = 'INSERT' then
    new.revoked_at := null;
    new.revoked_by := null;
  elsif new.revoked_at is not null then
    -- Intrekken moet altijd lukken (20260823010000).
    return new;
  end if;

  new.recipient_name := nullif(btrim(coalesce(new.recipient_name, '')), '');
  new.message := nullif(btrim(coalesce(new.message, '')), '');
  new.recipient_email := public.normalize_client_lookup_value(new.recipient_email);

  select * into v_ctx
  from public.drive_item_client(new.organization_id, new.item_type, new.item_id);

  new.client_id := v_ctx.client_id;
  new.project_id := v_ctx.project_id;
  new.item_name := coalesce(nullif(btrim(coalesce(new.item_name, '')), ''), v_ctx.item_name);

  if new.recipient_kind = 'contact' then
    if new.client_id is null then
      raise exception 'Dit item hoort niet bij een klantdossier, dus er is geen contactpersoon om mee te delen. Kies een collega of een deellink.'
        using errcode = '23514';
    end if;

    select * into v_contact from public.client_contacts cc where cc.id = new.client_contact_id;
    if not found then
      raise exception 'Deze contactpersoon bestaat niet (meer).' using errcode = '02000';
    end if;

    if v_contact.organization_id <> new.organization_id or v_contact.client_id <> new.client_id then
      raise exception 'Dit bestand hoort bij klantdossier “%”. Het mag alleen worden gedeeld met een geregistreerde contactpersoon van diezelfde klant.',
        coalesce(v_ctx.client_name, 'onbekend') using errcode = '42501';
    end if;
    if not v_contact.is_active then
      raise exception 'Contactpersoon “%” staat op inactief. Activeer die eerst bij de klant.', v_contact.name
        using errcode = '23514';
    end if;
    if not v_contact.gives_portal_access then
      raise exception 'Contactpersoon “%” heeft geen portaaltoegang. Zet die eerst aan bij de klant, of stuur de bestanden met “Versturen…”: daarvoor is geen portaaltoegang nodig.', v_contact.name
        using errcode = '23514';
    end if;

    new.recipient_email := public.normalize_client_lookup_value(v_contact.email);
    new.recipient_name := v_contact.name;
    new.member_user_id := null;
    new.token_hash := null;

  elsif new.recipient_kind = 'client' then
    -- Het hoofdadres van de klant waar het item nú bij hoort. Wie dat adres op
    -- dit moment is, bepaalt de klantkaart — niet wat de browser meestuurt.
    if new.client_id is null then
      raise exception 'Dit item hoort niet bij een klantdossier, dus er is geen klant om mee te delen. Kies een collega of een deellink.'
        using errcode = '23514';
    end if;

    select * into v_client from public.clients c
     where c.id = new.client_id and c.organization_id = new.organization_id;
    if not found then
      raise exception 'Deze klant bestaat niet (meer).' using errcode = '02000';
    end if;

    v_email := public.normalize_client_lookup_value(v_client.email);
    if v_email is null or v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
      raise exception 'Klant “%” heeft geen geldig e-mailadres. Vul dat eerst in op de klantkaart.', v_client.name
        using errcode = '23514';
    end if;

    new.recipient_email := v_email;
    new.recipient_name := coalesce(nullif(btrim(coalesce(v_client.contact_name, '')), ''), v_client.name);
    new.client_contact_id := null;
    new.member_user_id := null;
    new.token_hash := null;

  elsif new.recipient_kind = 'member' then
    select m.user_id, m.email into v_member
    from public.organization_members m
    where m.user_id = new.member_user_id
      and m.organization_id = new.organization_id
      and m.status = 'active';
    if not found then
      raise exception 'Deze collega is geen actief lid van deze organisatie.' using errcode = '42501';
    end if;

    new.recipient_email := coalesce(
      public.normalize_client_lookup_value(v_member.email),
      new.recipient_email
    );
    new.client_contact_id := null;
    new.token_hash := null;

  else -- 'link'
    if new.client_id is not null then
      raise exception 'Dit bestand hoort bij klantdossier “%”. Klantgerelateerde bestanden mogen alleen worden gedeeld met de klant zelf of de geregistreerde contactpersonen van die klant, niet via een open deellink.',
        coalesce(v_ctx.client_name, 'onbekend') using errcode = '42501';
    end if;
    if new.recipient_email is null then
      raise exception 'Vul een geldig e-mailadres in om een deellink te versturen.' using errcode = '23514';
    end if;
    if new.recipient_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
      raise exception 'Vul een geldig e-mailadres in om een deellink te versturen.' using errcode = '23514';
    end if;
    if nullif(btrim(coalesce(new.token_hash, '')), '') is null then
      raise exception 'Een deellink kan niet zonder token worden aangemaakt.' using errcode = '23514';
    end if;
    new.client_contact_id := null;
    new.member_user_id := null;
  end if;

  return new;
end;
$$;

-- De portaaltoegang voor delingen, nu ook voor het hoofdadres. Alles blijft
-- LIVE afgeleid: verhuist het item naar een andere klant, of verandert het
-- e-mailadres op de klantkaart, dan is de toegang op dat moment weg.
create or replace function public.portal_drive_shares_for_email(p_email text)
returns setof public.drive_shares
language sql
stable
security definer
set search_path = public
as $$
  select s.*
  from public.drive_shares s
  join public.client_contacts cc on cc.id = s.client_contact_id
  cross join lateral public.drive_item_client_safe(s.organization_id, s.item_type, s.item_id) ctx
  where s.recipient_kind = 'contact'
    and s.revoked_at is null
    and (s.expires_at is null or s.expires_at > now())
    and cc.is_active = true
    and cc.gives_portal_access = true
    and cc.organization_id = s.organization_id
    and ctx.client_id is not null
    and ctx.client_id = cc.client_id
    and public.normalize_client_lookup_value(p_email) is not null
    and public.normalize_client_lookup_value(cc.email) = public.normalize_client_lookup_value(p_email)
  union all
  select s.*
  from public.drive_shares s
  cross join lateral public.drive_item_client_safe(s.organization_id, s.item_type, s.item_id) ctx
  join public.clients c on c.id = ctx.client_id and c.organization_id = s.organization_id
  where s.recipient_kind = 'client'
    and s.revoked_at is null
    and (s.expires_at is null or s.expires_at > now())
    and ctx.client_id is not null
    and ctx.client_id = s.client_id
    and public.normalize_client_lookup_value(p_email) is not null
    and public.normalize_client_lookup_value(c.email) = public.normalize_client_lookup_value(p_email);
$$;

revoke all on function public.portal_drive_shares_for_email(text) from public, anon, authenticated;
grant execute on function public.portal_drive_shares_for_email(text) to service_role;

-- Deelhygiëne na een verhuizing (20260903000000), met de klantdeling erbij:
-- verhuist een item naar een andere klant, dan vervalt de deling met het
-- hoofdadres van de oude klant.
create or replace function public.revoke_stale_drive_shares(p_item_type text, p_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.drive_shares s
  set revoked_at = now(),
      revoked_by = auth.uid()
  where s.item_type = p_item_type
    and s.item_id = p_item_id
    and s.revoked_at is null
    and (
      (s.recipient_kind = 'contact'
        and (select cc.client_id from public.client_contacts cc where cc.id = s.client_contact_id)
            is distinct from
            (select ctx.client_id from public.drive_item_client_safe(s.organization_id, s.item_type, s.item_id) ctx))
      or
      (s.recipient_kind = 'client'
        and s.client_id
            is distinct from
            (select ctx.client_id from public.drive_item_client_safe(s.organization_id, s.item_type, s.item_id) ctx))
      or
      (s.recipient_kind = 'link'
        and (select ctx.client_id from public.drive_item_client_safe(s.organization_id, s.item_type, s.item_id) ctx)
            is not null)
    );
end;
$$;

revoke all on function public.revoke_stale_drive_shares(text, uuid) from public, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Tabellen
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1a. De zending ─────────────────────────────────────────────────────────
create table if not exists public.file_transfers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),

  -- Bij welke klant hoort dit pakket. Vast na aanmaken; de bestanden en de
  -- ontvangers worden ertegen getoetst (triggers hieronder). Verwijder je de
  -- klant, dan gaan de zendingen mee (AVG) — de bestanden ruimt de
  -- opruimtaak op via storage_purge_queue.
  client_id uuid references public.clients(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,

  subject text not null,
  message text,
  can_download boolean not null default true,
  expires_at timestamptz not null,

  status text not null default 'draft' check (status in ('draft', 'sent', 'revoked', 'expired')),
  -- Waar de zending begon: Inhoud, de klantkaart, het mailvenster, een
  -- ticketantwoord of Gerrie. Alleen voor de weergave en het logboek.
  origin text not null default 'content' check (origin in ('content', 'client', 'message', 'ticket', 'gerrie')),
  ticket_id uuid references public.tickets(id) on delete set null,
  ticket_note_id uuid references public.ticket_notes(id) on delete set null,
  client_email_thread_id uuid references public.client_email_threads(id) on delete set null,
  -- Naam van wie verstuurde, zoals hij in de mail stond (momentopname).
  sender_name text,

  item_count integer not null default 0 check (item_count >= 0),
  total_bytes bigint not null default 0 check (total_bytes >= 0),

  sent_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null,
  -- Wanneer de bestanden zijn opgeruimd (na de vervaldatum of na intrekken).
  purged_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint file_transfers_subject_length check (char_length(subject) between 1 and 200),
  constraint file_transfers_message_length check (message is null or char_length(message) <= 5000)
);

comment on table public.file_transfers is
  'Zendingen: een bevroren pakket bestanden met een bericht, aan het hoofdadres of de contactpersonen van één klant (of aan losse adressen als het pakket bij geen klant hoort). Zie 20261013100000_file_transfers.sql.';

create index if not exists idx_file_transfers_org_created on public.file_transfers (organization_id, created_at desc);
create index if not exists idx_file_transfers_client on public.file_transfers (organization_id, client_id) where client_id is not null;
create index if not exists idx_file_transfers_due on public.file_transfers (status, expires_at) where status in ('sent', 'draft');
create index if not exists idx_file_transfers_ticket_note on public.file_transfers (ticket_note_id) where ticket_note_id is not null;

-- ── 1b. Wat erin zit ───────────────────────────────────────────────────────
create table if not exists public.file_transfer_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  transfer_id uuid not null references public.file_transfers(id) on delete cascade,

  -- 'upload' = nieuw van de computer van de afzender; de andere drie zijn een
  -- KOPIE van iets uit Inhoud (bestand, notitie, document) op het moment van
  -- toevoegen. De bron mag daarna veranderen of verdwijnen: de zending niet.
  source_type text not null check (source_type in ('attachment', 'note', 'document', 'upload')),
  source_id uuid,

  name text not null,
  mime_type text not null default 'application/octet-stream',
  size_bytes bigint not null default 0,
  sha256 text,
  -- De eigen kopie in R2, altijd onder {organisatie}/transfer/{zending}/.
  storage_key text,
  -- Een notitie of tekstdocument, bevroren als HTML (wordt op de pagina gelezen).
  html_snapshot text,
  -- Pad binnen een meegestuurde map ("Ontwerpen / Definitief").
  path text not null default '',
  position integer not null default 0,
  purged_at timestamptz,
  created_at timestamptz not null default now(),

  constraint file_transfer_items_name_length check (char_length(name) between 1 and 300),
  constraint file_transfer_items_size check (size_bytes >= 0 and size_bytes <= 1073741824),
  constraint file_transfer_items_source_shape check (
    (source_type = 'upload' and source_id is null)
    or (source_type <> 'upload' and source_id is not null)
  ),
  constraint file_transfer_items_payload check (
    purged_at is not null
    or (storage_key is not null and html_snapshot is null)
    or (storage_key is null and html_snapshot is not null)
  ),
  constraint file_transfer_items_snapshot_length check (html_snapshot is null or octet_length(html_snapshot) <= 2097152)
);

create index if not exists idx_file_transfer_items_transfer on public.file_transfer_items (transfer_id, position, created_at);
create index if not exists idx_file_transfer_items_live on public.file_transfer_items (organization_id) where purged_at is null;

-- ── 1c. Aan wie ────────────────────────────────────────────────────────────
create table if not exists public.file_transfer_recipients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  transfer_id uuid not null references public.file_transfers(id) on delete cascade,

  -- 'client'  = het hoofdadres van de klant van de zending
  -- 'contact' = een contactpersoon van die klant (portaaltoegang niet nodig)
  -- 'email'   = een los adres; alleen bij een zending zonder klant
  kind text not null check (kind in ('client', 'contact', 'email')),
  -- Verdwijnt de contactpersoon, dan blijft de regel staan (wie kreeg wat),
  -- maar de toegang is weg: die wordt live tegen deze kolom getoetst.
  client_contact_id uuid references public.client_contacts(id) on delete set null,
  email text not null,
  name text,

  -- sha256 van de persoonlijke link-token; de platte token staat alleen in de mail.
  token_hash text,
  -- Het bericht in het klantgesprek (Berichten / portaal) waarmee hij verstuurd is.
  client_email_id uuid references public.client_emails(id) on delete set null,

  notified_at timestamptz,
  notify_error text,
  -- sent | delivered | bounced | complained | failed (Resend-webhook)
  delivery_status text,
  delivery_updated_at timestamptz,

  first_opened_at timestamptz,
  last_opened_at timestamptz,
  open_count integer not null default 0 check (open_count >= 0),
  first_downloaded_at timestamptz,
  last_downloaded_at timestamptz,
  download_count integer not null default 0 check (download_count >= 0),

  revoked_at timestamptz,
  -- Te vaak een verkeerde code: de link is dicht tot de afzender opnieuw
  -- verstuurt (dat geeft een nieuwe link en zet dit terug). Zichtbaar voor het team.
  code_blocked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uidx_file_transfer_recipients_token
  on public.file_transfer_recipients (token_hash) where token_hash is not null;
create unique index if not exists uidx_file_transfer_recipients_email
  on public.file_transfer_recipients (transfer_id, email);
create index if not exists idx_file_transfer_recipients_transfer on public.file_transfer_recipients (transfer_id);
create index if not exists idx_file_transfer_recipients_email on public.file_transfer_recipients (email) where revoked_at is null;
create index if not exists idx_file_transfer_recipients_client_email on public.file_transfer_recipients (client_email_id) where client_email_id is not null;

-- ── 1d. Codes en sessies (geheim: geen policies, alleen de service-role) ────
create table if not exists public.file_transfer_codes (
  recipient_id uuid primary key references public.file_transfer_recipients(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  code_hash text,
  code_expires_at timestamptz,
  -- Foute pogingen op de huidige code (vijf = een kwartier dicht).
  attempts integer not null default 0,
  locked_until timestamptz,
  sends_window_start timestamptz,
  sends_in_window integer not null default 0,
  -- Foute pogingen over álle codes heen: een nieuwe code aanvragen zet deze
  -- tellers niet terug. Tien in 24 uur = een dag dicht; twintig in totaal =
  -- de link is dicht tot de afzender opnieuw verstuurt.
  failures_window_start timestamptz,
  failures_in_window integer not null default 0,
  failures_total integer not null default 0,
  blocked_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.file_transfer_sessions (
  token_hash text primary key,
  recipient_id uuid not null references public.file_transfer_recipients(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_file_transfer_sessions_expiry on public.file_transfer_sessions (expires_at);

-- ── 1e. Het logboek ────────────────────────────────────────────────────────
create table if not exists public.file_transfer_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  transfer_id uuid not null references public.file_transfers(id) on delete cascade,
  recipient_id uuid references public.file_transfer_recipients(id) on delete set null,
  item_id uuid references public.file_transfer_items(id) on delete set null,
  kind text not null check (kind in (
    'sent', 'resent', 'recipient_added', 'delivered', 'bounced', 'complained', 'failed',
    'code_sent', 'code_failed', 'code_locked',
    'opened', 'downloaded', 'zip_downloaded',
    'extended', 'revoked', 'recipient_revoked', 'expired', 'purged'
  )),
  actor_user_id uuid,
  -- Kort en zonder persoonsgegevens die er niet al staan (geen IP-adres).
  detail text,
  created_at timestamptz not null default now(),
  constraint file_transfer_events_detail_length check (detail is null or char_length(detail) <= 300)
);

create index if not exists idx_file_transfer_events_transfer on public.file_transfer_events (transfer_id, created_at);

-- ── 1f. Opslag die nog weg moet ────────────────────────────────────────────
-- Een database kan geen R2-object wissen. Verdwijnt er een rij met een eigen
-- kopie — een klant verwijderd, een zending verwijderd, een concept opgeruimd —
-- dan komt de sleutel hier, en haalt de opruimtaak hem uit R2.
create table if not exists public.storage_purge_queue (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  storage_key text not null,
  -- 'file_transfer' = de rij is weg, het object moet weg.
  -- 'file_transfer_pending' = een upload of kopie die nog geen bestandsrij
  -- heeft: komt die rij er, dan gaat deze regel weer weg; zo niet (time-out,
  -- geweigerd), dan ruimt de taak het object na purge_after alsnog op.
  reason text not null default 'file_transfer',
  purge_after timestamptz not null default now(),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  constraint storage_purge_queue_key check (position('..' in storage_key) = 0 and storage_key like organization_id::text || '/%')
);

create index if not exists idx_storage_purge_queue_created on public.storage_purge_queue (created_at);
create index if not exists idx_storage_purge_queue_due on public.storage_purge_queue (purge_after);
create index if not exists idx_storage_purge_queue_key on public.storage_purge_queue (storage_key);

-- ════════════════════════════════════════════════════════════════════════════
-- 2. De regels
-- ════════════════════════════════════════════════════════════════════════════

-- ── 2a. Is deze ontvanger NU nog geldig? ───────────────────────────────────
-- Live, bij elke toegang: het hoofdadres moet nog het adres op de klantkaart
-- zijn, een contactpersoon moet nog actief zijn en bij dezelfde klant horen,
-- een los adres mag alleen bij een zending zonder klant.
create or replace function public.file_transfer_recipient_valid(
  p_transfer public.file_transfers,
  p_recipient public.file_transfer_recipients
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_recipient.revoked_at is not null then false
    when p_recipient.organization_id <> p_transfer.organization_id then false
    when p_recipient.kind = 'client' then
      p_transfer.client_id is not null and exists (
        select 1 from public.clients c
         where c.id = p_transfer.client_id
           and c.organization_id = p_transfer.organization_id
           and public.normalize_client_lookup_value(c.email) = p_recipient.email)
    when p_recipient.kind = 'contact' then
      p_transfer.client_id is not null and exists (
        select 1 from public.client_contacts cc
         where cc.id = p_recipient.client_contact_id
           and cc.client_id = p_transfer.client_id
           and cc.organization_id = p_transfer.organization_id
           and cc.is_active
           and public.normalize_client_lookup_value(cc.email) = p_recipient.email)
    when p_recipient.kind = 'email' then p_transfer.client_id is null
    else false
  end;
$$;

revoke all on function public.file_transfer_recipient_valid(public.file_transfers, public.file_transfer_recipients) from public, anon, authenticated;
grant execute on function public.file_transfer_recipient_valid(public.file_transfers, public.file_transfer_recipients) to service_role;

-- Dezelfde toets op id, voor de edge function: opnieuw mailen mag alleen naar
-- een adres dat NU nog klopt (klantkaart gewijzigd, contactpersoon inactief =
-- niet meer mailen; de inhoud van die mail is ook klantinformatie).
create or replace function public.file_transfer_recipient_still_valid(p_recipient_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_recipient public.file_transfer_recipients;
  v_transfer public.file_transfers;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de verzenddienst mag dit aanroepen.' using errcode = '42501';
  end if;
  select * into v_recipient from public.file_transfer_recipients r where r.id = p_recipient_id;
  if not found then
    return false;
  end if;
  select * into v_transfer from public.file_transfers t where t.id = v_recipient.transfer_id;
  if not found then
    return false;
  end if;
  return public.file_transfer_recipient_valid(v_transfer, v_recipient);
end;
$$;

revoke all on function public.file_transfer_recipient_still_valid(uuid) from public, anon, authenticated;
grant execute on function public.file_transfer_recipient_still_valid(uuid) to service_role;

-- ── 2b. De zending zelf ────────────────────────────────────────────────────
create or replace function public.enforce_file_transfer_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_client uuid;
  v_ticket record;
  v_note record;
  v_thread record;
  v_items integer;
  v_recipients integer;
begin
  new.subject := btrim(regexp_replace(coalesce(new.subject, ''), '\s+', ' ', 'g'));
  new.message := nullif(btrim(coalesce(new.message, '')), '');
  new.sender_name := nullif(btrim(coalesce(new.sender_name, '')), '');

  if TG_OP = 'INSERT' then
    -- Een zending begint altijd als concept: de controles bij versturen
    -- (bestanden klaar, ontvangers geldig) kun je niet overslaan door meteen
    -- als 'sent' in te voegen.
    new.status := 'draft';
    new.sent_at := null;
    new.revoked_at := null;
    new.revoked_by := null;
    new.purged_at := null;
    new.item_count := 0;
    new.total_bytes := 0;

    if new.client_id is not null and not exists (
      select 1 from public.clients c where c.id = new.client_id and c.organization_id = new.organization_id
    ) then
      raise exception 'Deze klant bestaat niet in deze organisatie.' using errcode = '42501';
    end if;
  else
    if new.client_id is distinct from old.client_id then
      raise exception 'Een zending verhuist niet naar een andere klant. Maak een nieuwe zending.' using errcode = '42501';
    end if;
    if new.created_by is distinct from old.created_by then
      new.created_by := old.created_by;
    end if;
  end if;

  if new.project_id is not null then
    select p.client_id into v_project_client
      from public.projects p
     where p.id = new.project_id and p.organization_id = new.organization_id;
    if not found then
      raise exception 'Dit project bestaat niet in deze organisatie.' using errcode = '42501';
    end if;
    if v_project_client is distinct from new.client_id then
      raise exception 'Dit project hoort bij een andere klant dan de zending.' using errcode = '42501';
    end if;
  end if;

  if new.ticket_id is not null and (TG_OP = 'INSERT' or new.ticket_id is distinct from old.ticket_id) then
    select t.client_id, t.organization_id into v_ticket from public.tickets t where t.id = new.ticket_id;
    if not found or v_ticket.organization_id <> new.organization_id then
      raise exception 'Dit ticket bestaat niet in deze organisatie.' using errcode = '42501';
    end if;
    if v_ticket.client_id is distinct from new.client_id then
      raise exception 'Dit ticket hoort bij een andere klant dan de zending.' using errcode = '42501';
    end if;
  end if;

  if new.ticket_note_id is not null and (TG_OP = 'INSERT' or new.ticket_note_id is distinct from old.ticket_note_id) then
    select n.ticket_id, n.organization_id into v_note from public.ticket_notes n where n.id = new.ticket_note_id;
    if not found or v_note.organization_id <> new.organization_id or v_note.ticket_id is distinct from new.ticket_id then
      raise exception 'Dit antwoord hoort niet bij het ticket van de zending.' using errcode = '42501';
    end if;
  end if;

  if new.client_email_thread_id is not null and (TG_OP = 'INSERT' or new.client_email_thread_id is distinct from old.client_email_thread_id) then
    select th.client_id, th.organization_id into v_thread from public.client_email_threads th where th.id = new.client_email_thread_id;
    if not found or v_thread.organization_id <> new.organization_id or v_thread.client_id is distinct from new.client_id then
      raise exception 'Dit gesprek hoort niet bij de klant van de zending.' using errcode = '42501';
    end if;
  end if;

  -- ── Statusovergangen ──────────────────────────────────────────────────────
  if TG_OP = 'UPDATE' and new.status is distinct from old.status then
    if old.status = 'draft' and new.status = 'sent' then
      -- Een bestand staat er pas als de bytes er zijn (de kopie of upload is
      -- klaar); de vorm-CHECK op file_transfer_items bewaakt dat.
      select count(*) into v_items
        from public.file_transfer_items i
       where i.transfer_id = new.id and i.purged_at is null;
      if v_items = 0 then
        raise exception 'Een zending zonder bestanden kan niet worden verstuurd.' using errcode = '23514';
      end if;
      select count(*) into v_recipients
        from public.file_transfer_recipients r
       where r.transfer_id = new.id and r.revoked_at is null;
      if v_recipients = 0 and new.ticket_note_id is null then
        raise exception 'Kies minstens één ontvanger.' using errcode = '23514';
      end if;
      new.sent_at := coalesce(new.sent_at, now());
    elsif old.status = 'sent' and new.status = 'revoked' then
      new.revoked_at := coalesce(new.revoked_at, now());
    elsif old.status = 'sent' and new.status = 'expired' then
      if new.expires_at > now() then
        raise exception 'Deze zending is nog niet verlopen.' using errcode = '23514';
      end if;
    else
      raise exception 'Een zending kan niet van "%" naar "%".', old.status, new.status using errcode = '23514';
    end if;
  end if;

  -- ── Vervaldatum ───────────────────────────────────────────────────────────
  if TG_OP = 'INSERT' or new.expires_at is distinct from old.expires_at then
    if TG_OP = 'UPDATE' and old.status in ('revoked', 'expired') then
      raise exception 'Deze zending is ingetrokken of verlopen; de bestanden zijn (of worden) opgeruimd. Stuur ze opnieuw.' using errcode = '23514';
    end if;
    if new.status <> 'expired' and new.expires_at <= now() then
      raise exception 'De vervaldatum ligt in het verleden.' using errcode = '23514';
    end if;
    if new.expires_at > now() + interval '366 days' then
      raise exception 'Een zending blijft hoogstens een jaar beschikbaar.' using errcode = '23514';
    end if;
  end if;

  -- ── Na versturen ligt de inhoud vast ──────────────────────────────────────
  if TG_OP = 'UPDATE' and old.status <> 'draft' then
    if new.subject is distinct from old.subject or new.message is distinct from old.message then
      raise exception 'Onderwerp en bericht van een verstuurde zending liggen vast.' using errcode = '23514';
    end if;
    if new.item_count is distinct from old.item_count or new.total_bytes is distinct from old.total_bytes then
      raise exception 'De bestanden van een verstuurde zending liggen vast.' using errcode = '23514';
    end if;
    if old.status in ('revoked', 'expired') and new.can_download is distinct from old.can_download then
      raise exception 'Deze zending is ingetrokken of verlopen.' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists file_transfers_rules on public.file_transfers;
create trigger file_transfers_rules
  before insert or update on public.file_transfers
  for each row execute function public.enforce_file_transfer_rules();

drop trigger if exists file_transfers_touch_updated_at on public.file_transfers;
create trigger file_transfers_touch_updated_at
  before update on public.file_transfers
  for each row execute function public.set_updated_at();

drop trigger if exists file_transfers_prevent_org_change on public.file_transfers;
create trigger file_transfers_prevent_org_change
  before update of organization_id on public.file_transfers
  for each row execute function public.prevent_organization_id_change();

-- In het activiteitenlog: aanmaken, versturen, intrekken, vervaldatum,
-- verwijderen. Niet de tellers (die veranderen bij elk bestand).
drop trigger if exists file_transfers_audit on public.file_transfers;
create trigger file_transfers_audit
  after insert or delete or update of status, expires_at, can_download, revoked_at
  on public.file_transfers
  for each row execute function public.audit_row_change('file_transfer', 'subject');

-- ── 2c. De bestanden ───────────────────────────────────────────────────────
create or replace function public.enforce_file_transfer_item_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transfer public.file_transfers;
  v_ctx record;
  v_prefix text;
begin
  -- De zending gaat op slot (for no key update): een upload die net klaar is
  -- terwijl iemand op Versturen drukt, wacht tot dat versturen klaar is en ziet
  -- dan dat de zending verstuurd is — in plaats van er stilletjes bij te komen.
  -- Bewust niet "for share": twee gelijktijdige uploads zouden dat slot daarna
  -- allebei willen ophogen (de tellers) en elkaar vastzetten.
  if TG_OP = 'DELETE' then
    select * into v_transfer from public.file_transfers t where t.id = old.transfer_id for no key update;
    -- Niet gevonden = de zending zelf wordt verwijderd (cascade): dan mag het.
    if found and v_transfer.status <> 'draft' then
      raise exception 'De bestanden van een verstuurde zending liggen vast.' using errcode = '23514';
    end if;
    return old;
  end if;

  select * into v_transfer from public.file_transfers t where t.id = new.transfer_id for no key update;
  if not found then
    raise exception 'Deze zending bestaat niet (meer).' using errcode = '02000';
  end if;
  if new.organization_id <> v_transfer.organization_id then
    raise exception 'Dit bestand hoort niet bij de organisatie van de zending.' using errcode = '42501';
  end if;

  v_prefix := v_transfer.organization_id::text || '/transfer/' || v_transfer.id::text || '/';

  if TG_OP = 'UPDATE' then
    if new.transfer_id <> old.transfer_id or new.source_type <> old.source_type
       or new.source_id is distinct from old.source_id then
      raise exception 'Een bestand verhuist niet naar een andere zending.' using errcode = '42501';
    end if;
    if v_transfer.status <> 'draft' then
      -- Na versturen mag alleen het opruimen nog iets aan een bestand doen.
      if new.name is distinct from old.name
         or new.mime_type is distinct from old.mime_type
         or new.size_bytes is distinct from old.size_bytes
         or new.sha256 is distinct from old.sha256
         or new.storage_key is distinct from old.storage_key
         or new.path is distinct from old.path
         or new.position is distinct from old.position
         or (new.html_snapshot is distinct from old.html_snapshot and new.html_snapshot is not null)
         or (old.purged_at is not null and new.purged_at is null) then
        raise exception 'De bestanden van een verstuurde zending liggen vast.' using errcode = '23514';
      end if;
      return new;
    end if;
  elsif v_transfer.status <> 'draft' then
    raise exception 'Aan een verstuurde zending kun je niets meer toevoegen. Stuur de extra bestanden in een nieuwe zending.' using errcode = '23514';
  end if;

  new.name := btrim(coalesce(new.name, ''));
  if new.name = '' then
    raise exception 'Een bestand heeft een naam nodig.' using errcode = '23514';
  end if;
  new.path := btrim(coalesce(new.path, ''));
  new.mime_type := coalesce(nullif(btrim(coalesce(new.mime_type, '')), ''), 'application/octet-stream');

  -- HET SLOT: wat uit Inhoud komt, hoort bij dezelfde klant als de zending.
  -- De klant van het bestand komt van de server (drive_item_client); onbekend
  -- of niet-deelbaar = geweigerd (fail closed).
  if new.source_type <> 'upload' and (TG_OP = 'INSERT') then
    select * into v_ctx
      from public.drive_item_client(new.organization_id, new.source_type, new.source_id);
    if v_ctx.client_id is distinct from v_transfer.client_id then
      if v_ctx.client_id is null then
        raise exception '“%” hoort bij geen klant en kan niet mee in een zending voor een klant. Upload het bestand zelf in de zending als het voor deze klant bedoeld is.',
          coalesce(v_ctx.item_name, new.name) using errcode = '42501';
      elsif v_transfer.client_id is null then
        raise exception '“%” hoort bij klantdossier “%”. Klantbestanden gaan alleen naar die klant zelf of een contactpersoon van die klant: kies de klant als ontvanger.',
          coalesce(v_ctx.item_name, new.name), coalesce(v_ctx.client_name, 'onbekend') using errcode = '42501';
      else
        raise exception '“%” hoort bij klantdossier “%”, en deze zending is voor een andere klant.',
          coalesce(v_ctx.item_name, new.name), coalesce(v_ctx.client_name, 'onbekend') using errcode = '42501';
      end if;
    end if;
  end if;

  if new.storage_key is not null then
    if left(new.storage_key, length(v_prefix)) <> v_prefix or position('..' in new.storage_key) > 0 then
      raise exception 'De opslagsleutel hoort niet bij deze zending.' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists file_transfer_items_rules on public.file_transfer_items;
create trigger file_transfer_items_rules
  before insert or update or delete on public.file_transfer_items
  for each row execute function public.enforce_file_transfer_item_rules();

-- Tellers op de zending (aantal + totale grootte). Alleen zolang het een
-- concept is verandert er iets; bij een cascade-verwijdering raakt de update
-- geen rij meer.
create or replace function public.refresh_file_transfer_totals()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transfer uuid := coalesce(new.transfer_id, old.transfer_id);
begin
  update public.file_transfers t
     set item_count = s.cnt,
         total_bytes = s.bytes
    from (
      select count(*)::integer as cnt, coalesce(sum(i.size_bytes), 0)::bigint as bytes
        from public.file_transfer_items i
       where i.transfer_id = v_transfer
    ) s
   where t.id = v_transfer
     and t.status = 'draft'
     and (t.item_count is distinct from s.cnt or t.total_bytes is distinct from s.bytes);
  return null;
end;
$$;

drop trigger if exists file_transfer_items_totals on public.file_transfer_items;
create trigger file_transfer_items_totals
  after insert or delete or update of size_bytes on public.file_transfer_items
  for each row execute function public.refresh_file_transfer_totals();

-- Verdwijnt een bestand met een eigen kopie, dan moet die kopie ook uit R2.
create or replace function public.queue_file_transfer_item_purge()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.storage_key is not null and old.purged_at is null then
    insert into public.storage_purge_queue (organization_id, storage_key, reason)
    values (old.organization_id, old.storage_key, 'file_transfer');
  end if;
  return old;
end;
$$;

drop trigger if exists file_transfer_items_purge_queue on public.file_transfer_items;
create trigger file_transfer_items_purge_queue
  after delete on public.file_transfer_items
  for each row execute function public.queue_file_transfer_item_purge();

-- ── 2d. De ontvangers ──────────────────────────────────────────────────────
create or replace function public.enforce_file_transfer_recipient_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transfer public.file_transfers;
  v_client public.clients;
  v_contact public.client_contacts;
  v_email text;
begin
  select * into v_transfer from public.file_transfers t where t.id = new.transfer_id;
  if not found then
    raise exception 'Deze zending bestaat niet (meer).' using errcode = '02000';
  end if;
  if new.organization_id <> v_transfer.organization_id then
    raise exception 'Deze ontvanger hoort niet bij de organisatie van de zending.' using errcode = '42501';
  end if;

  if TG_OP = 'UPDATE' then
    -- Wie de ontvanger is, ligt vast; alleen de status beweegt.
    -- (client_contact_id mag wel naar null: dat doet de database zelf als de
    -- contactpersoon verdwijnt, en dan is de toegang live ook weg.)
    if new.transfer_id <> old.transfer_id
       or new.kind <> old.kind
       or (new.client_contact_id is distinct from old.client_contact_id and new.client_contact_id is not null)
       or new.email <> old.email then
      raise exception 'Een ontvanger kun je niet wijzigen. Voeg een nieuwe ontvanger toe.' using errcode = '42501';
    end if;
    -- Ingetrokken blijft ingetrokken: een nieuwe link vraagt een nieuwe ontvanger.
    if old.revoked_at is not null and new.revoked_at is null then
      raise exception 'Een ingetrokken ontvanger blijft ingetrokken.' using errcode = '23514';
    end if;
    return new;
  end if;

  -- INSERT
  if v_transfer.status in ('revoked', 'expired') then
    raise exception 'Deze zending is ingetrokken of verlopen.' using errcode = '23514';
  end if;
  new.revoked_at := null;

  if new.kind = 'client' then
    if v_transfer.client_id is null then
      raise exception 'Deze zending hoort bij geen klant, dus er is geen hoofdadres om naar te sturen.' using errcode = '23514';
    end if;
    select * into v_client from public.clients c
     where c.id = v_transfer.client_id and c.organization_id = v_transfer.organization_id;
    if not found then
      raise exception 'De klant van deze zending bestaat niet (meer).' using errcode = '02000';
    end if;
    v_email := public.normalize_client_lookup_value(v_client.email);
    if v_email is null or v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
      raise exception 'Klant “%” heeft geen geldig e-mailadres. Vul dat eerst in op de klantkaart.', v_client.name using errcode = '23514';
    end if;
    new.email := v_email;
    new.name := coalesce(nullif(btrim(coalesce(v_client.contact_name, '')), ''), v_client.name);
    new.client_contact_id := null;

  elsif new.kind = 'contact' then
    if v_transfer.client_id is null then
      raise exception 'Deze zending hoort bij geen klant, dus er is geen contactpersoon om naar te sturen.' using errcode = '23514';
    end if;
    select * into v_contact from public.client_contacts cc where cc.id = new.client_contact_id;
    if not found then
      raise exception 'Deze contactpersoon bestaat niet (meer).' using errcode = '02000';
    end if;
    -- HET SLOT: klantbestanden alleen naar mensen van díe klant.
    if v_contact.organization_id <> v_transfer.organization_id or v_contact.client_id <> v_transfer.client_id then
      raise exception 'Deze contactpersoon hoort niet bij de klant van de zending. Klantbestanden gaan alleen naar de klant zelf of een contactpersoon van die klant.'
        using errcode = '42501';
    end if;
    if not v_contact.is_active then
      raise exception 'Contactpersoon “%” staat op inactief. Activeer die eerst bij de klant.', v_contact.name using errcode = '23514';
    end if;
    v_email := public.normalize_client_lookup_value(v_contact.email);
    if v_email is null or v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
      raise exception 'Contactpersoon “%” heeft geen geldig e-mailadres.', v_contact.name using errcode = '23514';
    end if;
    new.email := v_email;
    new.name := v_contact.name;

  else -- 'email'
    if v_transfer.client_id is not null then
      raise exception 'Deze zending hoort bij een klant. Klantbestanden gaan alleen naar de klant zelf of een geregistreerde contactpersoon van die klant — voeg de ontvanger eerst toe als contactpersoon.'
        using errcode = '42501';
    end if;
    v_email := public.normalize_client_lookup_value(new.email);
    if v_email is null or v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
      raise exception 'Vul een geldig e-mailadres in.' using errcode = '23514';
    end if;
    new.email := v_email;
    new.name := nullif(btrim(coalesce(new.name, '')), '');
    new.client_contact_id := null;
  end if;

  return new;
end;
$$;

drop trigger if exists file_transfer_recipients_rules on public.file_transfer_recipients;
create trigger file_transfer_recipients_rules
  before insert or update on public.file_transfer_recipients
  for each row execute function public.enforce_file_transfer_recipient_rules();

drop trigger if exists file_transfer_recipients_touch_updated_at on public.file_transfer_recipients;
create trigger file_transfer_recipients_touch_updated_at
  before update on public.file_transfer_recipients
  for each row execute function public.set_updated_at();

-- Melding aan wie verstuurde, bij de eerste download door een ontvanger.
create or replace function public.push_on_file_transfer_download()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transfer record;
begin
  begin
    select t.created_by, t.subject, t.id into v_transfer
      from public.file_transfers t where t.id = new.transfer_id;
    if v_transfer.created_by is null then return null; end if;
    perform public.push_enqueue(
      new.organization_id, 'file_transfer_downloaded', array[v_transfer.created_by],
      jsonb_build_object(
        'title', 'Bestanden gedownload',
        'body', coalesce(new.name, new.email) || ' heeft “' || left(v_transfer.subject, 120) || '” gedownload.',
        'url', '/',
        'tag', 'transfer:' || v_transfer.id::text));
  exception when others then
    raise warning 'push_on_file_transfer_download: %', sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists file_transfer_recipients_download_push on public.file_transfer_recipients;
create trigger file_transfer_recipients_download_push
  after update of first_downloaded_at on public.file_transfer_recipients
  for each row
  when (old.first_downloaded_at is null and new.first_downloaded_at is not null)
  execute function public.push_on_file_transfer_download();

-- Triggerfuncties zijn niet los aan te roepen, maar netjes dicht is dicht.
revoke all on function public.enforce_file_transfer_rules() from public, anon, authenticated;
revoke all on function public.enforce_file_transfer_item_rules() from public, anon, authenticated;
revoke all on function public.refresh_file_transfer_totals() from public, anon, authenticated;
revoke all on function public.queue_file_transfer_item_purge() from public, anon, authenticated;
revoke all on function public.enforce_file_transfer_recipient_rules() from public, anon, authenticated;
revoke all on function public.push_on_file_transfer_download() from public, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. RLS
-- ════════════════════════════════════════════════════════════════════════════
-- Teamleden mogen lezen (module Inhoud); schrijven gaat uitsluitend via de
-- service-role. Er zijn bewust GEEN insert/update/delete-policies: elke wijziging
-- loopt langs een edge function die de mail, de opslag en het logboek erbij doet.

alter table public.file_transfers enable row level security;
alter table public.file_transfer_items enable row level security;
alter table public.file_transfer_recipients enable row level security;
alter table public.file_transfer_events enable row level security;
alter table public.file_transfer_codes enable row level security;
alter table public.file_transfer_sessions enable row level security;
alter table public.storage_purge_queue enable row level security;

drop policy if exists "file_transfers read" on public.file_transfers;
create policy "file_transfers read" on public.file_transfers
  for select using (public.can_read_org(organization_id));

drop policy if exists "file_transfer_items read" on public.file_transfer_items;
create policy "file_transfer_items read" on public.file_transfer_items
  for select using (public.can_read_org(organization_id));

drop policy if exists "file_transfer_recipients read" on public.file_transfer_recipients;
create policy "file_transfer_recipients read" on public.file_transfer_recipients
  for select using (public.can_read_org(organization_id));

drop policy if exists "file_transfer_events read" on public.file_transfer_events;
create policy "file_transfer_events read" on public.file_transfer_events
  for select using (public.can_read_org(organization_id));

select public.apply_module_gate('file_transfers', 'content');
select public.apply_module_gate('file_transfer_items', 'content');
select public.apply_module_gate('file_transfer_recipients', 'content');
select public.apply_module_gate('file_transfer_events', 'content');

-- Hoort een zending bij een klant, dan staan er contactpersonen in (naam, adres,
-- wat ze openden): dat is ook Klanten. Wie die module niet mag lezen, ziet de
-- zending niet. Items, ontvangers en logboek volgen hun zending: de subquery
-- valt zelf onder de regels van file_transfers.
drop policy if exists "file_transfers client gate" on public.file_transfers;
create policy "file_transfers client gate" on public.file_transfers
  as restrictive for select
  using (client_id is null or public.can_read_module(organization_id, 'clients'));

drop policy if exists "file_transfer_items follow transfer" on public.file_transfer_items;
create policy "file_transfer_items follow transfer" on public.file_transfer_items
  as restrictive for select
  using (exists (select 1 from public.file_transfers t where t.id = file_transfer_items.transfer_id));

drop policy if exists "file_transfer_recipients follow transfer" on public.file_transfer_recipients;
create policy "file_transfer_recipients follow transfer" on public.file_transfer_recipients
  as restrictive for select
  using (exists (select 1 from public.file_transfers t where t.id = file_transfer_recipients.transfer_id));

drop policy if exists "file_transfer_events follow transfer" on public.file_transfer_events;
create policy "file_transfer_events follow transfer" on public.file_transfer_events
  as restrictive for select
  using (exists (select 1 from public.file_transfers t where t.id = file_transfer_events.transfer_id));

-- De schrijf-trigger van de module-poort mag hier NIET staan. Teamleden kunnen
-- deze tabellen toch al niet beschrijven (geen policies), maar de database doet
-- het soms namens hen: verwijdert iemand met alleen Klanten-rechten een klant,
-- een contactpersoon of een mail, dan ruimt een cascade (of een "set null") rijen
-- hier op — en die zou dan stranden op een module waar die persoon niets mee te
-- maken had. Hetzelfde als bij drive_shares (20260823000000). Het lezen blijft
-- achter de restrictieve select-policy van de poort.
drop trigger if exists zzz_module_write_gate on public.file_transfers;
drop trigger if exists zzz_module_write_gate on public.file_transfer_items;
drop trigger if exists zzz_module_write_gate on public.file_transfer_recipients;
drop trigger if exists zzz_module_write_gate on public.file_transfer_events;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Service-role-functies
-- ════════════════════════════════════════════════════════════════════════════

-- ── 4a. Een map uitklappen voor een zending ────────────────────────────────
-- Dezelfde regel als drive_share_items: elk blad moet bij dezelfde klant horen
-- als de map. Een submap of notitie die later van een andere klant werd, lift
-- niet mee.
create or replace function public.drive_folder_leaves(p_organization_id uuid, p_folder_id uuid)
returns table (
  item_type text,
  item_id uuid,
  name text,
  mime_type text,
  size_bytes bigint,
  storage_key text,
  path text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_client uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de verzenddienst mag dit aanroepen.' using errcode = '42501';
  end if;

  select ctx.client_id into v_client
    from public.drive_item_client(p_organization_id, 'folder', p_folder_id) ctx;

  return query
  with recursive tree as (
    select f.id, f.name, ''::text as path, 0 as depth
      from public.content_folders f
     where f.id = p_folder_id and f.organization_id = p_organization_id
    union all
    select c.id, c.name, case when t.path = '' then t.name else t.path || ' / ' || t.name end, t.depth + 1
      from public.content_folders c
      join tree t on c.parent_id = t.id
     where t.depth < 20
       and c.organization_id = p_organization_id
       and coalesce((select p.client_id from public.projects p where p.id = c.project_id), c.client_id)
           is not distinct from v_client
  )
  select 'attachment'::text, a.id, a.name, a.mime_type, a.size_bytes::bigint, a.storage_key,
         case when t.path = '' then t.name else t.path || ' / ' || t.name end
    from tree t
    join public.attachments a
      on a.entity_type = 'folder' and a.entity_id = t.id and a.organization_id = p_organization_id
  union all
  select 'note'::text, n.id, n.title, 'text/html'::text, 0::bigint, null::text,
         case when t.path = '' then t.name else t.path || ' / ' || t.name end
    from tree t
    join public.notes n on n.folder_id = t.id and n.organization_id = p_organization_id
     and coalesce((select p.client_id from public.projects p where p.id = n.project_id), n.client_id)
         is not distinct from v_client
  union all
  select 'document'::text, d.id, d.title, coalesce(d.mime_type, 'text/html'), coalesce(d.size_bytes, 0)::bigint, d.storage_key,
         case when t.path = '' then t.name else t.path || ' / ' || t.name end
    from tree t
    join public.documents d on d.folder_id = t.id and d.organization_id = p_organization_id
     and coalesce((select p.client_id from public.projects p where p.id = d.project_id), d.client_id)
         is not distinct from v_client;
end;
$$;

revoke all on function public.drive_folder_leaves(uuid, uuid) from public, anon, authenticated;
grant execute on function public.drive_folder_leaves(uuid, uuid) to service_role;

-- ── 4b. Een persoonlijke link oplossen ─────────────────────────────────────
-- Geeft de zending + ontvanger terug, met wat er nú geldt. `state`:
--   active  — alles in orde
--   revoked — de zending of deze ontvanger is ingetrokken
--   expired — over de vervaldatum, of al opgeruimd
--   invalid — de ontvanger hoort er (live getoetst) niet meer bij
create or replace function public.file_transfer_resolve(p_token_hash text)
returns table (
  transfer_id uuid,
  recipient_id uuid,
  organization_id uuid,
  client_id uuid,
  state text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_recipient public.file_transfer_recipients;
  v_transfer public.file_transfers;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de verzenddienst mag dit aanroepen.' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_token_hash, '')), '') is null then
    return;
  end if;

  select * into v_recipient from public.file_transfer_recipients r where r.token_hash = p_token_hash;
  if not found then
    return;
  end if;
  select * into v_transfer from public.file_transfers t where t.id = v_recipient.transfer_id;
  if not found then
    return;
  end if;

  return query select
    v_transfer.id,
    v_recipient.id,
    v_transfer.organization_id,
    v_transfer.client_id,
    case
      when v_transfer.status = 'revoked' or v_recipient.revoked_at is not null then 'revoked'
      when v_transfer.status = 'expired' or v_transfer.purged_at is not null or v_transfer.expires_at <= now() then 'expired'
      when v_transfer.status <> 'sent' then 'invalid'
      when not public.file_transfer_recipient_valid(v_transfer, v_recipient) then 'invalid'
      else 'active'
    end;
end;
$$;

revoke all on function public.file_transfer_resolve(text) from public, anon, authenticated;
grant execute on function public.file_transfer_resolve(text) to service_role;

-- ── 4c. De e-mailcode ──────────────────────────────────────────────────────
-- Een nieuwe code klaarzetten. Hooguit vijf codes per uur per ontvanger, en
-- niet zolang de ontvanger op slot staat.
create or replace function public.file_transfer_store_code(
  p_recipient_id uuid,
  p_code_hash text,
  p_ttl_seconds integer default 600
)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_row public.file_transfer_codes;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de verzenddienst mag dit aanroepen.' using errcode = '42501';
  end if;

  select r.organization_id into v_org from public.file_transfer_recipients r where r.id = p_recipient_id;
  if not found then
    return 'unknown';
  end if;

  insert into public.file_transfer_codes (recipient_id, organization_id)
  values (p_recipient_id, v_org)
  on conflict (recipient_id) do nothing;

  select * into v_row from public.file_transfer_codes c where c.recipient_id = p_recipient_id for update;

  if v_row.blocked_at is not null then
    return 'blocked';
  end if;
  if v_row.locked_until is not null and v_row.locked_until > now() then
    return 'locked';
  end if;

  if v_row.sends_window_start is null or v_row.sends_window_start < now() - interval '1 hour' then
    v_row.sends_window_start := now();
    v_row.sends_in_window := 0;
  end if;
  if v_row.sends_in_window >= 5 then
    return 'rate_limited';
  end if;

  update public.file_transfer_codes
     set code_hash = p_code_hash,
         code_expires_at = now() + make_interval(secs => greatest(60, least(coalesce(p_ttl_seconds, 600), 1800))),
         attempts = 0,
         sends_window_start = v_row.sends_window_start,
         sends_in_window = v_row.sends_in_window + 1,
         updated_at = now()
   where recipient_id = p_recipient_id;
  return 'ok';
end;
$$;

revoke all on function public.file_transfer_store_code(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.file_transfer_store_code(uuid, text, integer) to service_role;

-- Een ingevulde code controleren. De rij gaat op slot (for update), zodat ook
-- parallelle pogingen netjes tellen. Een goede code werkt precies één keer.
-- Fout telt op drie manieren, en een nieuwe code aanvragen zet alleen de
-- eerste terug:
--   * vijf keer fout op deze code   → een kwartier dicht, de code is weg;
--   * tien keer fout in 24 uur       → een dag dicht;
--   * twintig keer fout in totaal    → de link is dicht ('blocked') tot de
--     afzender opnieuw verstuurt. Zo blijft raden bij een doorgestuurde of
--     uitgelekte link kansloos, ook over een zending van een jaar.
create or replace function public.file_transfer_check_code(p_recipient_id uuid, p_code_hash text)
returns table (status text, attempts_left integer, locked_until timestamptz)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_row public.file_transfer_codes;
  v_attempts integer;
  v_window_start timestamptz;
  v_in_window integer;
  v_total integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de verzenddienst mag dit aanroepen.' using errcode = '42501';
  end if;

  select * into v_row from public.file_transfer_codes c where c.recipient_id = p_recipient_id for update;
  if found and v_row.blocked_at is not null then
    return query select 'blocked'::text, 0, null::timestamptz;
    return;
  end if;
  if not found or v_row.code_hash is null then
    if found and v_row.locked_until is not null and v_row.locked_until > now() then
      return query select 'locked'::text, 0, v_row.locked_until;
      return;
    end if;
    return query select 'none'::text, 0, null::timestamptz;
    return;
  end if;
  if v_row.locked_until is not null and v_row.locked_until > now() then
    return query select 'locked'::text, 0, v_row.locked_until;
    return;
  end if;
  if v_row.code_expires_at is null or v_row.code_expires_at <= now() then
    update public.file_transfer_codes set code_hash = null, code_expires_at = null, updated_at = now()
     where recipient_id = p_recipient_id;
    return query select 'expired'::text, 0, null::timestamptz;
    return;
  end if;

  if v_row.code_hash = p_code_hash then
    update public.file_transfer_codes
       set code_hash = null, code_expires_at = null, attempts = 0, locked_until = null, updated_at = now()
     where recipient_id = p_recipient_id;
    return query select 'ok'::text, 5, null::timestamptz;
    return;
  end if;

  v_attempts := v_row.attempts + 1;
  v_window_start := v_row.failures_window_start;
  v_in_window := v_row.failures_in_window;
  if v_window_start is null or v_window_start < now() - interval '24 hours' then
    v_window_start := now();
    v_in_window := 0;
  end if;
  v_in_window := v_in_window + 1;
  v_total := v_row.failures_total + 1;

  if v_total >= 20 then
    update public.file_transfer_codes
       set attempts = 0, code_hash = null, code_expires_at = null, locked_until = null,
           failures_window_start = v_window_start, failures_in_window = v_in_window,
           failures_total = v_total, blocked_at = now(), updated_at = now()
     where recipient_id = p_recipient_id;
    update public.file_transfer_recipients set code_blocked_at = now()
     where id = p_recipient_id and code_blocked_at is null;
    return query select 'blocked'::text, 0, null::timestamptz;
    return;
  end if;

  if v_in_window >= 10 or v_attempts >= 5 then
    update public.file_transfer_codes
       set attempts = 0, code_hash = null, code_expires_at = null,
           locked_until = now() + case when v_in_window >= 10 then interval '24 hours' else interval '15 minutes' end,
           failures_window_start = v_window_start, failures_in_window = v_in_window,
           failures_total = v_total, updated_at = now()
     where recipient_id = p_recipient_id;
    return query select 'locked'::text, 0,
      now() + case when v_in_window >= 10 then interval '24 hours' else interval '15 minutes' end;
    return;
  end if;

  update public.file_transfer_codes
     set attempts = v_attempts,
         failures_window_start = v_window_start, failures_in_window = v_in_window,
         failures_total = v_total, updated_at = now()
   where recipient_id = p_recipient_id;
  return query select 'wrong'::text, least(5 - v_attempts, 10 - v_in_window, 20 - v_total), null::timestamptz;
end;
$$;

revoke all on function public.file_transfer_check_code(uuid, text) from public, anon, authenticated;
grant execute on function public.file_transfer_check_code(uuid, text) to service_role;

-- ── 4d. Openen en downloaden vastleggen ────────────────────────────────────
-- Eén aanroep: een regel in het logboek én de tellers op de ontvanger, zonder
-- dat twee gelijktijdige downloads elkaars telling overschrijven.
create or replace function public.file_transfer_record(
  p_transfer_id uuid,
  p_recipient_id uuid,
  p_kind text,
  p_item_id uuid default null,
  p_detail text default null,
  p_actor_user_id uuid default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de verzenddienst mag dit aanroepen.' using errcode = '42501';
  end if;

  select t.organization_id into v_org from public.file_transfers t where t.id = p_transfer_id;
  if not found then
    return;
  end if;

  insert into public.file_transfer_events (organization_id, transfer_id, recipient_id, item_id, kind, detail, actor_user_id)
  values (v_org, p_transfer_id, p_recipient_id, p_item_id, p_kind, left(p_detail, 300), p_actor_user_id);

  if p_recipient_id is null then
    return;
  end if;

  if p_kind = 'opened' then
    update public.file_transfer_recipients
       set open_count = open_count + 1,
           first_opened_at = coalesce(first_opened_at, now()),
           last_opened_at = now()
     where id = p_recipient_id and transfer_id = p_transfer_id;
  elsif p_kind in ('downloaded', 'zip_downloaded') then
    update public.file_transfer_recipients
       set download_count = download_count + 1,
           first_opened_at = coalesce(first_opened_at, now()),
           last_opened_at = coalesce(last_opened_at, now()),
           first_downloaded_at = coalesce(first_downloaded_at, now()),
           last_downloaded_at = now()
     where id = p_recipient_id and transfer_id = p_transfer_id;
  end if;
end;
$$;

revoke all on function public.file_transfer_record(uuid, uuid, text, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.file_transfer_record(uuid, uuid, text, uuid, text, uuid) to service_role;

-- ── 4e. Het portaal: welke zendingen staan klaar voor dit adres ────────────
-- Alleen verstuurde, niet verlopen zendingen aan precies dit (geverifieerde)
-- adres, met de ontvanger live getoetst. Iedere portaalgebruiker ziet alleen
-- wat aan hém gestuurd is — zoals bij Berichten.
create or replace function public.portal_file_transfers_for_email(p_email text)
returns table (transfer_id uuid, recipient_id uuid, organization_id uuid, client_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select t.id, r.id, t.organization_id, t.client_id
    from public.file_transfer_recipients r
    join public.file_transfers t on t.id = r.transfer_id
   where public.normalize_client_lookup_value(p_email) is not null
     and r.email = public.normalize_client_lookup_value(p_email)
     and r.kind in ('client', 'contact')
     and t.status = 'sent'
     and t.purged_at is null
     and t.expires_at > now()
     and public.file_transfer_recipient_valid(t, r);
$$;

revoke all on function public.portal_file_transfers_for_email(text) from public, anon, authenticated;
grant execute on function public.portal_file_transfers_for_email(text) to service_role;

-- ── 4f. Opruimen ───────────────────────────────────────────────────────────
-- Zet verstreken zendingen op 'expired' (met een regel in het logboek) en geeft
-- de bestanden terug die uit R2 moeten: van verlopen en ingetrokken zendingen,
-- en van concepten die langer dan een dag blijven liggen.
create or replace function public.file_transfer_purge_candidates(p_limit integer default 200)
returns table (item_id uuid, transfer_id uuid, organization_id uuid, storage_key text, transfer_status text)
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de opruimtaak mag dit aanroepen.' using errcode = '42501';
  end if;

  with due as (
    update public.file_transfers t
       set status = 'expired'
     where t.status = 'sent' and t.expires_at <= now()
    returning t.id, t.organization_id
  )
  insert into public.file_transfer_events (organization_id, transfer_id, kind)
  select d.organization_id, d.id, 'expired' from due d;

  return query
  select i.id, i.transfer_id, i.organization_id, i.storage_key, t.status
    from public.file_transfer_items i
    join public.file_transfers t on t.id = i.transfer_id
   where i.purged_at is null
     and (t.status in ('expired', 'revoked')
          or (t.status = 'draft' and t.created_at < now() - interval '1 day'))
   order by t.updated_at
   limit greatest(1, least(coalesce(p_limit, 200), 1000));
end;
$$;

revoke all on function public.file_transfer_purge_candidates(integer) from public, anon, authenticated;
grant execute on function public.file_transfer_purge_candidates(integer) to service_role;

-- Markeert bestanden als opgeruimd (de bytes zijn dan al uit R2) en sluit de
-- zending af zodra alles weg is. Concepten die opgeruimd zijn verdwijnen
-- helemaal; van verstuurde zendingen blijven de gegevens als bewijs staan
-- (wie, wat, wanneer), zonder de inhoud.
create or replace function public.file_transfer_mark_purged(p_item_ids uuid[])
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de opruimtaak mag dit aanroepen.' using errcode = '42501';
  end if;

  update public.file_transfer_items i
     set purged_at = now(),
         html_snapshot = null
   where i.id = any(coalesce(p_item_ids, '{}'::uuid[]))
     and i.purged_at is null;
  get diagnostics v_count = row_count;

  -- Verstuurde zendingen waarvan niets meer over is: afgesloten.
  with done as (
    update public.file_transfers t
       set purged_at = now()
     where t.purged_at is null
       and t.status in ('expired', 'revoked')
       and not exists (
         select 1 from public.file_transfer_items i
          where i.transfer_id = t.id and i.purged_at is null)
    returning t.id, t.organization_id
  )
  insert into public.file_transfer_events (organization_id, transfer_id, kind)
  select d.organization_id, d.id, 'purged' from done d;

  -- Achtergelaten concepten: weg, inclusief de rij.
  delete from public.file_transfers t
   where t.status = 'draft'
     and t.created_at < now() - interval '1 day'
     and not exists (
       select 1 from public.file_transfer_items i
        where i.transfer_id = t.id and i.purged_at is null);

  -- Verlopen sessies en codes hebben geen nut meer.
  delete from public.file_transfer_sessions s where s.expires_at < now() - interval '1 hour';
  delete from public.file_transfer_codes c
   where c.code_hash is null and (c.locked_until is null or c.locked_until < now())
     and c.updated_at < now() - interval '1 day';

  return v_count;
end;
$$;

revoke all on function public.file_transfer_mark_purged(uuid[]) from public, anon, authenticated;
grant execute on function public.file_transfer_mark_purged(uuid[]) to service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Opslagmeter, auditmodule, pushmelding, e-mailsjabloon
-- ════════════════════════════════════════════════════════════════════════════

-- ── 5a. Zendingen tellen mee in het opslagquotum ──────────────────────────
-- Gelijk aan 20260818000000, met transfers_bytes erbij: alles wat er als eigen
-- kopie van een zending in R2 staat en nog niet is opgeruimd (concepten
-- inbegrepen). De kolom komt achteraan, zodat bestaande lezers niets merken.
drop function if exists public.organization_storage_status(uuid);

create function public.organization_storage_status(p_organization_id uuid)
returns table (
  used_bytes bigint,
  attachments_bytes bigint,
  documents_bytes bigint,
  recordings_bytes bigint,
  gallery_bytes bigint,
  contracts_bytes bigint,
  limit_bytes bigint,
  plan_storage_gb integer,
  storage_addons integer,
  storage_addon_gb integer,
  transfers_bytes bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_attachments bigint := 0;
  v_documents bigint := 0;
  v_recordings bigint := 0;
  v_gallery bigint := 0;
  v_covers bigint := 0;
  v_contracts bigint := 0;
  v_transfers bigint := 0;
  v_contract_expr text;
  v_profile public.organization_billing_profiles;
  v_plan public.billing_plans;
  v_plan_gb integer;
  v_addon_gb integer;
  v_addons integer := 0;
  v_limit bigint;
  v_family uuid[];
begin
  if auth.role() <> 'service_role' and not public.can_read_org(p_organization_id) then
    raise exception 'Geen toegang tot het opslagverbruik van deze organisatie.' using errcode = '42501';
  end if;

  select array(select public.org_family(p_organization_id)) into v_family;

  select coalesce(sum(a.size_bytes), 0) into v_attachments
  from public.attachments a where a.organization_id = any(v_family);

  select coalesce(sum(coalesce(d.size_bytes, 0)), 0) into v_documents
  from public.documents d where d.organization_id = any(v_family);

  select coalesce(sum(coalesce(mr.size_bytes, 0)), 0) into v_recordings
  from public.meeting_recordings mr where mr.organization_id = any(v_family);

  select coalesce(sum(gi.size_bytes + gi.derived_bytes), 0) into v_gallery
  from public.gallery_items gi where gi.organization_id = any(v_family);

  select coalesce(sum(coalesce(g.cover_bytes, 0)), 0) into v_covers
  from public.galleries g where g.organization_id = any(v_family);
  v_gallery := v_gallery + v_covers;

  select coalesce(sum(i.size_bytes), 0) into v_transfers
  from public.file_transfer_items i
  where i.organization_id = any(v_family)
    and i.purged_at is null
    and i.storage_key is not null;

  select nullif(concat_ws(' + ',
    case when exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'contracts' and column_name = 'body_size_bytes')
      then 'coalesce(c.body_size_bytes, 0)' end,
    case when exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'contracts' and column_name = 'signed_pdf_size_bytes')
      then 'coalesce(c.signed_pdf_size_bytes, 0)' end
  ), '') into v_contract_expr;

  if v_contract_expr is not null then
    execute format('select coalesce(sum(%s), 0)::bigint from public.contracts c where c.organization_id = any($1)', v_contract_expr)
      into v_contracts using v_family;
  end if;

  select * into v_profile
  from public.organization_billing_profiles p
  where p.organization_id = public.billing_root_organization(p_organization_id);

  if found and not v_profile.billing_exempt then
    select * into v_plan from public.billing_plans bp where bp.plan_key = v_profile.plan_key;
    if found and (v_plan.limits ? 'storage_gb') then
      v_plan_gb := nullif(v_plan.limits->>'storage_gb', '')::integer;
      v_addon_gb := coalesce(nullif(v_plan.limits->>'storage_addon_gb', '')::integer, 100);
      v_addons := coalesce(v_profile.storage_addons, 0);
      if v_plan_gb is not null then
        v_limit := (v_plan_gb::bigint + v_addons::bigint * v_addon_gb::bigint) * 1073741824;
      end if;
    end if;
  end if;

  return query select
    (v_attachments + v_documents + v_recordings + v_gallery + v_contracts + v_transfers),
    v_attachments,
    v_documents,
    v_recordings,
    v_gallery,
    v_contracts,
    v_limit,
    v_plan_gb,
    v_addons,
    v_addon_gb,
    v_transfers;
end;
$$;

revoke all on function public.organization_storage_status(uuid) from public, anon;
grant execute on function public.organization_storage_status(uuid) to authenticated, service_role;

-- ── 5a2. Wie verwijst naar een opslagsleutel? ─────────────────────────────
-- Versturen en delen toetsen dat de sleutel van een bijlage of document bij
-- precies dat ene item hoort (een teamlid schrijft de sleutel zelf; de
-- database toetst alleen het organisatieprefix). Zonder index is dat bij een
-- grote Inhoud een volledige scan.
create index if not exists idx_attachments_storage_key on public.attachments (organization_id, storage_key);
create index if not exists idx_documents_storage_key on public.documents (organization_id, storage_key) where storage_key is not null;

-- ── 5b. Activiteitenlog: zendingen horen bij Inhoud ───────────────────────
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
    when p_entity_type in ('attachment', 'content_folder', 'document', 'drive_share', 'file_transfer', 'note', 'note_handwriting') then 'content'
    when p_entity_type in ('saved_report') then 'stats'
    else 'admin'
  end;
$$;

-- ── 5c. Pushmelding "Bestanden gedownload" ────────────────────────────────
-- De volledige lijst uit 20260918010000, plus 'file_transfer_downloaded'.
do $$
declare
  c record;
begin
  for c in
    select conname, conrelid::regclass as tbl
      from pg_constraint
     where contype = 'c'
       and conrelid in ('public.notification_outbox'::regclass, 'public.notification_preferences'::regclass)
       and pg_get_constraintdef(oid) like '%event_type%'
  loop
    execute format('alter table %s drop constraint %I', c.tbl, c.conname);
  end loop;
end $$;

alter table public.notification_outbox add constraint notification_outbox_event_type_check
  check (event_type in ('ticket_new','ticket_note_client','chat_message','client_email_inbound','booking_new','invoice_paid','decision_digest','mcp_proposal','purchase_invoice_inbox','file_transfer_downloaded'));
alter table public.notification_preferences add constraint notification_preferences_event_type_check
  check (event_type in ('ticket_new','ticket_note_client','chat_message','client_email_inbound','booking_new','invoice_paid','decision_digest','mcp_proposal','purchase_invoice_inbox','file_transfer_downloaded'));

-- ── 5d. E-mailsjabloon "Bestanden verstuurd" ──────────────────────────────
do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.email_templates'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%template_key%'
  loop
    execute format('alter table public.email_templates drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.email_templates
  add constraint email_templates_template_key_check
  check (template_key in (
    'quote.sent',
    'invoice.sent',
    'invoice.reminder.1',
    'invoice.reminder.2',
    'invoice.reminder.3',
    'creditNote.sent',
    'contract.sent',
    'contract.signed.client',
    'meetingBooking.linkSent',
    'meetingBooking.confirmed',
    'file.shared',
    'file.transfer',
    'portal.ticket.received',
    'portal.ticket.created',
    'portal.ticket.reply',
    'portal.ticket.status'
  ));

commit;
