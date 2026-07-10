import React, { useEffect, useMemo, useRef, useState } from 'react';

const allowedTags = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'blockquote', 'a', 'div', 'span',
]);
const blockTags = new Set(['p', 'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'blockquote', 'div']);
const checklistClass = 'rf-task-list';
const taskCheckboxClass = 'rf-task-checkbox';
const taskContentClass = 'rf-task-content';
const checkedTaskMarkers = new Set(['☑', '✅', '✔', '✓', '☒']);

function canUseDom() {
  return typeof window !== 'undefined' && typeof DOMParser !== 'undefined' && typeof document !== 'undefined';
}

export function looksLikeRichText(value: string | null | undefined) {
  return Boolean(value && /<\/?[a-z][\s\S]*>/i.test(value));
}

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function plainTextToRichText(value: string) {
  const normalized = value.replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';

  return normalized
    .split(/\n{2,}/)
    .map(paragraph => `<p>${paragraph.split('\n').map(line => escapeHtml(line)).join('<br>')}</p>`)
    .join('');
}

function normalizeInput(value: string | null | undefined) {
  const input = String(value ?? '').trim();
  if (!input) return '';
  return looksLikeRichText(input) ? input : plainTextToRichText(input);
}

function isSafeHref(href: string) {
  const trimmed = href.trim();
  return /^(https?:|mailto:|tel:|#)/i.test(trimmed);
}

function hasTaskListAncestor(element: Element) {
  return Boolean(element.closest(`ul.${checklistClass}, ol.${checklistClass}`));
}

function createTaskCheckbox(targetDocument: Document, checked: boolean) {
  const checkbox = targetDocument.createElement('span');
  checkbox.className = taskCheckboxClass;
  checkbox.setAttribute('contenteditable', 'false');
  checkbox.setAttribute('role', 'checkbox');
  checkbox.setAttribute('aria-checked', String(checked));
  checkbox.setAttribute('tabindex', '0');
  return checkbox;
}

function firstTextNode(root: HTMLElement, targetDocument: Document): Text | null {
  const walker = targetDocument.createTreeWalker(root, 4);
  return walker.nextNode() as Text | null;
}

function detectLegacyTaskMarker(text: string) {
  const match = text.match(/^\s*(☑|✅|✔|✓|☒|☐|□)\s*/);
  if (!match) return null;
  return {
    marker: match[1],
    checked: checkedTaskMarkers.has(match[1]),
    length: match[0].length,
  };
}

function removeDecorativeTaskCheckboxes(cleanElement: HTMLElement) {
  cleanElement.querySelectorAll(`.${taskCheckboxClass}`).forEach(node => node.remove());
}

function unwrapTaskContentContainers(cleanElement: HTMLElement) {
  cleanElement.querySelectorAll(`.${taskContentClass}`).forEach(node => {
    node.replaceWith(...Array.from(node.childNodes));
  });
}

function normalizeTaskItem(cleanElement: HTMLElement, sourceElement: HTMLElement, targetDocument: Document) {
  removeDecorativeTaskCheckboxes(cleanElement);
  unwrapTaskContentContainers(cleanElement);

  const sourceChecked = sourceElement.getAttribute('data-checked');
  const sourceAriaChecked = sourceElement.getAttribute('aria-checked');
  let checked = sourceChecked === 'true' || sourceAriaChecked === 'true';

  const textNode = firstTextNode(cleanElement, targetDocument);
  if (textNode) {
    const legacy = detectLegacyTaskMarker(textNode.data);
    if (legacy) {
      checked = legacy.checked;
      textNode.data = textNode.data.slice(legacy.length);
    }
  }

  const content = targetDocument.createElement('span');
  content.className = taskContentClass;
  while (cleanElement.firstChild) {
    content.appendChild(cleanElement.firstChild);
  }
  if (!content.textContent?.trim() && content.querySelector('br') === null) {
    content.appendChild(targetDocument.createElement('br'));
  }

  cleanElement.setAttribute('data-checked', String(checked));
  cleanElement.setAttribute('aria-checked', String(checked));
  cleanElement.appendChild(createTaskCheckbox(targetDocument, checked));
  cleanElement.appendChild(content);
}

export function sanitizeRichText(value: string | null | undefined): string {
  const normalized = normalizeInput(value);
  if (!normalized) return '';

  if (!canUseDom()) {
    // Zonder DOM kunnen we niet per-tag saneren; strip dan ALLE tags (plain
    // tekst) i.p.v. enkel <script>/<style>, zodat vectoren als <img onerror=…>
    // of <svg onload=…> niet overleven. Dit pad geldt alleen bij SSR/prerender;
    // in de browser draait de volledige DOM-sanitizer hieronder.
    return normalized.replace(/<[^>]*>/g, '');
  }

  const parser = new DOMParser();
  const parsed = parser.parseFromString(`<div>${normalized}</div>`, 'text/html');
  const sourceRoot = parsed.body.firstElementChild ?? parsed.body;
  const output = document.createElement('div');

  const sanitizeNode = (node: Node, targetDocument: Document): Node | null => {
    if (node.nodeType === Node.TEXT_NODE) {
      return targetDocument.createTextNode(node.textContent ?? '');
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return null;

    const element = node as HTMLElement;
    const tag = element.tagName.toLowerCase();

    if (tag === 'script' || tag === 'style' || tag === 'iframe' || tag === 'object' || tag === 'embed') {
      return null;
    }

    if (!allowedTags.has(tag)) {
      const fragment = targetDocument.createDocumentFragment();
      Array.from(element.childNodes).forEach(child => {
        const cleanChild = sanitizeNode(child, targetDocument);
        if (cleanChild) fragment.appendChild(cleanChild);
      });
      return fragment;
    }

    const cleanElement = targetDocument.createElement(tag);

    if ((tag === 'ul' || tag === 'ol') && element.classList.contains(checklistClass)) {
      cleanElement.className = checklistClass;
    }

    const isTaskCheckbox = tag === 'span' && element.classList.contains(taskCheckboxClass) && hasTaskListAncestor(element);
    if (isTaskCheckbox) {
      cleanElement.className = taskCheckboxClass;
      cleanElement.setAttribute('contenteditable', 'false');
      cleanElement.setAttribute('role', 'checkbox');
      cleanElement.setAttribute('tabindex', '0');
    }

    if (tag === 'a') {
      const href = element.getAttribute('href') ?? '';
      if (isSafeHref(href)) {
        cleanElement.setAttribute('href', href.trim());
        cleanElement.setAttribute('target', '_blank');
        cleanElement.setAttribute('rel', 'noopener noreferrer');
      }
    }

    Array.from(element.childNodes).forEach(child => {
      const cleanChild = sanitizeNode(child, targetDocument);
      if (cleanChild) cleanElement.appendChild(cleanChild);
    });

    if (tag === 'li' && hasTaskListAncestor(element)) {
      normalizeTaskItem(cleanElement, element, targetDocument);
    }

    if (isTaskCheckbox) {
      const li = element.closest('li');
      const checked = li?.getAttribute('data-checked') === 'true' || element.getAttribute('aria-checked') === 'true';
      cleanElement.setAttribute('aria-checked', String(checked));
    }

    if (blockTags.has(tag) && !cleanElement.textContent?.trim() && cleanElement.querySelector('br') === null && cleanElement.querySelector(`.${taskCheckboxClass}`) === null) {
      cleanElement.appendChild(targetDocument.createElement('br'));
    }

    return cleanElement;
  };

  Array.from(sourceRoot.childNodes).forEach(child => {
    const cleanChild = sanitizeNode(child, document);
    if (cleanChild) output.appendChild(cleanChild);
  });

  return output.innerHTML.trim();
}

export function richTextToPlainText(value: string | null | undefined): string {
  const html = sanitizeRichText(value);
  if (!html) return '';

  if (!canUseDom()) {
    return html.replace(/<br\s*\/?>(\s*)/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  const parsed = new DOMParser().parseFromString(html, 'text/html');
  parsed.body.querySelectorAll(`.${taskCheckboxClass}`).forEach(node => node.remove());
  return (parsed.body.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function RichTextViewer({ content, emptyText = 'Geen inhoud', className = '' }: { content?: string | null; emptyText?: string; className?: string }) {
  const safeHtml = useMemo(() => sanitizeRichText(content), [content]);

  if (!safeHtml) return <span className={`rich-text-empty ${className}`.trim()}>{emptyText}</span>;

  return <div className={`rich-text-viewer ${className}`.trim()} dangerouslySetInnerHTML={{ __html: safeHtml }} />;
}

export function RichTextExcerpt({ content, emptyText = 'Geen inhoud' }: { content?: string | null; emptyText?: string }) {
  const text = useMemo(() => richTextToPlainText(content), [content]);
  return <>{text || emptyText}</>;
}


// Plaats de cursor op het punt waar wordt gedropt, zodat een gesleepte variabele
// daar landt en niet aan het einde. Chrome/Safari: caretRangeFromPoint;
// Firefox: caretPositionFromPoint.
function placeCaretAtPoint(x: number, y: number, root: HTMLElement | null) {
  const selection = window.getSelection();
  if (!selection) return;
  let range: Range | null = null;
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (typeof doc.caretRangeFromPoint === 'function') {
    range = doc.caretRangeFromPoint(x, y);
  } else if (typeof doc.caretPositionFromPoint === 'function') {
    const pos = doc.caretPositionFromPoint(x, y);
    if (pos) {
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.collapse(true);
    }
  }
  if (range && root && root.contains(range.startContainer)) {
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

function eventTargetElement(target: EventTarget | null): HTMLElement | null {
  if (target instanceof HTMLElement) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

function ToolbarButton({ children, label, disabled, onAction }: { children: React.ReactNode; label: string; disabled?: boolean; onAction: () => void }) {
  return <button
    type="button"
    className="rich-text-toolbar-button"
    title={label}
    aria-label={label}
    disabled={disabled}
    onMouseDown={(event) => {
      event.preventDefault();
      if (!disabled) onAction();
    }}
  >{children}</button>;
}

export function RichTextEditor({
  value,
  onChange,
  placeholder = 'Schrijf je notitie…',
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [focused, setFocused] = useState(false);
  const [isEmpty, setIsEmpty] = useState(() => !richTextToPlainText(value));

  useEffect(() => {
    if (!editorRef.current || focused) return;
    const safeHtml = sanitizeRichText(value);
    if (editorRef.current.innerHTML !== safeHtml) {
      editorRef.current.innerHTML = safeHtml;
      setIsEmpty(!richTextToPlainText(safeHtml));
    }
  }, [focused, value]);

  const commit = () => {
    const raw = editorRef.current?.innerHTML ?? '';
    const safe = sanitizeRichText(raw);
    setIsEmpty(!richTextToPlainText(safe));
    onChange(safe);
  };

  const focusEditor = () => {
    editorRef.current?.focus();
  };

  const runCommand = (command: string, commandValue?: string) => {
    if (disabled) return;
    focusEditor();
    document.execCommand(command, false, commandValue);
    commit();
  };

  const applyBlock = (tagName: 'p' | 'h2' | 'h3' | 'blockquote') => {
    runCommand('formatBlock', tagName);
  };

  const insertTaskList = () => {
    if (disabled) return;
    focusEditor();
    document.execCommand('insertHTML', false, '<ul class="rf-task-list"><li data-checked="false"><span class="rf-task-checkbox" contenteditable="false" role="checkbox" aria-checked="false" tabindex="0"></span>Nieuwe taak</li></ul><p><br></p>');
    commit();
  };

  const toggleTaskItem = (checkbox: HTMLElement) => {
    if (disabled) return;
    const li = checkbox.closest('li');
    if (!li || !editorRef.current?.contains(li)) return;

    const nextChecked = li.getAttribute('data-checked') !== 'true';
    li.setAttribute('data-checked', String(nextChecked));
    li.setAttribute('aria-checked', String(nextChecked));
    li.querySelectorAll(`.${taskCheckboxClass}`).forEach(node => node.setAttribute('aria-checked', String(nextChecked)));
    commit();
  };

  const addLink = () => {
    if (disabled) return;
    const href = window.prompt('Plak een link');
    if (!href) return;
    if (!isSafeHref(href)) {
      window.alert('Gebruik een veilige link, bijvoorbeeld https://, mailto: of tel:.');
      return;
    }
    runCommand('createLink', href);
  };

  return <div className="rich-text-field">
    <div className="rich-text-toolbar" aria-label="Notitie opmaak">
      <ToolbarButton label="Paragraaf" disabled={disabled} onAction={() => applyBlock('p')}>Tekst</ToolbarButton>
      <ToolbarButton label="Titel" disabled={disabled} onAction={() => applyBlock('h2')}>Titel</ToolbarButton>
      <ToolbarButton label="Subtitel" disabled={disabled} onAction={() => applyBlock('h3')}>Sub</ToolbarButton>
      <span className="rich-text-toolbar-divider" />
      <ToolbarButton label="Vet" disabled={disabled} onAction={() => runCommand('bold')}><strong>B</strong></ToolbarButton>
      <ToolbarButton label="Italic" disabled={disabled} onAction={() => runCommand('italic')}><em>I</em></ToolbarButton>
      <ToolbarButton label="Onderstrepen" disabled={disabled} onAction={() => runCommand('underline')}><u>U</u></ToolbarButton>
      <span className="rich-text-toolbar-divider" />
      <ToolbarButton label="Bullets" disabled={disabled} onAction={() => runCommand('insertUnorderedList')}>• Lijst</ToolbarButton>
      <ToolbarButton label="Genummerde lijst" disabled={disabled} onAction={() => runCommand('insertOrderedList')}>1. Lijst</ToolbarButton>
      <ToolbarButton label="Takenlijst" disabled={disabled} onAction={insertTaskList}>☐ Taken</ToolbarButton>
      <span className="rich-text-toolbar-divider" />
      <ToolbarButton label="Quote" disabled={disabled} onAction={() => applyBlock('blockquote')}>Quote</ToolbarButton>
      <ToolbarButton label="Link" disabled={disabled} onAction={addLink}>Link</ToolbarButton>
    </div>
    <div
      ref={editorRef}
      className={`rich-text-editor ${isEmpty ? 'is-empty' : ''}`}
      contentEditable={!disabled}
      data-placeholder={placeholder}
      role="textbox"
      aria-multiline="true"
      suppressContentEditableWarning
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onInput={commit}
      onClick={(event) => {
        const checkbox = eventTargetElement(event.target)?.closest(`.${taskCheckboxClass}`) as HTMLElement | null;
        if (!checkbox) return;
        event.preventDefault();
        event.stopPropagation();
        toggleTaskItem(checkbox);
      }}
      onKeyDown={(event) => {
        const checkbox = eventTargetElement(event.target)?.closest(`.${taskCheckboxClass}`) as HTMLElement | null;
        if (!checkbox || ![' ', 'Enter'].includes(event.key)) return;
        event.preventDefault();
        toggleTaskItem(checkbox);
      }}
      onPaste={(event) => {
        if (disabled) return;
        event.preventDefault();
        const text = event.clipboardData.getData('text/plain');
        document.execCommand('insertText', false, text);
        commit();
      }}
      onDragOver={(event) => {
        if (disabled) return;
        if (Array.from(event.dataTransfer.types).includes('text/plain')) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={(event) => {
        if (disabled) return;
        const text = event.dataTransfer.getData('text/plain');
        if (!text) return;
        event.preventDefault();
        focusEditor();
        placeCaretAtPoint(event.clientX, event.clientY, editorRef.current);
        document.execCommand('insertText', false, text);
        commit();
      }}
    />
    <div className="rich-text-help">Ondersteunt titels, subtitels, vet, italic, bullets, genummerde lijsten, aanvinkbare takenlijsten, quotes en links.</div>
  </div>;
}
