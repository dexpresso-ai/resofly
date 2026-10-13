import { createContext, useContext, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import {
  AlertTriangle, AtSign, Bell, Bookmark, BookmarkCheck, Check, CheckCheck, Copy, CornerUpLeft, Eye, Forward,
  MailOpen, MessageSquareReply, MoreHorizontal, Pencil, Phone, Pin, PinOff, SmilePlus, Trash2, Video,
} from 'lucide-react';
import { detectMeetingKind } from '../../lib/meeting';
import { safeHttpUrl } from '../../lib/safeUrl';
import type { Attachment, ChatMessage, ChatMessageReaction } from '../../types';
import { AttachmentGrid } from './attachments';
import { QUICK_REACTIONS } from './emoji';
import { EmojiPicker, MessageText } from './format';
import {
  formatClock, formatFull, memberDisplay, plainSnippet, systemText, ts, type ConversationVM,
} from './model';
import type { TeamChatApi } from './useTeamChat';
import { Avatar, isTouchOnly, Menu, Popover, type MenuItem } from './ui';

// ── Gedeelde context voor alle berichten in één gesprek ──────────────────────

export interface MessageActions {
  react: (msg: ChatMessage, emoji: string) => void;
  reply: (msg: ChatMessage) => void;
  edit: (msg: ChatMessage) => void;
  saveEdit: (msg: ChatMessage, body: string) => Promise<void>;
  cancelEdit: () => void;
  remove: (msg: ChatMessage) => void;
  undoRemove: (msg: ChatMessage) => void;
  pin: (msg: ChatMessage, pinned: boolean) => void;
  toggleSaved: (msg: ChatMessage) => void;
  forward: (msg: ChatMessage) => void;
  copy: (msg: ChatMessage) => void;
  markUnread: () => void;
  jumpTo: (messageId: string) => void;
  attachmentsChanged: (msg: ChatMessage) => void;
}

export interface MessageContextValue {
  api: TeamChatApi;
  vm: ConversationVM;
  names: string[];
  myName: string;
  reactionsByMessage: Map<string, ChatMessageReaction[]>;
  attachmentsByMessage: Map<string, Attachment[]>;
  messagesById: Map<string, ChatMessage>;
  editingId: string | null;
  /** In deze sessie ingetrokken berichten: de tekst, zodat "Ongedaan maken" kan. */
  undoable: Map<string, string>;
  highlightId: string | null;
  actions: MessageActions;
}

export const MessageContext = createContext<MessageContextValue | null>(null);

function useMessageContext(): MessageContextValue {
  const ctx = useContext(MessageContext);
  if (!ctx) throw new Error('MessageContext ontbreekt');
  return ctx;
}

// ── Kleine onderdelen ────────────────────────────────────────────────────────

function ImportanceLabel({ importance }: { importance: ChatMessage['importance'] }) {
  if (!importance || importance === 'normal') return null;
  return (
    <div className={`tmc-importance is-${importance}`}>
      {importance === 'urgent' ? <Bell size={13} /> : <AlertTriangle size={13} />}
      {importance === 'urgent' ? 'DRINGEND!' : 'BELANGRIJK!'}
    </div>
  );
}

function ForwardedLabel({ msg }: { msg: ChatMessage }) {
  const { api } = useMessageContext();
  const fwd = msg.meta?.forwarded;
  if (!fwd) return null;
  const from = fwd.sender_id ? memberDisplay(api.memberById.get(fwd.sender_id)).name : 'iemand';
  return (
    <div className="tmc-forwarded">
      <Forward size={13} /> Doorgestuurd · oorspronkelijk van {from}{fwd.conversation_title ? ` in ${fwd.conversation_title}` : ''}
    </div>
  );
}

function QuoteBlock({ msg }: { msg: ChatMessage }) {
  const { api, messagesById, actions } = useMessageContext();
  if (!msg.reply_to_id) return null;
  const quoted = messagesById.get(msg.reply_to_id);
  const name = quoted ? memberDisplay(api.memberById.get(quoted.sender_id ?? '')).name : 'Bericht';
  return (
    <button type="button" className="tmc-quote" onClick={() => actions.jumpTo(msg.reply_to_id!)} title="Naar het oorspronkelijke bericht">
      <span className="tmc-quote-head">{name}{quoted && <time>{formatClock(quoted.created_at)}</time>}</span>
      <span className="tmc-quote-body">{quoted ? plainSnippet(quoted, 160) : 'Dit bericht is niet meer beschikbaar.'}</span>
    </button>
  );
}

export function MeetingCard({ msg }: { msg: ChatMessage }) {
  const { api } = useMessageContext();
  const url = safeHttpUrl(msg.meta?.url);
  const audio = !!msg.meta?.audio_only;
  const provider = msg.meta?.provider === 'jitsi' ? 'Jitsi Meet' : detectMeetingKind(url).label;
  const starter = msg.sender_id === api.currentUserId ? 'jou' : memberDisplay(api.memberById.get(msg.sender_id ?? '')).name;
  return (
    <div className="tmc-meeting">
      <span className="tmc-meeting-icon" aria-hidden="true">{audio ? <Phone size={18} /> : <Video size={18} />}</span>
      <div className="tmc-meeting-text">
        <strong>{audio ? 'Gesprek gestart' : 'Vergadering gestart'}</strong>
        <span>door {starter} · {formatClock(msg.created_at)} · {provider}</span>
      </div>
      {url && !msg.deleted_at && (
        <a className="tmc-btn is-primary" href={url} target="_blank" rel="noopener noreferrer">Deelnemen</a>
      )}
    </div>
  );
}

export function SystemLine({ msg }: { msg: ChatMessage }) {
  const { api } = useMessageContext();
  return (
    <div className="tmc-system" id={`tmc-msg-${msg.id}`}>
      <span>{systemText(msg.meta?.event, msg.meta, msg.sender_id, api.currentUserId, api.memberById)}</span>
      <time title={formatFull(msg.created_at)}>{formatClock(msg.created_at)}</time>
    </div>
  );
}

function Reactions({ msg }: { msg: ChatMessage }) {
  const { api, reactionsByMessage, actions } = useMessageContext();
  const list = reactionsByMessage.get(msg.id) ?? [];
  const grouped = useMemo(() => {
    const map = new Map<string, { users: string[]; mine: boolean }>();
    for (const r of list) {
      const cur = map.get(r.emoji) ?? { users: [], mine: false };
      cur.users.push(r.user_id);
      if (r.user_id === api.currentUserId) cur.mine = true;
      map.set(r.emoji, cur);
    }
    return [...map.entries()];
  }, [list, api.currentUserId]);
  if (grouped.length === 0) return null;
  return (
    <div className="tmc-reactions">
      {grouped.map(([emoji, info]) => {
        const names = info.users.map((id) => (id === api.currentUserId ? 'Jij' : memberDisplay(api.memberById.get(id)).name));
        return (
          <button key={emoji} type="button" className={`tmc-reaction${info.mine ? ' is-mine' : ''}`} onClick={() => actions.react(msg, emoji)}
            title={`${names.join(', ')} ${names.length === 1 && names[0] !== 'Jij' ? 'reageerde' : 'reageerden'} met ${emoji}`} aria-pressed={info.mine}>
            <span>{emoji}</span><span className="tmc-reaction-n">{info.users.length}</span>
          </button>
        );
      })}
    </div>
  );
}

function InlineEditor({ msg }: { msg: ChatMessage }) {
  const { actions } = useMessageContext();
  const [value, setValue] = useState(msg.body);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [value]);
  async function save() {
    if (busy) return;
    setBusy(true);
    try { await actions.saveEdit(msg, value); } finally { setBusy(false); }
  }
  return (
    <div className="tmc-edit">
      <textarea ref={ref} value={value} onChange={(e) => setValue(e.target.value)} aria-label="Bericht bewerken"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void save(); }
          if (e.key === 'Escape') { e.preventDefault(); actions.cancelEdit(); }
        }} />
      <div className="tmc-edit-actions">
        <span className="tmc-edit-hint">Enter om op te slaan · Esc om te annuleren</span>
        <button type="button" className="tmc-btn" onClick={actions.cancelEdit}>Annuleren</button>
        <button type="button" className="tmc-btn is-primary" onClick={() => void save()} disabled={busy || !value.trim()}>Gereed</button>
      </div>
    </div>
  );
}

/** De zweefbalk boven een bericht: zes reacties, meer emoji en "Meer opties". */
function HoverActions({ msg, mine, threadRoot }: { msg: ChatMessage; mine: boolean; threadRoot?: boolean }) {
  const { api, actions } = useMessageContext();
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLButtonElement>(null);
  const saved = api.savedIds.has(msg.id);
  const pinned = !!msg.pinned_at;
  const isText = (msg.kind ?? 'text') === 'text';
  const canWrite = api.canWrite;

  const items: MenuItem[] = [];
  if (canWrite) items.push({ key: 'reply', label: threadRoot ? 'Beantwoorden in draadje' : 'Beantwoorden', icon: threadRoot ? <MessageSquareReply size={16} /> : <CornerUpLeft size={16} />, onSelect: () => actions.reply(msg) });
  if (mine && isText && canWrite) items.push({ key: 'edit', label: 'Bewerken', icon: <Pencil size={16} />, onSelect: () => actions.edit(msg) });
  if (canWrite) items.push({ key: 'pin', label: pinned ? 'Losmaken' : 'Vastmaken', icon: pinned ? <PinOff size={16} /> : <Pin size={16} />, onSelect: () => actions.pin(msg, !pinned) });
  items.push({ key: 'save', label: saved ? 'Niet meer opslaan' : 'Dit bericht opslaan', icon: saved ? <BookmarkCheck size={16} /> : <Bookmark size={16} />, onSelect: () => actions.toggleSaved(msg) });
  if (isText && canWrite) items.push({ key: 'forward', label: 'Doorsturen', icon: <Forward size={16} />, onSelect: () => actions.forward(msg) });
  if (isText && msg.body) items.push({ key: 'copy', label: 'Tekst kopiëren', icon: <Copy size={16} />, onSelect: () => actions.copy(msg) });
  if (!mine) items.push({ key: 'unread', label: 'Markeren als ongelezen', icon: <MailOpen size={16} />, onSelect: actions.markUnread });
  if (mine && canWrite) items.push({ key: 'delete', label: 'Verwijderen', icon: <Trash2 size={16} />, onSelect: () => actions.remove(msg), danger: true, divider: true });

  return (
    <div className={`tmc-hover${menuOpen || pickerOpen ? ' is-pinned-open' : ''}`} role="toolbar" aria-label="Reageren op dit bericht">
      {canWrite && QUICK_REACTIONS.map((r) => (
        <button key={r.emoji} type="button" className="tmc-hover-emoji" onClick={() => actions.react(msg, r.emoji)} title={r.label} aria-label={r.label}>{r.emoji}</button>
      ))}
      {canWrite && (
        <button type="button" ref={pickerRef} className="tmc-hover-btn" onClick={() => setPickerOpen((v) => !v)} title="Meer reacties" aria-label="Meer reacties" aria-expanded={pickerOpen}><SmilePlus size={16} /></button>
      )}
      {canWrite && <span className="tmc-hover-sep" aria-hidden="true" />}
      <button type="button" ref={moreRef} className="tmc-hover-btn" onClick={() => setMenuOpen((v) => !v)} title="Meer opties" aria-label="Meer opties" aria-expanded={menuOpen}><MoreHorizontal size={17} /></button>
      <Menu anchorRef={moreRef} open={menuOpen} onClose={() => setMenuOpen(false)} items={items} placement={mine ? 'below-end' : 'below-start'} />
      <Popover anchorRef={pickerRef} open={pickerOpen} onClose={() => setPickerOpen(false)} placement="below-end" className="tmc-emoji-pop" label="Reageren met een emoji">
        <EmojiPicker onPick={(emoji) => { setPickerOpen(false); actions.react(msg, emoji); }} />
      </Popover>
    </div>
  );
}

/** Op een telefoon is er geen hover: een tik op het bericht zet de balk open. */
function useTapToReveal() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (ev: Event) => {
      if (ref.current?.contains(ev.target as Node)) return;
      if ((ev.target as HTMLElement).closest?.('.tmc-popover')) return;
      setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);
  function onTap(e: MouseEvent<HTMLDivElement>) {
    if (!isTouchOnly()) return;
    if ((e.target as HTMLElement).closest('a,button,input,textarea,.tmc-hover')) return;
    setOpen((v) => !v);
  }
  return { open, ref, onTap };
}

function MessageBody({ msg, compact }: { msg: ChatMessage; compact?: boolean }) {
  const { api, names, myName, attachmentsByMessage, editingId, undoable, actions } = useMessageContext();
  const mine = msg.sender_id === api.currentUserId;
  if (editingId === msg.id) return <InlineEditor msg={msg} />;
  if (msg.deleted_at) {
    return (
      <div className="tmc-deleted">
        Dit bericht is verwijderd.
        {mine && undoable.has(msg.id) && <button type="button" className="tmc-link-btn" onClick={() => actions.undoRemove(msg)}>Ongedaan maken</button>}
      </div>
    );
  }
  const atts = attachmentsByMessage.get(msg.id) ?? [];
  return (
    <>
      <ForwardedLabel msg={msg} />
      <QuoteBlock msg={msg} />
      {(msg.kind ?? 'text') === 'meeting'
        ? <MeetingCard msg={msg} />
        : msg.body && <MessageText body={msg.body} names={names} myName={myName} compact={compact} />}
      {msg.attachment_count > 0 && (
        atts.length > 0
          ? <AttachmentGrid attachments={atts} canDelete={mine} onChanged={() => actions.attachmentsChanged(msg)} />
          : <div className="tmc-atts-loading">Bijlage laden…</div>
      )}
    </>
  );
}

// ── Chat: de bubbels van een 1-op-1- of groepschat ───────────────────────────

export function ChatMessageRow({ msg, continued, receipt }: {
  msg: ChatMessage;
  continued: boolean;
  /** Alleen voor je eigen berichten: verzonden of gezien (door wie). */
  receipt?: { state: 'sent' | 'seen'; label: string; showAlways: boolean } | null;
}) {
  const { api, highlightId } = useMessageContext();
  const mine = msg.sender_id === api.currentUserId;
  const sender = api.memberById.get(msg.sender_id ?? '');
  const mentionsMe = !mine && !!api.currentUserId && (msg.mentions ?? []).includes(api.currentUserId);
  const importance = msg.importance ?? 'normal';
  const tap = useTapToReveal();
  const pinned = !!msg.pinned_at && !msg.deleted_at;

  return (
    <div
      id={`tmc-msg-${msg.id}`}
      ref={tap.ref}
      onClick={tap.onTap}
      className={`tmc-msg${mine ? ' is-mine' : ''}${continued ? ' is-cont' : ''}${mentionsMe ? ' is-mention-me' : ''}${highlightId === msg.id ? ' is-highlight' : ''}${tap.open ? ' is-open' : ''}`}
    >
      <div className="tmc-msg-gutter">
        {!mine && !continued && <Avatar userId={msg.sender_id} member={sender} size={32} presence={api.presenceOf(msg.sender_id)} />}
        {continued && <time className="tmc-msg-gutter-time" title={formatFull(msg.created_at)}>{formatClock(msg.created_at)}</time>}
      </div>
      <div className="tmc-msg-main">
        <div className={`tmc-bubble${importance !== 'normal' ? ` is-${importance}` : ''}${msg.deleted_at ? ' is-deleted' : ''}`}>
          {!continued && (
            <div className="tmc-msg-head">
              {!mine && <span className="tmc-msg-author">{memberDisplay(sender).name}</span>}
              <time title={formatFull(msg.created_at)}>{formatClock(msg.created_at)}</time>
              {msg.edited_at && !msg.deleted_at && <span className="tmc-msg-edited">Bewerkt</span>}
              {pinned && <span className="tmc-msg-pin" title="Vastgemaakt"><Pin size={12} /></span>}
            </div>
          )}
          {continued && (msg.edited_at || pinned) && !msg.deleted_at && (
            <div className="tmc-msg-head is-mini">
              {msg.edited_at && <span className="tmc-msg-edited">Bewerkt</span>}
              {pinned && <span className="tmc-msg-pin" title="Vastgemaakt"><Pin size={12} /></span>}
            </div>
          )}
          <ImportanceLabel importance={importance} />
          <MessageBody msg={msg} />
          {mentionsMe && <span className="tmc-mention-flag" title="Je wordt genoemd"><AtSign size={12} /></span>}
          {!msg.deleted_at && <HoverActions msg={msg} mine={mine} />}
        </div>
        <Reactions msg={msg} />
      </div>
      {mine && (
        <div className={`tmc-receipt${receipt?.showAlways ? ' is-visible' : ''}`} title={receipt?.label}>
          {receipt?.state === 'seen' ? <Eye size={13} aria-label={receipt.label} /> : <Check size={13} aria-label={receipt?.label ?? 'Verzonden'} />}
        </div>
      )}
    </div>
  );
}

// ── Kanaal: een post met zijn draadje ────────────────────────────────────────

export function PostCard({ root, replies, expanded, onToggleExpanded, replyOpen, onOpenReply, replyComposer }: {
  root: ChatMessage;
  replies: ChatMessage[];
  expanded: boolean;
  onToggleExpanded: () => void;
  replyOpen: boolean;
  onOpenReply: () => void;
  replyComposer: ReactNode;
}) {
  const { api, highlightId } = useMessageContext();
  const hiddenCount = expanded ? 0 : Math.max(0, replies.length - 2);
  const visible = expanded ? replies : replies.slice(-2);
  const hiddenNames = useMemo(() => {
    const ids = [...new Set(replies.slice(0, hiddenCount).map((r) => r.sender_id).filter(Boolean) as string[])];
    const names = ids.map((id) => (id === api.currentUserId ? 'jou' : memberDisplay(api.memberById.get(id)).first));
    if (names.length <= 2) return names.join(' en ');
    return `${names.slice(0, 2).join(', ')} en ${names.length - 2} anderen`;
  }, [replies, hiddenCount, api.currentUserId, api.memberById]);

  if ((root.kind ?? 'text') === 'system') return <SystemLine msg={root} />;

  return (
    <article className={`tmc-post${highlightId === root.id ? ' is-highlight' : ''}`} aria-label={root.subject ?? 'Post'}>
      <PostEntry msg={root} isRoot />
      {replies.length > 0 && (
        <div className="tmc-post-replies">
          {hiddenCount > 0 && (
            <button type="button" className="tmc-post-more" onClick={onToggleExpanded}>
              <CheckCheck size={14} /> {hiddenCount} {hiddenCount === 1 ? 'antwoord' : 'antwoorden'} van {hiddenNames}
            </button>
          )}
          {expanded && replies.length > 2 && (
            <button type="button" className="tmc-post-more" onClick={onToggleExpanded}>Minder weergeven</button>
          )}
          {visible.map((r) => <PostEntry key={r.id} msg={r} />)}
        </div>
      )}
      <div className="tmc-post-foot">
        {replyOpen ? replyComposer : api.canWrite && (
          <button type="button" className="tmc-post-reply" onClick={onOpenReply}><CornerUpLeft size={15} /> Beantwoorden</button>
        )}
      </div>
    </article>
  );
}

function PostEntry({ msg, isRoot }: { msg: ChatMessage; isRoot?: boolean }) {
  const { api, highlightId } = useMessageContext();
  const mine = msg.sender_id === api.currentUserId;
  const sender = api.memberById.get(msg.sender_id ?? '');
  const mentionsMe = !mine && !!api.currentUserId && (msg.mentions ?? []).includes(api.currentUserId);
  const importance = msg.importance ?? 'normal';
  const tap = useTapToReveal();
  if ((msg.kind ?? 'text') === 'system') return <SystemLine msg={msg} />;
  return (
    <div
      id={`tmc-msg-${msg.id}`}
      ref={tap.ref}
      onClick={tap.onTap}
      className={`tmc-entry${isRoot ? ' is-root' : ' is-reply'}${mentionsMe ? ' is-mention-me' : ''}${importance !== 'normal' ? ` is-${importance}` : ''}${!isRoot && highlightId === msg.id ? ' is-highlight' : ''}${tap.open ? ' is-open' : ''}`}
    >
      <Avatar userId={msg.sender_id} member={sender} size={isRoot ? 32 : 26} presence={isRoot ? api.presenceOf(msg.sender_id) : undefined} />
      <div className="tmc-entry-main">
        <div className="tmc-entry-head">
          <span className="tmc-msg-author">{memberDisplay(sender).name}</span>
          <time title={formatFull(msg.created_at)}>{formatClock(msg.created_at)}</time>
          {msg.edited_at && !msg.deleted_at && <span className="tmc-msg-edited">Bewerkt</span>}
          {msg.pinned_at && !msg.deleted_at && <span className="tmc-msg-pin" title="Vastgemaakt"><Pin size={12} /></span>}
          {mentionsMe && <span className="tmc-mention-flag is-inline" title="Je wordt genoemd"><AtSign size={12} /></span>}
        </div>
        <ImportanceLabel importance={importance} />
        {isRoot && msg.subject && !msg.deleted_at && <h4 className="tmc-post-subject">{msg.subject}</h4>}
        <MessageBody msg={msg} compact={!isRoot} />
        <Reactions msg={msg} />
      </div>
      {!msg.deleted_at && <HoverActions msg={msg} mine={mine} threadRoot={isRoot} />}
    </div>
  );
}

/** Leesbevestiging voor je eigen bericht, zoals Teams: verzonden of gezien. */
export function receiptFor(
  msg: ChatMessage,
  others: { user_id: string; last_read_at: string }[],
  nameOf: (id: string) => string,
): { state: 'sent' | 'seen'; label: string } {
  const seen = others.filter((p) => ts(p.last_read_at) >= ts(msg.created_at));
  if (others.length > 0 && seen.length === others.length) {
    return { state: 'seen', label: others.length === 1 ? 'Gezien' : `Gezien door iedereen (${others.length})` };
  }
  if (seen.length > 0) return { state: 'sent', label: `Gezien door ${seen.map((p) => nameOf(p.user_id)).join(', ')}` };
  return { state: 'sent', label: 'Verzonden' };
}
