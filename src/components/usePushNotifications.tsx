import { useCallback, useEffect, useState } from 'react';
import { BellRing } from 'lucide-react';
import { Button } from './Ui';
import {
  PUSH_EVENTS,
  currentPermission,
  disablePush,
  enablePush,
  ensureServiceWorker,
  getBrowserSubscription,
  isPushSupported,
  loadNotificationPreferences,
  sendTestPush,
  setNotificationPreference,
  type PushEventType,
} from '../lib/push-api';

export interface PushApi {
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
  subscribed: boolean;
  busy: boolean;
  error: string | null;
  info: string | null;
  preferences: Record<PushEventType, boolean>;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  test: () => Promise<void>;
  togglePreference: (eventType: PushEventType, enabled: boolean) => Promise<void>;
}

const defaultPreferences = () =>
  Object.fromEntries(PUSH_EVENTS.map(e => [e.type, true])) as Record<PushEventType, boolean>;

/**
 * App-niveau hook (naast useTicketUnread/useTeamChat): registreert de service
 * worker, houdt de abonnementsstatus bij en biedt aan/uit + per-gebeurtenis
 * voorkeuren. Levert push zodra de gebruiker toestemming geeft — ook als de app
 * geminimaliseerd/gesloten is.
 */
export function usePushNotifications(params: {
  organizationId: string | null;
  currentUserId: string | null;
}): PushApi {
  const { organizationId, currentUserId } = params;
  const [supported] = useState(isPushSupported);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(currentPermission);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<Record<PushEventType, boolean>>(defaultPreferences);

  // Registreer de service worker en detecteer een bestaand browserabonnement.
  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    ensureServiceWorker()
      .then(() => getBrowserSubscription())
      .then(sub => { if (!cancelled) setSubscribed(Boolean(sub)); })
      .catch(() => { /* stil: de gebruiker kan het handmatig aanzetten */ });
    return () => { cancelled = true; };
  }, [supported]);

  // Stille hersync: staat de toestemming al aan, ververs dan de opgeslagen rij
  // (bv. na server-side opschonen of het roteren van de VAPID-sleutel).
  useEffect(() => {
    if (!supported || !organizationId || !currentUserId) return;
    if (Notification.permission !== 'granted') return;
    let cancelled = false;
    (async () => {
      try {
        await enablePush(organizationId);
        if (!cancelled) { setSubscribed(true); setPermission('granted'); }
      } catch { /* stil */ }
    })();
    return () => { cancelled = true; };
  }, [supported, organizationId, currentUserId]);

  // Laad de per-gebeurtenis voorkeuren voor de actieve organisatie.
  useEffect(() => {
    if (!organizationId) { setPreferences(defaultPreferences()); return; }
    let cancelled = false;
    loadNotificationPreferences(organizationId)
      .then(prefs => { if (!cancelled) setPreferences(prefs); })
      .catch(() => { /* stil: standaard = alles aan */ });
    return () => { cancelled = true; };
  }, [organizationId]);

  const enable = useCallback(async () => {
    if (!organizationId) { setError('Geen actieve organisatie.'); return; }
    setBusy(true); setError(null); setInfo(null);
    try {
      await enablePush(organizationId);
      setSubscribed(true); setPermission('granted');
      setInfo('Meldingen staan nu aan op dit apparaat.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Meldingen aanzetten mislukt.');
      setPermission(currentPermission());
    } finally { setBusy(false); }
  }, [organizationId]);

  const disable = useCallback(async () => {
    setBusy(true); setError(null); setInfo(null);
    try {
      await disablePush();
      setSubscribed(false);
      setInfo('Meldingen staan uit op dit apparaat.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Meldingen uitzetten mislukt.');
    } finally { setBusy(false); }
  }, []);

  const test = useCallback(async () => {
    setBusy(true); setError(null); setInfo(null);
    try {
      const result = await sendTestPush();
      setInfo(result.sent > 0 ? 'Testmelding verstuurd — je zou hem nu moeten zien.' : 'Geen apparaat gevonden. Zet meldingen eerst aan.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Testmelding versturen mislukt.');
    } finally { setBusy(false); }
  }, []);

  const togglePreference = useCallback(async (eventType: PushEventType, enabled: boolean) => {
    if (!organizationId) return;
    setPreferences(prev => ({ ...prev, [eventType]: enabled })); // optimistisch
    try {
      await setNotificationPreference(organizationId, eventType, enabled);
    } catch (e) {
      setPreferences(prev => ({ ...prev, [eventType]: !enabled }));
      setError(e instanceof Error ? e.message : 'Voorkeur opslaan mislukt.');
    }
  }, [organizationId]);

  return { supported, permission, subscribed, busy, error, info, preferences, enable, disable, test, togglePreference };
}

/** Instellingen → Meldingen: aan/uit + per-gebeurtenis + testknop. */
export function PushNotificationsCard({ api }: { api: PushApi }) {
  const { supported, permission, subscribed, busy, error, info, preferences, enable, disable, test, togglePreference } = api;

  return (
    <section className="settings-card organization-card">
      <div className="settings-card-head">
        <div>
          <h3><BellRing size={15} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 6 }} />Meldingen op dit apparaat</h3>
          <p className="settings-help">
            Krijg een melding op je computer of telefoon zodra er een nieuw ticket, chatbericht, klant-e-mail of boeking binnenkomt —
            ook als ResoFly geminimaliseerd of gesloten is. Zet meldingen aan per apparaat/browser dat je gebruikt.
          </p>
        </div>
        {supported && permission !== 'denied' && (
          subscribed
            ? <Button variant="danger" onClick={disable} disabled={busy}>{busy ? '…' : 'Uitzetten'}</Button>
            : <Button variant="primary" onClick={enable} disabled={busy}>{busy ? '…' : 'Meldingen aanzetten'}</Button>
        )}
      </div>

      {error && <div className="error">{error}</div>}
      {info && <div className="success">{info}</div>}

      {!supported && (
        <p className="settings-help">
          Deze browser ondersteunt geen pushmeldingen. Gebruik een recente Chrome, Edge of Firefox — of installeer ResoFly als app
          (menu van je browser → “App installeren”).
        </p>
      )}
      {supported && permission === 'denied' && (
        <p className="settings-help">
          Meldingen zijn geblokkeerd in je browser. Klik op het slotje in de adresbalk → <strong>Meldingen</strong> → Toestaan, en probeer het opnieuw.
        </p>
      )}

      {supported && subscribed && (
        <>
          <div>
            <p className="settings-help" style={{ marginBottom: 8 }}>Waarvoor wil je een melding?</p>
            <div className="notif-prefs">
              {PUSH_EVENTS.map(ev => (
                <label key={ev.type} className="settings-toggle notif-pref-row" title={ev.hint}>
                  <input
                    type="checkbox"
                    checked={preferences[ev.type]}
                    onChange={e => togglePreference(ev.type, e.target.checked)}
                  />
                  <span>{ev.label}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="settings-save-bar">
            <Button onClick={test} disabled={busy}>Stuur testmelding</Button>
            <p className="settings-help">De voorkeuren gelden voor jou binnen deze organisatie; aan/uit geldt per apparaat.</p>
          </div>
        </>
      )}
    </section>
  );
}
