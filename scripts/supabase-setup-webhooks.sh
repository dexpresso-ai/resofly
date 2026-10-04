#!/usr/bin/env bash
# =============================================================================
# Eenmalig: de webhooks van de openbare API inrichten op een Supabase-project.
# Precies stap 7 van SUPABASE_STAGING_LAPTOP.md, maar zonder knippen en plakken.
#
#   1. WEBHOOK_SECRET_ENCRYPTION_KEY: alleen als hij er nog niet staat. Nooit
#      vervangen, want een nieuwe sleutel maakt de geheimen van bestaande
#      webhooks onleesbaar.
#   2. De bezorger: staat de pg_cron-taak 'webhooks-dispatch' er nog niet, dan
#      een nieuw WEBHOOK_CRON_SECRET en de taak met precies die waarde. Staat
#      hij er al, dan blijven taak en secret zoals ze zijn.
#   3. De dagelijkse opruimtaak 'resofly-api-purge', als die ontbreekt.
#
# Veilig om opnieuw te draaien: het zet alleen wat ontbreekt, en geen enkele
# waarde komt in beeld. Draait in de workflow "Deploy Supabase (staging)"
# (vinkje setup_webhooks), maar kan ook vanaf een laptop, na `supabase login`
# en `supabase link`:
#
#   SUPABASE_PROJECT_ID=enzghpduqwaojcxgwarr SUPABASE_DB_PASSWORD='…' \
#     bash scripts/supabase-setup-webhooks.sh
#
# Pas draaien NA `supabase db push` en `supabase functions deploy`: de taken
# roepen functies aan die daarmee komen. Nodig: de supabase-CLI, psql, openssl.
# =============================================================================
set -euo pipefail

ref="${SUPABASE_PROJECT_ID:?Zet SUPABASE_PROJECT_ID (de project-ref)}"
: "${SUPABASE_DB_PASSWORD:?Zet SUPABASE_DB_PASSWORD (het databasewachtwoord)}"
supabase_cli="${SUPABASE_BIN:-supabase}"
# Dezelfde verbinding als de CLI: de pooler die `supabase link` hier neerzet.
pooler="${SUPABASE_POOLER_URL:-$(cat supabase/.temp/pooler-url)}"

export PGPASSWORD="$SUPABASE_DB_PASSWORD"
export PGSSLMODE="${PGSSLMODE:-require}"
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-20}"

sql() { psql "$pooler" -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }

# Een nieuwe willekeurige waarde. In GitHub Actions wordt hij meteen
# gemaskeerd, zodat hij ook bij een fout nergens in het log belandt.
generate() { openssl rand -base64 32 | tr -d '\n'; }
mask() { if [ "${GITHUB_ACTIONS:-}" = "true" ]; then echo "::add-mask::$1"; fi; }

fail() {
  echo "$1" >&2
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then echo "::error title=Webhooks inrichten::$1"; fi
  exit 1
}

# ── Eerst kijken, dan pas iets veranderen ──────────────────────────────────
missing="$(sql <<'SQL'
select concat_ws(', ',
  case when not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                         where n.nspname = 'cron' and p.proname = 'schedule') then 'pg_cron' end,
  case when not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                         where n.nspname = 'net' and p.proname = 'http_post') then 'pg_net' end);
SQL
)"
if [ -n "$missing" ]; then
  fail "Zet eerst deze extensie(s) aan in het Supabase-dashboard (Database → Extensions): $missing. Daarna dit opnieuw draaien."
fi
if [ "$(sql -c "select to_regprocedure('public.webhook_purge_expired()') is not null")" != "t" ]; then
  fail "De migraties van de openbare API staan nog niet op deze database. Eerst supabase db push."
fi

listed="$("$supabase_cli" secrets list --project-ref "$ref")"
has_secret() { grep -qE "(^|[^A-Za-z0-9_])$1([^A-Za-z0-9_]|\$)" <<<"$listed"; }

# ── 1. De sleutel voor de ondertekengeheimen ───────────────────────────────
if has_secret WEBHOOK_SECRET_ENCRYPTION_KEY; then
  echo "WEBHOOK_SECRET_ENCRYPTION_KEY staat er al; die blijft zoals hij is."
else
  key="$(generate)"; mask "$key"
  "$supabase_cli" secrets set --project-ref "$ref" "WEBHOOK_SECRET_ENCRYPTION_KEY=$key" >/dev/null
  echo "WEBHOOK_SECRET_ENCRYPTION_KEY gezet."
fi

# ── 2. De bezorger, elke minuut ────────────────────────────────────────────
if [ "$(sql -c "select count(*) from cron.job where jobname = 'webhooks-dispatch'")" != "0" ]; then
  echo "De bezorger 'webhooks-dispatch' staat al ingepland; taak en WEBHOOK_CRON_SECRET blijven zoals ze zijn."
else
  # Eerst het secret, dan de taak: mislukt de taak, dan maakt een volgende
  # run allebei opnieuw, en passen ze weer bij elkaar.
  cron_secret="$(generate)"; mask "$cron_secret"
  "$supabase_cli" secrets set --project-ref "$ref" "WEBHOOK_CRON_SECRET=$cron_secret" >/dev/null
  sql -v secret="$cron_secret" -v url="https://${ref}.functions.supabase.co/webhooks?cron=dispatch" >/dev/null <<'SQL'
select cron.schedule(
  'webhooks-dispatch',
  '* * * * *',
  format(
    'select net.http_post(url := %L, headers := jsonb_build_object(''Content-Type'', ''application/json'', ''x-cron-secret'', %L), body := ''{}''::jsonb, timeout_milliseconds := 90000);',
    :'url', :'secret'));
SQL
  echo "WEBHOOK_CRON_SECRET gezet en de bezorger 'webhooks-dispatch' ingepland (elke minuut)."
fi

# ── 3. Opruimen, dagelijks ─────────────────────────────────────────────────
if [ "$(sql -c "select count(*) from cron.job where jobname = 'resofly-api-purge'")" != "0" ]; then
  echo "De opruimtaak 'resofly-api-purge' staat er al."
else
  sql -c "select cron.schedule('resofly-api-purge', '17 3 * * *', 'select public.api_purge_expired(); select public.webhook_purge_expired();')" >/dev/null
  echo "De opruimtaak 'resofly-api-purge' ingepland (dagelijks om 03:17 UTC)."
fi

echo "Klaar: de webhooks zijn ingericht op ${ref}."
