/**
 * Eén lopende timer voor de hele app.
 *
 * De timer zat opgesloten in `TimerCard` op de pagina Urenregistratie, met zijn
 * eigen stukje localStorage. Daardoor kon de weekplanner er niet bij: je zag een
 * taak voor je liggen en moest naar een ander scherm om de klok te starten, waar
 * je project en klant nog eens met de hand koos. En omdat elke component zijn
 * eigen state hield, wisten twee schermen niets van elkaars timer.
 *
 * Deze hook is de enige plek waar een lopende timer nog leeft. Hij synchroniseert
 * over componenten én over tabbladen (via het `storage`-event), zodat je nooit
 * twee klokken tegelijk aan het lopen krijgt.
 */
import { useCallback, useEffect, useState } from 'react';
import type { UUID } from '../types';

export interface RunningTimer {
  projectId: string;
  clientId: string;
  /** De taak waar deze klok bij hoort. Leeg = alleen op project/klant geboekt. */
  taskId: string;
  description: string;
  startedAt: string;
}

/** Naam van het gebeurtenis­type waarmee componenten in hetzelfde tabblad elkaar
 *  op de hoogte brengen; `storage` vuurt namelijk alleen in ándere tabbladen. */
const SYNC_EVENT = 'resofly-timer-changed';

function read(storageKey: string): RunningTimer | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RunningTimer>;
    if (!parsed || typeof parsed.startedAt !== 'string') return null;
    // `taskId` bestond nog niet toen de timer alleen op de urenpagina leefde;
    // een timer die al liep mag daar niet op stukvallen.
    return {
      projectId: parsed.projectId ?? '',
      clientId: parsed.clientId ?? '',
      taskId: parsed.taskId ?? '',
      description: parsed.description ?? '',
      startedAt: parsed.startedAt,
    };
  } catch {
    return null;
  }
}

export function useRunningTimer(storageKey: string) {
  const [running, setRunning] = useState<RunningTimer | null>(() => read(storageKey));

  useEffect(() => {
    const sync = () => setRunning(read(storageKey));
    window.addEventListener(SYNC_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(SYNC_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, [storageKey]);

  const persist = useCallback((next: RunningTimer | null) => {
    try {
      if (next) localStorage.setItem(storageKey, JSON.stringify(next));
      else localStorage.removeItem(storageKey);
    } catch {
      /* privémodus: de timer leeft dan alleen in dit tabblad */
    }
    setRunning(next);
    window.dispatchEvent(new Event(SYNC_EVENT));
  }, [storageKey]);

  return { running, persist };
}

/** Verstreken tijd als 00:00:00, live meelopend zolang er een klok draait. */
export function useElapsedLabel(startedAt: string | null): string {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const id = window.setInterval(() => setTick(t => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  if (!startedAt) return '00:00:00';
  const ms = Math.max(0, Date.now() - new Date(startedAt).getTime());
  const hh = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const mm = String(Math.floor(ms / 60000) % 60).padStart(2, '0');
  const ss = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** Hoeveel minuten er op een taak zijn geschreven. Zonder koppeling is dat nul —
 *  niet "onbekend", want een uur zonder taak hoort ook nergens bij een taak. */
export function loggedMinutesByTask(entries: { task_id: UUID | null; minutes: number }[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.task_id) continue;
    map.set(entry.task_id, (map.get(entry.task_id) ?? 0) + Math.max(0, entry.minutes));
  }
  return map;
}
