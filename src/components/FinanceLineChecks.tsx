import { AlertTriangle } from 'lucide-react';
import { Button } from './Ui';
import type { Client, FinanceLine, VatCode } from '../types';
import { zeroVatIssues } from '../lib/invoiceZeroVat';
import { discountNeedsSpreading, spreadDiscountOverRates } from '../lib/invoiceDiscount';

/**
 * Wat er onder de regels van een offerte of factuur mis kan zijn vóór hij de
 * deur uit gaat. Alleen waarschuwen: opslaan als concept mag altijd.
 *
 *  - 0% zonder reden, of met een reden die niet bij het land van de klant
 *    past. Bij versturen weigert de server dezelfde regels met dezelfde zinnen
 *    (lib/invoiceZeroVat.ts), zodat je het hier al ziet en niet pas bij de
 *    knop Versturen.
 *  - Een korting die op één tarief staat terwijl de factuur meer tarieven
 *    heeft. Bij een korting op het totaal kwam er zo te weinig btw in de
 *    aangifte. Met de knop wordt de korting naar rato per tarief gesplitst
 *    (lib/invoiceDiscount.ts); de regels blijven gewone regels.
 */
export function FinanceLineChecks({ kind, lines, client, vatCodes, korEnabled, disabled, onChangeLines, newId }: {
  kind: 'quote' | 'invoice';
  lines: FinanceLine[];
  client: Client | null;
  vatCodes: VatCode[];
  korEnabled: boolean;
  disabled: boolean;
  onChangeLines: (lines: FinanceLine[]) => void;
  newId: () => string;
}) {
  const codes = Object.fromEntries(vatCodes.map(code => [code.code, { kind: code.kind, salesBox: code.sales_box }]));
  const issues = zeroVatIssues(lines, codes, client, { korEnabled });
  const discounts = discountNeedsSpreading(lines);
  if (issues.length === 0 && discounts.length === 0) return null;
  const sendWord = kind === 'quote' ? 'Op de factuur uit deze offerte' : 'Bij versturen';
  return <div className="finance-line-checks">
    {issues.map(issue => <div key={`${issue.line}-${issue.problem}`} className="fin-autobook-banner" role="status">
      <AlertTriangle size={16} />
      <span>{sendWord} houdt ResoFly dit tegen. {issue.message}</span>
    </div>)}
    {discounts.length > 0 && <div className="fin-autobook-banner" role="status">
      <AlertTriangle size={16} />
      <span>
        {discounts.length === 1 ? `De korting "${discounts[0].description || 'Korting'}" staat` : 'De kortingen staan'} op één btw-tarief, maar {kind === 'quote' ? 'deze offerte' : 'deze factuur'} heeft meer tarieven.
        Geldt de korting voor het hele bedrag, verdeel hem dan over de tarieven; anders klopt de btw niet.
        Geldt hij voor één onderdeel, dan is het goed zo.
      </span>
      {!disabled && <Button onClick={() => onChangeLines(spreadDiscountOverRates(lines, newId))}>Verdeel over de tarieven</Button>}
    </div>}
  </div>;
}
