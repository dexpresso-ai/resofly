import { Fragment, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { isEmojiOnly, parseChatText, type ChatBlock, type ChatInline } from '../../lib/chatFormat';
import { EMOJI_CATEGORIES, recentEmoji, rememberEmoji, searchEmoji } from './emoji';

/** De opgemaakte tekst van een bericht (zie src/lib/chatFormat.ts voor de regels). */
export function MessageText({ body, names, myName, compact }: { body: string; names: string[]; myName?: string | null; compact?: boolean }) {
  const blocks = useMemo(() => parseChatText(body, names), [body, names]);
  if (!compact && isEmojiOnly(body)) return <div className="tmc-jumbo" aria-label={body}>{body.trim()}</div>;
  return <div className="tmc-text">{renderBlocks(blocks, myName ?? null)}</div>;
}

function renderBlocks(blocks: ChatBlock[], me: string | null): ReactNode {
  return blocks.map((b, i) => {
    switch (b.t) {
      case 'p': return <p key={i}>{renderInline(b.c, me)}</p>;
      case 'quote': return <blockquote key={i}>{renderBlocks(b.c, me)}</blockquote>;
      case 'pre': return <pre key={i}><code>{b.v}</code></pre>;
      case 'ul': return <ul key={i}>{b.items.map((item, j) => <li key={j}>{renderInline(item, me)}</li>)}</ul>;
      case 'ol': return <ol key={i} start={b.start}>{b.items.map((item, j) => <li key={j}>{renderInline(item, me)}</li>)}</ol>;
      default: return null;
    }
  });
}

function renderInline(nodes: ChatInline[], me: string | null): ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text': return <Fragment key={i}>{n.v}</Fragment>;
      case 'br': return <br key={i} />;
      case 'b': return <strong key={i}>{renderInline(n.c, me)}</strong>;
      case 'i': return <em key={i}>{renderInline(n.c, me)}</em>;
      case 's': return <s key={i}>{renderInline(n.c, me)}</s>;
      case 'code': return <code key={i}>{n.v}</code>;
      case 'link': return <a key={i} href={n.href} target="_blank" rel="noopener noreferrer">{renderInline(n.c, me)}</a>;
      case 'mention': {
        const isMe = !!me && (n.name === me || n.name === 'iedereen');
        return <span key={i} className={`tmc-mention${isMe ? ' is-me' : ''}`}>@{n.name}</span>;
      }
      default: return null;
    }
  });
}

/** De emoji-kiezer van de opsteller en de "meer reacties"-knop. */
export function EmojiPicker({ onPick, autoFocus = true }: { onPick: (emoji: string) => void; autoFocus?: boolean }) {
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<string>(() => (recentEmoji().length ? 'recent' : EMOJI_CATEGORIES[0].key));
  const gridRef = useRef<HTMLDivElement>(null);
  const recent = useMemo(() => recentEmoji(), []);
  const results = query.trim() ? searchEmoji(query) : null;
  const items = results
    ?? (cat === 'recent' ? recent : (EMOJI_CATEGORIES.find((c) => c.key === cat)?.items.map((i) => i.e) ?? []));
  const label = results ? 'Zoekresultaten' : cat === 'recent' ? 'Recent gebruikt' : EMOJI_CATEGORIES.find((c) => c.key === cat)?.label;

  function pick(e: string) {
    rememberEmoji(e);
    onPick(e);
  }

  return (
    <div className="tmc-emoji">
      <label className="tmc-emoji-search">
        <Search size={14} aria-hidden="true" />
        <input autoFocus={autoFocus} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Zoek een emoji" aria-label="Zoek een emoji"
          onKeyDown={(e) => { if (e.key === 'Enter' && items[0]) { e.preventDefault(); pick(items[0]); } if (e.key === 'ArrowDown') { e.preventDefault(); gridRef.current?.querySelector<HTMLButtonElement>('button')?.focus(); } }} />
      </label>
      {!results && (
        <div className="tmc-emoji-cats" role="tablist" aria-label="Categorieën">
          {recent.length > 0 && (
            <button type="button" role="tab" aria-selected={cat === 'recent'} className={cat === 'recent' ? 'is-active' : ''} onClick={() => setCat('recent')} title="Recent gebruikt">🕘</button>
          )}
          {EMOJI_CATEGORIES.map((c) => (
            <button key={c.key} type="button" role="tab" aria-selected={cat === c.key} className={cat === c.key ? 'is-active' : ''} onClick={() => setCat(c.key)} title={c.label}>{c.icon}</button>
          ))}
        </div>
      )}
      <div className="tmc-emoji-label">{label}</div>
      <div ref={gridRef} className="tmc-emoji-grid" role="listbox" aria-label={label}>
        {items.length === 0 && <div className="tmc-emoji-empty">Geen emoji gevonden</div>}
        {items.map((e) => (
          <button key={e} type="button" role="option" aria-selected={false} onClick={() => pick(e)} aria-label={e}>{e}</button>
        ))}
      </div>
    </div>
  );
}
