/**
 * Waar "terug" heen gaat binnen een werktabblad.
 *
 * Elk werktabblad houdt bij op welke pagina's het stond, zoals een tabblad in
 * de browser. Terug gaat naar de vorige. Is die geschiedenis op (net
 * opgestart, of na herladen), dan gaat terug een niveau omhoog, naar dezelfde
 * pagina als de terugpijl van het kruimelpad: van een project naar
 * Projecten, en van daar naar het dashboard. Op het dashboard is er niets
 * meer, en zet de terugknop de app weg, zoals op de startpagina van elke app.
 *
 * Een tabblad dat je vanuit een ander opende (+, of een galerij), gaat aan
 * het eind terug naar dat tabblad en sluit zichzelf, zoals een tabblad in
 * Chrome dat een link opende. Anders bleef je in de galerij terug omhoog
 * klimmen naar het dashboard, terwijl het project een tabblad verder openstond.
 * De stappen van dat andere tabblad tellen dan ook mee: terug in de galerij is
 * eerst het project, en daarna gewoon verder terug zoals in dat tabblad.
 *
 * Puur (geen React), zodat tabHistory.test.ts er met `node --test` overheen
 * draait. `page` is een string om dezelfde reden als in breadcrumbs.ts.
 */
import type { AppData } from '../types';
// Met .ts: zo laadt node --test dit bestand ook.
import { breadcrumbTrail, type CrumbHome } from './breadcrumbs.ts';

/** Wat een werktabblad toont, voor zover terug ernaar moet kunnen. */
export type TabView = {
  page: string;
  projectId: string | null;
  clientId: string | null;
  galleryId: string | null;
  statsReportId: string | null;
  /** Alleen op de pagina Instellingen: welk onderdeel daar openstond. */
  settingsTab: string | null;
};

export type TabHistoryContext = {
  data: AppData;
  /** In een losse app: het begin van die app in plaats van het dashboard. */
  home: CrumbHome | null;
  /** Bestaat wat deze weergave toont nog, en mag dit teamlid erheen? */
  isValid: (view: TabView) => boolean;
};

/** Een open werktabblad en wat het nu toont. */
export type TabEntry = { id: string; view: TabView };

/** Wat main.tsx moet doen voor een stap terug. */
export type TabBackAction =
  | { kind: 'view'; view: TabView }
  | { kind: 'opener'; tabId: string }
  | { kind: 'none' };

/** Zo ver terug onthouden we per tabblad. Ouder valt eraf. */
export const MAX_TAB_HISTORY = 50;

export function viewKey(view: TabView): string {
  return [view.page, view.projectId ?? '', view.clientId ?? '', view.galleryId ?? '', view.statsReportId ?? '', view.settingsTab ?? ''].join('|');
}

/** Eén niveau omhoog: dezelfde pagina als de terugpijl van het kruimelpad. */
export function upView(view: TabView, data: AppData, home: CrumbHome | null): TabView | null {
  let target = null;
  for (const crumb of breadcrumbTrail(view, data, home)) if (crumb.target) target = crumb.target;
  if (!target) return null;
  return { page: target.page, projectId: target.projectId, clientId: target.clientId, galleryId: target.galleryId, statsReportId: null, settingsTab: null };
}

/** Hoe vaak je vanaf hier omhoog kunt tot het begin. */
export function upSteps(view: TabView, data: AppData, home: CrumbHome | null): number {
  const seen = new Set([viewKey(view)]);
  let steps = 0;
  let cursor = upView(view, data, home);
  // Het pad is kort (hooguit galerij › project › projecten › dashboard); de
  // grens houdt een kring in PAGE_PARENT uit een oneindige lus.
  while (cursor && !seen.has(viewKey(cursor)) && steps < 10) {
    seen.add(viewKey(cursor));
    steps += 1;
    cursor = upView(cursor, data, home);
  }
  return steps;
}

export class TabHistory {
  /** Per tabblad de pagina's ervoor, de laatste bovenaan. */
  private stacks = new Map<string, TabView[]>();
  /** Per tabblad het tabblad van waaruit het geopend werd. */
  private openers = new Map<string, string>();
  /** De tabbladen bij de vorige keer kijken: wat er nieuw bij komt, is net geopend. */
  private known = new Set<string>();
  private last: { tabId: string; key: string; view: TabView } | null = null;

  /**
   * Na elke render: wat staat er nu in het actieve tabblad? Een andere pagina
   * dan de vorige keer, in hetzelfde tabblad, is een stap: de vorige gaat op
   * de stapel. Zo telt het als één stap als een klik setPage, setProjectId en
   * setClientId na elkaar aanroept: we zien alleen waar hij uitkwam.
   */
  observe(tabs: readonly TabEntry[], activeTabId: string, context: TabHistoryContext): void {
    const open = new Set(tabs.map(tab => tab.id));
    const view = tabs.find(tab => tab.id === activeTabId)?.view;
    if (!view) return;
    for (const id of [...this.stacks.keys()]) if (!open.has(id)) this.stacks.delete(id);
    for (const [id, opener] of [...this.openers]) if (!open.has(id) || !open.has(opener)) this.openers.delete(id);

    const previous = this.last;
    const key = viewKey(view);
    const isNew = !this.known.has(activeTabId);
    this.known = open;
    this.last = { tabId: activeTabId, key, view };

    if (previous && previous.tabId !== activeTabId) {
      // Net geopend vanuit het tabblad dat er nog staat. Na herstellen of na een
      // wissel van organisatie is dat tabblad weg: dan geen opener.
      if (isNew && open.has(previous.tabId)) this.openers.set(activeTabId, previous.tabId);
    } else if (previous && previous.key !== key) {
      const stack = this.stacks.get(activeTabId) ?? [];
      stack.push(previous.view);
      if (stack.length > MAX_TAB_HISTORY) stack.splice(0, stack.length - MAX_TAB_HISTORY);
      this.stacks.set(activeTabId, stack);
    }
    this.prune(activeTabId, key, context);
  }

  /**
   * Wat niet meer bestaat (een verwijderd project, een module die dichtging),
   * valt eruit, en ook wat dan twee keer na elkaar staat of gelijk is aan waar
   * je nu bent: anders deed een druk op terug zichtbaar niets.
   */
  private prune(tabId: string, currentKey: string, context: TabHistoryContext) {
    const stack = this.stacks.get(tabId);
    if (!stack) return;
    const kept: TabView[] = [];
    for (const view of stack) {
      if (!context.isValid(view)) continue;
      if (kept.length && viewKey(kept[kept.length - 1]) === viewKey(view)) continue;
      kept.push(view);
    }
    while (kept.length && viewKey(kept[kept.length - 1]) === currentKey) kept.pop();
    if (kept.length) this.stacks.set(tabId, kept);
    else this.stacks.delete(tabId);
  }

  private openerOf(tabId: string, tabs: readonly TabEntry[]): string | null {
    const opener = this.openers.get(tabId);
    return opener && opener !== tabId && tabs.some(tab => tab.id === opener) ? opener : null;
  }

  /**
   * Hoeveel stappen terug dit tabblad heeft. Kwam het uit een ander tabblad,
   * dan horen de stappen van dat tabblad erbij: na de stap terug naar dat
   * tabblad gaat terug daar gewoon verder. Telden we die pas als je er al was,
   * dan kwam er een item bij zonder tik, en dat slaat Chrome over: de volgende
   * druk zette de app weg (zie backButton.ts).
   */
  steps(tabs: readonly TabEntry[], activeTabId: string, context: TabHistoryContext, seen = new Set<string>()): number {
    const tab = tabs.find(entry => entry.id === activeTabId);
    if (!tab || seen.has(activeTabId)) return 0;
    seen.add(activeTabId);
    const stack = this.stacks.get(activeTabId) ?? [];
    const opener = this.openerOf(activeTabId, tabs);
    if (opener && !seen.has(opener)) return stack.length + 1 + this.steps(tabs, opener, context, seen);
    return stack.length + upSteps(stack[0] ?? tab.view, context.data, context.home);
  }

  /** Doet `steps` stappen terug en zegt wat main.tsx moet tonen. */
  back(tabs: readonly TabEntry[], activeTabId: string, steps: number, context: TabHistoryContext): TabBackAction {
    const view = tabs.find(tab => tab.id === activeTabId)?.view;
    if (!view) return { kind: 'none' };
    const stack = this.stacks.get(activeTabId) ?? [];
    let target = view;
    let remaining = steps;
    while (remaining > 0 && stack.length > 0) {
      target = stack.pop()!;
      remaining -= 1;
    }
    if (remaining > 0) {
      const opener = this.openerOf(activeTabId, tabs);
      if (opener) {
        this.openers.delete(activeTabId);
        return { kind: 'opener', tabId: opener };
      }
      while (remaining > 0) {
        const up = upView(target, context.data, context.home);
        if (!up) break;
        target = up;
        remaining -= 1;
      }
    }
    const key = viewKey(target);
    if (key === viewKey(view)) return { kind: 'none' };
    // Zo telt observe het terugzetten niet als een nieuwe stap.
    this.last = { tabId: activeTabId, key, view: target };
    return { kind: 'view', view: target };
  }

  /**
   * Een nieuwe rapportage heeft eerst een tijdelijke sleutel en krijgt na een
   * halve seconde zijn id. Dat is dezelfde pagina, geen stap.
   */
  renameReport(from: string, to: string) {
    const rename = (view: TabView): TabView => (view.statsReportId === from ? { ...view, statsReportId: to } : view);
    for (const [id, stack] of this.stacks) this.stacks.set(id, stack.map(rename));
    if (this.last) {
      const view = rename(this.last.view);
      this.last = { ...this.last, view, key: viewKey(view) };
    }
  }
}
