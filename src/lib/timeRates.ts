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
