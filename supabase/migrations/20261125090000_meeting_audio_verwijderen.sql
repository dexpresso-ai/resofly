-- ============================================================
-- ResoFly — De audio van een meeting wissen, transcript en notulen houden
-- Date: 2026-11-25
--
-- Waarom: een uur vergaderen is al gauw 30 tot 60 MB audio in R2. Na het
-- uitschrijven heb je die zelden nog nodig: het transcript en de notulen
-- staan in de database. Tot nu toe kon je alleen de hele opname wissen, en
-- dan was het transcript ook weg. Nu wist Inhoud → Meetings alleen de audio.
--
-- Wat er verandert:
-- 1. meeting_recordings.audio_deleted_at en audio_deleted_by: wanneer en door
--    wie de audio is gewist. Zo ziet de tabel "Audio verwijderd" in plaats
--    van een opname die er nooit was. Na het wissen zijn storage_key en
--    size_bytes leeg; de check houdt dat bij elkaar. size_bytes moet mee:
--    de opslagmeter (organization_storage_status, 20261013100000) telt hem,
--    en anders bleef de gewiste audio meetellen bij je opslag.
-- 2. Een vangnet voor R2. De edge function (meeting-transcribe, actie
--    deleteAudio) haalt de audio meteen weg. Lukt dat niet (worker even
--    onbereikbaar), dan bleef het bestand eerst voor altijd staan: niets
--    wees er nog naar, dus niets ruimde het op. Daarom zet een trigger de
--    oude sleutel in storage_purge_queue zodra storage_key leeg wordt of de
--    opname verdwijnt. De nachtelijke opruimtaak (file-transfer ?cron=purge)
--    haalt hem dan alsnog weg. Dat geldt ook voor het wissen van een hele
--    opname: de app wiste de audio daar zelf, en een mislukking werd stil
--    overgeslagen.
-- 3. De wachtrij wist alleen wat bij zijn reden past
--    (storage_purge_queue_guard, 20261110140000). De nieuwe reden
--    'meeting_recording' mag alleen sleutels onder <organisatie>/meeting_recording/.
--
-- Schrijven gaat zoals altijd alleen via de service-role in de edge function;
-- RLS staat leden alleen lezen toe.
--
-- Veilig om opnieuw te draaien.
-- ============================================================

begin;

-- ── 1. Wanneer en door wie ─────────────────────────────────────────────────

alter table public.meeting_recordings
  add column if not exists audio_deleted_at timestamptz,
  add column if not exists audio_deleted_by uuid references auth.users(id) on delete set null;

comment on column public.meeting_recordings.audio_deleted_at is
  'Wanneer de audio is gewist (Inhoud → Meetings). Transcript en notulen blijven staan.';
comment on column public.meeting_recordings.audio_deleted_by is
  'Wie de audio wiste.';

-- Gewiste audio heeft geen sleutel en geen grootte meer. Anders kon de tabel
-- "verwijderd" zeggen terwijl het bestand nog af te spelen was, of telde het
-- nog mee in de opslag.
alter table public.meeting_recordings drop constraint if exists meeting_recordings_audio_gewist_zonder_sleutel;
alter table public.meeting_recordings add constraint meeting_recordings_audio_gewist_zonder_sleutel check (
  audio_deleted_at is null or (storage_key is null and size_bytes is null)
);

-- ── 2. De wachtrij mag opnames opruimen ────────────────────────────────────
-- Gelijk aan 20261110140000, met één reden erbij.

create or replace function public.storage_purge_queue_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  -- '<organisatie>/<soort>/…': het tweede stuk zegt wat het voor bestand is.
  v_segment text := split_part(coalesce(new.storage_key, ''), '/', 2);
  v_allowed text[];
begin
  v_allowed := case new.reason
    when 'document' then array['document', 'folder']
    when 'contract' then array['contract']
    when 'folder' then array['folder']
    when 'file_transfer' then array['transfer']
    when 'file_transfer_pending' then array['transfer']
    when 'meeting_recording' then array['meeting_recording']
    else null
  end;
  -- Bewijsstukken en inbox-originelen nooit, ook niet bij een onbekende reden.
  if v_segment in ('invoice-pdfs', 'quote-pdfs', 'contract-pdfs', 'annual-account-pdfs', 'purchase_invoice_inbox')
     or (v_allowed is not null and not (v_segment = any (v_allowed))) then
    -- Niet in de wachtrij, en geen fout: het verwijderen van het document of
    -- contract zelf moet gewoon doorgaan. Het bestand blijft staan.
    raise warning 'Opslagsleutel van soort "%" hoort niet bij opruimreden "%": niet in de wachtrij gezet.', v_segment, new.reason;
    return null;
  end if;
  return new;
end;
$$;

revoke all on function public.storage_purge_queue_guard() from public, anon, authenticated;

-- ── 3. Audio die nergens meer bij hoort, gaat de wachtrij in ───────────────

create or replace function public.queue_meeting_audio_purge()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_oud text := old.storage_key;
begin
  if tg_op = 'UPDATE' and new.storage_key is not distinct from v_oud then
    return new;
  end if;
  if v_oud is null
     or position('..' in v_oud) > 0
     or v_oud not like old.organization_id::text || '/meeting_recording/%' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  -- Wijst een andere opname nog naar dit bestand, dan blijft het staan.
  if exists (select 1 from public.meeting_recordings m
              where m.storage_key = v_oud and m.id <> old.id) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  -- Al in de wachtrij (een tweede poging na een mislukte): niet dubbel.
  if not exists (select 1 from public.storage_purge_queue q
                  where q.storage_key = v_oud and q.reason = 'meeting_recording') then
    insert into public.storage_purge_queue (organization_id, storage_key, reason, purge_after)
    values (old.organization_id, v_oud, 'meeting_recording', now());
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function public.queue_meeting_audio_purge() from public, anon, authenticated;

drop trigger if exists meeting_recordings_purge_audio on public.meeting_recordings;
create trigger meeting_recordings_purge_audio
  after delete or update of storage_key on public.meeting_recordings
  for each row execute function public.queue_meeting_audio_purge();

commit;
