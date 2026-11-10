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
#   - client-domains (klantadressen): de opzoeking voor de Worker zonder het
#     goede geheim (401) en de nachtelijke ronde zonder cron-secret (401); met
#     het secret uit de taak 'client-domains-recheck' 200;
#   - het boekhouder-hek: geen organisatietabel zonder module gate én zonder hek
#     (public.accountant_fence_gaps() is leeg). Ook alleen met SUPABASE_DB_PASSWORD.
#   - de secrets voor Mollie: MOLLIE_TOKEN_ENCRYPTION_KEY (de eigen Mollie-key
#     van organisaties) en het webhook-secret. Alleen de namen, via de
#     Management API; alleen met SUPABASE_ACCESS_TOKEN.
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
# Klantadressen (migratie 20261108230000): zonder het geheim van de Worker
# geeft de opzoeking niets prijs, en de nachtelijke ronde draait niet.
check "client-domains weigert de opzoeking zonder het geheim van de Worker" 401 'Geen toegang' \
  -X POST "$base/client-domains" -H 'x-client-domains-secret: rooktest' -H 'Content-Type: application/json' --data '{"host":"rooktest.resofly.com"}'
check "client-domains weigert de nachtelijke ronde zonder cron-secret" 401 'cron-secret' -X POST "$base/client-domains?cron=recheck"
# Het klantportaal (migratie 20261109020000): het platform controleert daar geen
# JWT meer (een sleutel van een eigen domein is er geen), dus de functie zelf
# moet zonder inlog en met een verzonnen sleutel weigeren.
check "client-portal weigert zonder inlog" 401 'Niet ingelogd' \
  -X POST "$base/client-portal" -H 'Content-Type: application/json' --data '{"action":"getPortalData"}'
check "client-portal weigert een verzonnen sleutel" 401 'session_unbound' \
  -X POST "$base/client-portal" -H 'x-portal-token: rooktest-rooktest-rooktest-rooktest-01' -H 'Content-Type: application/json' --data '{"action":"getPortalData"}'
# De API-laag (docs/rapporten/CONTROLE_API_LAAG_2026-11-10.md): het
# OpenAPI-document, de MCP-server en de autorisatieserver antwoorden in de echte
# runtime, en de deuren zonder login weigeren zonder bewijs.
check "api geeft zijn OpenAPI-document" 200 '"openapi":"3.1' "$base/api/v1/openapi.json"
check "mcp weigert zonder token" 401 '"unauthorized"' \
  -X POST "$base/mcp" -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
check "mcp-oauth publiceert zijn metadata (alleen S256)" 200 '"code_challenge_methods_supported":["S256"]' \
  "$base/mcp-oauth/.well-known/oauth-authorization-server"
check "mcp-oauth stuurt een onbekende client nergens heen" 400 'Onbekende AI-client' \
  "$base/mcp-oauth/authorize?client_id=rooktest&redirect_uri=https%3A%2F%2Frooktest.invalid%2Fcb&response_type=code"
check "mail-inbound weigert zonder geheim" 401 'Niet geautoriseerd' \
  -X POST "$base/mail-inbound" -H 'Content-Type: application/json' --data '{}'
# Open punt O4 van die controle: Supabase serveert een GET met text/html op
# *.supabase.co als platte tekst. Dan ziet een ontvanger die op "Afmelden" klikt
# HTML-code in plaats van een knop. Geen fout in deze test (afmelden met één klik
# vanuit het mailprogramma werkt wel), wel een waarschuwing tot het is opgelost.
unsub_type="$(curl -s -o "$body" -w '%{content_type}' --max-time 60 "$base/email-unsubscribe?token=rooktest" || true)"
if grep -qi '<html\|<!doctype' "$body" && ! printf '%s' "$unsub_type" | grep -qi 'text/html'; then
  echo "LET OP afmeldpagina komt aan als ${unsub_type:-onbekend}, niet als HTML: de ontvanger ziet code (O4)"
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then echo "::warning title=Rooktest::De afmeldpagina komt aan als ${unsub_type:-onbekend} in plaats van text/html (open punt O4)"; fi
else
  echo "info   afmeldpagina: ${unsub_type:-geen Content-Type}"
fi

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

  # Klantadressen: de nachtelijke ronde met het secret uit de taak.
  domains_secret="$(PGPASSWORD="$SUPABASE_DB_PASSWORD" PGSSLMODE="${PGSSLMODE:-require}" PGCONNECT_TIMEOUT=20 \
    psql "$pooler" -X -q -t -A -v ON_ERROR_STOP=1 <<'SQL'
select case when to_regclass('cron.job') is null then ''
            else coalesce((select substring(command from 'x-cron-secret'', ''([^'']*)''')
                             from cron.job where jobname = 'client-domains-recheck'), '') end;
SQL
)"
  if [ -n "$domains_secret" ]; then
    mask "$domains_secret"
    check "client-domains draait de nachtelijke ronde met het secret uit de cron-taak" 200 '"ok":true' \
      -X POST "$base/client-domains?cron=recheck" -H "x-cron-secret: $domains_secret" -H 'Content-Type: application/json' --data '{}'
  else
    echo "-      klantadressen (client-domains): nachtelijke ronde overgeslagen (nog geen cron-taak 'client-domains-recheck')"
  fi

  # Boekhouder-hek (migratie 20261011000000): elke organisatietabel heeft een
  # module gate of het hek. Een nieuwe tabel die het vergeet, valt hier op —
  # anders zou de boekhouder hem gewoon kunnen lezen.
  fence_gaps="$(PGPASSWORD="$SUPABASE_DB_PASSWORD" PGSSLMODE="${PGSSLMODE:-require}" PGCONNECT_TIMEOUT=20 \
    psql "$pooler" -X -q -t -A -v ON_ERROR_STOP=1 <<'SQL'
select case when to_regprocedure('public.accountant_fence_gaps()') is null then '-'
            else coalesce((select string_agg(g, ', ') from public.accountant_fence_gaps() g), '') end;
SQL
)"
  if [ "$fence_gaps" = "-" ]; then
    echo "-      boekhouder-hek: overgeslagen (migratie 20261011000000 nog niet toegepast)"
  elif [ -z "$fence_gaps" ]; then
    echo "ok     boekhouder-hek: elke organisatietabel is afgeschermd"
  else
    problems=$((problems + 1))
    echo "FOUT   boekhouder-hek: geen module gate en geen hek op: $fence_gaps (zie apply_accountant_fence)"
    if [ "${GITHUB_ACTIONS:-}" = "true" ]; then echo "::error title=Rooktest::Boekhouder-hek ontbreekt op: $fence_gaps"; fi
  fi

  # De publieke sleutel (migratie 20261101000000): anon heeft in public geen
  # rechten meer, behalve SELECT op billing_plans, en roept geen functie aan
  # (op die van extensies als pg_trgm na). Een nieuwe tabel of functie die
  # anon toch weer openzet, valt hier op.
  anon_open="$(PGPASSWORD="$SUPABASE_DB_PASSWORD" PGSSLMODE="${PGSSLMODE:-require}" PGCONNECT_TIMEOUT=20 \
    psql "$pooler" -X -q -t -A -v ON_ERROR_STOP=1 <<'SQL'
select case when not exists (select 1 from supabase_migrations.schema_migrations where version = '20261101000000') then '-'
       else coalesce((
         select string_agg(x, ', ') from (
           select distinct 'tabel ' || table_name as x
             from information_schema.role_table_grants
            where grantee = 'anon' and table_schema = 'public'
              and not (table_name = 'billing_plans' and privilege_type = 'SELECT')
           union all
           select 'functie ' || p.oid::regprocedure::text
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
              and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass
                                and d.objid = p.oid and d.deptype = 'e')
         ) open), '') end;
SQL
)"
  if [ "$anon_open" = "-" ]; then
    echo "-      publieke sleutel: overgeslagen (migratie 20261101000000 nog niet toegepast)"
  elif [ -z "$anon_open" ]; then
    echo "ok     publieke sleutel: anon heeft geen rechten in public (alleen de prijsplannen)"
  else
    problems=$((problems + 1))
    echo "FOUT   publieke sleutel: anon heeft weer rechten op: $(echo "$anon_open" | head -c 600)"
    if [ "${GITHUB_ACTIONS:-}" = "true" ]; then echo "::error title=Rooktest::anon heeft weer rechten in public"; fi
  fi

  # Migratie 20261105230000: anon komt het schema public niet meer in. Op
  # supabase/postgres 17.6.1.111 liet elke geweigerde functieaanroep van anon de
  # hele database crashen (supautils); een weigering op het schema niet. Alleen
  # lezen: roep hier nooit een geweigerde functie aan om het te testen.
  anon_schema="$(PGPASSWORD="$SUPABASE_DB_PASSWORD" PGSSLMODE="${PGSSLMODE:-require}" PGCONNECT_TIMEOUT=20 \
    psql "$pooler" -X -q -t -A -v ON_ERROR_STOP=1 <<'SQL'
select case when not exists (select 1 from supabase_migrations.schema_migrations where version = '20261105230000') then '-'
            when has_schema_privilege('anon', 'public', 'usage') then 'open'
            else 'dicht' end;
SQL
)"
  if [ "$anon_schema" = "-" ]; then
    echo "-      schema public voor anon: overgeslagen (migratie 20261105230000 nog niet toegepast)"
  elif [ "$anon_schema" = "dicht" ]; then
    echo "ok     schema public voor anon: geen gebruiksrecht"
  else
    problems=$((problems + 1))
    echo "FOUT   schema public voor anon: anon heeft weer USAGE (een geweigerde functieaanroep kan de database laten crashen)"
    if [ "${GITHUB_ACTIONS:-}" = "true" ]; then echo "::error title=Rooktest::anon heeft weer USAGE op schema public"; fi
  fi

  # De Postgres-versie: 17.6.1.111 crasht bij een geweigerde functieaanroep van
  # een ingelogde gebruiker. Alleen een melding; upgraden doet de eigenaar.
  pg_build="$(PGPASSWORD="$SUPABASE_DB_PASSWORD" PGSSLMODE="${PGSSLMODE:-require}" PGCONNECT_TIMEOUT=20 \
    psql "$pooler" -X -q -t -A -c "select version()" 2>/dev/null | head -1)"
  echo "info   postgres: ${pg_build:-onbekend} (supabase/.temp/postgres-version: $(cat supabase/.temp/postgres-version 2>/dev/null || echo onbekend))"
else
  echo "-      de bezorger met cron-secret: overgeslagen (geen SUPABASE_DB_PASSWORD of psql)"
fi

# Supabase Auth: het klantportaal en de uitnodigingen vertrouwen op het
# e-mailadres van de login. Dat is alleen veilig als niemand zelf een account
# maakt, een adres eerst bevestigd moet zijn, en een adreswijziging op beide
# adressen bevestigd wordt. Die schakelaars staan in het dashboard, niet in de
# repo; hier valt op als iemand er een omzet.
if [ -n "${SUPABASE_ACCESS_TOKEN:-}" ] && command -v python3 >/dev/null; then
  auth_json="$(curl -s --max-time 30 -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    "https://api.supabase.com/v1/projects/${ref}/config/auth" || true)"
  auth_problems="$(printf '%s' "$auth_json" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("Auth-instellingen niet leesbaar"); sys.exit(0)
if not isinstance(d, dict) or "disable_signup" not in d:
    print("Auth-instellingen niet leesbaar"); sys.exit(0)
eis = [
    ("disable_signup", True, "zelf registreren moet uit"),
    ("mailer_autoconfirm", False, "een e-mailadres moet bevestigd worden"),
    ("mailer_secure_email_change_enabled", True, "een adreswijziging moet op beide adressen bevestigd worden"),
    ("external_anonymous_users_enabled", False, "anonieme accounts moeten uit"),
]
fout = [uitleg for sleutel, moet, uitleg in eis if d.get(sleutel) is not moet]
if (d.get("password_min_length") or 0) < 12:
    fout.append("wachtwoorden minimaal 12 tekens")
print("; ".join(fout))
')"
  if [ -z "$auth_problems" ]; then
    echo "ok     Auth-instellingen: geen zelfregistratie, adressen bevestigd, sterke wachtwoorden"
  else
    problems=$((problems + 1))
    echo "FOUT   Auth-instellingen: $auth_problems"
    if [ "${GITHUB_ACTIONS:-}" = "true" ]; then echo "::error title=Rooktest::Auth-instellingen: $auth_problems"; fi
  fi
else
  echo "-      Auth-instellingen: overgeslagen (geen SUPABASE_ACCESS_TOKEN of python3)"
fi

# Secrets die de functies nodig hebben. Alleen de namen: geen waarde komt in
# beeld. Op staging ontbrak MOLLIE_TOKEN_ENCRYPTION_KEY (gezien op 6 november
# 2026): niemand kon zijn eigen Mollie-account koppelen, en geen controle zag het.
if [ -n "${SUPABASE_ACCESS_TOKEN:-}" ] && command -v python3 >/dev/null; then
  secrets_json="$(curl -s --max-time 30 -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    "https://api.supabase.com/v1/projects/${ref}/secrets" || true)"
  secret_problems="$(printf '%s' "$secrets_json" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("de lijst met secrets is niet te lezen"); sys.exit(0)
names = {item.get("name") for item in d if isinstance(item, dict)} if isinstance(d, list) else set()
if "SUPABASE_SERVICE_ROLE_KEY" not in names:
    print("de lijst met secrets is niet te lezen"); sys.exit(0)
eis = [
    (["MOLLIE_TOKEN_ENCRYPTION_KEY"], "MOLLIE_TOKEN_ENCRYPTION_KEY (zonder kan niemand Mollie koppelen; zet hem met scripts/supabase-setup-webhooks.sh)"),
    (["INVOICE_MOLLIE_WEBHOOK_SECRET", "MOLLIE_WEBHOOK_SECRET"], "INVOICE_MOLLIE_WEBHOOK_SECRET (zonder weigert de Mollie-webhook elke betaling)"),
]
print("; ".join(uitleg for opties, uitleg in eis if not any(o in names for o in opties)))
')"
  if [ -z "$secret_problems" ]; then
    echo "ok     secrets: de sleutel voor de Mollie-keys en het secret van de Mollie-webhook staan er"
  else
    problems=$((problems + 1))
    echo "FOUT   secrets: $secret_problems"
    if [ "${GITHUB_ACTIONS:-}" = "true" ]; then echo "::error title=Rooktest::Secrets: $secret_problems"; fi
  fi
else
  echo "-      secrets: overgeslagen (geen SUPABASE_ACCESS_TOKEN of python3)"
fi

if [ "$problems" -gt 0 ]; then
  echo "$problems controle(s) mislukt. Kijk in Supabase onder Edge Functions → Logs." >&2
  exit 1
fi
echo "Rooktest geslaagd op ${ref}."
