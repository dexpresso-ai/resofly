-- ============================================================
-- ResoFly — Contracten: opstellen in Collabora (Word) + meerdere projecten
-- Date: 2026-08-03
--
-- Twee samenhangende wijzigingen:
--
-- A. OPSTELLEN IN WORD (Collabora/WOPI). Tot nu toe was de contractinhoud één
--    HTML-kolom (`contracts.body`) uit de zelfgebouwde RichTextEditor. Nieuwe
--    contracten krijgen in plaats daarvan een echt .docx-bestand op R2, dat via
--    dezelfde WOPI-host (media-api) in Collabora bewerkt wordt — precies zoals
--    documenten in Word-modus (20260716000000_document_word_mode).
--
--    `editor_mode` maakt dit expliciet en houdt BESTAANDE contracten werkend:
--    'richtext' = de HTML in `body` (legacy, en onveranderlijk voor alles wat al
--    getekend is), 'office' = het .docx op `body_storage_key`. Er wordt niets
--    gemigreerd: een getekend contract is een juridisch stuk en blijft exact
--    zoals het was.
--
--    De PDF komt bij office-contracten niet meer uit de HTML→pdf-lib-parser maar
--    uit Collabora's convert-to. Die conversie gebeurt ÉÉN keer, bij versturen,
--    en wordt vastgelegd op de contractversie (pdf_storage_key + sha256). Die ene
--    PDF is daarna de bron voor de e-mailbijlage, de ondertekenpagina én het
--    getekende exemplaar — dus wat de klant ziet, tekent en terugkrijgt is
--    aantoonbaar hetzelfde document.
--
-- B. MEERDERE PROJECTEN PER CONTRACT. De koppeling zat als `projects.contract_id`
--    op de projectkant: één project → één contract, en de UI las altijd alleen
--    het eerste project. Dat wordt een echte veel-op-veel-koppeltabel
--    (`contract_projects`), gemodelleerd op project_members/task_assignees.
--    `projects.contract_id` wordt niet gedropt maar vervalt als bron van waarheid
--    (zie de opmerking bij de backfill).
--
-- Beveiliging:
-- - contract_projects: RLS via can_read_org/can_write_org + de restrictive
--   module-gate. Gate op 'finance' (nét als contracts zelf) — een lid zonder
--   Financiën ziet de contractrijen sowieso niet, dus een 'projects'-gate zou
--   alleen een halve toestand opleveren waarin je koppelt wat je niet mag zien.
-- - Org-integriteit via assert_same_org_reference PLUS dezelfde klant-match die
--   enforce_projects_contract_integrity op de oude kolom afdwong.
-- - De onveranderlijkheidstrigger van 20260723000000 wordt uitgebreid: na
--   ondertekenen/intrekken zijn óók het bronbestand (body_storage_key) en de
--   editor-modus bevroren — voor iedereen, óók de service-role. Dat is wat de
--   WOPI-PutFile van de media-api tegenhoudt als er na ondertekening nog een
--   oude editorsessie openstaat.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Office-modus op contracten
-- ------------------------------------------------------------
alter table public.contracts
  add column if not exists editor_mode text not null default 'richtext',
  add column if not exists body_storage_key text,
  add column if not exists body_mime_type text,
  add column if not exists body_size_bytes bigint,
  add column if not exists edit_version integer not null default 1,
  add column if not exists last_edited_by uuid references auth.users(id) on delete set null,
  add column if not exists last_edited_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'contracts_editor_mode_check'
  ) then
    alter table public.contracts
      add constraint contracts_editor_mode_check check (editor_mode in ('richtext', 'office'));
  end if;

  -- Een office-contract zónder bestand zou een leeg contract zijn dat wél
  -- verstuurbaar lijkt. De frontend uploadt het .docx vóór de insert, dus dit is
  -- afdwingbaar zonder tussenstand.
  if not exists (
    select 1 from pg_constraint where conname = 'contracts_office_requires_storage_key'
  ) then
    alter table public.contracts
      add constraint contracts_office_requires_storage_key
      check (editor_mode <> 'office' or body_storage_key is not null);
  end if;
end $$;

comment on column public.contracts.editor_mode is
  'richtext = HTML in body (legacy); office = .docx op body_storage_key, bewerkt in Collabora.';
comment on column public.contracts.body_storage_key is
  'R2-sleutel van het .docx-bronbestand (office-modus). Canonieke opslag; contracts.body blijft leeg.';

-- ------------------------------------------------------------
-- 2. Versies: de verstuurde PDF vastleggen
--
--    Bij richtext-contracten is `body` de momentopname. Bij office-contracten
--    bestaat die HTML niet — daar is de bij het versturen gegenereerde PDF het
--    bewijsstuk. Nullable, want legacy-versies hebben hem niet.
-- ------------------------------------------------------------
alter table public.contract_versions
  add column if not exists pdf_storage_key text,
  add column if not exists pdf_sha256 text,
  add column if not exists pdf_size_bytes bigint;

comment on column public.contract_versions.pdf_storage_key is
  'R2-sleutel van de PDF zoals die naar de klant ging (office-modus). Onveranderlijk.';

-- De RPC krijgt de PDF-velden erbij. Eerst de oude signatuur droppen: een
-- overload met extra default-parameters zou aanroepen-op-naam dubbelzinnig maken
-- (42725). Bestaande aanroepen die de nieuwe parameters weglaten blijven werken.
drop function if exists public.snapshot_contract_version(uuid, uuid, text, text, text, bigint, text, uuid);

create or replace function public.snapshot_contract_version(
  p_contract_id uuid,
  p_organization_id uuid,
  p_reason text,
  p_title text,
  p_body text,
  p_amount_cents bigint default null,
  p_currency text default null,
  p_created_by uuid default null,
  p_pdf_storage_key text default null,
  p_pdf_sha256 text default null,
  p_pdf_size_bytes bigint default null
)
returns public.contract_versions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next integer;
  v_row public.contract_versions;
begin
  select coalesce(max(version_number), 0) + 1 into v_next
  from public.contract_versions
  where organization_id = p_organization_id and contract_id = p_contract_id;

  insert into public.contract_versions(
    organization_id, contract_id, version_number, snapshot_reason, title, body,
    amount_cents, currency, created_by, pdf_storage_key, pdf_sha256, pdf_size_bytes
  ) values (
    p_organization_id, p_contract_id, v_next, p_reason, coalesce(p_title, ''), coalesce(p_body, ''),
    p_amount_cents, p_currency, p_created_by, p_pdf_storage_key, p_pdf_sha256, p_pdf_size_bytes
  ) returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.snapshot_contract_version(uuid, uuid, text, text, text, bigint, text, uuid, text, text, bigint)
  from public, anon, authenticated;
grant execute on function public.snapshot_contract_version(uuid, uuid, text, text, text, bigint, text, uuid, text, text, bigint)
  to service_role;

-- ------------------------------------------------------------
-- 3. Onveranderlijkheid uitbreiden naar de office-kolommen
--
--    Herschrijft enforce_contract_signed_immutability uit
--    20260723000000_contract_signed_immutability_and_hardening. Blok (a) en (b)
--    blijven ongewijzigd; blok (c) bevriest er het bronbestand bij.
-- ------------------------------------------------------------
create or replace function public.enforce_contract_signed_immutability()
returns trigger
language plpgsql
as $$
begin
  if TG_OP <> 'UPDATE' then return new; end if;

  -- (a) Anti-forge: op 'signed'/'declined' zetten mag UITSLUITEND vanuit de
  --     service-role (de publieke sign_/decline_contract_public-RPC's).
  if new.status is distinct from old.status
     and new.status in ('signed','declined')
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Een contract kan alleen via de publieke ondertekenflow op "%" worden gezet.', new.status
      using errcode = '42501';
  end if;

  -- (b) Ondertekenbewijs is uitsluitend door de service-role te zetten.
  if coalesce(auth.role(), '') <> 'service_role' then
    if new.signed_document_sha256 is distinct from old.signed_document_sha256
       or new.signed_storage_provider is distinct from old.signed_storage_provider
       or new.signed_storage_key is distinct from old.signed_storage_key
       or new.signed_pdf_file_name is distinct from old.signed_pdf_file_name
       or new.signed_pdf_size_bytes is distinct from old.signed_pdf_size_bytes
       or new.signed_pdf_data_base64 is distinct from old.signed_pdf_data_base64
       or new.signed_at is distinct from old.signed_at then
      raise exception 'Het ondertekenbewijs van een contract kan niet worden gewijzigd.'
        using errcode = '42501';
    end if;
  end if;

  -- (c) Inhoud is definitief zodra het contract getekend of ingetrokken is — voor
  --     iedereen, óók de service-role. Bij office-contracten hoort het .docx daar
  --     net zo goed bij als de HTML bij een richtext-contract: dit is wat een
  --     WOPI-PutFile uit een nog openstaande editorsessie tegenhoudt.
  if old.status in ('signed','voided') then
    if new.title is distinct from old.title
       or new.body is distinct from old.body
       or new.amount_cents is distinct from old.amount_cents
       or new.currency is distinct from old.currency
       or new.date is distinct from old.date
       or new.valid_until is distinct from old.valid_until
       or new.editor_mode is distinct from old.editor_mode
       or new.body_storage_key is distinct from old.body_storage_key
       or new.body_mime_type is distinct from old.body_mime_type
       or new.body_size_bytes is distinct from old.body_size_bytes
       or new.edit_version is distinct from old.edit_version then
      raise exception 'Een getekend of ingetrokken contract kan inhoudelijk niet meer worden gewijzigd.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

-- ------------------------------------------------------------
-- 4. contract_projects — veel-op-veel koppeling
--    Vorm gespiegeld op project_members (20260710040000).
-- ------------------------------------------------------------
create table if not exists public.contract_projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contract_id uuid not null references public.contracts(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  unique (contract_id, project_id)
);

create index if not exists idx_contract_projects_contract
  on public.contract_projects(organization_id, contract_id);
create index if not exists idx_contract_projects_project
  on public.contract_projects(organization_id, project_id);

alter table public.contract_projects enable row level security;

-- Org-integriteit + klant-match. De klant-match spiegelt
-- enforce_projects_contract_integrity: een contract van klant A mag niet aan een
-- project van klant B hangen. FK's alleen bewaken de tenantgrens niet.
create or replace function public.enforce_contract_projects_integrity()
returns trigger
language plpgsql
as $$
declare
  v_contract_client uuid;
  v_project_client  uuid;
begin
  perform public.assert_same_org_reference('public.contracts', new.contract_id, new.organization_id, 'contract_projects.contract_id');
  perform public.assert_same_org_reference('public.projects', new.project_id, new.organization_id, 'contract_projects.project_id');

  select client_id into v_contract_client from public.contracts where id = new.contract_id;
  select client_id into v_project_client  from public.projects  where id = new.project_id;

  if v_contract_client is not null and v_project_client is not null
     and v_contract_client <> v_project_client then
    raise exception 'Een project kan alleen aan een contract van dezelfde klant worden gekoppeld.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists contract_projects_integrity on public.contract_projects;
create trigger contract_projects_integrity
  before insert or update of organization_id, contract_id, project_id on public.contract_projects
  for each row execute function public.enforce_contract_projects_integrity();

drop trigger if exists contract_projects_prevent_org_change on public.contract_projects;
create trigger contract_projects_prevent_org_change
  before update of organization_id on public.contract_projects
  for each row execute function public.prevent_organization_id_change();

drop trigger if exists contract_projects_audit on public.contract_projects;
create trigger contract_projects_audit
  after insert or update or delete on public.contract_projects
  for each row execute function public.audit_row_change('contract_project', 'project_id');

drop policy if exists "contract projects read" on public.contract_projects;
create policy "contract projects read" on public.contract_projects for select using (
  public.can_read_org(organization_id)
);
drop policy if exists "contract projects insert" on public.contract_projects;
create policy "contract projects insert" on public.contract_projects for insert with check (
  public.can_write_org(organization_id)
);
drop policy if exists "contract projects update" on public.contract_projects;
create policy "contract projects update" on public.contract_projects for update using (
  public.can_write_org(organization_id)
) with check (
  public.can_write_org(organization_id)
);
drop policy if exists "contract projects delete" on public.contract_projects;
create policy "contract projects delete" on public.contract_projects for delete using (
  public.can_write_org(organization_id)
);

-- Modulegate: contracten vallen onder Financiën, dus de koppelrij ook.
select public.apply_module_gate('contract_projects', 'finance');

-- ------------------------------------------------------------
-- 5. Backfill vanuit de oude projects.contract_id
--
--    `projects.contract_id` blijft als kolom bestaan (met zijn eigen trigger en
--    de factuur-tegenhanger), maar is na deze migratie geen bron van waarheid
--    meer: alle lezers — de contractpagina, de projectpagina en beide edge
--    functions — gaan over contract_projects. De kolom wordt niet meer geschreven
--    en kan in een latere opruimronde vervallen.
-- ------------------------------------------------------------
insert into public.contract_projects (organization_id, contract_id, project_id, created_by)
select p.organization_id, p.contract_id, p.id, p.created_by
from public.projects p
join public.contracts c on c.id = p.contract_id and c.organization_id = p.organization_id
where p.contract_id is not null
on conflict (contract_id, project_id) do nothing;

comment on column public.projects.contract_id is
  'VERVALLEN sinds 20260803000000 — de contract/projectkoppeling loopt via public.contract_projects (veel-op-veel). Alleen nog aanwezig voor historische rijen.';

commit;
