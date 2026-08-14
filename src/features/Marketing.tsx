import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ban, CheckCircle2, Clock, Copy, Mail, MailWarning, Megaphone, Pause, Play, Plus, Send, Trash2, Users, Workflow, X } from 'lucide-react';
import type {
  AppData, CampaignAudience, CampaignCustomFilter, CampaignCustomFilterOperator, CampaignAudiencePreview,
  ClientFieldDefinition, EmailCampaign, EmailCampaignRecipient, EmailCampaignStats, EmailSuppression, UUID,
  EmailFlow, EmailFlowStep, EmailFlowStats, EmailFlowStepStats, FlowStopCondition, FlowStepInput,
} from '../types';
import { Button, Input, Select, ColorPicker } from '../components/Ui';
import { STANDARD_MERGE_TOKENS, customFieldToken, unknownMergeTokens, type MergeFieldDefinition } from '../lib/mergeTokens';
import { activeFieldDefinitions, distinctFieldValues } from '../components/CustomFields';
import { RichTextEditor } from '../components/RichTextEditor';
import {
  loadCampaigns, loadCampaignStats, loadCampaignRecipients, loadSuppressions,
  createCampaign, updateCampaign, deleteCampaign, addSuppression, removeSuppression,
  loadFlows, loadFlowSteps, loadFlowStats, loadFlowStepStats,
  createFlow, updateFlow, deleteFlow, replaceFlowSteps,
} from '../lib/repository';
import {
  previewCampaignAudience, sendTestCampaign, sendCampaign, scheduleCampaign, pauseCampaign, resumeCampaign, cancelCampaign,
  activateFlow, pauseFlow, resumeFlow, cancelFlow,
} from '../lib/marketing-api';

type Tab = 'campaigns' | 'flows' | 'suppressions';
type View = { mode: 'list' } | { mode: 'edit'; id: UUID } | { mode: 'detail'; id: UUID };

const STATUS_LABEL: Record<string, string> = {
  draft: 'Concept', scheduled: 'Ingepland', sending: 'Wordt verzonden', sent: 'Verzonden', paused: 'Gepauzeerd', cancelled: 'Geannuleerd',
  active: 'Actief', archived: 'Gestopt',
};

const STOP_CONDITION_LABEL: Record<FlowStopCondition, string> = {
  reply: 'Alleen een antwoord',
  open_click_reply: 'Openen, klikken of antwoorden',
  click_reply: 'Klikken of antwoorden',
};

function emptyAudience(): CampaignAudience {
  return { mode: 'filter', statuses: [], tags: [], includeContacts: false, manualClientIds: [], customFilters: [] };
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' });
}

export function Marketing({ data, organizationId, canWrite, onChanged }: {
  data: AppData;
  organizationId: UUID;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<Tab>('campaigns');
  const [campaigns, setCampaigns] = useState<EmailCampaign[]>([]);
  const [stats, setStats] = useState<Record<UUID, EmailCampaignStats>>({});
  const [suppressions, setSuppressions] = useState<EmailSuppression[]>([]);
  const [flows, setFlows] = useState<EmailFlow[]>([]);
  const [flowStats, setFlowStats] = useState<Record<UUID, EmailFlowStats>>({});
  const [flowStepStats, setFlowStepStats] = useState<Record<UUID, EmailFlowStepStats[]>>({});
  const [view, setView] = useState<View>({ mode: 'list' });
  const [flowView, setFlowView] = useState<View>({ mode: 'list' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, s, sup, fl, fs, fss] = await Promise.all([
        loadCampaigns(organizationId),
        loadCampaignStats(organizationId),
        loadSuppressions(organizationId),
        loadFlows(organizationId),
        loadFlowStats(organizationId),
        loadFlowStepStats(organizationId),
      ]);
      setCampaigns(c);
      setStats(Object.fromEntries(s.map(row => [row.campaign_id, row])));
      setSuppressions(sup);
      setFlows(fl);
      setFlowStats(Object.fromEntries(fs.map(row => [row.flow_id, row])));
      const byFlow: Record<UUID, EmailFlowStepStats[]> = {};
      for (const row of fss) (byFlow[row.flow_id] ||= []).push(row);
      setFlowStepStats(byFlow);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Laden mislukt.');
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => { void reload(); }, [reload]);

  const selected = view.mode !== 'list' ? campaigns.find(c => c.id === view.id) ?? null : null;

  async function handleNew() {
    if (!canWrite || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createCampaign(organizationId, {
        name: 'Nieuwe campagne', subject: '', body_html: '', audience: emptyAudience(),
      });
      setCampaigns(prev => [created, ...prev]);
      setView({ mode: 'edit', id: created.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Campagne aanmaken mislukt.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: UUID) {
    if (!canWrite || busy) return;
    if (!window.confirm('Deze campagne definitief verwijderen?')) return;
    setBusy(true);
    try {
      await deleteCampaign(organizationId, id);
      setCampaigns(prev => prev.filter(c => c.id !== id));
      setView({ mode: 'list' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verwijderen mislukt.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDuplicate(c: EmailCampaign) {
    if (!canWrite || busy) return;
    setBusy(true);
    try {
      const created = await createCampaign(organizationId, {
        name: `${c.name} (kopie)`, subject: c.subject, preheader: c.preheader, body_html: c.body_html,
        body_text: c.body_text, accent_color: c.accent_color, audience: c.audience,
      });
      setCampaigns(prev => [created, ...prev]);
      setView({ mode: 'edit', id: created.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Dupliceren mislukt.');
    } finally {
      setBusy(false);
    }
  }

  const selectedFlow = flowView.mode !== 'list' ? flows.find(f => f.id === flowView.id) ?? null : null;

  async function handleNewFlow() {
    if (!canWrite || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createFlow(organizationId, { name: 'Nieuwe stroom', audience: emptyAudience(), stop_condition: 'reply' });
      setFlows(prev => [created, ...prev]);
      setFlowView({ mode: 'edit', id: created.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Stroom aanmaken mislukt.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteFlow(id: UUID) {
    if (!canWrite || busy) return;
    if (!window.confirm('Deze stroom definitief verwijderen?')) return;
    setBusy(true);
    try {
      await deleteFlow(organizationId, id);
      setFlows(prev => prev.filter(f => f.id !== id));
      setFlowView({ mode: 'list' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verwijderen mislukt.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mk">
      <div className="mk-head">
        <div>
          <p className="eyebrow">E-mailmarketing</p>
          <h1 className="mk-title">Campagnes & mailings</h1>
          <p className="mk-sub">Stuur gerichte mail naar je klanten en volg wie opent, klikt en antwoordt.</p>
        </div>
        {tab === 'campaigns' && view.mode === 'list' && canWrite && (
          <Button variant="primary" onClick={handleNew} disabled={busy}><Plus size={16} /> Nieuwe campagne</Button>
        )}
        {tab === 'flows' && flowView.mode === 'list' && canWrite && (
          <Button variant="primary" onClick={handleNewFlow} disabled={busy}><Plus size={16} /> Nieuwe stroom</Button>
        )}
      </div>

      <div className="client-tabs-bar mk-tabs">
        <button className={`client-tab-btn${tab === 'campaigns' ? ' active' : ''}`} onClick={() => { setTab('campaigns'); setView({ mode: 'list' }); }}>
          <Megaphone size={15} /> Campagnes
        </button>
        <button className={`client-tab-btn${tab === 'flows' ? ' active' : ''}`} onClick={() => { setTab('flows'); setFlowView({ mode: 'list' }); }}>
          <Workflow size={15} /> Stromen
        </button>
        <button className={`client-tab-btn${tab === 'suppressions' ? ' active' : ''}`} onClick={() => setTab('suppressions')}>
          <Ban size={15} /> Afmeldingen{suppressions.length > 0 && <span className="client-tab-badge">{suppressions.length}</span>}
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {tab === 'suppressions' ? (
        <SuppressionsTab
          organizationId={organizationId} canWrite={canWrite} suppressions={suppressions}
          onChanged={reload} onError={setError}
        />
      ) : loading ? (
        <div className="mk-empty">Laden…</div>
      ) : tab === 'flows' ? (
        flowView.mode === 'list' ? (
          <FlowList
            flows={flows} stats={flowStats} canWrite={canWrite}
            onOpen={(f) => setFlowView(f.status === 'draft' ? { mode: 'edit', id: f.id } : { mode: 'detail', id: f.id })}
            onDelete={handleDeleteFlow}
          />
        ) : selectedFlow && flowView.mode === 'edit' ? (
          <FlowEditor
            key={selectedFlow.id} data={data} organizationId={organizationId} canWrite={canWrite} flow={selectedFlow}
            onBack={() => setFlowView({ mode: 'list' })}
            onSaved={(f) => setFlows(prev => prev.map(x => x.id === f.id ? f : x))}
            onActivated={async () => { await reload(); onChanged(); setFlowView({ mode: 'detail', id: selectedFlow.id }); }}
            onDelete={() => handleDeleteFlow(selectedFlow.id)}
            onError={setError}
          />
        ) : selectedFlow ? (
          <FlowDetail
            key={selectedFlow.id} organizationId={organizationId} flow={selectedFlow}
            stats={flowStats[selectedFlow.id]} stepStats={flowStepStats[selectedFlow.id] ?? []}
            canWrite={canWrite} onBack={() => setFlowView({ mode: 'list' })} onChanged={reload} onError={setError}
          />
        ) : (
          <div className="mk-empty">Stroom niet gevonden.</div>
        )
      ) : view.mode === 'list' ? (
        <CampaignList
          campaigns={campaigns} stats={stats} canWrite={canWrite}
          onOpen={(c) => setView(c.status === 'draft' || c.status === 'scheduled' ? { mode: 'edit', id: c.id } : { mode: 'detail', id: c.id })}
          onDuplicate={handleDuplicate} onDelete={handleDelete}
        />
      ) : selected && view.mode === 'edit' ? (
        <CampaignEditor
          key={selected.id} data={data} organizationId={organizationId} canWrite={canWrite} campaign={selected}
          onBack={() => setView({ mode: 'list' })}
          onSaved={(c) => setCampaigns(prev => prev.map(x => x.id === c.id ? c : x))}
          onSent={async () => { await reload(); onChanged(); setView({ mode: 'detail', id: selected.id }); }}
          onDelete={() => handleDelete(selected.id)}
          onError={setError}
        />
      ) : selected ? (
        <CampaignDetail
          key={selected.id} organizationId={organizationId} campaign={selected} stats={stats[selected.id]}
          canWrite={canWrite} onBack={() => setView({ mode: 'list' })} onChanged={reload} onError={setError}
        />
      ) : (
        <div className="mk-empty">Campagne niet gevonden.</div>
      )}
    </div>
  );
}

// ── Campagnelijst ───────────────────────────────────────────────────────────

function CampaignList({ campaigns, stats, canWrite, onOpen, onDuplicate, onDelete }: {
  campaigns: EmailCampaign[];
  stats: Record<UUID, EmailCampaignStats>;
  canWrite: boolean;
  onOpen: (c: EmailCampaign) => void;
  onDuplicate: (c: EmailCampaign) => void;
  onDelete: (id: UUID) => void;
}) {
  if (campaigns.length === 0) {
    return <div className="mk-empty"><Mail size={30} /><p>Nog geen campagnes. Maak er een aan om je eerste mailing te versturen.</p></div>;
  }
  return (
    <div className="quote-table-card">
      <div className="quote-table-scroll">
        <table className="quote-table mk-table">
          <thead>
            <tr><th>Campagne</th><th>Status</th><th>Verzonden</th><th>Resultaat</th><th></th></tr>
          </thead>
          <tbody>
            {campaigns.map(c => {
              const s = stats[c.id];
              return (
                <tr key={c.id} className="mk-row" onClick={() => onOpen(c)}>
                  <td data-label="Campagne">
                    <div className="mk-name">{c.name || '(naamloos)'}</div>
                    <div className="mk-subject">{c.subject || 'Geen onderwerp'}</div>
                  </td>
                  <td data-label="Status"><span className={`mk-status ${c.status}`}>{STATUS_LABEL[c.status] ?? c.status}</span></td>
                  <td data-label="Verzonden">{s ? `${s.sent}/${s.total}` : '—'}</td>
                  <td data-label="Resultaat">
                    {s ? (
                      <div className="mk-stat-row">
                        <span className="mk-chip" title="Geopend">{s.opened} geopend</span>
                        <span className="mk-chip" title="Geklikt">{s.clicked} klik</span>
                        <span className="mk-chip good" title="Geantwoord">{s.replied} antw.</span>
                        {s.unsubscribed > 0 && <span className="mk-chip warn" title="Afgemeld">{s.unsubscribed} afm.</span>}
                      </div>
                    ) : '—'}
                  </td>
                  <td data-label="" className="mk-actions" onClick={(e) => e.stopPropagation()}>
                    {canWrite && <button className="mk-icon" title="Dupliceren" onClick={() => onDuplicate(c)}><Copy size={15} /></button>}
                    {canWrite && (c.status === 'draft' || c.status === 'cancelled') && (
                      <button className="mk-icon danger" title="Verwijderen" onClick={() => onDelete(c.id)}><Trash2 size={15} /></button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Variabelen ({{token}}) ──────────────────────────────────────────────────

/** De velddefinities in de vorm die de gedeelde tokenmodule verwacht. */
function toMergeDefinitions(definitions: ClientFieldDefinition[]): MergeFieldDefinition[] {
  return activeFieldDefinitions(definitions).map(d => ({
    field_key: d.field_key,
    label: d.label,
    field_type: d.field_type,
    default_fallback: d.default_fallback,
  }));
}

/**
 * Sleepbare/klikbare chips waarmee je een variabele in de tekst zet. Bewust
 * dezelfde bediening als bij contracten: slepen zet hem op de cursorpositie,
 * klikken kopieert naar het klembord.
 */
function MergeTokenChips({ definitions }: { definitions: ClientFieldDefinition[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  const custom = activeFieldDefinitions(definitions);

  const groups: Array<{ title: string; items: Array<{ token: string; label: string }> }> = [
    ...['Klant', 'Eigen bedrijf', 'Overig'].map(group => ({
      title: group,
      items: STANDARD_MERGE_TOKENS.filter(t => t.group === group).map(t => ({ token: t.token, label: t.label })),
    })),
    ...(custom.length > 0
      ? [{ title: 'Eigen velden', items: custom.map(d => ({ token: customFieldToken(d.field_key), label: d.label })) }]
      : []),
  ];

  function copy(token: string) {
    try { void navigator.clipboard?.writeText(`{{${token}}}`); } catch { /* klembord kan geweigerd zijn */ }
    setCopied(token);
    window.setTimeout(() => setCopied(c => (c === token ? null : c)), 1200);
  }

  return (
    <div className="mk-tokens">
      <div className="mk-tokens-intro">
        Sleep een variabele in je tekst, of klik om te kopiëren. Is het veld bij een klant leeg, geef dan een terugval mee:
        <code>{'{{voornaam|klant}}'}</code>.
      </div>
      {groups.map(group => (
        <div key={group.title} className="mk-token-group">
          <span className="mk-token-group-title">{group.title}</span>
          <div className="mk-token-chips">
            {group.items.map(item => (
              <span
                key={item.token}
                role="button"
                tabIndex={0}
                draggable
                className={`mk-token-chip${copied === item.token ? ' copied' : ''}`}
                onDragStart={e => { e.dataTransfer.setData('text/plain', `{{${item.token}}}`); e.dataTransfer.effectAllowed = 'copy'; }}
                onClick={() => copy(item.token)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copy(item.token); } }}
                title={`${item.label} — {{${item.token}}}`}
              >
                {copied === item.token ? '✓ gekopieerd' : item.label}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Waarschuwt over variabelen die nergens op slaan: een typefout, of een veld dat
 * inmiddels verwijderd is. Zo'n token wordt bij het versturen weggelaten (het
 * hoort nooit als "{{voornam}}" bij de klant te belanden), dus zonder deze
 * melding zou je het gat pas ná verzending zien.
 */
function UnknownTokenWarning({ texts, definitions }: { texts: Array<string | null | undefined>; definitions: ClientFieldDefinition[] }) {
  const unknown = useMemo(() => {
    const merge = toMergeDefinitions(definitions);
    return [...new Set(texts.flatMap(text => unknownMergeTokens(text, merge)))];
  }, [texts, definitions]);

  if (unknown.length === 0) return null;
  return (
    <div className="mk-token-warning">
      <MailWarning size={15} />
      <span>
        {unknown.length === 1
          ? 'Deze variabele bestaat niet en blijft leeg bij het versturen:'
          : 'Deze variabelen bestaan niet en blijven leeg bij het versturen:'}{' '}
        {unknown.map((token, i) => (
          <span key={token}>{i > 0 && ', '}<code>{`{{${token}}}`}</code></span>
        ))}
      </span>
    </div>
  );
}

// ── Campagne-editor ─────────────────────────────────────────────────────────

function CampaignEditor({ data, organizationId, canWrite, campaign, onBack, onSaved, onSent, onDelete, onError }: {
  data: AppData;
  organizationId: UUID;
  canWrite: boolean;
  campaign: EmailCampaign;
  onBack: () => void;
  onSaved: (c: EmailCampaign) => void;
  onSent: () => void | Promise<void>;
  onDelete: () => void;
  onError: (msg: string | null) => void;
}) {
  const [name, setName] = useState(campaign.name);
  const [subject, setSubject] = useState(campaign.subject);
  const [preheader, setPreheader] = useState(campaign.preheader ?? '');
  const [bodyHtml, setBodyHtml] = useState(campaign.body_html);
  const [accent, setAccent] = useState(campaign.accent_color ?? '#FFD966');
  const [audience, setAudience] = useState<CampaignAudience>(campaign.audience ?? emptyAudience());
  const [testEmail, setTestEmail] = useState('');
  const [scheduleAt, setScheduleAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const readOnly = !canWrite;

  const buildInput = useCallback(() => ({
    name: name.trim() || 'Naamloze campagne',
    subject: subject.trim(),
    preheader: preheader.trim() || null,
    body_html: bodyHtml,
    accent_color: accent,
    audience,
  }), [name, subject, preheader, bodyHtml, accent, audience]);

  // persist() beheert bewust GEEN busy-vlag: de aanroepende actie-handlers houden
  // busy vast over hun HELE duur (opslaan + versturen), zodat de knoppen niet
  // tussentijds weer klikbaar worden (dubbele-submit-guard).
  async function persist(): Promise<boolean> {
    onError(null);
    try {
      const updated = await updateCampaign(organizationId, campaign.id, buildInput());
      onSaved(updated);
      return true;
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Opslaan mislukt.');
      return false;
    }
  }

  async function handleSaveButton() {
    setBusy(true);
    try {
      if (await persist()) setNotice('Opgeslagen.');
    } finally {
      setBusy(false);
    }
  }

  async function handleTest() {
    if (!testEmail.trim()) { onError('Vul een test-e-mailadres in.'); return; }
    onError(null);
    setBusy(true);
    try {
      if (!(await persist())) return;
      await sendTestCampaign(organizationId, campaign.id, testEmail.trim());
      setNotice(`Testmail verstuurd naar ${testEmail.trim()}.`);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Testmail mislukt.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSend() {
    if (!subject.trim()) { onError('Vul een onderwerp in voordat je verstuurt.'); return; }
    if (!window.confirm('De campagne nu naar de geselecteerde klanten versturen?')) return;
    onError(null);
    setBusy(true);
    try {
      if (!(await persist())) return;
      const res = await sendCampaign(organizationId, campaign.id);
      setNotice(`Verzending gestart: ${res.sent} verstuurd, nog ${res.remaining} in de wachtrij.`);
      await onSent();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Versturen mislukt.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSchedule() {
    if (!scheduleAt) { onError('Kies een verzendmoment.'); return; }
    if (!subject.trim()) { onError('Vul een onderwerp in.'); return; }
    onError(null);
    setBusy(true);
    try {
      if (!(await persist())) return;
      await scheduleCampaign(organizationId, campaign.id, new Date(scheduleAt).toISOString());
      setNotice('Campagne ingepland.');
      await onSent();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Inplannen mislukt.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mk-editor">
      <div className="mk-editor-bar">
        <button className="mk-back" onClick={onBack}><X size={16} /> Terug</button>
        <span className={`mk-status ${campaign.status}`}>{STATUS_LABEL[campaign.status] ?? campaign.status}</span>
        {notice && <span className="mk-notice">{notice}</span>}
      </div>

      <div className="mk-editor-grid">
        <div className="settings-card mk-card">
          <label className="mk-field"><span>Interne naam</span>
            <Input value={name} onChange={e => setName(e.target.value)} disabled={readOnly} placeholder="Bijv. Nieuwsbrief juli" />
          </label>
          <label className="mk-field"><span>Onderwerp</span>
            <Input value={subject} onChange={e => setSubject(e.target.value)} disabled={readOnly} placeholder="Onderwerp van de e-mail" />
          </label>
          <label className="mk-field"><span>Preheader <em>(voorbeeldtekst in de inbox)</em></span>
            <Input value={preheader} onChange={e => setPreheader(e.target.value)} disabled={readOnly} placeholder="Korte samenvatting" />
          </label>
          <div className="mk-field"><span>Bericht</span>
            <RichTextEditor value={bodyHtml} onChange={setBodyHtml} disabled={readOnly} placeholder="Schrijf je bericht…" />
          </div>
          {!readOnly && <MergeTokenChips definitions={data.clientFieldDefinitions} />}
          <UnknownTokenWarning texts={[subject, preheader, bodyHtml]} definitions={data.clientFieldDefinitions} />
          <div className="mk-field"><span>Accentkleur</span>
            <ColorPicker value={accent} onChange={setAccent} disabled={readOnly} />
          </div>
        </div>

        <div className="mk-side">
          <AudienceSelector data={data} organizationId={organizationId} value={audience} onChange={setAudience} disabled={readOnly} />

          {!readOnly && (
            <div className="settings-card mk-card">
              <div className="mk-card-title">Testen</div>
              <div className="mk-inline">
                <Input type="email" value={testEmail} onChange={e => setTestEmail(e.target.value)} placeholder="jij@voorbeeld.nl" />
                <Button onClick={handleTest} disabled={busy}><Send size={15} /> Test</Button>
              </div>
            </div>
          )}

          {!readOnly && (
            <div className="settings-card mk-card">
              <div className="mk-card-title">Versturen</div>
              <Button variant="primary" className="mk-full" onClick={handleSend} disabled={busy}><Send size={16} /> Nu versturen</Button>
              <div className="mk-schedule">
                <Input type="datetime-local" value={scheduleAt} onChange={e => setScheduleAt(e.target.value)} />
                <Button onClick={handleSchedule} disabled={busy}>Inplannen</Button>
              </div>
              <div className="mk-editor-foot">
                <Button onClick={handleSaveButton} disabled={busy}>Opslaan</Button>
                <button className="mk-icon danger" title="Verwijderen" onClick={onDelete} disabled={busy}><Trash2 size={15} /></button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Doelgroep-selector ──────────────────────────────────────────────────────

const STATUS_OPTIONS: { value: 'active' | 'prospect' | 'inactive'; label: string }[] = [
  { value: 'active', label: 'Actief' }, { value: 'prospect', label: 'Prospect' }, { value: 'inactive', label: 'Inactief' },
];

function AudienceSelector({ data, organizationId, value, onChange, disabled }: {
  data: AppData;
  organizationId: UUID;
  value: CampaignAudience;
  onChange: (a: CampaignAudience) => void;
  disabled: boolean;
}) {
  const allTags = useMemo(() => [...new Set(data.clients.flatMap(c => c.tags ?? []))].filter(Boolean).sort(), [data.clients]);
  const [preview, setPreview] = useState<CampaignAudiencePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [clientQuery, setClientQuery] = useState('');

  const audienceKey = JSON.stringify(value);
  useEffect(() => {
    let cancelled = false;
    setPreviewing(true);
    const timer = window.setTimeout(async () => {
      try {
        const result = await previewCampaignAudience(organizationId, value);
        if (!cancelled) setPreview(result);
      } catch {
        if (!cancelled) setPreview(null);
      } finally {
        if (!cancelled) setPreviewing(false);
      }
    }, 400);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audienceKey, organizationId]);

  const patch = (p: Partial<CampaignAudience>) => onChange({ ...value, ...p });
  const toggleStatus = (s: 'active' | 'prospect' | 'inactive') =>
    patch({ statuses: value.statuses.includes(s) ? value.statuses.filter(x => x !== s) : [...value.statuses, s] });
  const toggleTag = (t: string) =>
    patch({ tags: value.tags.includes(t) ? value.tags.filter(x => x !== t) : [...value.tags, t] });
  const toggleClient = (id: UUID) =>
    patch({ manualClientIds: value.manualClientIds.includes(id) ? value.manualClientIds.filter(x => x !== id) : [...value.manualClientIds, id] });

  const filteredClients = useMemo(() => {
    const q = clientQuery.trim().toLowerCase();
    const list = q ? data.clients.filter(c => `${c.name} ${c.email ?? ''}`.toLowerCase().includes(q)) : data.clients;
    return list.slice(0, 200);
  }, [data.clients, clientQuery]);

  return (
    <div className="settings-card mk-card mk-audience">
      <div className="mk-card-title"><Users size={15} /> Ontvangers</div>

      <div className="mk-audience-modes">
        <button type="button" className={value.mode === 'filter' ? 'active' : ''} disabled={disabled} onClick={() => patch({ mode: 'filter' })}>Op filter</button>
        <button type="button" className={value.mode === 'manual' ? 'active' : ''} disabled={disabled} onClick={() => patch({ mode: 'manual' })}>Handmatig</button>
      </div>

      {value.mode === 'filter' ? (
        <>
          <div className="mk-audience-block">
            <span className="mk-audience-label">Klantstatus <em>(leeg = alle)</em></span>
            <div className="mk-checks">
              {STATUS_OPTIONS.map(o => (
                <label key={o.value} className={`mk-check${value.statuses.includes(o.value) ? ' on' : ''}`}>
                  <input type="checkbox" checked={value.statuses.includes(o.value)} disabled={disabled} onChange={() => toggleStatus(o.value)} />
                  {o.label}
                </label>
              ))}
            </div>
          </div>
          {allTags.length > 0 && (
            <div className="mk-audience-block">
              <span className="mk-audience-label">Labels <em>(leeg = alle)</em></span>
              <div className="mk-checks mk-tag-list">
                {allTags.map(t => (
                  <label key={t} className={`mk-check${value.tags.includes(t) ? ' on' : ''}`}>
                    <input type="checkbox" checked={value.tags.includes(t)} disabled={disabled} onChange={() => toggleTag(t)} />
                    {t}
                  </label>
                ))}
              </div>
            </div>
          )}
          <CustomFieldFilters
            data={data}
            filters={value.customFilters ?? []}
            disabled={disabled}
            onChange={customFilters => patch({ customFilters })}
          />
        </>
      ) : (
        <div className="mk-audience-block">
          <Input value={clientQuery} onChange={e => setClientQuery(e.target.value)} placeholder="Zoek klant…" disabled={disabled} />
          <div className="mk-client-list">
            {filteredClients.map(c => (
              <label key={c.id} className={`mk-check${value.manualClientIds.includes(c.id) ? ' on' : ''}`}>
                <input type="checkbox" checked={value.manualClientIds.includes(c.id)} disabled={disabled} onChange={() => toggleClient(c.id)} />
                <span>{c.name}{c.email ? <em> · {c.email}</em> : ''}</span>
              </label>
            ))}
            {filteredClients.length === 0 && <div className="mk-muted">Geen klanten gevonden.</div>}
          </div>
        </div>
      )}

      <label className="mk-check mk-contacts-toggle">
        <input type="checkbox" checked={value.includeContacts} disabled={disabled} onChange={() => patch({ includeContacts: !value.includeContacts })} />
        Ook contactpersonen meenemen
      </label>

      <div className="mk-preview">
        {previewing ? <span className="mk-muted">Berekenen…</span> : preview ? (
          <>
            <div className="mk-preview-count"><strong>{preview.sendable}</strong> ontvangers</div>
            <div className="mk-preview-meta">
              {preview.suppressed > 0 && <span>{preview.suppressed} afgemeld</span>}
              {preview.withoutEmail > 0 && <span>{preview.withoutEmail} zonder e-mail</span>}
            </div>
          </>
        ) : <span className="mk-muted">Nog geen telling.</span>}
      </div>
    </div>
  );
}

const CUSTOM_FILTER_OPERATOR_LABEL: Record<CampaignCustomFilterOperator, string> = {
  is: 'is',
  not: 'is niet',
  filled: 'is ingevuld',
  empty: 'is leeg',
};

/**
 * Voorwaarden op de vrije klantvelden, bv. "Pakket is Premium". Alle
 * voorwaarden moeten kloppen (EN) — dat is voorspelbaarder dan een mengeling
 * van EN en OF, en dekt in de praktijk wat je met een mailing wilt.
 */
function CustomFieldFilters({ data, filters, disabled, onChange }: {
  data: AppData;
  filters: CampaignCustomFilter[];
  disabled: boolean;
  onChange: (filters: CampaignCustomFilter[]) => void;
}) {
  const definitions = useMemo(() => activeFieldDefinitions(data.clientFieldDefinitions), [data.clientFieldDefinitions]);
  const allValues = useMemo(() => data.clients.map(c => c.custom_fields), [data.clients]);
  if (definitions.length === 0) return null;

  const patchAt = (index: number, patch: Partial<CampaignCustomFilter>) =>
    onChange(filters.map((f, i) => (i === index ? { ...f, ...patch } : f)));

  return (
    <div className="mk-audience-block">
      <span className="mk-audience-label">Eigen velden <em>(alle voorwaarden moeten kloppen)</em></span>

      {filters.map((filter, index) => {
        const def = definitions.find(d => d.field_key === filter.fieldKey);
        const needsValue = filter.operator === 'is' || filter.operator === 'not';
        const suggestions = def ? distinctFieldValues(def, allValues) : [];
        const listId = `cf-values-${index}-${filter.fieldKey}`;

        return (
          <div key={index} className="mk-filter-row">
            <Select value={filter.fieldKey} disabled={disabled} onChange={e => patchAt(index, { fieldKey: e.target.value, value: '' })}>
              {definitions.map(d => <option key={d.field_key} value={d.field_key}>{d.label}</option>)}
            </Select>

            <Select
              value={filter.operator}
              disabled={disabled}
              onChange={e => patchAt(index, { operator: e.target.value as CampaignCustomFilterOperator })}
            >
              {(Object.keys(CUSTOM_FILTER_OPERATOR_LABEL) as CampaignCustomFilterOperator[]).map(op => (
                <option key={op} value={op}>{CUSTOM_FILTER_OPERATOR_LABEL[op]}</option>
              ))}
            </Select>

            {needsValue && (
              <>
                <Input
                  value={filter.value}
                  disabled={disabled}
                  list={suggestions.length > 0 ? listId : undefined}
                  placeholder="Waarde"
                  onChange={e => patchAt(index, { value: e.target.value })}
                />
                {suggestions.length > 0 && (
                  <datalist id={listId}>
                    {suggestions.map(v => <option key={v} value={v} />)}
                  </datalist>
                )}
              </>
            )}

            <button
              type="button"
              className="mk-icon danger"
              title="Voorwaarde verwijderen"
              disabled={disabled}
              onClick={() => onChange(filters.filter((_, i) => i !== index))}
            >
              <X size={14} />
            </button>
          </div>
        );
      })}

      <button
        type="button"
        className="mk-filter-add"
        disabled={disabled}
        onClick={() => onChange([...filters, { fieldKey: definitions[0].field_key, operator: 'is', value: '' }])}
      >
        <Plus size={14} /> Voorwaarde toevoegen
      </button>
    </div>
  );
}

// ── Campagne-detail (tracking) ──────────────────────────────────────────────

function CampaignDetail({ organizationId, campaign, stats, canWrite, onBack, onChanged, onError }: {
  organizationId: UUID;
  campaign: EmailCampaign;
  stats: EmailCampaignStats | undefined;
  canWrite: boolean;
  onBack: () => void;
  onChanged: () => void | Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [recipients, setRecipients] = useState<EmailCampaignRecipient[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const loadRecipients = useCallback(async () => {
    setLoading(true);
    try {
      setRecipients(await loadCampaignRecipients(organizationId, campaign.id));
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Ontvangers laden mislukt.');
    } finally {
      setLoading(false);
    }
  }, [organizationId, campaign.id, onError]);

  useEffect(() => { void loadRecipients(); }, [loadRecipients]);

  // Ververs ontvangers ÉN de geaggregeerde stats (die uit de parent komen).
  const refreshAll = useCallback(async () => {
    await Promise.all([loadRecipients(), Promise.resolve(onChanged())]);
  }, [loadRecipients, onChanged]);

  // Terwijl de campagne verzendt, komen tracking-events binnen: licht pollen zodat
  // de tellers vanzelf oplopen zonder handmatig verversen.
  useEffect(() => {
    if (campaign.status !== 'sending') return;
    const id = window.setInterval(() => { void refreshAll(); }, 15000);
    return () => window.clearInterval(id);
  }, [campaign.status, refreshAll]);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    onError(null);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Actie mislukt.');
    } finally {
      setBusy(false);
    }
  }

  const chips: { label: string; value: number; cls?: string }[] = stats ? [
    { label: 'Ontvangers', value: stats.total },
    { label: 'Verzonden', value: stats.sent },
    { label: 'Afgeleverd', value: stats.delivered },
    { label: 'Geopend', value: stats.opened },
    { label: 'Geklikt', value: stats.clicked },
    { label: 'Geantwoord', value: stats.replied, cls: 'good' },
    { label: 'Gebounced', value: stats.bounced, cls: 'warn' },
    { label: 'Afgemeld', value: stats.unsubscribed, cls: 'warn' },
  ] : [];

  return (
    <div className="mk-detail">
      <div className="mk-editor-bar">
        <button className="mk-back" onClick={onBack}><X size={16} /> Terug</button>
        <span className={`mk-status ${campaign.status}`}>{STATUS_LABEL[campaign.status] ?? campaign.status}</span>
        <div className="mk-detail-actions">
          <Button onClick={() => void refreshAll()} disabled={loading || busy}>Ververs</Button>
          {canWrite && campaign.status === 'sending' && <Button onClick={() => act(() => pauseCampaign(organizationId, campaign.id))} disabled={busy}><Pause size={15} /> Pauzeer</Button>}
          {canWrite && campaign.status === 'paused' && <Button variant="primary" onClick={() => act(() => resumeCampaign(organizationId, campaign.id))} disabled={busy}><Play size={15} /> Hervat</Button>}
          {canWrite && (campaign.status === 'sending' || campaign.status === 'paused' || campaign.status === 'scheduled') && (
            <Button variant="danger" onClick={() => act(() => cancelCampaign(organizationId, campaign.id))} disabled={busy}><Ban size={15} /> Annuleer</Button>
          )}
        </div>
      </div>

      <div className="mk-detail-head">
        <h2>{campaign.name || '(naamloos)'}</h2>
        <p className="mk-subject">{campaign.subject}</p>
        <p className="mk-muted">Gestart: {fmtDate(campaign.started_at)} · Afgerond: {fmtDate(campaign.sent_at)}</p>
      </div>

      <div className="mk-stat-grid">
        {chips.map(c => (
          <div key={c.label} className={`stat-card mk-stat-card${c.cls ? ' ' + c.cls : ''}`}>
            <div className="sc-val">{c.value}</div><div className="sc-label">{c.label}</div>
          </div>
        ))}
      </div>

      <div className="quote-table-card">
        <div className="quote-table-scroll">
          <table className="quote-table mk-table">
            <thead><tr><th>Ontvanger</th><th>Status</th><th>Geopend</th><th>Geklikt</th><th>Geantwoord</th></tr></thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} className="mk-muted">Laden…</td></tr>
              ) : recipients.length === 0 ? (
                <tr><td colSpan={5} className="mk-muted">Nog geen ontvangers.</td></tr>
              ) : recipients.map(r => (
                <tr key={r.id}>
                  <td data-label="Ontvanger"><div className="mk-name">{r.to_name || r.to_email}</div>{r.to_name && <div className="mk-subject">{r.to_email}</div>}</td>
                  <td data-label="Status"><span className={`mk-status ${recipientStatusClass(r.status)}`}>{recipientStatusLabel(r.status)}</span>{r.error_message && <span className="mk-err" title={r.error_message}><MailWarning size={13} /></span>}</td>
                  <td data-label="Geopend">{r.opened_at ? <CheckCircle2 size={15} className="mk-ok" /> : '—'}</td>
                  <td data-label="Geklikt">{r.clicked_at ? <CheckCircle2 size={15} className="mk-ok" /> : '—'}</td>
                  <td data-label="Geantwoord">{r.replied_at ? <CheckCircle2 size={15} className="mk-ok" /> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function recipientStatusLabel(status: string): string {
  const map: Record<string, string> = {
    pending: 'In wachtrij', sending: 'Verzenden', sent: 'Verzonden', delivered: 'Afgeleverd', opened: 'Geopend',
    clicked: 'Geklikt', bounced: 'Gebounced', failed: 'Mislukt', complained: 'Klacht', skipped: 'Overgeslagen', unsubscribed: 'Afgemeld',
  };
  return map[status] ?? status;
}
function recipientStatusClass(status: string): string {
  if (status === 'bounced' || status === 'failed' || status === 'complained') return 'cancelled';
  if (status === 'unsubscribed' || status === 'skipped') return 'paused';
  if (status === 'opened' || status === 'clicked' || status === 'delivered') return 'sent';
  if (status === 'sent') return 'scheduled';
  return 'draft';
}

// ── Afmeldingen ─────────────────────────────────────────────────────────────

const SUPPRESSION_REASON_LABEL: Record<string, string> = {
  unsubscribed: 'Afgemeld', bounced: 'Gebounced', complained: 'Klacht', manual: 'Handmatig',
};

function SuppressionsTab({ organizationId, canWrite, suppressions, onChanged, onError }: {
  organizationId: UUID;
  canWrite: boolean;
  suppressions: EmailSuppression[];
  onChanged: () => void | Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  async function add() {
    const value = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) { onError('Vul een geldig e-mailadres in.'); return; }
    setBusy(true); onError(null);
    try {
      await addSuppression(organizationId, value, 'manual');
      setEmail('');
      await onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Toevoegen mislukt.');
    } finally { setBusy(false); }
  }

  async function remove(value: string) {
    setBusy(true); onError(null);
    try {
      await removeSuppression(organizationId, value);
      await onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Verwijderen mislukt.');
    } finally { setBusy(false); }
  }

  return (
    <div className="mk-suppressions">
      <div className="settings-card mk-card">
        <div className="mk-card-title">Afmeldingen & blokkeringen</div>
        <p className="mk-muted">Deze adressen ontvangen geen marketingmail meer. Adressen komen hier via de afmeldlink, een bounce/klacht, of handmatig.</p>
        {canWrite && (
          <div className="mk-inline">
            <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="adres@voorbeeld.nl" />
            <Button onClick={add} disabled={busy}><Plus size={15} /> Blokkeren</Button>
          </div>
        )}
      </div>

      <div className="quote-table-card">
        <div className="quote-table-scroll">
          <table className="quote-table mk-table">
            <thead><tr><th>E-mailadres</th><th>Reden</th><th>Sinds</th><th></th></tr></thead>
            <tbody>
              {suppressions.length === 0 ? (
                <tr><td colSpan={4} className="mk-muted">Nog geen afmeldingen.</td></tr>
              ) : suppressions.map(s => (
                <tr key={s.email}>
                  <td data-label="E-mailadres">{s.email}</td>
                  <td data-label="Reden"><span className="mk-status paused">{SUPPRESSION_REASON_LABEL[s.reason] ?? s.reason}</span></td>
                  <td data-label="Sinds">{fmtDate(s.created_at)}</td>
                  <td data-label="" className="mk-actions">
                    {canWrite && <button className="mk-icon" title="Weer toestaan" onClick={() => remove(s.email)} disabled={busy}><Trash2 size={15} /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Stromen (follow-ups) ────────────────────────────────────────────────────

function emptyStep(index: number): FlowStepInput {
  return { step_index: index, delay_days: index === 0 ? 0 : 3, subject: '', preheader: null, body_html: '', body_text: null, accent_color: '#FFD966' };
}

function FlowList({ flows, stats, canWrite, onOpen, onDelete }: {
  flows: EmailFlow[];
  stats: Record<UUID, EmailFlowStats>;
  canWrite: boolean;
  onOpen: (f: EmailFlow) => void;
  onDelete: (id: UUID) => void;
}) {
  if (flows.length === 0) {
    return <div className="mk-empty"><Workflow size={30} /><p>Nog geen stromen. Maak een reeks die automatisch opvolgt wanneer een klant niet reageert.</p></div>;
  }
  return (
    <div className="quote-table-card">
      <div className="quote-table-scroll">
        <table className="quote-table mk-table">
          <thead><tr><th>Stroom</th><th>Status</th><th>Ingeschreven</th><th>Voortgang</th><th></th></tr></thead>
          <tbody>
            {flows.map(f => {
              const s = stats[f.id];
              return (
                <tr key={f.id} className="mk-row" onClick={() => onOpen(f)}>
                  <td data-label="Stroom">
                    <div className="mk-name">{f.name || '(naamloos)'}</div>
                    <div className="mk-subject">Stopt zodra de klant: {STOP_CONDITION_LABEL[f.stop_condition].toLowerCase()}</div>
                  </td>
                  <td data-label="Status"><span className={`mk-status ${f.status}`}>{STATUS_LABEL[f.status] ?? f.status}</span></td>
                  <td data-label="Ingeschreven">{s ? s.enrollments : '—'}</td>
                  <td data-label="Voortgang">
                    {s ? (
                      <div className="mk-stat-row">
                        <span className="mk-chip">{s.active} lopend</span>
                        <span className="mk-chip good">{s.stopped_reacted} gereageerd</span>
                        <span className="mk-chip">{s.completed} klaar</span>
                      </div>
                    ) : '—'}
                  </td>
                  <td className="mk-actions" onClick={e => e.stopPropagation()}>
                    {canWrite && (f.status === 'draft' || f.status === 'archived') && (
                      <button className="mk-icon danger" title="Verwijderen" onClick={() => onDelete(f.id)}><Trash2 size={15} /></button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FlowEditor({ data, organizationId, canWrite, flow, onBack, onSaved, onActivated, onDelete, onError }: {
  data: AppData;
  organizationId: UUID;
  canWrite: boolean;
  flow: EmailFlow;
  onBack: () => void;
  onSaved: (f: EmailFlow) => void;
  onActivated: () => void | Promise<void>;
  onDelete: () => void;
  onError: (msg: string | null) => void;
}) {
  const [name, setName] = useState(flow.name);
  const [stopCondition, setStopCondition] = useState<FlowStopCondition>(flow.stop_condition);
  const [audience, setAudience] = useState<CampaignAudience>(flow.audience ?? emptyAudience());
  const [steps, setSteps] = useState<FlowStepInput[]>([]);
  const [stepsLoaded, setStepsLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const readOnly = !canWrite;

  useEffect(() => {
    let cancelled = false;
    loadFlowSteps(organizationId, flow.id)
      .then((rows: EmailFlowStep[]) => {
        if (cancelled) return;
        const mapped = rows.map(r => ({ step_index: r.step_index, delay_days: r.delay_days, subject: r.subject, preheader: r.preheader, body_html: r.body_html, body_text: r.body_text, accent_color: r.accent_color }));
        setSteps(mapped.length ? mapped : [emptyStep(0)]);
        setStepsLoaded(true);
      })
      .catch(() => { if (!cancelled) { setSteps([emptyStep(0)]); setStepsLoaded(true); } });
    return () => { cancelled = true; };
  }, [organizationId, flow.id]);

  const updateStep = (i: number, patch: Partial<FlowStepInput>) => setSteps(prev => prev.map((s, idx) => idx === i ? { ...s, ...patch } : s));
  const addStep = () => setSteps(prev => [...prev, emptyStep(prev.length)]);
  const removeStep = (i: number) => setSteps(prev => prev.filter((_, idx) => idx !== i));

  async function persist(): Promise<boolean> {
    if (!stepsLoaded) return false; // nooit opslaan met een nog-lege stappenlijst (zou alles wissen)
    onError(null);
    try {
      const updated = await updateFlow(organizationId, flow.id, { name: name.trim() || 'Naamloze stroom', audience, stop_condition: stopCondition });
      onSaved(updated);
      const clean = steps.map((s, i) => ({ ...s, step_index: i, delay_days: i === 0 ? 0 : Math.max(0, Math.round(s.delay_days || 0)) }));
      await replaceFlowSteps(organizationId, flow.id, clean);
      return true;
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Opslaan mislukt.');
      return false;
    }
  }

  async function handleSaveButton() {
    setBusy(true);
    try { if (await persist()) setNotice('Opgeslagen.'); } finally { setBusy(false); }
  }

  async function handleActivate() {
    if (steps.some(s => !s.subject.trim())) { onError('Elke stap heeft een onderwerp nodig.'); return; }
    if (!window.confirm('Stroom activeren? De doelgroep wordt ingeschreven en de eerste mail gaat direct uit.')) return;
    setBusy(true);
    try {
      if (!(await persist())) return;
      const res = await activateFlow(organizationId, flow.id);
      setNotice(`Geactiveerd: ${res.enrolled} ingeschreven, ${res.sent} eerste mails verstuurd.`);
      await onActivated();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Activeren mislukt.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mk-editor">
      <div className="mk-editor-bar">
        <button className="mk-back" onClick={onBack}><X size={16} /> Terug</button>
        <span className={`mk-status ${flow.status}`}>{STATUS_LABEL[flow.status] ?? flow.status}</span>
        {notice && <span className="mk-notice">{notice}</span>}
      </div>

      <div className="mk-editor-grid">
        <div className="settings-card mk-card">
          <label className="mk-field"><span>Naam van de stroom</span>
            <Input value={name} onChange={e => setName(e.target.value)} disabled={readOnly} placeholder="Bijv. Opvolging na offerte" />
          </label>
          <label className="mk-field"><span>Stop de reeks zodra de klant heeft…</span>
            <Select value={stopCondition} onChange={e => setStopCondition(e.target.value as FlowStopCondition)} disabled={readOnly}>
              <option value="reply">Alleen een antwoord</option>
              <option value="open_click_reply">Openen, klikken of antwoorden</option>
              <option value="click_reply">Klikken of antwoorden</option>
            </Select>
          </label>

          {!stepsLoaded ? <div className="mk-muted">Stappen laden…</div> : (
            <div className="mk-steps">
              {steps.map((step, i) => (
                <div className="mk-step" key={i}>
                  <div className="mk-step-head">
                    <span className="mk-step-num">Stap {i + 1}</span>
                    <span className="mk-step-delay"><Clock size={13} />
                      {i === 0 ? 'Direct bij inschrijven' : (
                        <>Wacht <Input type="number" min="0" className="mk-days" value={String(step.delay_days)} onChange={e => updateStep(i, { delay_days: Number(e.target.value) })} disabled={readOnly} /> dagen</>
                      )}
                    </span>
                    {!readOnly && steps.length > 1 && <button className="mk-icon danger" title="Stap verwijderen" onClick={() => removeStep(i)}><Trash2 size={14} /></button>}
                  </div>
                  <Input value={step.subject} onChange={e => updateStep(i, { subject: e.target.value })} disabled={readOnly} placeholder="Onderwerp van deze mail" />
                  <RichTextEditor value={step.body_html} onChange={html => updateStep(i, { body_html: html })} disabled={readOnly} placeholder="Bericht van deze stap…" />
                  <UnknownTokenWarning texts={[step.subject, step.body_html]} definitions={data.clientFieldDefinitions} />
                </div>
              ))}
              {!readOnly && <MergeTokenChips definitions={data.clientFieldDefinitions} />}
              {!readOnly && <Button onClick={addStep}><Plus size={15} /> Stap toevoegen</Button>}
            </div>
          )}
        </div>

        <div className="mk-side">
          <AudienceSelector data={data} organizationId={organizationId} value={audience} onChange={setAudience} disabled={readOnly} />
          {!readOnly && (
            <div className="settings-card mk-card">
              <div className="mk-card-title">Publiceren</div>
              <Button variant="primary" className="mk-full" onClick={handleActivate} disabled={busy || !stepsLoaded}><Play size={16} /> Activeren</Button>
              <p className="mk-muted">Bij activeren wordt de doelgroep ingeschreven en gaat de eerste mail direct uit. Volgende stappen volgen automatisch als er niet is gereageerd.</p>
              <div className="mk-editor-foot">
                <Button onClick={handleSaveButton} disabled={busy || !stepsLoaded}>Opslaan</Button>
                <button className="mk-icon danger" title="Verwijderen" onClick={onDelete} disabled={busy}><Trash2 size={15} /></button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FlowDetail({ organizationId, flow, stats, stepStats, canWrite, onBack, onChanged, onError }: {
  organizationId: UUID;
  flow: EmailFlow;
  stats: EmailFlowStats | undefined;
  stepStats: EmailFlowStepStats[];
  canWrite: boolean;
  onBack: () => void;
  onChanged: () => void | Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    onError(null);
    try { await fn(); await onChanged(); }
    catch (e) { onError(e instanceof Error ? e.message : 'Actie mislukt.'); }
    finally { setBusy(false); }
  }

  const chips: { label: string; value: number; cls?: string }[] = stats ? [
    { label: 'Ingeschreven', value: stats.enrollments },
    { label: 'Lopend', value: stats.active },
    { label: 'Gereageerd', value: stats.stopped_reacted, cls: 'good' },
    { label: 'Afgerond', value: stats.completed },
    { label: 'Afgemeld', value: stats.stopped_unsubscribed, cls: 'warn' },
  ] : [];

  const orderedSteps = [...stepStats].sort((a, b) => a.step_index - b.step_index);

  return (
    <div className="mk-detail">
      <div className="mk-editor-bar">
        <button className="mk-back" onClick={onBack}><X size={16} /> Terug</button>
        <span className={`mk-status ${flow.status}`}>{STATUS_LABEL[flow.status] ?? flow.status}</span>
        <div className="mk-detail-actions">
          {canWrite && flow.status === 'active' && <Button onClick={() => act(() => pauseFlow(organizationId, flow.id))} disabled={busy}><Pause size={15} /> Pauzeer</Button>}
          {canWrite && flow.status === 'paused' && <Button variant="primary" onClick={() => act(() => resumeFlow(organizationId, flow.id))} disabled={busy}><Play size={15} /> Hervat</Button>}
          {canWrite && (flow.status === 'active' || flow.status === 'paused') && <Button variant="danger" onClick={() => act(() => cancelFlow(organizationId, flow.id))} disabled={busy}><Ban size={15} /> Stoppen</Button>}
        </div>
      </div>

      <div className="mk-detail-head">
        <h2>{flow.name || '(naamloos)'}</h2>
        <p className="mk-muted">Stopt zodra de klant heeft: {STOP_CONDITION_LABEL[flow.stop_condition].toLowerCase()}</p>
      </div>

      <div className="mk-stat-grid">
        {chips.map(c => (
          <div key={c.label} className={`stat-card mk-stat-card${c.cls ? ' ' + c.cls : ''}`}>
            <div className="sc-val">{c.value}</div><div className="sc-label">{c.label}</div>
          </div>
        ))}
      </div>

      <div className="quote-table-card">
        <div className="quote-table-scroll">
          <table className="quote-table mk-table">
            <thead><tr><th>Stap</th><th>Verzonden</th><th>Geopend</th><th>Geklikt</th><th>Geantwoord</th></tr></thead>
            <tbody>
              {orderedSteps.length === 0 ? (
                <tr><td colSpan={5} className="mk-muted">Nog niets verstuurd.</td></tr>
              ) : orderedSteps.map(s => (
                <tr key={s.step_index}>
                  <td data-label="Stap">Stap {s.step_index + 1}</td>
                  <td data-label="Verzonden">{s.sent}</td>
                  <td data-label="Geopend">{s.opened}</td>
                  <td data-label="Geklikt">{s.clicked}</td>
                  <td data-label="Geantwoord">{s.replied}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
