import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Bell, BookOpen, CalendarCog, CreditCard, ListChecks, Mail, Palette, Receipt, ShieldCheck, Sparkles, SlidersHorizontal, Trash2, Users } from 'lucide-react';
import { PushNotificationsCard, type PushApi } from '../components/usePushNotifications';
import { BUSINESS_LEGAL_FORMS, LEGAL_FORM_LABELS } from '../types';
import type { AppData, AuditLog, BillingPlan, CompanySettings, CompanySettingsInput, EmailTemplate, LegalForm, EmailTemplateInput, EmailTemplateKey, InvoiceMollieSettingsStatus, InvoiceReminderSettings, InvoiceTemplateKind, OrganizationBillingOverview, OrganizationContext, OrganizationInboundAlias, OrganizationMember, OrganizationRole, Project, SendingDomain, SendingDomainDnsRecord, SendingDomainStatus, UserSenderIdentity } from '../types';
import { Button, Input, Select, Textarea } from '../components/Ui';
import { Modal } from '../components/Modal';
import { BRAND_BODY_FONTS, BRAND_FONTS, CLIENT_THEMES, GALLERY_BACKGROUNDS, brandFont, brandStyle, brandThemeVars, ensureBrandFontsLoaded } from '../lib/branding';
import { changeOrganizationPlan, createExtraSeatCheckout, createStorageAddonCheckout, getSelfServiceBillingPlans, loadBillingOverview, loadBillingPlans, markMockPaymentPaid, setBusinessAddon, setCreativeAddon, startSubscriptionCheckout } from '../services/billingService';
import { sendResendTestEmail, addSendingDomain, verifySendingDomain, updateSendingDomain, removeSendingDomain } from '../services/mailService';
import { deleteInvoiceMollieKey, loadInvoiceMollieStatus, saveInvoiceMollieKey, loadInvoiceReminderSettings, saveInvoiceReminderSettings, saveInvoiceDunningSettings, loadStatutoryInterestRates, loadEmailTemplates, upsertEmailTemplate, resetEmailTemplate, loadSendingDomains, loadMySenderIdentity, saveMySenderIdentity, clearMySenderIdentity, loadInboundAlias, ensureInboundAlias, rotateInboundAlias, setInboundAliasForwardFrom } from '../lib/repository';
import { loadGerrieUsage, type GerrieUsageRow } from '../lib/gerrie-api';
import { EMAIL_TEMPLATES, EMAIL_FIELD_LABELS, EMAIL_FIELD_HINTS, fillPlaceholders, type EmailField } from '../lib/emailTemplateContent';
import { ProjectTemplatesManager } from './ProjectTemplates';
import { ClientFieldsManager } from './ClientFields';
import { LEVEL_LABELS, MODULES, parseModuleAccess, type ModuleAccess, type ModuleLevel } from '../lib/permissions';

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
  legal_form: 'eenmanszaak',
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
  fiscal_year_start_month: 1,
  year_result_account_code: '0510',
  default_hourly_rate_cents: null,
  brand_logo_data_url: null,
  brand_accent_color: '#FFD966',
  brand_footer_text: null,
  brand_hide_powered_by: false,
  brand_heading_font: 'system',
  brand_body_font: 'system',
  brand_gallery_bg: '#0B0B0B',
  brand_client_theme: 'dark',
};

const ROLE_LABELS: Record<OrganizationRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

export type SettingsTab = 'organisatie' | 'sjablonen' | 'klantvelden' | 'huisstijl' | 'meldingen' | 'agenda' | 'facturatie' | 'boekhouding' | 'betalen' | 'abonnement' | 'ai' | 'email';

/**
 * Rechtenraster: per module kiezen tussen geen toegang, alleen lezen en
 * volledig. Een ontbrekende sleutel betekent volledig — daarom slaan we
 * 'write' niet op, zodat later toegevoegde modules automatisch openstaan.
 */
function ModuleAccessGrid({ value, onChange, disabled = false, readOnlyCap = false }: {
  value: ModuleAccess;
  onChange: (next: ModuleAccess) => void;
  disabled?: boolean;
  /** Voor een viewer: 'volledig' bestaat niet, die kan hoogstens lezen. */
  readOnlyCap?: boolean;
}) {
  function set(key: string, level: ModuleLevel) {
    const next: ModuleAccess = { ...value };
    if (level === 'write') delete next[key as keyof ModuleAccess];
    else next[key as keyof ModuleAccess] = level;
    onChange(next);
  }

  return <div className="settings-grid compact">
    {MODULES.map(module => {
      const current: ModuleLevel = value[module.key] ?? 'write';
      return <label key={module.key} title={module.description}>{module.label}
        <Select value={current} disabled={disabled} onChange={event => set(module.key, event.target.value as ModuleLevel)}>
          <option value="none">{LEVEL_LABELS.none}</option>
          <option value="read">{LEVEL_LABELS.read}</option>
          {!readOnlyCap && <option value="write">{LEVEL_LABELS.write}</option>}
        </Select>
      </label>;
    })}
  </div>;
}

/** Korte samenvatting onder een teamlid: "Financiën verborgen · Uren alleen lezen". */
function moduleAccessSummary(role: OrganizationRole, raw: unknown): string {
  if (role === 'owner' || role === 'admin') return 'Toegang tot alle modules';
  const access = parseModuleAccess(raw);
  const hidden = MODULES.filter(m => access[m.key] === 'none').map(m => m.label);
  const readOnly = role === 'viewer'
    ? MODULES.filter(m => access[m.key] !== 'none').map(m => m.label)
    : MODULES.filter(m => access[m.key] === 'read').map(m => m.label);
  if (!hidden.length && !readOnly.length) return 'Toegang tot alle modules';
  const parts: string[] = [];
  if (hidden.length) parts.push(`${hidden.join(', ')} verborgen`);
  if (readOnly.length) parts.push(role === 'viewer' ? 'rest alleen lezen' : `${readOnly.join(', ')} alleen lezen`);
  return parts.join(' · ');
}

export const SETTINGS_TABS: Array<{ id: SettingsTab; label: string; Icon: typeof Users; description: string }> = [
  { id: 'organisatie', label: 'Organisatie & team', Icon: Users, description: 'Beheer je werkruimte, teamleden en rollen, en bekijk de recente activiteit.' },
  { id: 'sjablonen', label: 'Projectsjablonen', Icon: ListChecks, description: 'Leg je vaste werkwijze vast als standaardtaken en subtaken, en rol die bij elk nieuw project in één klik uit.' },
  { id: 'klantvelden', label: 'Eigen klantvelden', Icon: SlidersHorizontal, description: 'Verzin je eigen velden bij een klant — en gebruik ze als variabele in je campagnes en mailings.' },
  { id: 'huisstijl', label: 'Huisstijl', Icon: Palette, description: 'Je logo, merkkleur en afsluiting op alles wat je klant ziet — het klantportaal en de galerij — zodat het van jou is, niet van ResoFly.' },
  { id: 'meldingen', label: 'Meldingen', Icon: Bell, description: 'Ontvang OS-meldingen op je apparaat bij nieuwe tickets, chatberichten, e-mails en boekingen — ook als ResoFly dicht is.' },
  { id: 'agenda', label: 'Agenda', Icon: CalendarCog, description: 'Koppel Google Calendar of Microsoft Outlook, maak eigen ResoFly-agenda\'s, abonneer op een agenda via een link en zet de sync met je telefoon aan.' },
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

function DunningSettingsCard({ organizationId, canAdmin }: { organizationId: string; canAdmin: boolean }) {
  const [settings, setSettings] = useState<InvoiceReminderSettings | null>(null);
  const [rates, setRates] = useState<Array<{ kind: 'consumer' | 'commercial'; rate_basis_points: number; valid_from: string; source_note: string | null }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    loadInvoiceReminderSettings(organizationId)
      .then(loaded => { if (!cancelled) setSettings(loaded); })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Debiteureninstellingen laden mislukt.'); });
    loadStatutoryInterestRates().then(r => { if (!cancelled) setRates(r); }).catch(() => {});
    return () => { cancelled = true; };
  }, [organizationId]);

  function update<K extends keyof InvoiceReminderSettings>(key: K, value: InvoiceReminderSettings[K]) {
    setSettings(prev => prev ? { ...prev, [key]: value } : prev);
    setMessage(null);
  }

  async function save() {
    if (!settings) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      await saveInvoiceDunningSettings(organizationId, {
        dunning_enabled: settings.dunning_enabled ?? false,
        dunning_offset_days: settings.dunning_offset_days ?? 30,
        dunning_collection_costs_vat: settings.dunning_collection_costs_vat ?? false,
      });
      setMessage('Debiteureninstellingen opgeslagen.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Debiteureninstellingen opslaan mislukt.');
    } finally {
      setBusy(false);
    }
  }

  const currentConsumer = rates.filter(r => r.kind === 'consumer')[0];
  const currentCommercial = rates.filter(r => r.kind === 'commercial')[0];
  const pct = (bp: number) => `${(bp / 100).toString().replace('.', ',')}%`;

  return <section className="settings-card organization-card billing-card">
    <div className="settings-card-head">
      <div>
        <h3>Debiteurenautomaat (aanmaningen)</h3>
        <p className="settings-help">Voor te late facturen die de herinneringen voorbij zijn: stel automatisch een formele aanmaning voor met wettelijke (handels)rente + WIK-incassokosten. De aanmaning wordt nooit vanzelf verstuurd — jij bevestigt hem eerst.</p>
      </div>
    </div>
    {message && <div className="success">{message}</div>}
    {error && <div className="error">{error}</div>}
    {!canAdmin ? <p className="settings-help">Alleen owners en admins kunnen de debiteureninstellingen aanpassen.</p>
      : !settings ? <p className="settings-help">Instellingen laden…</p>
      : <>
        <div className="billing-control-row">
          <div>
            <strong>Aanmaningen automatisch voorstellen</strong>
            <p className="settings-help">Staat dit uit, dan kun je nog steeds handmatig een aanmaning opstellen vanuit een factuur.</p>
          </div>
          <label className="settings-toggle"><input type="checkbox" checked={Boolean(settings.dunning_enabled)} onChange={e => update('dunning_enabled', e.target.checked)} /> {settings.dunning_enabled ? 'Aan' : 'Uit'}</label>
        </div>
        <div className="billing-control-row">
          <div>
            <strong>Aanmaning voorstellen na (dagen)</strong>
            <p className="settings-help">Aantal dagen ná de vervaldatum voordat een aanmaning wordt voorgesteld (bovenop de herinneringen).</p>
            <Input type="number" min={0} value={String(settings.dunning_offset_days ?? 30)} onChange={e => update('dunning_offset_days', clampReminderDays(e.target.value))} />
          </div>
        </div>
        <div className="billing-control-row">
          <div>
            <strong>Btw over incassokosten meesturen</strong>
            <p className="settings-help">Alleen aanzetten als je géén btw-aftrekrecht hebt (bijv. vrijgestelde diensten). Normaal gesproken uit laten.</p>
          </div>
          <label className="settings-toggle"><input type="checkbox" checked={Boolean(settings.dunning_collection_costs_vat)} onChange={e => update('dunning_collection_costs_vat', e.target.checked)} /> {settings.dunning_collection_costs_vat ? 'Aan' : 'Uit'}</label>
        </div>
        {(currentConsumer || currentCommercial) && <p className="settings-help">Actuele rentetarieven: wettelijke rente {currentConsumer ? pct(currentConsumer.rate_basis_points) : '—'} (consument) · handelsrente {currentCommercial ? pct(currentCommercial.rate_basis_points) : '—'} (zakelijk). Nationaal vastgesteld; verifieer bij twijfel bij de officiële bron.</p>}
        <Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Opslaan…' : 'Debiteurenautomaat opslaan'}</Button>
      </>}
  </section>;
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

// Klikpad per provider. Voor Microsoft staat er bewust "Omleiden", niet
// "Doorsturen": bij Doorsturen word jíj de afzender en is de klant achteraf niet
// meer te herkennen.
const FORWARDING_PROVIDERS: { id: string; label: string; steps: string[] }[] = [
  {
    id: 'gmail',
    label: 'Gmail / Google Workspace',
    steps: [
      'Open Gmail op je computer en klik rechtsboven op het tandwiel → “Alle instellingen bekijken”.',
      'Ga naar het tabblad “Doorsturen en POP/IMAP”.',
      'Klik op “Een doorstuuradres toevoegen” en plak het adres hierboven.',
      'Google stuurt een bevestigingscode. Die verschijnt hieronder zodra hij binnen is.',
      'Kies daarna “Een kopie van binnenkomende e-mail doorsturen” en bewaar de wijzigingen.',
    ],
  },
  {
    id: 'microsoft',
    label: 'Microsoft 365 / Outlook.com',
    steps: [
      'Open Outlook op het web en klik rechtsboven op het tandwiel.',
      'Ga naar “E-mail” → “Regels” en kies “Nieuwe regel toevoegen”.',
      'Voorwaarde: “Toegepast op alle berichten”.',
      'Actie: kies “Omleiden naar” — níét “Doorsturen naar”. Bij Doorsturen word jij de afzender en kunnen we de klant niet meer herkennen.',
      'Vul het adres hierboven in en bewaar de regel.',
    ],
  },
  {
    id: 'hosting',
    label: 'Eigen hosting (cPanel, Plesk, DirectAdmin)',
    steps: [
      'Log in op het beheerpaneel van je hostingpartij.',
      'Zoek naar “E-mail” → “Forwarders” of “Doorstuuradressen”.',
      'Maak een forwarder aan vanaf je eigen adres (bijvoorbeeld info@jouwdomein.nl).',
      'Zet als bestemming het adres hierboven.',
      'Kies, als je hosting die keuze biedt, “kopie bewaren in het postvak” zodat je zelf niets kwijtraakt.',
    ],
  },
];

function InboundForwardingCard({ organizationId, canAdmin }: { organizationId: string; canAdmin: boolean }) {
  const [alias, setAlias] = useState<OrganizationInboundAlias | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [provider, setProvider] = useState('gmail');
  const [forwardFrom, setForwardFrom] = useState('');

  const domain = 'inbound.resofly.com';
  const address = alias ? `${alias.local_part}@${domain}` : '';

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    loadInboundAlias(organizationId)
      .then(row => { if (!cancelled) { setAlias(row); setForwardFrom(row?.forward_from_email ?? ''); setLoaded(true); } })
      .catch(err => { if (!cancelled) { setError(err instanceof Error ? err.message : 'Doorstuuradres laden mislukt.'); setLoaded(true); } });
    return () => { cancelled = true; };
  }, [organizationId]);

  async function run(fn: () => Promise<OrganizationInboundAlias>, okMessage: string) {
    setBusy(true); setError(null); setMessage(null);
    try {
      const row = await fn();
      setAlias(row);
      setForwardFrom(row.forward_from_email ?? '');
      setMessage(okMessage);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Actie mislukt.');
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Kopiëren lukte niet. Selecteer het adres en kopieer het handmatig.');
    }
  }

  // Drie toestanden. Groen slaat om naar een waarschuwing na 14 dagen stilte:
  // providers zetten doorsturen uit na herhaalde afleverfouten, en dat merk je
  // anders pas als je een klant kwijt bent.
  const lastAgeDays = alias?.last_received_at
    ? (Date.now() - new Date(alias.last_received_at).getTime()) / 86400000
    : null;
  const status: 'none' | 'confirm' | 'ok' | 'stale' =
    alias?.pending_confirmation_code ? 'confirm'
    : lastAgeDays == null ? 'none'
    : lastAgeDays > 14 ? 'stale' : 'ok';

  const steps = FORWARDING_PROVIDERS.find(p => p.id === provider)?.steps ?? [];

  return <section className="settings-card organization-card inbound-alias-card">
    <div className="settings-card-head">
      <div>
        <h3>Mail aan je eigen adres opvangen</h3>
        <p className="settings-help">
          Stuurt een klant een mail rechtstreeks naar je eigen adres (bijvoorbeeld <code>info@jouwdomein.nl</code>)
          in plaats van te antwoorden op een bericht uit ResoFly? Stel dan bij je mailprovider een doorstuurregel
          in naar het adres hieronder. Die berichten komen dan vanzelf onder de juiste klant te staan.
          <strong> Je blijft alles gewoon in je eigen postvak ontvangen — er verdwijnt niets.</strong>
        </p>
      </div>
    </div>

    {message && <div className="success">{message}</div>}
    {error && <div className="error">{error}</div>}

    {!canAdmin ? <p className="settings-help">Alleen owners en admins beheren het doorstuuradres.</p>
      : !loaded ? <p className="settings-help">Doorstuuradres laden…</p>
      : !alias ? <>
          <p className="settings-help">Er is nog geen doorstuuradres aangemaakt voor deze organisatie.</p>
          <Button variant="primary" disabled={busy} onClick={() => run(() => ensureInboundAlias(organizationId), 'Doorstuuradres aangemaakt.')}>
            {busy ? 'Bezig…' : 'Maak mijn doorstuuradres aan'}
          </Button>
        </>
      : <>
        <div className="dns-record inbound-alias-address">
          <div className="dns-record-field grow">
            <span className="dns-record-label">Jouw doorstuuradres</span>
            <code className="dns-record-value">{address}</code>
          </div>
          <Button onClick={copy}>{copied ? 'Gekopieerd' : 'Kopieer'}</Button>
        </div>

        <div className={`inbound-status inbound-status-${status}`}>
          {status === 'none' && <>Nog niets binnengekomen op dit adres. Zet de doorstuurregel hieronder klaar en stuur daarna vanaf je telefoon een mailtje naar je eigen adres om het te testen.</>}
          {status === 'confirm' && <>
            Je provider vraagt eerst om een bevestiging. De code is <strong>{alias.pending_confirmation_code}</strong>.
            <span className="inbound-status-note">
              Deze code komt uit een binnengekomen e-mail. Controleer hem in je eigen postvak voordat je hem gebruikt —
              wij tonen bewust geen klikbare link.
            </span>
          </>}
          {status === 'ok' && <>Werkt. Laatste bericht binnengekomen op {new Date(alias.last_received_at!).toLocaleString('nl-NL')} ({alias.received_total} in totaal).</>}
          {status === 'stale' && <>Er kwam al ruim twee weken niets binnen op dit adres. Controleer of de doorstuurregel nog aanstaat — providers zetten die uit na herhaalde afleverfouten.</>}
        </div>

        <div className="settings-grid compact">
          <label>Welk adres stuur je door?
            <Input
              type="email"
              value={forwardFrom}
              onChange={e => { setForwardFrom(e.target.value); setError(null); setMessage(null); }}
              onBlur={() => {
                const value = forwardFrom.trim();
                if (!value || value === (alias.forward_from_email ?? '')) return;
                void run(() => setInboundAliasForwardFrom(organizationId, alias.id, value), 'Opgeslagen.');
              }}
              placeholder="info@jouwdomein.nl"
              disabled={busy}
            />
          </label>
          <label>Waar staat je mail?
            <Select value={provider} onChange={e => setProvider(e.target.value)}>
              {FORWARDING_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </Select>
          </label>
        </div>
        <p className="settings-help">
          We gebruiken je eigen adres om te herkennen dat een bericht via de doorstuurregel binnenkomt,
          en om te voorkomen dat je eigen post als klantmail wordt aangezien.
        </p>

        <ol className="inbound-steps">
          {steps.map((step, i) => <li key={i}>{step}</li>)}
        </ol>

        <div className="inbound-alias-actions">
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              if (!window.confirm('Een nieuw adres aanmaken? Je oude adres blijft nog 30 dagen werken, maar die berichten komen in de opvangbak in plaats van direct bij de klant. Vergeet niet je doorstuurregel aan te passen.')) return;
              void run(() => rotateInboundAlias(organizationId), 'Nieuw doorstuuradres aangemaakt. Pas je doorstuurregel aan.');
            }}
          >
            Nieuw adres aanmaken
          </Button>
        </div>
      </>}
  </section>;
}

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

function PersonalSenderCard({ organizationId }: { organizationId: string }) {
  const [loaded, setLoaded] = useState(false);
  const [fromName, setFromName] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [hasRow, setHasRow] = useState(false);
  const [verifiedDomains, setVerifiedDomains] = useState<string[]>([]);
  const [orgSender, setOrgSender] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    Promise.all([loadMySenderIdentity(organizationId), loadSendingDomains(organizationId)])
      .then(([identity, domains]: [UserSenderIdentity | null, SendingDomain[]]) => {
        if (cancelled) return;
        setFromName(identity?.from_name ?? '');
        setFromEmail(identity?.from_email ?? '');
        setHasRow(!!identity);
        setVerifiedDomains(domains.filter(d => d.status === 'verified').map(d => d.domain.toLowerCase()));
        const primary = domains.find(d => d.status === 'verified');
        setOrgSender(primary?.from_email ? (primary.from_name ? `${primary.from_name} <${primary.from_email}>` : primary.from_email) : null);
      })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Laden mislukt.'); })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [organizationId]);

  async function save() {
    const name = fromName.trim();
    const email = fromEmail.trim().toLowerCase();
    if (!name && !email) { setError('Vul minimaal een afzendernaam of afzenderadres in.'); return; }
    if (email) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError('Het afzenderadres is geen geldig e-mailadres.'); return; }
      const domain = email.slice(email.lastIndexOf('@') + 1);
      if (verifiedDomains.length === 0) {
        setError('Er is nog geen geverifieerd verzenddomein. Laat het adres leeg (alleen je naam wordt dan gebruikt) of koppel eerst een domein.');
        return;
      }
      if (!verifiedDomains.includes(domain)) {
        setError(`Het adres moet eindigen op een geverifieerd domein: ${verifiedDomains.map(d => `@${d}`).join(', ')}.`);
        return;
      }
    }
    setBusy(true); setError(null); setMessage(null);
    try {
      await saveMySenderIdentity(organizationId, { from_name: name || null, from_email: email || null });
      setHasRow(true);
      setMessage('Persoonlijke afzender opgeslagen.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Opslaan mislukt.');
    } finally { setBusy(false); }
  }

  async function clear() {
    setBusy(true); setError(null); setMessage(null);
    try {
      await clearMySenderIdentity(organizationId);
      setFromName(''); setFromEmail(''); setHasRow(false);
      setMessage('Persoonlijke afzender verwijderd; je mailt weer als de organisatie.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verwijderen mislukt.');
    } finally { setBusy(false); }
  }

  // Preview spiegelt het echte servergedrag: een persoonlijke From ontstaat alleen
  // wanneer er een concreet adres is (persoonlijk óf van het org-domein).
  const orgEmail = orgSender ? (orgSender.includes('<') ? orgSender.slice(orgSender.lastIndexOf('<') + 1, orgSender.lastIndexOf('>')) : orgSender) : null;
  const effectiveEmail = fromEmail.trim().toLowerCase() || orgEmail;
  const preview = effectiveEmail && (fromName.trim() || fromEmail.trim())
    ? (fromName.trim() ? `${fromName.trim()} <${effectiveEmail}>` : effectiveEmail)
    : null;

  return <section className="settings-card organization-card">
    <div className="settings-card-head">
      <div>
        <h3>Persoonlijke afzender</h3>
        <p className="settings-help">Verstuur klant-mails en campagnes onder je eigen naam, bijvoorbeeld <code>Jan de Vries &lt;jan@jouwdomein.nl&gt;</code>. Dit geldt alleen voor mails die jíj verstuurt (of campagnes/stromen die jij aanmaakt); collega's stellen hun eigen afzender in. Werkt zodra je organisatie een geverifieerd verzenddomein heeft; een eigen adres moet daar dan op eindigen.</p>
      </div>
    </div>

    {message && <div className="success">{message}</div>}
    {error && <div className="error">{error}</div>}

    {!loaded ? <p className="settings-help">Laden…</p> : <>
      {verifiedDomains.length === 0 && <p className="settings-help">Je organisatie heeft nog geen geverifieerd verzenddomein. Koppel en verifieer er hierboven eerst een — tot die tijd wordt een persoonlijke afzender <strong>niet</strong> toegepast en gaat alle mail via het standaardadres.</p>}
      <div className="settings-grid compact">
        <label>Jouw afzendernaam
          <Input value={fromName} onChange={e => { setFromName(e.target.value); setError(null); setMessage(null); }} placeholder="Jan de Vries" />
        </label>
        <label>Jouw afzenderadres (optioneel)
          <Input type="email" value={fromEmail} onChange={e => { setFromEmail(e.target.value); setError(null); setMessage(null); }} placeholder={verifiedDomains.length > 0 ? `jan@${verifiedDomains[0]}` : 'eerst een domein koppelen'} disabled={verifiedDomains.length === 0} />
        </label>
      </div>
      {preview && <p className="settings-help">Jouw mails worden verstuurd als: <strong>{preview}</strong></p>}
      {!preview && verifiedDomains.length > 0 && (fromName.trim() || fromEmail.trim()) && <p className="settings-help">Let op: je verzenddomein heeft nog geen afzenderadres ingesteld, dus je persoonlijke afzender wordt nog niet toegepast. Vul hierboven bij het domein een afzenderadres in.</p>}
      {!preview && !fromName.trim() && !fromEmail.trim() && orgSender && <p className="settings-help">Zonder persoonlijke afzender mail je als: <strong>{orgSender}</strong></p>}
      <div className="settings-actions-row">
        <Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Bezig…' : 'Opslaan'}</Button>
        {hasRow && <Button variant="danger" onClick={clear} disabled={busy}>Verwijderen</Button>}
      </div>
    </>}
  </section>;
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
            <p className="email-preview-structural">— Hier vult ResoFly automatisch {meta.group === 'booking'
              ? 'de gekozen tijden, de videocall-link en je begeleidende tekst'
              : meta.group === 'bestanden'
                ? 'het overzicht in: wat er is gedeeld, jouw bericht en tot wanneer de link geldig is'
                : `het overzicht in: bedrag, datums${meta.group === 'offerte' ? ' en geldigheid' : ''}`}.</p>
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
  data,
  organizationId,
  canWrite,
  onChanged,
  organizationContext,
  currentUserId,
  push,
  settingsNav = null,
  calendarSettings = null,
  onCreateOrganization,
  onSwitchOrganization,
  onInviteMember,
  onAcceptInvitation,
  onUpdateMemberRole,
  onSetMemberModuleAccess,
  onDisableMember,
  onRevokeInvitation,
  onSave,
}: {
  settings: CompanySettings | null;
  data: AppData;
  organizationId: string;
  canWrite: boolean;
  onChanged: () => void | Promise<void>;
  organizationContext: OrganizationContext;
  currentUserId: string | null;
  push: PushApi;
  settingsNav?: { tab: SettingsTab; key: number } | null;
  /** De agenda-instellingen (koppelingen, eigen agenda's, telefoon-sync) wonen
   *  hier als tabblad in plaats van als eigen pagina onder Agenda. De pagina
   *  zelf komt uit CalendarPage; is dit leeg, dan staat de agenda-module dicht
   *  voor dit teamlid en verdwijnt het tabblad. */
  calendarSettings?: ReactNode;
  onCreateOrganization: () => void;
  onSwitchOrganization: (organizationId: string) => void;
  onInviteMember: (email: string, role: OrganizationRole, moduleAccess: ModuleAccess) => Promise<{ emailSent: boolean; emailError?: string }>;
  onAcceptInvitation: (invitationId: string) => Promise<void>;
  onUpdateMemberRole: (memberId: string, role: OrganizationRole) => Promise<void>;
  onSetMemberModuleAccess: (memberId: string, moduleAccess: ModuleAccess) => Promise<void>;
  onDisableMember: (memberId: string) => Promise<void>;
  onRevokeInvitation: (invitationId: string) => Promise<void>;
  onSave: (settings: CompanySettingsInput) => Promise<void>;
}) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(settingsNav?.tab ?? 'organisatie');
  // Elke keer dat het account-menu naar een instellingen-sectie navigeert (nieuwe
  // `key`, ook bij dezelfde tab) springt de instellingenpagina naar die tab.
  useEffect(() => { if (settingsNav) setActiveTab(settingsNav.tab); }, [settingsNav]);
  const [form, setForm] = useState<CompanySettingsInput>(() => settingsToForm(settings));
  const [message, setMessage] = useState<string | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<OrganizationRole>('member');
  // Modulerechten voor de uit te nodigen medewerker. Leeg = overal volledige
  // toegang; de owner zet gericht modules dicht vóór het versturen.
  const [inviteAccess, setInviteAccess] = useState<ModuleAccess>({});
  const [inviteAccessOpen, setInviteAccessOpen] = useState(false);
  // Welk teamlid heeft zijn rechtenpaneel openstaan, en de nog niet opgeslagen wijziging.
  const [accessMemberId, setAccessMemberId] = useState<string | null>(null);
  const [accessDraft, setAccessDraft] = useState<ModuleAccess>({});
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
  // Creatieve module aanvinken bij de aanschaf; pas actief zodra er betaald is.
  const [selectedCreative, setSelectedCreative] = useState(false);
  const [pendingChange, setPendingChange] = useState<PendingBillingChange | null>(null);
  const [confirmingChange, setConfirmingChange] = useState(false);
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
  // AI-gebruik is er alleen voor owners/admins, het agenda-tabblad alleen als de
  // agenda-module openstaat. Landt iemand toch op een tabblad dat er voor hem
  // niet is (onthouden keuze, wissel van organisatie), dan valt hij terug op het
  // eerste tabblad in plaats van op een lege pagina te staren.
  const hasCalendarSettings = Boolean(calendarSettings);
  const visibleTabs = SETTINGS_TABS.filter(tab => {
    if (tab.id === 'ai') return canAdminOrganization;
    if (tab.id === 'agenda') return hasCalendarSettings;
    return true;
  });
  useEffect(() => {
    if (activeTab === 'ai' && !canAdminOrganization) setActiveTab('organisatie');
    if (activeTab === 'agenda' && !hasCalendarSettings) setActiveTab('organisatie');
  }, [activeTab, canAdminOrganization, hasCalendarSettings]);
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
  const billingIntervalUnit = billingOverview?.billing_interval === 'year' ? 'jaar' : 'maand';
  const currentSeatCents = billingOverview ? (billingOverview.billing_interval === 'year' ? billingOverview.extra_seat_yearly_price_cents : billingOverview.extra_seat_price_cents) : 0;
  // Opslagbundels (accountbrede opslag) tellen mee in het huidige periodebedrag.
  const currentStorageAddons = billingOverview?.storage_addons ?? 0;
  const currentStorageCents = billingOverview
    ? (billingOverview.billing_interval === 'year' ? (billingOverview.storage_addon_yearly_price_cents ?? 0) : (billingOverview.storage_addon_price_cents ?? 0))
    : 0;
  // Creatieve module (galerij-oplevering): inbegrepen bij custom/vrijgesteld,
  // anders een losse post op het abonnementsbedrag.
  // Zakelijke module: de status komt uit een eigen RPC (organization_business_status),
  // niet uit het billingoverzicht, omdat ook niet-admins moeten weten of de
  // fiscale schermen er horen te zijn.
  const businessStatus = organizationContext.businessStatus;
  const businessIncluded = businessStatus?.included_in_plan ?? false;
  const businessEnabled = businessStatus?.enabled ?? false;
  const businessActive = businessStatus?.active ?? false;
  const businessGraceUntil = businessStatus?.grace_until ?? null;

  const creativeIncluded = billingOverview?.creative_included_in_plan ?? false;
  const creativeEnabled = billingOverview?.creative_enabled ?? false;
  const creativeActive = billingOverview?.creative_active ?? creativeIncluded;
  const creativeGraceUntil = billingOverview?.creative_grace_until ?? null;
  const currentCreativeCents = billingOverview
    ? (billingOverview.billing_interval === 'year' ? (billingOverview.creative_addon_yearly_price_cents ?? 0) : (billingOverview.creative_addon_price_cents ?? 0))
    : 0;
  const currentBusinessCents = businessStatus
    ? (businessStatus.billing_interval === 'year' ? businessStatus.addon_yearly_price_cents : businessStatus.addon_price_cents)
    : 0;
  const currentEntityCents = businessStatus
    ? (businessStatus.billing_interval === 'year' ? businessStatus.entity_addon_yearly_price_cents : businessStatus.entity_addon_price_cents)
    : 0;
  const currentCostCents = billingOverview
    ? (billingOverview.billing_interval === 'year' ? billingOverview.yearly_price_cents : billingOverview.monthly_price_cents)
      + billingOverview.purchased_seats * currentSeatCents
      + currentStorageAddons * currentStorageCents
      + (creativeEnabled && !creativeIncluded ? currentCreativeCents : 0)
      + (businessEnabled && !businessIncluded ? currentBusinessCents : 0)
    : 0;
  const storageUsedBytes = billingOverview?.storage_used_bytes ?? 0;
  const storageLimitGb = billingOverview?.storage_limit_gb ?? null;
  const storageUsedGb = storageUsedBytes / 1073741824;
  const storagePct = storageLimitGb != null && storageLimitGb > 0 ? Math.min(100, (storageUsedGb / storageLimitGb) * 100) : null;

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
      const invitedEmail = inviteEmail.trim();
      const result = await onInviteMember(inviteEmail, inviteRole, inviteAccess);
      setInviteEmail('');
      setInviteAccess({});
      setInviteAccessOpen(false);
      const seatNote = isBillingExempt
        ? 'Deze organisatie is intern/onbeperkt, dus er gelden geen seat-limieten.'
        : 'Er is één gebruikerslicentie gereserveerd totdat de uitnodiging wordt geaccepteerd of ingetrokken.';
      if (result.emailSent) {
        setOrgMessage(`Uitnodiging verstuurd naar ${invitedEmail}. ${seatNote}`);
      } else {
        // Uitnodiging staat wél in de database, alleen de e-mail mislukte. Dat
        // eerlijk melden i.p.v. valse "verstuurd", met een werkbaar alternatief.
        setOrgError(`Uitnodiging aangemaakt, maar de e-mail naar ${invitedEmail} kon niet worden verzonden${result.emailError ? ` (${result.emailError})` : ''}. Controleer de mailinstellingen bij Instellingen → E-mail. Het teamlid kan ondertussen ook zelf inloggen met dit e-mailadres om de uitnodiging te accepteren. ${seatNote}`);
      }
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

  function toggleAccessPanel(member: OrganizationMember) {
    setOrgMessage(null);
    setOrgError(null);
    if (accessMemberId === member.id) { setAccessMemberId(null); return; }
    setAccessMemberId(member.id);
    setAccessDraft(parseModuleAccess(member.module_access));
  }

  async function saveMemberAccess(memberId: string) {
    setOrgMessage(null);
    setOrgError(null);
    setBusyMemberId(memberId);
    try {
      await onSetMemberModuleAccess(memberId, accessDraft);
      setAccessMemberId(null);
      setOrgMessage('Modulerechten opgeslagen. Het teamlid ziet de wijziging zodra het de pagina ververst.');
    } catch (error) {
      setOrgError(error instanceof Error ? error.message : 'Modulerechten opslaan mislukt.');
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
      const result = await startSubscriptionCheckout(activeOrganization.id, selectedPlan, selectedInterval, selectedCreative);
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

  async function buyStorageAddon() {
    if (!activeOrganization || !canAdminOrganization) return;
    setBillingBusy('storage');
    setBillingError(null);
    setBillingMessage(null);
    try {
      await createStorageAddonCheckout(activeOrganization.id, 1);
      await refreshBilling();
      setBillingMessage('Opslagbundel toegevoegd. Het abonnementsbedrag is aangepast en de extra opslag is direct beschikbaar.');
    } catch (error) {
      setBillingError(error instanceof Error ? error.message : 'Opslagbundel toevoegen mislukt.');
    } finally {
      setBillingBusy(null);
    }
  }

  async function toggleCreative(enabled: boolean) {
    if (!activeOrganization || !canAdminOrganization) return;
    setBillingBusy('creative');
    setBillingError(null);
    setBillingMessage(null);
    try {
      await setCreativeAddon(activeOrganization.id, enabled);
      await refreshBilling();
      // Ook de app-brede context verversen: het galerij-tabblad bij projecten
      // hangt aan organizationContext.creativeStatus, niet aan dit scherm.
      await onChanged();
      setBillingMessage(enabled
        ? 'Creatieve module aangezet. Het galerij-tabblad staat vanaf nu bij elk project.'
        : 'Creatieve module uitgezet. Je kunt niets meer toevoegen; al gedeelde galerijen blijven nog 30 dagen bereikbaar.');
    } catch (error) {
      setBillingError(error instanceof Error ? error.message : 'Creatieve module wijzigen mislukt.');
    } finally {
      setBillingBusy(null);
    }
  }

  function requestToggleCreative(enabled: boolean) {
    if (!activeOrganization || !canAdminOrganization || !billingOverview) return;
    setBillingError(null);
    setBillingMessage(null);
    setPendingChange({
      title: enabled ? 'Creatieve module aanzetten' : 'Creatieve module uitzetten',
      description: enabled
        ? `Je voegt de creatieve module toe aan het ${billingOverview.plan_name}-abonnement. Daarmee krijgt elk project een galerij: foto's en video's opleveren aan je klant via het portaal of een deellink.`
        : 'Je zet de creatieve module uit. Er kan meteen niets meer worden toegevoegd, gewijzigd of gepubliceerd. Bestaande galerijen blijf je zien en kun je opruimen, en al gedeelde links en het klantportaal blijven nog 30 dagen werken.',
      currentCostCents,
      newCostCents: enabled ? currentCostCents + currentCreativeCents : Math.max(0, currentCostCents - currentCreativeCents),
      intervalUnit: billingIntervalUnit,
      currency: billingOverview.currency,
      execute: () => toggleCreative(enabled),
    });
  }

  async function toggleBusiness(enabled: boolean) {
    if (!activeOrganization || !canAdminOrganization) return;
    setBillingBusy('business');
    setBillingError(null);
    setBillingMessage(null);
    try {
      await setBusinessAddon(activeOrganization.id, enabled);
      await refreshBilling();
      // Ook de app-brede context verversen: de rechtsvorm-afhankelijke schermen
      // en de knop "+ administratie" hangen aan organizationContext.businessStatus.
      await onChanged();
      setBillingMessage(enabled
        ? 'Zakelijke module aangezet. Je kunt nu een rechtsvorm kiezen en extra administraties toevoegen.'
        : 'Zakelijke module uitgezet. Bestaande administraties blijven nog 30 dagen leesbaar.');
    } catch (error) {
      setBillingError(error instanceof Error ? error.message : 'Zakelijke module wijzigen mislukt.');
    } finally {
      setBillingBusy(null);
    }
  }

  function requestToggleBusiness(enabled: boolean) {
    if (!activeOrganization || !canAdminOrganization || !billingOverview) return;
    setBillingError(null);
    setBillingMessage(null);
    setPendingChange({
      title: enabled ? 'Zakelijke module aanzetten' : 'Zakelijke module uitzetten',
      description: enabled
        ? `Je voegt de zakelijke module toe aan het ${billingOverview.plan_name}-abonnement: boekhouden voor een BV met het bijbehorende rekeningschema, vennootschapsbelasting en jaarrekening, plus meerdere administraties naast elkaar (holding en werk-BV).`
        : 'Je zet de zakelijke module uit. Bestaande administraties blijven nog 30 dagen leesbaar, maar je kunt er geen nieuwe meer aanmaken.',
      currentCostCents,
      newCostCents: enabled ? currentCostCents + currentBusinessCents : Math.max(0, currentCostCents - currentBusinessCents),
      intervalUnit: billingIntervalUnit,
      currency: billingOverview.currency,
      execute: () => toggleBusiness(enabled),
    });
  }

  function requestBuyStorageAddon() {
    if (!activeOrganization || !canAdminOrganization || !billingOverview) return;
    const addonGb = billingOverview.storage_addon_gb ?? 100;
    setBillingError(null);
    setBillingMessage(null);
    setPendingChange({
      title: 'Opslagbundel bijkopen',
      description: `Je voegt een opslagbundel van ${addonGb} GB toe aan het ${billingOverview.plan_name}-abonnement. De opslag geldt voor je hele account (galerijen, bestanden en bijlagen samen) en is direct beschikbaar.`,
      currentCostCents,
      newCostCents: currentCostCents + currentStorageCents,
      intervalUnit: billingIntervalUnit,
      currency: billingOverview.currency,
      execute: buyStorageAddon,
    });
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
      setBillingMessage('Plan gewijzigd. Het bedrag van je abonnement is aangepast.');
    } catch (error) {
      setBillingError(error instanceof Error ? error.message : 'Plan wijzigen mislukt.');
    } finally {
      setBillingBusy(null);
    }
  }

  // Opent de bevestigings-popup voor een directe wijziging op een lopend abonnement.
  function requestBuyExtraSeat() {
    if (!activeOrganization || !canAdminOrganization || !billingOverview) return;
    setBillingError(null);
    setBillingMessage(null);
    setPendingChange({
      title: 'Extra gebruiker toevoegen',
      description: `Je voegt 1 extra gebruiker toe aan het ${billingOverview.plan_name}-abonnement. De seat wordt direct beschikbaar en het abonnementsbedrag wordt aangepast.`,
      currentCostCents,
      newCostCents: currentCostCents + currentSeatCents,
      intervalUnit: billingIntervalUnit,
      currency: billingOverview.currency,
      execute: buyExtraSeat,
    });
  }

  function requestChangePlan() {
    if (!activeOrganization || !canAdminOrganization || !selectedPlan) return;
    if (!selectedPlanIsSelfService) {
      setBillingError('Dit plan kan niet via self-service worden gewijzigd. Kies Starter, Team of Pro.');
      return;
    }
    // Nog geen lopend abonnement → meteen naar de Mollie-checkout; dat is zelf de bevestiging.
    if (!hasMollieSubscription) { void startSubscription(); return; }
    if (!billingOverview || !selectedPlanObj) return;
    setBillingError(null);
    setBillingMessage(null);
    setPendingChange({
      title: 'Plan wijzigen',
      description: `Je wijzigt je abonnement van ${billingOverview.plan_name} naar ${selectedPlanObj.name}. De wijziging gaat direct in; je blijft ${billingOverview.billing_interval === 'year' ? 'jaarlijks' : 'maandelijks'} betalen.`,
      currentCostCents,
      newCostCents: planCostCents(selectedPlanObj, billingOverview.purchased_seats, billingOverview.billing_interval, currentStorageAddons, creativeEnabled && !creativeIncluded),
      intervalUnit: billingIntervalUnit,
      currency: billingOverview.currency,
      execute: changePlan,
    });
  }

  async function confirmPendingChange() {
    if (!pendingChange) return;
    setConfirmingChange(true);
    try {
      await pendingChange.execute();
    } finally {
      setConfirmingChange(false);
      setPendingChange(null);
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
      {visibleTabs.map(tab => (
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
          <h3>Rollen en modulerechten</h3>
          <p className="settings-help">Owner = volledig beheer. Admin = organisatie-instellingen en uitnodigingen. Member = werken in CRM/projecten. Viewer = alleen lezen. Per member of viewer stel je daarnaast met <strong>Rechten</strong> in welke modules diegene ziet — bijvoorbeeld wél projecten en uren, maar geen financiën. Owners en admins houden altijd toegang tot alles. Owners zijn bovendien tegen elkaar beschermd: geen enkele owner kan een andere owner degraderen, uitschakelen of verwijderen.</p>
        </div>
      </div>

      <div className="team-list">
        <strong>Actieve teamleden</strong>
        {organizationContext.teamMembers.map(member => {
          const isSelf = member.user_id === currentUserId;
          const isLastOwner = member.role === 'owner' && activeOwnerCount <= 1;
          // Owners zijn tegen elkaar beschermd: een andere owner kun je niet
          // degraderen of uitschakelen (de database blokkeert het ook).
          const isPeerOwner = member.role === 'owner' && !isSelf;
          const roleLocked = !canManageRoles || isSelf || isLastOwner || isPeerOwner || busyMemberId === member.id;
          // Rechten instellen mag een admin voor members/viewers; alleen een owner
          // mag ook een admin beperken (die beperking gaat pas gelden na degradatie).
          const canEditAccess = canAdminOrganization && member.role !== 'owner'
            && (member.role !== 'admin' || canManageRoles) && busyMemberId !== member.id;
          const accessOpen = accessMemberId === member.id;
          return <div key={member.id}>
            <div className="team-row role-row">
              <div>
                <span>{member.email ?? member.user_id}</span>
                <small>{isSelf ? 'Jijzelf · ' : ''}{ROLE_LABELS[member.role]}{isLastOwner ? ' · laatste owner' : isPeerOwner ? ' · beschermd' : ''} · {moduleAccessSummary(member.role, member.module_access)}</small>
              </div>
              <Select value={member.role} disabled={roleLocked} onChange={event => changeRole(member.id, event.target.value as OrganizationRole)}>
                <option value="owner">Owner</option>
                <option value="admin">Admin</option>
                <option value="member">Member</option>
                <option value="viewer">Viewer</option>
              </Select>
              <Button disabled={!canEditAccess} onClick={() => toggleAccessPanel(member)} aria-expanded={accessOpen}>{accessOpen ? 'Sluiten' : 'Rechten'}</Button>
              <Button variant="danger" disabled={!canManageRoles || isSelf || isLastOwner || isPeerOwner || busyMemberId === member.id} onClick={() => disableMember(member.id)}>Uitschakelen</Button>
            </div>

            {accessOpen && <div className="settings-card">
              <p className="settings-help">Wat mag <strong>{member.email ?? 'dit teamlid'}</strong> per module? “Geen toegang” laat de module volledig uit het menu verdwijnen; de gegevens zijn dan ook via de database niet op te vragen.{member.role === 'viewer' && ' Een viewer kan sowieso nergens wijzigen, dus hier kies je alleen tussen lezen en verbergen.'}{member.role === 'admin' && ' Let op: als admin houdt dit teamlid nu nog toegang tot alles — deze instelling gaat pas gelden zodra je de rol naar member of viewer zet.'}</p>
              <ModuleAccessGrid value={accessDraft} onChange={setAccessDraft} disabled={busyMemberId === member.id} readOnlyCap={member.role === 'viewer'} />
              <div className="invite-row">
                <Button onClick={() => setAccessDraft({})} disabled={busyMemberId === member.id}>Alles openzetten</Button>
                <Button onClick={() => setAccessDraft(Object.fromEntries(MODULES.map(m => [m.key, 'none'])) as ModuleAccess)} disabled={busyMemberId === member.id}>Alles dichtzetten</Button>
                <Button variant="primary" onClick={() => saveMemberAccess(member.id)} disabled={busyMemberId === member.id}>{busyMemberId === member.id ? 'Opslaan…' : 'Rechten opslaan'}</Button>
              </div>
            </div>}
          </div>;
        })}
        {organizationContext.teamMembers.length === 0 && <p className="settings-help">Nog geen teamleden gevonden.</p>}
      </div>

      {canAdminOrganization ? <>
        <div className="invite-row">
          <Input type="email" value={inviteEmail} onChange={event => setInviteEmail(event.target.value)} placeholder="teamlid@bedrijf.nl" />
          <Select value={inviteRole} onChange={event => setInviteRole(event.target.value as OrganizationRole)}>
            <option value="admin">Admin</option>
            <option value="member">Member</option>
            <option value="viewer">Viewer</option>
          </Select>
          <Button onClick={() => setInviteAccessOpen(open => !open)} aria-expanded={inviteAccessOpen}>Modulerechten</Button>
          <Button variant="primary" onClick={inviteMember} disabled={inviteDisabled}>Uitnodigen</Button>
        </div>

        {inviteAccessOpen && (inviteRole === 'admin'
          ? <p className="settings-help">Een admin heeft altijd toegang tot alle modules. Kies rol <strong>Member</strong> of <strong>Viewer</strong> als je de nieuwe medewerker per module wilt beperken.</p>
          : <div className="settings-card">
              <p className="settings-help">Wat mag deze nieuwe medewerker straks zien? Standaard staat alles open; zet hier gericht modules dicht. Je kunt dit na het accepteren altijd nog aanpassen via <strong>Rechten</strong> bij het teamlid.</p>
              <ModuleAccessGrid value={inviteAccess} onChange={setInviteAccess} readOnlyCap={inviteRole === 'viewer'} />
            </div>)}
      </> : <p className="settings-help">Alleen owners en admins kunnen teamleden uitnodigen.</p>}

      {isBillingExempt && canAdminOrganization && <p className="settings-help">Deze organisatie is <strong>intern/onbeperkt</strong> — je kunt zonder seat-limiet teamleden uitnodigen.</p>}
      {!isBillingExempt && !hasAvailableLicense && <p className="settings-help">Er zijn geen vrije licenties meer. Trek een openstaande uitnodiging in, schakel een teamlid uit of laat billing eerst extra seats synchroniseren.</p>}

      {organizationContext.organizationInvitations.length > 0 && <div className="team-list">
        <strong>Openstaande teamuitnodigingen</strong>
        {organizationContext.organizationInvitations.map(invitation => <div className="team-row" key={invitation.id}>
          <div><span>{invitation.email}</span><small>{ROLE_LABELS[invitation.role]} · {moduleAccessSummary(invitation.role, invitation.module_access)} · verloopt {formatDate(invitation.expires_at)}</small></div>
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

    {activeTab === 'sjablonen' && <div className="settings-tab-panel">
      <ProjectTemplatesManager data={data} organizationId={organizationId} canWrite={canWrite} onChanged={onChanged} />
    </div>}

    {activeTab === 'klantvelden' && <div className="settings-tab-panel">
      <ClientFieldsManager data={data} organizationId={organizationId} canWrite={canWrite} onChanged={onChanged} />
    </div>}

    {activeTab === 'meldingen' && <div className="settings-tab-panel">
      <PushNotificationsCard api={push} />
    </div>}

    {activeTab === 'agenda' && hasCalendarSettings && <div className="settings-tab-panel settings-tab-panel-calendar">
      {calendarSettings}
    </div>}

    {activeTab === 'huisstijl' && <div className="settings-tab-panel">
      <div className="settings-save-bar">
        <p className="settings-help">Zo ziet je klant de galerij: je eigen logo, je eigen accentkleur en je eigen afsluiting. Opslaan is nodig voordat het live staat.</p>
        <Button variant="primary" onClick={save} disabled={isSaving || !canAdminOrganization}>{isSaving ? 'Opslaan…' : 'Opslaan'}</Button>
      </div>
      {message && <div className="success">{message}</div>}
      <BrandingCard form={form} setForm={setForm} canWrite={canAdminOrganization} />
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
        {/* Rechtsvorm stuurt het rekeningschema, de resultaatbestemming en welke
            fiscale schermen zichtbaar zijn (urencriterium bij IB, Vpb bij een BV).
            De Vpb-rechtsvormen hangen aan de zakelijke module: de database weigert
            de overgang zonder die module, dus zetten we ze hier ook niet in de
            lijst. Staat de rechtsvorm er al op en verloopt de module, dan blijft
            de huidige waarde gewoon kiesbaar — anders kan de klant zijn eigen
            bedrijfsgegevens niet meer opslaan. */}
        <select
          className="form-select"
          value={form.legal_form ?? 'eenmanszaak'}
          onChange={e=>set('legal_form', e.target.value as LegalForm)}
          title={businessActive
            ? 'Rechtsvorm — bepaalt het rekeningschema en welke fiscale schermen je ziet'
            : 'BV, NV en coöperatie horen bij de zakelijke module (Instellingen → Abonnement)'}
        >
          {(Object.keys(LEGAL_FORM_LABELS) as LegalForm[])
            .filter(key => businessActive
              || !BUSINESS_LEGAL_FORMS.includes(key)
              || key === (form.legal_form ?? 'eenmanszaak'))
            .map(key => <option key={key} value={key}>{LEGAL_FORM_LABELS[key]}</option>)}
        </select>
        {/* Merknaam wordt bij Huisstijl beheerd; hier alleen tonen. */}
        <Input value={form.trade_name ?? ''} readOnly disabled placeholder="Merknaam — in te stellen bij Huisstijl" title="Je merknaam staat bij Instellingen → Huisstijl" />
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
          {/* De accentkleur is de merkkleur en heeft één bewerkplek: Huisstijl.
              Hier alleen tonen wat je krijgt, zodat het voorbeeld klopt. */}
          <div className="color-setting">
            <span className="style-label">Merkkleur</span>
            <div className="color-input-pair brand-locked">
              <span className="brand-locked-dot" style={{ background: form.brand_accent_color || '#FFD966' }} aria-hidden="true" />
              <span className="brand-locked-value">{form.brand_accent_color || '#FFD966'}</span>
              <button type="button" className="gal-linkbtn" onClick={() => setActiveTab('huisstijl')}>
                Wijzigen bij Huisstijl
              </button>
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
            <div className="invoice-preview-accent-bar" style={{ background: form.brand_accent_color ?? '#FFD966' }} />
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
              <div style={{ height: 1.5, background: form.brand_accent_color ?? '#FFD966', margin: '6px 0' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>Werkzaamheden Q1 2025</span>
                <span style={{ fontWeight: 600 }}>EUR 1.000,00</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', opacity: 0.5, fontSize: `${Math.max(7, (form.invoice_font_size ?? 10) - 1)}px` }}>
                <span>BTW 21%</span>
                <span>EUR 210,00</span>
              </div>
              <div style={{ borderTop: `1.5px solid ${form.brand_accent_color ?? '#FFD966'}`, marginTop: 6, paddingTop: 6, display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: `${(form.invoice_font_size ?? 10) + 2}px` }}>
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
      <p className="settings-help">De boekhoud-startdatum is de knipdatum vanaf wanneer het grootboek leidend is: verkoopfacturen van vóór deze datum worden niet meer naar het grootboek geboekt (die stand zit in je beginbalans). Kies bij voorkeur een kwartaal- of jaargrens. Met de KOR-regeling wordt geen BTW in rekening gebracht en is voorbelasting niet aftrekbaar. De boekjaar-startmaand bepaalt de jaargrens (gebruik januari voor een gewoon kalenderjaar, een andere maand voor een gebroken boekjaar). Bij een jaarafsluiting wordt het resultaat op de gekozen resultaatrekening geboekt.</p>
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
        <label className="bk-setting-field"><span>Boekjaar begint in</span>
          <select className="form-select" value={form.fiscal_year_start_month ?? 1} onChange={e=>set('fiscal_year_start_month', Number(e.target.value))} disabled={!canAdminOrganization}>
            {['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'].map((m, i) => <option key={m} value={i + 1}>{m[0].toUpperCase() + m.slice(1)}</option>)}
          </select>
        </label>
        <label className="bk-setting-field"><span>Jaarresultaat boeken op</span>
          <select className="form-select" value={form.year_result_account_code ?? '0510'} onChange={e=>set('year_result_account_code', e.target.value)} disabled={!canAdminOrganization}>
            <option value="0510">0510 · Onverdeeld resultaat</option>
            <option value="0500">0500 · Eigen vermogen</option>
          </select>
        </label>
        <label className="bk-setting-field"><span>Standaard uurtarief (€)</span>
          <Input type="number" min="0" step="0.01"
            value={form.default_hourly_rate_cents != null ? String(form.default_hourly_rate_cents / 100) : ''}
            onChange={e => {
              const v = e.target.value.replace(',', '.').trim();
              set('default_hourly_rate_cents', v === '' ? null : Math.max(0, Math.round(Number(v) * 100)));
            }}
            placeholder="Geen tarief" disabled={!canAdminOrganization} />
        </label>
        <label className="bk-setting-check">
          <input type="checkbox" checked={Boolean(form.kor_enabled)} onChange={e=>set('kor_enabled', e.target.checked)} disabled={!canAdminOrganization} />
          <span>KOR (kleineondernemersregeling) actief</span>
        </label>
      </div>
      <p className="settings-help">Het standaard uurtarief wordt gebruikt om de declarabele waarde van geregistreerde uren te berekenen wanneer een project geen eigen tarief heeft.</p>
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
    {activeOrganization && <DunningSettingsCard organizationId={activeOrganization.id} canAdmin={canAdminOrganization} />}
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

        {hasMollieSubscription && <p className="settings-help billing-current-cost">
          Je betaalt momenteel <strong>{formatEur(currentCostCents, billingOverview.currency)}</strong> per {billingIntervalUnit}
          {billingOverview.purchased_seats > 0
            ? ` — ${billingOverview.plan_name} + ${billingOverview.purchased_seats} extra ${billingOverview.purchased_seats === 1 ? 'gebruiker' : 'gebruikers'}.`
            : ` — ${billingOverview.plan_name}.`}
        </p>}

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
          <Button variant="primary" onClick={requestBuyExtraSeat} disabled={billingBusy === 'seat' || !hasMollieSubscription}>{billingBusy === 'seat' ? 'Bezig…' : 'Extra gebruiker toevoegen'}</Button>
        </div>}

        {/* ── Creatieve module (galerij-oplevering) ── */}
        <div className="billing-control-row">
          <div>
            <strong>Creatieve module</strong>
            <p className="settings-help">
              Galerij-oplevering bij elk project: foto's en video's in volle resolutie naar je klant, via het portaal of een deellink met pincode, inclusief favorieten en downloaden.
              {creativeIncluded
                ? ' Inbegrepen bij dit abonnement.'
                : creativeEnabled
                  ? ` Actief · ${formatEur(currentCreativeCents, billingOverview.currency)} per ${billingIntervalUnit}.`
                  : ` ${formatEur(currentCreativeCents, billingOverview.currency)} per ${billingIntervalUnit}.`}
            </p>
            {!creativeActive && creativeGraceUntil && new Date(creativeGraceUntil) > new Date() && <p className="settings-help">
              Uitgezet: je kunt niets toevoegen of wijzigen. Al gedeelde galerijen blijven bereikbaar tot {new Date(creativeGraceUntil).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' })}.
            </p>}
          </div>
          {canAdminOrganization && !creativeIncluded && (
            <Button
              variant={creativeEnabled ? undefined : 'primary'}
              onClick={() => requestToggleCreative(!creativeEnabled)}
              disabled={billingBusy === 'creative' || (!creativeEnabled && (!hasMollieSubscription || currentCreativeCents <= 0))}
              title={!creativeEnabled && !hasMollieSubscription ? 'Start eerst een abonnement' : undefined}
            >
              {billingBusy === 'creative' ? 'Bezig…' : creativeEnabled ? 'Uitzetten' : 'Aanzetten'}
            </Button>
          )}
        </div>

        {/* ── Zakelijke module (BV-boekhouding, Vpb, jaarrekening) ── */}
        <div className="billing-control-row">
          <div>
            <strong>Zakelijke module</strong>
            <p className="settings-help">
              Boekhouden voor een BV: rekeningschema met aandelenkapitaal en reserves, vennootschapsbelasting, jaarrekening en publicatiestukken. Inclusief meerdere administraties naast elkaar, zoals een holding met een werk-BV.
              {businessIncluded
                ? ' Inbegrepen bij dit abonnement.'
                : businessEnabled
                  ? ` Actief · ${formatEur(currentBusinessCents, billingOverview.currency)} per ${billingIntervalUnit}.`
                  : ` ${formatEur(currentBusinessCents, billingOverview.currency)} per ${billingIntervalUnit}.`}
              {businessActive && currentEntityCents > 0 && ` Extra administratie: ${formatEur(currentEntityCents, billingOverview.currency)} per ${billingIntervalUnit}.`}
            </p>
            {businessActive && businessStatus && <p className="settings-help">
              {businessStatus.entity_count} administratie{businessStatus.entity_count === 1 ? '' : 's'} in gebruik{businessStatus.entity_allowance !== null ? ` van ${businessStatus.entity_allowance}` : ''}.
            </p>}
            {!businessActive && businessGraceUntil && new Date(businessGraceUntil) > new Date() && <p className="settings-help">
              Uitgezet: bestaande administraties blijven leesbaar tot {new Date(businessGraceUntil).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' })}.
            </p>}
          </div>
          {canAdminOrganization && !businessIncluded && (
            <Button
              variant={businessEnabled ? undefined : 'primary'}
              onClick={() => requestToggleBusiness(!businessEnabled)}
              disabled={billingBusy === 'business' || (!businessEnabled && (!hasMollieSubscription || currentBusinessCents <= 0))}
              title={!businessEnabled && !hasMollieSubscription ? 'Start eerst een abonnement' : undefined}
            >
              {billingBusy === 'business' ? 'Bezig…' : businessEnabled ? 'Uitzetten' : 'Aanzetten'}
            </Button>
          )}
        </div>

        {/* ── Accountbrede opslag (galerijen + bestanden + bijlagen) ── */}
        <div className="billing-control-row billing-storage-row">
          <div>
            <strong>Opslag</strong>
            <p className="settings-help">
              {storageUsedGb >= 0.05 ? `${storageUsedGb.toFixed(1)} GB in gebruik` : 'Vrijwel geen opslag in gebruik'}
              {storageLimitGb != null ? ` van ${storageLimitGb} GB` : isBillingExempt ? ' · geen limiet (interne organisatie)' : ' · geen limiet ingesteld'}
              {currentStorageAddons > 0 ? ` · ${currentStorageAddons} bundel${currentStorageAddons === 1 ? '' : 's'} bijgekocht` : ''}
            </p>
            {storagePct != null && <div className="billing-storage-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(storagePct)}>
              <div className={`billing-storage-fill${storagePct >= 90 ? ' warn' : ''}`} style={{ width: `${storagePct}%` }} />
            </div>}
            {storagePct != null && storagePct >= 90 && <p className="settings-help billing-storage-warn">Je opslag is bijna vol — nieuwe uploads worden geweigerd zodra de limiet is bereikt.</p>}
          </div>
          {canAdminOrganization && !isBillingExempt && storageLimitGb != null && (
            <Button
              variant={storagePct != null && storagePct >= 90 ? 'primary' : undefined}
              onClick={requestBuyStorageAddon}
              disabled={billingBusy === 'storage' || !hasMollieSubscription || currentStorageCents <= 0}
              title={!hasMollieSubscription ? 'Start eerst een abonnement' : undefined}
            >
              {billingBusy === 'storage' ? 'Bezig…' : `+${billingOverview.storage_addon_gb ?? 100} GB bijkopen (${formatEur(currentStorageCents, billingOverview.currency)}/${billingIntervalUnit})`}
            </Button>
          )}
        </div>

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
            {!hasMollieSubscription && selectedPlanObj && !selectedPlanObj.is_custom && creativePlanCents(selectedPlanObj, selectedInterval) > 0 && <label className="check-row">
              <input type="checkbox" checked={selectedCreative} onChange={event => setSelectedCreative(event.target.checked)} disabled={billingBusy === 'plan' || billingBusy === 'connect'} />
              <span>Creatieve module erbij — galerij-oplevering (foto/video) bij elk project · <strong>{formatEur(creativePlanCents(selectedPlanObj, selectedInterval), selectedPlanObj.currency)}</strong> per {selectedInterval === 'year' ? 'jaar' : 'maand'}</span>
            </label>}
          </div>
          <Select value={selectedPlan} onChange={event => setSelectedPlan(event.target.value)} disabled={billingBusy === 'plan'}>
            {!selectedPlanIsSelfService && <option value={selectedPlan} disabled>{billingOverview.plan_name} · handmatig beheerd</option>}
            {selfServiceBillingPlans.map(plan => <option key={plan.plan_key} value={plan.plan_key}>{plan.name} · {plan.included_seats ?? 'custom'} seats</option>)}
          </Select>
          {!hasMollieSubscription && <Select value={selectedInterval} onChange={event => setSelectedInterval(event.target.value as 'month' | 'year')} disabled={billingBusy === 'plan'}>
            <option value="month">Maandelijks</option>
            {selectedPlanHasYearly && <option value="year">Jaarlijks</option>}
          </Select>}
          <Button onClick={requestChangePlan} disabled={billingBusy === 'plan' || (hasMollieSubscription && selectedPlan === billingOverview.plan_key) || !selectedPlanIsSelfService}>{billingBusy === 'plan' ? 'Bezig…' : (hasMollieSubscription ? 'Plan wijzigen' : 'Abonnement starten')}</Button>
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

    {pendingChange && <Modal title={pendingChange.title} onClose={() => { if (!confirmingChange) setPendingChange(null); }} footer={<>
      <Button onClick={() => setPendingChange(null)} disabled={confirmingChange}>Annuleren</Button>
      <Button variant="primary" onClick={confirmPendingChange} disabled={confirmingChange}>{confirmingChange ? 'Bezig…' : 'Bevestigen'}</Button>
    </>}>
      <p>{pendingChange.description}</p>
      <div className="license-grid">
        <div className="license-metric"><span>Huidig</span><strong>{formatEur(pendingChange.currentCostCents, pendingChange.currency)}<small> /{pendingChange.intervalUnit}</small></strong></div>
        <div className="license-metric"><span>Nieuw</span><strong>{formatEur(pendingChange.newCostCents, pendingChange.currency)}<small> /{pendingChange.intervalUnit}</small></strong></div>
        <div className="license-metric"><span>Verschil</span><strong>{pendingChange.newCostCents >= pendingChange.currentCostCents ? '+' : ''}{formatEur(pendingChange.newCostCents - pendingChange.currentCostCents, pendingChange.currency)}<small> /{pendingChange.intervalUnit}</small></strong></div>
      </div>
      <p className="settings-help">Bij bevestigen wordt het bedrag van je abonnement bij Mollie direct aangepast.</p>
    </Modal>}
    </div>}

    {activeTab === 'ai' && <div className="settings-tab-panel">
      {canAdminOrganization
        ? (activeOrganization ? <AiUsagePanel organizationId={activeOrganization.id} members={organizationContext.teamMembers} /> : <p className="settings-help">Geen actieve organisatie geselecteerd.</p>)
        : <p className="settings-help">Alleen owners en admins kunnen het AI-gebruik inzien.</p>}
    </div>}

    {activeTab === 'email' && <div className="settings-tab-panel">
    {activeOrganization && <InboundForwardingCard organizationId={activeOrganization.id} canAdmin={canAdminOrganization} />}
    {activeOrganization && <SendingDomainCard organizationId={activeOrganization.id} canAdmin={canAdminOrganization} />}
    {activeOrganization && <PersonalSenderCard organizationId={activeOrganization.id} />}
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

// Totale periodekosten van een plan = basisprijs + extra seats × seatprijs +
// opslagbundels × bundelprijs, in het interval.
function planCostCents(plan: BillingPlan, purchasedSeats: number, interval: 'month' | 'year', storageAddons = 0, creative = false): number {
  const base = interval === 'year' ? plan.yearly_price_cents : plan.monthly_price_cents;
  const seat = interval === 'year' ? plan.extra_seat_yearly_price_cents : plan.extra_seat_price_cents;
  const storage = interval === 'year' ? (plan.storage_addon_yearly_price_cents ?? 0) : (plan.storage_addon_price_cents ?? 0);
  return base + Math.max(0, purchasedSeats) * seat + Math.max(0, storageAddons) * storage
    + (creative ? creativePlanCents(plan, interval) : 0);
}

function creativePlanCents(plan: BillingPlan, interval: 'month' | 'year'): number {
  return (interval === 'year' ? plan.creative_addon_yearly_price_cents : plan.creative_addon_price_cents) ?? 0;
}

type PendingBillingChange = {
  title: string;
  description: string;
  currentCostCents: number;
  newCostCents: number;
  intervalUnit: string;
  currency: string;
  execute: () => Promise<void>;
};

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

/** Max. logobreedte; groter heeft geen zin en het logo gaat als data-URL mee. */
const BRAND_LOGO_MAX_WIDTH = 600;
const BRAND_LOGO_MAX_BYTES = 300 * 1024;

/**
 * Schaalt het logo terug en levert een data-URL op. Data-URL i.p.v. R2 omdat de
 * publieke galerijpagina geen sessie heeft en dus geen media-token kan gebruiken;
 * zo blijft het logo daar gewoon zichtbaar. PNG blijft PNG (transparantie),
 * de rest wordt JPEG.
 */
async function logoToDataUrl(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    throw new Error('Kies een PNG-, JPEG- of WebP-bestand.');
  }
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, BRAND_LOGO_MAX_WIDTH / bitmap.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas niet beschikbaar.');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const usePng = file.type === 'image/png';
    const dataUrl = canvas.toDataURL(usePng ? 'image/png' : 'image/jpeg', usePng ? undefined : 0.9);
    if (dataUrl.length > BRAND_LOGO_MAX_BYTES * 1.4) {
      throw new Error('Dit logo is te groot. Gebruik een kleiner bestand (richtlijn: onder 300 kB).');
    }
    return dataUrl;
  } finally {
    bitmap.close();
  }
}

function BrandingCard({ form, setForm, canWrite }: {
  form: CompanySettingsInput;
  setForm: React.Dispatch<React.SetStateAction<CompanySettingsInput>>;
  canWrite: boolean;
}) {
  const [logoError, setLogoError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Het voorbeeld moet de échte letters tonen, dus de gekozen families laden.
  useEffect(() => {
    ensureBrandFontsLoaded([form.brand_heading_font, form.brand_body_font]);
  }, [form.brand_heading_font, form.brand_body_font]);

  async function pickLogo(file: File | undefined) {
    if (!file) return;
    setLogoError(null);
    try {
      const dataUrl = await logoToDataUrl(file);
      setForm(prev => ({ ...prev, brand_logo_data_url: dataUrl }));
    } catch (e) {
      setLogoError(e instanceof Error ? e.message : 'Logo verwerken mislukt.');
    }
  }

  return (
    <section className="settings-card">
      <h3>Je merk</h3>
      <p className="settings-help">
        Hier staat je merk in z&apos;n geheel: naam, logo, kleur en lettertypen. De merkkleur werkt door in
        álles wat je klant ziet — het klantportaal, galerijen, facturen, offertes, contracten en e-mails.
      </p>

      <div className="brand-grid">
        <div className="brand-field brand-field-wide">
          <span className="brand-label">Merknaam</span>
          <Input
            value={form.trade_name ?? ''}
            onChange={(e) => setForm(prev => ({ ...prev, trade_name: e.target.value }))}
            placeholder="Bijv. Studio Noord"
            disabled={!canWrite}
          />
          <p className="settings-help">De naam waaronder je naar buiten treedt. Je juridische bedrijfsnaam staat bij Facturatie.</p>
        </div>
        <div className="brand-field">
          <span className="brand-label">Logo</span>
          <div className="brand-logo-row">
            <div className="brand-logo-preview">
              {form.brand_logo_data_url
                ? <img src={form.brand_logo_data_url} alt="Je logo" />
                : <span className="brand-logo-empty">Geen logo</span>}
            </div>
            <div className="brand-logo-actions">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                style={{ display: 'none' }}
                onChange={(e) => { void pickLogo(e.target.files?.[0]); e.target.value = ''; }}
              />
              <Button onClick={() => fileRef.current?.click()} disabled={!canWrite}>Logo kiezen</Button>
              {form.brand_logo_data_url && (
                <Button variant="ghost" onClick={() => setForm(prev => ({ ...prev, brand_logo_data_url: null }))} disabled={!canWrite}>
                  Verwijderen
                </Button>
              )}
              <p className="settings-help">PNG, JPEG of WebP. We schalen het automatisch terug naar {BRAND_LOGO_MAX_WIDTH}px breed.</p>
            </div>
          </div>
          {logoError && <div className="error">{logoError}</div>}
        </div>

        <div className="brand-field">
          <span className="brand-label">Merkkleur</span>
          <div className="brand-color-row">
            <input
              type="color"
              className="brand-color"
              value={/^#[0-9A-Fa-f]{6}$/.test(form.brand_accent_color) ? form.brand_accent_color : '#FFD966'}
              onChange={(e) => setForm(prev => ({ ...prev, brand_accent_color: e.target.value.toUpperCase() }))}
              disabled={!canWrite}
              aria-label="Accentkleur"
            />
            <Input
              value={form.brand_accent_color}
              onChange={(e) => setForm(prev => ({ ...prev, brand_accent_color: e.target.value.toUpperCase() }))}
              disabled={!canWrite}
              maxLength={7}
              aria-label="Accentkleur als hexcode"
            />
          </div>
          <p className="settings-help">Werkt door in het klantportaal en de galerij, én op je facturen, offertes, contracten en e-mails.</p>
        </div>

        <div className="brand-field brand-field-wide">
          <span className="brand-label">Achtergrond van de galerij</span>
          <div className="brand-bg-row">
            {GALLERY_BACKGROUNDS.map(option => (
              <button
                key={option.value}
                type="button"
                className={`brand-bg-swatch${form.brand_gallery_bg?.toUpperCase() === option.value ? ' is-active' : ''}`}
                style={{ background: option.value }}
                onClick={() => setForm(prev => ({ ...prev, brand_gallery_bg: option.value }))}
                disabled={!canWrite}
                title={option.label}
                aria-label={option.label}
                aria-pressed={form.brand_gallery_bg?.toUpperCase() === option.value}
              />
            ))}
            <input
              type="color"
              className="brand-color"
              value={/^#[0-9A-Fa-f]{6}$/.test(form.brand_gallery_bg) ? form.brand_gallery_bg : '#0B0B0B'}
              onChange={(e) => setForm(prev => ({ ...prev, brand_gallery_bg: e.target.value.toUpperCase() }))}
              disabled={!canWrite}
              aria-label="Eigen achtergrondkleur"
            />
          </div>
          <p className="settings-help">
            Tekst, randen en knoppen passen zich automatisch aan: bij een lichte achtergrond wordt de tekst donker.
          </p>
        </div>

        <div className="brand-field brand-field-wide">
          <span className="brand-label">Sfeer van je klantpagina&apos;s</span>
          <div className="brand-theme-row">
            {CLIENT_THEMES.map(option => (
              <button
                key={option.value}
                type="button"
                className={`brand-theme-card${form.brand_client_theme === option.value ? ' is-active' : ''}`}
                onClick={() => setForm(prev => ({ ...prev, brand_client_theme: option.value }))}
                disabled={!canWrite}
                aria-pressed={form.brand_client_theme === option.value}
              >
                {/* Geen kleurstaal maar een echt stukje pagina: kop, gedempte
                    regel, statuschip en knop zijn precies de vier plekken waar
                    een heel licht of heel donker merk uit de bocht kan vliegen. */}
                <span
                  className="brand-theme-preview"
                  style={brandThemeVars({
                    logoDataUrl: null,
                    accentColor: form.brand_accent_color,
                    footerText: null,
                    hidePoweredBy: false,
                    companyName: null,
                    headingFont: form.brand_heading_font,
                    bodyFont: form.brand_body_font,
                    clientTheme: option.value,
                  }) as React.CSSProperties}
                >
                  <span className="brand-theme-card-mock">
                    {form.brand_logo_data_url
                      ? <img className="brand-theme-logo" src={form.brand_logo_data_url} alt="" />
                      : <span className="brand-theme-mark">{(form.trade_name || 'A').slice(0, 1).toUpperCase()}</span>}
                    <strong className="brand-theme-title">Factuur 2026-014</strong>
                    <span className="brand-theme-sub">Vervalt 15 september · € 1.240</span>
                    <span className="brand-theme-row-inline">
                      <em className="brand-theme-chip">Verstuurd</em>
                      <i className="brand-theme-btn">Betaal nu</i>
                    </span>
                  </span>
                </span>
                <strong>{option.label}</strong>
                <small>{option.hint}</small>
              </button>
            ))}
          </div>
          <p className="settings-help">
            Geldt voor het klantportaal en de publieke offerte-, factuur- en contractpagina. Licht of donker
            kiezen is genoeg: vlakken, randen en tekst worden uit je merkkleur afgeleid en halen overal het
            vereiste contrast — ook als je merkkleur heel licht of heel donker is.
          </p>
        </div>

        <div className="brand-field">
          <span className="brand-label">Lettertype koppen</span>
          <Select
            value={form.brand_heading_font}
            onChange={(e) => setForm(prev => ({ ...prev, brand_heading_font: e.target.value }))}
            disabled={!canWrite}
          >
            {BRAND_FONTS.map(font => <option key={font.key} value={font.key}>{font.label}</option>)}
          </Select>
          <p className="settings-help">{brandFont(form.brand_heading_font).hint}</p>
        </div>

        <div className="brand-field">
          <span className="brand-label">Lettertype tekst</span>
          <Select
            value={form.brand_body_font}
            onChange={(e) => setForm(prev => ({ ...prev, brand_body_font: e.target.value }))}
            disabled={!canWrite}
          >
            {BRAND_BODY_FONTS.map(font => <option key={font.key} value={font.key}>{font.label}</option>)}
          </Select>
          <p className="settings-help">{brandFont(form.brand_body_font).hint}</p>
        </div>

        {/* Voorbeeld met de daadwerkelijke lettertypen en accentkleur. */}
        <div className="brand-field brand-field-wide">
          <span className="brand-label">Voorbeeld galerij</span>
          <div
            className="brand-preview"
            style={{
              ...brandStyle({
                logoDataUrl: null,
                accentColor: form.brand_accent_color,
                footerText: null,
                hidePoweredBy: false,
                companyName: null,
                headingFont: form.brand_heading_font,
                bodyFont: form.brand_body_font,
                galleryBg: form.brand_gallery_bg,
              }),
              background: /^#[0-9A-Fa-f]{6}$/.test(form.brand_gallery_bg) ? form.brand_gallery_bg : undefined,
              fontFamily: brandFont(form.brand_body_font).stack,
            } as React.CSSProperties}
          >
            {form.brand_logo_data_url && <img className="brand-preview-logo" src={form.brand_logo_data_url} alt="" />}
            <h4 style={{ fontFamily: brandFont(form.brand_heading_font).stack }}>Bruiloft Sanne &amp; Tim</h4>
            <p>De mooiste beelden van jullie dag — kies je favorieten en download ze in hoge resolutie.</p>
            <span className="brand-preview-chips">
              <span className="brand-preview-chip is-active">Ceremonie</span>
              <span className="brand-preview-chip">Diner</span>
              <span className="brand-preview-chip">Feest</span>
            </span>
          </div>
        </div>

        <div className="brand-field brand-field-wide">
          <span className="brand-label">Afsluiting onder je klantpagina&apos;s</span>
          <Input
            value={form.brand_footer_text ?? ''}
            onChange={(e) => setForm(prev => ({ ...prev, brand_footer_text: e.target.value || null }))}
            placeholder="Bijv. Bedankt voor het vertrouwen — Studio Noord"
            disabled={!canWrite}
            maxLength={160}
          />
        </div>

        <label className="brand-field brand-field-wide check-row">
          <input
            type="checkbox"
            checked={form.brand_hide_powered_by}
            onChange={(e) => setForm(prev => ({ ...prev, brand_hide_powered_by: e.target.checked }))}
            disabled={!canWrite}
          />
          <span>&ldquo;Geleverd via ResoFly&rdquo; verbergen op de publieke galerijpagina</span>
        </label>
      </div>
    </section>
  );
}

function settingsToForm(settings: CompanySettings | null): CompanySettingsInput {
  if (!settings) return emptySettings;
  return {
    company_name: settings.company_name ?? '',
    legal_form: settings.legal_form ?? 'eenmanszaak',
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
    fiscal_year_start_month: settings.fiscal_year_start_month ?? 1,
    year_result_account_code: settings.year_result_account_code ?? '0510',
    default_hourly_rate_cents: settings.default_hourly_rate_cents ?? null,
    brand_logo_data_url: settings.brand_logo_data_url ?? null,
    brand_accent_color: settings.brand_accent_color ?? '#FFD966',
    brand_footer_text: settings.brand_footer_text ?? null,
    brand_hide_powered_by: settings.brand_hide_powered_by ?? false,
    brand_heading_font: settings.brand_heading_font ?? 'system',
    brand_body_font: settings.brand_body_font ?? 'system',
    brand_gallery_bg: settings.brand_gallery_bg ?? '#0B0B0B',
    brand_client_theme: settings.brand_client_theme === 'light' ? 'light' : 'dark',
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
    // De merkkleur is de enige bron; de factuurkleur volgt (de database houdt
    // dit ook af met een trigger, hier al zodat de UI meteen klopt).
    brand_accent_color: normalizeHex(input.brand_accent_color, '#FFD966'),
    invoice_accent_color: normalizeHex(input.brand_accent_color, '#FFD966'),
    // Twee vaste waarden; de CHECK op de kolom laat niets anders toe.
    brand_client_theme: input.brand_client_theme === 'light' ? 'light' : 'dark',
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
