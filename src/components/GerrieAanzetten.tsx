import { useState, type FormEvent } from 'react';
import { AlertTriangle, Check, Eye, Sparkles, UserCheck } from 'lucide-react';
import { Button } from './Ui';
import { Modal } from './Modal';
import {
  AI_CONSENT_POINTS, AI_CONSENT_STATE_LABEL, aiConsentState, allPointsChecked, consentIsActive, consentIsOutdated,
  consentSinceLabel, type AiConsent, type AiConsentPointKey,
} from '../lib/aiConsent';
import { parseModuleAccess, resolveModuleLevel } from '../lib/permissions';
import type { OrganizationMember } from '../types';

/**
 * Gerrie aanzetten (2026-11-12).
 *
 * Gerrie staat pas aan als de gebruiker dat zelf doet, per organisatie, na
 * drie vinkjes: de AI leest je gegevens en stelt handelingen voor, de AI kan
 * fouten maken, en de AI beslist niets zelf. De teksten staan in
 * src/lib/aiConsent.ts; de database controleert de vinkjes nog een keer
 * (set_ai_consent).
 *
 * Twee plekken: de pagina Gerrie zolang hij uit staat, en Instellingen → AI,
 * waar je hem ook weer uitzet.
 */

/** Zet Gerrie aan of uit; gooit met een leesbare zin als het niet lukt. */
export type AiConsentChange = (enabled: boolean, acknowledged: readonly AiConsentPointKey[]) => Promise<void>;

const POINT_ICON: Record<AiConsentPointKey, typeof Eye> = {
  gegevens_lezen: Eye,
  kan_fouten_maken: AlertTriangle,
  geen_eigen_beslissingen: UserCheck,
};

/** De drie punten, elk met een vinkje, en de knop. */
export function GerrieConsentForm({ organizationName, outdated = false, onChange }: {
  organizationName: string;
  /** Gerrie stond aan onder een oudere tekst: dat zeggen we erbij. */
  outdated?: boolean;
  onChange: AiConsentChange;
}) {
  const [checked, setChecked] = useState<Set<AiConsentPointKey>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = allPointsChecked(checked);

  function toggle(key: AiConsentPointKey, on: boolean) {
    setChecked(prev => {
      const next = new Set(prev);
      if (on) next.add(key); else next.delete(key);
      return next;
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onChange(true, [...checked]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gerrie aanzetten is niet gelukt. Probeer het opnieuw.');
      setBusy(false);
    }
    // Gelukt: dit formulier verdwijnt, want Gerrie staat aan. Daarom hier geen
    // setBusy(false); dat gaf een waarschuwing over een verdwenen component.
  }

  return (
    <form className="gaz-form" onSubmit={submit}>
      {outdated && (
        <p className="gaz-note" role="status">
          De uitleg over Gerrie is veranderd sinds je hem aanzette. Lees hem opnieuw en vink de punten aan; daarna werkt Gerrie weer.
        </p>
      )}
      <ol className="gaz-points">
        {AI_CONSENT_POINTS.map((point, index) => {
          const Icon = POINT_ICON[point.key];
          const on = checked.has(point.key);
          const id = `gaz-${point.key}`;
          return (
            <li key={point.key} className={`gaz-point${on ? ' is-checked' : ''}`}>
              <span className="gaz-point-icon" aria-hidden="true"><Icon size={18} /></span>
              <div className="gaz-point-body">
                <h3><span className="gaz-point-nr">{index + 1}.</span> {point.title}</h3>
                <p>{point.text}</p>
                <label className="gaz-check" htmlFor={id}>
                  <input id={id} type="checkbox" checked={on} disabled={busy} onChange={e => toggle(point.key, e.target.checked)} />
                  <span>{point.confirm}</span>
                </label>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="gaz-fine">
        Dit geldt alleen voor jou, in {organizationName || 'deze organisatie'}. Werk je in meer organisaties, dan zet je Gerrie in elk daarvan apart aan.
        Uitzetten kan altijd, onder Instellingen → AI.
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="gaz-actions">
        <Button variant="primary" type="submit" disabled={!ready || busy}>
          <Sparkles size={15} aria-hidden="true" /> {busy ? 'Gerrie aanzetten…' : 'Gerrie aanzetten'}
        </Button>
        {!ready && <span className="gaz-hint">Vink eerst alle drie de punten aan.</span>}
      </div>
    </form>
  );
}

/** De pagina Gerrie zolang hij voor deze gebruiker uit staat. */
export function GerrieAanzettenPage({ organizationName, consent, onChange }: {
  organizationName: string;
  consent: AiConsent | null;
  onChange: AiConsentChange;
}) {
  return (
    <div className="cc-root gaz-page">
      <header className="cc-top">
        <div className="cc-brand"><span className="cc-spark" aria-hidden="true"><Sparkles size={18} /></span><b>Gerrie</b><span className="cc-sub">AI-assistent</span></div>
      </header>
      <section className="gaz" aria-labelledby="gaz-title">
        <div className="gaz-hero">
          <h2 id="gaz-title">Zet Gerrie aan</h2>
          <p>
            Gerrie is de AI-assistent van ResoFly. Hij beantwoordt je vragen over je eigen administratie, zet werk voor je klaar
            en houdt met agents dingen voor je in de gaten. Hij staat pas aan als jij dat wilt. Lees hieronder wat dat betekent.
          </p>
        </div>
        <GerrieConsentForm organizationName={organizationName} outdated={consentIsOutdated(consent)} onChange={onChange} />
      </section>
    </div>
  );
}

/**
 * Instellingen → AI: of Gerrie voor jou aanstaat, hem aan- of uitzetten, en
 * voor een owner of admin hoe het in het team staat.
 */
export function AiConsentSettings({ organizationName, consent, moduleOpen, onChange, consents = [], teamMembers = [], isAdmin = false, currentUserId = null }: {
  organizationName: string;
  consent: AiConsent | null;
  /** Staat de module Gerrie voor deze gebruiker open? Zo niet, dan kan hij Gerrie niet aanzetten. */
  moduleOpen: boolean;
  onChange: AiConsentChange;
  consents?: AiConsent[];
  teamMembers?: OrganizationMember[];
  isAdmin?: boolean;
  currentUserId?: string | null;
}) {
  const [confirmOff, setConfirmOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = moduleOpen && consentIsActive(consent);
  const since = consentSinceLabel(consent);

  async function turnOff() {
    setBusy(true);
    setError(null);
    try {
      await onChange(false, []);
      setConfirmOff(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gerrie uitzetten is niet gelukt. Probeer het opnieuw.');
    } finally {
      setBusy(false);
    }
  }

  const team = isAdmin ? teamMembers
    .filter(member => member.status === 'active')
    .map(member => {
      const open = resolveModuleLevel(member.role, parseModuleAccess(member.module_access), 'gerrie') !== 'none';
      const row = consents.find(c => c.user_id === member.user_id) ?? null;
      return { member, state: aiConsentState(row, open), since: consentSinceLabel(row) };
    }) : [];

  return (
    <section className="settings-card gaz-settings" aria-labelledby="gaz-settings-title">
      <div className="settings-card-head">
        <div>
          <h3 id="gaz-settings-title">Gerrie (AI)</h3>
          <p className="settings-help">
            Gerrie is de AI-assistent van ResoFly: de chat, het commandocentrum, de agents, de beslislijst en de rapportages met Gerrie.
            Je zet hem zelf aan, per organisatie. Dat geldt ook voor een eigen AI die je hieronder koppelt.
          </p>
        </div>
        <span className={`gaz-state${on ? ' is-on' : ''}`}>{on ? 'Aan' : 'Uit'}</span>
      </div>

      {!moduleOpen ? (
        <p className="settings-help">
          De module Gerrie staat voor jou dicht in {organizationName || 'deze organisatie'}. Vraag de eigenaar of een beheerder om hem open te zetten;
          daarna kun je Gerrie hier aanzetten.
        </p>
      ) : on ? (
        <div className="gaz-on">
          <p>Gerrie staat voor jou aan{since ? ` sinds ${since}` : ''}. Je ging akkoord met:</p>
          <ul className="gaz-agreed">
            {AI_CONSENT_POINTS.map(point => (
              <li key={point.key}><Check size={15} aria-hidden="true" /> <span><strong>{point.title}.</strong> {point.confirm}</span></li>
            ))}
          </ul>
          <div className="gaz-actions">
            <Button variant="danger" onClick={() => { setError(null); setConfirmOff(true); }} disabled={busy}>Gerrie uitzetten</Button>
          </div>
        </div>
      ) : (
        <GerrieConsentForm organizationName={organizationName} outdated={consentIsOutdated(consent)} onChange={onChange} />
      )}

      {isAdmin && team.length > 0 && (
        <div className="gaz-team">
          <h4>In je team</h4>
          <p className="settings-help">Iedereen zet Gerrie zelf aan; dat kun je niet voor een ander doen. Wie Gerrie niet mag gebruiken, stel je in bij Organisatie &amp; team.</p>
          <ul className="gaz-team-list">
            {team.map(({ member, state, since: memberSince }) => (
              <li key={member.id}>
                <span className="gaz-team-name">{member.email || 'Teamlid'}{member.user_id === currentUserId ? ' (jij)' : ''}</span>
                <span className={`gaz-team-state is-${state}`}>
                  {AI_CONSENT_STATE_LABEL[state]}{state === 'on' && memberSince ? ` · sinds ${memberSince}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {confirmOff && (
        <Modal title="Gerrie uitzetten?" onClose={() => { if (!busy) setConfirmOff(false); }} footer={<>
          <Button onClick={() => setConfirmOff(false)} disabled={busy}>Annuleren</Button>
          <Button variant="danger" onClick={() => void turnOff()} disabled={busy}>{busy ? 'Uitzetten…' : 'Uitzetten'}</Button>
        </>}>
          <ul className="gaz-off-list">
            <li>Gerrie verdwijnt uit je scherm: de chat, het commandocentrum, de beslislijst en de rapportages met Gerrie.</li>
            <li>Je agents in {organizationName || 'deze organisatie'} gaan op pauze. Zet je Gerrie later weer aan, dan zet je ze zelf weer aan.</li>
            <li>Een eigen AI die je koppelde, werkt niet meer tot je Gerrie weer aanzet.</li>
            <li>Je gesprekken en rapportages blijven bewaard.</li>
          </ul>
          {error && <p className="error" role="alert">{error}</p>}
        </Modal>
      )}
    </section>
  );
}
