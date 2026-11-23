/**
 * Tarief en declarabel-stand van een nieuwe urenpost.
 *
 * Stond tot november 2026 in features/TimeTracking.tsx. main.tsx gebruikt het
 * bij de timer en bij "Tijd reserveren"; met de import uit de pagina zat de hele
 * urenpagina in de bundel die bij elke start laadt.
 */
import type { AppData } from '../types';

/** Resolve het standaardtarief (centen) voor een project: project-tarief, anders bedrijfsdefault. */
export function resolveRateCents(data: AppData, projectId: string | null): number | null {
  const project = projectId ? data.projects.find(p => p.id === projectId) : null;
  return project?.hourly_rate_cents ?? data.companySettings?.default_hourly_rate_cents ?? null;
}

/**
 * Standaard declarabel-stand voor een project: urenbasis-projecten zijn declarabel,
 * aangenomen-prijs-projecten ('fixed_price') worden via offerte/factuur afgerekend
 * en komen dus standaard niet-declarabel binnen. Zonder project: declarabel.
 */
export function defaultBillableForProject(data: AppData, projectId: string | null): boolean {
  const project = projectId ? data.projects.find(p => p.id === projectId) : null;
  return project ? project.billing_type !== 'fixed_price' : true;
}

/** "121 uur" of "27,5 uur": hooguit twee decimalen, met een komma. */
export function hoursLabel(minutes: number): string {
  const hours = Math.round((minutes / 60) * 100) / 100;
  return `${String(hours).replace('.', ',')} uur`;
}

/** Het minimum dat deze hulpjes van een uur en een factuur nodig hebben. */
type EntryLike = { billable: boolean; minutes: number; hourly_rate_cents: number | null; invoice_id?: string | null };
type InvoiceLike = { id: string; number: string; status: string };

/**
 * Wat er van een rij uren nog te factureren is: declarabel, met een tarief en
 * nog op geen factuur. Dezelfde regel als time_invoice_preview in de database
 * (migratie 20261123110000); `withoutRateMinutes` zijn declarabele uren zonder
 * tarief, die de factuur overslaat.
 */
export function openHoursSummary(entries: readonly EntryLike[]): { minutes: number; valueCents: number; withoutRateMinutes: number } {
  let minutes = 0;
  let valueCents = 0;
  let withoutRateMinutes = 0;
  for (const entry of entries) {
    if (!entry.billable || entry.minutes <= 0 || entry.invoice_id) continue;
    if (!entry.hourly_rate_cents || entry.hourly_rate_cents <= 0) { withoutRateMinutes += entry.minutes; continue; }
    minutes += entry.minutes;
    valueCents += Math.round((entry.minutes / 60) * entry.hourly_rate_cents);
  }
  return { minutes, valueCents, withoutRateMinutes };
}

/**
 * Het label bij een uur dat op een factuur staat: "Op concept F2026-001" of
 * "Gefactureerd F2026-001". Null als het uur nog vrij is. Wie Financiën niet
 * mag lezen heeft de factuur niet in zijn gegevens; die ziet "Gefactureerd".
 */
export function invoicedLabel(entry: { invoice_id?: string | null }, invoices: readonly InvoiceLike[]): string | null {
  if (!entry.invoice_id) return null;
  const invoice = invoices.find(i => i.id === entry.invoice_id);
  if (!invoice) return 'Gefactureerd';
  return `${invoice.status === 'draft' ? 'Op concept' : 'Gefactureerd'} ${invoice.number}`;
}
