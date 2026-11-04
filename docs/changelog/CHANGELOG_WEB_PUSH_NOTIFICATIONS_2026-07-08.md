# Web Push — OS-/device-meldingen (2026-07-08)

OS-meldingen op je apparaat (Windows/macOS/Android) zodra er een nieuw **ticket**,
**klantreactie op een ticket**, **teamchat-bericht**, **inkomende klant-e-mail**,
**boeking** of **betaalde factuur** binnenkomt — **ook als ResoFly geminimaliseerd of
gesloten is**. Dit vult het gat van de bestaande in-app Realtime-toasts, die alleen
werken zolang er een tab open is.

## Wat is er gebouwd

**Database** — `supabase/migrations/20260710000000_web_push.sql`
- `push_subscriptions` (per gebruiker/apparaat), `notification_preferences`
  (per organisatie × gebeurtenis, ontbrekende rij = aan), `notification_outbox`
  (durable wachtrij). Per-gebruiker RLS zoals `ticket_reads`; outbox heeft RLS aan
  zonder policies (onbereikbaar voor gewone gebruikers).
- SECURITY DEFINER triggers op `tickets`, `ticket_notes`, `chat_messages`,
  `client_emails`, `meeting_bookings`, `invoices` die per ontvanger een outbox-rij
  wegschrijven (fan-out via `organization_members`/`chat_participants`, afzender
  uitgesloten). Elke trigger draait in een exception-block: melden blokkeert nooit
  de bron-insert.
- RPC's `claim_push_outbox` / `mark_push_outbox` (`for update skip locked`,
  crash-herstel na 5 min, `attempts >= 5` → `dead`). Alle SECURITY DEFINER functies
  ge-revoked van `public, anon, authenticated`; dispatcher-RPC's `grant`ed aan
  `service_role`.

**Edge function** — `supabase/functions/web-push/` + `_shared/webPush.ts`
- `?cron=drain` (x-cron-secret): leegt de outbox, verstuurt versleutelde pushes en
  ruimt dode abonnementen op (404/410). App-acties `getVapidKey` + `test`.
- VAPID (ES256-JWT) + payload-encryptie (RFC 8291 / aes128gcm, RFC 8188) met de hand
  op Web Crypto — bewust géén `npm:web-push` (past niet in de Deno-edge-runtime).
- `config.toml`: `[functions.web-push] verify_jwt = false`.

**Frontend / PWA**
- `public/sw.js` (alleen push + notificationclick, géén fetch-handler),
  `public/manifest.webmanifest` + app-iconen (`public/icons/`), `<link rel="manifest">`
  in `index.html` → ResoFly is nu installeerbaar als app.
- `src/lib/push-api.ts` + `src/components/usePushNotifications.tsx` (App-niveau hook,
  gekoppeld in `main.tsx`) + nieuwe tab **Instellingen → Meldingen** (aan/uit per
  apparaat, per-gebeurtenis voorkeuren, testknop).

## Kwaliteit
- Adversarieel gereviewd (multi-agent) + zelf. Verholpen: 1 **kritiek** (SECURITY
  DEFINER functies moesten van `anon`/`authenticated` worden ge-revoked, niet enkel
  `public`), 1 **high** (een corrupt abonnement/ongeldige VAPID-sleutel liet de
  verzendfunctie throwen en brak de hele drain-batch → verzendfunctie is nu total +
  per-rij guard), 1 **medium** (org-id-wijzigingsguard blokkeerde re-sync bij
  org-wissel → verwijderd).
- Frontend typecheck groen, `deno check` groen, `npm run build` groen. Service
  worker-registratie in de browser geverifieerd (scope `/`, geserveerd als
  `text/javascript`).

## Nog te doen (operator) — zie `PUSH_SETUP.md`
1. VAPID-sleutelpaar genereren.
2. Secrets: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`,
   `PUSH_CRON_SECRET`, `PUSH_ALLOWED_ORIGINS`.
3. pg_cron-job `web-push-drain` (elke minuut → `web-push?cron=drain`).
4. End-to-end test via **Instellingen → Meldingen → Stuur testmelding**.

> Web Push-abonnementen gelden per exacte origin: op staging én productie apart
> "Meldingen aanzetten".
