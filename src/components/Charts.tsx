// Lichte, dependency-vrije grafieken voor de rapportbouwer. Staafdiagram in CSS
// (consistent met ProfitLoss/Dashboard), lijn- en taartdiagram in pure SVG.
// Elke grafiek krijgt al-geaggregeerde rijen + een waardeformatter.
import { useId } from 'react';
import type { ReportRow } from '../lib/reporting';

// On-brand palet, afgeleid van de workspace-accenttokens.
const PALETTE = ['#FFD966', '#34d399', '#a78bfa', '#FF9F43', '#f06b6b', '#60A5FA', '#2DD4BF', '#F472B6', '#FACC15', '#94A3B8'];

type ChartProps = { rows: ReportRow[]; format: (n: number) => string };

function capRows(rows: ReportRow[], max: number): ReportRow[] {
  if (rows.length <= max) return rows;
  const top = rows.slice(0, max - 1);
  const restSum = rows.slice(max - 1).reduce((s, r) => s + r.value, 0);
  return [...top, { key: '__rest', label: 'Overig', value: restSum }];
}

export function BarChart({ rows, format }: ChartProps) {
  const shown = capRows(rows, 12);
  const max = shown.reduce((m, r) => Math.max(m, r.value), 0);
  if (shown.length === 0) return <ChartEmpty />;
  return (
    <div className="rb-bars">
      {shown.map(r => {
        const pct = max > 0 ? Math.max(0, (r.value / max) * 100) : 0;
        return (
          <div className="rb-bar-row" key={r.key}>
            <span className="rb-bar-label" title={r.label}>{r.label}</span>
            <span className="rb-bar-track"><span className="rb-bar-fill" style={{ width: `${pct}%` }} /></span>
            <span className="rb-bar-val">{format(r.value)}</span>
          </div>
        );
      })}
    </div>
  );
}

export function LineChart({ rows, format }: ChartProps) {
  if (rows.length === 0) return <ChartEmpty />;
  const W = 760, H = 260, padL = 56, padR = 16, padT = 16, padB = 34;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0) || 1;
  const n = rows.length;
  const x = (i: number) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => padT + innerH - (v / max) * innerH;
  const points = rows.map((r, i) => `${x(i)},${y(r.value)}`).join(' ');
  const areaPath = `M ${x(0)},${padT + innerH} L ${points.split(' ').join(' L ')} L ${x(n - 1)},${padT + innerH} Z`;
  const labelEvery = Math.max(1, Math.ceil(n / 8));
  return (
    <svg className="rb-svg" viewBox={`0 0 ${W} ${H}`} role="img" preserveAspectRatio="xMidYMid meet">
      {[0, 0.5, 1].map(t => {
        const gy = padT + innerH - t * innerH;
        return (
          <g key={t}>
            <line x1={padL} y1={gy} x2={W - padR} y2={gy} stroke="var(--border)" strokeWidth={1} />
            <text x={padL - 8} y={gy + 4} textAnchor="end" className="rb-svg-axis">{format(max * t)}</text>
          </g>
        );
      })}
      <path d={areaPath} fill="rgba(255,217,102,.10)" stroke="none" />
      <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
      {rows.map((r, i) => <circle key={r.key} cx={x(i)} cy={y(r.value)} r={3.5} fill="var(--accent)" />)}
      {rows.map((r, i) => (i % labelEvery === 0 || i === n - 1)
        ? <text key={`l${r.key}`} x={x(i)} y={H - 12} textAnchor="middle" className="rb-svg-axis">{r.label}</text>
        : null)}
    </svg>
  );
}

export function PieChart({ rows, format }: ChartProps) {
  const shown = capRows(rows.filter(r => r.value > 0), 8);
  const sum = shown.reduce((s, r) => s + r.value, 0);
  if (sum <= 0) return <ChartEmpty />;
  const cx = 110, cy = 110, r = 100;
  let angle = -Math.PI / 2;
  const slices = shown.map((row, i) => {
    const frac = row.value / sum;
    const start = angle;
    const end = angle + frac * Math.PI * 2;
    angle = end;
    const large = end - start > Math.PI ? 1 : 0;
    const x1 = cx + r * Math.cos(start), y1 = cy + r * Math.sin(start);
    const x2 = cx + r * Math.cos(end), y2 = cy + r * Math.sin(end);
    const d = frac >= 0.9999
      ? `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} Z`
      : `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
    return { row, d, color: PALETTE[i % PALETTE.length], pct: Math.round(frac * 100) };
  });
  return (
    <div className="rb-pie-wrap">
      <svg className="rb-pie-svg" viewBox="0 0 220 220" role="img">
        {slices.map(s => <path key={s.row.key} d={s.d} fill={s.color} stroke="var(--bg2)" strokeWidth={1.5} />)}
        <circle cx={cx} cy={cy} r={54} fill="var(--bg2)" />
      </svg>
      <div className="rb-pie-legend">
        {slices.map(s => (
          <div className="rb-pie-legend-row" key={s.row.key}>
            <span className="rb-pie-dot" style={{ background: s.color }} />
            <span className="rb-pie-legend-label" title={s.row.label}>{s.row.label}</span>
            <span className="rb-pie-legend-val">{format(s.row.value)}</span>
            <span className="rb-pie-legend-pct">{s.pct}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ChartEmpty() {
  return <div className="rb-chart-empty">Geen gegevens om weer te geven voor deze selectie.</div>;
}

/** Compacte trendlijn voor statkaarten: één reeks, geen assen of legenda — de
 *  kaartkop en het bedrag dragen de betekenis, de lijn toont alleen de richting.
 *  Bewust `aria-hidden`: de waarde en het trendpercentage staan al als tekst in
 *  de kaart, dus voor schermlezers zou de lijn enkel ruis zijn. */
export function Sparkline({ values, tone = 'accent' }: { values: number[]; tone?: 'accent' | 'danger' }) {
  const gradientId = useId();
  if (values.length < 2) return null;

  const W = 96, H = 30, pad = 3;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (values.length - 1)) * (W - pad * 2);
  const y = (v: number) => pad + (1 - (v - min) / span) * (H - pad * 2);

  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const area = `M ${x(0).toFixed(1)},${H - pad} L ${points.join(' L ')} L ${x(values.length - 1).toFixed(1)},${H - pad} Z`;
  const stroke = tone === 'danger' ? 'var(--accent-r)' : 'var(--accent)';

  return (
    <svg className="sc-spark" viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={stroke} stopOpacity=".3" />
          <stop offset="1" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <polyline points={points.join(' ')} fill="none" stroke={stroke} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r={2.2} fill={stroke} />
    </svg>
  );
}
