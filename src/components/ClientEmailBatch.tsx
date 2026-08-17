import { useState } from 'react';
import { Mail, RotateCcw, UserX } from 'lucide-react';
import { ApprovalChecklist, type ChecklistItem } from './ApprovalChecklist';
import type { GerrieClientEmailItem, GerrieSendClientEmailProposal } from '../lib/gerrie-api';

/**
 * Een reeks klantmails die een agent heeft klaargezet — mail voor mail na te lezen,
 * AAN TE PASSEN en af te vinken.
 *
 * Dit is het scherm waar echte post naar echte klanten gaat. Alleen kunnen lezen was
 * niet genoeg: je wilt bij die ene klant een zin anders. Dat via de agent proberen
 * werkt slecht — bij een agent met een vaste tekst kán hij het per definitie niet
 * veranderen, en ook een schrijvende agent komt vaak met dezelfde tekst terug. Dus
 * pas je hem hier aan, vlak voordat hij weggaat. Wat je typt is precies wat er
 * verstuurd wordt.
 *
 * De wijziging leeft in dit scherm en gaat mee met de verzending; hij wordt niet
 * teruggeschreven naar het voorstel. Sluit je de wachtrij zonder te versturen, dan
 * staat de oorspronkelijke tekst er weer — vandaar de "terug naar het origineel"-knop
 * in plaats van een stille overschrijving.
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
  const [drafts, setDrafts] = useState<GerrieClientEmailItem[]>(() => proposal.items.map((i) => ({ ...i })));

  function patch(index: number, field: 'subject' | 'body', value: string) {
    setDrafts((prev) => prev.map((d, i) => (i === index ? { ...d, [field]: value } : d)));
  }
  function reset(index: number) {
    setDrafts((prev) => prev.map((d, i) => (i === index ? { ...proposal.items[i] } : d)));
  }

  const items: ChecklistItem[] = drafts.map((draft, i) => {
    const original = proposal.items[i];
    const changed = draft.subject !== original.subject || draft.body !== original.body;
    return {
      key: `${original.client_id}-${i}`,
      title: original.client_name || original.recipient_email,
      subtitle: original.recipient_email,
      meta: draft.subject,
      badge: changed ? 'aangepast' : undefined,
      detailLabel: 'Tekst aanpassen',
      detail: (
        <div className="cem-edit">
          <label className="cem-edit-field">
            <span>Onderwerp</span>
            <input
              className="cem-edit-input"
              value={draft.subject}
              maxLength={300}
              disabled={disabled || !canWrite}
              onChange={(e) => patch(i, 'subject', e.target.value)}
            />
          </label>
          <label className="cem-edit-field">
            <span>Bericht</span>
            <textarea
              className="cem-edit-input cem-edit-body"
              value={draft.body}
              rows={9}
              maxLength={8000}
              disabled={disabled || !canWrite}
              onChange={(e) => patch(i, 'body', e.target.value)}
            />
          </label>
          <div className="cem-edit-foot">
            <span>Witregels blijven alinea's. De handtekening van je organisatie komt er automatisch onder.</span>
            {changed && (
              <button type="button" className="ag-btn ag-btn-ghost" onClick={() => reset(i)}>
                <RotateCcw size={12} /> Terug naar het origineel
              </button>
            )}
          </div>
        </div>
      ),
    };
  });

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
            ? 'Jouw vaste tekst, per klant ingevuld — hier nog aan te passen.'
            : 'Door je agent geschreven. Lees na en pas aan waar je wilt; wat er staat is wat er weggaat.'}
        </span>
      </>}
      skippedNote={proposal.skipped.length > 0
        ? <p className="cem-skipped"><UserX size={12} /> Geen e-mailadres bekend: {proposal.skipped.join(', ')}</p>
        : undefined}
      // Bewust de bewerkte versie, niet het oorspronkelijke voorstel.
      sendOne={(_item, index) => onSendOne(drafts[index])}
      onResolved={onResolved}
    />
  );
}
