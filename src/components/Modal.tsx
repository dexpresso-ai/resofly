import type { ReactNode } from 'react';

export function Modal({ title, children, footer, onClose, className = '' }: { title: string; children: ReactNode; footer?: ReactNode; onClose: () => void; className?: string }) {
  return <div className="modal-bg open" onMouseDown={onClose}>
    <section className={`modal ${className}`.trim()} onMouseDown={(e) => e.stopPropagation()}>
      <header className="modal-head"><h3>{title}</h3><button className="modal-close" onClick={onClose}>×</button></header>
      <div className="modal-body">{children}</div>
      {footer && <footer className="modal-foot">{footer}</footer>}
    </section>
  </div>;
}
