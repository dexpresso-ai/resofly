import { useEffect, useMemo, useState } from 'react';
import { Download, FileSignature, FileText, Link2, Plus, Send, Trash2, X } from 'lucide-react';
import type { AppData, Contract, ContractEvent, ContractInternalNote, ContractSigner, ContractStatus, ContractTemplate, ContractVersion, Project } from '../types';
import { Modal } from '../components/Modal';
import { Button, Input, Select, Textarea } from '../components/Ui';
import { dateNL, euro, total } from '../lib/format';
import { supabase } from '../lib/supabase';
import { insertRow, updateRow } from '../lib/repository';
import { RichTextEditor, RichTextViewer, richTextToPlainText } from '../components/RichTextEditor';
import { CONTRACT_TOKENS, buildContractTokens, fillContractTokens } from '../lib/contractTokens';

type PageProps = {
  data: AppData;
  organizationId: string;
  canWrite: boolean;
  onChanged: () => void;
};

const STATUS_META: Record<ContractStatus, { label: string; bg: string; fg: string }> = {
  draft: { label: 'Concept', bg: '#2a2a31', fg: '#d8d8df' },
  pending_internal_approval: { label: 'Wacht op goedkeuring', bg: '#3a3320', fg: '#ffd966' },
  internally_approved: { label: 'Intern goedgekeurd', bg: '#23351f', fg: '#9be29b' },
  sent: { label: 'Wacht op ondertekening', bg: '#2a2540', fg: '#c7b8ff' },
  signed: { label: 'Ondertekend', bg: '#1f3a2a', fg: '#7ee2a8' },
  declined: { label: 'Geweigerd', bg: '#3a2020', fg: '#ff9b9b' },
  expired: { label: 'Verlopen', bg: '#332a20', fg: '#ffc480' },
  voided: { label: 'Ingetrokken', bg: '#2a2a31', fg: '#9b9ba7' },
};

export function ContractStatusBadge({ status }: { status: ContractStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.draft;
  return <span style={{ background: meta.bg, color: meta.fg, padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>{meta.label}</span>;
}

export function Contracts({ data, organizationId, canWrite, onChanged }: PageProps) {
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<Contract | 'new' | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);

  async function reload() {
    setError(null);
    const { data: rows, error } = await supabase
      .from('contracts').select('*').eq('organization_id', organizationId).order('created_at', { ascending: false });
    if (error) setError(error.message); else setContracts((rows ?? []) as Contract[]);
    setLoading(false);
  }
  useEffect(() => { setLoading(true); void reload(); /* eslint-disable-next-line */ }, [organizationId]);

  const open = useMemo(() => contracts.find(c => c.id === openId) ?? null, [contracts, openId]);
  const clientName = (id: string | null) => data.clients.find(c => c.id === id)?.name ?? '—';

  return (
    <div className="bk-page">
      <div className="bk-head">
        <div><h2>Contracten</h2><p>Stel contracten op en laat ze digitaal ondertekenen.</p></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button disabled={!canWrite} onClick={() => setShowTemplates(true)}><FileText size={15} /> Sjablonen</Button>
          <Button variant="primary" disabled={!canWrite} onClick={() => setEdit('new')}><Plus size={15} /> Nieuw contract</Button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {loading ? <p className="settings-help">Contracten laden…</p>
        : contracts.length === 0
          ? <div className="empty"><div className="e-big">Nog geen contracten</div><div className="e-sub">Maak je eerste contract en stuur het ter ondertekening.</div></div>
          : <div className="bk-table-wrap"><table className="bk-table">
              <thead><tr><th>Nummer</th><th>Titel</th><th>Klant</th><th>Datum</th><th>Status</th><th></th></tr></thead>
              <tbody>{contracts.map(c => (
                <tr key={c.id} className="bk-row" onClick={() => setOpenId(c.id)}>
                  <td><strong>{c.number}</strong></td>
                  <td>{c.title || <span className="bk-muted">— zonder titel —</span>}</td>
                  <td>{clientName(c.client_id)}</td>
                  <td>{dateNL(c.date)}</td>
                  <td><ContractStatusBadge status={c.status} /></td>
                  <td className="bk-cell-action">Openen</td>
                </tr>
              ))}</tbody>
            </table></div>}

      {edit && <ContractForm
        data={data} organizationId={organizationId} canWrite={canWrite}
        contract={edit === 'new' ? null : edit}
        onClose={() => setEdit(null)}
        onSaved={async (id) => { setEdit(null); await reload(); if (id) setOpenId(id); }}
      />}

      {open && <ContractDetail
        data={data} organizationId={organizationId} canWrite={canWrite} contract={open}
        onClose={() => setOpenId(null)}
        onEdit={() => { setEdit(open); setOpenId(null); }}
        onChanged={async () => { await reload(); onChanged(); }}
        onDeleted={async () => { setOpenId(null); await reload(); }}
      />}

      {showTemplates && <ContractTemplatesManager organizationId={organizationId} canWrite={canWrite} onClose={() => setShowTemplates(false)} />}
    </div>
  );
}

// ───────────────────────────── Sjabloonbeheer ─────────────────────────────

function ContractTemplatesManager({ organizationId, canWrite, onClose }: { organizationId: string; canWrite: boolean; onClose: () => void }) {
  const [templates, setTemplates] = useState<ContractTemplate[]>([]);
  const [editing, setEditing] = useState<ContractTemplate | 'new' | null>(null);
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    const { data, error } = await supabase.from('contract_templates').select('*')
      .eq('organization_id', organizationId).order('name');
    if (error) setError(error.message); else setTemplates((data ?? []) as ContractTemplate[]);
  }
  useEffect(() => { void reload(); /* eslint-disable-next-line */ }, [organizationId]);

  function startNew() { setEditing('new'); setName(''); setBody(''); setError(null); }
  function startEdit(t: ContractTemplate) { setEditing(t); setName(t.name); setBody(t.body); setError(null); }

  async function save() {
    if (!name.trim()) { setError('Geef het sjabloon een naam.'); return; }
    setBusy(true); setError(null);
    try {
      if (editing && editing !== 'new') {
        await supabase.from('contract_templates').update({ name: name.trim(), body }).eq('id', editing.id).eq('organization_id', organizationId).throwOnError();
      } else {
        await supabase.from('contract_templates').insert({ organization_id: organizationId, name: name.trim(), body }).throwOnError();
      }
      setEditing(null); await reload();
    } catch (e) { setError(errMsg(e, 'Opslaan mislukt')); }
    finally { setBusy(false); }
  }

  async function remove(t: ContractTemplate) {
    if (!confirm(`Sjabloon "${t.name}" verwijderen?`)) return;
    setBusy(true); setError(null);
    try {
      await supabase.from('contract_templates').delete().eq('id', t.id).eq('organization_id', organizationId).throwOnError();
      if (editing && editing !== 'new' && editing.id === t.id) setEditing(null);
      await reload();
    } catch (e) { setError(errMsg(e, 'Verwijderen mislukt')); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="Contractsjablonen" onClose={onClose} className="contract-modal contract-editor-modal"
      footer={<div className="bk-foot"><span className="bk-spacer" /><Button onClick={onClose}>Sluiten</Button></div>}>
      {error && <div className="error">{error}</div>}
      <p className="settings-help">Herbruikbare contractteksten met variabelen zoals {'{{klantnaam}}'} en {'{{bedrag}}'}. Kies er een bij "Nieuw contract" via "Start vanuit sjabloon".</p>

      {editing ? <>
        <label className="bk-field"><span>Naam</span>
          <Input value={name} onChange={e => setName(e.target.value)} disabled={!canWrite} placeholder="Bijv. Onderhoudsovereenkomst" />
        </label>
        <label className="bk-field"><span>Inhoud</span>
          <RichTextEditor value={body} onChange={setBody} disabled={!canWrite} placeholder="Schrijf het sjabloon… gebruik {{variabelen}} waar je wilt." />
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
          <Button onClick={() => setEditing(null)} disabled={busy}>Terug</Button>
          {canWrite && <Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Bezig…' : 'Sjabloon opslaan'}</Button>}
        </div>
      </> : <>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
          <Button variant="primary" disabled={!canWrite} onClick={startNew}><Plus size={14} /> Nieuw sjabloon</Button>
        </div>
        {templates.length === 0
          ? <p className="bk-muted">Nog geen sjablonen.</p>
          : <div style={{ display: 'grid', gap: 6 }}>
              {templates.map(t => <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid #2a2a31', borderRadius: 10, padding: '8px 12px' }}>
                <strong style={{ flex: 1 }}>{t.name}</strong>
                <Button onClick={() => startEdit(t)}>Bewerken</Button>
                {canWrite && <Button variant="danger" onClick={() => remove(t)} disabled={busy}><Trash2 size={14} /></Button>}
              </div>)}
            </div>}
      </>}
    </Modal>
  );
}

// ───────────────────────────── Opstellen / bewerken ─────────────────────────────

function ContractForm({ data, organizationId, canWrite, contract, onClose, onSaved }: {
  data: AppData; organizationId: string; canWrite: boolean; contract: Contract | null;
  onClose: () => void; onSaved: (id?: string) => void;
}) {
  const [clientId, setClientId] = useState(contract?.client_id ?? '');
  const [title, setTitle] = useState(contract?.title ?? '');
  const [bodyHtml, setBodyHtml] = useState(contract?.body ?? '');
  const [date, setDate] = useState(contract?.date ?? new Date().toISOString().slice(0, 10));
  const [validUntil, setValidUntil] = useState(contract?.valid_until ?? '');
  const [quoteId, setQuoteId] = useState(contract?.quote_id ?? '');
  const [amount, setAmount] = useState(contract?.amount_cents != null ? (contract.amount_cents / 100).toFixed(2) : '');
  const [currency, setCurrency] = useState(contract?.currency ?? 'EUR');
  const [templates, setTemplates] = useState<ContractTemplate[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const readOnly = !canWrite || (contract != null && contract.status !== 'draft');

  useEffect(() => {
    void supabase.from('contract_templates').select('*')
      .eq('organization_id', organizationId).eq('is_active', true).order('name')
      .then(({ data }) => setTemplates((data ?? []) as ContractTemplate[]));
  }, [organizationId]);

  const selectedClient = data.clients.find(c => c.id === clientId) ?? null;
  const clientQuotes = data.quotes.filter(q => q.client_id === clientId);
  const selectedQuote = data.quotes.find(q => q.id === quoteId) ?? null;
  const quoteTotal = selectedQuote ? total(selectedQuote.lines).total : null;
  const amountCents = amount.trim() ? Math.round(Number(amount.replace(',', '.')) * 100) : null;

  const previewTokens = buildContractTokens({
    clientName: selectedClient?.name,
    contactName: selectedClient?.contact_name,
    contractNumber: contract?.number ?? '',
    date,
    amountCents,
    currency,
    projectName: data.projects.find(p => p.contract_id === contract?.id)?.name ?? null,
    companyName: data.companySettings?.trade_name || data.companySettings?.company_name,
    companyAddress: formatCompanyAddress(data.companySettings),
  });

  function copyToken(token: string) {
    try { void navigator.clipboard?.writeText(`{{${token}}}`); } catch { /* clipboard kan geweigerd zijn */ }
    setCopied(token);
    window.setTimeout(() => setCopied(c => (c === token ? null : c)), 1200);
  }

  async function save() {
    if (!title.trim()) { setError('Geef het contract een titel.'); return; }
    if (!richTextToPlainText(bodyHtml).trim()) { setError('Vul de inhoud van het contract in.'); return; }
    if (amount.trim() && (amountCents === null || !Number.isFinite(amountCents))) { setError('Vul een geldig bedrag in (bijv. 1500 of 1500,00).'); return; }
    setBusy(true); setError(null);
    try {
      const values = {
        client_id: clientId || null,
        quote_id: quoteId || null,
        title: title.trim(),
        body: bodyHtml,
        date,
        valid_until: validUntil || null,
        amount_cents: amountCents,
        currency: currency || 'EUR',
      };
      if (contract) {
        await supabase.from('contracts').update(values).eq('id', contract.id).eq('organization_id', organizationId).throwOnError();
        onSaved(contract.id);
      } else {
        const { data: row, error } = await supabase.from('contracts')
          .insert({ organization_id: organizationId, ...values }).select('id').single();
        if (error) throw error;
        onSaved((row as { id: string }).id);
      }
    } catch (e) { setError(errMsg(e, 'Opslaan mislukt')); }
    finally { setBusy(false); }
  }

  async function previewPdf() {
    if (!contract) return;
    setBusy(true); setError(null);
    try {
      const { data: res, error } = await supabase.functions.invoke('contract-workflow', {
        body: { action: 'previewContractPdf', organizationId, contractId: contract.id },
      });
      if (error) throw new Error(await fnErr(error, 'PDF-preview mislukt'));
      if (!res?.ok) throw new Error(res?.error || 'PDF-preview mislukt');
      openBase64Pdf(res.pdf.base64);
    } catch (e) { setError(errMsg(e, 'PDF-preview mislukt')); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={contract ? `Contract ${contract.number}` : 'Nieuw contract'} onClose={onClose} className="contract-modal contract-editor-modal"
      footer={<div className="bk-foot">
        {contract && <Button onClick={previewPdf} disabled={busy}><FileText size={14} /> PDF-preview</Button>}
        <span className="bk-spacer" />
        <Button onClick={onClose}>Annuleren</Button>
        {!readOnly && <Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Bezig…' : 'Opslaan'}</Button>}
      </div>}>
      {error && <div className="error">{error}</div>}
      {readOnly && contract && <div className="settings-help">Dit contract is al {STATUS_META[contract.status].label.toLowerCase()} en kan niet meer worden bewerkt.</div>}

      <div className="bk-grid2">
        <label className="bk-field"><span>Klant</span>
          <Select value={clientId} onChange={e => { setClientId(e.target.value); setQuoteId(''); }} disabled={readOnly}>
            <option value="">— kies klant —</option>
            {data.clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </label>
        <label className="bk-field"><span>Titel / onderwerp</span>
          <Input value={title} onChange={e => setTitle(e.target.value)} disabled={readOnly} placeholder="Onderhoudsovereenkomst 2026" />
        </label>
        <label className="bk-field"><span>Datum</span>
          <Input type="date" value={date} onChange={e => setDate(e.target.value)} disabled={readOnly} />
        </label>
        <label className="bk-field"><span>Ondertekenen vóór (optioneel)</span>
          <Input type="date" value={validUntil} onChange={e => setValidUntil(e.target.value)} disabled={readOnly} />
        </label>
      </div>

      <div className="bk-grid2">
        <label className="bk-field"><span>Bedrag (voor {'{{bedrag}}'})</span>
          <Input value={amount} onChange={e => setAmount(e.target.value)} disabled={readOnly} placeholder="1500,00" />
        </label>
        <label className="bk-field"><span>Valuta</span>
          <Select value={currency} onChange={e => setCurrency(e.target.value)} disabled={readOnly}>
            <option value="EUR">EUR (€)</option>
            <option value="USD">USD ($)</option>
            <option value="GBP">GBP (£)</option>
          </Select>
        </label>
        <label className="bk-field"><span>Gekoppelde offerte (optioneel)</span>
          <Select value={quoteId} onChange={e => setQuoteId(e.target.value)} disabled={readOnly || !clientId}>
            <option value="">— geen —</option>
            {clientQuotes.map(q => <option key={q.id} value={q.id}>{q.number} · {euro(total(q.lines).total)}</option>)}
          </Select>
        </label>
        {selectedQuote && !readOnly && quoteTotal != null && <div className="bk-field" style={{ alignSelf: 'end' }}>
          <Button onClick={() => setAmount(quoteTotal.toFixed(2))}>Neem bedrag over uit offerte ({euro(quoteTotal)})</Button>
        </div>}
      </div>

      {!readOnly && <div className="bk-field">
        <span>Sjabloon &amp; variabelen</span>
        <Select value="" onChange={e => { const t = templates.find(x => x.id === e.target.value); if (t) setBodyHtml(t.body); }} disabled={templates.length === 0}>
          <option value="">{templates.length ? 'Start vanuit sjabloon…' : 'Nog geen sjablonen'}</option>
          {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          {CONTRACT_TOKENS.map(t => <button key={t.token} type="button" onClick={() => copyToken(t.token)}
            title={`Kopieer {{${t.token}}}`}
            style={{ border: '1px solid #2a2a31', background: copied === t.token ? '#1f3a2a' : 'transparent', color: copied === t.token ? '#7ee2a8' : '#d8d8df', borderRadius: 999, padding: '3px 10px', fontSize: 12, cursor: 'pointer' }}>
            {copied === t.token ? '✓ gekopieerd' : `{{${t.token}}}`}
          </button>)}
        </div>
        <small>Klik een variabele om ‘m te kopiëren en plak ‘m in de tekst. Bij versturen worden ze automatisch ingevuld.</small>
      </div>}

      <div className="bk-field">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Inhoud van het contract</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <MiniTab active={!showPreview} onClick={() => setShowPreview(false)}>Bewerken</MiniTab>
            <MiniTab active={showPreview} onClick={() => setShowPreview(true)}>Voorbeeld</MiniTab>
          </div>
        </div>
        {showPreview
          ? <div className="contract-preview" style={{ border: '1px solid #2a2a31', borderRadius: 12, padding: 16, background: '#0e0e11', minHeight: 200 }}>
              <RichTextViewer content={fillContractTokens(bodyHtml, previewTokens)} emptyText="Nog geen inhoud." />
            </div>
          : <RichTextEditor value={bodyHtml} onChange={setBodyHtml} disabled={readOnly} placeholder="Schrijf de contracttekst… gebruik de werkbalk voor koppen, lijsten en opmaak." />}
        <small>De klant ziet deze inhoud op de ondertekenpagina en in het PDF. Afbeeldingen en tabellen volgen in een latere fase.</small>
      </div>
    </Modal>
  );
}

function MiniTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} style={{
    padding: '4px 12px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
    border: `1px solid ${active ? '#ffd966' : '#2a2a31'}`, background: active ? '#ffd966' : 'transparent', color: active ? '#111' : '#d8d8df',
  }}>{children}</button>;
}

// ───────────────────────────── Detail / acties ─────────────────────────────

function ContractDetail({ data, organizationId, canWrite, contract, onClose, onEdit, onChanged, onDeleted }: {
  data: AppData; organizationId: string; canWrite: boolean; contract: Contract;
  onClose: () => void; onEdit: () => void; onChanged: () => void; onDeleted: () => void;
}) {
  const [signer, setSigner] = useState<ContractSigner | null>(null);
  const [events, setEvents] = useState<ContractEvent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [showSend, setShowSend] = useState(false);

  const client = data.clients.find(c => c.id === contract.client_id) ?? null;
  const linkedProject = data.projects.find(p => p.contract_id === contract.id) ?? null;
  const clientProjects = data.projects.filter(p => p.client_id === contract.client_id && !p.archived);

  const [recipientEmail, setRecipientEmail] = useState(client?.email ?? '');
  const [recipientName, setRecipientName] = useState(client?.contact_name || client?.name || '');
  const [personalMessage, setPersonalMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [{ data: signers }, { data: evts }] = await Promise.all([
        supabase.from('contract_signers').select('*').eq('organization_id', organizationId).eq('contract_id', contract.id).eq('role', 'client').order('signing_order').limit(1),
        supabase.from('contract_events').select('*').eq('organization_id', organizationId).eq('contract_id', contract.id).order('created_at', { ascending: true }),
      ]);
      if (cancelled) return;
      setSigner(((signers ?? [])[0] as ContractSigner) ?? null);
      setEvents((evts ?? []) as ContractEvent[]);
    })();
    return () => { cancelled = true; };
  }, [organizationId, contract.id, contract.status]);

  const canSend = canWrite && ['draft', 'internally_approved', 'expired'].includes(contract.status);
  const canResend = canWrite && contract.status === 'sent';
  const canVoid = canWrite && !['signed', 'voided'].includes(contract.status);

  async function send() {
    if (!isEmail(recipientEmail)) { setError('Vul een geldig e-mailadres in.'); return; }
    setBusy('send'); setError(null); setInfo(null);
    try {
      const { data: res, error } = await supabase.functions.invoke('contract-workflow', {
        body: { action: 'sendContractForSignature', organizationId, contractId: contract.id, recipientEmail, recipientName, personalMessage },
      });
      if (error) throw new Error(await fnErr(error, 'Versturen mislukt'));
      if (!res?.ok) throw new Error(res?.error || 'Versturen mislukt');
      setInfo('Contract verstuurd ter ondertekening.');
      setShowSend(false);
      onChanged();
    } catch (e) { setError(errMsg(e, 'Versturen mislukt')); }
    finally { setBusy(null); }
  }

  async function voidContract() {
    if (!confirm('Weet je zeker dat je dit contract wilt intrekken? De ondertekenlink wordt ongeldig.')) return;
    const reason = prompt('Reden van intrekken (optioneel):') ?? '';
    setBusy('void'); setError(null);
    try {
      const { error } = await supabase.rpc('void_contract', { p_contract_id: contract.id, p_organization_id: organizationId, p_reason: reason || null });
      if (error) throw error;
      onChanged();
    } catch (e) { setError(errMsg(e, 'Intrekken mislukt')); }
    finally { setBusy(null); }
  }

  async function download() {
    setBusy('download'); setError(null);
    try {
      const { data: res, error } = await supabase.functions.invoke('contract-workflow', {
        body: { action: 'downloadContractPdf', organizationId, contractId: contract.id },
      });
      if (error) throw new Error(await fnErr(error, 'Downloaden mislukt'));
      if (!res?.ok) throw new Error(res?.error || 'Downloaden mislukt');
      triggerDownload(res.pdf.base64, res.pdf.fileName || `contract-${contract.number}.pdf`);
    } catch (e) { setError(errMsg(e, 'Downloaden mislukt')); }
    finally { setBusy(null); }
  }

  async function removeDraft() {
    if (contract.status !== 'draft') return;
    if (!confirm('Conceptcontract verwijderen?')) return;
    setBusy('delete'); setError(null);
    try {
      await supabase.from('contracts').delete().eq('id', contract.id).eq('organization_id', organizationId).throwOnError();
      onDeleted();
    } catch (e) { setError(errMsg(e, 'Verwijderen mislukt')); setBusy(null); }
  }

  return (
    <Modal title={`Contract ${contract.number}`} onClose={onClose} className="contract-modal contract-detail"
      footer={<div className="bk-foot">
        {contract.status === 'draft' && canWrite && <Button variant="danger" onClick={removeDraft} disabled={!!busy}><Trash2 size={14} /> Verwijderen</Button>}
        <span className="bk-spacer" />
        {contract.status === 'draft' && canWrite && <Button onClick={onEdit} disabled={!!busy}>Bewerken</Button>}
        <Button onClick={onClose}>Sluiten</Button>
      </div>}>
      {error && <div className="error">{error}</div>}
      {info && <div className="success">{info}</div>}

      <div className="contract-detail-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <div>
          <h3 style={{ margin: '0 0 4px' }}>{contract.title || 'Zonder titel'}</h3>
          <p className="bk-muted" style={{ margin: 0 }}>{client?.name ?? '—'} · {dateNL(contract.date)}{contract.valid_until ? ` · ondertekenen vóór ${dateNL(contract.valid_until)}` : ''}</p>
        </div>
        <ContractStatusBadge status={contract.status} />
      </div>

      {/* Acties */}
      <div className="contract-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        {canSend && <Button variant="primary" onClick={() => setShowSend(v => !v)} disabled={!!busy}><Send size={14} /> Verstuur ter ondertekening</Button>}
        {canResend && <Button onClick={() => setShowSend(v => !v)} disabled={!!busy}><Send size={14} /> Opnieuw versturen</Button>}
        {contract.status === 'signed' && <Button variant="primary" onClick={download} disabled={!!busy}><Download size={14} /> {busy === 'download' ? 'Bezig…' : 'Download getekend PDF'}</Button>}
        {canVoid && <Button variant="danger" onClick={voidContract} disabled={!!busy}><X size={14} /> Intrekken</Button>}
      </div>

      {showSend && (canSend || canResend) && <div className="contract-send-form" style={{ border: '1px solid #2a2a31', borderRadius: 12, padding: 14, marginBottom: 16 }}>
        <div className="bk-grid2">
          <label className="bk-field"><span>E-mail ontvanger</span><Input value={recipientEmail} onChange={e => setRecipientEmail(e.target.value)} placeholder="klant@bedrijf.nl" /></label>
          <label className="bk-field"><span>Naam ontvanger</span><Input value={recipientName} onChange={e => setRecipientName(e.target.value)} /></label>
        </div>
        <label className="bk-field"><span>Persoonlijk berichtje (optioneel)</span>
          <Textarea value={personalMessage} onChange={e => setPersonalMessage(e.target.value)} rows={3} placeholder="Hi Jan, fijn dat we gaan samenwerken…" />
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={() => setShowSend(false)} disabled={!!busy}>Annuleren</Button>
          <Button variant="primary" onClick={send} disabled={busy === 'send'}>{busy === 'send' ? 'Versturen…' : 'Verstuur nu'}</Button>
        </div>
      </div>}

      {/* Ondertekenaar / bewijs */}
      <Section icon={<FileSignature size={15} />} title="Ondertekening">
        {contract.status === 'signed'
          ? <p>✅ Ondertekend door <strong>{signer?.name || '—'}</strong>{signer?.email ? ` (${signer.email})` : ''} op {contract.signed_at ? new Date(contract.signed_at).toLocaleString('nl-NL', { dateStyle: 'long', timeStyle: 'short' }) : '—'}.{signer?.signed_ip ? ` Vanaf IP ${signer.signed_ip}.` : ''}</p>
          : contract.status === 'declined'
            ? <p>De klant heeft het contract geweigerd{signer?.decline_reason ? `: "${signer.decline_reason}"` : '.'}</p>
            : contract.status === 'sent'
              ? <p>Wacht op ondertekening door {signer?.name || client?.name || 'de klant'}{signer?.email ? ` (${signer.email})` : ''}. {contract.public_token_expires_at ? `Link geldig tot ${dateNL(contract.public_token_expires_at)}.` : ''}</p>
              : <p className="bk-muted">Nog niet verstuurd ter ondertekening.</p>}
      </Section>

      {/* Projectkoppeling */}
      <ProjectLinkSection
        organizationId={organizationId} canWrite={canWrite} contract={contract}
        linkedProject={linkedProject} clientProjects={clientProjects}
        onChanged={onChanged} setError={setError}
      />

      {/* Interne notities (alleen intern, nooit klantgericht) */}
      <ContractNotesSection contractId={contract.id} organizationId={organizationId} canWrite={canWrite} />

      {/* Onveranderlijke verstuurde versies */}
      <ContractVersionsSection contractId={contract.id} organizationId={organizationId} />

      {/* Tijdlijn */}
      {events.length > 0 && <Section title="Tijdlijn">
        <div className="quote-timeline">
          {events.map(ev => <div className="quote-timeline-item" key={ev.id}>
            <span>{new Date(ev.created_at).toLocaleString('nl-NL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
            <strong>{ev.title}</strong>
            {ev.description && <p>{ev.description}</p>}
          </div>)}
        </div>
      </Section>}
    </Modal>
  );
}

function ProjectLinkSection({ organizationId, canWrite, contract, linkedProject, clientProjects, onChanged, setError }: {
  organizationId: string; canWrite: boolean; contract: Contract;
  linkedProject: Project | null; clientProjects: Project[];
  onChanged: () => void; setError: (m: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'none' | 'new' | 'existing'>('none');
  const [newName, setNewName] = useState(contract.title || '');
  const [pickId, setPickId] = useState('');

  const nudge = contract.status === 'signed' && !linkedProject;

  async function createProject() {
    if (!newName.trim()) { setError('Geef het project een naam.'); return; }
    setBusy(true); setError(null);
    try {
      await insertRow<Project>('projects', organizationId, {
        client_id: contract.client_id, name: newName.trim(), contract_id: contract.id,
        start_date: contract.date, end_date: contract.valid_until,
      });
      setMode('none'); onChanged();
    } catch (e) { setError(errMsg(e, 'Project aanmaken mislukt')); }
    finally { setBusy(false); }
  }
  async function linkExisting() {
    if (!pickId) return;
    setBusy(true); setError(null);
    try {
      await updateRow<Project>('projects', pickId, { contract_id: contract.id }, organizationId);
      setMode('none'); onChanged();
    } catch (e) { setError(errMsg(e, 'Koppelen mislukt')); }
    finally { setBusy(false); }
  }
  async function unlink() {
    if (!linkedProject) return;
    setBusy(true); setError(null);
    try {
      await updateRow<Project>('projects', linkedProject.id, { contract_id: null }, organizationId);
      onChanged();
    } catch (e) { setError(errMsg(e, 'Ontkoppelen mislukt')); }
    finally { setBusy(false); }
  }

  return (
    <Section icon={<Link2 size={15} />} title="Project">
      {linkedProject
        ? <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <span>Gekoppeld aan project <strong>{linkedProject.name}</strong>.</span>
            {canWrite && <Button onClick={unlink} disabled={busy}>Ontkoppelen</Button>}
          </div>
        : <>
            {nudge && <p style={{ color: '#ffd966', marginTop: 0 }}>📌 Contract getekend — wil je nu een project starten?</p>}
            {!nudge && <p className="bk-muted" style={{ marginTop: 0 }}>Nog geen project gekoppeld. Je kunt dit nu of later doen.</p>}
            {canWrite && contract.client_id && <>
              {mode === 'none' && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button onClick={() => setMode('new')} disabled={busy}><Plus size={14} /> Nieuw project aanmaken</Button>
                {clientProjects.length > 0 && <Button onClick={() => setMode('existing')} disabled={busy}><Link2 size={14} /> Bestaand project koppelen</Button>}
              </div>}
              {mode === 'new' && <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <label className="bk-field" style={{ flex: 1, minWidth: 200 }}><span>Projectnaam</span><Input value={newName} onChange={e => setNewName(e.target.value)} /></label>
                <Button variant="primary" onClick={createProject} disabled={busy}>Aanmaken</Button>
                <Button onClick={() => setMode('none')} disabled={busy}>Annuleren</Button>
              </div>}
              {mode === 'existing' && <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <label className="bk-field" style={{ flex: 1, minWidth: 200 }}><span>Kies project</span>
                  <Select value={pickId} onChange={e => setPickId(e.target.value)}>
                    <option value="">— kies —</option>
                    {clientProjects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </Select>
                </label>
                <Button variant="primary" onClick={linkExisting} disabled={busy || !pickId}>Koppelen</Button>
                <Button onClick={() => setMode('none')} disabled={busy}>Annuleren</Button>
              </div>}
            </>}
            {!contract.client_id && <p className="bk-muted">Koppel eerst een klant aan dit contract.</p>}
          </>}
    </Section>
  );
}

const noteLinkBtn: React.CSSProperties = { background: 'none', border: 'none', color: '#9b9ba7', cursor: 'pointer', textDecoration: 'underline', fontSize: 12, padding: 0 };

/** Interne notities bij een contract — alleen voor het team, nooit klantgericht. */
function ContractNotesSection({ contractId, organizationId, canWrite }: { contractId: string; organizationId: string; canWrite: boolean }) {
  const [notes, setNotes] = useState<ContractInternalNote[]>([]);
  const [me, setMe] = useState<{ id: string; email: string } | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  async function reload() {
    const { data, error } = await supabase.from('contract_internal_notes').select('*')
      .eq('organization_id', organizationId).eq('contract_id', contractId)
      .order('created_at', { ascending: false });
    if (error) setError(error.message); else setNotes((data ?? []) as ContractInternalNote[]);
  }
  useEffect(() => {
    let cancelled = false;
    void reload();
    void supabase.auth.getUser().then(({ data }) => { if (!cancelled && data.user) setMe({ id: data.user.id, email: data.user.email ?? '' }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, contractId]);

  async function add() {
    if (!draft.trim()) return;
    setBusy(true); setError(null);
    try {
      await supabase.from('contract_internal_notes')
        .insert({ organization_id: organizationId, contract_id: contractId, body: draft.trim(), author_name: me?.email ?? null })
        .throwOnError();
      setDraft(''); await reload();
    } catch (e) { setError(errMsg(e, 'Notitie opslaan mislukt')); }
    finally { setBusy(false); }
  }
  async function saveEdit(id: string) {
    if (!editText.trim()) return;
    setBusy(true); setError(null);
    try {
      await supabase.from('contract_internal_notes').update({ body: editText.trim() })
        .eq('id', id).eq('organization_id', organizationId).throwOnError();
      setEditingId(null); await reload();
    } catch (e) { setError(errMsg(e, 'Wijzigen mislukt')); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    if (!confirm('Interne notitie verwijderen?')) return;
    setBusy(true); setError(null);
    try {
      await supabase.from('contract_internal_notes').delete()
        .eq('id', id).eq('organization_id', organizationId).throwOnError();
      await reload();
    } catch (e) { setError(errMsg(e, 'Verwijderen mislukt')); }
    finally { setBusy(false); }
  }

  return <Section title="Interne notities">
    <p className="bk-muted" style={{ marginTop: 0, fontSize: 13 }}>🔒 Alleen zichtbaar voor je team — nooit voor de klant, niet in het PDF of de e-mails.</p>
    {error && <div className="error">{error}</div>}
    {canWrite && <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'flex-start' }}>
      <Textarea value={draft} onChange={e => setDraft(e.target.value)} rows={2} placeholder="Interne notitie toevoegen…" />
      <Button variant="primary" onClick={add} disabled={busy || !draft.trim()}>Plaats</Button>
    </div>}
    {notes.length === 0
      ? <p className="bk-muted" style={{ fontSize: 13 }}>Nog geen interne notities.</p>
      : <div style={{ display: 'grid', gap: 8 }}>
          {notes.map(n => <div key={n.id} style={{ border: '1px solid #2a2a31', borderRadius: 10, padding: '8px 10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
              <strong style={{ fontSize: 13 }}>{n.author_name || 'Onbekend'}</strong>
              <span className="bk-muted" style={{ fontSize: 12 }}>{new Date(n.created_at).toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' })}</span>
            </div>
            {editingId === n.id
              ? <div>
                  <Textarea value={editText} onChange={e => setEditText(e.target.value)} rows={2} />
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    <Button variant="primary" onClick={() => saveEdit(n.id)} disabled={busy || !editText.trim()}>Opslaan</Button>
                    <Button onClick={() => setEditingId(null)} disabled={busy}>Annuleren</Button>
                  </div>
                </div>
              : <>
                  <div style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{n.body}</div>
                  {canWrite && me?.id === n.created_by && <div style={{ display: 'flex', gap: 12, marginTop: 6 }}>
                    <button type="button" onClick={() => { setEditingId(n.id); setEditText(n.body); }} style={noteLinkBtn}>Bewerken</button>
                    <button type="button" onClick={() => remove(n.id)} style={noteLinkBtn}>Verwijderen</button>
                  </div>}
                </>}
          </div>)}
        </div>}
  </Section>;
}

function ContractVersionsSection({ contractId, organizationId }: { contractId: string; organizationId: string }) {
  const [versions, setVersions] = useState<ContractVersion[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void supabase.from('contract_versions').select('*')
      .eq('organization_id', organizationId).eq('contract_id', contractId)
      .order('version_number', { ascending: false })
      .then(({ data }) => { if (!cancelled) setVersions((data ?? []) as ContractVersion[]); });
    return () => { cancelled = true; };
  }, [organizationId, contractId]);

  if (versions.length === 0) return null;
  const reasonLabel = (r: string) => r === 'sent_to_client' ? 'Verstuurd' : r === 'signed' ? 'Ondertekend' : r === 'superseded' ? 'Vervangen' : 'Handmatig';

  return <Section title="Versies">
    <p className="bk-muted" style={{ marginTop: 0, fontSize: 13 }}>Onveranderlijke momentopnames van wat er naar de klant is verstuurd.</p>
    <div style={{ display: 'grid', gap: 6 }}>
      {versions.map(v => <div key={v.id} style={{ border: '1px solid #2a2a31', borderRadius: 10, padding: '8px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong style={{ fontSize: 13 }}>v{v.version_number}</strong>
          <span className="bk-muted" style={{ fontSize: 12 }}>{reasonLabel(v.snapshot_reason)} · {new Date(v.created_at).toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' })}</span>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={() => setOpenId(openId === v.id ? null : v.id)} style={noteLinkBtn}>{openId === v.id ? 'Verberg' : 'Bekijk inhoud'}</button>
        </div>
        {openId === v.id && <div style={{ marginTop: 8, borderTop: '1px solid #2a2a31', paddingTop: 8 }}>
          {v.title && <div style={{ fontWeight: 600, marginBottom: 6 }}>{v.title}</div>}
          <RichTextViewer content={v.body} emptyText="Geen inhoud." />
        </div>}
      </div>)}
    </div>
  </Section>;
}

function Section({ icon, title, children }: { icon?: React.ReactNode; title: string; children: React.ReactNode }) {
  return <div style={{ borderTop: '1px solid #2a2a31', paddingTop: 12, marginTop: 14 }}>
    <h4 style={{ margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 14 }}>{icon}{title}</h4>
    {children}
  </div>;
}

// ───────────────────────────── helpers ─────────────────────────────

function formatCompanyAddress(cs: AppData['companySettings']): string {
  if (!cs) return '';
  return [cs.address_line1, cs.address_line2, [cs.postal_code, cs.city].filter(Boolean).join(' '), cs.country]
    .map(v => (v ?? '').trim()).filter(Boolean).join(', ');
}
function openBase64Pdf(base64: string): void {
  try {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    window.open(url, '_blank', 'noopener,noreferrer');
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch { /* preview kon niet worden geopend */ }
}
function triggerDownload(base64: string, fileName: string): void {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fileName; document.body.appendChild(a); a.click();
  a.remove(); URL.revokeObjectURL(url);
}
function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : (typeof e === 'object' && e && 'message' in e ? String((e as { message: unknown }).message) : fallback);
}
async function fnErr(error: unknown, fallback: string): Promise<string> {
  const context = (error as { context?: unknown })?.context;
  if (context instanceof Response) {
    try {
      const payload = await context.clone().json().catch(() => null) as { error?: string } | null;
      if (payload?.error) return payload.error;
    } catch { /* val terug */ }
  }
  return error instanceof Error && error.message ? error.message : fallback;
}
