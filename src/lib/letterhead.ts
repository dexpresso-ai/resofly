/**
 * Het eigen briefpapier (company_settings.invoice_template_data_url) zit niet
 * in de kern van de werkruimte.
 *
 * Waarom: het is een data-URL tot honderden KB's, en de kern laadt bij elke
 * start en na elke wijziging. Alleen een PDF heeft het nodig. Sinds november
 * 2026 laadt de kern de bedrijfsinstellingen via de RPC company_settings_core
 * (migratie 20261120100000), zonder dit ene veld.
 *
 * Daardoor betekent het veld drie dingen:
 *  - undefined: niet geladen. Het kan er zijn; kijk naar invoice_template_kind;
 *  - null: er is geen briefpapier (of het formulier haalde het weg);
 *  - een string: het briefpapier zelf.
 *
 * Twee regels, en dit bestand bewaakt ze (letterhead.test.ts):
 *  1. Een PDF wordt nooit gemaakt met een niet-geladen briefpapier. lib/pdf.ts
 *     haalt het eerst op (withInvoiceLetterhead in repository.ts); lukt dat
 *     niet, dan mislukt de PDF met een melding in plaats van stil zonder
 *     briefpapier.
 *  2. Opslaan zonder geladen briefpapier laat het briefpapier in de database
 *     staan. Anders wiste elke opslag in Instellingen het briefpapier
 *     (upsertCompanySettings, letterheadFieldsForSave).
 */

export interface LetterheadFields<K extends string = string> {
  invoice_template_kind?: K | null;
  invoice_template_file_name?: string | null;
  invoice_template_mime_type?: string | null;
  invoice_template_file_size?: number | null;
  invoice_template_data_url?: string | null;
  invoice_template_updated_at?: string | null;
}

/** De zes kolommen die samen het briefpapier vormen. */
export const LETTERHEAD_COLUMNS = [
  'invoice_template_kind', 'invoice_template_file_name', 'invoice_template_mime_type',
  'invoice_template_file_size', 'invoice_template_data_url', 'invoice_template_updated_at',
] as const;

/** Er is briefpapier, maar het is (nog) niet geladen: eerst ophalen voor een PDF. */
export function letterheadMissing(row: LetterheadFields | null | undefined): boolean {
  if (!row) return false;
  return Boolean(row.invoice_template_kind) && row.invoice_template_kind !== 'none' && row.invoice_template_data_url === undefined;
}

/**
 * De briefpapiervelden zoals het instellingenformulier ze opslaat. Is het
 * briefpapier niet geladen, dan blijven ze zoals ze waren en gaat de data-URL
 * niet mee. upsertCompanySettings laat dan alle zes de kolommen ongemoeid.
 * Anders: geen data-URL betekent geen briefpapier, en dan alles leeg.
 */
export interface LetterheadForSave<K extends string> {
  invoice_template_kind: K | 'none';
  invoice_template_file_name: string | null;
  invoice_template_mime_type: string | null;
  invoice_template_file_size: number;
  /** undefined: niet geladen, en dus niet mee met de opslag. */
  invoice_template_data_url: string | null | undefined;
  invoice_template_updated_at: string | null;
}

export function letterheadFieldsForSave<K extends string>(input: LetterheadFields<K>): LetterheadForSave<K> {
  const clean = (value: string | null | undefined) => {
    const trimmed = String(value ?? '').trim();
    return trimmed || null;
  };
  if (input.invoice_template_data_url === undefined) {
    return {
      invoice_template_kind: input.invoice_template_kind ?? 'none',
      invoice_template_file_name: input.invoice_template_file_name ?? null,
      invoice_template_mime_type: input.invoice_template_mime_type ?? null,
      invoice_template_file_size: Number(input.invoice_template_file_size || 0),
      invoice_template_data_url: undefined,
      invoice_template_updated_at: input.invoice_template_updated_at ?? null,
    };
  }
  const kind: K | 'none' = input.invoice_template_data_url && input.invoice_template_kind && input.invoice_template_kind !== 'none'
    ? input.invoice_template_kind
    : 'none';
  return {
    invoice_template_kind: kind,
    invoice_template_file_name: kind === 'none' ? null : clean(input.invoice_template_file_name),
    invoice_template_mime_type: kind === 'none' ? null : clean(input.invoice_template_mime_type),
    invoice_template_file_size: kind === 'none' ? 0 : Number(input.invoice_template_file_size || 0),
    invoice_template_data_url: kind === 'none' ? null : input.invoice_template_data_url,
    invoice_template_updated_at: kind === 'none' ? null : input.invoice_template_updated_at ?? null,
  };
}

/**
 * Wat upsertCompanySettings mag schrijven. Is de data-URL niet geladen, dan
 * gaan de zes briefpapierkolommen er allemaal uit: de database houdt wat hij
 * had. Zo kan geen enkele opslag (het formulier, een handeling van Gerrie) het
 * briefpapier wissen omdat hij het niet kende.
 */
export function withoutUnloadedLetterhead(row: Record<string, unknown>): Record<string, unknown> {
  if (row.invoice_template_data_url !== undefined) return row;
  const out = { ...row };
  for (const column of LETTERHEAD_COLUMNS) delete out[column];
  return out;
}
