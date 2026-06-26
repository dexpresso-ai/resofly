import { useEffect, useState } from 'react';
import { BookOpen, CreditCard, Mail, Receipt, ShieldCheck, Sparkles, Users } from 'lucide-react';
import type { AppData, AuditLog, BillingPlan, CompanySettings, CompanySettingsInput, EmailTemplate, EmailTemplateInput, EmailTemplateKey, InvoiceMollieSettingsStatus, InvoiceReminderSettings, InvoiceTemplateKind, OrganizationBillingOverview, OrganizationContext, OrganizationMember, OrganizationRole, Project, SendingDomain, SendingDomainDnsRecord, SendingDomainStatus } from '../types';
import { Button, Input, Select, Textarea } from '../components/Ui';
import { changeOrganizationPlan, createExtraSeatCheckout, getSelfServiceBillingPlans, loadBillingOverview, loadBillingPlans, markMockPaymentPaid, startSubscriptionCheckout } from '../services/billingService';
import { sendResendTestEmail, addSendingDomain, verifySendingDomain, updateSendingDomain, removeSendingDomain } from '../services/mailService';
import { deleteInvoiceMollieKey, loadInvoiceMollieStatus, saveInvoiceMollieKey, loadInvoiceReminderSettings, saveInvoiceReminderSettings, loadEmailTemplates, upsertEmailTemplate, resetEmailTemplate, loadSendingDomains } from '../lib/repository';
import { loadGerrieUsage, type GerrieUsageRow } from '../lib/gerrie-api';
import { EMAIL_TEMPLATES, EMAIL_FIELD_LABELS, EMAIL_FIELD_HINTS, fillPlaceholders, type EmailField } from '../lib/emailTemplateContent';

const TEMPLATE_MAX_BYTES = 2 * 1024 * 1024;

const TEMPLATE_FIELD_LABELS = [
  'Bedrijfsnaam, adres, e-mail, telefoon, website',
  'KvK, BTW-nummer en IBAN',
  'Klantnaam, contactpersoon, e-mail en telefoon',
  'Factuur-/offertenummer, datum en vervaldatum/geldig tot',
  'Regels met omschrijving, aantal, prijs, BTW en totaal',
  'Subtotaal, BTW, totaalbedrag, notities en betaaltekst',
];

const emptySettings: CompanySettingsInput = {
  company_name: '',
  trade_name: '',
  address_line1: '',
  address_line2: '',
  postal_code: '',
  city: '',
  country: 'Nederland',
  email: '',
  phone: '',
  website: '',
  kvk_number: '',
  vat_number: '',
  iban: '',
  invoice_payment_terms: 'Graag betalen binnen de afgesproken betalingstermijn onder vermelding van het factuurnummer.',
  invoice_footer: 'Bedankt voor het vertrouwen.',
  invoice_template_kind: 'none',
  invoice_template_file_name: null,
  invoice_template_mime_type: null,
  invoice_template_file_size: 0,
  invoice_template_data_url: null,
  invoice_template_text_color: '#1a1a1a',
  invoice_accent_color: '#FFD966',
  invoice_font_size: 10,
  invoice_template_updated_at: null,
  bookkeeping_start_date: null,
  kor_enabled: false,
  vat_return_period: 'quarterly',
};

const ROLE_LABELS: Record<OrganizationRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

type SettingsTab = 'organisatie' | 'facturatie' | 'boekhouding' | 'betalen' | 'abonnement' | 'ai' | 'email';

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string; Icon: typeof Users; description: string }> = [
  { id: 'organisatie', label: 'Organisatie & team', Icon: Users, description: 'Beheer je werkruimte, teamleden en rollen, en bekijk de recente activiteit.' },
  { id: 'facturatie', label: 'Facturatie', Icon: Receipt, description: 'Bedrijfsgegevens, factuurtemplate en betaalteksten die op je facturen en offertes verschijnen.' },
  { id: 'boekhouding', label: 'Boekhouding', Icon: BookOpen, description: 'De boekhoud-startdatum (knipdatum) en de KOR-regeling voor je grootboek en BTW-aangifte.' },
  { id: 'betalen', label: 'Online betalen', Icon: CreditCard, description: 'Koppel Mollie zodat klanten je facturen direct online kunnen betalen.' },
  { id: 'abonnement', label: 'Abonnement', Icon: ShieldCheck, description: 'Je ResoFly-abonnement, betaalstatus en gebruikerslicenties.' },
  { id: 'ai', label: 'AI-gebruik', Icon: Sparkles, description: 'Het verbruik en de kosten van Gerrie (AI-assistent) per gebruiker, deze maand.' },
  { id: 'email', label: 'E-mail', Icon: Mail, description: 'Pas de teksten van je offerte-, factuur- en herinneringsmails aan, en verstuur een testmail om je configuratie te controleren.' },
];

export function CalendarPage() {
  return <div className="empty"><div className="e-big">Kalender</div><p>V1 toont deadlines in projecten. Koppeling met Google/Microsoft Calendar kan hierop worden gebouwd.</p></div>;
}

export function Archive({ data, onOpen, onRestore }: { data: AppData; onOpen: (id: string) => void; onRestore: (project: Project) => void }) {
  const archived = data.projects.filter(p=>p.archived);
  if (!archived.length) return <div className="empty"><div className="e-big">Geen gearchiveerde projecten</div><p>Archiveer een project via “Project bewerken”.</p></div>;
  return <div className="archive-list">{archived.map(p=><div className="archive-item" key={p.id}><span className="archive-dot" style={{background:p.color}}/><div className="archive-info"><div className="archive-name">{p.name}</div><small>{p.description ?? 'Geen omschrijving'}</small></div><div className="archive-actions"><Button onClick={() => onOpen(p.id)}>Open</Button><Button onClick={() => onRestore(p)}>Herstellen</Button></div></div>)}</div>;
}

function clampReminderDays(value: string): number {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(parsed, 365);
}

function InvoiceReminderSettingsCard({ organizationId, canAdmin }: { organizationId: string; canAdmin: boolean }) {
  const [settings, setSettings] = useState<InvoiceReminderSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    loadInvoiceReminderSettings(organizationId)
      .then(loaded => { if (!cancelled) setSettings(loaded); })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Herinneringsinstellingen laden mislukt.'); });
    return () => { cancelled = true; };
  }, [organizationId]);

  function update<K extends keyof InvoiceReminderSettings>(key: K, value: InvoiceReminderSettings[K]) {
    setSettings(prev => prev ? { ...prev, [key]: value } : prev);
    setMessage(null);
  }

  async function save() {
    if (!settings) return;
    // Spiegelt de DB-constraints: niet-negatief en oplopend.
    if (settings.level1_offset_days < 0 || settings.level2_offset_days < 0 || settings.level3_offset_days < 0) {
      setError('Het aantal dagen mag niet negatief zijn.'); return;
    }
    if (!(settings.level1_offset_days <= settings.level2_offset_days && settings.level2_offset_days <= settings.level3_offset_days)) {
      setError('De dagen moeten oplopen: niveau 1 ≤ niveau 2 ≤ niveau 3.'); return;
    }
    setBusy(true); setError(null); setMessage(null);
    try {
      const saved = await saveInvoiceReminderSettings(organizationId, {
        auto_reminders_enabled: settings.auto_reminders_enabled,
        level1_offset_days: settings.level1_offset_days,
        level2_offset_days: settings.level2_offset_days,
        level3_offset_days: settings.level3_offset_days,
        include_payment_link: settings.include_payment_link,
      });
      setSettings(saved);
      setMessage('Herinneringsinstellingen opgeslagen.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Herinneringsinstellingen opslaan mislukt.');
    } finally {
      setBusy(false);
    }
  }

  return <section className="settings-card organization-card billing-card">
    <div className="settings-card-head">
      <div>
        <h3>Automatische betalingsherinneringen</h3>
        <p className="settings-help">Stuur automatisch getrapte herinneringen voor te late facturen: een vriendelijke herinnering, een tweede herinnering en een aanmaning. Het aantal dagen telt vanaf de vervaldatum. Per factuur kun je herinneringen pauzeren in het factuurdetail.</p>
      </div>
    </div>
    {message && <div className="success">{message}</div>}
    {error && <div className="error">{error}</div>}
    {!canAdmin ? <p className="settings-help">Alleen owners en admins kunnen de herinneringsinstellingen aanpassen.</p>
      : !settings ? <p className="settings-help">Instellingen laden…</p>
      : <>
        <div className="billing-control-row">
          <div>
            <strong>Automatische herinneringen</strong>
            <p className="settings-help">Staat dit uit, dan kun je nog steeds handmatig een herinnering sturen vanuit een factuur.</p>
          </div>
          <label className="settings-toggle"><input type="checkbox" checked={settings.auto_reminders_enabled} onChange={e => update('auto_reminders_enabled', e.target.checked)} /> {settings.auto_reminders_enabled ? 'Aan' : 'Uit'}</label>
        </div>
        <div className="billing-control-row">
          <div>
            <strong>Niveau 1 · Vriendelijke herinnering</strong>
            <p className="settings-help">Aantal dagen ná de vervaldatum.</p>
            <Input type="number" min={0} value={String(settings.level1_offset_days)} onChange={e => update('level1_offset_days', clampReminderDays(e.target.value))} />
          </div>
        </div>
        <div className="billing-control-row">
          <div>
            <strong>Niveau 2 · Tweede herinnering</strong>
            <p className="settings-help">Aantal dagen ná de vervaldatum (≥ niveau 1).</p>
            <Input type="number" min={0} value={String(settings.level2_offset_days)} onChange={e => update('level2_offset_days', clampReminderDays(e.target.value))} />
          </div>
        </div>
        <div className="billing-control-row">
          <div>
            <strong>Niveau 3 · Aanmaning</strong>
            <p className="settings-help">Aantal dagen ná de vervaldatum (≥ niveau 2).</p>
            <Input type="number" min={0} value={String(settings.level3_offset_days)} onChange={e => update('level3_offset_days', clampReminderDays(e.target.value))} />
          </div>
        </div>
        <div className="billing-control-row">
          <div>
            <strong>Betaallink meesturen</strong>
            <p className="settings-help">Voegt een Mollie-betaallink toe als deze organisatie Mollie gekoppeld heeft.</p>
          </div>
          <label className="settings-toggle"><input type="checkbox" checked={settings.include_payment_link} onChange={e => update('include_payment_link', e.target.checked)} /> {settings.include_payment_link ? 'Aan' : 'Uit'}</label>
        </div>
        <Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Opslaan…' : 'Herinneringen opslaan'}</Button>
      </>}
  </section>;
}

const SENDING_DOMAIN_STATUS_LABELS: Record<SendingDomainStatus, string> = {
  pending: 'Verificatie in afwachting',
  verified: 'Geverifieerd',
  failed: 'Verificatie mislukt',
  temporary_failure: 'Tijdelijke fout — probeer later opnieuw',
};

function SendingDomainCard({ organizationId, canAdmin }: { organizationId: string; canAdmin: boolean }) {
  const [domains, setDomains] = useState<SendingDomain[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [newDomain, setNewDomain] = useState('');
  const [newFromName, setNewFromName] = useState('');
  const [newFromEmail, setNewFromEmail] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setError(null);
    loadSendingDomains(organizationId)
      .then(rows => { if (!cancelled) { setDomains(rows); setLoaded(true); } })
      .catch(err => { if (!cancelled) { setError(err instanceof Error ? err.message : 'Verzenddomeinen laden mislukt.'); setLoaded(true); } });
    return () => { cancelled = true; };
  }, [organizationId]);

  async function reload() {
    setDomains(await loadSendingDomains(organizationId));
  }

  async function add() {
    if (!newDomain.trim()) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      await addSendingDomain(organizationId, {
        domain: newDomain.trim(),
        fromName: newFromName.trim() || undefined,
        fromEmail: newFromEmail.trim() || undefined,
      });
      setNewDomain(''); setNewFromName(''); setNewFromEmail('');
      await reload();
      setMessage('Domein toegevoegd. Plaats de DNS-records hieronder bij je domeinprovider en klik daarna op “Verifieer”.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Domein toevoegen mislukt.');
    } finally {
      setBusy(false);
    }
  }

  async function verify(domain: SendingDomain) {
    setBusy(true); setError(null); setMessage(null);
    try {
      const updated = await verifySendingDomain(organizationId, domain.id);
      await reload();
      setMessage(updated.status === 'verified'
        ? `${updated.domain} is geverifieerd — je kunt nu vanaf dit domein mailen.`
        : 'Nog niet geverifieerd. DNS-wijzigingen kunnen tot ~24 uur duren; probeer het daarna opnieuw.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verifiëren mislukt.');
    } finally {
      setBusy(false);
    }
  }

  async function makeDefault(domain: SendingDomain) {
    setBusy(true); setError(null); setMessage(null);
    try {
      await updateSendingDomain(organizationId, domain.id, { isDefault: true });
      await reload();
      setMessage(`${domain.domain} is nu het standaard verzenddomein.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Standaard instellen mislukt.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(domain: SendingDomain) {
    if (!window.confirm(`Domein ${domain.domain} ontkoppelen? E-mails vallen daarna terug op het standaard afzenderadres.`)) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      await removeSendingDomain(organizationId, domain.id);
      await reload();
      setMessage('Domein ontkoppeld.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ontkoppelen mislukt.');
    } finally {
      setBusy(false);
    }
  }

  return <section className="settings-card organization-card sending-domain-card">
    <div className="settings-card-head">
      <div>
        <h3>Eigen verzenddomein</h3>
        <p className="settings-help">Koppel je eigen domein zodat e-mails vanaf jouw adres (bijvoorbeeld <code>info@eigendomeinnaam.nl</code>) worden verstuurd in plaats van het standaardadres. Voeg het domein toe, plaats de getoonde DNS-records bij je domeinprovider en klik op “Verifieer”.</p>
      </div>
    </div>

    {message && <div className="success">{message}</div>}
    {error && <div className="error">{error}</div>}

    {!canAdmin ? <p className="settings-help">Alleen owners en admins kunnen verzenddomeinen beheren.</p>
      : !loaded ? <p className="settings-help">Verzenddomeinen laden…</p>
      : <>
        <div className="settings-grid compact">
          <label>Domein
            <Input value={newDomain} onChange={e => { setNewDomain(e.target.value); setError(null); setMessage(null); }} placeholder="eigendomeinnaam.nl" />
          </label>
          <label>Afzendernaam (optioneel)
            <Input value={newFromName} onChange={e => setNewFromName(e.target.value)} placeholder="Jouw bedrijf" />
          </label>
          <label>Afzenderadres (optioneel)
            <Input type="email" value={newFromEmail} onChange={e => setNewFromEmail(e.target.value)} placeholder="info@eigendomeinnaam.nl" />
          </label>
        </div>
        <Button variant="primary" onClick={add} disabled={busy || !newDomain.trim()}>{busy ? 'Bezig…' : '+ Domein toevoegen'}</Button>

        <div className="sending-domain-list">
          {domains.length === 0 && <p className="settings-help">Nog geen domein gekoppeld. Voeg er een toe om vanaf je eigen adres te mailen.</p>}
          {domains.map(domain => (
            <div className="sending-domain-row" key={domain.id}>
              <div className="sending-domain-head-row">
                <div className="sending-domain-title">
                  <strong>{domain.domain}</strong>
                  {domain.is_default && <span className="sending-domain-default">Standaard</span>}
                  <span className={`sending-domain-status ${domain.status}`}>{SENDING_DOMAIN_STATUS_LABELS[domain.status]}</span>
                </div>
                <div className="sending-domain-actions">
                  <Button onClick={() => verify(domain)} disabled={busy}>Verifieer</Button>
                  {domain.status === 'verified' && !domain.is_default && <Button onClick={() => makeDefault(domain)} disabled={busy}>Maak standaard</Button>}
                  <Button variant="danger" onClick={() => remove(domain)} disabled={busy}>Verwijderen</Button>
                </div>
              </div>
              {domain.from_email && <p className="settings-help">Afzender: {domain.from_name ? `${domain.from_name} <${domain.from_email}>` : domain.from_email}</p>}
              {domain.status !== 'verified' && domain.dns_records.length > 0 && <DnsRecordsTable records={domain.dns_records} />}
            </div>
          ))}
        </div>
      </>}
  </section>;
}

function DnsRecordsTable({ records }: { records: SendingDomainDnsRecord[] }) {
  return <div className="dns-records">
    <p className="settings-help">Voeg deze records toe bij je DNS-provider. Na het plaatsen kan verificatie tot ~24 uur duren.</p>
    <div className="dns-records-list">
      {records.map((rec, i) => (
        <div className="dns-record" key={`${rec.type}-${rec.name}-${i}`}>
          <div className="dns-record-field"><span className="dns-record-label">Type</span><code>{rec.type}</code></div>
          <div className="dns-record-field"><span className="dns-record-label">Naam</span><code>{rec.name}</code></div>
          <div className="dns-record-field grow"><span className="dns-record-label">Waarde</span><code className="dns-record-value">{rec.value}</code></div>
          {rec.priority != null && <div className="dns-record-field"><span className="dns-record-label">Prioriteit</span><code>{rec.priority}</code></div>}
        </div>
      ))}
    </div>
  </div>;
}

type EmailTemplateForm = { subject: string; intro: string; closing: string; cta_label: string };

function formFromTemplate(meta: typeof EMAIL_TEMPLATES[number], row: EmailTemplate | undefined): EmailTemplateForm {
  // Prefill met de opgeslagen tekst; een leeg veld valt terug op de standaardtekst,
  // zodat de gebruiker altijd de huidige effectieve tekst ziet en kan bijwerken.
  return {
    subject: row?.subject ?? meta.defaults.subject,
    intro: row?.intro ?? meta.defaults.intro,
    closing: row?.closing ?? meta.defaults.closing,
    cta_label: row?.cta_label ?? meta.defaults.cta_label,
  };
}

function EmailTemplatesCard({ organizationId, canAdmin }: { organizationId: string; canAdmin: boolean }) {
  const [rows, setRows] = useState<Record<string, EmailTemplate>>({});
  const [loaded, setLoaded] = useState(false);
  const [activeKey, setActiveKey] = useState<EmailTemplateKey>(EMAIL_TEMPLATES[0].key);
  const [form, setForm] = useState<EmailTemplateForm>(() => formFromTemplate(EMAIL_TEMPLATES[0], undefined));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const meta = EMAIL_TEMPLATES.find(t => t.key === activeKey) ?? EMAIL_TEMPLATES[0];
  const isCustomized = Boolean(rows[activeKey]);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setError(null);
    loadEmailTemplates(organizationId)
      .then(loadedRows => {
        if (cancelled) return;
        const map: Record<string, EmailTemplate> = {};
        for (const row of loadedRows) map[row.template_key] = row;
        setRows(map);
        setLoaded(true);
      })
      .catch(err => { if (!cancelled) { setError(err instanceof Error ? err.message : 'E-mailteksten laden mislukt.'); setLoaded(true); } });
    return () => { cancelled = true; };
  }, [organizationId]);

  // Herinitialiseer het formulier zodra de geselecteerde template of de geladen
  // rijen wijzigen.
  useEffect(() => {
    setForm(formFromTemplate(meta, rows[activeKey]));
    setMessage(null);
    setError(null);
  }, [activeKey, rows, meta]);

  const setField = (field: EmailField, value: string) => {
    setForm(prev => ({ ...prev, [field]: value }));
    setMessage(null);
  };

  async function save() {
    setBusy(true); setError(null); setMessage(null);
    try {
      const input: EmailTemplateInput = {
        enabled: true,
        subject: meta.fields.includes('subject') ? form.subject : null,
        intro: meta.fields.includes('intro') ? form.intro : null,
        closing: meta.fields.includes('closing') ? form.closing : null,
        cta_label: meta.fields.includes('cta_label') ? form.cta_label : null,
      };
      const saved = await upsertEmailTemplate(organizationId, activeKey, input);
      setRows(prev => ({ ...prev, [activeKey]: saved }));
      setMessage('E-mailtekst opgeslagen. Nieuwe e-mails gebruiken deze tekst direct.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'E-mailtekst opslaan mislukt.');
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true); setError(null); setMessage(null);
    try {
      await resetEmailTemplate(organizationId, activeKey);
      setRows(prev => { const next = { ...prev }; delete next[activeKey]; return next; });
      setForm(formFromTemplate(meta, undefined));
      setMessage('Teruggezet naar de standaardtekst.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Terugzetten mislukt.');
    } finally {
      setBusy(false);
    }
  }

  return <section className="settings-card organization-card email-templates-card">
    <div className="settings-card-head">
      <div>
        <h3>E-mailteksten aanpassen</h3>
        <p className="settings-help">Bepaal zelf het onderwerp, de aanhef, de afsluiting en de knoptekst van je uitgaande e-mails. De bedragen, datums, beveiligde link en PDF-bijlage worden automatisch ingevuld en blijven correct. Plaatshouders zoals <code>{'{{recipient_name}}'}</code> worden bij het versturen vervangen.</p>
      </div>
    </div>

    {message && <div className="success">{message}</div>}
    {error && <div className="error">{error}</div>}

    {!loaded ? <p className="settings-help">E-mailteksten laden…</p> : <>
      <div className="settings-grid compact">
        <label>E-mail
          <Select value={activeKey} onChange={e => setActiveKey(e.target.value as EmailTemplateKey)}>
            {EMAIL_TEMPLATES.map(t => <option key={t.key} value={t.key}>{t.label}{rows[t.key] ? ' • aangepast' : ''}</option>)}
          </Select>
        </label>
      </div>
      <p className="settings-help">{meta.description}</p>

      <div className="email-template-editor">
        {meta.fields.includes('subject') && <label className="email-template-field">
          <span>{EMAIL_FIELD_LABELS.subject}</span>
          <Input value={form.subject} onChange={e => setField('subject', e.target.value)} disabled={!canAdmin} placeholder={meta.defaults.subject} />
          <small>{EMAIL_FIELD_HINTS.subject}</small>
        </label>}

        {meta.fields.includes('intro') && <label className="email-template-field">
          <span>{EMAIL_FIELD_LABELS.intro}</span>
          <Textarea value={form.intro} onChange={e => setField('intro', e.target.value)} disabled={!canAdmin} rows={5} placeholder={meta.defaults.intro} />
          <small>{EMAIL_FIELD_HINTS.intro}</small>
        </label>}

        {meta.fields.includes('closing') && <label className="email-template-field">
          <span>{EMAIL_FIELD_LABELS.closing}</span>
          <Textarea value={form.closing} onChange={e => setField('closing', e.target.value)} disabled={!canAdmin} rows={3} placeholder={meta.defaults.closing || 'Optioneel — laat leeg om weg te laten'} />
          <small>{EMAIL_FIELD_HINTS.closing}</small>
        </label>}

        {meta.fields.includes('cta_label') && <label className="email-template-field">
          <span>{EMAIL_FIELD_LABELS.cta_label}</span>
          <Input value={form.cta_label} onChange={e => setField('cta_label', e.target.value)} disabled={!canAdmin} placeholder={meta.defaults.cta_label} />
          <small>{EMAIL_FIELD_HINTS.cta_label}</small>
        </label>}
      </div>

      <div className="email-template-placeholders">
        <strong>Beschikbare plaatshouders</strong>
        <div className="email-placeholder-chips">
          {meta.placeholders.map(p => <span key={p.token} className="email-placeholder-chip" title={p.example}><code>{`{{${p.token}}}`}</code> {p.label}</span>)}
        </div>
      </div>

      <div className="email-template-preview">
        <strong>Voorbeeld</strong>
        <div className="email-preview-box">
          <div className="email-preview-subject">{fillPlaceholders(form.subject || meta.defaults.subject) || '(geen onderwerp)'}</div>
          <div className="email-preview-body">
            {fillPlaceholders(form.intro || meta.defaults.intro).split('\n').map((line, i) => <p key={i}>{line || ' '}</p>)}
            <p className="email-preview-structural">— Hier vult ResoFly automatisch het overzicht in: bedrag, datums{meta.group === 'offerte' ? ' en geldigheid' : ''}.</p>
            {form.closing.trim() && fillPlaceholders(form.closing).split('\n').map((line, i) => <p key={`c${i}`}>{line || ' '}</p>)}
            {meta.fields.includes('cta_label') && <p><span className="email-preview-cta">{fillPlaceholders(form.cta_label || meta.defaults.cta_label)}</span></p>}
          </div>
        </div>
      </div>

      {canAdmin ? <div className="email-template-actions">
        <Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Opslaan…' : 'E-mailtekst opslaan'}</Button>
        <Button onClick={reset} disabled={busy || !isCustomized}>Herstel standaardtekst</Button>
      </div> : <p className="settings-help">Alleen owners en admins kunnen e-mailteksten aanpassen.</p>}
    </>}
  </section>;
}

function AiUsagePanel({ organizationId, members }: { organizationId: string; members: OrganizationMember[] }) {
  const [rows, setRows] = useState<GerrieUsageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null); setError(null);
    loadGerrieUsage(organizationId)
      .then(r => { if (!cancelled) setRows(r); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'AI-gebruik laden mislukt.'); });
    return () => { cancelled = true; };
  }, [organizationId]);

  const USD_TO_EUR = 0.92;
  const emailByUser = new Map(members.map(m => [m.user_id, m.email || m.user_id]));
  // De rijen komen al per gebruiker geaggregeerd binnen (over alle organisaties heen).
  const list = (rows ?? [])
    .map(r => ({ uid: r.user_id, label: emailByUser.get(r.user_id) ?? 'Onbekende gebruiker', messages: r.messages, tokens: r.tokens, costEur: r.cost_usd * USD_TO_EUR }))
    .sort((a, b) => b.costEur - a.costEur);
  const fmtEur = (n: number) => `€ ${n.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const totalEur = list.reduce((s, x) => s + x.costEur, 0);
  const totalMsg = list.reduce((s, x) => s + x.messages, 0);
  const totalTok = list.reduce((s, x) => s + x.tokens, 0);

  return (
    <section className="settings-card organization-card">
      <div className="settings-card-head">
        <div>
          <h3>AI-gebruik deze maand</h3>
          <p className="settings-help">Verbruik van Gerrie per gebruiker in de huidige kalendermaand, geteld over al hun organisaties heen (zelfde telling als het tegoed/de limiet). Bedragen zijn schattingen op basis van het Claude-tarief, omgerekend naar euro's.</p>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {rows === null && !error && <p className="settings-help">Laden…</p>}
      {rows !== null && list.length === 0 && <p className="settings-help">Nog geen AI-gebruik deze maand.</p>}
      {list.length > 0 && (
        <table className="ai-usage-table">
          <thead>
            <tr><th>Gebruiker</th><th>Berichten</th><th>Tokens</th><th>Kosten</th></tr>
          </thead>
          <tbody>
            {list.map(row => (
              <tr key={row.uid}>
                <td>{row.label}</td>
                <td>{row.messages.toLocaleString('nl-NL')}</td>
                <td>{row.tokens.toLocaleString('nl-NL')}</td>
                <td>{fmtEur(row.costEur)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td>Totaal</td><td>{totalMsg.toLocaleString('nl-NL')}</td><td>{totalTok.toLocaleString('nl-NL')}</td><td>{fmtEur(totalEur)}</td></tr>
          </tfoot>
        </table>
      )}
    </section>
  );
}

export function Settings({
  settings,
  organizationContext,
  currentUserId,
  onCreateOrganization,
  onSwitchOrganization,
  onInviteMember,
  onAcceptInvitation,
  onUpdateMemberRole,
  onDisableMember,
  onRevokeInvitation,
  onSave,
}: {
  settings: CompanySettings | null;
  organizationContext: OrganizationContext;
  currentUserId: string | null;
  onCreateOrganization: () => void;
  onSwitchOrganization: (organizationId: string) => void;
  onInviteMember: (email: string, role: OrganizationRole) => Promise<void>;
  onAcceptInvitation: (invitationId: string) => Promise<void>;
  onUpdateMemberRole: (memberId: string, role: OrganizationRole) => Promise<void>;
  onDisableMember: (memberId: string) => Promise<void>;
  onRevokeInvitation: (invitationId: string) => Promise<void>;
  onSave: (settings: CompanySettingsInput) => Promise<void>;
}) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('organisatie');
  const [form, setForm] = useState<CompanySettingsInput>(() => settingsToForm(settings));
  const [message, setMessage] = useState<string | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<OrganizationRole>('member');
  const [orgMessage, setOrgMessage] = useState<string | null>(null);
  const [orgError, setOrgError] = useState<string | null>(null);
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);
  const [busyInvitationId, setBusyInvitationId] = useState<string | null>(null);
  const [billingOverview, setBillingOverview] = useState<OrganizationBillingOverview | null>(organizationContext.billingOverview);
  const [billingPlans, setBillingPlans] = useState<BillingPlan[]>([]);
  const [billingBusy, setBillingBusy] = useState<string | null>(null);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [billingMessage, setBillingMessage] = useState<string | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<string>(organizationContext.billingOverview?.plan_key ?? 'starter');
  const [selectedInterval, setSelectedInterval] = useState<'month' | 'year'>('month');
  const [lastMockPaymentId, setLastMockPaymentId] = useState<string | null>(null);
  const [resendTestEmail, setResendTestEmail] = useState(settings?.email ?? '');
  const [resendTestName, setResendTestName] = useState(settings?.trade_name || settings?.company_name || '');
  const [resendBusy, setResendBusy] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);
  const [resendMessage, setResendMessage] = useState<string | null>(null);
  const [invoiceMollie, setInvoiceMollie] = useState<InvoiceMollieSettingsStatus | null>(null);
  const [invoiceMollieKey, setInvoiceMollieKey] = useState('');
  const [invoiceMollieBusy, setInvoiceMollieBusy] = useState<string | null>(null);
  const [invoiceMollieError, setInvoiceMollieError] = useState<string | null>(null);
  const [invoiceMollieMessage, setInvoiceMollieMessage] = useState<string | null>(null);

  const activeOrganization = organizationContext.activeOrganization;
  const activeMembership = organizationContext.activeMembership;
  const canAdminOrganization = activeMembership ? ['owner', 'admin'].includes(activeMembership.role) : false;
  const canManageRoles = activeMembership?.role === 'owner';
  const activeOwnerCount = organizationContext.teamMembers.filter(member => member.role === 'owner' && member.status === 'active').length;
  const licenseUsage = organizationContext.licenseUsage;
  const seatOverview = billingOverview ?? licenseUsage;
  const selfServiceBillingPlans = getSelfServiceBillingPlans(billingPlans);
  const customBillingPlans = billingPlans.filter(plan => plan.is_custom);
  const selectedPlanIsSelfService = selfServiceBillingPlans.some(plan => plan.plan_key === selectedPlan);
  const hasPendingCheckout = billingOverview ? ['open', 'pending', 'authorized'].includes(billingOverview.payment_status) : false;
  const isBillingExempt = !!seatOverview?.billing_exempt;
  // Een écht lopend Mollie-abonnement vereist een subscription-id. subscription_status
  // staat bij een nieuwe org standaard al op 'active' (licentiemodel), dus daar kunnen
  // we niet op gaten — anders denkt de UI dat er al een abonnement is.
  const hasMollieSubscription = !!billingOverview?.mollie_subscription_id;
  const hasAvailableLicense = isBillingExempt || (seatOverview ? seatOverview.available_seats > 0 : true);
  const inviteDisabled = !canAdminOrganization || !activeOrganization || !inviteEmail.trim() || !hasAvailableLicense;
  const selectedPlanObj = billingPlans.find(plan => plan.plan_key === selectedPlan);
  const selectedPlanHasYearly = (selectedPlanObj?.yearly_price_cents ?? 0) > 0;

  useEffect(() => {
    setForm(settingsToForm(settings));
    setResendTestEmail(settings?.email ?? '');
    setResendTestName(settings?.trade_name || settings?.company_name || '');
  }, [settings]);
  useEffect(() => {
    setBillingOverview(organizationContext.billingOverview);
    setSelectedPlan(organizationContext.billingOverview?.plan_key ?? 'starter');
  }, [organizationContext.billingOverview, activeOrganization?.id]);
  useEffect(() => {
    let cancelled = false;
    loadBillingPlans().then(plans => { if (!cancelled) setBillingPlans(plans); }).catch(error => {
      if (!cancelled) setBillingError(error instanceof Error ? error.message : 'Billing-plannen laden mislukt.');
    });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    // Val terug op maandelijks zodra het gekozen plan geen jaarprijs (meer) heeft.
    if (!selectedPlanHasYearly && selectedInterval === 'year') setSelectedInterval('month');
  }, [selectedPlanHasYearly, selectedInterval]);
  useEffect(() => {
    let cancelled = false;
    if (!activeOrganization || !canAdminOrganization) { setInvoiceMollie(null); setInvoiceMollieError(null); return; }
    loadInvoiceMollieStatus(activeOrganization.id)
      .then(status => { if (!cancelled) { setInvoiceMollie(status); setInvoiceMollieError(null); } })
      .catch(err => { if (!cancelled) { setInvoiceMollie(null); setInvoiceMollieError(err instanceof Error ? err.message : 'Status laden mislukt.'); } });
    return () => { cancelled = true; };
  }, [activeOrganization?.id, canAdminOrganization]);

  const set = (key: keyof CompanySettingsInput, value: string | number | boolean | InvoiceTemplateKind | null) => {
    setForm(prev => ({ ...prev, [key]: value }));
    setMessage(null);
    setTemplateError(null);
  };

  async function save() {
    if (!canAdminOrganization) {
      setTemplateError('Alleen owners en admins kunnen bedrijfsinstellingen aanpassen.');
      return;
    }
    setMessage(null);
    setTemplateError(null);
    setIsSaving(true);
    try {
      await onSave(cleanSettingsInput(form));
      setMessage('Bedrijfsinstellingen opgeslagen. Nieuwe factuur-PDFs gebruiken deze gegevens direct.');
    } catch (error) {
      setTemplateError(error instanceof Error ? error.message : 'Bedrijfsinstellingen opslaan mislukt.');
    } finally {
      setIsSaving(false);
    }
  }

  async function inviteMember() {
    setOrgMessage(null);
    setOrgError(null);
    if (!hasAvailableLicense) {
      setOrgError('Geen vrije gebruikerslicentie beschikbaar. Koop eerst een extra gebruikerslicentie voordat je iemand uitnodigt.');
      return;
    }
    try {
      await onInviteMember(inviteEmail, inviteRole);
      setInviteEmail('');
      setOrgMessage(isBillingExempt
        ? 'Uitnodiging opgeslagen. Deze organisatie is intern/onbeperkt, dus er gelden geen seat-limieten.'
        : 'Uitnodiging opgeslagen. Er is één gebruikerslicentie gereserveerd totdat de uitnodiging wordt geaccepteerd of ingetrokken.');
    } catch (error) {
      setOrgError(error instanceof Error ? error.message : 'Uitnodiging aanmaken mislukt.');
    }
  }

  async function acceptInvitation(invitationId: string) {
    setOrgMessage(null);
    setOrgError(null);
    try {
      await onAcceptInvitation(invitationId);
      setOrgMessage('Uitnodiging geaccepteerd.');
    } catch (error) {
      setOrgError(error instanceof Error ? error.message : 'Uitnodiging accepteren mislukt.');
    }
  }

  async function changeRole(memberId: string, role: OrganizationRole) {
    setOrgMessage(null);
    setOrgError(null);
    setBusyMemberId(memberId);
    try {
      await onUpdateMemberRole(memberId, role);
      setOrgMessage('Rol bijgewerkt.');
    } catch (error) {
      setOrgError(error instanceof Error ? error.message : 'Rol wijzigen mislukt.');
    } finally {
      setBusyMemberId(null);
    }
  }

  async function disableMember(memberId: string) {
    if (!confirm('Dit teamlid uitschakelen voor deze organisatie?')) return;
    setOrgMessage(null);
    setOrgError(null);
    setBusyMemberId(memberId);
    try {
      await onDisableMember(memberId);
      setOrgMessage('Teamlid uitgeschakeld.');
    } catch (error) {
      setOrgError(error instanceof Error ? error.message : 'Teamlid uitschakelen mislukt.');
    } finally {
      setBusyMemberId(null);
    }
  }

  async function revokeInvitation(invitationId: string) {
    setOrgMessage(null);
    setOrgError(null);
    setBusyInvitationId(invitationId);
    try {
      await onRevokeInvitation(invitationId);
      setOrgMessage('Uitnodiging ingetrokken.');
    } catch (error) {
      setOrgError(error instanceof Error ? error.message : 'Uitnodiging intrekken mislukt.');
    } finally {
      setBusyInvitationId(null);
    }
  }

  async function refreshBilling() {
    if (!activeOrganization) return;
    setBillingBusy('refresh');
    setBillingError(null);
    setBillingMessage(null);
    try {
      const overview = await loadBillingOverview(activeOrganization.id);
      setBillingOverview(overview);
      setSelectedPlan(overview?.plan_key ?? selectedPlan);
      setBillingMessage('Billinggegevens ververst.');
    } catch (error) {
      setBillingError(error instanceof Error ? error.message : 'Billinggegevens verversen mislukt.');
    } finally {
      setBillingBusy(null);
    }
  }

  async function startSubscription() {
    if (!activeOrganization || !canAdminOrganization) return;
    setBillingBusy('connect');
    setBillingError(null);
    setBillingMessage(null);
    setLastMockPaymentId(null);
    try {
      const result = await startSubscriptionCheckout(activeOrganization.id, selectedPlan, selectedInterval);
      if (result.mock && result.providerPaymentId) {
        setLastMockPaymentId(result.providerPaymentId);
        setBillingMessage('Mock-checkout aangemaakt. Rond de mockbetaling af om het abonnement te activeren.');
        return;
      }
      if (result.checkoutUrl) {
        window.location.href = result.checkoutUrl;
        return;
      }
      await refreshBilling();
      setBillingMessage('Abonnement bijgewerkt.');
    } catch (error) {
      setBillingError(error instanceof Error ? error.message : 'Abonnement starten mislukt.');
    } finally {
      setBillingBusy(null);
    }
  }

  async function connectInvoiceMollie() {
    if (!activeOrganization || !canAdminOrganization) return;
    const apiKey = invoiceMollieKey.trim();
    if (!apiKey) { setInvoiceMollieError('Vul je Mollie API-key in.'); return; }
    setInvoiceMollieBusy('connect');
    setInvoiceMollieError(null);
    setInvoiceMollieMessage(null);
    try {
      const status = await saveInvoiceMollieKey(activeOrganization.id, apiKey);
      setInvoiceMollie(status);
      setInvoiceMollieKey('');
      setInvoiceMollieMessage(`Mollie gekoppeld (${status.mode === 'live' ? 'live' : 'test'}-modus). Bij het versturen van een factuur kun je nu een betaallink meesturen.`);
    } catch (error) {
      setInvoiceMollieError(error instanceof Error ? error.message : 'Mollie koppelen mislukt.');
    } finally {
      setInvoiceMollieBusy(null);
    }
  }

  async function disconnectInvoiceMollie() {
    if (!activeOrganization || !canAdminOrganization) return;
    if (!confirm('Mollie ontkoppelen voor facturen?\n\nDe opgeslagen API-key wordt direct verwijderd. Vergeet niet de key ook in je eigen Mollie-dashboard in te trekken.')) return;
    setInvoiceMollieBusy('disconnect');
    setInvoiceMollieError(null);
    setInvoiceMollieMessage(null);
    try {
      const result = await deleteInvoiceMollieKey(activeOrganization.id);
      setInvoiceMollie(result.status);
      setInvoiceMollieKey('');
      setInvoiceMollieMessage(result.hadOpenPayments
        ? 'Mollie ontkoppeld. Let op: er stonden nog open betaallinks; die kunnen niet meer automatisch worden geverifieerd. Trek de key ook in je Mollie-dashboard in.'
        : 'Mollie ontkoppeld. Trek de key ook in je eigen Mollie-dashboard in.');
    } catch (error) {
      setInvoiceMollieError(error instanceof Error ? error.message : 'Mollie ontkoppelen mislukt.');
    } finally {
      setInvoiceMollieBusy(null);
    }
  }

  async function buyExtraSeat() {
    if (!activeOrganization || !canAdminOrganization) return;
    setBillingBusy('seat');
    setBillingError(null);
    setBillingMessage(null);
    setLastMockPaymentId(null);
    try {
      const checkout = await createExtraSeatCheckout(activeOrganization.id, 1);
      if (checkout.checkoutUrl) {
        window.location.href = checkout.checkoutUrl;
        return;
      }
      await refreshBilling();
      setBillingMessage('Extra gebruiker toegevoegd. Het maandbedrag van je abonnement is aangepast.');
    } catch (error) {
      setBillingError(error instanceof Error ? error.message : 'Extra gebruiker toevoegen mislukt.');
    } finally {
      setBillingBusy(null);
    }
  }

  async function completeMockPayment() {
    if (!activeOrganization || !lastMockPaymentId) return;
    setBillingBusy('mock-paid');
    setBillingError(null);
    setBillingMessage(null);
    try {
      await markMockPaymentPaid(activeOrganization.id, lastMockPaymentId);
      setLastMockPaymentId(null);
      await refreshBilling();
      setBillingMessage('Mockbetaling verwerkt. De idempotente payment-RPC heeft de betaalde wijziging één keer toegepast.');
    } catch (error) {
      setBillingError(error instanceof Error ? error.message : 'Mockbetaling verwerken mislukt.');
    } finally {
      setBillingBusy(null);
    }
  }

  async function sendTestMail() {
    if (!activeOrganization || !canAdminOrganization) return;
    setResendBusy(true);
    setResendError(null);
    setResendMessage(null);
    try {
      const result = await sendResendTestEmail(activeOrganization.id, {
        recipientEmail: resendTestEmail,
        recipientName: resendTestName,
      });
      setResendMessage(`Testmail verzonden naar ${result.recipientEmail}. Resend-id: ${result.providerEmailId || 'onbekend'}.`);
    } catch (error) {
      setResendError(error instanceof Error ? error.message : 'Resend-testmail verzenden mislukt.');
    } finally {
      setResendBusy(false);
    }
  }

  async function changePlan() {
    if (!activeOrganization || !canAdminOrganization || !selectedPlan) return;
    if (!selectedPlanIsSelfService) {
      setBillingError('Dit plan kan niet via self-service worden gewijzigd. Kies Starter, Team of Pro.');
      return;
    }
    setBillingBusy('plan');
    setBillingError(null);
    setBillingMessage(null);
    try {
      const checkout = await changeOrganizationPlan(activeOrganization.id, selectedPlan);
      if (checkout.mock && checkout.providerPaymentId) {
        setLastMockPaymentId(checkout.providerPaymentId);
        setBillingMessage('Mock-checkout aangemaakt. Rond de mockbetaling af om de planwijziging te activeren.');
        return;
      }
      if (checkout.checkoutUrl) {
        window.location.href = checkout.checkoutUrl;
        return;
      }
      await refreshBilling();
      setBillingMessage('Plan gewijzigd. Het maandbedrag van je abonnement is aangepast.');
    } catch (error) {
      setBillingError(error instanceof Error ? error.message : 'Plan wijzigen mislukt.');
    } finally {
      setBillingBusy(null);
    }
  }

  async function onTemplateSelected(file: File | undefined) {
    setTemplateError(null);
    setMessage(null);
    if (!file) return;
    if (!isSupportedTemplate(file)) {
      setTemplateError('Upload een PDF, PNG of JPG-template.');
      return;
    }
    if (file.size > TEMPLATE_MAX_BYTES) {
      setTemplateError(`Template is te groot. Maximum is ${Math.round(TEMPLATE_MAX_BYTES / 1024 / 1024)} MB.`);
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setForm(prev => ({
        ...prev,
        invoice_template_kind: file.type === 'application/pdf' ? 'pdf' : 'image',
        invoice_template_file_name: file.name,
        invoice_template_mime_type: file.type || 'application/octet-stream',
        invoice_template_file_size: file.size,
        invoice_template_data_url: dataUrl,
        invoice_template_updated_at: new Date().toISOString(),
      }));
      setMessage('Template geladen. Klik op Opslaan om hem vast te leggen.');
    } catch (error) {
      setTemplateError(error instanceof Error ? error.message : 'Template kon niet worden gelezen.');
    }
  }

  function removeTemplate() {
    setForm(prev => ({
      ...prev,
      invoice_template_kind: 'none',
      invoice_template_file_name: null,
      invoice_template_mime_type: null,
      invoice_template_file_size: 0,
      invoice_template_data_url: null,
      invoice_template_updated_at: null,
    }));
    setTemplateError(null);
    setMessage('Template verwijderd uit het formulier. Klik op Opslaan om dit vast te leggen.');
  }

  const activeTabMeta = SETTINGS_TABS.find(tab => tab.id === activeTab) ?? SETTINGS_TABS[0];

  return <div className="settings-page">
    <div className="settings-head">
      <div>
        <h2>Instellingen</h2>
        <p>{activeTabMeta.description}</p>
      </div>
      {!canAdminOrganization && <p className="settings-help">Je kunt deze instellingen bekijken, maar alleen owners en admins kunnen ze aanpassen.</p>}
    </div>

    <div className="client-tabs-bar settings-tabs-bar" role="tablist">
      {SETTINGS_TABS.filter(tab => tab.id !== 'ai' || canAdminOrganization).map(tab => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={activeTab === tab.id}
          className={`client-tab-btn${activeTab === tab.id ? ' active' : ''}`}
          onClick={() => setActiveTab(tab.id)}
        >
          <tab.Icon size={15} aria-hidden="true" />
          {tab.label}
        </button>
      ))}
    </div>

    {activeTab === 'organisatie' && <div className="settings-tab-panel">
    <section className="settings-card organization-card">
      <div className="settings-card-head">
        <div>
          <h3>Organisatie-onboarding</h3>
          <p className="settings-help">Alle app-data hangt aan de actieve organisatie. Gebruik rollen om veilig meerdere gebruikers binnen dezelfde workspace te laten werken.</p>
        </div>
        <Button onClick={onCreateOrganization}>Nieuwe organisatie</Button>
      </div>

      {orgMessage && <div className="success">{orgMessage}</div>}
      {orgError && <div className="error">{orgError}</div>}

      <div className="settings-grid compact">
        <label>Actieve organisatie
          <Select value={activeOrganization?.id ?? ''} onChange={event => onSwitchOrganization(event.target.value)}>
            {organizationContext.organizations.map(org => <option key={org.id} value={org.id}>{org.name}</option>)}
          </Select>
        </label>
        <label>Jouw rol
          <Input value={activeMembership ? ROLE_LABELS[activeMembership.role] : 'Geen rol'} readOnly />
        </label>
      </div>

      {organizationContext.pendingInvitations.length > 0 && <div className="team-list">
        <strong>Openstaande uitnodigingen voor jou</strong>
        {organizationContext.pendingInvitations.map(invitation => <div className="team-row" key={invitation.id}>
          <div><span>{invitation.email}</span><small>Rol: {ROLE_LABELS[invitation.role]}</small></div>
          <Button variant="primary" onClick={() => acceptInvitation(invitation.id)}>Accepteren</Button>
        </div>)}
      </div>}
    </section>

    <section className="settings-card organization-card">
      <div className="settings-card-head">
        <div>
          <h3>Rollenbeheer</h3>
          <p className="settings-help">Owner = volledig beheer. Admin = organisatie-instellingen en uitnodigingen. Member = werken in CRM/projecten. Viewer = alleen lezen.</p>
        </div>
      </div>

      <div className="team-list">
        <strong>Actieve teamleden</strong>
        {organizationContext.teamMembers.map(member => {
          const isSelf = member.user_id === currentUserId;
          const isLastOwner = member.role === 'owner' && activeOwnerCount <= 1;
          const roleLocked = !canManageRoles || isSelf || isLastOwner || busyMemberId === member.id;
          return <div className="team-row role-row" key={member.id}>
            <div><span>{member.email ?? member.user_id}</span><small>{isSelf ? 'Jijzelf · ' : ''}{ROLE_LABELS[member.role]}{isLastOwner ? ' · laatste owner' : ''}</small></div>
            <Select value={member.role} disabled={roleLocked} onChange={event => changeRole(member.id, event.target.value as OrganizationRole)}>
              <option value="owner">Owner</option>
              <option value="admin">Admin</option>
              <option value="member">Member</option>
              <option value="viewer">Viewer</option>
            </Select>
            <Button variant="danger" disabled={!canManageRoles || isSelf || isLastOwner || busyMemberId === member.id} onClick={() => disableMember(member.id)}>Uitschakelen</Button>
          </div>;
        })}
        {organizationContext.teamMembers.length === 0 && <p className="settings-help">Nog geen teamleden gevonden.</p>}
      </div>

      {canAdminOrganization ? <div className="invite-row">
        <Input type="email" value={inviteEmail} onChange={event => setInviteEmail(event.target.value)} placeholder="teamlid@bedrijf.nl" />
        <Select value={inviteRole} onChange={event => setInviteRole(event.target.value as OrganizationRole)}>
          <option value="admin">Admin</option>
          <option value="member">Member</option>
          <option value="viewer">Viewer</option>
        </Select>
        <Button variant="primary" onClick={inviteMember} disabled={inviteDisabled}>Uitnodigen</Button>
      </div> : <p className="settings-help">Alleen owners en admins kunnen teamleden uitnodigen.</p>}

      {isBillingExempt && canAdminOrganization && <p className="settings-help">Deze organisatie is <strong>intern/onbeperkt</strong> — je kunt zonder seat-limiet teamleden uitnodigen.</p>}
      {!isBillingExempt && !hasAvailableLicense && <p className="settings-help">Er zijn geen vrije licenties meer. Trek een openstaande uitnodiging in, schakel een teamlid uit of laat billing eerst extra seats synchroniseren.</p>}

      {organizationContext.organizationInvitations.length > 0 && <div className="team-list">
        <strong>Openstaande teamuitnodigingen</strong>
        {organizationContext.organizationInvitations.map(invitation => <div className="team-row" key={invitation.id}>
          <div><span>{invitation.email}</span><small>{ROLE_LABELS[invitation.role]} · verloopt {formatDate(invitation.expires_at)}</small></div>
          <Button variant="danger" disabled={!canAdminOrganization || busyInvitationId === invitation.id} onClick={() => revokeInvitation(invitation.id)}>Intrekken</Button>
        </div>)}
      </div>}
    </section>

    <section className="settings-card activity-card">
      <div className="settings-card-head">
        <div>
          <h3>Audit-log basis</h3>
          <p className="settings-help">Laatste wijzigingen binnen deze organisatie. De log is alleen-lezen en wordt server-side gevuld door database-triggers.</p>
        </div>
      </div>
      <div className="activity-list">
        {organizationContext.auditLogs.map(log => <AuditLogRow key={log.id} log={log} />)}
        {organizationContext.auditLogs.length === 0 && <p className="settings-help">Nog geen audit-events. Voer de Sprint 1 SQL-migratie uit en maak daarna een wijziging om dit te vullen.</p>}
      </div>
    </section>
    </div>}

    {activeTab === 'facturatie' && <div className="settings-tab-panel">
    <div className="settings-save-bar">
      <p className="settings-help">Wijzigingen aan bedrijfsgegevens, factuurtemplate en betaalteksten worden pas actief nadat je ze opslaat. Nieuwe factuur-PDFs gebruiken deze gegevens direct.</p>
      <Button variant="primary" onClick={save} disabled={isSaving || !canAdminOrganization}>{isSaving ? 'Opslaan…' : 'Opslaan'}</Button>
    </div>
    {message && <div className="success">{message}</div>}
    {templateError && <div className="error">{templateError}</div>}

    <section className="settings-card">
      <h3>Bedrijfsgegevens op factuur</h3>
      <div className="settings-grid">
        <Input value={form.company_name ?? ''} onChange={e=>set('company_name', e.target.value)} placeholder="Bedrijfsnaam" />
        <Input value={form.trade_name ?? ''} onChange={e=>set('trade_name', e.target.value)} placeholder="Handelsnaam / label" />
        <Input value={form.address_line1 ?? ''} onChange={e=>set('address_line1', e.target.value)} placeholder="Adresregel 1" />
        <Input value={form.address_line2 ?? ''} onChange={e=>set('address_line2', e.target.value)} placeholder="Adresregel 2" />
        <Input value={form.postal_code ?? ''} onChange={e=>set('postal_code', e.target.value)} placeholder="Postcode" />
        <Input value={form.city ?? ''} onChange={e=>set('city', e.target.value)} placeholder="Plaats" />
        <Input value={form.country ?? ''} onChange={e=>set('country', e.target.value)} placeholder="Land" />
        <Input value={form.email ?? ''} onChange={e=>set('email', e.target.value)} placeholder="E-mailadres" />
        <Input value={form.phone ?? ''} onChange={e=>set('phone', e.target.value)} placeholder="Telefoon" />
        <Input value={form.website ?? ''} onChange={e=>set('website', e.target.value)} placeholder="Website" />
        <Input value={form.kvk_number ?? ''} onChange={e=>set('kvk_number', e.target.value)} placeholder="KvK-nummer" />
        <Input value={form.vat_number ?? ''} onChange={e=>set('vat_number', e.target.value)} placeholder="BTW-nummer" />
        <Input value={form.iban ?? ''} onChange={e=>set('iban', e.target.value)} placeholder="IBAN" />
      </div>
    </section>

    <section className="settings-card">
      <h3>Factuurtemplate &amp; stijl</h3>
      <p className="settings-help">Upload een eigen A4 afbeelding of PDF als achtergrond. Stel de tekstkleur, accentkleur en lettergrootte in — alle wijzigingen zijn direct zichtbaar in het voorbeeld hieronder.</p>
      <div className="field-list">
        {TEMPLATE_FIELD_LABELS.map(label => <span key={label}>{label}</span>)}
      </div>
      <div className="template-upload-row">
        <input type="file" accept="application/pdf,image/png,image/jpeg" onChange={e => { void onTemplateSelected(e.target.files?.[0]); e.currentTarget.value = ''; }} />
        {form.invoice_template_file_name && <Button variant="danger" onClick={removeTemplate}>Template verwijderen</Button>}
      </div>
      {form.invoice_template_file_name ? (
        <div className="template-meta">
          <div className="template-meta-row">
            <div>
              <strong>{form.invoice_template_file_name}</strong>
              <span>{form.invoice_template_kind === 'pdf' ? 'PDF-template' : 'Afbeelding-template'} · {Math.round((form.invoice_template_file_size || 0) / 1024)} KB</span>
            </div>
            {form.invoice_template_kind === 'image' && form.invoice_template_data_url && (
              <img src={form.invoice_template_data_url} alt="Template voorvertoning" className="template-thumb" />
            )}
          </div>
        </div>
      ) : (
        <div className="template-meta muted">Nog geen template ingesteld. Zonder template gebruikt ResoFly een nette standaardfactuur.</div>
      )}

      <div className="invoice-style-grid">
        <div className="invoice-style-controls">
          <div className="color-setting">
            <span className="style-label">Tekstkleur</span>
            <div className="color-input-pair">
              <input
                type="color"
                className="color-dot-input"
                value={/^#[0-9a-f]{6}$/i.test(form.invoice_template_text_color ?? '') ? (form.invoice_template_text_color as string) : '#1a1a1a'}
                onChange={e => set('invoice_template_text_color', e.target.value)}
              />
              <Input value={form.invoice_template_text_color ?? '#1a1a1a'} onChange={e => set('invoice_template_text_color', e.target.value)} placeholder="#1a1a1a" />
            </div>
          </div>
          <div className="color-setting">
            <span className="style-label">Accentkleur</span>
            <div className="color-input-pair">
              <input
                type="color"
                className="color-dot-input"
                value={/^#[0-9a-f]{6}$/i.test(form.invoice_accent_color ?? '') ? (form.invoice_accent_color as string) : '#FFD966'}
                onChange={e => set('invoice_accent_color', e.target.value)}
              />
              <Input value={form.invoice_accent_color ?? '#FFD966'} onChange={e => set('invoice_accent_color', e.target.value)} placeholder="#FFD966" />
            </div>
          </div>
          <div className="font-size-setting">
            <span className="style-label">Lettergrootte — {form.invoice_font_size ?? 10}pt</span>
            <div className="font-size-row">
              <span className="font-size-bound">8</span>
              <input
                type="range"
                min="8"
                max="14"
                step="1"
                value={form.invoice_font_size ?? 10}
                onChange={e => set('invoice_font_size', Number(e.target.value))}
                className="font-size-slider"
              />
              <span className="font-size-bound">14</span>
            </div>
          </div>
        </div>

        <div className="invoice-preview-wrap">
          <span className="style-label">Voorbeeld</span>
          <div
            className="invoice-preview-card"
            style={{ color: form.invoice_template_text_color ?? '#1a1a1a', fontSize: `${form.invoice_font_size ?? 10}px` }}
          >
            <div className="invoice-preview-accent-bar" style={{ background: form.invoice_accent_color ?? '#FFD966' }} />
            <div className="invoice-preview-body">
              <div className="invoice-preview-header-row">
                <div>
                  <div style={{ fontSize: `${(form.invoice_font_size ?? 10) + 6}px`, fontWeight: 700, marginBottom: 2 }}>
                    {form.company_name || 'Uw Bedrijfsnaam'}
                  </div>
                  <div style={{ opacity: 0.5, fontSize: `${Math.max(7, (form.invoice_font_size ?? 10) - 1)}px` }}>
                    Straatnaam 1 · 1234 AB Amsterdam
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: `${(form.invoice_font_size ?? 10) + 12}px`, fontWeight: 800, lineHeight: 1.1 }}>FACTUUR</div>
                  <div style={{ opacity: 0.5, fontSize: `${Math.max(7, (form.invoice_font_size ?? 10) - 1)}px` }}>Nummer: 2025-001</div>
                </div>
              </div>
              <div style={{ height: 1.5, background: form.invoice_accent_color ?? '#FFD966', margin: '6px 0' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>Werkzaamheden Q1 2025</span>
                <span style={{ fontWeight: 600 }}>EUR 1.000,00</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', opacity: 0.5, fontSize: `${Math.max(7, (form.invoice_font_size ?? 10) - 1)}px` }}>
                <span>BTW 21%</span>
                <span>EUR 210,00</span>
              </div>
              <div style={{ borderTop: `1.5px solid ${form.invoice_accent_color ?? '#FFD966'}`, marginTop: 6, paddingTop: 6, display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: `${(form.invoice_font_size ?? 10) + 2}px` }}>
                <span>Totaal</span>
                <span>EUR 1.210,00</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section className="settings-card">
      <h3>Betaling en footer</h3>
      <Textarea value={form.invoice_payment_terms ?? ''} onChange={e=>set('invoice_payment_terms', e.target.value)} placeholder="Betaalinstructies" />
      <Textarea value={form.invoice_footer ?? ''} onChange={e=>set('invoice_footer', e.target.value)} placeholder="Footertekst" />
    </section>
    </div>}

    {activeTab === 'boekhouding' && <div className="settings-tab-panel">
    <div className="settings-save-bar">
      <p className="settings-help">Deze instellingen sturen het grootboek en de BTW-aangifte aan. Wijzigingen worden pas actief nadat je ze opslaat.</p>
      <Button variant="primary" onClick={save} disabled={isSaving || !canAdminOrganization}>{isSaving ? 'Opslaan…' : 'Opslaan'}</Button>
    </div>
    {message && <div className="success">{message}</div>}
    <section className="settings-card">
      <h3>Boekhouding</h3>
      <p className="settings-help">De boekhoud-startdatum is de knipdatum vanaf wanneer het grootboek leidend is: verkoopfacturen van vóór deze datum worden niet meer naar het grootboek geboekt (die stand zit in je beginbalans). Kies bij voorkeur een kwartaal- of jaargrens. Met de KOR-regeling wordt geen BTW in rekening gebracht en is voorbelasting niet aftrekbaar.</p>
      <div className="settings-grid">
        <label className="bk-setting-field"><span>Boekhouding leidend vanaf</span>
          <Input type="date" value={form.bookkeeping_start_date ?? ''} onChange={e=>set('bookkeeping_start_date', e.target.value || null)} disabled={!canAdminOrganization} />
        </label>
        <label className="bk-setting-field"><span>BTW-aangifte indienen</span>
          <select className="form-select" value={form.vat_return_period ?? 'quarterly'} onChange={e=>set('vat_return_period', e.target.value)} disabled={!canAdminOrganization}>
            <option value="quarterly">Per kwartaal</option>
            <option value="monthly">Maandelijks</option>
          </select>
        </label>
        <label className="bk-setting-check">
          <input type="checkbox" checked={Boolean(form.kor_enabled)} onChange={e=>set('kor_enabled', e.target.checked)} disabled={!canAdminOrganization} />
          <span>KOR (kleineondernemersregeling) actief</span>
        </label>
      </div>
    </section>
    </div>}

    {activeTab === 'betalen' && <div className="settings-tab-panel">
    <section className="settings-card organization-card billing-card">
      <div className="settings-card-head">
        <div>
          <h3>Online betalen (Mollie)</h3>
          <p className="settings-help">Koppel het eigen Mollie-account van deze organisatie. Daarna kun je bij het versturen van een factuur een betaallink meesturen zodat klanten direct online kunnen betalen. Mollie is optioneel — zonder koppeling verstuur je gewoon de factuur-PDF.</p>
        </div>
      </div>

      {invoiceMollieMessage && <div className="success">{invoiceMollieMessage}</div>}
      {invoiceMollieError && <div className="error">{invoiceMollieError}</div>}

      {canAdminOrganization ? <>
        <div className="billing-summary">
          <div>
            <span>Status</span>
            <strong>{invoiceMollie?.status === 'connected' ? 'Gekoppeld' : 'Niet gekoppeld'}</strong>
            <small>{invoiceMollie?.status === 'connected'
              ? `${invoiceMollie.mode === 'live' ? 'Live' : 'Test'}-modus${invoiceMollie.key_suffix ? ' · key ••••' + invoiceMollie.key_suffix : ''}`
              : 'Facturen worden zonder betaallink verstuurd.'}</small>
          </div>
          {invoiceMollie?.status === 'connected' && invoiceMollie.connected_at && <div>
            <span>Gekoppeld sinds</span>
            <strong>{formatDate(invoiceMollie.connected_at)}</strong>
            <small>{invoiceMollie.last_validated_at ? 'Laatst gevalideerd ' + formatDate(invoiceMollie.last_validated_at) : 'Nog niet opnieuw gevalideerd'}</small>
          </div>}
        </div>

        {invoiceMollie?.status === 'connected' ? <>
          <div className="billing-control-row">
            <div>
              <strong>Key vervangen</strong>
              <p className="settings-help">Plak een nieuwe API-key om de bestaande te vervangen, bijvoorbeeld na rotatie in je Mollie-dashboard.</p>
              <Input type="password" value={invoiceMollieKey} onChange={event => setInvoiceMollieKey(event.target.value)} placeholder="Nieuwe live_… of test_…" autoComplete="off" />
            </div>
            <Button onClick={connectInvoiceMollie} disabled={invoiceMollieBusy === 'connect' || !invoiceMollieKey.trim()}>{invoiceMollieBusy === 'connect' ? 'Opslaan…' : 'Key vervangen'}</Button>
          </div>
          <div className="billing-control-row">
            <div>
              <strong>Mollie ontkoppelen</strong>
              <p className="settings-help">Verwijdert de opgeslagen key direct. Trek de key daarna ook in je eigen Mollie-dashboard in.</p>
            </div>
            <Button variant="danger" onClick={disconnectInvoiceMollie} disabled={invoiceMollieBusy === 'disconnect'}>{invoiceMollieBusy === 'disconnect' ? 'Ontkoppelen…' : 'Mollie ontkoppelen'}</Button>
          </div>
        </> : <div className="billing-control-row">
          <div>
            <strong>Mollie koppelen</strong>
            <p className="settings-help">Plak je Mollie API-key (begint met <code>live_</code> of <code>test_</code>). Te vinden in je Mollie-dashboard onder Developers → API-keys.</p>
            <Input type="password" value={invoiceMollieKey} onChange={event => setInvoiceMollieKey(event.target.value)} placeholder="live_… of test_…" autoComplete="off" />
          </div>
          <Button variant="primary" onClick={connectInvoiceMollie} disabled={invoiceMollieBusy === 'connect' || !invoiceMollieKey.trim()}>{invoiceMollieBusy === 'connect' ? 'Koppelen…' : 'Mollie koppelen'}</Button>
        </div>}
      </> : <p className="settings-help">Alleen owners en admins kunnen de Mollie-koppeling beheren.</p>}
    </section>

    {activeOrganization && <InvoiceReminderSettingsCard organizationId={activeOrganization.id} canAdmin={canAdminOrganization} />}
    </div>}

    {activeTab === 'abonnement' && <div className="settings-tab-panel">
    <section className="settings-card organization-card billing-card">
      <div className="settings-card-head">
        <div>
          <h3>Billing & licenties</h3>
          <p className="settings-help">Het billing-profiel stuurt het compatibele organisatieveld <code>licensed_seats</code> aan. Actieve gebruikers plus pending uitnodigingen mogen nooit boven de beschikbare seats uitkomen.</p>
        </div>
        {canAdminOrganization && <div className="billing-actions">
          <Button onClick={refreshBilling} disabled={billingBusy === 'refresh'}>{billingBusy === 'refresh' ? 'Verversen…' : 'Billing verversen'}</Button>
          {!isBillingExempt && !hasMollieSubscription && <Button variant="primary" onClick={startSubscription} disabled={billingBusy === 'connect'}>{billingBusy === 'connect' ? 'Bezig…' : 'Abonnement starten'}</Button>}
        </div>}
      </div>

      {billingMessage && <div className="success">{billingMessage}</div>}
      {billingError && <div className="error">{billingError}</div>}
      {hasPendingCheckout && <div className="success">Er staat een checkout open of pending. Rond de betaling af of ververs de billingstatus na terugkeer uit Mollie.</div>}

      {billingOverview ? <>
        <div className="billing-summary">
          <div>
            <span>Huidig plan</span>
            <strong>{billingOverview.plan_name}</strong>
            <small>{billingOverview.subscription_status}{hasMollieSubscription ? ` · ${billingOverview.billing_interval === 'year' ? 'jaarlijks' : 'maandelijks'}` : ''}</small>
          </div>
          <div>
            <span>Betaalstatus</span>
            <strong>{paymentStatusLabel(billingOverview.payment_status)}</strong>
            <small>Laatste: {billingOverview.last_payment_status ?? 'nog geen betaling'}</small>
          </div>
          <div>
            <span>Mollie-status</span>
            <strong>{mollieStatusLabel(billingOverview.mollie_connect_status)}</strong>
            <small>{billingOverview.mollie_customer_id ? 'Customer: ' + billingOverview.mollie_customer_id : 'Nog geen customer-id'}</small>
          </div>
          <div>
            <span>Volgende factuur</span>
            <strong>{formatDate(billingOverview.next_invoice_date)}</strong>
            <small>{billingOverview.current_period_ends_at ? 'Periode tot ' + formatDate(billingOverview.current_period_ends_at) : 'Nog niet ingesteld'}</small>
          </div>
        </div>

        <div className="license-grid">
          <div className="license-metric"><span>Inbegrepen</span><strong>{billingOverview.included_seats}</strong></div>
          <div className="license-metric"><span>Aangekocht extra</span><strong>{billingOverview.purchased_seats}</strong></div>
          <div className="license-metric"><span>Actief</span><strong>{billingOverview.active_members}</strong></div>
          <div className="license-metric"><span>Pending</span><strong>{billingOverview.pending_invitations}</strong></div>
          <div className="license-metric"><span>Totaal seats</span><strong>{billingOverview.licensed_seats}</strong></div>
          <div className="license-metric"><span>Vrij</span><strong>{isBillingExempt ? '∞' : billingOverview.available_seats}</strong></div>
        </div>

        {isBillingExempt && <div className="billing-control-row">
          <div>
            <strong>Interne organisatie — onbeperkte gebruikers</strong>
            <p className="settings-help">Deze organisatie is vrijgesteld van facturatie. Je kunt zonder seat-limiet teamleden uitnodigen; er lopen geen abonnementskosten en er is geen Mollie-koppeling nodig.</p>
          </div>
          <span className="badge">Intern · gratis</span>
        </div>}

{canAdminOrganization && !isBillingExempt && <div className="billing-control-row">
          <div>
            <strong>Extra gebruiker toevoegen</strong>
            <p className="settings-help">{hasMollieSubscription
              ? 'Voegt direct een extra seat toe en past het maandbedrag van je abonnement aan.'
              : 'Start eerst een abonnement; daarna kun je extra gebruikers toevoegen.'}</p>
          </div>
          <Button variant="primary" onClick={buyExtraSeat} disabled={billingBusy === 'seat' || !hasMollieSubscription}>{billingBusy === 'seat' ? 'Bezig…' : 'Extra gebruiker toevoegen'}</Button>
        </div>}

        {canAdminOrganization && lastMockPaymentId && <div className="billing-control-row mock-row">
          <div>
            <strong>Mockbetaling klaar</strong>
            <p className="settings-help">Payment-id: {lastMockPaymentId}. Gebruik dit alleen lokaal met <code>MOLLIE_ALLOW_MOCK=true</code>.</p>
          </div>
          <Button variant="primary" onClick={completeMockPayment} disabled={billingBusy === 'mock-paid'}>{billingBusy === 'mock-paid' ? 'Verwerken…' : 'Mockbetaling afronden'}</Button>
        </div>}

{canAdminOrganization && !isBillingExempt && <div className="billing-control-row">
          <div>
            <strong>{hasMollieSubscription ? 'Plan wijzigen' : 'Abonnement starten'}</strong>
            <p className="settings-help">{hasMollieSubscription
              ? `Past het bedrag van je lopende abonnement direct aan (interval blijft ${billingOverview.billing_interval === 'year' ? 'jaarlijks' : 'maandelijks'}). Custom-plannen blijven handmatig.`
              : 'Kies een plan en facturatie-interval; je start het abonnement via een Mollie-checkout. Custom-plannen blijven handmatig.'}</p>
            {!hasMollieSubscription && selectedPlanObj && !selectedPlanObj.is_custom && <p className="settings-help">
              {selectedInterval === 'year' && selectedPlanHasYearly
                ? <>Prijs: <strong>{formatEur(selectedPlanObj.yearly_price_cents, selectedPlanObj.currency)}</strong> per jaar{selectedPlanObj.monthly_price_cents * 12 > selectedPlanObj.yearly_price_cents ? ` · je bespaart ${formatEur(selectedPlanObj.monthly_price_cents * 12 - selectedPlanObj.yearly_price_cents, selectedPlanObj.currency)} t.o.v. maandelijks` : ''}</>
                : <>Prijs: <strong>{formatEur(selectedPlanObj.monthly_price_cents, selectedPlanObj.currency)}</strong> per maand{selectedPlanHasYearly ? ' · jaarlijks beschikbaar' : ''}</>}
            </p>}
          </div>
          <Select value={selectedPlan} onChange={event => setSelectedPlan(event.target.value)} disabled={billingBusy === 'plan'}>
            {!selectedPlanIsSelfService && <option value={selectedPlan} disabled>{billingOverview.plan_name} · handmatig beheerd</option>}
            {selfServiceBillingPlans.map(plan => <option key={plan.plan_key} value={plan.plan_key}>{plan.name} · {plan.included_seats ?? 'custom'} seats</option>)}
          </Select>
          {!hasMollieSubscription && <Select value={selectedInterval} onChange={event => setSelectedInterval(event.target.value as 'month' | 'year')} disabled={billingBusy === 'plan'}>
            <option value="month">Maandelijks</option>
            {selectedPlanHasYearly && <option value="year">Jaarlijks</option>}
          </Select>}
          <Button onClick={changePlan} disabled={billingBusy === 'plan' || (hasMollieSubscription && selectedPlan === billingOverview.plan_key) || !selectedPlanIsSelfService}>{billingBusy === 'plan' ? 'Bezig…' : (hasMollieSubscription ? 'Plan wijzigen' : 'Abonnement starten')}</Button>
        </div>}

        {customBillingPlans.length > 0 && !isBillingExempt && <div className="billing-control-row">
          <div>
            <strong>Custom-plan</strong>
            <p className="settings-help">Custom-plannen worden niet als self-service checkout aangeboden. Neem contact op voor contractafspraken, seats en facturatie.</p>
          </div>
          <span className="badge">Neem contact op</span>
        </div>}
      </> : <p className="settings-help">Billinggegevens konden nog niet worden geladen. Controleer of de Sprint 2 migratie is uitgevoerd.</p>}

      {!canAdminOrganization && <p className="settings-help">Alleen owners en admins kunnen billing-acties uitvoeren.</p>}
      {!isBillingExempt && seatOverview && seatOverview.available_seats <= 0 && <div className="error">Geen vrije gebruikerslicentie beschikbaar. Koop eerst een extra gebruikerslicentie voordat je iemand uitnodigt.</div>}
    </section>
    </div>}

    {activeTab === 'ai' && <div className="settings-tab-panel">
      {canAdminOrganization
        ? (activeOrganization ? <AiUsagePanel organizationId={activeOrganization.id} members={organizationContext.teamMembers} /> : <p className="settings-help">Geen actieve organisatie geselecteerd.</p>)
        : <p className="settings-help">Alleen owners en admins kunnen het AI-gebruik inzien.</p>}
    </div>}

    {activeTab === 'email' && <div className="settings-tab-panel">
    {activeOrganization && <SendingDomainCard organizationId={activeOrganization.id} canAdmin={canAdminOrganization} />}
    {activeOrganization && <EmailTemplatesCard organizationId={activeOrganization.id} canAdmin={canAdminOrganization} />}
    <section className="settings-card organization-card">
      <div className="settings-card-head">
        <div>
          <h3>E-mail via Resend</h3>
          <p className="settings-help">Verstuur een server-side testmail met dezelfde centrale template-registry als de offerteflow. De API-key blijft in Supabase Edge Function secrets.</p>
        </div>
        <Button variant="primary" onClick={sendTestMail} disabled={!canAdminOrganization || resendBusy || !resendTestEmail.trim()}>{resendBusy ? 'Versturen…' : 'Verstuur testmail'}</Button>
      </div>
      {resendMessage && <div className="success">{resendMessage}</div>}
      {resendError && <div className="error">{resendError}</div>}
      <div className="settings-grid compact">
        <label>Testmail naar
          <Input type="email" value={resendTestEmail} onChange={event => { setResendTestEmail(event.target.value); setResendError(null); setResendMessage(null); }} placeholder="jij@bedrijf.nl" />
        </label>
        <label>Naam/contactpersoon
          <Input value={resendTestName} onChange={event => { setResendTestName(event.target.value); setResendError(null); setResendMessage(null); }} placeholder="Naam voor aanhef" />
        </label>
      </div>
      {!canAdminOrganization && <p className="settings-help">Alleen owners en admins kunnen testmails verzenden.</p>}
    </section>
    </div>}
  </div>;
}

function AuditLogRow({ log }: { log: AuditLog }) {
  const changed = log.metadata?.changed_columns;
  const changedColumns = Array.isArray(changed) ? changed.join(', ') : '';
  return <div className="activity-row">
    <div>
      <strong>{auditActionLabel(log.action)} · {entityLabel(log.entity_type)}</strong>
      <span>{log.entity_label || log.entity_id || 'Onbekend record'}{changedColumns ? ` · ${changedColumns}` : ''}</span>
    </div>
    <time>{formatDateTime(log.created_at)}</time>
  </div>;
}

function auditActionLabel(action: string) {
  const labels: Record<string, string> = { created: 'Aangemaakt', updated: 'Bijgewerkt', deleted: 'Verwijderd', invited: 'Uitgenodigd', accepted: 'Geaccepteerd', revoked: 'Ingetrokken', role_changed: 'Rol gewijzigd', disabled: 'Uitgeschakeld', expired: 'Verlopen', mollie_connected: 'Mollie gekoppeld', plan_changed: 'Plan gewijzigd', seat_purchased: 'Seat gekocht', seat_downgrade_requested: 'Downgrade aangevraagd', payment_succeeded: 'Betaling geslaagd', payment_failed: 'Betaling mislukt', payment_expired: 'Betaling verlopen', subscription_cancelled: 'Subscription geannuleerd', licensed_seats_changed: 'Licenties gewijzigd', invitation_blocked_insufficient_seats: 'Uitnodiging geblokkeerd', billing_synced: 'Billing gesynchroniseerd' };
  return labels[action] ?? action;
}

function entityLabel(entity: string) {
  const labels: Record<string, string> = { organization: 'Organisatie', member: 'Teamlid', invitation: 'Uitnodiging', license_event: 'Licentie', client: 'Klant', project: 'Project', task: 'Taak', ticket: 'Ticket', note: 'Notitie', quote: 'Offerte', invoice: 'Factuur', attachment: 'Bijlage', company_settings: 'Bedrijfsinstellingen', calendar_connection: 'Agenda-koppeling', calendar_source: 'Agenda', billing_profile: 'Billingprofiel', subscription: 'Subscription', payment: 'Betaling', billing_event: 'Billing-event', license_change: 'Licentiewijziging' };
  return labels[entity] ?? entity;
}

function formatEur(cents: number, currency = 'EUR') {
  return new Intl.NumberFormat('nl-NL', { style: 'currency', currency }).format((cents ?? 0) / 100);
}

function paymentStatusLabel(status: string) {
  const labels: Record<string, string> = { none: 'Nog geen betaling', open: 'Open', pending: 'In behandeling', paid: 'Betaald', failed: 'Mislukt', expired: 'Verlopen', canceled: 'Geannuleerd', authorized: 'Geautoriseerd', refunded: 'Teruggestort', charged_back: 'Gestorneerd' };
  return labels[status] ?? status;
}

function mollieStatusLabel(status: string) {
  const labels: Record<string, string> = { not_connected: 'Niet gekoppeld', pending: 'Koppeling gestart', connected: 'Gekoppeld', mock_connected: 'Mock gekoppeld', error: 'Fout', revoked: 'Ingetrokken' };
  return labels[status] ?? status;
}

function formatDate(value: string | null) {
  if (!value) return 'niet ingesteld';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'onbekend';
  return new Intl.DateTimeFormat('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('nl-NL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
}

function settingsToForm(settings: CompanySettings | null): CompanySettingsInput {
  if (!settings) return emptySettings;
  return {
    company_name: settings.company_name ?? '',
    trade_name: settings.trade_name ?? '',
    address_line1: settings.address_line1 ?? '',
    address_line2: settings.address_line2 ?? '',
    postal_code: settings.postal_code ?? '',
    city: settings.city ?? '',
    country: settings.country ?? 'Nederland',
    email: settings.email ?? '',
    phone: settings.phone ?? '',
    website: settings.website ?? '',
    kvk_number: settings.kvk_number ?? '',
    vat_number: settings.vat_number ?? '',
    iban: settings.iban ?? '',
    invoice_payment_terms: settings.invoice_payment_terms ?? emptySettings.invoice_payment_terms,
    invoice_footer: settings.invoice_footer ?? emptySettings.invoice_footer,
    invoice_template_kind: settings.invoice_template_kind ?? 'none',
    invoice_template_file_name: settings.invoice_template_file_name ?? null,
    invoice_template_mime_type: settings.invoice_template_mime_type ?? null,
    invoice_template_file_size: settings.invoice_template_file_size ?? 0,
    invoice_template_data_url: settings.invoice_template_data_url ?? null,
    invoice_template_text_color: settings.invoice_template_text_color ?? '#1a1a1a',
    invoice_accent_color: settings.invoice_accent_color ?? '#FFD966',
    invoice_font_size: settings.invoice_font_size ?? 10,
    invoice_template_updated_at: settings.invoice_template_updated_at ?? null,
    bookkeeping_start_date: settings.bookkeeping_start_date ?? null,
    kor_enabled: settings.kor_enabled ?? false,
    vat_return_period: settings.vat_return_period ?? 'quarterly',
  };
}

function cleanSettingsInput(input: CompanySettingsInput): CompanySettingsInput {
  const clean = (value: string | null | undefined) => {
    const trimmed = String(value ?? '').trim();
    return trimmed || null;
  };

  const templateKind = input.invoice_template_data_url && input.invoice_template_kind !== 'none'
    ? input.invoice_template_kind
    : 'none';

  return {
    ...input,
    company_name: String(input.company_name || '').trim(),
    trade_name: clean(input.trade_name),
    address_line1: clean(input.address_line1),
    address_line2: clean(input.address_line2),
    postal_code: clean(input.postal_code),
    city: clean(input.city),
    country: clean(input.country) || 'Nederland',
    email: clean(input.email),
    phone: clean(input.phone),
    website: clean(input.website),
    kvk_number: clean(input.kvk_number),
    vat_number: clean(input.vat_number),
    iban: clean(input.iban),
    invoice_payment_terms: clean(input.invoice_payment_terms),
    invoice_footer: clean(input.invoice_footer),
    invoice_template_kind: templateKind,
    invoice_template_file_name: templateKind === 'none' ? null : clean(input.invoice_template_file_name),
    invoice_template_mime_type: templateKind === 'none' ? null : clean(input.invoice_template_mime_type),
    invoice_template_file_size: templateKind === 'none' ? 0 : Number(input.invoice_template_file_size || 0),
    invoice_template_data_url: templateKind === 'none' ? null : input.invoice_template_data_url,
    invoice_template_updated_at: templateKind === 'none' ? null : input.invoice_template_updated_at,
    invoice_template_text_color: normalizeHex(input.invoice_template_text_color, '#1a1a1a'),
    invoice_accent_color: normalizeHex(input.invoice_accent_color, '#FFD966'),
    invoice_font_size: Math.max(8, Math.min(14, Number(input.invoice_font_size ?? 10))),
  };
}

function normalizeHex(value: string | null | undefined, fallback: string): string {
  const trimmed = String(value ?? '').trim();
  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed : fallback;
}

function isSupportedTemplate(file: File): boolean {
  return file.type === 'application/pdf' || ['image/png', 'image/jpeg'].includes(file.type);
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Template kon niet worden gelezen.'));
    reader.readAsDataURL(file);
  });
}
