import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  aiRefusedBy, bytesMatchType, declarationStatus, declarationView, declineAllowed, isUploadableReceipt, isUploadChannel,
  receiptTwinWarning, uploadChannelFor,
} from './invoiceInboxRules.ts';

/**
 * Bonnen fotograferen en declaraties (2026-11-17). Wie Financiën mag bewerken,
 * krijgt van een foto een concept; ieder ander teamlid dient een declaratie in
 * en ziet daarvan alleen zijn eigen bon. Deze tests bewaken die scheiding op
 * alle drie de plekken: de regels, de edge function en de database.
 *
 * De edge function en de migratie draaien niet in node; die lezen we als
 * tekst, net als aiConsent.test.ts en gerrieSecurity.test.ts.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const edge = read('../invoice-inbox/index.ts');
const inbox = read('./invoiceInbox.ts');
const sql = read('../../migrations/20261117120000_bonnen_en_declaraties.sql');

// ── De regels ────────────────────────────────────────────────────────────────

test('het kanaal volgt uit het recht op Financiën: alleen schrijven geeft een concept', () => {
  assert.equal(uploadChannelFor('write'), 'receipt');
  assert.equal(uploadChannelFor('read'), 'declaration');
  assert.equal(uploadChannelFor('none'), 'declaration');
  assert.equal(isUploadChannel('receipt'), true);
  assert.equal(isUploadChannel('declaration'), true);
  assert.equal(isUploadChannel('email'), false);
  assert.equal(isUploadChannel(null), false);
});

test('een bon is een foto of een pdf-scan, en de bytes moeten dat ook zijn', () => {
  assert.equal(isUploadableReceipt('bon.jpg', 'image/jpeg'), true);
  assert.equal(isUploadableReceipt('scan.PDF', ''), true);
  assert.equal(isUploadableReceipt('bon.webp', 'image/webp'), true);
  assert.equal(isUploadableReceipt('e-factuur.xml', 'text/xml'), false, 'een e-factuur gaat via Factuur scannen');
  assert.equal(isUploadableReceipt('bon.heic', 'image/heic'), false);
  assert.equal(isUploadableReceipt('plaatje.gif', 'image/gif'), false);

  const bytes = (...values: number[]) => new Uint8Array(values);
  const ascii = (text: string) => new Uint8Array([...text].map((c) => c.charCodeAt(0)));
  assert.equal(bytesMatchType(bytes(0xff, 0xd8, 0xff, 0xe0), 'image/jpeg'), true);
  assert.equal(bytesMatchType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d), 'image/png'), true);
  assert.equal(bytesMatchType(ascii('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '), 'image/webp'), true);
  assert.equal(bytesMatchType(ascii('%PDF-1.7'), 'application/pdf'), true);
  assert.equal(bytesMatchType(ascii('\n\n%PDF-1.4'), 'application/pdf'), true, 'de kop mag iets naar achteren staan');
  assert.equal(bytesMatchType(ascii('hallo'), 'image/jpeg'), false);
  assert.equal(bytesMatchType(ascii('%PDF'), 'image/jpeg'), false, 'een pdf met .jpg erachter');
  assert.equal(bytesMatchType(bytes(), 'application/pdf'), false);
});

test('een eigen nee tegen AI, of Gerrie dichtgezet, houdt de bon bij het model weg', () => {
  assert.equal(aiRefusedBy({ consentEnabled: false, gerrieLevel: 'write' }), true, 'zelf nee gezegd');
  assert.equal(aiRefusedBy({ consentEnabled: true, gerrieLevel: 'none' }), true, 'module dicht');
  assert.equal(aiRefusedBy({ consentEnabled: null, gerrieLevel: 'write' }), false, 'nog niet gekozen: de knop is de vraag');
  assert.equal(aiRefusedBy({ consentEnabled: true, gerrieLevel: 'read' }), false);
});

test('de status in gewone woorden, zoals list_my_declarations hem geeft', () => {
  assert.equal(declarationStatus('processing', null), 'processing');
  assert.equal(declarationStatus('received', null), 'processing');
  assert.equal(declarationStatus('ready', { status: 'draft', payment_status: 'unpaid' }), 'submitted');
  // Wat bij Financiën op een keuze wacht, is voor de indiener gewoon ingediend.
  for (const status of ['needs_review', 'duplicate', 'failed']) assert.equal(declarationStatus(status, null), 'submitted');
  assert.equal(declarationStatus('booked', { status: 'booked', payment_status: 'unpaid' }), 'approved');
  assert.equal(declarationStatus('booked', { status: 'booked', payment_status: 'paid' }), 'paid');
  assert.equal(declarationStatus('rejected', null), 'rejected');
});

test('een declarant krijgt zijn eigen bon terug, en niets over anderen', () => {
  const view = declarationView({
    id: 'i1',
    status: 'duplicate',
    proposal: {
      supplier: { name: '  Albert Heijn ' }, date: '2026-11-16', currency: 'eur',
      totals: { total_cents: 2340 },
      // Velden die een declarant nooit mag zien: een waarschuwing die een
      // andere factuur noemt, en het IBAN dat bij de leverancier bekend is.
      ...({ warnings: ['Staat al als INK-2026-0012'], supplier_iban: 'NL00BANK0123456789' } as object),
    },
  });
  assert.deepEqual(view, {
    id: 'i1', status: 'submitted', store_name: 'Albert Heijn', receipt_date: '2026-11-16', total_cents: 2340, currency: 'EUR', read: true,
  });
  assert.deepEqual(Object.keys(view).sort(), ['currency', 'id', 'read', 'receipt_date', 'status', 'store_name', 'total_cents']);
  const unread = declarationView({ id: 'i2', status: 'needs_review', proposal: null });
  assert.equal(unread.read, false);
  assert.equal(unread.store_name, null);
  assert.equal(declarationView({ id: 'i3', status: 'ready', proposal: { date: '16-11-2026' } }).receipt_date, null);
});

test('afwijzen kan alleen bij een declaratie die nog niet is goedgekeurd', () => {
  assert.equal(declineAllowed({ channel: 'declaration', status: 'ready' }).ok, true);
  assert.equal(declineAllowed({ channel: 'declaration', status: 'needs_review' }).ok, true);
  assert.equal(declineAllowed({ channel: 'declaration', status: 'duplicate' }).ok, true);
  for (const [row, pattern] of [
    [{ channel: 'email', status: 'ready' }, /Negeren/],
    [{ channel: 'receipt', status: 'ready' }, /Negeren/],
    [{ channel: 'declaration', status: 'booked' }, /tegenboeking/],
    [{ channel: 'declaration', status: 'rejected' }, /al afgewezen/],
    [{ channel: 'declaration', status: 'processing' }, /uitgelezen/],
  ] as const) {
    const verdict = declineAllowed(row);
    assert.equal(verdict.ok, false);
    assert.match(verdict.ok ? '' : verdict.why, pattern);
  }
});

test('twee keer dezelfde bon is een waarschuwing, geen blokkade', () => {
  assert.equal(receiptTwinWarning(null), null);
  assert.match(receiptTwinWarning({ internal_number: 'INK-2026-0007', supplier_invoice_number: null }) ?? '', /INK-2026-0007/);
});

test('Gerrie hoort dat het een bon is: per btw-tarief één regel, bedragen incl. btw', () => {
  // claudeInvoice.ts leest Deno.env bij het laden; daarom als tekst.
  const claude = read('./claudeInvoice.ts');
  const instruction = claude.slice(claude.indexOf('export const RECEIPT_INSTRUCTION'), claude.indexOf("].join('\\n');", claude.indexOf('export const RECEIPT_INSTRUCTION')));
  assert.match(instruction, /btw-specificatie/);
  assert.match(instruction, /per btw-tarief één regel/i);
  assert.match(instruction, /due_date is null/);
  assert.match(instruction, /Verzin geen bedragen/);
  assert.match(claude, /input\.documentKind === 'receipt'\s*\? `\$\{RECEIPT_INSTRUCTION\}/);
});

// ── De edge function ─────────────────────────────────────────────────────────

test('upload: het kanaal en de indiener komen uit de sessie, nooit uit de invoer', () => {
  const start = edge.indexOf('async function handleUpload(');
  const body = edge.slice(start, edge.indexOf('\nfunction readUploadFile(', start));
  assert.match(body, /uploadChannelFor\(await getModuleLevel\(admin, user\.id, organizationId, 'finance'\)\)/);
  assert.match(body, /submittedBy: user\.id/);
  assert.doesNotMatch(body, /body\.(channel|submittedBy|submitted_by|userId)/);
  // Lid met schrijfrol, vóór de upload; de rest van de handelingen vraagt Financiën.
  const upload = edge.indexOf("if (action === 'upload')");
  assert.ok(upload > edge.indexOf('assertWriteRole(role);'), 'eerst de schrijfrol');
  assert.ok(upload < edge.indexOf("await assertModuleAccess(admin, user.id, organizationId, 'finance', 'write');"), 'de rest blijft achter Financiën');
});

test('upload: een declarant krijgt alleen declarationView terug, met een limiet per uur', () => {
  const start = edge.indexOf('async function handleUpload(');
  const body = edge.slice(start, edge.indexOf('\nfunction readUploadFile(', start));
  assert.match(body, /if \(channel === 'declaration'\) return \{ ok: true, channel, declaration: declarationView\(item\) \};/);
  assert.match(body, /MAX_UPLOADS_PER_HOUR/);
  assert.match(body, /\.eq\('submitted_by', user\.id\)/);
});

// ── De verwerking ────────────────────────────────────────────────────────────

test('een bon gaat nooit vanzelf de boeken in, en een nee tegen AI telt', () => {
  assert.match(inbox, /const mayAutoBook = settings\.auto_book && !isReceipt;/);
  const loop = inbox.slice(inbox.indexOf('for (const att of toExtract) {'), inbox.indexOf('const log = { extracted:'));
  const refused = loop.indexOf("if (await aiRefused()) { aiBlocked = aiBlocked ?? 'ai_declined'; continue; }");
  assert.ok(refused > 0, 'de keuze van de indiener wordt niet gewogen');
  assert.ok(refused < loop.indexOf('result = await buildAiProposal('), 'eerst de keuze, dan het model');
  assert.match(loop, /documentKind: isReceipt \? 'receipt' : 'invoice'/);
  // Het teamlid is de afzender, niet de winkel.
  assert.match(inbox, /const senderForMatch = isReceipt \? null : await senderEmailForMatching\(/);
});

test('negeren kan geen declaratie wegleggen; afwijzen vraagt een reden', () => {
  const reject = inbox.slice(inbox.indexOf('export async function rejectInboxItem('), inbox.indexOf('export async function restoreInboxItem('));
  assert.match(reject, /if \(row\.channel === 'declaration'\) \{/);
  const decline = inbox.slice(inbox.indexOf('export async function declineDeclaration('), inbox.indexOf('export async function linkInboxItem('));
  assert.match(decline, /if \(!reasonText\) throw new HttpError\(/);
  // Alleen een concept verdwijnt; een geboekte declaratie blijft staan.
  assert.match(decline, /\.eq\('organization_id', row\.organization_id\)\.eq\('status', 'draft'\)/);
});

// ── De database ──────────────────────────────────────────────────────────────

test('list_my_declarations: alleen de ingelogde gebruiker, alleen declaraties, alleen als lid', () => {
  const start = sql.indexOf('create or replace function public.list_my_declarations(');
  const body = sql.slice(start, sql.indexOf('\n$$;', start));
  assert.match(body, /security definer\s+set search_path = public/);
  assert.match(body, /v_user uuid := auth\.uid\(\);/);
  assert.match(body, /m\.organization_id = p_organization_id and m\.user_id = v_user and m\.status = 'active'/);
  assert.match(body, /and i\.submitted_by = v_user/);
  assert.match(body, /and i\.channel = 'declaration'/);
  assert.match(body, /where i\.organization_id = p_organization_id/);
  // Geen parameter voor de gebruiker: die komt altijd uit de sessie.
  assert.doesNotMatch(body, /p_user/);
  // Niets wat over een ander kan gaan.
  for (const column of ['warnings', 'error_message', 'supplier_id', 'sender_email', 'duplicate_of', 'extraction_meta']) {
    assert.doesNotMatch(body.slice(body.indexOf('return query')), new RegExp(`i\\.${column}`), `${column} hoort niet in wat een declarant terugkrijgt`);
  }
  assert.match(sql, /revoke all on function public\.list_my_declarations\(uuid\) from public, anon;/);
  assert.match(sql, /grant execute on function public\.list_my_declarations\(uuid\) to authenticated;/);
});

test('meldingen: een declaratie gaat naar wie Financiën mag bewerken, de beslissing alleen naar de indiener', () => {
  const start = sql.indexOf('create or replace function public.push_on_purchase_invoice_inbox()');
  const body = sql.slice(start, sql.indexOf('\nend; $$;', start));
  assert.match(body, /exception when others then/);
  assert.match(body, /if coalesce\(new\.channel, 'email'\) = 'receipt' then return new; end if;/);
  assert.match(body, /array\[new\.submitted_by\]/);
  assert.match(body, /m\.user_id is distinct from new\.submitted_by/);
  assert.match(body, /coalesce\(nullif\(m\.module_access ->> 'finance', ''\), 'write'\) = 'write'/);
  const checks = sql.match(/event_type in \([^)]*\)/g) ?? [];
  assert.equal(checks.length, 2);
  for (const check of checks) {
    for (const type of ['ticket_new', 'ticket_note_client', 'chat_message', 'client_email_inbound', 'booking_new', 'invoice_paid',
      'decision_digest', 'mcp_proposal', 'purchase_invoice_inbox', 'file_transfer_downloaded', 'agent_run', 'declaration']) {
      assert.ok(check.includes(`'${type}'`), `de CHECK mist '${type}'`);
    }
  }
  assert.match(read('../../../src/lib/push-api.ts'), /\|\s*'declaration'/);
  assert.match(read('../../../src/lib/push-api.ts'), /type: 'declaration'/);
  assert.match(read('./actions/admin.ts'), /\{ type: 'declaration', label: '[^']+' \}/);
});
