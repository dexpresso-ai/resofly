import type { FinanceLine } from '../types';

/**
 * Korting op het totaal bij een factuur met meer btw-tarieven.
 *
 * Een factuur kent geen korting op het totaal: een korting is een regel met
 * een negatief bedrag en één btw-tarief. Geldt de korting voor de hele factuur,
 * dan hoort hij naar rato over de tarieven te vallen. Bij € 100 aan 9%,
 * € 100 aan 21% en "10% korting" van − € 20 aan 21% kwam er € 1,20 te weinig
 * btw in de aangifte, en stonden rubriek 1a en 1b elk € 10 scheef (controle van
 * 22 november 2026, bevinding 15).
 *
 * Bewust geen nieuw soort regel ("korting op het totaal") maar een knop die de
 * kortingsregel splitst in één regel per tarief. Zo blijft een factuur gewoon
 * een lijst regels met elk een tarief, en rekenen de pdf, de e-factuur (UBL),
 * de boeking, de aangifte en een creditnota er allemaal al goed mee.
 *
 * Puur, zonder React; getest in invoiceDiscount.test.ts.
 */

function cents(line: Pick<FinanceLine, 'quantity' | 'unit_price'>): number {
  const value = (Number(line.quantity) || 0) * (Number(line.unit_price) || 0) * 100;
  return Number.isFinite(value) ? Math.round(value) : 0;
}

function rate(line: Pick<FinanceLine, 'vat'>): number {
  return Number(line.vat) || 0;
}

type Group = { vat: number; vat_code: string | null; baseCents: number };

/** De regels met een positief bedrag, per tarief en btw-code. */
function groupsOf(lines: FinanceLine[]): Group[] {
  const groups = new Map<string, Group>();
  for (const line of lines) {
    const amount = cents(line);
    if (amount <= 0) continue;
    const code = String(line.vat_code ?? '').trim() || null;
    const key = `${rate(line)}|${code ?? ''}`;
    const group = groups.get(key) ?? { vat: rate(line), vat_code: code, baseCents: 0 };
    group.baseCents += amount;
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * Staat er een korting die waarschijnlijk over meer tarieven had moeten vallen?
 * Ja als er een regel met een negatief bedrag is, de positieve regels meer dan
 * één tarief hebben, en er een tarief is zonder eigen kortingsregel. Is de
 * korting al per tarief verdeeld, dan niets.
 *
 * Een korting op één onderdeel ("licentie − € 50") komt hier ook uit; daarom is
 * dit een vraag in het formulier, geen weigering.
 */
export function discountNeedsSpreading(lines: FinanceLine[] | null | undefined): FinanceLine[] {
  const list = Array.isArray(lines) ? lines : [];
  const discounts = list.filter(line => cents(line) < 0);
  if (discounts.length === 0) return [];
  const rates = new Set(groupsOf(list).map(group => group.vat));
  if (rates.size < 2) return [];
  const discountRates = new Set(discounts.map(rate));
  return [...rates].some(r => !discountRates.has(r)) ? discounts : [];
}

/**
 * Splitst elke kortingsregel in één regel per tarief (en btw-code), naar rato
 * van het bedrag excl. btw per tarief. De delen tellen op de cent op tot de
 * oorspronkelijke korting (grootste rest). De volgorde blijft: de delen komen
 * op de plek van de oude regel.
 */
export function spreadDiscountOverRates(lines: FinanceLine[], newId: () => string): FinanceLine[] {
  const groups = groupsOf(lines);
  const totalBase = groups.reduce((sum, group) => sum + group.baseCents, 0);
  if (groups.length < 2 || totalBase <= 0) return lines;
  const out: FinanceLine[] = [];
  for (const line of lines) {
    const discount = cents(line);
    if (discount >= 0) { out.push(line); continue; }
    // Grootste rest: eerst naar beneden afronden (in absolute centen), dan de
    // centen die over zijn naar de delen met de grootste rest.
    const shares = groups.map(group => {
      const exact = (-discount) * group.baseCents / totalBase;
      return { group, cents: Math.floor(exact), rest: exact - Math.floor(exact) };
    });
    let left = -discount - shares.reduce((sum, share) => sum + share.cents, 0);
    for (const share of [...shares].sort((a, b) => b.rest - a.rest)) {
      if (left <= 0) break;
      share.cents += 1;
      left -= 1;
    }
    const description = String(line.description ?? '').trim() || 'Korting';
    shares.filter(share => share.cents > 0).forEach((share, index) => {
      out.push({
        id: index === 0 ? line.id : newId(),
        description: `${description} (deel ${share.group.vat}% btw)`,
        quantity: 1,
        unit_price: -share.cents / 100,
        vat: share.group.vat,
        ...(share.group.vat_code ? { vat_code: share.group.vat_code } : {}),
      });
    });
  }
  return out;
}
