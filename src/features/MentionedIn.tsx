// ============================================================
// "Genoemd in" op het scherm van een klant of project (stap 2-1c,
// docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md §18).
//
// De pagina's die deze klant of dit project met @ noemen, het laatst bewerkt
// bovenaan. Een tik opent de pagina. Alleen voor wie Inhoud mag lezen: de
// aanroeper toont het paneel anders niet, en de database geeft dan ook niets
// (regel 3).
//
// Zonder pagina's in de organisatie geen paneel: dan kan niets deze klant
// noemen, en stond er op elk scherm een lege kaart.
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import { FileText } from 'lucide-react';
import type { AppData, InternalDocument, UUID } from '../types';
import { loadMentionedIn } from '../lib/repository';
import { relativeTime } from '../lib/auditLog';
import { MENTIONED_IN_LIMIT, mentionedInPages } from '../lib/pageMentionedIn';

export function MentionedIn({ organizationId, kind, entityId, data, refreshKey = 0, onOpen }: {
  organizationId: UUID;
  kind: 'client' | 'project';
  entityId: UUID;
  data: Pick<AppData, 'documents' | 'clients' | 'projects' | 'companySettings'>;
  /** De verversteller van de app: na het sluiten van een pagina opnieuw ophalen. */
  refreshKey?: number;
  onOpen: (doc: InternalDocument) => void;
}) {
  const hasPages = data.documents.some(doc => doc.format === 'page');
  // Elk antwoord hoort bij de klant of het project waarvoor het kwam. Het
  // klantscherm blijft staan als je naar een andere klant gaat (een chip met
  // "Klant openen"); met een gewone state toonde het paneel dan even de lijst
  // van de vorige klant. Bij een ververs blijft de lijst wel staan tot het
  // nieuwe antwoord er is: de app ververst na elke opslag, en leeg maken liet
  // het paneel steeds terugspringen naar "Laden…".
  const target = `${organizationId}:${kind}:${entityId}`;
  const [loaded, setLoaded] = useState<{ target: string; ids: UUID[] } | null>(null);
  const [failed, setFailed] = useState<{ target: string; message: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const ids = loaded?.target === target ? loaded.ids : null;
  const error = failed?.target === target ? failed.message : null;
  const showAll = expanded === target;

  useEffect(() => {
    if (!hasPages) return;
    let alive = true;
    loadMentionedIn(organizationId, kind, entityId)
      .then(rows => { if (alive) { setLoaded({ target, ids: rows }); setFailed(null); } })
      .catch(e => { if (alive) setFailed({ target, message: e instanceof Error ? e.message : 'Laden mislukt.' }); });
    return () => { alive = false; };
  }, [organizationId, kind, entityId, target, refreshKey, hasPages]);

  // Uit de ids en de geladen pagina's samen. Het antwoord en het verversen van
  // de app komen in willekeurige volgorde binnen; zo klopt de lijst in beide.
  const rows = useMemo(() => (ids ? mentionedInPages(ids, data.documents, {
    clients: data.clients,
    projects: data.projects,
    ownDossierName: data.companySettings?.company_name ?? '',
  }) : null), [ids, data.documents, data.clients, data.projects, data.companySettings?.company_name]);

  if (!hasPages) return null;
  const what = kind === 'client' ? 'deze klant' : 'dit project';
  const visible = rows ? (showAll ? rows : rows.slice(0, MENTIONED_IN_LIMIT)) : [];
  const now = new Date();

  return <article className="client-panel mentioned-in" aria-label="Genoemd in">
    <div className="client-panel-head">
      <h3>Genoemd in</h3>
      {rows && rows.length > 0 && <span>{rows.length}</span>}
    </div>
    {rows === null && !error && <div className="client-empty-line">Laden…</div>}
    {rows === null && error && <div className="client-empty-line">Kon niet ophalen welke pagina's {what} noemen. {error}</div>}
    {rows && rows.length === 0 && <div className="client-empty-line">Nog geen pagina noemt {what}. Typ @ in een pagina en kies {kind === 'client' ? 'de klant' : 'het project'}.</div>}
    {rows && rows.length > 0 && <div className="proj-next-list">
      {visible.map(row => {
        const modified = row.doc.updated_at;
        return <button key={row.doc.id} type="button" className="proj-next-row proj-recent-row" onClick={() => onOpen(row.doc)}>
          <span className="proj-recent-icon" style={{ color: 'var(--accent-b)' }} aria-hidden="true"><FileText size={15} /></span>
          <span className="proj-next-text">
            <span className="proj-next-title">{row.title}</span>
            <span className="proj-next-meta">{row.place}</span>
          </span>
          {modified && <time className="proj-recent-time" dateTime={modified} title={`Laatst bewerkt ${new Date(modified).toLocaleString('nl-NL', { dateStyle: 'long', timeStyle: 'short' })}`}>
            {relativeTime(modified, now)}
          </time>}
        </button>;
      })}
      {rows.length > MENTIONED_IN_LIMIT && !showAll && <button type="button" className="client-overview-more-link" onClick={() => setExpanded(target)}>
        +{rows.length - MENTIONED_IN_LIMIT} meer
      </button>}
    </div>}
  </article>;
}
