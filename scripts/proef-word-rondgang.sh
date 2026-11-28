#!/usr/bin/env bash
# ============================================================
# De Word-export van pagina's door LibreOffice heen (bouwplan pagina's, §9).
#
# LibreOffice is de motor van Collabora: de Word-kopie ("Maak er een
# Word-document van") wordt daar bewerkt en opgeslagen, en de PDF komt er
# straks uit. Een bestand dat wij geldig maken, moet dat dus ook blijven nadat
# LibreOffice het opnieuw heeft opgeslagen. Dat ging bij het voorblad van
# stap 1B-4a mis, en de controle met de hand werd toen verkeerd gelezen.
#
# Per proefbestand (scripts/proef-word-export.mjs):
#   1. tegen de XSD's van ECMA-376 (validate.py);
#   2. opnieuw opgeslagen als .docx door LibreOffice, en weer tegen de XSD's;
#   3. beide als PDF, met het aantal bladzijden en de paginanummers.
# Faalt (exit 1) zodra één controle niet "All validations PASSED!" zegt.
#
# Gebruik:
#   scripts/proef-word-rondgang.sh <uitmap>
#
# Nodig: node 22 of nieuwer, soffice (LibreOffice), pdfinfo en pdftotext
# (poppler), python3, en validate.py met de XSD's. Dat laatste staat in een
# cloudsessie van Claude Code in /mnt/skills/public/docx/scripts/office;
# elders: DOCX_VALIDATE=/pad/naar/validate.py.
# ============================================================
set -euo pipefail

uit="${1:?Gebruik: scripts/proef-word-rondgang.sh <uitmap>}"
validate="${DOCX_VALIDATE:-/mnt/skills/public/docx/scripts/office/validate.py}"
if [ ! -f "$validate" ]; then
  echo "validate.py niet gevonden ($validate). Zet DOCX_VALIDATE naar de XSD-controle van ECMA-376." >&2
  exit 2
fi
for nodig in node soffice pdfinfo pdftotext python3; do
  command -v "$nodig" >/dev/null || { echo "$nodig ontbreekt" >&2; exit 2; }
done

hier="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$uit"
uit="$(cd "$uit" && pwd)"
# Een eigen profiel: een open LibreOffice van de gebruiker houdt het anders vast.
profiel="file://$uit/.lo-profiel"

(cd "$hier" && node --experimental-strip-types --no-warnings scripts/proef-word-export.mjs "$uit") >/dev/null

geldig() {
  # validate.py zegt "All validations PASSED!" als alles klopt; anders de fouten.
  local uitvoer
  uitvoer="$(python3 "$validate" "$1" 2>&1 || true)"
  if grep -q "All validations PASSED!" <<<"$uitvoer"; then
    echo "geldig"
  else
    echo "ONGELDIG"
    grep -E "error|Element|FAILED" <<<"$uitvoer" | head -5 | sed 's/^/      /' >&2
  fi
}

fout=0
mkdir -p "$uit/opnieuw" "$uit/pdf"
for bestand in "$uit"/*.docx; do
  naam="$(basename "$bestand" .docx)"
  soffice "-env:UserInstallation=$profiel" --headless --convert-to 'docx:MS Word 2007 XML' --outdir "$uit/opnieuw" "$bestand" >/dev/null 2>&1
  soffice "-env:UserInstallation=$profiel" --headless --convert-to pdf --outdir "$uit/pdf" "$bestand" >/dev/null 2>&1
  soffice "-env:UserInstallation=$profiel" --headless --convert-to pdf --outdir "$uit/opnieuw" "$uit/opnieuw/$naam.docx" >/dev/null 2>&1
  eigen="$(geldig "$bestand")"
  later="$(geldig "$uit/opnieuw/$naam.docx")"
  bladen="$(pdfinfo "$uit/pdf/$naam.pdf" | awk '/^Pages/ {print $2}')"
  bladenLater="$(pdfinfo "$uit/opnieuw/$naam.pdf" | awk '/^Pages/ {print $2}')"
  nummers="$(pdftotext -layout "$uit/opnieuw/$naam.pdf" - | grep -o 'Pagina [0-9]* van [0-9]*' | tr '\n' ',' | sed 's/,$//')"
  echo "$naam: eigen bestand $eigen; na opnieuw opslaan $later; $bladen bladen (daarna $bladenLater); ${nummers:-geen paginanummers}"
  if [ "$eigen" != "geldig" ] || [ "$later" != "geldig" ] || [ "$bladen" != "$bladenLater" ]; then
    fout=1
  fi
done
exit "$fout"
