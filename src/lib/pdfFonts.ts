// De letters van de huisstijl voor de PDF in de app: het live voorbeeld, de
// editor van Documentopmaak en "Download concept-PDF".
//
// fontkit (nodig om een letter in een PDF in te sluiten) is groot; die laden
// we pas als er echt een PDF wordt gemaakt, als eigen stukje van de bundel. De
// bestanden staan in public/fonts/pdf (scripts/pdf-lettertypen.mjs); de server
// heeft dezelfde bytes in supabase/functions/_shared/pdfFonts.ts.
//
// Lukt laden niet (offline, een oude browser), dan geeft dit null en tekent de
// module met de standaardletters. Een voorbeeld in Helvetica is beter dan geen
// voorbeeld.
import type { PdfFontSource } from './documentLayout';

const files = new Map<string, Promise<Uint8Array | null>>();
let source: Promise<PdfFontSource | null> | null = null;

function loadFile(name: string): Promise<Uint8Array | null> {
  // Alleen onze eigen bestandsnamen: "inter-700", "bebas-neue-400".
  if (!/^[a-z]+(-[a-z]+)*-(400|700)$/.test(name)) return Promise.resolve(null);
  let pending = files.get(name);
  if (!pending) {
    pending = fetch(`/fonts/pdf/${name}.woff`)
      .then(response => (response.ok ? response.arrayBuffer() : null))
      .then(buffer => (buffer ? new Uint8Array(buffer) : null))
      .catch(() => null);
    files.set(name, pending);
    // Mislukt? Dan de volgende keer opnieuw proberen in plaats van het onthouden.
    void pending.then(bytes => { if (!bytes) files.delete(name); });
  }
  return pending;
}

export function appPdfFonts(): Promise<PdfFontSource | null> {
  if (!source) {
    source = import('@pdf-lib/fontkit')
      .then(module => ({ fontkit: module.default, load: loadFile }))
      .catch(error => {
        console.warn('fontkit laden mislukt; de PDF krijgt standaardletters', error);
        source = null;
        return null;
      });
  }
  return source;
}
