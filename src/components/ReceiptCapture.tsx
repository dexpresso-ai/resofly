import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Camera, CheckCircle2, FileText, Images, PenLine, RotateCcw, Sparkles } from 'lucide-react';
import type { AppData, PurchaseInvoiceInboxItem, UUID } from '../types';
import { Modal } from './Modal';
import { Button, Select } from './Ui';
import { StepTrack, useElapsed } from './StepTrack';
import { dateNL, euro } from '../lib/format';
import { formatElapsed } from '../lib/reportBuild';
import { readableError } from '../lib/networkRetry';
import { newClientRequestId, prepareReceiptFile, uploadReceipt, type DeclarationReceipt, type ReceiptInvoiceSummary } from '../lib/receipt-api';
import { runInvoiceInboxAction } from '../lib/invoice-inbox-api';
import {
  DECLARATION_STEPS, RECEIPT_ACCEPT, RECEIPT_STEPS, RECEIPTS_PER_BATCH, isPdfFile, readingLine, receiptOutcomeKind,
  receiptUnreadReason, type ReceiptOutcomeKind,
} from '../lib/receipts';

/**
 * Bon fotograferen (2026-11-18).
 *
 * Eén tik op "Bon fotograferen" en de camera gaat open (op een computer: de
 * bestandskiezer). Zodra de foto er is, opent dit venster: Gerrie leest de
 * bon, en dat zie je gebeuren. Daarna de keuze: Verder (het concept nakijken,
 * of terug naar je declaraties) of meteen de volgende bon.
 *
 * Twee standen, op grond van de rechten op Financiën (de server beslist het
 * ook zo, zie invoice-inbox):
 *  - 'receipt'      wie Financiën mag bewerken: de bon wordt een
 *                   concept-inkoopfactuur, met de foto als bewijsstuk;
 *  - 'declaration'  ieder ander teamlid: de bon wordt een declaratie die
 *                   iemand met Financiën goedkeurt. Je ziet alleen je eigen bon.
 *
 * Een browser opent de camera alleen na een tik van de gebruiker. Daarom
 * openen "Bon fotograferen" en "Nieuwe boeking" hem rechtstreeks in de klik,
 * en komt het venster pas als er een foto is.
 */

export type ReceiptMode = 'receipt' | 'declaration';

const euroCents = (cents: number | null | undefined) => euro((cents ?? 0) / 100);

type JobResult =
  | { channel: 'receipt'; item: PurchaseInvoiceInboxItem; invoice: ReceiptInvoiceSummary | null }
  | { channel: 'declaration'; declaration: DeclarationReceipt };

interface Job {
  id: string;
  file: File;
  /** De verkleinde foto (of de pdf zoals hij is), zodra die klaar is. */
  prepared: File | null;
  previewUrl: string | null;
  phase: number;
  startedAt: number;
  state: 'waiting' | 'working' | 'done' | 'error';
  result: JobResult | null;
  error: string | null;
  retrying: boolean;
}

export interface ReceiptCaptureProps {
  organizationId: UUID;
  mode: ReceiptMode;
  /** Voor de keuzelijst met leveranciers als de winkel nog onbekend is (alleen 'receipt'). */
  data?: AppData;
  disabled?: boolean;
  /** Er is iets aangemaakt of gewijzigd: de werkruimte (of de lijst) opnieuw laden. */
  onChanged: () => void;
  /** 'receipt': Verder opent dit concept (of de bestaande factuur bij een dubbele bon). */
  onOpenInvoice?: (purchaseInvoiceId: UUID) => void;
  /** 'receipt': "Zelf invullen" als Gerrie de bon niet kon lezen. */
  onFillIn?: (item: PurchaseInvoiceInboxItem, file: File | null) => void;
  /** Kleinere knoppen (in een kop met andere knoppen). */
  compact?: boolean;
}

export function ReceiptCapture({ organizationId, mode, data, disabled = false, onChanged, onOpenInvoice, onFillIn, compact = false }: ReceiptCaptureProps) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [open, setOpen] = useState(false);
  // Een venster dat dichtging terwijl Gerrie las, krijgt de uitslag niet meer
  // in beeld; de bon staat dan gewoon op de werklijst of in je declaraties.
  const sessionRef = useRef(0);
  const jobsRef = useRef<Job[]>([]);
  jobsRef.current = jobs;

  const isDeclaration = mode === 'declaration';
  const steps = isDeclaration ? DECLARATION_STEPS : RECEIPT_STEPS;
  const againLabel = isDeclaration ? 'Nieuwe declaratie' : 'Nieuwe boeking';

  const patch = useCallback((id: string, update: Partial<Job>) => {
    setJobs(list => list.map(job => (job.id === id ? { ...job, ...update } : job)));
  }, []);

  // Voorbeeldplaatjes opruimen als het venster dichtgaat of de lijst wisselt.
  useEffect(() => () => { jobsRef.current.forEach(job => job.previewUrl && URL.revokeObjectURL(job.previewUrl)); }, []);

  const runJob = useCallback(async (job: Job, session: number) => {
    const alive = () => sessionRef.current === session;
    patch(job.id, { state: 'working', phase: 0, startedAt: Date.now() });
    let prepared: File;
    try {
      prepared = await prepareReceiptFile(job.file);
    } catch (error) {
      if (alive()) patch(job.id, { state: 'error', error: readableError(error, 'De foto kon niet worden klaargemaakt.') });
      return;
    }
    if (!alive()) return;
    const previewUrl = isPdfFile(prepared) ? null : URL.createObjectURL(prepared);
    patch(job.id, { prepared, previewUrl, phase: 1 });
    // Versturen is na een tel gebeurd; daarna is het wachten op Gerrie. De
    // server geeft één antwoord, dus de stap "lezen" begint op de klok.
    const reading = window.setTimeout(() => { if (alive()) patch(job.id, { phase: 2 }); }, 1200);
    try {
      const result = await uploadReceipt(organizationId, prepared, job.id, {
        onRetry: () => { if (alive()) patch(job.id, { retrying: true }); },
      });
      window.clearTimeout(reading);
      if (!alive()) { onChanged(); return; }
      patch(job.id, { phase: steps.length, state: 'done', result, retrying: false });
      onChanged();
    } catch (error) {
      window.clearTimeout(reading);
      if (alive()) patch(job.id, { state: 'error', retrying: false, error: readableError(error, 'Insturen mislukt.') });
    }
  }, [organizationId, onChanged, patch, steps.length]);

  const start = useCallback(async (files: File[]) => {
    const picked = files.slice(0, RECEIPTS_PER_BATCH);
    if (picked.length === 0) return;
    jobsRef.current.forEach(job => job.previewUrl && URL.revokeObjectURL(job.previewUrl));
    const session = sessionRef.current + 1;
    sessionRef.current = session;
    const fresh: Job[] = picked.map(file => ({
      id: newClientRequestId(), file, prepared: null, previewUrl: null, phase: 0, startedAt: Date.now(),
      state: 'waiting', result: null, error: null, retrying: false,
    }));
    setJobs(fresh);
    setOpen(true);
    // Na elkaar, niet tegelijk: één bon tegelijk in beeld, en de server krijgt
    // geen tien uitleesopdrachten in dezelfde seconde.
    for (const job of fresh) {
      if (sessionRef.current !== session) return;
      await runJob(job, session);
    }
  }, [runJob]);

  function onFiles(input: HTMLInputElement | null) {
    const files = input?.files ? Array.from(input.files) : [];
    if (input) input.value = '';
    void start(files);
  }

  function close() {
    sessionRef.current += 1;
    setOpen(false);
    jobsRef.current.forEach(job => job.previewUrl && URL.revokeObjectURL(job.previewUrl));
    setJobs([]);
  }

  const working = jobs.some(job => job.state === 'working' || job.state === 'waiting');
  const current = jobs.find(job => job.state === 'working') ?? jobs.find(job => job.state === 'waiting') ?? null;
  const finished = jobs.length > 0 && !working;
  const tooMany = useRef(false);

  return (
    <>
      <div className={`rcp-launch${compact ? ' is-compact' : ''}`}>
        <Button variant="primary" disabled={disabled} onClick={() => cameraRef.current?.click()}
          title="Op je telefoon gaat de camera open; op een computer kies je een foto of pdf.">
          <Camera size={15} /> Bon fotograferen
        </Button>
        <Button disabled={disabled} onClick={() => pickRef.current?.click()} title={`Foto's of pdf-scans uit je galerij of bestanden, tot ${RECEIPTS_PER_BATCH} tegelijk`}>
          <Images size={15} /> Uit galerij
        </Button>
      </div>
      {/* capture="environment": op een telefoon meteen de achtercamera. */}
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden data-receipt-input="camera" onChange={e => {
        tooMany.current = false;
        onFiles(e.currentTarget);
      }} />
      <input ref={pickRef} type="file" accept={RECEIPT_ACCEPT} multiple hidden data-receipt-input="pick" onChange={e => {
        tooMany.current = (e.currentTarget.files?.length ?? 0) > RECEIPTS_PER_BATCH;
        onFiles(e.currentTarget);
      }} />

      {open && (
        <Modal className="rcp-modal" title={isDeclaration ? 'Declaratie' : 'Bon fotograferen'} onClose={close}
          footer={finished ? (
            <div className="rcp-foot">
              <Button onClick={() => cameraRef.current?.click()}><Camera size={15} /> {againLabel}</Button>
              <span className="bk-spacer" />
              <ContinueButton jobs={jobs} mode={mode} onOpenInvoice={onOpenInvoice} onClose={close} />
            </div>
          ) : undefined}>
          {current && <ReceiptWorking job={current} steps={steps} index={jobs.indexOf(current)} total={jobs.length} isDeclaration={isDeclaration} />}
          {finished && tooMany.current && <p className="bk-muted rcp-note">Je koos meer dan {RECEIPTS_PER_BATCH} bestanden; de eerste {RECEIPTS_PER_BATCH} zijn ingestuurd.</p>}
          {finished && jobs.length === 1 && (
            <ReceiptResult job={jobs[0]} mode={mode} data={data} organizationId={organizationId}
              onItem={(item, invoice) => patch(jobs[0].id, { result: { channel: 'receipt', item, invoice } })}
              onChanged={onChanged}
              onFillIn={(item, file) => { close(); onFillIn?.(item, file); }} />
          )}
          {finished && jobs.length > 1 && (
            <ul className="rcp-batch">
              {jobs.map((job, i) => (
                <li key={job.id}>
                  <span className="rcp-batch-num">{i + 1}</span>
                  <BatchLine job={job} mode={mode} />
                </li>
              ))}
            </ul>
          )}
        </Modal>
      )}
    </>
  );
}

/**
 * Verder: bij één bon met een concept opent dat concept (of bij een dubbele
 * bon de factuur die er al was). Anders sluit het venster; wat nog aandacht
 * vraagt staat op de werklijst, en een declaratie in je lijst.
 */
function ContinueButton({ jobs, mode, onOpenInvoice, onClose }: { jobs: Job[]; mode: ReceiptMode; onOpenInvoice?: (id: UUID) => void; onClose: () => void }) {
  const only = jobs.length === 1 ? jobs[0] : null;
  const item = only?.result?.channel === 'receipt' ? only.result.item : null;
  const target = mode === 'receipt' && item
    ? (receiptOutcomeKind(item) === 'concept' ? item.purchase_invoice_id : receiptOutcomeKind(item) === 'duplicate' ? item.duplicate_of_purchase_invoice_id : null)
    : null;
  return (
    <Button variant="primary" onClick={() => { onClose(); if (target) onOpenInvoice?.(target); }}>
      Verder
    </Button>
  );
}

// ── Gerrie aan het werk ──────────────────────────────────────────────────────

function ReceiptWorking({ job, steps, index, total, isDeclaration }: { job: Job; steps: readonly string[]; index: number; total: number; isDeclaration: boolean }) {
  const elapsed = useElapsed(job.startedAt);
  const status = job.retrying
    ? 'Geen verbinding. Zodra je weer online bent, gaat het verder…'
    : job.phase === 0 ? 'De foto rechtzetten en verkleinen…'
    : job.phase === 1 ? 'Versturen…'
    : readingLine(elapsed - 1200);
  return (
    <section className="rcp-working" aria-label="Gerrie leest je bon" data-phase={job.phase}>
      <div className="rcp-stage" aria-hidden="true">
        {/* Het kader draagt de hoeken van het scanvak; het bonnetje zelf heeft
            een kartelrand (clip-path), en die zou de hoeken wegknippen. */}
        <div className="rcp-frame">
          <div className="rcp-paper">
            {job.previewUrl
              ? <img src={job.previewUrl} alt="" />
              : <span className="rcp-paper-blank"><FileText size={34} /><i /><i /><i /><i /></span>}
            <span className="rcp-beam" />
          </div>
          <span className="rcp-corner rcp-corner-tl" /><span className="rcp-corner rcp-corner-tr" />
          <span className="rcp-corner rcp-corner-bl" /><span className="rcp-corner rcp-corner-br" />
        </div>
        <span className="aire-orb rcp-orb"><i /><i /><i /><i /></span>
      </div>
      <div className="rcp-info">
        <div className="rcp-info-head">
          <span className="aire-build-badge" aria-hidden="true"><Sparkles size={15} /></span>
          <div className="rcp-info-text">
            <b>{total > 1 ? `Gerrie leest bon ${index + 1} van ${total}` : 'Gerrie leest je bon'}</b>
            <span role="status">{status}</span>
          </div>
          <span className="aire-build-time" title="Zo lang is Gerrie al bezig">{formatElapsed(elapsed)}</span>
        </div>
        <StepTrack steps={steps} phase={Math.min(job.phase, steps.length - 1)} />
        <p className="rcp-note">
          {isDeclaration
            ? 'Je declaratie wordt ingediend zodra Gerrie klaar is. Dit duurt meestal 10 tot 20 seconden.'
            : 'De bon wordt een concept met de foto als bewijsstuk. Er wordt niets geboekt. Dit duurt meestal 10 tot 20 seconden.'}
        </p>
      </div>
    </section>
  );
}

// ── De uitslag ───────────────────────────────────────────────────────────────

function Summary({ store, date, total, currency }: { store: string | null; date: string | null; total: number | null; currency?: string | null }) {
  return (
    <dl className="rcp-summary">
      <div><dt>Winkel</dt><dd>{store || '—'}</dd></div>
      <div><dt>Datum</dt><dd>{date ? dateNL(date) : '—'}</dd></div>
      <div><dt>Totaal</dt><dd>{total != null ? `${currency && currency !== 'EUR' ? `${currency} ` : ''}${euroCents(total)}` : '—'}</dd></div>
    </dl>
  );
}

function ReceiptResult({ job, mode, data, organizationId, onItem, onChanged, onFillIn }: {
  job: Job; mode: ReceiptMode; data?: AppData; organizationId: UUID;
  onItem: (item: PurchaseInvoiceInboxItem, invoice: ReceiptInvoiceSummary | null) => void;
  onChanged: () => void;
  onFillIn: (item: PurchaseInvoiceInboxItem, file: File | null) => void;
}) {
  if (job.state === 'error' || !job.result) {
    return (
      <div className="rcp-result is-error" role="alert">
        <AlertTriangle size={22} />
        <div>
          <b>De bon is niet ingestuurd</b>
          <p>{job.error ?? 'Er ging iets mis.'}</p>
          <p className="bk-muted">Er is niets opgeslagen. Probeer het opnieuw met {mode === 'declaration' ? 'Nieuwe declaratie' : 'Nieuwe boeking'}.</p>
        </div>
      </div>
    );
  }
  if (job.result.channel === 'declaration') return <DeclarationResult declaration={job.result.declaration} />;
  return <FinanceResult item={job.result.item} invoice={job.result.invoice} file={job.prepared} data={data} organizationId={organizationId}
    onItem={onItem} onChanged={onChanged} onFillIn={onFillIn} />;
}

function DeclarationResult({ declaration }: { declaration: DeclarationReceipt }) {
  return (
    <div className="rcp-result is-done">
      <CheckCircle2 size={22} />
      <div>
        <b>Je declaratie is ingediend</b>
        {declaration.read
          ? <p>Gerrie heeft je bon gelezen. Iemand van Financiën kijkt hem na en keurt hem goed.</p>
          : declaration.status === 'processing'
            ? <p>Gerrie leest hem nog. Je ziet hem zo in je lijst.</p>
            : <p>Gerrie kon de bon niet helemaal lezen; de administratie vult de bedragen in. Je hoeft niets te doen.</p>}
        {declaration.read && <Summary store={declaration.store_name} date={declaration.receipt_date} total={declaration.total_cents} currency={declaration.currency} />}
      </div>
    </div>
  );
}

function FinanceResult({ item, invoice, file, data, organizationId, onItem, onChanged, onFillIn }: {
  item: PurchaseInvoiceInboxItem; invoice: ReceiptInvoiceSummary | null; file: File | null; data?: AppData; organizationId: UUID;
  onItem: (item: PurchaseInvoiceInboxItem, invoice: ReceiptInvoiceSummary | null) => void;
  onChanged: () => void;
  onFillIn: (item: PurchaseInvoiceInboxItem, file: File | null) => void;
}) {
  const kind: ReceiptOutcomeKind = receiptOutcomeKind(item);
  const proposal = item.proposal;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const suppliers = useMemo(() => [...(data?.suppliers ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'nl')), [data?.suppliers]);
  const [supplierChoice, setSupplierChoice] = useState<string>(proposal?.supplier.name ? '__new__' : '');

  async function act(label: string, input: Parameters<typeof runInvoiceInboxAction>[2]) {
    setBusy(label); setError(null);
    try {
      const next = await runInvoiceInboxAction(organizationId, item.id, input);
      onItem(next, null);
      onChanged();
    } catch (e) {
      setError(readableError(e, 'Dat lukte niet.'));
    } finally {
      setBusy(null);
    }
  }

  const store = invoice?.supplier_name ?? proposal?.supplier.name ?? null;
  const total = invoice?.total_cents ?? proposal?.totals.total_cents ?? null;
  const date = invoice?.date ?? proposal?.date ?? null;
  const duplicateOf = item.duplicate_of_purchase_invoice_id ? data?.purchaseInvoices.find(pi => pi.id === item.duplicate_of_purchase_invoice_id) : null;
  const fillIn = <Button onClick={() => onFillIn(item, file)}><PenLine size={14} /> Zelf invullen</Button>;

  return (
    <div className={`rcp-result ${kind === 'concept' ? 'is-done' : 'is-attention'}`}>
      {kind === 'concept' ? <CheckCircle2 size={22} /> : <AlertTriangle size={22} />}
      <div>
        {kind === 'concept' && <>
          <b>Opgeslagen als concept{invoice?.internal_number ? ` ${invoice.internal_number}` : ''}</b>
          <p>Kijk het na en boek het als het klopt. De foto hangt eraan als bewijsstuk.</p>
        </>}
        {kind === 'supplier' && <>
          <b>Gelezen, maar de winkel is nog geen leverancier</b>
          <p>Kies de leverancier of maak hem aan; daarna staat de bon als concept klaar.</p>
          <div className="rcp-actions">
            <Select value={supplierChoice} onChange={e => setSupplierChoice(e.target.value)} disabled={busy != null} aria-label="Leverancier">
              <option value="">Kies een leverancier…</option>
              {proposal?.supplier.name && <option value="__new__">➕ Nieuwe leverancier: {proposal.supplier.name}</option>}
              {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
            <Button variant="primary" disabled={busy != null || !supplierChoice}
              onClick={() => act('prepare', supplierChoice === '__new__' ? { action: 'prepare', createSupplier: true } : { action: 'prepare', supplierId: supplierChoice })}>
              {busy === 'prepare' ? 'Bezig…' : 'Opslaan als concept'}
            </Button>
          </div>
        </>}
        {kind === 'duplicate' && <>
          <b>Deze bon is al eerder ingestuurd</b>
          <p>{duplicateOf ? <>Hij staat al als <strong>{duplicateOf.internal_number ?? duplicateOf.supplier_invoice_number ?? 'inkoopfactuur'}</strong>. </> : null}Er is geen tweede concept gemaakt. Verder opent de bon die er al is.</p>
          {proposal && <div className="rcp-actions">
            <Button disabled={busy != null} onClick={() => act('force', { action: 'prepare', allowDuplicate: true })}>{busy === 'force' ? 'Bezig…' : 'Toch opslaan als concept'}</Button>
          </div>}
        </>}
        {kind === 'unread' && <>
          <b>Opgeslagen, maar niet gelezen</b>
          <p>{receiptUnreadReason(item.reason)} De foto staat op de werklijst; vul de bon zelf in.</p>
          <div className="rcp-actions">{fillIn}</div>
        </>}
        {kind === 'failed' && <>
          <b>Uitlezen mislukte</b>
          <p>{item.error_message ? 'Er ging iets mis bij Gerrie.' : receiptUnreadReason(item.reason)} De foto is bewaard; probeer het opnieuw of vul de bon zelf in.</p>
          <div className="rcp-actions">
            <Button disabled={busy != null} onClick={() => act('retry', { action: 'process' })}><RotateCcw size={14} /> {busy === 'retry' ? 'Bezig…' : 'Opnieuw proberen'}</Button>
            {fillIn}
          </div>
        </>}
        {kind === 'processing' && <>
          <b>Gerrie is nog bezig</b>
          <p>De verbinding viel even weg. De bon is binnen; hij verschijnt zo op de werklijst.</p>
        </>}
        {kind !== 'processing' && kind !== 'unread' && (store || total) ? <Summary store={store} date={date} total={total} currency={invoice?.currency ?? proposal?.currency} /> : null}
        {item.warnings.length > 0 && kind === 'concept' && <ul className="bk-ai-warnings">{item.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}

function BatchLine({ job, mode }: { job: Job; mode: ReceiptMode }) {
  if (job.state === 'error' || !job.result) return <span className="rcp-batch-line is-error">Niet ingestuurd: {job.error ?? 'er ging iets mis'}</span>;
  if (job.result.channel === 'declaration') {
    const d = job.result.declaration;
    return <span className="rcp-batch-line">{d.store_name ?? 'Bon'}{d.total_cents != null ? ` · ${euroCents(d.total_cents)}` : ''} — ingediend</span>;
  }
  const { item, invoice } = job.result;
  const kind = receiptOutcomeKind(item);
  const label = kind === 'concept' ? `concept${invoice?.internal_number ? ` ${invoice.internal_number}` : ''}`
    : kind === 'supplier' ? 'kies de leverancier op de werklijst'
    : kind === 'duplicate' ? 'al eerder ingestuurd'
    : kind === 'processing' ? 'wordt nog gelezen'
    : 'niet gelezen — vul hem in op de werklijst';
  const store = invoice?.supplier_name ?? item.proposal?.supplier.name ?? (mode === 'receipt' ? 'Bon' : 'Declaratie');
  const total = invoice?.total_cents ?? item.proposal?.totals.total_cents ?? null;
  return <span className={`rcp-batch-line${kind === 'concept' ? '' : ' is-attention'}`}>{store}{total != null ? ` · ${euroCents(total)}` : ''} — {label}</span>;
}
