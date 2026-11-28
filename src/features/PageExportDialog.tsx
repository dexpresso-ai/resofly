// ============================================================
// Het exportvenster van een pagina (stap 1B-3, docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md §9).
//
// Export is een kopie van dit moment; de pagina blijft de bron. Het venster
// vervangt de knop "Word" in de balk van de editor. Met de Word-kopie en
// afdrukken erbij zou de balk anders een knop per uitvoer krijgen, en die
// past op een telefoon al nauwelijks.
//
// Het venster doet zelf niets: de editor slaat eerst op en maakt het bestand
// (PageEditor.tsx). Wat er loopt, houdt de editor bij. Sluit je het venster
// terwijl er iets loopt, dan gaat dat door, en kan er geen tweede bij komen.
// ============================================================

import { useEffect } from 'react';
import { FileDown, FilePlus2, Printer, X } from 'lucide-react';
import { useBackStep } from '../lib/useBackStep';

export type PageExportAction = 'word' | 'kopie' | 'afdrukken';

export function PageExportDialog({ busy, error, canCopy, onChoose, onClose }: {
  /** Wat er nu loopt; zolang kun je niets anders kiezen. */
  busy: PageExportAction | null;
  error: string | null;
  /** Een Word-document in het dossier maken mag alleen wie Inhoud mag schrijven. */
  canCopy: boolean;
  onChoose: (action: PageExportAction) => void;
  onClose: () => void;
}) {
  useBackStep(true, onClose);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const option = (action: PageExportAction, icon: JSX.Element, label: string, help: string) => (
    <button
      type="button"
      className={`page-export-option page-export-${action}`}
      onClick={() => onChoose(action)}
      disabled={busy !== null}
      aria-busy={busy === action}
    >
      {icon}
      <span>
        <strong>{busy === action ? 'Bezig…' : label}</strong>
        <small>{help}</small>
      </span>
    </button>
  );

  return (
    <div className="page-export-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="page-export" role="dialog" aria-modal="true" aria-labelledby="page-export-title">
        <div className="page-export-head">
          <strong id="page-export-title">Exporteren</strong>
          <button type="button" className="page-editor-close" onClick={onClose} aria-label="Sluiten"><X size={16} /></button>
        </div>
        <p className="page-export-intro">Een kopie van de pagina zoals ze nu is, in je huisstijl. De pagina zelf verandert niet.</p>
        <div className="page-export-options">
          {option('word', <FileDown size={18} aria-hidden="true" />, 'Word downloaden', 'Een .docx-bestand op je computer.')}
          {canCopy && option('kopie', <FilePlus2 size={18} aria-hidden="true" />, 'Maak er een Word-document van',
            'Een Word-document naast de pagina, dat meteen opent. Voor de laatste puntjes: wat je daarin wijzigt, komt niet terug in de pagina.')}
          {option('afdrukken', <Printer size={18} aria-hidden="true" />, 'Afdrukken',
            'Of bewaar de pagina als PDF: kies dat in het afdrukvenster van je browser.')}
        </div>
        {error && <p className="page-export-error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
