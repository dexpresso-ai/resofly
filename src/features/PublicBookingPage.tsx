import { useEffect, useMemo, useState } from 'react';
import { Button, Input } from '../components/Ui';
import { supabase } from '../lib/supabase';

interface PublicSlot { id: string; starts_at: string; ends_at: string }
interface PublicLinkData {
  link: { title: string; intro_text: string | null; max_total_bookings: number; max_per_week: number };
  slots: PublicSlot[];
  taken_slot_starts: string[];
  prefill: { name: string | null; email: string | null } | null;
}
interface BookResult {
  confirmed: Array<{ slot_id: string; starts_at: string; ends_at: string }>;
  failed: Array<{ slot_id: string; reason: string }>;
  meeting_url: string | null;
  invite_message: string | null;
  title: string;
}

function isValidEmail(v: string): boolean { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

/** Maandag (lokaal) van de week waarin `iso` valt, als YYYY-MM-DD-sleutel. */
function weekKey(iso: string): string {
  const d = new Date(iso);
  const monday = new Date(d);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}
function fmtDay(iso: string): string {
  return new Intl.DateTimeFormat('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Amsterdam' }).format(new Date(iso));
}
function fmtTime(iso: string): string {
  return new Intl.DateTimeFormat('nl-NL', { timeStyle: 'short', timeZone: 'Europe/Amsterdam' }).format(new Date(iso));
}
function fmtWeekLabel(mondayKey: string): string {
  const d = new Date(mondayKey + 'T12:00:00');
  const end = new Date(d); end.setDate(d.getDate() + 6);
  const f = (x: Date) => new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short' }).format(x);
  return `Week van ${f(d)} – ${f(end)}`;
}

export function PublicBookingPage({ token }: { token: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PublicLinkData | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<BookResult | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true); setError(null);
      const { data: res, error: err } = await supabase.functions.invoke('meeting-booking-public', { body: { action: 'getLink', token } });
      if (!alive) return;
      if (err || !res || res.ok !== true) {
        setError((res && res.error) || err?.message || 'Deze boekingslink werkt niet meer.');
      } else {
        const d = res as unknown as { link: PublicLinkData['link']; slots: PublicSlot[]; taken_slot_starts: string[]; prefill: PublicLinkData['prefill'] };
        setData({ link: d.link, slots: d.slots, taken_slot_starts: d.taken_slot_starts, prefill: d.prefill });
        if (d.prefill?.name) setName(d.prefill.name);
        if (d.prefill?.email) setEmail(d.prefill.email);
      }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [token]);

  const slotById = useMemo(() => new Map((data?.slots ?? []).map(s => [s.id, s])), [data]);

  const weekGroups = useMemo(() => {
    const groups = new Map<string, PublicSlot[]>();
    for (const s of data?.slots ?? []) {
      const k = weekKey(s.starts_at);
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(s);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data]);

  // Reeds bezette boekingen per week + totaal (server blijft leidend).
  const takenTotal = data?.taken_slot_starts.length ?? 0;
  const takenPerWeek = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of data?.taken_slot_starts ?? []) m.set(weekKey(t), (m.get(weekKey(t)) ?? 0) + 1);
    return m;
  }, [data]);

  const selectedPerWeek = useMemo(() => {
    const m = new Map<string, number>();
    for (const id of selected) { const s = slotById.get(id); if (s) { const k = weekKey(s.starts_at); m.set(k, (m.get(k) ?? 0) + 1); } }
    return m;
  }, [selected, slotById]);

  const maxTotal = data?.link.max_total_bookings ?? 1;
  const maxWeek = data?.link.max_per_week ?? 1;
  const totalUsed = takenTotal + selected.size;
  const totalRemaining = Math.max(0, maxTotal - totalUsed);

  function weekRemaining(k: string): number {
    return Math.max(0, maxWeek - ((takenPerWeek.get(k) ?? 0) + (selectedPerWeek.get(k) ?? 0)));
  }

  function toggle(slot: PublicSlot) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(slot.id)) { next.delete(slot.id); return next; }
      const k = weekKey(slot.starts_at);
      if (totalRemaining <= 0) return prev; // totaallimiet
      if (weekRemaining(k) <= 0) return prev; // weeklimiet
      next.add(slot.id);
      return next;
    });
  }

  async function book() {
    if (selected.size === 0 || !isValidEmail(email)) return;
    setSubmitting(true); setError(null);
    const { data: res, error: err } = await supabase.functions.invoke('meeting-booking-public', {
      body: { action: 'bookSlots', token, slotIds: [...selected], name: name.trim(), email: email.trim() },
    });
    setSubmitting(false);
    if (err || !res || res.ok !== true) {
      setError((res && res.error) || err?.message || 'Boeken mislukt. Probeer het opnieuw.');
      return;
    }
    setResult(res as unknown as BookResult);
    setSelected(new Set());
  }

  if (loading) return <main className="public-quote-page"><div className="public-quote-card"><h1>Beschikbare tijden laden…</h1></div></main>;
  if (error && !data) return <main className="public-quote-page"><div className="public-quote-card"><p className="eyebrow">Afspraak inplannen</p><h1>Deze link werkt niet meer</h1><p>{error}</p></div></main>;
  if (!data) return <main className="public-quote-page"><div className="public-quote-card"><h1>Niet gevonden</h1></div></main>;

  // Bevestigingsscherm na het boeken.
  if (result) {
    return (
      <main className="public-quote-page">
        <section className="public-quote-card public-quote-hero">
          <div>
            <p className="eyebrow">{result.title}</p>
            <h1>{result.confirmed.length > 0 ? 'Afspraak bevestigd 🎉' : 'Boeking niet gelukt'}</h1>
            <p>{result.confirmed.length > 0 ? 'Je ontvangt een agenda-uitnodiging en een bevestiging per e-mail.' : 'Geen van de gekozen momenten kon worden geboekt.'}</p>
          </div>
        </section>
        {result.confirmed.length > 0 && (
          <section className="public-quote-card">
            <h2>Ingepland</h2>
            <ul>{result.confirmed.map(c => <li key={c.slot_id}>{fmtDay(c.starts_at)} · {fmtTime(c.starts_at)}–{fmtTime(c.ends_at)}</li>)}</ul>
            {result.meeting_url && <p><strong>Videocall:</strong> <a href={result.meeting_url}>{result.meeting_url}</a></p>}
            {result.invite_message && <p style={{ whiteSpace: 'pre-wrap' }}>{result.invite_message}</p>}
          </section>
        )}
        {result.failed.length > 0 && (
          <section className="public-quote-card">
            <h2>Niet gelukt</h2>
            <ul>{result.failed.map(f => <li key={f.slot_id}>{slotById.get(f.slot_id) ? fmtDay(slotById.get(f.slot_id)!.starts_at) + ' · ' + fmtTime(slotById.get(f.slot_id)!.starts_at) : 'Blok'}: {f.reason}</li>)}</ul>
            <Button onClick={() => { setResult(null); }}>Ander moment kiezen</Button>
          </section>
        )}
      </main>
    );
  }

  const noneAvailable = data.slots.length === 0;

  return (
    <main className="public-quote-page">
      <section className="public-quote-card public-quote-hero">
        <div>
          <p className="eyebrow">Afspraak inplannen</p>
          <h1>{data.link.title}</h1>
          {data.link.intro_text && <p style={{ whiteSpace: 'pre-wrap' }}>{data.link.intro_text}</p>}
        </div>
      </section>

      {error && <div className="public-quote-alert">{error}</div>}

      <section className="public-quote-card">
        <h2>Kies een moment</h2>
        <p className="muted" style={{ marginTop: -4 }}>
          Je mag {maxTotal === 1 ? 'één moment' : `maximaal ${maxTotal} momenten`} kiezen{maxWeek < maxTotal ? `, maximaal ${maxWeek} per week` : ''}. Tijden in Nederlandse tijd (Europe/Amsterdam).
        </p>
        {noneAvailable && <p>Er zijn op dit moment geen beschikbare tijden. Neem contact op voor een ander voorstel.</p>}
        {weekGroups.map(([k, slots]) => {
          const remaining = weekRemaining(k);
          return (
            <div key={k} style={{ marginBottom: 18 }}>
              <h3 style={{ margin: '0 0 8px' }}>{fmtWeekLabel(k)} {remaining <= 0 && <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>· weeklimiet bereikt</span>}</h3>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {slots.map(s => {
                  const isSel = selected.has(s.id);
                  const disabled = !isSel && (totalRemaining <= 0 || remaining <= 0);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => toggle(s)}
                      disabled={disabled}
                      className={`btn ${isSel ? 'btn-primary' : 'btn-ghost'}`}
                      style={{ opacity: disabled ? 0.4 : 1, textAlign: 'left' }}
                      title={`${fmtDay(s.starts_at)} ${fmtTime(s.starts_at)}`}
                    >
                      <div style={{ fontWeight: 600 }}>{fmtDay(s.starts_at)}</div>
                      <div style={{ fontSize: 13 }}>{fmtTime(s.starts_at)} – {fmtTime(s.ends_at)}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </section>

      {!noneAvailable && (
        <section className="public-quote-card">
          <h2>Je gegevens</h2>
          <div style={{ display: 'grid', gap: 12, maxWidth: 420 }}>
            <label>Naam<Input value={name} onChange={e => setName(e.target.value)} placeholder="Voor- en achternaam" /></label>
            <label>E-mailadres<Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="jij@voorbeeld.nl" /></label>
          </div>
          <div style={{ marginTop: 16 }}>
            <Button variant="primary" disabled={submitting || selected.size === 0 || !isValidEmail(email)} onClick={book}>
              {submitting ? 'Bezig met boeken…' : selected.size <= 1 ? 'Bevestig afspraak' : `Bevestig ${selected.size} afspraken`}
            </Button>
            {selected.size > 0 && <span className="muted" style={{ marginLeft: 12 }}>{selected.size} moment{selected.size === 1 ? '' : 'en'} geselecteerd</span>}
          </div>
        </section>
      )}
    </main>
  );
}
