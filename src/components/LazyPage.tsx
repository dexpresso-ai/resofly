/**
 * Pagina's die pas laden als je ze opent (src/main.tsx).
 *
 * Tot november 2026 zat elke pagina van de werkruimte in de bundel die bij
 * elke start werd geladen en geparsed: Agenda, Weekplanner, Boekhouding,
 * Instellingen… samen ruim de helft van die bundel. Op een telefoon kostte
 * alleen het parsen al seconden, ook als je die dag maar één pagina opende.
 *
 * Twee onderdelen:
 *  - lazyPage(): React.lazy voor een benoemde export. Een mislukte import wordt
 *    een PageLoadError, zodat de grens hieronder hem herkent.
 *  - PageLoadBoundary: vangt alleen zo'n laadfout. Na een nieuwe deploy bestaan
 *    de oude bestanden niet meer op Cloudflare Pages, en een venster dat al
 *    openstond kan de pagina dan niet meer ophalen. Zonder deze grens werd de
 *    hele app wit. Opnieuw proberen helpt niet (de browser onthoudt een
 *    mislukte module), herladen wel. Elke andere fout gaat door zoals altijd.
 *    Zie ook lib/chunkReload.ts: die vraagt om te herladen zodra hij ziet dat
 *    er een nieuwe versie staat.
 */
import React, { lazy, useState, type ComponentType, type ReactNode } from 'react';
import { Button } from './Ui';

export class PageLoadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'PageLoadError';
  }
}

/**
 * React.lazy voor een benoemde export: `lazyPage(() => import('./features/Bank'), 'BankPage')`.
 *
 * `preload()` haalt het bestand alvast op, zonder te renderen: de app doet dat
 * bij het opstarten voor de pagina waarop hij opent, tegelijk met de gegevens.
 * Eerst kwam dat bestand pas als de gegevens er waren: in een losse app een
 * waterval van schil, groep en pagina, gemeten 0,4-1,6 s op een telefoon.
 *
 * Is het bestand al binnen, dan rendert de pagina meteen. React.lazy wacht
 * anders altijd één keer, ook op een bestand dat er al is, en die tweede beurt
 * kwam op een telefoon achter alle andere renders van de schil (~400 ms).
 * Welke van de twee een pagina gebruikt, ligt vast zodra hij verschijnt: een
 * pagina die van de een naar de ander wisselt, zou React opnieuw opbouwen, en
 * wat je had ingetypt was dan weg.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyPage<M extends Record<K, ComponentType<any>>, K extends keyof M>(load: () => Promise<M>, name: K) {
  type Page = M[K];
  let loaded: Page | null = null;
  let pending: Promise<{ default: Page }> | null = null;
  const start = () => (pending ??= load().then(
    module => { loaded = module[name]; return { default: module[name] }; },
    error => {
      // Een volgende poging mag het opnieuw proberen (na herladen meestal pas).
      pending = null;
      throw new PageLoadError(error);
    },
  ));
  const Lazy = lazy(start);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function LazyPage(props: any) {
    const [Direct] = useState(() => loaded);
    return Direct ? React.createElement(Direct, props) : React.createElement(Lazy, props);
  }
  const preload = () => { start().catch(() => undefined); };
  return Object.assign(LazyPage as unknown as Page, { preload });
}

/** Terwijl een pagina binnenkomt. Kort: meestal staat hij er binnen een tel. */
export function PageLoading() {
  return <div className="empty" role="status" aria-live="polite"><span className="boot-spinner" aria-hidden="true" /><div>Laden…</div></div>;
}

interface BoundaryProps {
  /** Verandert de pagina in dit tabblad, dan begint de grens opnieuw. */
  resetKey: string;
  children: ReactNode;
}

export class PageLoadBoundary extends React.Component<BoundaryProps, { error: unknown }> {
  state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidUpdate(previous: BoundaryProps) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    // Geen laadfout: niet hier opvangen. Een grens die bij het herstellen zelf
    // een fout gooit, geeft die door aan de grens erboven (zo werkt React), en
    // de app gedraagt zich dan zoals vóór deze grens.
    if (!(error instanceof PageLoadError)) throw error;
    return <div className="empty" role="alert">
      <div className="e-big">Deze pagina kon niet worden geladen</div>
      <div>Waarschijnlijk is ResoFly net bijgewerkt, of viel de verbinding even weg. Herlaad om verder te gaan. Wat je nog niet hebt opgeslagen, gaat dan verloren.</div>
      <Button onClick={() => window.location.reload()}>Herladen</Button>
    </div>;
  }
}
