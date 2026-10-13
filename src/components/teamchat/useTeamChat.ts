import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase, supabaseAuth } from '../../lib/supabase';
import {
  loadActivity, loadConversations, loadLastMessages, loadMemberStatuses, loadSavedMessageIds,
  loadUnreadCounts, markConversationRead, saveMessage, saveMyStatus, setConversationPrefs, unsaveMessage,
} from '../../lib/chat';
import { plainPreview } from '../../lib/chatFormat';
import type {
  ChatActivityItem, ChatAvailability, ChatConversation, ChatConversationPrefs, ChatImportance,
  ChatLastMessage, ChatMemberStatus, ChatMessage, ChatParticipant, OrganizationMember,
} from '../../types';
import {
  buildConversationVMs, memberDisplay, resolvePresence, ts, type ConversationVM, type Presence,
} from './model';

/**
 * Teamchat op App-niveau: één realtime-abonnement (postgres_changes op de
 * chattabellen) en één presence-kanaal (wie er is, en wie even weg is). Voedt de
 * sidebar-badge, de volledige pagina, het zwevende paneel en de meldingen, zodat
 * er maar één abonnement bestaat.
 */

export interface ChatRealtimeEvent {
  table: string;
  eventType: string;
  new: Record<string, unknown> | null;
  old: Record<string, unknown> | null;
}

export interface ChatToast {
  id: string;
  conversationId: string;
  messageId: string;
  senderId: string | null;
  /** Wie (bij een 1-op-1-chat) of waar (groepschat/kanaal). */
  title: string;
  /** Bij een groepschat of kanaal: van wie. */
  sender: string | null;
  snippet: string;
  importance: ChatImportance;
  mentionsMe: boolean;
}

export interface FocusRequest {
  seq: number;
  conversationId: string;
  messageId: string | null;
}

export interface TeamChatApi {
  ready: boolean;
  organizationId: string | null;
  organizationName: string;
  currentUserId: string | null;
  canWrite: boolean;
  teamMembers: OrganizationMember[];
  memberById: Map<string, OrganizationMember>;

  conversations: ChatConversation[];
  participants: ChatParticipant[];
  prefs: Map<string, ChatConversationPrefs>;
  unread: Map<string, number>;
  vms: ConversationVM[];
  /** Ongelezen over alle niet-gedempte gesprekken (de badge in de zijbalk). */
  unreadTotal: number;
  unreadChats: number;
  unreadChannels: number;

  online: Set<string>;
  idle: Set<string>;
  statuses: Map<string, ChatMemberStatus>;
  presenceOf: (userId: string | null | undefined) => Presence;
  myStatus: ChatMemberStatus | null;
  setMyAvailability: (availability: ChatAvailability) => Promise<void>;
  setMyStatusMessage: (message: string | null, expiresAt: string | null) => Promise<void>;

  savedIds: Set<string>;
  toggleSaved: (messageId: string) => Promise<void>;

  activity: ChatActivityItem[];
  activityUnseen: number;
  activitySeenAt: string;
  markActivitySeen: () => void;
  reloadActivity: () => Promise<void>;

  reloadConversations: () => Promise<void>;
  reloadUnread: () => Promise<void>;
  markRead: (conversationId: string) => Promise<void>;
  setPrefs: (conversationId: string, patch: { pinned?: boolean; muted?: boolean; hidden?: boolean; unread?: boolean }) => Promise<void>;
  onRealtime: (cb: (ev: ChatRealtimeEvent) => void) => () => void;

  focus: FocusRequest | null;
  requestFocus: (conversationId: string, messageId?: string | null) => void;
  consumeFocus: (seq: number) => void;

  getDraft: (conversationId: string) => string;
  setDraft: (conversationId: string, text: string) => void;
  draftIds: Set<string>;

  toasts: ChatToast[];
  dismissToast: (id: string) => void;
  /** Een open gespreksvenster meldt zich hier: daarvoor verschijnt dan geen melding. */
  registerView: (conversationId: string) => () => void;
}

const IDLE_AFTER_MS = 5 * 60 * 1000;

function sortConversations(list: ChatConversation[]): ChatConversation[] {
  return [...list].sort((a, b) => ts(b.last_message_at ?? b.created_at) - ts(a.last_message_at ?? a.created_at));
}

function toLast(m: ChatMessage): ChatLastMessage {
  return {
    conversation_id: m.conversation_id,
    message_id: m.id,
    sender_id: m.sender_id,
    body: m.body,
    kind: m.kind ?? 'text',
    meta: m.meta ?? {},
    attachment_count: m.attachment_count,
    deleted_at: m.deleted_at,
    created_at: m.created_at,
  };
}

const storage = {
  get(key: string): string | null { try { return window.localStorage.getItem(key); } catch { return null; } },
  set(key: string, value: string) { try { window.localStorage.setItem(key, value); } catch { /* privé-venster */ } },
};

export function useTeamChat(params: {
  organizationId: string | null;
  organizationName?: string | null;
  currentUserId: string | null;
  teamMembers: OrganizationMember[];
  canWrite?: boolean;
}): TeamChatApi {
  const { organizationId, currentUserId, teamMembers } = params;
  const organizationName = params.organizationName?.trim() || 'Organisatie';
  const canWrite = params.canWrite ?? true;

  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [participants, setParticipants] = useState<ChatParticipant[]>([]);
  const [prefs, setPrefsMap] = useState<Map<string, ChatConversationPrefs>>(new Map());
  const [previews, setPreviews] = useState<Map<string, ChatLastMessage>>(new Map());
  const [unread, setUnread] = useState<Map<string, number>>(new Map());
  const [online, setOnline] = useState<Set<string>>(new Set());
  const [idle, setIdle] = useState<Set<string>>(new Set());
  const [statuses, setStatuses] = useState<Map<string, ChatMemberStatus>>(new Map());
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [activity, setActivity] = useState<ChatActivityItem[]>([]);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const [toasts, setToasts] = useState<ChatToast[]>([]);
  const [draftIds, setDraftIds] = useState<Set<string>>(new Set());
  const [ready, setReady] = useState(false);

  const activityKey = organizationId && currentUserId ? `resofly.chat.activitySeen.${organizationId}.${currentUserId}` : null;
  const [activitySeenAt, setActivitySeenAt] = useState<string>(() => new Date(0).toISOString());
  useEffect(() => {
    setActivitySeenAt((activityKey && storage.get(activityKey)) || new Date(Date.now() - 7 * 86400000).toISOString());
  }, [activityKey]);

  const listenersRef = useRef<Set<(ev: ChatRealtimeEvent) => void>>(new Set());
  const meRef = useRef(currentUserId); meRef.current = currentUserId;
  const viewsRef = useRef<Map<string, number>>(new Map());
  const prefsRef = useRef(prefs); prefsRef.current = prefs;
  const statusesRef = useRef(statuses); statusesRef.current = statuses;
  const conversationsRef = useRef(conversations); conversationsRef.current = conversations;
  const participantsRef = useRef(participants); participantsRef.current = participants;
  const teamRef = useRef(teamMembers); teamRef.current = teamMembers;
  const presenceRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const idleSelfRef = useRef(false);
  const focusSeq = useRef(0);

  const memberById = useMemo(() => new Map(teamMembers.map((m) => [m.user_id, m])), [teamMembers]);

  // ── Laden ──────────────────────────────────────────────────────────────────

  const reloadConversations = useCallback(async () => {
    if (!organizationId) { setConversations([]); setParticipants([]); setPrefsMap(new Map()); setPreviews(new Map()); return; }
    try {
      const [res, last] = await Promise.all([loadConversations(organizationId), loadLastMessages(organizationId)]);
      setConversations(sortConversations(res.conversations));
      setParticipants(res.participants);
      setPrefsMap(new Map(res.prefs.map((p) => [p.conversation_id, p])));
      setPreviews(new Map(last.map((l) => [l.conversation_id, l])));
    } catch { /* best-effort: de volgende realtime-gebeurtenis probeert het opnieuw */ }
  }, [organizationId]);

  const reloadUnread = useCallback(async () => {
    if (!organizationId) { setUnread(new Map()); return; }
    try {
      const rows = await loadUnreadCounts();
      setUnread(new Map(rows.map((r) => [r.conversation_id, r.unread_count])));
    } catch { /* */ }
  }, [organizationId]);

  const reloadActivity = useCallback(async () => {
    if (!organizationId) { setActivity([]); return; }
    setActivity(await loadActivity(organizationId, 60));
  }, [organizationId]);

  const markRead = useCallback(async (conversationId: string) => {
    setUnread((prev) => { if (!prev.has(conversationId)) return prev; const next = new Map(prev); next.delete(conversationId); return next; });
    const nowIso = new Date().toISOString();
    setParticipants((prev) => prev.map((p) => (p.conversation_id === conversationId && p.user_id === meRef.current ? { ...p, last_read_at: nowIso } : p)));
    setPrefsMap((prev) => {
      const cur = prev.get(conversationId);
      if (!cur?.marked_unread) return prev;
      const next = new Map(prev); next.set(conversationId, { ...cur, marked_unread: false }); return next;
    });
    try { await markConversationRead(conversationId); } catch { /* */ }
  }, []);

  const setPrefs = useCallback(async (conversationId: string, patch: { pinned?: boolean; muted?: boolean; hidden?: boolean; unread?: boolean }) => {
    const me = meRef.current;
    if (!me || !organizationId) return;
    setPrefsMap((prev) => {
      const cur = prev.get(conversationId) ?? {
        conversation_id: conversationId, user_id: me, organization_id: organizationId,
        is_pinned: false, is_muted: false, hidden_at: null, marked_unread: false, updated_at: new Date().toISOString(),
      };
      const next = new Map(prev);
      next.set(conversationId, {
        ...cur,
        is_pinned: patch.pinned ?? cur.is_pinned,
        is_muted: patch.muted ?? cur.is_muted,
        hidden_at: patch.hidden === undefined ? cur.hidden_at : (patch.hidden ? new Date().toISOString() : null),
        marked_unread: patch.unread ?? cur.marked_unread,
      });
      return next;
    });
    if (patch.unread) setUnread((prev) => { const next = new Map(prev); next.set(conversationId, Math.max(1, prev.get(conversationId) ?? 0)); return next; });
    try { await setConversationPrefs(conversationId, patch); }
    catch (e) { void reloadConversations(); throw e; }
  }, [organizationId, reloadConversations]);

  const onRealtime = useCallback((cb: (ev: ChatRealtimeEvent) => void) => {
    listenersRef.current.add(cb);
    return () => { listenersRef.current.delete(cb); };
  }, []);

  // ── Meldingen in de app ────────────────────────────────────────────────────

  const dismissToast = useCallback((id: string) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);

  const registerView = useCallback((conversationId: string) => {
    const views = viewsRef.current;
    views.set(conversationId, (views.get(conversationId) ?? 0) + 1);
    setToasts((prev) => (prev.some((t) => t.conversationId === conversationId) ? prev.filter((t) => t.conversationId !== conversationId) : prev));
    return () => {
      const n = (views.get(conversationId) ?? 1) - 1;
      if (n <= 0) views.delete(conversationId); else views.set(conversationId, n);
    };
  }, []);

  // ── Concepten (per gesprek, bewaard op dit apparaat) ───────────────────────

  const draftsKey = organizationId && currentUserId ? `resofly.chat.drafts.${organizationId}.${currentUserId}` : null;
  const draftsRef = useRef<Map<string, string>>(new Map());
  const draftTimer = useRef<number | null>(null);
  useEffect(() => {
    const map = new Map<string, string>();
    if (draftsKey) {
      try {
        const raw = storage.get(draftsKey);
        if (raw) for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, string>)) if (typeof v === 'string' && v.trim()) map.set(k, v);
      } catch { /* kapotte opslag: begin leeg */ }
    }
    draftsRef.current = map;
    setDraftIds(new Set(map.keys()));
  }, [draftsKey]);

  const getDraft = useCallback((conversationId: string) => draftsRef.current.get(conversationId) ?? '', []);
  const setDraft = useCallback((conversationId: string, text: string) => {
    const map = draftsRef.current;
    const had = !!map.get(conversationId)?.trim();
    if (text.trim()) map.set(conversationId, text); else map.delete(conversationId);
    const has = !!text.trim();
    if (had !== has) setDraftIds(new Set([...map.keys()].filter((k) => map.get(k)?.trim())));
    if (!draftsKey) return;
    if (draftTimer.current) window.clearTimeout(draftTimer.current);
    draftTimer.current = window.setTimeout(() => {
      storage.set(draftsKey, JSON.stringify(Object.fromEntries(map)));
    }, 400);
  }, [draftsKey]);

  // ── Focus (melding, deeplink, "openen in volledig scherm") ─────────────────

  const requestFocus = useCallback((conversationId: string, messageId: string | null = null) => {
    focusSeq.current += 1;
    setFocus({ seq: focusSeq.current, conversationId, messageId });
  }, []);
  const consumeFocus = useCallback((seq: number) => setFocus((cur) => (cur && cur.seq === seq ? null : cur)), []);

  // ── Status ─────────────────────────────────────────────────────────────────

  const myStatus = currentUserId ? statuses.get(currentUserId) ?? null : null;

  const writeStatus = useCallback(async (patch: Partial<Pick<ChatMemberStatus, 'availability' | 'status_message' | 'message_expires_at'>>) => {
    const me = meRef.current;
    if (!me || !organizationId) return;
    const cur = statusesRef.current.get(me);
    const next = {
      availability: patch.availability ?? cur?.availability ?? 'auto',
      status_message: patch.status_message !== undefined ? patch.status_message : (cur?.status_message ?? null),
      message_expires_at: patch.message_expires_at !== undefined ? patch.message_expires_at : (cur?.message_expires_at ?? null),
    };
    setStatuses((prev) => {
      const map = new Map(prev);
      map.set(me, { organization_id: organizationId, user_id: me, updated_at: new Date().toISOString(), ...next });
      return map;
    });
    try {
      const saved = await saveMyStatus(organizationId, me, next);
      setStatuses((prev) => { const map = new Map(prev); map.set(me, saved); return map; });
    } catch (e) {
      setStatuses((prev) => { const map = new Map(prev); if (cur) map.set(me, cur); else map.delete(me); return map; });
      throw e;
    }
  }, [organizationId]);

  const setMyAvailability = useCallback((availability: ChatAvailability) => writeStatus({ availability }), [writeStatus]);
  const setMyStatusMessage = useCallback((message: string | null, expiresAt: string | null) => writeStatus({
    status_message: message?.trim() ? message.trim().slice(0, 280) : null,
    message_expires_at: message?.trim() ? expiresAt : null,
  }), [writeStatus]);

  // ── Opgeslagen ─────────────────────────────────────────────────────────────

  const savedIdsRef = useRef(savedIds); savedIdsRef.current = savedIds;
  const toggleSaved = useCallback(async (messageId: string) => {
    const wasSaved = savedIdsRef.current.has(messageId);
    setSavedIds((prev) => { const next = new Set(prev); if (wasSaved) next.delete(messageId); else next.add(messageId); return next; });
    try {
      if (wasSaved) await unsaveMessage(messageId); else await saveMessage(messageId);
    } catch (e) {
      setSavedIds((prev) => { const next = new Set(prev); if (wasSaved) next.add(messageId); else next.delete(messageId); return next; });
      throw e;
    }
  }, []);

  const markActivitySeen = useCallback(() => {
    const now = new Date().toISOString();
    setActivitySeenAt(now);
    if (activityKey) storage.set(activityKey, now);
  }, [activityKey]);

  // ── Abonnementen ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (!organizationId || !currentUserId) {
      setConversations([]); setParticipants([]); setPrefsMap(new Map()); setPreviews(new Map());
      setUnread(new Map()); setOnline(new Set()); setIdle(new Set()); setStatuses(new Map());
      setSavedIds(new Set()); setActivity([]); setToasts([]); setReady(false);
      return;
    }
    let cancelled = false;
    setReady(false);
    void reloadConversations();
    void reloadUnread();
    void reloadActivity();
    loadMemberStatuses(organizationId).then((rows) => { if (!cancelled) setStatuses(new Map(rows.map((r) => [r.user_id, r]))); });
    loadSavedMessageIds(organizationId).then((rows) => { if (!cancelled) setSavedIds(new Set(rows.map((r) => r.message_id))); });

    let presence: ReturnType<typeof supabase.channel> | null = null;
    let db: ReturnType<typeof supabase.channel> | null = null;
    let unreadTimer: number | null = null;
    let activityTimer: number | null = null;
    const scheduleUnread = () => {
      if (unreadTimer) return;
      unreadTimer = window.setTimeout(() => { unreadTimer = null; void reloadUnread(); }, 350);
    };
    const scheduleActivity = () => {
      if (activityTimer) window.clearTimeout(activityTimer);
      activityTimer = window.setTimeout(() => { activityTimer = null; void reloadActivity(); }, 900);
    };

    function maybeToast(row: ChatMessage, retried = false) {
      const me = meRef.current;
      if (!me || row.sender_id === me || (row.kind ?? 'text') === 'system' || row.deleted_at) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (viewsRef.current.has(row.conversation_id)) return;
      const conv = conversationsRef.current.find((c) => c.id === row.conversation_id);
      if (!conv) {
        // Het eerste bericht van een gloednieuwe chat: het gesprek wordt net
        // opgehaald (zie hieronder). Even later nog één keer proberen.
        if (!retried && !cancelled) window.setTimeout(() => maybeToast(row, true), 1200);
        return;
      }
      const mentionsMe = (row.mentions ?? []).includes(me);
      const urgent = row.importance === 'urgent';
      if (prefsRef.current.get(conv.id)?.is_muted && !mentionsMe && !urgent) return;
      if (statusesRef.current.get(me)?.availability === 'dnd' && !urgent) return;
      if (row.parent_id && !mentionsMe) {
        // Een antwoord in een kanaaldraadje: alleen als je zelf in dat draadje zat.
        // Zonder de berichten bij de hand weten we dat niet zeker — dan liever stil.
        return;
      }
      const sender = memberDisplay(teamRef.current.find((m) => m.user_id === row.sender_id));
      let title = sender.name;
      let from: string | null = null;
      if (conv.kind !== 'dm') {
        const others = participantsRef.current.filter((p) => p.conversation_id === conv.id && p.user_id !== me).map((p) => p.user_id);
        title = conv.title?.trim() || (conv.kind === 'group'
          ? others.map((id) => memberDisplay(teamRef.current.find((m) => m.user_id === id)).first).slice(0, 3).join(', ')
          : 'Kanaal');
        from = sender.name;
      }
      const snippet = (row.kind ?? 'text') === 'meeting'
        ? (row.meta?.audio_only ? 'is een gesprek gestart' : 'is een vergadering gestart')
        : plainPreview(row.body, 140) || (row.attachment_count > 0 ? 'stuurde een bijlage' : '');
      const toast: ChatToast = {
        id: row.id, conversationId: conv.id, messageId: row.id, senderId: row.sender_id,
        title, sender: from, snippet, importance: row.importance ?? 'normal', mentionsMe,
      };
      setToasts((prev) => [...prev.filter((t) => t.id !== toast.id), toast].slice(-3));
    }

    function handleLocal(ev: ChatRealtimeEvent) {
      const me = meRef.current;
      if (ev.table === 'chat_participants') {
        const uid = (ev.new?.user_id ?? ev.old?.user_id) as string | undefined;
        if (uid && uid === me) { void reloadConversations(); scheduleUnread(); return; }
        if (ev.eventType === 'UPDATE' && ev.new) {
          const row = ev.new as unknown as ChatParticipant;
          setParticipants((prev) => prev.map((p) => (p.conversation_id === row.conversation_id && p.user_id === row.user_id ? { ...p, ...row } : p)));
        } else if (ev.eventType === 'INSERT' && ev.new) {
          const row = ev.new as unknown as ChatParticipant;
          setParticipants((prev) => (prev.some((p) => p.conversation_id === row.conversation_id && p.user_id === row.user_id) ? prev : [...prev, row]));
        } else if (ev.eventType === 'DELETE' && ev.old) {
          const row = ev.old as unknown as Partial<ChatParticipant>;
          if (row.conversation_id && row.user_id) setParticipants((prev) => prev.filter((p) => !(p.conversation_id === row.conversation_id && p.user_id === row.user_id)));
        }
      } else if (ev.table === 'chat_conversations' && ev.new) {
        const row = ev.new as unknown as ChatConversation;
        setConversations((prev) => {
          const idx = prev.findIndex((c) => c.id === row.id);
          const next = idx >= 0 ? prev.map((c) => (c.id === row.id ? { ...c, ...row } : c)) : [row, ...prev];
          return sortConversations(next);
        });
      } else if (ev.table === 'chat_messages') {
        const row = (ev.new ?? ev.old) as unknown as ChatMessage | null;
        if (!row?.conversation_id) return;
        if (ev.eventType === 'INSERT' && ev.new) {
          const msg = ev.new as unknown as ChatMessage;
          setConversations((prev) => sortConversations(prev.map((c) => (c.id === msg.conversation_id && ts(c.last_message_at) < ts(msg.created_at) ? { ...c, last_message_at: msg.created_at } : c))));
          setPreviews((prev) => {
            const cur = prev.get(msg.conversation_id);
            if (cur && ts(cur.created_at) > ts(msg.created_at)) return prev;
            const next = new Map(prev); next.set(msg.conversation_id, toLast(msg)); return next;
          });
          if (msg.sender_id !== me && (msg.kind ?? 'text') !== 'system') { scheduleUnread(); maybeToast(msg); }
          if (msg.sender_id !== me && ((msg.mentions ?? []).includes(me ?? '') || msg.reply_to_id || msg.parent_id)) scheduleActivity();
          // Een nieuw gesprek dat we nog niet kenden (iemand begon een chat met jou).
          if (!conversationsRef.current.some((c) => c.id === msg.conversation_id)) void reloadConversations();
        } else if (ev.eventType === 'UPDATE' && ev.new) {
          const msg = ev.new as unknown as ChatMessage;
          setPreviews((prev) => {
            const cur = prev.get(msg.conversation_id);
            if (!cur || cur.message_id !== msg.id) return prev;
            const next = new Map(prev); next.set(msg.conversation_id, toLast(msg)); return next;
          });
          if (msg.deleted_at) scheduleUnread();
        }
      } else if (ev.table === 'chat_message_reactions') {
        const uid = (ev.new?.user_id ?? ev.old?.user_id) as string | undefined;
        if (uid && uid !== me) scheduleActivity();
      } else if (ev.table === 'chat_conversation_prefs') {
        const row = (ev.new ?? ev.old) as unknown as ChatConversationPrefs | null;
        if (!row?.conversation_id || row.user_id !== me) return;
        setPrefsMap((prev) => { const next = new Map(prev); if (ev.eventType === 'DELETE') next.delete(row.conversation_id); else next.set(row.conversation_id, row); return next; });
        if (ev.eventType !== 'DELETE') scheduleUnread();
      } else if (ev.table === 'chat_member_status' && ev.new) {
        const row = ev.new as unknown as ChatMemberStatus;
        setStatuses((prev) => { const next = new Map(prev); next.set(row.user_id, row); return next; });
      }
    }

    const syncPresence = () => {
      if (!presence) return;
      const state = presence.presenceState() as Record<string, { idle?: boolean }[]>;
      const on = new Set<string>();
      const away = new Set<string>();
      for (const [key, metas] of Object.entries(state)) {
        on.add(key);
        if (metas.length > 0 && metas.every((m) => m.idle)) away.add(key);
      }
      setOnline(on);
      setIdle(away);
    };

    supabaseAuth.getSession().then(({ data }) => {
      if (cancelled) return;
      const token = data.session?.access_token;
      if (token) supabase.realtime.setAuth(token);

      presence = supabase.channel(`chat:presence:${organizationId}`, { config: { presence: { key: currentUserId } } });
      presenceRef.current = presence;
      presence
        .on('presence', { event: 'sync' }, syncPresence)
        .subscribe((status) => {
          if (status === 'SUBSCRIBED' && presence) {
            void presence.track({ user_id: currentUserId, online_at: new Date().toISOString(), idle: idleSelfRef.current });
          }
        });

      db = supabase.channel(`chat:db:${organizationId}`);
      const tables = ['chat_messages', 'chat_participants', 'chat_conversations', 'chat_message_reactions', 'chat_conversation_prefs', 'chat_member_status'] as const;
      for (const table of tables) {
        db.on(
          'postgres_changes',
          { event: '*', schema: 'public', table, filter: `organization_id=eq.${organizationId}` },
          (payload) => {
            const ev: ChatRealtimeEvent = {
              table,
              eventType: payload.eventType,
              new: (payload.new && Object.keys(payload.new).length ? payload.new : null) as Record<string, unknown> | null,
              old: (payload.old && Object.keys(payload.old).length ? payload.old : null) as Record<string, unknown> | null,
            };
            listenersRef.current.forEach((cb) => { try { cb(ev); } catch { /* een luisteraar mag de rest niet breken */ } });
            handleLocal(ev);
          },
        );
      }
      db.subscribe((status) => { if (!cancelled && status === 'SUBSCRIBED') setReady(true); });
    });

    return () => {
      cancelled = true;
      if (unreadTimer) window.clearTimeout(unreadTimer);
      if (activityTimer) window.clearTimeout(activityTimer);
      presenceRef.current = null;
      if (presence) supabase.removeChannel(presence);
      if (db) supabase.removeChannel(db);
    };
  }, [organizationId, currentUserId, reloadConversations, reloadUnread, reloadActivity]);

  // Even weg: na vijf minuten zonder muis of toetsenbord sta je op Afwezig, net
  // als in Teams. Dat gaat mee in de presence; de rest van het team ziet het.
  useEffect(() => {
    if (!organizationId || !currentUserId) return;
    let lastActive = Date.now();
    let lastMove = 0;
    const setSelfIdle = (value: boolean) => {
      if (idleSelfRef.current === value) return;
      idleSelfRef.current = value;
      void presenceRef.current?.track({ user_id: currentUserId, online_at: new Date().toISOString(), idle: value });
    };
    const active = () => { lastActive = Date.now(); setSelfIdle(false); };
    const move = () => { const now = Date.now(); if (now - lastMove > 15000) { lastMove = now; active(); } };
    const events: (keyof WindowEventMap)[] = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'focus'];
    events.forEach((e) => window.addEventListener(e, active, { passive: true }));
    window.addEventListener('mousemove', move, { passive: true });
    const timer = window.setInterval(() => setSelfIdle(Date.now() - lastActive > IDLE_AFTER_MS), 30000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, active));
      window.removeEventListener('mousemove', move);
      window.clearInterval(timer);
    };
  }, [organizationId, currentUserId]);

  // ── Afgeleid ───────────────────────────────────────────────────────────────

  const vms = useMemo(() => buildConversationVMs({
    conversations, participants, prefs, unread, previews, teamMembers, me: currentUserId,
  }), [conversations, participants, prefs, unread, previews, teamMembers, currentUserId]);

  const { unreadTotal, unreadChats, unreadChannels } = useMemo(() => {
    let total = 0; let chats = 0; let channels = 0;
    for (const vm of vms) {
      if (vm.muted || vm.unread <= 0) continue;
      total += vm.unread;
      if (vm.kind === 'channel') channels += 1; else chats += 1;
    }
    return { unreadTotal: total, unreadChats: chats, unreadChannels: channels };
  }, [vms]);

  const presenceOf = useCallback((userId: string | null | undefined) => {
    const on = userId && userId === currentUserId && !online.has(userId) ? new Set([...online, userId]) : online;
    return resolvePresence(userId, { online: on, idle, statuses });
  }, [online, idle, statuses, currentUserId]);

  const activityUnseen = useMemo(() => activity.filter((a) => ts(a.created_at) > ts(activitySeenAt)).length, [activity, activitySeenAt]);

  return useMemo<TeamChatApi>(() => ({
    ready, organizationId, organizationName, currentUserId, canWrite, teamMembers, memberById,
    conversations, participants, prefs, unread, vms, unreadTotal, unreadChats, unreadChannels,
    online, idle, statuses, presenceOf, myStatus, setMyAvailability, setMyStatusMessage,
    savedIds, toggleSaved,
    activity, activityUnseen, activitySeenAt, markActivitySeen, reloadActivity,
    reloadConversations, reloadUnread, markRead, setPrefs, onRealtime,
    focus, requestFocus, consumeFocus,
    getDraft, setDraft, draftIds,
    toasts, dismissToast, registerView,
  }), [
    ready, organizationId, organizationName, currentUserId, canWrite, teamMembers, memberById,
    conversations, participants, prefs, unread, vms, unreadTotal, unreadChats, unreadChannels,
    online, idle, statuses, presenceOf, myStatus, setMyAvailability, setMyStatusMessage,
    savedIds, toggleSaved,
    activity, activityUnseen, activitySeenAt, markActivitySeen, reloadActivity,
    reloadConversations, reloadUnread, markRead, setPrefs, onRealtime,
    focus, requestFocus, consumeFocus,
    getDraft, setDraft, draftIds,
    toasts, dismissToast, registerView,
  ]);
}
