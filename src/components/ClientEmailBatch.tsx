import { Mail, UserX } from 'lucide-react';
import { ApprovalChecklist, type ChecklistItem } from './ApprovalChecklist';
import type { GerrieClientEmailItem, GerrieSendClientEmailProposal } from '../lib/gerrie-api';

/**
 * Een reeks klantmails die een agent heeft klaargezet — mail voor mail af te vinken.
 *
 * Dit is het scherm waar echte post naar echte klanten gaat, dus je ziet per mail
 * de ontvanger, het onderwerp en de VOLLEDIGE tekst (bij twee of minder mails
 * meteen opengeklapt) voordat je er een vinkje bij zet.
 *
 * Het afvink-gedrag zelf zit in [ApprovalChecklist], dat ook de facturen- en
 * offertelijst aandrijft: hoe je beslist hoort overal hetzelfde te zijn.
 */
export function ClientEmailBatch({ proposal, canWrite, onSendOne, onResolved, disabled = false }: {
  proposal: GerrieSendClientEmailProposal;
  canWrite: boolean;
  onSendOne: (item: GerrieClientEmailItem) => Promise<void>;
  /** Vuurt één keer, zodra alle mails verstuurd of overgeslagen zijn. */
  onResolved: (outcome: { sent: number; skipped: number; failed: number }) => void;
  disabled?: boolean;
}) {
  const items: ChecklistItem[] = proposal.items.map((item, i) => ({
    key: `${item.client_id}-${i}`,
    title: item.client_name || item.recipient_email,
    subtitle: item.recipient_email,
    meta: item.subject,
    detail: item.body,
    detailLabel: 'Tekst lezen',
  }));

  return (
    <ApprovalChecklist
      items={items}
      canWrite={canWrite}
      disabled={disabled}
      openDetailsUpTo={2}
      sendLabel="Verstuur"
      unitLabel="mailtje"
      unitLabelPlural="mailtjes"
      noWriteHint="Je hebt geen schrijfrechten voor klantmail — vraag een owner of admin."
      lead={<>
        <Mail size={13} aria-hidden="true" />
        <span>
          {proposal.origin === 'template'
            ? 'Jouw vaste tekst, per klant ingevuld.'
            : 'Door je agent geschreven — lees hem na voordat je akkoord geeft.'}
        </span>
      </>}
      skippedNote={proposal.skipped.length > 0
        ? <p className="cem-skipped"><UserX size={12} /> Geen e-mailadres bekend: {proposal.skipped.join(', ')}</p>
        : undefined}
      sendOne={(_item, index) => onSendOne(proposal.items[index])}
      onResolved={onResolved}
    />
  );
}
