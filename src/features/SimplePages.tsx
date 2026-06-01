import { useEffect, useState } from 'react';
import type { AppData, AuditLog, BillingPlan, CompanySettings, CompanySettingsInput, InvoiceMollieSettingsStatus, InvoiceTemplateKind, OrganizationBillingOverview, OrganizationContext, OrganizationRole, Project } from '../types';
import { Button, Input, Select, Textarea } from '../components/Ui';
import { changeOrganizationPlan, createExtraSeatCheckout, getSelfServiceBillingPlans, loadBillingOverview, loadBillingPlans, markMockPaymentPaid, startMollieConnect } from '../services/billingService';
import { sendResendTestEmail } from '../services/mailService';
import { deleteInvoiceMollieKey, loadInvoiceMollieStatus, saveInvoiceMollieKey } from '../lib/repository';

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
  invoice_template_updated_at: null,
};

const ROLE_LABELS: Record<OrganizationRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

export function CalendarPage() {
  return <div className="empty"><div className="e-big">Kalender</div><p>V1 toont deadlines in projecten. Koppeling met Google/Microsoft Calendar kan hierop worden gebouwd.</p></div>;
}

export function Stats({ data }: { data: AppData }) {
  return <div className="stats-grid"><div className="stats-card"><h3>Verdeling taken</h3>{['todo','doing','review','done'].map(st => <div className="bar-row" key={st}><span className="bar-label">{st}</span><div className="bar-track"><div className="bar-fill" style={{width:`${data.tasks.length ? data.tasks.filter(t=>t.status===st).length/data.tasks.length*100 : 0}%`}}/></div><span className="bar-val">{data.tasks.filter(t=>t.status===st).length}</span></div>)}</div></div>;
}

export function Archive({ data, onOpen, onRestore }: { data: AppData; onOpen: (id: string) => void; onRestore: (project: Project) => void }) {
  const archived = data.projects.filter(p=>p.archived);
  if (!archived.length) return <div className="empty"><div className="e-big">Geen gearchiveerde projecten</div><p>Archiveer een project via “Project bewerken”.</p></div>;
  return <div className="archive-list">{archived.map(p=><div className="archive-item" key={p.id}><span className="archive-dot" style={{background:p.color}}/><div className="archive-info"><div className="archive-name">{p.name}</div><small>{p.description ?? 'Geen omschrijving'}</small></div><div className="archive-actions"><Button onClick={() => onOpen(p.id)}>Open</Button><Button onClick={() => onRestore(p)}>Herstellen</Button></div></div>)}</div>;
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
  const hasAvailableLicense = seatOverview ? seatOverview.available_seats > 0 : true;
  const inviteDisabled = !canAdminOrganization || !activeOrganization || !inviteEmail.trim() || !hasAvailableLicense;

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
    let cancelled = false;
    if (!activeOrganization || !canAdminOrganization) { setInvoiceMollie(null); return; }
    loadInvoiceMollieStatus(activeOrganization.id)
      .then(status => { if (!cancelled) setInvoiceMollie(status); })
      .catch(() => { if (!cancelled) setInvoiceMollie(null); });
    return () => { cancelled = true; };
  }, [activeOrganization?.id, canAdminOrganization]);

  const set = (key: keyof CompanySettingsInput, value: string | number | InvoiceTemplateKind | null) => {
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
      setOrgMessage('Uitnodiging opgeslagen. Er is één gebruikerslicentie gereserveerd totdat de uitnodiging wordt geaccepteerd of ingetrokken.');
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

  async function connectMollie() {
    if (!activeOrganization || !canAdminOrganization) return;
    setBillingBusy('connect');
    setBillingError(null);
    setBillingMessage(null);
    try {
      const result = await startMollieConnect(activeOrganization.id);
      if (result.authUrl) {
        window.location.href = result.authUrl;
        return;
      }
      await refreshBilling();
      setBillingMessage(result.mockConnected ? 'Mollie mock-koppeling actief voor lokale tests.' : 'Mollie-koppeling gestart.');
    } catch (error) {
      setBillingError(error instanceof Error ? error.message : 'Mollie koppelen mislukt.');
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
      if (checkout.mock) {
        setLastMockPaymentId(checkout.providerPaymentId);
        setBillingMessage(checkout.reused ? 'Bestaande open mock-checkout hergebruikt. Rond de mockbetaling af om de idempotente flow lokaal te testen.' : 'Mock-checkout aangemaakt. Rond de mockbetaling af om de webhook/RPC-flow lokaal te testen.');
        return;
      }
      window.location.href = checkout.checkoutUrl;
    } catch (error) {
      setBillingError(error instanceof Error ? error.message : 'Extra licentie kopen mislukt.');
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
      if (checkout.mock) {
        setLastMockPaymentId(checkout.providerPaymentId);
        setBillingMessage(checkout.reused ? 'Bestaande open mock-checkout voor planwijziging hergebruikt.' : 'Planwijziging-checkout aangemaakt. Rond de mockbetaling af om de wijziging toe te passen.');
        return;
      }
      window.location.href = checkout.checkoutUrl;
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

  return <div className="settings-page">
    <div className="settings-head">
      <div>
        <h2>Organisatie & instellingen</h2>
        <p>Beheer je ResoFly-werkruimte, teamrollen, audit-log en factuurgegevens vanuit één centrale tenant-instelling.</p>
      </div>
      <Button variant="primary" onClick={save} disabled={isSaving || !canAdminOrganization}>{isSaving ? 'Opslaan…' : 'Opslaan'}</Button>
      {!canAdminOrganization && <p className="settings-help">Je kunt deze instellingen bekijken, maar alleen owners en admins kunnen ze aanpassen.</p>}
    </div>

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

    <section className="settings-card organization-card billing-card">
      <div className="settings-card-head">
        <div>
          <h3>Billing & licenties</h3>
          <p className="settings-help">Het billing-profiel stuurt het compatibele organisatieveld <code>licensed_seats</code> aan. Actieve gebruikers plus pending uitnodigingen mogen nooit boven de beschikbare seats uitkomen.</p>
        </div>
        {canAdminOrganization && <div className="billing-actions">
          <Button onClick={refreshBilling} disabled={billingBusy === 'refresh'}>{billingBusy === 'refresh' ? 'Verversen…' : 'Billing verversen'}</Button>
          <Button variant="primary" onClick={connectMollie} disabled={billingBusy === 'connect'}>{billingBusy === 'connect' ? 'Koppelen…' : 'Mollie koppelen'}</Button>
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
            <small>{billingOverview.subscription_status}</small>
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
          <div className="license-metric"><span>Vrij</span><strong>{billingOverview.available_seats}</strong></div>
        </div>

{canAdminOrganization && <div className="billing-control-row">
          <div>
            <strong>Extra gebruiker toevoegen</strong>
            <p className="settings-help">Maak een Mollie-checkout aan. Pas na een succesvolle webhook/RPC-verwerking wordt de extra seat definitief toegevoegd.</p>
          </div>
          <Button variant="primary" onClick={buyExtraSeat} disabled={billingBusy === 'seat' || !['connected','mock_connected'].includes(billingOverview.mollie_connect_status)}>{billingBusy === 'seat' ? 'Checkout…' : 'Extra licentie kopen'}</Button>
        </div>}

        {canAdminOrganization && lastMockPaymentId && <div className="billing-control-row mock-row">
          <div>
            <strong>Mockbetaling klaar</strong>
            <p className="settings-help">Payment-id: {lastMockPaymentId}. Gebruik dit alleen lokaal met <code>MOLLIE_ALLOW_MOCK=true</code>.</p>
          </div>
          <Button variant="primary" onClick={completeMockPayment} disabled={billingBusy === 'mock-paid'}>{billingBusy === 'mock-paid' ? 'Verwerken…' : 'Mockbetaling afronden'}</Button>
        </div>}

{canAdminOrganization && <div className="billing-control-row">
          <div>
            <strong>Plan wijzigen</strong>
            <p className="settings-help">Betaalde upgrades lopen via Mollie-checkout. Downgrades en Custom-plannen blijven handmatig, zodat proratie en contractafspraken kloppen.</p>
          </div>
          <Select value={selectedPlan} onChange={event => setSelectedPlan(event.target.value)} disabled={billingBusy === 'plan'}>
            {!selectedPlanIsSelfService && <option value={selectedPlan} disabled>{billingOverview.plan_name} · handmatig beheerd</option>}
            {selfServiceBillingPlans.map(plan => <option key={plan.plan_key} value={plan.plan_key}>{plan.name} · {plan.included_seats ?? 'custom'} seats</option>)}
          </Select>
          <Button onClick={changePlan} disabled={billingBusy === 'plan' || selectedPlan === billingOverview.plan_key || !selectedPlanIsSelfService}>{billingBusy === 'plan' ? 'Checkout…' : 'Plan checkout starten'}</Button>
        </div>}

        {customBillingPlans.length > 0 && <div className="billing-control-row">
          <div>
            <strong>Custom-plan</strong>
            <p className="settings-help">Custom-plannen worden niet als self-service checkout aangeboden. Neem contact op voor contractafspraken, seats en facturatie.</p>
          </div>
          <span className="badge">Neem contact op</span>
        </div>}
      </> : <p className="settings-help">Billinggegevens konden nog niet worden geladen. Controleer of de Sprint 2 migratie is uitgevoerd.</p>}

      {!canAdminOrganization && <p className="settings-help">Alleen owners en admins kunnen billing-acties uitvoeren.</p>}
      {seatOverview && seatOverview.available_seats <= 0 && <div className="error">Geen vrije gebruikerslicentie beschikbaar. Koop eerst een extra gebruikerslicentie voordat je iemand uitnodigt.</div>}
    </section>

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

      {!hasAvailableLicense && <p className="settings-help">Er zijn geen vrije licenties meer. Trek een openstaande uitnodiging in, schakel een teamlid uit of laat billing eerst extra seats synchroniseren.</p>}

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

    {message && <div className="success">{message}</div>}
    {templateError && <div className="error">{templateError}</div>}

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
      <h3>Factuurtemplate</h3>
      <p className="settings-help">Upload een eigen A4 PDF-template of een afbeelding. De datavelden blijven vast: bedrijfsgegevens, klant, factuurnummer, datums, regels, BTW, totaal, notities en betaalinformatie.</p>
      <div className="field-list">
        {TEMPLATE_FIELD_LABELS.map(label => <span key={label}>{label}</span>)}
      </div>
      <div className="template-upload-row">
        <input type="file" accept="application/pdf,image/png,image/jpeg" onChange={e => { void onTemplateSelected(e.target.files?.[0]); e.currentTarget.value = ''; }} />
        {form.invoice_template_file_name && <Button variant="danger" onClick={removeTemplate}>Template verwijderen</Button>}
      </div>
      {form.invoice_template_file_name ? <div className="template-meta">
        <strong>{form.invoice_template_file_name}</strong>
        <span>{form.invoice_template_kind === 'pdf' ? 'PDF-template' : 'Afbeelding-template'} · {Math.round((form.invoice_template_file_size || 0) / 1024)} KB</span>
      </div> : <div className="template-meta muted">Nog geen template ingesteld. Zonder template gebruikt ResoFly een nette standaardfactuur.</div>}
      <div className="settings-grid compact">
        <Input value={form.invoice_template_text_color ?? '#1a1a1a'} onChange={e=>set('invoice_template_text_color', e.target.value)} placeholder="Tekstkleur, bijv. #1a1a1a" />
        <Input value={form.invoice_accent_color ?? '#FFD966'} onChange={e=>set('invoice_accent_color', e.target.value)} placeholder="Accentkleur, bijv. #FFD966" />
      </div>
    </section>

    <section className="settings-card">
      <h3>Betaling en footer</h3>
      <Textarea value={form.invoice_payment_terms ?? ''} onChange={e=>set('invoice_payment_terms', e.target.value)} placeholder="Betaalinstructies" />
      <Textarea value={form.invoice_footer ?? ''} onChange={e=>set('invoice_footer', e.target.value)} placeholder="Footertekst" />
    </section>
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
    invoice_template_updated_at: settings.invoice_template_updated_at ?? null,
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
