-- ============================================================
-- ResoFly — Contract-editor: sjablonen, versies, bedrag (fase 2, deel A1)
-- Date: 2026-06-22
--
-- Backend-fundament voor de contract-editor:
--  - contract_templates: herbruikbare contractsjablonen (rich-text body).
--  - contracts.amount_cents/currency: bedrag voor de {{bedrag}}-variabele
--    (handmatig in te vullen of over te nemen uit een gekoppelde offerte).
--  - contracts.template_id: herkomst-sjabloon (informatief).
--  - contract_versions: onveranderlijke snapshot van de verstuurde versie
--    (honoreert "immutable na versturen"); naast het getekende PDF.
--
-- Snapshots worden uitsluitend aangemaakt via snapshot_contract_version
-- (security definer, service-role); de tabel heeft geen schrijf-policies en is
-- daarmee onveranderbaar voor de client.
-- ============================================================

create extension if not exists pgcrypto;

begin;

-- ------------------------------------------------------------
-- 1. Contractsjablonen
-- ------------------------------------------------------------
create table if not exists public.contract_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  name text not null,
  body text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contract_templates_name_not_blank check (length(btrim(name)) > 0)
);
create index if not exists idx_contract_templates_org on public.contract_templates(organization_id, is_active, name);

drop trigger if exists contract_templates_updated on public.contract_templates;
create trigger contract_templates_updated before update on public.contract_templates
  for each row execute function public.set_updated_at();

drop trigger if exists contract_templates_prevent_org_change on public.contract_templates;
create trigger contract_templates_prevent_org_change before update of organization_id on public.contract_templates
  for each row execute function public.prevent_organization_id_change();

drop trigger if exists contract_templates_audit on public.contract_templates;
create trigger contract_templates_audit after insert or update or delete on public.contract_templates
  for each row execute function public.audit_row_change('contract_template', 'name');

alter table public.contract_templates enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='contract_templates' and policyname='contract templates read') then
    create policy "contract templates read" on public.contract_templates for select using (public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='contract_templates' and policyname='contract templates insert') then
    create policy "contract templates insert" on public.contract_templates for insert with check (public.can_write_org(organization_id) and created_by = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='contract_templates' and policyname='contract templates update') then
    create policy "contract templates update" on public.contract_templates for update using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='contract_templates' and policyname='contract templates delete') then
    create policy "contract templates delete" on public.contract_templates for delete using (public.can_write_org(organization_id));
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. Bedrag + sjabloon-herkomst op contracten
-- ------------------------------------------------------------
alter table public.contracts
  add column if not exists amount_cents bigint,
  add column if not exists currency text not null default 'EUR',
  add column if not exists template_id uuid references public.contract_templates(id) on delete set null;

-- ------------------------------------------------------------
-- 3. Onveranderlijke contractversies
-- ------------------------------------------------------------
create table if not exists public.contract_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contract_id uuid not null references public.contracts(id) on delete cascade,
  version_number integer not null,
  snapshot_reason text not null check (snapshot_reason in ('sent_to_client','signed','superseded','manual')),
  title text not null default '',
  body text not null default '',
  amount_cents bigint,
  currency text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (organization_id, contract_id, version_number)
);
create index if not exists idx_contract_versions_contract
  on public.contract_versions(organization_id, contract_id, version_number desc);

alter table public.contract_versions enable row level security;
-- Alleen-lezen voor leden; aanmaken uitsluitend via snapshot_contract_version (service role).
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='contract_versions' and policyname='contract versions read') then
    create policy "contract versions read" on public.contract_versions for select using (public.can_read_org(organization_id));
  end if;
end $$;

create or replace function public.snapshot_contract_version(
  p_contract_id uuid,
  p_organization_id uuid,
  p_reason text,
  p_title text,
  p_body text,
  p_amount_cents bigint default null,
  p_currency text default null,
  p_created_by uuid default null
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
    organization_id, contract_id, version_number, snapshot_reason, title, body, amount_cents, currency, created_by
  ) values (
    p_organization_id, p_contract_id, v_next, p_reason, coalesce(p_title, ''), coalesce(p_body, ''), p_amount_cents, p_currency, p_created_by
  ) returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.snapshot_contract_version(uuid, uuid, text, text, text, bigint, text, uuid) to service_role;

commit;
