import { useMemo, useRef, useState } from 'react';
import { Download, FileSpreadsheet, Upload } from 'lucide-react';
import { Modal } from './Modal';
import { Button } from './Ui';
import { downloadCsv } from '../lib/csv';
import { parseCsv, prepareImport, type ImportColumn, type PreparedRow } from '../lib/csvImport';

type Phase = 'select' | 'preview' | 'importing' | 'done';

export interface CsvImportModalProps {
  /** Titel boven de modal, bv. "Klanten importeren". */
  title: string;
  /** Meervoud van wat geïmporteerd wordt, bv. "klanten" of "leveranciers". */
  entityLabel: string;
  columns: ImportColumn[];
  templateFilename: string;
  /** Slaat één rij op. Gooi een Error om de rij als mislukt te markeren. */
  importRow: (record: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
  /** Wordt aangeroepen nadat de import klaar is, om de data te verversen. */
  onDone: () => void;
}

const PREVIEW_LIMIT = 50;

export function CsvImportModal({ title, entityLabel, columns, templateFilename, importRow, onClose, onDone }: CsvImportModalProps) {
  const [phase, setPhase] = useState<Phase>('select');
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [missingRequired, setMissingRequired] = useState<string[]>([]);
  const [rows, setRows] = useState<PreparedRow[]>([]);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<{ imported: number; failed: { line: number; error: string }[] } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const validRows = useMemo(() => rows.filter(r => r.errors.length === 0), [rows]);
  const invalidCount = rows.length - validRows.length;

  function downloadTemplate() {
    downloadCsv(templateFilename, columns.map(c => c.header), [columns.map(c => c.example ?? '')]);
  }

  async function onFile(file: File | undefined | null) {
    if (!file) return;
    setError(null);
    try {
      const text = await file.text();
      const prepared = prepareImport(parseCsv(text), columns);
      setFileName(file.name);
      setMissingRequired(prepared.missingRequired);
      setRows(prepared.rows);
      if (!prepared.missingRequired.length && prepared.rows.length === 0) {
        setError('Het bestand bevat wel kolomkoppen, maar geen rijen om te importeren.');
        return;
      }
      setPhase('preview');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Het bestand kon niet worden gelezen.');
    }
  }

  async function runImport() {
    setPhase('importing');
    setProgress(0);
    const failed: { line: number; error: string }[] = [];
    let imported = 0;
    for (let i = 0; i < validRows.length; i += 1) {
      try {
        await importRow(validRows[i].record);
        imported += 1;
      } catch (e) {
        failed.push({ line: i + 1, error: e instanceof Error ? e.message : 'Onbekende fout' });
      }
      setProgress(i + 1);
    }
    setResult({ imported, failed });
    setPhase('done');
  }

  function finish() {
    onDone();
    onClose();
  }

  const previewColumns = columns;
  const visibleRows = rows.slice(0, PREVIEW_LIMIT);

  return (
    <Modal title={title} className="csv-import-modal"
      onClose={phase === 'importing' ? () => { } : phase === 'done' ? finish : onClose}
      footer={renderFooter()}>
      {error && <div className="error">{error}</div>}

      {phase === 'select' && (
        <div className="csv-import-intro">
          <p>Importeer in bulk via een CSV-bestand met <strong>vaste kolomkoppen</strong>. Download eerst het
            voorbeeldbestand, vul je {entityLabel} in en upload het terug.</p>
          <div className="csv-import-template">
            <FileSpreadsheet size={18} />
            <div>
              <strong>Verwachte kolommen</strong>
              <span>{columns.map(c => c.header + (c.required ? ' *' : '')).join(' · ')}</span>
              <small>Kolommen met * zijn verplicht. Onbekende kolommen worden genegeerd.</small>
            </div>
          </div>
          <div className="csv-import-actions">
            <Button onClick={downloadTemplate}><Download size={15} /> Voorbeeldbestand downloaden</Button>
            <Button variant="primary" onClick={() => inputRef.current?.click()}><Upload size={15} /> CSV-bestand kiezen</Button>
          </div>
          <input ref={inputRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }}
            onChange={e => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
        </div>
      )}

      {phase === 'preview' && missingRequired.length > 0 && (
        <div className="csv-import-missing">
          <p>In <strong>{fileName}</strong> ontbreken verplichte kolommen:</p>
          <ul>{missingRequired.map(h => <li key={h}>{h}</li>)}</ul>
          <p>Gebruik het voorbeeldbestand zodat de kolomkoppen exact kloppen.</p>
        </div>
      )}

      {phase === 'preview' && missingRequired.length === 0 && (
        <div className="csv-import-preview">
          <div className="csv-import-summary">
            <span><strong>{fileName}</strong> · {rows.length} rij{rows.length === 1 ? '' : 'en'}</span>
            <span className="csv-import-counts">
              <em className="ok">{validRows.length} geldig</em>
              {invalidCount > 0 && <em className="bad">{invalidCount} met fouten (worden overgeslagen)</em>}
            </span>
          </div>
          <div className="csv-import-table-wrap">
            <table className="csv-import-table">
              <thead>
                <tr>
                  <th>#</th>
                  {previewColumns.map(c => <th key={c.key}>{c.header}</th>)}
                  <th>Controle</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row, i) => (
                  <tr key={i} className={row.errors.length ? 'has-error' : ''}>
                    <td>{i + 1}</td>
                    {previewColumns.map(c => <td key={c.key}>{formatCell(row.record[c.key])}</td>)}
                    <td>{row.errors.length === 0
                      ? <span className="csv-cell-ok">OK</span>
                      : <span className="csv-cell-bad">{row.errors.join('; ')}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > PREVIEW_LIMIT && <p className="csv-import-more">Eerste {PREVIEW_LIMIT} van {rows.length} rijen getoond. Alle geldige rijen worden geïmporteerd.</p>}
        </div>
      )}

      {phase === 'importing' && (
        <div className="csv-import-progress">
          <p>Bezig met importeren… {progress} / {validRows.length}</p>
          <div className="prog-bar"><div className="prog-fill" style={{ width: `${validRows.length ? (progress / validRows.length) * 100 : 0}%`, background: 'var(--accent)' }} /></div>
        </div>
      )}

      {phase === 'done' && result && (
        <div className="csv-import-done">
          <div className="success">{result.imported} {entityLabel} geïmporteerd.</div>
          {result.failed.length > 0 && (
            <div className="csv-import-failed">
              <strong>{result.failed.length} rij{result.failed.length === 1 ? '' : 'en'} mislukt:</strong>
              <ul>{result.failed.map(f => <li key={f.line}>Rij {f.line}: {f.error}</li>)}</ul>
            </div>
          )}
        </div>
      )}
    </Modal>
  );

  function renderFooter() {
    if (phase === 'select') return <Button onClick={onClose}>Annuleren</Button>;
    if (phase === 'preview' && missingRequired.length > 0) return <>
      <Button onClick={onClose}>Annuleren</Button>
      <Button variant="primary" onClick={() => { setPhase('select'); setError(null); }}>Opnieuw kiezen</Button>
    </>;
    if (phase === 'preview') return <>
      <Button onClick={() => { setPhase('select'); setRows([]); }}>Ander bestand</Button>
      <Button variant="primary" onClick={runImport} disabled={validRows.length === 0}>
        {validRows.length} {entityLabel} importeren
      </Button>
    </>;
    if (phase === 'importing') return <Button disabled>Bezig…</Button>;
    return <Button variant="primary" onClick={finish}>Sluiten</Button>;
  }
}

function formatCell(value: unknown): string {
  if (value == null) return '';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}
