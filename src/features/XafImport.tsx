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
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Upload } from 'lucide-react';
import type { Client, LedgerAccount, PartnershipPartner, Supplier } from '../types';
import { Button, Input, Select } from '../components/Ui';
import { dateNL, euro } from '../lib/format';
import { createClientWithServerCode, insertRow, listPartnershipPartners, loadCompanySettings } from '../lib/repository';
import {
  addDays, balancesAt, decodeXafBytes, mappingWarnings, openingLines, parseXaf, planRelations, proposeAccount, splitResultOverPartners,
  VAT_RETURN_CODES, type OpeningLineDraft, type ResultSplit, type XafFile,
} from '../lib/xafImport';

const euroCents = (cents: number) => euro(cents / 100);
/** Alleen de eerste letter: "ResoFly" in een voorstel bleef anders niet heel. */
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** 6000 basispunten → "60%", 3333 → "33,33%". */
const percent = (basisPoints: number) => `${String(basisPoints / 100).replace('.', ',')}%`;

/** Rechtsvormen met vennoten (zie Bookkeeping.tsx, de beginbalans). */
const PARTNERSHIP_FORMS: ReadonlySet<string> = new Set(['vof', 'maatschap', 'cv']);

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
  // De rechtsvorm en de actieve vennoten, voor het resultaat tot de
  // overstapdatum. undefined: nog bezig; null: niet te laden, dan de gewone
  // uitleg over de sluitpost. Pas na het inlezen van een bestand: wie de
  // beginbalans alleen opent, wacht er niet op.
  const [owners, setOwners] = useState<{ partnership: boolean; partners: PartnershipPartner[] } | null | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    setOwners(undefined);
    (async () => {
      const settings = await loadCompanySettings(organizationId);
      const partnership = PARTNERSHIP_FORMS.has(settings?.legal_form ?? '');
      const partners = partnership ? (await listPartnershipPartners(organizationId)).filter(p => p.is_active) : [];
      return { partnership, partners };
    })()
      .then(result => { if (!cancelled) setOwners(result); })
      .catch(() => { if (!cancelled) setOwners(null); });
    return () => { cancelled = true; };
  }, [file, organizationId]);

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
  // Wat aan de koppeling niet lijkt te kloppen: meer rekeningen op de bank of
  // op één eigen-vermogensrekening, of een bank die credit uitkomt (zie
  // mappingWarnings).
  const linkWarnings = useMemo(
    () => (balances ? mappingWarnings(balances.balance, mapping, balanceAccounts) : []),
    [balances, mapping, balanceAccounts],
  );
  // Bij een vof, maatschap of cv: het resultaat tot de overstapdatum per
  // vennoot op zijn kapitaal. Zonder dit kwam de winst van vóór de overstap
  // als sluitpost op 0500, en werd die nooit over de vennoten verdeeld.
  const resultSplit = useMemo<ResultSplit | null>(() => {
    if (!balances || !owners?.partnership) return null;
    const shares = owners.partners
      .filter(p => accountById.get(p.capital_account_id)?.is_active)
      .map(p => ({ capitalAccountId: p.capital_account_id, name: p.name, partnerNumber: p.partner_number, basisPoints: p.profit_share_basis_points }));
    return splitResultOverPartners(balances.resultCents, shares);
  }, [balances, owners, accountById]);
  const equityAccount = ledgerAccounts.find(a => a.subtype === 'equity' && a.is_active);
  const equityLabel = equityAccount ? `${equityAccount.code} ${equityAccount.name}` : '0500';
  const plan = useMemo(() => (file ? planRelations(file, clients, suppliers) : null), [file, clients, suppliers]);
  const relationTotal = plan ? (canWriteClients ? plan.clients.length : 0) + plan.suppliers.length : 0;

  /** Waar het resultaat tot de overstapdatum heen gaat. */
  function resultText(resultCents: number): string {
    if (!resultSplit || resultCents === 0) return 'Dat komt via de sluitpost op het eigen vermogen.';
    const winst = resultCents < 0;
    const it = winst ? 'die' : 'dat';
    if (resultSplit.kind === 'no_partners') {
      return `Dat komt als sluitpost op ${equityLabel}, op geen enkele vennoot. Wil je ${it} over de vennoten verdelen, leg dan eerst de vennoten vast (Financiën → Vennoten) en lees de auditfile daarna opnieuw in.`;
    }
    if (resultSplit.kind === 'shares_not_100') {
      return `De winstverdeling van de vennoten telt op tot ${percent(resultSplit.totalBasisPoints)} in plaats van 100%. Daarom komt ${winst ? 'de winst' : 'het verlies'} als sluitpost op ${equityLabel}, op geen enkele vennoot. Zet de verdeling goed bij Vennoten en lees de auditfile daarna opnieuw in, of verdeel ${it} zelf in de beginbalans hieronder.`;
    }
    const parts = resultSplit.lines.map(line => {
      const code = accountById.get(line.account_id)?.code;
      return `${code ? `${code} ` : ''}${line.name} (${percent(line.basisPoints)}) ${euroCents(Math.abs(line.cents))}`;
    });
    return `Dit is ${winst ? 'de winst' : 'het verlies'} van vóór de overstap. ResoFly zet ${it} per vennoot op zijn kapitaalrekening, naar zijn winstaandeel: ${parts.join(', ')}. Verdelen jullie ${winst ? 'die winst' : 'dat verlies'} anders, pas de bedragen dan aan in de beginbalans hieronder.`;
  }

  function apply() {
    if (!balances) return;
    // Bij een bestand zonder beginbalans, meer rekeningen op de bank of een
    // bank die credit staat eerst vragen. Deze knop ging zonder vraag door, en
    // de beginbalans eronder zag er dan ingevuld en dus goed uit: een lening
    // die in het banksaldo was verdwenen, viel pas maanden later op.
    const doubts = [
      ...(balances.missingOpening ? ['De auditfile heeft geen beginbalans: de saldi zijn alleen de boekingen uit het bestand.'] : []),
      ...linkWarnings,
    ];
    if (doubts.length > 0 && !window.confirm(`Kijk dit eerst na:\n\n${doubts.map(d => `• ${d}`).join('\n\n')}\n\nToch in de beginbalans zetten?`)) return;
    try {
      onApply(switchDate, openingLines(balances.balance, mapping, resultSplit?.kind === 'split' ? resultSplit.lines : []));
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
                  : proposal?.reason && !proposal.targetId
                    // Bewust geen voorstel (een lening, creditcard, spaarrekening): zeg waarom, tot er gekozen is.
                    ? !mapping[b.code] && <small className="xaf-import-hint is-warn">{proposal.reason}</small>
                    : proposal?.reason && mapping[b.code] === proposal.targetId && <small className="xaf-import-hint">Voorstel: {lowerFirst(proposal.reason)}</small>}
              </td>
            </tr>;
          })}</tbody>
        </table></div>}

      <p className="bk-muted">
        Resultaat tot de overstapdatum: {euroCents(Math.abs(balances.resultCents))} {balances.resultCents <= 0 ? 'winst' : 'verlies'}.
        {' '}{resultText(balances.resultCents)} Ontbreekt een rekening in de lijst? Maak hem eerst aan onder Rekeningschema.
      </p>

      {linkWarnings.map(warning => <div key={warning} className="xaf-import-warning">{warning}</div>)}

      <div className="xaf-import-actions">
        {/* Wachten op de vennoten: anders komt de winst bij een snelle klik toch op 0500. */}
        <Button variant="primary" onClick={apply} disabled={!canWrite || unmapped.length > 0 || balances.balance.length === 0 || owners === undefined}>Zet in de beginbalans</Button>
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
