-- ============================================================
-- ResoFly — Transcriptie telt mee in het AI-budget
-- Date: 2026-11-08
--
-- Waarom: het uitschrijven van een opname (ElevenLabs Scribe) kost geld, maar
-- stond alleen op de opname zelf (meeting_recordings.transcription_cost_usd).
-- Het maandbudget telt alleen ai_usage op (ai_usage_month_totals), dus wie
-- geen AI-tegoed meer had kon onbeperkt laten transcriberen, en Instellingen →
-- AI-gebruik liet die kosten niet zien.
--
-- Nu krijgt elke transcriptie een eigen rij in ai_usage (model
-- 'elevenlabs/scribe_v1', zonder tokens), met de opname erbij
-- (_shared/transcriptionUsage.ts).
--
-- - Hoogstens één rij per opname (unieke index): een herhaalde webhook of een
--   dubbele aanroep belast het tegoed niet twee keer.
-- - Verwijdert iemand de opname, dan blijft de rij staan (on delete set null):
--   de kosten zijn gemaakt en blijven meetellen. Met een cascade zou wissen het
--   tegoed weer vrijmaken.
-- - Lezen en schrijven veranderen niet: owners/admins lezen ai_usage, alleen de
--   service-role schrijft (20260623000004).
-- ============================================================

begin;

alter table public.ai_usage
  add column if not exists transcribed_recording_id uuid
    references public.meeting_recordings(id) on delete set null;

comment on column public.ai_usage.transcribed_recording_id is
  'De opname waarvan deze rij de transcriptie (ElevenLabs Scribe) is. Hoogstens één rij per opname.';

create unique index if not exists ai_usage_transcribed_recording_once
  on public.ai_usage (transcribed_recording_id)
  where transcribed_recording_id is not null;

commit;
