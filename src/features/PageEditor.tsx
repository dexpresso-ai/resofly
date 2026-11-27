// ============================================================
// De pagina-editor (stap 1A-3a, docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md §5).
//
// Een eigen stuk bundel: main.tsx laadt dit pas als je een pagina opent
// (lazyPage), zodat Tiptap en ProseMirror niet bij elke start meekomen.
//
// De regels, en wat er misging toen het anders was of anders zou zijn:
//  - Eén tegelijk bewerken: wie opent, claimt de pagina (claim_page_edit) en
//    geeft elke 30 seconden een hartslag. Een ander leest mee en ziet wie er
//    bewerkt; komt de pagina vrij, dan laadt hij vers en mag hij verder.
//  - Alleen opslaan met een verse claim (hooguit 75 seconden oud). Een laptop
//    die na een uur slapen wakker wordt, zou anders over het werk van degene
//    heen schrijven die het intussen overnam.
//  - Openen slaat niets op. Laden gebeurt zonder update-melding, en de inhoud
//    na het laden (met de blok-id's die UniqueID erbij zet) is het
//    vertrekpunt. Anders verschoof alleen al het openen "laatst gewijzigd" en
//    kwam er een regel in het logboek.
//  - Eén keer opslaan tegelijk: alles gaat achter elkaar (een keten van
//    beloftes). Twee tegelijk stuurden hetzelfde edit_version mee, en de
//    tweede gaf dan een vals conflict.
//  - Opslaan kijkt naar edit_version. Schreef iemand anders ertussen (Gerrie,
//    de API, een overname), dan overschrijven we niets: de editor gaat op
//    alleen-lezen en zegt dat. Mocht je gewoon niet (meer) schrijven, dan zegt
//    hij dat.
//  - Sluiten in een vaste volgorde: laatste wijziging opslaan, een versie
//    vastleggen (alleen als er deze keer iets is opgeslagen), de claim
//    loslaten. Mislukt het opslaan, dan blijft de editor open.
//  - Een pagina met een blok dat deze versie van de app niet kent, gaat niet
//    open om te bewerken (pageBodyCheck.ts). Tiptap maakte er stilletjes een
//    lege pagina van, en de eerste toets schreef die over de echte heen.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import type { Editor, JSONContent } from '@tiptap/react';
import {
  AlignCenter, AlignLeft, AlignRight, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, BetweenHorizontalEnd, BetweenHorizontalStart,
  BetweenVerticalEnd, BetweenVerticalStart, Bold, Braces, ChevronLeft, Copy, Heading1, Heading2, Heading3, History, Info, Italic, Lightbulb, Link2,
  List, ListChecks, ListOrdered, Minus, OctagonAlert, PanelTop, Pilcrow, Plus, Quote, Redo2, Strikethrough, TableCellsMerge,
  TableCellsSplit, Trash2, TriangleAlert, Underline as UnderlineIcon, Undo2, X,
} from 'lucide-react';
import { isInTable, moveTableColumn, moveTableRow, selectedRect } from '@tiptap/pm/tables';
import { pageEditorExtensions, type PageLinks } from '../lib/pageEditorExtensions';
import { calloutVariant, isAllowedPageLink, type CalloutVariant } from '../lib/pageSchema';
import { pageBodyFit } from '../lib/pageBodyCheck';
import {
  claimPageEdit, createPage, listPageVersions, loadPage, loadPageVersion, pageTitle, releasePageEdit, restorePageVersion, savePage,
  savePageVersion, type PageVersionSummary,
} from '../lib/repository';
import { useBackStep } from '../lib/useBackStep';
import {
  BlockMenu, closeSlashMenu, pageBlocksFor, runPageBlock, slashMenuExtension, type BlockMenuState, type SlashBridge,
} from './PageBlockMenu';

const SAVE_DELAY_MS = 1500;
const HEARTBEAT_MS = 30_000;
/** Een claim telt als vers zolang de laatste geslaagde hartslag niet ouder is. */
const CLAIM_FRESH_MS = 75_000;
/** Tijdens een lange sessie elk kwartier een versie. */
const VERSION_EVERY_MS = 15 * 60_000;

type Mode = 'laden' | 'bewerken' | 'lezen' | 'conflict' | 'geen_recht' | 'fout' | 'onbekend';

const TOO_NEW_MESSAGE = 'Deze pagina heeft blokken die deze versie van de app nog niet kent. Ververs de app om hem te openen; er gaat niets verloren.';
const BROKEN_MESSAGE = 'De inhoud van deze pagina klopt niet, daarom kun je hem niet bewerken. Er wordt niets opgeslagen.';

/** De opgeslagen pagina past niet in deze editor (pageBodyCheck.ts). Alleen
 *  bij onbekende blokken helpt verversen; een kapotte pagina blijft kapot. */
class PageTooNewError extends Error {
  readonly canRefresh: boolean;
  constructor(reason: string, canRefresh: boolean) {
    super(`De pagina past niet in deze editor (${reason}).`);
    this.canRefresh = canRefresh;
  }
}
type SaveState = 'opgeslagen' | 'wijzigingen' | 'bezig' | 'fout';

function snapshotOf(title: string, body: JSONContent): string {
  return JSON.stringify({ title, body });
}

const REASON_LABEL: Record<string, string> = {
  sessie: 'Bewerkt', vrijgave: 'Vrijgegeven', vastgelegd: 'Vastgelegd', teruggezet: 'Teruggezet', voor_gerrie: 'Voor Gerrie',
};

function whenLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Naar een andere pagina: verder (een subpagina, of omhoog) of terug langs de weg die je kwam. */
export type PageStep = { id: string; how: 'vooruit' | 'terug' };

export function PageEditor({ documentId, organizationId, canWrite, nameOf, onClose, onOpenPage, backTo = null }: {
  documentId: string;
  organizationId: string;
  /** Schrijfrechten op Inhoud. Zonder: alleen lezen, en geen claim. */
  canWrite: boolean;
  /** De naam van een collega, voor "Sanne bewerkt deze pagina". */
  nameOf: (userId: string) => string;
  onClose: () => void;
  /** Een andere pagina openen nadat deze netjes dicht is (stap 1A-4b). */
  onOpenPage?: (step: PageStep) => void;
  /** De pagina waar je vandaan kwam: de terugknop gaat daarheen in plaats van dicht. */
  backTo?: string | null;
}) {
  const [mode, setModeState] = useState<Mode>('laden');
  const [saveState, setSaveState] = useState<SaveState>('opgeslagen');
  const [title, setTitleState] = useState('');
  const [holder, setHolder] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [closeAnyway, setCloseAnyway] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [refreshHelps, setRefreshHelps] = useState(true);
  const [parent, setParent] = useState<{ id: string; title: string | null } | null>(null);

  const modeRef = useRef<Mode>('laden');
  const titleRef = useRef('');
  const versionRef = useRef(0);
  const baselineRef = useRef('');
  const lastClaimOkRef = useRef(0);
  const claimedEverRef = useRef(false);
  const savedThisSessionRef = useRef(false);
  const lastVersionAtRef = useRef(Date.now());
  const saveChainRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const timerRef = useRef<number | null>(null);
  const closingRef = useRef(false);
  const releasedRef = useRef(false);
  const editorRef = useRef<Editor | null>(null);
  const scheduleRef = useRef<() => void>(() => {});

  const setMode = (next: Mode) => { modeRef.current = next; setModeState(next); };
  const setTitle = (next: string) => { titleRef.current = next; setTitleState(next); };

  // Het blokmenu: `/` in de tekst en de +-knop (PageBlockMenu.tsx). menuRef
  // loopt synchroon mee, zodat Enter direct na een pijltje het goede blok kiest.
  const [blockMenu, setBlockMenu] = useState<BlockMenuState | null>(null);
  const menuRef = useRef<BlockMenuState | null>(null);
  const showMenu = (next: BlockMenuState | null) => { menuRef.current = next; setBlockMenu(next); };
  const slashBridge = useRef<SlashBridge | null>(null);
  const extensions = useMemo(() => [...pageEditorExtensions(), slashMenuExtension(slashBridge)], []);

  const editor = useEditor({
    extensions,
    editable: false,
    content: '',
    onUpdate: () => scheduleRef.current(),
  });
  editorRef.current = editor;

  slashBridge.current = {
    open: props => showMenu({ source: 'slash', items: props.items, active: 0, anchor: props.clientRect?.() ?? null, pick: block => props.command(block) }),
    update: props => {
      const previous = menuRef.current;
      const active = previous?.source === 'slash' ? Math.min(previous.active, Math.max(0, props.items.length - 1)) : 0;
      showMenu({ source: 'slash', items: props.items, active, anchor: props.clientRect?.() ?? null, pick: block => props.command(block) });
    },
    keyDown: event => {
      const menu = menuRef.current;
      if (!menu || menu.source !== 'slash') return false;
      const count = menu.items.length;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (count) showMenu({ ...menu, active: (menu.active + (event.key === 'ArrowDown' ? 1 : count - 1)) % count });
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const block = menu.items[menu.active];
        if (!block) return false;
        menu.pick(block);
        return true;
      }
      return false;
    },
    close: () => { if (menuRef.current?.source === 'slash') showMenu(null); },
  };

  const closeBlockMenu = () => {
    const menu = menuRef.current;
    if (menu?.source === 'slash' && editorRef.current) closeSlashMenu(editorRef.current);
    showMenu(null);
  };

  const openPlusMenu = (anchor: DOMRect) => {
    const ed = editorRef.current;
    if (!ed || modeRef.current !== 'bewerken') return;
    if (menuRef.current) { closeBlockMenu(); return; }
    showMenu({
      source: 'plus',
      items: pageBlocksFor(ed, ''),
      active: -1,
      anchor,
      pick: block => { showMenu(null); runPageBlock(ed, block.key); },
    });
  };

  const currentSnapshot = useCallback((): string | null => {
    const ed = editorRef.current;
    if (!ed) return null;
    return snapshotOf(titleRef.current.trim() || 'Naamloze pagina', ed.getJSON());
  }, []);

  /** Vers uit de database, zonder dat het een wijziging telt. */
  const loadFresh = useCallback(async () => {
    const ed = editorRef.current;
    if (!ed) return;
    const row = await loadPage(documentId, organizationId);
    const fit = pageBodyFit(ed.schema, row.body);
    if (!fit.ok) {
      // Niets in de editor zetten: Tiptap zou er een lege pagina van maken.
      setTitle(row.title);
      throw new PageTooNewError(fit.reason, fit.unknown.length > 0);
    }
    // Niet in de geschiedenis van "ongedaan maken": anders maakte Ctrl+Z direct
    // na het openen de pagina leeg (en sloeg dat op), en haalde het na
    // "Terugzetten" of "Opnieuw laden" de vervangen tekst terug. setContent zet
    // alleen preventUpdate, niet addToHistory (nagekeken in @tiptap/core 3.35.1).
    ed.chain().setMeta('addToHistory', false).setContent(row.body as JSONContent, { emitUpdate: false }).run();
    setTitle(row.title);
    setParent(previous => (row.parent_id ? { id: row.parent_id, title: previous?.id === row.parent_id ? previous.title : null } : null));
    versionRef.current = row.edit_version;
    baselineRef.current = snapshotOf(row.title.trim() || 'Naamloze pagina', ed.getJSON());
    setSaveState('opgeslagen');
  }, [documentId, organizationId]);

  /** Past de pagina niet in deze editor: alleen lezen, geen claim, niets opslaan. */
  const stopIfTooNew = useCallback(async (error: unknown): Promise<boolean> => {
    if (!(error instanceof PageTooNewError)) return false;
    editorRef.current?.setEditable(false, false);
    setHolder(null);
    setMode('onbekend');
    setRefreshHelps(error.canRefresh);
    setMessage(error.canRefresh ? TOO_NEW_MESSAGE : BROKEN_MESSAGE);
    if (claimedEverRef.current && !releasedRef.current) {
      releasedRef.current = true;
      await releasePageEdit(documentId).catch(() => {});
    }
    return true;
  }, [documentId]);

  const tryClaim = useCallback(async () => {
    const ed = editorRef.current;
    if (!ed || !canWrite) return;
    try {
      const result = await claimPageEdit(documentId);
      if (result.claimed) {
        lastClaimOkRef.current = Date.now();
        claimedEverRef.current = true;
        releasedRef.current = false;
        if (modeRef.current === 'lezen') {
          // De pagina kwam vrij: eerst vers laden, dan pas verder schrijven.
          try {
            await loadFresh();
          } catch (error) {
            if (await stopIfTooNew(error)) return;
            throw error;
          }
        }
        if (modeRef.current === 'lezen' || modeRef.current === 'laden') {
          setHolder(null);
          setMode('bewerken');
          ed.setEditable(true, false);
        }
      } else {
        setHolder(result.userId);
        if (modeRef.current === 'bewerken' || modeRef.current === 'laden') {
          ed.setEditable(false, false);
          setMode('lezen');
        }
      }
    } catch {
      // Geen verbinding: niets veranderen. Zonder verse claim slaat de editor
      // vanzelf niet meer op (CLAIM_FRESH_MS).
    }
  }, [canWrite, documentId, loadFresh, stopIfTooNew]);

  const doSave = useCallback(async (): Promise<boolean> => {
    const ed = editorRef.current;
    if (!ed || modeRef.current !== 'bewerken') return modeRef.current !== 'fout';
    const snap = currentSnapshot();
    if (snap === null || snap === baselineRef.current) {
      setSaveState('opgeslagen');
      return true;
    }
    if (Date.now() - lastClaimOkRef.current > CLAIM_FRESH_MS) {
      await tryClaim();
      if (modeRef.current !== 'bewerken' || Date.now() - lastClaimOkRef.current > CLAIM_FRESH_MS) {
        setSaveState('fout');
        setMessage('Er is geen verbinding: je laatste wijzigingen zijn nog niet opgeslagen.');
        return false;
      }
    }
    const savingTitle = titleRef.current.trim() || 'Naamloze pagina';
    setSaveState('bezig');
    try {
      const result = await savePage(documentId, organizationId, { title: savingTitle, body: ed.getJSON() }, versionRef.current);
      if (result.ok) {
        versionRef.current = result.editVersion;
        baselineRef.current = snap;
        savedThisSessionRef.current = true;
        setMessage(null);
        setSaveState(currentSnapshot() === baselineRef.current ? 'opgeslagen' : 'wijzigingen');
        if (Date.now() - lastVersionAtRef.current > VERSION_EVERY_MS) {
          lastVersionAtRef.current = Date.now();
          void savePageVersion(documentId).catch(() => {});
        }
        return true;
      }
      // Niets geschreven: iemand anders kwam ertussen, of je mag niet (meer).
      const fresh = await loadPage(documentId, organizationId).catch(() => null);
      ed.setEditable(false, false);
      if (fresh && fresh.edit_version === versionRef.current) {
        setMode('geen_recht');
        setMessage('Je mag deze pagina niet (meer) bewerken. Je laatste wijzigingen zijn niet opgeslagen.');
      } else {
        setMode('conflict');
        setMessage('Iemand anders heeft deze pagina intussen gewijzigd. Je laatste wijzigingen zijn niet opgeslagen.');
      }
      setSaveState('fout');
      return false;
    } catch {
      setSaveState('fout');
      setMessage('Opslaan is niet gelukt. Het wordt opnieuw geprobeerd bij je volgende wijziging.');
      return false;
    }
  }, [currentSnapshot, documentId, organizationId, tryClaim]);

  /** Achter de vorige aan: nooit twee keer tegelijk opslaan. */
  const queueSave = useCallback((): Promise<boolean> => {
    const next = saveChainRef.current.then(() => doSave(), () => doSave());
    saveChainRef.current = next;
    return next;
  }, [doSave]);

  scheduleRef.current = () => {
    if (modeRef.current !== 'bewerken') return;
    // Alleen als er echt iets anders staat dan wat is opgeslagen. setEditable
    // stuurt in Tiptap 3 zelf een update; zonder deze vergelijking stond er
    // direct na het openen "Niet opgeslagen".
    if (currentSnapshot() === baselineRef.current) {
      if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null; }
      setSaveState('opgeslagen');
      return;
    }
    setSaveState('wijzigingen');
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => { timerRef.current = null; void queueSave(); }, SAVE_DELAY_MS);
  };

  // Laden, dan claimen.
  useEffect(() => {
    if (!editor) return;
    let cancelled = false;
    (async () => {
      try {
        await loadFresh();
        if (cancelled) return;
        if (!canWrite) { setMode('lezen'); return; }
        await tryClaim();
        if (modeRef.current === 'laden') setMode('lezen');
      } catch (error) {
        if (cancelled) return;
        if (await stopIfTooNew(error)) return;
        setMode('fout');
        setMessage((error as { message?: string } | null)?.message || 'Deze pagina kon niet worden geopend.');
      }
    })();
    return () => { cancelled = true; };
  }, [editor, loadFresh, tryClaim, canWrite, stopIfTooNew]);

  // De hartslag, en meteen claimen als het tabblad weer zichtbaar wordt.
  useEffect(() => {
    if (!canWrite) return;
    const beat = () => {
      if (modeRef.current === 'bewerken' || modeRef.current === 'lezen') void tryClaim();
    };
    const interval = window.setInterval(beat, HEARTBEAT_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') beat(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(interval); document.removeEventListener('visibilitychange', onVisible); };
  }, [canWrite, tryClaim]);

  // Waarschuwen bij weggaan met wijzigingen die nog niet zijn opgeslagen; de
  // claim loslaten als de pagina echt dichtgaat (de rest vervalt na twee minuten).
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (modeRef.current === 'bewerken' && currentSnapshot() !== baselineRef.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    const onPageHide = () => {
      if (claimedEverRef.current && !releasedRef.current) { releasedRef.current = true; void releasePageEdit(documentId).catch(() => {}); }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
      if (timerRef.current) window.clearTimeout(timerRef.current);
      onPageHide();
    };
  }, [currentSnapshot, documentId]);

  const close = useCallback(async (discard = false, next?: PageStep) => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null; }
    if (!discard && modeRef.current === 'bewerken') {
      const ok = await queueSave();
      if (!ok) {
        closingRef.current = false;
        setCloseAnyway(true);
        return;
      }
    }
    if (savedThisSessionRef.current) await savePageVersion(documentId).catch(() => {});
    if (claimedEverRef.current && !releasedRef.current) {
      releasedRef.current = true;
      await releasePageEdit(documentId).catch(() => {});
    }
    if (next && onOpenPage) onOpenPage(next);
    else onClose();
  }, [documentId, onClose, onOpenPage, queueSave]);

  // De terugknop van de telefoon: terug naar de pagina waar je vandaan kwam,
  // anders dicht, zoals Sluiten.
  useBackStep(true, () => { void close(false, backTo ? { id: backTo, how: 'terug' } : undefined); });

  // Subpagina's (stap 1A-4b): wat het blok nodig heeft. Een andere pagina
  // openen gaat via close(), zodat deze eerst is opgeslagen, een versie heeft
  // en de claim los is.
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!editor) return;
    const titles = new Map<string, Promise<string | null>>();
    const links: PageLinks = {
      titleOf: pageId => {
        let title = titles.get(pageId);
        if (!title) {
          title = pageTitle(pageId, organizationId);
          titles.set(pageId, title);
          title.catch(() => titles.delete(pageId));
        }
        return title;
      },
      open: pageId => { void closeRef.current(false, { id: pageId, how: 'vooruit' }); },
      create: async () => {
        try {
          const page = await createPage(organizationId, { parent_id: documentId, title: 'Naamloze pagina' });
          titles.set(page.id, Promise.resolve(page.title));
          return page.id;
        } catch (error) {
          setMessage((error as { message?: string } | null)?.message || 'De subpagina kon niet worden gemaakt.');
          return null;
        }
      },
    };
    (editor.storage as unknown as Record<string, { links: PageLinks | null }>).subpage.links = links;
  }, [editor, documentId, organizationId]);

  // De titel van de bovenliggende pagina, voor de knop omhoog.
  useEffect(() => {
    if (!parent || parent.title !== null) return;
    let cancelled = false;
    pageTitle(parent.id, organizationId)
      .then(title => { if (!cancelled) setParent(current => (current?.id === parent.id ? { id: parent.id, title: title ?? 'Pagina' } : current)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [parent, organizationId]);

  const reloadAfterConflict = async () => {
    setMessage(null);
    try {
      await loadFresh();
      setMode('lezen');
      await tryClaim();
    } catch (error) {
      if (await stopIfTooNew(error)) return;
      setMode('fout');
      setMessage((error as { message?: string } | null)?.message || 'Opnieuw laden is niet gelukt.');
    }
  };

  /** Een oude versie terugzetten. Eerst wat er nu staat opslaan en als versie
   *  vastleggen, zodat het niet verloren gaat; dan terugzetten en vers laden. */
  const restoreVersion = async (version: PageVersionSummary) => {
    if (modeRef.current !== 'bewerken') return;
    if (!window.confirm(`Versie ${version.version} terugzetten? Wat er nu staat, blijft als versie bewaard.`)) return;
    if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null; }
    const saved = await queueSave();
    if (!saved) return;
    try {
      await savePageVersion(documentId).catch(() => {});
      await restorePageVersion(version.id);
      await loadFresh();
      savedThisSessionRef.current = true;
      setMessage(`Versie ${version.version} is teruggezet.`);
      setVersionsOpen(false);
    } catch (error) {
      if (await stopIfTooNew(error)) return;
      setMessage((error as { message?: string } | null)?.message || 'Terugzetten is niet gelukt.');
    }
  };

  const copyLink = async () => {
    const url = `${window.location.origin}${window.location.pathname}?pagina=${encodeURIComponent(documentId)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Kopieer de link naar deze pagina:', url);
    }
  };

  const editable = mode === 'bewerken';
  useEffect(() => {
    if (!editable && menuRef.current) showMenu(null);
  }, [editable]);
  const statusText = mode === 'laden' ? 'Laden…'
    : mode === 'onbekend' ? 'Alleen lezen'
    : mode === 'lezen' ? (holder ? `${nameOf(holder)} bewerkt deze pagina` : 'Alleen lezen')
      : mode === 'bewerken' ? (saveState === 'bezig' ? 'Opslaan…' : saveState === 'wijzigingen' ? 'Niet opgeslagen' : saveState === 'fout' ? 'Niet opgeslagen' : 'Opgeslagen')
        : 'Niet opgeslagen';

  return (
    <div className="page-editor" role="dialog" aria-modal="true" aria-label={title || 'Pagina'}>
      <div className="page-editor-bar">
        <button type="button" className="page-editor-close" onClick={() => void close()} aria-label="Pagina sluiten"><X size={18} /></button>
        {parent && <button
          type="button"
          className="page-editor-parent"
          onClick={() => void close(false, { id: parent.id, how: 'vooruit' })}
          title={`Naar ${parent.title ?? 'de bovenliggende pagina'}`}
          aria-label={`Naar de bovenliggende pagina${parent.title ? `: ${parent.title}` : ''}`}
        ><ChevronLeft size={15} /><span>{parent.title ?? '…'}</span></button>}
        <span className="page-editor-crumb" title={title}>{title || 'Pagina'}</span>
        <span className={`page-editor-status is-${mode === 'bewerken' ? saveState : mode}`} role="status">{statusText}</span>
        <button type="button" className="page-editor-action" onClick={() => void copyLink()} title="Een link naar deze pagina, voor collega's">
          <Copy size={15} /><span>{copied ? 'Gekopieerd' : 'Link'}</span>
        </button>
        <button type="button" className={`page-editor-action${versionsOpen ? ' is-active' : ''}`} onClick={() => setVersionsOpen(open => !open)} aria-expanded={versionsOpen}>
          <History size={15} /><span>Versies</span>
        </button>
      </div>

      {editable && editor && <Toolbar editor={editor} onInsert={openPlusMenu} />}
      {editable && blockMenu && <BlockMenu menu={blockMenu} onHover={index => { if (menuRef.current) showMenu({ ...menuRef.current, active: index }); }} onClose={closeBlockMenu} />}

      {(message || (mode === 'lezen' && holder)) && <div className={`page-editor-banner${mode === 'conflict' || mode === 'geen_recht' || mode === 'fout' || mode === 'onbekend' ? ' is-warning' : ''}`}>
        <span>{message ?? `${nameOf(holder as string)} bewerkt deze pagina. Je kunt meelezen; zodra die klaar is, kun je verder.`}</span>
        {mode === 'conflict' && <button type="button" className="btn" onClick={() => void reloadAfterConflict()}>Opnieuw laden</button>}
        {mode === 'onbekend' && refreshHelps && <button type="button" className="btn" onClick={() => window.location.reload()}>App verversen</button>}
        {closeAnyway && <button type="button" className="btn" onClick={() => void close(true)}>Toch sluiten</button>}
      </div>}

      {versionsOpen && <VersionsPanel
        documentId={documentId}
        organizationId={organizationId}
        canRestore={editable}
        nameOf={nameOf}
        onRestore={version => void restoreVersion(version)}
        onClose={() => setVersionsOpen(false)}
      />}

      <div className="page-editor-scroll">
        <div className="page-editor-sheet">
          <input
            className="page-editor-title"
            value={title}
            placeholder="Naamloze pagina"
            aria-label="Titel van de pagina"
            readOnly={!editable}
            onChange={event => { setTitle(event.target.value); scheduleRef.current(); }}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); editor?.commands.focus('start'); } }}
          />
          <EditorContent editor={editor} className="page-prose" />
        </div>
      </div>
    </div>
  );
}

/** `text`: een woord naast het icoon, waar iconen alleen te veel op elkaar lijken (weghalen). */
type Tool = { label: string; icon: JSX.Element; text?: string; active?: boolean; disabled?: boolean; run: () => void } | 'sep';

function ToolButtons({ tools }: { tools: Tool[] }) {
  return <>{tools.map((tool, index) => tool === 'sep'
    ? <span key={`sep-${index}`} className="page-editor-sep" aria-hidden="true" />
    : <button
        key={tool.label}
        type="button"
        className={`page-editor-tool${tool.active ? ' is-active' : ''}${tool.text ? ' has-text' : ''}`}
        title={tool.label}
        aria-label={tool.label}
        aria-pressed={tool.active ?? undefined}
        disabled={tool.disabled}
        // Muisklik houdt de cursor in de tekst.
        onMouseDown={event => event.preventDefault()}
        onClick={tool.run}
      >{tool.icon}{tool.text && <span>{tool.text}</span>}</button>)}</>;
}

const CALLOUT_CHOICES: Array<{ variant: CalloutVariant; label: string; icon: JSX.Element }> = [
  { variant: 'info', label: 'Info', icon: <Info size={16} /> },
  { variant: 'tip', label: 'Tip', icon: <Lightbulb size={16} /> },
  { variant: 'let-op', label: 'Let op', icon: <TriangleAlert size={16} /> },
  { variant: 'waarschuwing', label: 'Waarschuwing', icon: <OctagonAlert size={16} /> },
];

/** Waar de cursor in een tabel staat, voor verplaatsen (null buiten een tabel). */
function tablePlace(editor: Editor): { top: number; bottom: number; left: number; right: number; rows: number; cols: number; header: boolean } | null {
  const { state } = editor;
  if (!isInTable(state)) return null;
  try {
    const rect = selectedRect(state);
    const firstCell = rect.table.firstChild?.firstChild;
    return {
      top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
      rows: rect.map.height, cols: rect.map.width,
      header: firstCell?.type.name === 'tableHeader',
    };
  } catch {
    return null;
  }
}

function Toolbar({ editor, onInsert }: { editor: Editor; onInsert: (anchor: DOMRect) => void }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: ed }) => {
      const place = tablePlace(ed);
      const cellAlign = (ed.getAttributes('tableCell').align ?? ed.getAttributes('tableHeader').align ?? null) as string | null;
      return {
        p: ed.isActive('paragraph'),
        h1: ed.isActive('heading', { level: 1 }),
        h2: ed.isActive('heading', { level: 2 }),
        h3: ed.isActive('heading', { level: 3 }),
        bold: ed.isActive('bold'),
        italic: ed.isActive('italic'),
        underline: ed.isActive('underline'),
        strike: ed.isActive('strike'),
        link: ed.isActive('link'),
        bullet: ed.isActive('bulletList'),
        ordered: ed.isActive('orderedList'),
        task: ed.isActive('taskList'),
        quote: ed.isActive('blockquote'),
        code: ed.isActive('codeBlock'),
        canUndo: ed.can().undo(),
        canRedo: ed.can().redo(),
        table: place,
        canMerge: place ? ed.can().mergeCells() : false,
        canSplit: place ? ed.can().splitCell() : false,
        cellAlign,
        callout: ed.isActive('callout') ? calloutVariant(ed.getAttributes('callout').variant) : null,
        details: ed.isActive('details'),
      };
    },
  });
  const chain = () => editor.chain().focus();
  const setLink = () => {
    const previous = (editor.getAttributes('link').href as string | undefined) ?? '';
    const href = window.prompt('Waar moet de link heen? Leeg laten haalt de link weg.', previous);
    if (href === null) return;
    const value = href.trim();
    if (!value) { chain().extendMarkRange('link').unsetLink().run(); return; }
    if (!isAllowedPageLink(value)) {
      window.alert('Een link mag naar https://, http://, mailto: of tel:.');
      return;
    }
    chain().extendMarkRange('link').setLink({ href: value }).run();
  };
  // Rijen en kolommen verplaatsen: prosemirror-tables kent het, Tiptap heeft
  // er geen opdracht voor. Eén stap per klik, binnen de tabel.
  const moveRow = (step: -1 | 1) => {
    const place = tablePlace(editor);
    if (!place) return;
    const from = step < 0 ? place.top : place.bottom - 1;
    const to = from + step;
    if (to < 0 || to >= place.rows) return;
    moveTableRow({ from, to })(editor.state, editor.view.dispatch);
    editor.commands.focus();
  };
  const moveColumn = (step: -1 | 1) => {
    const place = tablePlace(editor);
    if (!place) return;
    const from = step < 0 ? place.left : place.right - 1;
    const to = from + step;
    if (to < 0 || to >= place.cols) return;
    moveTableColumn({ from, to })(editor.state, editor.view.dispatch);
    editor.commands.focus();
  };

  const tools: Tool[] = [
    { label: 'Tekst', icon: <Pilcrow size={16} />, active: state.p, run: () => chain().setParagraph().run() },
    { label: 'Kop 1', icon: <Heading1 size={16} />, active: state.h1, run: () => chain().toggleHeading({ level: 1 }).run() },
    { label: 'Kop 2', icon: <Heading2 size={16} />, active: state.h2, run: () => chain().toggleHeading({ level: 2 }).run() },
    { label: 'Kop 3', icon: <Heading3 size={16} />, active: state.h3, run: () => chain().toggleHeading({ level: 3 }).run() },
    'sep',
    { label: 'Vet', icon: <Bold size={16} />, active: state.bold, run: () => chain().toggleBold().run() },
    { label: 'Cursief', icon: <Italic size={16} />, active: state.italic, run: () => chain().toggleItalic().run() },
    { label: 'Onderstrepen', icon: <UnderlineIcon size={16} />, active: state.underline, run: () => chain().toggleUnderline().run() },
    { label: 'Doorhalen', icon: <Strikethrough size={16} />, active: state.strike, run: () => chain().toggleStrike().run() },
    { label: 'Link', icon: <Link2 size={16} />, active: state.link, run: setLink },
    'sep',
    { label: 'Opsomming', icon: <List size={16} />, active: state.bullet, run: () => chain().toggleBulletList().run() },
    { label: 'Nummering', icon: <ListOrdered size={16} />, active: state.ordered, run: () => chain().toggleOrderedList().run() },
    { label: 'Takenlijst', icon: <ListChecks size={16} />, active: state.task, run: () => chain().toggleTaskList().run() },
    { label: 'Citaat', icon: <Quote size={16} />, active: state.quote, run: () => chain().toggleBlockquote().run() },
    { label: 'Code', icon: <Braces size={16} />, active: state.code, run: () => chain().toggleCodeBlock().run() },
    // Via runPageBlock: Tiptap zette na de lijn de selectie op het blok erna,
    // en de volgende toets overschreef dat (zie cursorOnText in PageBlockMenu).
    { label: 'Scheidingslijn', icon: <Minus size={16} />, run: () => { runPageBlock(editor, 'scheidingslijn'); } },
    'sep',
    { label: 'Ongedaan maken', icon: <Undo2 size={16} />, disabled: !state.canUndo, run: () => chain().undo().run() },
    { label: 'Opnieuw', icon: <Redo2 size={16} />, disabled: !state.canRedo, run: () => chain().redo().run() },
  ];

  const place = state.table;
  const tableTools: Tool[] = place ? [
    { label: 'Rij erboven', icon: <BetweenHorizontalStart size={16} />, run: () => chain().addRowBefore().run() },
    { label: 'Rij eronder', icon: <BetweenHorizontalEnd size={16} />, run: () => chain().addRowAfter().run() },
    { label: 'Kolom links', icon: <BetweenVerticalStart size={16} />, run: () => chain().addColumnBefore().run() },
    { label: 'Kolom rechts', icon: <BetweenVerticalEnd size={16} />, run: () => chain().addColumnAfter().run() },
    'sep',
    { label: 'Rij omhoog', icon: <ArrowUp size={16} />, disabled: place.top <= 0, run: () => moveRow(-1) },
    { label: 'Rij omlaag', icon: <ArrowDown size={16} />, disabled: place.bottom >= place.rows, run: () => moveRow(1) },
    { label: 'Kolom naar links', icon: <ArrowLeft size={16} />, disabled: place.left <= 0, run: () => moveColumn(-1) },
    { label: 'Kolom naar rechts', icon: <ArrowRight size={16} />, disabled: place.right >= place.cols, run: () => moveColumn(1) },
    'sep',
    { label: 'Kopregel', icon: <PanelTop size={16} />, active: place.header, run: () => chain().toggleHeaderRow().run() },
    { label: 'Cellen samenvoegen', icon: <TableCellsMerge size={16} />, disabled: !state.canMerge, run: () => chain().mergeCells().run() },
    { label: 'Cel splitsen', icon: <TableCellsSplit size={16} />, disabled: !state.canSplit, run: () => chain().splitCell().run() },
    'sep',
    { label: 'Links uitlijnen', icon: <AlignLeft size={16} />, active: !state.cellAlign || state.cellAlign === 'left', run: () => chain().setCellAttribute('align', null).run() },
    { label: 'Midden uitlijnen', icon: <AlignCenter size={16} />, active: state.cellAlign === 'center', run: () => chain().setCellAttribute('align', 'center').run() },
    { label: 'Rechts uitlijnen', icon: <AlignRight size={16} />, active: state.cellAlign === 'right', run: () => chain().setCellAttribute('align', 'right').run() },
    'sep',
    { label: 'Rij verwijderen', icon: <Trash2 size={15} />, text: 'Rij', disabled: place.rows <= 1, run: () => chain().deleteRow().run() },
    { label: 'Kolom verwijderen', icon: <Trash2 size={15} />, text: 'Kolom', disabled: place.cols <= 1, run: () => chain().deleteColumn().run() },
    { label: 'Tabel verwijderen', icon: <Trash2 size={15} />, text: 'Tabel', run: () => chain().deleteTable().run() },
  ] : [];

  const calloutTools: Tool[] = state.callout ? [
    ...CALLOUT_CHOICES.map(choice => ({
      label: choice.label,
      icon: choice.icon,
      active: state.callout === choice.variant,
      run: () => { chain().updateAttributes('callout', { variant: choice.variant }).run(); },
    })),
    'sep' as const,
    { label: 'Kader weghalen', icon: <Trash2 size={15} />, text: 'Kader weg', run: () => chain().lift('callout').run() },
  ] : [];

  return (
    <>
      <div className="page-editor-toolbar" role="toolbar" aria-label="Opmaak">
        <button
          type="button"
          className="page-editor-tool page-editor-insert"
          title="Blok invoegen (of typ / in de tekst)"
          aria-label="Blok invoegen"
          onMouseDown={event => event.preventDefault()}
          onClick={event => onInsert(event.currentTarget.getBoundingClientRect())}
        ><Plus size={18} /></button>
        <span className="page-editor-sep" aria-hidden="true" />
        <ToolButtons tools={tools} />
      </div>
      {place && <div className="page-editor-subbar" role="toolbar" aria-label="Tabel">
        <span className="page-editor-subbar-label">Tabel</span>
        <ToolButtons tools={tableTools} />
      </div>}
      {state.callout && <div className="page-editor-subbar" role="toolbar" aria-label="Callout">
        <span className="page-editor-subbar-label">Callout</span>
        <ToolButtons tools={calloutTools} />
      </div>}
      {state.details && !place && !state.callout && <div className="page-editor-subbar" role="toolbar" aria-label="Uitklapper">
        <span className="page-editor-subbar-label">Uitklapper</span>
        <ToolButtons tools={[{ label: 'Uitklapper weghalen', icon: <Trash2 size={15} />, text: 'Uitklapper weg', run: () => chain().unsetDetails().run() }]} />
      </div>}
    </>
  );
}

/** Het versiepaneel (stap 1A-3b): de lijst, een voorvertoning, en terugzetten. */
function VersionsPanel({ documentId, organizationId, canRestore, nameOf, onRestore, onClose }: {
  documentId: string;
  organizationId: string;
  canRestore: boolean;
  nameOf: (userId: string) => string;
  onRestore: (version: PageVersionSummary) => void;
  onClose: () => void;
}) {
  const [versions, setVersions] = useState<PageVersionSummary[] | null>(null);
  const [selected, setSelected] = useState<PageVersionSummary | null>(null);
  const [preview, setPreview] = useState<{ title: string; body: unknown } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listPageVersions(documentId, organizationId)
      .then(rows => { if (!cancelled) setVersions(rows); })
      .catch(err => { if (!cancelled) setError((err as { message?: string } | null)?.message || 'De versies konden niet worden geladen.'); });
    return () => { cancelled = true; };
  }, [documentId, organizationId]);

  useEffect(() => {
    if (!selected) { setPreview(null); return; }
    let cancelled = false;
    loadPageVersion(selected.id, organizationId)
      .then(row => { if (!cancelled) setPreview(row); })
      .catch(err => { if (!cancelled) setError((err as { message?: string } | null)?.message || 'Deze versie kon niet worden geladen.'); });
    return () => { cancelled = true; };
  }, [selected, organizationId]);

  return (
    <aside className="page-versions" aria-label="Versies">
      <div className="page-versions-head">
        <strong>Versies</strong>
        <button type="button" className="page-editor-close" onClick={onClose} aria-label="Versies sluiten"><X size={16} /></button>
      </div>
      {error && <p className="page-versions-empty">{error}</p>}
      {!error && versions === null && <p className="page-versions-empty">Laden…</p>}
      {!error && versions?.length === 0 && <p className="page-versions-empty">Nog geen versies. Een versie komt er bij als je de pagina sluit na het bewerken.</p>}
      {versions && versions.length > 0 && <ol className="page-versions-list">
        {versions.map(version => <li key={version.id}>
          <button type="button" className={`page-versions-item${selected?.id === version.id ? ' is-active' : ''}`} onClick={() => setSelected(version)}>
            <span className="page-versions-num">Versie {version.version}</span>
            <span className="page-versions-meta">{REASON_LABEL[version.reason] ?? version.reason} · {version.created_by ? nameOf(version.created_by) : 'onbekend'} · {whenLabel(version.created_at)}</span>
          </button>
        </li>)}
      </ol>}
      {selected && <div className="page-versions-preview">
        <div className="page-versions-preview-head">
          <span>Zo zag versie {selected.version} eruit</span>
          {canRestore && <button type="button" className="btn btn-primary" onClick={() => onRestore(selected)}>Deze versie terugzetten</button>}
        </div>
        {preview ? <VersionPreview title={preview.title} body={preview.body} /> : <p className="page-versions-empty">Laden…</p>}
      </div>}
    </aside>
  );
}

/** Een versie alleen-lezen, met dezelfde blokken als de editor. Past hij
 *  niet in deze editor, dan zeggen we dat, in plaats van een lege pagina. */
function VersionPreview({ title, body }: { title: string; body: unknown }) {
  const editor = useEditor({ extensions: pageEditorExtensions({ placeholder: '' }), editable: false, content: '' }, []);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!editor) return;
    const fit = pageBodyFit(editor.schema, body);
    setProblem(fit.ok ? null : fit.unknown.length > 0 ? TOO_NEW_MESSAGE : BROKEN_MESSAGE);
    editor.commands.setContent(fit.ok ? body as JSONContent : '', { emitUpdate: false });
  }, [editor, body]);
  return <div className="page-versions-sheet">
    <h2 className="page-versions-title">{title || 'Naamloze pagina'}</h2>
    {problem && <p className="page-versions-empty">{problem}</p>}
    <EditorContent editor={editor} className="page-prose" />
  </div>;
}
