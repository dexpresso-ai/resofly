-- ============================================================
-- BrandCore — Organization user licensing recheck
-- Date: 2026-04-30
--
-- Purpose:
-- - Make seat reservations deterministic when invitations are accepted,
--   revoked or already expired.
-- - Keep the database as the source of truth; the frontend only mirrors it.
-- ============================================================

create or replace function public.enforce_invitation_license_capacity()
returns trigger
language plpgsql
as $$
declare
  v_licensed integer;
  v_reserved integer;
begin
  -- Alleen geldige pending uitnodigingen reserveren een seat. Zodra een
  -- uitnodiging wordt geaccepteerd, ingetrokken of verlopen is, komt de
  -- gereserveerde seat direct vrij.
  if new.status <> 'pending' or (new.expires_at is not null and new.expires_at <= now()) then
    new.consumes_license := false;
    return new;
  end if;

  new.consumes_license := true;

  select licensed_seats into v_licensed
  from public.organizations
  where id = new.organization_id
  for update;

  if v_licensed is null then
    raise exception 'Organisatie niet gevonden.' using errcode = 'P0002';
  end if;

  v_reserved := public.organization_reserved_license_count(new.organization_id, null, case when TG_OP = 'UPDATE' then new.id else null end);
  if v_reserved + 1 > v_licensed then
    raise exception 'Geen vrije gebruikerslicentie beschikbaar. Koop eerst een extra gebruikerslicentie voordat je iemand uitnodigt.' using errcode = '23514';
  end if;

  return new;
end;
$$;

create or replace function public.accept_organization_invitation(p_invitation_id uuid)
returns public.organization_members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_email citext := public.current_user_email();
  v_invitation public.organization_invitations;
  v_member public.organization_members;
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

  insert into public.organization_members(organization_id, user_id, email, role, status, invited_by, joined_at)
  values (v_invitation.organization_id, v_user_id, v_email, v_invitation.role, 'active', v_invitation.invited_by, now())
  on conflict (organization_id, user_id)
  do update set role = excluded.role, status = 'active', email = excluded.email, updated_at = now()
  returning * into v_member;

  return v_member;
end;
$$;

update public.organization_invitations
set consumes_license = false,
    status = case when status = 'pending' and expires_at is not null and expires_at <= now() then 'expired' else status end,
    updated_at = now()
where consumes_license = true
  and (
    status <> 'pending'
    or (expires_at is not null and expires_at <= now())
  );
