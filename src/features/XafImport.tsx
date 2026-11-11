/**
 * Boekhouding → Beginbalans: overstappen van een ander pakket met een
 * auditfile (XAF). Zie src/lib/xafImport.ts en
 * docs/plannen/GEGEVENS_MEENEMEN_BOUWPLAN_2026-11-11.md.
 *
 * Dit paneel vult alleen de beginbalans eronder in; vastleggen blijft de
 * bestaande knop daar, met dezelfde controle en dezelfde sluitpost. De
 * klanten en leveranciers gaan langs dezelfde weg als "Importeren" op hun eigen
 * pagina's (create_client_with_next_code en een gewone insert), dus met de
 * rechten van wie het doet.
 */
import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Upload } from 'lucide-react';
import type { Client, LedgerAccount, Supplier } from '../types';
import { Button, Input, Select } from '../components/Ui';
import { dateNL, euro } from '../lib/format';
import { createClientWithServerCode, insertRow } from '../lib/repository';
import {
  addDays, balancesAt, decodeXafBytes, openingLines, parseXaf, planRelations, proposeAccount, VAT_RETURN_CODES,
  type OpeningLineDraft, type XafFile,
} from '../lib/xafImport';

const euroCents = (cents: number) => euro(cents / 100);
/** Alleen de eerste letter: "ResoFly" in een voorstel bleef anders niet heel. */
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Grenzen aan het bestand: een auditfile van vijf jaar is zo 200 MB, maar de browser leest hem in één keer. */
const MAX_XAF_BYTES = 150 * 1024 * 1024;

export function XafImportPanel({
  organizationId, canWrite, canWriteClients, ledgerAccounts, clients, suppliers, defaultDate, onApply, onRelationsAdded,
}: {
  organizationId: string;
  canWrite: boolean;
  canWriteClients: boolean;
  ledgerAccounts: LedgerAccount[];
  clients: Client[];
  suppliers: Supplier[];
  defaultDate: string | null;
  onApply: (date: string, lines: OpeningLineDraft[]) => void;
  onRelationsAdded: () => void;
}) {
  const [file, setFile] = useState<XafFile | null>(null);
  const [fileName, setFileName] = useState('');
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [switchDate, setSwitchDate] = useState('');
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [applied, setApplied] = useState(false);
  const [relations, setRelations] = useState<{ busy: boolean; done: number; total: number; added: number; failed: string[] } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0];
    event.target.value = '';
    if (!chosen) return;
    setError(null); setApplied(false); setRelations(null); setChoices({});
    if (chosen.size > MAX_XAF_BYTES) { setError('Dit bestand is groter dan 150 MB. Maak in je oude pakket een auditfile per boekjaar.'); return; }
    setReading(true);
    try {
      const parsed = parseXaf(decodeXafBytes(new Uint8Array(await chosen.arrayBuffer())));
      setFile(parsed);
      setFileName(chosen.name);
      setSwitchDate(defaultDate || (parsed.endDate ? addDays(parsed.endDate, 1) : new Date().toISOString().slice(0, 10)));
    } catch (e) {
      setFile(null);
      setError(e instanceof Error ? e.message : 'Dit bestand kon ik niet lezen.');
    } finally {
      setReading(false);
    }
  }

  const balances = useMemo(() => (file && switchDate ? balancesAt(file, switchDate) : null), [file, switchDate]);
  const balanceAccounts = useMemo(
    () => ledgerAccounts.filter(a => a.is_active && (a.type === 'asset' || a.type === 'liability' || a.type === 'equity')),
    [ledgerAccounts],
  );
  const proposals = useMemo(() => {
    const out: Record<string, { targetId: string | null; reason: string | null }> = {};
    for (const b of balances?.balance ?? []) out[b.code] = proposeAccount(b, balanceAccounts);
    return out;
  }, [balances, balanceAccounts]);
  const mapping = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [code, proposal] of Object.entries(proposals)) if (proposal.targetId) out[code] = proposal.targetId;
    return { ...out, ...choices };
  }, [proposals, choices]);
  const accountById = useMemo(() => new Map(ledgerAccounts.map(a => [a.id, a])), [ledgerAccounts]);
  const unmapped = (balances?.balance ?? []).filter(b => !mapping[b.code]);
  const plan = useMemo(() => (file ? planRelations(file, clients, suppliers) : null), [file, clients, suppliers]);
  const relationTotal = plan ? (canWriteClients ? plan.clients.length : 0) + plan.suppliers.length : 0;

  function apply() {
    if (!balances) return;
    try {
      onApply(switchDate, openingLines(balances.balance, mapping));
      setApplied(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Overnemen lukte niet.');
    }
  }

  async function addRelations() {
    if (!plan || relationTotal === 0) return;
    const jobs: Array<{ label: string; run: () => Promise<unknown> }> = [
      ...(canWriteClients ? plan.clients.map(record => ({
        label: `Klant ${String(record.name)}`,
        run: () => createClientWithServerCode(organizationId, { ...record, color: '#FFD966' }),
      })) : []),
      ...plan.suppliers.map(record => ({
        label: `Leverancier ${String(record.name)}`,
        run: () => insertRow<Supplier>('suppliers', organizationId, record),
      })),
    ];
    const state = { busy: true, done: 0, total: jobs.length, added: 0, failed: [] as string[] };
    setRelations({ ...state });
    // Na elkaar: een klantnummer komt uit een reeks, en zo blijft de volgorde
    // van het oude pakket ook de volgorde van de nummers.
    for (const job of jobs) {
      try {
        await job.run();
        state.added += 1;
      } catch (e) {
        state.failed.push(`${job.label}: ${e instanceof Error ? e.message : (e as { message?: string })?.message ?? 'mislukt'}`);
      }
      state.done += 1;
      setRelations({ ...state, failed: [...state.failed] });
    }
    setRelations({ ...state, busy: false, failed: [...state.failed] });
    onRelationsAdded();
  }

  return <section className="xaf-import">
    <div className="xaf-import-head">
      <div>
        <strong>Overstappen van een ander pakket?</strong>
        <p className="bk-muted">Lees de auditfile (XAF) van je oude administratie in. ResoFly rekent per rekening het saldo uit op je overstapdatum en vult daarmee de beginbalans hieronder. De klanten en leveranciers uit het bestand voeg je in één keer toe. Bewaar de auditfile zelf bij je administratie: die valt onder de bewaarplicht.</p>
      </div>
      <Button onClick={() => inputRef.current?.click()} disabled={!canWrite || reading}><Upload size={15} /> {reading ? 'Lezen…' : 'Auditfile kiezen'}</Button>
      <input ref={inputRef} type="file" accept=".xaf,.xml,application/xml,text/xml" hidden onChange={onFile} />
    </div>

    {error && <div className="error">{error}</div>}

    {file && balances && <>
      <p className="bk-muted">
        {fileName}: {file.companyName ?? 'administratie zonder naam'}{file.software ? `, uit ${file.software}` : ''}
        {file.startDate && file.endDate ? `, ${dateNL(file.startDate)} t/m ${dateNL(file.endDate)}` : ''}.
        {' '}{file.accounts.length} rekeningen, {file.relations.length} relaties, {file.lines.length} boekingsregels.
      </p>

      <label className="bk-field xaf-import-date">
        <span>Overstapdatum</span>
        <Input type="date" value={switchDate} onChange={e => { setSwitchDate(e.target.value); setApplied(false); }} disabled={!canWrite} />
        <small>De eerste dag in ResoFly. Wat je oude pakket vóór deze dag boekte, zit in de saldi.</small>
      </label>

      {balances.warnings.map(warning => <div key={warning} className="xaf-import-warning">{warning}</div>)}

      {balances.balance.length === 0
        ? <p className="bk-muted">Op deze datum staat er op geen enkele balansrekening een saldo.</p>
        : <div className="bk-table-wrap"><table className="bk-table xaf-import-table">
          <thead><tr><th>Rekening in de auditfile</th><th className="bk-num">Saldo</th><th>Wordt in ResoFly</th></tr></thead>
          <tbody>{balances.balance.map(b => {
            const target = mapping[b.code] ? accountById.get(mapping[b.code]) : null;
            const proposal = proposals[b.code];
            return <tr key={b.code}>
              <td data-label="Rekening">{b.code} · {b.name}</td>
              <td data-label="Saldo" className="bk-num">{euroCents(Math.abs(b.cents))} {b.cents >= 0 ? 'debet' : 'credit'}</td>
              <td data-label="Wordt">
                <Select value={mapping[b.code] ?? ''} onChange={e => { setChoices(c => ({ ...c, [b.code]: e.target.value })); setApplied(false); }} disabled={!canWrite}>
                  <option value="">— kies een rekening —</option>
                  {balanceAccounts.map(a => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                </Select>
                {target && VAT_RETURN_CODES.has(target.code)
                  ? <small className="xaf-import-hint is-warn">Op {target.code} telt dit mee in je eerste btw-aangifte in ResoFly. Gaf je oude pakket het al aan? Kies dan 1530.</small>
                  : proposal?.reason && mapping[b.code] === proposal.targetId && <small className="xaf-import-hint">Voorstel: {lowerFirst(proposal.reason)}</small>}
              </td>
            </tr>;
          })}</tbody>
        </table></div>}

      <p className="bk-muted">
        Resultaat tot de overstapdatum: {euroCents(Math.abs(balances.resultCents))} {balances.resultCents <= 0 ? 'winst' : 'verlies'}.
        {' '}Dat komt via de sluitpost op het eigen vermogen. Ontbreekt een rekening in de lijst? Maak hem eerst aan onder Rekeningschema.
      </p>

      <div className="xaf-import-actions">
        <Button variant="primary" onClick={apply} disabled={!canWrite || unmapped.length > 0 || balances.balance.length === 0}>Zet in de beginbalans</Button>
        {unmapped.length > 0 && <span className="bk-muted">Kies nog een rekening voor {unmapped.map(b => b.code).join(', ')}.</span>}
      </div>
      {applied && <div className="success">De beginbalans hieronder is ingevuld. Kijk hem na en klik op Beginbalans vastleggen.</div>}

      {plan && <div className="xaf-import-relations">
        <strong>Klanten en leveranciers</strong>
        <p className="bk-muted">
          {count(plan.clients.length, 'nieuwe klant', 'nieuwe klanten')} en {count(plan.suppliers.length, 'nieuwe leverancier', 'nieuwe leveranciers')}.
          {plan.existing > 0 && ` ${count(plan.existing, 'staat', 'staan')} al in ResoFly (zelfde btw-nummer of naam) en sla ik over.`}
          {plan.skipped > 0 && ` ${count(plan.skipped, 'relatie', 'relaties')} zonder soort of naam neem ik niet over.`}
          {!canWriteClients && plan.clients.length > 0 && ' Klanten toevoegen mag jij niet; dat doet iemand met schrijfrechten op Klanten.'}
        </p>
        {relations && <div className={relations.busy ? 'bk-muted' : relations.failed.length ? 'error' : 'success'}>
          {relations.busy
            ? `Bezig: ${relations.done} van ${relations.total}…`
            : `${relations.added} toegevoegd${relations.failed.length ? `, ${relations.failed.length} mislukt` : ''}.`}
          {!relations.busy && relations.failed.length > 0 && <ul className="xaf-import-failed">{relations.failed.slice(0, 20).map(f => <li key={f}>{f}</li>)}</ul>}
        </div>}
        <div className="xaf-import-actions">
          <Button onClick={addRelations} disabled={!canWrite || relationTotal === 0 || Boolean(relations?.busy) || Boolean(relations && !relations.busy)}>
            {relationTotal === 0 ? 'Niets nieuws toe te voegen' : `Voeg ${relationTotal} toe`}
          </Button>
        </div>
      </div>}
    </>}
  </section>;
}
