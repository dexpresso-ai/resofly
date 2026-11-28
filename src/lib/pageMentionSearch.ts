// ============================================================
// Zoeken na @ in een pagina (stap 2-1b, docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md §18).
//
// Wat de kiezer toont, komt uit wat de app geladen heeft: klanten, projecten,
// taken, facturen en collega's. De database geeft alleen wat je mag lezen
// (regel 3), dus wie Financiën niet mag zien, vindt hier geen factuur.
// Zonder Tiptap en zonder React, zodat pageMentionSearch.test.ts het in Node
// nakijkt.
// ============================================================

import { MENTION_KIND_WORDS, type MentionKind } from '../../supabase/functions/_shared/pageMentions.ts';

export type MentionCandidate = {
  kind: MentionKind;
  id: string;
  /** De naam op de chip. */
  label: string;
  /** Eén regel eronder: de soort, en waar het bij hoort. */
  hint: string;
};

type Named = { id: string };
export type MentionSources = {
  clients: ReadonlyArray<Named & { name: string }>;
  projects: ReadonlyArray<Named & { name: string; client_id: string | null; archived?: boolean | null }>;
  tasks: ReadonlyArray<Named & { title: string; project_id: string | null; status?: string | null }>;
  invoices: ReadonlyArray<Named & { number: string; client_id: string | null }>;
  /** Actieve collega's: id en een korte naam (het adres zonder domein). */
  members: ReadonlyArray<{ id: string; name: string; email?: string | null }>;
};

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** Kleine letters, zonder accenten en dubbele spaties. */
function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const words = (text: string) => normalize(text).split(/[\s\-_./@]+/).filter(Boolean);

/**
 * Alles wat je kunt noemen, in een vaste volgorde: klanten, projecten, taken,
 * facturen, collega's. Een gearchiveerd project en een afgeronde taak niet:
 * die noem je zelden, en ze duwen de rest uit de lijst.
 */
export function mentionCandidates(sources: MentionSources): MentionCandidate[] {
  const clientName = new Map(sources.clients.map(client => [client.id, client.name]));
  const projectName = new Map(sources.projects.map(project => [project.id, project.name]));
  const hint = (kind: MentionKind, place?: string | null) => (place ? `${capital(MENTION_KIND_WORDS[kind])} · ${place}` : capital(MENTION_KIND_WORDS[kind]));
  const out: MentionCandidate[] = [];
  for (const client of sources.clients) {
    if (client.name.trim()) out.push({ kind: 'client', id: client.id, label: client.name.trim(), hint: hint('client') });
  }
  for (const project of sources.projects) {
    if (project.archived || !project.name.trim()) continue;
    out.push({ kind: 'project', id: project.id, label: project.name.trim(), hint: hint('project', project.client_id ? clientName.get(project.client_id) : null) });
  }
  for (const task of sources.tasks) {
    if (task.status === 'done' || !task.title.trim()) continue;
    out.push({ kind: 'task', id: task.id, label: task.title.trim(), hint: hint('task', task.project_id ? projectName.get(task.project_id) : null) });
  }
  for (const invoice of sources.invoices) {
    if (!invoice.number.trim()) continue;
    out.push({ kind: 'invoice', id: invoice.id, label: invoice.number.trim(), hint: hint('invoice', invoice.client_id ? clientName.get(invoice.client_id) : null) });
  }
  for (const member of sources.members) {
    if (member.name.trim()) out.push({ kind: 'member', id: member.id, label: member.name.trim(), hint: hint('member', member.email ?? null) });
  }
  return out;
}

/**
 * Wat je na @ typt, tegen de namen. De beste eerst: de naam begint ermee, een
 * woord in de naam begint ermee, de naam bevat het, een woord eronder (de
 * klant van een project) begint ermee. Bij gelijke stand de vaste volgorde.
 * Na @ typ je geen spatie (dan sluit de kiezer, zoals het blokmenu): met
 * "@jan" vind je "Bakkerij Jansen" via het tweede woord.
 */
export function searchMentions(query: string, candidates: readonly MentionCandidate[], limit = 8): MentionCandidate[] {
  const q = normalize(query);
  if (!q) return candidates.slice(0, limit);
  const scored: Array<{ candidate: MentionCandidate; score: number; index: number }> = [];
  candidates.forEach((candidate, index) => {
    const label = normalize(candidate.label);
    const score = label.startsWith(q) ? 0
      : words(candidate.label).some(word => word.startsWith(q)) ? 1
        : label.includes(q) ? 2
          : words(candidate.hint).some(word => word.startsWith(q)) ? 3
            : -1;
    if (score >= 0) scored.push({ candidate, score, index });
  });
  return scored.sort((a, b) => a.score - b.score || a.index - b.index).slice(0, limit).map(entry => entry.candidate);
}

/**
 * mentionCandidates met een geheugen van één: bij elke toets na @ dezelfde
 * lijsten, dus niet elke keer alles opnieuw opbouwen.
 */
let last: { sources: unknown[]; candidates: MentionCandidate[] } | null = null;
export function cachedMentionCandidates(sources: MentionSources): MentionCandidate[] {
  const key = [sources.clients, sources.projects, sources.tasks, sources.invoices, sources.members];
  if (last && last.sources.every((value, index) => value === key[index])) return last.candidates;
  last = { sources: key, candidates: mentionCandidates(sources) };
  return last.candidates;
}

const memberLists = new WeakMap<object, MentionSources['members']>();

/**
 * De collega's voor de kiezer: wie actief lid is, met zijn adres zonder domein
 * (zo heet een collega op een chip; zie de @-vermeldingen in stap 2-1a). Voor
 * dezelfde lijst dezelfde uitkomst, zodat cachedMentionCandidates niet bij elke
 * toets opnieuw bouwt.
 */
export function mentionMembers(members: ReadonlyArray<{ user_id: string; email?: string | null; status?: string | null }>): MentionSources['members'] {
  let list = memberLists.get(members);
  if (!list) {
    list = members
      .filter(member => (member.status ?? 'active') === 'active' && typeof member.email === 'string' && member.email.includes('@'))
      .map(member => ({ id: member.user_id, name: (member.email as string).split('@')[0], email: member.email }));
    memberLists.set(members, list);
  }
  return list;
}
