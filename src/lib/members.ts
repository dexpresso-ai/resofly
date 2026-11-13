import type { OrganizationMember, ProjectMember, UUID } from '../types';
import { parseModuleAccess, resolveModuleLevel, type ModuleKey } from './permissions.ts';

/**
 * Helpers om organisatieleden in de UI te tonen. Er is (bewust) geen aparte
 * profieltabel: het enige menselijke veld op een lid is het e-mailadres.
 * Deze helpers leiden daar een nette naam, initialen en een vaste avatarkleur
 * uit af, zodat projectteam- en taak-toewijzingsweergaven overal gelijk zijn.
 */

/** Ruw e-mailadres van een lid, met een nette fallback. */
export function memberEmail(member: OrganizationMember | undefined): string {
  return member?.email?.trim() || 'Teamlid';
}

function findMember(userId: UUID, members: OrganizationMember[]): OrganizationMember | undefined {
  return members.find(m => m.user_id === userId);
}

/** Volledige weergavenaam. 'Jij' voor de ingelogde gebruiker. */
export function memberName(userId: UUID, members: OrganizationMember[], currentUserId?: UUID | null): string {
  if (currentUserId && userId === currentUserId) return 'Jij';
  return memberEmail(findMember(userId, members));
}

/** Korte naam zonder domein: 'jan.jansen@bedrijf.nl' → 'jan.jansen'. */
export function memberShortName(userId: UUID, members: OrganizationMember[], currentUserId?: UUID | null): string {
  if (currentUserId && userId === currentUserId) return 'Jij';
  const email = memberEmail(findMember(userId, members));
  return email.includes('@') ? email.split('@')[0] : email;
}

/** 1–2 letterinitialen voor een avatar. */
export function memberInitials(userId: UUID, members: OrganizationMember[]): string {
  const email = memberEmail(findMember(userId, members));
  const local = (email.includes('@') ? email.split('@')[0] : email).replace(/[^a-zA-Z0-9]+/g, ' ').trim();
  const parts = local.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (local.slice(0, 2) || '?').toUpperCase();
}

/**
 * Deterministische, prettig verzadigde avatarkleur uit het user-id, zodat
 * hetzelfde lid overal dezelfde kleur krijgt zonder opgeslagen voorkeur.
 */
export function memberColor(userId: UUID): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 52% 42%)`;
}

/**
 * Teamleden die een klant (accountlead) of een ticket (toegewezen) kunnen
 * krijgen: actief, geen boekhouder, en de module mogen lezen. Spiegel van
 * `public.member_can_hold` (migratie 20261111160000); de database weigert de
 * rest. Een accountlead die Klanten niet ziet, krijgt zijn klanten nergens te
 * zien — die bood de keuzelijst dus ook niet aan.
 */
export function membersWhoCanHold(members: OrganizationMember[], module: ModuleKey): OrganizationMember[] {
  return members
    .filter(m => (m.status ?? 'active') === 'active' && m.role !== 'accountant')
    .filter(m => resolveModuleLevel(m.role, parseModuleAccess(m.module_access), module) !== 'none')
    .sort((a, b) => memberEmail(a).localeCompare(memberEmail(b), 'nl'));
}

/**
 * Wie je in het taakvenster aan een taak kunt toewijzen.
 *
 * - `chips`: de knoppen die je aan- en uitzet. Bij een projecttaak het
 *   projectteam plus wie er al op staat; zonder project iedereen die
 *   Projecten mag zien.
 * - `others`: de rest van het team, voor de keuzelijst "Ander teamlid".
 * - `canAssignSelf`: of de knop "Aan mij toewijzen" zin heeft.
 *
 * Eerder bood een projecttaak alleen het projectteam aan. Was dat team leeg,
 * dan kon je niemand kiezen, ook jezelf niet, en moest je eerst via het
 * projectdashboard het team vullen. Nu kun je iedereen kiezen; wie nog niet
 * in het projectteam zit, komt er bij het opslaan bij (`projectTeamAdditions`).
 * Zo blijft gelden dat wie een taak heeft, in het projectteam zit.
 */
export function taskAssigneeChoices({ projectId, assigneeIds, members, projectMembers, currentUserId }: {
  projectId: UUID | null;
  assigneeIds: UUID[];
  members: OrganizationMember[];
  projectMembers: ProjectMember[];
  currentUserId?: UUID | null;
}): { chips: UUID[]; others: OrganizationMember[]; canAssignSelf: boolean } {
  const eligible = membersWhoCanHold(members, 'projects');
  const base = projectId
    ? projectMembers.filter(pm => pm.project_id === projectId).map(pm => pm.user_id)
    : eligible.map(m => m.user_id);
  const chips = Array.from(new Set([...base, ...assigneeIds]));
  const others = eligible.filter(m => !chips.includes(m.user_id));
  const canAssignSelf = Boolean(currentUserId)
    && !assigneeIds.includes(currentUserId as UUID)
    && eligible.some(m => m.user_id === currentUserId);
  return { chips, others, canAssignSelf };
}

/**
 * Wie er bij het opslaan van een projecttaak nog in het projectteam moet,
 * omdat de taak aan die persoon is toegewezen. Leeg voor een taak zonder
 * project: dan is er geen team.
 */
export function projectTeamAdditions(projectId: UUID | null, assigneeIds: UUID[], projectMembers: ProjectMember[]): UUID[] {
  if (!projectId) return [];
  const team = new Set(projectMembers.filter(pm => pm.project_id === projectId).map(pm => pm.user_id));
  return Array.from(new Set(assigneeIds.filter(id => !team.has(id))));
}

/**
 * Naam voor een lijst of rapport. Anders dan `memberName` zegt dit "Oud-teamlid"
 * voor iemand die niet (meer) in de lijst staat: "Teamlid" las als een echte
 * collega met die naam.
 */
export function holderName(userId: UUID | null | undefined, members: OrganizationMember[], emptyLabel: string): string {
  if (!userId) return emptyLabel;
  const member = findMember(userId, members);
  return member ? memberEmail(member) : 'Oud-teamlid';
}

/**
 * Filter op wie iets "heeft" (accountlead, toegewezen). '' = iedereen,
 * 'me' = de ingelogde gebruiker, 'none' = niemand, anders een user-id. "Mij"
 * is een eigen waarde en geen user-id, zodat een filter voor elke collega
 * hetzelfde betekent.
 */
export function matchesHolder(holderId: UUID | null | undefined, filter: string, currentUserId: UUID | null | undefined): boolean {
  if (!filter) return true;
  const holder = holderId ?? null;
  if (filter === 'none') return holder === null;
  if (filter === 'me') return Boolean(currentUserId) && holder === currentUserId;
  return holder === filter;
}
