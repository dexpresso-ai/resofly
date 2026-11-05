/**
 * Werklijst en archief van tickets. Draaien met:  npm test
 *
 * Een afgehandeld ticket hoort niet meer tussen het werk, op de ticketpagina
 * en in het klantdossier. Gaat een van deze regels stilletjes om, dan staat
 * het archief weer op de werklijst (of verdwijnt er werk in het archief), en
 * dat merk je pas als een klant vraagt waarom er niet gereageerd is.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Ticket } from '../types.ts';
import {
  TICKET_OPEN_STATUSES, TICKET_REOPEN_STATUS, TICKET_STATUS_LABELS, TICKET_STATUS_ORDER, TICKET_WORKLIST_STATUSES,
  canResolveTicket, isTicketArchived, sortArchivedTickets, ticketInScope, ticketMatchesStatus, ticketResolvedAt, ticketStatusLabel,
} from './tickets.ts';

function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: 'ticket-1', organization_id: 'org-1', created_by: null, client_id: 'client-a',
    title: 'Website laadt traag op mobiel', description: null, priority: 'med', status: 'new',
    notes: null, converted_to_project_id: null, created_at: '2026-09-10T08:00:00Z', updated_at: '2026-09-10T08:00:00Z',
    resolved_at: null,
    ...over,
  };
}

test('afgehandeld heeft een label en staat achteraan, buiten de werklijst', () => {
  assert.equal(TICKET_STATUS_LABELS.resolved, 'Afgehandeld');
  assert.equal(ticketStatusLabel('resolved'), 'Afgehandeld');
  assert.equal(TICKET_STATUS_ORDER.at(-1), 'resolved');
  assert.deepEqual(TICKET_WORKLIST_STATUSES, ['new', 'review', 'approved', 'rejected', 'converted']);
  assert.ok(!TICKET_OPEN_STATUSES.has('resolved'), 'afgehandeld is niet openstaand');
  assert.equal(ticketMatchesStatus(ticket({ status: 'resolved' }), 'open'), false);
});

test('werklijst en archief: alleen afgehandeld gaat naar het archief', () => {
  for (const status of TICKET_WORKLIST_STATUSES) {
    const t = ticket({ status });
    assert.equal(isTicketArchived(t), false, status);
    assert.equal(ticketInScope(t, 'worklist'), true, status);
    assert.equal(ticketInScope(t, 'archive'), false, status);
  }
  const done = ticket({ status: 'resolved' });
  assert.equal(isTicketArchived(done), true);
  assert.equal(ticketInScope(done, 'worklist'), false);
  assert.equal(ticketInScope(done, 'archive'), true);
});

test('afhandelen kan bij alles behalve wat al afgehandeld is of een project werd', () => {
  assert.equal(canResolveTicket(ticket({ status: 'new' })), true);
  assert.equal(canResolveTicket(ticket({ status: 'review' })), true);
  assert.equal(canResolveTicket(ticket({ status: 'approved' })), true);
  assert.equal(canResolveTicket(ticket({ status: 'rejected' })), true, 'ook een geweigerd ticket mag van de werklijst');
  assert.equal(canResolveTicket(ticket({ status: 'resolved' })), false);
  assert.equal(canResolveTicket(ticket({ status: 'converted' })), false);
  // De database zet een ticket met een project altijd op omgezet; afhandelen zou niets doen.
  assert.equal(canResolveTicket(ticket({ status: 'approved', converted_to_project_id: 'project-1' })), false);
});

test('heropenen zet het ticket weer in behandeling, op de werklijst', () => {
  assert.equal(TICKET_REOPEN_STATUS, 'review');
  assert.ok(TICKET_WORKLIST_STATUSES.includes(TICKET_REOPEN_STATUS));
});

test('het archief: laatst afgehandeld bovenaan, zonder resolved_at op de laatste wijziging', () => {
  const old = ticket({ id: 'old', status: 'resolved', resolved_at: '2026-10-01T09:00:00Z', updated_at: '2026-11-04T09:00:00Z' });
  const recent = ticket({ id: 'recent', status: 'resolved', resolved_at: '2026-11-03T09:00:00Z' });
  // Een rij van vóór de kolom (of een app die nog niet ververst is): de laatste wijziging telt.
  const legacy = ticket({ id: 'legacy', status: 'resolved', resolved_at: undefined, updated_at: '2026-10-15T09:00:00Z' });
  assert.equal(ticketResolvedAt(legacy), '2026-10-15T09:00:00Z');
  assert.equal(ticketResolvedAt(old), '2026-10-01T09:00:00Z', 'een latere wijziging verschuift de afhandeldatum niet');
  assert.deepEqual(sortArchivedTickets([old, legacy, recent]).map(t => t.id), ['recent', 'legacy', 'old']);
});
