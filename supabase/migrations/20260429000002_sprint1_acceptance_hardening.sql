-- ============================================================
-- BrandCore Sprint 1 Acceptance Hardening
-- Strengthens role/invitation integrity for production staging.
-- Safe to run after 20260429_sprint1_workspace_foundation.sql.
-- ============================================================

create or replace function public.prevent_member_identity_change()
returns trigger
language plpgsql
as $$
begin
  if old.organization_id is distinct from new.organization_id then
    raise exception 'organization_members.organization_id kan niet worden gewijzigd' using errcode = '23514';
  end if;
  if old.user_id is distinct from new.user_id then
    raise exception 'organization_members.user_id kan niet worden gewijzigd' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.prevent_invitation_identity_change()
returns trigger
language plpgsql
as $$
begin
  if old.organization_id is distinct from new.organization_id then
    raise exception 'organization_invitations.organization_id kan niet worden gewijzigd' using errcode = '23514';
  end if;
  if old.email is distinct from new.email then
    raise exception 'organization_invitations.email kan niet worden gewijzigd' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists organization_members_identity_guard on public.organization_members;
create trigger organization_members_identity_guard
  before update of organization_id, user_id on public.organization_members
  for each row execute function public.prevent_member_identity_change();

drop trigger if exists organization_invitations_identity_guard on public.organization_invitations;
create trigger organization_invitations_identity_guard
  before update of organization_id, email on public.organization_invitations
  for each row execute function public.prevent_invitation_identity_change();

-- Prevent direct REST inserts from spoofing invited_by. The RPC already sets invited_by = auth.uid().
drop policy if exists "invitations insert by admins" on public.organization_invitations;
create policy "invitations insert by admins" on public.organization_invitations
  for insert with check (public.can_admin_org(organization_id) and invited_by = auth.uid());
