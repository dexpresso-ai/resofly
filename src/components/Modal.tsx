import type { ReactNode } from 'react';
import { useBackStep } from '../lib/useBackStep';

export function Modal({ title, children, footer, onClose, className = '' }: { title: string; children: ReactNode; footer?: ReactNode; onClose: () => void; className?: string }) {
  // De terugknop van de telefoon sluit het venster, net als het kruisje.
  useBackStep(true, onClose);
  return <div className="modal-bg open" onMouseDown={onClose}>
    <section className={`modal ${className}`.trim()} onMouseDown={(e) => e.stopPropagation()}>
      <header className="modal-head"><h3>{title}</h3><button className="modal-close" onClick={onClose}>×</button></header>
      <div className="modal-body">{children}</div>
      {footer && <footer className="modal-foot">{footer}</footer>}
    </section>
  </div>;
}
