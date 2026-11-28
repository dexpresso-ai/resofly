// Pure stukjes van de Word-export van een pagina (pageWordExport.ts), los van
// de database, zodat `npm test` ze kan nalopen. pageReferences staat in
// _shared: het portaal gebruikt hem ook.

export { pageReferences } from '../../supabase/functions/_shared/pageReferences.ts';

/** Een bestandsnaam die overal kan: "Werkwijze & afspraken" wordt "Werkwijze-afspraken.docx". */
export function wordFileName(title: string): string {
  const base = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return `${base || 'pagina'}.docx`;
}
