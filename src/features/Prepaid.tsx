import { useMemo, useState } from 'react';
import { CalendarClock, Landmark, Layers, Plus, Square, Trash2 } from 'lucide-react';
import type { AppData, LedgerAccount, PrepaidExpense, PurchaseInvoice } from '../types';
import { Modal } from '../components/Modal';
import { Button, Input, Select, Textarea } from '../components/Ui';
import { PageIcon } from '../components/PageIcon';
import { dateNL, euro } from '../lib/format';
import { amsterdamTodayIso } from '../lib/dates';
import {
  bookPrepaidExpenseStart, deletePrepaidExpense, endPrepaidExpense, ensureDefaultLedgerAccounts, postPrepaidReleases, savePrepaidExpense,
  type PrepaidExpenseInput,
} from '../lib/repository';
import { isOnBalance, monthEnd, monthLabel, prepaidSchedule, prepaidSummary, termGroups } from '../lib/prepaid';

/**
 * Vooruitbetaalde kosten: een betaling die over meerdere maanden naar de kosten
 * gaat (een verzekering voor drie jaar, een jaarabonnement, huur vooruit).
 * Het bedrag gaat naar de balans en elke maand een termijn naar de kosten.
 *
 * Het scherm schrijft niets zelf: vastleggen, boeken, beëindigen en
 * verwijderen lopen via de functies in de database (migratie 20261111220000),
 * die het register en het grootboek samen bijwerken. Corrigeren gaat met
 * tegenboeken in het Grootboek; het register gaat dan mee terug.
 */

const euroCents = (cents: number | null | undefined) => euro((cents ?? 0) / 100);
const centsFromInput = (v: string) => Math.round((parseFloat(String(v).replace(',', '.')) || 0) * 100);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

type PageProps = { data: AppData; organizationId: string; canWrite: boolean; onChanged: () => void };

const STATUS_LABEL: Record<PrepaidExpense['status'], string> = { active: 'Loopt', completed: 'Afgerond', ended: 'Beëindigd' };

/** Subsoorten die nooit "Vooruitbetaalde kosten" zijn; de database weigert ze ook (prepaid_check_account). */
const NOT_PREPAID = new Set(['bank', 'accounts_receivable', 'vat_input', 'psp_clearing', 'fixed_asset', 'accumulated_depreciation', 'accumulated_amortization', 'intangible_asset']);
const VAT_SUBTYPES = new Set(['vat_input', 'vat_output', 'vat_reverse', 'vat_payable']);

const accountLabel = (a: LedgerAccount) => `${a.code} · ${a.name}`;

function statusText(item: PrepaidExpense): string {
  if (item.status === 'active' && !isOnBalance(item)) return 'Nog niet geboekt';
  return STATUS_LABEL[item.status];
}

function statusClass(item: PrepaidExpense): string {
  if (item.status === 'active' && !isOnBalance(item)) return 'bk-prepaid-draft';
  return `bk-prepaid-${item.status}`;
}

function SetupBanner({ organizationId, canWrite, onChanged }: { organizationId: string; canWrite: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function setup() {
    setBusy(true); setError(null);
    try { await ensureDefaultLedgerAccounts(organizationId); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Aanmaken mislukt'); }
    finally { setBusy(false); }
  }
  return (
    <div className="bk-setup">
      <div>
        <strong>Boekhouding nog niet ingericht.</strong>
        <p>Maak eerst het rekeningschema aan (tabblad Grootboek) om vooruitbetaalde kosten te kunnen boeken.</p>
        {error && <p className="error">{error}</p>}
      </div>
      <Button variant="primary" disabled={!canWrite || busy} onClick={setup}>{busy ? 'Bezig…' : 'Rekeningschema aanmaken'}</Button>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="bk-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

/** "€ 27,78 per maand (28×) en € 27,77 (8×)" */
function perMonthText(amountCents: number, months: number, startDate: string): string {
  const groups = termGroups(prepaidSchedule(amountCents, months, startDate));
  if (groups.length === 0) return '';
  if (groups.length === 1) return `${euroCents(groups[0].amountCents)} per maand`;
  return `${euroCents(groups[0].amountCents)} per maand (${groups[0].count}×) en ${groups.slice(1).map(g => `${euroCents(g.amountCents)} (${g.count}×)`).join(' en ')}`;
}

export function PrepaidPage({ data, organizationId, canWrite, onChanged }: PageProps) {
  const [open, setOpen] = useState<PrepaidExpense | 'new' | null>(null);
  const today = amsterdamTodayIso();
  const lastAllowed = monthEnd(today);
  const [through, setThrough] = useState(lastAllowed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const rows = useMemo(() => data.prepaidExpenses.map(item => ({ item, summary: prepaidSummary(item, data.prepaidExpenseReleases, through) })),
    [data.prepaidExpenses, data.prepaidExpenseReleases, through]);
  const totals = useMemo(() => {
    const monthStart = `${today.slice(0, 8)}01`;
    let onBalance = 0; let thisMonth = 0; let dueCount = 0; let dueCents = 0;
    const active = new Set(data.prepaidExpenses.filter(p => p.status === 'active' && isOnBalance(p)).map(p => p.id));
    for (const { summary } of rows) { onBalance += summary.onBalanceCents; dueCount += summary.dueCount; dueCents += summary.dueCents; }
    for (const r of data.prepaidExpenseReleases) {
      if (r.date >= monthStart && r.date <= lastAllowed && (r.status === 'posted' || active.has(r.prepaid_expense_id))) thisMonth += r.amount_cents;
    }
    return { onBalance, thisMonth, dueCount, dueCents };
  }, [rows, data.prepaidExpenses, data.prepaidExpenseReleases, today, lastAllowed]);

  if (data.ledgerAccounts.length === 0) {
    return <div className="bk-page"><SetupBanner organizationId={organizationId} canWrite={canWrite} onChanged={onChanged} /></div>;
  }

  async function postAll() {
    if (through > lastAllowed) { setError(`Je boekt termijnen tot en met het einde van deze maand (${dateNL(lastAllowed)}).`); return; }
    if (!confirm(`${plural(totals.dueCount, 'termijn', 'termijnen')} (${euroCents(totals.dueCents)}) t/m ${dateNL(through)} naar de kosten boeken? Elke termijn wordt een journaalpost; corrigeren gaat met tegenboeken.`)) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await postPrepaidReleases(organizationId, through);
      setNotice(`${plural(result.posted_count, 'termijn', 'termijnen')} geboekt (${euroCents(result.posted_cents)}).`);
      onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : 'Boeken mislukt'); }
    finally { setBusy(false); }
  }

  return (
    <div className="bk-page">
      <div className="bk-head">
        <div><PageIcon page="prepaid" /><h2>Vooruitbetaalde kosten</h2><p>Betaal je vooruit, zoals een verzekering voor drie jaar? Dan staat het bedrag op de balans en gaat er elke maand een deel naar de kosten.</p></div>
        <Button variant="primary" disabled={!canWrite} onClick={() => setOpen('new')}><Plus size={15} /> Vooruitbetaling vastleggen</Button>
      </div>
      {error && <div className="error">{error}</div>}
      {notice && <div className="bk-note">{notice}</div>}
      {canWrite && totals.dueCount > 0 && (
        <div className="bk-acq bk-prepaid-due">
          <div className="bk-acq-text">
            <strong>{plural(totals.dueCount, 'termijn staat', 'termijnen staan')} klaar om te boeken</strong>
            <span className="bk-muted"> — {euroCents(totals.dueCents)} t/m {dateNL(through)} van de balans naar de kosten.</span>
          </div>
          <div className="bk-acq-actions">
            <Input type="date" value={through} max={lastAllowed} onChange={e => setThrough(e.target.value || lastAllowed)} aria-label="Boeken tot en met" />
            <Button variant="primary" onClick={postAll} disabled={busy}><CalendarClock size={14} /> {busy ? 'Bezig…' : 'Alles boeken'}</Button>
          </div>
        </div>
      )}
      {data.prepaidExpenses.length > 0 && <div className="bk-asset-kpis bk-prepaid-kpis">
        <div className="bk-asset-kpi-main"><span>Nog op de balans</span><strong>{euroCents(totals.onBalance)}</strong></div>
        <div><span>Deze maand naar de kosten</span><strong>{euroCents(totals.thisMonth)}</strong></div>
      </div>}
      {data.prepaidExpenses.length === 0
        ? <div className="empty">
            <div className="e-big">Nog geen vooruitbetalingen</div>
            <p>Leg een betaling vast die over meerdere maanden gaat: een verzekering, een jaarabonnement of huur vooruit. ResoFly maakt het schema en boekt per maand.</p>
          </div>
        : <div className="bk-table-wrap bk-prepaid-list"><table className="bk-table">
            <thead><tr><th>Omschrijving</th><th>Periode</th><th className="bk-num">Bedrag</th><th className="bk-num">Naar de kosten</th><th className="bk-num">Op de balans</th><th>Status</th></tr></thead>
            <tbody>{rows.map(({ item, summary }) => (
              <tr key={item.id} className="bk-row" onClick={() => setOpen(item)}>
                <td className="bk-prepaid-name"><strong>{item.description}</strong></td>
                <td data-label="Periode"><span><span className="bk-prepaid-period">{monthLabel(item.start_date)} – {monthLabel(summary.lastDate ?? monthEnd(item.start_date))}</span> <small className="bk-muted">· {item.months} mnd</small></span></td>
                <td data-label="Bedrag" className="bk-num">{euroCents(item.amount_cents)}</td>
                <td data-label="Naar de kosten" className="bk-num">{euroCents(summary.releasedCents)}</td>
                <td data-label="Op de balans" className="bk-num"><strong>{euroCents(summary.onBalanceCents)}</strong></td>
                <td data-label="Status"><span><span className={`status-pill ${statusClass(item)}`}>{statusText(item)}</span>{summary.dueCount > 0 && <small className="bk-muted"> · {summary.dueCount} klaar</small>}</span></td>
              </tr>
            ))}</tbody>
          </table></div>}
      {open && <PrepaidForm data={data} organizationId={organizationId} canWrite={canWrite}
        item={open === 'new' ? null : data.prepaidExpenses.find(p => p.id === open.id) ?? open}
        onClose={() => setOpen(null)} onChanged={onChanged} />}
    </div>
  );
}

type StartChoice = 'counter' | 'expense' | 'existing';

/**
 * Vastleggen (nieuw) of bekijken en bijwerken (bestaand). Een nieuwe post wordt
 * in één keer vastgelegd, naar de balans geboekt en, als je dat aanvinkt, tot en
 * met deze maand naar de kosten geboekt. Ook vanuit het Grootboek te openen.
 */
export function PrepaidForm({ data, organizationId, canWrite, item, onClose, onChanged }: {
  data: AppData; organizationId: string; canWrite: boolean; item: PrepaidExpense | null;
  onClose: () => void; onChanged: () => void;
}) {
  const today = amsterdamTodayIso();
  const lastAllowed = monthEnd(today);
  const active = data.ledgerAccounts.filter(a => a.is_active);
  const expenseAccounts = active.filter(a => a.type === 'expense');
  const prepaidAccounts = active.filter(a => a.type === 'asset' && !NOT_PREPAID.has(a.subtype ?? ''));
  const balanceAccounts = active.filter(a => (a.type === 'asset' || a.type === 'liability' || a.type === 'equity') && !VAT_SUBTYPES.has(a.subtype ?? ''));
  const byCode = (code: string) => active.find(a => a.code === code)?.id ?? '';
  // De rekening Vooruitbetaalde kosten: op subsoort, anders op naam. Is er nog
  // geen, dan blijft het veld leeg en maakt de database hem aan.
  const defaultPrepaid = prepaidAccounts.find(a => a.subtype === 'prepaid_expenses')?.id
    ?? prepaidAccounts.find(a => /vooruitbetaal/i.test(a.name))?.id ?? '';
  const hasPrepaidAccount = prepaidAccounts.some(a => a.subtype === 'prepaid_expenses');

  // De post zoals hij in de database staat. Na vastleggen houdt het venster de
  // teruggegeven rij vast tot de gegevens ververst zijn: anders stond er een
  // tel lang weer "Vastleggen en boeken", en gaf een tweede klik twee posten.
  const [snapshot, setSnapshot] = useState<PrepaidExpense | null>(item);
  const current = snapshot ? data.prepaidExpenses.find(p => p.id === snapshot.id && p.updated_at >= snapshot.updated_at) ?? snapshot : null;
  const releases = useMemo(() => current ? data.prepaidExpenseReleases.filter(r => r.prepaid_expense_id === current.id).sort((a, b) => a.period_index - b.period_index) : [],
    [data.prepaidExpenseReleases, current]);
  const posted = releases.filter(r => r.status === 'posted');
  const booked = Boolean(current && (current.start_journal_entry_id || current.end_journal_entry_id || current.status !== 'active' || posted.length > 0));
  const locked = !canWrite || booked;

  // Het formulier volgt de opgeslagen post: bij openen, en na elke opslag.
  // Anders bleef na vastleggen "nieuwe rekening" gekozen terwijl die rekening
  // er inmiddels was, en stond er bij Balansrekening alleen "Selecteer…".
  const formFrom = (it: PrepaidExpense | null) => {
    const counterIsExpense = Boolean(it?.counter_account_id && expenseAccounts.some(a => a.id === it.counter_account_id));
    return {
      description: it?.description ?? '',
      amount: it ? (it.amount_cents / 100).toFixed(2) : '',
      payment_date: it?.payment_date ?? today,
      start_date: it?.start_date ?? `${today.slice(0, 8)}01`,
      months: String(it?.months ?? 12),
      expense_account_id: it?.expense_account_id ?? byCode('4500'),
      prepaid_account_id: it?.prepaid_account_id ?? defaultPrepaid,
      choice: (it ? (it.start_mode === 'existing' ? 'existing' : counterIsExpense ? 'expense' : 'counter') : 'counter') as StartChoice,
      counter_account_id: it?.counter_account_id && !counterIsExpense ? it.counter_account_id : byCode('1100'),
      booked_on_account_id: it?.counter_account_id && counterIsExpense ? it.counter_account_id : (it?.expense_account_id ?? byCode('4500')),
      source_purchase_invoice_id: it?.source_purchase_invoice_id ?? '',
      notes: it?.notes ?? '',
    };
  };
  const [form, setForm] = useState(() => formFrom(item));
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm(f => ({ ...f, [key]: value }));
  const [postNow, setPostNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [throughDate, setThroughDate] = useState(lastAllowed);
  const [endDate, setEndDate] = useState(today);
  const [refund, setRefund] = useState('');
  const [refundAccount, setRefundAccount] = useState(byCode('1100'));

  const amountCents = centsFromInput(form.amount);
  const months = parseInt(form.months, 10) || 0;
  const preview = useMemo(() => prepaidSchedule(amountCents, months, form.start_date), [amountCents, months, form.start_date]);
  const previewDue = preview.filter(t => t.date <= lastAllowed);
  const counterId = form.choice === 'expense' ? form.booked_on_account_id : form.counter_account_id;
  const label = (id: string | null | undefined) => { const a = id ? data.ledgerAccounts.find(x => x.id === id) : undefined; return a ? accountLabel(a) : ''; };
  const prepaidLabel = form.prepaid_account_id ? label(form.prepaid_account_id) : 'Vooruitbetaalde kosten (nieuw)';
  const supplierName = (pi: PurchaseInvoice) => data.suppliers.find(s => s.id === pi.supplier_id)?.name ?? 'leverancier';
  const purchaseInvoices = useMemo(() => [...data.purchaseInvoices].sort((a, b) => b.date.localeCompare(a.date)), [data.purchaseInvoices]);
  const willPost = postNow && previewDue.length > 0;
  const bookLabel = form.choice === 'existing' && !willPost ? (current ? 'Opslaan' : 'Vastleggen') : (current ? 'Opslaan en boeken' : 'Vastleggen en boeken');

  /** Een inkoopfactuur kiezen vult in wat je er al van weet (alleen zolang er niets geboekt is). */
  function pickInvoice(id: string) {
    set('source_purchase_invoice_id', id);
    if (locked || !id) return;
    const pi = data.purchaseInvoices.find(p => p.id === id);
    if (!pi) return;
    const lineAccount = pi.lines.find(l => l.account_id)?.account_id ?? byCode('4500');
    const account = data.ledgerAccounts.find(a => a.id === lineAccount);
    setForm(f => ({
      ...f,
      description: f.description.trim() ? f.description : `${supplierName(pi)} ${pi.supplier_invoice_number ?? pi.internal_number ?? ''}`.trim(),
      amount: (pi.subtotal_cents / 100).toFixed(2),
      payment_date: pi.date,
      // Al geboekt? Dan staat het bedrag op de rekening van de factuurregel:
      // een kostenrekening (dan haalt ResoFly het daar weg), of al op de balans.
      ...(pi.journal_entry_id && account
        ? account.type === 'expense'
          ? { choice: 'expense' as StartChoice, booked_on_account_id: account.id }
          : prepaidAccounts.some(a => a.id === account.id) ? { choice: 'existing' as StartChoice, prepaid_account_id: account.id } : {}
        : {}),
    }));
  }

  function values(): PrepaidExpenseInput {
    const base: PrepaidExpenseInput = {
      description: form.description.trim(),
      source_purchase_invoice_id: form.source_purchase_invoice_id || null,
      notes: form.notes.trim() || null,
      expense_account_id: form.expense_account_id,
    };
    if (locked) return base;
    return {
      ...base,
      amount_cents: amountCents,
      payment_date: form.payment_date,
      start_date: form.start_date,
      months,
      prepaid_account_id: form.prepaid_account_id || null,
      start_mode: form.choice === 'existing' ? 'existing' : 'book',
      counter_account_id: form.choice === 'existing' ? null : counterId || null,
    };
  }

  function check(): string | null {
    if (!form.description.trim()) return 'Geef een omschrijving.';
    if (!form.expense_account_id) return 'Kies de kostenrekening.';
    if (locked) return null;
    if (amountCents <= 0) return 'Het bedrag moet groter zijn dan nul.';
    if (months < 1 || months > 600) return 'De looptijd is 1 tot en met 600 maanden.';
    if (!form.payment_date || !form.start_date) return 'Vul beide datums in.';
    if (form.choice !== 'existing' && !counterId) return 'Kies waar het bedrag vandaan komt.';
    if (form.choice !== 'existing' && counterId === form.prepaid_account_id) return 'De tegenrekening mag niet de balansrekening zelf zijn.';
    return null;
  }

  /** Vastleggen (of de wijzigingen opslaan), naar de balans boeken en zo nodig de termijnen t/m deze maand. */
  async function saveAndBook() {
    const problem = check();
    if (problem) { setError(problem); return; }
    const parts = [
      form.choice === 'existing' ? null : `${euroCents(amountCents)} naar de balans (debet ${prepaidLabel} / credit ${label(counterId)})`,
      willPost ? `${plural(previewDue.length, 'termijn', 'termijnen')} t/m ${dateNL(lastAllowed)} naar de kosten` : null,
    ].filter(Boolean);
    if (parts.length && !confirm(`Boeken: ${parts.join(', en ')}? Corrigeren gaat daarna met tegenboeken in het Grootboek.`)) return;
    setBusy(true); setError(null); setNotice(null);
    let saved: PrepaidExpense | null = null;
    try {
      saved = await savePrepaidExpense(organizationId, current?.id ?? null, values());
      setSnapshot(saved);
      setForm(formFrom(saved));
      if (saved.start_mode === 'book' && !saved.start_journal_entry_id) {
        saved = await bookPrepaidExpenseStart(organizationId, saved.id);
        setSnapshot(saved);
      }
      let postedText = '';
      if (willPost) {
        const result = await postPrepaidReleases(organizationId, lastAllowed, saved.id);
        postedText = result.posted_count ? `, en ${plural(result.posted_count, 'termijn', 'termijnen')} naar de kosten (${euroCents(result.posted_cents)})` : '';
      }
      setNotice(`${current ? 'Opgeslagen' : 'Vastgelegd'}${saved.start_mode === 'book' ? ' en naar de balans geboekt' : ''}${postedText}.`);
    } catch (e) {
      // Vastgelegd maar niet (helemaal) geboekt: het venster blijft op de post
      // staan, en "Opslaan en boeken" maakt het af.
      setError(`${e instanceof Error ? e.message : 'Boeken mislukt'}${saved ? ' De post is wel vastgelegd; met Opslaan en boeken maak je het af.' : ''}`);
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  /** Alleen opslaan: een omschrijving, notitie of kostenrekening, of een post die nog niet geboekt is. */
  async function saveOnly() {
    if (!current) return;
    const problem = check();
    if (problem) { setError(problem); return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      const saved = await savePrepaidExpense(organizationId, current.id, values());
      setSnapshot(saved);
      setForm(formFrom(saved));
      setNotice('Opgeslagen.');
      onChanged();
    }
    catch (e) { setError(e instanceof Error ? e.message : 'Opslaan mislukt'); }
    finally { setBusy(false); }
  }

  const dueReleases = releases.filter(r => r.status === 'scheduled' && r.date <= throughDate);
  async function postThrough() {
    if (!current) return;
    if (!confirm(`${plural(dueReleases.length, 'termijn', 'termijnen')} t/m ${dateNL(throughDate)} naar de kosten boeken? Elke termijn wordt een journaalpost.`)) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await postPrepaidReleases(organizationId, throughDate, current.id);
      setNotice(`${plural(result.posted_count, 'termijn', 'termijnen')} geboekt (${euroCents(result.posted_cents)}).`);
      onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : 'Boeken mislukt'); }
    finally { setBusy(false); }
  }

  const releasedCents = posted.reduce((s, r) => s + r.amount_cents, 0);
  const refundCents = centsFromInput(refund);
  const onBalance = current && current.status === 'active' && isOnBalance(current) ? current.amount_cents - releasedCents : 0;
  const dueBeforeEnd = releases.filter(r => r.status === 'scheduled' && r.date <= endDate);
  const restAtEnd = Math.max(onBalance - dueBeforeEnd.reduce((s, r) => s + r.amount_cents, 0), 0);
  async function endNow() {
    if (!current) return;
    const parts = [
      dueBeforeEnd.length ? `eerst ${plural(dueBeforeEnd.length, 'termijn', 'termijnen')} t/m ${dateNL(endDate)} naar de kosten` : null,
      refundCents > 0 ? `${euroCents(refundCents)} terug naar ${label(refundAccount)}` : null,
      restAtEnd - refundCents > 0 ? `${euroCents(restAtEnd - refundCents)} in één keer naar de kosten` : null,
    ].filter(Boolean);
    if (!confirm(`${current.description} beëindigen per ${dateNL(endDate)}: ${parts.join(', ')}. De overige termijnen vervallen. Terugdraaien gaat met tegenboeken in het Grootboek.`)) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const ended = await endPrepaidExpense(organizationId, current.id, endDate, refundCents, refundCents > 0 ? refundAccount : null);
      setSnapshot(ended);
      setNotice(ended.status === 'ended' ? 'Beëindigd.' : 'Alle termijnen waren al geboekt; de post is afgerond.');
      onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : 'Beëindigen mislukt'); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!current || !confirm(`${current.description} verwijderen? Dat kan zolang er niets in het grootboek staat.`)) return;
    setBusy(true); setError(null);
    try { await deletePrepaidExpense(organizationId, current.id); onChanged(); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Verwijderen mislukt'); setBusy(false); }
  }

  const lastRelease = releases.length ? releases[releases.length - 1].date : null;
  const endedToCosts = current?.status === 'ended' ? Math.max((current.end_amount_cents ?? 0) - (current.end_refund_cents ?? 0), 0) : 0;

  return (
    <Modal className="bk-modal-wide" title={current ? current.description : 'Vooruitbetaling vastleggen'} onClose={onClose}
      footer={<div className="bk-foot">
        {current && canWrite && !booked && <Button variant="danger" onClick={remove} disabled={busy}><Trash2 size={14} /> Verwijderen</Button>}
        <span className="bk-spacer" />
        <Button onClick={onClose}>{current ? 'Sluiten' : 'Annuleren'}</Button>
        {canWrite && current && <Button onClick={saveOnly} disabled={busy} variant={booked ? 'primary' : undefined}>{busy && booked ? 'Bezig…' : 'Opslaan'}</Button>}
        {canWrite && !booked && (!current || bookLabel !== 'Opslaan') && <Button variant="primary" onClick={saveAndBook} disabled={busy}>{busy ? 'Bezig…' : bookLabel}</Button>}
      </div>}>
      {error && <div className="error">{error}</div>}
      {notice && <div className="bk-note">{notice}</div>}

      {current && (
        <div className="bk-asset-kpis">
          <div><span>Bedrag</span><strong>{euroCents(current.amount_cents)}</strong></div>
          <div><span>Naar de kosten</span><strong>{euroCents(releasedCents + endedToCosts)}</strong></div>
          <div className="bk-asset-kpi-main"><span>Op de balans</span><strong>{euroCents(onBalance)}</strong></div>
        </div>
      )}
      {current && booked && current.status === 'active' && <div className="bk-note">Er is al geboekt: bedrag, datums, looptijd en balansrekening liggen vast. De omschrijving, de kostenrekening (voor de termijnen die nog komen) en de notities kun je wijzigen. Corrigeren gaat met tegenboeken in het Grootboek: eerst de termijnen, dan de boeking naar de balans. Het schema gaat mee terug.</div>}
      {current && !booked && <div className="bk-note">Nog niet geboekt. Pas zo nodig iets aan en kies {bookLabel === 'Opslaan' ? 'Opslaan' : `"${bookLabel}"`}.</div>}

      <div className="bk-grid2 bk-prepaid-grid">
        <Field label="Omschrijving"><Input value={form.description} onChange={e => set('description', e.target.value)} disabled={!canWrite} placeholder="Bijv. bedrijfsaansprakelijkheidsverzekering" maxLength={200} /></Field>
        <Field label="Bedrag (excl. btw)" hint={locked ? undefined : 'Btw op de factuur? Boek die via Inkoopfacturen, dan gaat hij naar je aangifte.'}>
          <Input type="number" step="0.01" min="0" inputMode="decimal" value={form.amount} onChange={e => set('amount', e.target.value)} disabled={locked} placeholder="0,00" />
        </Field>
        <Field label="Betaald op" hint={locked ? undefined : 'Of de factuurdatum.'}><Input type="date" value={form.payment_date} onChange={e => set('payment_date', e.target.value)} disabled={locked} /></Field>
        <Field label="Geldt vanaf" hint={locked ? undefined : 'De eerste maand; elke termijn valt op de laatste dag van de maand.'}><Input type="date" value={form.start_date} onChange={e => set('start_date', e.target.value)} disabled={locked} /></Field>
        <Field label="Looptijd (maanden)" hint={locked ? undefined : 'Bijv. 36 voor drie jaar.'}><Input type="number" step="1" min="1" max="600" inputMode="numeric" value={form.months} onChange={e => set('months', e.target.value)} disabled={locked} /></Field>
        <Field label="Kostenrekening" hint="Waar elke maand een deel op komt, bijv. Verzekeringen.">
          <Select value={form.expense_account_id} onChange={e => set('expense_account_id', e.target.value)} disabled={!canWrite || (current ? current.status !== 'active' : false)}>
            <option value="">— kies —</option>
            {expenseAccounts.map(a => <option key={a.id} value={a.id}>{accountLabel(a)}</option>)}
          </Select>
        </Field>
        <Field label="Balansrekening" hint={locked || hasPrepaidAccount ? undefined : 'Nog geen rekening Vooruitbetaalde kosten: ResoFly maakt hem aan bij de vorderingen.'}>
          <Select value={form.prepaid_account_id} onChange={e => set('prepaid_account_id', e.target.value)} disabled={locked}>
            {!hasPrepaidAccount && <option value="">Vooruitbetaalde kosten (nieuw)</option>}
            {prepaidAccounts.map(a => <option key={a.id} value={a.id}>{accountLabel(a)}</option>)}
          </Select>
        </Field>
        <Field label="Inkoopfactuur" hint="Optioneel: de factuur waar het bij hoort.">
          <Select value={form.source_purchase_invoice_id} onChange={e => pickInvoice(e.target.value)} disabled={!canWrite}>
            <option value="">— geen —</option>
            {purchaseInvoices.map(pi => <option key={pi.id} value={pi.id}>{pi.internal_number || pi.supplier_invoice_number || pi.date} · {supplierName(pi)} · {euroCents(pi.total_cents)}</option>)}
          </Select>
        </Field>
      </div>

      {!locked && (
        <div className="bk-prepaid-start">
          <Field label="Hoe staat het bedrag nu in je boekhouding?">
            <Select value={form.choice} onChange={e => set('choice', e.target.value as StartChoice)}>
              <option value="counter">Nog niet geboekt: ResoFly boekt het naar de balans</option>
              <option value="expense">Al als kosten geboekt (inkoopfactuur of bank op een kostenrekening)</option>
              <option value="existing">Staat al op de balansrekening (of in de beginbalans)</option>
            </Select>
          </Field>
          {form.choice === 'counter' && (
            <Field label="Betaald via" hint="Meestal Bank. Boek dezelfde betaling dan niet nog eens bij de bank; staat hij daar al, kies dan hierboven hoe je hem boekte.">
              <Select value={form.counter_account_id} onChange={e => set('counter_account_id', e.target.value)}>
                <option value="">— kies —</option>
                {balanceAccounts.filter(a => a.id !== form.prepaid_account_id && a.subtype !== 'prepaid_expenses').map(a => <option key={a.id} value={a.id}>{accountLabel(a)}</option>)}
              </Select>
            </Field>
          )}
          {form.choice === 'expense' && (
            <Field label="Geboekt op" hint="ResoFly haalt het bedrag van deze kostenrekening af en zet het op de balans; daarna gaat er elke maand een deel terug naar de kosten.">
              <Select value={form.booked_on_account_id} onChange={e => set('booked_on_account_id', e.target.value)}>
                <option value="">— kies —</option>
                {expenseAccounts.map(a => <option key={a.id} value={a.id}>{accountLabel(a)}</option>)}
              </Select>
            </Field>
          )}
          {form.choice === 'existing' && <p className="bk-muted">Bijvoorbeeld omdat je de bankregel of de inkoopfactuur direct op {prepaidLabel} boekte, of omdat het bedrag in je beginbalans zit. ResoFly boekt dan alleen de maandtermijnen. Begon de periode vóór je boekhouding in ResoFly? Vul dan in wat er bij de start nog op de balans stond, met de maanden die toen nog over waren.</p>}
        </div>
      )}

      {!locked && preview.length > 0 && (
        <div className="bk-note bk-prepaid-preview">
          <strong>{perMonthText(amountCents, months, form.start_date)}</strong>, van {monthLabel(preview[0].date)} t/m {monthLabel(preview[preview.length - 1].date)}.{' '}
          {form.choice === 'existing' ? 'Er gaat niets naar de balans' : <>Bij boeken gaat {euroCents(amountCents)} naar de balans (debet {prepaidLabel} / credit {label(counterId) || '…'})</>}
          {willPost ? <>, en {plural(previewDue.length, 'termijn', 'termijnen')} t/m {dateNL(lastAllowed)} naar de kosten ({euroCents(previewDue.reduce((s, t) => s + t.amountCents, 0))})</> : null}.
          {previewDue.length > 0 && (
            <label className="bk-prepaid-check"><input type="checkbox" checked={postNow} onChange={e => setPostNow(e.target.checked)} /> Termijnen t/m {dateNL(lastAllowed)} meteen boeken ({previewDue.length})</label>
          )}
        </div>
      )}

      <Field label="Notities"><Textarea value={form.notes} onChange={e => set('notes', e.target.value)} disabled={!canWrite} rows={2} placeholder="Bijv. polisnummer" /></Field>

      {current && current.status === 'ended' && (
        <div className="bk-note bk-acq-done"><Landmark size={14} /> Beëindigd per {dateNL(current.end_date)}: {euroCents(current.end_amount_cents)} van de balans{current.end_refund_cents ? `, waarvan ${euroCents(current.end_refund_cents)} terug naar ${label(current.end_refund_account_id)}` : ''}{endedToCosts > 0 ? ` en ${euroCents(endedToCosts)} naar de kosten` : ''}.</div>
      )}
      {current && current.status === 'completed' && (
        <div className="bk-note bk-acq-done"><Landmark size={14} /> Afgerond: het hele bedrag is naar de kosten.</div>
      )}

      {current && canWrite && current.status === 'active' && isOnBalance(current) && (
        <div className="bk-acq bk-dispose">
          <div className="bk-acq-text">
            <strong>Eerder stoppen</strong>
            <span className="bk-muted"> Opgezegd of beëindigd? Eerst gaan de termijnen t/m de einddatum naar de kosten. Wat dan nog op de balans staat ({euroCents(restAtEnd)}), gaat in één keer weg: een terugbetaling naar de rekening die je kiest, de rest naar de kosten.</span>
          </div>
          <div className="bk-acq-actions">
            <Input type="date" value={endDate} max={lastAllowed} onChange={e => setEndDate(e.target.value)} aria-label="Einddatum" />
            <Input type="number" step="0.01" min="0" inputMode="decimal" value={refund} onChange={e => setRefund(e.target.value)} placeholder="Terugbetaling € 0,00" aria-label="Terugbetaling" />
            {refundCents > 0 && (
              <Select value={refundAccount} onChange={e => setRefundAccount(e.target.value)} aria-label="Rekening van de terugbetaling">
                <option value="">— rekening —</option>
                {balanceAccounts.filter(a => a.id !== current.prepaid_account_id).map(a => <option key={a.id} value={a.id}>{accountLabel(a)}</option>)}
              </Select>
            )}
            <Button variant="danger" onClick={endNow} disabled={busy || !endDate || (refundCents > 0 && !refundAccount)}><Square size={13} /> Beëindigen</Button>
          </div>
        </div>
      )}

      {current && booked ? (
        <div className="bk-schedule bk-prepaid-sched">
          <div className="bk-schedule-head">
            <h4><Layers size={15} /> Schema{lastRelease ? ` · ${monthLabel(current.start_date)} t/m ${monthLabel(lastRelease)}` : ''}</h4>
            {canWrite && current.status === 'active' && isOnBalance(current) && releases.some(r => r.status === 'scheduled') && (
              <div className="bk-schedule-actions">
                <span className="bk-post-inline">
                  <Input type="date" value={throughDate} max={lastAllowed} onChange={e => setThroughDate(e.target.value || lastAllowed)} aria-label="Boeken tot en met" />
                  <Button variant="primary" onClick={postThrough} disabled={busy || dueReleases.length === 0 || throughDate > lastAllowed}><CalendarClock size={14} /> Boek t/m ({dueReleases.length})</Button>
                </span>
              </div>
            )}
          </div>
          {releases.length === 0
            ? <p className="bk-muted">{current.status === 'ended' ? 'Geen termijnen meer: de post is beëindigd.' : current.status === 'completed' ? 'Geen termijnen meer: alles is geboekt.' : 'Schema laden…'}</p>
            : <div className="bk-table-wrap bk-prepaid-schedule"><table className="bk-table">
                <thead><tr><th>#</th><th>Maand</th><th className="bk-num">Naar de kosten</th><th className="bk-num bk-prepaid-after">Daarna op de balans</th><th>Status</th></tr></thead>
                <tbody>{releases.map(r => (
                  <tr key={r.id}>
                    <td>{r.period_index}</td>
                    <td>{monthLabel(r.date)}</td>
                    <td className="bk-num">{euroCents(r.amount_cents)}</td>
                    <td className="bk-num bk-prepaid-after">{euroCents(r.remaining_after_cents)}</td>
                    <td><span className={`status-pill bk-dep-${r.status}`}>{r.status === 'posted' ? 'Geboekt' : 'Gepland'}</span></td>
                  </tr>
                ))}</tbody>
              </table></div>}
        </div>
      ) : preview.length > 0 && (
        <div className="bk-schedule">
          <div className="bk-schedule-head"><h4><Layers size={15} /> Schema</h4></div>
          <div className="bk-table-wrap bk-prepaid-schedule"><table className="bk-table">
            <thead><tr><th>#</th><th>Maand</th><th className="bk-num">Naar de kosten</th><th className="bk-num">Daarna op de balans</th></tr></thead>
            <tbody>{preview.map(t => (
              <tr key={t.periodIndex}>
                <td>{t.periodIndex}</td>
                <td>{monthLabel(t.date)}</td>
                <td className="bk-num">{euroCents(t.amountCents)}</td>
                <td className="bk-num">{euroCents(t.remainingAfterCents)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </div>
      )}
    </Modal>
  );
}
