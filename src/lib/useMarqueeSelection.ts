import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import {
  clampPoint, combineMarquee, edgeScrollSpeed, hitKeys, marqueeBox, marqueeMode, passedThreshold,
  type MarqueeMode, type Point,
} from './marquee';

/**
 * Selecteren met een kader, zoals in de Verkenner van Windows: druk op een lege
 * plek in de lijst, sleep, en alles wat het kader raakt wordt geselecteerd. Shift
 * voegt toe aan wat er al aanstond, Ctrl (of ⌘) schakelt om, en een klik op lege
 * ruimte zonder te slepen wist de selectie. Sleep je tegen de rand aan, dan
 * scrolt de lijst mee.
 *
 * Rijen en tegels melden zich aan met `data-selkey`; alles daarbuiten telt als
 * lege ruimte, behalve knoppen, invoervelden, menu's, de kolomkoppen en de
 * selectiebalk. Met een vinger is slepen scrollen; dit is puur voor de muis.
 *
 * Het kader leeft in de inhoudscoördinaten van de scrollende container, zodat het
 * gewoon meescrolt en de rijen in dezelfde ruimte gemeten kunnen worden.
 */
export type MarqueeRect = { left: number; top: number; width: number; height: number };

type Drag = {
  start: Point;
  mode: MarqueeMode;
  base: Set<string>;
  /** Grootte van de inhoud bij het begin, zodat het kader die niet laat groeien. */
  bounds: { width: number; height: number };
  /** Voorbij de drempel: dan pas tekenen en selecteren. */
  active: boolean;
  last: { clientX: number; clientY: number };
  raf: number | null;
};

const NOT_EMPTY_SPACE = '[data-selkey], .odrv-thead, .odrv-selbar, button, input, textarea, select, label, a, [role="menu"], [contenteditable="true"]';

function contentPoint(el: HTMLElement, clientX: number, clientY: number): Point {
  const rect = el.getBoundingClientRect();
  return { x: clientX - rect.left + el.scrollLeft, y: clientY - rect.top + el.scrollTop };
}

export function useMarqueeSelection({ enabled, getBase, apply, clear }: {
  enabled: boolean;
  /** De selectie bij het begin van de sleep — het uitgangspunt voor Shift en Ctrl. */
  getBase: () => Set<string>;
  /** Zet de selectie zoals het kader hem berekend heeft. */
  apply: (next: Set<string>) => void;
  /** Een klik op lege ruimte, zonder sleep. */
  clear: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [rect, setRect] = useState<MarqueeRect | null>(null);

  // De callbacks van de aanroeper veranderen per render; de sleep leest ze via een ref
  // zodat de window-listeners nooit een verouderde versie vasthouden.
  const callbacks = useRef({ getBase, apply, clear });
  callbacks.current = { getBase, apply, clear };

  const update = useCallback((clientX: number, clientY: number) => {
    const el = containerRef.current;
    const d = drag.current;
    if (!el || !d) return;
    const current = clampPoint(contentPoint(el, clientX, clientY), d.bounds);
    if (!d.active) {
      if (!passedThreshold(d.start, current)) return;
      d.active = true;
    }
    const box = marqueeBox(d.start, current);
    setRect({ left: box.left, top: box.top, width: box.right - box.left, height: box.bottom - box.top });

    // Rijen meten in dezelfde inhoudscoördinaten als het kader.
    const origin = el.getBoundingClientRect();
    const targets = Array.from(el.querySelectorAll<HTMLElement>('[data-selkey]')).map(node => {
      const b = node.getBoundingClientRect();
      return {
        key: node.dataset.selkey as string,
        box: {
          left: b.left - origin.left + el.scrollLeft,
          top: b.top - origin.top + el.scrollTop,
          right: b.right - origin.left + el.scrollLeft,
          bottom: b.bottom - origin.top + el.scrollTop,
        },
      };
    });
    callbacks.current.apply(combineMarquee(d.base, hitKeys(box, targets), d.mode));
  }, []);

  /** Elke frame: scrolt de lijst (of de pagina) mee als de muis bij de rand hangt. */
  const autoScroll = useCallback(() => {
    const el = containerRef.current;
    const d = drag.current;
    if (!el || !d) return;
    if (d.active) {
      const bounds = el.getBoundingClientRect();
      const scrollsItself = el.scrollHeight > el.clientHeight + 1;
      const top = scrollsItself ? bounds.top : 0;
      const bottom = scrollsItself ? bounds.bottom : window.innerHeight;
      const dy = edgeScrollSpeed(d.last.clientY, top, bottom);
      if (dy !== 0) {
        if (scrollsItself) el.scrollTop += dy; else window.scrollBy(0, dy);
        update(d.last.clientX, d.last.clientY);
      }
    }
    d.raf = requestAnimationFrame(autoScroll);
  }, [update]);

  const finish = useCallback((cancelled: boolean) => {
    const d = drag.current;
    if (!d) return;
    if (d.raf !== null) cancelAnimationFrame(d.raf);
    drag.current = null;
    setRect(null);
    if (cancelled) {
      if (d.active) callbacks.current.apply(d.base);
      return;
    }
    // Klik op lege ruimte zonder te slepen: zoals in de Verkenner wist dat de selectie —
    // tenzij je Ctrl of Shift vasthield, dan was het duidelijk niet de bedoeling.
    if (!d.active && d.mode === 'replace') callbacks.current.clear();
  }, []);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      d.last = { clientX: event.clientX, clientY: event.clientY };
      update(event.clientX, event.clientY);
    };
    const onUp = () => finish(false);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && drag.current) finish(true); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('keydown', onKey);
      if (drag.current?.raf !== null && drag.current?.raf !== undefined) cancelAnimationFrame(drag.current.raf);
    };
  }, [update, finish]);

  const onMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!enabled || event.button !== 0 || drag.current) return;
    const el = containerRef.current;
    if (!el || !(event.target instanceof Element)) return;
    if (event.target.closest(NOT_EMPTY_SPACE)) return;
    // De schuifbalk hoort bij de container, maar is geen lege ruimte.
    const bounds = el.getBoundingClientRect();
    if (event.clientX > bounds.left + el.clientWidth || event.clientY > bounds.top + el.clientHeight) return;

    // Een naamveld dat nog openstaat moet gewoon zijn wijziging bevestigen (dat doet
    // het bij blur); daarna kan het kader beginnen.
    const focused = document.activeElement;
    if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) focused.blur();

    event.preventDefault(); // geen tekstselectie tijdens het slepen
    el.focus({ preventScroll: true }); // zodat Ctrl+A daarna de lijst bereikt

    drag.current = {
      start: contentPoint(el, event.clientX, event.clientY),
      mode: marqueeMode(event),
      base: callbacks.current.getBase(),
      bounds: { width: el.scrollWidth, height: el.scrollHeight },
      active: false,
      last: { clientX: event.clientX, clientY: event.clientY },
      raf: null,
    };
    drag.current.raf = requestAnimationFrame(autoScroll);
  }, [enabled, autoScroll]);

  return { containerRef, rect, active: rect !== null, onMouseDown };
}
