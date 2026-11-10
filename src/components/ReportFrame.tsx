import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReportData } from '../lib/aiReports';

/**
 * Het kader waarin een rapportage van Gerrie draait (public/rapport-weergave.html).
 *
 * sandbox="allow-scripts" zonder allow-same-origin: de pagina erin heeft geen
 * eigen herkomst, kan niet bij de sessie of de opslag van de app, kan geen
 * venster openen en geen formulier versturen. Het netwerk is daar dicht (CSP).
 * Daarom sturen we de gegevens er zelf in, met één bericht, en luisteren we
 * alleen naar berichten van dít kader.
 *
 * Elke nieuwe weergave (andere HTML, andere gegevens, ander thema) is een nieuw
 * kader: zo neemt de ene versie geen half script van de vorige mee.
 */

const FRAME_SRC = '/rapport-weergave.html';

/** De ResoFly-variabelen die het kader overneemt, zodat de pagina eruitziet als de rest van de app. */
const TOKENS = [
  '--bg', '--surface', '--surface-2', '--surface-3', '--well', '--line', '--line-2', '--line-3',
  '--ink', '--ink-2', '--ink-3', '--ink-4', '--accent', '--accent-ink', '--on-accent', '--accent-rgb',
  '--ok', '--warn', '--danger', '--info', '--note', '--ok-rgb', '--warn-rgb', '--danger-rgb', '--info-rgb',
  '--grid', '--r-xs', '--r-sm', '--r-md', '--r-lg', '--r-xl', '--r-card', '--shadow-card', '--font-sans',
];

function readTokens(from: Element | null): Record<string, string> {
  const style = getComputedStyle(from ?? document.documentElement);
  const out: Record<string, string> = {};
  for (const name of TOKENS) {
    const value = style.getPropertyValue(name).trim();
    if (value) out[name] = value;
  }
  return out;
}

function currentTheme(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

/** Verandert het thema of de stijl van de app, dan tekent het kader opnieuw. */
function useThemeKey(): string {
  const read = () => `${document.documentElement.getAttribute('data-theme') ?? ''}|${document.documentElement.getAttribute('data-look') ?? ''}`;
  const [key, setKey] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setKey(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-look'] });
    return () => observer.disconnect();
  }, []);
  return key;
}

let frameSeq = 0;

export function ReportFrame({ html, data, title, onError, onRendered }: {
  html: string;
  data: ReportData | null;
  title: string;
  onError?: (message: string) => void;
  onRendered?: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(420);
  const [stuck, setStuck] = useState(false);
  const themeKey = useThemeKey();
  // Een nieuw kader bij nieuwe inhoud: de sleutel verandert dan.
  const frameKey = useMemo(() => `rf-${++frameSeq}`, [html, data, themeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const handlers = useRef({ onError, onRendered });
  handlers.current = { onError, onRendered };

  useEffect(() => {
    let sent = false;
    setStuck(false);
    const timer = window.setTimeout(() => { if (!sent) setStuck(true); }, 10000);
    function onMessage(event: MessageEvent) {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const msg = event.data as { source?: string; type?: string; height?: number; message?: string } | null;
      if (!msg || msg.source !== 'rf-frame') return;
      if (msg.type === 'ready' && !sent) {
        sent = true;
        window.clearTimeout(timer);
        // Het kader heeft geen herkomst ("null"): '*' is de enige manier om het te bereiken.
        // Het bericht gaat alleen naar dít kader (contentWindow), dat we net zelf geladen hebben.
        frame.contentWindow?.postMessage({
          source: 'rf-host', type: 'render', html, data, title,
          theme: currentTheme(), tokens: readTokens(wrapRef.current),
        }, '*');
      } else if (msg.type === 'height' && typeof msg.height === 'number' && Number.isFinite(msg.height)) {
        setHeight(Math.max(120, Math.min(30000, Math.round(msg.height))));
      } else if (msg.type === 'error') {
        handlers.current.onError?.(String(msg.message ?? '').slice(0, 500));
      } else if (msg.type === 'rendered') {
        handlers.current.onRendered?.();
      }
    }
    window.addEventListener('message', onMessage);
    return () => { window.removeEventListener('message', onMessage); window.clearTimeout(timer); };
  }, [frameKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="aire-frame-wrap" ref={wrapRef}>
      <iframe
        key={frameKey}
        ref={frameRef}
        className="aire-frame"
        src={FRAME_SRC}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        title={title || 'Rapportage'}
        style={{ height }}
      />
      {stuck && <div className="aire-frame-stuck" role="alert">De weergave laadt niet. Ververs de pagina; lukt het daarna nog niet, meld het dan.</div>}
    </div>
  );
}
