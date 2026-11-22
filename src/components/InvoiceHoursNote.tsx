import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from './Ui';
import { downloadCsv } from '../lib/csv';
import { selectInvoiceHours, type InvoiceHourRow } from '../lib/repository';
import { hoursLabel } from '../lib/timeRates';

/**
 * In het factuurvenster: welke geregistreerde uren op deze factuur staan, met
 * de urenspecificatie als CSV voor de klant.
 *
 * Zonder dit zag je op een factuur van "Uren factureren" niet dat er uren aan
 * vastliggen, en ook niet dat ze weer vrijkomen als je de urenregel weghaalt.
 * Wie een samengevoegde regel factureert en een specificatie wil meesturen,
 * typte die tot nu toe met de hand.
 *
 * Haalt de uren zelf op (één kleine vraag per factuur): de facturenpagina laadt
 * de urengroep niet. Wie de module Uren niet mag lezen krijgt niets terug en
 * ziet dit blok dus niet.
 */
export function InvoiceHoursNote({ organizationId, invoiceId, invoiceNumber, draft }: {
  organizationId: string;
  invoiceId: string;
  invoiceNumber: string;
  draft: boolean;
}) {
  const [rows, setRows] = useState<InvoiceHourRow[]>([]);

  useEffect(() => {
    let current = true;
    selectInvoiceHours(organizationId, invoiceId)
      .then(result => { if (current) setRows(result); })
      // Geen leesrecht op Uren, of de migratie staat er nog niet: dan geen blok.
      .catch(() => { if (current) setRows([]); });
    return () => { current = false; };
  }, [organizationId, invoiceId]);

  if (rows.length === 0) return null;
  const minutes = rows.reduce((sum, row) => sum + row.minutes, 0);

  function download() {
    downloadCsv(
      `urenspecificatie-${invoiceNumber || 'factuur'}.csv`,
      ['Datum', 'Omschrijving', 'Uren', 'Uurtarief', 'Bedrag'],
      rows.map(row => [
        row.entry_date,
        row.description ?? '',
        (row.minutes / 60).toFixed(2),
        (row.hourly_rate_cents / 100).toFixed(2),
        ((row.minutes / 60) * row.hourly_rate_cents / 100).toFixed(2),
      ]),
    );
  }

  return (
    <section className="finance-editor-section invoice-hours-note">
      <div className="finance-section-head">
        <strong>Uren op deze factuur</strong>
        <span>{hoursLabel(minutes)} uit je urenregistratie ({rows.length} {rows.length === 1 ? 'registratie' : 'registraties'})</span>
      </div>
      <p className="settings-help" style={{ margin: 0 }}>
        {draft
          ? 'Deze uren liggen vast zolang ze op dit concept staan. Haal je een urenregel weg of verwijder je het concept, dan komen ze weer vrij om te factureren.'
          : 'Deze uren zijn gefactureerd en liggen vast. Crediteer je de factuur helemaal, dan komen ze weer vrij.'}
      </p>
      <div className="finance-actions"><Button onClick={download}><Download size={14} /> Urenspecificatie (CSV)</Button></div>
    </section>
  );
}
