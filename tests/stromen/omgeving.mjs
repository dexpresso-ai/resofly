// De lokale Supabase-stack (supabase start) en de secrets van de edge
// functions zoals op staging, maar met nep-diensten voor Resend, Mollie en de
// media-worker (zie nepdiensten.mjs).
import { execFileSync } from 'node:child_process';

const ROOT = new URL('../../', import.meta.url);

function lokaleStatus() {
  try {
    const out = execFileSync('npx', ['supabase', 'status', '-o', 'env'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return Object.fromEntries(out.split('\n')
      .map((regel) => regel.match(/^([A-Z_]+)="(.*)"$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]));
  } catch {
    throw new Error('tests/stromen: de lokale stack draait niet. Start hem met `npx supabase start` (zie README.md).');
  }
}

const status = lokaleStatus();
if (!status.API_URL || !status.SERVICE_ROLE_KEY) {
  throw new Error('tests/stromen: API_URL of SERVICE_ROLE_KEY ontbreekt in `supabase status`. Draaien gateway, auth en rest?');
}

export const API_URL = status.API_URL;
export const ANON_KEY = status.ANON_KEY;
export const SERVICE_KEY = status.SERVICE_ROLE_KEY;
export const DB_URL = status.DB_URL;
export const ORIGIN = 'http://localhost:5173';
export const PUBLIEK = 'http://localhost:5173';
export const MEDIA = 'https://media.stromen.test';
export const R2_GEHEIM = 'r2-geheim-stromen';
export const CRON_SECRET = 'cron-geheim-stromen';
export const WEBHOOK_SECRET = 'webhook-geheim-stromen';
export const AGENDA_STATE_GEHEIM = 'agenda-state-geheim-stromen';
/** Waarmee de afmeldlinks in marketingmail worden ondertekend (UNSUBSCRIBE_SECRET). */
export const AFMELD_GEHEIM = 'afmeld-geheim-stromen';
/** Zoals Resend het signing secret geeft (whsec_ + base64); de webhook controleert er de handtekening mee. */
export const RESEND_WEBHOOK_GEHEIM = `whsec_${Buffer.from('stromen-resend-webhook-geheim-32b').toString('base64')}`;

Object.assign(process.env, {
  SUPABASE_URL: API_URL,
  SUPABASE_ANON_KEY: ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  SUPABASE_DB_URL: DB_URL,
  RESEND_API_KEY: 're_stromen_test',
  RESEND_FROM_EMAIL: 'ResoFly <noreply@resofly.test>',
  RESEND_REPLY_TO: 'hallo@resofly.test',
  RESEND_WEBHOOK_SIGNING_SECRET: RESEND_WEBHOOK_GEHEIM,
  APP_PUBLIC_URL: PUBLIEK,
  QUOTE_ALLOWED_ORIGINS: ORIGIN,
  QUOTE_PUBLIC_ALLOWED_ORIGINS: ORIGIN,
  QUOTE_PUBLIC_BASE_URL: PUBLIEK,
  CONTRACT_ALLOWED_ORIGINS: ORIGIN,
  CONTRACT_PUBLIC_ALLOWED_ORIGINS: ORIGIN,
  CONTRACT_PUBLIC_BASE_URL: PUBLIEK,
  INVOICE_ALLOWED_ORIGINS: ORIGIN,
  INVOICE_PUBLIC_ALLOWED_ORIGINS: ORIGIN,
  INVOICE_PUBLIC_BASE_URL: PUBLIEK,
  CLIENT_PORTAL_ALLOWED_ORIGINS: ORIGIN,
  CLIENT_PORTAL_BASE_URL: PUBLIEK,
  MAIL_ALLOWED_ORIGINS: ORIGIN,
  QUOTE_PDF_STORAGE_WORKER_URL: MEDIA,
  QUOTE_PDF_STORAGE_SECRET: R2_GEHEIM,
  INVOICE_PDF_STORAGE_WORKER_URL: MEDIA,
  INVOICE_PDF_STORAGE_SECRET: R2_GEHEIM,
  CONTRACT_PDF_STORAGE_WORKER_URL: MEDIA,
  CONTRACT_PDF_STORAGE_SECRET: R2_GEHEIM,
  MEDIA_WORKER_URL: MEDIA,
  INTERNAL_UPLOAD_SECRET: R2_GEHEIM,
  INVOICE_MOLLIE_WEBHOOK_URL: `${API_URL}/functions/v1/invoice-workflow`,
  INVOICE_MOLLIE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  MOLLIE_TOKEN_ENCRYPTION_KEY: 'stromen-test-sleutel-voor-mollie-tokens',
  INVOICE_MOLLIE_ALLOW_MOCK: 'false',
  MOLLIE_ALLOW_MOCK: 'false',
  INVOICE_REMINDER_CRON_SECRET: CRON_SECRET,
  // De API laadt via Gerrie ook de agendacode; die eist deze sleutel bij het laden.
  CALENDAR_TOKEN_ENCRYPTION_KEY: 'stromen-test-sleutel-voor-agenda-tokens',
  // De agendakoppeling (agenda.mjs): Google en Microsoft zijn nep, de callback is de echte functie.
  CALENDAR_REDIRECT_URL: `${API_URL}/functions/v1/calendar-integrations`,
  CALENDAR_OAUTH_STATE_SECRET: AGENDA_STATE_GEHEIM,
  CALENDAR_ALLOWED_RETURN_ORIGINS: ORIGIN,
  CALENDAR_ICS_CRON_SECRET: CRON_SECRET,
  GOOGLE_CALENDAR_CLIENT_ID: 'google-client-stromen',
  GOOGLE_CALENDAR_CLIENT_SECRET: 'google-geheim-stromen',
  MICROSOFT_CALENDAR_CLIENT_ID: 'microsoft-client-stromen',
  MICROSOFT_CALENDAR_CLIENT_SECRET: 'microsoft-geheim-stromen',
  MICROSOFT_CALENDAR_TENANT_ID: 'common',
  // Marketing (marketing.mjs): de verzendronde en de afmeldlink. Een batch van
  // vijf in plaats van honderd: dan is met twaalf klanten al te zien wat er
  // gebeurt als een campagne over meerdere rondes loopt.
  CAMPAIGN_CRON_SECRET: CRON_SECRET,
  UNSUBSCRIBE_SECRET: AFMELD_GEHEIM,
  CAMPAIGN_DISPATCH_BATCH: '5',
});
