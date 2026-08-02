// ============================================================
// Contracten in Word-modus (Collabora) — gedeeld tussen contract-workflow
// (ingelogd) en contract-public (ondertekenpagina).
//
// Een office-contract heeft geen HTML-body: de inhoud is een .docx op R2. De PDF
// komt daarom niet uit de pdf-lib-opbouw maar uit Collabora's convert-to, via de
// media-api Worker (die als enige de R2-binding én de service binding naar de
// office-server heeft).
//
// Belangrijk: die conversie gebeurt ÉÉN keer, bij het versturen. De resulterende
// PDF wordt opgeslagen en vastgelegd op de contractversie, en is daarna de bron
// voor de e-mailbijlage, de ondertekenpagina én het getekende exemplaar. Zo is
// aantoonbaar hetzelfde document verstuurd, getoond en getekend — een herhaalde
// conversie zou dat niet garanderen (fonts, versies, hyphenation).
// ============================================================

const MEDIA_WORKER_URL = (
  Deno.env.get('CONTRACT_PDF_STORAGE_WORKER_URL') ||
  Deno.env.get('INVOICE_PDF_STORAGE_WORKER_URL') ||
  ''
).replace(/\/$/, '');
const MEDIA_WORKER_SECRET =
  Deno.env.get('CONTRACT_PDF_STORAGE_SECRET') || Deno.env.get('INVOICE_PDF_STORAGE_SECRET') || '';

export type OfficeContractFields = {
  editor_mode?: string | null;
  body_storage_key?: string | null;
};

/** Is dit contract in Word (Collabora) opgesteld in plaats van in de rich-text-editor? */
export function isOfficeContract(contract: OfficeContractFields): boolean {
  return contract.editor_mode === 'office' && Boolean(contract.body_storage_key);
}

export class OfficeContractError extends Error {}

function requireMediaWorker(): { url: string; secret: string } {
  if (!MEDIA_WORKER_URL || !MEDIA_WORKER_SECRET) {
    throw new OfficeContractError(
      'De koppeling met de documentopslag ontbreekt (CONTRACT_PDF_STORAGE_WORKER_URL/-SECRET). ' +
      'Word-contracten kunnen daardoor niet naar PDF worden omgezet.',
    );
  }
  return { url: MEDIA_WORKER_URL, secret: MEDIA_WORKER_SECRET };
}

/** Zet het .docx van een contract om naar PDF (Collabora, server-side). */
export async function convertContractDocxToPdf(organizationId: string, storageKey: string): Promise<Uint8Array> {
  const { url, secret } = requireMediaWorker();
  const response = await fetch(`${url}/internal/office/convert-pdf`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ organizationId, storageKey }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    console.error('convert-pdf mislukt', { status: response.status, detail: detail.slice(0, 300) });
    throw new OfficeContractError(
      'Het Word-document kon niet naar PDF worden omgezet. Probeer het zo nog eens — ' +
      'de documentserver start mogelijk nog op.',
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** Leg een contract-PDF onveranderlijk vast op R2. Geeft de opslagsleutel terug. */
export async function storeContractPdf(
  organizationId: string,
  contractId: string,
  bytes: Uint8Array,
  sha256: string,
  label: string,
): Promise<string> {
  const { url, secret } = requireMediaWorker();
  const key = `${organizationId}/contract-pdfs/${contractId}/${crypto.randomUUID()}-${label}.pdf`;
  const response = await fetch(`${url}/internal/contract-snapshot`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/pdf',
      'X-Storage-Key': key,
      'X-SHA256': sha256,
      'X-Size-Bytes': String(bytes.byteLength),
    },
    body: bytes as unknown as BodyInit,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    console.error('contract-PDF opslaan mislukt', { status: response.status, detail: detail.slice(0, 300), key });
    throw new OfficeContractError('De contract-PDF kon niet worden opgeslagen.');
  }
  return key;
}

/** Haal een eerder vastgelegde contract-PDF terug op. */
export async function fetchStoredContractPdf(storageKey: string): Promise<Uint8Array> {
  const { url, secret } = requireMediaWorker();
  const response = await fetch(`${url}/internal/contract-snapshot/${encodeURIComponent(storageKey)}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    console.error('contract-PDF ophalen mislukt', { status: response.status, detail: detail.slice(0, 300), storageKey });
    throw new OfficeContractError('De contract-PDF kon niet uit de opslag worden opgehaald.');
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * De PDF zoals die bij het versturen is vastgelegd — de laatste contractversie
 * met een pdf_storage_key. Dat is exact het document dat de klant per e-mail
 * kreeg, en dus ook wat de ondertekenpagina moet tonen.
 */
export async function loadSentContractPdf(
  // deno-lint-ignore no-explicit-any
  supabaseAdmin: any,
  organizationId: string,
  contractId: string,
): Promise<{ bytes: Uint8Array; storageKey: string; sha256: string | null } | null> {
  const { data, error } = await supabaseAdmin
    .from('contract_versions')
    .select('pdf_storage_key,pdf_sha256')
    .eq('organization_id', organizationId)
    .eq('contract_id', contractId)
    .not('pdf_storage_key', 'is', null)
    .order('version_number', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const storageKey = (data?.pdf_storage_key as string | undefined) || '';
  if (!storageKey) return null;
  return {
    bytes: await fetchStoredContractPdf(storageKey),
    storageKey,
    sha256: (data?.pdf_sha256 as string | undefined) ?? null,
  };
}

/**
 * Namen van álle projecten die aan dit contract hangen, voor {{projectnaam}}.
 *
 * Sinds contract_projects (20260803000000) kunnen dat er meerdere zijn. We geven
 * ze op zijn Nederlands terug ("A, B en C") in plaats van willekeurig één — die
 * oude `.limit(1)` koos stilzwijgend het oudste project, wat in een getekend
 * contract de verkeerde projectnaam kon vastleggen.
 */
export async function loadLinkedProjectNames(
  // deno-lint-ignore no-explicit-any
  supabaseAdmin: any,
  organizationId: string,
  contractId: string,
): Promise<string | null> {
  // Bewust twee losse queries in plaats van een PostgREST-embed: de embed hangt
  // af van relatiedetectie op een tabel met drie foreign keys, en dit draait in
  // de ondertekenflow — een stilzwijgend lege {{projectnaam}} zou in een getekend
  // contract terechtkomen en is dan niet meer te corrigeren.
  const { data: links, error: linkError } = await supabaseAdmin
    .from('contract_projects')
    .select('project_id')
    .eq('organization_id', organizationId)
    .eq('contract_id', contractId)
    .order('created_at', { ascending: true });
  if (linkError) {
    console.warn('projectkoppelingen ophalen mislukt', linkError.message);
    return null;
  }
  const projectIds = ((links ?? []) as Array<{ project_id: string }>).map((row) => row.project_id);
  if (projectIds.length === 0) return null;

  const { data: projects, error: projectError } = await supabaseAdmin
    .from('projects')
    .select('id,name')
    .eq('organization_id', organizationId)
    .in('id', projectIds);
  if (projectError) {
    console.warn('projectnamen ophalen mislukt', projectError.message);
    return null;
  }
  // Volgorde van de koppelingen aanhouden (oudste eerst), niet die van de tweede query.
  const byId = new Map(((projects ?? []) as Array<{ id: string; name: string }>).map((p) => [p.id, p.name]));
  const names = projectIds.map((id) => (byId.get(id) || '').trim()).filter(Boolean);
  return formatNameList(names);
}

/** "A", "A en B", "A, B en C" — leesbaar in een contracttekst. */
export function formatNameList(names: string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} en ${names[names.length - 1]}`;
}
