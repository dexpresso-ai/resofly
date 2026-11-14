/**
 * Tests voor de geschiedenis per werktabblad (tabHistory.ts). Draaien met:  npm test
 *
 * Wat terug in een tabblad doet: eerst de vorige pagina's, dan omhoog langs
 * het kruimelpad tot het dashboard. Een tabblad dat uit een ander kwam, gaat
 * aan het eind terug naar dat tabblad.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppData } from '../types';
import { TabHistory, upSteps, upView, viewKey, MAX_TAB_HISTORY, type TabEntry, type TabHistoryContext, type TabView } from './tabHistory.ts';

const data = {
  projects: [{ id: 'p1', name: 'WOW – Implementatie' }, { id: 'p2', name: 'Huisstijl' }],
  clients: [{ id: 'c1', name: 'Bakkerij De Korenaar' }],
  galleries: [{ id: 'g1', title: 'Bruiloft' }],
  companySettings: null,
} as unknown as AppData;

function view(page: string, extra: Partial<TabView> = {}): TabView {
  return { page, projectId: null, clientId: null, galleryId: null, statsReportId: null, settingsTab: null, ...extra };
}

const context: TabHistoryContext = {
  data,
  home: null,
  isValid: (v) => v.page !== 'project' || data.projects.some(p => p.id === v.projectId),
};

/** Een tabblad dat je laat navigeren zoals main.tsx dat doet: na elke render observe. */
function tab(history = new TabHistory(), id = 't1', start = view('dashboard')) {
  let current = start;
  const entries = (): TabEntry[] => [{ id, view: current }];
  history.observe(entries(), id, context);
  return {
    history,
    get current() { return current; },
    go(next: TabView) { current = next; history.observe(entries(), id, context); },
    steps() { return history.steps(entries(), id, context); },
    back() {
      const action = history.back(entries(), id, 1, context);
      if (action.kind === 'view') current = action.view;
      history.observe(entries(), id, context);
      return action;
    },
  };
}

/** Meerdere tabbladen: id → wat het toont. */
function tabs(views: Record<string, TabView>): TabEntry[] {
  return Object.entries(views).map(([id, v]) => ({ id, view: v }));
}

test('omhoog is de terugpijl van het kruimelpad', () => {
  assert.equal(upView(view('dashboard'), data, null), null);
  assert.deepEqual(upView(view('project', { projectId: 'p1' }), data, null), view('projects'));
  assert.deepEqual(upView(view('projects'), data, null), view('dashboard'));
  assert.deepEqual(upView(view('gallery', { galleryId: 'g1', projectId: 'p1' }), data, null), view('project', { projectId: 'p1' }));
  assert.deepEqual(upView(view('report', { statsReportId: 'r1' }), data, null), view('stats'));
  assert.deepEqual(upView(view('settings', { settingsTab: 'agenda' }), data, null), view('dashboard'));
  assert.equal(upSteps(view('gallery', { galleryId: 'g1', projectId: 'p1' }), data, null), 3);
  assert.equal(upSteps(view('dashboard'), data, null), 0);
});

test('in een losse app is het begin van de app het eind van terug', () => {
  const home = { page: 'invoices', label: 'Financiën', pages: ['invoices', 'quotes'] };
  assert.deepEqual(upView(view('quotes'), data, home), view('invoices'));
  assert.equal(upSteps(view('invoices'), data, home), 0);
});

test('terug gaat langs de pagina’s waar het tabblad stond, de laatste eerst', () => {
  const t = tab();
  t.go(view('projects'));
  t.go(view('project', { projectId: 'p1' }));
  t.go(view('client', { clientId: 'c1' }));
  assert.equal(t.steps(), 3);
  assert.deepEqual(t.back(), { kind: 'view', view: view('project', { projectId: 'p1' }) });
  assert.deepEqual(t.back(), { kind: 'view', view: view('projects') });
  assert.deepEqual(t.back(), { kind: 'view', view: view('dashboard') });
  assert.equal(t.steps(), 0);
  assert.deepEqual(t.back(), { kind: 'none' });
});

test('terugzetten telt niet als een nieuwe stap', () => {
  const t = tab();
  t.go(view('clients'));
  t.back();
  assert.equal(t.steps(), 0);
  // En daarna gewoon weer verder.
  t.go(view('tickets'));
  assert.equal(t.steps(), 1);
});

test('zonder geschiedenis gaat terug omhoog, tot het dashboard', () => {
  // Na herladen staat het tabblad op een project, zonder geschiedenis.
  const t = tab(new TabHistory(), 't1', view('project', { projectId: 'p2' }));
  assert.equal(t.steps(), 2);
  assert.deepEqual(t.back(), { kind: 'view', view: view('projects') });
  assert.deepEqual(t.back(), { kind: 'view', view: view('dashboard') });
  assert.deepEqual(t.back(), { kind: 'none' });
});

test('na de geschiedenis nog omhoog vanaf de oudste pagina', () => {
  const t = tab(new TabHistory(), 't1', view('projects'));
  t.go(view('project', { projectId: 'p1' }));
  // Eén terug naar Projecten, en van daar één omhoog naar het dashboard.
  assert.equal(t.steps(), 2);
  t.back();
  t.back();
  assert.equal(t.current.page, 'dashboard');
});

test('dezelfde pagina nog eens openen is geen stap', () => {
  const t = tab();
  t.go(view('projects'));
  t.go(view('projects'));
  assert.equal(t.steps(), 1);
});

test('een verwijderd project valt uit de geschiedenis', () => {
  const t = tab();
  t.go(view('project', { projectId: 'weg' }));
  t.go(view('tickets'));
  // 'weg' bestaat niet: terug slaat het over en gaat naar het dashboard.
  assert.equal(t.steps(), 1);
  assert.deepEqual(t.back(), { kind: 'view', view: view('dashboard') });
});

test('de geschiedenis blijft binnen de grens', () => {
  const t = tab();
  for (let i = 0; i < MAX_TAB_HISTORY + 20; i += 1) t.go(view(i % 2 ? 'projects' : 'clients'));
  assert.ok(t.steps() <= MAX_TAB_HISTORY + 1);
});

test('elk tabblad heeft zijn eigen geschiedenis', () => {
  const history = new TabHistory();
  history.observe(tabs({ a: view('dashboard'), b: view('tickets') }), 'a', context);
  history.observe(tabs({ a: view('projects'), b: view('tickets') }), 'a', context);
  // Wisselen naar b is geen stap in a of b.
  history.observe(tabs({ a: view('projects'), b: view('tickets') }), 'b', context);
  assert.equal(history.steps(tabs({ a: view('projects'), b: view('tickets') }), 'b', context), 1, 'alleen omhoog naar het dashboard');
  history.observe(tabs({ a: view('projects'), b: view('tickets') }), 'a', context);
  assert.equal(history.steps(tabs({ a: view('projects'), b: view('tickets') }), 'a', context), 1);
  assert.deepEqual(history.back(tabs({ a: view('projects'), b: view('tickets') }), 'a', 1, context), { kind: 'view', view: view('dashboard') });
});

test('een tabblad dat je vanuit een ander opende, gaat aan het eind terug naar dat tabblad', () => {
  const history = new TabHistory();
  const project = view('project', { projectId: 'p1' });
  history.observe(tabs({ a: view('projects') }), 'a', context);
  history.observe(tabs({ a: project }), 'a', context);
  // De galerij opent in een nieuw tabblad.
  const gallery = view('gallery', { galleryId: 'g1', projectId: 'p1' });
  const both = tabs({ a: project, g: gallery });
  history.observe(both, 'g', context);
  // Eén stap terug naar het project, plus wat dat tabblad zelf nog heeft
  // (Projecten, dan het dashboard). Niet omhoog langs het project in de galerij.
  assert.equal(history.steps(both, 'g', context), 3);
  assert.deepEqual(history.back(both, 'g', 1, context), { kind: 'opener', tabId: 'a' });
  // main.tsx sluit het tabblad en zet a voorop: evenveel stappen als er nog over waren.
  history.observe(tabs({ a: project }), 'a', context);
  assert.equal(history.steps(tabs({ a: project }), 'a', context), 2);
});

test('is het tabblad waar je vandaan kwam al dicht, dan gewoon omhoog', () => {
  const history = new TabHistory();
  history.observe(tabs({ a: view('dashboard') }), 'a', context);
  history.observe(tabs({ a: view('dashboard'), n: view('dashboard') }), 'n', context);
  assert.equal(history.steps(tabs({ a: view('dashboard'), n: view('dashboard') }), 'n', context), 1);
  history.observe(tabs({ n: view('dashboard') }), 'n', context);
  assert.equal(history.steps(tabs({ n: view('dashboard') }), 'n', context), 0);
});

test('tabbladen na herstellen of een andere organisatie zijn niet "vanuit" het opstarttabblad geopend', () => {
  const history = new TabHistory();
  history.observe(tabs({ boot: view('dashboard') }), 'boot', context);
  // restoreTabsForOrganization: een nieuwe set, het opstarttabblad is weg.
  const restored = tabs({ x: view('projects'), y: view('clients') });
  history.observe(restored, 'y', context);
  assert.equal(history.steps(restored, 'y', context), 1, 'omhoog, geen opener');
});

test('een rapportage die zijn id krijgt, is geen nieuwe stap', () => {
  const t = tab();
  t.go(view('stats'));
  t.go(view('report', { statsReportId: 'nieuw:1' }));
  t.history.renameReport('nieuw:1', 'r1');
  t.go(view('report', { statsReportId: 'r1' }));
  assert.equal(t.steps(), 2);
  assert.deepEqual(t.back(), { kind: 'view', view: view('stats') });
});

test('de sleutel kent alles wat terug moet herstellen', () => {
  assert.notEqual(viewKey(view('settings', { settingsTab: 'agenda' })), viewKey(view('settings', { settingsTab: 'team' })));
  assert.notEqual(viewKey(view('report', { statsReportId: 'a' })), viewKey(view('report', { statsReportId: 'b' })));
});
