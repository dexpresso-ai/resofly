import { memberModuleLevel } from '../roles.ts';
import { ActionError, orgQuery, type ActionCtx } from './types.ts';

/**
 * Wie iets "heeft": de accountlead van een klant, het teamlid aan wie een
 * ticket is toegewezen. Gedeeld door client.set_account_lead en ticket.assign.
 *
 * Dezelfde regel als de database (public.member_can_hold, migratie
 * 20261111160000): een actief teamlid van DEZE organisatie, geen boekhouder,
 * dat de module mag lezen. Hier nog eens, zodat de goedkeurkaart al zegt dat
 * het niet kan, in plaats van dat het pas bij Uitvoeren op een databasefout
 * stukloopt.
 */

export interface Holder { userId: string; name: string }

/**
 * Lees het teamlid uit de invoer. Leeg = niemand (null). "me" = degene namens
 * wie de handeling draait: het model kent zijn eigen user_id niet, en verzon er
 * anders een.
 */
export async function resolveHolder(ctx: ActionCtx, input: Record<string, unknown>, key: string, module: 'clients' | 'tickets'): Promise<Holder | null> {
  const raw = String(input[key] ?? '').trim().toLowerCase();
  if (!raw || raw === 'none') return null;
  const userId = raw === 'me' ? ctx.userId : raw;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(userId)) {
    throw new ActionError(`"${key}" moet een user_id uit list_team_members zijn, "me" of leeg.`);
  }
  const { data, error } = await orgQuery(ctx, 'organization_members', 'user_id, email, role, status, module_access')
    .eq('user_id', userId).maybeSingle();
  if (error) throw new ActionError(`Teamlid ophalen mislukt: ${error.message}`);
  const member = data as { email: string | null; role: string; status: string; module_access: Record<string, unknown> | null } | null;
  if (!member || member.status !== 'active') {
    throw new ActionError('Dit is geen actief teamlid van deze organisatie. Zoek het juiste teamlid met list_team_members.');
  }
  const name = String(member.email ?? '').trim() || 'Teamlid';
  if (member.role === 'accountant') {
    throw new ActionError(`${name} is boekhouder, geen teamlid: die kan geen ${module === 'clients' ? 'accountlead' : 'ticket'} krijgen.`);
  }
  if (memberModuleLevel(member.role, member.module_access, module) === 'none') {
    throw new ActionError(`${name} mag ${module === 'clients' ? 'Klanten' : 'Tickets'} niet zien, en kan daarom geen ${module === 'clients' ? 'accountlead zijn' : 'tickets toegewezen krijgen'}.`);
  }
  return { userId, name };
}

/** Namen van de huidige houders, voor "nu: …" op de kaart. Zacht: dit is versiering. */
export async function holderNames(ctx: ActionCtx, userIds: Array<string | null>): Promise<Map<string, string>> {
  const wanted = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string>();
  if (wanted.length === 0) return names;
  const { data } = await orgQuery(ctx, 'organization_members', 'user_id, email').in('user_id', wanted);
  for (const m of (data ?? []) as Array<{ user_id: string; email: string | null }>) {
    names.set(String(m.user_id), String(m.email ?? '').trim() || 'Teamlid');
  }
  return names;
}
