import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
  type ChangeEvent, type ClipboardEvent, type KeyboardEvent,
} from 'react';
import {
  AlertTriangle, Bell, Bold, Code, Italic, Link2, List, ListOrdered, Paperclip, PenLine, Quote,
  Send, Smile, Strikethrough, X,
} from 'lucide-react';
import { toggleLinePrefix, toggleWrap } from '../../lib/chatFormat';
import { MAX_UPLOAD_BYTES } from '../../lib/r2';
import type { ChatImportance, ChatMessage, OrganizationMember } from '../../types';
import { EmojiPicker } from './format';
import { memberDisplay, mentionIdsIn, plainSnippet } from './model';
import type { TeamChatApi } from './useTeamChat';
import { Avatar, Popover } from './ui';

export interface ComposerSubmit {
  body: string;
  mentions: string[];
  files: File[];
  importance: ChatImportance;
  subject: string | null;
}

export interface ComposerHandle {
  focus: () => void;
  addFiles: (files: File[]) => void;
}

export interface ComposerProps {
  api: TeamChatApi;
  /** Sleutel voor het concept (gesprek, of gesprek + draadje). */
  draftKey: string;
  /** Wie je kunt noemen. */
  memberIds: string[];
  /** 'chat' = 1-op-1/groep · 'post' = nieuwe post in een kanaal · 'reply' = antwoord in een draadje · 'new' = nieuwe chat. */
  mode: 'chat' | 'post' | 'reply' | 'new';
  placeholder: string;
  replyTo?: ChatMessage | null;
  onCancelReply?: () => void;
  onSubmit: (input: ComposerSubmit) => Promise<boolean>;
  onTyping?: () => void;
  /** Pijltje omhoog in een leeg veld: je laatste bericht bewerken. */
  onEditLast?: () => void;
  /** Sluiten (antwoord in een draadje, nieuwe post). */
  onCancel?: () => void;
  autoFocus?: boolean;
  /** "@iedereen" aanbieden (groepschat of kanaal). */
  allowEveryone?: boolean;
}

interface MentionState { query: string; start: number; end: number }

const EVERYONE = 'iedereen';

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, ref) {
  const {
    api, draftKey, memberIds, mode, placeholder, replyTo, onCancelReply, onSubmit, onTyping, onEditLast,
    onCancel, autoFocus, allowEveryone,
  } = props;
  const [draft, setDraftState] = useState(() => api.getDraft(draftKey));
  const [files, setFiles] = useState<File[]>([]);
  const [importance, setImportance] = useState<ChatImportance>('normal');
  const [subject, setSubject] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [importanceOpen, setImportanceOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const emojiBtn = useRef<HTMLButtonElement>(null);
  const importanceBtn = useRef<HTMLButtonElement>(null);
  const linkBtn = useRef<HTMLButtonElement>(null);
  const selectionRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });

  // Een ander gesprek: het concept van dát gesprek.
  const keyRef = useRef(draftKey);
  useEffect(() => {
    if (keyRef.current === draftKey) return;
    keyRef.current = draftKey;
    setDraftState(api.getDraft(draftKey));
    setFiles([]); setImportance('normal'); setSubject(''); setMention(null); setNotice(null);
  }, [draftKey, api]);

  const updateDraft = useCallback((value: string) => {
    setDraftState(value);
    api.setDraft(keyRef.current, value);
  }, [api]);

  const me = api.currentUserId;
  const candidates = useMemo(
    () => memberIds.filter((id) => id !== me).map((id) => api.memberById.get(id)).filter((m): m is OrganizationMember => !!m),
    [memberIds, me, api.memberById],
  );

  const autoGrow = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, expanded ? 320 : 180)}px`;
  }, [expanded]);
  useEffect(() => { autoGrow(); }, [draft, autoGrow]);

  useEffect(() => {
    if (!autoFocus) return;
    const t = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(t);
  }, [autoFocus, draftKey]);

  useEffect(() => { if (replyTo) inputRef.current?.focus(); }, [replyTo]);

  const addFiles = useCallback((list: File[]) => {
    if (list.length === 0) return;
    const tooBig = list.filter((f) => f.size > MAX_UPLOAD_BYTES);
    const ok = list.filter((f) => f.size <= MAX_UPLOAD_BYTES);
    if (tooBig.length) setNotice(`${tooBig.map((f) => f.name).join(', ')} ${tooBig.length === 1 ? 'is' : 'zijn'} groter dan ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`);
    if (ok.length) setFiles((prev) => [...prev, ...ok].slice(0, 10));
    inputRef.current?.focus();
  }, []);

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
    addFiles,
  }), [addFiles]);

  // ── @-vermeldingen ─────────────────────────────────────────────────────────

  const mentionOptions = useMemo(() => {
    if (!mention) return [] as { id: string; name: string; member?: OrganizationMember }[];
    const q = mention.query.toLowerCase();
    const list: { id: string; name: string; member?: OrganizationMember }[] = candidates
      .map((m) => ({ id: m.user_id, name: memberDisplay(m).name, member: m }))
      .filter((o) => !q || o.name.toLowerCase().split(' ').some((w) => w.startsWith(q)) || o.name.toLowerCase().includes(q) || (o.member?.email ?? '').toLowerCase().startsWith(q));
    if (allowEveryone && (!q || EVERYONE.startsWith(q))) list.push({ id: EVERYONE, name: EVERYONE });
    return list.slice(0, 7);
  }, [mention, candidates, allowEveryone]);

  function detectMention(value: string, caret: number) {
    const upto = value.slice(0, caret);
    const m = /(^|[\s(])@([^\s@]{0,30})$/.exec(upto);
    if (m) {
      setMention({ query: m[2], start: caret - m[2].length - 1, end: caret });
      setMentionIndex(0);
    } else {
      setMention(null);
    }
  }

  function pickMention(option: { id: string; name: string }) {
    if (!mention) return;
    const before = draft.slice(0, mention.start);
    const after = draft.slice(mention.end);
    const insert = `@${option.name} `;
    const next = `${before}${insert}${after}`;
    updateDraft(next);
    setMention(null);
    const caret = before.length + insert.length;
    window.requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }

  function computeMentions(body: string): string[] {
    return mentionIdsIn(body, memberIds, api.memberById, me, !!allowEveryone);
  }

  // ── Opmaak ─────────────────────────────────────────────────────────────────

  function applyEdit(result: { value: string; start: number; end: number }) {
    updateDraft(result.value);
    window.requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(result.start, result.end);
    });
  }

  function wrap(marker: string) {
    const el = inputRef.current;
    if (!el) return;
    const start = el.selectionStart ?? draft.length;
    const end = el.selectionEnd ?? draft.length;
    if (marker === '`' && draft.slice(start, end).includes('\n')) {
      const before = draft.slice(0, start);
      const inner = draft.slice(start, end);
      const after = draft.slice(end);
      const pre = before && !before.endsWith('\n') ? '\n' : '';
      applyEdit({ value: `${before}${pre}\`\`\`\n${inner}\n\`\`\`\n${after}`, start: start + pre.length + 4, end: start + pre.length + 4 + inner.length });
      return;
    }
    applyEdit(toggleWrap(draft, start, end, marker));
  }

  function prefix(kind: 'bullet' | 'number' | 'quote') {
    const el = inputRef.current;
    if (!el) return;
    applyEdit(toggleLinePrefix(draft, el.selectionStart ?? 0, el.selectionEnd ?? 0, kind));
  }

  function insertAtCaret(text: string) {
    const { start, end } = selectionRef.current;
    const s = Math.min(start, draft.length);
    const e = Math.min(end, draft.length);
    const next = draft.slice(0, s) + text + draft.slice(e);
    applyEdit({ value: next, start: s + text.length, end: s + text.length });
  }

  function rememberSelection() {
    const el = inputRef.current;
    if (el) selectionRef.current = { start: el.selectionStart ?? draft.length, end: el.selectionEnd ?? draft.length };
  }

  // ── Versturen ──────────────────────────────────────────────────────────────

  const canSend = !sending && (draft.trim().length > 0 || files.length > 0);

  async function submit() {
    if (!canSend) return;
    const body = draft.trim();
    setSending(true);
    setNotice(null);
    const staged = files;
    const snapshot = { draft, importance, subject };
    // Meteen leeg: de volgende zin typt al terwijl deze nog verstuurd wordt.
    updateDraft('');
    setFiles([]);
    setMention(null);
    try {
      const ok = await onSubmit({
        body,
        mentions: computeMentions(body),
        files: staged,
        importance,
        subject: mode === 'post' && subject.trim() ? subject.trim() : null,
      });
      if (ok) {
        setImportance('normal');
        setSubject('');
        if (mode === 'post') setExpanded(false);
      } else {
        updateDraft(snapshot.draft);
        setFiles(staged);
      }
    } catch (e) {
      updateDraft(snapshot.draft);
      setFiles(staged);
      setNotice(e instanceof Error ? e.message : 'Versturen mislukt');
    } finally {
      setSending(false);
      window.requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  function onInput(e: ChangeEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget;
    updateDraft(el.value);
    detectMention(el.value, el.selectionStart ?? el.value.length);
    if (el.value.trim()) onTyping?.();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
    if (mention && mentionOptions.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((i) => (i + 1) % mentionOptions.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex((i) => (i - 1 + mentionOptions.length) % mentionOptions.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mentionOptions[mentionIndex] ?? mentionOptions[0]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMention(null); return; }
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      if (e.key.toLowerCase() === 'b') { e.preventDefault(); wrap('**'); return; }
      if (e.key.toLowerCase() === 'i') { e.preventDefault(); wrap('_'); return; }
      if (e.key === 'Enter') { e.preventDefault(); void submit(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Met de opmaakbalk open is Enter een nieuwe regel en Ctrl+Enter versturen — zoals in Teams.
      if (!expanded) { e.preventDefault(); void submit(); }
      return;
    }
    if (e.key === 'ArrowUp' && !draft && files.length === 0 && onEditLast) { e.preventDefault(); onEditLast(); return; }
    if (e.key === 'Escape') {
      if (replyTo && onCancelReply) { e.preventDefault(); onCancelReply(); return; }
      if (onCancel && !draft.trim()) { e.preventDefault(); onCancel(); }
    }
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = Array.from(e.clipboardData.files ?? []);
    if (pasted.length && !e.clipboardData.getData('text')) {
      e.preventDefault();
      addFiles(pasted.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `schermafbeelding-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}${i ? `-${i}` : ''}.png`, { type: f.type || 'image/png' }))));
    }
  }

  const isPost = mode === 'post';
  const showSubject = isPost && expanded;
  const label = importance === 'urgent' ? 'DRINGEND!' : importance === 'important' ? 'BELANGRIJK!' : null;

  return (
    <div className={`tmc-composer${expanded ? ' is-expanded' : ''}${mode === 'reply' ? ' is-reply' : ''}${importance !== 'normal' ? ` is-${importance}` : ''}`}>
      {mention && mentionOptions.length > 0 && (
        <div className="tmc-mention-pop" role="listbox" aria-label="Iemand noemen">
          {mentionOptions.map((o, i) => (
            <button
              type="button"
              key={o.id}
              role="option"
              aria-selected={i === mentionIndex}
              className={i === mentionIndex ? 'is-active' : ''}
              onMouseDown={(e) => { e.preventDefault(); pickMention(o); }}
              onMouseEnter={() => setMentionIndex(i)}
            >
              {o.member
                ? <Avatar userId={o.id} member={o.member} size={26} presence={api.presenceOf(o.id)} />
                : <span className="tmc-avatar tmc-avatar-everyone" style={{ width: 26, height: 26 }}>@</span>}
              <span className="tmc-mention-name">{o.member ? o.name : 'iedereen in dit gesprek'}</span>
              {o.member?.email && <span className="tmc-mention-mail">{o.member.email}</span>}
            </button>
          ))}
        </div>
      )}

      {replyTo && (
        <div className="tmc-replying">
          <div className="tmc-quote is-static">
            <div className="tmc-quote-head">{memberDisplay(api.memberById.get(replyTo.sender_id ?? '')).name}</div>
            <div className="tmc-quote-body">{plainSnippet(replyTo)}</div>
          </div>
          <button type="button" className="tmc-icon-btn" onClick={onCancelReply} aria-label="Niet meer citeren" title="Niet meer citeren"><X size={15} /></button>
        </div>
      )}

      <div className="tmc-compose-box">
        {label && <div className={`tmc-compose-importance is-${importance}`}>{importance === 'urgent' ? <Bell size={13} /> : <AlertTriangle size={13} />}{label}</div>}
        {expanded && (
          <div className="tmc-format-bar" role="toolbar" aria-label="Opmaak">
            <button type="button" onClick={() => wrap('**')} title="Vet (Ctrl+B)" aria-label="Vet"><Bold size={16} /></button>
            <button type="button" onClick={() => wrap('_')} title="Cursief (Ctrl+I)" aria-label="Cursief"><Italic size={16} /></button>
            <button type="button" onClick={() => wrap('~~')} title="Doorhalen" aria-label="Doorhalen"><Strikethrough size={16} /></button>
            <span className="tmc-format-sep" />
            <button type="button" onClick={() => prefix('bullet')} title="Opsomming" aria-label="Opsomming"><List size={16} /></button>
            <button type="button" onClick={() => prefix('number')} title="Genummerde lijst" aria-label="Genummerde lijst"><ListOrdered size={16} /></button>
            <button type="button" onClick={() => prefix('quote')} title="Citaat" aria-label="Citaat"><Quote size={16} /></button>
            <span className="tmc-format-sep" />
            <button type="button" onClick={() => wrap('`')} title="Code" aria-label="Code"><Code size={16} /></button>
            <button type="button" ref={linkBtn} onMouseDown={rememberSelection} onClick={() => setLinkOpen((v) => !v)} title="Link invoegen" aria-label="Link invoegen" aria-expanded={linkOpen}><Link2 size={16} /></button>
          </div>
        )}
        {showSubject && (
          <input className="tmc-subject" value={subject} onChange={(e) => setSubject(e.target.value.slice(0, 200))} placeholder="Onderwerp toevoegen" aria-label="Onderwerp" />
        )}
        <div className="tmc-compose-row">
          <textarea
            ref={inputRef}
            className="tmc-input"
            rows={1}
            value={draft}
            placeholder={placeholder}
            aria-label={placeholder}
            onChange={onInput}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onSelect={rememberSelection}
            onBlur={rememberSelection}
          />
          <div className="tmc-compose-actions">
            <button type="button" className={`tmc-tool${expanded ? ' is-on' : ''}`} onClick={() => { setExpanded((v) => !v); window.requestAnimationFrame(() => inputRef.current?.focus()); }} title={expanded ? 'Opmaak sluiten' : 'Opmaak'} aria-label="Opmaak" aria-pressed={expanded}><PenLine size={17} /></button>
            <button type="button" ref={emojiBtn} className={`tmc-tool${emojiOpen ? ' is-on' : ''}`} onMouseDown={rememberSelection} onClick={() => setEmojiOpen((v) => !v)} title="Emoji" aria-label="Emoji" aria-expanded={emojiOpen}><Smile size={17} /></button>
            <button type="button" className="tmc-tool" onClick={() => fileRef.current?.click()} title="Bestanden toevoegen" aria-label="Bestanden toevoegen"><Paperclip size={17} /></button>
            {mode !== 'reply' && (
              <button type="button" ref={importanceBtn} className={`tmc-tool${importance !== 'normal' ? ' is-on is-alert' : ''}`} onClick={() => setImportanceOpen((v) => !v)} title="Bezorgopties" aria-label="Bezorgopties" aria-expanded={importanceOpen}><AlertTriangle size={17} /></button>
            )}
            <span className="tmc-compose-divider" aria-hidden="true" />
            <button type="button" className="tmc-send" onClick={() => void submit()} disabled={!canSend} aria-label={expanded ? 'Versturen (Ctrl+Enter)' : 'Versturen'} title={expanded ? 'Versturen (Ctrl+Enter)' : 'Versturen (Enter)'}><Send size={17} /></button>
          </div>
        </div>
        {files.length > 0 && (
          <div className="tmc-staged">
            {files.map((f, i) => (
              <StagedFile key={`${f.name}-${i}-${f.size}`} file={f} onRemove={() => setFiles((prev) => prev.filter((_, j) => j !== i))} />
            ))}
          </div>
        )}
      </div>
      {notice && <div className="tmc-compose-notice" role="alert">{notice}<button type="button" onClick={() => setNotice(null)} aria-label="Sluiten"><X size={13} /></button></div>}
      {(mode === 'reply' || (isPost && onCancel)) && (
        <div className="tmc-compose-foot">
          {onCancel && <button type="button" className="tmc-link-btn" onClick={onCancel}>Annuleren</button>}
        </div>
      )}

      <input ref={fileRef} type="file" multiple hidden onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />

      <Popover anchorRef={emojiBtn} open={emojiOpen} onClose={() => setEmojiOpen(false)} placement="above-end" className="tmc-emoji-pop" label="Emoji">
        <EmojiPicker onPick={(emoji) => { setEmojiOpen(false); insertAtCaret(emoji); }} />
      </Popover>

      <Popover anchorRef={importanceBtn} open={importanceOpen} onClose={() => setImportanceOpen(false)} placement="above-end" className="tmc-menu" label="Bezorgopties">
        <div className="tmc-menu-title">Bezorgopties</div>
        {([
          ['normal', 'Standaard', 'Gewoon afleveren.'],
          ['important', 'Belangrijk', 'Met een rode markering in het gesprek.'],
          ['urgent', 'Dringend', 'Ook een melding bij Niet storen of een gedempte chat.'],
        ] as [ChatImportance, string, string][]).map(([value, title, hint]) => (
          <button key={value} type="button" role="menuitemradio" aria-checked={importance === value} className={`tmc-menu-item is-tall${importance === value ? ' is-checked' : ''}`}
            onClick={() => { setImportance(value); setImportanceOpen(false); inputRef.current?.focus(); }}>
            <span className={`tmc-menu-icon${value !== 'normal' ? ' is-alert' : ''}`}>{value === 'urgent' ? <Bell size={15} /> : value === 'important' ? <AlertTriangle size={15} /> : <Send size={15} />}</span>
            <span className="tmc-menu-label">{title}<small>{hint}</small></span>
          </button>
        ))}
      </Popover>

      <Popover anchorRef={linkBtn} open={linkOpen} onClose={() => setLinkOpen(false)} placement="above-start" className="tmc-link-pop" label="Link invoegen">
        <LinkForm
          initialText={draft.slice(selectionRef.current.start, selectionRef.current.end)}
          onCancel={() => setLinkOpen(false)}
          onInsert={(text, url) => { setLinkOpen(false); insertAtCaret(`[${text || url}](${url})`); }}
        />
      </Popover>
    </div>
  );
});

function StagedFile({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file.type.startsWith('image/')) return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return (
    <span className="tmc-staged-file" title={file.name}>
      {url ? <img src={url} alt="" /> : <Paperclip size={14} />}
      <span className="tmc-staged-name">{file.name}</span>
      <button type="button" onClick={onRemove} aria-label={`${file.name} weghalen`}><X size={13} /></button>
    </span>
  );
}

function LinkForm({ initialText, onInsert, onCancel }: { initialText: string; onInsert: (text: string, url: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initialText);
  const [url, setUrl] = useState('https://');
  const normalized = /^www\./i.test(url.trim()) ? `https://${url.trim()}` : url.trim();
  const valid = /^https?:\/\/[^\s]+\.[^\s]+/.test(normalized);
  return (
    <form className="tmc-link-form" onSubmit={(e) => { e.preventDefault(); if (valid) onInsert(text.trim(), normalized); }}>
      <label>Weer te geven tekst<input value={text} onChange={(e) => setText(e.target.value)} placeholder="Tekst" /></label>
      <label>Adres<input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" /></label>
      <div className="tmc-link-actions">
        <button type="button" className="tmc-btn" onClick={onCancel}>Annuleren</button>
        <button type="submit" className="tmc-btn is-primary" disabled={!valid}>Invoegen</button>
      </div>
    </form>
  );
}
