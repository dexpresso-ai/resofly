import { supabase } from './supabase';
import { uploadToR2 } from './r2';
import type {
  Attachment,
  ChatConversation,
  ChatMessage,
  ChatMessageReaction,
  ChatParticipant,
  ChatUnreadCount,
  UUID,
} from '../types';

/**
 * Data-laag voor de teamchat. Alle toegang loopt rechtstreeks met de gebruikers-
 * client onder RLS (net als tickets/notities); structurele mutaties (gesprek
 * starten, leden toevoegen, gelezen markeren) lopen via SECURITY DEFINER RPC's uit
 * migratie 20260705000001_team_chat.sql. Zo blijft realtime werken zonder edge
 * function.
 */

// ── Laden ────────────────────────────────────────────────────────────────────

/** Alle gesprekken (RLS: alleen waar je zelf in zit) + de bijbehorende deelnemers. */
export async function loadConversations(organizationId: UUID): Promise<{
  conversations: ChatConversation[];
  participants: ChatParticipant[];
}> {
  const [conv, part] = await Promise.all([
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
  ]);
  if (conv.error) throw conv.error;
  if (part.error) throw part.error;
  return {
    conversations: (conv.data ?? []) as ChatConversation[],
    participants: (part.data ?? []) as ChatParticipant[],
  };
}

/** De laatste `limit` berichten van een gesprek (oplopend gesorteerd) + reacties. */
export async function loadMessages(conversationId: UUID, limit = 100): Promise<{
  messages: ChatMessage[];
  reactions: ChatMessageReaction[];
}> {
  const [msg, react] = await Promise.all([
    supabase
      .from('chat_messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(limit),
    supabase
      .from('chat_message_reactions')
      .select('*')
      .eq('conversation_id', conversationId),
  ]);
  if (msg.error) throw msg.error;
  if (react.error) throw react.error;
  const messages = ((msg.data ?? []) as ChatMessage[]).slice().reverse();
  return { messages, reactions: (react.data ?? []) as ChatMessageReaction[] };
}

/** Bijlagen voor een set berichten (entity_type='chat_message'). */
export async function loadMessageAttachments(organizationId: UUID, messageIds: UUID[]): Promise<Attachment[]> {
  if (messageIds.length === 0) return [];
  const { data, error } = await supabase
    .from('attachments')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('entity_type', 'chat_message')
    .in('entity_id', messageIds);
  if (error) throw error;
  return (data ?? []) as Attachment[];
}

/** Ongelezen berichten per gesprek voor de huidige gebruiker (RPC). */
export async function loadUnreadCounts(): Promise<ChatUnreadCount[]> {
  const { data, error } = await supabase.rpc('chat_unread_counts');
  if (error) throw error;
  return (data ?? []) as ChatUnreadCount[];
}

// ── Gesprekken beheren (RPC's) ───────────────────────────────────────────────

/** Start (of hervind) een 1-op-1 gesprek met een teamlid. Geeft het gesprek-id. */
export async function startDm(organizationId: UUID, otherUserId: UUID): Promise<UUID> {
  const { data, error } = await supabase.rpc('chat_start_dm', {
    p_organization_id: organizationId,
    p_other_user: otherUserId,
  });
  if (error) throw error;
  return String(data) as UUID;
}

/** Maak een groepskanaal met een naam en (optioneel) beginleden. Geeft het id. */
export async function createChannel(organizationId: UUID, title: string, memberIds: UUID[]): Promise<UUID> {
  const { data, error } = await supabase.rpc('chat_create_channel', {
    p_organization_id: organizationId,
    p_title: title,
    p_member_ids: memberIds,
  });
  if (error) throw error;
  return String(data) as UUID;
}

/** Voeg leden toe aan een kanaal. */
export async function addParticipants(conversationId: UUID, userIds: UUID[]): Promise<void> {
  const { error } = await supabase.rpc('chat_add_participants', {
    p_conversation_id: conversationId,
    p_user_ids: userIds,
  });
  if (error) throw error;
}

/** Verlaat een kanaal. */
export async function leaveConversation(conversationId: UUID): Promise<void> {
  const { error } = await supabase.rpc('chat_leave', { p_conversation_id: conversationId });
  if (error) throw error;
}

/** Markeer een gesprek als (nu) gelezen voor de huidige gebruiker. */
export async function markConversationRead(conversationId: UUID): Promise<void> {
  const { error } = await supabase.rpc('chat_mark_read', { p_conversation_id: conversationId });
  if (error) throw error;
}

/** Hernoem/omschrijf een kanaal (elke deelnemer mag dit via RLS). */
export async function renameChannel(conversationId: UUID, title: string): Promise<void> {
  const { error } = await supabase
    .from('chat_conversations')
    .update({ title })
    .eq('id', conversationId);
  if (error) throw error;
}

// ── Berichten ────────────────────────────────────────────────────────────────

/**
 * Verstuur een bericht. De afzender + organisatie worden server-side (trigger)
 * gezet; wij leveren een client-side id zodat we bijlagen er meteen aan kunnen
 * hangen en het bericht optimistisch tonen. Bestanden gaan via de bestaande
 * R2-uploadpijplijn (entity_type='chat_message').
 */
export async function sendMessage(
  organizationId: UUID,
  conversationId: UUID,
  input: { body: string; mentions?: UUID[]; files?: File[] },
): Promise<{ message: ChatMessage; attachments: Attachment[]; failedUploads: number }> {
  const files = input.files ?? [];
  const id = crypto.randomUUID();
  const { data, error } = await supabase
    .from('chat_messages')
    .insert({
      id,
      conversation_id: conversationId,
      body: input.body,
      mentions: input.mentions ?? [],
      attachment_count: files.length,
    })
    .select('*')
    .single();
  if (error) throw error;
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
export async function editMessage(messageId: UUID, body: string): Promise<void> {
  const { error } = await supabase
    .from('chat_messages')
    .update({ body, edited_at: new Date().toISOString() })
    .eq('id', messageId);
  if (error) throw error;
}

/** Trek een eigen bericht in (soft-delete: tekst leeg, tombstone blijft staan). */
export async function deleteMessage(messageId: UUID): Promise<void> {
  const { error } = await supabase
    .from('chat_messages')
    .update({ body: '', deleted_at: new Date().toISOString() })
    .eq('id', messageId);
  if (error) throw error;
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
  if (error && error.code !== '23505') throw error;
}

/** Verwijder je eigen emoji-reactie (RLS beperkt tot eigen rijen). */
export async function removeReaction(messageId: UUID, emoji: string): Promise<void> {
  const { error } = await supabase
    .from('chat_message_reactions')
    .delete()
    .eq('message_id', messageId)
    .eq('emoji', emoji);
  if (error) throw error;
}
