import {
  approveQuoteInternal, bookAllUnbookedSalesInvoices, bookBankTransaction, cancelInvoiceDunningNotice,
  createInvoiceRefund, postCreditNoteToLedger, postSalesInvoiceToLedger, proposeInvoiceDunningNotice,
  rejectQuoteInternal, resetEmailTemplate, saveInvoiceDunningSettings, saveInvoiceReminderSettings,
  sendCreditNoteEmail, sendInvoiceDunningNotice, sendInvoiceReminderEmail, setInvoiceRemindersPaused,
  submitQuoteForInternalApproval, updateRow, upsertCompanySettings, upsertEmailTemplate,
} from '../repository';
import { euro } from '../format';
import { flag, optText, patchOf, text, type ActionExecutor, type ActionRunCtx } from './types';
import type { CompanySettingsInput, EmailTemplateKey } from '../../types';

/**
 * Uitvoerders voor de verkoopkant van het geld: offertes en facturen. Elke functie
 * doet precies wat de knop in het Finance-scherm doet — zie
 * `supabase/functions/_shared/actions/finance.ts` voor wat er aan de gebruiker
 * beloofd wordt op de kaart die hij goedkeurt.
 */

/** Geheel getal uit de payload; de server heeft hem al gevalideerd. */
function int(payload: Record<string, unknown>, key: string): number {
  const value = Number(payload[key]);
  if (!Number.isFinite(value)) throw new Error(`Deze actie mist "${key}".`);
  return Math.round(value);
}

/** Bedrag in centen als leesbare tekst voor de bevestigingszin. */
function euroCents(cents: number): string {
  return euro(Math.round(cents) / 100);
}

/**
 * De bedrijfsgegevens zoals `upsertCompanySettings` ze verwacht: de volledige set,
 * met de wijziging erover. Het instellingenscherm stuurt óók het hele formulier —
 * een losse partiële upsert zou bij een ontbrekende rij op de NOT NULL-kolommen
 * stuklopen en bij een bestaande rij niets van de rest garanderen.
 */
function companySettingsWithPatch(ctx: ActionRunCtx, patch: Record<string, unknown>): CompanySettingsInput {
  const current = ctx.data.companySettings;
  if (!current) {
    throw new Error('Er zijn nog geen bedrijfsgegevens vastgelegd. Vul ze eerst in bij Instellingen → Bedrijf.');
  }
  const { id: _id, organization_id: _organizationId, created_by: _createdBy, created_at: _createdAt, updated_at: _updatedAt, ...rest } = current;
  return { ...rest, ...patch } as CompanySettingsInput;
}

export const FINANCE_EXECUTORS: Record<string, ActionExecutor> = {
  // ── Offerte: de interne goedkeuringsronde ────────────────────────────────
  'quote.submit_internal_approval': async (payload, ctx) => {
    const quote = await submitQuoteForInternalApproval(ctx.organizationId, text(payload, 'quote_id'));
    return `Offerte ${quote?.number ?? optText(payload, 'number') ?? ''} staat ter interne goedkeuring`.replace('  ', ' ');
  },

  'quote.approve_internal': async (payload, ctx) => {
    const quote = await approveQuoteInternal(ctx.organizationId, text(payload, 'quote_id'));
    return `Offerte ${quote?.number ?? optText(payload, 'number') ?? ''} is intern goedgekeurd en mag naar de klant`.replace('  ', ' ');
  },

  'quote.reject_internal': async (payload, ctx) => {
    const note = optText(payload, 'note') ?? undefined;
    const quote = await rejectQuoteInternal(ctx.organizationId, text(payload, 'quote_id'), note);
    const number = quote?.number ?? optText(payload, 'number') ?? '';
    return `Offerte ${number} is intern afgewezen en staat weer op concept${note ? ` — reden: ${note}` : ''}`.replace('  ', ' ');
  },

  // ── Offerte en factuur: koppeling aan een project ────────────────────────
  'finance.link_project': async (payload, ctx) => {
    const documentKind = text(payload, 'document');
    const table = documentKind === 'quote' ? 'quotes' : 'invoices';
    const label = documentKind === 'quote' ? 'Offerte' : 'Factuur';
    // Leeg project_id is hier een geldige waarde: dat is "Geen project" in het formulier.
    const projectId = optText(payload, 'project_id');
    await updateRow(table, text(payload, 'document_id'), { project_id: projectId }, ctx.organizationId);
    const number = optText(payload, 'number') ?? '';
    const projectName = optText(payload, 'project_name');
    return projectName
      ? `${label} ${number} gekoppeld aan project ${projectName}`.replace('  ', ' ')
      : `${label} ${number} losgemaakt van het project`.replace('  ', ' ');
  },

  // ── Factuur: status en betaling ──────────────────────────────────────────
  'invoice.set_status': async (payload, ctx) => {
    const status = text(payload, 'status');
    await updateRow('invoices', text(payload, 'invoice_id'), { status }, ctx.organizationId);
    const number = optText(payload, 'number') ?? '';
    const labels: Record<string, string> = {
      draft: 'staat weer op concept', sent: 'staat op verzonden', overdue: 'staat op te laat',
      paid: 'is als betaald geboekt', cancelled: 'is geannuleerd', void: 'is ongeldig gemaakt',
      written_off: 'is afgeboekt als oninbaar',
    };
    return `Factuur ${number} ${labels[status] ?? `staat op ${status}`}`.replace('  ', ' ');
  },

  // ── Factuur: de herinneringstrap ─────────────────────────────────────────
  'invoice.set_reminders_paused': async (payload, ctx) => {
    const paused = flag(payload, 'paused');
    await setInvoiceRemindersPaused(ctx.organizationId, text(payload, 'invoice_id'), paused);
    const number = optText(payload, 'number') ?? '';
    return paused
      ? `Automatische herinneringen voor factuur ${number} staan op pauze`.replace('  ', ' ')
      : `Automatische herinneringen voor factuur ${number} lopen weer`.replace('  ', ' ');
  },

  'invoice.send_reminder': async (payload, ctx) => {
    const level = int(payload, 'level') as 1 | 2 | 3;
    const result = await sendInvoiceReminderEmail(ctx.organizationId, text(payload, 'invoice_id'), { level });
    const number = optText(payload, 'number') ?? '';
    const to = result.recipientEmail ?? optText(payload, 'email') ?? 'de klant';
    const sentLevel = result.level ?? level;
    // De betaallink is bijzaak; als die niet lukte hoort de gebruiker dat wel te weten.
    const linkNote = result.paymentLinkError ? ' (zonder betaallink — die kon niet worden aangemaakt)' : '';
    return `Betalingsherinnering niveau ${sentLevel} voor factuur ${number} verstuurd naar ${to}${linkNote}`.replace('  ', ' ');
  },

  // ── Factuur: de formele aanmaning (WIK) ──────────────────────────────────
  'invoice.propose_dunning': async (payload, ctx) => {
    await proposeInvoiceDunningNotice(ctx.organizationId, text(payload, 'invoice_id'));
    const number = optText(payload, 'number') ?? '';
    return `Aanmaningsvoorstel klaargezet voor factuur ${number} — bevestig het met "Aanmaning versturen" voordat er iets de deur uit gaat`.replace('  ', ' ');
  },

  'dunning.send': async (payload, ctx) => {
    const result = await sendInvoiceDunningNotice(ctx.organizationId, text(payload, 'notice_id'));
    const number = optText(payload, 'invoice_number') ?? '';
    const to = result.recipientEmail ?? optText(payload, 'email') ?? 'de klant';
    const total = typeof result.totalClaimCents === 'number' ? ` van ${euroCents(result.totalClaimCents)}` : '';
    const deadline = result.deadlineDate ? ` — betaaltermijn tot ${result.deadlineDate}` : '';
    return `Aanmaning${total} voor factuur ${number} verstuurd naar ${to}${deadline}`.replace('  ', ' ');
  },

  'dunning.cancel': async (payload, ctx) => {
    await cancelInvoiceDunningNotice(ctx.organizationId, text(payload, 'notice_id'));
    return `Aanmaningsvoorstel voor factuur ${optText(payload, 'invoice_number') ?? ''} geannuleerd`.replace('  ', ' ');
  },

  // ── Terugbetaling en creditnota ──────────────────────────────────────────
  'invoice.register_refund': async (payload, ctx) => {
    const amountCents = int(payload, 'amount_cents');
    const result = await createInvoiceRefund(ctx.organizationId, text(payload, 'invoice_id'), {
      amountCents,
      reason: optText(payload, 'reason') ?? undefined,
      createCreditNote: flag(payload, 'create_credit_note'),
      idempotencyKey: optText(payload, 'idempotency_key') ?? undefined,
      // Bewust vastgezet: de Mollie-terugbetaling zet echt geld in beweging bij de
      // provider en blijft handwerk in het scherm.
      kind: 'manual',
    });
    const number = optText(payload, 'number') ?? '';
    const creditNote = result.creditNote ? ` — creditnota ${result.creditNote.number} uitgegeven` : '';
    return `Terugbetaling van ${euroCents(amountCents)} vastgelegd op factuur ${number}${creditNote}`.replace('  ', ' ');
  },

  'credit_note.send': async (payload, ctx) => {
    const result = await sendCreditNoteEmail(ctx.organizationId, text(payload, 'credit_note_id'));
    const number = optText(payload, 'number') ?? '';
    const to = result.recipientEmail ?? optText(payload, 'email') ?? 'de klant';
    return `Creditnota ${number} gemaild naar ${to}`.replace('  ', ' ');
  },

  // ── Grootboek ────────────────────────────────────────────────────────────
  'invoice.post_to_ledger': async (payload, ctx) => {
    const entry = await postSalesInvoiceToLedger(ctx.organizationId, text(payload, 'invoice_id'));
    const number = optText(payload, 'number') ?? '';
    const reference = entry?.entry_number ? ` (boekstuk ${entry.entry_number})` : '';
    return `Factuur ${number} geboekt in het grootboek${reference}`.replace('  ', ' ');
  },

  'invoice.post_all_unbooked': async (_payload, ctx) => {
    const count = await bookAllUnbookedSalesInvoices(ctx.organizationId);
    return count > 0
      ? `${count} verkoopfactu${count === 1 ? 'ur' : 'ren'} alsnog in het grootboek geboekt`
      : 'Er stonden geen ongeboekte verkoopfacturen meer open';
  },

  'credit_note.post_to_ledger': async (payload, ctx) => {
    const entry = await postCreditNoteToLedger(ctx.organizationId, text(payload, 'credit_note_id'));
    const number = optText(payload, 'number') ?? '';
    const reference = entry?.entry_number ? ` (boekstuk ${entry.entry_number})` : '';
    return `Creditnota ${number} geboekt in het grootboek${reference}`.replace('  ', ' ');
  },

  'invoice.reconcile_bank_transaction': async (payload, ctx) => {
    await bookBankTransaction(ctx.organizationId, text(payload, 'transaction_id'), {
      matchedInvoiceId: text(payload, 'invoice_id'),
    });
    const number = optText(payload, 'number') ?? '';
    const amount = euroCents(int(payload, 'amount_cents'));
    return `Bankbedrag ${amount} afgeletterd tegen factuur ${number} — de betaling staat geboekt`.replace('  ', ' ');
  },

  // ── Instellingen die de klantpost bepalen ────────────────────────────────
  'finance.set_reminder_settings': async (payload, ctx) => {
    const enabled = flag(payload, 'auto_reminders_enabled');
    const level1 = int(payload, 'level1_offset_days');
    const level2 = int(payload, 'level2_offset_days');
    const level3 = int(payload, 'level3_offset_days');
    await saveInvoiceReminderSettings(ctx.organizationId, {
      auto_reminders_enabled: enabled,
      level1_offset_days: level1,
      level2_offset_days: level2,
      level3_offset_days: level3,
      include_payment_link: flag(payload, 'include_payment_link'),
    });
    return enabled
      ? `Automatische betalingsherinneringen staan aan: niveau 1 na ${level1} dagen, 2 na ${level2}, 3 na ${level3}`
      : 'Automatische betalingsherinneringen staan uit';
  },

  'finance.set_dunning_settings': async (payload, ctx) => {
    const enabled = flag(payload, 'dunning_enabled');
    const offset = int(payload, 'dunning_offset_days');
    await saveInvoiceDunningSettings(ctx.organizationId, {
      dunning_enabled: enabled,
      dunning_offset_days: offset,
      dunning_collection_costs_vat: flag(payload, 'dunning_collection_costs_vat'),
    });
    return enabled
      ? `Debiteurenautomaat staat aan: een aanmaningsvoorstel na ${offset} dagen te laat`
      : 'Debiteurenautomaat staat uit';
  },

  'finance.set_email_template': async (payload, ctx) => {
    const key = text(payload, 'template_key') as EmailTemplateKey;
    await upsertEmailTemplate(ctx.organizationId, key, {
      enabled: flag(payload, 'enabled'),
      subject: optText(payload, 'subject'),
      intro: optText(payload, 'intro'),
      closing: optText(payload, 'closing'),
      cta_label: optText(payload, 'cta_label'),
    });
    return `E-mailtekst "${optText(payload, 'label') ?? key}" aangepast`;
  },

  'finance.reset_email_template': async (payload, ctx) => {
    const key = text(payload, 'template_key') as EmailTemplateKey;
    await resetEmailTemplate(ctx.organizationId, key);
    return `E-mailtekst "${optText(payload, 'label') ?? key}" staat weer op de standaardtekst`;
  },

  'finance.set_invoice_company_details': async (payload, ctx) => {
    const patch = patchOf(payload);
    const settings = await upsertCompanySettings(ctx.organizationId, companySettingsWithPatch(ctx, patch));
    const changed = Array.isArray(payload.changed) ? (payload.changed as unknown[]).map(String) : Object.keys(patch);
    return `Bedrijfsgegevens van ${settings.company_name} bijgewerkt op de factuur (${changed.join(', ')})`;
  },
};
