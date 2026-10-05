import { PAGE_ICON } from './TabBar';

/**
 * Het pictogram van een pagina in een donkere tegel met een gouden icoon, links
 * van de titel — dezelfde taal als de zijbalk, zodat je altijd ziet waar je
 * bent. Hetzelfde icoon als in de werktab. Staat als eerste kind in het tekstblok
 * van de paginakop; cockpit.css zet dat blok vanaf 1025px om in twee kolommen en
 * verbergt de tegel daaronder, zodat telefoon en tablet hun opbouw houden.
 */
export function PageIcon({ page }: { page: string }) {
  const Icon = PAGE_ICON[page];
  if (!Icon) return null;
  // Een div, geen span: de koppen stylen hun losse <span>-regels (de meta onder
  // de titel), en die regels mogen de tegel niet raken.
  return <div className="page-icon" aria-hidden="true"><Icon size={21} strokeWidth={2.1} /></div>;
}
