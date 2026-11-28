// ============================================================
// Een .woff-letter terug naar TTF (of OTF), voor de Word-export van pagina's.
//
// De huisstijlletters staan als WOFF in public/fonts/pdf en _shared/pdfFonts.ts:
// pdf-lib sluit die zo in een PDF in. LibreOffice (en dus Collabora) gebruikt
// een WOFF niet, ook niet als hij geïnstalleerd is; een TTF wel, ook als hij in
// de DOCX is ingesloten. Zie docs/rapporten/PROEF_1B1_LETTERS_EMOJI_2026-11-28.md.
//
// WOFF 1 is een TTF met elke tabel apart met zlib ingepakt (W3C, "WOFF File
// Format 1.0"). Terugzetten is: de tabellen uitpakken en weer achter elkaar
// zetten, met de oude kop ervoor. Zonder pakketten: DecompressionStream bestaat
// in Deno, in browsers en in Node.
// ============================================================

const WOFF_SIGNATURE = 0x774f4646; // "wOFF"

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** De som van een tabel in stukken van vier bytes, zoals de tabelrij in een TTF hem kent. */
export function sfntChecksum(data: Uint8Array): number {
  let sum = 0;
  const padded = data.length % 4 === 0 ? data : (() => { const copy = new Uint8Array(data.length + 4 - (data.length % 4)); copy.set(data); return copy; })();
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  for (let i = 0; i < padded.length; i += 4) sum = (sum + view.getUint32(i)) >>> 0;
  return sum;
}

/** Een WOFF 1-bestand als TTF of OTF. Gooit een fout bij iets anders, ook bij WOFF 2. */
export async function woffToSfnt(woff: Uint8Array): Promise<Uint8Array> {
  const view = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
  if (woff.length < 44 || view.getUint32(0) !== WOFF_SIGNATURE) throw new Error('Geen WOFF 1-bestand.');
  const flavor = view.getUint32(4);
  const numTables = view.getUint16(12);
  if (woff.length < 44 + numTables * 20) throw new Error('Het WOFF-bestand is afgebroken.');
  const tables: Array<{ tag: number; checksum: number; data: Uint8Array }> = [];
  for (let i = 0; i < numTables; i += 1) {
    const at = 44 + i * 20;
    const tag = view.getUint32(at);
    const offset = view.getUint32(at + 4);
    const compLength = view.getUint32(at + 8);
    const origLength = view.getUint32(at + 12);
    const checksum = view.getUint32(at + 16);
    if (offset + compLength > woff.length) throw new Error('Het WOFF-bestand is afgebroken.');
    const stored = woff.subarray(offset, offset + compLength);
    // Kleiner dan het origineel: ingepakt. Even groot: zoals hij was.
    const data = compLength < origLength ? await inflate(stored) : stored;
    if (data.length !== origLength) throw new Error('Een tabel in het WOFF-bestand pakt niet goed uit.');
    tables.push({ tag, checksum, data });
  }
  // De kop van een TTF: aantal tabellen, en de zoekhulp die het formaat vraagt.
  const entrySelector = Math.floor(Math.log2(Math.max(1, numTables)));
  const searchRange = 2 ** entrySelector * 16;
  const headerLength = 12 + numTables * 16;
  const total = tables.reduce((sum, table) => sum + Math.ceil(table.data.length / 4) * 4, headerLength);
  const out = new Uint8Array(total);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, flavor);
  outView.setUint16(4, numTables);
  outView.setUint16(6, searchRange);
  outView.setUint16(8, entrySelector);
  outView.setUint16(10, numTables * 16 - searchRange);
  let offset = headerLength;
  tables.forEach((table, i) => {
    const record = 12 + i * 16;
    outView.setUint32(record, table.tag);
    outView.setUint32(record + 4, table.checksum);
    outView.setUint32(record + 8, offset);
    outView.setUint32(record + 12, table.data.length);
    out.set(table.data, offset);
    offset += Math.ceil(table.data.length / 4) * 4;
  });
  return out;
}

/**
 * De naam van de familie uit een TTF of OTF ("DM Sans"), zoals Word en
 * LibreOffice hem zoeken. Een ingesloten letter hoort onder die naam in de
 * DOCX te staan. null als de naam er niet in staat.
 */
export function sfntFamilyName(sfnt: Uint8Array): string | null {
  const view = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  if (sfnt.length < 12) return null;
  const numTables = view.getUint16(4);
  for (let i = 0; i < numTables; i += 1) {
    const record = 12 + i * 16;
    if (record + 16 > sfnt.length) return null;
    if (view.getUint32(record) !== 0x6e616d65) continue; // "name"
    const table = view.getUint32(record + 8);
    const count = view.getUint16(table + 2);
    const strings = table + view.getUint16(table + 4);
    let fallback: string | null = null;
    for (let n = 0; n < count; n += 1) {
      const entry = table + 6 + n * 12;
      const platform = view.getUint16(entry);
      const encoding = view.getUint16(entry + 2);
      const nameId = view.getUint16(entry + 6);
      const length = view.getUint16(entry + 8);
      const start = strings + view.getUint16(entry + 10);
      // 16 is de "typografische" familie (zonder gewicht erin), 1 de gewone.
      if ((nameId !== 1 && nameId !== 16) || start + length > sfnt.length) continue;
      let text: string | null = null;
      if (platform === 3 && (encoding === 1 || encoding === 10)) {
        text = '';
        for (let k = 0; k + 1 < length; k += 2) text += String.fromCharCode(view.getUint16(start + k));
      } else if (platform === 1 && encoding === 0) {
        text = String.fromCharCode(...sfnt.subarray(start, start + length));
      }
      if (!text?.trim()) continue;
      if (nameId === 16) return text.trim();
      fallback ??= text.trim();
    }
    return fallback;
  }
  return null;
}
