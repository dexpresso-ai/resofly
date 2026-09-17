import { useEffect, useState } from 'react';

/**
 * Onder deze grens past er geen tweede kolom naast een gesprek. Zelfde waarde
 * als de mobiele regels in globals.css, zodat React en CSS nooit uit elkaar
 * lopen: de een toont één venster, de ander rekent met twee.
 */
export const NARROW_VIEWPORT_QUERY = '(max-width:760px)';

/** Volgt of de viewport smal is (telefoon, of een heel smal venster). */
export function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(NARROW_VIEWPORT_QUERY).matches);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia(NARROW_VIEWPORT_QUERY);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}
