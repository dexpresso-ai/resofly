-- ============================================================
-- ResoFly — Bestanden delen (drive_shares)
-- Date: 2026-08-23
--
-- Aanleiding:
-- De cloud-drive ("Bestanden" in het klantdossier en de Inhoud-pagina) kende
-- geen enkele manier om iets met een mens buiten je eigen scherm te delen.
-- Alles was óf zichtbaar voor de hele organisatie, óf voor niemand.
--
-- Scope:
-- - Eén deeltabel voor álle drive-objecten: map, geüpload bestand, notitie en
--   document. Wie deelt, met wie, tot wanneer, en of downloaden mag.
-- - Drie soorten ontvangers:
--     'contact' — een geregistreerde contactpersoon van de klant. Ziet het
--                 bestand in het klantportaal (/portal → Bestanden).
--     'member'  — een collega in dezelfde organisatie. Krijgt een melding met
--                 een link; die had al toegang, dit is een wegwijzer.
--     'link'    — een los e-mailadres, dat via een geheime deellink
--                 (/gedeeld/<token>) bij het bestand kan.
--
-- DE KERNREGEL (de reden dat dit een trigger is en geen UI-controle):
--   Hoort het item bij een klantdossier, dan mag het UITSLUITEND worden gedeeld
--   met een geregistreerde, actieve contactpersoon van diezelfde klant. Een open
--   deellink naar een willekeurig e-mailadres wordt dan geweigerd door de
--   database — niet door het scherm, want een scherm is geen slot.
--
-- Ontwerp:
-- - `drive_item_client()` leidt de klant/project-context af uit het item zelf.
--   De client mag die nooit meesturen: de trigger overschrijft wat er staat.
-- - Deellinks bewaren alleen `sha256hex(token)` (zelfde patroon als offertes,
--   facturen, contracten en galerijen). De platte token bestaat alleen in de
--   verstuurde e-mail en in de URL.
-- - Portaal en publieke pagina lezen via service-role RPC's; RLS blijft dus
--   dicht voor anon/authenticated. Een klant is geen organisatielid en krijgt
--   via de gewone app nul toegang.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Waar hoort dit item bij? ─────────────────────────────────────────────
-- Leidt de klant- en projectcontext af uit het item zelf. Dit is de enige bron
-- van waarheid voor "is dit klantgerelateerd?" — de browser doet hier niet aan
-- mee. Onbekende of niet-bestaande items geven een fout: fail-closed, want een
-- item waarvan we de klant niet kunnen vaststellen mag je niet zomaar delen.
create or replace function public.drive_item_client(
  p_organization_id uuid,
  p_item_type text,
  p_item_id uuid
)
returns table (client_id uuid, project_id uuid, item_name text, client_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_client_id  uuid;
  v_project_id uuid;
  v_name       text;
  v_att        public.attachments;
begin
  if p_item_type = 'folder' then
    select f.client_id, f.project_id, f.name into v_client_id, v_project_id, v_name
    from public.content_folders f
    where f.id = p_item_id and f.organization_id = p_organization_id;
    if not found then
      raise exception 'Deze map bestaat niet (meer) in deze organisatie.' using errcode = '02000';
    end if;

  elsif p_item_type = 'note' then
    select n.client_id, n.project_id, n.title into v_client_id, v_project_id, v_name
    from public.notes n
    where n.id = p_item_id and n.organization_id = p_organization_id;
    if not found then
      raise exception 'Deze notitie bestaat niet (meer) in deze organisatie.' using errcode = '02000';
    end if;

  elsif p_item_type = 'document' then
    select d.client_id, d.project_id, d.title into v_client_id, v_project_id, v_name
    from public.documents d
    where d.id = p_item_id and d.organization_id = p_organization_id;
    if not found then
      raise exception 'Dit document bestaat niet (meer) in deze organisatie.' using errcode = '02000';
    end if;

  elsif p_item_type = 'attachment' then
    select * into v_att
    from public.attachments a
    where a.id = p_item_id and a.organization_id = p_organization_id;
    if not found then
      raise exception 'Dit bestand bestaat niet (meer) in deze organisatie.' using errcode = '02000';
    end if;
    v_name := v_att.name;

    -- Een attachment kent zelf geen klant; die hangt aan het ding waar hij aan
    -- vastzit. Alleen de types die in de drive voorkomen (plus de voor de hand
    -- liggende buren) worden hier vertaald; de rest weigeren we bewust.
    case v_att.entity_type
      when 'folder' then
        select f.client_id, f.project_id into v_client_id, v_project_id
        from public.content_folders f where f.id = v_att.entity_id;
      when 'client' then
        v_client_id := v_att.entity_id;
      when 'project' then
        select p.client_id, p.id into v_client_id, v_project_id
        from public.projects p where p.id = v_att.entity_id;
      when 'note' then
        select n.client_id, n.project_id into v_client_id, v_project_id
        from public.notes n where n.id = v_att.entity_id;
      when 'document' then
        select d.client_id, d.project_id into v_client_id, v_project_id
        from public.documents d where d.id = v_att.entity_id;
      when 'task' then
        select t.client_id, t.project_id into v_client_id, v_project_id
        from public.tasks t where t.id = v_att.entity_id;
      when 'ticket' then
        select t.client_id into v_client_id
        from public.tickets t where t.id = v_att.entity_id;
      else
        raise exception 'Dit soort bestand (%) kan niet via de bestandenmodule worden gedeeld.', v_att.entity_type
          using errcode = '23514';
    end case;

  else
    raise exception 'Onbekend itemtype om te delen: %', p_item_type using errcode = '23514';
  end if;

  -- Zelfde regel als de Inhoud-verkenner: hangt er een project aan, dan telt de
  -- klant van dát project — niet een eventueel afwijkende klantkoppeling op het
  -- item zelf. Zo kan een item nooit "van niemand" lijken terwijl het via het
  -- project wél bij een klant hoort.
  if v_project_id is not null then
    select coalesce(p.client_id, v_client_id) into v_client_id
    from public.projects p
    where p.id = v_project_id and p.organization_id = p_organization_id;
  end if;

  return query
  select
    v_client_id,
    v_project_id,
    nullif(btrim(coalesce(v_name, '')), ''),
    (select c.name from public.clients c where c.id = v_client_id);
end;
$$;

comment on function public.drive_item_client(uuid, text, uuid) is
  'Leidt klant + project af uit een drive-item (map, bestand, notitie, document). Enige bron van waarheid voor "is dit klantgerelateerd?".';

-- Bewust NIET uitvoerbaar door ingelogde browsers: met een willekeurige
-- organisatie-id zou je anders kunnen aftasten of een map/bestand daar bestaat
-- en bij welke klant het hoort. De trigger hieronder draait als security definer
-- en heeft de rechten dus zelf al.
revoke all on function public.drive_item_client(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.drive_item_client(uuid, text, uuid) to service_role;

-- Dezelfde afleiding, maar dan bruikbaar midden in een query: een verdwenen of
-- niet-deelbaar item levert geen fout maar nul rijen op. Een lateral join hierop
-- laat de rij dan vanzelf vallen — fail closed, zonder de hele query te slopen.
create or replace function public.drive_item_client_safe(
  p_organization_id uuid,
  p_item_type text,
  p_item_id uuid
)
returns table (client_id uuid, project_id uuid, item_name text, client_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return query select * from public.drive_item_client(p_organization_id, p_item_type, p_item_id);
exception
  when others then
    return;
end;
$$;

revoke all on function public.drive_item_client_safe(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.drive_item_client_safe(uuid, text, uuid) to service_role;

-- ── 2. De deeltabel ─────────────────────────────────────────────────────────

create table if not exists public.drive_shares (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),

  -- Wat wordt gedeeld
  item_type text not null check (item_type in ('folder', 'attachment', 'note', 'document')),
  item_id uuid not null,
  -- Naamsnapshot, zodat een e-mail/portaalregel leesbaar blijft en de naam in de
  -- deelgeschiedenis niet meeverandert als het bestand later wordt hernoemd.
  item_name text,

  -- Server-side afgeleide context. NOOIT uit de client overgenomen: de trigger
  -- overschrijft deze twee kolommen bij elke insert/update.
  client_id uuid references public.clients(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,

  -- Met wie
  recipient_kind text not null check (recipient_kind in ('contact', 'member', 'link')),
  client_contact_id uuid references public.client_contacts(id) on delete cascade,
  member_user_id uuid references auth.users(id) on delete cascade,
  recipient_email text,
  recipient_name text,

  -- Rechten en levensduur
  can_download boolean not null default true,
  message text,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null,

  -- Alleen voor recipient_kind = 'link': sha256hex van de deeltoken.
  token_hash text,

  last_viewed_at timestamptz,
  view_count integer not null default 0 check (view_count >= 0),
  notified_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Precies één ontvanger-anker per soort.
  constraint drive_shares_recipient_shape check (
    (recipient_kind = 'contact' and client_contact_id is not null and member_user_id is null and token_hash is null)
    or (recipient_kind = 'member' and member_user_id is not null and client_contact_id is null and token_hash is null)
    or (recipient_kind = 'link' and client_contact_id is null and member_user_id is null and recipient_email is not null)
  ),
  constraint drive_shares_message_length check (message is null or char_length(message) <= 2000)
);

comment on table public.drive_shares is
  'Wie mag welk drive-item (map/bestand/notitie/document) zien. Klantgerelateerde items mogen alleen naar geregistreerde contactpersonen van diezelfde klant.';
comment on column public.drive_shares.client_id is
  'Server-side afgeleid uit het item (drive_item_client). Gevuld = klantgerelateerd = alleen contactpersonen van deze klant.';
comment on column public.drive_shares.token_hash is
  'sha256hex van de deeltoken. De platte token staat alleen in de verstuurde e-mail; hier nooit.';

-- Kolommen die in een eerdere run van deze migratie nog niet bestonden.
alter table public.drive_shares add column if not exists item_name text;
alter table public.drive_shares add column if not exists revoked_by uuid references auth.users(id) on delete set null;
alter table public.drive_shares add column if not exists notified_at timestamptz;

create index if not exists idx_drive_shares_org_item
  on public.drive_shares (organization_id, item_type, item_id);
create index if not exists idx_drive_shares_client
  on public.drive_shares (organization_id, client_id) where client_id is not null;
create index if not exists idx_drive_shares_contact
  on public.drive_shares (client_contact_id) where client_contact_id is not null;
create index if not exists idx_drive_shares_member
  on public.drive_shares (member_user_id) where member_user_id is not null;
create unique index if not exists idx_drive_shares_token
  on public.drive_shares (token_hash) where token_hash is not null;

-- Eén actieve deling per (item, ontvanger). Opnieuw delen werkt daardoor als
-- bijwerken in plaats van als stapelen; ingetrokken delingen blijven bewaard
-- als geschiedenis.
create unique index if not exists idx_drive_shares_active_contact
  on public.drive_shares (item_type, item_id, client_contact_id)
  where revoked_at is null and client_contact_id is not null;
create unique index if not exists idx_drive_shares_active_member
  on public.drive_shares (item_type, item_id, member_user_id)
  where revoked_at is null and member_user_id is not null;
create unique index if not exists idx_drive_shares_active_link
  on public.drive_shares (item_type, item_id, recipient_email)
  where revoked_at is null and recipient_kind = 'link';

-- ── 3. De kernregel als trigger ─────────────────────────────────────────────

-- SECURITY DEFINER: de regel moet gelden ook als de schrijver de contactpersoon
-- of het item zelf niet mag lezen. Vaste search_path zodat er niets omheen kan.
create or replace function public.enforce_drive_share_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx      record;
  v_contact  public.client_contacts;
  v_member   record;
begin
  -- Een deling mag NOOIT al ingetrokken worden aangemaakt. Zonder deze regel kun
  -- je de hele controle hieronder overslaan met een insert die revoked_at al
  -- gevuld heeft, en daarna met één update op revoked_at de deling alsnog scherp
  -- zetten. Dat is precies de achterdeur die deze trigger moet dichthouden.
  if TG_OP = 'INSERT' then
    new.revoked_at := null;
    new.revoked_by := null;
  elsif old.revoked_at is not null and new.revoked_at is not null then
    -- Al ingetrokken en blijft ingetrokken: die rij geeft nergens toegang, er is
    -- niets te bewaken. Weer scherp zetten (revoked_at terug op null) valt hier
    -- NIET onder en loopt dus gewoon langs alle regels hieronder.
    return new;
  end if;

  new.recipient_name := nullif(btrim(coalesce(new.recipient_name, '')), '');
  new.message := nullif(btrim(coalesce(new.message, '')), '');
  new.recipient_email := public.normalize_client_lookup_value(new.recipient_email);

  select * into v_ctx
  from public.drive_item_client(new.organization_id, new.item_type, new.item_id);

  -- De klantcontext komt altijd van de server. Wat de client meestuurde telt niet.
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

    -- HET SLOT: klantgerelateerd → alleen een geregistreerde contactpersoon van
    -- diezelfde klant, binnen dezelfde organisatie.
    if v_contact.organization_id <> new.organization_id or v_contact.client_id <> new.client_id then
      raise exception 'Dit bestand hoort bij klantdossier “%”. Het mag alleen worden gedeeld met een geregistreerde contactpersoon van diezelfde klant.',
        coalesce(v_ctx.client_name, 'onbekend') using errcode = '42501';
    end if;
    if not v_contact.is_active then
      raise exception 'Contactpersoon “%” staat op inactief. Activeer die eerst bij de klant.', v_contact.name
        using errcode = '23514';
    end if;
    -- Zonder portaaltoegang komt deze persoon het portaal niet in en ziet hij het
    -- gedeelde bestand dus nooit. Dezelfde eis als portal_drive_shares_for_email
    -- hieronder: één regel aan beide kanten, anders lukt het delen wel maar
    -- gebeurt er niets.
    if not v_contact.gives_portal_access then
      raise exception 'Contactpersoon “%” heeft geen portaaltoegang. Zet die eerst aan bij de klant, anders kan hij het bestand niet openen.', v_contact.name
        using errcode = '23514';
    end if;

    new.recipient_email := public.normalize_client_lookup_value(v_contact.email);
    new.recipient_name := v_contact.name;
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
    -- Klantgerelateerd? Dan geen open deellink. Dit is de andere helft van het slot.
    if new.client_id is not null then
      raise exception 'Dit bestand hoort bij klantdossier “%”. Klantgerelateerde bestanden mogen alleen worden gedeeld met de geregistreerde contactpersonen van die klant, niet via een open deellink.',
        coalesce(v_ctx.client_name, 'onbekend') using errcode = '42501';
    end if;
    if new.recipient_email is null then
      raise exception 'Vul een geldig e-mailadres in om een deellink te versturen.' using errcode = '23514';
    end if;
    if new.recipient_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
      raise exception 'Vul een geldig e-mailadres in om een deellink te versturen.' using errcode = '23514';
    end if;
    -- Intrekken zet token_hash op null; dat is juist de bedoeling en mag hier
    -- niet stranden. Een lópende deellink moet wél een token hebben.
    if new.revoked_at is null and nullif(btrim(coalesce(new.token_hash, '')), '') is null then
      raise exception 'Een deellink kan niet zonder token worden aangemaakt.' using errcode = '23514';
    end if;
    new.client_contact_id := null;
    new.member_user_id := null;
  end if;

  return new;
end;
$$;

drop trigger if exists drive_shares_guard on public.drive_shares;
-- De kolomlijst bevat ALLES wat iets over toegang zegt — revoked_at voorop, want
-- zonder die kolom vuurt de trigger niet bij "zet revoked_at terug op null" en is
-- de hele controle met één update te omzeilen. Alleen de tellers
-- (last_viewed_at, view_count, notified_at) staan er bewust niet in: die
-- veranderen bij elke weergave en hebben niets met toegang te maken.
create trigger drive_shares_guard
  before insert or update of organization_id, item_type, item_id, item_name, client_id, project_id,
    recipient_kind, client_contact_id, member_user_id, recipient_email, recipient_name,
    can_download, message, expires_at, revoked_at, revoked_by, token_hash
  on public.drive_shares
  for each row execute function public.enforce_drive_share_rules();

drop trigger if exists drive_shares_touch_updated_at on public.drive_shares;
create trigger drive_shares_touch_updated_at
  before update on public.drive_shares
  for each row execute function public.set_updated_at();

drop trigger if exists drive_shares_prevent_org_change on public.drive_shares;
create trigger drive_shares_prevent_org_change
  before update of organization_id on public.drive_shares
  for each row execute function public.prevent_organization_id_change();

drop trigger if exists drive_shares_audit on public.drive_shares;
-- Zelfde kolomlijst-gedachte: een deling die alleen maar bekeken wordt hoort niet
-- in het activiteitenlog. Zonder deze lijst schrijft elke weergave van een
-- deellink een auditregel en verdrinken de echte gebeurtenissen erin.
create trigger drive_shares_audit
  after insert or delete or update of item_type, item_id, item_name, client_id, project_id,
    recipient_kind, client_contact_id, member_user_id, recipient_email, recipient_name,
    can_download, message, expires_at, revoked_at, token_hash
  on public.drive_shares
  for each row execute function public.audit_row_change('drive_share', 'item_name');

-- ── 4. Opruimen als het gedeelde item verdwijnt ─────────────────────────────
-- De koppeling is polymorf, dus een foreign key kan dit niet. Zonder deze
-- triggers zou een verwijderd bestand als "gedeeld" in het portaal blijven staan.
-- SECURITY DEFINER: opruimen mag nooit de verwijdering zelf blokkeren, ook niet
-- als degene die het item weggooit geen schrijfrechten op de Inhoud-module heeft.
create or replace function public.cleanup_drive_shares_for_item()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.drive_shares s
  where s.item_type = TG_ARGV[0]
    and s.item_id = old.id;
  return old;
end;
$$;

drop trigger if exists content_folders_cleanup_shares on public.content_folders;
create trigger content_folders_cleanup_shares
  after delete on public.content_folders
  for each row execute function public.cleanup_drive_shares_for_item('folder');

drop trigger if exists attachments_cleanup_shares on public.attachments;
create trigger attachments_cleanup_shares
  after delete on public.attachments
  for each row execute function public.cleanup_drive_shares_for_item('attachment');

drop trigger if exists notes_cleanup_shares on public.notes;
create trigger notes_cleanup_shares
  after delete on public.notes
  for each row execute function public.cleanup_drive_shares_for_item('note');

drop trigger if exists documents_cleanup_shares on public.documents;
create trigger documents_cleanup_shares
  after delete on public.documents
  for each row execute function public.cleanup_drive_shares_for_item('document');

-- ── 5. RLS ──────────────────────────────────────────────────────────────────

alter table public.drive_shares enable row level security;

drop policy if exists "drive_shares read" on public.drive_shares;
create policy "drive_shares read" on public.drive_shares for select using (
  public.can_read_org(organization_id)
);

drop policy if exists "drive_shares insert" on public.drive_shares;
create policy "drive_shares insert" on public.drive_shares for insert with check (
  public.can_write_org(organization_id)
);

drop policy if exists "drive_shares update" on public.drive_shares;
create policy "drive_shares update" on public.drive_shares for update using (
  public.can_write_org(organization_id)
) with check (
  public.can_write_org(organization_id)
);

drop policy if exists "drive_shares delete" on public.drive_shares;
create policy "drive_shares delete" on public.drive_shares for delete using (
  public.can_write_org(organization_id)
);

-- Delen hoort bij de Inhoud-module, net als mappen, notities en documenten.
select public.apply_module_gate('drive_shares', 'content');

-- De module-poort mag niet op DELETE staan. Verwijdert iemand een bestand dat
-- buiten de Inhoud-module valt (een bijlage bij een ticket bijvoorbeeld), dan
-- ruimt cleanup_drive_shares_for_item hieronder de deling op — en die opruiming
-- zou dan stranden op een module waar de gebruiker niets mee te maken had. Het
-- restrictieve DELETE-beleid blijft staan; alleen de rij-trigger vervalt.
drop trigger if exists zzz_module_write_gate on public.drive_shares;
create trigger zzz_module_write_gate
  before insert or update on public.drive_shares
  for each row execute function public.enforce_module_write_access('content', 'write');

-- ── 6. Een deling uitklappen naar wat je daadwerkelijk kunt openen ──────────
-- Deel je een map, dan deel je de inhoud mee — inclusief submappen. Deze functie
-- levert de bladeren van die boom, met het pad binnen de gedeelde map erbij.
create or replace function public.drive_share_items(p_share_id uuid)
returns table (
  item_type text,
  item_id uuid,
  name text,
  mime_type text,
  size_bytes bigint,
  storage_key text,
  modified timestamptz,
  path text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_share  public.drive_shares;
  v_client uuid;
begin
  select * into v_share from public.drive_shares s where s.id = p_share_id;
  if not found then
    return;
  end if;

  -- De klant van de deling, LIVE afgeleid. Elk blad moet bij diezelfde klant
  -- horen; anders zou een submap of een later verplaatste notitie van een ándere
  -- klant meeliften op deze deling.
  select ctx.client_id into v_client
  from public.drive_item_client_safe(v_share.organization_id, v_share.item_type, v_share.item_id) ctx;

  if v_share.item_type = 'folder' then
    return query
    with recursive tree as (
      select f.id, f.name, ''::text as path, 0 as depth
      from public.content_folders f
      where f.id = v_share.item_id and f.organization_id = v_share.organization_id
      union all
      select c.id, c.name, case when t.path = '' then t.name else t.path || ' / ' || t.name end, t.depth + 1
      from public.content_folders c
      join tree t on c.parent_id = t.id
      where t.depth < 20
        and c.organization_id = v_share.organization_id
        and coalesce((select p.client_id from public.projects p where p.id = c.project_id), c.client_id)
            is not distinct from v_client
    )
    select 'attachment'::text, a.id, a.name, a.mime_type, a.size_bytes, a.storage_key,
           a.created_at,
           case when t.path = '' then t.name else t.path || ' / ' || t.name end
    from tree t
    join public.attachments a
      on a.entity_type = 'folder' and a.entity_id = t.id
     and a.organization_id = v_share.organization_id
    union all
    select 'note'::text, n.id, n.title, 'text/html'::text, 0::bigint, null::text,
           coalesce(n.updated_at, n.created_at),
           case when t.path = '' then t.name else t.path || ' / ' || t.name end
    from tree t
    join public.notes n on n.folder_id = t.id and n.organization_id = v_share.organization_id
     and coalesce((select p.client_id from public.projects p where p.id = n.project_id), n.client_id)
         is not distinct from v_client
    union all
    select 'document'::text, d.id, d.title,
           coalesce(d.mime_type, 'text/html'), coalesce(d.size_bytes, 0)::bigint, d.storage_key,
           coalesce(d.updated_at, d.created_at),
           case when t.path = '' then t.name else t.path || ' / ' || t.name end
    from tree t
    join public.documents d on d.folder_id = t.id and d.organization_id = v_share.organization_id
     and coalesce((select p.client_id from public.projects p where p.id = d.project_id), d.client_id)
         is not distinct from v_client;

  elsif v_share.item_type = 'attachment' then
    return query
    select 'attachment'::text, a.id, a.name, a.mime_type, a.size_bytes, a.storage_key, a.created_at, ''::text
    from public.attachments a
    where a.id = v_share.item_id and a.organization_id = v_share.organization_id;

  elsif v_share.item_type = 'note' then
    return query
    select 'note'::text, n.id, n.title, 'text/html'::text, 0::bigint, null::text,
           coalesce(n.updated_at, n.created_at), ''::text
    from public.notes n
    where n.id = v_share.item_id and n.organization_id = v_share.organization_id;

  else
    return query
    select 'document'::text, d.id, d.title,
           coalesce(d.mime_type, 'text/html'), coalesce(d.size_bytes, 0)::bigint, d.storage_key,
           coalesce(d.updated_at, d.created_at), ''::text
    from public.documents d
    where d.id = v_share.item_id and d.organization_id = v_share.organization_id;
  end if;
end;
$$;

revoke all on function public.drive_share_items(uuid) from public, anon, authenticated;
grant execute on function public.drive_share_items(uuid) to service_role;

-- ── 7. Toegangspaden voor portaal en deellink ───────────────────────────────

-- Alle lopende delingen voor een geverifieerd portaal-e-mailadres. Spiegelt
-- portal_clients_for_email: alleen actieve, portaal-gemachtigde contactpersonen.
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
    -- LIVE afgeleid, niet de opgeslagen momentopname s.client_id: verhuist het
    -- item naar een andere klant, dan vervalt de toegang van deze contactpersoon
    -- op datzelfde moment.
    and ctx.client_id is not null
    and ctx.client_id = cc.client_id
    and public.normalize_client_lookup_value(p_email) is not null
    and public.normalize_client_lookup_value(cc.email) = public.normalize_client_lookup_value(p_email);
$$;

revoke all on function public.portal_drive_shares_for_email(text) from public, anon, authenticated;
grant execute on function public.portal_drive_shares_for_email(text) to service_role;

-- Deellink oplossen. Alleen service_role (de publieke edge function); de token
-- zelf komt nooit in de database, alleen zijn hash.
create or replace function public.resolve_drive_share_link(
  p_token_hash text,
  p_touch boolean default false
)
returns setof public.drive_shares
language plpgsql
security definer
set search_path = public
as $$
declare
  v_share public.drive_shares;
  v_ctx   record;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de deellink-service mag deellinks oplossen.' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_token_hash, '')), '') is null then
    return;
  end if;

  select * into v_share
  from public.drive_shares s
  where s.token_hash = p_token_hash
    and s.recipient_kind = 'link'
    and s.revoked_at is null
    and (s.expires_at is null or s.expires_at > now());
  if not found then
    return;
  end if;

  -- Hercontrole op leestijd. Een item dat ná het delen alsnog aan een klant is
  -- gekoppeld, is vanaf dat moment klantgerelateerd — en dan mag een open
  -- deellink er niet meer bij, hoe geldig de token zelf ook is. Kan de klant niet
  -- worden vastgesteld (item weg), dan ook niet: fail closed.
  select * into v_ctx
  from public.drive_item_client_safe(v_share.organization_id, v_share.item_type, v_share.item_id);
  if not found or v_ctx.client_id is not null then
    return;
  end if;

  if p_touch then
    update public.drive_shares
    set last_viewed_at = now(), view_count = view_count + 1
    where id = v_share.id
      and revoked_at is null
      and (expires_at is null or expires_at > now())
    returning * into v_share;
    -- Verdwijnt de rij tussen het zoeken en het bijwerken, dan zou v_share met
    -- allemaal NULL's gevuld worden en zou de bezoeker een lege, geldig ogende
    -- pagina krijgen in plaats van "deze link bestaat niet meer".
    if not found then
      return;
    end if;
  end if;

  return next v_share;
end;
$$;

revoke all on function public.resolve_drive_share_link(text, boolean) from public, anon, authenticated;
grant execute on function public.resolve_drive_share_link(text, boolean) to service_role;

-- Bijhouden dat een portaalcontact een deling heeft geopend.
create or replace function public.touch_drive_share(p_share_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de portaal-/deellink-service mag dit bijwerken.' using errcode = '42501';
  end if;
  update public.drive_shares
  set last_viewed_at = now(), view_count = view_count + 1
  where id = p_share_id;
end;
$$;

revoke all on function public.touch_drive_share(uuid) from public, anon, authenticated;
grant execute on function public.touch_drive_share(uuid) to service_role;

-- ── 8. E-mailsjabloon "bestand gedeeld" ─────────────────────────────────────
-- De template_key-CHECK wordt telkens gedropt en opnieuw gezet; de naam ervan
-- verschilt per installatie, dus opzoeken in pg_constraint.
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
    'file.shared'
  ));

commit;
