import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { X } from 'lucide-react';
import type { OfficeSession } from '../lib/office';

/**
 * Volledig-scherm Collabora-editor. Collabora verwacht een POST met het WOPI-access_token
 * naar de editor-URL, gericht op een iframe — daarom laden we via een self-submitting form
 * i.p.v. het token in de URL te zetten. De canonieke opslag blijft R2 (via de WOPI-host).
 */
const FRAME_NAME = 'resofly-office-frame';

export function OfficeEditor({ session, onClose }: { session: OfficeSession; onClose: () => void }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'timeout'>('loading');

  useEffect(() => {
    setPhase('loading');
    formRef.current?.submit();
    // Collabora (cold start op CF Containers) kan tientallen seconden nodig hebben; toon na
    // 45s een nette fout-/opnieuw-status i.p.v. een blanco frame.
    const t = setTimeout(() => setPhase((p) => (p === 'loading' ? 'timeout' : p)), 45000);
    return () => clearTimeout(t);
  }, [session]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label={session.fileName}>
      <div style={bar}>
        <span style={titleStyle} title={session.fileName}>
          {session.fileName}{!session.canWrite && ' — alleen-lezen'}
        </span>
        <button type="button" onClick={onClose} style={closeBtn} aria-label="Editor sluiten">
          <X size={16} /> Sluiten
        </button>
      </div>
      <form ref={formRef} action={session.editorUrl} method="post" target={FRAME_NAME} style={{ display: 'none' }}>
        <input type="hidden" name="access_token" value={session.accessToken} />
        <input type="hidden" name="access_token_ttl" value={String(session.accessTokenExp)} />
      </form>
      <div style={frameWrap}>
        <iframe
          name={FRAME_NAME}
          title={session.fileName}
          style={frame}
          allow="clipboard-read; clipboard-write; fullscreen"
          onLoad={() => setPhase('ready')}
        />
        {phase !== 'ready' && (
          <div style={loadingOverlay}>
            {phase === 'loading' ? (
              <span>Editor wordt gestart…</span>
            ) : (
              <div style={{ textAlign: 'center', maxWidth: 420, padding: 16 }}>
                <p style={{ margin: '0 0 12px' }}>
                  De editor reageert niet. De Collabora-server start mogelijk nog op of is niet bereikbaar.
                </p>
                <button type="button" style={closeBtn} onClick={() => { setPhase('loading'); formRef.current?.submit(); }}>
                  Opnieuw proberen
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const overlay: CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 2000,
  background: 'var(--bg, #0b0b0b)', display: 'flex', flexDirection: 'column',
};
const bar: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
  height: 48, padding: '0 12px', borderBottom: '1px solid var(--border, #262626)', flex: '0 0 auto',
};
const titleStyle: CSSProperties = {
  fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const closeBtn: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px',
  border: '1px solid var(--border, #262626)', borderRadius: 8, background: 'transparent',
  color: 'inherit', cursor: 'pointer', flex: '0 0 auto',
};
const frameWrap: CSSProperties = { position: 'relative', flex: '1 1 auto', minHeight: 0 };
const frame: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 };
const loadingOverlay: CSSProperties = {
  position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
  gap: 8, background: 'var(--bg, #0b0b0b)', color: 'inherit',
};
