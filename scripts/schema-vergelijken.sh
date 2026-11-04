#!/usr/bin/env bash
# =============================================================================
# Legt een database die vanaf nul uit de migraties is opgebouwd naast het
# gekoppelde Supabase-project (staging), en zegt of ze verschillen.
#
# Waarom: staging is lang met de hand bijgewerkt in de SQL-editor. Wat daar
# zonder migratie gebeurt, krijgt een nieuwe database (productie) nooit. Deze
# vergelijking vond op 4 november 2026 zo een kapotte invoice_token_hash en de
# jaarprijzen van de abonnementen; zie supabase/migrations/README.md.
#
# Gebruik, vanuit de root van de repo, na `supabase db start` (lokaal, vanaf
# nul) en `supabase link`:
#
#   SUPABASE_DB_PASSWORD='…' bash scripts/schema-vergelijken.sh
#
# Alleen lezen, op beide databases. Nodig: psql.
# =============================================================================
set -euo pipefail

: "${SUPABASE_DB_PASSWORD:?Zet SUPABASE_DB_PASSWORD (het databasewachtwoord van het gekoppelde project)}"
pooler="${SUPABASE_POOLER_URL:-$(cat supabase/.temp/pooler-url)}"
local_url="${LOCAL_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fingerprint() { psql "$1" -X -q -t -A -v ON_ERROR_STOP=1 -f scripts/schema-vingerafdruk.sql | sort; }

fingerprint "$local_url" > "$work/vanaf-nul.txt"
PGPASSWORD="$SUPABASE_DB_PASSWORD" PGSSLMODE="${PGSSLMODE:-require}" \
  fingerprint "$pooler" > "$work/project.txt"

# Bewuste verschillen, die bij het project horen en niet bij het schema:
#  - pg_cron zet je per project aan in het dashboard;
#  - public._migrations is het logboek van de handmatige migratieronde van
#    31 mei 2026 op staging. Geen code gebruikt het.
expected='^extension \| pg_cron \||public\._migrations'
grep -Ev "$expected" "$work/project.txt" > "$work/project-zonder-bekend.txt" || true

if diff -u --label project "$work/project-zonder-bekend.txt" --label vanaf-nul "$work/vanaf-nul.txt"; then
  echo "Gelijk: $(wc -l < "$work/vanaf-nul.txt") regels vingerafdruk."
else
  echo
  echo "Verschillen hierboven: - alleen op het project, + alleen vanaf nul." >&2
  echo "Iets wat alleen op het project staat, hoort in een nieuwe migratie." >&2
  exit 1
fi
