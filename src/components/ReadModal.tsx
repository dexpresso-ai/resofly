import { useEffect } from 'react';
import { sanitizeEmailHtml } from '../lib/sanitizeHtml';

/** Leesvenster voor een gedeelde notitie of tekstdocument. Sluit op Escape en op
 *  een klik buiten het venster, net als de rest van de app. */
export function ReadModal({ title, html, onClose }: { title: string; html: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return <div className="modal-bg open" onMouseDown={onClose}>
    <section className="modal share-read-modal" role="dialog" aria-modal="true" aria-label={title} onMouseDown={e => e.stopPropagation()}>
      <header className="modal-head">
        <h3>{title}</h3>
        <button className="modal-close" aria-label="Sluiten" onClick={onClose}>×</button>
      </header>
      <div className="modal-body">
        <div className="rich-text-viewer" dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(html) }} />
      </div>
    </section>
  </div>;
}

