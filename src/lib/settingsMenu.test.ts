import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ACCOUNTANT_SETTINGS_TABS, SETTINGS_GROUPS, SETTINGS_TAB_IDS, groupSettingsTabs, settingsGroupOf, visibleSettingsTabIds,
} from './settingsMenu.ts';

/**
 * De instellingen in groepen (2026-11-18). Het paneel links, het accountmenu
 * en de pagina zelf lezen alle drie deze indeling; hier staat vast dat elk
 * onderdeel er precies één keer in zit en dat de regels per rol kloppen.
 */

const withCalendar = { canReadCalendar: true };

test('elk onderdeel hoort bij precies één groep', () => {
  const seen = new Map<string, string>();
  for (const group of SETTINGS_GROUPS) {
    assert.ok(group.tabs.length > 0, `groep ${group.id} is leeg`);
    for (const tab of group.tabs) {
      assert.ok(!seen.has(tab), `${tab} staat in ${seen.get(tab)} én in ${group.id}`);
      seen.set(tab, group.id);
    }
  }
  assert.equal(seen.size, SETTINGS_TAB_IDS.length);
  assert.equal(settingsGroupOf('betalen').id, 'geld');
  assert.equal(settingsGroupOf('organisatie').id, 'organisatie');
});

test('elk onderdeel heeft een naam, icoon en uitleg in settingsMenuItems', () => {
  // De groepen bepalen welke onderdelen er zijn; components/settingsMenuItems.ts
  // geeft ze een gezicht (tot november 2026 deed SimplePages dat). Een
  // onderdeel zonder dat gezicht viel stil uit het menu.
  const source = readFileSync(new URL('../components/settingsMenuItems.ts', import.meta.url), 'utf8');
  const meta = source.slice(source.indexOf('const SETTINGS_TAB_META'), source.indexOf('export const SETTINGS_TABS'));
  for (const tab of SETTINGS_TAB_IDS) {
    assert.match(meta, new RegExp(`\\b${tab}: \\{ label: '`), `${tab} mist in SETTINGS_TAB_META`);
  }
});

test('een eigenaar ziet alles, in de volgorde van de groepen', () => {
  assert.deepEqual(visibleSettingsTabIds('owner', withCalendar), SETTINGS_TAB_IDS);
  assert.deepEqual(groupSettingsTabs(SETTINGS_TAB_IDS.map(id => ({ id }))).map(group => group.id),
    ['organisatie', 'werkwijze', 'klant', 'geld', 'koppelingen', 'apparaat']);
});

test('een teamlid ziet AI wel, maar geen beheer en geen API-sleutels', () => {
  const member = visibleSettingsTabIds('member', withCalendar);
  // Tot 18 november verborg het menu AI voor een teamlid, terwijl de pagina
  // het toonde. Zijn eigen AI moet hij zelf kunnen koppelen en loskoppelen.
  assert.ok(member.includes('ai'));
  for (const tab of ['api', 'logboek', 'gegevens', 'boekhouder'] as const) assert.ok(!member.includes(tab), tab);
  // De groep Organisatie houdt voor hem alleen Organisatie & team en Abonnement.
  const organisatie = groupSettingsTabs(member.map(id => ({ id }))).find(group => group.id === 'organisatie');
  assert.deepEqual(organisatie?.tabs.map(tab => tab.id), ['organisatie', 'abonnement']);
});

test('zonder de agenda-module geen onderdeel Agenda', () => {
  assert.ok(!visibleSettingsTabIds('admin', { canReadCalendar: false }).includes('agenda'));
  assert.ok(visibleSettingsTabIds('admin', withCalendar).includes('agenda'));
});

test('de boekhouder ziet alleen zijn vier onderdelen; lege groepen verdwijnen', () => {
  const accountant = visibleSettingsTabIds('accountant', withCalendar);
  assert.deepEqual([...accountant].sort(), [...ACCOUNTANT_SETTINGS_TABS].sort());
  const groups = groupSettingsTabs(accountant.map(id => ({ id })));
  assert.deepEqual(groups.map(group => group.id), ['organisatie', 'geld', 'apparaat']);
  assert.deepEqual(groups.find(group => group.id === 'geld')?.tabs.map(tab => tab.id), ['facturatie', 'boekhouding']);
});

test('groeperen houdt de extra velden van een onderdeel vast', () => {
  const groups = groupSettingsTabs([{ id: 'email', label: 'E-mail' }, { id: 'huisstijl', label: 'Huisstijl' }]);
  assert.deepEqual(groups, [{ id: 'klant', label: 'Wat je klant ziet', tabs: [{ id: 'huisstijl', label: 'Huisstijl' }, { id: 'email', label: 'E-mail' }] }]);
});
