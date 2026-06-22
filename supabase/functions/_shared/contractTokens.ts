// ============================================================
// Gedeelde variabelen/placeholders voor contracten ({{token}}).
//
// De body mag tokens bevatten; die worden server-side ingevuld op het moment van
// renderen (publieke pagina, PDF) en bij het bevriezen van een verstuurde versie,
// zodat de klant en het getekende exemplaar altijd concrete waarden zien.
//
// BELANGRIJK: houd de tokenset gelijk aan de frontend-catalogus
// (src/lib/contractTokens.ts), die de chips in de editor levert.
// ============================================================

export type ContractTokenInput = {
  contract: { number: string; date: string | null; amount_cents?: number | null; currency?: string | null };
  client?: { name?: string | null; contact_name?: string | null } | null;
  company?: {
    company_name?: string | null;
    trade_name?: string | null;
    address_line1?: string | null;
    address_line2?: string | null;
    postal_code?: string | null;
    city?: string | null;
    country?: string | null;
  } | null;
  projectName?: string | null;
};

export function buildContractTokens(input: ContractTokenInput): Record<string, string> {
  const c = input.company;
  const address = [
    c?.address_line1,
    c?.address_line2,
    [c?.postal_code, c?.city].filter(Boolean).join(' '),
    c?.country,
  ].map((v) => (v ?? '').trim()).filter(Boolean).join(', ');

  return {
    klantnaam: input.client?.name ?? '',
    contactpersoon: input.client?.contact_name ?? '',
    contractnummer: input.contract.number ?? '',
    datum: formatDateNl(input.contract.date),
    bedrag: formatAmount(input.contract.amount_cents, input.contract.currency),
    projectnaam: input.projectName ?? '',
    bedrijfsnaam: c?.trade_name || c?.company_name || '',
    bedrijfsadres: address,
  };
}

// Vervangt {{token}} door de (HTML-veilige) waarde. Onbekende tokens worden
// weggelaten, zodat een typefout nooit als "{{foo}}" bij de klant belandt.
export function fillContractTokens(html: string | null | undefined, tokens: Record<string, string>): string {
  return String(html ?? '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) =>
    escapeHtml(tokens[key] ?? ''),
  );
}

function formatAmount(amountCents: number | null | undefined, currency: string | null | undefined): string {
  if (amountCents === null || amountCents === undefined || !Number.isFinite(Number(amountCents))) return '';
  try {
    return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: currency || 'EUR' }).format(Number(amountCents) / 100);
  } catch {
    return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(Number(amountCents) / 100);
  }
}

function formatDateNl(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('nl-NL');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
