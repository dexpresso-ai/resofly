// De kop van het klantportaal: een groet, de datum en één zin over wat er voor
// de klant openstaat. Los van de component, zodat de Nederlandse zinsbouw
// (enkelvoud/meervoud, "en" tussen de laatste twee) te testen is.

/** Dezelfde dagdelen als het dashboard van de werkruimte. */
export function dayGreeting(date: Date): string {
  const hour = date.getHours();
  if (hour < 6) return 'Goedenacht';
  if (hour < 12) return 'Goedemorgen';
  if (hour < 18) return 'Goedemiddag';
  return 'Goedenavond';
}

/** "Donderdag 15 oktober" */
export function portalDateLabel(date: Date): string {
  const label = date.toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** De voornaam voor de groet; leeg als er geen naam is (dan alleen "Goedemiddag"). */
export function firstName(name: string | null | undefined): string {
  const first = String(name ?? '').trim().split(/\s+/)[0] ?? '';
  // Een e-mailadres of een bedrijfsnaam met cijfers is geen voornaam.
  if (!first || first.includes('@') || /\d/.test(first)) return '';
  return first;
}

export type PortalSummaryCounts = {
  openInvoices: number;
  overdueInvoices: number;
  unreadTickets: number;
  unreadThreads: number;
};

function joinDutch(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} en ${parts[parts.length - 1]}`;
}

/**
 * "Er staat 1 factuur open en er is 1 nieuw antwoord op je ticket." Een
 * vervallen factuur gaat voor: die is dringender dan dat er iets openstaat,
 * en twee keer dezelfde factuur noemen is ruis.
 */
export function portalSummary(counts: PortalSummaryCounts): string {
  const parts: string[] = [];
  const { openInvoices, overdueInvoices, unreadTickets, unreadThreads } = counts;
  if (overdueInvoices > 0) {
    parts.push(overdueInvoices === 1 ? 'er is 1 factuur vervallen' : `er zijn ${overdueInvoices} facturen vervallen`);
  } else if (openInvoices > 0) {
    parts.push(openInvoices === 1 ? 'er staat 1 factuur open' : `er staan ${openInvoices} facturen open`);
  }
  if (unreadTickets > 0) {
    parts.push(unreadTickets === 1 ? 'er is 1 nieuw antwoord op je ticket' : `er zijn ${unreadTickets} nieuwe antwoorden op je tickets`);
  }
  if (unreadThreads > 0) {
    parts.push(unreadThreads === 1 ? 'je hebt 1 nieuw bericht' : `je hebt ${unreadThreads} nieuwe berichten`);
  }
  if (parts.length === 0) return 'Alles is bij: er staat niets voor je open.';
  const sentence = joinDutch(parts);
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}
