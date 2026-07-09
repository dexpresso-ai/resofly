import type { OrganizationMember, UUID } from '../types';
import { memberColor, memberInitials, memberName } from '../lib/members';

/**
 * Compacte, overlappende avatarstapel van toegewezen teamleden. Wordt gedeeld
 * door de kanban-taakkaarten en de weekplanner, zodat toewijzingen overal
 * hetzelfde ogen. Toont maximaal `max` avatars en verder een "+N"-teller.
 */
export function AssigneeAvatars({ userIds, teamMembers, currentUserId, max = 3 }: {
  userIds: UUID[];
  teamMembers: OrganizationMember[];
  currentUserId?: UUID | null;
  max?: number;
}) {
  if (userIds.length === 0) return null;
  const shown = userIds.slice(0, max);
  const overflow = userIds.length - shown.length;
  return <span className="assignee-avatars">
    {shown.map(id => (
      <span
        key={id}
        className="assignee-avatar"
        style={{ background: memberColor(id) }}
        title={memberName(id, teamMembers, currentUserId)}
      >
        {memberInitials(id, teamMembers)}
      </span>
    ))}
    {overflow > 0 && (
      <span
        className="assignee-avatar assignee-avatar-more"
        title={userIds.slice(max).map(id => memberName(id, teamMembers, currentUserId)).join(', ')}
      >
        +{overflow}
      </span>
    )}
  </span>;
}
