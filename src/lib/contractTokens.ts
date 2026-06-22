// Frontend-catalogus + invuller voor contract-variabelen ({{token}}).
// Spiegelt de server-side module supabase/functions/_shared/contractTokens.ts:
// houd de tokenset en de invul-logica gelijk. Wordt gebruikt voor de live
// HTML-preview in de editor en voor de chips waarmee je tokens invoegt.

export const CONTRACT_TOKENS: Array<{ token: string; label: string }> = [
  { token: 'klantnaam', label: 'Klantnaam' },
  { token: 'contactpersoon', label: 'Contactpersoon' },
  { token: 'contractnummer', label: 'Contractnummer' },
  { token: 'datum', label: 'Datum' },
  { token: 'bedrag', label: 'Bedrag' },
  { token: 'projectnaam', label: 'Projectnaam' },
  { token: 'bedrijfsnaam', label: 'Bedrijfsnaam' },
  { token: 'bedrijfsadres', label: 'Bedrijfsadres' },
];

export type ContractTokenInput = {
  clientName?: string | null;
  contactName?: string | null;
  contractNumber?: string | null;
  date?: string | null;
  amountCents?: number | null;
  currency?: string | null;
  projectName?: string | null;
  companyName?: string | null;
  companyAddress?: string | null;
};

export function buildContractTokens(input: ContractTokenInput): Record<string, string> {
  return {
    klantnaam: input.clientName ?? '',
    contactpersoon: input.contactName ?? '',
    contractnummer: input.contractNumber ?? '',
    datum: formatDateNl(input.date),
    bedrag: formatAmount(input.amountCents, input.currency),
    projectnaam: input.projectName ?? '',
    bedrijfsnaam: input.companyName ?? '',
    bedrijfsadres: input.companyAddress ?? '',
  };
}

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

function formatDateNl(value: string | null | undefined): string {
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
