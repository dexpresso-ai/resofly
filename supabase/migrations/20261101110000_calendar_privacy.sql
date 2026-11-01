-- ============================================================
-- ResoFly — Privé-afspraken en ICS-adressen van collega's blijven privé
-- Date: 2026-11-01
--
-- Beveiligingsronde SaaS (CHANGELOG_BEVEILIGING_SAAS_2026-11-01.md, punt P).
--
--   1. calendar_event_links (de koppeling van een afspraak aan een klant,
--      project of taak) las elk teamlid met Agenda, ook voor afspraken in de
--      PRIVÉ-agenda van een collega: titel, tijden en de gekoppelde klant. Het
--      auditlog maskeerde die regels al als "Privé-afspraak"; de tabel zelf
--      niet. En elk teamlid kon zulke koppelingen wijzigen of weghalen, en
--      daarmee de uren die eruit volgen. Nu alleen als je de agenda zelf mag
--      zien (je eigen, of een met de organisatie gedeelde), of de koppeling
--      zelf maakte. De subquery op calendar_sources draait met jouw RLS, dus
--      "mag zien" is precies de regel van calendar_sources zelf.
--   2. calendar_sources.feed_url is het geheime ICS-adres van een agenda. Elk
--      teamlid las het zodra de agenda gedeeld was (en een oud-teamlid hield
--      wat hij kopieerde). De app leest calendar_sources nooit rechtstreeks
--      (alleen via de edge functions op de service-role), dus feed_url en
--      feed_etag gaan uit de leesrechten van authenticated.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Koppelingen aan afspraken: alleen bij een agenda die je mag zien ────

drop policy if exists "calendar_event_links read" on public.calendar_event_links;
create policy "calendar_event_links read" on public.calendar_event_links
  for select using (
    public.can_read_org(organization_id)
    and (
      created_by = auth.uid()
      or calendar_source_id is null
      or exists (select 1 from public.calendar_sources s where s.id = calendar_event_links.calendar_source_id)
    )
  );

drop policy if exists "calendar_event_links update" on public.calendar_event_links;
create policy "calendar_event_links update" on public.calendar_event_links
  for update using (
    public.can_write_org(organization_id)
    and (
      created_by = auth.uid()
      or calendar_source_id is null
      or exists (select 1 from public.calendar_sources s where s.id = calendar_event_links.calendar_source_id)
    )
  )
  with check (
    public.can_write_org(organization_id)
    and (
      created_by = auth.uid()
      or calendar_source_id is null
      or exists (select 1 from public.calendar_sources s where s.id = calendar_event_links.calendar_source_id)
    )
  );

drop policy if exists "calendar_event_links delete" on public.calendar_event_links;
create policy "calendar_event_links delete" on public.calendar_event_links
  for delete using (
    public.can_write_org(organization_id)
    and (
      created_by = auth.uid()
      or calendar_source_id is null
      or exists (select 1 from public.calendar_sources s where s.id = calendar_event_links.calendar_source_id)
    )
  );

-- ── 2. Het ICS-adres van een agenda is niet leesbaar voor de app ───────────

revoke select on public.calendar_sources from authenticated;
grant select (
  id, organization_id, user_id, connection_id, provider, provider_calendar_id, name, description, color,
  timezone, is_primary, access_role, sync_enabled, write_enabled, visibility, created_at, updated_at,
  change_seq, feed_content_hash, feed_last_synced_at, feed_last_error
) on public.calendar_sources to authenticated;

commit;
