#!/usr/bin/env bash
# Databasetests: elk .sql-bestand in deze map, tegen de lokale database van
# `supabase db start` (alle migraties op een lege database). Elk bestand draait
# in één transactie die wordt teruggedraaid; een mislukte controle stopt psql
# met een foutmelding die met MISLUKT begint.
#
#   npm run test:database
#
# Een andere database (niet staging, niet productie):
#   RESOFLY_TEST_DATABASE_URL=postgresql://… npm run test:database
#
# In CI draait dit in de job migrations van .github/workflows/frontend-checks.yml,
# direct na de keten vanaf nul.
set -euo pipefail
cd "$(dirname "$0")"

URL="${RESOFLY_TEST_DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
command -v psql >/dev/null || { echo "psql ontbreekt: installeer postgresql-client."; exit 1; }

status=0
for bestand in *.sql; do
  echo "── ${bestand}"
  if psql "$URL" -X -q -v ON_ERROR_STOP=1 -f "$bestand"; then
    echo "   geslaagd"
  else
    echo "   MISLUKT"
    status=1
  fi
done
exit $status
