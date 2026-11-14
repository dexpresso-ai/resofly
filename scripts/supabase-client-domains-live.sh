#!/usr/bin/env bash
# =============================================================================
# CLIENT_DOMAINS_LIVE op een Supabase-project zetten: welke links naar het
# klantadres van een organisatie gaan (jansen.resofly.com, of haar eigen
# domein). Zie docs/setup/KLANTDOMEINEN_SETUP.md, stap 5.
#
#   true    alles: offertes, facturen, contracten, albums, het portaal, …
#   albums  alleen de deellinks van albums (Galerij → Delen, en Gerrie); de
#           rest blijft op het adres van de app
#   false   niets: alle links naar het adres van de app
#
# Op staging komt de waarde uit .github/workflows/deploy-staging.yml en draait
# dit na de rooktest. Die controleert dat een klantadres echt antwoordt: de
# Worker toont er een album, en gallery-public neemt het adres aan als
# herkomst. Faalt de rooktest, dan komt deze stap niet aan de beurt en blijft
# de schakelaar zoals hij was. Liever een link naar het adres van de app dan
# een link die nergens heen gaat.
#
# Zet alleen iets als de waarde verandert: Supabase bewaart van elke waarde een
# SHA-256, en die vergelijkt dit script. Het is geen geheim, maar komt evengoed
# alleen als woord in beeld (true, albums of false).
#
#   SUPABASE_PROJECT_ID=enzghpduqwaojcxgwarr SUPABASE_ACCESS_TOKEN=sbp_… \
#     CLIENT_DOMAINS_LIVE=albums bash scripts/supabase-client-domains-live.sh
#
# Nodig: de supabase-CLI, curl en python3.
# =============================================================================
set -euo pipefail

ref="${SUPABASE_PROJECT_ID:?Zet SUPABASE_PROJECT_ID (de project-ref)}"
want="${CLIENT_DOMAINS_LIVE:?Zet CLIENT_DOMAINS_LIVE (true, albums of false)}"
: "${SUPABASE_ACCESS_TOKEN:?Zet SUPABASE_ACCESS_TOKEN (een persoonlijk token, sbp_…)}"
supabase_cli="${SUPABASE_BIN:-supabase}"
# Alleen anders om dit script te testen (tegen een nagebootste Management API).
api="${SUPABASE_API_URL:-https://api.supabase.com}"

fail() {
  echo "$1" >&2
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then echo "::error title=Klantadressen::$1"; fi
  exit 1
}

# Alleen wat de code kent (_shared/clientLinks.ts, parseClientDomainsLive). Een
# tikfout zou daar stil "niets" betekenen, terwijl iemand denkt dat het aan staat.
case "$want" in
  true|albums|false) ;;
  *) fail "CLIENT_DOMAINS_LIVE=\"$want\" kent de code niet. Kies true, albums of false." ;;
esac

# De secrets van het project: alleen namen en digests, nooit een waarde.
secrets_json="$(curl -s --max-time 30 -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "${api}/v1/projects/${ref}/secrets" || true)"
# "<leesbaar> <digest>": of de lijst te lezen is, en de digest van CLIENT_DOMAINS_LIVE (of -).
readable=""
current=""
read -r readable current < <(printf '%s' "$secrets_json" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("nee -"); sys.exit(0)
items = [i for i in d if isinstance(i, dict)] if isinstance(d, list) else []
if not any(i.get("name") == "SUPABASE_SERVICE_ROLE_KEY" for i in items):
    print("nee -"); sys.exit(0)
digest = next((str(i.get("value") or "") for i in items if i.get("name") == "CLIENT_DOMAINS_LIVE"), "")
print("ja", digest.split()[0] if digest.split() else "-")
') || true
if [ "$readable" != "ja" ]; then
  fail "De lijst met secrets van ${ref} is niet te lezen. CLIENT_DOMAINS_LIVE is niet veranderd."
fi

wanted_digest="$(printf '%s' "$want" | python3 -c 'import hashlib, sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())')"
if [ "$current" = "$wanted_digest" ]; then
  echo "CLIENT_DOMAINS_LIVE staat al op \"$want\"; niets veranderd."
  exit 0
fi

"$supabase_cli" secrets set --project-ref "$ref" "CLIENT_DOMAINS_LIVE=$want" >/dev/null
case "$want" in
  true) echo "CLIENT_DOMAINS_LIVE op \"true\" gezet: alle links naar klantpagina's gaan naar het klantadres van de organisatie." ;;
  albums) echo "CLIENT_DOMAINS_LIVE op \"albums\" gezet: de deellinks van albums gaan naar het klantadres, de rest naar het adres van de app." ;;
  false) echo "CLIENT_DOMAINS_LIVE op \"false\" gezet: alle links gaan naar het adres van de app." ;;
esac
