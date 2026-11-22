import { AlertTriangle } from 'lucide-react';
import type { Client, FinanceLine, VatCode } from '../types';
import { zeroVatIssues } from '../lib/invoiceZeroVat';

/**
 * Wat er onder de regels van een offerte of factuur mis kan zijn vóór hij de
 * deur uit gaat. Alleen waarschuwen: opslaan als concept mag altijd.
 *
 *  - 0% zonder reden, of met een reden die niet bij het land van de klant
 *    past. Bij versturen weigert de server dezelfde regels met dezelfde zinnen
 *    (lib/invoiceZeroVat.ts), zodat je het hier al ziet en niet pas bij de
 *    knop Versturen.
 */
export function FinanceLineChecks({ kind, lines, client, vatCodes, korEnabled }: {
  kind: 'quote' | 'invoice';
  lines: FinanceLine[];
  client: Client | null;
  vatCodes: VatCode[];
  korEnabled: boolean;
  /** Voor de knoppen die regels aanpassen; nu nog niet gebruikt. */
  disabled?: boolean;
  onChangeLines?: (lines: FinanceLine[]) => void;
  newId?: () => string;
}) {
  const codes = Object.fromEntries(vatCodes.map(code => [code.code, { kind: code.kind, salesBox: code.sales_box }]));
  const issues = zeroVatIssues(lines, codes, client, { korEnabled });
  if (issues.length === 0) return null;
  const sendWord = kind === 'quote' ? 'Op de factuur uit deze offerte' : 'Bij versturen';
  return <div className="finance-line-checks">
    {issues.map(issue => <div key={`${issue.line}-${issue.problem}`} className="fin-autobook-banner" role="status">
      <AlertTriangle size={16} />
      <span>{sendWord} houdt ResoFly dit tegen. {issue.message}</span>
    </div>)}
  </div>;
}
