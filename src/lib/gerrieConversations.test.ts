/**
 * Tests voor Gerrie → Gesprekken: hoe de lijst en een teruggelezen gesprek eruitzien,
 * en dat zoeken en de afscherming doen wat ze beloven.
 * Draaien met:  npm test
 *
 * De afscherming zit in de database en de edge function; die draaien hier niet.
 * Wat hier wel kan: nagaan dat de migratie, de edge function en de app dezelfde
 * grenzen noemen. Haalt iemand er één weg, dan faalt het hier.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildThread, conversationTitle, dayHeading, groupConversations, ilikePattern, listTimeLabel, mergeSearchHits,
  pastProposalStatus, snippetAround, splitOnQuery, startedLabel, TITLE_LIMIT,
  type ConversationSummary,
} from './gerrieConversations.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
// Donderdag 12 november 2026, 15:00 lokale tijd.
const NOW = new Date(2026, 10, 12, 15, 0, 0);
const at = (dayOffset: number, hour = 10, minute = 0) => new Date(2026, 10, 12 + dayOffset, hour, minute).toISOString();
const conv = (id: string, updatedAt: string, extra: Partial<ConversationSummary> = {}): ConversationSummary =>
  ({ id, title: `Gesprek ${id}`, createdAt: updatedAt, updatedAt, ...extra });

test('de titel: het begin van de eerste vraag, met … als hij is afgekapt', () => {
  assert.equal(conversationTitle('Welke facturen staan open?'), 'Welke facturen staan open?');
  assert.equal(conversationTitle('  twee   spaties\nen een regel  '), 'twee spaties en een regel');
  assert.equal(conversationTitle(''), 'Gesprek zonder titel');
  assert.equal(conversationTitle(null), 'Gesprek zonder titel');
  const cut = 'Maak een overzicht van alle openstaande facturen per klant, '.slice(0, TITLE_LIMIT);
  assert.equal(cut.length, TITLE_LIMIT);
  assert.equal(conversationTitle(cut), 'Maak een overzicht van alle openstaande facturen per klant…');
});

test('de lijst in blokken: vandaag, gisteren, deze week, deze maand, dan per maand', () => {
  const groups = groupConversations([
    conv('a', at(0, 9)), conv('b', at(-1)), conv('c', at(-3)), conv('d', at(-12)),
    conv('e', at(-40)), conv('f', new Date(2025, 11, 3).toISOString()),
  ], NOW);
  assert.deepEqual(groups.map((g) => g.label), ['Vandaag', 'Gisteren', 'Afgelopen 7 dagen', 'Afgelopen 30 dagen', 'Oktober', 'December 2025']);
  assert.deepEqual(groups.map((g) => g.items.map((i) => i.id)), [['a'], ['b'], ['c'], ['d'], ['e'], ['f']]);
});

test('tijd naast een gesprek: kort, en gewoon Nederlands', () => {
  assert.equal(listTimeLabel(at(0, 9, 5), NOW), '09:05');
  assert.equal(listTimeLabel(at(-1), NOW), 'gisteren');
  assert.equal(listTimeLabel(at(-3), NOW), 'ma');
  assert.equal(listTimeLabel(at(-20), NOW), '23 okt');
  assert.equal(listTimeLabel(new Date(2025, 2, 4).toISOString(), NOW), '4 mrt 2025');
  assert.equal(listTimeLabel('geen datum', NOW), '');
});

test('dagen in een gesprek en wanneer het begon', () => {
  assert.equal(dayHeading(at(0), NOW), 'Vandaag');
  assert.equal(dayHeading(at(-1), NOW), 'Gisteren');
  assert.equal(dayHeading(at(-3), NOW), 'Maandag 9 november');
  assert.equal(dayHeading(new Date(2025, 0, 2).toISOString(), NOW), 'Donderdag 2 januari 2025');
  assert.equal(startedLabel(at(0, 10, 31), NOW), 'Gestart vandaag om 10:31');
  assert.equal(startedLabel(at(-5, 8, 0), NOW), 'Gestart op 7 november om 08:00');
});

test('wat er met een voorstel gebeurde', () => {
  assert.equal(pastProposalStatus('proposed'), 'open');
  assert.equal(pastProposalStatus('executed'), 'done');
  assert.equal(pastProposalStatus('auto_executed'), 'done');
  assert.equal(pastProposalStatus('confirmed'), 'approved');
  assert.equal(pastProposalStatus('cancelled'), 'rejected');
  assert.equal(pastProposalStatus('failed'), 'failed');
  assert.equal(pastProposalStatus(null), 'open');
  assert.equal(pastProposalStatus('iets nieuws'), 'open');
});

test('een gesprek terugbouwen: voorstellen bij hun bericht, lege beurten weg', () => {
  const thread = buildThread(
    [
      { id: 'm1', role: 'user', content: 'Stuur factuur 2026-014', created_at: at(0, 9) },
      { id: 'm2', role: 'assistant', content: 'Ik heb hem klaargezet.', created_at: at(0, 9, 1) },
      { id: 'm3', role: 'assistant', content: '   ', created_at: at(0, 9, 2) },
      { id: 'm4', role: 'assistant', content: '', created_at: at(0, 9, 3) },
      { id: 'm5', role: 'system', content: 'raar', created_at: at(0, 9, 4) },
    ],
    [
      { id: 'a2', message_id: 'm4', status: 'proposed', title: 'Herinnering versturen', sub: '', created_at: at(0, 9, 3) },
      { id: 'a1', message_id: 'm2', status: 'executed', title: 'Factuur 2026-014 versturen', sub: 'naar klant@example.nl', created_at: at(0, 9, 1) },
      { id: 'a3', message_id: null, status: 'executed', title: 'Los', sub: '', created_at: at(0, 9, 5) },
    ],
  );
  assert.deepEqual(thread.map((m) => m.id), ['m1', 'm2', 'm4', 'm5']);
  assert.deepEqual(thread[1].proposals, [{ auditId: 'a1', title: 'Factuur 2026-014 versturen', sub: 'naar klant@example.nl', status: 'done' }]);
  assert.equal(thread[2].text, '');
  assert.equal(thread[2].proposals[0].status, 'open');
  // Een onbekende rol is nooit "Gerrie": liever als jouw bericht dan als iets wat hij zei.
  assert.equal(thread[3].role, 'user');
});

test('zoeken: jokers uit LIKE en PostgREST worden letterlijk', () => {
  assert.equal(ilikePattern('factuur'), '%factuur%');
  assert.equal(ilikePattern('  50%  korting '), '%50\\% korting%');
  assert.equal(ilikePattern('a_b'), '%a\\_b%');
  assert.equal(ilikePattern('c:\\map'), '%c:\\\\map%');
  assert.equal(ilikePattern('alles*'), '%alles %');
});

test('zoeken: het stukje rond de treffer, en de treffer gemarkeerd', () => {
  const text = 'Goedemorgen! Er staan drie facturen open bij Bakkerij De Korenaar, samen € 4.210. De oudste is van 3 oktober en inmiddels 40 dagen te laat.';
  const snippet = snippetAround(text, 'korenaar', 30);
  assert.ok(snippet);
  assert.match(snippet!, /^….*Korenaar.*…$/);
  assert.ok(snippet!.length < text.length);
  assert.equal(snippetAround(text, 'niet aanwezig'), null);
  assert.equal(snippetAround('kort', 'kort'), 'kort');

  assert.deepEqual(splitOnQuery('Factuur en factuur', 'FACTUUR'), [
    { text: 'Factuur', hit: true }, { text: ' en ', hit: false }, { text: 'factuur', hit: true },
  ]);
  assert.deepEqual(splitOnQuery('iets', 'x'), [{ text: 'iets', hit: false }]);
});

test('zoeken: titel- en berichttreffers samen, één keer per gesprek, nieuwste eerst', () => {
  const merged = mergeSearchHits(
    [conv('a', at(-2)), conv('b', at(0))],
    [conv('a', at(-2), { snippet: '…in het bericht…' }), conv('c', at(-1), { snippet: 'c' })],
  );
  assert.deepEqual(merged.map((c) => c.id), ['b', 'c', 'a']);
  assert.equal(merged.find((c) => c.id === 'a')?.snippet, '…in het bericht…');
});

test('afscherming: een chat is van jou alleen, het toezicht op agents blijft', () => {
  const sql = read('../../supabase/migrations/20261112120000_gerrie_gesprekken.sql');
  // Lezen: eigen gesprekken, of een verslag dat geen chat is voor owner/admin.
  assert.match(sql, /create policy "ai_conversations read"[\s\S]*created_by = auth\.uid\(\)[\s\S]*kind <> 'chat'[\s\S]*'owner', 'admin'/);
  assert.match(sql, /create policy "ai_messages read"[\s\S]*created_by = auth\.uid\(\)[\s\S]*c\.kind <> 'chat'[\s\S]*'owner', 'admin'/);
  // Een gesprek aan een agent is nooit een chat, ook als de runner het pas later koppelt.
  assert.match(sql, /new\.agent_run_id is not null or new\.agent_id is not null then\s+new\.kind := 'agent_run'/);
  // De backfill mag de volgorde van de lijst niet op de migratiedatum zetten.
  assert.match(sql, /disable trigger ai_conversations_touch_updated_at[\s\S]*update public\.ai_conversations[\s\S]*enable trigger ai_conversations_touch_updated_at/);

  const fn = read('../../supabase/functions/gerrie-agent/index.ts');
  const del = fn.slice(fn.indexOf("action === 'delete_conversation'"), fn.indexOf("// Commandocentrum — missieplan"));
  // Verwijderen: in één delete op id, organisatie, eigenaar én soort.
  assert.match(del, /\.delete\(\)\s*\.eq\('id', id\)\.eq\('organization_id', organizationId\)\.eq\('created_by', user\.id\)\.eq\('kind', 'chat'\)/);
  // Verder praten kan alleen in een eigen chat.
  assert.match(fn, /\.eq\('id', conversationId\)\.eq\('organization_id', organizationId\)\.eq\('created_by', user\.id\)\.eq\('kind', 'chat'\)/);
  assert.match(fn, /createConversation\(organizationId, user\.id, message, 'chat'\)/);

  // Elke plek die een gesprek maakt, zegt wat voor gesprek het is.
  const core = read('../../supabase/functions/_shared/gerrieCore.ts');
  const runner = read('../../supabase/functions/gerrie-agent-runner/index.ts');
  for (const source of [core, runner, fn]) {
    for (const call of source.matchAll(/await createConversation\(([^;]*)\);/g)) {
      assert.match(call[1], /'(chat|agent_run|agent_preview|agent_builder|mission)'\)?$/, `createConversation zonder soort: ${call[0]}`);
    }
  }
  assert.match(runner, /`Agent: \$\{name\} — \$\{todayIso\(\)\}`, 'agent_run'/);

  // De app filtert zelf ook: alleen jouw chats in deze organisatie.
  const api = read('./gerrieConversations-api.ts');
  for (const query of api.split("supabase.from('ai_conversations')").slice(1)) {
    assert.match(query, /\.eq\('organization_id', organizationId\)\.eq\('created_by', userId\)\.eq\('kind', 'chat'\)/);
  }
});
