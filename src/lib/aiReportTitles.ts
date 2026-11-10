/**
 * De titels van de rapportages van Gerrie, voor het tabblad en de broodkruimel.
 *
 * Los van aiReports.ts (dat de database aanroept), zodat workspaceTabs.ts er
 * zonder Supabase-client bij kan: viewTitle draait ook in de unittests.
 */
const titles = new Map<string, string>();

export function rememberReportTitle(id: string, title: string): void {
  if (id && title) titles.set(id, title);
}

export function aiReportTitle(id: string | null | undefined): string | null {
  return id ? titles.get(id) ?? null : null;
}
