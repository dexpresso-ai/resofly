import type { ClientEmail, ClientEmailStatus } from '../types';
import { sanitizeEmailHtml } from '../lib/sanitizeHtml';

/**
 * Eén e-mailbericht in een klantgesprek, plus de tekstjes eromheen. Gedeeld
 * door het klantdossier (tabblad Communicatie) en de pagina Berichten, zodat
 * een bericht er overal hetzelfde uitziet en "Verwijderen" op beide plekken
 * hetzelfde doet.
 */

export const CLIENT_EMAIL_STATUS_LABELS: Record<ClientEmailStatus, string> = {
  queued: 'In wachtrij',
  sent: 'Verzonden',
  delivered: 'Afgeleverd',
  opened: 'Geopend',
  clicked: 'Link geklikt',
  bounced: 'Gebounced',
  failed: 'Mislukt',
  complained: 'Spam-klacht',
  received: 'Ontvangen',
};

export function clientEmailStatusTone(status: ClientEmailStatus): string {
  if (status === 'delivered' || status === 'opened' || status === 'clicked') return 'success';
  if (status === 'bounced' || status === 'failed' || status === 'complained') return 'danger';
  if (status === 'received') return 'inbound';
  return 'neutral';
}

export function formatEmailDateTime(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('nl-NL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
}

/**
 * Waarom staat dit binnengekomen bericht in dít dossier? Bij mail die via het
 * doorstuuradres komt is dat een gok van het systeem, en dan hoor je te zien
 * waaróp die gok gebaseerd is.
 */
export function inboundOriginLabel(msg: ClientEmail): string | null {
  const viaAlias = (msg.metadata as { inbound_route?: string } | null)?.inbound_route === 'alias';
  switch (msg.link_source) {
    case 'client_email': return viaAlias ? 'Binnengekomen via je doorstuuradres, herkend op het e-mailadres' : 'Automatisch gekoppeld op e-mailadres';
    case 'client_contact': return viaAlias ? 'Binnengekomen via je doorstuuradres, herkend op een contactpersoon' : 'Automatisch gekoppeld op een contactpersoon';
    case 'manual': return 'Handmatig gekoppeld vanuit de opvangbak';
    case 'header_thread': return 'Gekoppeld aan een lopend gesprek';
    case 'reply_token': return null; // antwoord op onze eigen mail: vanzelfsprekend
    default: return viaAlias ? 'Binnengekomen via je doorstuuradres' : null;
  }
}

export function ClientEmailMessageCard({ message: msg, isUnread, canWrite, onRemove }: {
  message: ClientEmail;
  isUnread: boolean;
  canWrite: boolean;
  /** "Verwijderen" op een inkomend bericht: haalt het uit het klantdossier (soft delete). */
  onRemove: (clientEmailId: string) => void;
}) {
  return <div className={`client-comm-message ${msg.direction}${isUnread ? ' unread' : ''}`}>
    <div className="client-comm-message-meta">
      <span className="client-comm-dir">{msg.direction === 'outbound' ? 'Uitgaand' : 'Inkomend'}</span>
      <span className={`client-comm-status ${clientEmailStatusTone(msg.status)}`}>{CLIENT_EMAIL_STATUS_LABELS[msg.status] ?? msg.status}</span>
      <time>{formatEmailDateTime(msg.created_at)}</time>
    </div>
    <div className="client-comm-message-from">
      {msg.direction === 'outbound'
        ? `${msg.from_email} → ${msg.to_email}`
        /* Weergavenaam afgekapt: die is vrij te kiezen door de afzender. */
        : `Van ${(msg.from_name ?? '').slice(0, 80) ? `${(msg.from_name ?? '').slice(0, 80)} <${msg.from_email}>` : msg.from_email}`}
    </div>
    {msg.direction === 'inbound' && inboundOriginLabel(msg) && (
      <div className="client-comm-origin">{inboundOriginLabel(msg)}</div>
    )}
    {msg.body_html
      ? <div className="client-comm-body" dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(msg.body_html) }} />
      : <div className="client-comm-body client-comm-body-plain">{msg.body_text}</div>}
    {msg.error_message && <div className="client-comm-error">{msg.error_message}</div>}
    {canWrite && msg.direction === 'inbound' && <div className="client-comm-message-actions">
      <button
        type="button"
        className="client-comm-remove"
        onClick={() => onRemove(msg.id)}
        title="Haal dit bericht uit het klantdossier"
      >
        Verwijderen
      </button>
    </div>}
  </div>;
}
