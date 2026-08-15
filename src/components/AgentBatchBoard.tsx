import { AlertTriangle, FileText, Receipt } from 'lucide-react';
import { ApprovalChecklist, type ChecklistItem } from './ApprovalChecklist';
import { ClientEmailBatch } from './ClientEmailBatch';
import { euro } from '../lib/format';
import type {
  GerrieActionHandlers, GerrieProposal, GerrieSendDocumentItem,
  GerrieSendInvoicesProposal, GerrieSendQuotesProposal,
  GerrieSendClientEmailProposal, GerrieSendRemindersProposal,
} from '../lib/gerrie-api';

/**
 * Het afvinkbord voor alles wat een agent in MEERVOUD klaarzet: mailtjes,
 * facturen, offertes en betalingsherinneringen.
 *
 * Deze drie soorten hebben één ding gemeen: er gaat post de deur uit namens jou,
 * en je wilt per regel kunnen beslissen — niet per stapel. Daarom krijgen ze
 * allemaal dezelfde lijst met vinkjes en dezelfde "alles aan/uit"-knop, op alle
 * plekken waar zo'n voorstel opduikt (startscherm, run-historie, chat-dock).
 *
 * Elke regel loopt langs precies dezelfde uitvoer-handler als een los voorstel,
 * zodat afvinken exact hetzelfde doet als goedkeuren — alleen dan per regel.
 */

type BatchProposal = GerrieSendClientEmailProposal | GerrieSendInvoicesProposal | GerrieSendQuotesProposal | GerrieSendRemindersProposal;

/** Is dit een voorstel dat je regel voor regel afvinkt? Zo ja: geef het terug. */
export function asBatchProposal(p: GerrieProposal): BatchProposal | null {
  switch (p.type) {
    case 'send_client_email':
    case 'send_invoices':
    case 'send_quotes':
      return p;
    // Eén herinnering is nog steeds een lijst van één; dezelfde vorm voorkomt dat
    // "1 herinnering" ineens een ander soort beslissing wordt dan "7 herinneringen".
    case 'send_reminders':
      return p.invoices.length > 0 ? p : null;
    default:
      return null;
  }
}

export function AgentBatchBoard({ proposal, canWrite, handlers, onResolved, disabled = false }: {
  proposal: BatchProposal;
  canWrite: boolean;
  handlers: GerrieActionHandlers;
  /** Vuurt één keer, zodra elke regel verstuurd of overgeslagen is. */
  onResolved: (outcome: { sent: number; skipped: number; failed: number }) => void;
  disabled?: boolean;
}) {
  if (proposal.type === 'send_client_email') {
    return (
      <ClientEmailBatch
        proposal={proposal}
        canWrite={canWrite}
        disabled={disabled}
        onSendOne={(mail) => handlers.onSendClientEmail
          ? handlers.onSendClientEmail(mail)
          : Promise.reject(new Error('Mailen is hier niet beschikbaar.'))}
        onResolved={onResolved}
      />
    );
  }

  if (proposal.type === 'send_reminders') {
    const items: ChecklistItem[] = proposal.invoices.map((inv) => ({
      key: inv.id,
      title: inv.client_name || inv.number,
      subtitle: `Factuur ${inv.number}`,
      meta: [
        `${inv.level}e herinnering`,
        typeof inv.days_overdue === 'number' ? `${inv.days_overdue} dagen te laat` : '',
      ].filter(Boolean).join(' · '),
      badge: typeof inv.total_eur === 'number' ? euro(inv.total_eur) : undefined,
    }));
    return (
      <ApprovalChecklist
        items={items}
        canWrite={canWrite}
        disabled={disabled}
        sendLabel="Verstuur"
        unitLabel="herinnering"
        unitLabelPlural="herinneringen"
        lead={<><AlertTriangle size={13} aria-hidden="true" /> <span>Elke regel is de eerstvolgende herinnering voor die factuur. Wat je uitvinkt blijft staan.</span></>}
        sendOne={(_item, index) => {
          const inv = proposal.invoices[index];
          // Per factuur langs dezelfde weg als de hele batch — één regel tegelijk,
          // zodat een mislukte herinnering de rest niet meesleept.
          return handlers.onSendReminders
            ? handlers.onSendReminders({ type: 'send_reminders', invoices: [inv], total: 1 })
            : Promise.reject(new Error('Herinneringen versturen is hier niet beschikbaar.'));
        }}
        onResolved={onResolved}
      />
    );
  }

  const isInvoice = proposal.type === 'send_invoices';
  const items: ChecklistItem[] = proposal.items.map((doc) => ({
    key: doc.id,
    title: doc.client_name || doc.number,
    subtitle: doc.recipient_email,
    meta: [isInvoice ? `Factuur ${doc.number}` : `Offerte ${doc.number}`, doc.date ?? ''].filter(Boolean).join(' · '),
    badge: euro(doc.total_eur),
  }));

  return (
    <ApprovalChecklist
      items={items}
      canWrite={canWrite}
      disabled={disabled}
      sendLabel="Verstuur"
      unitLabel={isInvoice ? 'factuur' : 'offerte'}
      unitLabelPlural={isInvoice ? 'facturen' : 'offertes'}
      lead={<>
        {isInvoice ? <Receipt size={13} aria-hidden="true" /> : <FileText size={13} aria-hidden="true" />}
        <span>Elke regel gaat als losse e-mail naar de klant. Wat je uitvinkt blijft gewoon staan.</span>
      </>}
      skippedNote={proposal.skipped.length > 0 ? (
        <p className="cem-skipped">
          <AlertTriangle size={12} /> Niet meegenomen: {proposal.skipped.map((s) => `${s.number} (${s.reason})`).join(', ')}
        </p>
      ) : undefined}
      sendOne={(_item, index) => sendDocument(proposal.items[index], isInvoice, handlers)}
      onResolved={onResolved}
    />
  );
}

/** Eén document, langs precies dezelfde handler als een los verstuur-voorstel. */
function sendDocument(doc: GerrieSendDocumentItem, isInvoice: boolean, h: GerrieActionHandlers): Promise<void> {
  if (isInvoice) {
    return h.onSendInvoice
      ? h.onSendInvoice({ type: 'send_invoice', id: doc.id, number: doc.number, client_name: doc.client_name, recipient_email: doc.recipient_email, recipient_name: doc.recipient_name })
      : Promise.reject(new Error('Facturen versturen is hier niet beschikbaar.'));
  }
  return h.onSendQuote
    ? h.onSendQuote({ type: 'send_quote', id: doc.id, number: doc.number, client_name: doc.client_name, recipient_email: doc.recipient_email, recipient_name: doc.recipient_name })
    : Promise.reject(new Error('Offertes versturen is hier niet beschikbaar.'));
}
