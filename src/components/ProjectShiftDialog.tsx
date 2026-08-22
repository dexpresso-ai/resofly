/**
 * "Dit project schuift op — moet zijn werk mee?"
 *
 * De projecttijdbalk tekent `projects.start_date`/`end_date`, de weekplanner
 * taakdatums, en op de projectkanban komt `planned_date` niet voor. Verzet je
 * een project twee weken, dan bleven de ingeplande taken staan waar ze stonden.
 * Dat is geen ontbrekende functie maar een stille fout: je merkt hem pas als de
 * week eromheen niet meer klopt.
 *
 * De vraag komt daarom alleen daar waar je bewust een datum verandert — niet bij
 * elke sleep in de planner.
 */
import { useState } from 'react';
import { Modal } from './Modal';
import { Button } from './Ui';
import type { Project, Task, UUID } from '../types';

export type ProjectShift = { project: Project; days: number; tasks: Task[] };

function shiftKey(key: string, days: number): string {
  const [year, month, day] = key.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, (month ?? 1) - 1, (day ?? 1) + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

function dayLabel(key: string): string {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1)
    .toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });
}

export function ProjectShiftDialog({ shift, busy, onCancel, onConfirm }: {
  shift: ProjectShift;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (taskIds: UUID[], shiftDeadlines: boolean) => void;
}) {
  // Standaard gaat alles mee: dat is bijna altijd de bedoeling, en uitvinken is
  // sneller dan alles aanvinken.
  const [skipped, setSkipped] = useState<UUID[]>([]);
  // Deadlines standaard NIET: anders staat elke taak ineens ná zijn eigen
  // deadline, en dat is een inhoudelijke afspraak met je klant.
  const [shiftDeadlines, setShiftDeadlines] = useState(false);

  const chosen = shift.tasks.filter(task => !skipped.includes(task.id));
  const direction = shift.days > 0 ? 'op' : 'terug';
  const count = Math.abs(shift.days);

  return <Modal
    title="Schuift het werk mee?"
    onClose={onCancel}
    footer={<>
      <Button onClick={onCancel} disabled={busy}>Laat staan</Button>
      <Button
        variant="primary"
        disabled={busy || chosen.length === 0}
        onClick={() => onConfirm(chosen.map(task => task.id), shiftDeadlines)}
      >
        {busy ? 'Bezig…' : `Schuif ${chosen.length} ${chosen.length === 1 ? 'taak' : 'taken'} mee`}
      </Button>
    </>}
  >
    <p className="ps-lede">
      <strong>{shift.project.name}</strong> schuift {count} {count === 1 ? 'dag' : 'dagen'} {direction}.
      Er {shift.tasks.length === 1 ? 'staat 1 taak' : `staan ${shift.tasks.length} taken`} van dit project ingepland.
    </p>

    <ul className="ps-list">
      {shift.tasks.map(task => {
        const checked = !skipped.includes(task.id);
        return <li key={task.id}>
          <label>
            <input
              type="checkbox"
              checked={checked}
              onChange={() => setSkipped(prev => checked ? [...prev, task.id] : prev.filter(id => id !== task.id))}
            />
            <span className="ps-title">{task.title}</span>
            <span className="ps-move">
              {dayLabel(task.planned_date!)} → {dayLabel(shiftKey(task.planned_date!, shift.days))}
            </span>
          </label>
        </li>;
      })}
    </ul>

    <label className="ps-deadlines">
      <input type="checkbox" checked={shiftDeadlines} onChange={e => setShiftDeadlines(e.target.checked)} />
      <span>
        Ook de deadlines meeschuiven
        <em>Laat je dit uit, dan blijven de afgesproken deadlines staan — en kan een taak ná zijn deadline komen te liggen.</em>
      </span>
    </label>
  </Modal>;
}
