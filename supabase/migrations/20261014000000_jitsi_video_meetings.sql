-- ============================================================
-- ResoFly — Jitsi Meet in de agenda
-- Date: 2026-10-14
--
-- Een videovergadering zonder Google of Microsoft ertussen: een Jitsi-kamer is
-- gewoon een link, dus die werkt op elke agenda (ook de eigen ResoFly-agenda)
-- en vraagt geen koppeling of account.
--
-- 1. company_settings.jitsi_base_url — de Jitsi-server van de organisatie.
--    Leeg = de openbare server meet.jit.si. Wie zelf een Jitsi-server draait,
--    vult hier het adres in; alle nieuwe links in de agenda, de boekingslinks
--    en de teamchat gaan dan daarheen. Alleen https, zonder query, # of
--    inloggegevens, hooguit één padstuk (een tenant of submap). De server moet
--    gasten met alleen de link binnenlaten (JaaS van 8x8, met een JWT per
--    deelnemer, dus niet). De app normaliseert vóór het opslaan
--    (src/lib/meeting.ts); deze check is het vangnet. Lezen mag elk teamlid,
--    wijzigen alleen owner/admin (de bestaande policies op company_settings).
--
-- 2. meeting_booking_links.conference_provider — welke videovergadering een
--    boeking krijgt als auto_conference aan staat:
--      'calendar' — Google Meet / Teams van de gekoppelde agenda (zoals tot nu);
--      'jitsi'    — per boeking een eigen Jitsi-kamer, op elke agenda.
--    Bestaande links houden 'calendar' en gedragen zich dus precies als eerst.
--    Een vaste meeting_url blijft voorrang houden.
-- ============================================================

begin;

alter table public.company_settings
  add column if not exists jitsi_base_url text;

alter table public.company_settings
  drop constraint if exists company_settings_jitsi_base_url_check;
alter table public.company_settings
  add constraint company_settings_jitsi_base_url_check
  check (jitsi_base_url is null or (
    char_length(jitsi_base_url) <= 200
    and jitsi_base_url ~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?(/[^/?#[:space:]]+)?$'
  ));

comment on column public.company_settings.jitsi_base_url is
  'Eigen Jitsi-server voor videovergaderingen (https://…). Leeg = meet.jit.si.';

alter table public.meeting_booking_links
  add column if not exists conference_provider text not null default 'calendar';

alter table public.meeting_booking_links
  drop constraint if exists meeting_booking_links_conference_provider_check;
alter table public.meeting_booking_links
  add constraint meeting_booking_links_conference_provider_check
  check (conference_provider in ('calendar', 'jitsi'));

comment on column public.meeting_booking_links.conference_provider is
  'Bij auto_conference: calendar = Google Meet/Teams van de agenda, jitsi = eigen Jitsi-kamer per boeking.';

commit;
