import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarCheck, Clock, Mail, Phone, Globe, Video, X } from 'lucide-react';
import { Button } from '../components/Ui';
import { supabase } from '../lib/supabase';
import { safeHttpUrl } from '../lib/safeUrl';
import { PublicBrandFooter, PublicDocHero, PublicDocState, usePublicBrandTheme } from '../components/PublicBrand';
import type { BrandingPayload } from '../lib/branding';
import type { MeetingBookingLinkState } from '../types';
import {
  amsterdamWeekKey,
  choiceRule,
  commonDuration,
  durationLabel,
  fmtDayKey,
  fmtDayLong,
  fmtMoment,
  fmtTime,
  fmtWeekLabel,
  groupByDay,
} from '../lib/bookingLinks';

// De boekingspagina die de klant opent vanuit de mail (/booking/<token>).
//
// Sinds november 2026 een echte klantpagina, net als de offerte en de factuur:
// in de huisstijl van de leverancier (kop, logo, kleuren, afsluiting), met wie
// de afspraak is, hoe lang hij duurt en hoe hij plaatsvindt. Eerst stond hier
// een kale kaart zonder afzender, waarop een klant niet kon zien met wie hij een
// afspraak maakte, en een gesloten of verlopen link gaf alleen "Deze link werkt
// niet meer" zonder te zeggen bij wie hij dan terecht kon.

interface PublicSlot { id: string; starts_at: string; ends_at: string }
interface PublicCompany { name: string | null; email: string | null; phone: string | null; website: string | null }
interface PublicLinkData {
  state: MeetingBookingLinkState;
  link: { title: string; intro_text: string | null; max_total_bookings: number; max_per_week: number; expires_at: string | null; video: string | null };
  slots: PublicSlot[];
  taken_slot_starts: string[];
  booked: Array<{ starts_at: string; ends_at: string }>;
  prefill: { name: string | null; email: string | null } | null;
  branding: BrandingPayload | null;
  company: PublicCompany | null;
}
interface BookResult {
  confirmed: Array<{ slot_id: string; starts_at: string; ends_at: string; meeting_url: string | null }>;
  failed: Array<{ slot_id: string; reason: string }>;
  meeting_url: string | null;
  invite_message: string | null;
  title: string;
  /** De gekozen momenten zoals ze waren: na het verversen staat een moment dat
   *  een ander net boekte er niet meer, en dan wist "niet gelukt" niet welk. */
  chosen?: PublicSlot[];
}

function isValidEmail(v: string): boolean { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()); }

/** De uitleg van de server bij een 4xx, of een eigen zin. */
async function functionError(error: unknown, fallback: string): Promise<string> {
  const context = (error as { context?: unknown })?.context;
  if (context instanceof Response) {
    const payload = await context.clone().json().catch(() => null) as { error?: string } | null;
    if (payload?.error) return payload.error;
  }
  return fallback;
}

const STATUS_TEXT: Record<MeetingBookingLinkState, string> = {
  open: 'Kies een moment',
  full: 'Ingepland',
  closed: 'Gesloten',
  expired: 'Verlopen',
  unavailable: 'Niet beschikbaar',
};

export function PublicBookingPage({ token }: { token: string }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PublicLinkData | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<BookResult | null>(null);
  const detailsRef = useRef<HTMLElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const emailRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async (opts: { keepForm?: boolean } = {}) => {
    const { data: res, error: err } = await supabase.functions.invoke('meeting-booking-public', { body: { action: 'getLink', token } });
    if (err || !res || res.ok !== true) {
      return { error: (res && res.error) || (err ? await functionError(err, 'Deze boekingslink werkt niet (meer).') : 'Deze boekingslink werkt niet (meer).') };
    }
    const d = res as unknown as PublicLinkData;
    const next: PublicLinkData = {
      state: d.state ?? 'open',
      link: d.link,
      slots: d.slots ?? [],
      taken_slot_starts: d.taken_slot_starts ?? [],
      booked: d.booked ?? [],
      prefill: d.prefill ?? null,
      branding: d.branding ?? null,
      company: d.company ?? null,
    };
    if (!opts.keepForm) {
      if (next.prefill?.name) setName(prev => prev || next.prefill!.name!);
      if (next.prefill?.email) setEmail(prev => prev || next.prefill!.email!);
    }
    return { data: next };
  }, [token]);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true); setLoadError(null);
      const res = await load();
      if (!alive) return;
      if (res.error) setLoadError(res.error); else setData(res.data!);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [load]);

  const branding = data?.branding ?? null;
  const companyName = branding?.companyName || data?.company?.name || '';
  usePublicBrandTheme(branding, 'Afspraak');

  const slots = data?.slots ?? [];
  const slotById = useMemo(() => new Map(slots.map(s => [s.id, s])), [slots]);
  const duration = useMemo(() => commonDuration(slots.length ? slots : (data?.booked ?? [])), [slots, data?.booked]);

  // Per week (Nederlandse tijd, zoals de weeklimiet in de database), daarin per dag.
  const weeks = useMemo(() => {
    const byWeek = new Map<string, PublicSlot[]>();
    for (const s of slots) {
      const k = amsterdamWeekKey(s.starts_at);
      const list = byWeek.get(k);
      if (list) list.push(s); else byWeek.set(k, [s]);
    }
    return [...byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([week, list]) => ({ week, days: groupByDay(list) }));
  }, [slots]);

  const maxTotal = data?.link.max_total_bookings ?? 1;
  const maxWeek = data?.link.max_per_week ?? 1;
  const takenTotal = data?.taken_slot_starts.length ?? 0;
  const takenPerWeek = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of data?.taken_slot_starts ?? []) m.set(amsterdamWeekKey(t), (m.get(amsterdamWeekKey(t)) ?? 0) + 1);
    return m;
  }, [data]);
  const selectedPerWeek = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const id of selected) {
      const s = slotById.get(id);
      if (!s) continue;
      const k = amsterdamWeekKey(s.starts_at);
      m.set(k, [...(m.get(k) ?? []), id]);
    }
    return m;
  }, [selected, slotById]);
  const allowedTotal = Math.max(0, maxTotal - takenTotal);
  const weekRoom = (k: string) => Math.max(0, maxWeek - (takenPerWeek.get(k) ?? 0));

  /**
   * Kiezen. Mag de klant maar één moment kiezen, dan vervangt een klik op een
   * ander moment de keuze (eerst moest je je keuze eerst weer uitzetten, en
   * stond de rest grijs zonder uitleg). Hetzelfde binnen een week die vol is.
   */
  function toggle(slot: PublicSlot) {
    setError(null);
    setSelected(prev => {
      if (prev.includes(slot.id)) return prev.filter(id => id !== slot.id);
      const k = amsterdamWeekKey(slot.starts_at);
      const inWeek = prev.filter(id => { const s = slotById.get(id); return s && amsterdamWeekKey(s.starts_at) === k; });
      if (inWeek.length >= weekRoom(k)) {
        if (inWeek.length === 0) return prev;
        return [...prev.filter(id => id !== inWeek[inWeek.length - 1]), slot.id];
      }
      if (prev.length >= allowedTotal) {
        if (allowedTotal === 1) return [slot.id];
        return prev;
      }
      return [...prev, slot.id];
    });
  }

  function slotDisabled(slot: PublicSlot): boolean {
    if (selected.includes(slot.id)) return false;
    const k = amsterdamWeekKey(slot.starts_at);
    const inWeek = selectedPerWeek.get(k)?.length ?? 0;
    if (weekRoom(k) === 0) return true;
    if (inWeek >= weekRoom(k)) return false; // vervangt de keuze in die week
    if (selected.length >= allowedTotal) return allowedTotal !== 1;
    return false;
  }

  const selectedSlots = selected.map(id => slotById.get(id)).filter((s): s is PublicSlot => Boolean(s))
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const emailInvalid = email.trim() !== '' && !isValidEmail(email);

  function goToDetails() {
    detailsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.setTimeout(() => (name.trim() ? emailRef.current : nameRef.current)?.focus({ preventScroll: true }), 350);
  }

  async function book() {
    setEmailTouched(true);
    if (selected.length === 0) { setError('Kies eerst een moment.'); return; }
    if (!isValidEmail(email)) { setError('Vul je e-mailadres in, dan sturen we je de bevestiging.'); emailRef.current?.focus(); return; }
    setSubmitting(true); setError(null);
    const { data: res, error: err } = await supabase.functions.invoke('meeting-booking-public', {
      body: { action: 'bookSlots', token, slotIds: selected, name: name.trim(), email: email.trim() },
    });
    if (err || !res || res.ok !== true) {
      setSubmitting(false);
      setError((res && res.error) || (err ? await functionError(err, 'Boeken is niet gelukt. Probeer het opnieuw.') : 'Boeken is niet gelukt. Probeer het opnieuw.'));
      return;
    }
    setResult({ ...(res as unknown as BookResult), chosen: selectedSlots });
    setSelected([]);
    // Meteen de nieuwe stand ophalen: kiest de klant hierna een ander moment,
    // dan staan de net geboekte momenten er niet meer als vrij tussen.
    const fresh = await load({ keepForm: true });
    if (fresh.data) setData(fresh.data);
    setSubmitting(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  if (loading) return <PublicDocState><p className="eyebrow">Afspraak inplannen</p><h1>Vrije momenten laden…</h1></PublicDocState>;
  if (loadError || !data) {
    return <PublicDocState>
      <p className="eyebrow">Afspraak inplannen</p>
      <h1>Deze link werkt niet (meer)</h1>
      <p>{loadError ?? 'Deze boekingslink is niet gevonden.'}</p>
      <p className="muted">Misschien heb je intussen een nieuwe link gekregen: kijk in je mail. Anders kun je contact opnemen met wie je de link stuurde.</p>
    </PublicDocState>;
  }

  const eyebrow = companyName ? `Afspraak met ${companyName}` : 'Afspraak inplannen';
  // De kern in twee tegels: hoe lang, en hoe (alleen als het een videogesprek is).
  const videoVia = data.link.video ? data.link.video.replace(/^Videogesprek( via | — )?/, '') : '';
  const facts = [
    ...(duration ? [{ label: 'Duur', value: duration }] : []),
    ...(data.link.video ? [{ label: 'Hoe', value: 'Videogesprek', sub: videoVia || undefined }] : []),
  ];

  // ── Na het boeken ───────────────────────────────────────────────────────
  if (result) {
    const ok = result.confirmed.length > 0;
    const meetingUrl = safeHttpUrl(result.meeting_url);
    return <main className="public-quote-page public-doc public-booking">
      <PublicDocHero
        branding={branding}
        companyName={companyName}
        kind="Afspraak"
        eyebrow={eyebrow}
        title={ok ? (result.confirmed.length === 1 ? 'Je afspraak staat vast' : `Je ${result.confirmed.length} afspraken staan vast`) : 'Dat moment lukte niet'}
        intro={ok ? `Je krijgt een bevestiging per e-mail op ${email.trim()} en een uitnodiging voor je agenda.` : 'Er is niets geboekt. Kies hieronder een ander moment.'}
        status={<div className={`public-quote-status st-${ok ? 'accepted' : 'rejected'}`}>{ok ? 'Bevestigd' : 'Niet gelukt'}</div>}
      />
      <div className="public-canvas">
        {ok && <section className="public-quote-card booking-done" aria-live="polite">
          <h2><CalendarCheck size={18} aria-hidden="true" /> Ingepland</h2>
          <ul className="booking-moments">
            {result.confirmed.map(c => <li key={c.slot_id}>
              <strong>{fmtDayLong(c.starts_at)}</strong>
              <span>{fmtTime(c.starts_at)} – {fmtTime(c.ends_at)} · {durationLabel(c.starts_at, c.ends_at)}</span>
            </li>)}
          </ul>
          {meetingUrl && <p className="booking-video-line">
            <Video size={15} aria-hidden="true" />
            <a href={meetingUrl} target="_blank" rel="noopener noreferrer">Link naar het videogesprek</a>
            <span className="muted">(staat ook in je mail)</span>
          </p>}
          {result.invite_message && <p className="booking-note">{result.invite_message}</p>}
        </section>}
        {result.failed.length > 0 && <section className="public-quote-card booking-failed" role="alert">
          <h2>{ok ? 'Dit moment lukte niet' : 'Niet gelukt'}</h2>
          <ul className="booking-moments">
            {result.failed.map(f => {
              const s = result.chosen?.find(c => c.id === f.slot_id) ?? slotById.get(f.slot_id);
              return <li key={f.slot_id}>
                <strong>{s ? fmtMoment(s.starts_at, s.ends_at) : 'Moment'}</strong>
                <span>{f.reason}</span>
              </li>;
            })}
          </ul>
          {data.state === 'open' && data.slots.length > 0 && <Button variant="primary" onClick={() => setResult(null)}>Kies een ander moment</Button>}
        </section>}
        <ContactCard company={data.company} companyName={companyName} question={ok ? 'Kun je toch niet?' : 'Lukt het niet?'} />
        <PublicBrandFooter branding={branding} />
      </div>
    </main>;
  }

  // ── De link kan (nu) niet boeken ──────────────────────────────────────────
  if (data.state !== 'open') {
    const copy: Record<Exclude<MeetingBookingLinkState, 'open'>, { title: string; text: string }> = {
      full: data.booked.length
        ? { title: data.booked.length === 1 ? 'Je afspraak staat vast' : 'Je afspraken staan vast', text: 'Via deze link is alles ingepland wat er ingepland kon worden.' }
        : { title: 'Alles is al ingepland', text: 'Via deze link kunnen geen afspraken meer worden gemaakt.' },
      closed: { title: 'Deze link is gesloten', text: `Via deze link kun je geen afspraak meer maken.${companyName ? ` Wil je toch een afspraak? Neem dan contact op met ${companyName}.` : ''}` },
      expired: { title: 'Deze link is verlopen', text: `De link is niet meer geldig.${companyName ? ` Vraag ${companyName} om een nieuwe link.` : ' Vraag de afzender om een nieuwe link.'}` },
      unavailable: { title: 'Deze link is niet meer beschikbaar', text: `Via deze link kun je op dit moment geen afspraak maken.${companyName ? ` Neem contact op met ${companyName}.` : ''}` },
    };
    const c = copy[data.state];
    return <main className="public-quote-page public-doc public-booking">
      <PublicDocHero
        branding={branding}
        companyName={companyName}
        kind="Afspraak"
        eyebrow={eyebrow}
        title={data.link.title}
        status={<div className={`public-quote-status st-${data.state === 'full' ? 'accepted' : 'expired'}`}>{STATUS_TEXT[data.state]}</div>}
      />
      <div className="public-canvas">
        <section className="public-quote-card booking-state">
          <h2>{c.title}</h2>
          <p>{c.text}</p>
          {data.booked.length > 0 && <BookedList booked={data.booked} />}
        </section>
        <ContactCard company={data.company} companyName={companyName} question="Vragen?" />
        <PublicBrandFooter branding={branding} />
      </div>
    </main>;
  }

  // ── Kiezen ────────────────────────────────────────────────────────────────
  const noneAvailable = slots.length === 0;
  const canConfirm = selected.length > 0 && isValidEmail(email) && !submitting;

  return (
    <main className="public-quote-page public-doc public-booking">
      <PublicDocHero
        branding={branding}
        companyName={companyName}
        kind="Afspraak"
        eyebrow={eyebrow}
        title={data.link.title}
        intro={data.link.intro_text ? <span className="booking-intro">{data.link.intro_text}</span> : undefined}
        status={<div className="public-quote-status st-sent">{STATUS_TEXT.open}</div>}
        facts={facts}
      />

      <div className={`public-canvas${selected.length ? ' has-booking-bar' : ''}`}>
        {data.booked.length > 0 && <section className="public-quote-card booking-state">
          <h2>Al ingepland</h2>
          <BookedList booked={data.booked} />
        </section>}

        <section className="public-quote-card booking-pick" aria-labelledby="booking-pick-title">
          <div className="booking-pick-head">
            <h2 id="booking-pick-title">Kies een moment</h2>
            <p className="muted">{choiceRule(maxTotal, maxWeek, takenTotal)}. Alle tijden zijn Nederlandse tijd.</p>
          </div>
          {noneAvailable && <div className="booking-empty">
            <Clock size={20} aria-hidden="true" />
            <p>Er zijn op dit moment geen vrije momenten.{companyName ? ` Neem contact op met ${companyName} voor een ander voorstel.` : ' Neem contact op met de afzender voor een ander voorstel.'}</p>
          </div>}
          {weeks.map(({ week, days }) => {
            const room = weekRoom(week);
            const multiWeek = weeks.length > 1;
            return (
              <div key={week} className="booking-week">
                {multiWeek && <h3 className="booking-week-label">
                  {fmtWeekLabel(week)}
                  {room === 0 && <span className="muted"> · in deze week heb je al een afspraak</span>}
                </h3>}
                {days.map(({ day, slots: daySlots }) => (
                  <div key={day} className="booking-day">
                    <div className="booking-day-label">{fmtDayKey(day)}</div>
                    {/* De klassen booking-slots en booking-slot meet de mobiele
                        test (eerste moment hoog genoeg in beeld). */}
                    <div className="booking-slots" role="group" aria-label={fmtDayKey(day)}>
                      {daySlots.map(s => {
                        const isSel = selected.includes(s.id);
                        const disabled = slotDisabled(s);
                        return (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => toggle(s)}
                            disabled={disabled}
                            aria-pressed={isSel}
                            aria-label={`${fmtDayLong(s.starts_at)}, ${fmtTime(s.starts_at)} tot ${fmtTime(s.ends_at)}`}
                            className={`booking-slot${isSel ? ' is-selected' : ''}`}
                            title={disabled ? 'Je hebt het maximum aantal momenten gekozen. Haal eerst een moment weg.' : undefined}
                          >
                            <span className="booking-slot-time">{fmtTime(s.starts_at)}</span>
                            {!duration && <span className="booking-slot-end">tot {fmtTime(s.ends_at)}</span>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </section>

        {!noneAvailable && (
          <section className="public-quote-card booking-details" ref={detailsRef} aria-labelledby="booking-details-title">
            <h2 id="booking-details-title">Je gegevens</h2>
            {selectedSlots.length > 0
              ? <ul className="booking-chosen" aria-label="Gekozen momenten">
                  {selectedSlots.map(s => <li key={s.id}>
                    <span>{fmtMoment(s.starts_at, s.ends_at)}</span>
                    <button type="button" className="booking-chosen-remove" onClick={() => toggle(s)} aria-label={`${fmtMoment(s.starts_at, s.ends_at)} weghalen`}><X size={14} /></button>
                  </li>)}
                </ul>
              : <p className="muted booking-chosen-empty">Kies hierboven een moment.</p>}
            <div className="booking-fields">
              <label>Naam
                {/* Een gewoon invoerveld: Input uit Ui stuurt geen ref door, en "Verder"
                    zet de cursor hier. */}
                <input className="form-input" ref={nameRef} value={name} onChange={e => setName(e.target.value)} placeholder="Voor- en achternaam" autoComplete="name" maxLength={160} />
              </label>
              <label>E-mailadres
                <input
                  className="form-input"
                  ref={emailRef}
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  onBlur={() => setEmailTouched(true)}
                  placeholder="jij@voorbeeld.nl"
                  aria-invalid={emailTouched && emailInvalid ? true : undefined}
                  aria-describedby="booking-email-hint"
                  maxLength={254}
                />
                <span id="booking-email-hint" className={`booking-field-hint${emailTouched && emailInvalid ? ' is-error' : ''}`}>
                  {emailTouched && emailInvalid ? 'Dit e-mailadres klopt nog niet.' : 'Hierheen sturen we de bevestiging en de uitnodiging.'}
                </span>
              </label>
            </div>
            {error && <div className="public-quote-alert booking-error" role="alert">{error}</div>}
            <div className="booking-confirm">
              <Button variant="primary" disabled={!canConfirm} onClick={() => void book()}>
                {submitting ? 'Bezig met inplannen…' : selected.length <= 1 ? 'Bevestig afspraak' : `Bevestig ${selected.length} afspraken`}
              </Button>
              <span className="muted">Je krijgt meteen een bevestiging per e-mail.</span>
            </div>
          </section>
        )}

        <ContactCard company={data.company} companyName={companyName} question="Vragen?" />
        <PublicBrandFooter branding={branding} />
      </div>

      {/* Op de telefoon: de keuze onderaan in beeld, met één knop naar de gegevens. */}
      {selected.length > 0 && !noneAvailable && <div className="booking-bar" role="region" aria-label="Je keuze">
        <span>{selected.length === 1 && selectedSlots[0] ? fmtMoment(selectedSlots[0].starts_at, selectedSlots[0].ends_at) : `${selected.length} momenten gekozen`}</span>
        <Button variant="primary" onClick={goToDetails}>Verder</Button>
      </div>}
    </main>
  );
}

function BookedList({ booked }: { booked: Array<{ starts_at: string; ends_at: string }> }) {
  return <ul className="booking-moments">
    {booked.map(b => <li key={b.starts_at}>
      <strong>{fmtDayLong(b.starts_at)}</strong>
      <span>{fmtTime(b.starts_at)} – {fmtTime(b.ends_at)}</span>
    </li>)}
  </ul>;
}

/** Bij wie de klant terechtkan: de gegevens die de leverancier ook op zijn offertes zet. */
function ContactCard({ company, companyName, question }: { company: PublicCompany | null; companyName: string; question: string }) {
  if (!company || (!company.email && !company.phone && !company.website)) return null;
  const website = company.website ? safeHttpUrl(/^https?:\/\//i.test(company.website) ? company.website : `https://${company.website}`) : null;
  return <section className="public-quote-card booking-contact">
    <h2>{question}</h2>
    <p className="muted">Neem contact op met {companyName || 'de afzender'}.</p>
    <div className="booking-contact-lines">
      {company.email && <a href={`mailto:${company.email}`}><Mail size={15} aria-hidden="true" /> {company.email}</a>}
      {company.phone && <a href={`tel:${company.phone.replace(/[^+\d]/g, '')}`}><Phone size={15} aria-hidden="true" /> {company.phone}</a>}
      {website && <a href={website} target="_blank" rel="noopener noreferrer"><Globe size={15} aria-hidden="true" /> {company.website}</a>}
    </div>
  </section>;
}
