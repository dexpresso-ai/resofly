/**
 * Een zip maken in de browser, zonder bibliotheek: voor "Alles exporteren"
 * (Instellingen → Gegevens). De media-worker zipt al, maar die draait op
 * Cloudflare en zit niet in de app; en voor één zip per export een pakket van
 * honderden kB in de bundel trekken is zonde.
 *
 * Wat dit kan, en waarom:
 *  - ZIP64 zodra een bestand, de positie of het aantal bestanden boven de
 *    grenzen van het oude formaat komt (4 GiB, 65.535). Een administratie met
 *    jaren aan opnames en bijlagen haalt dat.
 *  - Bestandsnamen in UTF-8 (vlag 11), zodat "Offerte Café.pdf" niet als
 *    "Offerte CafÃ©.pdf" uitpakt in Windows Verkenner.
 *  - Tekst (JSON, CSV, XML) comprimeren met deflate, als de browser dat kan
 *    (CompressionStream 'deflate-raw'). Bestanden zoals PDF en JPEG zijn al
 *    gecomprimeerd en gaan zoals ze zijn.
 *  - Elk onderdeel wordt meteen een Blob. Die mag de browser op schijf zetten,
 *    zodat een grote export niet in één keer in het geheugen hoeft.
 *
 * Puur (Blob, TextEncoder en CompressionStream bestaan in browsers én in
 * Node), zodat `npm test` het kan nalopen.
 */

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (zoals zip en gzip), eventueel verder rekenend op een eerdere waarde. */
export function crc32(data: Uint8Array, previous = 0): number {
  let crc = (previous ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i += 1) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const UINT32_MAX = 0xffffffff;
const UINT16_MAX = 0xffff;

export interface ZipAddOptions {
  /** Comprimeren als dat kleiner uitvalt (voor tekst). Standaard uit. */
  compress?: boolean;
  /** Wijzigingsdatum in de zip. Standaard het moment van maken van de zip. */
  modified?: Date;
  /**
   * Krijgt de inhoud één keer te zien, bijvoorbeeld voor een SHA-256. Zo
   * hoeft een bestand van 150 MB maar één keer uit de Blob gelezen te worden.
   */
  inspect?: (bytes: Uint8Array) => void | Promise<void>;
}

interface CentralRecord {
  name: Uint8Array;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
  method: 0 | 8;
  time: number;
  date: number;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

class Bytes {
  private readonly view: DataView;
  readonly bytes: Uint8Array;
  private pos = 0;
  constructor(size: number) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }
  u16(value: number): this { this.view.setUint16(this.pos, value, true); this.pos += 2; return this; }
  u32(value: number): this { this.view.setUint32(this.pos, value >>> 0, true); this.pos += 4; return this; }
  u64(value: number): this { this.view.setBigUint64(this.pos, BigInt(value), true); this.pos += 8; return this; }
  raw(data: Uint8Array): this { this.bytes.set(data, this.pos); this.pos += data.length; return this; }
}

/** null als de browser geen 'deflate-raw' kent (alleen 'deflate' en 'gzip', zoals Safari vóór 16.4). */
function safeCompressionStream(): CompressionStream | null {
  try {
    return new CompressionStream('deflate-raw' as CompressionFormat);
  } catch {
    return null;
  }
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  const compression = safeCompressionStream();
  if (!compression) return null;
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(compression);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/** Een pad in de zip: altijd met /, nooit absoluut, nooit omhoog. */
export function safeZipPath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(part => part && part !== '.' && part !== '..');
  if (!parts.length) throw new Error(`Ongeldig pad in de zip: "${path}"`);
  return parts.join('/');
}

export class ZipBuilder {
  private readonly parts: BlobPart[] = [];
  private readonly central: CentralRecord[] = [];
  private readonly names = new Set<string>();
  private offset = 0;
  private readonly created = new Date();
  private readonly encoder = new TextEncoder();
  private readonly options: { forceZip64?: boolean };

  /** forceZip64 is voor de test: de ZIP64-velden ook schrijven als het niet hoeft. */
  constructor(options: { forceZip64?: boolean } = {}) {
    this.options = options;
  }

  get entryCount(): number { return this.central.length; }
  get byteLength(): number { return this.offset; }

  has(path: string): boolean { return this.names.has(safeZipPath(path)); }

  private reserve(path: string): string {
    const name = safeZipPath(path);
    if (this.names.has(name)) throw new Error(`Dubbel pad in de zip: ${name}`);
    this.names.add(name);
    return name;
  }

  async add(path: string, data: Uint8Array | string | Blob, options: ZipAddOptions = {}): Promise<void> {
    const name = this.reserve(path);
    const bytes = typeof data === 'string'
      ? this.encoder.encode(data)
      : data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer());
    const crc = crc32(bytes);
    if (options.inspect) await options.inspect(bytes);
    // Een Blob blijft zelf het onderdeel: dan houdt de zip geen tweede kopie
    // van een bestand van 150 MB in het geheugen vast.
    let stored: Blob | Uint8Array = data instanceof Blob ? data : bytes;
    let storedSize = bytes.length;
    let method: 0 | 8 = 0;
    if (options.compress && bytes.length > 64) {
      const deflated = await deflateRaw(bytes);
      if (deflated && deflated.length < bytes.length) { stored = deflated; storedSize = deflated.length; method = 8; }
    }
    this.pushEntry(name, { crc, size: bytes.length, stored, storedSize, method, modified: options.modified });
  }

  /**
   * Een bestand dat in stukken ontstaat, zoals een tabel van een half miljoen
   * rijen: elk stuk gaat meteen door de CRC en de compressie, zodat er nooit
   * één tekst van honderden MB nodig is (de limiet van een JavaScript-string).
   * Gooit `produce` een fout, dan komt er niets in de zip.
   */
  async addStream(
    path: string,
    produce: (write: (chunk: string | Uint8Array) => Promise<void>) => Promise<void>,
    options: ZipAddOptions = {},
  ): Promise<void> {
    const name = this.reserve(path);
    let crc = 0;
    let size = 0;
    const compression = options.compress && typeof CompressionStream !== 'undefined' ? safeCompressionStream() : null;
    const writer = compression?.writable.getWriter() ?? null;
    const compressed = compression ? new Response(compression.readable).blob() : null;
    // Breekt produce af, dan faalt ook deze belofte; zonder handler wordt dat
    // een onafgehandelde fout in de console, bovenop de echte melding.
    compressed?.catch(() => undefined);
    const raw: Uint8Array[] = [];
    try {
      await produce(async chunk => {
        const bytes = typeof chunk === 'string' ? this.encoder.encode(chunk) : chunk;
        if (!bytes.length) return;
        crc = crc32(bytes, crc);
        size += bytes.length;
        if (writer) await writer.write(bytes as BufferSource); else raw.push(bytes);
      });
      if (writer) await writer.close();
    } catch (error) {
      if (writer) await writer.abort(error).catch(() => undefined);
      this.names.delete(name);
      throw error;
    }
    if (compressed && size > 0) {
      const blob = await compressed;
      this.pushEntry(name, { crc, size, stored: blob, storedSize: blob.size, method: 8, modified: options.modified });
    } else {
      const blob = new Blob(raw as BlobPart[]);
      this.pushEntry(name, { crc, size, stored: blob, storedSize: blob.size, method: 0, modified: options.modified });
    }
  }

  private pushEntry(
    name: string,
    entry: { crc: number; size: number; stored: Blob | Uint8Array; storedSize: number; method: 0 | 8; modified?: Date },
  ): void {
    const { crc, size, stored, storedSize, method } = entry;
    const nameBytes = this.encoder.encode(name);
    const { time, date } = dosDateTime(entry.modified ?? this.created);
    const zip64 = Boolean(this.options.forceZip64) || size >= UINT32_MAX || storedSize >= UINT32_MAX;
    const extraLength = zip64 ? 20 : 0;

    const header = new Bytes(30 + nameBytes.length + extraLength)
      .u32(0x04034b50)
      .u16(zip64 ? 45 : 20)
      .u16(0x0800)
      .u16(method)
      .u16(time)
      .u16(date)
      .u32(crc)
      .u32(zip64 ? UINT32_MAX : storedSize)
      .u32(zip64 ? UINT32_MAX : size)
      .u16(nameBytes.length)
      .u16(extraLength)
      .raw(nameBytes);
    if (zip64) header.u16(0x0001).u16(16).u64(size).u64(storedSize);

    this.central.push({ name: nameBytes, crc, compressedSize: storedSize, size, offset: this.offset, method, time, date });
    // Elk onderdeel meteen als Blob: de browser mag die op schijf zetten.
    this.parts.push(new Blob([header.bytes as BlobPart, stored as BlobPart]));
    this.offset += header.bytes.length + storedSize;
  }

  /** De zip als Blob. Daarna kan er niets meer bij. */
  finish(): Blob {
    const centralStart = this.offset;
    const records: Uint8Array[] = [];
    for (const record of this.central) {
      const needs = {
        size: this.options.forceZip64 || record.size >= UINT32_MAX,
        compressed: this.options.forceZip64 || record.compressedSize >= UINT32_MAX,
        offset: this.options.forceZip64 || record.offset >= UINT32_MAX,
      };
      const extraLength = (needs.size ? 8 : 0) + (needs.compressed ? 8 : 0) + (needs.offset ? 8 : 0);
      const zip64 = extraLength > 0;
      const out = new Bytes(46 + record.name.length + (zip64 ? 4 + extraLength : 0))
        .u32(0x02014b50)
        .u16(zip64 ? 45 : 20)
        .u16(zip64 ? 45 : 20)
        .u16(0x0800)
        .u16(record.method)
        .u16(record.time)
        .u16(record.date)
        .u32(record.crc)
        .u32(needs.compressed ? UINT32_MAX : record.compressedSize)
        .u32(needs.size ? UINT32_MAX : record.size)
        .u16(record.name.length)
        .u16(zip64 ? 4 + extraLength : 0)
        .u16(0)
        .u16(0)
        .u16(0)
        .u32(0)
        .u32(needs.offset ? UINT32_MAX : record.offset)
        .raw(record.name);
      if (zip64) {
        // De volgorde ligt vast: grootte, gecomprimeerde grootte, positie.
        out.u16(0x0001).u16(extraLength);
        if (needs.size) out.u64(record.size);
        if (needs.compressed) out.u64(record.compressedSize);
        if (needs.offset) out.u64(record.offset);
      }
      records.push(out.bytes);
    }
    const centralSize = records.reduce((sum, r) => sum + r.length, 0);
    const count = this.central.length;
    const zip64End = this.options.forceZip64 || count >= UINT16_MAX || centralStart >= UINT32_MAX || centralSize >= UINT32_MAX;

    const tail: Uint8Array[] = [];
    if (zip64End) {
      const zip64EndOffset = centralStart + centralSize;
      tail.push(new Bytes(56)
        .u32(0x06064b50).u64(44).u16(45).u16(45).u32(0).u32(0)
        .u64(count).u64(count).u64(centralSize).u64(centralStart).bytes);
      tail.push(new Bytes(20).u32(0x07064b50).u32(0).u64(zip64EndOffset).u32(1).bytes);
    }
    tail.push(new Bytes(22)
      .u32(0x06054b50).u16(0).u16(0)
      .u16(zip64End ? UINT16_MAX : count)
      .u16(zip64End ? UINT16_MAX : count)
      .u32(zip64End ? UINT32_MAX : centralSize)
      .u32(zip64End ? UINT32_MAX : centralStart)
      .u16(0).bytes);

    return new Blob([...this.parts, ...records.map(r => r as BlobPart), ...tail.map(t => t as BlobPart)], { type: 'application/zip' });
  }
}
