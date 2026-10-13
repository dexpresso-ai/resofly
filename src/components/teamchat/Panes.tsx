import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AtSign, Bell, BellOff, Bookmark, BookmarkX, CheckCheck, ChevronDown, ChevronRight, Compass, CornerUpLeft, Download,
  EyeOff, FileText, Filter, Hash, LogOut, MailOpen, MessageSquare, MessageSquarePlus, MoreHorizontal, Pencil, Pin,
  PinOff, Plus, Search, SmilePlus, SquarePen, Users, X,
} from 'lucide-react';
import {
  createGroup, leaveConversation, loadChatFiles, loadMessagesByIds, loadPublicChannels, loadSavedMessageIds, searchMessages,
  sendMessage, startDm,
} from '../../lib/chat';
import { plainPreview } from '../../lib/chatFormat';
import { downloadAttachment } from '../../lib/r2';
import type { Attachment, ChatActivityItem, ChatMessage } from '../../types';
import { FileIcon } from './attachments';
import { Composer, type ComposerSubmit } from './Composer';
import { ConversationAvatar, PeopleField, StatusMessageDialog } from './Dialogs';
import {
  activeStatusMessage, AVAILABILITY_CHOICES, formatAgo, formatBytes, formatListTime, memberDisplay, plainSnippet,
  PRESENCE_LABEL, previewLine, ts, type ConversationVM,
} from './model';
import type { TeamChatApi } from './useTeamChat';
import { Avatar, IconButton, Menu, Popover, PresenceBadge, TeamAvatar, type MenuItem } from './ui';

export type ChatView = 'activity' | 'chat' | 'teams' | 'files' | 'saved';

export const VIEW_ITEMS: { key: ChatView; label: string; icon: (size: number) => ReactNode }[] = [
  { key: 'activity', label: 'Activiteit', icon: (s) => <Bell size={s} /> },
  { key: 'chat', label: 'Chat', icon: (s) => <MessageSquare size={s} /> },
  { key: 'teams', label: 'Teams', icon: (s) => <Users size={s} /> },
  { key: 'files', label: 'Bestanden', icon: (s) => <FileText size={s} /> },
  { key: 'saved', label: 'Opgeslagen', icon: (s) => <Bookmark size={s} /> },
];

export function viewBadge(api: TeamChatApi, view: ChatView): number {
  if (view === 'activity') return api.activityUnseen;
  if (view === 'chat') return api.unreadChats;
  if (view === 'teams') return api.unreadChannels;
  return 0;
}

// ── De app-rail links (zoals in Teams) ───────────────────────────────────────

export function Rail({ api, view, onView }: { api: TeamChatApi; view: ChatView; onView: (v: ChatView) => void }) {
  return (
    <nav className="tmc-rail" aria-label="Teamchat">
      {VIEW_ITEMS.map((item) => {
        const badge = viewBadge(api, item.key);
        return (
          <button key={item.key} type="button" className={`tmc-rail-item${view === item.key ? ' is-active' : ''}`} onClick={() => onView(item.key)} aria-current={view === item.key ? 'page' : undefined} title={item.label}>
            <span className="tmc-rail-icon">{item.icon(20)}{badge > 0 && <span className="tmc-badge is-alert">{badge > 99 ? '99+' : badge}</span>}</span>
            <span className="tmc-rail-label">{item.label}</span>
          </button>
        );
      })}
      <span className="tmc-rail-spacer" />
      <StatusButton api={api} />
    </nav>
  );
}

/** Je eigen avatar met status; een klik opent het statusmenu van Teams. */
export function StatusButton({ api, size = 34 }: { api: TeamChatApi; size?: number }) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const me = api.currentUserId;
  const member = api.memberById.get(me ?? '');
  const d = memberDisplay(member);
  const presence = api.presenceOf(me);
  const manual = api.myStatus?.availability ?? 'auto';
  const message = activeStatusMessage(api.myStatus ?? undefined);
  const [error, setError] = useState<string | null>(null);

  function choose(value: typeof manual) {
    setOpen(false);
    setError(null);
    api.setMyAvailability(value).catch(() => setError('Status opslaan mislukt.'));
  }

  return (
    <>
      <button type="button" ref={ref} className="tmc-me" onClick={() => setOpen((v) => !v)} aria-label={`Jouw status: ${PRESENCE_LABEL[presence]}`} title={`Jouw status: ${PRESENCE_LABEL[presence]}`} aria-expanded={open}>
        <Avatar userId={me} member={member} size={size} presence={presence} />
      </button>
      <Popover anchorRef={ref} open={open} onClose={() => setOpen(false)} placement="right-start" className="tmc-status-pop" width={300} label="Status">
        <div className="tmc-status-head">
          <Avatar userId={me} member={member} size={44} presence={presence} />
          <div><strong>{d.name}</strong><small>{d.email}</small></div>
        </div>
        {message && <div className="tmc-status-msg">“{message}”</div>}
        <div className="tmc-status-list" role="menu" aria-label="Status kiezen">
          {AVAILABILITY_CHOICES.map((c) => (
            <button key={c.value} type="button" role="menuitemradio" aria-checked={manual === c.value} className={`tmc-menu-item${manual === c.value ? ' is-checked' : ''}`} onClick={() => choose(c.value)}>
              <span className="tmc-menu-icon"><PresenceBadge presence={c.presence} size={14} ring={false} /></span>
              <span className="tmc-menu-label">{c.label}</span>
            </button>
          ))}
          {manual !== 'auto' && (
            <button type="button" role="menuitem" className="tmc-menu-item" onClick={() => choose('auto')}>
              <span className="tmc-menu-icon"><CheckCheck size={15} /></span>
              <span className="tmc-menu-label">Status opnieuw instellen<small>Automatisch: Beschikbaar of Afwezig</small></span>
            </button>
          )}
          <div className="tmc-menu-sep" />
          <button type="button" role="menuitem" className="tmc-menu-item" onClick={() => { setOpen(false); setDialog(true); }}>
            <span className="tmc-menu-icon"><Pencil size={15} /></span>
            <span className="tmc-menu-label">{message ? 'Statusbericht wijzigen' : 'Statusbericht instellen'}</span>
          </button>
        </div>
        {error && <div className="tmc-inline-error">{error}</div>}
      </Popover>
      {dialog && <StatusMessageDialog api={api} onClose={() => setDialog(false)} />}
    </>
  );
}

// ── Kop van een lijstvenster ─────────────────────────────────────────────────

function PaneHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="tmc-pane-head">
      <h2>{title}</h2>
      <div className="tmc-pane-actions">{children}</div>
    </div>
  );
}

function Section({ title, count, open, onToggle, children, action }: { title: string; count?: number; open: boolean; onToggle: () => void; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="tmc-section">
      <div className="tmc-section-head">
        <button type="button" className="tmc-section-toggle" onClick={onToggle} aria-expanded={open}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span>{title}</span>{count !== undefined && <span className="tmc-section-count">{count}</span>}
        </button>
        {action}
      </div>
      {open && children}
    </div>
  );
}

// ── Eén regel in de gesprekslijst ────────────────────────────────────────────

function ConversationRow({ api, vm, active, onOpen, indent }: { api: TeamChatApi; vm: ConversationVM; active: boolean; onOpen: (id: string) => void; indent?: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const draft = !active && api.draftIds.has(vm.id) ? api.getDraft(vm.id) : '';
  const unread = vm.unread > 0;
  const isChannel = vm.kind === 'channel';
  const sub = draft ? null : previewLine(vm, api.currentUserId, api.memberById);

  const items: MenuItem[] = [
    { key: 'pin', label: vm.pinned ? 'Losmaken' : 'Vastmaken', icon: vm.pinned ? <PinOff size={16} /> : <Pin size={16} />, onSelect: () => void api.setPrefs(vm.id, { pinned: !vm.pinned }) },
    unread
      ? { key: 'read', label: 'Markeren als gelezen', icon: <CheckCheck size={16} />, onSelect: () => void api.markRead(vm.id) }
      : { key: 'unread', label: 'Markeren als ongelezen', icon: <MailOpen size={16} />, onSelect: () => void api.setPrefs(vm.id, { unread: true }) },
    { key: 'mute', label: vm.muted ? 'Dempen opheffen' : 'Dempen', icon: vm.muted ? <Bell size={16} /> : <BellOff size={16} />, onSelect: () => void api.setPrefs(vm.id, { muted: !vm.muted }) },
    { key: 'hide', label: vm.hidden ? 'Weergeven' : 'Verbergen', icon: <EyeOff size={16} />, onSelect: () => void api.setPrefs(vm.id, { hidden: !vm.hidden }) },
  ];
  if (vm.kind !== 'dm') {
    items.push({
      key: 'leave', label: isChannel ? 'Kanaal verlaten' : 'Chat verlaten', icon: <LogOut size={16} />, danger: true, divider: true,
      onSelect: () => {
        if (!confirm(isChannel ? `#${vm.title} verlaten?` : 'Deze groepschat verlaten?')) return;
        leaveConversation(vm.id).then(() => api.reloadConversations()).catch(() => undefined);
      },
    });
  }

  return (
    <div className={`tmc-row-wrap${active ? ' is-active' : ''}${unread ? ' is-unread' : ''}${indent ? ' is-indent' : ''}`}>
      <button type="button" className="tmc-row" onClick={() => onOpen(vm.id)} aria-current={active ? 'true' : undefined}>
        {isChannel
          ? <span className="tmc-row-hash" aria-hidden="true"><Hash size={15} /></span>
          : <ConversationAvatar api={api} vm={vm} size={32} />}
        <span className="tmc-row-body">
          <span className="tmc-row-top">
            <span className="tmc-row-name">{vm.title}</span>
            {vm.muted && <BellOff size={12} className="tmc-row-muted" aria-label="Gedempt" />}
            {!isChannel && <span className="tmc-row-time">{formatListTime(vm.lastActivity)}</span>}
          </span>
          {!isChannel && (
            <span className="tmc-row-sub">
              {draft ? <><span className="tmc-row-draft">Concept:</span> {plainPreview(draft, 70)}</> : sub}
            </span>
          )}
        </span>
        {unread && (vm.muted ? <span className="tmc-dot" aria-label="Ongelezen" /> : <span className="tmc-count" aria-label={`${vm.unread} ongelezen`}>{vm.unread > 99 ? '99+' : vm.unread}</span>)}
      </button>
      <button type="button" ref={moreRef} className="tmc-row-more" onClick={() => setMenuOpen((v) => !v)} aria-label={`Meer opties voor ${vm.title}`} title="Meer opties" aria-expanded={menuOpen}><MoreHorizontal size={16} /></button>
      <Menu anchorRef={moreRef} open={menuOpen} onClose={() => setMenuOpen(false)} items={items} />
    </div>
  );
}

// ── Chat ─────────────────────────────────────────────────────────────────────

type ChatFilter = 'all' | 'unread' | 'dm' | 'group' | 'muted';
const CHAT_FILTERS: { key: ChatFilter; label: string }[] = [
  { key: 'all', label: 'Alles' },
  { key: 'unread', label: 'Ongelezen' },
  { key: 'dm', label: '1-op-1' },
  { key: 'group', label: 'Groepschats' },
  { key: 'muted', label: 'Gedempt' },
];

export function ChatListPane({ api, activeId, onOpen, onNewChat, compact }: {
  api: TeamChatApi;
  activeId: string | null;
  onOpen: (id: string, messageId?: string | null) => void;
  onNewChat: () => void;
  compact?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ChatFilter>('all');
  const [filterOpen, setFilterOpen] = useState(false);
  const [open, setOpen] = useState({ pinned: true, recent: true });
  const [results, setResults] = useState<ChatMessage[] | null>(null);
  const [searching, setSearching] = useState(false);
  const q = query.trim().toLowerCase();

  useEffect(() => {
    if (q.length < 2 || !api.organizationId) { setResults(null); return; }
    setSearching(true);
    const t = window.setTimeout(() => {
      searchMessages(api.organizationId!, q, 25)
        .then((rows) => setResults(rows))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => window.clearTimeout(t);
  }, [q, api.organizationId]);

  const chats = api.vms.filter((vm) => vm.kind !== 'channel');
  const matches = (vm: ConversationVM) => !q
    || vm.title.toLowerCase().includes(q)
    || vm.memberIds.some((id) => memberDisplay(api.memberById.get(id)).name.toLowerCase().includes(q));
  const passFilter = (vm: ConversationVM) => {
    switch (filter) {
      case 'unread': return vm.unread > 0;
      case 'dm': return vm.kind === 'dm';
      case 'group': return vm.kind === 'group';
      case 'muted': return vm.muted;
      default: return true;
    }
  };
  const visible = chats.filter((vm) => matches(vm) && passFilter(vm) && (q || filter === 'muted' || !vm.hidden || vm.id === activeId));
  const pinned = visible.filter((vm) => vm.pinned);
  const recent = visible.filter((vm) => !vm.pinned);
  const dmWith = new Set(chats.filter((vm) => vm.kind === 'dm').map((vm) => vm.counterpartId));
  const people = q
    ? api.teamMembers.filter((m) => m.user_id !== api.currentUserId && !dmWith.has(m.user_id) && memberDisplay(m).name.toLowerCase().includes(q)).slice(0, 5)
    : [];
  const vmById = new Map(api.vms.map((v) => [v.id, v]));

  const [startError, setStartError] = useState<string | null>(null);
  async function startWith(userId: string) {
    if (!api.organizationId) return;
    setStartError(null);
    try {
      const id = await startDm(api.organizationId, userId);
      await api.reloadConversations();
      setQuery('');
      onOpen(id);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : 'Chat starten mislukt');
    }
  }

  return (
    <div className={`tmc-list${compact ? ' is-compact' : ''}`}>
      <PaneHead title="Chat">
        <IconButton label="Filteren" onClick={() => setFilterOpen((v) => !v)} active={filterOpen || filter !== 'all'} expanded={filterOpen}><Filter size={17} /></IconButton>
        {api.canWrite && <IconButton label="Nieuwe chat" onClick={onNewChat}><SquarePen size={17} /></IconButton>}
      </PaneHead>
      <label className="tmc-search">
        <Search size={15} aria-hidden="true" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Zoek een chat, collega of bericht" aria-label="Zoeken in de chat" />
        {query && <button type="button" onClick={() => setQuery('')} aria-label="Wissen"><X size={14} /></button>}
      </label>
      {filterOpen && (
        <div className="tmc-filters" role="radiogroup" aria-label="Filter">
          {CHAT_FILTERS.map((f) => (
            <button key={f.key} type="button" role="radio" aria-checked={filter === f.key} className={filter === f.key ? 'is-active' : ''} onClick={() => setFilter(f.key)}>{f.label}</button>
          ))}
        </div>
      )}
      <div className="tmc-list-scroll">
        {startError && <div className="tmc-inline-error">{startError}</div>}
        {people.length > 0 && (
          <div className="tmc-section">
            <div className="tmc-section-title">Personen</div>
            {people.map((m) => (
              <button key={m.user_id} type="button" className="tmc-row tmc-row-person" onClick={() => void startWith(m.user_id)}>
                <Avatar userId={m.user_id} member={m} size={32} presence={api.presenceOf(m.user_id)} />
                <span className="tmc-row-body">
                  <span className="tmc-row-top"><span className="tmc-row-name">{memberDisplay(m).name}</span></span>
                  <span className="tmc-row-sub">Nieuwe chat beginnen</span>
                </span>
              </button>
            ))}
          </div>
        )}
        {pinned.length > 0 && (
          <Section title="Vastgemaakt" open={open.pinned} onToggle={() => setOpen((o) => ({ ...o, pinned: !o.pinned }))}>
            {pinned.map((vm) => <ConversationRow key={vm.id} api={api} vm={vm} active={vm.id === activeId} onOpen={onOpen} />)}
          </Section>
        )}
        <Section title="Recent" open={open.recent} onToggle={() => setOpen((o) => ({ ...o, recent: !o.recent }))}>
          {recent.map((vm) => <ConversationRow key={vm.id} api={api} vm={vm} active={vm.id === activeId} onOpen={onOpen} />)}
          {recent.length === 0 && pinned.length === 0 && (
            <div className="tmc-empty-hint">
              {q || filter !== 'all'
                ? 'Geen chats gevonden.'
                : <>Nog geen chats. {api.canWrite && <button type="button" className="tmc-link-btn" onClick={onNewChat}>Begin een nieuwe chat</button>}</>}
            </div>
          )}
        </Section>
        {q.length >= 2 && (
          <div className="tmc-section">
            <div className="tmc-section-title">Berichten{searching ? ' — zoeken…' : results ? ` (${results.length})` : ''}</div>
            {results?.length === 0 && !searching && <div className="tmc-empty-hint">Geen berichten met “{query.trim()}”.</div>}
            {results?.map((m) => {
              const vm = vmById.get(m.conversation_id);
              return (
                <button key={m.id} type="button" className="tmc-result" onClick={() => onOpen(m.conversation_id, m.id)}>
                  <Avatar userId={m.sender_id} member={api.memberById.get(m.sender_id ?? '')} size={28} />
                  <span className="tmc-result-body">
                    <span className="tmc-result-top"><strong>{memberDisplay(api.memberById.get(m.sender_id ?? '')).name}</strong><span>{vm ? (vm.kind === 'channel' ? `#${vm.title}` : vm.title) : ''}</span><time>{formatListTime(m.created_at)}</time></span>
                    <Highlight text={plainSnippet(m, 160)} query={query.trim()} />
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function Highlight({ text, query }: { text: string; query: string }) {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (!query || idx < 0) return <span className="tmc-result-text">{text}</span>;
  const start = Math.max(0, idx - 40);
  return (
    <span className="tmc-result-text">
      {start > 0 && '…'}{text.slice(start, idx)}<mark>{text.slice(idx, idx + query.length)}</mark>{text.slice(idx + query.length)}
    </span>
  );
}

// ── Teams (kanalen) ──────────────────────────────────────────────────────────

export function TeamsListPane({ api, activeId, onOpen, onNewChannel, onDiscover, compact }: {
  api: TeamChatApi;
  activeId: string | null;
  onOpen: (id: string) => void;
  onNewChannel: () => void;
  onDiscover: () => void;
  compact?: boolean;
}) {
  const [teamOpen, setTeamOpen] = useState(true);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [discoverable, setDiscoverable] = useState(0);
  const [teamMenu, setTeamMenu] = useState(false);
  const teamMenuRef = useRef<HTMLButtonElement>(null);
  const channels = api.vms
    .filter((vm) => vm.kind === 'channel')
    .sort((a, b) => a.title.localeCompare(b.title, 'nl', { sensitivity: 'base' }));
  const shown = channels.filter((vm) => !vm.hidden || vm.id === activeId);
  const hidden = channels.filter((vm) => vm.hidden && vm.id !== activeId);
  const channelCount = channels.length;

  useEffect(() => {
    if (!api.organizationId) return;
    let alive = true;
    loadPublicChannels(api.organizationId).then((rows) => { if (alive) setDiscoverable(rows.length); });
    return () => { alive = false; };
  }, [api.organizationId, channelCount]);

  const teamItems: MenuItem[] = [
    ...(api.canWrite ? [{ key: 'new', label: 'Kanaal maken', icon: <Plus size={16} />, onSelect: onNewChannel }] : []),
    { key: 'discover', label: 'Kanalen ontdekken', icon: <Compass size={16} />, onSelect: onDiscover },
  ];

  return (
    <div className={`tmc-list${compact ? ' is-compact' : ''}`}>
      <PaneHead title="Teams">
        <IconButton label="Kanalen ontdekken" onClick={onDiscover}><Compass size={17} /></IconButton>
        {api.canWrite && <IconButton label="Kanaal maken" onClick={onNewChannel}><Plus size={18} /></IconButton>}
      </PaneHead>
      <div className="tmc-list-scroll">
        <div className="tmc-team">
          <div className="tmc-team-head">
            <button type="button" className="tmc-team-toggle" onClick={() => setTeamOpen((v) => !v)} aria-expanded={teamOpen}>
              {teamOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <TeamAvatar name={api.organizationName} size={28} />
              <span className="tmc-team-name">{api.organizationName}</span>
            </button>
            <button type="button" ref={teamMenuRef} className="tmc-row-more is-visible" onClick={() => setTeamMenu((v) => !v)} aria-label="Meer opties voor het team" aria-expanded={teamMenu}><MoreHorizontal size={16} /></button>
            <Menu anchorRef={teamMenuRef} open={teamMenu} onClose={() => setTeamMenu(false)} items={teamItems} />
          </div>
          {teamOpen && (
            <div className="tmc-team-channels">
              {shown.map((vm) => <ConversationRow key={vm.id} api={api} vm={vm} active={vm.id === activeId} onOpen={onOpen} indent />)}
              {shown.length === 0 && (
                <div className="tmc-empty-hint">
                  Nog geen kanalen. {api.canWrite && <button type="button" className="tmc-link-btn" onClick={onNewChannel}>Maak het eerste kanaal</button>}
                </div>
              )}
              {discoverable > 0 && (
                <button type="button" className="tmc-discover-link" onClick={onDiscover}><Compass size={14} /> {discoverable} {discoverable === 1 ? 'kanaal' : 'kanalen'} om te ontdekken</button>
              )}
              {hidden.length > 0 && (
                <>
                  <button type="button" className="tmc-hidden-toggle" onClick={() => setHiddenOpen((v) => !v)} aria-expanded={hiddenOpen}>
                    {hiddenOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {hidden.length} verborgen {hidden.length === 1 ? 'kanaal' : 'kanalen'}
                  </button>
                  {hiddenOpen && hidden.map((vm) => <ConversationRow key={vm.id} api={api} vm={vm} active={false} onOpen={onOpen} indent />)}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Activiteit ───────────────────────────────────────────────────────────────

type ActivityFilter = 'all' | ChatActivityItem['activity_type'];

export function ActivityPane({ api, onOpen, activeId }: { api: TeamChatApi; onOpen: (conversationId: string, messageId: string) => void; activeId: string | null }) {
  const [filter, setFilter] = useState<ActivityFilter>('all');
  // Wat nieuw was toen je keek, blijft vet zolang je hier bent; de teller gaat meteen naar nul.
  const [seenBefore] = useState(api.activitySeenAt);
  const [clicked, setClicked] = useState<Set<string>>(new Set());
  useEffect(() => { api.markActivitySeen(); void api.reloadActivity(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const vmById = new Map(api.vms.map((v) => [v.id, v]));
  const items = api.activity.filter((a) => filter === 'all' || a.activity_type === filter);

  return (
    <div className="tmc-list">
      <PaneHead title="Activiteit">
        <IconButton label="Alles als gelezen markeren" onClick={() => setClicked(new Set(api.activity.map((a) => `${a.activity_type}:${a.message_id}:${a.actor_id}:${a.emoji ?? ''}`)))}><CheckCheck size={17} /></IconButton>
      </PaneHead>
      <div className="tmc-filters is-static" role="radiogroup" aria-label="Filter">
        {([['all', 'Alles'], ['mention', 'Vermeldingen'], ['reply', 'Antwoorden'], ['reaction', 'Reacties']] as [ActivityFilter, string][]).map(([key, label]) => (
          <button key={key} type="button" role="radio" aria-checked={filter === key} className={filter === key ? 'is-active' : ''} onClick={() => setFilter(key)}>{label}</button>
        ))}
      </div>
      <div className="tmc-list-scroll">
        {items.length === 0 && (
          <div className="tmc-empty-panel is-small">
            <Bell size={28} />
            <strong>Niets nieuws</strong>
            <span>Hier zie je wie je noemt, wie op je antwoordt en wie op je berichten reageert.</span>
          </div>
        )}
        {items.map((a) => {
          const key = `${a.activity_type}:${a.message_id}:${a.actor_id}:${a.emoji ?? ''}`;
          const vm = vmById.get(a.conversation_id);
          const actor = memberDisplay(api.memberById.get(a.actor_id ?? '')).name;
          const fresh = ts(a.created_at) > ts(seenBefore) && !clicked.has(key);
          const where = vm ? (vm.kind === 'channel' ? `#${vm.title}` : vm.kind === 'dm' ? 'jullie chat' : vm.title) : 'een gesprek';
          const what = a.activity_type === 'mention' ? <>heeft je genoemd in <strong>{where}</strong></>
            : a.activity_type === 'reply' ? <>heeft geantwoord in <strong>{where}</strong></>
            : <>reageerde met {a.emoji} op je bericht in <strong>{where}</strong></>;
          return (
            <button key={key} type="button" className={`tmc-activity${fresh ? ' is-fresh' : ''}${vm?.id === activeId ? ' is-active' : ''}`}
              onClick={() => { setClicked((prev) => new Set(prev).add(key)); onOpen(a.conversation_id, a.message_id); }}>
              <span className="tmc-activity-av">
                <Avatar userId={a.actor_id} member={api.memberById.get(a.actor_id ?? '')} size={32} />
                <span className={`tmc-activity-type is-${a.activity_type}`}>
                  {a.activity_type === 'mention' ? <AtSign size={11} /> : a.activity_type === 'reply' ? <CornerUpLeft size={11} /> : <SmilePlus size={11} />}
                </span>
              </span>
              <span className="tmc-activity-body">
                <span className="tmc-activity-top"><span><strong>{actor}</strong> {what}</span><time>{formatAgo(a.created_at)}</time></span>
                {a.body && <span className="tmc-activity-text">{plainPreview(a.body, 120)}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Opgeslagen ───────────────────────────────────────────────────────────────

export function SavedPane({ api, onOpen, activeId }: { api: TeamChatApi; onOpen: (conversationId: string, messageId: string) => void; activeId: string | null }) {
  const [rows, setRows] = useState<{ message: ChatMessage; savedAt: string }[] | null>(null);
  const savedKey = [...api.savedIds].sort().join(',');
  useEffect(() => {
    if (!api.organizationId) return;
    let alive = true;
    (async () => {
      const ids = await loadSavedMessageIds(api.organizationId!);
      const messages = await loadMessagesByIds(ids.map((r) => r.message_id)).catch(() => [] as ChatMessage[]);
      const byId = new Map(messages.map((m) => [m.id, m]));
      if (alive) setRows(ids.filter((r) => byId.has(r.message_id)).map((r) => ({ message: byId.get(r.message_id)!, savedAt: r.created_at })));
    })();
    return () => { alive = false; };
  }, [api.organizationId, savedKey]);
  const vmById = new Map(api.vms.map((v) => [v.id, v]));

  return (
    <div className="tmc-list">
      <PaneHead title="Opgeslagen" />
      <div className="tmc-list-scroll">
        {rows === null && <div className="tmc-empty-hint">Laden…</div>}
        {rows?.length === 0 && (
          <div className="tmc-empty-panel is-small">
            <Bookmark size={28} />
            <strong>Nog niets opgeslagen</strong>
            <span>Kies bij een bericht “Meer opties” → “Dit bericht opslaan” om het hier terug te vinden.</span>
          </div>
        )}
        {rows?.map(({ message }) => {
          const vm = vmById.get(message.conversation_id);
          return (
            <div key={message.id} className={`tmc-saved${vm?.id === activeId ? ' is-active' : ''}`}>
              <button type="button" className="tmc-saved-main" onClick={() => onOpen(message.conversation_id, message.id)}>
                <Avatar userId={message.sender_id} member={api.memberById.get(message.sender_id ?? '')} size={30} />
                <span className="tmc-activity-body">
                  <span className="tmc-activity-top"><span><strong>{memberDisplay(api.memberById.get(message.sender_id ?? '')).name}</strong>{vm ? <> in {vm.kind === 'channel' ? `#${vm.title}` : vm.title}</> : null}</span><time>{formatListTime(message.created_at)}</time></span>
                  <span className="tmc-activity-text">{plainSnippet(message, 140)}</span>
                </span>
              </button>
              <IconButton label="Niet meer opslaan" onClick={() => void api.toggleSaved(message.id)} className="is-small"><BookmarkX size={15} /></IconButton>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Bestanden ────────────────────────────────────────────────────────────────

export function FilesView({ api, onOpen }: { api: TeamChatApi; onOpen: (conversationId: string, messageId: string) => void }) {
  const [rows, setRows] = useState<{ attachment: Attachment; message: ChatMessage | null }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (!api.organizationId) return;
    let alive = true;
    loadChatFiles(api.organizationId)
      .then((r) => { if (alive) setRows(r); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Laden mislukt'); });
    return () => { alive = false; };
  }, [api.organizationId]);
  const vmById = new Map(api.vms.map((v) => [v.id, v]));
  const q = query.trim().toLowerCase();
  const list = (rows ?? []).filter((r) => !q || r.attachment.name.toLowerCase().includes(q));

  return (
    <div className="tmc-files">
      <div className="tmc-files-head">
        <h2>Bestanden</h2>
        <span className="tmc-files-sub">Alles wat er in je chats en kanalen is gedeeld</span>
        <label className="tmc-search is-inline"><Search size={14} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Zoek op bestandsnaam" aria-label="Zoek op bestandsnaam" /></label>
      </div>
      {error && <div className="tmc-inline-error">{error}</div>}
      {rows === null && !error && <div className="tmc-empty-hint">Laden…</div>}
      {rows && list.length === 0 && (
        <div className="tmc-empty-panel"><FileText size={32} /><strong>{q ? 'Geen bestanden gevonden' : 'Nog geen bestanden gedeeld'}</strong><span>Bestanden die iemand in een chat of kanaal deelt, komen hier samen.</span></div>
      )}
      {list.length > 0 && (
        <div className="tmc-table is-files" role="table" aria-label="Bestanden">
          <div className="tmc-table-head" role="row"><span role="columnheader">Naam</span><span role="columnheader">Gedeeld in</span><span role="columnheader">Door</span><span role="columnheader">Datum</span><span role="columnheader" aria-label="Acties" /></div>
          {list.map(({ attachment, message }) => {
            const vm = message ? vmById.get(message.conversation_id) : undefined;
            return (
              <div key={attachment.id} className="tmc-table-row" role="row">
                <span role="cell" className="tmc-table-name"><FileIcon att={attachment} size={18} /><span><strong>{attachment.name}</strong><small>{formatBytes(attachment.size_bytes)}</small></span></span>
                <span role="cell">{vm ? (vm.kind === 'channel' ? `#${vm.title}` : vm.title) : '—'}</span>
                <span role="cell">{message ? memberDisplay(api.memberById.get(message.sender_id ?? '')).name : '—'}</span>
                <span role="cell">{formatListTime(attachment.created_at)}</span>
                <span role="cell" className="tmc-table-actions">
                  <IconButton label="Downloaden" onClick={() => void downloadAttachment(attachment)} className="is-small"><Download size={15} /></IconButton>
                  {message && <IconButton label="Toon in het gesprek" onClick={() => onOpen(message.conversation_id, message.id)} className="is-small"><MessageSquare size={15} /></IconButton>}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Nieuwe chat ("Aan:") ─────────────────────────────────────────────────────

export function NewChatPane({ api, onCancel, onCreated, single }: {
  api: TeamChatApi;
  onCancel: () => void;
  onCreated: (id: string) => void;
  single: boolean;
}) {
  const [people, setPeople] = useState<string[]>([]);
  const [groupName, setGroupName] = useState('');
  const [nameOpen, setNameOpen] = useState(false);
  const existing = people.length === 1 ? api.vms.find((vm) => vm.kind === 'dm' && vm.counterpartId === people[0]) ?? null : null;
  const single1 = people.length === 1 ? api.memberById.get(people[0]) : undefined;

  async function submit(input: ComposerSubmit): Promise<boolean> {
    if (!api.organizationId) return false;
    if (people.length === 0) throw new Error('Kies eerst minstens één collega bij “Aan:”.');
    const id = people.length === 1
      ? await startDm(api.organizationId, people[0])
      : await createGroup(api.organizationId, people, groupName);
    await sendMessage(api.organizationId, id, { body: input.body, mentions: input.mentions, files: input.files, importance: input.importance });
    await api.reloadConversations();
    onCreated(id);
    return true;
  }

  const memberIds = useMemo(() => [...people, api.currentUserId].filter(Boolean) as string[], [people, api.currentUserId]);

  return (
    <section className="tmc-conv tmc-newchat" aria-label="Nieuwe chat">
      <header className="tmc-head">
        {single && <IconButton label="Terug" onClick={onCancel} className="tmc-back"><X size={20} /></IconButton>}
        <span className="tmc-newchat-icon" aria-hidden="true"><MessageSquarePlus size={18} /></span>
        <div className="tmc-head-id"><div className="tmc-head-title"><h2>Nieuwe chat</h2></div></div>
        <div className="tmc-head-actions">
          {people.length >= 2 && (
            <button type="button" className={`tmc-btn is-ghost${nameOpen ? ' is-on' : ''}`} onClick={() => setNameOpen((v) => !v)} aria-expanded={nameOpen}>
              <Pencil size={14} /> Groepsnaam
            </button>
          )}
          {!single && <IconButton label="Annuleren" onClick={onCancel}><X size={18} /></IconButton>}
        </div>
      </header>
      {nameOpen && people.length >= 2 && (
        <div className="tmc-newchat-name">
          <input value={groupName} onChange={(e) => setGroupName(e.target.value.slice(0, 120))} placeholder="Geef de groepschat een naam (optioneel)" aria-label="Groepsnaam" autoFocus />
        </div>
      )}
      <div className="tmc-newchat-to">
        <PeopleField api={api} selected={people} onChange={setPeople} autoFocus placeholder="Typ een naam" />
      </div>
      <div className="tmc-newchat-body">
        {people.length === 0 && (
          <div className="tmc-start">
            <span className="tmc-start-art" aria-hidden="true"><MessageSquarePlus size={30} /></span>
            <strong>Begin een nieuw gesprek</strong>
            <span>Kies één collega voor een 1-op-1-chat, of meerdere voor een groepschat.</span>
          </div>
        )}
        {people.length === 1 && single1 && (
          <div className="tmc-start">
            <Avatar userId={people[0]} member={single1} size={64} presence={api.presenceOf(people[0])} />
            <strong>{memberDisplay(single1).name}</strong>
            <span>{existing ? 'Jullie hebben al een chat. Je bericht komt daarin.' : `${PRESENCE_LABEL[api.presenceOf(people[0])]} · Stuur een bericht om te beginnen.`}</span>
            {existing && <button type="button" className="tmc-btn" onClick={() => onCreated(existing.id)}>Naar de chat</button>}
          </div>
        )}
        {people.length >= 2 && (
          <div className="tmc-start">
            <div className="tmc-start-faces">
              {people.slice(0, 4).map((id) => <Avatar key={id} userId={id} member={api.memberById.get(id)} size={44} />)}
            </div>
            <strong>{groupName.trim() || people.map((id) => memberDisplay(api.memberById.get(id)).first).join(', ')}</strong>
            <span>Een nieuwe groepschat met {people.length} collega’s.</span>
          </div>
        )}
      </div>
      <div className="tmc-compose-wrap">
        <Composer
          api={api}
          draftKey="__new__"
          memberIds={memberIds}
          mode="new"
          placeholder={people.length ? 'Typ je eerste bericht' : 'Kies eerst bij “Aan:” met wie je wilt chatten'}
          onSubmit={submit}
          allowEveryone={people.length >= 2}
        />
      </div>
    </section>
  );
}
