import { supabase } from './supabase';
import { uploadToR2 } from './r2';
import { extractUrls } from './chatFormat';
import type {
  Attachment,
  ChatActivityItem,
  ChatAvailability,
  ChatConversation,
  ChatConversationPrefs,
  ChatImportance,
  ChatLastMessage,
  ChatMemberStatus,
  ChatMessage,
  ChatMessageKind,
  ChatMessageMeta,
  ChatMessageReaction,
  ChatParticipant,
  ChatPublicChannel,
  ChatUnreadCount,
  UUID,
} from '../types';

/**
 * Data-laag voor de teamchat. Alle toegang loopt rechtstreeks met de gebruikers-
 * client onder RLS (net als tickets/notities); structurele mutaties (gesprek
 * starten, leden toevoegen, gelezen markeren, vastmaken, voorkeuren) lopen via
 * SECURITY DEFINER RPC's uit de migraties 20260705000001_team_chat.sql en
 * 20261013000000_teamchat_teams.sql. Zo blijft realtime werken zonder edge
 * function.
 */

/** Een fout van supabase-js is een plat object, geen Error: maak er een echte van. */
function fail(error: unknown, fallback: string): never {
  if (error instanceof Error) throw error;
  const message = (error as { message?: string } | null)?.message;
  throw new Error(message ? message.replace(/^chat: /, '') : fallback);
}

/** PostgREST-filters met veel id's: in brokken, zodat de URL niet te lang wordt. */
function chunks<T>(list: T[], size = 80): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// ── Gesprekken ───────────────────────────────────────────────────────────────

/** Alle gesprekken (RLS: alleen waar je zelf in zit), de deelnemers en je eigen voorkeuren. */
export async function loadConversations(organizationId: UUID): Promise<{
  conversations: ChatConversation[];
  participants: ChatParticipant[];
  prefs: ChatConversationPrefs[];
}> {
  const [conv, part, prefs] = await Promise.all([
    supabase
      .from('chat_conversations')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('is_archived', false)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false }),
    supabase
      .from('chat_participants')
      .select('*')
      .eq('organization_id', organizationId),
    supabase
      .from('chat_conversation_prefs')
      .select('*')
      .eq('organization_id', organizationId),
  ]);
  if (conv.error) fail(conv.error, 'Gesprekken laden mislukt');
  if (part.error) fail(part.error, 'Deelnemers laden mislukt');
  return {
    conversations: (conv.data ?? []) as ChatConversation[],
    participants: (part.data ?? []) as ChatParticipant[],
    // Zonder de nieuwe migratie bestaat de tabel nog niet: dan gewoon geen voorkeuren.
    prefs: prefs.error ? [] : ((prefs.data ?? []) as ChatConversationPrefs[]),
  };
}

/** Het laatste bericht per gesprek — de voorbeeldregel in de gesprekslijst. */
export async function loadLastMessages(organizationId: UUID): Promise<ChatLastMessage[]> {
  const { data, error } = await supabase.rpc('chat_last_messages', { p_organization_id: organizationId });
  if (error) return [];
  return (data ?? []) as ChatLastMessage[];
}

/** Ongelezen berichten per gesprek voor de huidige gebruiker (RPC). */
export async function loadUnreadCounts(): Promise<ChatUnreadCount[]> {
  const { data, error } = await supabase.rpc('chat_unread_counts');
  if (error) fail(error, 'Ongelezen laden mislukt');
  return (data ?? []) as ChatUnreadCount[];
}

/** Start (of hervind) een 1-op-1 gesprek met een teamlid. Geeft het gesprek-id. */
export async function startDm(organizationId: UUID, otherUserId: UUID): Promise<UUID> {
  const { data, error } = await supabase.rpc('chat_start_dm', {
    p_organization_id: organizationId,
    p_other_user: otherUserId,
  });
  if (error) fail(error, 'Chat starten mislukt');
  return String(data) as UUID;
}

/** Een groepschat met meerdere collega's, met of zonder naam. */
export async function createGroup(organizationId: UUID, memberIds: UUID[], title?: string | null): Promise<UUID> {
  const { data, error } = await supabase.rpc('chat_create_group', {
    p_organization_id: organizationId,
    p_member_ids: memberIds,
    p_title: title?.trim() || null,
  });
  if (error) fail(error, 'Groepschat maken mislukt');
  return String(data) as UUID;
}

/** Een kanaal: openbaar (vindbaar voor de hele organisatie) of privé. */
export async function createChannel(
  organizationId: UUID,
  input: { title: string; description?: string | null; memberIds: UUID[]; visibility: 'public' | 'private' },
): Promise<UUID> {
  const { data, error } = await supabase.rpc('chat_create_channel', {
    p_organization_id: organizationId,
    p_title: input.title,
    p_member_ids: input.memberIds,
    p_description: input.description?.trim() || null,
    p_visibility: input.visibility,
  });
  if (error) fail(error, 'Kanaal maken mislukt');
  return String(data) as UUID;
}

/** Naam (en bij een kanaal de omschrijving) aanpassen. */
export async function updateConversation(conversationId: UUID, title: string | null, description?: string | null): Promise<void> {
  const { error } = await supabase.rpc('chat_update_conversation', {
    p_conversation_id: conversationId,
    p_title: title,
    p_description: description ?? null,
  });
  if (error) fail(error, 'Naam wijzigen mislukt');
}

/** Voeg leden toe aan een groepschat of kanaal. */
export async function addParticipants(conversationId: UUID, userIds: UUID[]): Promise<void> {
  const { error } = await supabase.rpc('chat_add_participants', {
    p_conversation_id: conversationId,
    p_user_ids: userIds,
  });
  if (error) fail(error, 'Toevoegen mislukt');
}

/** Haal iemand uit een groepschat of kanaal. */
export async function removeParticipant(conversationId: UUID, userId: UUID): Promise<void> {
  const { error } = await supabase.rpc('chat_remove_participant', {
    p_conversation_id: conversationId,
    p_user_id: userId,
  });
  if (error) fail(error, 'Verwijderen mislukt');
}

/** Verlaat een groepschat of kanaal. */
export async function leaveConversation(conversationId: UUID): Promise<void> {
  const { error } = await supabase.rpc('chat_leave', { p_conversation_id: conversationId });
  if (error) fail(error, 'Verlaten mislukt');
}

/** Openbare kanalen waar je nog niet in zit. */
export async function loadPublicChannels(organizationId: UUID): Promise<ChatPublicChannel[]> {
  const { data, error } = await supabase.rpc('chat_public_channels', { p_organization_id: organizationId });
  if (error) return [];
  return (data ?? []) as ChatPublicChannel[];
}

/** Deelnemen aan een openbaar kanaal. */
export async function joinChannel(conversationId: UUID): Promise<void> {
  const { error } = await supabase.rpc('chat_join_channel', { p_conversation_id: conversationId });
  if (error) fail(error, 'Deelnemen mislukt');
}

/** Markeer een gesprek als (nu) gelezen voor de huidige gebruiker. */
export async function markConversationRead(conversationId: UUID): Promise<void> {
  const { error } = await supabase.rpc('chat_mark_read', { p_conversation_id: conversationId });
  if (error) fail(error, 'Gelezen markeren mislukt');
}

/** Eigen voorkeuren voor een gesprek: wat je niet meegeeft, blijft zoals het was. */
export async function setConversationPrefs(
  conversationId: UUID,
  prefs: { pinned?: boolean; muted?: boolean; hidden?: boolean; unread?: boolean },
): Promise<void> {
  const { error } = await supabase.rpc('chat_set_preferences', {
    p_conversation_id: conversationId,
    p_pinned: prefs.pinned ?? null,
    p_muted: prefs.muted ?? null,
    p_hidden: prefs.hidden ?? null,
    p_unread: prefs.unread ?? null,
  });
  if (error) fail(error, 'Opslaan mislukt');
}

// ── Berichten laden ──────────────────────────────────────────────────────────

export interface MessagePage {
  messages: ChatMessage[];
  reactions: ChatMessageReaction[];
  /** Er zijn oudere berichten dan deze pagina. */
  hasMore: boolean;
}

async function reactionsFor(messageIds: UUID[]): Promise<ChatMessageReaction[]> {
  if (messageIds.length === 0) return [];
  const results = await Promise.all(chunks(messageIds).map((ids) => supabase
    .from('chat_message_reactions')
    .select('*')
    .in('message_id', ids)));
  const out: ChatMessageReaction[] = [];
  for (const r of results) {
    if (r.error) fail(r.error, 'Reacties laden mislukt');
    out.push(...((r.data ?? []) as ChatMessageReaction[]));
  }
  return out;
}

/**
 * Een chat (1-op-1 of groep): de laatste `limit` berichten, oplopend gesorteerd,
 * of — met `before` — de pagina daarvóór.
 */
export async function loadMessages(conversationId: UUID, opts: { limit?: number; before?: string } = {}): Promise<MessagePage> {
  const limit = opts.limit ?? 50;
  let query = supabase
    .from('chat_messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit + 1);
  if (opts.before) query = query.lt('created_at', opts.before);
  const { data, error } = await query;
  if (error) fail(error, 'Berichten laden mislukt');
  const rows = (data ?? []) as ChatMessage[];
  const hasMore = rows.length > limit;
  const messages = rows.slice(0, limit).reverse();
  const reactions = await reactionsFor(messages.map((m) => m.id));
  return { messages, reactions, hasMore };
}

/** Rond één bericht (voor "spring naar"): wat ervoor en erna kwam. */
export async function loadMessagesAround(conversationId: UUID, messageId: UUID, span = 25): Promise<MessagePage & { found: boolean }> {
  const target = await supabase.from('chat_messages').select('*').eq('id', messageId).maybeSingle();
  if (target.error) fail(target.error, 'Bericht laden mislukt');
  const msg = target.data as ChatMessage | null;
  if (!msg || msg.conversation_id !== conversationId) return { ...(await loadMessages(conversationId)), found: false };
  const [older, newer] = await Promise.all([
    supabase.from('chat_messages').select('*').eq('conversation_id', conversationId)
      .lt('created_at', msg.created_at).order('created_at', { ascending: false }).limit(span + 1),
    supabase.from('chat_messages').select('*').eq('conversation_id', conversationId)
      .gt('created_at', msg.created_at).order('created_at', { ascending: true }).limit(400),
  ]);
  if (older.error) fail(older.error, 'Berichten laden mislukt');
  if (newer.error) fail(newer.error, 'Berichten laden mislukt');
  const olderRows = (older.data ?? []) as ChatMessage[];
  const messages = [...olderRows.slice(0, span).reverse(), msg, ...((newer.data ?? []) as ChatMessage[])];
  const reactions = await reactionsFor(messages.map((m) => m.id));
  return { messages, reactions, hasMore: olderRows.length > span, found: true };
}

/**
 * Een kanaal: de laatste `limit` posts (zonder parent) met al hun antwoorden.
 * Een antwoord laat de volgorde van de posts ongemoeid, zoals in Teams.
 */
export async function loadChannelPosts(conversationId: UUID, opts: { limit?: number; before?: string } = {}): Promise<MessagePage> {
  const limit = opts.limit ?? 25;
  let query = supabase
    .from('chat_messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .is('parent_id', null)
    .order('created_at', { ascending: false })
    .limit(limit + 1);
  if (opts.before) query = query.lt('created_at', opts.before);
  const { data, error } = await query;
  if (error) fail(error, 'Berichten laden mislukt');
  const rows = (data ?? []) as ChatMessage[];
  const hasMore = rows.length > limit;
  const roots = rows.slice(0, limit).reverse();
  const replies = await loadReplies(roots.map((r) => r.id));
  const messages = [...roots, ...replies];
  const reactions = await reactionsFor(messages.map((m) => m.id));
  return { messages, reactions, hasMore };
}

/** Een kanaal vanaf één post tot nu (voor "spring naar" bij een oudere post). */
export async function loadChannelPostsFrom(conversationId: UUID, fromIso: string): Promise<MessagePage> {
  const [newer, older] = await Promise.all([
    supabase.from('chat_messages').select('*').eq('conversation_id', conversationId)
      .is('parent_id', null).gte('created_at', fromIso).order('created_at', { ascending: true }).limit(200),
    supabase.from('chat_messages').select('id').eq('conversation_id', conversationId)
      .is('parent_id', null).lt('created_at', fromIso).limit(1),
  ]);
  if (newer.error) fail(newer.error, 'Berichten laden mislukt');
  const roots = (newer.data ?? []) as ChatMessage[];
  const replies = await loadReplies(roots.map((r) => r.id));
  const messages = [...roots, ...replies];
  const reactions = await reactionsFor(messages.map((m) => m.id));
  return { messages, reactions, hasMore: (older.data ?? []).length > 0 };
}

/** Alle antwoorden onder een set posts. */
export async function loadReplies(rootIds: UUID[]): Promise<ChatMessage[]> {
  if (rootIds.length === 0) return [];
  const results = await Promise.all(chunks(rootIds, 60).map((ids) => supabase
    .from('chat_messages')
    .select('*')
    .in('parent_id', ids)
    .order('created_at', { ascending: true })
    .limit(2000)));
  const out: ChatMessage[] = [];
  for (const r of results) {
    if (r.error) fail(r.error, 'Antwoorden laden mislukt');
    out.push(...((r.data ?? []) as ChatMessage[]));
  }
  return out;
}

/** Losse berichten op id (voor citaten buiten beeld, opgeslagen berichten, activiteit). */
export async function loadMessagesByIds(ids: UUID[]): Promise<ChatMessage[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const results = await Promise.all(chunks(unique).map((part) => supabase.from('chat_messages').select('*').in('id', part)));
  const out: ChatMessage[] = [];
  for (const r of results) {
    if (r.error) fail(r.error, 'Berichten laden mislukt');
    out.push(...((r.data ?? []) as ChatMessage[]));
  }
  return out;
}

/** Vastgemaakte berichten van een gesprek, nieuwste eerst. */
export async function loadPinnedMessages(conversationId: UUID): Promise<ChatMessage[]> {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .not('pinned_at', 'is', null)
    .is('deleted_at', null)
    .order('pinned_at', { ascending: false })
    .limit(20);
  if (error) return [];
  return (data ?? []) as ChatMessage[];
}

/** Bijlagen voor een set berichten (entity_type='chat_message'). */
export async function loadMessageAttachments(organizationId: UUID, messageIds: UUID[]): Promise<Attachment[]> {
  if (messageIds.length === 0) return [];
  const results = await Promise.all(chunks(messageIds).map((ids) => supabase
    .from('attachments')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('entity_type', 'chat_message')
    .in('entity_id', ids)));
  const out: Attachment[] = [];
  for (const r of results) {
    if (r.error) fail(r.error, 'Bijlagen laden mislukt');
    out.push(...((r.data ?? []) as Attachment[]));
  }
  return out;
}

/** Gedeeld in één gesprek: de bestanden (met het bericht erbij) en de links. */
export async function loadConversationShared(organizationId: UUID, conversationId: UUID): Promise<{
  files: { attachment: Attachment; message: ChatMessage }[];
  links: { url: string; message: ChatMessage }[];
}> {
  const [withFiles, withLinks] = await Promise.all([
    supabase.from('chat_messages').select('*').eq('conversation_id', conversationId)
      .gt('attachment_count', 0).is('deleted_at', null).order('created_at', { ascending: false }).limit(300),
    supabase.from('chat_messages').select('*').eq('conversation_id', conversationId)
      .or('body.ilike.*http*,body.ilike.*www.*').is('deleted_at', null).order('created_at', { ascending: false }).limit(300),
  ]);
  if (withFiles.error) fail(withFiles.error, 'Gedeelde bestanden laden mislukt');
  const fileMessages = (withFiles.data ?? []) as ChatMessage[];
  const byId = new Map(fileMessages.map((m) => [m.id, m]));
  const attachments = await loadMessageAttachments(organizationId, fileMessages.map((m) => m.id));
  const files = attachments
    .map((attachment) => ({ attachment, message: byId.get(attachment.entity_id)! }))
    .filter((f) => !!f.message)
    .sort((a, b) => b.attachment.created_at.localeCompare(a.attachment.created_at));
  const links: { url: string; message: ChatMessage }[] = [];
  const seen = new Set<string>();
  for (const message of ((withLinks.data ?? []) as ChatMessage[])) {
    for (const url of extractUrls(message.body)) {
      if (seen.has(url)) continue;
      seen.add(url);
      links.push({ url, message });
    }
  }
  return { files, links };
}

/** Alle bestanden uit de chats waar je in zit (RLS + het hek op bijlagen). */
export async function loadChatFiles(organizationId: UUID): Promise<{ attachment: Attachment; message: ChatMessage | null }[]> {
  const { data, error } = await supabase
    .from('attachments')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('entity_type', 'chat_message')
    .order('created_at', { ascending: false })
    .limit(300);
  if (error) fail(error, 'Bestanden laden mislukt');
  const attachments = (data ?? []) as Attachment[];
  const messages = await loadMessagesByIds(attachments.map((a) => a.entity_id));
  const byId = new Map(messages.map((m) => [m.id, m]));
  return attachments.map((attachment) => ({ attachment, message: byId.get(attachment.entity_id) ?? null }));
}

/** Zoeken in alle berichten van je gesprekken. */
export async function searchMessages(organizationId: UUID, query: string, limit = 30): Promise<ChatMessage[]> {
  const term = query.trim().replace(/[%_\\]/g, (c) => `\\${c}`);
  if (term.length < 2) return [];
  const { data, error } = await supabase
    .from('chat_messages')
    .select('*')
    .eq('organization_id', organizationId)
    .ilike('body', `%${term}%`)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) fail(error, 'Zoeken mislukt');
  return ((data ?? []) as ChatMessage[]).filter((m) => (m.kind ?? 'text') !== 'system');
}

// ── Berichten versturen ──────────────────────────────────────────────────────

export interface SendInput {
  body: string;
  mentions?: UUID[];
  files?: File[];
  kind?: Exclude<ChatMessageKind, 'system'>;
  replyToId?: UUID | null;
  parentId?: UUID | null;
  subject?: string | null;
  importance?: ChatImportance;
  meta?: ChatMessageMeta;
}

/**
 * Verstuur een bericht. De afzender + organisatie worden server-side (trigger)
 * gezet; wij leveren een client-side id zodat we bijlagen er meteen aan kunnen
 * hangen en het bericht optimistisch tonen. Bestanden gaan via de bestaande
 * R2-uploadpijplijn (entity_type='chat_message').
 */
export async function sendMessage(
  organizationId: UUID,
  conversationId: UUID,
  input: SendInput,
): Promise<{ message: ChatMessage; attachments: Attachment[]; failedUploads: number }> {
  const files = input.files ?? [];
  const id = crypto.randomUUID();
  const row: Record<string, unknown> = {
    id,
    conversation_id: conversationId,
    body: input.body,
    mentions: input.mentions ?? [],
    attachment_count: files.length,
  };
  // Alleen meesturen wat afwijkt van de standaard: zo werkt een gewoon bericht
  // ook nog tegen een database zonder de nieuwe kolommen.
  if (input.kind && input.kind !== 'text') row.kind = input.kind;
  if (input.replyToId) row.reply_to_id = input.replyToId;
  if (input.parentId) row.parent_id = input.parentId;
  if (input.subject?.trim()) row.subject = input.subject.trim();
  if (input.importance && input.importance !== 'normal') row.importance = input.importance;
  if (input.meta && Object.keys(input.meta).length) row.meta = input.meta;

  const { data, error } = await supabase.from('chat_messages').insert(row).select('*').single();
  if (error) fail(error, 'Versturen mislukt');
  const message = data as ChatMessage;

  // Het bericht is nu verzonden. Een mislukte upload mag NIET de hele verzending
  // laten falen (anders herstelt de composer de tekst en verstuurt de gebruiker
  // dezelfde tekst dubbel). We tellen mislukte uploads en corrigeren daarna de
  // attachment_count naar het werkelijke aantal.
  const attachments: Attachment[] = [];
  let failedUploads = 0;
  for (const file of files) {
    try {
      attachments.push(await uploadToR2(file, organizationId, { entity_type: 'chat_message', entity_id: id }));
    } catch {
      failedUploads += 1;
    }
  }
  if (files.length > 0) {
    // Correcte telling + een UPDATE-nudge zodat abonnees de bijlagen ophalen.
    await supabase
      .from('chat_messages')
      .update({ updated_at: new Date().toISOString(), attachment_count: attachments.length })
      .eq('id', id);
    message.attachment_count = attachments.length;
  }
  return { message, attachments, failedUploads };
}

/** Bewerk de tekst van een eigen bericht. */
export async function editMessage(messageId: UUID, body: string, mentions?: UUID[]): Promise<void> {
  const patch: Record<string, unknown> = { body, edited_at: new Date().toISOString() };
  if (mentions) patch.mentions = mentions;
  const { error } = await supabase.from('chat_messages').update(patch).eq('id', messageId);
  if (error) fail(error, 'Bewerken mislukt');
}

/** Trek een eigen bericht in (soft-delete: tekst leeg, tombstone blijft staan). */
export async function deleteMessage(messageId: UUID): Promise<void> {
  const { error } = await supabase
    .from('chat_messages')
    .update({ body: '', deleted_at: new Date().toISOString() })
    .eq('id', messageId);
  if (error) fail(error, 'Verwijderen mislukt');
}

/** "Ongedaan maken" na intrekken: de tekst komt terug. */
export async function restoreMessage(messageId: UUID, body: string): Promise<void> {
  const { error } = await supabase
    .from('chat_messages')
    .update({ body, deleted_at: null })
    .eq('id', messageId);
  if (error) fail(error, 'Herstellen mislukt');
}

/** Vastmaken of losmaken (mag bij elk bericht in het gesprek). */
export async function pinMessage(messageId: UUID, pinned: boolean): Promise<void> {
  const { error } = await supabase.rpc('chat_pin_message', { p_message_id: messageId, p_pinned: pinned });
  if (error) fail(error, pinned ? 'Vastmaken mislukt' : 'Losmaken mislukt');
}

// ── Reacties ─────────────────────────────────────────────────────────────────

/** Voeg een emoji-reactie toe (gesprek + organisatie worden server-side gezet). */
export async function addReaction(messageId: UUID, emoji: string): Promise<void> {
  const { error } = await supabase
    .from('chat_message_reactions')
    .insert({ message_id: messageId, emoji })
    .select('message_id')
    .single();
  // Dubbele reactie (zelfde emoji) is geen fout — negeer een unique-violation.
  if (error && error.code !== '23505') fail(error, 'Reageren mislukt');
}

/** Verwijder je eigen emoji-reactie (RLS beperkt tot eigen rijen). */
export async function removeReaction(messageId: UUID, emoji: string): Promise<void> {
  const { error } = await supabase
    .from('chat_message_reactions')
    .delete()
    .eq('message_id', messageId)
    .eq('emoji', emoji);
  if (error) fail(error, 'Reactie weghalen mislukt');
}

// ── Opgeslagen berichten ─────────────────────────────────────────────────────

export async function loadSavedMessageIds(organizationId: UUID): Promise<{ message_id: UUID; created_at: string }[]> {
  const { data, error } = await supabase
    .from('chat_saved_messages')
    .select('message_id, created_at')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) return [];
  return (data ?? []) as { message_id: UUID; created_at: string }[];
}

export async function saveMessage(messageId: UUID): Promise<void> {
  const { error } = await supabase.from('chat_saved_messages').insert({ message_id: messageId });
  if (error && error.code !== '23505') fail(error, 'Opslaan mislukt');
}

export async function unsaveMessage(messageId: UUID): Promise<void> {
  const { error } = await supabase.from('chat_saved_messages').delete().eq('message_id', messageId);
  if (error) fail(error, 'Verwijderen uit opgeslagen mislukt');
}

// ── Status ───────────────────────────────────────────────────────────────────

export async function loadMemberStatuses(organizationId: UUID): Promise<ChatMemberStatus[]> {
  const { data, error } = await supabase
    .from('chat_member_status')
    .select('*')
    .eq('organization_id', organizationId);
  if (error) return [];
  return (data ?? []) as ChatMemberStatus[];
}

export async function saveMyStatus(
  organizationId: UUID,
  userId: UUID,
  status: { availability: ChatAvailability; status_message: string | null; message_expires_at: string | null },
): Promise<ChatMemberStatus> {
  const { data, error } = await supabase
    .from('chat_member_status')
    .upsert({ organization_id: organizationId, user_id: userId, ...status }, { onConflict: 'organization_id,user_id' })
    .select('*')
    .single();
  if (error) fail(error, 'Status opslaan mislukt');
  return data as ChatMemberStatus;
}

// ── Activiteit ───────────────────────────────────────────────────────────────

export async function loadActivity(organizationId: UUID, limit = 60): Promise<ChatActivityItem[]> {
  const { data, error } = await supabase.rpc('chat_activity', { p_organization_id: organizationId, p_limit: limit });
  if (error) return [];
  return (data ?? []) as ChatActivityItem[];
}
