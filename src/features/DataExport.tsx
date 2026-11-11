/**
 * Instellingen → Gegevens: alles van de organisatie in één zip downloaden.
 * Zie docs/plannen/GEGEVENS_MEENEMEN_BOUWPLAN_2026-11-11.md.
 *
 * Alleen de eigenaar en de beheerders zien dit tabblad (settingsTabRoleRule).
 * De export leest met de eigen rechten, dus je krijgt niets wat je in de app
 * niet al kon zien. Het scherm haalt niets op tot je op de knop drukt.
 */
import { useEffect, useRef, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Button } from '../components/Ui';
import { buildDataExport, errorMessage, ExportAbortedError, type ExportProgress, type ExportResult } from '../lib/dataExport';
import { fetchStoredFileBlob } from '../lib/r2';
import { fetchExportPage, logDataExport } from '../lib/repository';

const PHASE_LABEL: Record<ExportProgress['phase'], string> = {
  tabellen: 'Gegevens lezen',
  bestanden: 'Bestanden ophalen',
  boekhouding: 'Auditfiles maken',
  inpakken: 'Inpakken',
};

/** Hoeveel van de balk elke fase vult: bestanden ophalen duurt het langst. */
const PHASE_SPAN: Record<ExportProgress['phase'], [number, number]> = {
  tabellen: [0, 45],
  bestanden: [45, 92],
  boekhouding: [92, 97],
  inpakken: [97, 100],
};

function percent(progress: ExportProgress | null): number {
  if (!progress) return 0;
  const [from, to] = PHASE_SPAN[progress.phase];
  const part = progress.total > 0 ? progress.done / progress.total : 1;
  return Math.round(from + (to - from) * Math.min(1, part));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} kB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2).replace('.', ',')} GB`;
}

const nl = (n: number) => n.toLocaleString('nl-NL');

export function DataExportPanel({ organizationId, organizationName, userId, userEmail }: {
  organizationId: string;
  organizationName: string;
  userId: string;
  userEmail: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const urlRef = useRef<string | null>(null);

  // Weg van het tabblad: de export stopt en de download-URL komt vrij, anders
  // houdt de browser een zip van misschien een paar GB vast.
  useEffect(() => () => {
    abortRef.current?.abort();
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);

  function download(built: ExportResult) {
    if (!urlRef.current) urlRef.current = URL.createObjectURL(built.blob);
    const a = document.createElement('a');
    a.href = urlRef.current;
    a.download = built.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function start() {
    if (busy) return;
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true); setError(null); setResult(null); setProgress(null);
    try {
      const built = await buildDataExport({
        source: { fetchRows: fetchExportPage, fetchFile: fetchStoredFileBlob },
        organizationId,
        organizationName,
        exportedBy: { id: userId, email: userEmail },
        onProgress: setProgress,
        signal: controller.signal,
      });
      // Eerst de regel in het logboek, dan pas de download. Weigert de
      // database (geen eigenaar of beheerder), dan geen zip.
      await logDataExport(organizationId, { tabellen: built.summary.tables, rijen: built.summary.rows, bestanden: built.summary.files });
      setResult(built);
      download(built);
    } catch (e) {
      if (!(e instanceof ExportAbortedError)) setError(errorMessage(e));
    } finally {
      abortRef.current = null;
      setBusy(false);
      setProgress(null);
    }
  }

  const summary = result?.summary;
  const problems = summary ? summary.missingFiles.length + summary.tableErrors.length : 0;

  return <section className="settings-card data-export-card">
    <div className="settings-card-head">
      <div>
        <h3>Alles exporteren</h3>
        <p className="settings-help">Je gegevens zijn van jou. Download in één keer alles wat je organisatie in ResoFly heeft: om over te stappen, voor je archief of voor je accountant. Je krijgt een zip die je ook zonder ResoFly kunt openen.</p>
      </div>
    </div>

    <div className="data-export-columns">
      <div>
        <h4>Wat erin zit</h4>
        <ul className="data-export-list">
          <li>Al je gegevens: klanten, projecten, taken, uren, tickets, offertes, facturen, de boekhouding, je instellingen en het logboek.</li>
          <li>Lijsten voor Excel van de belangrijkste onderdelen.</li>
          <li>Per boekjaar een auditfile (XAF) voor je accountant of een ander boekhoudpakket.</li>
          <li>Alle bestanden: bijlagen, documenten, opnames, inkoopfacturen, en de PDF's van offertes, facturen en contracten zoals je ze verstuurde.</li>
        </ul>
      </div>
      <div>
        <h4>Wat er niet in zit</h4>
        <ul className="data-export-list">
          <li>Galerijen. Die download je per galerij als zip, bij het project.</li>
          <li>Wachtwoorden en sleutels van koppelingen. Die werken alleen in ResoFly.</li>
          <li>Wat van één teamlid is, zoals gesprekken met Gerrie, en wat collega's privé hebben.</li>
          <li>Wat alleen voor de werking van ResoFly is, zoals wachtrijen en wie wat gelezen heeft.</li>
        </ul>
        <p className="settings-help">In de zip staat in LEESMIJ.txt precies wat er niet in zit, en waarom.</p>
      </div>
    </div>

    <p className="settings-help">De eigenaar en de beheerders zien in het logboek dat je een export hebt gemaakt. Houd dit venster open tot de download klaar is; met veel bestanden duurt dat een paar minuten.</p>

    {error && <div className="error">Exporteren lukte niet: {error}</div>}

    {busy && <div className="data-export-progress" role="status" aria-live="polite">
      <div className="prog-bar"><div className="prog-fill" style={{ width: `${percent(progress)}%` }} /></div>
      <span>
        {progress ? `${PHASE_LABEL[progress.phase]}${progress.total > 1 ? `: ${nl(Math.min(progress.done + 1, progress.total))} van ${nl(progress.total)}` : ''}` : 'Starten…'}
      </span>
    </div>}

    {summary && !busy && <div className="success data-export-done">
      <strong>Klaar. De download is gestart.</strong>
      <span>{nl(summary.tables)} tabellen · {nl(summary.rows)} rijen · {nl(summary.files)} bestanden ({formatBytes(summary.fileBytes)}){summary.auditfiles.length ? ` · ${summary.auditfiles.length} auditfile${summary.auditfiles.length === 1 ? '' : 's'}` : ''}</span>
    </div>}

    {summary && !busy && problems > 0 && <details className="data-export-problems">
      <summary>{problems === 1 ? '1 ding' : `${nl(problems)} dingen`} kon ik niet meenemen</summary>
      <ul className="data-export-list">
        {summary.tableErrors.map(e => <li key={`t-${e.table}`}><strong>{e.table}</strong>: {e.message}</li>)}
        {summary.missingFiles.slice(0, 50).map(f => <li key={`f-${f.key}`}>{f.key.split('/').pop()}: {f.message}</li>)}
        {summary.missingFiles.length > 50 && <li>en nog {nl(summary.missingFiles.length - 50)} bestanden; de hele lijst staat in manifest.json.</li>}
      </ul>
    </details>}

    <div className="data-export-actions">
      {busy
        ? <>
          <Button variant="primary" disabled><Loader2 size={15} className="spin" /> Bezig…</Button>
          <Button onClick={() => abortRef.current?.abort()}>Stoppen</Button>
        </>
        : <>
          <Button variant="primary" onClick={start}><Download size={15} /> Alles exporteren</Button>
          {result && <Button onClick={() => download(result)}>Opnieuw downloaden</Button>}
        </>}
    </div>
  </section>;
}
