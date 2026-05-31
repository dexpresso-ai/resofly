-- Calendar privacy hardening: personal calendars are private by default.
-- A user must explicitly share a calendar source before it becomes visible in team planning.

alter table public.calendar_sources
  add column if not exists visibility text not null default 'private' check (visibility in ('private','organization'));

create index if not exists idx_calendar_sources_org_visibility
  on public.calendar_sources(organization_id, visibility, sync_enabled);

-- Replace broad organization-readable policies with privacy-aware policies.
drop policy if exists "calendar connections read" on public.calendar_connections;
drop policy if exists "calendar connections write" on public.calendar_connections;
drop policy if exists "calendar connections read own or shared" on public.calendar_connections;
drop policy if exists "calendar connections insert own" on public.calendar_connections;
drop policy if exists "calendar connections update own" on public.calendar_connections;
drop policy if exists "calendar connections delete own" on public.calendar_connections;

create policy "calendar connections read own or shared" on public.calendar_connections
  for select using (
    user_id = auth.uid()
    or (
      public.can_read_org(organization_id)
      and exists (
        select 1
        from public.calendar_sources source
        where source.connection_id = calendar_connections.id
          and source.visibility = 'organization'
      )
    )
  );

create policy "calendar connections insert own" on public.calendar_connections
  for insert with check (public.can_write_org(organization_id) and user_id = auth.uid());

create policy "calendar connections update own" on public.calendar_connections
  for update using (public.can_write_org(organization_id) and user_id = auth.uid())
  with check (public.can_write_org(organization_id) and user_id = auth.uid());

create policy "calendar connections delete own" on public.calendar_connections
  for delete using (public.can_write_org(organization_id) and user_id = auth.uid());

drop policy if exists "calendar sources read" on public.calendar_sources;
drop policy if exists "calendar sources write" on public.calendar_sources;
drop policy if exists "calendar sources read own or shared" on public.calendar_sources;
drop policy if exists "calendar sources insert own" on public.calendar_sources;
drop policy if exists "calendar sources update own" on public.calendar_sources;
drop policy if exists "calendar sources delete own" on public.calendar_sources;

create policy "calendar sources read own or shared" on public.calendar_sources
  for select using (user_id = auth.uid() or (visibility = 'organization' and public.can_read_org(organization_id)));

create policy "calendar sources insert own" on public.calendar_sources
  for insert with check (public.can_write_org(organization_id) and user_id = auth.uid());

create policy "calendar sources update own" on public.calendar_sources
  for update using (public.can_write_org(organization_id) and user_id = auth.uid())
  with check (public.can_write_org(organization_id) and user_id = auth.uid());

create policy "calendar sources delete own" on public.calendar_sources
  for delete using (public.can_write_org(organization_id) and user_id = auth.uid());
