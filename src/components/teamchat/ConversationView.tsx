import {
  Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode,
} from 'react';
import {
  ArrowDown, ArrowLeft, BellOff, Bell, ChevronDown, Download, EyeOff, FileText, Hash, Link2, LogOut, MailOpen,
  MessageSquare, MoreHorizontal, Pencil, Phone, Pin, PinOff, SquarePen, UserMinus, UserPlus, Users, Video, X,
} from 'lucide-react';
import {
  deleteMessage, editMessage, leaveConversation, loadChannelPosts, loadChannelPostsFrom, loadConversationShared,
  loadMessageAttachments, loadMessages, loadMessagesAround, loadMessagesByIds, loadPinnedMessages, pinMessage,
  removeParticipant, restoreMessage, sendMessage, startDm, addReaction, removeReaction,
} from '../../lib/chat';
import { downloadAttachment } from '../../lib/r2';
import { supabase, supabaseAuth } from '../../lib/supabase';
import type { Attachment, ChatMessage, ChatMessageReaction } from '../../types';
import { FileIcon } from './attachments';
import { Composer, type ComposerHandle, type ComposerSubmit } from './Composer';
import { AddPeopleDialog, ConversationAvatar, ForwardDialog, MeetingDialog, RenameDialog } from './Dialogs';
import {
  ChatMessageRow, MessageContext, PostCard, receiptFor, SystemLine, type MessageActions, type MessageContextValue,
} from './Message';
import {
  activeStatusMessage, continuesGroup, dayKey, formatBytes, formatDayLabel, formatListTime, memberDisplay,
  mentionIdsIn, PRESENCE_LABEL, ts, type ConversationVM,
} from './model';
import type { TeamChatApi } from './useTeamChat';
import { Avatar, copyText, IconButton, Menu, type MenuItem } from './ui';

// ── Berichten van één gesprek: laden, ouder laden, springen, realtime ────────

type Layout = 'chat' | 'posts';

function useConversationMessages(api: TeamChatApi, conversationId: string, layout: Layout) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [reactions, setReactions] = useState<ChatMessageReaction[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [extra, setExtra] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesRef = useRef(messages); messagesRef.current = messages;
  const extraRef = useRef(extra); extraRef.current = extra;
  const aliveRef = useRef(true);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
  const orgId = api.organizationId;

  const sortMsgs = (list: ChatMessage[]) => [...list].sort((a, b) => ts(a.created_at) - ts(b.created_at));

  const mergeMessages = useCallback((incoming: ChatMessage[]) => {
    if (incoming.length === 0) return;
    setMessages((prev) => {
      const map = new Map(prev.map((m) => [m.id, m]));
      for (const m of incoming) map.set(m.id, { ...(map.get(m.id) ?? {}), ...m });
      return sortMsgs([...map.values()]);
    });
  }, []);

  const mergeReactions = useCallback((rows: ChatMessageReaction[]) => {
    if (rows.length === 0) return;
    setReactions((prev) => {
      const key = (r: ChatMessageReaction) => `${r.message_id}|${r.user_id}|${r.emoji}`;
      const map = new Map(prev.map((r) => [key(r), r]));
      for (const r of rows) map.set(key(r), r);
      return [...map.values()];
    });
  }, []);

  // Bijlagen van deze berichten opnieuw ophalen en VERVANGEN: een verwijderde
  // bijlage verdwijnt dan ook echt uit beeld.
  const fetchAttachments = useCallback(async (msgs: ChatMessage[]) => {
    if (!orgId || msgs.length === 0) return;
    const scope = new Set(msgs.map((m) => m.id));
    const need = msgs.filter((m) => m.attachment_count > 0).map((m) => m.id);
    try {
      const rows = need.length ? await loadMessageAttachments(orgId, need) : [];
      if (!aliveRef.current) return;
      setAttachments((prev) => [...prev.filter((a) => !scope.has(a.entity_id)), ...rows]);
    } catch { /* het bericht staat er; de bijlage komt bij de volgende keer */ }
  }, [orgId]);

  // Citaten van berichten die buiten het geladen venster vallen.
  const loadQuotes = useCallback(async (msgs: ChatMessage[]) => {
    const known = new Set([...messagesRef.current, ...extraRef.current].map((m) => m.id));
    for (const m of msgs) known.add(m.id);
    const missing = [...new Set(msgs.map((m) => m.reply_to_id).filter((id): id is string => !!id && !known.has(id)))];
    if (missing.length === 0) return;
    try {
      const rows = await loadMessagesByIds(missing);
      if (aliveRef.current) setExtra((prev) => [...prev, ...rows]);
    } catch { /* het citaat toont dan "niet meer beschikbaar" */ }
  }, []);

  const applyPage = useCallback((page: { messages: ChatMessage[]; reactions: ChatMessageReaction[]; hasMore: boolean }, replace: boolean) => {
    if (replace) { setMessages(sortMsgs(page.messages)); setReactions(page.reactions); }
    else { mergeMessages(page.messages); mergeReactions(page.reactions); }
    setHasMore(page.hasMore);
    void fetchAttachments(page.messages);
    void loadQuotes(page.messages);
  }, [mergeMessages, mergeReactions, fetchAttachments, loadQuotes]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setMessages([]); setReactions([]); setAttachments([]); setExtra([]); setHasMore(false);
    (layout === 'posts' ? loadChannelPosts(conversationId) : loadMessages(conversationId))
      .then((page) => { if (!cancelled) { applyPage(page, true); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : 'Laden mislukt'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [conversationId, layout, applyPage]);

  const loadOlder = useCallback(async (): Promise<boolean> => {
    if (loadingOlder || !hasMore) return false;
    const roots = layout === 'posts' ? messagesRef.current.filter((m) => !m.parent_id) : messagesRef.current;
    const oldest = roots[0];
    if (!oldest) return false;
    setLoadingOlder(true);
    try {
      const page = layout === 'posts'
        ? await loadChannelPosts(conversationId, { before: oldest.created_at })
        : await loadMessages(conversationId, { before: oldest.created_at });
      if (!aliveRef.current) return false;
      applyPage(page, false);
      return true;
    } catch {
      return false;
    } finally {
      if (aliveRef.current) setLoadingOlder(false);
    }
  }, [loadingOlder, hasMore, layout, conversationId, applyPage]);

  const loadAround = useCallback(async (messageId: string): Promise<boolean> => {
    try {
      if (layout === 'chat') {
        const page = await loadMessagesAround(conversationId, messageId);
        if (!page.found || !aliveRef.current) return false;
        applyPage(page, true);
        return true;
      }
      const [target] = await loadMessagesByIds([messageId]);
      if (!target || target.conversation_id !== conversationId) return false;
      let root = target;
      if (target.parent_id) {
        const [r] = await loadMessagesByIds([target.parent_id]);
        if (r) root = r;
      }
      const page = await loadChannelPostsFrom(conversationId, root.created_at);
      if (!aliveRef.current) return false;
      applyPage(page, true);
      return true;
    } catch {
      return false;
    }
  }, [layout, conversationId, applyPage]);

  useEffect(() => api.onRealtime((ev) => {
    if (ev.table === 'chat_messages') {
      const row = (ev.new ?? ev.old) as unknown as ChatMessage | null;
      if (!row || row.conversation_id !== conversationId) return;
      if (ev.eventType === 'INSERT' && ev.new) {
        const msg = ev.new as unknown as ChatMessage;
        // Een antwoord onder een post die hier niet geladen is: niet los tonen.
        if (layout === 'posts' && msg.parent_id && !messagesRef.current.some((m) => m.id === msg.parent_id)) return;
        mergeMessages([msg]);
        if (msg.attachment_count > 0) {
          void fetchAttachments([msg]);
          window.setTimeout(() => { if (aliveRef.current) void fetchAttachments([msg]); }, 1800);
        }
        if (msg.reply_to_id) void loadQuotes([msg]);
      } else if (ev.eventType === 'UPDATE' && ev.new) {
        const msg = ev.new as unknown as ChatMessage;
        setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev.map((m) => (m.id === msg.id ? { ...m, ...msg } : m)) : prev));
        setExtra((prev) => (prev.some((m) => m.id === msg.id) ? prev.map((m) => (m.id === msg.id ? { ...m, ...msg } : m)) : prev));
        if (msg.attachment_count > 0) void fetchAttachments([msg]);
      }
    } else if (ev.table === 'chat_message_reactions') {
      const row = (ev.new ?? ev.old) as unknown as ChatMessageReaction | null;
      if (!row || row.conversation_id !== conversationId) return;
      if (ev.eventType === 'INSERT' && ev.new) mergeReactions([ev.new as unknown as ChatMessageReaction]);
      else if (ev.eventType === 'DELETE' && ev.old) {
        const r = ev.old as unknown as Partial<ChatMessageReaction>;
        setReactions((prev) => prev.filter((x) => !(x.message_id === r.message_id && x.user_id === r.user_id && x.emoji === r.emoji)));
      }
    }
  }), [api.onRealtime, conversationId, layout, mergeMessages, mergeReactions, fetchAttachments, loadQuotes]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    messages, reactions, attachments, extra, loading, loadingOlder, hasMore, error, setError,
    setMessages, setReactions, setAttachments, mergeMessages, loadOlder, loadAround, fetchAttachments,
  };
}

// ── Typen ("Bob typt…") ──────────────────────────────────────────────────────

function useTyping(api: TeamChatApi, conversationId: string) {
  const [typing, setTyping] = useState<string[]>([]);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const timers = useRef<Map<string, number>>(new Map());
  const lastSent = useRef(0);
  const me = api.currentUserId;

  const remove = useCallback((uid: string) => {
    setTyping((prev) => (prev.includes(uid) ? prev.filter((x) => x !== uid) : prev));
    const t = timers.current.get(uid);
    if (t) { window.clearTimeout(t); timers.current.delete(uid); }
  }, []);

  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;
    const timerMap = timers.current;
    supabaseAuth.getSession().then(({ data }) => {
      if (cancelled) return;
      const token = data.session?.access_token;
      if (token) supabase.realtime.setAuth(token);
      channel = supabase.channel(`chat:typing:${conversationId}`, { config: { broadcast: { self: false } } });
      channel.on('broadcast', { event: 'typing' }, (msg) => {
        const uid = (msg.payload as { user_id?: string })?.user_id;
        if (!uid || uid === me) return;
        setTyping((prev) => (prev.includes(uid) ? prev : [...prev, uid]));
        const existing = timerMap.get(uid);
        if (existing) window.clearTimeout(existing);
        timerMap.set(uid, window.setTimeout(() => remove(uid), 3500));
      }).subscribe();
      channelRef.current = channel;
    });
    return () => {
      cancelled = true;
      channelRef.current = null;
      timerMap.forEach((t) => window.clearTimeout(t));
      timerMap.clear();
      setTyping([]);
      if (channel) supabase.removeChannel(channel);
    };
  }, [conversationId, me, remove]);

  // Wie een bericht stuurt, is klaar met typen.
  useEffect(() => api.onRealtime((ev) => {
    if (ev.table === 'chat_messages' && ev.eventType === 'INSERT' && ev.new?.conversation_id === conversationId) {
      const uid = ev.new.sender_id as string | undefined;
      if (uid) remove(uid);
    }
  }), [api.onRealtime, conversationId, remove]); // eslint-disable-line react-hooks/exhaustive-deps

  const broadcast = useCallback(() => {
    const now = Date.now();
    if (now - lastSent.current < 1800) return;
    lastSent.current = now;
    void channelRef.current?.send({ type: 'broadcast', event: 'typing', payload: { user_id: me } });
  }, [me]);

  return { typing, broadcast };
}

// ── Het gespreksvenster ──────────────────────────────────────────────────────

export interface JumpRequest { messageId: string; seq: number }

export function ConversationView({ api, vm, single, onBack, jump, onJumpHandled, onOpenConversation }: {
  api: TeamChatApi;
  vm: ConversationVM;
  /** Eén venster tegelijk (telefoon of zwevend paneel): met een terugpijl. */
  single: boolean;
  onBack: () => void;
  jump: JumpRequest | null;
  onJumpHandled: () => void;
  onOpenConversation: (id: string, messageId?: string | null) => void;
}) {
  const isChannel = vm.kind === 'channel';
  const layout: Layout = isChannel ? 'posts' : 'chat';
  const me = api.currentUserId;
  const conv = useConversationMessages(api, vm.id, layout);
  const { typing, broadcast } = useTyping(api, vm.id);

  const [tab, setTab] = useState<'chat' | 'shared'>('chat');
  const [membersOpen, setMembersOpen] = useState(false);
  const [dialog, setDialog] = useState<null | 'rename' | 'video' | 'audio' | 'add'>(null);
  const [forwardMsg, setForwardMsg] = useState<ChatMessage | null>(null);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [undoable, setUndoable] = useState<Map<string, string>>(new Map());
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [postOpen, setPostOpen] = useState(() => !!api.getDraft(vm.id).trim());
  const [replyOpenId, setReplyOpenId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [pinned, setPinned] = useState<ChatMessage[]>([]);
  const [pinnedIdx, setPinnedIdx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const composerRef = useRef<ComposerHandle>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  /** Een bericht in dít venster (er kunnen meerdere chattabbladen open staan). */
  const findMessageEl = useCallback((messageId: string) => sectionRef.current?.querySelector<HTMLElement>(`[id="tmc-msg-${messageId}"]`) ?? null, []);
  const manualUnread = useRef(false);

  // Meldingen voor dit gesprek zijn overbodig zolang het open staat.
  useEffect(() => api.registerView(vm.id), [api.registerView, vm.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Waar was je gebleven? Vastgelegd bij het openen, vóór "gelezen".
  const [lastReadOnOpen] = useState(() => api.participants.find((p) => p.conversation_id === vm.id && p.user_id === me)?.last_read_at ?? null);

  // Gelezen zodra je kijkt — tenzij je het net zelf op ongelezen zette.
  useEffect(() => {
    const read = () => {
      if (document.visibilityState !== 'visible' || manualUnread.current) return;
      if (vm.unread > 0) void api.markRead(vm.id);
    };
    read();
    document.addEventListener('visibilitychange', read);
    return () => document.removeEventListener('visibilitychange', read);
  }, [api, vm.id, vm.unread]);
  useEffect(() => {
    const last = conv.messages[conv.messages.length - 1];
    if (last && last.sender_id !== me) manualUnread.current = false;
  }, [conv.messages, me]);

  // Vastgemaakte berichten: bij openen, en opnieuw zodra er iets aan vastmaken verandert.
  const reloadPinned = useCallback(async () => setPinned(await loadPinnedMessages(vm.id)), [vm.id]);
  useEffect(() => { void reloadPinned(); setPinnedIdx(0); }, [reloadPinned]);
  useEffect(() => api.onRealtime((ev) => {
    if (ev.table !== 'chat_messages' || ev.eventType !== 'UPDATE' || ev.new?.conversation_id !== vm.id) return;
    const known = pinned.find((p) => p.id === ev.new?.id);
    if ((ev.new?.pinned_at ?? null) !== (known?.pinned_at ?? null) || (known && ev.new?.deleted_at)) void reloadPinned();
  }), [api.onRealtime, vm.id, pinned, reloadPinned]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (!notice) return; const t = window.setTimeout(() => setNotice(null), 4000); return () => window.clearTimeout(t); }, [notice]);

  const others = useMemo(
    () => api.participants.filter((p) => p.conversation_id === vm.id && p.user_id !== me),
    [api.participants, vm.id, me],
  );
  const names = useMemo(() => [...vm.memberIds.map((id) => memberDisplay(api.memberById.get(id)).name), 'iedereen'], [vm.memberIds, api.memberById]);
  const myName = memberDisplay(api.memberById.get(me ?? '')).name;

  const messagesById = useMemo(() => new Map([...conv.extra, ...conv.messages].map((m) => [m.id, m])), [conv.extra, conv.messages]);
  const reactionsByMessage = useMemo(() => {
    const map = new Map<string, ChatMessageReaction[]>();
    for (const r of conv.reactions) { const list = map.get(r.message_id) ?? []; list.push(r); map.set(r.message_id, list); }
    return map;
  }, [conv.reactions]);
  const attachmentsByMessage = useMemo(() => {
    const map = new Map<string, Attachment[]>();
    for (const a of conv.attachments) { const list = map.get(a.entity_id) ?? []; list.push(a); map.set(a.entity_id, list); }
    return map;
  }, [conv.attachments]);

  // ── Springen naar een bericht ──────────────────────────────────────────────

  const flash = useCallback((messageId: string) => {
    const el = findMessageEl(messageId);
    if (!el) return false;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setHighlightId(messageId);
    window.setTimeout(() => setHighlightId((cur) => (cur === messageId ? null : cur)), 2200);
    return true;
  }, [findMessageEl]);

  const jumpTo = useCallback(async (messageId: string) => {
    setTab('chat');
    const target = messagesById.get(messageId);
    if (isChannel && target?.parent_id) setExpandedIds((prev) => new Set(prev).add(target.parent_id!));
    if (conv.messages.some((m) => m.id === messageId)) {
      window.requestAnimationFrame(() => flash(messageId));
      return;
    }
    const ok = await conv.loadAround(messageId);
    if (!ok) { setNotice('Dat bericht is niet meer te vinden.'); return; }
    window.setTimeout(() => {
      const msg = findMessageEl(messageId);
      if (!msg) {
        // Een antwoord in een ingeklapt draadje: eerst uitklappen.
        setExpandedIds((prev) => { const next = new Set(prev); conv.messages.forEach((m) => { if (m.parent_id) next.add(m.parent_id); }); return next; });
      }
      window.setTimeout(() => flash(messageId), 60);
    }, 80);
  }, [messagesById, isChannel, conv, flash, findMessageEl]);

  useEffect(() => {
    if (!jump || conv.loading) return;
    void jumpTo(jump.messageId);
    onJumpHandled();
  }, [jump, conv.loading]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Acties op berichten ────────────────────────────────────────────────────

  const actions: MessageActions = useMemo(() => ({
    react: (msg, emoji) => {
      if (!me) return;
      const has = conv.reactions.some((r) => r.message_id === msg.id && r.user_id === me && r.emoji === emoji);
      if (has) {
        conv.setReactions((prev) => prev.filter((r) => !(r.message_id === msg.id && r.user_id === me && r.emoji === emoji)));
        removeReaction(msg.id, emoji).catch(() => setNotice('Reactie weghalen mislukt.'));
      } else {
        conv.setReactions((prev) => [...prev, { message_id: msg.id, conversation_id: vm.id, organization_id: vm.conversation.organization_id, user_id: me, emoji, created_at: new Date().toISOString() }]);
        addReaction(msg.id, emoji).catch(() => setNotice('Reageren mislukt.'));
      }
    },
    reply: (msg) => {
      if (isChannel) {
        const rootId = msg.parent_id ?? msg.id;
        setReplyOpenId(rootId);
        setExpandedIds((prev) => new Set(prev).add(rootId));
      } else {
        setReplyTo(msg);
        window.requestAnimationFrame(() => composerRef.current?.focus());
      }
    },
    edit: (msg) => setEditingId(msg.id),
    saveEdit: async (msg, body) => {
      const text = body.trim();
      if (!text || text === msg.body) { setEditingId(null); return; }
      const mentions = mentionIdsIn(text, vm.memberIds, api.memberById, me, vm.kind !== 'dm');
      const editedAt = new Date().toISOString();
      conv.setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, body: text, mentions, edited_at: editedAt } : m)));
      setEditingId(null);
      try { await editMessage(msg.id, text, mentions); }
      catch (e) {
        conv.setMessages((prev) => prev.map((m) => (m.id === msg.id ? msg : m)));
        setNotice(e instanceof Error ? e.message : 'Bewerken mislukt');
      }
    },
    cancelEdit: () => { setEditingId(null); window.requestAnimationFrame(() => composerRef.current?.focus()); },
    remove: (msg) => {
      if (!confirm('Dit bericht verwijderen? Je collega’s zien dan “Dit bericht is verwijderd”.')) return;
      setUndoable((prev) => new Map(prev).set(msg.id, msg.body));
      conv.setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, body: '', deleted_at: new Date().toISOString() } : m)));
      deleteMessage(msg.id).catch((e) => {
        conv.setMessages((prev) => prev.map((m) => (m.id === msg.id ? msg : m)));
        setNotice(e instanceof Error ? e.message : 'Verwijderen mislukt');
      });
    },
    undoRemove: (msg) => {
      const body = undoable.get(msg.id);
      if (body === undefined) return;
      conv.setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, body, deleted_at: null } : m)));
      setUndoable((prev) => { const next = new Map(prev); next.delete(msg.id); return next; });
      restoreMessage(msg.id, body).catch((e) => setNotice(e instanceof Error ? e.message : 'Herstellen mislukt'));
    },
    pin: (msg, value) => {
      const at = value ? new Date().toISOString() : null;
      conv.setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, pinned_at: at, pinned_by: value ? me : null } : m)));
      pinMessage(msg.id, value)
        .then(() => { void reloadPinned(); setNotice(value ? 'Bericht vastgemaakt.' : 'Bericht losgemaakt.'); })
        .catch((e) => { conv.setMessages((prev) => prev.map((m) => (m.id === msg.id ? msg : m))); setNotice(e instanceof Error ? e.message : 'Mislukt'); });
    },
    toggleSaved: (msg) => {
      const was = api.savedIds.has(msg.id);
      api.toggleSaved(msg.id)
        .then(() => setNotice(was ? 'Niet meer opgeslagen.' : 'Opgeslagen. Je vindt het terug onder Opgeslagen.'))
        .catch(() => setNotice('Opslaan mislukt.'));
    },
    forward: (msg) => setForwardMsg(msg),
    copy: (msg) => { void copyText(msg.body).then((ok) => setNotice(ok ? 'Tekst gekopieerd.' : 'Kopiëren lukte niet.')); },
    markUnread: () => {
      manualUnread.current = true;
      api.setPrefs(vm.id, { unread: true }).then(() => setNotice('Gemarkeerd als ongelezen.')).catch(() => setNotice('Markeren mislukt.'));
    },
    jumpTo: (id) => { void jumpTo(id); },
    attachmentsChanged: (msg) => { void conv.fetchAttachments([msg]); },
  }), [me, conv, vm, isChannel, api, undoable, reloadPinned, jumpTo]);

  const ctx: MessageContextValue = {
    api, vm, names, myName, reactionsByMessage, attachmentsByMessage, messagesById, editingId, undoable, highlightId, actions,
  };

  // ── Versturen ──────────────────────────────────────────────────────────────

  async function submit(input: ComposerSubmit, extra: { parentId?: string } = {}): Promise<boolean> {
    if (!api.organizationId) return false;
    const { message, attachments, failedUploads } = await sendMessage(api.organizationId, vm.id, {
      body: input.body,
      mentions: input.mentions,
      files: input.files,
      importance: input.importance,
      subject: input.subject,
      replyToId: !isChannel ? replyTo?.id ?? null : null,
      parentId: extra.parentId ?? null,
    });
    conv.mergeMessages([message]);
    if (attachments.length) conv.setAttachments((prev) => [...prev, ...attachments]);
    if (!isChannel) setReplyTo(null);
    if (failedUploads > 0) setNotice(`${failedUploads} bestand${failedUploads === 1 ? '' : 'en'} kon niet worden geüpload.`);
    return true;
  }

  const editLast = useCallback(() => {
    const mine = [...conv.messages].reverse().find((m) => m.sender_id === me && !m.deleted_at && (m.kind ?? 'text') === 'text' && (!isChannel || !m.parent_id));
    if (mine) setEditingId(mine.id);
  }, [conv.messages, me, isChannel]);

  // ── Slepen en neerzetten ───────────────────────────────────────────────────

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (!api.canWrite || !Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    setDragging(true);
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    if (!api.canWrite) return;
    const files = Array.from(e.dataTransfer.files ?? []);
    e.preventDefault();
    setDragging(false);
    if (files.length === 0) return;
    setTab('chat');
    if (isChannel && !postOpen) { setPostOpen(true); setPendingFiles(files); return; }
    composerRef.current?.addFiles(files);
  }
  useEffect(() => {
    if (pendingFiles.length === 0) return;
    const t = window.setTimeout(() => { composerRef.current?.addFiles(pendingFiles); setPendingFiles([]); }, 30);
    return () => window.clearTimeout(t);
  }, [pendingFiles, postOpen]);

  // ── Kop ────────────────────────────────────────────────────────────────────

  const typingNames = typing.filter((id) => vm.memberIds.includes(id)).map((id) => memberDisplay(api.memberById.get(id)).first);
  const counterpart = vm.counterpartId;
  const presence = vm.kind === 'dm' ? api.presenceOf(counterpart) : null;
  const statusMessage = vm.kind === 'dm' ? activeStatusMessage(api.statuses.get(counterpart ?? '')) : null;
  let sub: string;
  if (typingNames.length) sub = `${typingNames.join(', ')} ${typingNames.length === 1 ? 'typt' : 'typen'}…`;
  else if (vm.kind === 'dm') sub = `${PRESENCE_LABEL[presence ?? 'offline']}${statusMessage ? ` · ${statusMessage}` : ''}`;
  else if (vm.kind === 'group') sub = `${vm.memberIds.length} deelnemers`;
  else sub = vm.conversation.description?.trim() || `${vm.isPrivate ? 'Privékanaal' : 'Kanaal'} · ${vm.memberIds.length} ${vm.memberIds.length === 1 ? 'lid' : 'leden'}`;

  const menuItems: MenuItem[] = [
    { key: 'pin', label: vm.pinned ? 'Losmaken' : 'Vastmaken', icon: vm.pinned ? <PinOff size={16} /> : <Pin size={16} />, onSelect: () => void api.setPrefs(vm.id, { pinned: !vm.pinned }) },
    { key: 'mute', label: vm.muted ? 'Dempen opheffen' : 'Dempen', icon: vm.muted ? <Bell size={16} /> : <BellOff size={16} />, onSelect: () => void api.setPrefs(vm.id, { muted: !vm.muted }), hint: vm.muted ? undefined : 'Alleen nog vermeldingen' },
    { key: 'unread', label: 'Markeren als ongelezen', icon: <MailOpen size={16} />, onSelect: actions.markUnread },
  ];
  if (vm.kind !== 'dm' && api.canWrite) menuItems.push({ key: 'rename', label: isChannel ? 'Kanaal bewerken' : 'Naam wijzigen', icon: <Pencil size={16} />, onSelect: () => setDialog('rename'), divider: true });
  if (vm.kind !== 'channel') menuItems.push({ key: 'hide', label: 'Verbergen', icon: <EyeOff size={16} />, onSelect: () => { void api.setPrefs(vm.id, { hidden: true }); onBack(); }, divider: vm.kind === 'dm' });
  if (vm.kind !== 'dm') {
    menuItems.push({
      key: 'leave', label: isChannel ? 'Kanaal verlaten' : 'Chat verlaten', icon: <LogOut size={16} />, danger: true, divider: true,
      onSelect: () => {
        if (!confirm(isChannel ? `#${vm.title} verlaten?` : 'Deze groepschat verlaten?')) return;
        leaveConversation(vm.id).then(() => { void api.reloadConversations(); onBack(); }).catch((e) => setNotice(e instanceof Error ? e.message : 'Verlaten mislukt'));
      },
    });
  }

  return (
    <MessageContext.Provider value={ctx}>
      <section
        ref={sectionRef}
        className={`tmc-conv${dragging ? ' is-dragging' : ''}${membersOpen ? ' has-side' : ''}`}
        aria-label={vm.title}
        onDragOver={onDragOver}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
        onDrop={onDrop}
      >
        <header className="tmc-head">
          {single && <IconButton label="Terug naar de lijst" onClick={onBack} className="tmc-back"><ArrowLeft size={20} /></IconButton>}
          <ConversationAvatar api={api} vm={vm} size={single ? 34 : 36} />
          <div className="tmc-head-id">
            <div className="tmc-head-title">
              {isChannel && <Hash size={15} className="tmc-head-hash" />}
              <h2 title={vm.title}>{vm.title}</h2>
              {vm.kind !== 'dm' && api.canWrite && !single && (
                <button type="button" className="tmc-head-edit" onClick={() => setDialog('rename')} aria-label={isChannel ? 'Kanaal bewerken' : 'Naam wijzigen'} title={isChannel ? 'Kanaal bewerken' : 'Naam wijzigen'}><Pencil size={13} /></button>
              )}
              {vm.muted && <BellOff size={13} className="tmc-head-muted" aria-label="Gedempt" />}
            </div>
            <div className={`tmc-head-sub${typingNames.length ? ' is-typing' : ''}`}>{sub}</div>
          </div>
          <nav className="tmc-tabs" role="tablist" aria-label="Weergave">
            <button type="button" role="tab" aria-selected={tab === 'chat'} className={tab === 'chat' ? 'is-active' : ''} onClick={() => setTab('chat')}>{isChannel ? 'Berichten' : 'Chat'}</button>
            <button type="button" role="tab" aria-selected={tab === 'shared'} className={tab === 'shared' ? 'is-active' : ''} onClick={() => setTab('shared')}>Gedeeld</button>
          </nav>
          <div className="tmc-head-actions">
            {api.canWrite && (
              <>
                <button type="button" className="tmc-meet-btn" onClick={() => setDialog('video')} title="Vergaderen" aria-label="Vergaderen"><Video size={17} /><span>Vergaderen</span></button>
                <IconButton label="Bellen (alleen geluid)" onClick={() => setDialog('audio')} className="tmc-call-btn"><Phone size={17} /></IconButton>
              </>
            )}
            {vm.kind === 'dm'
              ? api.canWrite && <IconButton label="Personen toevoegen" onClick={() => setDialog('add')}><UserPlus size={17} /></IconButton>
              : (
                <button type="button" className={`tmc-people-btn${membersOpen ? ' is-active' : ''}`} onClick={() => setMembersOpen((v) => !v)} aria-expanded={membersOpen} title="Deelnemers" aria-label={`${vm.memberIds.length} deelnemers`}>
                  <Users size={17} /><span>{vm.memberIds.length}</span>
                </button>
              )}
            <IconButton label="Meer opties" buttonRef={moreRef} onClick={() => setMenuOpen((v) => !v)} expanded={menuOpen}><MoreHorizontal size={18} /></IconButton>
            <Menu anchorRef={moreRef} open={menuOpen} onClose={() => setMenuOpen(false)} items={menuItems} />
          </div>
        </header>

        {tab === 'chat' && pinned.length > 0 && (
          <PinnedBar
            api={api}
            message={pinned[Math.min(pinnedIdx, pinned.length - 1)]}
            index={Math.min(pinnedIdx, pinned.length - 1)}
            total={pinned.length}
            onOpen={(id) => void jumpTo(id)}
            onNext={() => setPinnedIdx((i) => (i + 1) % pinned.length)}
            onUnpin={(m) => actions.pin(m, false)}
          />
        )}

        <div className="tmc-conv-body">
          <div className="tmc-conv-main">
            {tab === 'shared'
              ? <SharedPane api={api} vm={vm} onJump={(id) => void jumpTo(id)} />
              : isChannel
                ? <PostList
                    api={api}
                    vm={vm}
                    conv={conv}
                    expandedIds={expandedIds}
                    onToggleExpanded={(id) => setExpandedIds((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; })}
                    replyOpenId={replyOpenId}
                    onOpenReply={(id) => { setReplyOpenId(id); setExpandedIds((prev) => new Set(prev).add(id)); }}
                    renderReplyComposer={(root) => (
                      <Composer
                        api={api}
                        draftKey={`${vm.id}:${root.id}`}
                        memberIds={vm.memberIds}
                        mode="reply"
                        placeholder="Antwoorden"
                        onSubmit={(input) => submit(input, { parentId: root.id })}
                        onTyping={broadcast}
                        onCancel={() => setReplyOpenId(null)}
                        autoFocus
                        allowEveryone
                      />
                    )}
                    typingNames={typingNames}
                  />
                : <ChatList api={api} vm={vm} conv={conv} others={others} lastReadOnOpen={lastReadOnOpen} typingNames={typingNames} typingIds={typing} />}
          </div>
          {membersOpen && vm.kind !== 'dm' && (
            <MembersPanel api={api} vm={vm} onClose={() => setMembersOpen(false)} onAdd={() => setDialog('add')} onOpenConversation={onOpenConversation} onNotice={setNotice} onLeft={onBack} />
          )}
        </div>

        {notice && <div className="tmc-notice" role="status">{notice}<button type="button" onClick={() => setNotice(null)} aria-label="Sluiten"><X size={13} /></button></div>}

        {tab === 'chat' && (
          api.canWrite
            ? isChannel
              ? postOpen
                ? (
                  <div className="tmc-compose-wrap">
                    <Composer
                      ref={composerRef}
                      api={api}
                      draftKey={vm.id}
                      memberIds={vm.memberIds}
                      mode="post"
                      placeholder={`Nieuw bericht in #${vm.title} — typ @ om iemand te noemen`}
                      onSubmit={(input) => submit(input)}
                      onTyping={broadcast}
                      onEditLast={editLast}
                      onCancel={() => setPostOpen(false)}
                      autoFocus
                      allowEveryone
                    />
                  </div>
                )
                : (
                  <div className="tmc-compose-wrap is-collapsed">
                    <button type="button" className="tmc-new-post" onClick={() => setPostOpen(true)}><SquarePen size={17} /> Nieuw bericht</button>
                  </div>
                )
              : (
                <div className="tmc-compose-wrap">
                  <Composer
                    ref={composerRef}
                    api={api}
                    draftKey={vm.id}
                    memberIds={vm.memberIds}
                    mode="chat"
                    placeholder="Typ een bericht"
                    replyTo={replyTo}
                    onCancelReply={() => setReplyTo(null)}
                    onSubmit={(input) => submit(input)}
                    onTyping={broadcast}
                    onEditLast={editLast}
                    autoFocus={!single}
                    allowEveryone={vm.kind === 'group'}
                  />
                </div>
              )
            : <div className="tmc-readonly">Je kunt in de teamchat alleen meelezen. Vraag een beheerder als je ook wilt schrijven.</div>
        )}

        {dragging && <div className="tmc-drop" aria-hidden="true"><Download size={28} /><span>Zet de bestanden hier neer om ze te delen</span></div>}
      </section>

      {dialog === 'rename' && <RenameDialog api={api} vm={vm} onClose={() => setDialog(null)} />}
      {(dialog === 'video' || dialog === 'audio') && <MeetingDialog api={api} vm={vm} audio={dialog === 'audio'} onClose={() => setDialog(null)} />}
      {dialog === 'add' && <AddPeopleDialog api={api} vm={vm} onClose={() => setDialog(null)} onOpenConversation={(id) => onOpenConversation(id)} />}
      {forwardMsg && (
        <ForwardDialog api={api} message={forwardMsg} sourceTitle={isChannel ? `#${vm.title}` : vm.title} onClose={() => setForwardMsg(null)} onForwarded={(title) => setNotice(`Doorgestuurd naar ${title}.`)} />
      )}
    </MessageContext.Provider>
  );
}

// ── Vastgemaakt ──────────────────────────────────────────────────────────────

function PinnedBar({ api, message, index, total, onOpen, onNext, onUnpin }: {
  api: TeamChatApi;
  message: ChatMessage;
  index: number;
  total: number;
  onOpen: (id: string) => void;
  onNext: () => void;
  onUnpin: (m: ChatMessage) => void;
}) {
  const who = memberDisplay(api.memberById.get(message.sender_id ?? '')).name;
  const text = message.subject || message.body;
  return (
    <div className="tmc-pinned">
      <Pin size={15} className="tmc-pinned-icon" />
      <button type="button" className="tmc-pinned-main" onClick={() => onOpen(message.id)} title="Naar het bericht">
        <strong>Vastgemaakt{total > 1 ? ` · ${index + 1} van ${total}` : ''}</strong>
        <span>{who}: {text ? text.replace(/\s+/g, ' ').slice(0, 140) : 'bijlage'}</span>
      </button>
      {total > 1 && <IconButton label="Volgende vastgemaakte bericht" onClick={onNext}><ChevronDown size={16} /></IconButton>}
      {api.canWrite && <IconButton label="Losmaken" onClick={() => onUnpin(message)}><PinOff size={15} /></IconButton>}
    </div>
  );
}

// ── Scrollen: onderaan blijven, ouder laden zonder te verspringen ────────────

function useChatScroll(deps: { count: number; lastId: string | null; lastMine: boolean; loading: boolean; initialTarget: string | null }, onTop: () => Promise<boolean>) {
  const ref = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const prevLast = useRef<string | null>(null);
  const prepend = useRef<{ height: number; top: number } | null>(null);
  const didInitial = useRef(false);
  const [newBelow, setNewBelow] = useState(0);
  const loadingTop = useRef(false);

  const toBottom = useCallback((smooth = false) => {
    const el = ref.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    setNewBelow(0);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || deps.loading) return;
    if (prepend.current) {
      const { height, top } = prepend.current;
      el.scrollTop = el.scrollHeight - height + top;
      prepend.current = null;
      prevLast.current = deps.lastId;
      return;
    }
    if (!didInitial.current) {
      didInitial.current = true;
      prevLast.current = deps.lastId;
      const target = deps.initialTarget ? el.querySelector<HTMLElement>(`[id="${deps.initialTarget}"]`) : null;
      if (target) target.scrollIntoView({ block: 'center' });
      else el.scrollTop = el.scrollHeight;
      nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
      return;
    }
    if (deps.lastId && deps.lastId !== prevLast.current) {
      prevLast.current = deps.lastId;
      if (nearBottom.current || deps.lastMine) toBottom(true);
      else setNewBelow((n) => n + 1);
    }
  }, [deps.count, deps.lastId, deps.lastMine, deps.loading, deps.initialTarget, toBottom]);

  // Groeit de inhoud terwijl je onderaan stond (een afbeelding laadt, er komt
  // een reactie bij), dan blijf je onderaan — zoals in Teams.
  useEffect(() => {
    const inner = innerRef.current;
    const el = ref.current;
    if (!inner || !el || typeof ResizeObserver === 'undefined') return;
    let lastHeight = inner.offsetHeight;
    const ro = new ResizeObserver(() => {
      const h = inner.offsetHeight;
      if (h > lastHeight && nearBottom.current && !prepend.current) el.scrollTop = el.scrollHeight;
      lastHeight = h;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    if (nearBottom.current) setNewBelow(0);
    if (el.scrollTop < 90 && !loadingTop.current) {
      loadingTop.current = true;
      prepend.current = { height: el.scrollHeight, top: el.scrollTop };
      void onTop().then((loaded) => { if (!loaded) prepend.current = null; }).finally(() => { loadingTop.current = false; });
    }
  }, [onTop]);

  return { ref, innerRef, onScroll, newBelow, toBottom };
}

// ── Chat (1-op-1 en groep) ───────────────────────────────────────────────────

type ConvState = ReturnType<typeof useConversationMessages>;

function ChatList({ api, vm, conv, others, lastReadOnOpen, typingNames, typingIds }: {
  api: TeamChatApi;
  vm: ConversationVM;
  conv: ConvState;
  others: { user_id: string; last_read_at: string }[];
  lastReadOnOpen: string | null;
  typingNames: string[];
  typingIds: string[];
}) {
  const me = api.currentUserId;
  const msgs = conv.messages;
  const last = msgs[msgs.length - 1] ?? null;

  // De eerste ongelezen regel bij het openen; blijft staan zolang je kijkt.
  // Eén keer bepaald (een ref, geen state): nieuwe berichten verschuiven hem niet.
  const dividerRef = useRef<string | null | undefined>(undefined);
  if (dividerRef.current === undefined && !conv.loading) {
    const first = lastReadOnOpen
      ? msgs.find((m) => m.sender_id !== me && (m.kind ?? 'text') !== 'system' && ts(m.created_at) > ts(lastReadOnOpen))
      : undefined;
    dividerRef.current = first ? first.id : null;
  }
  const dividerId = dividerRef.current ?? null;

  const scroll = useChatScroll({
    count: msgs.length,
    lastId: last?.id ?? null,
    lastMine: last?.sender_id === me,
    loading: conv.loading,
    initialTarget: dividerId ? 'tmc-unread-divider' : null,
  }, conv.loadOlder);

  const myLastId = useMemo(() => [...msgs].reverse().find((m) => m.sender_id === me && !m.deleted_at && (m.kind ?? 'text') !== 'system')?.id ?? null, [msgs, me]);
  const nameOf = (id: string) => memberDisplay(api.memberById.get(id)).first;

  return (
    <div className="tmc-scroll-wrap">
      <div className="tmc-msgs" ref={scroll.ref} onScroll={scroll.onScroll} role="log" aria-live="polite" aria-label={`Berichten met ${vm.title}`}>
        <div className="tmc-msgs-inner" ref={scroll.innerRef}>
        {conv.loadingOlder && <div className="tmc-loading-older">Eerdere berichten laden…</div>}
        {!conv.loading && !conv.hasMore && msgs.length > 0 && <ConversationStart api={api} vm={vm} compact />}
        {conv.loading && <MessagesSkeleton />}
        {conv.error && <div className="tmc-inline-error">{conv.error}</div>}
        {!conv.loading && msgs.length === 0 && !conv.error && <ConversationStart api={api} vm={vm} />}
        {msgs.map((msg, i) => {
          const prev = msgs[i - 1];
          const showDay = !prev || dayKey(prev.created_at) !== dayKey(msg.created_at);
          const showDivider = dividerId === msg.id;
          const continued = !showDay && !showDivider && continuesGroup(prev, msg);
          return (
            <Fragment key={msg.id}>
              {showDay && <div className="tmc-day"><span>{formatDayLabel(msg.created_at)}</span></div>}
              {showDivider && <div className="tmc-unread-divider" id="tmc-unread-divider"><span>Nieuwe berichten</span></div>}
              {(msg.kind ?? 'text') === 'system'
                ? <SystemLine msg={msg} />
                : <ChatMessageRow
                    msg={msg}
                    continued={continued}
                    receipt={msg.sender_id === me ? { ...receiptFor(msg, others, nameOf), showAlways: msg.id === myLastId } : null}
                  />}
            </Fragment>
          );
        })}
        {typingNames.length > 0 && (
          <div className="tmc-typing-row">
            <Avatar userId={typingIds[0]} member={api.memberById.get(typingIds[0])} size={24} />
            <span className="tmc-typing" aria-label={`${typingNames.join(', ')} typt`}><span /><span /><span /></span>
          </div>
        )}
        </div>
      </div>
      {scroll.newBelow > 0 && (
        <button type="button" className="tmc-jump-down" onClick={() => scroll.toBottom(true)}><ArrowDown size={14} /> {scroll.newBelow === 1 ? 'Nieuw bericht' : `${scroll.newBelow} nieuwe berichten`}</button>
      )}
    </div>
  );
}

function ConversationStart({ api, vm, compact }: { api: TeamChatApi; vm: ConversationVM; compact?: boolean }) {
  if (compact) return <div className="tmc-start-mini">Begin van het gesprek</div>;
  const presence = vm.kind === 'dm' ? api.presenceOf(vm.counterpartId) : null;
  return (
    <div className="tmc-start">
      <ConversationAvatar api={api} vm={vm} size={64} />
      <strong>{vm.kind === 'channel' ? `Welkom in #${vm.title}` : vm.title}</strong>
      <span>
        {vm.kind === 'dm'
          ? `${PRESENCE_LABEL[presence ?? 'offline']} · Stuur een bericht om het gesprek te beginnen.`
          : vm.kind === 'group'
            ? 'Je groepschat begint hier. Typ @ om iemand te noemen, of start een vergadering met de knop rechtsboven.'
            : 'Start een gesprek met "Nieuw bericht". Antwoorden komen in een draadje onder de post, zodat elk onderwerp bij elkaar blijft.'}
      </span>
    </div>
  );
}

function MessagesSkeleton() {
  return (
    <div className="tmc-skeleton" aria-label="Berichten laden">
      {[0, 1, 2, 3].map((i) => <div key={i} className={`tmc-skeleton-row${i % 2 ? ' is-mine' : ''}`}><span /><span /></div>)}
    </div>
  );
}

// ── Kanaal (posts met draadjes) ──────────────────────────────────────────────

function PostList({ api, vm, conv, expandedIds, onToggleExpanded, replyOpenId, onOpenReply, renderReplyComposer, typingNames }: {
  api: TeamChatApi;
  vm: ConversationVM;
  conv: ConvState;
  expandedIds: Set<string>;
  onToggleExpanded: (id: string) => void;
  replyOpenId: string | null;
  onOpenReply: (id: string) => void;
  renderReplyComposer: (root: ChatMessage) => ReactNode;
  typingNames: string[];
}) {
  const me = api.currentUserId;
  const roots = useMemo(() => conv.messages.filter((m) => !m.parent_id), [conv.messages]);
  const repliesByRoot = useMemo(() => {
    const map = new Map<string, ChatMessage[]>();
    for (const m of conv.messages) {
      if (!m.parent_id) continue;
      const list = map.get(m.parent_id) ?? [];
      list.push(m);
      map.set(m.parent_id, list);
    }
    return map;
  }, [conv.messages]);
  const lastRoot = roots[roots.length - 1] ?? null;
  const lastAny = conv.messages[conv.messages.length - 1] ?? null;
  const scroll = useChatScroll({
    count: conv.messages.length,
    lastId: lastRoot?.id ?? null,
    lastMine: lastAny?.sender_id === me,
    loading: conv.loading,
    initialTarget: null,
  }, conv.loadOlder);

  return (
    <div className="tmc-scroll-wrap">
      <div className="tmc-msgs is-posts" ref={scroll.ref} onScroll={scroll.onScroll} role="feed" aria-label={`Berichten in #${vm.title}`}>
        <div className="tmc-msgs-inner" ref={scroll.innerRef}>
        {conv.loadingOlder && <div className="tmc-loading-older">Eerdere berichten laden…</div>}
        {conv.loading && <MessagesSkeleton />}
        {conv.error && <div className="tmc-inline-error">{conv.error}</div>}
        {!conv.loading && roots.length === 0 && !conv.error && <ConversationStart api={api} vm={vm} />}
        {!conv.loading && !conv.hasMore && roots.length > 0 && <ConversationStart api={api} vm={vm} compact />}
        {roots.map((root, i) => {
          const prev = roots[i - 1];
          const showDay = !prev || dayKey(prev.created_at) !== dayKey(root.created_at);
          return (
            <Fragment key={root.id}>
              {showDay && <div className="tmc-day"><span>{formatDayLabel(root.created_at)}</span></div>}
              <PostCard
                root={root}
                replies={repliesByRoot.get(root.id) ?? []}
                expanded={expandedIds.has(root.id)}
                onToggleExpanded={() => onToggleExpanded(root.id)}
                replyOpen={replyOpenId === root.id}
                onOpenReply={() => onOpenReply(root.id)}
                replyComposer={replyOpenId === root.id ? renderReplyComposer(root) : null}
              />
            </Fragment>
          );
        })}
        {typingNames.length > 0 && <div className="tmc-typing-line">{typingNames.join(', ')} {typingNames.length === 1 ? 'typt' : 'typen'}…</div>}
        </div>
      </div>
      {scroll.newBelow > 0 && (
        <button type="button" className="tmc-jump-down" onClick={() => scroll.toBottom(true)}><ArrowDown size={14} /> Nieuwe berichten</button>
      )}
    </div>
  );
}

// ── Deelnemers ───────────────────────────────────────────────────────────────

function MembersPanel({ api, vm, onClose, onAdd, onOpenConversation, onNotice, onLeft }: {
  api: TeamChatApi;
  vm: ConversationVM;
  onClose: () => void;
  onAdd: () => void;
  onOpenConversation: (id: string) => void;
  onNotice: (text: string) => void;
  onLeft: () => void;
}) {
  const me = api.currentUserId;
  const roles = new Map(api.participants.filter((p) => p.conversation_id === vm.id).map((p) => [p.user_id, p.role]));
  const ids = [...vm.memberIds].sort((a, b) => (a === me ? -1 : b === me ? 1 : memberDisplay(api.memberById.get(a)).name.localeCompare(memberDisplay(api.memberById.get(b)).name, 'nl')));
  const canRemove = api.canWrite && (vm.kind === 'group' || vm.myRole === 'admin');

  async function chatWith(userId: string) {
    if (!api.organizationId) return;
    try {
      const id = await startDm(api.organizationId, userId);
      await api.reloadConversations();
      onOpenConversation(id);
    } catch (e) { onNotice(e instanceof Error ? e.message : 'Chat openen mislukt'); }
  }
  async function remove(userId: string) {
    const name = memberDisplay(api.memberById.get(userId)).name;
    if (!confirm(`${name} uit ${vm.kind === 'channel' ? `#${vm.title}` : 'deze groepschat'} verwijderen?`)) return;
    try { await removeParticipant(vm.id, userId); await api.reloadConversations(); }
    catch (e) { onNotice(e instanceof Error ? e.message : 'Verwijderen mislukt'); }
  }
  async function leave() {
    if (!confirm(vm.kind === 'channel' ? `#${vm.title} verlaten?` : 'Deze groepschat verlaten?')) return;
    try { await leaveConversation(vm.id); await api.reloadConversations(); onLeft(); }
    catch (e) { onNotice(e instanceof Error ? e.message : 'Verlaten mislukt'); }
  }

  return (
    <aside className="tmc-side" aria-label="Deelnemers">
      <div className="tmc-side-head">
        <strong>Deelnemers ({vm.memberIds.length})</strong>
        <IconButton label="Sluiten" onClick={onClose}><X size={16} /></IconButton>
      </div>
      {api.canWrite && <button type="button" className="tmc-side-add" onClick={onAdd}><UserPlus size={16} /> Personen toevoegen</button>}
      <div className="tmc-side-list">
        {ids.map((id) => {
          const member = api.memberById.get(id);
          const d = memberDisplay(member);
          const presence = api.presenceOf(id);
          const status = activeStatusMessage(api.statuses.get(id));
          return (
            <div key={id} className="tmc-side-row">
              <Avatar userId={id} member={member} size={32} presence={presence} />
              <div className="tmc-side-text">
                <strong>{d.name}{id === me ? ' (jij)' : ''}{roles.get(id) === 'admin' && <span className="tmc-role">Beheerder</span>}</strong>
                <small>{status ?? PRESENCE_LABEL[presence]}</small>
              </div>
              {id !== me && (
                <div className="tmc-side-actions">
                  <IconButton label={`Chat met ${d.first}`} onClick={() => void chatWith(id)} className="is-small"><MessageSquare size={15} /></IconButton>
                  {canRemove && <IconButton label={`${d.first} verwijderen`} onClick={() => void remove(id)} className="is-small is-danger"><UserMinus size={15} /></IconButton>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <button type="button" className="tmc-side-leave" onClick={() => void leave()}><LogOut size={15} /> {vm.kind === 'channel' ? 'Kanaal verlaten' : 'Chat verlaten'}</button>
    </aside>
  );
}

// ── Gedeeld: bestanden en links in dit gesprek ───────────────────────────────

function SharedPane({ api, vm, onJump }: { api: TeamChatApi; vm: ConversationVM; onJump: (messageId: string) => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof loadConversationShared>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<'files' | 'links'>('files');
  useEffect(() => {
    if (!api.organizationId) return;
    let alive = true;
    loadConversationShared(api.organizationId, vm.id)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Laden mislukt'); });
    return () => { alive = false; };
  }, [api.organizationId, vm.id]);

  return (
    <div className="tmc-shared">
      <div className="tmc-shared-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={section === 'files'} className={section === 'files' ? 'is-active' : ''} onClick={() => setSection('files')}><FileText size={15} /> Bestanden{data ? ` (${data.files.length})` : ''}</button>
        <button type="button" role="tab" aria-selected={section === 'links'} className={section === 'links' ? 'is-active' : ''} onClick={() => setSection('links')}><Link2 size={15} /> Links{data ? ` (${data.links.length})` : ''}</button>
      </div>
      {error && <div className="tmc-inline-error">{error}</div>}
      {!data && !error && <MessagesSkeleton />}
      {data && section === 'files' && (
        data.files.length === 0
          ? <div className="tmc-empty-panel"><FileText size={32} /><strong>Nog geen bestanden</strong><span>Sleep een bestand in het gesprek of gebruik de paperclip.</span></div>
          : (
            <div className="tmc-table" role="table" aria-label="Gedeelde bestanden">
              <div className="tmc-table-head" role="row"><span role="columnheader">Naam</span><span role="columnheader">Gedeeld door</span><span role="columnheader">Datum</span><span role="columnheader" aria-label="Acties" /></div>
              {data.files.map(({ attachment, message }) => (
                <div key={attachment.id} className="tmc-table-row" role="row">
                  <span role="cell" className="tmc-table-name"><FileIcon att={attachment} size={18} /><span><strong>{attachment.name}</strong><small>{formatBytes(attachment.size_bytes)}</small></span></span>
                  <span role="cell">{memberDisplay(api.memberById.get(message.sender_id ?? '')).name}</span>
                  <span role="cell">{formatListTime(attachment.created_at)}</span>
                  <span role="cell" className="tmc-table-actions">
                    <IconButton label="Downloaden" onClick={() => void downloadAttachment(attachment)} className="is-small"><Download size={15} /></IconButton>
                    <IconButton label="Toon in het gesprek" onClick={() => onJump(message.id)} className="is-small"><MessageSquare size={15} /></IconButton>
                  </span>
                </div>
              ))}
            </div>
          )
      )}
      {data && section === 'links' && (
        data.links.length === 0
          ? <div className="tmc-empty-panel"><Link2 size={32} /><strong>Nog geen links</strong><span>Links die iemand in dit gesprek plakt, verschijnen hier.</span></div>
          : (
            <div className="tmc-links">
              {data.links.map(({ url, message }) => (
                <div key={`${message.id}-${url}`} className="tmc-link-row">
                  <Link2 size={16} />
                  <a href={url} target="_blank" rel="noopener noreferrer" title={url}>{url.replace(/^https?:\/\//, '')}</a>
                  <small>{memberDisplay(api.memberById.get(message.sender_id ?? '')).first} · {formatListTime(message.created_at)}</small>
                  <IconButton label="Toon in het gesprek" onClick={() => onJump(message.id)} className="is-small"><MessageSquare size={15} /></IconButton>
                </div>
              ))}
            </div>
          )
      )}
    </div>
  );
}
