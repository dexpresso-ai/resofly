// ============================================================
// Web Push — frontend-helpers.
//
// Abonnementen (push_subscriptions) en voorkeuren (notification_preferences)
// schrijft de client rechtstreeks via RLS (zoals campagne-/suppressie-CRUD). De
// edge function `web-push` levert alleen de publieke VAPID-sleutel en de
// testmelding (service-role-acties). De service worker (/sw.js) toont de melding.
// ============================================================

import { supabase } from './supabase';
import { throwFunctionError } from './functionErrors';
import type { UUID } from '../types';

export type PushEventType =
  | 'ticket_new'
  | 'ticket_note_client'
  | 'chat_message'
  | 'client_email_inbound'
  | 'booking_new'
  | 'invoice_paid';

export const PUSH_EVENTS: Array<{ type: PushEventType; label: string; hint: string }> = [
  { type: 'ticket_new', label: 'Nieuw ticket', hint: 'Een klant maakt een ticket aan via het portaal.' },
  { type: 'ticket_note_client', label: 'Reactie op ticket', hint: 'Een klant reageert op een lopend ticket.' },
  { type: 'chat_message', label: 'Teamchat-bericht', hint: 'Een nieuw bericht in een gesprek of kanaal waar je in zit.' },
  { type: 'client_email_inbound', label: 'Inkomende klant-e-mail', hint: 'Een klant beantwoordt een e-mail.' },
  { type: 'booking_new', label: 'Nieuwe boeking', hint: 'Een klant boekt zelf een afspraak via je boekingslink.' },
  { type: 'invoice_paid', label: 'Factuur betaald', hint: 'Een factuur wordt op betaald gezet.' },
];

/** Draait deze browser Web Push? (nodig: service worker + PushManager + Notification) */
export function isPushSupported(): boolean {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

export function currentPermission(): NotificationPermission | 'unsupported' {
  if (!isPushSupported()) return 'unsupported';
  return Notification.permission;
}

// ── Service worker ────────────────────────────────────────────────────────────

let registrationPromise: Promise<ServiceWorkerRegistration> | null = null;

/** Registreer (eenmalig) de service worker op root-scope en wacht tot hij actief is. */
export async function ensureServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!isPushSupported()) throw new Error('Deze browser ondersteunt geen meldingen.');
  if (!registrationPromise) {
    registrationPromise = navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then(() => navigator.serviceWorker.ready)
      .catch((err) => { registrationPromise = null; throw err; });
  }
  return registrationPromise;
}

// ── VAPID-sleutel + base64url ────────────────────────────────────────────────

// Let inferentie een Uint8Array<ArrayBuffer> opleveren (nodig als applicationServerKey).
function urlBase64ToUint8Array(base64: string) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function arrayBufferToBase64Url(buffer: ArrayBuffer | null): string {
  if (!buffer) return '';
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function fetchVapidPublicKey(): Promise<string> {
  const { data, error } = await supabase.functions.invoke('web-push', { body: { action: 'getVapidKey' } });
  if (error) await throwFunctionError(error, 'Kon de meldingssleutel niet ophalen.');
  if (!data?.ok || !data.publicKey) throw new Error(data?.error || 'Meldingssleutel ontbreekt op de server.');
  return String(data.publicKey);
}

// ── Abonneren / afmelden ──────────────────────────────────────────────────────

export async function getBrowserSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const registration = await ensureServiceWorker();
  return registration.pushManager.getSubscription();
}

/**
 * Vraag toestemming (indien nodig), abonneer bij de push-dienst en sla het
 * abonnement op onder de huidige gebruiker/organisatie. Idempotent: opnieuw
 * aanroepen ververst simpelweg de opgeslagen rij.
 */
export async function enablePush(organizationId: UUID): Promise<void> {
  if (!isPushSupported()) throw new Error('Deze browser ondersteunt geen meldingen.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(permission === 'denied'
      ? 'Meldingen zijn geblokkeerd. Zet ze aan via het slotje in de adresbalk.'
      : 'Meldingen zijn niet toegestaan.');
  }

  const registration = await ensureServiceWorker();
  const applicationServerKey = urlBase64ToUint8Array(await fetchVapidPublicKey());

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
  }

  const p256dh = arrayBufferToBase64Url(subscription.getKey('p256dh'));
  const auth = arrayBufferToBase64Url(subscription.getKey('auth'));
  if (!p256dh || !auth) throw new Error('Kon de meldingssleutels van de browser niet lezen.');

  const { error } = await supabase.from('push_subscriptions').upsert({
    organization_id: organizationId,
    endpoint: subscription.endpoint,
    p256dh,
    auth,
    user_agent: navigator.userAgent.slice(0, 400),
    last_seen_at: new Date().toISOString(),
  }, { onConflict: 'endpoint' });
  if (error) throw new Error(error.message);
}

/** Meld dit apparaat af: verwijder de opgeslagen rij én het browserabonnement. */
export async function disablePush(): Promise<void> {
  const subscription = await getBrowserSubscription();
  if (subscription) {
    await supabase.from('push_subscriptions').delete().eq('endpoint', subscription.endpoint);
    await subscription.unsubscribe().catch(() => {});
  }
}

/** Stuur een testmelding naar alle apparaten van de huidige gebruiker. */
export async function sendTestPush(): Promise<{ sent: number }> {
  const { data, error } = await supabase.functions.invoke('web-push', { body: { action: 'test' } });
  if (error) await throwFunctionError(error, 'Testmelding versturen mislukt.');
  if (!data?.ok) throw new Error(data?.error || 'Testmelding versturen mislukt.');
  return { sent: Number(data.sent || 0) };
}

// ── Voorkeuren (per organisatie × gebeurtenis) ───────────────────────────────

/** Laad de per-gebeurtenis voorkeuren; ontbrekende rij = aan (standaard). */
export async function loadNotificationPreferences(organizationId: UUID): Promise<Record<PushEventType, boolean>> {
  const defaults = Object.fromEntries(PUSH_EVENTS.map(e => [e.type, true])) as Record<PushEventType, boolean>;
  const { data, error } = await supabase
    .from('notification_preferences')
    .select('event_type, enabled')
    .eq('organization_id', organizationId);
  if (error) throw new Error(error.message);
  for (const row of (data ?? []) as Array<{ event_type: PushEventType; enabled: boolean }>) {
    if (row.event_type in defaults) defaults[row.event_type] = row.enabled;
  }
  return defaults;
}

export async function setNotificationPreference(
  organizationId: UUID,
  eventType: PushEventType,
  enabled: boolean,
): Promise<void> {
  const { error } = await supabase.from('notification_preferences').upsert({
    organization_id: organizationId,
    event_type: eventType,
    enabled,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'organization_id,user_id,event_type' });
  if (error) throw new Error(error.message);
}
