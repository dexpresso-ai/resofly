import { useEffect, useMemo, useState } from 'react';
import { BarChart3, Download, LayoutGrid, LineChart as LineIcon, Pin, PinOff, PieChart as PieIcon, Plus, Save, Table as TableIcon, Trash2 } from 'lucide-react';
import type { AppData, SavedReport } from '../types';
import { Button, Input, Select } from '../components/Ui';
import { downloadCsv } from '../lib/csv';
import { createSavedReport, deleteSavedReport, updateSavedReport } from '../lib/repository';
import { BarChart, LineChart, PieChart } from '../components/Charts';
import {
  DATE_PRESET_LABELS, GRANULARITY_LABELS, REPORT_SOURCES, REPORT_SOURCE_ORDER, REPORT_TEMPLATES,
  cloneDefinition, defaultReportFor, formatMeasure, measureKey, measureOptions, runReport,
  type ChartType, type DateGranularity, type DateRangePreset, type ReportDefinition,
  type ReportField, type ReportSourceKey,
} from '../lib/reporting';

const CHART_META: { type: ChartType; label: string; Icon: typeof BarChart3 }[] = [
  { type: 'bar', label: 'Staaf', Icon: BarChart3 },
  { type: 'line', label: 'Lijn', Icon: LineIcon },
  { type: 'pie', label: 'Taart', Icon: PieIcon },
  { type: 'table', label: 'Tabel', Icon: TableIcon },
  { type: 'kpi', label: 'Kerncijfer', Icon: LayoutGrid },
];

function allowedCharts(dimField: ReportField | null): ChartType[] {
  if (!dimField) return ['kpi', 'table'];
  if (dimField.type === 'date') return ['line', 'bar', 'table'];
  return ['bar', 'pie', 'table'];
}

function coerceDefinition(raw: unknown): ReportDefinition {
  const r = (raw ?? {}) as Partial<ReportDefinition>;
  const source: ReportSourceKey = r.source && REPORT_SOURCES[r.source] ? r.source : 'invoices';
  const fallback = defaultReportFor(source);
  return {
    source,
    measure: r.measure ?? fallback.measure,
    dimension: r.dimension === undefined ? fallback.dimension : r.dimension,
    granularity: r.granularity ?? 'month',
    filters: Array.isArray(r.filters) ? r.filters : [],
    datePreset: r.datePreset ?? 'this_year',
    chart: r.chart ?? fallback.chart,
  };
}

export function Statistics({ data, organizationId, canWrite, onChanged, openReportId }: {
  data: AppData;
  organizationId: string;
  canWrite: boolean;
  onChanged: () => void | Promise<void>;
  openReportId?: string | null;
}) {
  const [def, setDef] = useState<ReportDefinition>(() => defaultReportFor('invoices'));
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [name, setName] = useState('Naamloos rapport');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const source = REPORT_SOURCES[def.source];
  const result = useMemo(() => runReport(def, data), [def, data]);
  const loadedReport = loadedId ? data.savedReports.find(r => r.id === loadedId) ?? null : null;

  function loadDefinition(definition: ReportDefinition, reportName: string, id: string | null) {
    setDef(cloneDefinition(coerceDefinition(definition)));
    setName(reportName);
    setLoadedId(id);
    setError(null);
    setMessage(null);
  }

  // Open een specifiek rapport wanneer daarheen genavigeerd wordt (bv. via een dashboard-widget).
  useEffect(() => {
    if (!openReportId || openReportId === loadedId) return;
    const target = data.savedReports.find(r => r.id === openReportId);
    if (target) loadDefinition(target.definition, target.name, target.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openReportId, data.savedReports]);

  const dimensionFields = source.fields.filter(f => f.role === 'dimension');
  const enumFields = source.fields.filter(f => f.type === 'enum');
  const selectedDimField = def.dimension ? source.fields.find(f => f.key === def.dimension) ?? null : null;
  const charts = allowedCharts(selectedDimField);
  const measures = measureOptions(source);
  const format = (n: number) => formatMeasure(n, result.measureType);

  function changeSource(key: ReportSourceKey) { setDef(defaultReportFor(key)); }
  function changeMeasure(key: string) {
    const found = measures.find(o => measureKey(o.measure) === key);
    if (found) setDef(d => ({ ...d, measure: { ...found.measure } }));
  }
  function changeDimension(value: string) {
    const dimension = value || null;
    const field = dimension ? source.fields.find(f => f.key === dimension) ?? null : null;
    const next = allowedCharts(field);
    setDef(d => ({ ...d, dimension, chart: next.includes(d.chart) ? d.chart : next[0] }));
  }
  function setFilter(fieldKey: string, value: string) {
    setDef(d => {
      const others = d.filters.filter(f => f.field !== fieldKey);
      return { ...d, filters: value ? [...others, { field: fieldKey, value }] : others };
    });
  }

  async function save(asNew: boolean) {
    const clean = name.trim();
    if (!clean) { setError('Geef het rapport een naam.'); return; }
    setBusy(true); setError(null); setMessage(null);
    try {
      if (!asNew && loadedReport) {
        await updateSavedReport(organizationId, loadedReport.id, { name: clean, definition: def });
        setMessage('Rapport bijgewerkt.');
      } else {
        const created = await createSavedReport(organizationId, { name: clean, definition: def });
        setLoadedId(created.id);
        setMessage('Rapport opgeslagen onder “Mijn rapportages”.');
      }
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Opslaan mislukt.');
    } finally { setBusy(false); }
  }

  async function togglePin() {
    if (!loadedReport) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      await updateSavedReport(organizationId, loadedReport.id, { is_pinned: !loadedReport.is_pinned });
      setMessage(loadedReport.is_pinned ? 'Van het dashboard gehaald.' : 'Op het dashboard gepind.');
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Pinnen mislukt.');
    } finally { setBusy(false); }
  }

  async function remove(report: SavedReport) {
    if (!confirm(`Rapport “${report.name}” verwijderen?`)) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      await deleteSavedReport(organizationId, report.id);
      if (report.id === loadedId) { setLoadedId(null); setName('Naamloos rapport'); }
      setMessage('Rapport verwijderd.');
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verwijderen mislukt.');
    } finally { setBusy(false); }
  }

  function exportCsv() {
    const dimHeader = result.dimensionLabel ?? 'Totaal';
    const num = (v: number) => result.measureType === 'money' ? v.toFixed(2) : String(Math.round(v * 100) / 100);
    const rows = result.rows.map(r => [r.label, num(r.value)]);
    if (result.dimensionLabel) rows.push(['Totaal', num(result.total)]);
    downloadCsv(`${(name || 'rapport').replace(/[^\w-]+/g, '-').toLowerCase()}.csv`, [dimHeader, result.measureLabel], rows);
  }

  const avgPerGroup = result.groupCount > 0 ? result.total / result.groupCount : 0;
  const savedReports = data.savedReports;

  return (
    <div className="rb-page">
      <div className="rb-toolbar">
        <div className="rb-title-area">
          <Input className="rb-name-input" value={name} onChange={e => { setName(e.target.value); setMessage(null); }} aria-label="Rapportnaam" disabled={!canWrite} />
          {loadedReport?.is_pinned && <span className="rb-pin-badge"><Pin size={12} /> Op dashboard</span>}
        </div>
        <div className="rb-actions">
          <Button onClick={exportCsv} disabled={result.rows.length === 0}><Download size={14} /> CSV</Button>
          {canWrite && loadedReport && <Button onClick={togglePin} disabled={busy}>{loadedReport.is_pinned ? <><PinOff size={14} /> Losmaken</> : <><Pin size={14} /> Pin</>}</Button>}
          {canWrite && loadedReport && <Button onClick={() => save(true)} disabled={busy}>Opslaan als nieuw</Button>}
          {canWrite && <Button variant="primary" onClick={() => save(false)} disabled={busy}><Save size={14} /> {loadedReport ? 'Opslaan' : 'Rapport opslaan'}</Button>}
        </div>
      </div>

      {(error || message) && <div className={error ? 'error' : 'success'}>{error ?? message}</div>}

      <div className="rb-library">
        <div className="rb-lib-group">
          <span className="rb-lib-label">Mijn rapportages</span>
          {savedReports.length === 0
            ? <span className="rb-lib-empty">Nog geen opgeslagen rapportages.</span>
            : <div className="rb-chips">
                {savedReports.map(r => (
                  <span key={r.id} className={`rb-chip${r.id === loadedId ? ' is-active' : ''}`}>
                    <button type="button" className="rb-chip-open" onClick={() => loadDefinition(r.definition, r.name, r.id)}>
                      {r.is_pinned && <Pin size={11} />}{r.name}
                    </button>
                    {canWrite && <button type="button" className="rb-chip-del" onClick={() => remove(r)} title="Verwijderen" aria-label={`Verwijder ${r.name}`}><Trash2 size={12} /></button>}
                  </span>
                ))}
              </div>}
        </div>
        <div className="rb-lib-actions">
          <Select value="" onChange={e => { const t = REPORT_TEMPLATES.find(x => x.name === e.target.value); if (t) loadDefinition(t.definition, t.name, null); }} placeholder="Nieuw uit sjabloon…">
            {REPORT_TEMPLATES.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
          </Select>
          <Button onClick={() => loadDefinition(defaultReportFor('invoices'), 'Naamloos rapport', null)}><Plus size={14} /> Leeg</Button>
        </div>
      </div>

      <div className="rb-layout">
        <aside className="rb-config">
          <Field label="Bron">
            <Select value={def.source} onChange={e => changeSource(e.target.value as ReportSourceKey)}>
              {REPORT_SOURCE_ORDER.map(key => <option key={key} value={key}>{REPORT_SOURCES[key].label}</option>)}
            </Select>
          </Field>

          <Field label="Meetwaarde">
            <Select value={measureKey(def.measure)} onChange={e => changeMeasure(e.target.value)}>
              {measures.map(o => <option key={measureKey(o.measure)} value={measureKey(o.measure)}>{o.label}</option>)}
            </Select>
          </Field>

          <Field label="Groeperen op">
            <Select value={def.dimension ?? ''} onChange={e => changeDimension(e.target.value)}>
              <option value="">Geen (één totaal)</option>
              {dimensionFields.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
            </Select>
          </Field>

          {selectedDimField?.type === 'date' && (
            <Field label="Per periode">
              <Select value={def.granularity} onChange={e => setDef(d => ({ ...d, granularity: e.target.value as DateGranularity }))}>
                {(['day', 'week', 'month', 'quarter', 'year'] as DateGranularity[]).map(g => <option key={g} value={g}>{GRANULARITY_LABELS[g]}</option>)}
              </Select>
            </Field>
          )}

          <Field label="Periode">
            <Select value={def.datePreset} onChange={e => setDef(d => ({ ...d, datePreset: e.target.value as DateRangePreset }))}>
              {(Object.keys(DATE_PRESET_LABELS) as DateRangePreset[]).map(p => <option key={p} value={p}>{DATE_PRESET_LABELS[p]}</option>)}
            </Select>
          </Field>

          {enumFields.length > 0 && (
            <div className="rb-field">
              <div className="rb-field-label">Filters</div>
              <div className="rb-filters">
                {enumFields.map(f => {
                  const current = def.filters.find(x => x.field === f.key)?.value ?? '';
                  return (
                    <Select key={f.key} value={current} onChange={e => setFilter(f.key, e.target.value)}>
                      <option value="">Alle · {f.label}</option>
                      {f.enumValues?.map(v => <option key={v.value} value={v.value}>{f.label}: {v.label}</option>)}
                    </Select>
                  );
                })}
              </div>
            </div>
          )}

          <Field label="Weergave">
            <div className="bk-seg rb-chart-seg">
              {CHART_META.filter(c => charts.includes(c.type)).map(c => (
                <button key={c.type} className={def.chart === c.type ? 'is-active' : ''} onClick={() => setDef(d => ({ ...d, chart: c.type }))} title={c.label}>
                  <c.Icon size={14} /><span>{c.label}</span>
                </button>
              ))}
            </div>
          </Field>
        </aside>

        <section className="rb-preview">
          <div className="rb-kpis">
            <Kpi label={result.measureLabel} value={format(result.total)} accent />
            <Kpi label="Records" value={new Intl.NumberFormat('nl-NL').format(result.rowCount)} />
            {result.dimensionLabel && <Kpi label={result.dimensionLabel} value={new Intl.NumberFormat('nl-NL').format(result.groupCount)} />}
            {result.dimensionLabel && <Kpi label={`Gem. per ${result.dimensionLabel.toLowerCase()}`} value={format(avgPerGroup)} />}
          </div>

          <div className="rb-chart-card">
            {result.rowCount === 0
              ? <div className="rb-chart-empty">Geen gegevens in deze selectie. Pas de periode of filters aan.</div>
              : def.chart === 'bar' ? <BarChart rows={result.rows} format={format} />
              : def.chart === 'line' ? <LineChart rows={result.rows} format={format} />
              : def.chart === 'pie' ? <PieChart rows={result.rows} format={format} />
              : def.chart === 'kpi' ? <BigKpi label={result.measureLabel} value={format(result.total)} />
              : <ResultTable dimensionLabel={result.dimensionLabel} measureLabel={result.measureLabel} rows={result.rows} total={result.total} format={format} />}
          </div>
        </section>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="rb-field"><div className="rb-field-label">{label}</div>{children}</div>;
}

function Kpi({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return <div className={`rb-kpi${accent ? ' rb-kpi-accent' : ''}`}><div className="rb-kpi-label">{label}</div><div className="rb-kpi-val">{value}</div></div>;
}

function BigKpi({ label, value }: { label: string; value: string }) {
  return <div className="rb-bigkpi"><div className="rb-bigkpi-label">{label}</div><div className="rb-bigkpi-val">{value}</div></div>;
}

function ResultTable({ dimensionLabel, measureLabel, rows, total, format }: {
  dimensionLabel: string | null; measureLabel: string;
  rows: { key: string; label: string; value: number }[]; total: number; format: (n: number) => string;
}) {
  return (
    <div className="rb-table-wrap">
      <table className="rb-table">
        <thead><tr><th>{dimensionLabel ?? 'Totaal'}</th><th className="num">{measureLabel}</th></tr></thead>
        <tbody>{rows.map(r => <tr key={r.key}><td>{r.label}</td><td className="num">{format(r.value)}</td></tr>)}</tbody>
        {dimensionLabel && <tfoot><tr><td>Totaal</td><td className="num">{format(total)}</td></tr></tfoot>}
      </table>
    </div>
  );
}
