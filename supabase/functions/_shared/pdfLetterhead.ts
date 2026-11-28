// ============================================================
// Een briefpapier dat een PDF is, onder een PDF die er al is (stap 1B-5).
//
// De PDF van een pagina komt uit Collabora, via een Word-file, en in een
// .docx kan geen PDF als briefpapier. Daarom komt het er na het omzetten
// onder, met pdf-lib, zoals bij facturen (documentLayout.ts): de eerste
// pagina van het briefpapier, één keer ingesloten, op elke bladzijde, als
// omslag geschaald (een ander formaat dan A4 vult de bladzijde toch).
//
// Onder, niet over. pdf-lib tekent altijd bovenop: de nieuwe inhoud komt
// achteraan de pagina, en daar zou het briefpapier de tekst bedekken. Daarom
// gaat die inhoud hier naar voren. De pagina's zelf blijven staan, dus de
// links en de inhoudsopgave blijven werken; de pagina's opnieuw insluiten in
// een nieuw document zou ze kwijtraken.
//
// Puur: pdf-lib komt van de aanroeper (esm.sh in Deno, node_modules in de
// tests), net als in documentLayout.ts.
// ============================================================

/** Het briefpapier is geen bruikbare PDF. Dan geen PDF zonder: de gebruiker koos het. */
export class LetterheadUnusable extends Error {
  constructor(message = 'Je briefpapier is geen bruikbare PDF. Kies het opnieuw bij Instellingen → Documentopmaak.') {
    super(message);
    this.name = 'LetterheadUnusable';
  }
}

// Alleen wat deze module van pdf-lib (1.17.1) gebruikt.
type ContentsArray = { size(): number; get(index: number): unknown; remove(index: number): void; insert(index: number, value: unknown): void };
interface UnderlayEmbeddedPage {
  width: number;
  height: number;
  /** pdf-lib sluit pas in bij `save()`; zo kan het meteen, binnen een try. */
  embed?(): Promise<void>;
}
interface UnderlayPage {
  getMediaBox(): { x: number; y: number; width: number; height: number };
  // deno-lint-ignore no-explicit-any
  drawPage(page: any, options?: any): void;
  node: { Contents(): unknown };
}
export interface UnderlayDocument {
  getPages(): UnderlayPage[];
  getPageCount(): number;
  // deno-lint-ignore no-explicit-any
  embedPdf(source: any, indices?: number[]): Promise<UnderlayEmbeddedPage[]>;
  save(): Promise<Uint8Array>;
}
export interface PdfUnderlayLib {
  PDFDocument: {
    create(): Promise<UnderlayDocument>;
    load(bytes: Uint8Array, options?: { ignoreEncryption?: boolean; updateMetadata?: boolean }): Promise<UnderlayDocument>;
  };
}

/**
 * Laadt het briefpapier en sluit de eerste pagina op proef in, vóór het
 * echte werk: een kapot briefpapier moet in een paar milliseconden een
 * duidelijke melding geven, niet na een minuut omzetten.
 *
 * null: een lege eerste pagina (zonder inhoud). Dan valt er niets te
 * tekenen, en is de PDF met dat briefpapier dezelfde als zonder; net als bij
 * facturen geen fout. Een PDF zonder pagina's of die niet te lezen is, wel:
 * de gebruiker koos het briefpapier, dus nooit stil zonder.
 */
export async function loadLetterhead(lib: PdfUnderlayLib, bytes: Uint8Array): Promise<UnderlayDocument | null> {
  let source: UnderlayDocument;
  let pages: number;
  try {
    source = await lib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    // Ook dit kan misgaan: van alleen een kop ("%PDF-1.4") maakt pdf-lib een
    // document zonder catalogus, en dan geeft het tellen een TypeError.
    pages = source.getPageCount();
  } catch {
    throw new LetterheadUnusable();
  }
  if (pages === 0) throw new LetterheadUnusable();
  try {
    // Op proef in een los document: pdf-lib sluit pas in bij save(), en een
    // pagina die dan mislukt, liet bij facturen de hele PDF mislukken.
    const probe = await lib.PDFDocument.create();
    const [trial] = await probe.embedPdf(source, [0]);
    await trial?.embed?.();
    if (!trial || !(trial.width > 0) || !(trial.height > 0)) return null;
  } catch (error) {
    // Een pagina zonder inhoud: pdf-lib geeft zijn fouten geen eigen naam;
    // de melding is vast (1.17.1), zoals in documentLayout.ts.
    if (/missing Contents/i.test(String((error as { message?: string } | null)?.message ?? ''))) return null;
    throw new LetterheadUnusable();
  }
  return source;
}

/**
 * Het briefpapier onder elke bladzijde van `pdf`. `letterhead` komt uit
 * loadLetterhead. De gegevens van het bestand (titel, maker) blijven die
 * van het origineel.
 */
export async function underlayLetterhead(lib: PdfUnderlayLib, pdf: Uint8Array, letterhead: UnderlayDocument): Promise<Uint8Array> {
  const doc = await lib.PDFDocument.load(pdf, { updateMetadata: false });
  const [paper] = await doc.embedPdf(letterhead, [0]);
  if (!paper || !(paper.width > 0) || !(paper.height > 0)) return pdf;
  for (const page of doc.getPages()) {
    const box = page.getMediaBox();
    // Als omslag: de bladzijde helemaal vullen, zonder vervormen.
    const scale = Math.max(box.width / paper.width, box.height / paper.height);
    const width = paper.width * scale;
    const height = paper.height * scale;
    page.drawPage(paper, { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height });
    toBack(page);
  }
  return await doc.save();
}

/**
 * De inhoud die drawPage net achteraan zette, naar voren: eerst het
 * briefpapier, dan de pagina. drawPage zet zijn tekening tussen q en Q, dus
 * de pagina begint daarna met de gewone stand van zaken.
 */
function toBack(page: UnderlayPage): void {
  const contents = page.node.Contents() as ContentsArray | undefined;
  // Na drawPage is Contents altijd een lijst (pdf-lib maakt er een van). Is
  // dat ooit anders, dan liever geen PDF dan een briefpapier over de tekst.
  if (!contents || typeof contents.size !== 'function' || typeof contents.insert !== 'function') {
    throw new Error('Het briefpapier kon niet onder de bladzijde.');
  }
  const last = contents.size() - 1;
  if (last <= 0) return;
  const stream = contents.get(last);
  contents.remove(last);
  contents.insert(0, stream);
}
