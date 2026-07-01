-- ============================================================
-- ResoFly — Meeting-notulen naar de genodigden mailen (fase 2)
-- Date: 2026-07-01
--
-- Voortbouwend op 20260630000010_meeting_recordings. Twee kleine uitbreidingen,
-- zodat de app-gebruiker na de transcriptie:
--  1) de transcriptie kan bijwerken (kolom transcript_text bestaat al — bewerken
--     loopt via de service-role in meeting-transcribe, dus GEEN policy nodig);
--  2) de samenvatting per e-mail naar alle genodigden kan sturen. Hier houden we
--     bij wanneer en naar wie dat is gebeurd (audit + UI-feedback).
--
-- Beveiliging: net als de rest van deze tabel schrijft alleen de service-role
-- (meeting-transcribe). RLS blijft lezen-voor-org-leden; geen policywijziging.
-- ============================================================

begin;

alter table public.meeting_recordings
  add column if not exists summary_sent_at timestamptz,
  add column if not exists summary_recipients jsonb;  -- [{email, name}] van de laatste verzending

comment on column public.meeting_recordings.summary_sent_at is
  'Wanneer de notulen voor het laatst naar de genodigden zijn gemaild.';
comment on column public.meeting_recordings.summary_recipients is
  'Ontvangers van de laatste notulen-mail: JSON-array van {email, name}.';

commit;
