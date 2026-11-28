// ============================================================
// Een bestand kiezen voor een bestandsblok (stap 1A-4b, docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md §8).
//
// Twee wegen: een bestand dat al in het dossier van de pagina staat, of
// bestanden van de computer (die worden een bijlage van de pagina zelf). De
// lijst toont alleen wat de database bij opslaan aanneemt: hetzelfde dossier
// (listDossierFiles volgt de regel van migratie 20261127150000). Anders kon je
// iets kiezen waarna de pagina niet meer opsloeg.
// ============================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Search, Upload, X } from 'lucide-react';
import type { DossierFile } from '../lib/repository';
import { useBackStep } from '../lib/useBackStep';

export type FileChoice = { attachmentId: string } | { files: File[] } | null;

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

export function PageFilePicker({ files, error, onChoose }: {
  /** null zolang de lijst laadt. */
  files: DossierFile[] | null;
  error: string | null;
  onChoose: (choice: FileChoice) => void;
}) {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);
  useBackStep(true, () => onChoose(null));
  useEffect(() => {
    searchRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onChoose(null); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onChoose]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (files ?? []).filter(file => !q || file.name.toLowerCase().includes(q) || (file.folder ?? '').toLowerCase().includes(q));
  }, [files, query]);

  const fromComputer = () => {
    // In de pagina hangen zolang je kiest: een los invoerveld kon de browser
    // opruimen voordat de keuze binnen was.
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.hidden = true;
    document.body.append(input);
    input.addEventListener('change', () => {
      const chosen = Array.from(input.files ?? []);
      input.remove();
      if (chosen.length > 0) onChoose({ files: chosen });
    });
    input.addEventListener('cancel', () => input.remove());
    input.click();
  };

  return (
    <div className="page-file-picker-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onChoose(null); }}>
      <div className="page-file-picker" role="dialog" aria-modal="true" aria-label="Bestand invoegen">
        <div className="page-file-picker-head">
          <strong>Bestand invoegen</strong>
          <button type="button" className="page-editor-close" onClick={() => onChoose(null)} aria-label="Sluiten"><X size={16} /></button>
        </div>
        <button type="button" className="btn page-file-picker-upload" onClick={fromComputer}><Upload size={15} />Van je computer…</button>
        <label className="page-file-picker-search">
          <Search size={15} aria-hidden="true" />
          <input ref={searchRef} value={query} onChange={event => setQuery(event.target.value)} placeholder="Zoeken in dit dossier" aria-label="Zoeken in dit dossier" />
        </label>
        <div className="page-file-picker-list" role="listbox" aria-label="Bestanden in dit dossier">
          {error && <p className="page-file-picker-empty">{error}</p>}
          {!error && files === null && <p className="page-file-picker-empty">Laden…</p>}
          {!error && files !== null && files.length === 0 && <p className="page-file-picker-empty">Er staan nog geen bestanden in dit dossier. Kies er een van je computer.</p>}
          {!error && files !== null && files.length > 0 && shown.length === 0 && <p className="page-file-picker-empty">Geen bestand gevonden.</p>}
          {shown.map(file => (
            <button key={file.id} type="button" role="option" aria-selected={false} className="page-file-picker-item" onClick={() => onChoose({ attachmentId: file.id })}>
              <FileText size={16} aria-hidden="true" />
              <span className="page-file-picker-name">{file.name}</span>
              <span className="page-file-picker-meta">{[file.folder, sizeLabel(file.size_bytes)].filter(Boolean).join(' · ')}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
