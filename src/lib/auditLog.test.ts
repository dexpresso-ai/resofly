/**
 * Tests voor het logboek: van een regel uit audit_logs naar een zin, de
 * wijzigingen per veld, de soorten en de filters. Draaien met:  npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import {
  AUDIT_ENTITY_MODULE, actorName, auditCategory, auditTarget, changeLines, changeSummary, cleanQuery, dayKey, dayLabel,
  entityTypesFor, formatValue, groupByDay, matchesFilters, periodStart, relativeTime, sentenceText, timeLabel, toAuditEntry,
  type AuditEntry,
} from './auditLog.ts';
import { AUDIT_ENTITY_MODULE as SERVER_MAPPING } from '../../supabase/functions/_shared/actions/admin.ts';
import type { AuditLog, OrganizationMember } from '../types';

const ME = '00000000-0000-0000-0000-0000000000a1';
const ANNE = '00000000-0000-0000-0000-0000000000a2';
const members = [
  { id: 'm1', organization_id: 'o', user_id: ME, email: 'gerjan@studio.nl', role: 'owner', status: 'active' },
  { id: 'm2', organization_id: 'o', user_id: ANNE, email: 'anne@studio.nl', role: 'member', status: 'active' },
] as unknown as OrganizationMember[];

function row(over: Partial<AuditLog>): AuditLog {
  return {
    id: 'r1', organization_id: 'o', actor_user_id: ANNE, action: 'updated', entity_type: 'task', entity_id: 't1',
    entity_label: 'Homepage ontwerpen', metadata: {}, created_at: '2026-11-08T09:15:00Z', ...over,
  };
}
const entry = (over: Partial<AuditLog>): AuditEntry => toAuditEntry(row(over));
const C1 = '00000000-0000-0000-0000-0000000000c1';
const P1 = '00000000-0000-0000-0000-0000000000d1';
const CX = '00000000-0000-0000-0000-0000000000cf';
const lookup = {
  members, currentUserId: ME,
  clients: new Map([[C1, 'Bakkerij De Korst']]),
  projects: new Map([[P1, 'Nieuwe website']]),
  tasks: new Map([['t1', 'Homepage ontwerpen']]),
};
/** Intl zet een vaste spatie tussen € en het bedrag. */
const plain = (s: string) => s.replace(/\u00a0/g, ' ');

test('de indeling per module is gelijk aan die van de server (en dus van de database)', () => {
  assert.deepEqual({ ...AUDIT_ENTITY_MODULE }, { ...SERVER_MAPPING });
});

test('elke soort hoort bij precies één categorie in het filter', () => {
  const all = Object.keys(AUDIT_ENTITY_MODULE);
  const covered = ['finance', 'clients', 'projects', 'content', 'tickets', 'time', 'calendar', 'marketing', 'stats', 'team', 'admin']
    .flatMap(c => entityTypesFor(c as never));
  assert.equal(covered.length, all.length);
  assert.equal(auditCategory('invoice'), 'finance');
  assert.equal(auditCategory('member'), 'team');
  assert.equal(auditCategory('iets_nieuws'), 'admin');
});

test('een regel van vóór het logboek (zonder de nieuwe kolommen) leest gewoon', () => {
  const e = toAuditEntry({ ...row({ metadata: { changed_columns: ['status', 'due_date'] } }), actor_user_id: null });
  assert.equal(e.via, 'systeem');
  assert.equal(e.count, 1);
  assert.equal(e.lastAt, e.createdAt);
  assert.deepEqual(changeLines(e).map(l => [l.label, l.kind]), [['Status', 'changed'], ['Vervaldatum', 'changed']]);
});

test('zinnen: facturen versturen, betalen, herinneren', () => {
  assert.equal(sentenceText(entry({ action: 'invoice_sent_to_client', entity_type: 'invoice', entity_label: '2026-014' }), lookup),
    'anne verstuurde factuur 2026-014 naar de klant');
  assert.equal(sentenceText(entry({ action: 'invoice_sent_to_client', entity_type: 'invoice', entity_label: '2026-014', actor_user_id: ME }), lookup),
    'Jij verstuurde factuur 2026-014 naar de klant');
  assert.equal(sentenceText(entry({ action: 'invoice_paid', entity_type: 'invoice', entity_label: '2026-014', actor_user_id: null }), lookup),
    'Factuur 2026-014 is betaald');
  assert.equal(sentenceText(entry({ action: 'invoice_reminder_sent', entity_type: 'invoice', entity_label: '2026-014', metadata: { reminder_level: 2 } }), lookup),
    'anne stuurde herinnering 2 voor factuur 2026-014');
  assert.equal(sentenceText(entry({ action: 'invoice_created_from_quote', entity_type: 'invoice', entity_label: '2026-015', metadata: { quote_number: 'OFF-7' } }), lookup),
    'anne maakte factuur 2026-015 van offerte OFF-7');
});

test('zinnen: de klant accepteert een offerte', () => {
  assert.equal(sentenceText(entry({ action: 'quote_client_accepted', entity_type: 'quote', entity_label: 'OFF-7', actor_user_id: null }), lookup),
    'De klant accepteerde offerte OFF-7');
});

test('zinnen: een status, archiveren, hernoemen, verplaatsen', () => {
  const status = entry({ metadata: { changes: { status: { old: 'doing', new: 'done' } } } });
  assert.equal(sentenceText(status, lookup), 'anne zette taak Homepage ontwerpen op Klaar');
  const archived = entry({ entity_type: 'project', entity_label: 'Nieuwe website', metadata: { changes: { archived: { old: false, new: true } } } });
  assert.equal(sentenceText(archived, lookup), 'anne archiveerde project Nieuwe website');
  const renamed = entry({ entity_type: 'document', entity_label: 'Offerte v2.docx', metadata: { changes: { title: { old: 'Offerte.docx', new: 'Offerte v2.docx' } } } });
  assert.equal(sentenceText(renamed, lookup), 'anne hernoemde document Offerte.docx naar Offerte v2.docx');
  const moved = entry({ entity_type: 'note', entity_label: 'Notulen', metadata: { changes: { folder_id: { old: null, new: 'f1' } } } });
  assert.equal(sentenceText(moved, lookup), 'anne verplaatste notitie Notulen naar een andere map');
});

test('zinnen: online bewerkt, geüpload, uren, team', () => {
  assert.equal(sentenceText(entry({ entity_type: 'document', entity_label: 'Plan.docx', metadata: { online: true, changes: { last_edited_at: { changed: true } } } }), lookup),
    'anne bewerkte document Plan.docx online');
  assert.equal(sentenceText(entry({ action: 'created', entity_type: 'attachment', entity_label: 'logo.png' }), lookup), 'anne uploadde logo.png');
  assert.equal(sentenceText(entry({ action: 'created', entity_type: 'time_entry', entity_label: 'Ontwerp', metadata: { changes: { minutes: { new: 90 } } } }), lookup),
    'anne schreef 1 u 30 min: Ontwerp');
  assert.equal(sentenceText(entry({ action: 'role_changed', entity_type: 'member', entity_label: 'anne@studio.nl', actor_user_id: ME, metadata: { changes: { role: { old: 'member', new: 'admin' } } } }), lookup),
    'Jij gaf anne@studio.nl de rol Admin');
  assert.equal(sentenceText(entry({ action: 'created', entity_type: 'task_assignee', entity_label: 'Homepage ontwerpen', metadata: { changes: { user_id: { new: ANNE } } } }), lookup),
    'anne wees taak Homepage ontwerpen toe aan anne');
  // Een oude regel: het label was het id van het teamlid.
  assert.equal(sentenceText(entry({ action: 'created', entity_type: 'project_member', entity_label: ANNE, project_id: P1, actor_user_id: ME }), lookup),
    'Jij voegde anne toe aan project Nieuwe website');
});

test('een vertrokken teamlid houdt zijn naam; zonder gebruiker staat er Systeem', () => {
  const gone = entry({ actor_user_id: '00000000-0000-0000-0000-0000000000ff', actor_label: 'piet@studio.nl' });
  assert.equal(actorName(gone, members, ME), 'piet');
  assert.equal(actorName(entry({ actor_user_id: null, via: 'systeem' }), members, ME), 'Systeem');
});

test('de wijzigingen per veld: waarden, alleen "gewijzigd", verwijzingen met de naam die je mag zien', () => {
  const e = entry({ metadata: { changes: {
    status: { old: 'todo', new: 'done' },
    description: { changed: true },
    project_id: { old: null, new: P1 },
    client_id: { old: null, new: CX },
    estimated_minutes: { old: 60, new: 150 },
    subtasks: { old: '1/3', new: '3/3', count: true },
  } } });
  const lines = changeLines(e, lookup);
  const byKey = Object.fromEntries(lines.map(l => [l.key, l]));
  assert.deepEqual([byKey.status.from, byKey.status.to], ['Te doen', 'Klaar']);
  assert.equal(byKey.description.kind, 'changed');
  assert.equal(byKey.project_id.to, 'Nieuwe website');
  // Een klant die je niet mag zien (of die weg is): geen id in beeld.
  assert.equal(byKey.client_id.to, 'een andere klant');
  assert.equal(byKey.estimated_minutes.to, '2 u 30 min');
  assert.equal(byKey.subtasks.to, '3/3');
  assert.match(changeSummary(lines), /^Status: Te doen → Klaar · Omschrijving gewijzigd · nog 4$/);
});

test('waarden: bedragen, rechten, datums', () => {
  assert.equal(plain(formatValue('invoice', 'total_amount', 1210)), '€ 1.210,00');
  assert.equal(plain(formatValue('fixed_asset', 'acquisition_cost_cents', 150000)), '€ 1.500,00');
  assert.equal(formatValue('member', 'module_access', { finance: 'none', time: 'read' }), 'Financiën: geen toegang, Uren: alleen lezen');
  assert.equal(formatValue('member', 'module_access', {}), 'alles volledig');
  assert.equal(formatValue('invoice', 'due_date', '2026-11-22'), '22 nov 2026');
  assert.equal(formatValue('invoice', 'status', 'sent'), 'Verzonden');
  assert.equal(formatValue('ticket', 'status', 'resolved'), 'Afgehandeld');
});

test('aanmaken: een momentopname, zonder de naam en de klant die al in beeld staan', () => {
  const e = entry({ action: 'created', entity_type: 'invoice', entity_label: 'CONCEPT-1', client_id: C1, metadata: { changes: {
    number: { old: null, new: 'CONCEPT-1' }, status: { old: null, new: 'draft' }, client_id: { old: null, new: C1 }, total_amount: { old: null, new: 0 },
  } } });
  assert.deepEqual(changeLines(e, lookup).map(l => plain(`${l.label}: ${l.to}`)), ['Status: Concept', 'Totaal: € 0,00']);
});

test('tijd: een reeks toont van–tot; dagen in de tijdlijn', () => {
  const e = entry({ created_at: '2026-11-08T09:02:00Z', last_at: '2026-11-08T09:14:00Z', event_count: 4 });
  assert.match(timeLabel(e), /^\d{2}:02–\d{2}:14$/);
  const now = new Date('2026-11-08T15:00:00Z');
  assert.equal(dayLabel(dayKey('2026-11-08T10:00:00Z'), now), 'Vandaag');
  assert.equal(dayLabel(dayKey('2026-11-07T10:00:00Z'), now), 'Gisteren');
  assert.match(dayLabel('2026-11-03', now), /dinsdag 3 november 2026/);
  const groups = groupByDay([entry({ id: 'a', created_at: '2026-11-08T10:00:00Z' }), entry({ id: 'b', created_at: '2026-11-08T09:00:00Z' }), entry({ id: 'c', created_at: '2026-11-06T09:00:00Z' })]);
  assert.deepEqual(groups.map(g => g.entries.length), [2, 1]);
  assert.equal(relativeTime('2026-11-08T14:50:00Z', now), '10 min geleden');
});

test('filters: periode, persoon, systeem, klant, project, soort en zoeken', () => {
  const now = new Date('2026-11-08T12:00:00');
  const e = entry({ client_id: C1, project_id: P1, created_at: '2026-11-06T10:00:00' });
  assert.equal(matchesFilters(e, { period: 'vandaag' }, now), false);
  assert.equal(matchesFilters(e, { period: '7d' }, now), true);
  assert.equal(matchesFilters(e, { period: 'alles', actor: ANNE }, now), true);
  assert.equal(matchesFilters(e, { period: 'alles', actor: 'systeem' }, now), false);
  assert.equal(matchesFilters(e, { period: 'alles', clientId: C1, projectId: P1 }, now), true);
  assert.equal(matchesFilters(e, { period: 'alles', category: 'finance' }, now), false);
  assert.equal(matchesFilters(e, { period: 'alles', q: 'homepage' }, now), true);
  assert.equal(periodStart('alles'), null);
  assert.equal(cleanQuery('  factuur, (2026)*  '), 'factuur 2026');
});

test('openen: naar het ding zelf, of de pagina waar het staat', () => {
  assert.deepEqual(auditTarget(entry({})), { kind: 'task', id: 't1' });
  assert.deepEqual(auditTarget(entry({ entity_type: 'invoice' })), { kind: 'page', page: 'invoices' });
  assert.deepEqual(auditTarget(entry({ action: 'deleted', project_id: P1 })), { kind: 'project', id: P1 });
  assert.equal(auditTarget(entry({ entity_type: 'api_key' })), null);
});

// ── De migratie: wat er wel en niet met zijn waarde in het logboek komt ─────

const MIGRATIONS = new URL('../../supabase/migrations/', import.meta.url);
const LOGBOEK = '20261108100000_logboek.sql';
const sql = readFileSync(new URL(LOGBOEK, MIGRATIONS), 'utf8');

function fieldSpecs(): Record<string, Record<string, string>> {
  const body = sql.slice(sql.indexOf('create or replace function public.audit_field_spec'), sql.indexOf('create or replace function public.audit_clip'));
  const out: Record<string, Record<string, string>> = {};
  for (const m of body.matchAll(/when '([a-z_]+)' then '(\{[^']*\})'/g)) out[m[1]] = JSON.parse(m[2]);
  return out;
}

test('nooit met waarde in het logboek: tokens, hashes, sleutels, PDF-inhoud, adressen en teksten', () => {
  const specs = fieldSpecs();
  assert.ok(Object.keys(specs).length >= 40, 'te weinig tabellen gevonden — klopt de zoekopdracht nog?');
  const secret = /(token|hash|secret|storage_key|base64|_url$|sha256|password|(^|_)pin(_|$))/;
  const personal = /^(email|phone|phone_raw|phone_e164|address_line1|address_line2|postal_code|iban|recipient_email|recipient_name|e_invoice_email|client_decision_by_email|created_by_email|contact_name)$/;
  const text = /^(description|content|notes|note|body|body_html|body_text|message|intro|closing|internal_rejection_note|client_decision_note|void_reason|reason)$/;
  for (const [table, spec] of Object.entries(specs)) {
    for (const [column, mode] of Object.entries(spec)) {
      if (secret.test(column)) assert.equal(mode, 'i', `${table}.${column} mag niet met zijn waarde (of als wijziging) in het logboek`);
      if (text.test(column)) assert.notEqual(mode, 'v', `${table}.${column} is een tekst: alleen "gewijzigd"`);
      if (personal.test(column)) assert.notEqual(mode, 'v', `${table}.${column} is een persoonsgegeven: alleen "gewijzigd"`);
    }
  }
  // De gedeelde link van een galerij staat leesbaar in de tabel; nooit in het logboek.
  assert.equal(specs.galleries.share_token, 'i');
  assert.equal(specs.contracts.signed_pdf_data_base64, 'i');
});

test('samenvoegen nooit bij Financiën, de agenda, het team en het beheer', () => {
  const list = /v_entity_type in \(([^)]*)\) then\s+select a\.id/.exec(sql);
  assert.ok(list, 'de lijst met soorten die worden samengevoegd staat er niet meer');
  const types = [...list[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
  for (const type of types) {
    assert.ok(type in AUDIT_ENTITY_MODULE, `${type} is geen bekende soort`);
    assert.ok(!['finance', 'calendar', 'admin', null].includes(AUDIT_ENTITY_MODULE[type] as string | null), `${type} hoort niet samengevoegd te worden`);
  }
});

test('de trigger houdt een wijziging nooit tegen, en schrijft als laatste definitie', () => {
  const files = readdirSync(MIGRATIONS).filter(name => name.endsWith('.sql')).sort();
  const last = files.filter(file => /create or replace function public\.audit_row_change\(\)/.test(readFileSync(new URL(file, MIGRATIONS), 'utf8'))).pop();
  assert.equal(last, LOGBOEK);
  const body = sql.slice(sql.indexOf('create or replace function public.audit_row_change()'), sql.indexOf('create or replace function public.audit_logs_fill()'));
  assert.match(body, /exception when others then\s+raise warning 'audit logging failed/);
  const fill = sql.slice(sql.indexOf('create or replace function public.audit_logs_fill()'), sql.indexOf('drop trigger if exists audit_logs_fill'));
  assert.match(fill, /exception when others then\s+raise warning 'audit_logs_fill/);
  // Een bijlage in de teamchat geeft geen naam prijs.
  assert.match(body, /entity_type' = 'chat_message' then\s+v_label := 'Bijlage in de teamchat'/);
});
