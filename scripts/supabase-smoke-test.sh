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
#   - een klantadres (het oudste actieve webadres, zoals jansen.resofly.com):
#     de Worker toont er een album, en gallery-public neemt dat adres aan als
#     herkomst, ook in CORS. Alleen met SUPABASE_DB_PASSWORD (om een adres te
#     vinden). Daarna pas zet de deploy CLIENT_DOMAINS_LIVE;
#   - het boekhouder-hek: geen organisatietabel zonder module gate én zonder hek
#     (public.accountant_fence_gaps() is leeg). Ook alleen met SUPABASE_DB_PASSWORD.
#   - de secrets voor Mollie: MOLLIE_TOKEN_ENCRYPTION_KEY (de eigen Mollie-key
#     van organisaties) en het webhook-secret. Alleen de namen, via de
#     Management API; alleen met SUPABASE_ACCESS_TOKEN.
#   - de API-laag (controle van 10 november): het OpenAPI-document, mcp en
#     mcp-oauth zonder bewijs, mail-inbound zonder geheim, en de afmeldlink
#     uit een campagne (een browser gaat door naar /afmelden in de app).
#   - het eigen adres van de AI-koppeling (workers/mcp; op staging
#     mcp-staging.resofly.com): als
#     MCP_RESOURCE_URL daarop staat, de weg die een AI-client er aflegt, met
#     adressen die letterlijk overeenkomen. Anders overgeslagen.
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

# Het eigen adres van de AI-koppeling (workers/mcp; op staging sinds 11 november
# https://mcp-staging.resofly.com/mcp, op productie straks
# https://mcp.resofly.com/mcp). Welk adres dat is, zegt de MCP-server zelf: de
# `resource` in zijn resource-document (MCP_RESOURCE_URL). Staat dat op een
# eigen domein, dan loopt een AI-client hier dezelfde weg als hieronder: de 401,
# het resource-document, de metadata van de autorisatieserver, /authorize en
# /register. De adressen moeten letterlijk kloppen; één teken verschil en Claude
# weigert te koppelen. Zo valt ook op als iemand MCP_RESOURCE_URL op een domein
# zet waar de Worker (nog) niet staat: dan koppelt niemand meer.
if command -v python3 >/dev/null; then
  # json_get <bestand> <python-expressie op d>: één waarde uit een JSON-antwoord, of leeg.
  json_get() { python3 -c 'import json,sys
try:
    d = json.load(open(sys.argv[1])); v = eval(sys.argv[2], {}, {"d": d}); print("" if v is None else v)
except Exception:
    print("")' "$1" "$2"; }
  # split_url <url>: "<origin> <pad>", het pad zonder slash aan het eind.
  split_url() { python3 -c 'import sys,urllib.parse as u
p = u.urlsplit(sys.argv[1]); print(f"{p.scheme}://{p.netloc}", p.path.rstrip("/"))' "$1"; }
  mcp_fail() {
    problems=$((problems + 1))
    echo "FOUT   $1"
    if [ "${GITHUB_ACTIONS:-}" = "true" ]; then echo "::error title=Rooktest::$1"; fi
  }

  curl -s -o "$body" --max-time 60 "$base/mcp/.well-known/oauth-protected-resource" || true
  mcp_url="$(json_get "$body" 'd["resource"]')"
  if [ -z "$mcp_url" ]; then
    mcp_fail "het resource-document van mcp is niet leesbaar: $(head -c 200 "$body")"
  elif [ "$mcp_url" = "$base/mcp" ]; then
    echo "-      eigen adres van de AI-koppeling: overgeslagen (MCP_RESOURCE_URL staat niet ingesteld)"
  else
    echo "info   eigen adres van de AI-koppeling: $mcp_url"
    read -r mcp_origin mcp_path < <(split_url "$mcp_url")
    headers_file="$(mktemp)"
    got="$(curl -s -D "$headers_file" -o "$body" -w '%{http_code}' --max-time 60 -X POST "$mcp_url" \
      -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' || echo 000)"
    wanted_meta="resource_metadata=\"$mcp_url/.well-known/oauth-protected-resource\""
    if [ "$got" = "401" ] && grep -qF '"unauthorized"' "$body" && grep -qiF "$wanted_meta" "$headers_file"; then
      echo "ok     het eigen adres weigert zonder token en wijst naar zijn resource-document (401)"
    else
      mcp_fail "het eigen adres $mcp_url: verwacht 401 met $wanted_meta, kreeg $got: $(head -c 200 "$body")"
    fi
    rm -f "$headers_file"

    issuer=""
    for doc in "$mcp_url/.well-known/oauth-protected-resource" "$mcp_origin/.well-known/oauth-protected-resource$mcp_path"; do
      got="$(curl -s -o "$body" -w '%{http_code}' --max-time 60 "$doc" || echo 000)"
      seen="$(json_get "$body" 'd["resource"]')"
      if [ "$got" = "200" ] && [ "$seen" = "$mcp_url" ]; then
        echo "ok     resource-document op $doc noemt precies dit adres"
        issuer="$(json_get "$body" 'd["authorization_servers"][0]')"
      else
        mcp_fail "resource-document op $doc: verwacht 200 met resource $mcp_url, kreeg $got met \"$seen\""
      fi
    done

    if [ -n "$issuer" ]; then
      read -r issuer_origin issuer_path < <(split_url "$issuer")
      as_doc="$issuer_origin/.well-known/oauth-authorization-server$issuer_path"
      got="$(curl -s -o "$body" -w '%{http_code}' --max-time 60 "$as_doc" || echo 000)"
      seen="$(json_get "$body" 'd["issuer"]')"
      token_endpoint="$(json_get "$body" 'd["token_endpoint"]')"
      if [ "$got" = "200" ] && [ "$seen" = "$issuer" ] && [ "$token_endpoint" = "$issuer/token" ] \
        && grep -qF '"code_challenge_methods_supported":["S256"]' "$body"; then
        echo "ok     metadata van de autorisatieserver op $as_doc (issuer $issuer)"
      else
        mcp_fail "metadata op $as_doc: verwacht 200 met issuer $issuer, kreeg $got met \"$seen\""
      fi
      check "het eigen adres stuurt een onbekende client nergens heen" 400 'Onbekende AI-client' \
        "$issuer/authorize?client_id=rooktest&redirect_uri=https%3A%2F%2Frooktest.invalid%2Fcb&response_type=code"
      # Een registratie zonder terugkeeradres: de inhoud komt aan, er komt geen
      # client bij. Telt wel één poging voor de rem (zie senderAddress).
      check "het eigen adres neemt een registratie in ontvangst" 400 'redirect_uri' \
        -X POST "$issuer/register" -H 'Content-Type: application/json' --data '{}'
    fi
  fi
else
  echo "-      eigen adres van de AI-koppeling: overgeslagen (geen python3)"
fi
# De afmeldlink uit een campagnemail. Supabase serveert een GET met text/html op
# *.supabase.co als platte tekst: de ontvanger zag code in plaats van een knop
# (bevinding 19 van die controle). Een browser hoort daarom door te gaan naar
# /afmelden in de app.
unsub="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 60 -H 'Accept: text/html' "$base/email-unsubscribe?token=rooktest" || true)"
case "$unsub" in
  "303 "*"/afmelden?token=rooktest")
    echo "ok     email-unsubscribe stuurt een browser naar de afmeldpagina van de app (303)" ;;
  *)
    problems=$((problems + 1))
    echo "FOUT   email-unsubscribe stuurt een browser niet naar /afmelden in de app: ${unsub:-geen antwoord} (staat APP_PUBLIC_URL er?)"
    if [ "${GITHUB_ACTIONS:-}" = "true" ]; then echo "::error title=Rooktest::email-unsubscribe stuurt een browser niet naar /afmelden in de app"; fi ;;
esac

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

  # Klantadressen: een album op het adres van een organisatie
  # (jansen.resofly.com). De Worker (workers/client-domains) toont daar de app,
  # met de meta die zegt dat het een klantadres is, en gallery-public neemt dat
  # adres aan als herkomst, ook in CORS: precies de weg van een deellink uit
  # Galerij → Delen. De deploy zet de deellinks van albums pas op het klantadres
  # (CLIENT_DOMAINS_LIVE, stap "Klantadressen") als deze rooktest slaagt.
  client_name="$(PGPASSWORD="$SUPABASE_DB_PASSWORD" PGSSLMODE="${PGSSLMODE:-require}" PGCONNECT_TIMEOUT=20 \
    psql "$pooler" -X -q -t -A -v ON_ERROR_STOP=1 <<'SQL'
select case when to_regclass('public.client_subdomains') is null then ''
            else coalesce((select name from public.client_subdomains where status = 'active'
                            order by created_at, name limit 1), '') end;
SQL
)"
  if [ -n "$client_name" ]; then
    client_host="${client_name}.${CLIENT_DOMAIN_BASE:-resofly.com}"
    echo "info   klantadres voor de controle: $client_host"
    # Een link die niet bestaat: zo verandert de controle niets, en ziet hij
    # niets van een echt album.
    probe="rooktest-$(date +%s)-${RANDOM}${RANDOM}${RANDOM}"
    check "het klantadres toont een album via de Worker" 200 'name="resofly-client-host"' \
      "https://$client_host/gallerij/$probe"
    # Zonder klantadres als herkomst zou het antwoord "bestaat niet (meer)" of
    # "origin niet toegestaan" zijn; "Ongeldige galerijlink" komt alleen uit de
    # tak voor een klantadres (een link van een andere organisatie, of geen).
    check "gallery-public neemt het klantadres aan als herkomst (onbekende link: 404)" 404 'Ongeldige galerijlink' \
      -X POST "$base/gallery-public" -H "Origin: https://$client_host" -H 'Content-Type: application/json' \
      --data "{\"action\":\"getGallery\",\"token\":\"$probe\"}"
    allowed_origin="$(curl -s -o /dev/null -D - --max-time 60 -X OPTIONS "$base/gallery-public" \
      -H "Origin: https://$client_host" -H 'Access-Control-Request-Method: POST' \
      -H 'Access-Control-Request-Headers: authorization, apikey, content-type, x-client-info' \
      | tr -d '\r' | awk 'tolower($1) == "access-control-allow-origin:" { print $2; exit }' || true)"
    if [ "$allowed_origin" = "https://$client_host" ]; then
      echo "ok     gallery-public laat een browser op het klantadres toe (CORS)"
    else
      problems=$((problems + 1))
      echo "FOUT   gallery-public laat een browser op $client_host niet toe: Access-Control-Allow-Origin ${allowed_origin:-ontbreekt}"
      if [ "${GITHUB_ACTIONS:-}" = "true" ]; then echo "::error title=Rooktest::gallery-public laat het klantadres niet toe (CORS)"; fi
    fi
  else
    echo "-      klantadres: overgeslagen (nog geen organisatie met een webadres)"
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
