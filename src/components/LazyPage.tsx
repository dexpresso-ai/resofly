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
import React, { lazy, type ComponentType, type ReactNode } from 'react';
import { Button } from './Ui';

export class PageLoadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'PageLoadError';
  }
}

/** React.lazy voor een benoemde export: `lazyPage(() => import('./features/Bank'), 'BankPage')`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyPage<M extends Record<K, ComponentType<any>>, K extends keyof M>(load: () => Promise<M>, name: K) {
  return lazy(() => load().then(
    module => ({ default: module[name] }),
    error => { throw new PageLoadError(error); },
  ));
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
