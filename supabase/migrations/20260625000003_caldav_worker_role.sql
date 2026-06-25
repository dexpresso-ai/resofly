-- ============================================================
-- ResoFly — CalDAV-Worker: rol meegeven aan de auth-lookup (fase 3)
-- Date: 2026-06-25
--
-- Voor schrijven (PUT/DELETE) vanaf de telefoon moet de Worker weten of de
-- gebruiker schrijfrechten heeft binnen de organisatie. Daarom geeft de
-- auth-lookup nu ook de organisatierol terug (owner/admin/member = schrijven,
-- viewer = alleen lezen). Return-type wijzigt → eerst droppen.
-- ============================================================

begin;

drop function if exists public.caldav_lookup_app_passwords(text);

create function public.caldav_lookup_app_passwords(p_email text)
returns table (id uuid, user_id uuid, organization_id uuid, salt text, password_hash text, role text)
language sql
security definer
set search_path = public, auth
as $$
  select ap.id, ap.user_id, ap.organization_id, ap.salt, ap.password_hash, m.role
  from public.calendar_app_passwords ap
  join auth.users u on u.id = ap.user_id
  left join public.organization_members m
    on m.organization_id = ap.organization_id
    and m.user_id = ap.user_id
    and m.status = 'active'
  where ap.revoked_at is null
    and lower(u.email) = lower(trim(coalesce(p_email, '')))
    and coalesce(trim(p_email), '') <> '';
$$;

revoke all on function public.caldav_lookup_app_passwords(text) from public, anon, authenticated;
grant execute on function public.caldav_lookup_app_passwords(text) to service_role;

commit;
