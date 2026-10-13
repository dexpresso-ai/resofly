import type {
  ChatAvailability, ChatConversation, ChatConversationPrefs, ChatLastMessage, ChatMemberStatus,
  ChatMessage, ChatParticipant, OrganizationMember, UUID,
} from '../../types';
import { plainPreview } from '../../lib/chatFormat';

/**
 * Pure helpers voor de teamchat: namen, tijden, beschikbaarheid en het
 * gespreksmodel dat de lijst en het gespreksvenster delen. Geen React hier.
 */

// ── Namen en avatars ─────────────────────────────────────────────────────────
// Er is geen profieltabel: het enige menselijke veld van een lid is het
// e-mailadres. Daar maken we een nette naam van ("jan.de-vries@" → "Jan De Vries").

export interface MemberDisplay {
  name: string;
  first: string;
  initials: string;
  email: string;
}

export function memberDisplay(member: OrganizationMember | undefined, fallback = 'Teamlid'): MemberDisplay {
  const email = member?.email ?? '';
  const local = email.split('@')[0] ?? '';
  const name = local
    ? local.replace(/[._\-+]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/(^|\s)(\p{L})/gu, (_m, sp: string, c: string) => sp + c.toUpperCase())
    : (email || fallback);
  const parts = local.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const initials = (parts.length >= 2 ? `${parts[0][0]}${parts[1][0]}` : local.slice(0, 2) || '?').toUpperCase();
  return { name, first: name.split(' ')[0] || name, initials, email };
}

/** Vaste tint per id: dezelfde collega heeft overal dezelfde kleur. */
export function avatarHue(id: string | null | undefined): number {
  if (!id) return 210;
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return hash % 360;
}

// ── Tijd ─────────────────────────────────────────────────────────────────────

/** Tijdstip als getal. Supabase schrijft "+00:00", de browser "Z": nooit als tekst vergelijken. */
export const ts = (iso: string | null | undefined): number => (iso ? Date.parse(iso) || 0 : 0);

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
}

/** Volledige datum en tijd, voor een tooltip. */
export function formatFull(iso: string): string {
  return new Date(iso).toLocaleString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Tijd in de gesprekslijst: vandaag de klok, gisteren "Gisteren", deze week de dag, daarna de datum. */
export function formatListTime(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (sameDay(d, now)) return formatClock(iso);
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return 'Gisteren';
  const days = (now.getTime() - d.getTime()) / 86400000;
  if (days < 6) return d.toLocaleDateString('nl-NL', { weekday: 'short' }).replace('.', '');
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'numeric' });
  return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'numeric', year: '2-digit' });
}

/** Dagscheiding in een gesprek. */
export function formatDayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (sameDay(d, now)) return 'Vandaag';
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return 'Gisteren';
  return d.toLocaleDateString('nl-NL', d.getFullYear() === now.getFullYear()
    ? { weekday: 'long', day: 'numeric', month: 'long' }
    : { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Tijd in een melding of de activiteit: "nu", "5 min", "2 u", daarna de lijsttijd. */
export function formatAgo(iso: string, now = Date.now()): string {
  const min = Math.floor((now - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'nu';
  if (min < 60) return `${min} min`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} u`;
  return formatListTime(iso);
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

// ── Beschikbaarheid ──────────────────────────────────────────────────────────

/** Wat er bij iemand in beeld staat. 'auto' bestaat hier niet meer: die is al uitgerekend. */
export type Presence = Exclude<ChatAvailability, 'auto'>;

export const PRESENCE_LABEL: Record<Presence, string> = {
  available: 'Beschikbaar',
  busy: 'Bezet',
  dnd: 'Niet storen',
  brb: 'Zo terug',
  away: 'Afwezig',
  offline: 'Offline',
};

/** De keuzes in het statusmenu, in de volgorde van Teams. */
export const AVAILABILITY_CHOICES: { value: ChatAvailability; label: string; presence: Presence }[] = [
  { value: 'available', label: 'Beschikbaar', presence: 'available' },
  { value: 'busy', label: 'Bezet', presence: 'busy' },
  { value: 'dnd', label: 'Niet storen', presence: 'dnd' },
  { value: 'brb', label: 'Zo terug', presence: 'brb' },
  { value: 'away', label: 'Afwezig weergeven', presence: 'away' },
  { value: 'offline', label: 'Offline weergeven', presence: 'offline' },
];

export function resolvePresence(
  userId: string | null | undefined,
  ctx: { online: Set<string>; idle: Set<string>; statuses: Map<string, ChatMemberStatus> },
): Presence {
  if (!userId) return 'offline';
  const manual = ctx.statuses.get(userId)?.availability ?? 'auto';
  if (!ctx.online.has(userId)) return 'offline';
  if (manual === 'offline') return 'offline';
  if (manual !== 'auto') return manual;
  return ctx.idle.has(userId) ? 'away' : 'available';
}

/** Het statusbericht, zolang het niet verlopen is. */
export function activeStatusMessage(status: ChatMemberStatus | undefined, now = Date.now()): string | null {
  if (!status?.status_message) return null;
  if (status.message_expires_at && new Date(status.message_expires_at).getTime() < now) return null;
  return status.status_message;
}

// ── Gespreksmodel ────────────────────────────────────────────────────────────

export interface ConversationVM {
  conversation: ChatConversation;
  id: UUID;
  kind: ChatConversation['kind'];
  /** De naam zoals hij in beeld staat (bij een 1-op-1-chat: de collega). */
  title: string;
  /** Had de groepschat zelf een naam, of is het een opsomming van namen? */
  named: boolean;
  memberIds: UUID[];
  counterpartId: UUID | null;
  unread: number;
  pinned: boolean;
  muted: boolean;
  hidden: boolean;
  lastActivity: string;
  last: ChatLastMessage | null;
  myRole: ChatParticipant['role'] | null;
  isPrivate: boolean;
}

export function groupTitle(otherIds: UUID[], memberById: Map<string, OrganizationMember>): string {
  const names = otherIds.map((id) => memberDisplay(memberById.get(id)).first);
  if (names.length === 0) return 'Alleen jij';
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
}

export function buildConversationVMs(input: {
  conversations: ChatConversation[];
  participants: ChatParticipant[];
  prefs: Map<string, ChatConversationPrefs>;
  unread: Map<string, number>;
  previews: Map<string, ChatLastMessage>;
  teamMembers: OrganizationMember[];
  me: string | null;
}): ConversationVM[] {
  const { me } = input;
  const memberById = new Map(input.teamMembers.map((m) => [m.user_id, m]));
  const partByConv = new Map<string, ChatParticipant[]>();
  for (const p of input.participants) {
    const list = partByConv.get(p.conversation_id) ?? [];
    list.push(p);
    partByConv.set(p.conversation_id, list);
  }
  const out: ConversationVM[] = [];
  for (const conversation of input.conversations) {
    const parts = partByConv.get(conversation.id) ?? [];
    const mine = parts.find((p) => p.user_id === me);
    // Realtime kan een gesprek melden voordat (of nadat) jouw deelnemersrij er is.
    if (!mine) continue;
    const memberIds = parts.map((p) => p.user_id);
    const others = memberIds.filter((id) => id !== me);
    let title = conversation.title?.trim() || '';
    let named = !!title;
    let counterpartId: string | null = null;
    if (conversation.kind === 'dm') {
      counterpartId = others[0] ?? null;
      title = memberDisplay(memberById.get(counterpartId ?? '')).name;
      named = true;
    } else if (conversation.kind === 'group' && !title) {
      title = groupTitle(others, memberById);
    } else if (!title) {
      title = 'Kanaal';
    }
    const pref = input.prefs.get(conversation.id);
    const last = input.previews.get(conversation.id) ?? null;
    const lastActivity = [conversation.last_message_at, last?.created_at, conversation.created_at]
      .filter((v): v is string => !!v)
      .sort((a, b) => ts(a) - ts(b))
      .pop() ?? conversation.created_at;
    const hidden = !!pref?.hidden_at && ts(pref.hidden_at) >= ts(lastActivity);
    out.push({
      conversation,
      id: conversation.id,
      kind: conversation.kind,
      title,
      named,
      memberIds,
      counterpartId,
      unread: input.unread.get(conversation.id) ?? 0,
      pinned: !!pref?.is_pinned,
      muted: !!pref?.is_muted,
      hidden,
      lastActivity,
      last,
      myRole: mine.role,
      isPrivate: conversation.kind === 'channel' && (conversation.visibility ?? 'private') === 'private',
    });
  }
  return out.sort((a, b) => ts(b.lastActivity) - ts(a.lastActivity));
}

/** Eén regel tekst van een bericht (voor citaten, meldingen en zoekresultaten). */
export function plainSnippet(msg: ChatMessage, max = 120): string {
  if (msg.deleted_at) return 'Dit bericht is verwijderd.';
  if ((msg.kind ?? 'text') === 'meeting') return msg.meta?.audio_only ? 'Gesprek gestart' : 'Vergadering gestart';
  const text = plainPreview(msg.body, max);
  if (text) return text;
  if (msg.attachment_count > 0) return msg.attachment_count === 1 ? 'Bijlage' : `${msg.attachment_count} bijlagen`;
  return '';
}

/** De voorbeeldregel onder een gesprek in de lijst ("Jij: …", "Bob: …"). */
export function previewLine(vm: ConversationVM, me: string | null, memberById: Map<string, OrganizationMember>): string {
  const last = vm.last;
  if (!last) return vm.kind === 'channel' ? (vm.conversation.description ?? 'Nog geen berichten') : 'Nog geen berichten';
  const who = last.sender_id === me ? 'Jij' : memberDisplay(memberById.get(last.sender_id ?? '')).first;
  if (last.kind === 'system') return systemText(last.meta?.event, last.meta, last.sender_id, me, memberById);
  if (last.deleted_at) return `${who}: bericht verwijderd`;
  if (last.kind === 'meeting') return `${who}: ${last.meta?.audio_only ? 'gesprek gestart' : 'vergadering gestart'}`;
  const text = plainPreview(last.body, 90) || (last.attachment_count > 0 ? (last.attachment_count === 1 ? 'een bijlage' : `${last.attachment_count} bijlagen`) : '');
  if (vm.kind === 'dm' && last.sender_id !== me) return text;
  return `${who}: ${text}`;
}

/** Een systeemregel in gewone taal. */
export function systemText(
  event: string | undefined,
  meta: { user_ids?: string[]; title?: string | null } | undefined,
  actorId: string | null,
  me: string | null,
  memberById: Map<string, OrganizationMember>,
): string {
  const nameOf = (id: string | null | undefined) => (id && id === me ? 'jij' : memberDisplay(memberById.get(id ?? '')).name);
  const actor = actorId === me ? 'Jij' : memberDisplay(memberById.get(actorId ?? '')).name;
  const list = (ids: string[] | undefined) => {
    const names = (ids ?? []).map((id) => nameOf(id));
    if (names.length <= 1) return names[0] ?? 'iemand';
    return `${names.slice(0, -1).join(', ')} en ${names[names.length - 1]}`;
  };
  switch (event) {
    case 'members_added': return `${actor} ${actorId === me ? 'hebt' : 'heeft'} ${list(meta?.user_ids)} toegevoegd.`;
    case 'member_removed': return `${actor} ${actorId === me ? 'hebt' : 'heeft'} ${list(meta?.user_ids)} verwijderd.`;
    case 'member_left': return `${actor} ${actorId === me ? 'bent' : 'is'} vertrokken.`;
    case 'member_joined': return `${actor} neemt nu deel.`;
    case 'renamed': return meta?.title
      ? `${actor} ${actorId === me ? 'hebt' : 'heeft'} de naam gewijzigd in ‘${meta.title}’.`
      : `${actor} ${actorId === me ? 'hebt' : 'heeft'} de naam weggehaald.`;
    default: return 'Het gesprek is gewijzigd.';
  }
}

/**
 * Wie er in een tekst genoemd wordt: "@Naam" van een deelnemer, en bij een
 * groepschat of kanaal "@iedereen" voor alle deelnemers.
 */
export function mentionIdsIn(
  body: string,
  memberIds: string[],
  memberById: Map<string, OrganizationMember>,
  me: string | null,
  allowEveryone: boolean,
): string[] {
  const ids = new Set<string>();
  if (allowEveryone && /(^|\s)@iedereen(?![\p{L}\p{N}])/u.test(body)) {
    for (const id of memberIds) if (id !== me) ids.add(id);
  }
  for (const id of memberIds) {
    if (id === me) continue;
    const name = memberDisplay(memberById.get(id)).name;
    if (name && body.includes(`@${name}`)) ids.add(id);
  }
  return [...ids];
}

/** Mogen twee opeenvolgende berichten onder één kopje (zelfde afzender, kort na elkaar)? */
export function continuesGroup(prev: ChatMessage | undefined, msg: ChatMessage): boolean {
  if (!prev) return false;
  if ((prev.kind ?? 'text') !== 'text' || (msg.kind ?? 'text') !== 'text') return false;
  if (prev.sender_id !== msg.sender_id) return false;
  if (dayKey(prev.created_at) !== dayKey(msg.created_at)) return false;
  if ((msg.importance ?? 'normal') !== 'normal' || msg.reply_to_id || msg.meta?.forwarded) return false;
  return ts(msg.created_at) - ts(prev.created_at) < 5 * 60 * 1000;
}
