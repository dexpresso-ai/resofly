// Pure stukjes van de Word-export van een pagina (pageWordExport.ts), los van
// de database, zodat `npm test` ze kan nalopen. pageReferences staat in
// _shared: het portaal gebruikt hem ook.

export { pageReferences } from '../../supabase/functions/_shared/pageReferences.ts';

/**
 * Wat de export zegt bij een briefpapier dat een PDF is (stap 1B-4b). Hier,
 * zodat het venster het kan tonen zonder de hele export te laden.
 */
export const LETTERHEAD_PDF_MESSAGE = 'Je briefpapier is een PDF, en dat past niet in een Word-bestand. Met een afbeelding (PNG of JPG) als briefpapier kan het wel: Instellingen → Documentopmaak.';

/** Een bestandsnaam die overal kan: "Werkwijze & afspraken" wordt "Werkwijze-afspraken.docx". */
export function wordFileName(title: string): string {
  const base = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return `${base || 'pagina'}.docx`;
}
