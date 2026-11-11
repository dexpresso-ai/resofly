import { useState, type CSSProperties } from 'react';
import { Sparkles } from 'lucide-react';
import { BUILD_STEPS, buildPatienceNote, formatElapsed, type BuildPhase } from '../lib/reportBuild';
import { StepTrack, useElapsed } from './StepTrack';

/**
 * Zolang Gerrie een rapportage bouwt: een klein dashboard dat zichzelf opbouwt.
 *
 * Wat je ziet volgt wat Gerrie echt doet (de stap uit gerrie-agent):
 *   lezen        → een blauwdruk met lege vakken, het poollicht denkt na;
 *   gegevens     → de staven en cijfers rekenen, het licht haalt op;
 *   bouwen       → de vakken vullen zich, staven groeien, de lijn tekent zich;
 *   controleren  → een lichtstraal loopt de pagina na.
 * Voorheen stond hier één pulserend icoon met een regel tekst. Een rapportage
 * bouwen duurt soms minuten, en dan leek het alsof hij vastzat.
 *
 * Alles is CSS (rapportages.css). Met "minder beweging" staat het stil, maar
 * zie je de stap nog wel aan het dashboard en aan de stappenbalk.
 */

const BARS = [0.42, 0.68, 0.5, 0.86, 0.6, 0.94, 0.74];
const LINE = 'M2 38 C14 34 20 20 32 23 S50 36 62 27 S80 8 93 13 S110 21 118 6';

type Vars = CSSProperties & Record<`--${string}`, string | number>;

/**
 * Bij de eerste opbouw krijgt het tabblad na een halve seconde het echte id en
 * wordt de pagina opnieuw gemaakt. De verschuiving laat de opbouw doorlopen waar
 * hij was, in plaats van opnieuw te beginnen.
 */
function useStageOffset(startedAt: number): string {
  const [offset] = useState(() => {
    const seconds = Math.min(30, Math.max(0, (Date.now() - startedAt) / 1000));
    return `${(-seconds).toFixed(2)}s`;
  });
  return offset;
}

function BuildStage({ phase, startedAt }: { phase: BuildPhase; startedAt: number }) {
  const offset = useStageOffset(startedAt);
  return (
    <div className="aire-stage" data-phase={phase} style={{ '--aire-t': offset } as Vars} aria-hidden="true">
      <div className="aire-sk aire-sk-title" style={{ '--i': 0 } as Vars}><i /><i /></div>
      <div className="aire-sk-kpis">
        {[1, 2, 3].map((i) => (
          <div key={i} className="aire-sk aire-sk-kpi" style={{ '--i': i } as Vars}><i /><b /></div>
        ))}
      </div>
      <div className="aire-sk aire-sk-bars" style={{ '--i': 4 } as Vars}>
        {BARS.map((h, j) => <span key={j} style={{ '--h': h, '--j': j } as Vars} />)}
      </div>
      <div className="aire-sk aire-sk-line" style={{ '--i': 5 } as Vars}>
        <svg viewBox="0 0 120 48" preserveAspectRatio="none">
          <path className="aire-sk-area" d={`${LINE} L118 48 L2 48 Z`} />
          <path className="aire-sk-path" d={LINE} />
        </svg>
      </div>
      <div className="aire-sk aire-sk-table" style={{ '--i': 6 } as Vars}>
        {[0, 1, 2].map((j) => <div key={j} className="aire-sk-row" style={{ '--j': j } as Vars}><i /><i /><i /></div>)}
      </div>
      <span className="aire-beam" />
      <span className="aire-orb"><i /><i /><i /><i /></span>
    </div>
  );
}

/** Een nieuwe rapportage, of een die nog geen inhoud heeft: de hele opbouw. */
export function ReportBuilding({ status, phase, startedAt }: { status: string | null; phase: BuildPhase; startedAt: number }) {
  const elapsed = useElapsed(startedAt);
  const patience = buildPatienceNote(elapsed);
  return (
    <section className="aire-build" aria-label="Gerrie bouwt je rapportage">
      <BuildStage phase={phase} startedAt={startedAt} />
      <div className="aire-build-info">
        <div className="aire-build-head">
          <span className="aire-build-badge" aria-hidden="true"><Sparkles size={15} /></span>
          <div className="aire-build-text">
            <b>Gerrie bouwt je rapportage</b>
            <span className="aire-build-status" role="status">{status ?? 'Even geduld…'}</span>
          </div>
          <span className="aire-build-time" title="Zo lang is Gerrie al bezig">{formatElapsed(elapsed)}</span>
        </div>
        <StepTrack steps={BUILD_STEPS} phase={phase} />
        <p className="aire-build-note">{patience ?? 'Je kunt intussen gewoon verder werken; de pagina blijft hier staan.'}</p>
      </div>
    </section>
  );
}

/** Een bestaande rapportage aanpassen: de pagina blijft staan, met een balk erover. */
export function ReportUpdating({ status, phase, startedAt }: { status: string | null; phase: BuildPhase; startedAt: number }) {
  const elapsed = useElapsed(startedAt);
  return (
    <div className="aire-updating" role="status">
      <span className="aire-mini-orb" aria-hidden="true" />
      <span className="aire-updating-text">
        <b>Gerrie past je rapportage aan</b>
        <span>{status ?? 'Even geduld…'}</span>
      </span>
      <span className="aire-mini-steps" aria-hidden="true">
        {BUILD_STEPS.map((label, i) => <i key={label} className={i < phase ? 'is-done' : i === phase ? 'is-active' : undefined} />)}
      </span>
      <span className="aire-build-time">{formatElapsed(elapsed)}</span>
    </div>
  );
}
