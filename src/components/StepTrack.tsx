import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';

/**
 * Een stappenbalk met de klok erbij: gedeeld door Gerrie die een rapportage bouwt
 * (ReportBuilding) en een agent die aan het werk is (AgentWorkbench). De stijl
 * staat in rapportages.css (.aire-steps).
 */
export function StepTrack({ steps, phase, label = 'Voortgang', done = false }: { steps: readonly string[]; phase: number; label?: string; done?: boolean }) {
  return (
    <ol className="aire-steps" aria-label={label}>
      {steps.map((step, i) => {
        const finished = done || i < phase;
        const active = !done && i === phase;
        return (
          <li key={step} className={finished ? 'is-done' : active ? 'is-active' : undefined} aria-current={active ? 'step' : undefined}>
            <span className="aire-step-dot">{finished ? <Check size={11} strokeWidth={3} /> : null}</span>
            <span className="aire-step-label">{step}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Hoe lang iets al bezig is; tikt elke seconde. */
export function useElapsed(startedAt: number | null | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return startedAt ? Math.max(0, now - startedAt) : 0;
}
