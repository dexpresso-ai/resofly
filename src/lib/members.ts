import type { OrganizationMember, UUID } from '../types';

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
