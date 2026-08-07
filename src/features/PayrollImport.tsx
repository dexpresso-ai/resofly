import { useRef, useState } from 'react';
import { AlertTriangle, FileSpreadsheet, Upload } from 'lucide-react';
import { Button, Input, Select } from '../components/Ui';
import { euro } from '../lib/format';
import { parseCsv } from '../lib/csvImport';
import { postPayrollJournal } from '../lib/repository';

const euroCents = (cents: number | null | undefined) => euro((cents ?? 0) / 100);

/**
 * Bedrag uit een CSV van een salarisverwerker naar centen. Moet met beide
 * schrijfwijzen om kunnen gaan: "1.234,56" (Nederlands) en "1234.56" (Engels).
 * De regel: staat er een komma in, dan is die het decimaalteken en zijn punten
 * duizendtallen; staat er geen komma, dan is de punt het decimaalteken.
 */
export function parseAmountCents(raw: string): number {
  const s = (raw ?? '').replace(/[\s€]/g, '');
  if (!s) return 0;
  const normalised = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  const n = Number(normalised);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

type PayrollRow = { accountCode: string; description: string; debitCents: number; creditCents: number };

/**
 * De loonjournaalpost van de salarisverwerker innemen.
 *
 * ResoFly voert geen salarisadministratie — dat is bewust buiten scope. Wat de
 * verwerker heeft uitgerekend nemen we integraal over; wij kennen de
 * loonheffingstabellen niet en rekenen dus niets na. Wel controleren we of de
 * post sluit en of elke rekening bestaat, want dat kunnen we wel zien.
 *
 * De import gaat NIET via de bestaande CsvImportModal: die slaat rij voor rij
 * op, en een journaalpost die halverwege afbreekt laat een niet-sluitend
 * boekstuk achter. Hier wordt alles eerst gelezen en getoond, en pas daarna in
 * een keer geboekt.
 */
export function PayrollImport({ organizationId, canWrite, onPosted }: {
  organizationId: string; canWrite: boolean; onPosted: () => void;
}) {
  const [headers, setHeaders] = useState<string[]>([]);
  const [raw, setRaw] = useState<string[][]>([]);
  const [map, setMap] = useState({ account: '', description: '', debit: '', credit: '' });
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /** Kolomkoppen raden, zodat een gebruiker meestal niets hoeft te kiezen. */
  function guess(hs: string[], needles: string[]): string {
    return hs.find(h => needles.some(n => h.toLowerCase().includes(n))) ?? '';
  }

  async function onFile(file: File | undefined | null) {
    if (!file) return;
    setError(null); setDone(null);
    try {
      const parsed = parseCsv(await file.text());
      setHeaders(parsed.headers);
      setRaw(parsed.rows);
      setMap({
        account: guess(parsed.headers, ['rekening', 'grootboek', 'account', 'code']),
        description: guess(parsed.headers, ['omschrijving', 'description', 'toelichting']),
        debit: guess(parsed.headers, ['debet', 'debit']),
        credit: guess(parsed.headers, ['credit', 'kredit']),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bestand lezen mislukt');
    }
  }

  const idx = (h: string) => headers.indexOf(h);
  const rows: PayrollRow[] = raw
    .map(cells => ({
      accountCode: (cells[idx(map.account)] ?? '').trim(),
      description: (cells[idx(map.description)] ?? '').trim(),
      debitCents: parseAmountCents(cells[idx(map.debit)] ?? ''),
      creditCents: parseAmountCents(cells[idx(map.credit)] ?? ''),
    }))
    .filter(r => r.accountCode && (r.debitCents !== 0 || r.creditCents !== 0));

  const totalDebit = rows.reduce((s, r) => s + r.debitCents, 0);
  const totalCredit = rows.reduce((s, r) => s + r.creditCents, 0);
  const balanced = rows.length > 0 && totalDebit === totalCredit;

  function reset() {
    setHeaders([]); setRaw([]); setDescription('');
    if (fileRef.current) fileRef.current.value = '';
  }

  async function post() {
    setBusy(true); setError(null); setDone(null);
    try {
      const entry = await postPayrollJournal(organizationId, { date, description, lines: rows });
      setDone(`Geboekt als ${entry.entry_number ?? 'journaalpost'}.`);
      reset();
      onPosted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Boeken mislukt');
    } finally { setBusy(false); }
  }

  const FIELDS: Array<[keyof typeof map, string]> = [
    ['account', 'Rekening'], ['description', 'Omschrijving'], ['debit', 'Debet'], ['credit', 'Credit'],
  ];

  return (
    <div className="bk-report">
      <div className="bk-subhead">
        <p className="bk-muted">
          <FileSpreadsheet size={13} /> Loonjournaalpost. Exporteer de journaalpost bij je salarisverwerker als CSV en lees hem hier in.
          ResoFly voert geen salarisadministratie en rekent niets na — we nemen over wat de verwerker heeft berekend, en controleren alleen of de post sluit en of elke rekening bestaat.
        </p>
        {canWrite && <Button onClick={() => fileRef.current?.click()} disabled={busy}><Upload size={14} /> CSV kiezen</Button>}
      </div>
      <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={e => onFile(e.target.files?.[0])} />

      {error && <div className="error">{error}</div>}
      {done && <p className="bk-note">{done}</p>}

      {headers.length > 0 && (
        <>
          <div className="bk-fy-new-fields">
            {FIELDS.map(([key, label]) => (
              <label key={key}><span>{label}</span>
                <Select value={map[key]} onChange={e => setMap(m => ({ ...m, [key]: e.target.value }))}>
                  <option value="">— kolom kiezen —</option>
                  {headers.map(h => <option key={h} value={h}>{h}</option>)}
                </Select>
              </label>
            ))}
          </div>
          <div className="bk-fy-new-fields">
            <label><span>Boekdatum</span><input type="date" className="form-input" value={date} onChange={e => setDate(e.target.value)} /></label>
            <label><span>Omschrijving</span><Input value={description} onChange={e => setDescription(e.target.value)} placeholder="Bijv. Loonjournaalpost mei 2026" /></label>
          </div>

          {rows.length === 0
            ? <p className="bk-muted">Nog geen regels herkend — controleer de kolomkoppeling hierboven.</p>
            : <>
              <div className="bk-table-wrap"><table className="bk-table">
                <thead><tr><th>Rekening</th><th>Omschrijving</th><th className="bk-num">Debet</th><th className="bk-num">Credit</th></tr></thead>
                <tbody>{rows.map((r, i) => (
                  <tr key={i}>
                    <td><strong>{r.accountCode}</strong></td>
                    <td>{r.description || <span className="bk-muted">—</span>}</td>
                    <td className="bk-num">{r.debitCents ? euroCents(r.debitCents) : ''}</td>
                    <td className="bk-num">{r.creditCents ? euroCents(r.creditCents) : ''}</td>
                  </tr>
                ))}</tbody>
                <tfoot><tr className="bk-report-result">
                  <td colSpan={2}>{rows.length} regels</td>
                  <td className="bk-num">{euroCents(totalDebit)}</td>
                  <td className="bk-num">{euroCents(totalCredit)}</td>
                </tr></tfoot>
              </table></div>
              {!balanced && (
                <p className="bk-neg">
                  <AlertTriangle size={13} /> De post sluit niet: verschil {euroCents(Math.abs(totalDebit - totalCredit))}.
                  Controleer de kolomkoppeling en of alle regels zijn meegekomen — een loonjournaalpost hoort exact te sluiten.
                </p>
              )}
            </>}

          <div className="bk-fy-new-actions">
            <Button variant="ghost" onClick={reset} disabled={busy}>Annuleren</Button>
            {canWrite && <Button variant="primary" disabled={busy || !balanced} onClick={post}>{busy ? 'Bezig…' : 'Boeken'}</Button>}
          </div>
        </>
      )}
    </div>
  );
}
