import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AI_CONSENT_KEYS, AI_CONSENT_POINTS, AI_TERMS_VERSION, aiConsentState, allPointsChecked, consentIsActive, consentIsOutdated,
  consentSinceLabel,
} from './aiConsent.ts';
import { buildPermissions } from './permissions.ts';

/**
 * Gerrie aanzetten (2026-11-12): de app-kant. De database en de edge
 * functions staan in supabase/functions/_shared/aiConsent.test.ts.
 */

const on = { enabled: true, terms_version: AI_TERMS_VERSION };

test('drie punten, in vaste volgorde, met een titel, uitleg en bevestiging', () => {
  assert.deepEqual([...AI_CONSENT_KEYS], ['gegevens_lezen', 'kan_fouten_maken', 'geen_eigen_beslissingen']);
  for (const point of AI_CONSENT_POINTS) {
    assert.ok(point.title.length > 5 && point.text.length > 40 && point.confirm.startsWith('Ik begrijp'), point.key);
  }
});

test('de punten zeggen wat de vraag was: lezen en voorstellen, fouten, niets zelf beslissen', () => {
  const [lezen, fouten, beslissen] = AI_CONSENT_POINTS;
  assert.match(lezen.confirm, /leest .* handelingen voorstelt/);
  assert.match(fouten.confirm, /fouten kan maken/);
  assert.match(beslissen.confirm, /niets zelf beslist/);
  // De eigen AI mag rechtstreeks uitvoeren als je dat per koppeling aanzet.
  // De uitleg mag dus niet beweren dat alles altijd alleen klaargezet wordt.
  assert.match(beslissen.text, /alleen zelf iets uit als jij dat per koppeling aanzet/);
});

test('geen modelnaam en geen leverancier in de uitleg', () => {
  const all = AI_CONSENT_POINTS.map(p => `${p.title} ${p.text} ${p.confirm}`).join(' ');
  assert.doesNotMatch(all, /claude|anthropic|sonnet|haiku|opus|openai|gpt/i);
});

test('de knop pas met alle drie de vinkjes', () => {
  assert.equal(allPointsChecked([]), false);
  assert.equal(allPointsChecked(['gegevens_lezen', 'kan_fouten_maken']), false);
  assert.equal(allPointsChecked(new Set(AI_CONSENT_KEYS)), true);
  assert.equal(allPointsChecked([...AI_CONSENT_KEYS, 'iets_anders']), true);
});

test('aan, uit en een oudere tekst', () => {
  assert.equal(consentIsActive(on), true);
  assert.equal(consentIsActive({ enabled: false, terms_version: AI_TERMS_VERSION }), false);
  assert.equal(consentIsActive(null), false);
  assert.equal(consentIsActive({ enabled: true, terms_version: '2025-01-01' }), false);
  assert.equal(consentIsOutdated({ enabled: true, terms_version: '2025-01-01' }), true);
  assert.equal(consentIsOutdated(on), false);
  assert.equal(consentIsOutdated({ enabled: false, terms_version: '2025-01-01' }), false);
});

test('de stand per teamlid voor beheer', () => {
  assert.equal(aiConsentState(on, true), 'on');
  assert.equal(aiConsentState(on, false), 'blocked');
  assert.equal(aiConsentState(null, true), 'off');
  assert.equal(aiConsentState({ enabled: true, terms_version: 'oud' }, true), 'outdated');
});

test('sinds wanneer, in gewone woorden', () => {
  assert.equal(consentSinceLabel({ accepted_at: '2026-11-12T10:00:00Z' }), '12 november 2026');
  assert.equal(consentSinceLabel({ accepted_at: null }), null);
  assert.equal(consentSinceLabel(null), null);
});

// ── De rechten ───────────────────────────────────────────────────────────────

test('zonder akkoord is Gerrie dicht, maar de pagina Gerrie blijft open om hem aan te zetten', () => {
  for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
    const p = buildPermissions({ role }, { aiEnabled: false });
    assert.equal(p.canRead('gerrie'), false, role);
    assert.equal(p.canWrite('gerrie'), false, role);
    assert.equal(p.level('gerrie'), 'none', role);
    assert.equal(p.canOpenPage('gerrie'), true, role);
    assert.equal(p.canWritePage('gerrie'), false, role);
    assert.equal(p.gerrieNeedsConsent, true, role);
    // De rest verandert niet.
    assert.equal(p.canRead('clients'), true, role);
  }
});

test('met akkoord is alles zoals de rol en de modulerechten zeggen', () => {
  const owner = buildPermissions({ role: 'owner' }, { aiEnabled: true });
  assert.equal(owner.canWrite('gerrie'), true);
  assert.equal(owner.gerrieNeedsConsent, false);
  const viewer = buildPermissions({ role: 'viewer' }, { aiEnabled: true });
  assert.equal(viewer.level('gerrie'), 'read');
  // Zonder optie (portaal, laden) gedraagt het zich als voorheen.
  assert.equal(buildPermissions({ role: 'member' }).canRead('gerrie'), true);
});

test('module dicht: geen aanzetscherm, de pagina blijft dicht', () => {
  const closed = buildPermissions({ role: 'member', module_access: { gerrie: 'none' } }, { aiEnabled: false });
  assert.equal(closed.canOpenPage('gerrie'), false);
  assert.equal(closed.gerrieNeedsConsent, false);
  const accountant = buildPermissions({ role: 'accountant' }, { aiEnabled: false });
  assert.equal(accountant.canOpenPage('gerrie'), false);
  assert.equal(accountant.gerrieNeedsConsent, false);
  // Met akkoord maar module dicht: nog steeds dicht. Het akkoord verruimt niets.
  assert.equal(buildPermissions({ role: 'member', module_access: { gerrie: 'none' } }, { aiEnabled: true }).canRead('gerrie'), false);
});

test('"beperkt" gaat over de rechten die iemand kreeg, niet over zijn keuze voor Gerrie', () => {
  assert.equal(buildPermissions({ role: 'member' }, { aiEnabled: false }).isRestricted, false);
  assert.equal(buildPermissions({ role: 'member', module_access: { finance: 'none' } }, { aiEnabled: false }).isRestricted, true);
});

// ── De app-shell ─────────────────────────────────────────────────────────────

const main = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8');
const repository = readFileSync(new URL('./repository.ts', import.meta.url), 'utf8');

test('de app bouwt de rechten met het akkoord, en toont eerst het aanzetscherm', () => {
  assert.match(main, /const aiEnabled = consentIsActive\(organizationContext\.aiConsent\);/);
  assert.match(main, /buildPermissions\(activeMembership, \{ aiEnabled \}\)/);
  const consentPage = main.indexOf("if (page === 'gerrie' && permissions.gerrieNeedsConsent) return <GerrieAanzettenPage");
  const commandCenter = main.indexOf("if (page === 'gerrie') return <GerrieCommandCenter");
  assert.ok(consentPage > 0 && consentPage < commandCenter, 'het aanzetscherm moet vóór het commandocentrum komen');
  // De chat rechtsonder hangt aan canRead('gerrie'), en dus aan het akkoord.
  assert.match(main, /\{permissions\.canRead\('gerrie'\) && <GerrieChat /);
});

test('het akkoord laadt tegelijk met het lidmaatschap', () => {
  const load = repository.slice(repository.indexOf('export async function loadOrganizationContext'), repository.indexOf('export async function setAiConsent'));
  assert.match(load, /\.from\('ai_consents'\)/);
  assert.match(load, /aiConsent = rows\.find\(row => row\.user_id === currentUserId\) \?\? null;/);
  assert.match(repository, /supabase\.rpc\('set_ai_consent', \{/);
});
