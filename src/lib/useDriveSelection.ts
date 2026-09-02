import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

/**
 * Selecteren in de verkenner, met dezelfde toetsen als de Verkenner zelf:
 * gewoon klikken opent (dat blijft zo), Ctrl/⌘-klik zet er eentje bij of af, en
 * Shift-klik pakt alles tussen je vorige keuze en deze rij.
 *
 * De selectie leeft op rij-sleutels (`Row.key`), niet op database-id's: zo blijft
 * hij kloppen als dezelfde notitie op twee plekken in beeld kan staan. Verdwijnt
 * een rij (verwijderd, verplaatst, gefilterd), dan valt hij vanzelf uit de
 * selectie — vandaar het snoeien op de zichtbare sleutels.
 */
export type DriveSelection<T> = {
  /** De aangevinkte rij-sleutels, in de volgorde van de lijst. */
  keys: string[];
  /** De aangevinkte rijen zelf. */
  items: T[];
  count: number;
  has: (key: string) => boolean;
  /** Klik op een rij: geeft `true` terug als de klik de selectie was (en dus niet moet openen). */
  handleRowClick: (event: ReactMouseEvent, key: string) => boolean;
  /** Het vinkje links van het icoon. */
  toggle: (key: string) => void;
  selectAll: () => void;
  clear: () => void;
  /** Wat er meegaat als je gaat slepen: de hele selectie, of alleen deze rij. */
  dragKeys: (key: string) => string[];
};

export function useDriveSelection<T>(
  visible: Array<{ key: string; row: T; selectable: boolean }>,
): DriveSelection<T> {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const anchorRef = useRef<string | null>(null);

  // `visible` is elke render een nieuwe array (de rijen worden opnieuw opgebouwd),
  // dus memoïseren op de array zelf levert niets op. De sleutels eruit vormen wél
  // een stabiele waarde: verandert er niets aan de lijst, dan blijft alles hieronder
  // dezelfde identiteit houden en draait het opschonen niet elke render opnieuw.
  const keySignature = visible.filter(entry => entry.selectable).map(entry => entry.key).join(String.fromCharCode(0));
  const selectableKeys = useMemo(
    () => (keySignature ? keySignature.split(String.fromCharCode(0)) : []),
    [keySignature],
  );
  const selectableSet = useMemo(() => new Set(selectableKeys), [selectableKeys]);

  // Snoei alles wat niet meer in beeld is. Zonder dit zou een verplaatst of
  // verwijderd item onzichtbaar geselecteerd blijven en stilletjes meegaan met de
  // volgende actie.
  useEffect(() => {
    setSelected(current => {
      if (current.size === 0) return current;
      const next = new Set<string>();
      for (const key of current) if (selectableSet.has(key)) next.add(key);
      return next.size === current.size ? current : next;
    });
  }, [selectableSet]);

  const clear = useCallback(() => {
    anchorRef.current = null;
    setSelected(current => (current.size === 0 ? current : new Set()));
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(selectableKeys));
  }, [selectableKeys]);

  const toggle = useCallback((key: string) => {
    if (!selectableSet.has(key)) return;
    anchorRef.current = key;
    setSelected(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, [selectableSet]);

  const handleRowClick = useCallback((event: ReactMouseEvent, key: string): boolean => {
    if (!selectableSet.has(key)) return false;

    if (event.shiftKey) {
      event.preventDefault();
      const anchor = anchorRef.current ?? key;
      const from = selectableKeys.indexOf(anchor);
      const to = selectableKeys.indexOf(key);
      if (from === -1 || to === -1) { toggle(key); return true; }
      const [start, end] = from <= to ? [from, to] : [to, from];
      setSelected(new Set(selectableKeys.slice(start, end + 1)));
      return true;
    }

    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      toggle(key);
      return true;
    }

    // Gewone klik met een lopende selectie: eerst opruimen, dan pas openen. Zo
    // kun je nooit iets openen terwijl er ongemerkt nog vijf dingen aanstaan.
    if (selected.size > 0) clear();
    return false;
  }, [selectableSet, selectableKeys, selected.size, toggle, clear]);

  const dragKeys = useCallback((key: string): string[] => {
    if (selected.has(key) && selected.size > 1) return selectableKeys.filter(k => selected.has(k));
    return [key];
  }, [selected, selectableKeys]);

  const keys = useMemo(() => selectableKeys.filter(key => selected.has(key)), [selectableKeys, selected]);
  const items = useMemo(() => {
    const byKey = new Map(visible.map(entry => [entry.key, entry.row] as const));
    return keys.map(key => byKey.get(key)).filter((row): row is T => row !== undefined);
  }, [visible, keys]);

  return {
    keys,
    items,
    count: keys.length,
    has: (key: string) => selected.has(key),
    handleRowClick,
    toggle,
    selectAll,
    clear,
    dragKeys,
  };
}
