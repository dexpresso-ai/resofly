import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bell, Maximize2, MessageSquare, MessageSquarePlus, Plus, X } from 'lucide-react';
import { ConversationView, type JumpRequest } from './ConversationView';
import { DiscoverChannelsDialog, NewChannelDialog } from './Dialogs';
import { memberDisplay } from './model';
import {
  ActivityPane, ChatListPane, FilesView, NewChatPane, Rail, SavedPane, StatusButton, TeamsListPane, VIEW_ITEMS, viewBadge,
  type ChatView,
} from './Panes';
import type { TeamChatApi } from './useTeamChat';
import { Avatar, useNarrowViewport } from './ui';

const VIEW_KEY = 'resofly.chat.view';

function storedView(variant: 'page' | 'dock'): ChatView {
  try {
    const v = window.sessionStorage.getItem(`${VIEW_KEY}.${variant}`) as ChatView | null;
    return v && VIEW_ITEMS.some((i) => i.key === v) ? v : 'chat';
  } catch {
    return 'chat';
  }
}

/**
 * De teamchat zoals Microsoft Teams hem opbouwt: links de app-rail (Activiteit,
 * Chat, Teams, Bestanden, Opgeslagen), dan de lijst, rechts het gesprek. Op
 * een telefoon en in het zwevende paneel één venster tegelijk, met de
 * onderdelen als tabbladen bovenaan — de opbouw van de Teams-app op je telefoon.
 */
export function ChatShell({ api, variant, onClose, onExpand, active = true }: {
  api: TeamChatApi;
  variant: 'page' | 'dock';
  onClose?: () => void;
  /** Zwevend paneel → de volledige pagina (met het open gesprek). */
  onExpand?: (conversationId: string | null) => void;
  /** Is dit het zichtbare tabblad? Alleen dat pakt meldingen en deeplinks op. */
  active?: boolean;
}) {
  const narrow = useNarrowViewport();
  const single = variant === 'dock' || narrow;
  const [view, setViewState] = useState<ChatView>(() => storedView(variant));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [jump, setJump] = useState<JumpRequest | null>(null);
  const [dialog, setDialog] = useState<null | 'channel' | 'discover'>(null);
  const autoPicked = useRef(false);
  const jumpSeq = useRef(0);
  const knownActive = useRef(false);

  const activeVm = api.vms.find((v) => v.id === activeId) ?? null;

  const setView = useCallback((v: ChatView) => {
    setViewState(v);
    try { window.sessionStorage.setItem(`${VIEW_KEY}.${variant}`, v); } catch { /* */ }
  }, [variant]);

  // Het open gesprek verdween (verlaten, verwijderd uit een groep): terug naar de lijst.
  useEffect(() => {
    if (activeVm) { knownActive.current = true; return; }
    if (activeId && knownActive.current) { knownActive.current = false; setActiveId(null); }
  }, [activeVm, activeId]);

  const openConversation = useCallback((id: string, messageId: string | null = null) => {
    const vm = api.vms.find((v) => v.id === id);
    autoPicked.current = false;
    knownActive.current = false;
    setComposing(false);
    if (vm && (view === 'chat' || view === 'teams' || view === 'files')) {
      setView(vm.kind === 'channel' ? 'teams' : 'chat');
    }
    setActiveId(id);
    if (messageId) {
      jumpSeq.current += 1;
      setJump({ messageId, seq: jumpSeq.current });
    } else {
      setJump(null);
    }
  }, [api.vms, view, setView]);

  // Twee kolommen naast elkaar: de rechterkolom hoort niet leeg te staan.
  useEffect(() => {
    if (single || composing || activeId) return;
    if (view !== 'chat' && view !== 'teams') return;
    const first = api.vms.find((v) => (view === 'teams' ? v.kind === 'channel' : v.kind !== 'channel') && !v.hidden);
    if (!first) return;
    autoPicked.current = true;
    setActiveId(first.id);
  }, [single, composing, activeId, view, api.vms]);

  // Venster wordt smal: een niet zelf gekozen gesprek maakt plaats voor de lijst.
  useEffect(() => {
    if (!single || !autoPicked.current) return;
    autoPicked.current = false;
    setActiveId(null);
  }, [single]);

  // Melding, deeplink of "open in volledig scherm".
  const reloadedFor = useRef<number | null>(null);
  useEffect(() => {
    const f = api.focus;
    if (!f || !active) return;
    if (!api.vms.some((v) => v.id === f.conversationId)) {
      // Nog niet geladen (een gloednieuw gesprek): één keer herladen, en na een
      // paar seconden opgeven — het gesprek bestaat dan niet (meer) voor jou.
      if (reloadedFor.current !== f.seq) {
        reloadedFor.current = f.seq;
        void api.reloadConversations();
        window.setTimeout(() => api.consumeFocus(f.seq), 5000);
      }
      return;
    }
    api.consumeFocus(f.seq);
    openConversation(f.conversationId, f.messageId);
  }, [api.focus, api.vms, active]); // eslint-disable-line react-hooks/exhaustive-deps

  function changeView(v: ChatView) {
    setView(v);
    setComposing(false);
    if (single) { setActiveId(null); return; }
    if (v === 'chat' && activeVm?.kind === 'channel') setActiveId(null);
    if (v === 'teams' && activeVm && activeVm.kind !== 'channel') setActiveId(null);
    if (v === 'files') setActiveId(null);
  }

  function startNewChat() {
    setComposing(true);
    if (view !== 'chat') setView('chat');
    if (!single) setActiveId(null);
  }

  const listPane = (() => {
    switch (view) {
      case 'activity': return <ActivityPane api={api} activeId={activeId} onOpen={(c, m) => openConversation(c, m)} />;
      case 'teams': return <TeamsListPane api={api} activeId={activeId} onOpen={(id) => openConversation(id)} onNewChannel={() => setDialog('channel')} onDiscover={() => setDialog('discover')} compact={single} />;
      case 'saved': return <SavedPane api={api} activeId={activeId} onOpen={(c, m) => openConversation(c, m)} />;
      case 'files': return null;
      default: return <ChatListPane api={api} activeId={composing ? null : activeId} onOpen={(id, m) => openConversation(id, m)} onNewChat={startNewChat} compact={single} />;
    }
  })();

  const mainPane = composing
    ? <NewChatPane api={api} single={single} onCancel={() => setComposing(false)} onCreated={(id) => openConversation(id)} />
    : activeVm
      ? <ConversationView
          key={activeVm.id}
          api={api}
          vm={activeVm}
          single={single}
          onBack={() => { setActiveId(null); autoPicked.current = false; }}
          jump={jump}
          onJumpHandled={() => setJump(null)}
          onOpenConversation={(id, m) => openConversation(id, m ?? null)}
        />
      : view === 'files'
        ? <FilesView api={api} onOpen={(c, m) => openConversation(c, m)} />
        : <EmptyMain api={api} view={view} onNewChat={startNewChat} onNewChannel={() => setDialog('channel')} />;

  const dialogs = (
    <>
      {dialog === 'channel' && <NewChannelDialog api={api} onClose={() => setDialog(null)} onCreated={(id) => { setDialog(null); openConversation(id); }} />}
      {dialog === 'discover' && <DiscoverChannelsDialog api={api} onClose={() => setDialog(null)} onJoined={(id) => { setDialog(null); openConversation(id); }} />}
    </>
  );

  if (!single) {
    return (
      <div className="tmc tmc-shell chat-shell chat-page">
        {variant === 'page' && <Rail api={api} view={view} onView={changeView} />}
        {listPane && <aside className="tmc-pane">{listPane}</aside>}
        <main className="tmc-main">{mainPane}</main>
        {dialogs}
      </div>
    );
  }

  const showMain = composing || !!activeVm;
  return (
    <div className={`tmc tmc-shell chat-shell chat-single ${variant === 'dock' ? 'chat-dock' : 'chat-page'}`}>
      {showMain ? mainPane : (
        <div className="tmc-single">
          <div className="tmc-single-top">
            <StatusButton api={api} size={30} />
            <nav className="tmc-tabstrip" aria-label="Teamchat">
              {VIEW_ITEMS.map((item) => {
                const badge = viewBadge(api, item.key);
                return (
                  <button key={item.key} type="button" className={view === item.key ? 'is-active' : ''} onClick={() => changeView(item.key)} aria-current={view === item.key ? 'page' : undefined} aria-label={item.label} title={item.label}>
                    <span className="tmc-tabstrip-icon">{item.icon(18)}{badge > 0 && <span className="tmc-badge is-alert">{badge > 99 ? '99+' : badge}</span>}</span>
                    <span className="tmc-tabstrip-label">{item.label}</span>
                  </button>
                );
              })}
            </nav>
            {variant === 'dock' && onExpand && (
              <button type="button" className="tmc-icon-btn" onClick={() => onExpand(activeId)} aria-label="Openen als volledige pagina" title="Openen als volledige pagina"><Maximize2 size={16} /></button>
            )}
            {variant === 'dock' && onClose && (
              <button type="button" className="tmc-icon-btn" onClick={onClose} aria-label="Teamchat sluiten" title="Sluiten"><X size={18} /></button>
            )}
          </div>
          <div className="tmc-single-body">{listPane ?? <FilesView api={api} onOpen={(c, m) => openConversation(c, m)} />}</div>
        </div>
      )}
      {dialogs}
    </div>
  );
}

function EmptyMain({ api, view, onNewChat, onNewChannel }: { api: TeamChatApi; view: ChatView; onNewChat: () => void; onNewChannel: () => void }) {
  const isTeams = view === 'teams';
  return (
    <div className="tmc-empty-main">
      <span className="tmc-start-art is-large" aria-hidden="true">{isTeams ? <Plus size={34} /> : <MessageSquare size={34} />}</span>
      <strong>{isTeams ? 'Werk samen in kanalen' : view === 'activity' ? 'Je activiteit' : view === 'saved' ? 'Opgeslagen berichten' : 'Welkom in de teamchat'}</strong>
      <span>
        {isTeams
          ? 'Een kanaal houdt elk onderwerp bij elkaar: posts met de antwoorden eronder, bestanden en vergaderingen.'
          : view === 'activity' || view === 'saved'
            ? 'Kies links een regel om het gesprek te openen.'
            : 'Chat 1-op-1 of met een groep collega’s, deel bestanden en start een vergadering.'}
      </span>
      {api.canWrite && (
        <div className="tmc-empty-actions">
          <button type="button" className="tmc-btn is-primary" onClick={onNewChat}><MessageSquarePlus size={16} /> Nieuwe chat</button>
          <button type="button" className="tmc-btn" onClick={onNewChannel}><Plus size={16} /> Kanaal maken</button>
        </div>
      )}
    </div>
  );
}

// ── Meldingen in de app ──────────────────────────────────────────────────────

/** Een nieuw bericht terwijl je elders in ResoFly bezig bent: een banner rechtsonder, zoals in Teams. */
export function TeamChatToasts({ api, onOpen }: { api: TeamChatApi; onOpen: (conversationId: string, messageId: string) => void }) {
  if (api.toasts.length === 0) return null;
  return (
    <div className="tmc tmc-toasts" role="region" aria-label="Nieuwe chatberichten">
      {api.toasts.map((t) => <ChatToastItem key={t.id} api={api} toast={t} onOpen={onOpen} />)}
    </div>
  );
}

function ChatToastItem({ api, toast, onOpen }: { api: TeamChatApi; toast: TeamChatApi['toasts'][number]; onOpen: (conversationId: string, messageId: string) => void }) {
  const { dismissToast } = api;
  useEffect(() => {
    const t = window.setTimeout(() => dismissToast(toast.id), toast.importance === 'urgent' ? 20000 : 7000);
    return () => window.clearTimeout(t);
  }, [toast.id, toast.importance, dismissToast]);
  return (
    <div className={`tmc-toast${toast.importance !== 'normal' ? ` is-${toast.importance}` : ''}`} role="status">
      <button type="button" className="tmc-toast-main" onClick={() => { dismissToast(toast.id); onOpen(toast.conversationId, toast.messageId); }}>
        <Avatar userId={toast.senderId} member={api.memberById.get(toast.senderId ?? '')} size={36} presence={api.presenceOf(toast.senderId)} />
        <span className="tmc-toast-text">
          <span className="tmc-toast-title">
            {toast.importance === 'urgent' && <span className="tmc-toast-flag"><Bell size={11} /> DRINGEND</span>}
            {toast.importance === 'important' && <span className="tmc-toast-flag"><AlertTriangle size={11} /> BELANGRIJK</span>}
            <strong>{toast.title}</strong>
          </span>
          <span className="tmc-toast-body">{toast.sender ? `${memberDisplay(api.memberById.get(toast.senderId ?? '')).first}: ` : ''}{toast.mentionsMe ? '@ ' : ''}{toast.snippet}</span>
        </span>
      </button>
      <button type="button" className="tmc-toast-close" onClick={() => dismissToast(toast.id)} aria-label="Melding sluiten"><X size={14} /></button>
    </div>
  );
}
