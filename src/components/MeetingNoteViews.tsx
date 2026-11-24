import { useEffect, useState, type ReactNode } from 'react';
import { FileText, Users } from 'lucide-react';
import { getRecordingInContentNote } from '../lib/meeting-api';
import type { MeetingRecording, UUID } from '../types';

/**
 * Een meeting uit de agenda in Inhoud (sinds 24 november). De notitie in de
 * map Meetings bevat de notulen; het volledige transcript blijft op de opname
 * staan (meeting_recordings.content_note_id). Hier wissel je tussen de twee.
 *
 * Het transcript staat niet als tekst in de notitie: dan stond het twee keer
 * opgeslagen, en wie de opname in de agenda wist (AVG), hield het toch in
 * Inhoud. Nu gaat het met de opname mee; de notulen blijven als notitie staan.
 *
 * Zonder gekoppelde opname (een gewone notitie, of een notitie van het soort
 * "Meeting" die je zelf maakte) toont dit alleen de editor, zoals altijd.
 */
export function MeetingNoteViews({ organizationId, noteId, isMeeting, children }: {
  organizationId: UUID;
  /** De opgeslagen notitie; een nieuwe heeft nog geen opname. */
  noteId: UUID | null;
  /** Alleen een notitie van het soort Meeting kan een opname hebben; de rest vraagt niets op. */
  isMeeting: boolean;
  /** De editor met de notulen. */
  children: ReactNode;
}) {
  const [rec, setRec] = useState<MeetingRecording | null>(null);
  const [view, setView] = useState<'notulen' | 'transcript'>('notulen');

  useEffect(() => {
    setRec(null);
    setView('notulen');
    if (!noteId || !isMeeting) return;
    let cancelled = false;
    // Lukt het niet, dan gewoon de notitie: het transcript is een extra.
    getRecordingInContentNote(organizationId, noteId)
      .then((found) => { if (!cancelled) setRec(found); })
      .catch(() => { if (!cancelled) setRec(null); });
    return () => { cancelled = true; };
  }, [organizationId, noteId, isMeeting]);

  const transcript = rec?.transcript_text?.trim() ?? '';
  if (!transcript) return <>{children}</>;

  return (
    <div className="meeting-note-views">
      <div className="bk-seg bk-seg-sm meeting-note-switch" role="tablist" aria-label="Wat je van de meeting ziet">
        <button type="button" role="tab" id="meeting-note-tab-notulen" aria-controls="meeting-note-notulen"
          aria-selected={view === 'notulen'} className={view === 'notulen' ? 'is-active' : ''} onClick={() => setView('notulen')}>
          <FileText size={14} /><span>Notulen</span>
        </button>
        <button type="button" role="tab" id="meeting-note-tab-transcript" aria-controls="meeting-note-transcript"
          aria-selected={view === 'transcript'} className={view === 'transcript' ? 'is-active' : ''} onClick={() => setView('transcript')}>
          <Users size={14} /><span>Volledig transcript</span>
        </button>
      </div>
      {/* Verborgen in plaats van weg: zo blijft wat je in de notulen typte
          (en de geschiedenis van de editor) staan als je even wisselt. */}
      <div id="meeting-note-notulen" role="tabpanel" aria-labelledby="meeting-note-tab-notulen" hidden={view !== 'notulen'}>
        {children}
      </div>
      {view === 'transcript' && (
        <div id="meeting-note-transcript" role="tabpanel" aria-labelledby="meeting-note-tab-transcript" className="meeting-note-transcript">
          <p className="meeting-note-meta">
            Opname van {new Date(rec!.created_at).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' })}
            {rec!.duration_seconds ? ` · ${durationLabel(rec!.duration_seconds)}` : ''}
            {' · '}bijwerken doe je bij de afspraak in de agenda.
          </p>
          <TranscriptLines text={transcript} />
        </div>
      )}
    </div>
  );
}

/**
 * Het transcript per beurt. De regels zijn "Spreker 1: tekst" (zo schrijft
 * de server ze, _shared/scribeTranscript.ts); de spreker wordt vet. Het is
 * tekst uit de opname: React zet hem als tekst neer, nooit als opmaak.
 */
function TranscriptLines({ text }: { text: string }) {
  return (
    <div className="meeting-note-lines">
      {text.split('\n').filter((line) => line.trim()).map((line, i) => {
        const match = line.match(/^([^:\n]{1,40}):\s+(.*)$/);
        return match
          ? <p key={i}><strong>{match[1]}:</strong> {match[2]}</p>
          : <p key={i}>{line}</p>;
      })}
    </div>
  );
}

function durationLabel(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return 'minder dan een minuut';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} uur ${minutes % 60} min`;
}
