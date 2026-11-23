import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Select } from '../components/Ui';
import { Modal } from '../components/Modal';
import { dateNL, euro } from '../lib/format';
import { formatISODate } from '../lib/dates';
import { createInvoiceFromTimeEntries, previewTimeInvoice, type TimeInvoiceParams } from '../lib/repository';
import { hoursLabel } from '../lib/timeRates';
import type { AppData, Invoice, TimeInvoiceGrouping, TimeInvoicePreview, UUID } from '../types';

/**
 * "Uren factureren": de declarabele, nog niet gefactureerde uren van een klant
 * of project in één conceptfactuur.
 *
 * Tot november 2026 las je op de pagina Uren "Declarabel" af en typte je dat
 * bedrag in een lege factuur. Wat al gefactureerd was hield je zelf bij; dubbel
 * factureren of uren vergeten viel niet op.
 *
 * Het voorbeeld en het concept komen uit dezelfde database-functie
 * (time_invoice_preview / create_invoice_from_time_entries). Dit venster rekent
 * zelf niets uit: zo staat er op de factuur precies wat hier stond. Het leest
 * ook geen uren uit `data`, dus het kan vanaf elke pagina open.
 */

type PeriodChoice = 'all' | 'previous-month' | 'this-month' | 'custom';

const ROUNDING_OPTIONS: Array<[number, string]> = [
  [0, 'Niet afronden'],
  [6, 'Naar boven op 6 minuten'],
  [15, 'Naar boven op een kwartier'],
  [30, 'Naar boven op een half uur'],
  [60, 'Naar boven op een heel uur'],
];

/** De eerste en laatste dag van een maand, `offset` maanden vanaf nu. */
function monthRange(offset: number): { from: string; to: string } {
  const now = new Date();
  return {
    from: formatISODate(new Date(now.getFullYear(), now.getMonth() + offset, 1)),
    to: formatISODate(new Date(now.getFullYear(), now.getMonth() + offset + 1, 0)),
  };
}

function messageOf(error: unknown, fallback: string): string {
  const message = (error as { message?: string } | null)?.message;
  return message && message.trim() ? message : fallback;
}

export function TimeInvoiceDialog({ data, organizationId, defaults, onClose, onCreated }: {
  data: AppData;
  organizationId: UUID;
  defaults?: { clientId?: UUID | null; projectId?: UUID | null };
  onClose: () => void;
  onCreated: (invoice: Invoice) => void | Promise<void>;
}) {
  const defaultProject = defaults?.projectId ? data.projects.find(p => p.id === defaults.projectId) ?? null : null;
  const [clientId, setClientId] = useState<string>(defaults?.clientId ?? defaultProject?.client_id ?? '');
  const [projectId, setProjectId] = useState<string>(defaultProject?.id ?? '');
  // Standaard alles tot en met vandaag: zo blijven er geen oude uren liggen.
  const [period, setPeriod] = useState<PeriodChoice>('all');
  const [customFrom, setCustomFrom] = useState(() => monthRange(-1).from);
  const [customTo, setCustomTo] = useState(() => monthRange(-1).to);
  const [grouping, setGrouping] = useState<TimeInvoiceGrouping>('project');
  const [rounding, setRounding] = useState(0);
  const [preview, setPreview] = useState<TimeInvoicePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clients = useMemo(() => [...data.clients].sort((a, b) => a.name.localeCompare(b.name, 'nl')), [data.clients]);
  const projects = useMemo(() => data.projects.filter(p => p.client_id === clientId), [data.projects, clientId]);

  const params = useMemo<TimeInvoiceParams | null>(() => {
    if (!clientId) return null;
    const range = period === 'all' ? { from: null, to: formatISODate(new Date()) }
      : period === 'previous-month' ? monthRange(-1)
      : period === 'this-month' ? monthRange(0)
      : { from: customFrom || null, to: customTo || null };
    return { clientId, projectId: projectId || null, from: range.from, to: range.to, grouping, roundingMinutes: rounding };
  }, [clientId, projectId, period, customFrom, customTo, grouping, rounding]);

  useEffect(() => {
    if (!params) { setPreview(null); return; }
    let current = true;
    setLoading(true); setError(null);
    previewTimeInvoice(organizationId, params)
      .then(result => { if (current) setPreview(result); })
      .catch(e => { if (current) { setPreview(null); setError(messageOf(e, 'De uren ophalen is mislukt.')); } })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [organizationId, params]);

  async function create() {
    if (!params || !preview || preview.lines.length === 0 || busy) return;
    setBusy(true); setError(null);
    try {
      // De minuten en het bedrag uit het voorbeeld gaan mee: zijn de uren
      // intussen veranderd (een timer die afliep, een tweede tabblad, een ander
      // tarief), dan weigert de database in plaats van iets anders te
      // factureren dan hier stond.
      const invoice = await createInvoiceFromTimeEntries(organizationId, params, { minutes: preview.minutes, subtotalCents: preview.subtotal_cents });
      await onCreated(invoice);
    } catch (e) {
      setError(messageOf(e, 'De conceptfactuur maken is mislukt.'));
      setBusy(false);
    }
  }

  const shownLines = preview?.lines.slice(0, 8) ?? [];
  const hiddenLines = (preview?.lines.length ?? 0) - shownLines.length;
  const canCreate = Boolean(preview && preview.lines.length > 0 && !loading && !busy);

  return (
    <Modal title="Uren factureren" onClose={onClose} className="time-invoice-modal"
      footer={<>
        <Button onClick={onClose}>Annuleren</Button>
        <Button variant="primary" disabled={!canCreate} onClick={create}>{busy ? 'Bezig…' : 'Concept maken'}</Button>
      </>}>
      <div className="time-invoice-form">
        <p className="settings-help" style={{ margin: 0 }}>
          Je declarabele uren die nog niet op een factuur staan, komen in één conceptfactuur. Er wordt niets verstuurd: je kijkt het concept daarna na.
        </p>
        {error && <div className="error">{error}</div>}
        <div className="settings-grid compact">
          <label>Klant
            <Select value={clientId} onChange={e => { setClientId(e.target.value); setProjectId(''); }} placeholder="Kies een klant" searchable>
              <option value="">Kies een klant</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </label>
          <label>Project
            <Select value={projectId} onChange={e => setProjectId(e.target.value)} disabled={!clientId}>
              <option value="">Alle uren van deze klant</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </label>
        </div>
        <div className="settings-grid compact">
          <label>Periode
            <Select value={period} onChange={e => setPeriod(e.target.value as PeriodChoice)}>
              <option value="all">Alles tot en met vandaag</option>
              <option value="previous-month">Vorige maand</option>
              <option value="this-month">Deze maand</option>
              <option value="custom">Eigen periode</option>
            </Select>
          </label>
          <label>Op de factuur
            <Select value={grouping} onChange={e => setGrouping(e.target.value as TimeInvoiceGrouping)}>
              <option value="project">Eén regel per project en tarief</option>
              <option value="entry">Eén regel per registratie (urenspecificatie)</option>
            </Select>
          </label>
        </div>
        {period === 'custom' && (
          <div className="settings-grid compact">
            <label>Van<Input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} /></label>
            <label>Tot en met<Input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} /></label>
          </div>
        )}
        <div className="settings-grid compact">
          <label>Afronden per factuurregel
            <Select value={String(rounding)} onChange={e => setRounding(Number(e.target.value))}>
              {ROUNDING_OPTIONS.map(([value, label]) => <option key={value} value={String(value)}>{label}</option>)}
            </Select>
          </label>
        </div>

        <div className="time-invoice-preview" aria-live="polite">
          {!clientId && <div className="client-empty-line">Kies een klant om te zien wat je nog kunt factureren.</div>}
          {clientId && loading && !preview && <div className="client-empty-line">De uren worden opgehaald…</div>}
          {preview && preview.lines.length === 0 && (
            <div className="client-empty-line">
              {preview.without_rate.entry_count > 0
                ? 'De declarabele uren in deze periode hebben geen uurtarief.'
                : 'Geen declarabele uren die nog gefactureerd moeten worden in deze periode.'}
            </div>
          )}
          {preview && preview.lines.length > 0 && <>
            <div className="time-invoice-lines">
              {shownLines.map(line => (
                <div className="time-invoice-line" key={line.id}>
                  <span className="time-invoice-line-desc">{line.description}</span>
                  <span className="time-invoice-line-qty">{String(line.quantity).replace('.', ',')} u × {euro(line.unit_price)}</span>
                  <strong className="time-invoice-line-amount">{euro(Math.round(line.quantity * line.unit_price * 100) / 100)}</strong>
                </div>
              ))}
              {hiddenLines > 0 && <div className="time-invoice-more">en nog {hiddenLines} {hiddenLines === 1 ? 'regel' : 'regels'}</div>}
            </div>
            <div className="time-invoice-total">
              <span>
                {hoursLabel(preview.minutes)} · {preview.entry_count} {preview.entry_count === 1 ? 'registratie' : 'registraties'}
                {preview.first_date && preview.last_date ? ` · ${dateNL(preview.first_date)} t/m ${dateNL(preview.last_date)}` : ''}
                {preview.billed_minutes !== preview.minutes ? ` · afgerond naar ${hoursLabel(preview.billed_minutes)}` : ''}
              </span>
              <strong>{euro(preview.subtotal_cents / 100)} excl. btw</strong>
            </div>
          </>}
          {preview && preview.without_rate.entry_count > 0 && (
            <p className="time-invoice-warning">
              Let op: {hoursLabel(preview.without_rate.minutes)} ({preview.without_rate.entry_count} {preview.without_rate.entry_count === 1 ? 'registratie' : 'registraties'}) heeft geen uurtarief en komt niet op de factuur. Vul bij die uren een tarief in en open dit venster opnieuw.
            </p>
          )}
        </div>
        <p className="settings-help" style={{ margin: 0 }}>
          Uren op een factuur liggen vast: je kunt ze niet meer wijzigen of nog eens factureren. Verwijder je het concept of haal je de urenregel eruit, dan komen ze weer vrij. Dat gebeurt ook als je de factuur helemaal crediteert.
        </p>
      </div>
    </Modal>
  );
}
