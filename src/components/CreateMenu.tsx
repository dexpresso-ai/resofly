import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { CheckSquare, ChevronDown, FileText, FolderOpen, Plus, Receipt, StickyNote, Ticket, Users, type LucideIcon } from 'lucide-react';
import { useBackStep } from '../lib/useBackStep';

/** Wat je vanuit de bovenbalk kunt maken. Elk soort opent hetzelfde
 *  bewerkvenster als de knop "+ Nieuw" op zijn eigen pagina. */
export type CreateKind = 'task' | 'client' | 'project' | 'ticket' | 'note' | 'quote' | 'invoice';

const KINDS: Record<CreateKind, { label: string; hint: string; Icon: LucideIcon }> = {
  task: { label: 'Taak', hint: 'los, of bij een klant of project', Icon: CheckSquare },
  client: { label: 'Klant', hint: 'met contactgegevens', Icon: Users },
  project: { label: 'Project', hint: 'met planning en taken', Icon: FolderOpen },
  ticket: { label: 'Ticket', hint: 'een vraag of melding', Icon: Ticket },
  note: { label: 'Notitie', hint: 'bij een klant of project', Icon: StickyNote },
  quote: { label: 'Offerte', hint: 'als concept', Icon: FileText },
  invoice: { label: 'Factuur', hint: 'als concept', Icon: Receipt },
};

/** De volgorde in het menu: eerst het dagelijkse werk, dan het geld. */
export const CREATE_ORDER: CreateKind[] = ['task', 'client', 'project', 'ticket', 'note', 'quote', 'invoice'];

/**
 * De gouden hoofdknop rechtsboven in Baken, zoals "Nieuwe taak" in Value
 * Backlog. Er staan alleen soorten in die dit teamlid mag maken (de aanroeper
 * filtert op de modulerechten); zonder één soort staat de knop er niet.
 * Er wordt niets aangemaakt zonder het venster: de knop opent het, jij slaat op.
 */
export function CreateMenu({ kinds, onCreate, busy = false }: {
  kinds: CreateKind[];
  onCreate: (kind: CreateKind) => void;
  /** Er staat al een bewerkvenster open in dit tabblad. Een nieuw venster zou
   *  dat vervangen, en daarmee wat je er al in typte; de knop wacht dus tot
   *  het dicht is. (Het menu viel bovendien onder de achtergrond van het
   *  venster: je zag het wel, maar kon er niets in kiezen.) */
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  // De terugknop van de telefoon sluit het menu, zoals een klik ernaast.
  useBackStep(open, () => setOpen(false));

  useEffect(() => { if (busy) setOpen(false); }, [busy]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    // Het menu opent met de focus op de eerste regel, zodat je met de pijltjes
    // verder kunt (menu-button-patroon).
    boxRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  if (kinds.length === 0) return null;

  function close(refocus: boolean) {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
    if (event.key === 'Tab') { setOpen(false); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(boxRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? (index + 1) % items.length
      : (index - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  return <div className="bk-create" ref={boxRef}>
    <button
      ref={triggerRef}
      type="button"
      className="btn btn-primary bk-create-btn"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      disabled={busy}
      title={busy ? 'Sluit eerst het venster dat openstaat' : undefined}
      onClick={() => setOpen(value => !value)}
      onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); } }}
    >
      <Plus size={17} strokeWidth={2.6} aria-hidden="true" />
      <span className="bk-create-label">Nieuw</span>
      <ChevronDown size={14} strokeWidth={2.4} className="bk-create-caret" aria-hidden="true" />
    </button>
    {open && <div id={menuId} className="bk-create-menu" role="menu" aria-label="Nieuw maken" onKeyDown={onMenuKeyDown}>
      {kinds.map(kind => {
        const { label, hint, Icon } = KINDS[kind];
        return <button
          key={kind}
          type="button"
          role="menuitem"
          className={`bk-create-item is-${kind}`}
          onClick={() => { close(false); onCreate(kind); }}
        >
          <span className="bk-create-ico" aria-hidden="true"><Icon size={16} strokeWidth={2.1} /></span>
          <span className="bk-create-t"><b>{label}</b><small>{hint}</small></span>
        </button>;
      })}
    </div>}
  </div>;
}
