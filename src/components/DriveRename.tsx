import { useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { fileStem } from '../lib/rename';

/**
 * Het naamveld dat in de verkenner over de rij- of tegelnaam heen verschijnt, precies
 * zoals in Windows: de huidige naam staat er al in met alleen het deel vóór de
 * extensie geselecteerd, Enter bevestigt, Escape annuleert en klikken buiten het veld
 * bevestigt ook. Klik- en toetsaanslagen blijven binnen het veld, zodat de rij eronder
 * niet alsnog opent en Escape niet stiekem het ⋮-menu sluit in plaats van het veld.
 */
export function DriveRenameInput({ value, keepExtension, onCommit, onCancel }: {
  value: string;
  /** Bestanden houden hun extensie; mappen, notities en documenten dragen een titel. */
  keepExtension?: boolean;
  onCommit: (typed: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  /** Enter en Escape hebben het al afgehandeld; de onBlur erna mag niets meer doen. */
  const settled = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(0, (keepExtension ? fileStem(value) : value).length);
  }, [value, keepExtension]);

  function settle(commit: boolean) {
    if (settled.current) return;
    settled.current = true;
    if (commit) onCommit(ref.current?.value ?? '');
    else onCancel();
  }

  return <input
    ref={ref}
    className="odrv-rename"
    defaultValue={value}
    aria-label="Nieuwe naam"
    spellCheck={false}
    autoComplete="off"
    onClick={e => e.stopPropagation()}
    onMouseDown={e => e.stopPropagation()}
    onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); settle(true); }
      else if (e.key === 'Escape') { e.preventDefault(); settle(false); }
    }}
    onBlur={() => settle(true)}
  />;
}
