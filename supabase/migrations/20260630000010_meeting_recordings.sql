-- ============================================================
-- ResoFly — Meeting-opnames + transcript + AI-notulen (fase 1)
-- Date: 2026-06-30
--
-- Scope (fase 1 = fysieke meeting, device-mic):
-- - Eén rij per opname in `meeting_recordings`. De audio zelf staat privé in R2
--   (entity_type 'meeting_recording'); hier bewaren we alleen de R2-key + metadata.
-- - De opname koppelt aan een agenda-item via (provider, source_id, event_ref) —
--   bewust NIET als harde FK naar calendar_events, want Google/Microsoft-items
--   staan niet lokaal in die tabel. Dit spiegelt het bestaande
--   calendar_event_links-patroon en werkt dus voor google/microsoft/native.
-- - Optionele klant/project-koppeling, zodat de notulen later als notitie op de
--   klant of het project kunnen landen.
-- - Pipeline: uploaded -> transcribing -> transcribed -> summarizing -> done
--   (of error). Transcript van ElevenLabs Scribe; notulen van Claude.
--
-- Beveiliging:
-- - RLS: lezen mag elk org-lid (can_read_org). ALLE schrijfacties lopen via de
--   service-role in de edge-functies (meeting-transcribe / -webhook), die de
--   AVG-toestemming en validatie afdwingen — daarom GEEN insert/update/delete
--   policy (alleen de service-role omzeilt RLS).
-- ============================================================

begin;

create table if not exists public.meeting_recordings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),

  -- ── Koppeling aan het agenda-item (provider-agnostisch) ──────────────────
  provider text check (provider in ('google','microsoft','native')),
  source_id uuid references public.calendar_sources(id) on delete set null,
  event_ref text,                       -- provider event-id of native UID
  event_title_snapshot text,

  -- ── Optionele zakelijke koppeling (voor notulen -> notitie) ──────────────
  client_id uuid references public.clients(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,

  -- ── Audio (privé in R2) ──────────────────────────────────────────────────
  storage_key text,                     -- null tot de upload klaar is
  mime_type text,
  size_bytes bigint,
  duration_seconds integer,

  -- ── AVG / toestemming ────────────────────────────────────────────────────
  consent_given boolean not null default false,
  consent_at timestamptz,

  -- ── Pipeline-status ──────────────────────────────────────────────────────
  status text not null default 'uploaded'
    check (status in ('uploaded','transcribing','transcribed','summarizing','done','error')),
  error_message text,

  -- ── Transcriptie (ElevenLabs Scribe) ─────────────────────────────────────
  elevenlabs_request_id text,           -- correlatie met de async webhook
  language text,
  transcript_text text,
  transcript_json jsonb,                -- segmenten met sprekerlabels + tijdstempels
  transcription_cost_usd numeric(10,4) not null default 0,  -- aparte meter ($/uur)

  -- ── Notulen (Claude) ─────────────────────────────────────────────────────
  summary_text text,
  summary_json jsonb,                   -- {samenvatting, besproken[], besluiten[], actiepunten[], vervolgafspraken[]}

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_meeting_recordings_org
  on public.meeting_recordings(organization_id, created_at desc);
create index if not exists idx_meeting_recordings_event
  on public.meeting_recordings(organization_id, provider, event_ref);
create index if not exists idx_meeting_recordings_request
  on public.meeting_recordings(elevenlabs_request_id);
create index if not exists idx_meeting_recordings_client
  on public.meeting_recordings(client_id) where client_id is not null;
create index if not exists idx_meeting_recordings_project
  on public.meeting_recordings(project_id) where project_id is not null;

-- updated_at bijhouden (generieke helper bestaat al elders).
drop trigger if exists meeting_recordings_updated on public.meeting_recordings;
create trigger meeting_recordings_updated
  before update on public.meeting_recordings
  for each row execute function public.set_updated_at();

-- Verplaatsen naar een andere organisatie blokkeren (codebase-conventie).
drop trigger if exists meeting_recordings_prevent_org_change on public.meeting_recordings;
create trigger meeting_recordings_prevent_org_change
  before update of organization_id on public.meeting_recordings
  for each row execute function public.prevent_organization_id_change();

-- ── RLS — alleen LEZEN voor org-leden; schrijven uitsluitend via service-role ─
alter table public.meeting_recordings enable row level security;

drop policy if exists "meeting_recordings read" on public.meeting_recordings;
create policy "meeting_recordings read" on public.meeting_recordings for select using (
  public.can_read_org(organization_id)
);

commit;
