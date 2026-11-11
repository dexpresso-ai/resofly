import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, CalendarCheck, CalendarDays, CalendarPlus, Check, ChevronLeft, ChevronRight, Clock, Globe, Mail, Phone, X } from 'lucide-react';
import { Button } from '../components/Ui';
import { supabase } from '../lib/supabase';
import { safeHttpUrl } from '../lib/safeUrl';
import { PublicBrandFooter, PublicDocHero, PublicDocState, usePublicBrandTheme } from '../components/PublicBrand';
import { VideoServiceLine, VideoServiceMark } from '../components/VideoServiceMark';
import type { BrandingPayload } from '../lib/branding';
import type { MeetingBookingLinkState } from '../types';
import {
  VIDEO_INFO,
  amsterdamDateKey,
  amsterdamWeekKey,
  buildIcs,
  choiceRule,
  commonDuration,
  durationLabel,
  fmtDayKey,
  fmtDayLong,
  fmtDayParts,
  fmtMoment,
  fmtMonthLabel,
  fmtTime,
  groupByDay,
  isBookingVideoKind,
  monthGrid,
  monthKeyOf,
  shiftMonth,
  videoKindOf,
  type BookingVideoKind,
} from '../lib/bookingLinks';

// De boekingspagina die de klant opent vanuit de mail (/booking/<token>).
//
// November 2026, tweede ronde: in drie stappen, zoals de bekende
// planningsdiensten. Eerst een moment: een maandkalender met de dagen waarop
// iets vrij is, en ernaast de tijden van de gekozen dag (op de telefoon een
// strook met dagen). Dan je gegevens, met een samenvatting ernaast: wanneer,
// hoe lang, en welk videogesprek (Jitsi, Google Meet of Teams, met hoe je
// meedoet). Dan de bevestiging, met de knop naar het gesprek en een
// agenda-bestand.
//
// Wat het verving: één lange pagina met alle dagen onder elkaar, het formulier
// eronder, en het videogesprek als één woord in een tegel. Bij twintig
// momenten scrolde je op de telefoon langs alles heen, en bij een vaste link
// stond er "Link volgt per mail": of het Teams of Meet was, zag de klant pas
// in de bevestiging.

interface PublicSlot { id: string; starts_at: string; ends_at: string }
interface PublicCompany { name: string | null; email: string | null; phone: string | null; website: string | null }
interface PublicLinkData {
  state: MeetingBookingLinkState;
  link: {
    title: string;
    intro_text: string | null;
    max_total_bookings: number;
    max_per_week: number;
    expires_at: string | null;
    video: string | null;
    /** Sinds 2026-11-11; een oudere server stuurt alleen `video`. */
    video_service?: BookingVideoKind | null;
  };
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
  video_service?: BookingVideoKind | null;
  invite_message: string | null;
  title: string;
  /** De gekozen momenten zoals ze waren: na het verversen staat een moment dat
   *  een ander net boekte er niet meer, en dan wist "niet gelukt" niet welk. */
  chosen?: PublicSlot[];
}

type Step = 'pick' | 'details';

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

/** Een agenda-bestand downloaden zonder server: een blob in de browser. */
function downloadIcs(filename: string, content: string) {
  if (!content) return;
  const url = URL.createObjectURL(new Blob([content], { type: 'text/calendar;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const STATUS_TEXT: Record<MeetingBookingLinkState, string> = {
  open: 'Kies een moment',
  full: 'Ingepland',
  closed: 'Gesloten',
  expired: 'Verlopen',
  unavailable: 'Niet beschikbaar',
};

const WEEKDAY_HEADS = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'];

export function PublicBookingPage({ token }: { token: string }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PublicLinkData | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [step, setStep] = useState<Step>('pick');
  const [activeDay, setActiveDay] = useState<string | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<BookResult | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
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

  const slots = useMemo(() => data?.slots ?? [], [data]);
  const slotById = useMemo(() => new Map(slots.map(s => [s.id, s])), [slots]);
  const duration = useMemo(() => commonDuration(slots.length ? slots : (data?.booked ?? [])), [slots, data?.booked]);
  const days = useMemo(() => groupByDay(slots), [slots]);
  const slotsByDay = useMemo(() => new Map(days.map(d => [d.day, d.slots])), [days]);
  const video = videoKindOf(data?.link);

  // De eerste dag met iets vrij staat open; valt de gekozen dag weg (na het
  // verversen), dan weer de eerste.
  useEffect(() => {
    if (!days.length) { setActiveDay(null); return; }
    setActiveDay(prev => (prev && slotsByDay.has(prev) ? prev : days[0].day));
  }, [days, slotsByDay]);
  useEffect(() => {
    if (activeDay) setMonth(prev => (prev && prev === monthKeyOf(activeDay) ? prev : monthKeyOf(activeDay)));
  }, [activeDay]);

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
  const selectedDays = new Set(selectedSlots.map(s => amsterdamDateKey(s.starts_at)));
  const emailInvalid = email.trim() !== '' && !isValidEmail(email);

  function scrollToCard() {
    window.setTimeout(() => cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30);
  }

  function goToDetails() {
    if (selected.length === 0) { setError('Kies eerst een moment.'); return; }
    setError(null);
    setStep('details');
    scrollToCard();
    window.setTimeout(() => (name.trim() ? emailRef.current : nameRef.current)?.focus({ preventScroll: true }), 380);
  }

  function backToPick() {
    setStep('pick');
    setError(null);
    scrollToCard();
  }

  async function book() {
    setEmailTouched(true);
    if (selected.length === 0) { setError('Kies eerst een moment.'); setStep('pick'); return; }
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
    setStep('pick');
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
  // De kern in twee tegels: hoe lang, en welk videogesprek. Twee regels per
  // tegel: op de telefoon staan de momenten zo eerder in beeld.
  const facts = [
    ...(duration ? [{ label: 'Duur', value: duration }] : []),
    ...(video ? [{ label: 'Videogesprek', value: <span className="bk-fact-video"><VideoServiceMark kind={video} size="sm" />{VIDEO_INFO[video].name}</span> }] : []),
  ];

  // ── Na het boeken ───────────────────────────────────────────────────────
  if (result) {
    const ok = result.confirmed.length > 0;
    const meetingUrl = safeHttpUrl(result.meeting_url);
    const doneVideo: BookingVideoKind | null = isBookingVideoKind(result.video_service) ? result.video_service : video;
    return <main className="public-quote-page public-doc public-booking">
      <PublicDocHero
        branding={branding}
        companyName={companyName}
        kind="Afspraak"
        eyebrow={eyebrow}
        title={ok ? (result.confirmed.length === 1 ? 'Je afspraak staat vast' : `Je ${result.confirmed.length} afspraken staan vast`) : 'Dat moment lukte niet'}
        intro={ok ? `We hebben een bevestiging gestuurd naar ${email.trim()}, met een uitnodiging voor je agenda.` : 'Er is niets geboekt. Kies hieronder een ander moment.'}
        status={<div className={`public-quote-status st-${ok ? 'accepted' : 'rejected'}`}>{ok ? 'Bevestigd' : 'Niet gelukt'}</div>}
      />
      <div className="public-canvas">
        {ok && <section className="public-quote-card bk-done" aria-live="polite">
          <div className="bk-done-head">
            <span className="bk-done-check" aria-hidden="true"><Check size={22} strokeWidth={3} /></span>
            <div>
              <h2>{result.title || data.link.title}</h2>
              <p className="muted">{companyName ? `Met ${companyName}` : 'Ingepland'}{duration ? ` · ${duration}` : ''}</p>
            </div>
          </div>
          <ul className="bk-moment-list">
            {result.confirmed.map(c => <MomentCard key={c.slot_id} startsAt={c.starts_at} endsAt={c.ends_at}
              action={<button type="button" className="bk-link-btn" onClick={() => downloadIcs('afspraak.ics', buildIcs({
                uid: c.slot_id, title: companyName ? `${result.title || data.link.title} (${companyName})` : (result.title || data.link.title),
                startsAt: c.starts_at, endsAt: c.ends_at, description: result.invite_message, url: c.meeting_url ?? result.meeting_url,
              }))}><CalendarPlus size={15} aria-hidden="true" /> Zet in je agenda</button>} />)}
          </ul>
          {doneVideo && <div className="bk-video-card">
            <VideoServiceLine kind={doneVideo} showHow size="lg" />
            {meetingUrl
              ? <a className="btn btn-primary bk-join" href={meetingUrl} target="_blank" rel="noopener noreferrer">Deelnemen via {VIDEO_INFO[doneVideo].name}</a>
              : <p className="muted bk-video-later">De link naar het gesprek staat in je bevestiging en in de agenda-uitnodiging.</p>}
          </div>}
          {result.invite_message && <p className="booking-note">{result.invite_message}</p>}
          <ol className="bk-next">
            <li><Mail size={15} aria-hidden="true" /> De bevestiging staat in je mail ({email.trim()}).</li>
            <li><CalendarCheck size={15} aria-hidden="true" /> De uitnodiging voor je agenda komt apart.</li>
            {doneVideo && <li><Clock size={15} aria-hidden="true" /> Open het gesprek een paar minuten van tevoren.</li>}
          </ol>
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
          {data.state === 'open' && data.slots.length > 0 && <Button variant="primary" onClick={() => { setResult(null); setStep('pick'); }}>Kies een ander moment</Button>}
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
        facts={data.booked.length ? facts : undefined}
      />
      <div className="public-canvas">
        <section className="public-quote-card booking-state">
          <h2>{c.title}</h2>
          <p>{c.text}</p>
          {data.booked.length > 0 && <ul className="bk-moment-list">
            {data.booked.map(b => <MomentCard key={b.starts_at} startsAt={b.starts_at} endsAt={b.ends_at}
              action={<button type="button" className="bk-link-btn" onClick={() => downloadIcs('afspraak.ics', buildIcs({ uid: `${b.starts_at}-${data.link.title}`, title: data.link.title, startsAt: b.starts_at, endsAt: b.ends_at }))}><CalendarPlus size={15} aria-hidden="true" /> Zet in je agenda</button>} />)}
          </ul>}
        </section>
        <ContactCard company={data.company} companyName={companyName} question="Vragen?" />
        <PublicBrandFooter branding={branding} />
      </div>
    </main>;
  }

  // ── Kiezen en gegevens ────────────────────────────────────────────────────
  const noneAvailable = slots.length === 0;
  const canConfirm = selected.length > 0 && isValidEmail(email) && !submitting;
  const daySlots = activeDay ? slotsByDay.get(activeDay) ?? [] : [];
  const activeWeekFull = activeDay ? weekRoom(amsterdamWeekKey(`${activeDay}T12:00:00Z`)) === 0 : false;
  const firstMonth = days.length ? monthKeyOf(days[0].day) : null;
  const lastMonth = days.length ? monthKeyOf(days[days.length - 1].day) : null;
  const shownMonth = month ?? firstMonth;
  const rule = choiceRule(maxTotal, maxWeek, takenTotal);
  const multi = allowedTotal > 1;

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

      <div className={`public-canvas${selected.length && step === 'pick' ? ' has-booking-bar' : ''}`}>
        {data.booked.length > 0 && <section className="public-quote-card booking-state">
          <h2>Al ingepland</h2>
          <ul className="bk-moment-list">
            {data.booked.map(b => <MomentCard key={b.starts_at} startsAt={b.starts_at} endsAt={b.ends_at} />)}
          </ul>
        </section>}

        <section className={`public-quote-card bk-card is-${step}`} ref={cardRef} aria-labelledby="bk-card-title">
          <header className="bk-card-head">
            <div className="bk-card-title">
              {step === 'details' && <button type="button" className="bk-back" onClick={backToPick} aria-label="Terug naar de momenten"><ArrowLeft size={17} /></button>}
              <h2 id="bk-card-title">{step === 'pick' ? 'Kies een moment' : 'Je gegevens'}</h2>
            </div>
            <ol className="bk-steps" aria-label="Stappen">
              <li className={step === 'pick' ? 'is-current' : 'is-done'}><span>{step === 'pick' ? '1' : <Check size={12} strokeWidth={3} />}</span>Moment</li>
              <li className={step === 'details' ? 'is-current' : ''}><span>2</span>Gegevens</li>
              <li><span>3</span>Bevestigd</li>
            </ol>
          </header>

          {step === 'pick' && <>
            {noneAvailable && <div className="booking-empty">
              <Clock size={20} aria-hidden="true" />
              <p>Er zijn op dit moment geen vrije momenten.{companyName ? ` Neem contact op met ${companyName} voor een ander voorstel.` : ' Neem contact op met de afzender voor een ander voorstel.'}</p>
            </div>}

            {!noneAvailable && <div className="bk-pick">
              {/* Groot scherm: een maandkalender. */}
              {shownMonth && <div className="bk-cal" aria-label="Kalender">
                <div className="bk-cal-head">
                  <button type="button" className="bk-cal-nav" onClick={() => setMonth(shiftMonth(shownMonth, -1))} disabled={!firstMonth || shownMonth <= firstMonth} aria-label="Vorige maand"><ChevronLeft size={17} /></button>
                  <strong>{fmtMonthLabel(shownMonth)}</strong>
                  <button type="button" className="bk-cal-nav" onClick={() => setMonth(shiftMonth(shownMonth, 1))} disabled={!lastMonth || shownMonth >= lastMonth} aria-label="Volgende maand"><ChevronRight size={17} /></button>
                </div>
                <div className="bk-cal-grid" role="group" aria-label={fmtMonthLabel(shownMonth)}>
                  {WEEKDAY_HEADS.map(w => <span key={w} className="bk-cal-wd" aria-hidden="true">{w}</span>)}
                  {monthGrid(shownMonth).flat().map((day, i) => {
                    if (!day) return <span key={`e${i}`} className="bk-cal-day is-empty" />;
                    const has = slotsByDay.has(day);
                    const label = `${fmtDayKey(day)}${has ? `, ${slotsByDay.get(day)!.length} ${slotsByDay.get(day)!.length === 1 ? 'moment' : 'momenten'} vrij` : ', niets vrij'}`;
                    if (!has) return <span key={day} className="bk-cal-day" aria-hidden="true">{Number(day.slice(8))}</span>;
                    return <button key={day} type="button"
                      className={`bk-cal-day is-open${day === activeDay ? ' is-active' : ''}${selectedDays.has(day) ? ' is-chosen' : ''}`}
                      aria-pressed={day === activeDay} aria-label={label} onClick={() => setActiveDay(day)}>
                      {Number(day.slice(8))}
                    </button>;
                  })}
                </div>
                <p className="bk-cal-legend muted"><span className="bk-dot" aria-hidden="true" /> Er is iets vrij</p>
              </div>}

              {/* Telefoon: een strook met alleen de dagen waarop iets vrij is. */}
              <div className="bk-strip" role="group" aria-label="Dagen met vrije momenten">
                {days.map(({ day, slots: list }) => {
                  const p = fmtDayParts(day);
                  return <button key={day} type="button" aria-pressed={day === activeDay}
                    className={`bk-strip-day${day === activeDay ? ' is-active' : ''}${selectedDays.has(day) ? ' is-chosen' : ''}`}
                    aria-label={`${fmtDayKey(day)}, ${list.length} ${list.length === 1 ? 'moment' : 'momenten'}`}
                    onClick={() => setActiveDay(day)}>
                    <span>{p.weekday}</span><strong>{p.day}</strong><span>{p.month}</span>
                  </button>;
                })}
              </div>

              <div className="bk-times">
                {activeDay && <div className="bk-times-head">
                  <strong>{fmtDayKey(activeDay)}</strong>
                  <span className="muted">{daySlots.length} {daySlots.length === 1 ? 'moment' : 'momenten'} · Nederlandse tijd</span>
                </div>}
                {activeWeekFull && <p className="bk-times-note">In deze week heb je al een afspraak. Kies een dag in een andere week.</p>}
                {/* De klassen booking-slots en booking-slot meet de mobiele
                    test (eerste moment hoog genoeg in beeld). */}
                <div className="booking-slots" role="group" aria-label={activeDay ? fmtDayKey(activeDay) : 'Tijden'}>
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
                        title={disabled ? (activeWeekFull ? 'In deze week heb je al een afspraak.' : 'Je hebt het maximum aantal momenten gekozen. Haal eerst een moment weg.') : undefined}
                      >
                        {isSel && <Check size={14} strokeWidth={3} aria-hidden="true" className="booking-slot-check" />}
                        <span className="booking-slot-time">{fmtTime(s.starts_at)}</span>
                        <span className="booking-slot-end">{duration ? `tot ${fmtTime(s.ends_at)}` : `tot ${fmtTime(s.ends_at)} · ${durationLabel(s.starts_at, s.ends_at)}`}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>}

            {!noneAvailable && <footer className="bk-pick-foot">
              <div className="bk-pick-choice">
                <span className="muted bk-rule">{rule}.</span>
                {selectedSlots.length > 0
                  ? <ul className="booking-chosen" aria-label="Gekozen momenten">
                      {selectedSlots.map(s => <li key={s.id}>
                        <span>{fmtMoment(s.starts_at, s.ends_at)}</span>
                        <button type="button" className="booking-chosen-remove" onClick={() => toggle(s)} aria-label={`${fmtMoment(s.starts_at, s.ends_at)} weghalen`}><X size={14} /></button>
                      </li>)}
                    </ul>
                  : <span className="bk-pick-empty">{multi ? 'Kies een of meer tijden.' : 'Kies een tijd.'}</span>}
              </div>
              <Button variant="primary" disabled={selected.length === 0} onClick={goToDetails}>Verder <ArrowRight size={15} aria-hidden="true" /></Button>
            </footer>}
            {error && step === 'pick' && <div className="public-quote-alert booking-error" role="alert">{error}</div>}
          </>}

          {step === 'details' && <div className="bk-details">
            <aside className="bk-summary" aria-label="Je afspraak">
              <p className="bk-summary-eyebrow">Je afspraak</p>
              <h3>{data.link.title}</h3>
              <ul className="bk-summary-list">
                {selectedSlots.map(s => <li key={s.id}>
                  <CalendarDays size={16} aria-hidden="true" />
                  <span><strong>{fmtDayLong(s.starts_at)}</strong><em>{fmtTime(s.starts_at)} – {fmtTime(s.ends_at)}</em></span>
                </li>)}
                {duration && <li><Clock size={16} aria-hidden="true" /><span><strong>{duration}</strong></span></li>}
                {video && <li className="bk-summary-video"><VideoServiceLine kind={video} showHow /></li>}
                <li><Globe size={16} aria-hidden="true" /><span><em>Nederlandse tijd (Amsterdam)</em></span></li>
              </ul>
              <button type="button" className="bk-link-btn" onClick={backToPick}>Ander moment kiezen</button>
            </aside>

            <div className="bk-form">
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
                    onKeyDown={e => { if (e.key === 'Enter' && canConfirm) void book(); }}
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
            </div>
          </div>}
        </section>

        <ContactCard company={data.company} companyName={companyName} question="Vragen?" />
        <PublicBrandFooter branding={branding} />
      </div>

      {/* Op de telefoon: de keuze onderaan in beeld, met één knop naar de gegevens. */}
      {selected.length > 0 && !noneAvailable && step === 'pick' && <div className="booking-bar" role="region" aria-label="Je keuze">
        <span>{selected.length === 1 && selectedSlots[0] ? fmtMoment(selectedSlots[0].starts_at, selectedSlots[0].ends_at) : `${selected.length} momenten gekozen`}</span>
        <Button variant="primary" onClick={goToDetails}>Verder</Button>
      </div>}
    </main>
  );
}

/** Eén afspraak als kaart: een datumblok, de dag en de tijd. */
function MomentCard({ startsAt, endsAt, action }: { startsAt: string; endsAt: string; action?: ReactNode }) {
  const p = fmtDayParts(amsterdamDateKey(startsAt));
  return <li className="bk-moment">
    <span className="bk-moment-date" aria-hidden="true"><em>{p.month}</em><strong>{p.day}</strong></span>
    <span className="bk-moment-text">
      <strong>{fmtDayLong(startsAt)}</strong>
      <span>{fmtTime(startsAt)} – {fmtTime(endsAt)} · {durationLabel(startsAt, endsAt)}</span>
    </span>
    {action && <span className="bk-moment-action">{action}</span>}
  </li>;
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
