import { useEffect, useState } from 'react';
import type { OrganizationMember, UUID } from '../types';
import { Select } from './Ui';
import { holderName, membersWhoCanHold } from '../lib/members';
import type { ModuleKey } from '../lib/permissions';
import { loadClientFacingNames } from '../lib/repository';

/**
 * Eén teamlid kiezen voor een klant (accountlead) of een ticket (toegewezen).
 *
 * Alleen wie de module mag lezen staat erin; de database weigert de rest.
 * Staat er al iemand die niet (meer) kiesbaar is, dan blijft hij zichtbaar als
 * "Oud-teamlid" in plaats van stil op "niemand" te springen: dan leek de
 * keuze verdwenen terwijl hij in de database nog stond.
 *
 * Met `organizationId` staat eronder wat de klant in het portaal ziet. Dat is
 * de afzendernaam van het teamlid, niet het e-mailadres uit deze lijst; zonder
 * die regel zag je hier "anna@bureau.nl" en wist je niet dat de klant
 * "Anna de Vries" ziet, of niets.
 */
export function MemberSelect({ value, members, module, emptyLabel, currentUserId, disabled, onChange, id, organizationId }: {
  value: UUID | null | undefined;
  members: OrganizationMember[];
  module: ModuleKey;
  /** Tekst voor "niemand": "Geen accountlead", "Niet toegewezen". */
  emptyLabel: string;
  currentUserId?: UUID | null;
  disabled?: boolean;
  onChange: (userId: UUID | null) => void;
  id?: string;
  /** Toon eronder welke naam de klant in het portaal ziet. */
  organizationId?: UUID;
}) {
  const options = membersWhoCanHold(members, module);
  const current = value || '';
  const stale = current && !options.some(m => m.user_id === current);
  const names = useClientFacingNames(organizationId);
  return <>
    <Select id={id} value={current} onChange={e => onChange(e.target.value || null)} disabled={disabled} searchable={options.length > 8}>
      <option value="">{emptyLabel}</option>
      {stale && <option value={current}>{holderName(current, members, emptyLabel)}</option>}
      {options.map(m => <option key={m.user_id} value={m.user_id}>{m.user_id === currentUserId ? `${holderName(m.user_id, members, emptyLabel)} (jij)` : holderName(m.user_id, members, emptyLabel)}</option>)}
    </Select>
    {organizationId && current && names && <small className="member-select-portal">
      {portalHint(names.get(current) ?? null, module, current === currentUserId)}
    </small>}
  </>;
}

function portalHint(name: string | null, module: ModuleKey, isMe: boolean): string {
  if (name) return module === 'tickets' ? `In het klantportaal: "Opgepakt door ${name}".` : `In het klantportaal: "Je vaste contactpersoon: ${name}".`;
  const who = isMe ? 'Je hebt' : 'Dit teamlid heeft';
  const fallback = module === 'tickets'
    ? 'Het klantportaal zegt dan "Opgepakt door" met de naam van je bedrijf.'
    : 'Het klantportaal toont dan geen contactpersoon.';
  return `${who} nog geen naam voor klanten (Instellingen → E-mail → Persoonlijke afzender). ${fallback}`;
}

/** Afzendernamen van het team; null zolang ze laden of als dat mislukte (dan geen regel). */
function useClientFacingNames(organizationId: UUID | undefined): Map<UUID, string> | null {
  const [names, setNames] = useState<Map<UUID, string> | null>(null);
  useEffect(() => {
    if (!organizationId) return;
    let alive = true;
    loadClientFacingNames(organizationId).then(found => { if (alive) setNames(found); }).catch(() => { if (alive) setNames(null); });
    return () => { alive = false; };
  }, [organizationId]);
  return names;
}
