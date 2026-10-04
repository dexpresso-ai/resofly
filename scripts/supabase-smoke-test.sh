#!/usr/bin/env bash
# =============================================================================
# Rooktest na een deploy: antwoorden de functies van de openbare API zoals ze
# horen te antwoorden? Eén blik op de echte runtime van Supabase, na
# `supabase functions deploy`, zonder iets te veranderen.
#
#   - api: de beschrijving (200) en /v1/me zonder sleutel (401);
#   - webhooks: de bezorger zonder cron-secret (401);
#   - de bezorger MET het secret uit de cron-taak (200, {"ok":true…}). Dat
#     bewijst dat de taak en WEBHOOK_CRON_SECRET bij elkaar passen. Alleen als
#     de taak er is (scripts/supabase-setup-webhooks.sh) en SUPABASE_DB_PASSWORD
#     gezet is; anders overgeslagen.
#   - portal-notify (klantmeldingen) op dezelfde manier: zonder secret 401, met
#     het secret uit de taak 'portal-notify-drain' 200. Een 500 met "ontbreekt"
#     betekent dat RESEND_API_KEY/RESEND_FROM_EMAIL of APP_PUBLIC_URL er niet staat.
#
# Draait in de workflow "Deploy Supabase (staging)" na elke deploy, en kan ook
# vanaf een laptop: SUPABASE_PROJECT_ID=enzghpduqwaojcxgwarr bash scripts/supabase-smoke-test.sh
# =============================================================================
set -euo pipefail

ref="${SUPABASE_PROJECT_ID:?Zet SUPABASE_PROJECT_ID (de project-ref)}"
base="${SUPABASE_FUNCTIONS_URL:-https://${ref}.supabase.co/functions/v1}"
body="$(mktemp)"
trap 'rm -f "$body"' EXIT
problems=0

mask() { if [ "${GITHUB_ACTIONS:-}" = "true" ]; then echo "::add-mask::$1"; fi; }

# check <omschrijving> <verwachte status> <tekst die in het antwoord moet staan> <curl-argumenten…>
check() {
  local what="$1" want="$2" needle="$3"; shift 3
  local got
  got="$(curl -s -o "$body" -w '%{http_code}' --max-time 60 "$@" || echo 000)"
  if [ "$got" = "$want" ] && grep -qF -- "$needle" "$body"; then
    echo "ok     $what ($got)"
  else
    problems=$((problems + 1))
    echo "FOUT   $what: verwacht $want met \"$needle\", kreeg $got: $(head -c 300 "$body")"
    if [ "${GITHUB_ACTIONS:-}" = "true" ]; then echo "::error title=Rooktest::$what: verwacht $want, kreeg $got"; fi
  fi
}

check "api antwoordt met zijn beschrijving" 200 '"name":"ResoFly API"' "$base/api/v1"
check "api weigert /v1/me zonder sleutel" 401 '"unauthorized"' "$base/api/v1/me"
check "webhooks weigert de bezorger zonder cron-secret" 401 'cron-secret' -X POST "$base/webhooks?cron=dispatch"

if [ -n "${SUPABASE_DB_PASSWORD:-}" ] && command -v psql >/dev/null; then
  pooler="${SUPABASE_POOLER_URL:-$(cat supabase/.temp/pooler-url)}"
  secret="$(PGPASSWORD="$SUPABASE_DB_PASSWORD" PGSSLMODE="${PGSSLMODE:-require}" PGCONNECT_TIMEOUT=20 \
    psql "$pooler" -X -q -t -A -v ON_ERROR_STOP=1 <<'SQL'
select case when to_regclass('cron.job') is null then ''
            else coalesce((select substring(command from 'x-cron-secret'', ''([^'']*)''')
                             from cron.job where jobname = 'webhooks-dispatch'), '') end;
SQL
)"
  if [ -n "$secret" ]; then
    mask "$secret"
    check "de bezorger draait met het secret uit de cron-taak" 200 '"ok":true' \
      -X POST "$base/webhooks?cron=dispatch" -H "x-cron-secret: $secret" -H 'Content-Type: application/json' --data '{}'
  else
    echo "-      de bezorger met cron-secret: overgeslagen (nog geen cron-taak 'webhooks-dispatch')"
  fi

  # Klantmeldingen: pas te controleren zodra de taak (en dus het secret) er is.
  notify_secret="$(PGPASSWORD="$SUPABASE_DB_PASSWORD" PGSSLMODE="${PGSSLMODE:-require}" PGCONNECT_TIMEOUT=20 \
    psql "$pooler" -X -q -t -A -v ON_ERROR_STOP=1 <<'SQL'
select case when to_regclass('cron.job') is null then ''
            else coalesce((select substring(command from 'x-cron-secret'', ''([^'']*)''')
                             from cron.job where jobname = 'portal-notify-drain'), '') end;
SQL
)"
  if [ -n "$notify_secret" ]; then
    mask "$notify_secret"
    check "portal-notify weigert de wachtrij zonder cron-secret" 401 'cron-secret' -X POST "$base/portal-notify?cron=drain"
    check "portal-notify draait met het secret uit de cron-taak" 200 '"ok":true' \
      -X POST "$base/portal-notify?cron=drain" -H "x-cron-secret: $notify_secret" -H 'Content-Type: application/json' --data '{}'
  else
    echo "-      klantmeldingen (portal-notify): overgeslagen (nog geen cron-taak 'portal-notify-drain')"
  fi
else
  echo "-      de bezorger met cron-secret: overgeslagen (geen SUPABASE_DB_PASSWORD of psql)"
fi

if [ "$problems" -gt 0 ]; then
  echo "$problems controle(s) mislukt. Kijk in Supabase onder Edge Functions → Logs." >&2
  exit 1
fi
echo "Rooktest geslaagd op ${ref}."
