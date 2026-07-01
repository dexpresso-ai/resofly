import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, FileText, Loader2, Mail, Mic, Pause, Pencil, Play, Send, Square, Trash2, Users, X } from 'lucide-react';
import { Button, Input, Textarea } from './Ui';
import { getAccessToken, getWorkerBase } from '../lib/r2-api';
import {
  createRecording, deleteRecording as apiDeleteRecording, getRecording,
  isTerminalStatus, listRecordingsForEvent, sendSummaryToAttendees, startTranscription,
  summarizeRecording, updateRecordingText, uploadMeetingAudio,
} from '../lib/meeting-api';
import type { CalendarProvider, MeetingRecording, UUID } from '../types';

export interface MeetingRecorderEvent {
  provider: CalendarProvider | 'native' | null;
  sourceId: UUID | null;
  eventRef: string | null;
  eventTitle: string | null;
  clientId: UUID | null;
  projectId: UUID | null;
  /** Genodigden bij deze afspraak (voor "verstuur notulen naar genodigden"). */
  attendees: { email: string; name: string }[];
}

interface Props {
  organizationId: UUID;
  canWrite: boolean;
  event: MeetingRecorderEvent;
  /** Wordt getoond als "Opslaan als notitie" wanneer aanwezig (alleen bij gedeelde items). */
  onSaveAsNote?: (text: string) => Promise<void>;
}

type Phase = 'idle' | 'consent' | 'recording' | 'paused' | 'processing';

/** Kiest een breed-ondersteund audioformaat (incl. iOS/Safari die alleen mp4 doet). */
function pickMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  if (typeof MediaRecorder === 'undefined') return '';
  return candidates.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? '';
}

function fmtClock(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export function MeetingRecorder({ organizationId, canWrite, event, onSaveAsNote }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [recordings, setRecordings] = useState<MeetingRecording[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<UUID | null>(null);

  const mediaRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const mimeRef = useRef<string>('');
  const timerRef = useRef<number | null>(null);

  const recordingSupported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';

  const reload = useCallback(async () => {
    if (!event.eventRef) { setRecordings([]); return; }
    try {
      setRecordings(await listRecordingsForEvent(organizationId, event.provider ?? null, event.eventRef));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Opnames laden mislukt.');
    }
  }, [organizationId, event.provider, event.eventRef]);

  useEffect(() => { void reload(); }, [reload]);

  // Timer tijdens opname.
  useEffect(() => {
    if (phase === 'recording') {
      timerRef.current = window.setInterval(() => setElapsed((s) => s + 1), 1000);
      return () => { if (timerRef.current) window.clearInterval(timerRef.current); };
    }
  }, [phase]);

  // Opruimen bij unmount.
  useEffect(() => () => { stopTracks(); if (timerRef.current) window.clearInterval(timerRef.current); }, []);

  function stopTracks() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  async function beginRecording() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      const mime = pickMimeType();
      mimeRef.current = mime || 'audio/webm';
      const recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 32000 });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => { void finishRecording(); };
      mediaRef.current = recorder;
      recorder.start(1000); // chunk elke seconde, robuust bij lange opnames
      setElapsed(0);
      setPhase('recording');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Geen toegang tot de microfoon.');
      setPhase('idle');
      stopTracks();
    }
  }

  function togglePause() {
    const r = mediaRef.current;
    if (!r) return;
    if (r.state === 'recording') { r.pause(); setPhase('paused'); if (timerRef.current) window.clearInterval(timerRef.current); }
    else if (r.state === 'paused') { r.resume(); setPhase('recording'); }
  }

  function stopRecording() {
    const r = mediaRef.current;
    if (r && r.state !== 'inactive') r.stop();
    if (timerRef.current) window.clearInterval(timerRef.current);
  }

  async function finishRecording() {
    setPhase('processing');
    stopTracks();
    const duration = elapsed;
    try {
      const mime = mimeRef.current || 'audio/webm';
      const blob = new Blob(chunksRef.current, { type: mime });
      chunksRef.current = [];
      if (blob.size === 0) throw new Error('Lege opname — er is geen audio vastgelegd.');
      const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
      const file = new File([blob], `meeting-${Date.now()}.${ext}`, { type: mime });

      const recordingId = await createRecording(organizationId, {
        provider: event.provider, sourceId: event.sourceId, eventRef: event.eventRef,
        eventTitle: event.eventTitle, clientId: event.clientId, projectId: event.projectId,
      });
      const storageKey = await uploadMeetingAudio(file, organizationId, recordingId);
      await startTranscription(organizationId, {
        recordingId, storageKey, mimeType: mime, sizeBytes: file.size, durationSeconds: duration,
      });
      setPhase('idle');
      await pollUntilReady(recordingId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verwerken van de opname mislukt.');
      setPhase('idle');
      await reload();
    }
  }

  /** Pollt tot de opname klaar/mislukt is (transcriptie + notulen lopen async). */
  async function pollUntilReady(recordingId: UUID) {
    for (let i = 0; i < 200; i++) { // ~10 min (3s interval); langere audio rondt server-side hoe dan ook af
      await new Promise((r) => setTimeout(r, 3000));
      let rec: MeetingRecording | null = null;
      try { rec = await getRecording(recordingId); } catch { /* blijf proberen */ }
      if (rec) {
        const fresh = rec;
        setRecordings((prev) => [fresh, ...prev.filter((p) => p.id !== fresh.id)].sort((a, b) => b.created_at.localeCompare(a.created_at)));
        if (isTerminalStatus(rec)) return;
      }
    }
  }

  async function onDelete(rec: MeetingRecording) {
    if (!window.confirm('Deze opname, het transcript en de notulen definitief verwijderen?')) return;
    setBusyId(rec.id);
    try { await apiDeleteRecording(organizationId, rec); setRecordings((prev) => prev.filter((p) => p.id !== rec.id)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Verwijderen mislukt.'); }
    finally { setBusyId(null); }
  }

  async function onRetrySummary(rec: MeetingRecording) {
    setBusyId(rec.id);
    try { await summarizeRecording(organizationId, rec.id); await pollUntilReady(rec.id); }
    catch (e) { setError(e instanceof Error ? e.message : 'Samenvatten mislukt.'); }
    finally { setBusyId(null); }
  }

  const recording = phase === 'recording' || phase === 'paused';

  return (
    <section className="mr-section">
      <div className="mr-head"><Mic size={15} /><h4>Opname &amp; notulen</h4></div>

      {!event.eventRef && <p className="event-detail-empty">Opnemen kan zodra de afspraak is opgeslagen.</p>}
      {event.eventRef && !recordingSupported && <p className="event-detail-empty">Opnemen wordt niet ondersteund in deze browser.</p>}

      {event.eventRef && recordingSupported && canWrite && (
        <div className="mr-controls">
          {phase === 'idle' && (
            <Button variant="primary" onClick={() => setPhase('consent')}><Mic size={15} /> Opname starten</Button>
          )}

          {phase === 'consent' && (
            <div className="mr-consent">
              <p><AlertTriangle size={15} /><span>Deze meeting wordt opgenomen om er een samenvatting van te maken. Zorg dat de aanwezigen hiermee akkoord zijn.</span></p>
              <div className="mr-consent-actions">
                <Button variant="primary" onClick={() => void beginRecording()}><Check size={15} /> Akkoord, start opname</Button>
                <Button onClick={() => setPhase('idle')}>Annuleren</Button>
              </div>
            </div>
          )}

          {recording && (
            <div className="mr-live">
              <span className="mr-live-label">
                <span className={`mr-dot${phase === 'recording' ? ' is-live' : ''}`} />
                {phase === 'paused' ? 'Gepauzeerd' : 'Opname'} · {fmtClock(elapsed)}
              </span>
              <Button onClick={togglePause}>{phase === 'paused' ? <><Play size={15} /> Hervat</> : <><Pause size={15} /> Pauze</>}</Button>
              <Button variant="primary" onClick={stopRecording}><Square size={14} /> Stop &amp; verwerk</Button>
            </div>
          )}

          {phase === 'processing' && <span className="mr-progress"><Loader2 size={15} className="spin" /> Opname uploaden…</span>}
        </div>
      )}

      {error && <p className="mr-error">{error}</p>}

      <div className="mr-list-wrap">
        {recordings.map((rec) => (
          <RecordingCard key={rec.id} rec={rec} busy={busyId === rec.id} canWrite={canWrite}
            organizationId={organizationId} attendees={event.attendees}
            onPatch={(patch) => setRecordings((prev) => prev.map((p) => (p.id === rec.id ? { ...p, ...patch } : p)))}
            onDelete={() => void onDelete(rec)} onRetrySummary={() => void onRetrySummary(rec)} onSaveAsNote={onSaveAsNote} />
        ))}
      </div>
    </section>
  );
}

function statusLabel(status: MeetingRecording['status']): { text: string; spinning: boolean; error?: boolean } {
  switch (status) {
    case 'uploaded': return { text: 'Geüpload', spinning: false };
    case 'transcribing': return { text: 'Transcriberen…', spinning: true };
    case 'transcribed': return { text: 'Transcript klaar', spinning: false };
    case 'summarizing': return { text: 'Notulen maken…', spinning: true };
    case 'done': return { text: 'Klaar', spinning: false };
    case 'error': return { text: 'Mislukt', spinning: false, error: true };
  }
}

function RecordingCard({ rec, busy, canWrite, organizationId, attendees, onPatch, onDelete, onRetrySummary, onSaveAsNote }: {
  rec: MeetingRecording; busy: boolean; canWrite: boolean;
  organizationId: UUID; attendees: { email: string; name: string }[];
  onPatch: (patch: Partial<MeetingRecording>) => void;
  onDelete: () => void; onRetrySummary: () => void; onSaveAsNote?: (text: string) => Promise<void>;
}) {
  const [showTranscript, setShowTranscript] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState(false);
  // Transcriptie bewerken.
  const [editingTranscript, setEditingTranscript] = useState(false);
  const [transcriptDraft, setTranscriptDraft] = useState('');
  const [savingTranscript, setSavingTranscript] = useState(false);
  // Notulen naar genodigden mailen.
  const [composing, setComposing] = useState(false);
  const label = statusLabel(rec.status);
  const summary = rec.summary_json;

  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);

  async function loadAudio() {
    if (audioUrl || !rec.storage_key) return;
    try {
      const base = getWorkerBase();
      const token = await getAccessToken();
      const res = await fetch(`${base}/file/${encodeURIComponent(rec.storage_key)}`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error();
      setAudioUrl(URL.createObjectURL(await res.blob()));
    } catch { /* stil falen — knop blijft staan */ }
  }

  function summaryAsText(): string {
    if (!summary) return rec.summary_text ?? '';
    const lines: string[] = [];
    if (summary.samenvatting) lines.push(summary.samenvatting, '');
    const block = (title: string, items: string[]) => { if (items?.length) { lines.push(`${title}:`); items.forEach((i) => lines.push(`- ${i}`)); lines.push(''); } };
    block('Besproken', summary.besproken);
    block('Besluiten', summary.besluiten);
    block('Actiepunten', summary.actiepunten);
    block('Vervolgafspraken', summary.vervolgafspraken);
    return lines.join('\n').trim();
  }

  async function saveTranscript() {
    setSavingTranscript(true);
    try {
      await updateRecordingText(organizationId, rec.id, { transcriptText: transcriptDraft });
      onPatch({ transcript_text: transcriptDraft });
      setEditingTranscript(false);
    } catch { /* laat de bewerkmodus open zodat de gebruiker het opnieuw kan proberen */ }
    finally { setSavingTranscript(false); }
  }

  const created = new Date(rec.created_at).toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' });
  const sentAt = rec.summary_sent_at
    ? new Date(rec.summary_sent_at).toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' })
    : null;

  return (
    <div className="mr-card">
      <div className="mr-card-head">
        <span className={`mr-status${label.error ? ' err' : label.spinning ? '' : ' ok'}`}>
          {label.spinning ? <Loader2 size={14} className="spin" /> : label.error ? <AlertTriangle size={14} /> : <Check size={14} />}
          {label.text}
        </span>
        <span className="mr-meta">· {created}{rec.duration_seconds ? ` · ${fmtClock(rec.duration_seconds)}` : ''}</span>
        <span className="mr-spacer" />
        {canWrite && (
          <button type="button" className="mr-del" onClick={onDelete} disabled={busy} title="Opname verwijderen"><Trash2 size={15} /></button>
        )}
      </div>

      {rec.error_message && <p className="mr-card-note">{rec.error_message}</p>}

      {summary && (
        <div className="mr-summary">
          {summary.samenvatting && <p className="mr-summary-text">{summary.samenvatting}</p>}
          <SummaryList title="Besproken" items={summary.besproken} />
          <SummaryList title="Besluiten" items={summary.besluiten} />
          <SummaryList title="Actiepunten" items={summary.actiepunten} icon={<Check size={12} />} />
          <SummaryList title="Vervolgafspraken" items={summary.vervolgafspraken} />

          <div className="mr-actions">
            <Button onClick={() => void navigator.clipboard?.writeText(summaryAsText())}>Kopieer notulen</Button>
            {onSaveAsNote && (
              <Button disabled={savedNote} onClick={async () => { await onSaveAsNote(summaryAsText()); setSavedNote(true); }}>
                <FileText size={14} /> {savedNote ? 'Opgeslagen als notitie' : 'Opslaan als notitie'}
              </Button>
            )}
            {canWrite && (
              <Button variant="primary" onClick={() => setComposing((v) => !v)}>
                <Mail size={14} /> Verstuur naar genodigden
              </Button>
            )}
          </div>

          {sentAt && !composing && (
            <p className="mr-sent-note">
              <Check size={13} /> Notulen gemaild naar {rec.summary_recipients?.length ?? 0} genodigde{(rec.summary_recipients?.length ?? 0) === 1 ? '' : 'n'} · {sentAt}
            </p>
          )}

          {composing && (
            <SummaryComposer
              organizationId={organizationId}
              recordingId={rec.id}
              defaultSubject={`Samenvatting — ${rec.event_title_snapshot || 'afspraak'}`}
              defaultBody={summaryAsText()}
              attendees={attendees}
              hasTranscript={!!rec.transcript_text}
              onSent={(recipients) => { onPatch({ summary_sent_at: new Date().toISOString(), summary_recipients: recipients }); setComposing(false); }}
              onCancel={() => setComposing(false)}
            />
          )}
        </div>
      )}

      {rec.status === 'transcribed' && !summary && canWrite && (
        <Button className="mr-retry" disabled={busy} onClick={onRetrySummary}>Notulen (opnieuw) maken</Button>
      )}

      {rec.transcript_text && (
        <div className="mr-transcript-wrap">
          <button type="button" className="mr-transcript-toggle" onClick={() => setShowTranscript((v) => !v)}>
            <Users size={13} /> {showTranscript ? 'Verberg transcript' : 'Toon transcript'}
          </button>
          {showTranscript && !editingTranscript && (
            <>
              <pre className="mr-transcript">{rec.transcript_text}</pre>
              {canWrite && (
                <div className="mr-actions">
                  <Button className="mr-transcript-edit" onClick={() => { setTranscriptDraft(rec.transcript_text ?? ''); setEditingTranscript(true); }}>
                    <Pencil size={13} /> Transcript bijwerken
                  </Button>
                  {summary && (
                    <Button disabled={busy} onClick={onRetrySummary} title="Genereer de notulen opnieuw op basis van het (bijgewerkte) transcript">
                      {busy ? <><Loader2 size={13} className="spin" /> Bezig…</> : 'Notulen opnieuw maken'}
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
          {showTranscript && editingTranscript && (
            <div className="mr-transcript-editor">
              <Textarea rows={10} value={transcriptDraft} onChange={(e) => setTranscriptDraft(e.target.value)} />
              <div className="mr-actions">
                <Button variant="primary" disabled={savingTranscript} onClick={() => void saveTranscript()}>
                  {savingTranscript ? <><Loader2 size={13} className="spin" /> Opslaan…</> : <><Check size={13} /> Opslaan</>}
                </Button>
                <Button variant="ghost" disabled={savingTranscript} onClick={() => setEditingTranscript(false)}>Annuleren</Button>
                {rec.status === 'transcribed' || rec.summary_json ? (
                  <span className="mr-editor-hint">Tip: laat hierna de notulen opnieuw maken.</span>
                ) : null}
              </div>
            </div>
          )}
        </div>
      )}

      {rec.storage_key && (
        <div className="mr-audio">
          {audioUrl
            ? <audio controls src={audioUrl} />
            : <Button onClick={() => void loadAudio()}><Play size={14} /> Beluister opname</Button>}
        </div>
      )}
    </div>
  );
}

function SummaryList({ title, items, icon }: { title: string; items: string[]; icon?: ReactNode }) {
  if (!items?.length) return null;
  return (
    <div className="mr-list">
      <div className="mr-list-title">{title}</div>
      <ul className={icon ? 'mr-list-checks' : undefined}>
        {items.map((it, i) => <li key={i}>{icon && <span className="mr-li-icon">{icon}</span>}{it}</li>)}
      </ul>
    </div>
  );
}

/**
 * Composer om de (bewerkbare) notulen naar de genodigden te mailen. Onderwerp,
 * tekst én ontvangers zijn aanpasbaar, zodat de gebruiker de inhoud nog kan
 * bijwerken voordat er verstuurd wordt.
 */
function SummaryComposer({ organizationId, recordingId, defaultSubject, defaultBody, attendees, hasTranscript, onSent, onCancel }: {
  organizationId: UUID; recordingId: UUID;
  defaultSubject: string; defaultBody: string;
  attendees: { email: string; name: string }[];
  hasTranscript: boolean;
  onSent: (recipients: { email: string; name: string | null }[]) => void;
  onCancel: () => void;
}) {
  const [subject, setSubject] = useState(defaultSubject);
  const [bodyText, setBodyText] = useState(defaultBody);
  const [includeTranscript, setIncludeTranscript] = useState(false);
  // Voorgevulde ontvangers uit de genodigden (ontdubbeld), allemaal aangevinkt.
  const [rows, setRows] = useState<{ email: string; name: string; on: boolean }[]>(() => {
    const seen = new Set<string>();
    return attendees
      .map((a) => ({ email: a.email.trim().toLowerCase(), name: a.name?.trim() || '', on: true }))
      .filter((a) => a.email && !seen.has(a.email) && (seen.add(a.email), true));
  });
  const [extra, setExtra] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(email: string) { setRows((prev) => prev.map((r) => (r.email === email ? { ...r, on: !r.on } : r))); }
  function addExtra() {
    const email = extra.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
    if (!rows.some((r) => r.email === email)) setRows((prev) => [...prev, { email, name: '', on: true }]);
    setExtra('');
  }

  async function send() {
    const recipients = rows.filter((r) => r.on).map((r) => ({ email: r.email, name: r.name || null }));
    if (recipients.length === 0) { setError('Kies minstens één ontvanger.'); return; }
    if (!bodyText.trim()) { setError('De tekst is leeg.'); return; }
    setSending(true); setError(null);
    try {
      const res = await sendSummaryToAttendees(organizationId, { recordingId, recipients, subject, bodyText, includeTranscript });
      if (res.failed?.length) setError(`${res.sent} verstuurd, ${res.failed.length} mislukt (${res.failed[0].email}).`);
      onSent(recipients);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Versturen mislukt.');
    } finally { setSending(false); }
  }

  return (
    <div className="mr-composer">
      <div className="mr-composer-head"><Mail size={14} /><strong>Notulen mailen naar genodigden</strong></div>

      <label className="mr-composer-label">Ontvangers</label>
      {rows.length === 0 && <p className="mr-editor-hint">Geen genodigden gevonden — voeg hieronder handmatig een e-mailadres toe.</p>}
      <div className="mr-recipients">
        {rows.map((r) => (
          <label key={r.email} className="mr-recipient">
            <input type="checkbox" checked={r.on} onChange={() => toggle(r.email)} />
            <span>{r.name ? `${r.name} · ${r.email}` : r.email}</span>
          </label>
        ))}
      </div>
      <div className="mr-recipient-add">
        <Input type="email" placeholder="Extra e-mailadres toevoegen…" value={extra}
          onChange={(e) => setExtra(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addExtra(); } }} />
        <Button variant="ghost" onClick={addExtra}>Toevoegen</Button>
      </div>

      <label className="mr-composer-label">Onderwerp</label>
      <Input value={subject} onChange={(e) => setSubject(e.target.value)} />

      <label className="mr-composer-label">Bericht</label>
      <Textarea rows={10} value={bodyText} onChange={(e) => setBodyText(e.target.value)} />

      {hasTranscript && (
        <label className="mr-recipient mr-include-transcript">
          <input type="checkbox" checked={includeTranscript} onChange={(e) => setIncludeTranscript(e.target.checked)} />
          <span>Volledig transcript meesturen</span>
        </label>
      )}

      {error && <p className="mr-error">{error}</p>}

      <div className="mr-actions">
        <Button variant="primary" disabled={sending} onClick={() => void send()}>
          {sending ? <><Loader2 size={14} className="spin" /> Versturen…</> : <><Send size={14} /> Verstuur</>}
        </Button>
        <Button variant="ghost" disabled={sending} onClick={onCancel}><X size={14} /> Annuleren</Button>
      </div>
    </div>
  );
}
