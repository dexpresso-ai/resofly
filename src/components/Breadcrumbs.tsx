import { ChevronLeft, Home } from 'lucide-react';
import type { AppData } from '../types';
import { breadcrumbTrail, showsBreadcrumbs, type CrumbTarget, type CrumbView } from '../lib/breadcrumbs';

/**
 * Het kruimelpad boven de pagina-inhoud. Twee dingen tegelijk:
 *
 *  · waar ben ik  — Dashboard › Werk › Projecten › WOW – Implementatie
 *  · hoe kom ik terug — elke kruimel vóór de laatste is een knop
 *
 * Op een telefoon staat er een terugpijl vóór het pad: die springt naar de
 * dichtstbijzijnde bovenliggende pagina, zodat "terug" altijd één tik is en je
 * niet op een regel van elf pixels hoeft te mikken. De menukoppen ("Werk")
 * verdwijnen daar — zie globals.css — want ze zijn oriëntatie, geen doel.
 */
export function Breadcrumbs({
  view,
  data,
  onNavigate,
}: {
  view: CrumbView;
  data: AppData;
  onNavigate: (target: CrumbTarget) => void;
}) {
  if (!showsBreadcrumbs(view.page)) return null;

  const crumbs = breadcrumbTrail(view, data);
  // Eén kruimel zonder knop is geen pad maar een herhaling van de titel.
  const clickable = crumbs.filter(crumb => crumb.target);
  if (clickable.length === 0) return null;

  const back = clickable[clickable.length - 1];

  return (
    <nav className="crumbs" aria-label="Kruimelpad">
      <button
        type="button"
        className="crumbs-back"
        onClick={() => back.target && onNavigate(back.target)}
        aria-label={`Terug naar ${back.label}`}
        title={`Terug naar ${back.label}`}
      >
        <ChevronLeft size={17} aria-hidden="true" />
      </button>
      <ol className="crumbs-list">
        {crumbs.map(crumb => (
          <li key={crumb.key} className={`crumbs-item is-${crumb.kind}`}>
            {crumb.target
              ? <button type="button" className="crumbs-link" onClick={() => crumb.target && onNavigate(crumb.target)}>
                  {crumb.kind === 'home' && <Home size={13} aria-hidden="true" />}
                  <span className="crumbs-text">{crumb.label}</span>
                </button>
              : <span className="crumbs-plain" aria-current={crumb.kind === 'current' ? 'page' : undefined}>
                  <span className="crumbs-text">{crumb.label}</span>
                </span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}
