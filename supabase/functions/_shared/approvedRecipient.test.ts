import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { approvedRecipientChanged, normalizeRecipient, RECIPIENT_CHANGED_MESSAGE } from './approvedRecipient.ts';

/**
 * Een goedgekeurde mail gaat naar het adres dat op de kaart stond — of niet.
 * Verandert het e-mailadres van de klant tussen klaarzetten en goedkeuren, dan
 * keurde niemand de nieuwe ontvanger goed: de server weigert en verstuurt niets.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('vergelijken zoals de verzendfuncties: zonder spaties, zonder hoofdletters', () => {
  assert.equal(normalizeRecipient('  Kees@Jansen.NL '), 'kees@jansen.nl');
  assert.equal(approvedRecipientChanged('kees@jansen.nl', ' KEES@jansen.nl'), false);
  assert.equal(approvedRecipientChanged('kees@jansen.nl', 'piet@elders.nl'), true);
  assert.equal(approvedRecipientChanged('kees@jansen.nl', null), true, 'adres gewist: ook veranderd');
});

test('zonder goedgekeurd adres valt er niets te vergelijken (knop in het scherm, oud voorstel)', () => {
  for (const approved of [undefined, null, '', '   ']) assert.equal(approvedRecipientChanged(approved, 'piet@elders.nl'), false);
});

/** Het stuk code tussen twee merktekens (het eerste ná `from`). */
function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `niet gevonden: ${from}`);
  const end = source.indexOf(to, start);
  assert.ok(end > start, `niet gevonden na ${from}: ${to}`);
  return source.slice(start, end);
}

test('factuur-workflow: herinnering, aanmaning en creditnota controleren vóór het versturen', () => {
  const source = read('../invoice-workflow/index.ts');
  assert.match(source, /import \{ approvedRecipientChanged, RECIPIENT_CHANGED_MESSAGE \} from '\.\.\/_shared\/approvedRecipient\.ts';/);
  const check = /approvedRecipientChanged\((input|body)\.expectedRecipientEmail, recipientEmail\)\) throw new WorkflowHttpError\(RECIPIENT_CHANGED_MESSAGE, 409\)/;
  // Herinnering: de handmatige aanroep geeft het adres door aan de gedeelde verzendkern…
  assert.match(between(source, 'return await deliverInvoiceReminder({', '});'), /expectedRecipientEmail: body\.expectedRecipientEmail,/);
  // …en die controleert vóór er een verzending begint.
  assert.match(between(source, 'async function deliverInvoiceReminder(', 'beginInvoiceReminderSend('), check);
  assert.match(between(source, "'Vul een geldig klant-e-mailadres in voordat je een aanmaning verstuurt.'", 'to: [recipientEmail]'), check);
  assert.match(between(source, 'async function sendCreditNoteEmail(', 'await deliverCreditNoteEmail('), check);
});

test('mailfunctie: portaal-welkom en klantmail controleren vóór het versturen', () => {
  const source = read('../mail/index.ts');
  const check = /if \(approvedRecipientChanged\(body\.expectedRecipientEmail, recipientEmail\)\) \{\s*throw new MailHttpError\(RECIPIENT_CHANGED_MESSAGE, 409\);/;
  assert.match(between(source, 'async function sendClientPortalWelcome(', 'await sendViaResend('), check);
  assert.match(between(source, 'async function sendClientEmail(', 'resolveSenderIdentity('), check);
});

test('de uitvoerders in de app geven het adres van de kaart mee', () => {
  const finance = read('../../../src/lib/actions/finance.ts');
  for (const id of ['invoice.send_reminder', 'dunning.send', 'credit_note.send']) {
    assert.match(between(finance, `'${id}': async`, '\n  },'), /expectedRecipientEmail: optText\(payload, 'email'\) \?\? undefined/, id);
  }
  const clients = read('../../../src/lib/actions/clients.ts');
  assert.match(between(clients, "'client.send_portal_welcome': async", '\n  },'), /expectedRecipientEmail: optText\(payload, 'email'\) \?\? undefined/);
  const main = read('../../../src/main.tsx');
  assert.match(between(main, 'onSendReminders: async', '\n    },'), /expectedRecipientEmail: inv\.recipient_email \?\? undefined/);
  assert.match(between(main, 'onSendClientEmail: async', '\n    },'), /expectedRecipientEmail: item\.recipient_email,/);
  // Factuur en offerte versturen pinden het adres al (recipientEmail van de kaart).
  assert.match(between(main, 'onSendInvoice: async', '\n    },'), /recipientEmail: p\.recipient_email/);
  assert.match(between(main, 'onSendQuote: async', '\n    },'), /recipientEmail: p\.recipient_email/);
});

test('een reeks herinneringen draagt per factuur het adres, en het bord toont het', () => {
  const core = read('./gerrieCore.ts');
  assert.match(between(core, 'async function buildSendRemindersProposal(', '\n}\n'), /recipient_email: d\.client_email/);
  const board = read('../../../src/components/AgentBatchBoard.tsx');
  assert.match(board, /inv\.recipient_email \? `Factuur \$\{inv\.number\} · \$\{inv\.recipient_email\}`/);
});

test('de melding zegt dat er niets verstuurd is', () => {
  assert.match(RECIPIENT_CHANGED_MESSAGE, /niets verstuurd/);
});
