import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Globe, Link2, Lock, Phone, Search, Video, X } from 'lucide-react';
import {
  addParticipants, createChannel, createGroup, joinChannel, loadPublicChannels, sendMessage, updateConversation,
} from '../../lib/chat';
import { detectMeetingKind, isValidMeetingUrl, jitsiMeetingUrl, usesPublicJitsi } from '../../lib/meeting';
import type { ChatMessage, ChatPublicChannel } from '../../types';
import {
  formatListTime, memberDisplay, plainSnippet, PRESENCE_LABEL, type ConversationVM,
} from './model';
import type { TeamChatApi } from './useTeamChat';
import { Avatar, ChannelAvatar, GroupAvatar, Modal } from './ui';

// ── "Aan:"-veld: collega's kiezen met chips en een zoeklijst ─────────────────

export function PeopleField({ api, selected, onChange, exclude = [], placeholder = 'Typ een naam', autoFocus, label = 'Aan:' }: {
  api: TeamChatApi;
  selected: string[];
  onChange: (ids: string[]) => void;
  exclude?: string[];
  placeholder?: string;
  autoFocus?: boolean;
  label?: string;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const me = api.currentUserId;
  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    return api.teamMembers
      .filter((m) => m.user_id !== me && !selected.includes(m.user_id) && !exclude.includes(m.user_id))
      .map((m) => ({ member: m, d: memberDisplay(m) }))
      .filter(({ d }) => !q || d.name.toLowerCase().includes(q) || d.email.toLowerCase().includes(q))
      .sort((a, b) => a.d.name.localeCompare(b.d.name, 'nl'))
      .slice(0, 8);
  }, [api.teamMembers, me, selected, exclude, query]);

  function pick(id: string) {
    onChange([...selected, id]);
    setQuery('');
    setIndex(0);
    inputRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setIndex((i) => Math.min(i + 1, options.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && open && options[index]) { e.preventDefault(); pick(options[index].member.user_id); }
    else if (e.key === 'Backspace' && !query && selected.length) { onChange(selected.slice(0, -1)); }
    else if (e.key === 'Escape') { setOpen(false); }
  }

  return (
    <div className="tmc-people" onClick={() => inputRef.current?.focus()}>
      <span className="tmc-people-label">{label}</span>
      <div className="tmc-people-field">
        {selected.map((id) => {
          const d = memberDisplay(api.memberById.get(id));
          return (
            <span key={id} className="tmc-chip">
              <Avatar userId={id} member={api.memberById.get(id)} size={20} />
              {d.name}
              <button type="button" onClick={(e) => { e.stopPropagation(); onChange(selected.filter((x) => x !== id)); }} aria-label={`${d.name} weghalen`}><X size={12} /></button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); setIndex(0); }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
          placeholder={selected.length ? '' : placeholder}
          aria-label={placeholder}
          role="combobox"
          aria-expanded={open && options.length > 0}
          aria-autocomplete="list"
        />
      </div>
      {open && options.length > 0 && (
        <div className="tmc-people-pop" role="listbox">
          {options.map(({ member, d }, i) => (
            <button key={member.user_id} type="button" role="option" aria-selected={i === index} className={i === index ? 'is-active' : ''}
              onMouseDown={(e) => { e.preventDefault(); pick(member.user_id); }} onMouseEnter={() => setIndex(i)}>
              <Avatar userId={member.user_id} member={member} size={30} presence={api.presenceOf(member.user_id)} />
              <span className="tmc-people-opt"><strong>{d.name}</strong><small>{d.email} · {PRESENCE_LABEL[api.presenceOf(member.user_id)]}</small></span>
            </button>
          ))}
        </div>
      )}
      {open && options.length === 0 && query.trim() && <div className="tmc-people-pop is-empty">Geen collega gevonden met “{query.trim()}”.</div>}
    </div>
  );
}

/** Een lijst om collega's aan te vinken (nieuw kanaal). */
function PeopleChecklist({ api, selected, onToggle, exclude = [] }: { api: TeamChatApi; selected: Set<string>; onToggle: (id: string) => void; exclude?: string[] }) {
  const [query, setQuery] = useState('');
  const others = api.teamMembers
    .filter((m) => m.user_id !== api.currentUserId && !exclude.includes(m.user_id))
    .map((m) => ({ m, d: memberDisplay(m) }))
    .filter(({ d }) => !query.trim() || d.name.toLowerCase().includes(query.trim().toLowerCase()) || d.email.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => a.d.name.localeCompare(b.d.name, 'nl'));
  return (
    <div className="tmc-checklist">
      <label className="tmc-search is-inline"><Search size={14} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Zoek een collega" aria-label="Zoek een collega" /></label>
      <div className="tmc-checklist-items">
        {others.length === 0 && <div className="tmc-empty-hint">Geen collega’s gevonden.</div>}
        {others.map(({ m, d }) => {
          const on = selected.has(m.user_id);
          return (
            <button key={m.user_id} type="button" className={`tmc-check-row${on ? ' is-on' : ''}`} onClick={() => onToggle(m.user_id)} aria-pressed={on}>
              <Avatar userId={m.user_id} member={m} size={30} presence={api.presenceOf(m.user_id)} />
              <span className="tmc-people-opt"><strong>{d.name}</strong><small>{d.email}</small></span>
              <span className="tmc-checkbox" aria-hidden="true">{on && <Check size={13} />}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Nieuw kanaal ─────────────────────────────────────────────────────────────

export function NewChannelDialog({ api, onClose, onCreated }: { api: TeamChatApi; onClose: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [members, setMembers] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (!api.organizationId || busy) return;
    if (!title.trim()) { setError('Geef het kanaal een naam.'); return; }
    setBusy(true); setError(null);
    try {
      const id = await createChannel(api.organizationId, { title: title.trim(), description, memberIds: [...members], visibility });
      await api.reloadConversations();
      onCreated(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kanaal maken mislukt');
      setBusy(false);
    }
  }

  return (
    <Modal title={`Een kanaal maken in ${api.organizationName}`} onClose={onClose} width={520} labelledBy="tmc-new-channel"
      footer={<>
        <button type="button" className="tmc-btn" onClick={onClose}>Annuleren</button>
        <button type="button" className="tmc-btn is-primary" onClick={() => void create()} disabled={busy || !title.trim()}>{busy ? 'Bezig…' : 'Maken'}</button>
      </>}>
      <label className="tmc-field">
        <span>Kanaalnaam</span>
        <input value={title} onChange={(e) => setTitle(e.target.value.slice(0, 120))} placeholder="Bijvoorbeeld: Algemeen, Marketing, Project Korenaar" autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void create(); } }} />
      </label>
      <label className="tmc-field">
        <span>Beschrijving <small>(optioneel)</small></span>
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value.slice(0, 500))} placeholder="Waar gaat dit kanaal over?" />
      </label>
      <fieldset className="tmc-field tmc-radios">
        <legend>Wie kan het vinden?</legend>
        <label className={`tmc-radio${visibility === 'public' ? ' is-on' : ''}`}>
          <input type="radio" name="tmc-visibility" checked={visibility === 'public'} onChange={() => setVisibility('public')} />
          <Globe size={18} />
          <span><strong>Standaard</strong><small>Iedereen in {api.organizationName} kan het kanaal vinden en deelnemen.</small></span>
        </label>
        <label className={`tmc-radio${visibility === 'private' ? ' is-on' : ''}`}>
          <input type="radio" name="tmc-visibility" checked={visibility === 'private'} onChange={() => setVisibility('private')} />
          <Lock size={18} />
          <span><strong>Privé</strong><small>Alleen de mensen die je toevoegt.</small></span>
        </label>
      </fieldset>
      <div className="tmc-field">
        <span>Leden toevoegen {visibility === 'public' && <small>(optioneel)</small>}</span>
        <PeopleChecklist api={api} selected={members} onToggle={(id) => setMembers((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; })} />
      </div>
      {error && <div className="tmc-inline-error">{error}</div>}
    </Modal>
  );
}

// ── Kanalen ontdekken ────────────────────────────────────────────────────────

export function DiscoverChannelsDialog({ api, onClose, onJoined }: { api: TeamChatApi; onClose: () => void; onJoined: (id: string) => void }) {
  const [channels, setChannels] = useState<ChatPublicChannel[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!api.organizationId) return;
    let alive = true;
    loadPublicChannels(api.organizationId).then((rows) => { if (alive) setChannels(rows); });
    return () => { alive = false; };
  }, [api.organizationId]);

  async function join(id: string) {
    setBusy(id); setError(null);
    try {
      await joinChannel(id);
      await api.reloadConversations();
      onJoined(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Deelnemen mislukt');
      setBusy(null);
    }
  }

  return (
    <Modal title="Kanalen ontdekken" onClose={onClose} width={540} labelledBy="tmc-discover">
      <p className="tmc-modal-intro">Openbare kanalen in {api.organizationName} waar je nog niet in zit.</p>
      {channels === null && <div className="tmc-empty-hint">Laden…</div>}
      {channels?.length === 0 && <div className="tmc-empty-hint">Je zit al in alle openbare kanalen. Maak er zelf een met “Kanaal maken”.</div>}
      <div className="tmc-discover">
        {channels?.map((c) => (
          <div key={c.id} className="tmc-discover-row">
            <ChannelAvatar title={c.title ?? 'Kanaal'} size={36} />
            <div className="tmc-discover-text">
              <strong>{c.title}</strong>
              <small>{c.member_count} {c.member_count === 1 ? 'lid' : 'leden'}{c.last_message_at ? ` · laatste bericht ${formatListTime(c.last_message_at)}` : ''}</small>
              {c.description && <span>{c.description}</span>}
            </div>
            <button type="button" className="tmc-btn is-primary" onClick={() => void join(c.id)} disabled={busy === c.id}>{busy === c.id ? 'Bezig…' : 'Deelnemen'}</button>
          </div>
        ))}
      </div>
      {error && <div className="tmc-inline-error">{error}</div>}
    </Modal>
  );
}

// ── Hernoemen ────────────────────────────────────────────────────────────────

export function RenameDialog({ api, vm, onClose }: { api: TeamChatApi; vm: ConversationVM; onClose: () => void }) {
  const isChannel = vm.kind === 'channel';
  const [title, setTitle] = useState(vm.named ? vm.title : '');
  const [description, setDescription] = useState(vm.conversation.description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    if (busy) return;
    if (isChannel && !title.trim()) { setError('Een kanaal heeft een naam nodig.'); return; }
    setBusy(true); setError(null);
    try {
      await updateConversation(vm.id, title.trim() || null, isChannel ? description.trim() || null : null);
      await api.reloadConversations();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Opslaan mislukt');
      setBusy(false);
    }
  }
  return (
    <Modal title={isChannel ? 'Kanaal bewerken' : 'Groepschat een naam geven'} onClose={onClose} labelledBy="tmc-rename"
      footer={<>
        <button type="button" className="tmc-btn" onClick={onClose}>Annuleren</button>
        <button type="button" className="tmc-btn is-primary" onClick={() => void save()} disabled={busy}>{busy ? 'Bezig…' : 'Opslaan'}</button>
      </>}>
      <label className="tmc-field">
        <span>{isChannel ? 'Kanaalnaam' : 'Naam van de groepschat'}</span>
        <input value={title} onChange={(e) => setTitle(e.target.value.slice(0, 120))} autoFocus placeholder={isChannel ? 'Kanaalnaam' : vm.title}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save(); } }} />
      </label>
      {!isChannel && <p className="tmc-modal-intro">Leeg laten: dan staan de namen van de deelnemers erboven.</p>}
      {isChannel && (
        <label className="tmc-field">
          <span>Beschrijving</span>
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value.slice(0, 500))} />
        </label>
      )}
      {error && <div className="tmc-inline-error">{error}</div>}
    </Modal>
  );
}

// ── Vergaderen en bellen ─────────────────────────────────────────────────────

export function MeetingDialog({ api, vm, audio, onClose }: { api: TeamChatApi; vm: ConversationVM; audio: boolean; onClose: () => void }) {
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalized = /^www\./i.test(link.trim()) ? `https://${link.trim()}` : link.trim();
  const linkOk = isValidMeetingUrl(normalized) && normalized.toLowerCase().startsWith('https://');

  async function post(url: string, provider: string) {
    if (!api.organizationId) return;
    await sendMessage(api.organizationId, vm.id, {
      body: audio ? 'Gesprek' : 'Vergadering',
      kind: 'meeting',
      meta: { url, provider, audio_only: audio },
    });
  }

  async function startJitsi() {
    if (busy) return;
    // Op de Jitsi-server van de organisatie (Instellingen → Agenda), anders meet.jit.si.
    const url = `${jitsiMeetingUrl(api.jitsiBaseUrl)}${audio ? '#config.startWithVideoMuted=true&config.startAudioOnly=true' : ''}`;
    // Eerst het venster openen: na een await ziet de browser het niet meer als
    // een klik van jou en houdt hij het pop-upvenster tegen.
    window.open(url, '_blank', 'noopener,noreferrer');
    setBusy(true); setError(null);
    try { await post(url, 'jitsi'); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Delen mislukt'); setBusy(false); }
  }

  async function shareLink() {
    if (!linkOk || busy) return;
    setBusy(true); setError(null);
    try { await post(normalized, detectMeetingKind(normalized, api.jitsiBaseUrl).kind); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Delen mislukt'); setBusy(false); }
  }

  const where = vm.kind === 'dm' ? vm.title : vm.kind === 'channel' ? `#${vm.title}` : vm.title;
  return (
    <Modal title={audio ? `Bellen met ${where}` : `Vergaderen met ${where}`} onClose={onClose} width={460} labelledBy="tmc-meet">
      <button type="button" className="tmc-meet-start" onClick={() => void startJitsi()} disabled={busy || !api.canWrite}>
        <span className="tmc-meet-start-icon">{audio ? <Phone size={22} /> : <Video size={22} />}</span>
        <span>
          <strong>{audio ? 'Nu bellen' : 'Nu vergaderen'}</strong>
          <small>Start een {audio ? 'gesprek (alleen geluid)' : 'videovergadering'} in Jitsi Meet en deel de link hier. Je collega’s hebben geen account nodig.</small>
        </span>
      </button>
      <div className="tmc-or"><span>of deel een bestaande link</span></div>
      <form className="tmc-meet-link" onSubmit={(e) => { e.preventDefault(); void shareLink(); }}>
        <Link2 size={16} aria-hidden="true" />
        <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://teams.microsoft.com/… of meet.google.com/…" aria-label="Vergaderlink" />
        <button type="submit" className="tmc-btn is-primary" disabled={!linkOk || busy}>Delen</button>
      </form>
      {link.trim() && !linkOk && <div className="tmc-field-hint">Plak een volledige https-link.</div>}
      {linkOk && <div className="tmc-field-hint">Herkend als {detectMeetingKind(normalized, api.jitsiBaseUrl).label}.</div>}
      {usesPublicJitsi(api.jitsiBaseUrl) && <p className="tmc-modal-foot-note">Bij Jitsi Meet logt degene die de vergadering opent één keer kort in (bijvoorbeeld met Google of GitHub); de anderen doen direct mee.</p>}
      {error && <div className="tmc-inline-error">{error}</div>}
    </Modal>
  );
}

// ── Doorsturen ───────────────────────────────────────────────────────────────

export function ForwardDialog({ api, message, sourceTitle, onClose, onForwarded }: {
  api: TeamChatApi;
  message: ChatMessage;
  sourceTitle: string;
  onClose: () => void;
  onForwarded: (title: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = api.vms
    .filter((vm) => !query.trim() || vm.title.toLowerCase().includes(query.trim().toLowerCase()))
    .slice(0, 40);
  const targetVm = api.vms.find((v) => v.id === target) ?? null;

  async function forward() {
    if (!api.organizationId || !targetVm || busy) return;
    setBusy(true); setError(null);
    try {
      await sendMessage(api.organizationId, targetVm.id, {
        body: message.body,
        meta: { forwarded: { sender_id: message.sender_id, conversation_title: sourceTitle, created_at: message.created_at } },
      });
      if (note.trim()) await sendMessage(api.organizationId, targetVm.id, { body: note.trim() });
      onForwarded(targetVm.title);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Doorsturen mislukt');
      setBusy(false);
    }
  }

  return (
    <Modal title="Bericht doorsturen" onClose={onClose} width={520} labelledBy="tmc-forward"
      footer={<>
        <button type="button" className="tmc-btn" onClick={onClose}>Annuleren</button>
        <button type="button" className="tmc-btn is-primary" onClick={() => void forward()} disabled={!targetVm || busy}>{busy ? 'Bezig…' : 'Doorsturen'}</button>
      </>}>
      <div className="tmc-forward-preview">
        <strong>{memberDisplay(api.memberById.get(message.sender_id ?? '')).name}</strong>
        <span>{plainSnippet(message, 220)}</span>
        {message.attachment_count > 0 && <small>Bijlagen gaan niet mee; die blijven in het oorspronkelijke gesprek.</small>}
      </div>
      <label className="tmc-search is-inline"><Search size={14} /><input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Zoek een chat of kanaal" aria-label="Zoek een chat of kanaal" /></label>
      <div className="tmc-forward-list" role="listbox" aria-label="Doorsturen naar">
        {list.map((vm) => (
          <button key={vm.id} type="button" role="option" aria-selected={target === vm.id} className={`tmc-check-row${target === vm.id ? ' is-on' : ''}`} onClick={() => setTarget(vm.id)}>
            <ConversationAvatar api={api} vm={vm} size={30} />
            <span className="tmc-people-opt"><strong>{vm.kind === 'channel' ? `# ${vm.title}` : vm.title}</strong><small>{vm.kind === 'dm' ? 'Chat' : vm.kind === 'group' ? 'Groepschat' : 'Kanaal'}</small></span>
            <span className="tmc-radio-dot" aria-hidden="true" />
          </button>
        ))}
      </div>
      <label className="tmc-field">
        <span>Een bericht toevoegen <small>(optioneel)</small></span>
        <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Typ een bericht" />
      </label>
      {error && <div className="tmc-inline-error">{error}</div>}
    </Modal>
  );
}

// ── Personen toevoegen ───────────────────────────────────────────────────────

/**
 * In een groepschat of kanaal: leden toevoegen. In een 1-op-1-chat maakt Teams
 * een nieuwe groepschat met jullie tweeën plus wie je toevoegt — hier ook.
 */
export function AddPeopleDialog({ api, vm, onClose, onOpenConversation }: {
  api: TeamChatApi;
  vm: ConversationVM;
  onClose: () => void;
  onOpenConversation: (id: string) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [groupName, setGroupName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isDm = vm.kind === 'dm';

  async function add() {
    if (!api.organizationId || selected.length === 0 || busy) return;
    setBusy(true); setError(null);
    try {
      if (isDm) {
        const ids = [...new Set([vm.counterpartId, ...selected].filter(Boolean) as string[])];
        const id = await createGroup(api.organizationId, ids, groupName);
        await api.reloadConversations();
        onOpenConversation(id);
      } else {
        await addParticipants(vm.id, selected);
        await api.reloadConversations();
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Toevoegen mislukt');
      setBusy(false);
    }
  }

  return (
    <Modal title={isDm ? 'Personen toevoegen' : `Personen toevoegen aan ${vm.kind === 'channel' ? `#${vm.title}` : vm.title}`} onClose={onClose} width={520} labelledBy="tmc-add-people"
      footer={<>
        <button type="button" className="tmc-btn" onClick={onClose}>Annuleren</button>
        <button type="button" className="tmc-btn is-primary" onClick={() => void add()} disabled={busy || selected.length === 0}>{busy ? 'Bezig…' : 'Toevoegen'}</button>
      </>}>
      {isDm && <p className="tmc-modal-intro">Er komt een nieuwe groepschat met {vm.title}, jou en wie je hier kiest. Deze chat blijft zoals hij is.</p>}
      <PeopleField api={api} selected={selected} onChange={setSelected} exclude={vm.memberIds} autoFocus label="Toevoegen:" placeholder="Typ een naam" />
      {isDm && selected.length > 0 && (
        <label className="tmc-field">
          <span>Naam van de groepschat <small>(optioneel)</small></span>
          <input value={groupName} onChange={(e) => setGroupName(e.target.value.slice(0, 120))} placeholder="Bijvoorbeeld: Lancering Korenaar" />
        </label>
      )}
      {error && <div className="tmc-inline-error">{error}</div>}
    </Modal>
  );
}

// ── Statusbericht ────────────────────────────────────────────────────────────

const CLEAR_AFTER: { key: string; label: string; at: () => string | null }[] = [
  { key: 'never', label: 'Nooit', at: () => null },
  { key: '1h', label: '1 uur', at: () => new Date(Date.now() + 3600000).toISOString() },
  { key: '4h', label: '4 uur', at: () => new Date(Date.now() + 4 * 3600000).toISOString() },
  { key: 'today', label: 'Vandaag', at: () => { const d = new Date(); d.setHours(23, 59, 59, 0); return d.toISOString(); } },
  { key: 'week', label: 'Deze week', at: () => { const d = new Date(); const add = (7 - d.getDay()) % 7; d.setDate(d.getDate() + add); d.setHours(23, 59, 59, 0); return d.toISOString(); } },
];

export function StatusMessageDialog({ api, onClose }: { api: TeamChatApi; onClose: () => void }) {
  const current = api.myStatus;
  const [message, setMessage] = useState(current?.status_message ?? '');
  const [clearAfter, setClearAfter] = useState('today');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(clear = false) {
    setBusy(true); setError(null);
    try {
      if (clear) await api.setMyStatusMessage(null, null);
      else await api.setMyStatusMessage(message, CLEAR_AFTER.find((c) => c.key === clearAfter)?.at() ?? null);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Opslaan mislukt');
      setBusy(false);
    }
  }
  return (
    <Modal title="Statusbericht instellen" onClose={onClose} width={440} labelledBy="tmc-status"
      footer={<>
        {current?.status_message && <button type="button" className="tmc-btn is-ghost" onClick={() => void save(true)} disabled={busy}>Wissen</button>}
        <span className="tmc-spacer" />
        <button type="button" className="tmc-btn" onClick={onClose}>Annuleren</button>
        <button type="button" className="tmc-btn is-primary" onClick={() => void save()} disabled={busy || !message.trim()}>Gereed</button>
      </>}>
      <label className="tmc-field">
        <span>Wat wil je collega’s laten weten?</span>
        <textarea rows={3} autoFocus value={message} onChange={(e) => setMessage(e.target.value.slice(0, 280))} placeholder="Bijvoorbeeld: Vandaag op locatie, na 15:00 bereikbaar" />
        <small className="tmc-counter">{message.length}/280</small>
      </label>
      <label className="tmc-field">
        <span>Statusbericht wissen na</span>
        <select value={clearAfter} onChange={(e) => setClearAfter(e.target.value)}>
          {CLEAR_AFTER.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
      </label>
      {error && <div className="tmc-inline-error">{error}</div>}
    </Modal>
  );
}

// ── Avatar van een gesprek (lijst, doorsturen, kop) ──────────────────────────

export function ConversationAvatar({ api, vm, size = 32 }: { api: TeamChatApi; vm: ConversationVM; size?: number }) {
  if (vm.kind === 'dm') {
    return <Avatar userId={vm.counterpartId} member={api.memberById.get(vm.counterpartId ?? '')} size={size} presence={api.presenceOf(vm.counterpartId)} />;
  }
  if (vm.kind === 'channel') return <ChannelAvatar title={vm.title} size={size} isPrivate={vm.isPrivate} />;
  return <GroupAvatar ids={vm.memberIds.filter((id) => id !== api.currentUserId)} memberById={api.memberById} size={size} />;
}

