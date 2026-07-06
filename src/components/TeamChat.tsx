import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  ArrowLeft, Check, CheckCheck, Hash, LogOut, MessageSquare, Paperclip, Pencil, Plus,
  Search, Send, Smile, Trash2, Users, X,
} from 'lucide-react';
import { supabase, supabaseAuth } from '../lib/supabase';
import {
  addParticipants, addReaction, createChannel, deleteMessage, editMessage, leaveConversation,
  loadConversations, loadMessageAttachments, loadMessages, loadUnreadCounts, markConversationRead,
  removeReaction, renameChannel, sendMessage, startDm,
} from '../lib/chat';
import type {
  Attachment, ChatConversation, ChatMessage, ChatMessageReaction, ChatParticipant,
  OrganizationMember, UUID,
} from '../types';
import { AttachmentList } from './AttachmentList';

/**
 * Teamchat — interne chat tussen de leden van één organisatie.
 *
 * - `useTeamChat` draait op App-niveau: één realtime-abonnement (postgres_changes
 *   op de chattabellen) + één presence-kanaal (online-status). Voedt zowel de
 *   sidebar-badge als de volledige pagina én het zwevende paneel.
 * - `TeamChatPage` = volwaardige pagina (twee kolommen).
 * - `TeamChatDock`  = zwevend paneel rechtsonder (één kolom, terugknop).
 * Beide delen dezelfde `TeamChatApi` zodat er maar één abonnement bestaat.
 */

const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '✅', '👀'];

export interface ChatRealtimeEvent {
  table: string;
  eventType: string;
  new: Record<string, unknown> | null;
  old: Record<string, unknown> | null;
}

export interface TeamChatApi {
  ready: boolean;
  conversations: ChatConversation[];
  participants: ChatParticipant[];
  unread: Map<string, number>;
  unreadTotal: number;
  online: Set<string>;
  organizationId: string | null;
  currentUserId: string | null;
  teamMembers: OrganizationMember[];
  reloadConversations: () => Promise<void>;
  reloadUnread: () => Promise<void>;
  markRead: (conversationId: string) => Promise<void>;
  onRealtime: (cb: (ev: ChatRealtimeEvent) => void) => () => void;
  setActiveConversation: (id: string | null) => void;
}

// ── Naam- en avatar-helpers (geen profielen in de DB → afgeleid uit e-mail) ──

export function memberDisplay(member: OrganizationMember | undefined, fallback = 'Teamlid'): { name: string; initials: string } {
  const email = member?.email ?? '';
  const local = email.split('@')[0] ?? '';
  const name = local
    ? local.replace(/[._\-+]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    : (email || fallback);
  const parts = local.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const initials = (parts.length >= 2 ? `${parts[0][0]}${parts[1][0]}` : local.slice(0, 2) || '?').toUpperCase();
  return { name, initials };
}

const AVATAR_COLORS = ['#FFD966', '#34d399', '#FF9F43', '#f06b6b', '#a78bfa', '#38bdf8', '#f472b6'];
function avatarColor(id: string | null | undefined): string {
  if (!id) return AVATAR_COLORS[0];
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function Avatar({ id, initials, online, size = 34 }: { id: string | null; initials: string; online?: boolean; size?: number }) {
  return (
    <span className="chat-avatar" style={{ width: size, height: size, background: avatarColor(id) }} aria-hidden="true">
      {initials}
      {online !== undefined && <span className={`chat-avatar-dot${online ? ' is-online' : ''}`} />}
    </span>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
}

function formatDayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const ystd = new Date(); ystd.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return 'Vandaag';
  if (sameDay(d, ystd)) return 'Gisteren';
  return d.toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' });
}

function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'nu';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}u`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
}

// ── App-niveau hook: realtime + presence + ongelezen ─────────────────────────

export function useTeamChat(params: { organizationId: string | null; currentUserId: string | null; teamMembers: OrganizationMember[] }): TeamChatApi {
  const { organizationId, currentUserId, teamMembers } = params;
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [participants, setParticipants] = useState<ChatParticipant[]>([]);
  const [unread, setUnread] = useState<Map<string, number>>(new Map());
  const [online, setOnline] = useState<Set<string>>(new Set());
  const [ready, setReady] = useState(false);

  const listenersRef = useRef<Set<(ev: ChatRealtimeEvent) => void>>(new Set());
  const meRef = useRef(currentUserId); meRef.current = currentUserId;

  const reloadConversations = useCallback(async () => {
    if (!organizationId) { setConversations([]); setParticipants([]); return; }
    try {
      const res = await loadConversations(organizationId);
      setConversations(res.conversations);
      setParticipants(res.participants);
    } catch { /* best-effort */ }
  }, [organizationId]);

  const reloadUnread = useCallback(async () => {
    if (!organizationId) { setUnread(new Map()); return; }
    try {
      const rows = await loadUnreadCounts();
      setUnread(new Map(rows.map((r) => [r.conversation_id, r.unread_count])));
    } catch { /* */ }
  }, [organizationId]);

  const markRead = useCallback(async (conversationId: string) => {
    setUnread((prev) => { const next = new Map(prev); next.delete(conversationId); return next; });
    const nowIso = new Date().toISOString();
    setParticipants((prev) => prev.map((p) => (p.conversation_id === conversationId && p.user_id === meRef.current ? { ...p, last_read_at: nowIso } : p)));
    try { await markConversationRead(conversationId); } catch { /* */ }
  }, []);

  const onRealtime = useCallback((cb: (ev: ChatRealtimeEvent) => void) => {
    listenersRef.current.add(cb);
    return () => { listenersRef.current.delete(cb); };
  }, []);

  const setActiveConversation = useCallback((_id: string | null) => { /* placeholder for future toast suppression */ }, []);

  useEffect(() => {
    if (!organizationId || !currentUserId) {
      setConversations([]); setParticipants([]); setUnread(new Map()); setOnline(new Set()); setReady(false);
      return;
    }
    let cancelled = false;
    void reloadConversations();
    void reloadUnread();
    setReady(false);

    let presence: ReturnType<typeof supabase.channel> | null = null;
    let db: ReturnType<typeof supabase.channel> | null = null;
    let unreadTimer: number | null = null;
    const scheduleUnread = () => {
      if (unreadTimer) return;
      unreadTimer = window.setTimeout(() => { unreadTimer = null; void reloadUnread(); }, 350);
    };

    function handleLocal(ev: ChatRealtimeEvent) {
      const me = meRef.current;
      if (ev.table === 'chat_participants') {
        const uid = (ev.new?.user_id ?? ev.old?.user_id) as string | undefined;
        if (uid && uid === me) { void reloadConversations(); scheduleUnread(); return; }
        if (ev.eventType === 'UPDATE' && ev.new) {
          const row = ev.new as unknown as ChatParticipant;
          setParticipants((prev) => prev.map((p) => (p.conversation_id === row.conversation_id && p.user_id === row.user_id ? { ...p, last_read_at: row.last_read_at } : p)));
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
      } else if (ev.table === 'chat_messages' && ev.eventType === 'INSERT' && ev.new) {
        const row = ev.new as unknown as ChatMessage;
        setConversations((prev) => sortConversations(prev.map((c) => (c.id === row.conversation_id ? { ...c, last_message_at: row.created_at } : c))));
        if (row.sender_id !== me) scheduleUnread();
      }
    }

    supabaseAuth.getSession().then(({ data }) => {
      if (cancelled) return;
      const token = data.session?.access_token;
      if (token) supabase.realtime.setAuth(token);

      presence = supabase.channel(`chat:presence:${organizationId}`, { config: { presence: { key: currentUserId } } });
      presence
        .on('presence', { event: 'sync' }, () => {
          if (!presence) return;
          setOnline(new Set(Object.keys(presence.presenceState())));
        })
        .subscribe((status) => {
          if (status === 'SUBSCRIBED' && presence) void presence.track({ user_id: currentUserId, online_at: new Date().toISOString() });
        });

      db = supabase.channel(`chat:db:${organizationId}`);
      const tables = ['chat_messages', 'chat_participants', 'chat_conversations', 'chat_message_reactions'] as const;
      for (const table of tables) {
        db.on(
          'postgres_changes',
          { event: '*', schema: 'public', table, filter: `organization_id=eq.${organizationId}` },
          (payload) => {
            const ev: ChatRealtimeEvent = {
              table,
              eventType: payload.eventType,
              new: (payload.new ?? null) as Record<string, unknown> | null,
              old: (payload.old ?? null) as Record<string, unknown> | null,
            };
            listenersRef.current.forEach((cb) => { try { cb(ev); } catch { /* */ } });
            handleLocal(ev);
          },
        );
      }
      db.subscribe((status) => { if (!cancelled && status === 'SUBSCRIBED') setReady(true); });
    });

    return () => {
      cancelled = true;
      if (unreadTimer) window.clearTimeout(unreadTimer);
      if (presence) supabase.removeChannel(presence);
      if (db) supabase.removeChannel(db);
    };
  }, [organizationId, currentUserId, reloadConversations, reloadUnread]);

  const unreadTotal = useMemo(() => { let t = 0; unread.forEach((v) => { t += v; }); return t; }, [unread]);

  return {
    ready, conversations, participants, unread, unreadTotal, online,
    organizationId, currentUserId, teamMembers,
    reloadConversations, reloadUnread, markRead, onRealtime, setActiveConversation,
  };
}

function sortConversations(list: ChatConversation[]): ChatConversation[] {
  return [...list].sort((a, b) => {
    const ta = a.last_message_at ?? a.created_at;
    const tb = b.last_message_at ?? b.created_at;
    return tb.localeCompare(ta);
  });
}

// ── Afgeleide gespreks-viewmodels ────────────────────────────────────────────

interface ConversationVM {
  conversation: ChatConversation;
  title: string;
  memberIds: string[];
  counterpartId: string | null;
  unread: number;
  online: boolean;
}

function buildConversationVMs(api: TeamChatApi): ConversationVM[] {
  const me = api.currentUserId;
  const memberById = new Map(api.teamMembers.map((m) => [m.user_id, m]));
  const partByConv = new Map<string, ChatParticipant[]>();
  for (const p of api.participants) {
    const arr = partByConv.get(p.conversation_id) ?? [];
    arr.push(p);
    partByConv.set(p.conversation_id, arr);
  }
  return api.conversations.map((conversation) => {
    const parts = partByConv.get(conversation.id) ?? [];
    const memberIds = parts.map((p) => p.user_id);
    let title = conversation.title ?? 'Gesprek';
    let counterpartId: string | null = null;
    let online = false;
    if (conversation.kind === 'dm') {
      counterpartId = memberIds.find((id) => id !== me) ?? null;
      title = memberDisplay(memberById.get(counterpartId ?? '')).name;
      online = counterpartId ? api.online.has(counterpartId) : false;
    }
    return { conversation, title, memberIds, counterpartId, unread: api.unread.get(conversation.id) ?? 0, online };
  });
}

// ── Gedeelde shell ───────────────────────────────────────────────────────────

function ChatShell({ api, variant, onClose }: { api: TeamChatApi; variant: 'page' | 'dock'; onClose?: () => void }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [composeOpen, setComposeOpen] = useState<null | 'dm' | 'channel'>(null);

  const vms = useMemo(() => buildConversationVMs(api), [api]);
  const activeVm = vms.find((v) => v.conversation.id === activeId) ?? null;

  // Op de pagina: kies automatisch het eerste gesprek als er nog niets openstaat.
  useEffect(() => {
    if (variant === 'page' && !activeId && vms.length > 0) setActiveId(vms[0].conversation.id);
  }, [variant, activeId, vms]);

  const openConversation = useCallback((id: string) => {
    setActiveId(id);
    void api.markRead(id);
  }, [api]);

  const filtered = query.trim()
    ? vms.filter((v) => v.title.toLowerCase().includes(query.trim().toLowerCase()))
    : vms;

  const showList = variant === 'page' || !activeId;
  const showThread = variant === 'page' || !!activeId;

  return (
    <div className={`chat-shell chat-${variant}`}>
      {showList && (
        <ConversationList
          api={api}
          vms={filtered}
          activeId={activeId}
          query={query}
          onQuery={setQuery}
          onOpen={openConversation}
          onNew={setComposeOpen}
          onClose={onClose}
          variant={variant}
        />
      )}
      {showThread && (
        activeVm
          ? <ConversationThread
              key={activeVm.conversation.id}
              api={api}
              vm={activeVm}
              variant={variant}
              onBack={() => setActiveId(null)}
              onLeft={() => { setActiveId(null); void api.reloadConversations(); }}
            />
          : variant === 'page'
            ? <div className="chat-empty"><MessageSquare size={40} /><p>Kies een gesprek of start iets nieuws.</p></div>
            : null
      )}
      {composeOpen && (
        <NewConversationModal
          api={api}
          mode={composeOpen}
          onClose={() => setComposeOpen(null)}
          onCreated={(id) => { setComposeOpen(null); openConversation(id); }}
        />
      )}
    </div>
  );
}

// ── Gesprekslijst ────────────────────────────────────────────────────────────

function ConversationList({ api, vms, activeId, query, onQuery, onOpen, onNew, onClose, variant }: {
  api: TeamChatApi;
  vms: ConversationVM[];
  activeId: string | null;
  query: string;
  onQuery: (q: string) => void;
  onOpen: (id: string) => void;
  onNew: (mode: 'dm' | 'channel') => void;
  onClose?: () => void;
  variant: 'page' | 'dock';
}) {
  const dms = vms.filter((v) => v.conversation.kind === 'dm');
  const channels = vms.filter((v) => v.conversation.kind === 'channel');
  const memberById = new Map(api.teamMembers.map((m) => [m.user_id, m]));

  return (
    <div className="chat-list">
      <div className="chat-list-head">
        <div className="chat-list-title"><MessageSquare size={17} /><span>Teamchat</span></div>
        <div className="chat-list-head-actions">
          <button type="button" className="chat-icon-btn" title="Nieuw kanaal" onClick={() => onNew('channel')}><Hash size={16} /></button>
          <button type="button" className="chat-icon-btn" title="Nieuw gesprek" onClick={() => onNew('dm')}><Plus size={17} /></button>
          {variant === 'dock' && onClose && <button type="button" className="chat-icon-btn" title="Sluiten" onClick={onClose}><X size={17} /></button>}
        </div>
      </div>
      <div className="chat-search">
        <Search size={14} />
        <input value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Zoek gesprek of teamlid…" />
      </div>
      <div className="chat-list-scroll">
        {channels.length > 0 && <div className="chat-list-section">Kanalen</div>}
        {channels.map((vm) => (
          <ConversationRow key={vm.conversation.id} vm={vm} active={vm.conversation.id === activeId} onOpen={onOpen} memberById={memberById} api={api} />
        ))}
        <div className="chat-list-section">Directe berichten</div>
        {dms.length === 0 && <div className="chat-list-hint">Nog geen 1-op-1 gesprekken. Klik op <Plus size={12} /> om er een te starten.</div>}
        {dms.map((vm) => (
          <ConversationRow key={vm.conversation.id} vm={vm} active={vm.conversation.id === activeId} onOpen={onOpen} memberById={memberById} api={api} />
        ))}
      </div>
    </div>
  );
}

function ConversationRow({ vm, active, onOpen, memberById, api }: {
  vm: ConversationVM;
  active: boolean;
  onOpen: (id: string) => void;
  memberById: Map<string, OrganizationMember>;
  api: TeamChatApi;
}) {
  const isChannel = vm.conversation.kind === 'channel';
  const display = isChannel
    ? { name: vm.title, initials: (vm.title[0] ?? '#').toUpperCase() }
    : memberDisplay(memberById.get(vm.counterpartId ?? ''));
  return (
    <button type="button" className={`chat-conv${active ? ' active' : ''}`} onClick={() => onOpen(vm.conversation.id)}>
      {isChannel
        ? <span className="chat-avatar chat-avatar-channel" aria-hidden="true"><Hash size={16} /></span>
        : <Avatar id={vm.counterpartId} initials={display.initials} online={vm.online} size={38} />}
      <span className="chat-conv-body">
        <span className="chat-conv-top">
          <span className="chat-conv-name">{display.name}</span>
          <span className="chat-conv-time">{relativeTime(vm.conversation.last_message_at)}</span>
        </span>
        <span className="chat-conv-sub">
          {isChannel ? `${vm.memberIds.length} lid${vm.memberIds.length === 1 ? '' : 'eren'}` : (vm.online ? 'Online' : 'Offline')}
        </span>
      </span>
      {vm.unread > 0 && <span className="chat-conv-badge">{vm.unread > 99 ? '99+' : vm.unread}</span>}
    </button>
  );
}

// ── Gespreksvenster (berichten + composer) ───────────────────────────────────

function ConversationThread({ api, vm, variant, onBack, onLeft }: {
  api: TeamChatApi;
  vm: ConversationVM;
  variant: 'page' | 'dock';
  onBack: () => void;
  onLeft: () => void;
}) {
  const conversationId = vm.conversation.id;
  const me = api.currentUserId;
  const memberById = useMemo(() => new Map(api.teamMembers.map((m) => [m.user_id, m])), [api.teamMembers]);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [reactions, setReactions] = useState<ChatMessageReaction[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [typing, setTyping] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [showMembers, setShowMembers] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const typingChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const typingTimers = useRef<Map<string, number>>(new Map());
  const lastTypingSent = useRef(0);
  // Voorkomt state-updates na unmount (o.a. de vertraagde bijlagen-retry).
  const aliveRef = useRef(true);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);

  const convParticipants = api.participants.filter((p) => p.conversation_id === conversationId);

  // Bijlagen ophalen voor berichten die er (volgens attachment_count) hebben.
  const fetchAttachmentsFor = useCallback(async (msgs: ChatMessage[]) => {
    const need = msgs.filter((m) => m.attachment_count > 0).map((m) => m.id);
    if (need.length === 0 || !api.organizationId) return;
    try {
      const rows = await loadMessageAttachments(api.organizationId, need);
      if (!aliveRef.current) return;
      setAttachments((prev) => {
        const byId = new Map(prev.map((a) => [a.id, a]));
        rows.forEach((a) => byId.set(a.id, a));
        return Array.from(byId.values());
      });
    } catch { /* */ }
  }, [api.organizationId]);

  // Initieel laden bij gespreks-wissel.
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setMessages([]); setReactions([]); setAttachments([]); setTyping(new Set());
    loadMessages(conversationId)
      .then(({ messages, reactions }) => {
        if (cancelled) return;
        setMessages(messages);
        setReactions(reactions);
        setLoading(false);
        void fetchAttachmentsFor(messages);
      })
      .catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : 'Laden mislukt'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [conversationId, fetchAttachmentsFor]);

  // Realtime: luister mee op het app-brede abonnement, gefilterd op dit gesprek.
  useEffect(() => {
    const off = api.onRealtime((ev) => {
      if (ev.table === 'chat_messages') {
        const row = (ev.new ?? ev.old) as unknown as ChatMessage | null;
        if (!row || row.conversation_id !== conversationId) return;
        if (ev.eventType === 'INSERT' && ev.new) {
          const msg = ev.new as unknown as ChatMessage;
          setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev.map((m) => (m.id === msg.id ? msg : m)) : [...prev, msg]));
          if (msg.sender_id !== me) void api.markRead(conversationId);
          if (msg.attachment_count > 0) { void fetchAttachmentsFor([msg]); window.setTimeout(() => { if (aliveRef.current) void fetchAttachmentsFor([msg]); }, 1800); }
          // stop de typ-indicator van de afzender
          if (msg.sender_id) removeTyping(msg.sender_id);
        } else if (ev.eventType === 'UPDATE' && ev.new) {
          const msg = ev.new as unknown as ChatMessage;
          setMessages((prev) => prev.map((m) => (m.id === msg.id ? msg : m)));
          if (msg.attachment_count > 0) void fetchAttachmentsFor([msg]);
        }
      } else if (ev.table === 'chat_message_reactions') {
        const row = (ev.new ?? ev.old) as unknown as ChatMessageReaction | null;
        if (!row || row.conversation_id !== conversationId) return;
        if (ev.eventType === 'INSERT' && ev.new) {
          const r = ev.new as unknown as ChatMessageReaction;
          setReactions((prev) => (prev.some((x) => x.message_id === r.message_id && x.user_id === r.user_id && x.emoji === r.emoji) ? prev : [...prev, r]));
        } else if (ev.eventType === 'DELETE' && ev.old) {
          const r = ev.old as unknown as Partial<ChatMessageReaction>;
          setReactions((prev) => prev.filter((x) => !(x.message_id === r.message_id && x.user_id === r.user_id && x.emoji === r.emoji)));
        }
      }
    });
    return off;
    // api.onRealtime/api.markRead zijn stabiele useCallbacks → geen her-abonnement per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, me, api.onRealtime, api.markRead, fetchAttachmentsFor]);

  // Typ-indicator: eigen kanaal per gesprek (broadcast, niet persistent).
  useEffect(() => {
    api.setActiveConversation(conversationId);
    let channel: ReturnType<typeof supabase.channel> | null = null;
    supabaseAuth.getSession().then(({ data }) => {
      const token = data.session?.access_token;
      if (token) supabase.realtime.setAuth(token);
      channel = supabase.channel(`chat:typing:${conversationId}`, { config: { broadcast: { self: false } } });
      channel.on('broadcast', { event: 'typing' }, (msg) => {
        const uid = (msg.payload as { user_id?: string })?.user_id;
        if (uid && uid !== me) addTyping(uid);
      }).subscribe();
      typingChannelRef.current = channel;
    });
    return () => {
      api.setActiveConversation(null);
      typingChannelRef.current = null;
      typingTimers.current.forEach((t) => window.clearTimeout(t));
      typingTimers.current.clear();
      if (channel) supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, me]);

  function addTyping(uid: string) {
    setTyping((prev) => { const next = new Set(prev); next.add(uid); return next; });
    const existing = typingTimers.current.get(uid);
    if (existing) window.clearTimeout(existing);
    typingTimers.current.set(uid, window.setTimeout(() => removeTyping(uid), 3500));
  }
  function removeTyping(uid: string) {
    setTyping((prev) => { if (!prev.has(uid)) return prev; const next = new Set(prev); next.delete(uid); return next; });
    const t = typingTimers.current.get(uid);
    if (t) { window.clearTimeout(t); typingTimers.current.delete(uid); }
  }
  function broadcastTyping() {
    const now = Date.now();
    if (now - lastTypingSent.current < 1800) return;
    lastTypingSent.current = now;
    typingChannelRef.current?.send({ type: 'broadcast', event: 'typing', payload: { user_id: me } });
  }

  // Scroll naar beneden bij nieuwe berichten / typen.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, typing, loading]);

  const reactionsByMessage = useMemo(() => {
    const map = new Map<string, ChatMessageReaction[]>();
    for (const r of reactions) {
      const arr = map.get(r.message_id) ?? [];
      arr.push(r);
      map.set(r.message_id, arr);
    }
    return map;
  }, [reactions]);

  const isChannel = vm.conversation.kind === 'channel';
  const header = isChannel
    ? { name: vm.conversation.title ?? 'Kanaal', sub: `${vm.memberIds.length} leden` }
    : { name: vm.title, sub: vm.online ? 'Online' : 'Offline' };

  // Read receipt op mijn laatste bericht: wie heeft na dat bericht gelezen?
  const myLastMessage = [...messages].reverse().find((m) => m.sender_id === me && !m.deleted_at);
  const readByOthers = myLastMessage
    ? convParticipants.filter((p) => p.user_id !== me && Date.parse(p.last_read_at) >= Date.parse(myLastMessage.created_at))
    : [];
  const otherCount = convParticipants.filter((p) => p.user_id !== me).length;

  const typingNames = Array.from(typing)
    .filter((id) => vm.memberIds.includes(id))
    .map((id) => memberDisplay(memberById.get(id)).name);

  return (
    <div className="chat-thread">
      <header className="chat-thread-head">
        {variant === 'dock' && <button type="button" className="chat-icon-btn" onClick={onBack} title="Terug"><ArrowLeft size={18} /></button>}
        {isChannel
          ? <span className="chat-avatar chat-avatar-channel" aria-hidden="true"><Hash size={16} /></span>
          : <Avatar id={vm.counterpartId} initials={memberDisplay(memberById.get(vm.counterpartId ?? '')).initials} online={vm.online} size={34} />}
        <div className="chat-thread-id">
          <div className="chat-thread-name">{header.name}</div>
          <div className="chat-thread-sub">{typingNames.length > 0 ? `${typingNames.join(', ')} typt…` : header.sub}</div>
        </div>
        {isChannel && (
          <button type="button" className="chat-icon-btn" title="Leden" onClick={() => setShowMembers((v) => !v)}><Users size={17} /></button>
        )}
      </header>

      {showMembers && isChannel && (
        <ChannelMembers api={api} vm={vm} memberById={memberById} onLeft={onLeft} onClose={() => setShowMembers(false)} />
      )}

      <div className="chat-msgs" ref={scrollRef}>
        {loading && <div className="chat-loading">Laden…</div>}
        {error && <div className="chat-error">{error}</div>}
        {!loading && messages.length === 0 && !error && (
          <div className="chat-thread-empty">Nog geen berichten. Zeg hallo 👋</div>
        )}
        {messages.map((msg, i) => {
          const prev = messages[i - 1];
          const showDay = !prev || formatDayLabel(prev.created_at) !== formatDayLabel(msg.created_at);
          return (
            <div key={msg.id}>
              {showDay && <div className="chat-day-sep"><span>{formatDayLabel(msg.created_at)}</span></div>}
              <MessageRow
                api={api}
                msg={msg}
                mine={msg.sender_id === me}
                sender={memberById.get(msg.sender_id ?? '')}
                showAvatar={isChannel && msg.sender_id !== me && (!prev || prev.sender_id !== msg.sender_id || showDay)}
                isChannel={isChannel}
                reactions={reactionsByMessage.get(msg.id) ?? []}
                attachments={attachments}
                onAttachmentsChanged={() => void fetchAttachmentsFor([msg])}
              />
            </div>
          );
        })}
        {typingNames.length > 0 && (
          <div className="chat-typing-row"><span className="chat-typing"><span /><span /><span /></span></div>
        )}
      </div>

      {myLastMessage && !isChannel && (
        <div className="chat-receipt">{readByOthers.length > 0 ? <><CheckCheck size={13} /> Gelezen</> : <><Check size={13} /> Verzonden</>}</div>
      )}
      {myLastMessage && isChannel && otherCount > 0 && (
        <div className="chat-receipt"><CheckCheck size={13} /> Gelezen door {readByOthers.length}/{otherCount}</div>
      )}

      <Composer
        api={api}
        conversationId={conversationId}
        memberIds={vm.memberIds}
        onTyping={broadcastTyping}
        onSent={(msg, atts) => {
          setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
          if (atts.length) setAttachments((prev) => [...prev, ...atts]);
        }}
        onError={setError}
      />
    </div>
  );
}

// ── Eén bericht ──────────────────────────────────────────────────────────────

function MessageRow({ api, msg, mine, sender, showAvatar, isChannel, reactions, attachments, onAttachmentsChanged }: {
  api: TeamChatApi;
  msg: ChatMessage;
  mine: boolean;
  sender: OrganizationMember | undefined;
  showAvatar: boolean;
  isChannel: boolean;
  reactions: ChatMessageReaction[];
  attachments: Attachment[];
  onAttachmentsChanged: () => void;
}) {
  const me = api.currentUserId;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(msg.body);
  const [showReactPicker, setShowReactPicker] = useState(false);
  const display = memberDisplay(sender);

  const grouped = useMemo(() => {
    const map = new Map<string, { count: number; mine: boolean }>();
    for (const r of reactions) {
      const cur = map.get(r.emoji) ?? { count: 0, mine: false };
      cur.count += 1;
      if (r.user_id === me) cur.mine = true;
      map.set(r.emoji, cur);
    }
    return Array.from(map.entries());
  }, [reactions, me]);

  async function toggleReaction(emoji: string) {
    setShowReactPicker(false);
    const mineReacted = reactions.some((r) => r.emoji === emoji && r.user_id === me);
    try {
      if (mineReacted) await removeReaction(msg.id, emoji);
      else await addReaction(msg.id, emoji);
    } catch { /* realtime corrigeert */ }
  }

  async function saveEdit() {
    const body = draft.trim();
    setEditing(false);
    if (!body || body === msg.body) return;
    try { await editMessage(msg.id, body); } catch { /* */ }
  }

  async function remove() {
    if (!confirm('Dit bericht intrekken?')) return;
    try { await deleteMessage(msg.id); } catch { /* */ }
  }

  if (msg.deleted_at) {
    return (
      <div className={`chat-msg${mine ? ' mine' : ''}`}>
        {showAvatar && <Avatar id={msg.sender_id} initials={display.initials} size={28} />}
        <div className="chat-bubble chat-bubble-deleted">Bericht ingetrokken</div>
      </div>
    );
  }

  return (
    <div className={`chat-msg${mine ? ' mine' : ''}`}>
      {!mine && (showAvatar ? <Avatar id={msg.sender_id} initials={display.initials} size={28} /> : <span className="chat-avatar-spacer" />)}
      <div className="chat-msg-main">
        {showAvatar && !mine && isChannel && <div className="chat-msg-sender">{display.name}</div>}
        <div className="chat-bubble-wrap">
          <div className="chat-bubble">
            {editing ? (
              <div className="chat-edit">
                <textarea value={draft} autoFocus onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void saveEdit(); } if (e.key === 'Escape') setEditing(false); }} />
                <div className="chat-edit-actions">
                  <button type="button" onClick={() => setEditing(false)}>Annuleren</button>
                  <button type="button" className="primary" onClick={() => void saveEdit()}>Opslaan</button>
                </div>
              </div>
            ) : (
              <>
                {msg.body && <div className="chat-bubble-text"><MessageBody body={msg.body} teamMembers={api.teamMembers} /></div>}
                {msg.attachment_count > 0 && (
                  <div className="chat-bubble-atts">
                    <AttachmentList attachments={attachments} entityType="chat_message" entityId={msg.id} onChanged={onAttachmentsChanged} canDelete={mine} />
                  </div>
                )}
                <span className="chat-bubble-meta">{formatTime(msg.created_at)}{msg.edited_at ? ' · bewerkt' : ''}</span>
              </>
            )}
          </div>

          {!editing && (
            <div className="chat-msg-tools">
              <button type="button" title="Reageren" onClick={() => setShowReactPicker((v) => !v)}><Smile size={14} /></button>
              {mine && <button type="button" title="Bewerken" onClick={() => { setDraft(msg.body); setEditing(true); }}><Pencil size={13} /></button>}
              {mine && <button type="button" title="Intrekken" onClick={() => void remove()}><Trash2 size={13} /></button>}
              {showReactPicker && (
                <div className="chat-react-picker">
                  {QUICK_REACTIONS.map((e) => <button key={e} type="button" onClick={() => void toggleReaction(e)}>{e}</button>)}
                </div>
              )}
            </div>
          )}
        </div>

        {grouped.length > 0 && (
          <div className="chat-reactions">
            {grouped.map(([emoji, info]) => (
              <button key={emoji} type="button" className={`chat-reaction${info.mine ? ' mine' : ''}`} onClick={() => void toggleReaction(emoji)}>
                <span>{emoji}</span><span className="chat-reaction-n">{info.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Toont berichttekst met @-vermeldingen van bekende teamleden gemarkeerd. */
function MessageBody({ body, teamMembers }: { body: string; teamMembers: OrganizationMember[] }) {
  const names = useMemo(() => teamMembers.map((m) => memberDisplay(m).name).filter(Boolean), [teamMembers]);
  if (names.length === 0 || !body.includes('@')) return <>{body}</>;
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length);
  const re = new RegExp(`@(${escaped.join('|')})`, 'g');
  const parts: (string | { mention: string })[] = [];
  let last = 0; let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    if (match.index > last) parts.push(body.slice(last, match.index));
    parts.push({ mention: match[0] });
    last = match.index + match[0].length;
  }
  if (last < body.length) parts.push(body.slice(last));
  return <>{parts.map((p, i) => (typeof p === 'string' ? p : <span key={i} className="chat-mention">{p.mention}</span>))}</>;
}

// ── Composer met bestand-upload + @-vermeldingen ─────────────────────────────

function Composer({ api, conversationId, memberIds, onTyping, onSent, onError }: {
  api: TeamChatApi;
  conversationId: string;
  memberIds: string[];
  onTyping: () => void;
  onSent: (msg: ChatMessage, atts: Attachment[]) => void;
  onError: (msg: string | null) => void;
}) {
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [mention, setMention] = useState<{ query: string; start: number; end: number } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const mentionMembers = useMemo(() => api.teamMembers.filter((m) => memberIds.includes(m.user_id) && m.user_id !== api.currentUserId), [api.teamMembers, memberIds, api.currentUserId]);

  function autoGrow() {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }

  function detectMention(value: string, caret: number) {
    const upto = value.slice(0, caret);
    const m = /(^|\s)@([^\s@]*)$/.exec(upto);
    if (m) setMention({ query: m[2].toLowerCase(), start: caret - m[2].length - 1, end: caret });
    else setMention(null);
  }

  function onInput(e: FormEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget;
    setDraft(el.value);
    autoGrow();
    detectMention(el.value, el.selectionStart ?? el.value.length);
    if (el.value.trim()) onTyping();
  }

  function pickMention(member: OrganizationMember) {
    if (!mention) return;
    const name = memberDisplay(member).name;
    const before = draft.slice(0, mention.start);
    // Vervang exact het @-token (start..end uit de detectie), niet de live caret —
    // die kan verschoven zijn nadat de textarea de focus verloor bij het klikken.
    const after = draft.slice(mention.end);
    const next = `${before}@${name} ${after}`;
    setDraft(next);
    setMention(null);
    window.requestAnimationFrame(() => { inputRef.current?.focus(); autoGrow(); });
  }

  function computeMentions(body: string): UUID[] {
    const ids: UUID[] = [];
    for (const m of mentionMembers) {
      if (body.includes(`@${memberDisplay(m).name}`)) ids.push(m.user_id);
    }
    return ids;
  }

  async function submit() {
    const body = draft.trim();
    if ((!body && files.length === 0) || sending || !api.organizationId) return;
    setSending(true); onError(null);
    const staged = files;
    setDraft(''); setFiles([]); setMention(null);
    if (inputRef.current) inputRef.current.style.height = 'auto';
    try {
      const { message, attachments, failedUploads } = await sendMessage(api.organizationId, conversationId, {
        body, mentions: computeMentions(body), files: staged,
      });
      onSent(message, attachments);
      // Het bericht ís verzonden; alleen bijlagen faalden → melden, niet de tekst
      // herstellen (anders stuurt de gebruiker dezelfde tekst dubbel).
      if (failedUploads > 0) onError(`${failedUploads} bestand${failedUploads === 1 ? '' : 'en'} kon niet worden geüpload.`);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Versturen mislukt');
      setDraft(body); setFiles(staged);
    } finally {
      setSending(false);
      window.requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (mention && (e.key === 'Enter' || e.key === 'Tab') && mentionMembers.length > 0) {
      const list = mentionMembers.filter((m) => memberDisplay(m).name.toLowerCase().includes(mention.query));
      if (list.length > 0) { e.preventDefault(); pickMention(list[0]); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); }
  }

  function addFiles(list: FileList | null) {
    if (!list) return;
    setFiles((prev) => [...prev, ...Array.from(list)]);
    if (fileRef.current) fileRef.current.value = '';
  }

  const mentionList = mention ? mentionMembers.filter((m) => memberDisplay(m).name.toLowerCase().includes(mention.query)).slice(0, 6) : [];

  return (
    <div className="chat-composer-wrap">
      {mention && mentionList.length > 0 && (
        <div className="chat-mention-pop">
          {mentionList.map((m) => (
            <button type="button" key={m.user_id} onClick={() => pickMention(m)}>
              <Avatar id={m.user_id} initials={memberDisplay(m).initials} size={24} />
              <span>{memberDisplay(m).name}</span>
            </button>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="chat-staged">
          {files.map((f, i) => (
            <span className="chat-staged-file" key={`${f.name}-${i}`}>
              <Paperclip size={12} />{f.name}
              <button type="button" onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))} aria-label="Verwijderen"><X size={12} /></button>
            </span>
          ))}
        </div>
      )}
      <div className="chat-composer">
        <button type="button" className="chat-icon-btn" title="Bestand toevoegen" onClick={() => fileRef.current?.click()}><Paperclip size={18} /></button>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => addFiles(e.target.files)} />
        <textarea
          ref={inputRef}
          className="chat-input"
          rows={1}
          placeholder="Typ een bericht…"
          value={draft}
          onInput={onInput}
          onKeyDown={onKeyDown}
        />
        <button type="button" className="chat-send" onClick={() => void submit()} disabled={sending || (!draft.trim() && files.length === 0)} aria-label="Versturen"><Send size={17} /></button>
      </div>
    </div>
  );
}

// ── Kanaalleden + verlaten ───────────────────────────────────────────────────

function ChannelMembers({ api, vm, memberById, onLeft, onClose }: {
  api: TeamChatApi;
  vm: ConversationVM;
  memberById: Map<string, OrganizationMember>;
  onLeft: () => void;
  onClose: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const candidates = api.teamMembers.filter((m) => !vm.memberIds.includes(m.user_id));

  async function add(userId: string) {
    try { await addParticipants(vm.conversation.id, [userId]); await api.reloadConversations(); }
    catch { /* */ }
  }
  async function leave() {
    if (!confirm('Dit kanaal verlaten?')) return;
    try { await leaveConversation(vm.conversation.id); onLeft(); } catch { /* */ }
  }

  return (
    <div className="chat-members">
      <div className="chat-members-head"><span>Leden ({vm.memberIds.length})</span><button type="button" className="chat-icon-btn" onClick={onClose}><X size={15} /></button></div>
      <div className="chat-members-list">
        {vm.memberIds.map((id) => {
          const d = memberDisplay(memberById.get(id));
          return <div key={id} className="chat-member"><Avatar id={id} initials={d.initials} online={api.online.has(id)} size={26} /><span>{d.name}{id === api.currentUserId ? ' (jij)' : ''}</span></div>;
        })}
      </div>
      {adding
        ? <div className="chat-members-add">
            {candidates.length === 0 && <div className="chat-list-hint">Iedereen zit al in dit kanaal.</div>}
            {candidates.map((m) => {
              const d = memberDisplay(m);
              return <button type="button" key={m.user_id} className="chat-member" onClick={() => void add(m.user_id)}><Plus size={14} /><Avatar id={m.user_id} initials={d.initials} size={24} /><span>{d.name}</span></button>;
            })}
          </div>
        : <button type="button" className="chat-members-btn" onClick={() => setAdding(true)}><Plus size={14} /> Leden toevoegen</button>}
      <button type="button" className="chat-members-leave" onClick={() => void leave()}><LogOut size={14} /> Kanaal verlaten</button>
    </div>
  );
}

// ── Nieuw gesprek / kanaal ───────────────────────────────────────────────────

function NewConversationModal({ api, mode, onClose, onCreated }: {
  api: TeamChatApi;
  mode: 'dm' | 'channel';
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const others = api.teamMembers.filter((m) => m.user_id !== api.currentUserId);

  function toggle(id: string) {
    setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }

  async function create() {
    if (!api.organizationId || busy) return;
    setBusy(true); setError(null);
    try {
      if (mode === 'dm') {
        const target = Array.from(selected)[0];
        if (!target) { setError('Kies een teamlid.'); setBusy(false); return; }
        const id = await startDm(api.organizationId, target);
        await api.reloadConversations();
        onCreated(id);
      } else {
        if (!title.trim()) { setError('Geef het kanaal een naam.'); setBusy(false); return; }
        const id = await createChannel(api.organizationId, title.trim(), Array.from(selected));
        await api.reloadConversations();
        onCreated(id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Aanmaken mislukt');
      setBusy(false);
    }
  }

  return (
    <div className="chat-modal-bg" onClick={onClose}>
      <div className="chat-modal" onClick={(e) => e.stopPropagation()}>
        <div className="chat-modal-head">
          <h3>{mode === 'dm' ? 'Nieuw gesprek' : 'Nieuw kanaal'}</h3>
          <button type="button" className="chat-icon-btn" onClick={onClose}><X size={18} /></button>
        </div>
        {mode === 'channel' && (
          <input className="chat-modal-input" placeholder="Kanaalnaam (bijv. algemeen)" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        )}
        <div className="chat-modal-sub">{mode === 'dm' ? 'Kies een teamlid' : 'Voeg leden toe'}</div>
        <div className="chat-modal-members">
          {others.length === 0 && <div className="chat-list-hint">Er zijn nog geen andere teamleden in deze organisatie.</div>}
          {others.map((m) => {
            const d = memberDisplay(m);
            const on = selected.has(m.user_id);
            return (
              <button type="button" key={m.user_id} className={`chat-modal-member${on ? ' selected' : ''}`}
                onClick={() => (mode === 'dm' ? setSelected(new Set([m.user_id])) : toggle(m.user_id))}>
                <Avatar id={m.user_id} initials={d.initials} online={api.online.has(m.user_id)} size={30} />
                <span>{d.name}</span>
                {on && <Check size={16} className="chat-modal-check" />}
              </button>
            );
          })}
        </div>
        {error && <div className="chat-error">{error}</div>}
        <div className="chat-modal-actions">
          <button type="button" onClick={onClose}>Annuleren</button>
          <button type="button" className="primary" onClick={() => void create()} disabled={busy}>
            {busy ? 'Bezig…' : mode === 'dm' ? 'Openen' : 'Kanaal maken'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Publieke mounts ──────────────────────────────────────────────────────────

/** Volledige chatpagina (menu-item 'chat'). */
export function TeamChatPage({ api }: { api: TeamChatApi }) {
  return <ChatShell api={api} variant="page" />;
}

/** Zwevend chatpaneel rechtsonder (overal beschikbaar, behalve op de chatpagina). */
export function TeamChatDock({ api, hidden }: { api: TeamChatApi; hidden?: boolean }) {
  const [open, setOpen] = useState(false);
  if (hidden) return null;
  return (
    <div className="team-chat-dock-root">
      {open && (
        <section className="team-chat-dock" role="dialog" aria-label="Teamchat">
          <ChatShell api={api} variant="dock" onClose={() => setOpen(false)} />
        </section>
      )}
      <button type="button" className={`team-chat-fab${open ? ' is-open' : ''}`} onClick={() => setOpen((v) => !v)} aria-label={open ? 'Teamchat sluiten' : 'Teamchat openen'} aria-expanded={open}>
        {open ? <X size={22} /> : <MessageSquare size={22} />}
        {!open && api.unreadTotal > 0 && <span className="team-chat-fab-badge">{api.unreadTotal > 99 ? '99+' : api.unreadTotal}</span>}
      </button>
    </div>
  );
}
