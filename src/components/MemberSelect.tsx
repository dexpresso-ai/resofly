import type { OrganizationMember, UUID } from '../types';
import { Select } from './Ui';
import { holderName, membersWhoCanHold } from '../lib/members';
import type { ModuleKey } from '../lib/permissions';

/**
 * Eén teamlid kiezen voor een klant (accountlead) of een ticket (toegewezen).
 *
 * Alleen wie de module mag lezen staat erin; de database weigert de rest.
 * Staat er al iemand die niet (meer) kiesbaar is, dan blijft hij zichtbaar als
 * "Oud-teamlid" in plaats van stil op "niemand" te springen: dan leek de
 * keuze verdwenen terwijl hij in de database nog stond.
 */
export function MemberSelect({ value, members, module, emptyLabel, currentUserId, disabled, onChange, id }: {
  value: UUID | null | undefined;
  members: OrganizationMember[];
  module: ModuleKey;
  /** Tekst voor "niemand": "Geen accountlead", "Niet toegewezen". */
  emptyLabel: string;
  currentUserId?: UUID | null;
  disabled?: boolean;
  onChange: (userId: UUID | null) => void;
  id?: string;
}) {
  const options = membersWhoCanHold(members, module);
  const current = value || '';
  const stale = current && !options.some(m => m.user_id === current);
  return <Select id={id} value={current} onChange={e => onChange(e.target.value || null)} disabled={disabled} searchable={options.length > 8}>
    <option value="">{emptyLabel}</option>
    {stale && <option value={current}>{holderName(current, members, emptyLabel)}</option>}
    {options.map(m => <option key={m.user_id} value={m.user_id}>{m.user_id === currentUserId ? `${holderName(m.user_id, members, emptyLabel)} (jij)` : holderName(m.user_id, members, emptyLabel)}</option>)}
  </Select>;
}
