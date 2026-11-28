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
//
// Stap 1B-4: de opties voor Word (voorblad, inhoudsopgave, subpagina's als
// hoofdstukken). Ze staan bij de Word-knoppen: afdrukken toont de pagina
// zoals ze op het scherm staat, en kent ze niet.
//
// Stap 1B-5: de PDF, met dezelfde opties. De server maakt hem (page-export),
// uit dezelfde Word-file, zodat Word en PDF er hetzelfde uitzien (§9).
// "Vastleggen in het dossier" zet de PDF als vast bestand in de map.
// ============================================================

import { useEffect } from 'react';
import { FileDown, FileLock2, FilePlus2, FileText, Printer, X } from 'lucide-react';
import { useBackStep } from '../lib/useBackStep';

export type PageExportAction = 'word' | 'kopie' | 'pdf' | 'vastleggen' | 'afdrukken';

/** De opties voor Word (stap 1B-4). Standaard alles uit: dan is het bestand dat van 1B-3. */
export type PageExportOptions = { cover: boolean; toc: boolean; chapters: boolean; letterhead: boolean };

export const NO_EXPORT_OPTIONS: PageExportOptions = { cover: false, toc: false, chapters: false, letterhead: false };

/** De subpagina's onder de pagina: hoeveel, of te veel. null zolang ze laden of als dat niet lukte. */
export type PageExportSubpages = { count: number; tooMany: boolean; limit: number } | null;

export function PageExportDialog({ busy, error, canCopy, options, subpages, letterhead, letterheadPdfNote, folder, onOptions, onChoose, onClose }: {
  /** Wat er nu loopt; zolang kun je niets anders kiezen. */
  busy: PageExportAction | null;
  error: string | null;
  /** Een Word-document in het dossier maken mag alleen wie Inhoud mag schrijven. */
  canCopy: boolean;
  options: PageExportOptions;
  subpages: PageExportSubpages;
  /** Het briefpapier van Documentopmaak: een afbeelding kan in Word, een PDF niet. null: er is er geen. */
  letterhead: 'image' | 'pdf' | null;
  letterheadPdfNote: string;
  /**
   * De map waar "Vastleggen in het dossier" de PDF zet: die van de bovenste
   * pagina. undefined zolang hij laadt; null als er geen map is.
   */
  folder: { name: string } | null | undefined;
  onOptions: (options: PageExportOptions) => void;
  onChoose: (action: PageExportAction) => void;
  onClose: () => void;
}) {
  useBackStep(true, onClose);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const check = (key: keyof PageExportOptions, label: string, disabled = false) => (
    <label className={`page-export-check${disabled ? ' is-disabled' : ''}`}>
      <input
        type="checkbox"
        checked={options[key] && !disabled}
        disabled={disabled || busy !== null}
        onChange={event => onOptions({ ...options, [key]: event.target.checked })}
      />
      <span>{label}</span>
    </label>
  );
  const option = (action: PageExportAction, icon: JSX.Element, label: string, help: string, disabled = false) => (
    <button
      type="button"
      className={`page-export-option page-export-${action}`}
      onClick={() => onChoose(action)}
      disabled={busy !== null || disabled}
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
        <fieldset className="page-export-word-group">
          <legend>Word en PDF</legend>
          <div className="page-export-checks">
            {check('cover', 'Voorblad: titel, klant, project, datum en logo')}
            {check('toc', 'Inhoudsopgave vooraan')}
            {letterhead === 'image' && check('letterhead', 'Briefpapier, achter elke bladzijde')}
            {letterhead === 'pdf' && <>
              {check('letterhead', 'Briefpapier', true)}
              <p className="page-export-note">{letterheadPdfNote}</p>
            </>}
            {subpages && subpages.count > 0 && check('chapters', `Subpagina's als hoofdstukken (${subpages.count})`)}
            {subpages?.tooMany && <>
              {check('chapters', 'Subpagina\'s als hoofdstukken', true)}
              <p className="page-export-note">Er staan meer dan {subpages.limit} subpagina's onder deze pagina. Zoveel hoofdstukken passen niet in één bestand.</p>
            </>}
          </div>
          <div className="page-export-options">
            {option('word', <FileDown size={18} aria-hidden="true" />, 'Word downloaden', 'Een .docx-bestand op je computer.')}
            {canCopy && option('kopie', <FilePlus2 size={18} aria-hidden="true" />, 'Maak er een Word-document van',
              'Een Word-document naast de pagina, dat meteen opent. Voor de laatste puntjes: wat je daarin wijzigt, komt niet terug in de pagina.')}
            {option('pdf', <FileText size={18} aria-hidden="true" />, 'PDF downloaden', 'Dezelfde opmaak als Word, als PDF op je computer.')}
            {canCopy && option('vastleggen', <FileLock2 size={18} aria-hidden="true" />, 'Vastleggen in het dossier',
              folder === undefined ? 'De PDF als vast bestand in de map van de pagina.'
                : folder ? `De PDF als vast bestand in de map "${folder.name}". Wat je later aan de pagina wijzigt, verandert die PDF niet.`
                  : 'Kan alleen als de pagina in een map staat: zet haar eerst in een map.',
              folder === null)}
          </div>
          {(busy === 'pdf' || busy === 'vastleggen') && <p className="page-export-note" role="status">De eerste PDF na een pauze kan tot een minuut duren.</p>}
        </fieldset>
        <div className="page-export-options">
          {option('afdrukken', <Printer size={18} aria-hidden="true" />, 'Afdrukken',
            'De pagina zoals op het scherm. Of bewaar haar als PDF: kies dat in het afdrukvenster van je browser.')}
        </div>
        {error && <p className="page-export-error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
