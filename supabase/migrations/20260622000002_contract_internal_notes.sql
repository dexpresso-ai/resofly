-- ============================================================
-- ResoFly — Interne notities bij contracten (fase 2, deel B)
-- Date: 2026-06-22
--
-- Notities die uitsluitend voor organisatieleden zichtbaar zijn. Ze verschijnen
-- NOOIT op de publieke ondertekenpagina, in PDF's of in e-mails: dit is een
-- aparte tabel die de publieke/PDF/e-mail-code (contract-public, contractPdf,
-- de e-mailtemplates) nergens bevraagt. Lekken is daarmee structureel uitgesloten.
--
-- Per notitie: auteur (created_by + author_name-snapshot), tijdstip en inhoud.
-- Auditlogging op aanmaken/wijzigen/verwijderen via audit_row_change. Alleen de
-- auteur mag een eigen notitie wijzigen/verwijderen; lezen mag elk org-lid.
-- ============================================================

create extension if not exists pgcrypto;

begin;

create table if not exists public.contract_internal_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contract_id uuid not null references public.contracts(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  author_name text,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contract_internal_notes_body_not_blank check (length(btrim(body)) > 0),
  constraint contract_internal_notes_body_len check (char_length(body) <= 10000)
);

create index if not exists idx_contract_internal_notes_contract
  on public.contract_internal_notes(organization_id, contract_id, created_at desc);

drop trigger if exists contract_internal_notes_updated on public.contract_internal_notes;
create trigger contract_internal_notes_updated before update on public.contract_internal_notes
  for each row execute function public.set_updated_at();

drop trigger if exists contract_internal_notes_prevent_org_change on public.contract_internal_notes;
create trigger contract_internal_notes_prevent_org_change
  before update of organization_id on public.contract_internal_notes
  for each row execute function public.prevent_organization_id_change();

-- Org-integriteit: de notitie hoort bij een contract van dezelfde organisatie.
create or replace function public.enforce_contract_notes_org_integrity()
returns trigger language plpgsql as $$
begin
  perform public.assert_same_org_reference('public.contracts', new.contract_id, new.organization_id, 'contract_internal_notes.contract_id');
  return new;
end; $$;

drop trigger if exists contract_internal_notes_org_integrity on public.contract_internal_notes;
create trigger contract_internal_notes_org_integrity
  before insert or update of organization_id, contract_id on public.contract_internal_notes
  for each row execute function public.enforce_contract_notes_org_integrity();

-- Auditspoor (aanmaken/wijzigen/verwijderen), consistent met notes/documents/contracts.
drop trigger if exists contract_internal_notes_audit on public.contract_internal_notes;
create trigger contract_internal_notes_audit
  after insert or update or delete on public.contract_internal_notes
  for each row execute function public.audit_row_change('contract_note', 'author_name');

alter table public.contract_internal_notes enable row level security;

do $$
begin
  -- Lezen: elk organisatielid.
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='contract_internal_notes' and policyname='contract notes read') then
    create policy "contract notes read" on public.contract_internal_notes for select using (public.can_read_org(organization_id));
  end if;
  -- Aanmaken: schrijfrol, als zichzelf.
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='contract_internal_notes' and policyname='contract notes insert') then
    create policy "contract notes insert" on public.contract_internal_notes for insert with check (public.can_write_org(organization_id) and created_by = auth.uid());
  end if;
  -- Wijzigen/verwijderen: alleen de auteur.
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='contract_internal_notes' and policyname='contract notes update') then
    create policy "contract notes update" on public.contract_internal_notes for update using (public.can_write_org(organization_id) and created_by = auth.uid()) with check (public.can_write_org(organization_id) and created_by = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='contract_internal_notes' and policyname='contract notes delete') then
    create policy "contract notes delete" on public.contract_internal_notes for delete using (public.can_write_org(organization_id) and created_by = auth.uid());
  end if;
end $$;

commit;
